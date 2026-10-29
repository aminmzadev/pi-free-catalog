import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {FreePool} from '../src/free-pool.js';
import {PagesCatalog} from '../src/catalog-client.js';
import {Catalog,recordKey} from '../src/catalog.js';
import {migrateThinkingSelections,migratePoolProvider} from '../src/provider-removal.js';
import {state} from './helpers.mjs';
const K=recordKey('kilo','reflection/beam-free'),Z=recordKey('zen','retired-model'),O=recordKey('ovh','gpt-oss-120b');
function legacyPool(){return {schemaVersion:2,policyVersion:3,config:{schemaVersion:2,enabled:true,models:[K,Z,O],weights:{[K]:3,[Z]:4,[O]:2},thinking:{[K]:'high',[Z]:'low',[O]:'default'},scheduling:'round-robin',cycles:5,maxWaitMs:12000,responseStartTimeoutMs:30000},rotation:{cursor:0,used:2,completed:3,paused:false},approvedProviders:['kilo','ovh','zen'],modelBarriers:{[K]:{until:50000},[Z]:{until:60000}},barriers:{kilo:{until:70000},zen:{until:80000}},ovhReservations:{'gpt-oss-120b':[500,1000]},ovhCooldowns:{models:{'gpt-oss-120b':90000},providerUntil:100000},cooldownEvidence:[]};}
test('thinking retirement preserves every remaining provider/model preference exactly',()=>{
 const raw={[K]:'high',[Z]:'low',[O]:'default'};assert.deepEqual(migrateThinkingSelections(raw),{[K]:'high',[O]:'default'});assert.equal(raw[Z],'low');
});
test('pool retirement preserves remaining settings and conservative accounting without a cycle refund',()=>{
 const raw=legacyPool(),before=structuredClone(raw),{value,changed}=migratePoolProvider(raw);assert.equal(changed,true);assert.deepEqual(raw,before);
 assert.deepEqual(value.config.models,[K,O]);assert.deepEqual(value.config.weights,{[K]:3,[O]:2});assert.deepEqual(value.config.thinking,{[K]:'high',[O]:'default'});
 for(const k of ['cycles','maxWaitMs','responseStartTimeoutMs','scheduling'])assert.equal(value.config[k],raw.config[k]);
 assert.deepEqual(value.rotation,{...raw.rotation,paused:true});assert.equal(value.config.enabled,false);assert.equal(value.removalReviewRequired,true);
 assert.deepEqual(value.modelBarriers,{[K]:{until:50000}});assert.deepEqual(value.barriers,{kilo:{until:70000}});
 assert.deepEqual(value.ovhReservations,raw.ovhReservations);assert.deepEqual(value.ovhCooldowns,raw.ovhCooldowns);
});
test('retired current visit maps to a remaining identity but stays paused until explicit review',()=>{
 const raw=legacyPool();raw.rotation={cursor:1,used:3,completed:3,paused:false};const {value}=migratePoolProvider(raw);assert.equal(value.rotation.cursor,1);assert.equal(value.config.models[value.rotation.cursor],O);assert.equal(value.rotation.completed,3);assert.equal(value.rotation.paused,true);assert.equal(value.config.enabled,false);
});
for(const mutate of [x=>x.modelBarriers[Z].until=-1,x=>x.barriers.zen.until=-1,x=>x.rotation.used=3,x=>x.approvedProviders=['kilo','zen'],x=>x.config.weights[Z]=101,x=>x.config.models.push(Z)])test('retirement does not sanitize a corrupt legacy pool into valid settings: '+String(mutate),()=>{
 const raw=legacyPool();mutate(raw);assert.throws(()=>migratePoolProvider(raw));
});
test('unaffected remaining-provider pool is returned untouched',()=>{
 const {value}=migratePoolProvider(legacyPool());delete value.removalReviewRequired;const result=migratePoolProvider(value);assert.equal(result.changed,false);assert.equal(result.value,value);
});
test('real persisted pool upgrade survives restart and refuses implicit re-enablement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'retire-provider-')),file=join(dir,'pool.json');const catalog={state:state(),assertUsable(service,id){const e=this.state.entries[recordKey(service,id)];if(!e||e.classification!=='free')throw Error('not free');return e;}};
 try{
  await writeFile(file,JSON.stringify(legacyPool()));const pool=new FreePool({catalog,file,now:()=>1000});await pool.load();
  assert.equal(pool.removalReviewRequired,true);assert.equal(pool.config.enabled,false);assert.equal(pool.rotation.used,2);assert.equal(pool.rotation.completed,3);assert.equal(pool.rotation.paused,true);
  assert.equal(pool.until(K),70000);assert.deepEqual(pool.ovhReservations,legacyPool().ovhReservations);assert.deepEqual(pool.ovhCooldowns,legacyPool().ovhCooldowns);
  assert.match(pool.warning,/Review and explicitly restart/);const persisted=JSON.parse(await readFile(file));assert.equal(persisted.removalReviewRequired,true);
  await assert.rejects(pool.saveDraft({...pool.config,enabled:true},pool.config),/explicitly restart/);pool.close();
  const second=new FreePool({catalog,file,now:()=>1000});await second.load();assert.equal(second.config.enabled,false);assert.equal(second.rotation.completed,3);assert.equal(second.until(K),70000);assert.equal(second.removalReviewRequired,true);second.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('a failed migration write never enables requests or changes the old disk state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'retire-write-')),file=join(dir,'pool.json');try{
  const text=JSON.stringify(legacyPool());await writeFile(file,text);const pool=new FreePool({file,catalog:{state:state()},persist:async()=>{throw Error('disk full');}});await pool.load();assert.equal(pool.config.enabled,false);assert.equal(pool.rotation.paused,true);assert.equal(await readFile(file,'utf8'),text);assert.ok(pool.warning);pool.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
for(const gzip of [false,true])test('actual cache loading retires the removed provider without losing remaining saved history, gzip='+gzip,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'retire-cache-')),file=join(dir,'catalog.json');
 const kilo=state();const remaining={schemaVersion:1,refreshedAt:kilo.refreshedAt,sources:Object.fromEntries(Object.entries(kilo.sources).filter(([name])=>name!=='zen'&&name!=='official'&&name!=='modelsdev'&&name!=='pi')),entries:Object.fromEntries(Object.entries(kilo.entries).filter(([,e])=>e.service!=='zen')),history:kilo.history,changes:kilo.changes};
 const legacy={...structuredClone(remaining),sources:{...remaining.sources,zen:{url:'https://opencode.ai/zen/v1/models',fresh:true,fetchedAt:'2026-10-22T00:00:00.000Z',data:{data:[{id:'retired-model'}]}}},entries:{...remaining.entries,[Z]:{service:'zen',id:'retired-model',name:'Retired',type:'chat',classification:'free',lifecycle:'retired',listed:false,firstSeen:'2026-09-01T00:00:00.000Z',updatedAt:'2026-10-22T00:00:00.000Z',raw:{id:'retired-model'},metadata:{name:'Retired'},cost:{input:0,output:0}}}};
 const encoded=Buffer.from(gzip?gzipSync(JSON.stringify(legacy)):JSON.stringify(legacy,null,2));
 try{
  await writeFile(file,encoded);const before=await readFile(file);
  for(const Type of [Catalog,PagesCatalog]){
   const c=new Type({file,fetch:()=>{throw Error('load must never fetch');},now:()=>Date.parse(legacy.refreshedAt)});await c.load();
   assert.deepEqual(c.state.entries,remaining.entries,'remaining saved records changed');
   assert.deepEqual(c.state.history,remaining.history,'remaining saved history changed');
   assert.deepEqual(Object.keys(c.state.sources).sort(),['kilo','ovh','ovhmeta'],'removed provider metadata source remains active');
   assert.throws(()=>c.assertUsable('zen','retired-model'));
   assert.deepEqual(await readFile(file),before,'loading rewrote the disk cache');
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
