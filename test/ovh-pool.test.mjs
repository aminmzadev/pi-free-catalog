import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Catalog, recordKey } from '../src/catalog.js';
import { registrations } from '../src/models.js';
import { OvhPool, distinctModels } from '../src/ovh-pool.js';
import { cooldownEvidence, retryAt, boundedErrorBody, providerWide } from '../src/ovh-cooldown.js';
import { compatibility, safeBoundary } from '../src/ovh-pool-compat.js';
import { poolStream } from '../src/ovh-pool-stream.js';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { fetcher } from './helpers.mjs';
const A='gpt-oss-120b',B='gpt-oss-20b',C='Qwen3.8-27B';
const now=Date.parse('2026-10-22T00:00:00.000Z');
const catalog=new Catalog({fetch:fetcher()});await catalog.refresh();
const models=()=>new Map(registrations(catalog.state,'ovh').map(m=>[m.id,{...m,provider:'free-ovh'}]));
const context=normalizeContext({messages:[{role:'user',content:'hello',timestamp:1}]});
const opts={reasoning:'low',maxTokens:512};
const body=id=>({error:{type:'rate_limit_error',scope:'model',model:id,period:'minute',limit:2}});
const headers=()=>new Headers({'retry-after':'60','content-type':'application/json'});
const response=id=>Response.json(body(id),{status:429,headers:headers()});
async function setup(extra={}){const pool=new OvhPool({catalog,now:()=>now,getPiLevel:()=> 'low',...extra});await pool.configure('set',[A,B]);return pool;}
async function drain(stream){const events=[];for await(const e of stream)events.push(e);return {events,result:await stream.result()};}
function terminal(model,ctx){const s=createAssistantMessageEventStream();const msg={role:'assistant',content:[{type:'text',text:'ok'}],stopReason:'stop',api:model.api,provider:model.provider,model:model.id,timestamp:1};s.push({type:'done',reason:'stop',message:msg});s.end(msg);return s;}

