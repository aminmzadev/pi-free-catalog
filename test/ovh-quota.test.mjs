import test from 'node:test';
import assert from 'node:assert/strict';
import { minuteQuota, OvhQuota } from '../src/ovh-quota.js';
import { Catalog, recordKey } from '../src/catalog.js';
import { registrations } from '../src/models.js';
import { OvhPool } from '../src/ovh-pool.js';
import { poolStream, POOL_REQUEST } from '../src/ovh-pool-stream.js';
import { createAssistantMessageEventStream, normalizeContext } from '@earendil-works/pi-ai/compat';
import { fetcher } from './helpers.mjs';
const A='gpt-oss-120b',B='gpt-oss-20b',C='Qwen3.8-27B',D='Qwen3.5-397B-A17B';
const URL='https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
const request={id:A,url:URL,entitlement:2,now:1000};
const response=(remaining=1,reset=40)=>Response.json({ok:true},{headers:{'ratelimit-limit':'2','x-ratelimit-limit-minute':'2','ratelimit-remaining':String(remaining),'x-ratelimit-remaining-minute':String(remaining),'ratelimit-reset':String(reset)}});
const catalog=new Catalog({fetch:fetcher()});await catalog.refresh();
const models=new Map(registrations(catalog.state,'ovh').map(m=>[m.id,{...m,provider:'free-ovh'}]));
const context=normalizeContext({messages:[{role:'user',content:'hello',timestamp:1}]});
async function pool(extra={}){const p=new OvhPool({catalog,getPiLevel:()=> 'low',...extra});await p.configure('set',[A,B,C,D]);await p.configure('on');return p;}
async function drain(s){for await(const _e of s){}return s.result();}

