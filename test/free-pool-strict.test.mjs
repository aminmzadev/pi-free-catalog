import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { poolStream,POOL_REQUEST } from '../src/ovh-pool-stream.js';
import { FreePool,poolKey } from '../src/free-pool.js';
import { environment,K,K2,A,B,context } from './free-pool-helper.mjs';
const done=(model,text='done')=>({role:'assistant',content:[{type:'text',text}],api:model.api,provider:model.provider,model:model.id,stopReason:'stop',timestamp:1});
function output(model){const s=createAssistantMessageEventStream(),m=done(model);s.push({type:'done',reason:'stop',message:m});s.end(m);return s;}
const run=async stream=>{for await(const _ of stream){}return stream.result();};

test('concurrent begin calls cannot send or reserve a model twice',async()=>{
 const x=environment({weights:{[K]:3}});await x.enable();let sends=0;
 const stream=poolStream({pool:x.pool,model:x.model(K),context:context(),onHandoff:async()=>{},dispatch:async(model,_ctx,options)=>{
  const first=options[POOL_REQUEST].begin();assert.throws(()=>options[POOL_REQUEST].begin(),/second HTTP/);await first;sends++;return output(model);
 }});
 assert.equal((await run(stream)).stopReason,'stop');assert.equal(sends,1);assert.equal(x.pool.rotation.used,1);assert.equal(x.pool.busy,null);
});
test('persistence failure prevents actual SDK dispatch and reports error without spending disk allowance',async()=>{
 const x=environment();await x.enable();const before=structuredClone(x.disk);x.setFail(true);let sends=0;
 const stream=poolStream({pool:x.pool,model:x.model(K),context:context(),onHandoff:async()=>{},dispatch:async(m,_c,o)=>{await o[POOL_REQUEST].begin();sends++;return output(m);}});
 const result=await run(stream);assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/save rotation/);assert.equal(sends,0);assert.deepEqual(x.disk,before);assert.equal(x.pool.busy,null);
});
test('abort during durable reservation cannot dispatch, refund the reservation or leak the lock',async()=>{
 let release,writing;const gate=new Promise(r=>release=r),started=new Promise(r=>writing=r);let block=false;
 const x=environment({persist:async()=>{if(block){writing();await gate;}}});await x.enable();block=true;const controller=new AbortController();let sends=0;
 const stream=poolStream({pool:x.pool,model:x.model(K),context:context(),options:{signal:controller.signal},onHandoff:async()=>{},dispatch:async(m,_c,o)=>{await o[POOL_REQUEST].begin();sends++;return output(m);}});
 await started;controller.abort(Error('user abort'));release();const result=await run(stream);await x.pool.changes;
 assert.equal(result.stopReason,'aborted');assert.equal(sends,0);assert.equal(x.disk.rotation.cursor,1);assert.equal(x.pool.busy,null);
});
test('metadata eligibility is checked again after disk reservation and before the wire',async()=>{
 let mutate=false;const x=environment({persist:async()=>{if(mutate)x.catalog.state.entries[K].listed=false;}});await x.enable();mutate=true;let sends=0;
 const stream=poolStream({pool:x.pool,model:x.model(K),context:context(),onHandoff:async()=>{},dispatch:async(m,_c,o)=>{await o[POOL_REQUEST].begin();sends++;return output(m);}});
 assert.equal((await run(stream)).stopReason,'error');assert.equal(sends,0);assert.equal(x.disk.rotation.cursor,1);
});
test('same model ID on different providers is not mistaken for an attempted identity',async()=>{
 const keys=['["kilo","same"]','["kilo","second"]'];const x=environment({models:keys,synthetic:true});await x.enable({responseStartTimeoutMs:100});const sends=[],handoffs=[];
 const stream=poolStream({pool:x.pool,model:x.model(keys[0]),context:context(),onHandoff:async(a,b)=>handoffs.push([poolKey(a),poolKey(b)]),dispatch:async(m,_c,o)=>{await o[POOL_REQUEST].begin();sends.push(poolKey(m));return sends.length===1?createAssistantMessageEventStream():output(m);}});
 assert.equal((await run(stream)).stopReason,'stop');assert.deepEqual(sends,keys);assert.deepEqual(handoffs,[[keys[0],keys[1]]]);
});
test('finite cycle is not exceeded by response-start timeout failover',async()=>{
 const x=environment({cycles:1});await x.enable({responseStartTimeoutMs:10});const sends=[];
 const stream=poolStream({pool:x.pool,model:x.model(K),context:context(),onHandoff:async()=>{},dispatch:async(m,_c,o)=>{await o[POOL_REQUEST].begin();sends.push(poolKey(m));return createAssistantMessageEventStream();}});
 const result=await run(stream);assert.equal(result.stopReason,'error');assert.deepEqual(sends,[K,K2]);assert.equal(x.pool.rotation.paused,true);assert.equal(x.pool.busy,null);
});
test('closed or stale editors cannot reauthorize a cycle',async()=>{
 const x=environment();await x.enable();const old=x.pool.config;await x.pool.saveDraft({...old,maxWaitMs:1},old,{consent:true});await assert.rejects(x.pool.saveDraft(old,old,{restart:true,consent:true}),/changed/);
 x.pool.close();await assert.rejects(x.pool.reserve(x.model(K),()=>{}),/shut down/);await assert.rejects(x.pool.saveDraft(x.pool.config,x.pool.config,{restart:true,consent:true}),/closed/);
});
test('OVH server Retry-After and imported consumed slots survive general-pool restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ovh-durable-'));try{
  const x=environment({models:[A,B],scheduling:'round-robin'});x.ovh.started('gpt-oss-120b');await x.enable();assert.equal(x.disk.ovhReservations['gpt-oss-120b'].length,1);
  await x.pool.observe('gpt-oss-120b',new Response('{}',{status:429,headers:{'retry-after':'3600'}}),{url:'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions'},'ovh');
  const file=join(dir,'pool');await writeFile(file,JSON.stringify(x.disk));const p=new FreePool({catalog:x.catalog,ovhPool:x.ovh,file,now:()=>x.now});await p.load();assert.ok(p.until(B)>=x.now+3600000);assert.ok(p.until(A)>=x.now+3600000);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('OVH reservations across restart do not admit a third send even when server evidence is absent',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ovh-two-'));try{
  const x=environment({models:[A,B],scheduling:'round-robin'});await x.enable();await x.next();await x.next();
  const file=join(dir,'pool');await writeFile(file,JSON.stringify(x.disk));const p=new FreePool({catalog:x.catalog,ovhPool:x.ovh,file,now:()=>x.now});await p.load();assert.ok(p.until(A)>x.now);assert.equal(p.config.weights[A],2);
  await p.saveDraft(p.config,p.config,{restart:true,consent:true});assert.ok(p.until(A)>x.now);
 }finally{await rm(dir,{recursive:true,force:true});}
});