test('pool is OFF by default, even after selection; default observation cannot enable it',async()=>{
 const p=await setup();assert.equal(p.config.enabled,false);await p.observe(A,response(A));assert.equal(p.confirmed.size,1);assert.equal((await p.choose(models().get(A),context,opts)).id,A);assert.match(p.report(),/OFF \(default\)/);
});
test('stable duplicate exclusion preserves exact order and requires two distinct selected models',async()=>{
 assert.deepEqual(distinctModels([B,A,B,A,C]),[B,A,C]);const p=await setup();await p.configure('set',[B,A,B]);assert.deepEqual(p.config.models,[B,A]);await assert.rejects(p.configure('set',[A,A]),/two distinct/);assert.deepEqual(p.config.models,[B,A]);
});
test('maximum is all currently eligible OVH chat models; other operations and unknown IDs are rejected',async()=>{
 const p=await setup(),all=p.eligible().map(m=>m.id);assert.equal(all.length,10);await p.configure('set',all);assert.deepEqual(p.config.models,all);await assert.rejects(p.configure('set',[A,'unknown']));const other=Object.values(catalog.state.entries).find(e=>e.service==='ovh'&&e.type!=='chat');await assert.rejects(p.configure('set',[A,other.id]));
});
test('configuration persists locally, reloads exactly, and failed saves never activate a new configuration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ovh-pool-'));try{
  const file=join(dir,'pool.json'),p=await setup({file});await p.configure('on');await p.configure('wait',['1000']);const q=await setup({file:undefined});q.file=file;await q.load();assert.deepEqual(q.config,p.config);assert.equal(JSON.parse(await readFile(file)).enabled,true);
  const before=structuredClone(p.config),bytes=await readFile(file);p.persist=async()=>{throw Error('disk full');};await assert.rejects(p.configure('off'));assert.deepEqual(p.config,before);assert.deepEqual(await readFile(file),bytes);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('corrupt and oversized local configuration fails closed, without metadata requests or automatic pool fill',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ovh-pool-corrupt-'));try{
  const file=join(dir,'pool.json'),p=await setup({file});await writeFile(file,'{');await p.load();assert.equal(p.config.enabled,false);assert.deepEqual(p.config.models,[]);assert.match(p.report(),/invalid/);await writeFile(file,' '.repeat(65537));await p.load();assert.equal(p.config.enabled,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('a formerly selected unavailable model is retained and reported; the eligible primary can continue',async()=>{
 const c=new Catalog({fetch:fetcher()});await c.refresh();const p=await setup({catalog:c});await p.configure('on');c.state.entries[recordKey('ovh',B)].lifecycle='retired';assert.deepEqual(p.config.models,[A,B]);assert.match(p.report(),/eligible: 1/);assert.equal((await p.choose(models().get(A),context,opts)).id,A);
});
test('only complete exact model/minute/anonymous-lane evidence plus valid Retry-After confirms cooldown',()=>{
 assert.deepEqual(cooldownEvidence(A,429,headers(),body(A),now),{model:A,until:now+60000,scope:'model',period:'minute'});
});
for(const [label,alter]of[
 ['generic429',e=>({error:{type:'rate_limit_error',message:'model minute limit'}})],['wrong-model',e=>{e.error.model=B;return e;}],['missing-scope',e=>{delete e.error.scope;return e;}],['provider-scope',e=>{e.error.scope='provider';return e;}],['global-flag',e=>{e.error.global=true;return e;}],['IP-flag',e=>{e.error.ip_wide=true;return e;}],['wrong-period',e=>{e.error.period='day';return e;}],['wrong-limit',e=>{e.error.limit=20;return e;}],['authentication-type',e=>{e.error.type='authentication_error';return e;}],['conflicting-scope',e=>{e.scope='global';return e;}],
])test('no handoff from '+label,async()=>{
 const p=await setup();await p.configure('on');const json=alter(body(A));assert.equal(cooldownEvidence(A,429,headers(),json,now),null);await p.observe(A,Response.json(json,{status:429,headers:headers()}));assert.equal(p.confirmed.has(A),false);
});
for(const status of [400,401,403,404,408,500,502,503])test('non-rate-limit status '+status+' cannot authorize rotation',async()=>{
 const p=await setup();await p.configure('on');await p.observe(A,Response.json(body(A),{status,headers:headers()}));assert.equal(p.confirmed.has(A),false);
});
test('Retry-After parsing is strict and never accepts prose, missing, zero, past, overflow or malformed dates',()=>{
 for(const s of [null,'','60 sec','1e2','Infinity','-1','0','1'.repeat(400),'Thu, 01 Jan 1970 00:00:00 GMT'])assert.equal(retryAt(s,now),null,s);assert.equal(retryAt('60',now),now+60000);assert.equal(retryAt('0.5',now),now+500);assert.equal(retryAt(new Date(now+60000).toUTCString(),now),now+60000);
 const h=headers();h.set('retry-after','bad');assert.equal(cooldownEvidence(A,429,h,body(A),now),null);h.set('retry-after','60');h.set('x-ratelimit-scope','ip');assert.equal(cooldownEvidence(A,429,h,body(A),now),null);
});
test('provider-wide limits block the whole pool and do not bypass the cooldown through a different selected model',async()=>{
 const p=await setup();await p.configure('on');await p.observe(A,response(A));await p.observe(B,Response.json({error:{type:'rate_limit_error',scope:'provider'}},{status:429,headers:headers()}));assert.ok(p.providerUntil>now);assert.equal(p.confirmed.size,0);await assert.rejects(p.choose(models().get(A),context,opts),/Provider-wide/);
});
test('confirmed current cooldown hands off in selected priority order; never selects unlisted pool members',async()=>{
 const p=await setup();await p.configure('set',[A,C,B]);await p.configure('on');await p.observe(A,response(A));const next=await p.choose(models().get(A),context,opts);assert.equal(next.id,C);await p.configure('set',[A,B]);assert.equal((await p.choose(models().get(A),context,opts)).id,B);assert.equal((await p.choose(models().get(C),context,opts)).id,C);
});
test('first local attempt does not block the server-allowed second slot or authorize a handoff',async()=>{
 const p=await setup();await p.configure('on');p.started(A);assert.equal((await p.choose(models().get(A),context,opts)).id,A);assert.equal(p.confirmed.size,0);
});
test('exhausted pool returns a clear error without retries, while a bounded wait respects every cooldown',async()=>{
 let time=now,sleeps=[];const p=await setup({now:()=>time,sleep:async ms=>{sleeps.push(ms);time+=ms;}});await p.configure('on');await p.observe(A,response(A));p.ready.set(B,now+31000);await assert.rejects(p.choose(models().get(A),context,opts),/wait is disabled/);await p.configure('wait',['60000']);const next=await p.choose(models().get(A),context,opts);assert.equal(next.id,B);assert.deepEqual(sleeps,[31000]);assert.equal(time,now+31000);
});
test('a Retry-After extension during waiting is rechecked instead of dispatching early',async()=>{
 let time=now,count=0;const p=await setup({now:()=>time,sleep:async ms=>{time+=ms;if(++count===1)p.ready.set(B,time+5000);}});await p.configure('on');await p.configure('wait',['60000']);await p.observe(A,response(A));p.ready.set(B,now+31000);assert.equal((await p.choose(models().get(A),context,opts)).id,B);assert.equal(count,2);assert.equal(time,now+36000);
});
function check(extra={}){return compatibility({catalog,source:models().get(A),target:models().get(B),context,options:opts,getSelection:()=> 'auto',piLevel:'low',...extra});}
test('same-window, tool-capable models with identical native thinking settings are compatible',()=>assert.equal(check(),null));
test('default SDK output clamp is preserved for same-or-larger windows',()=>assert.equal(check({options:{reasoning:'low'}}),null));
test('smaller/unknown context, incompatible output and oversized transcripts are rejected',()=>{
 assert.match(check({target:{...models().get(B),contextWindow:1024}}),/Context/);assert.match(check({options:{...opts,maxTokens:999999}}),/Output/);assert.match(check({context:normalizeContext({messages:[{role:'user',content:'x'.repeat(150000),timestamp:1}]})}),/Context/);
});
test('tool declarations/history require explicit tools support',()=>{
 const c=new Catalog();c.state=structuredClone(catalog.state);c.state.entries[recordKey('ovh',B)].metadata.tool_call=false;const ctx=normalizeContext({messages:[],tools:[{name:'write',description:'write',parameters:{type:'object'}}]});assert.match(check({catalog:c,context:ctx}),/Tools/);
});
test('different supported thinking modes are allowed; unsupported target values are rejected',()=>{
 assert.equal(check({getSelection:(_s,id)=>id===A?'default':'auto'}),null);const c=new Catalog();c.state=structuredClone(catalog.state);c.state.entries[recordKey('ovh',B)].metadata.reasoning_options=[{type:'effort',values:['high']}];assert.match(check({catalog:c}),/thinking|Thinking/);
});
test('unfinished tool calls, executing tools, pending/deferred and multimodal histories still cannot hand off',()=>{
 for(const content of [[{type:'toolCall',id:'x',name:'write',arguments:{}}],[{type:'image',data:'AA==',mimeType:'image/png'}]]){
  const ctx=normalizeContext({messages:[{role:'assistant',content,timestamp:1}]});assert.ok(check({context:ctx}));
 }
 assert.ok(check({toolsRunning:true}));for(const stopReason of ['pending','deferred'])assert.ok(check({context:normalizeContext({messages:[{role:'assistant',content:[],stopReason,timestamp:1}]})}));
 const completed=normalizeContext({messages:[{role:'assistant',content:[{type:'toolCall',id:'x',name:'write',arguments:{}}],timestamp:1},{role:'toolResult',toolCallId:'x',toolName:'write',content:[{type:'text',text:'done'}],timestamp:2}]});assert.equal(safeBoundary(completed),null);
});
test('stream boundary calls exactly one SDK stream and preserves the exact transcript reference and all caller options',async()=>{
 const p=await setup();await p.configure('on');await p.observe(A,response(A));const calls=[];let switched=0;
 const r=await drain(poolStream({pool:p,model:models().get(A),context,options:opts,onHandoff:async()=>switched++,dispatch:(model,ctx,options)=>{calls.push({model,ctx,options});return terminal(model,ctx);}}));assert.equal(switched,1);assert.equal(calls.length,1);assert.equal(calls[0].model.id,B);assert.equal(calls[0].ctx,context);assert.equal(calls[0].options.reasoning,opts.reasoning);assert.equal(calls[0].options.maxTokens,opts.maxTokens);assert.equal(opts.signal,undefined);assert.equal(r.result.model,B);
});
test('caller cancellation releases the wait/lock and does not dispatch or switch',async()=>{
 const p=await setup();await p.configure('on');await p.configure('wait',['60000']);await p.observe(A,response(A));await p.observe(B,response(B));let sent=0,switched=0;const ctrl=new AbortController();const s=poolStream({pool:p,model:models().get(A),context,options:{...opts,signal:ctrl.signal},onHandoff:async()=>switched++,dispatch:()=>{sent++;}});ctrl.abort();const r=await drain(s);assert.equal(r.result.stopReason,'aborted');assert.equal(sent,0);assert.equal(switched,0);assert.equal(p.busy,null);
});
test('the overall wait deadline bounds a non-cooperative scheduler, with no dispatch',async()=>{
 const hold=setTimeout(()=>{},100);try{
  const p=await setup({sleep:()=>new Promise(()=>{})});await p.configure('on');await p.configure('wait',['10']);await p.observe(A,response(A));await p.observe(B,response(B));const r=await drain(poolStream({pool:p,model:models().get(A),context,options:opts,dispatch:()=>{throw Error('must not dispatch');},onHandoff:async()=>{}}));assert.equal(r.result.stopReason,'error');assert.match(r.result.errorMessage,/local wait budget expired before HTTP/);assert.equal(p.busy,null);
 }finally{clearTimeout(hold);}
});
test('error-body inspection is bounded, does not consume the original, and rejects malformed/non-JSON/oversized errors',async()=>{
 const r=response(A);assert.deepEqual(await boundedErrorBody(r),body(A));assert.deepEqual(await r.json(),body(A));assert.equal(await boundedErrorBody(new Response('hi')),null);assert.equal(await boundedErrorBody(Response.json({a:'x'.repeat(17000)})),null);assert.equal(await boundedErrorBody(new Response('{',{headers:{'content-type':'application/json'}})),null);
});
test('unknown context metadata is not invented by the pool',()=>{
 const c=new Catalog();c.state=structuredClone(catalog.state);delete c.state.entries[recordKey('ovh',B)].metadata.context_length;assert.match(check({catalog:c}),/unverified/);
});
test('unsigned reasoning history is expendable and does not prevent handoff',()=>{
 assert.equal(check({context:normalizeContext({messages:[{role:'assistant',content:[{type:'thinking',thinking:'private chain'}],timestamp:1}]})}),null);
});
test('successful/auth/invalid responses and network failures clear a prior model-specific trigger',async()=>{
 for(const status of [200,400,401,403]){const p=await setup();await p.configure('on');await p.observe(A,response(A));assert.ok(p.confirmed.has(A));await p.observe(A,Response.json({}, {status}));assert.equal(p.confirmed.has(A),false);}
 const p=await setup();await p.configure('on');await p.observe(A,response(A));p.networkFailure(A);assert.equal(p.confirmed.has(A),false);
});
test('configuration changes while queued cancel preflight without a handoff or dispatch',async()=>{
 const p=await setup();await p.configure('on');await p.observe(A,response(A));let sent=0,switched=0;const s=poolStream({pool:p,model:models().get(A),context,options:opts,onHandoff:async()=>switched++,dispatch:()=>{sent++;}});await p.configure('off');const r=await drain(s);assert.equal(r.result.stopReason,'error');assert.equal(sent,0);assert.equal(switched,0);
});
test('a currently active stream is never interrupted by a second pool call',async()=>{
 const p=await setup();await p.configure('on');let finish;const gate=new Promise(r=>finish=r);let calls=0;const dispatch=(m)=>{calls++;const s=createAssistantMessageEventStream();void gate.then(()=>{const msg={role:'assistant',model:m.id,content:[],stopReason:'stop',timestamp:1};s.push({type:'done',reason:'stop',message:msg});s.end(msg);});return s;};
 const first=poolStream({pool:p,model:models().get(A),context,options:opts,dispatch,onHandoff:async()=>{throw Error('must not switch');}});await new Promise(r=>setImmediate(r));const second=await drain(poolStream({pool:p,model:models().get(B),context,options:opts,dispatch,onHandoff:async()=>{throw Error('must not switch');}}));assert.equal(second.result.stopReason,'error');assert.match(second.result.errorMessage,/already active/);assert.equal(calls,1);finish();assert.equal((await drain(first)).result.stopReason,'stop');
});
test('shutdown cancels a pending bounded scheduler and releases its lock without dispatch',async()=>{
 const p=await setup();await p.configure('on');await p.configure('wait',['60000']);await p.observe(A,response(A));await p.observe(B,response(B));const s=poolStream({pool:p,model:models().get(A),context,options:opts,onHandoff:async()=>{throw Error('must not switch');},dispatch:()=>{throw Error('must not send');}});p.close();assert.equal((await drain(s)).result.stopReason,'aborted');assert.equal(p.busy,null);
});
test('bounded inspection handles stalled clones without consuming or hanging the upstream error body',async()=>{
 const hold=setTimeout(()=>{},100);let cancelled=false;
 try{const r={headers:new Headers({'content-type':'application/json'}),clone:()=>({body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:async()=>{cancelled=true;}})}})};assert.equal(await boundedErrorBody(r,{timeout:5}),null);assert.ok(cancelled);}finally{clearTimeout(hold);}
});
test('unknown-scope responses do not consume a stream body without declared JSON',async()=>{
 const p=await setup();await p.configure('on');let cloned=false;await p.observe(A,{status:429,headers:new Headers({'retry-after':'60'}),clone(){cloned=true;throw Error('not JSON');}});assert.equal(cloned,false);assert.equal(p.confirmed.has(A),false);
});
test('eligibility is revalidated after model-switch hooks and before any network dispatch',async()=>{
 const c=new Catalog();c.state=structuredClone(catalog.state);const p=await setup({catalog:c});await p.configure('on');await p.observe(A,response(A));let calls=0;
 const r=await drain(poolStream({pool:p,model:models().get(A),context,options:opts,onHandoff:async()=>{c.state.entries[recordKey('ovh',B)].lifecycle='retired';},dispatch:()=>calls++}));assert.equal(r.result.stopReason,'error');assert.equal(calls,0);assert.match(r.result.errorMessage,/revalidation/);
});
test('orphan/duplicate tool results are not normalized into invented state by the fallback coordinator',()=>{
 assert.ok(safeBoundary({messages:[{role:'toolResult',toolCallId:'missing',content:[]}]}));
 assert.ok(safeBoundary({messages:[{role:'assistant',content:[{type:'toolCall',id:'a'}]},{role:'toolResult',toolCallId:'a',content:[]},{role:'toolResult',toolCallId:'a',content:[]}]}));
});

