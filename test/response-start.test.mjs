// Scheduler/SDK streams are local fixtures. No provider requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Catalog, recordKey } from '../src/catalog.js';
import { registrations } from '../src/models.js';
import { OvhPool } from '../src/ovh-pool.js';
import { poolStream, POOL_REQUEST, meaningfulActivity } from '../src/ovh-pool-stream.js';
import { normalizeContext, createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { state } from './helpers.mjs';
const A='gpt-oss-120b',B='gpt-oss-20b',C='Qwen3.8-27B',D='Qwen3.5-397B-A17B';
const context=normalizeContext({messages:[{role:'user',content:'hello',timestamp:1}]});
async function fixture(extra={}) {
 const catalog=new Catalog({fetch:()=>{throw Error('No network');}});catalog.state=state();
 const p=new OvhPool({catalog,getPiLevel:()=> 'low',...extra});
 await p.saveDraft({...p.config,enabled:true,models:[A,B],thinking:{[A]:'default',[B]:'default'},responseStartTimeoutMs:20});
 const models=new Map(registrations(catalog.state,'ovh').map(m=>[m.id,{...m,provider:'free-ovh'}]));
 return {p,catalog,models};
}
const message=(m,content=[{type:'text',text:'ok'}],stopReason='stop')=>({role:'assistant',api:m.api,provider:m.provider,model:m.id,content,stopReason,timestamp:1});
function done(m,s=createAssistantMessageEventStream()) {const msg=message(m);s.push({type:'done',reason:'stop',message:msg});s.end(msg);return s;}
async function drain(s){const events=[];for await(const e of s)events.push(e);return {events,result:await s.result()};}
function begin(p,m,options){options[POOL_REQUEST].begin();p.started(m.id);}

test('first-activity definition excludes headers, whitespace, empty starts and includes thinking/tool data',()=>{
 for(const e of [{type:'start',partial:{content:[]}},{type:'text_start',partial:{content:[{type:'text',text:''}]}},{type:'thinking_delta',delta:''},{type:'text_delta',delta:' \n'}])assert.equal(meaningfulActivity(e),false);
 for(const e of [{type:'thinking_delta',delta:'plan'},{type:'text_delta',delta:'a'},{type:'toolcall_start',partial:{content:[]}}])assert.equal(meaningfulActivity(e),true);
});
test('silent attempt buffers structural events, aborts, discards late output and consumes quota without refund',async()=>{
 const {p,models}=await fixture();const sent=[],signals=[],activity=[];let late;
 const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{},onActivity:r=>activity.push(r),dispatch:(m,c,o)=>{
  assert.equal(c,context);begin(p,m,o);sent.push(m.id);signals.push(o.signal);
  if(m.id===B)return done(m);
  const s=createAssistantMessageEventStream();s.push({type:'start',partial:message(m,[])});late=()=>{s.push({type:'text_delta',delta:'LATE_FROM_A',partial:message(m)});done(m,s);};return s;
 }}));
 assert.deepEqual(sent,[A,B]);assert.ok(signals[0].aborted);assert.equal(out.result.model,B);assert.doesNotMatch(JSON.stringify(out.events),/LATE_FROM_A/);assert.equal(out.events.filter(e=>e.type==='start').length,0);
 late();await delay(5);assert.equal(p.busy,null);assert.equal(p.quota.describe(A).remaining,1);assert.equal(p.quota.describe(B).remaining,1);assert.equal(activity.length,1);assert.deepEqual(activity[0].steps.map(s=>s.state),['timed-out','responded']);p.close();
});
test('response timer starts only at real dispatch, not while SDK builds a payload',async()=>{
 const {p,models}=await fixture();let calls=0;
 const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{throw Error('must not switch');},dispatch:(m,c,o)=>{
  calls++;const s=createAssistantMessageEventStream();setTimeout(()=>{begin(p,m,o);done(m,s);},45);return s;
 }}));assert.equal(out.result.stopReason,'stop');assert.equal(calls,1);p.close();
});
for(const type of ['text_delta','thinking_delta','toolcall_start'])test(type+' commits one stream and disables timeout for a slow remaining response',async()=>{
 const {p,models}=await fixture();let calls=0;
 const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{throw Error('no mid-stream switch');},dispatch:(m,c,o)=>{
  calls++;begin(p,m,o);const s=createAssistantMessageEventStream();s.push({type:'start',partial:message(m,[])});s.push({type,delta:'active',partial:message(m)});setTimeout(()=>done(m,s),55);return s;
 }}));assert.equal(out.result.stopReason,'stop');assert.equal(calls,1);assert.equal(out.events[0].type,'start');p.close();
});
for(const status of [400,401,403,408,429,500,503])test('known HTTP '+status+' cannot become a response-start timeout while the error body stalls',async()=>{
 const {p,models}=await fixture();let calls=0;
 const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{throw Error('must not rotate');},dispatch:(m,c,o)=>{
  calls++;begin(p,m,o);o[POOL_REQUEST].headers(new Response(null,{status}));const s=createAssistantMessageEventStream();setTimeout(()=>{const msg={...message(m,[],'error'),errorMessage:'GENUINE_PROVIDER_ERROR_'+status};s.push({type:'error',reason:'error',error:msg});s.end(msg);},55);return s;
 }}));assert.equal(calls,1);assert.match(out.result.errorMessage,new RegExp('GENUINE_PROVIDER_ERROR_'+status));p.close();
});
test('genuine SDK/network errors remain errors, not automatic failover',async()=>{
 for(const mode of ['throw','delayed']){
  const {p,models}=await fixture();let calls=0;
  const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{},dispatch:(m,c,o)=>{
   calls++;begin(p,m,o);o[POOL_REQUEST].failed();
   if(mode==='throw')throw Error('ORIGINAL_NETWORK_ERROR');
   const s=createAssistantMessageEventStream();setTimeout(()=>{const msg={...message(m,[],'error'),errorMessage:'ORIGINAL_NETWORK_ERROR'};s.push({type:'error',reason:'error',error:msg});s.end(msg);},45);return s;
  }}));assert.equal(calls,1);assert.match(out.result.errorMessage,/ORIGINAL_NETWORK_ERROR/);p.close();
 }
});
test('exhaustion sends each model once, stops clearly, releases lock and can restore primary on a new inference',async()=>{
 const {p,models}=await fixture();const sent=[];
 let out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{},dispatch:(m,c,o)=>{begin(p,m,o);sent.push(m.id);return createAssistantMessageEventStream();}}));
 assert.deepEqual(sent,[A,B]);assert.match(out.result.errorMessage,/exhausted after response-start timeout.*2 model/);assert.equal(p.busy,null);
 out=await drain(poolStream({pool:p,model:models.get(B),context,onHandoff:async()=>{},dispatch:(m,c,o)=>{begin(p,m,o);sent.push(m.id);return done(m);}}));
 assert.equal(out.result.model,A);assert.deepEqual(sent,[A,B,A]);p.close();
});
for(const action of ['cancel','shutdown'])test(action+' wins over the deadline and never advances the chain, even when provider ignores abort',async()=>{
 const {p,models}=await fixture();const ctrl=new AbortController();let calls=0;
 const s=poolStream({pool:p,model:models.get(A),context,options:{signal:ctrl.signal},onHandoff:async()=>{},dispatch:(m,c,o)=>{begin(p,m,o);calls++;queueMicrotask(()=>action==='shutdown'?p.close():ctrl.abort());return createAssistantMessageEventStream();}});
 const out=await drain(s);assert.equal(out.result.stopReason,'aborted');assert.equal(calls,1);assert.equal(p.busy,null);p.close();
});
test('only later ready compatible selections are tried: unavailable, non-fitting and cooling candidates are skipped',async()=>{
 const {p,models,catalog}=await fixture();const E='Qwen3-32B';
 // Use exact fixture model IDs; no fabricated eligibility.
 const extra=[...models.keys()].find(id=>![A,B,C,D].includes(id));assert.ok(extra);
 await p.saveDraft({...p.config,models:[A,B,C,D,extra],thinking:Object.fromEntries([A,B,C,D,extra].map(id=>[id,'default']))});
 catalog.state.entries[recordKey('ovh',B)].lifecycle='retired';
 catalog.state.entries[recordKey('ovh',C)].metadata.context_length=1;
 p.ready.set(D,Date.now()+60000);
 const sent=[],reports=[];
 const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{},onActivity:r=>reports.push(r),dispatch:(m,c,o)=>{begin(p,m,o);sent.push(m.id);return m.id===A?createAssistantMessageEventStream():done(m);}}));
 assert.deepEqual(sent,[A,extra]);assert.equal(out.result.model,extra);assert.deepEqual(reports[0].steps.filter(s=>!s.sent).map(s=>s.state),['unavailable','not-compatible','cooling']);p.close();
});
test('disabled timeout preserves a single long silent request; readiness deadline does not expire an already sent stream',async()=>{
 const {p,models}=await fixture();await p.saveDraft({...p.config,maxWaitMs:10,responseStartTimeoutMs:0});let calls=0;
 const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{},dispatch:(m,c,o)=>{calls++;begin(p,m,o);const s=createAssistantMessageEventStream();setTimeout(()=>done(m,s),50);return s;}}));assert.equal(calls,1);assert.equal(out.result.stopReason,'stop');p.close();
});
test('non-cooperative dispatch promise is bounded after ticket.begin, and pending rejection is observed',async()=>{
 const {p,models}=await fixture();let calls=0,rejectLate;
 const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{},dispatch:(m,c,o)=>{begin(p,m,o);calls++;return m.id===A?new Promise((_r,j)=>rejectLate=j):done(m);}}));
 assert.equal(out.result.model,B);assert.equal(calls,2);rejectLate(Error('late rejection'));await delay(5);p.close();
});
test('second send to the same model is rejected, not treated as a timeout exception',async()=>{
 const {p,models}=await fixture();let calls=0;
 const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{},dispatch:(m,c,o)=>{calls++;begin(p,m,o);o[POOL_REQUEST].begin();return done(m);}}));assert.equal(calls,1);assert.match(out.result.errorMessage,/second HTTP dispatch/);p.close();
});