test('captured successful minute headers have a conservative relative reset',()=>assert.deepEqual(minuteQuota(response(),request),{remaining:1,until:42000}));
for(const [key,value]of [['ratelimit-limit','3'],['x-ratelimit-limit-minute','20'],['ratelimit-remaining','2'],['ratelimit-remaining','3'],['ratelimit-remaining','-1'],['x-ratelimit-remaining-minute','0'],['ratelimit-reset','0'],['ratelimit-reset','61'],['ratelimit-reset','1792745460'],['ratelimit-reset','1e2'],['ratelimit-reset','40.5'],['x-ratelimit-scope','provider'],['x-ratelimit-model',B],['x-ratelimit-window','3600'],['x-ratelimit-limit-hour','20'],['x-ratelimit-reset-day','50'],['ratelimit-policy','2;w=60']])test('successful quota rejects contradictory '+key+'='+value,()=>{const r=response();r.headers.set(key,value);assert.equal(minuteQuota(r,request),null);});
for(const key of ['ratelimit-limit','x-ratelimit-limit-minute','ratelimit-remaining','x-ratelimit-remaining-minute','ratelimit-reset'])test('successful quota refuses missing '+key,()=>{const r=response();r.headers.delete(key);assert.equal(minuteQuota(r,request),null);});
test('quota requires exact endpoint, no redirect and anonymous entitlement',()=>{
 for(const req of [{...request,url:URL+'?foo=1'},{...request,url:'https://example.com'},{...request,entitlement:20},{...request,entitlement:undefined}])assert.equal(minuteQuota(response(),req),null);
 const r=response();Object.defineProperty(r,'redirected',{value:true});assert.equal(minuteQuota(r,request),null);
 assert.equal(minuteQuota(Response.json({}, {status:401}),request),null);
});
test('two immediate local slots, exhausted independent model, authoritative reset and no quota refund',()=>{
 let time=0;const q=new OvhQuota(()=>time);
 q.started(A);q.observe(A,response(1),request);assert.equal(q.until(A),0);assert.equal(q.exhausted(A),false);
 time=2000;q.started(A);q.observe(A,response(0,38),request);assert.equal(q.until(A),41000);assert.equal(q.exhausted(A),true);assert.equal(q.until(B),0);
 time=40999;assert.ok(q.until(A)>time);time=41000;assert.equal(q.until(A),0);assert.equal(q.describe(A).remaining,2);
 q.started(B);q.failed(B);q.started(B);q.failed(B);assert.equal(q.until(B),time+61000);assert.equal(q.exhausted(B),false);
});
test('missing headers use two successful local attempts, not a fixed inter-request gap',()=>{
 let time=0;const q=new OvhQuota(()=>time);
 q.started(A);q.observe(A,Response.json({}),request);assert.equal(q.until(A),0);
 time=10;q.started(A);q.observe(A,Response.json({}),request);assert.equal(q.until(A),61000);assert.equal(q.exhausted(A),true);
 time=61000;assert.equal(q.until(A),0);assert.equal(q.describe(A).remaining,1);
});
test('malformed quota fields or failures do not become local-success rotation evidence',()=>{
 const q=new OvhQuota(()=>0);for(let i=0;i<2;i++){q.started(A);const r=response();r.headers.set('x-ratelimit-scope','global');q.observe(A,r,request);}
 assert.equal(q.exhausted(A),false);assert.ok(q.until(A)>0);
});
test('valid server slot across a minute boundary can override conservative prior local attempts',()=>{
 let time=1000;const q=new OvhQuota(()=>time);q.started(A);q.observe(A,response(1),request);time=41000;q.started(A);q.observe(A,response(1,60),request);assert.equal(q.until(A),0);q.started(A);q.observe(A,response(0,60),request);assert.equal(q.exhausted(A),true);
});
test('A1 remaining1 allows fast A2; A2 remaining0 selects B and reset restores A',async()=>{
 let time=0;const p=await pool({now:()=>time});
 p.started(A);await p.observe(A,response(1),{url:URL});assert.equal((await p.choose(models.get(A),context,{})).id,A);
 time=2000;p.started(A);await p.observe(A,response(0,38),{url:URL});assert.equal((await p.choose(models.get(A),context,{})).id,B);
 time=41000;assert.equal((await p.choose(models.get(B),context,{})).id,A);
});
test('multiple smaller contexts are skipped until a later selected model fits',async()=>{
 const p=await pool();await p.configure('set',[A,B,C,D]);
 const ctx=normalizeContext({messages:[{role:'user',content:'x'.repeat(140000),timestamp:1}]});
 const choice=await p.choose(models.get(A),ctx,{maxTokens:512});assert.equal(choice.id,C);assert.match(p.lastCheck,/gpt-oss-120b: Context/);assert.match(p.lastCheck,/gpt-oss-20b: Context/);
});
test('small actual conversation fits a smaller destination, explicit cap is retained',async()=>{
 const p=await pool();await p.configure('set',[D,A,B]);p.getSelection=()=> 'default';
 p.started(D);await p.observe(D,response(0),{url:URL});assert.equal((await p.choose(models.get(D),context,{maxTokens:128})).id,A);
});
test('all selected contexts too small return reasons, not provider requests or truncation',async()=>{
 const p=await pool(),ctx=normalizeContext({messages:[{role:'user',content:'x'.repeat(300000),timestamp:1}]});
 await assert.rejects(p.choose(models.get(A),ctx,{maxTokens:128}),/No compatible selected OVH model/);
 assert.ok(JSON.stringify(ctx).includes('x'.repeat(300000)));
});
test('pool edits, ON/OFF and reset preserve live runtime quota and cooldown barriers',async()=>{
 const p=await pool();p.started(A);await p.observe(A,response(0),{url:URL});p.providerUntil=5000;
 const until=p.quota.until(A);await p.configure('off');await p.configure('on');await p.configure('clear');assert.equal(p.quota.until(A),until);assert.equal(p.providerUntil,5000);
});
test('queued contention cannot consume a busy slot and cancellation releases nothing prematurely',async()=>{
 const p=await pool();await p.configure('wait',['100']);const release=await p.acquire();const ctrl=new AbortController();const waiting=p.acquire(ctrl.signal);ctrl.abort();await assert.rejects(waiting);assert.ok(p.busy);release();assert.equal(p.busy,null);
});
test('post-dispatch thrown exception preserves its original message past the scheduling deadline',async()=>{
 const p=await pool();await p.configure('wait',['5']);
 const msg=await drain(poolStream({pool:p,model:models.get(A),context,options:{maxTokens:512},onHandoff:async()=>{},dispatch:(m,c,o)=>{
  o[POOL_REQUEST].begin();const s=createAssistantMessageEventStream();s[Symbol.asyncIterator]=async function*(){await new Promise(r=>setTimeout(r,20));throw Error('ORIGINAL_PROVIDER_EXCEPTION');};return s;
 }}));assert.equal(msg.errorMessage,'ORIGINAL_PROVIDER_EXCEPTION');assert.equal(p.busy,null);
});
test('cancellation before dispatch consumes no local quota slot',async()=>{
 const p=await pool(),c=new AbortController();c.abort();let calls=0;
 const msg=await drain(poolStream({pool:p,model:models.get(A),context,options:{signal:c.signal},onHandoff:async()=>{},dispatch:()=>calls++}));assert.equal(msg.stopReason,'aborted');assert.equal(calls,0);assert.equal(p.quota.describe(A).remaining,2);
});

test('stale rising counters cannot mint slots before the known reset',()=>{const q=new OvhQuota(()=>1000);q.started(A);q.observe(A,response(1),request);q.started(A);q.observe(A,response(1),request);assert.ok(q.until(A)>1000);assert.equal(q.exhausted(A),false);});


test('synchronous preflight work cannot outrun a delayed timer callback and send after its budget',async()=>{
 const p=await pool();await p.configure('wait',['5']);const choose=p.choose.bind(p);p.choose=async(...args)=>{const end=performance.now()+15;while(performance.now()<end){}return choose(...args);};let calls=0;
 const msg=await drain(poolStream({pool:p,model:models.get(A),context,options:{maxTokens:128},onHandoff:async()=>{},dispatch:()=>calls++}));assert.equal(calls,0);assert.match(msg.errorMessage,/local wait budget expired before HTTP/);
});