test('unknown output metadata cannot be promoted from a local numeric registration fallback',()=>{
 const c=new Catalog();c.state=structuredClone(catalog.state);delete c.state.entries[recordKey('ovh',B)].metadata.max_completion_tokens;assert.match(check({catalog:c}),/Output limit is unverified/);
});
test('root-level global/provider/IP flags block the pool, including earlier cooldown triggers on other models',async()=>{
 for(const key of ['provider_wide','global','account_wide','ip_wide']){
  const p=await setup();await p.configure('on');await p.observe(A,response(A));await p.observe(B,Response.json({[key]:true,error:{type:'rate_limit_error'}},{status:429,headers:headers()}));assert.ok(p.providerUntil>now);assert.equal(p.confirmed.size,0);await assert.rejects(p.choose(models().get(A),context,opts),/Provider-wide/);
 }
});

// Regression fixes: reasoning history is expendable; priority recovery is checked on every call.
for(const [label,blocks]of[
 ['signed-thinking',[{type:'thinking',thinking:'old private reasoning',thinkingSignature:'opaque'}]],
 ['redacted-thinking',[{type:'thinking',thinking:'',redacted:true,thinkingSignature:'encrypted'}]],
 ['thought-signature-on-text',[{type:'text',text:'visible answer',thoughtSignature:'opaque'}]],
])test('reasoning metadata never blocks handoff: '+label,async()=>{
 const ctx=normalizeContext({messages:[{role:'assistant',provider:'free-ovh',api:'openai-completions',model:A,content:blocks,stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0},timestamp:1}]});
 assert.equal(safeBoundary(ctx),null);assert.equal(check({context:ctx}),null);
 const p=await setup();await p.configure('on');await p.observe(A,response(A));let switched=0;
 const before=JSON.stringify(ctx);const out=await drain(poolStream({pool:p,model:models().get(A),context:ctx,options:opts,onHandoff:async()=>switched++,dispatch:(m,actual)=>{assert.equal(actual,ctx);return terminal(m);}}));
 assert.equal(out.result.model,B);assert.equal(switched,1);assert.equal(JSON.stringify(ctx),before);
});
test('large foreign reasoning/signatures dropped by Pi do not falsely exhaust the handoff budget',()=>{
 const ctx=normalizeContext({messages:[{role:'assistant',provider:'free-ovh',api:'openai-completions',model:A,content:[{type:'thinking',thinking:'x'.repeat(200000),thinkingSignature:'signature'},{type:'text',text:'visible',thoughtSignature:'x'.repeat(200000)}],stopReason:'stop',usage:{input:100000,output:50000,cacheRead:0,cacheWrite:0,totalTokens:150000},timestamp:1}]});
 assert.equal(check({context:ctx}),null);
});
test('signed completed tool calls remain valid, while unfinished calls still block independently of reasoning',()=>{
 const assistant={role:'assistant',provider:'free-ovh',api:'openai-completions',model:A,content:[{type:'thinking',thinking:'plan',redacted:true},{type:'toolCall',id:'signed_call',name:'write',arguments:{},thoughtSignature:'opaque'}],timestamp:1};
 assert.match(safeBoundary({messages:[assistant]}),/Unresolved/);
 const ctx=normalizeContext({messages:[assistant,{role:'toolResult',toolCallId:'signed_call',toolName:'write',content:[{type:'text',text:'saved once'}],timestamp:2}]});
 assert.equal(safeBoundary(ctx),null);assert.equal(check({context:ctx}),null);
});
test('healthy fallback automatically returns to primary at exact cooldown expiry, without a new failure',async()=>{
 let time=now;const p=await setup({now:()=>time});await p.configure('on');await p.observe(A,response(A));
 assert.equal((await p.choose(models().get(A),context,opts)).id,B);
 time=now+59999;assert.equal((await p.choose(models().get(B),context,opts)).id,B);
 time=now+60000;assert.equal(p.confirmed.has(B),false);assert.equal((await p.choose(models().get(B),context,opts)).id,A);
});
test('priority recovery evaluates the exact stored order, not a hard-coded primary ID',async()=>{
 const p=await setup();await p.configure('set',[B,A]);await p.configure('on');
 assert.equal((await p.choose(models().get(A),context,opts)).id,B);
 await p.configure('set',[A,C,B]);p.ready.set(A,now+60000);
 assert.equal((await p.choose(models().get(B),context,opts)).id,C);
 p.ready.delete(A);assert.equal((await p.choose(models().get(B),context,opts)).id,A);
});
test('failback respects primary pacing and Retry-After extensions, without probing any cooling model',async()=>{
 let time=now;const p=await setup({now:()=>time});await p.configure('on');await p.observe(A,response(A));
 p.ready.set(A,now+90000);time=now+60000;assert.equal((await p.choose(models().get(B),context,opts)).id,B);
 time=now+90000;assert.equal((await p.choose(models().get(B),context,opts)).id,A);
});
test('primary incompatibility keeps a healthy fallback; recovery never bypasses context/tools/thinking guards',async()=>{
 const c=new Catalog();c.state=structuredClone(catalog.state);const p=await setup({catalog:c});await p.configure('on');
 c.state.entries[recordKey('ovh',A)].metadata.tool_call=false;
 const ctx=normalizeContext({messages:[],tools:[{name:'write',description:'write',parameters:{type:'object'}}]});
 assert.equal((await p.choose(models().get(B),ctx,opts)).id,B);
 c.state.entries[recordKey('ovh',A)].metadata.tool_call=true;
 p.getSelection=(_s,id)=>id===A?'default':'auto';assert.equal((await p.choose(models().get(B),context,opts)).id,A);
 p.getSelection=()=> 'auto';p.toolsRunning=()=>true;await assert.rejects(p.choose(models().get(B),context,opts),/tool is still executing/);
 p.toolsRunning=()=>false;assert.equal((await p.choose(models().get(B),context,opts)).id,A);
});
test('an unfinished tool call prevents failback even when the primary is ready',async()=>{
 const p=await setup();await p.configure('on');
 const ctx=normalizeContext({messages:[{role:'assistant',content:[{type:'thinking',thinking:'plan'},{type:'toolCall',id:'pending',name:'bash',arguments:{}}],timestamp:1}]});
 await assert.rejects(p.choose(models().get(B),ctx,opts),/Unresolved tool calls/);
});
test('global provider limit blocks priority failback as well as downward fallback',async()=>{
 const p=await setup();await p.configure('on');await p.observe(B,Response.json({error:{type:'rate_limit_error',scope:'global'}},{status:429,headers:headers()}));
 await assert.rejects(p.choose(models().get(B),context,opts),/Provider-wide/);
});
test('bounded waiting re-evaluates priority when the primary becomes ready before the fallback',async()=>{
 let time=now;const sleeps=[];const p=await setup({now:()=>time,sleep:async ms=>{sleeps.push(ms);time+=ms;}});await p.configure('on');await p.configure('wait',['60000']);
 p.ready.set(A,now+10000);p.ready.set(B,now+20000);
 assert.equal((await p.choose(models().get(B),context,opts)).id,A);assert.deepEqual(sleeps,[10000]);
});
test('cancellation before failback never changes models or dispatches a request',async()=>{
 const p=await setup();await p.configure('on');const controller=new AbortController();controller.abort();let calls=0;
 const out=await drain(poolStream({pool:p,model:models().get(B),context,options:{...opts,signal:controller.signal},onHandoff:async()=>calls++,dispatch:()=>calls++}));
 assert.equal(out.result.stopReason,'aborted');assert.equal(calls,0);
});

