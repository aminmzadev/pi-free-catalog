import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/compat';
import {poolStream,POOL_REQUEST} from '../src/ovh-pool-stream.js';
import {poolKey} from '../src/free-pool.js';
import {environment,context} from './free-pool-helper.mjs';
const keys=['["kilo","a"]','["kilo","b"]','["kilo","c"]'];
const seedText=process.env.FREE_POOL_CONTINUITY_SEED,steps=Number(process.env.FREE_POOL_CONTINUITY_STEPS??200);
if(seedText!==undefined&&(!/^\d+$/.test(seedText)||!Number.isSafeInteger(Number(seedText))||Number(seedText)>0xffffffff))throw Error('FREE_POOL_CONTINUITY_SEED must be uint32');
if(!Number.isSafeInteger(steps)||steps<1||steps>10000)throw Error('FREE_POOL_CONTINUITY_STEPS must be 1..10000');
const seeds=seedText===undefined?[0,1,42,99,104729,2654435769,2147483648,4294967295]:[Number(seedText)];
async function run(seed,count,{failAt=-1,failureDir}={}){
 let n=seed>>>0;const random=max=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n%max;};
 const weights=Object.fromEntries(keys.map(k=>[k,1+random(3)])),x=environment({models:keys,weights,synthetic:true,scheduling:'round-robin'}),trace=[],coverage=Array(7).fill(0),gates={};
 let r={cursor:0,used:0,completed:0,paused:false};const available=new Set(keys);
 x.pool.eligible=()=>x.all.filter(m=>available.has(poolKey(m)));x.pool.reason=()=>null;
 function advance(){r.used=0;r.cursor++;if(r.cursor===keys.length){r.cursor=0;r.completed++;}}
 const ready=k=>available.has(k)&&(gates[k]??0)<=x.now;
 try{
  await x.enable();
  for(let step=0;step<count;step++){
   x.advance(random(5001));for(const k of keys)random(5)===0?available.delete(k):available.add(k);
   const plans=Object.fromEntries(keys.map(k=>[k,random(7)])),expected=[],expectedKinds=[];let target;
   for(let i=0;i<keys.length;i++){const k=keys[r.cursor];if(ready(k)){target=k;break;}advance();}
   while(target){
    expected.push(target);const index=keys.indexOf(target);assert.equal(r.cursor,index);r.used++;if(r.used>=weights[target])advance();const kind=plans[target];expectedKinds.push(kind);coverage[kind]++;
    if(kind!==1&&kind!==2)break;
    gates[target]=x.now+2000;const ids=[...keys.slice(index+1),...keys.slice(0,index)];target=ids.find(k=>!expected.includes(k)&&ready(k));
    if(target)for(let i=0;i<keys.length&&keys[r.cursor]!==target;i++)advance();
   }
   const row={step,now:x.now,available:[...available],plans,expected,rotation:{...r}};trace.push(row);if(step===failAt)throw Error('Injected recorder check');
   const actual=[];let activity;
   const stream=poolStream({pool:x.pool,model:x.model(keys[0]),context:context(),onHandoff:async()=>{},onActivity:a=>activity=a,dispatch:async(model,_ctx,o)=>{
    await o[POOL_REQUEST].begin();const key=poolKey(model),kind=plans[key];actual.push(key);
    const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:kind===0?'stop':'error',timestamp:1};
    if(kind===1||kind===2){const response=new Response('{}',{status:429,headers:{'retry-after':'2'}});o[POOL_REQUEST].headers(response);const [service,id]=JSON.parse(key);await x.pool.observe(id,response,{},service);o[POOL_REQUEST].rejectRateLimit(response);return createAssistantMessageEventStream();}
    if(kind===6)throw Error('Fixture network failure');
    if(kind===5)return {async *[Symbol.asyncIterator](){yield {type:'text_delta',delta:'meaningful',partial:{content:[]}};const response=new Response('{}',{status:429});o[POOL_REQUEST].headers(response);assert.equal(o[POOL_REQUEST].rejectRateLimit(response),false);yield {type:'error',reason:'error',error:message};},result:async()=>message};
    if(kind===3||kind===4)o[POOL_REQUEST].headers(new Response('{}',{status:kind===3?401:503}));
    const result=createAssistantMessageEventStream();if(kind===0){result.push({type:'done',reason:'stop',message});result.end(message);}else{result.push({type:'error',reason:'error',error:message});result.end(message);}return result;
   }});
   for await(const _ of stream){}await stream.result();assert.deepEqual(actual,expected);assert.equal(new Set(actual).size,actual.length);assert.deepEqual(x.pool.rotation,r);assert.equal(x.pool.busy,null);assert.equal(x.pool.config.enabled,true);assert.equal(x.pool.rotation.paused,false);
   assert.deepEqual(Object.fromEntries(x.pool.modelBarriers),Object.fromEntries(Object.entries(gates).map(([k,until])=>[k,{until}])));assert.deepEqual([...x.pool.barriers],[]);
   if(activity)assert.equal(activity.steps.filter(s=>s.sent).length,actual.length);
  }
  return {seed,steps:count,coverage:Object.fromEntries(coverage.map((v,i)=>[i,v])),digest:createHash('sha256').update(JSON.stringify(trace)).digest('hex')};
 }catch(error){
  let location;try{const dir=failureDir??process.env.FREE_POOL_CONTINUITY_FAILURE_DIR??join(process.cwd(),'test-results');await mkdir(dir,{recursive:true});location=join(dir,`free-pool-continuity-${seed}-failure.json`);await writeFile(location,JSON.stringify({seed,steps:count,trace,error:String(error.stack)},null,2));}catch{location=JSON.stringify(trace);}
  throw Error(`Replay: FREE_POOL_CONTINUITY_SEED=${seed} FREE_POOL_CONTINUITY_STEPS=${count} npm run test:pool-continuity-monkey\nTrace: ${location}\n${error.message}`,{cause:error});
 }finally{x.pool.close();await x.pool.changes;}
}
for(const seed of seeds)test(`continuity monkey seed=${seed} steps=${steps}`,async t=>t.diagnostic(JSON.stringify(await run(seed,steps))));
test('continuity seed-zero replay matches exactly',async()=>assert.deepEqual(await run(0,100),await run(0,100)));
test('continuity trace recorder persists its prefix and falls back inline when unwritable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'continuity-recorder-'));try{await assert.rejects(run(42,10,{failAt:2,failureDir:dir}),/FREE_POOL_CONTINUITY_SEED=42/);const data=JSON.parse(await readFile(join(dir,'free-pool-continuity-42-failure.json')));assert.equal(data.trace.length,3);const blocked=join(dir,'blocked');await writeFile(blocked,'blocked');await assert.rejects(run(43,10,{failAt:0,failureDir:blocked}),/Trace: \[\{"step":0,/);}finally{await rm(dir,{recursive:true,force:true});}
});
