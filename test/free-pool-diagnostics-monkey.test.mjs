// Independent provenance/deadline oracle; no inference or sockets are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {FreePool} from '../src/free-pool.js';
import {environment,K,K2} from './free-pool-helper.mjs';
const rawSeed=process.env.FREE_POOL_DIAGNOSTICS_SEED,steps=Number(process.env.FREE_POOL_DIAGNOSTICS_STEPS??300);
if(rawSeed!==undefined&&(!/^\d+$/.test(rawSeed)||!Number.isSafeInteger(Number(rawSeed))||Number(rawSeed)>0xffffffff))throw Error('FREE_POOL_DIAGNOSTICS_SEED must be uint32');
if(!Number.isSafeInteger(steps)||steps<1||steps>10000)throw Error('FREE_POOL_DIAGNOSTICS_STEPS must be 1..10000');
const seeds=rawSeed===undefined?[0,1,42,99,104729,2654435769,2147483648,4294967295]:[Number(rawSeed)];
const clone=x=>structuredClone(x);
async function run(seed,count,{failAt=-1,failureDir}={}){
 let state=seed>>>0;const random=max=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%max;};
 const trace=[],counts=Array(12).fill(0),dir=await mkdtemp(join(tmpdir(),'diagnostic-monkey-')),file=join(dir,'state.json');
 let gates={},rows=[],disk,diskGates={},diskRows=[],fail=false;
 const persist=async(_file,value)=>{
  assert.deepEqual(value.barriers,{});assert.deepEqual(value.modelBarriers,Object.fromEntries(Object.entries(gates).map(([key,until])=>[key,{until}])));assert.deepEqual(value.cooldownEvidence,rows);
  if(fail)throw Error('Injected storage failure');disk=clone(value);diskGates=clone(gates);diskRows=clone(rows);
 };
 const x=environment();x.advance(Date.UTC(2026,9,23)-x.now);let pool=x.pool;pool.persist=persist;pool.file=file;
 async function observe(service,status,header,tag){
  const model=tag.startsWith('invalid-')||tag.startsWith('date-')?'thinkingmachines/inkling-small:free':'reflection/beam-free',key=model==='reflection/beam-free'?K:K2;
  const valid=header!==undefined&&/^\d+$/.test(header)?x.now+Number(header)*1000:header?.endsWith('GMT')?Date.parse(header):null;
  if(status===429||valid>x.now){
   const until=valid>x.now?valid:x.now+61000;gates[key]=Math.max(gates[key]??0,until);
   rows=[...rows,{service,model,status,at:x.now,until,scope:'model',source:valid>x.now?'retry-after':'fallback',retryAfterState:valid>x.now?'valid':header===undefined?'missing':'invalid',retryAfter:valid>x.now?header:null}].slice(-128);
  }
  await pool.observe(model,new Response('PRIVATE_PROVIDER_BODY',{status,headers:header===undefined?{}:{'retry-after':header}}),{},service);
 }
 function check(){
  assert.deepEqual(Object.fromEntries(pool.barriers),{});assert.deepEqual(Object.fromEntries(pool.modelBarriers),Object.fromEntries(Object.entries(gates).map(([key,until])=>[key,{until}])));assert.deepEqual(pool.cooldownEvidence,rows);
  for(const [service,key] of [['kilo',K],['kilo',K2]]){
   assert.equal(pool.until(key),gates[key]??0);const text=pool.cooldownStatus(key);
   if((gates[key]??0)<=x.now)assert.match(text,/no active local cooldown/);
   else{
    assert.match(text,new RegExp('cooling '+Math.ceil((gates[key]-x.now)/1000)+'s'));
    const e=[...rows].reverse().find(e=>e.service===service&&e.model===JSON.parse(key)[1]&&e.until===gates[key]);
    if(e){assert.ok(text.includes(service+'/'+e.model+'; HTTP '+e.status));assert.match(text,/model-local package handling/);if(e.source==='fallback')assert.match(text,/61 seconds/);else assert.ok(text.includes(e.retryAfter));}
    else assert.match(text,/origin unavailable/);
   }
  }
  assert.doesNotMatch(JSON.stringify(pool.cooldownEvidence),/PRIVATE_PROVIDER_BODY/);
 }
 try{
  await x.enable();
  for(let step=0;step<count;step++){
   const op=random(12);counts[op]++;const row={step,op};trace.push(row);if(step===failAt)throw Error('Injected recorder check');
   if(op===0)await observe('kilo',429,undefined,'fallback-'+step);
   else if(op===1)await observe('kilo',429,'invalid','invalid-'+step);
   else if(op===2){row.seconds=1+random(120);await observe('kilo',503,String(row.seconds),'header-'+step);}
   else if(op===3){row.date=new Date(Math.ceil((x.now+1000+random(90000))/1000)*1000).toUTCString();await observe('kilo',200,row.date,'date-'+step);}
   else if(op===4)await observe('kilo',200,undefined,'success-'+step);
   else if(op===5){row.ms=random(90001);x.advance(row.ms);}
   else if(op===6){const before=JSON.stringify(disk),r=clone(pool.rotation);pool.preview();const text=pool.report();assert.match(text,/HISTORICAL/);assert.equal(JSON.stringify(disk),before);assert.deepEqual(pool.rotation,r);}
   else if(op===7||op===9){
    pool.close();if(op===9){disk={...disk,cooldownEvidence:{corrupt:true}};diskRows=[];}
    await writeFile(file,JSON.stringify(disk));pool=new FreePool({catalog:x.catalog,ovhPool:x.ovh,file,now:()=>x.now,persist});await pool.load();gates=clone(diskGates);rows=clone(diskRows);
    if(op===9)assert.match(pool.diagnosticWarning,/evidence is invalid/);assert.equal(pool.rotation.paused,disk.rotation.paused);
   }else if(op===8){await pool.saveDraft(pool.config,pool.config,{restart:true,consent:true});}
   else if(op===10){
    fail=true;await assert.rejects(observe('kilo',429,undefined,'failed-store-'+step),/Could not save/);fail=false;assert.equal(pool.rotation.paused,true);
   }else{pool.networkFailure('offline-error','kilo');pool.networkFailure('offline-error','kilo');}
   check();
  }
  return {seed,steps:count,coverage:Object.fromEntries(counts.map((n,i)=>[i,n])),digest:createHash('sha256').update(JSON.stringify(trace)).digest('hex')};
 }catch(error){
  const details={seed,steps:count,trace,gates,rows,error:String(error.stack)};let location;
  try{const dest=failureDir??process.env.FREE_POOL_DIAGNOSTICS_FAILURE_DIR??join(process.cwd(),'test-results');await mkdir(dest,{recursive:true});location=join(dest,`free-pool-diagnostics-${seed}-failure.json`);await writeFile(location,JSON.stringify(details,null,2));}catch{location=JSON.stringify(trace);}
  throw Error(`Replay: FREE_POOL_DIAGNOSTICS_SEED=${seed} FREE_POOL_DIAGNOSTICS_STEPS=${count} npm run test:pool-diagnostics-monkey\nTrace: ${location}\n${error.message}`,{cause:error});
 }finally{pool.close();await pool.changes;await rm(dir,{recursive:true,force:true});}
}
for(const seed of seeds)test(`diagnostic monkey seed=${seed} steps=${steps}`,async t=>t.diagnostic(JSON.stringify(await run(seed,steps))));
test('diagnostic monkey exact seed-zero replay is deterministic',async()=>assert.deepEqual(await run(0,100),await run(0,100)));
test('diagnostic monkey recorder preserves prefix and falls back inline if unwritable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'diagnostic-recorder-'));
 try{await assert.rejects(run(42,10,{failAt:2,failureDir:dir}),/FREE_POOL_DIAGNOSTICS_SEED=42/);const data=JSON.parse(await readFile(join(dir,'free-pool-diagnostics-42-failure.json')));assert.equal(data.trace.length,3);const blocked=join(dir,'blocked');await writeFile(blocked,'block');await assert.rejects(run(43,10,{failAt:0,failureDir:blocked}),/Trace: \[\{"step":0,/);}
 finally{await rm(dir,{recursive:true,force:true});}
});