test('elapsed deadline is enforced when synchronous SDK work delays timer callbacks',async()=>{
 const {p,models}=await fixture();const sent=[];
 const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{},dispatch:(m,c,o)=>{
  begin(p,m,o);sent.push(m.id);if(m.id===A){const until=performance.now()+35;while(performance.now()<until){};}
  return done(m);
 }}));assert.deepEqual(sent,[A,B]);assert.equal(out.result.model,B);p.close();
});
test('caller abort takes precedence even after elapsed deadline with a deferred timer callback',async()=>{
 const {p,models}=await fixture();const ctrl=new AbortController();let calls=0;
 const out=await drain(poolStream({pool:p,model:models.get(A),context,options:{signal:ctrl.signal},onHandoff:async()=>{},dispatch:(m,c,o)=>{
  calls++;begin(p,m,o);const until=performance.now()+35;while(performance.now()<until){};ctrl.abort();return done(m);
 }}));assert.equal(calls,1);assert.equal(out.result.stopReason,'aborted');p.close();
});
test('headers from an invalidated attempt cannot be adopted later',async()=>{
 const {p,models}=await fixture();let old;
 const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{},dispatch:(m,c,o)=>{
  begin(p,m,o);if(m.id===A){old=o[POOL_REQUEST];return createAssistantMessageEventStream();}return done(m);
 }}));assert.equal(out.result.model,B);assert.throws(()=>old.headers(new Response(null,{status:401})));assert.equal(p.quota.describe(A).remaining,1);p.close();
});

test('tool state is revalidated immediately before actual send, after asynchronous payload preparation',async()=>{
 const {p,models}=await fixture();let sends=0;
 const out=await drain(poolStream({pool:p,model:models.get(A),context,onHandoff:async()=>{},dispatch:(m,c,o)=>{
  p.toolsRunning=()=>true;o[POOL_REQUEST].begin();sends++;return done(m);
 }}));assert.equal(sends,0);assert.equal(out.result.stopReason,'error');assert.match(out.result.errorMessage,/tool is still executing/);assert.equal(p.quota.describe(A).remaining,2);p.close();
});
