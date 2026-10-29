import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FreePool} from '../src/free-pool.js';
import {poolStream,POOL_REQUEST} from '../src/ovh-pool-stream.js';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/compat';
import {environment,K,K2 as SECOND,A,context} from './free-pool-helper.mjs';
const K2='["kilo","second"]';
const output=m=>{const s=createAssistantMessageEventStream(),message={role:'assistant',api:m.api,provider:m.provider,model:m.id,content:[{type:'text',text:'done'}],stopReason:'stop',timestamp:1};s.push({type:'done',reason:'stop',message});s.end(message);return s;};
const drain=async s=>{for await(const _ of s){}return s.result();};
const reply=(status=429,scope)=>new Response('{}',{status,headers:{'retry-after':'10',...(scope?{'x-ratelimit-scope':scope}:{})}});
test('same-provider sibling remains dispatchable after a model-local Kilo rejection',async()=>{
 const x=environment({models:[K,K2],synthetic:true});await x.enable();await x.pool.observe('reflection/beam-free',reply(),{},'kilo');assert.equal(x.pool.until(K),11000);assert.equal(x.pool.until(K2),0);assert.equal(await x.next(),K2);assert.deepEqual(x.disk.barriers,{});assert.equal(x.disk.cooldownEvidence[0].scope,'model');
});
for(const scope of ['provider','service','global','account','ip'])test('explicit server scope '+scope+' is respected, rather than inferred from Retry-After',async()=>{
 const x=environment({models:[K,K2],synthetic:true});await x.enable();await x.pool.observe('reflection/beam-free',reply(429,scope),{},'kilo');assert.equal(x.pool.until(K),11000);assert.equal(x.pool.until(K2),11000);assert.equal(x.disk.cooldownEvidence[0].scope,'service');assert.match(x.pool.cooldownStatus(K2),/explicitly declared by the server/);
});
for(const scope of [undefined,'model','upstream_provider_shared_pool','unknown'])test('unknown/model scope '+scope+' does not create a blanket Kilo block',async()=>{
 const x=environment({models:[K,K2],synthetic:true});await x.enable();await x.pool.observe('reflection/beam-free',reply(429,scope),{},'kilo');assert.equal(x.pool.until(K2),0);
});
async function legacy(run,{corrupt=false,fail=false,withOrigin=true,finite=true,modify=()=>{}}={}){
 const x=environment({models:[K,SECOND,A],cycles:finite?2:0,scheduling:'round-robin'});await x.enable();const dir=await mkdtemp(join(tmpdir(),'continuity-migration-')),file=join(dir,'pool.json');
 const raw={...x.disk,config:{...x.disk.config,cycles:finite?2:0},rotation:corrupt?{cursor:-1}:{cursor:0,used:0,completed:finite?2:0,paused:finite},barriers:{kilo:{until:61000}},ovhReservations:{'gpt-oss-120b':[500,1000]},ovhCooldowns:{models:{'gpt-oss-120b':120000},providerUntil:0},cooldownEvidence:withOrigin?[{service:'kilo',model:'reflection/beam-free',status:429,at:1000,until:61000,scope:'service',source:'fallback',retryAfterState:'missing',retryAfter:null}]:[]};delete raw.policyVersion;delete raw.modelBarriers;
 modify(raw);await writeFile(file,JSON.stringify(raw));const old=await readFile(file,'utf8');const p=new FreePool({catalog:x.catalog,ovhPool:x.ovh,file,now:()=>x.now,...(fail?{persist:async()=>{throw Error('disk failure');}}:{})});
 try{await p.load();await run({x,p,file,old,raw});}finally{p.close();await p.changes;await rm(dir,{recursive:true,force:true});}
}
test('authorized legacy migration removes finite-only pause, retains cursor/counters and all OVH quota, and persists before dispatch',()=>legacy(async({p,file})=>{
 assert.equal(p.config.cycles,0);assert.equal(p.config.enabled,true);assert.equal(p.rotation.completed,2);assert.equal(p.rotation.paused,false);assert.equal(p.until(K),61000);assert.equal(p.until(SECOND),0);assert.equal(p.until(A),120000);assert.deepEqual(p.ovhReservations['gpt-oss-120b'],[500,1000]);assert.deepEqual([...p.barriers],[]);
 const saved=JSON.parse(await readFile(file));assert.equal(saved.policyVersion,3);assert.equal(saved.config.cycles,0);assert.equal(saved.cooldownEvidence[0].scope,'model');
}));
test('unattributable old package-wide Kilo heuristics are retired with a visible policy notice, not copied to all models',()=>legacy(async({p})=>{assert.equal(p.until(K),0);assert.match(p.report(),/no recoverable origin were retired/);assert.equal(p.until(A),120000);},{withOrigin:false}));
test('invalid runtime never gets silently resumed by the continuity migration',()=>legacy(async({p,file,old})=>{assert.equal(p.rotation.paused,true);assert.equal(await readFile(file,'utf8'),old);},{corrupt:true}));
test('migration write failure blocks managed requests instead of falling through as unmanaged',()=>legacy(async({p,x,file,old})=>{assert.equal(p.config.enabled,true);assert.equal(p.rotation.paused,true);assert.equal(await readFile(file,'utf8'),old);await assert.rejects(p.choose(x.model(K),context(),{}),/paused/);assert.match(p.report(),/Could not persist the continuity policy/);},{fail:true}));
test('later explicit finite settings with policy version 3 remain deliberate rather than being silently rewritten',async()=>{
 const x=environment({cycles:1});await x.enable();const dir=await mkdtemp(join(tmpdir(),'finite-current-')),file=join(dir,'pool.json');try{await writeFile(file,JSON.stringify(x.disk));const p=new FreePool({catalog:x.catalog,ovhPool:x.ovh,file,now:()=>x.now});await p.load();assert.equal(p.config.cycles,1);p.close();}finally{await rm(dir,{recursive:true,force:true});}
});
for(const timeout of [0,100])test('owned pre-activity 429 advances to another model even with response-start timeout '+timeout,async()=>{
 const x=environment({models:[K,K2],synthetic:true});await x.enable({responseStartTimeoutMs:timeout});const sends=[];let activity;
 const m=await drain(poolStream({pool:x.pool,model:x.model(K),context:context(),onHandoff:async()=>{},onActivity:r=>activity=r,dispatch:async(model,_c,o)=>{await o[POOL_REQUEST].begin();sends.push(model.id);if(sends.length===1){const r=reply();o[POOL_REQUEST].headers(r);await x.pool.observe(model.id,r,{},'kilo');o[POOL_REQUEST].rejectRateLimit(r);return createAssistantMessageEventStream();}return output(model);}}));
 assert.equal(m.stopReason,'stop');assert.deepEqual(sends,['reflection/beam-free','second']);assert.equal(activity.steps.filter(s=>s.state==='rate-limited').length,1);assert.equal(activity.steps.filter(s=>s.sent).length,2);assert.equal(x.pool.busy,null);
});
test('every model rate-limited terminates boundedly, keeps continuous pool enabled, and never revisits an attempted identity',async()=>{
 const x=environment({models:[K,K2],synthetic:true});await x.enable();const sends=[];const m=await drain(poolStream({pool:x.pool,model:x.model(K),context:context(),onHandoff:async()=>{},dispatch:async(model,_c,o)=>{await o[POOL_REQUEST].begin();sends.push(model.id);const r=reply();o[POOL_REQUEST].headers(r);await x.pool.observe(model.id,r,{},'kilo');o[POOL_REQUEST].rejectRateLimit(r);return createAssistantMessageEventStream();}}));assert.equal(m.stopReason,'error');assert.match(m.errorMessage,/no untried ready compatible model/);assert.deepEqual(sends,['reflection/beam-free','second']);assert.equal(x.pool.config.enabled,true);assert.equal(x.pool.rotation.paused,false);assert.equal(x.pool.busy,null);
});
for(const type of ['text_delta','thinking_delta','toolcall_start'])test('no 429 handoff after meaningful '+type,async()=>{
 const x=environment();await x.enable();let sends=0,allowed;const message={role:'assistant',content:[],api:'openai-completions',provider:'free-kilo',model:'reflection/beam-free',stopReason:'error',timestamp:1};
 const m=await drain(poolStream({pool:x.pool,model:x.model(K),context:context(),onHandoff:async()=>{},dispatch:async(_m,_c,o)=>{await o[POOL_REQUEST].begin();sends++;return{async *[Symbol.asyncIterator](){yield {type,delta:'activity',partial:{content:[]}};const r=reply();o[POOL_REQUEST].headers(r);allowed=o[POOL_REQUEST].rejectRateLimit(r);yield{type:'error',reason:'error',error:message};},result:async()=>message};}}));assert.equal(allowed,false);assert.equal(sends,1);assert.equal(m.stopReason,'error');
});
test('caller cancellation after rejection prevents any fallback',async()=>{
 const x=environment();await x.enable();const c=new AbortController();let sends=0;const m=await drain(poolStream({pool:x.pool,model:x.model(K),context:context(),options:{signal:c.signal},onHandoff:async()=>{},dispatch:async(model,_ctx,o)=>{await o[POOL_REQUEST].begin();sends++;const r=reply();o[POOL_REQUEST].headers(r);await x.pool.observe(model.id,r,{},'kilo');c.abort(Error('user cancelled'));o[POOL_REQUEST].rejectRateLimit(r);return createAssistantMessageEventStream();}}));assert.equal(m.stopReason,'aborted');assert.equal(sends,1);assert.equal(x.pool.busy,null);
});
test('failure to durably save a 429 cooldown prevents fallback',async()=>{
 const x=environment();await x.enable();let sends=0;const m=await drain(poolStream({pool:x.pool,model:x.model(K),context:context(),onHandoff:async()=>{},dispatch:async(model,_ctx,o)=>{await o[POOL_REQUEST].begin();sends++;const r=reply();o[POOL_REQUEST].headers(r);x.setFail(true);await x.pool.observe(model.id,r,{},'kilo');o[POOL_REQUEST].rejectRateLimit(r);return createAssistantMessageEventStream();}}));assert.equal(m.stopReason,'error');assert.equal(sends,1);assert.equal(x.pool.rotation.paused,true);
});

test('legacy migration retains each known model deadline, not just the longest old blanket deadline',()=>legacy(async({p})=>{assert.equal(p.until(K),61000);assert.equal(p.until(K2),11000);},{modify:raw=>raw.cooldownEvidence.push({service:'kilo',model:'second',status:429,at:1000,until:11000,scope:'service',source:'retry-after',retryAfterState:'valid',retryAfter:'10'})}));
