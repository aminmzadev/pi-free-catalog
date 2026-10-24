// Independent scheduler oracle; compatibility/transport have separate real-SDK tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,mkdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { FreePool,poolKey } from '../src/free-pool.js';
import { environment } from './free-pool-helper.mjs';
const keys=['["kilo","same"]','["zen","same"]','["ovh","same"]','["ovh","second"]'];
const seedText=process.env.FREE_POOL_MONKEY_SEED;
if(seedText!==undefined&&(!/^\d+$/.test(seedText)||!Number.isSafeInteger(Number(seedText))||Number(seedText)>0xffffffff))throw Error('FREE_POOL_MONKEY_SEED must be uint32');
const count=Number(process.env.FREE_POOL_MONKEY_STEPS??500);
if(!Number.isSafeInteger(count)||count<1||count>10000)throw Error('FREE_POOL_MONKEY_STEPS must be 1..10000');
const seeds=seedText===undefined?Array.from({length:32},(_,i)=>Math.imul(i+1,0x9e3779b9)>>>0):[Number(seedText)];
function rng(seed){let n=seed>>>0;return max=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n%max;};}
const copy=x=>structuredClone(x),baseRotation=()=>({cursor:0,used:0,completed:0,paused:false});
async function run(seed,steps,{failAt=-1,failureDir}={}){
 const random=rng(seed),trace=[],plans=[];const models=random(2)?keys.slice(0,2):[...keys];
 let c={schemaVersion:2,enabled:true,models,thinking:Object.fromEntries(models.map(k=>[k,'default'])),weights:Object.fromEntries(models.map(k=>[k,k.includes('ovh')?2:1+random(4)])),scheduling:'round-robin',cycles:random(3),maxWaitMs:0,responseStartTimeoutMs:0};
 let r=baseRotation(),times={},barriers={},disk,source,sends=0,pool;
 const available=new Set(models),compatible=new Set(models);
 const dir=await mkdtemp(join(tmpdir(),'free-monkey-')),file=join(dir,'settings.json');
 const expected=()=>({schemaVersion:2,config:copy(c),rotation:copy(r),barriers:copy(barriers),ovhCooldowns:{models:{},providerUntil:0},ovhReservations:copy(times),approvedProviders:[...new Set(models.map(k=>JSON.parse(k)[0]))].sort()});
 const persist=async value=>{const plan=plans.shift();assert.ok(plan,'every write has an oracle plan');const {cooldownEvidence,policyVersion,modelBarriers,...enforced}=value;assert.equal(policyVersion,3);assert.deepEqual(modelBarriers,{});assert.ok(Array.isArray(cooldownEvidence)&&cooldownEvidence.length<=128);assert.deepEqual(enforced,plan.value);if(plan.fail)throw Error('injected disk failure');disk=copy(value);};
 const x=environment({models,synthetic:true,persist});pool=x.pool;source=x.model(models[0]);pool.file=file;
 // Durable OVH reservations are tested here; the established OVH quota ledger has
 // its own unit/session tests, so do not duplicate its implementation in the oracle.
 x.ovh.quota.until=()=>0;x.ovh.started=()=>{};
 function hooks(){pool.eligible=()=>x.all.filter(m=>available.has(poolKey(m)));pool.reason=(_a,b)=>compatible.has(poolKey(b))?null:'not compatible';}
 hooks();
 function plan(fail=false){plans.push({value:expected(),fail});}
 function advance(){r.used=0;r.cursor++;if(r.cursor===models.length){r.cursor=0;r.completed++;if(c.cycles&&r.completed>=c.cycles)r.paused=true;}}
 function until(key){const service=JSON.parse(key)[0];if(service!=='ovh')return barriers[service]?.until??0;const t=(times[JSON.parse(key)[1]]??[]).filter(t=>t+60000>x.now);return t.length>=2?Math.min(...t)+60000:0;}
 function referenceChoose(){
  if(r.paused)return null;const before=copy(r);let choice=null;
  for(let i=0;i<models.length;i++){
   const key=models[r.cursor];if(available.has(key)&&compatible.has(key)&&until(key)<=x.now){choice=key;break;}advance();if(r.paused)break;
  }
  if(JSON.stringify(before)!==JSON.stringify(r))plan();return choice;
 }
 function check(){assert.deepEqual(pool.config,c);assert.deepEqual(pool.rotation,r);assert.equal(plans.length,0);assert.equal(pool.busy,null);assert.deepEqual(Object.fromEntries(pool.barriers),barriers);assert.deepEqual(pool.ovhReservations,times);}
 async function reload(corrupt=false){
  pool.close();await writeFile(file,JSON.stringify(corrupt?{...disk,rotation:{cursor:-1}}:disk));
  pool=new FreePool({catalog:x.catalog,ovhPool:x.ovh,file,now:()=>x.now,persist:(_f,value)=>persist(value)});await pool.load();hooks();
  if(corrupt)r={...baseRotation(),paused:true};else{c=copy(disk.config);r=copy(disk.rotation);times=copy(disk.ovhReservations);barriers=copy(disk.barriers);}
 }
 try{
  plan();await pool.saveDraft(c,pool.config,{restart:true,consent:true});
  for(let step=0;step<steps;step++){
   const op=random(11),row={step,op};trace.push(row);if(step===failAt)throw Error('Injected recorder check');
   if(op===0||op===1){
    const key=referenceChoose();row.expected=key;
    if(!key)await assert.rejects(pool.choose(source,{messages:[]},{}));
    else{
     const actual=await pool.choose(source,{messages:[]},{});assert.equal(poolKey(actual),key);
     r.used++;if(JSON.parse(key)[0]==='ovh'){const id=JSON.parse(key)[1];times[id]=[...(times[id]??[]).filter(t=>t+60000>x.now),x.now];}
     if(r.used>=c.weights[key])advance();plan();await pool.reserve(actual,()=>{});sends++;source=actual;
    }
   }else if(op===2){const key=models[random(models.length)];row.key=key;if(available.has(key))available.delete(key);else available.add(key);}
   else if(op===3){const key=models[random(models.length)];row.key=key;if(compatible.has(key))compatible.delete(key);else compatible.add(key);}
   else if(op===4){row.ms=random(90001);x.advance(row.ms);}
   else if(op===5){r=baseRotation();plan();await pool.saveDraft(c,pool.config,{restart:true,consent:true});}
   else if(op===6){
    const key=models[random(models.length)];c={...c,weights:{...c.weights,[key]:JSON.parse(key)[0]==='ovh'?1+random(2):1+random(6)}};r=baseRotation();plan();await pool.saveDraft(c,pool.config,{restart:true,consent:true});row.weights=copy(c.weights);
   }else if(op===7){
    const service=random(2)?'kilo':'zen',seconds=1+random(60);barriers[service]={until:Math.max(barriers[service]?.until??0,x.now+seconds*1000)};plan();
    await pool.observe('same',new Response('',{status:429,headers:{'retry-after':String(seconds),'x-ratelimit-scope':'service'}}),{},service);row.service=service;row.seconds=seconds;
   }else if(op===8){await reload(random(5)===0);row.paused=r.paused;}
   else if(op===9){
    // Force a known ready slot so failure is injected at reservation, not a skip.
    x.advance(90000);for(const k of models){available.add(k);compatible.add(k);}
    if(!r.paused){const before=copy(r),key=models[r.cursor],target=x.model(key);r.used++;
     const priorTimes=copy(times);if(JSON.parse(key)[0]==='ovh'){const id=JSON.parse(key)[1];times[id]=[...(times[id]??[]).filter(t=>t+60000>x.now),x.now];}
     if(r.used>=c.weights[key])advance();plan(true);
     await assert.rejects(pool.reserve(target,()=>{}),/Could not save/);r={...before,paused:true};times=priorTimes;
    }
   }else{
    const before=JSON.stringify(expected()),sent=sends;pool.preview();pool.report();assert.equal(JSON.stringify(expected()),before);assert.equal(sends,sent);
   }
   check();
  }
  return {seed,steps,sends,coverage:Object.fromEntries(Array.from({length:11},(_,op)=>[op,trace.filter(t=>t.op===op).length])),digest:createHash('sha256').update(JSON.stringify(trace)).digest('hex')};
 }catch(e){
  const failure={seed,steps,trace,expected:expected(),disk,error:e.stack};let path;
  try{const dir=failureDir??process.env.FREE_POOL_MONKEY_FAILURE_DIR??join(process.cwd(),'test-results');await mkdir(dir,{recursive:true});const f=join(dir,`free-pool-${seed}-failure.json`);await writeFile(f,JSON.stringify(failure,null,2));path=f;}catch{}
  throw Error(`Free pool monkey failed. Replay: FREE_POOL_MONKEY_SEED=${seed} FREE_POOL_MONKEY_STEPS=${steps} npm run test:pool-monkey\nTrace: ${path??JSON.stringify(trace)}\n${e.message}`,{cause:e});
 }finally{pool.close();await pool.changes;await rm(dir,{recursive:true,force:true});}
}
for(const seed of seeds)test(`free pool monkey seed=${seed} steps=${count}`,async t=>t.diagnostic(JSON.stringify(await run(seed,count))));
test('free pool monkey seed zero exact replay has the same digest',async()=>assert.deepEqual(await run(0,180),await run(0,180)));

test('pool monkey failure recorder persists seed/full prefix and falls back to inline trace on write failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pool-recorder-'));try{
  await assert.rejects(run(42,10,{failAt:2,failureDir:dir}),/FREE_POOL_MONKEY_SEED=42 FREE_POOL_MONKEY_STEPS=10/);
  const saved=JSON.parse(await readFile(join(dir,'free-pool-42-failure.json')));assert.equal(saved.seed,42);assert.equal(saved.trace.length,3);assert.deepEqual(saved.trace.map(t=>t.step),[0,1,2]);
  const blocked=join(dir,'file');await writeFile(blocked,'blocked');await assert.rejects(run(43,10,{failAt:0,failureDir:blocked}),/Trace: \[\{"step":0,/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
