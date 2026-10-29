import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FreePool,freePoolDefaults,validateFreePool,schedulingMode,poolKey,parsePoolKey } from '../src/free-pool.js';
import { editFreePool } from '../src/free-pool-editor.js';
import { environment,K,K2,A,B,context } from './free-pool-helper.mjs';

for(const [models,mode]of [[[K,K2],'round-robin'],[[K,A],'priority'],[[A,B],'priority'],[[K,K2,A],'priority']])test('automatic default '+JSON.stringify(models),()=>{
 assert.equal(schedulingMode(validateFreePool({...freePoolDefaults(),models})),mode);
});
test('explicit priority/round robin override automatic defaults without changing enablement',()=>{
 for(const scheduling of ['priority','round-robin'])assert.equal(schedulingMode(validateFreePool({...freePoolDefaults(),models:[K,K2],scheduling})),scheduling);
 assert.equal(freePoolDefaults().enabled,false);
});
for(const w of [0,3,100,-1,1.5,'2',Infinity])test('OVH rejects requests per visit '+w,()=>assert.throws(()=>validateFreePool({...freePoolDefaults(),models:[A,B],weights:{[A]:w}}),/OVH/));
for(const w of [1,2])test('OVH accepts weight '+w,()=>assert.equal(validateFreePool({...freePoolDefaults(),models:[A,B],weights:{[A]:w}}).weights[A],w));
test('OVH default is 2; Kilo siblings default is 1 and can be 3/4/100',()=>{
 const c=validateFreePool({...freePoolDefaults(),models:[A,K,K2]});assert.equal(c.weights[A],2);assert.equal(c.weights[K],1);
 assert.equal(validateFreePool({...freePoolDefaults(),models:[K,K2],weights:{[K]:100,[K2]:4}}).weights[K],100);
});
for(const raw of [{models:[K,K]},{models:['kilo/foo']},{models:['["bad","id"]']},{models:[K],enabled:true},{models:[K,K2],weights:{alien:1}},{models:[K,K2],cycles:-1},{models:[K,K2],cycles:1,scheduling:'priority'},{models:[K,K2],weights:{[K]:101}},{models:[K,K2],maxWaitMs:60001},{models:[K,K2],responseStartTimeoutMs:300001}])test('invalid configuration '+JSON.stringify(raw),()=>assert.throws(()=>validateFreePool({...freePoolDefaults(),...raw})));
test('provider-qualified identities are exact, round-trip and cannot collide',()=>{
 const a='["kilo","same"]',b='["kilo","second"]';assert.notEqual(a,b);assert.equal(parsePoolKey(a).provider,'free-kilo');
 assert.throws(()=>parsePoolKey('[ "kilo", "same" ]'));assert.throws(()=>parsePoolKey('["kilo","bad\\u001bid"]'));
});
test('weighted block round robin produces 3/4/1, then repeats; no autonomous sends',async()=>{
 const x=environment({models:[K,K2,A],weights:{[K]:3,[K2]:4,[A]:1},scheduling:'round-robin'});await x.enable();
 assert.equal(x.sends,0);const output=[];for(let i=0;i<16;i++)output.push(await x.next());
 assert.deepEqual(output,[K,K,K,K2,K2,K2,K2,A,K,K,K,K2,K2,K2,K2,A]);assert.equal(x.sends,16);
});
test('Kilo siblings-only does not stick forever to the first always-ready model',async()=>{
 const x=environment();await x.enable();assert.deepEqual([await x.next(),await x.next(),await x.next(),await x.next()],[K,K2,K,K2]);
});
test('priority intentionally keeps returning to a ready primary',async()=>{
 const x=environment({scheduling:'priority'});await x.enable();assert.deepEqual([await x.next(),await x.next(),await x.next()],[K,K,K]);
});
test('finite allowance pauses before an extra send and restart is explicit; cooldowns are not reset',async()=>{
 const x=environment({models:[K,K2],weights:{[K]:3,[K2]:4},cycles:1});await x.enable();
 for(let n=0;n<7;n++)await x.next();assert.equal(x.pool.rotation.paused,true);assert.equal(x.pool.rotation.completed,1);
 await assert.rejects(x.next(),/paused/);assert.equal(x.sends,7);
 await x.pool.saveDraft({...x.pool.config,maxWaitMs:100},x.pool.config,{consent:true});assert.equal(x.pool.rotation.paused,true);
 x.pool.barriers.set('kilo',{until:9000});await x.pool.saveDraft(x.pool.config,x.pool.config,{restart:true,consent:true});assert.equal(x.pool.rotation.completed,0);assert.equal(x.pool.until(K2),9000);
});
test('two cycles of 3/4/1 stop after exactly sixteen reserved sends',async()=>{
 const x=environment({models:[K,K2,A],weights:{[K]:3,[K2]:4,[A]:1},cycles:2,scheduling:'round-robin'});await x.enable();for(let n=0;n<16;n++)await x.next();await assert.rejects(x.next(),/paused/);assert.equal(x.sends,16);
});
test('unavailable visits skip without fake sends; a finite pass cannot wait forever',async()=>{
 const x=environment({cycles:1});await x.enable();x.catalog.state.entries[K].listed=false;
 assert.equal(await x.next(),K2);assert.equal(x.sends,1);assert.equal(x.pool.rotation.completed,1);await assert.rejects(x.next(),/paused/);
});
test('all ineligible or incompatible entries terminate boundedly',async()=>{
 const x=environment();await x.enable();x.pool.reason=()=> 'does not fit';await assert.rejects(x.next(),/No ready/);assert.equal(x.sends,0);
});
test('unknown Kilo 429 gates its exact model and honors Retry-After',async()=>{
 const x=environment();await x.enable();await x.pool.observe('reflection/beam-free',new Response('{}',{status:429,headers:{'retry-after':'10'}}),{},'kilo');
 assert.equal(x.sends,0);assert.equal(x.pool.until(K),x.now+10000);assert.equal(await x.next(),K2);
 assert.equal(x.disk.modelBarriers[K].until,11000);assert.equal(x.disk.approvedProviders.join(','),'kilo');
});
test('Retry-After cannot shorten an existing barrier and no model RPM is invented',async()=>{
 const x=environment();await x.enable();await x.pool.observe('thinkingmachines/inkling-small:free',new Response('',{status:503,headers:{'retry-after':'20'}}),{},'kilo');
 await x.pool.observe('thinkingmachines/inkling-small:free',new Response('',{status:429,headers:{'retry-after':'1'}}),{},'kilo');assert.equal(x.pool.until(K2),21000);
 await x.pool.observe('thinkingmachines/inkling-small:free',new Response('',{status:200}),{},'kilo');assert.equal(x.pool.until(K2),21000);
});
test('OVH durable two-per-minute ledger overrides a fast rotation and survives config reset',async()=>{
 const x=environment({models:[A,B],scheduling:'round-robin'});await x.enable();
 assert.deepEqual([await x.next(),await x.next(),await x.next(),await x.next()],[A,A,B,B]);
 await assert.rejects(x.next(),/No ready/);assert.equal(x.sends,4);
 await x.pool.saveDraft(x.pool.config,x.pool.config,{restart:true,consent:true});await assert.rejects(x.next(),/No ready/);
 x.advance(61000);assert.equal(await x.next(),A);
});
test('a save failure prevents the wire, pauses safely, and does not silently continue',async()=>{
 const x=environment();await x.enable();x.setFail(true);await assert.rejects(x.next(),/Could not save rotation/);assert.equal(x.sends,0);assert.equal(x.pool.rotation.paused,true);x.setFail(false);await assert.rejects(x.next(),/paused/);
});
test('a cancelled reservation is spent conservatively, but no send is claimed',async()=>{
 const x=environment();await x.enable();let checks=0;await assert.rejects(x.pool.reserve(x.model(K),()=>{if(++checks===2)throw Error('cancelled');}),/cancelled/);
 assert.equal(x.sends,0);assert.equal(x.pool.rotation.cursor,1);assert.equal(x.disk.rotation.cursor,1);
});
test('new targets require route consent; structural changes require an explicit new allowance',async()=>{
 const x=environment();await assert.rejects(x.pool.saveDraft({...freePoolDefaults(),enabled:true,models:[K,K2]},x.pool.config,{restart:true}),/consent/);await x.enable();
 await assert.rejects(x.pool.saveDraft({...x.pool.config,weights:{[K]:3}},x.pool.config,{consent:true}),/restart/);
});
test('actual compatibility rejects unfinished tools, images, absent tools, overlong context, removed thinking and paid entries',async()=>{
 const x=environment();await x.enable();const a=x.model(K),b=x.model(K2),base=context();assert.equal(x.pool.reason(a,b,base,{}),null);
 const pending={messages:[{role:'assistant',content:[{type:'toolCall',id:'t',name:'read',arguments:{}}]}]};assert.match(x.pool.reason(a,b,pending,{}),/Unresolved/);
 assert.match(x.pool.reason(a,b,{messages:[{role:'user',content:[{type:'image',data:'x'}]}]},{}),/multimodal/);
 assert.match(x.pool.reason(a,b,{messages:[{role:'user',content:'x'.repeat(3000000)}]},{}),/budget|fit/);
 const old=x.catalog.state.entries[K2];x.catalog.state.entries[K2]={...old,classification:'paid'};assert.match(x.pool.reason(a,b,base,{}),/eligible/);
});
test('disk round trip keeps cursor, finite exhaustion, provider cooldown and OVH reservations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'free-persist-'));try{
  const x=environment({cycles:1});await x.enable();await x.next();await x.pool.observe('thinkingmachines/inkling-small:free',new Response('',{status:429,headers:{'retry-after':'2'}}),{},'kilo');
  const file=join(dir,'pool.json');await writeFile(file,JSON.stringify(x.disk));const restored=new FreePool({catalog:x.catalog,ovhPool:x.ovh,file,now:()=>x.now});await restored.load();assert.equal(restored.installed,true);assert.equal(restored.rotation.cursor,1);assert.equal(restored.until(K2),3000);
  await assert.rejects(restored.choose(x.model(K),context(),{}),/paused/);assert.equal(restored.rotation.paused,true);
  const again=new FreePool({catalog:x.catalog,ovhPool:x.ovh,file,now:()=>x.now});await again.load();assert.equal(again.rotation.paused,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('corrupt runtime pauses a valid enabled pool, while corrupt config disables it visibly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'free-corrupt-'));try{
  const x=environment();await x.enable();const file=join(dir,'pool');const raw=structuredClone(x.disk);raw.rotation.used=-1;await writeFile(file,JSON.stringify(raw));
  const p=new FreePool({catalog:x.catalog,ovhPool:x.ovh,file});await p.load();assert.equal(p.config.enabled,true);assert.equal(p.rotation.paused,true);
  await writeFile(file,'{');const q=new FreePool({catalog:x.catalog,ovhPool:x.ovh,file});await q.load();assert.equal(q.installed,true);assert.equal(q.config.enabled,false);assert.match(q.warning,/invalid/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('legacy import preserves order, enabled state, native thinking, limits and independent quota',async()=>{
 const x=environment();await x.ovh.configure('set',['gpt-oss-120b','gpt-oss-20b']);await x.ovh.configure('on');x.ovh.started('gpt-oss-120b');
 x.pool.importLegacy();assert.deepEqual(x.pool.config.models,[A,B]);assert.equal(x.pool.config.enabled,true);assert.equal(schedulingMode(x.pool.config),'priority');assert.equal(x.pool.config.weights[A],2);assert.equal(x.ovh.quota.describe('gpt-oss-120b').remaining,1);assert.equal(x.disk,undefined);
});
test('editor Escape and rejected review save nothing, preserve active model; affirmative review is explicit',async()=>{
 const x=environment();const messages=[],ctx={hasUI:true,model:x.model(K),isIdle:()=>true,ui:{select:async()=>undefined,confirm:async()=>false,input:async()=>undefined}};
 const before=ctx.model;assert.match(await editFreePool(x.pool,{},ctx),/cancelled/);assert.equal(x.disk,undefined);assert.equal(ctx.model,before);
 ctx.ui.select=async()=> 'Apply settings';assert.match(await editFreePool(x.pool,{},ctx),/cancelled/);assert.equal(x.disk,undefined);
});

test('reviewed editor saves a mixed weighted finite pool, asks routing consent, and keeps the active model by default',async()=>{
 const x=environment(),menus=[],inputs=['3','4','1'];
 const choices=[o=>o.find(v=>v==='Edit model order'),o=>o.find(v=>v==='free-kilo / reflection/beam-free'),o=>o.find(v=>v==='free-kilo / thinkingmachines/inkling-small:free'),()=> 'Use this order',()=> 'Edit requests per visit',o=>o.find(v=>v.startsWith(K)),o=>o.find(v=>v.startsWith(K2)),()=> 'Back',o=>o.find(v=>v.startsWith('Cycles:')),o=>o.find(v=>v.startsWith('Pool:')),()=> 'Apply settings'];
 let review='',setModels=0;
 const ctx={hasUI:true,model:{provider:'other',id:'keep'},isIdle:()=>true,ui:{select:async(title,options)=>{menus.push(title);const f=choices.shift();assert.ok(f,title);return f(options);},input:async()=>inputs.shift(),confirm:async(title,text)=>{review=text;return true;}}};
 const before=ctx.model;const result=await editFreePool(x.pool,{setModel:async()=>{setModels++;return false;}},ctx);
 assert.match(result,/settings saved/);assert.equal(setModels,0);assert.equal(ctx.model,before);assert.match(review,/PROVIDER ROUTING CONSENT/);
 assert.deepEqual(x.pool.config.models,[K,K2]);assert.equal(x.pool.config.weights[K],3);assert.equal(x.pool.config.weights[K2],4);assert.equal(x.pool.config.cycles,1);assert.equal(x.pool.config.enabled,true);assert.equal(schedulingMode(x.pool.config),'round-robin');assert.equal(x.sends,0);
});

test('priority editor hides round-robin-only weights/cycles; selecting priority explicitly clears finite cycles in the reviewed draft',async()=>{
 const x=environment({models:[K,K2],cycles:1}),seen=[];let n=0;
 const ctx={hasUI:true,model:{provider:'other',id:'keep'},isIdle:()=>true,ui:{select:async(_title,options)=>{seen.push(options);if(n++===0)return options.find(v=>v.startsWith('Scheduling:'));if(n===2)return 'priority';assert.equal(options.includes('Edit requests per visit'),false);assert.equal(options.some(v=>v.startsWith('Cycles:')),false);return 'Apply settings';},input:async()=>undefined,confirm:async(_title,text)=>{assert.match(text,/scheduling: priority; cycles: continuous/);return true;}}};
 const result=await editFreePool(x.pool,{},ctx);assert.match(result,/settings saved/);assert.equal(x.pool.config.cycles,0);assert.equal(x.pool.config.scheduling,'priority');assert.equal(x.sends,0);
});
