import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/compat';
import {FreePool} from '../src/free-pool.js';
import {readCooldownEvidence,MAX_COOLDOWN_EVIDENCE,activityDetail} from '../src/free-pool-diagnostics.js';
import {boundedActivity,activityText,showPoolStatus} from '../src/pool-activity.js';
import {poolStream} from '../src/ovh-pool-stream.js';
import {editFreePool} from '../src/free-pool-editor.js';
import {environment,K,K2,A,context} from './free-pool-helper.mjs';
const reply=(status,after)=>new Response('',{status,headers:after===undefined?{}:{'retry-after':after}});
const drain=async s=>{for await(const _ of s){}return s.result();};
async function restored(x,raw=x.disk){
 const dir=await mkdtemp(join(tmpdir(),'pool-diagnostic-'));
 try{const file=join(dir,'pool.json');await writeFile(file,JSON.stringify(raw));const p=new FreePool({catalog:x.catalog,ovhPool:x.ovh,file,now:()=>x.now,persist:async()=>{}});await p.load();return p;}
 finally{await rm(dir,{recursive:true,force:true});}
}
for(const [status,after,source,state] of [[429,undefined,'fallback','missing'],[429,'nonsense','fallback','invalid'],[429,'12','retry-after','valid'],[503,'4','retry-after','valid'],[200,'3','retry-after','valid']])test(`cooldown provenance HTTP ${status} Retry-After ${after} is explicit and survives restart`,async()=>{
 const x=environment();await x.enable();await x.pool.observe('reflection/beam-free',reply(status,after),{},'kilo');
 const until=x.now+(source==='fallback'?61000:Number(after)*1000);assert.equal(x.pool.until(K),until);assert.equal(x.pool.until(K2),0);
 assert.deepEqual(x.disk.cooldownEvidence,[{service:'kilo',model:'reflection/beam-free',status,at:x.now,until,scope:'model',source,retryAfterState:state,retryAfter:source==='fallback'?null:after}]);
 const p=await restored(x);assert.deepEqual(p.cooldownEvidence,x.pool.cooldownEvidence);assert.equal(p.until(K),until);
 assert.match(p.cooldownStatus(K),new RegExp('HTTP '+status));assert.match(p.cooldownStatus(K),/model-local package handling; upstream quota scope is unverified/);
 if(source==='fallback')assert.match(p.cooldownStatus(K),/61 seconds.*NOT a verified provider limit/);
 else assert.match(p.cooldownStatus(K),/provider Retry-After/);
 p.close();x.pool.close();
});
test('Retry-After HTTP date is retained exactly, without converting it into an invented capacity',async()=>{
 const x=environment();await x.enable();const date=new Date(20000).toUTCString();await x.pool.observe('thinkingmachines/inkling-small:free',reply(429,date),{},'kilo');assert.equal(x.pool.until(K2),20000);assert.match(x.pool.cooldownStatus(K2),/Thu, 01 Jan 1970/);assert.equal(x.disk.cooldownEvidence[0].retryAfter,date);
});
for(const status of [200,401,403,503])test(`HTTP ${status} without Retry-After invents no Kilo cooldown`,async()=>{
 const x=environment();await x.enable();await x.pool.observe('reflection/beam-free',reply(status),{},'kilo');assert.equal(x.pool.until(K),0);assert.deepEqual(x.pool.cooldownEvidence,[]);
});
test('shorter later headers do not falsely become the origin of a longer active barrier',async()=>{
 const x=environment();await x.enable();await x.pool.observe('original',reply(429,'120'),{},'kilo');x.advance(1000);await x.pool.observe('original',reply(503,'2'),{},'kilo');
 assert.match(x.pool.cooldownStatus('["kilo","original"]'),/kilo\/original; HTTP 429/);assert.doesNotMatch(x.pool.cooldownStatus('["kilo","original"]'),/kilo\/later/);assert.equal(x.pool.cooldownEvidence.length,2);
});
test('expired current cooldowns and stale historical checks are clearly separated',async()=>{
 const x=environment();await x.enable();await x.pool.observe('reflection/beam-free',reply(429,'2'),{},'kilo');x.catalog.state.entries[K2].listed=false;
 await assert.rejects(x.pool.choose(x.model(K),context(),{}),/cooldown-active/);const stamp=x.pool.lastCheckAt;x.advance(3000);
 const text=x.pool.report(),current=text.split('Last selection check')[0];assert.match(current,/no active local cooldown/);assert.doesNotMatch(current,/cooling \d+s/);assert.match(text,/HISTORICAL; not current readiness/);assert.match(text,/cooling down/);assert.equal(x.pool.lastCheckAt,stamp);
 const disk=structuredClone(x.disk),r=structuredClone(x.pool.rotation);x.pool.report();x.pool.preview();assert.deepEqual(x.disk,disk);assert.deepEqual(x.pool.rotation,r);assert.equal(x.sends,0);
});
test('old schema-2 files preserve cooldowns but honestly lack response provenance',async()=>{
 const x=environment();await x.enable();await x.pool.observe('reflection/beam-free',reply(429,'10'),{},'kilo');const raw=structuredClone(x.disk);delete raw.cooldownEvidence;
 const p=await restored(x,raw);assert.equal(p.until(K),11000);assert.equal(p.rotation.paused,false);assert.match(p.cooldownStatus(K),/origin unavailable/);assert.match(p.report(),/Older state cannot reconstruct/);p.close();
});
for(const bad of [{},[{service:'kilo'}],Array(129).fill({}),[{service:'kilo',model:'SECRET\n',status:429,at:1,until:2,scope:'model',source:'fallback',retryAfterState:'missing',retryAfter:null}]])test('bad optional evidence never clears enforcement or pauses valid scheduling: '+JSON.stringify(bad).slice(0,65),async()=>{
 const x=environment();await x.enable();await x.pool.observe('reflection/beam-free',reply(429,'10'),{},'kilo');const p=await restored(x,{...x.disk,cooldownEvidence:bad});assert.equal(p.until(K),11000);assert.equal(p.rotation.paused,false);assert.deepEqual(p.cooldownEvidence,[]);assert.match(p.report(),/evidence is invalid; enforcement is unchanged/);assert.doesNotMatch(p.report(),/SECRET/);p.close();
});
test('cooldown evidence is capped, allowlisted and cannot persist provider bodies, prompts or arbitrary fields',async()=>{
 const x=environment();await x.enable();for(let i=0;i<140;i++)await x.pool.observe('m'+i,reply(429,'2'),{},'kilo');assert.equal(x.pool.cooldownEvidence.length,MAX_COOLDOWN_EVIDENCE);assert.equal(x.pool.cooldownEvidence[0].model,'m12');
 const [e]=readCooldownEvidence([{...x.pool.cooldownEvidence[0],body:'PRIVATE_BODY',prompt:'PRIVATE_PROMPT',token:'PRIVATE_TOKEN'}]);assert.doesNotMatch(JSON.stringify(e),/PRIVATE|token|prompt|body/);assert.ok(Buffer.byteLength(JSON.stringify(x.disk.cooldownEvidence))<100000);
});
test('reviewed rotation restart preserves service deadlines and their evidence',async()=>{
 const x=environment();await x.enable();await x.pool.observe('reflection/beam-free',reply(429),{},'kilo');const before=structuredClone(x.pool.cooldownEvidence),until=x.pool.until(K);await x.pool.saveDraft(x.pool.config,x.pool.config,{restart:true,consent:true});assert.equal(x.pool.until(K),until);assert.deepEqual(x.pool.cooldownEvidence,before);
});
test('write failure does not remove the in-memory cooldown or claim it was persisted',async()=>{
 const x=environment();await x.enable();const old=structuredClone(x.disk);x.setFail(true);await assert.rejects(x.pool.observe('reflection/beam-free',reply(429),{},'kilo'),/Could not save/);assert.equal(x.pool.until(K),62000);assert.equal(x.pool.rotation.paused,true);assert.deepEqual(x.disk,old);
});
test('OVH rolling reservations explain a cooldown without inventing a new HTTP rejection',async()=>{
 const x=environment({models:[A,K],weights:{[A]:2},scheduling:'round-robin'});await x.enable();await x.next();await x.next();assert.match(x.pool.cooldownStatus(A),/OVH (?:durable reservation|conservative quota) ledger \(not a new provider rejection\)/);assert.deepEqual(x.pool.cooldownEvidence,[]);
});
test('preview begins at remaining weighted visit and stops at finite allowance without changing state',async()=>{
 const x=environment({weights:{[K]:3,[K2]:4},cycles:2});await x.enable();await x.next();await x.next();const disk=structuredClone(x.disk);const text=x.pool.preview();assert.match(text,/reserved 2\/3; remaining 1/);assert.match(text,/1\. .*kilo.*× 1 remaining in pass 1/);assert.match(text,/2\. .*kilo.*× 4 remaining in pass 1/);assert.match(text,/Then PAUSE/);assert.match(text,/NOT counts of successful answers/);assert.deepEqual(x.disk,disk);assert.equal(x.sends,2);
});
test('paused and priority previews do not present an actionable weighted rotation',async()=>{
 const x=environment({cycles:1});await x.enable();await x.next();await x.next();assert.match(x.pool.preview(),/No upcoming visits while PAUSED/);assert.doesNotMatch(x.pool.preview(),/remaining in pass/);
 const y=environment({scheduling:'priority'});await y.enable();assert.match(y.pool.preview(),/weights do not force rotation/);assert.doesNotMatch(y.pool.preview(),/remaining in pass/);
});
test('general and genuine legacy status viewers have correct headings and scoped activity hints',async()=>{
 for(const scope of ['free',undefined]){
  let heading;const pool={scope,report:()=> 'Snapshot'},ctx={hasUI:true,ui:{custom:async factory=>{const view=factory({terminal:{rows:20},requestRender(){}},null,null,()=>{});heading=view.render(80)[0];return false;}}};await showPoolStatus(pool,ctx,()=>assert.fail('viewer fallback'));assert.equal(heading,scope?'Free Pool':'OVH pool');
  assert.match(activityText({scope,steps:[]},false),scope?/Details: \/free-pool status/:/Details: \/free-ovh-pool status/);
 }
});
test('allowlisted compatibility and failure reasons explain the problem without storing raw error content',()=>{
 const data=boundedActivity({scope:'free',failure:'no-compatible-model',error:'PRIVATE_BODY',steps:[{model:'m',state:'not-compatible',detail:'tools-unverified',reason:'PRIVATE_PROMPT'}]});const text=activityText(data);assert.match(text,/includes tools or tool results/);assert.match(text,/longer wait does not add missing capabilities/);assert.doesNotMatch(JSON.stringify(data),/PRIVATE/);
 assert.equal(activityDetail('PRIVATE_PROMPT'),'');assert.equal(activityDetail(['tools-unverified']),'');assert.equal(boundedActivity({failure:['no-compatible-model']}).failure,undefined);assert.equal(boundedActivity({failure:'PRIVATE_BODY',steps:[{detail:'PRIVATE_PROMPT'}]}).failure,undefined);
});
test('no-compatible, finite allowance and readiness deadline are distinct failures without sends',async()=>{
 const x=environment();await x.enable();x.pool.reason=()=> 'Tools are not explicitly supported';let activity;
 const a=await drain(poolStream({pool:x.pool,model:x.model(K),context:context(),onHandoff:async()=>{},dispatch:()=>assert.fail('wire'),onActivity:v=>activity=v}));assert.match(a.errorMessage,/no-compatible-model/);assert.equal(activity.failure,'no-compatible-model');assert.ok(activity.steps.every(s=>s.detail==='tools-unverified'));
 const y=environment({cycles:1});await y.enable();y.pool.reason=()=> 'Tools are not explicitly supported';const b=await drain(poolStream({pool:y.pool,model:y.model(K),context:context(),onHandoff:async()=>{},dispatch:()=>assert.fail('wire'),onActivity:v=>activity=v}));assert.match(b.errorMessage,/finite-allowance-exhausted/);assert.equal(activity.failure,'finite-allowance-exhausted');assert.equal(y.sends,0);
 const z=environment();await z.enable({maxWaitMs:20});await z.pool.observe('reflection/beam-free',reply(429),{},'kilo');await z.pool.observe('thinkingmachines/inkling-small:free',reply(429),{},'kilo');z.pool.sleep=()=>new Promise(()=>{});
 const c=await drain(poolStream({pool:z.pool,model:z.model(K),context:context(),onHandoff:async()=>{},dispatch:()=>assert.fail('wire'),onActivity:v=>activity=v}));assert.match(c.errorMessage,/readiness-wait-expired/);assert.match(c.errorMessage,/response-start timer did not start/);assert.equal(activity.failure,'readiness-wait-expired');assert.equal(activity.steps.find(s=>s.state==='waiting').model,'Free Pool');assert.equal(z.sends,0);
});
test('draft preview shows unsaved scheduling without saving, resetting quota, fetching or selecting a model',async()=>{
 const x=environment({weights:{[K]:3}});await x.enable();await x.next();let n=0,rendered='';const disk=structuredClone(x.disk),before=x.pool.config;
 const ctx={hasUI:true,model:{provider:'other',id:'keep'},isIdle:()=>true,ui:{select:async()=>n++===0?'Preview draft':'Cancel',confirm:async()=>assert.fail('confirm'),input:async()=>undefined,custom:async factory=>{const view=factory({terminal:{rows:200},requestRender(){}},null,null,()=>{});rendered=view.render(160).join('\n');view.handleInput('\x1b[F');rendered+='\n'+view.render(160).join('\n');return false;}}};
 assert.match(await editFreePool(x.pool,{setModel:()=>assert.fail('model')},ctx),/cancelled/);assert.match(rendered,/remaining 2/);assert.equal(x.pool.config,before);assert.deepEqual(x.disk,disk);assert.equal(x.sends,1);
});