test('real SDK drops foreign signed/redacted reasoning but preserves visible messages and completed tool results on forced handoff',async()=>{
 const {completions}=await import('../src/sdk.js');const {scopedFetch}=await import('../src/transport.js');
 const p=await setup();await p.configure('on');await p.observe(A,response(A));
 const ctx=normalizeContext({messages:[{role:'user',content:'original request',timestamp:1},{role:'assistant',provider:'free-ovh',api:'openai-completions',model:A,stopReason:'toolUse',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0},timestamp:2,content:[
  {type:'thinking',thinking:'private reasoning to discard',thinkingSignature:'opaque-signed'},
  {type:'thinking',thinking:'',redacted:true,thinkingSignature:'encrypted-redaction'},
  {type:'text',text:'visible completed work'},
  {type:'toolCall',id:'call_read_done',name:'read',arguments:{path:'proof.txt'},thoughtSignature:'opaque-tool-signature'},
 ]},{role:'toolResult',toolCallId:'call_read_done',toolName:'read',content:[{type:'text',text:'already read once'}],isError:false,timestamp:3},{role:'user',content:'continue',timestamp:4}],tools:[{name:'read',description:'read',parameters:{type:'object',properties:{path:{type:'string'}}}}]});
 const before=JSON.stringify(ctx),wires=[];
 const out=await drain(poolStream({pool:p,model:models().get(A),context:ctx,options:opts,onHandoff:async()=>{},dispatch:(m,transcript,options)=>completions(m,transcript,{...options,apiKey:'public',maxRetries:0,fetch:scopedFetch({catalog,service:'ovh',model:m,session:'offline',getFetch:()=>async(url,init)=>{wires.push(JSON.parse(init.body));return new Response('data: {"id":"ok","choices":[{"index":0,"delta":{"content":"continued"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}})})}));
 assert.equal(out.result.stopReason,'stop');assert.equal(out.result.model,B);assert.equal(wires.length,1);assert.equal(wires[0].model,B);
 const text=JSON.stringify(wires[0].messages);for(const preserved of ['original request','visible completed work','call_read_done','already read once','continue'])assert.ok(text.includes(preserved));
 for(const discarded of ['private reasoning to discard','opaque-signed','encrypted-redaction','opaque-tool-signature'])assert.ok(!text.includes(discarded));
 assert.equal(JSON.stringify(ctx),before);
});

const liveMinuteBody=()=>({message:'API rate limit exceeded',request_id:'968bc57595ae7a6d59e2751cad03d322'});
const liveMinuteHeaders=()=>new Headers({'retry-after':'24','ratelimit-limit':'2','ratelimit-remaining':'0','ratelimit-reset':'24','x-ratelimit-limit-minute':'2','x-ratelimit-remaining-minute':'0','inference-id':liveMinuteBody().request_id,'content-type':'application/json'});
const liveRequest={model:A,url:'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',anonymousRateLimit:2};
function observed429(){const r=Response.json(liveMinuteBody(),{status:429,headers:liveMinuteHeaders()});Object.defineProperty(r,'url',{value:liveRequest.url});return r;}
test('captured OVH minute response requires trusted endpoint/entitlement, four agreeing quota headers and correlation ID',()=>{
 assert.deepEqual(cooldownEvidence(A,429,liveMinuteHeaders(),liveMinuteBody(),now,liveRequest),{model:A,until:now+24000,scope:'model',period:'minute'});
 assert.equal(cooldownEvidence(A,429,liveMinuteHeaders(),liveMinuteBody(),now),null);
 for(const request of [{...liveRequest,url:liveRequest.url+'?x=1'},{...liveRequest,url:'https://example.com/chat/completions'},{...liveRequest,anonymousRateLimit:undefined},{...liveRequest,anonymousRateLimit:20},{...liveRequest,model:B}])assert.equal(cooldownEvidence(A,429,liveMinuteHeaders(),liveMinuteBody(),now,request),null);
});
for(const [key,value]of [['ratelimit-limit','20'],['x-ratelimit-limit-minute','3'],['ratelimit-remaining','1'],['x-ratelimit-remaining-minute','1'],['ratelimit-reset','25.5'],['ratelimit-reset','61'],['ratelimit-reset','30'],['inference-id','wrong'],['retry-after','0'],['retry-after','120'],['x-ratelimit-limit-hour','2'],['x-ratelimit-scope','provider'],['x-ratelimit-model',B],['x-ratelimit-window','3600'],['ratelimit-policy','2;w=3600']])test('observed OVH minute contract rejects conflicting '+key+'='+value,()=>{
 const h=liveMinuteHeaders();h.set(key,value);assert.equal(cooldownEvidence(A,429,h,liveMinuteBody(),now,liveRequest),null);
});
for(const key of ['retry-after','ratelimit-limit','x-ratelimit-limit-minute','ratelimit-remaining','x-ratelimit-remaining-minute','ratelimit-reset','inference-id'])test('observed OVH minute contract refuses missing '+key,()=>{
 const h=liveMinuteHeaders();h.delete(key);assert.equal(cooldownEvidence(A,429,h,liveMinuteBody(),now,liveRequest),null);
});
test('generic/body-only/auth/network/daily/global and request-ID mismatches never acquire observed OVH evidence',()=>{
 for(const b of [{message:'rate limit',request_id:liveMinuteBody().request_id},{error:{type:'rate_limit_error'}},{...liveMinuteBody(),request_id:'other'},{...liveMinuteBody(),scope:'provider'},{...liveMinuteBody(),global:true},{...liveMinuteBody(),error:{scope:'ip'}},null,[]])assert.equal(cooldownEvidence(A,429,liveMinuteHeaders(),b,now,liveRequest),null);
 for(const status of [200,400,401,403,500,503])assert.equal(cooldownEvidence(A,status,liveMinuteHeaders(),liveMinuteBody(),now,liveRequest),null);
 const h=liveMinuteHeaders();h.set('retry-after',new Date(now+24000).toUTCString());assert.ok(cooldownEvidence(A,429,h,liveMinuteBody(),now,liveRequest));
});
test('real-format 429 hands off next boundary and restores priority after expiry without replaying dispatch',async()=>{
 let time=now;const p=await setup({now:()=>time});await p.configure('on');
 await p.observe(A,observed429());assert.ok(p.confirmed.has(A));let calls=[];
 let out=await drain(poolStream({pool:p,model:models().get(A),context,options:opts,dispatch:(m,c)=>{calls.push(m.id);return terminal(m,c);},onHandoff:async()=>{}}));
 assert.equal(out.result.model,B);assert.deepEqual(calls,[B]);time+=31000;
 out=await drain(poolStream({pool:p,model:models().get(B),context,options:opts,dispatch:(m,c)=>{calls.push(m.id);return terminal(m,c);},onHandoff:async()=>{}}));
 assert.deepEqual(calls,[B,A]);
});
test('observed headers cannot authorize another endpoint, redirected response or missing anonymous entitlement',async()=>{
 for(const variant of ['endpoint','redirect','entitlement']){
  const c=new Catalog({fetch:fetcher()});await c.refresh();const p=await setup({catalog:c});await p.configure('on');const r=Response.json(liveMinuteBody(),{status:429,headers:liveMinuteHeaders()});
  Object.defineProperty(r,'url',{value:variant==='endpoint'?'https://example.com/other':liveRequest.url});if(variant==='redirect')Object.defineProperty(r,'redirected',{value:true});if(variant==='entitlement')c.state.entries[recordKey('ovh',A)].metadata.ovh.anonymousRateLimit=undefined;
  await p.observe(A,r);assert.equal(p.confirmed.size,0,variant);
 }
});
