import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, recordKey } from '../src/catalog.js';
import { OvhPool } from '../src/ovh-pool.js';
import { editOvhPool, secondsToMs, APPLY, CANCEL } from '../src/ovh-pool-editor.js';
import { state } from './helpers.mjs';
const A='gpt-oss-120b',B='gpt-oss-20b';
async function fixture(){
 const catalog=new Catalog({fetch:()=>{throw Error('Editor must never fetch');}});catalog.state=state();let writes=0,changes=0;
 const p=new OvhPool({catalog,getPiLevel:()=> 'low',persist:async()=>{writes++;},file:'test-only-never-written'});await p.configure('set',[A,B]);writes=0;
 const steps=[],inputs=[],confirmations=[],observed=[];
 const ctx={hasUI:true,model:{provider:'free-ovh',id:B},isIdle:()=>true,ui:{setStatus(){},notify(){},select:async(title,options)=>{
  observed.push({title,options});const s=steps.shift();return typeof s==='function'?await s(title,options):s;
 },input:async()=>inputs.shift(),confirm:async(title,message)=>{observed.push({title,message});const c=confirmations.shift();return typeof c==='function'?await c(title,message):c;}}};
 const pi={setModel:async m=>{changes++;ctx.model=m;return true;}};
 return {p,catalog,ctx,pi,steps,inputs,confirmations,observed,run:()=>editOvhPool(p,pi,ctx),get writes(){return writes;},get changes(){return changes;}};
}
const starts=prefix=>(_title,options)=>options.find(s=>s.startsWith(prefix));
for(const [s,n]of [['0',0],['60',60000],['1.5',1500],['0.001',1],[' 2 ',2000],['60.001',null],['-1',null],['1e2',null],['',null],['0.0001',null],['Infinity',null],['1,5',null]])test('wait input '+JSON.stringify(s),()=>assert.equal(secondsToMs(s),n));

test('all fields stay in draft; final cancellation preserves exact configuration and active model',async()=>{
 const x=await fixture(),before=structuredClone(x.p.config),model=x.ctx.model;
 x.steps.push('Edit model order',(_t,o)=>o.find(s=>s.endsWith(`[${B}]`)),(_t,o)=>o.find(s=>s.endsWith(`[${A}]`)),'Use this order',starts('Pool:'),starts('Maximum wait:'),starts('Select primary on Apply:'),APPLY);
 x.inputs.push('1.5');x.confirmations.push(false);assert.match(await x.run(),/cancelled/);assert.deepEqual(x.p.config,before);assert.equal(x.ctx.model,model);assert.equal(x.writes,0);
});
test('one reviewed atomic write saves order/state/wait/thinking, then public primary selection',async()=>{
 const x=await fixture();x.steps.push('Edit model order',(_t,o)=>o.find(s=>s.endsWith(`[${B}]`)),(_t,o)=>o.find(s=>s.endsWith(`[${A}]`)),'Use this order','Edit per-model thinking',starts(B+' —'),'Native: high',starts(A+' —'),'Native: low','Back',starts('Pool:'),starts('Maximum wait:'),starts('Select primary on Apply:'),APPLY);
 x.inputs.push('2');x.confirmations.push((_t,m)=>{assert.match(m,/gpt-oss-20b: high/);assert.equal(x.writes,0);return true;});
 assert.match(await x.run(),/settings saved/);assert.deepEqual(x.p.config.models,[B,A]);assert.deepEqual(x.p.config.thinking,{[B]:'high',[A]:'low'});assert.equal(x.p.config.enabled,true);assert.equal(x.p.config.maxWaitMs,2000);assert.equal(x.writes,1);assert.equal(x.changes,1);
});
test('Cancel/Escape at top level changes nothing',async()=>{for(const choice of [CANCEL,undefined]){const x=await fixture(),before=x.p.config;x.steps.push(choice);await x.run();assert.equal(x.p.config,before);assert.equal(x.writes,0);}});
test('order picker Undo and Back never save an intermediate order',async()=>{
 const x=await fixture(),before=x.p.config;x.steps.push('Edit model order',(_t,o)=>o.find(s=>s.endsWith(`[${A}]`)),'Undo last selection','Back — keep draft order',CANCEL);await x.run();assert.equal(x.p.config,before);assert.equal(x.writes,0);
});
test('invalid/custom wait retries; input Escape keeps the draft value',async()=>{
 const x=await fixture();x.steps.push(starts('Maximum wait:'),starts('Maximum wait:'),APPLY);x.inputs.push('61','bad','2.25',undefined);x.confirmations.push(true);await x.run();assert.equal(x.p.config.maxWaitMs,2250);assert.equal(x.writes,1);
});
test('per-model thinking menu lists only advertised modes and cancel preserves saved modes',async()=>{
 const x=await fixture(),before=x.p.config;x.steps.push('Edit per-model thinking',starts(A+' —'),(_t,o)=>{assert.ok(o.includes('Native: high'));assert.ok(!o.includes('Native: off'));return 'Native: high';},'Back',CANCEL);await x.run();assert.equal(x.p.config,before);assert.equal(x.writes,0);
});
test('confirmed Reset still requires Apply, preserves active model and runtime barriers',async()=>{
 const x=await fixture();x.p.started(A);x.p.ready.set(A,Date.now()+60000);x.steps.push('Reset draft',APPLY);x.confirmations.push(true,true);const model=x.ctx.model;await x.run();assert.deepEqual(x.p.config.models,[]);assert.equal(x.p.config.enabled,false);assert.equal(x.p.config.maxWaitMs,0);assert.equal(x.ctx.model,model);assert.ok(x.p.ready.has(A));assert.equal(x.p.quota.describe(A).remaining,1);
});
test('Reset followed by Cancel saves nothing',async()=>{
 const x=await fixture(),before=x.p.config;x.steps.push('Reset draft',CANCEL);x.confirmations.push(true);await x.run();assert.equal(x.p.config,before);assert.equal(x.writes,0);
});
for(const kind of ['busy','model','config','shutdown'])test('stale editor guard: '+kind,async()=>{
 const x=await fixture();x.steps.push(()=>{
  if(kind==='busy')x.ctx.isIdle=()=>false;
  if(kind==='model')x.ctx.model={provider:'other',id:'other'};
  if(kind==='config')x.p.config={...x.p.config};
  if(kind==='shutdown')x.p.close();return APPLY;
 });assert.match(await x.run(),/unchanged/);assert.equal(x.writes,0);assert.equal(x.changes,0);
});
test('headless editor is read-only and never selects models',async()=>{
 const x=await fixture();x.ctx.hasUI=false;assert.match(await x.run(),/requires the Pi UI/);assert.equal(x.writes,0);assert.equal(x.changes,0);
});
test('failed atomic write leaves memory unchanged and selects no model',async()=>{
 const x=await fixture(),before=x.p.config;x.p.persist=async()=>{throw Error('disk full');};x.steps.push(starts('Pool:'),APPLY);x.confirmations.push(true);assert.match(await x.run(),/unchanged: disk full/);assert.equal(x.p.config,before);assert.equal(x.changes,0);
});
test('failed model selection reports saved settings accurately, not a fictitious rollback',async()=>{
 const x=await fixture();x.pi.setModel=async()=>false;x.steps.push(starts('Pool:'),starts('Select primary on Apply:'),APPLY);x.confirmations.push(true);assert.match(await x.run(),/settings were saved.*selection failed/);assert.equal(x.p.config.enabled,true);assert.equal(x.ctx.model.id,B);assert.equal(x.writes,1);
});
test('old schema without thinking overrides preserves configured order/state/wait',async()=>{
 const x=await fixture();const old={schemaVersion:1,enabled:true,models:[B,A],maxWaitMs:2000};const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'pool-migrate-'));
 try{await writeFile(join(dir,'p.json'),JSON.stringify(old));x.p.file=join(dir,'p.json');await x.p.load();assert.deepEqual({...x.p.config,thinking:undefined},{...old,responseStartTimeoutMs:0,thinking:undefined});assert.deepEqual(x.p.config.thinking,{});}finally{await rm(dir,{recursive:true,force:true});}
});
test('unavailable retained selections do not prevent disabling the pool',async()=>{
 const x=await fixture();await x.p.configure('on');x.catalog.state.entries[recordKey('ovh',B)].lifecycle='retired';await x.p.configure('off');assert.equal(x.p.config.enabled,false);assert.deepEqual(x.p.config.models,[A,B]);
});
test('unadvertised pool thinking cannot be committed and outside selections are never written',async()=>{
 const x=await fixture(),before=x.p.config;await assert.rejects(x.p.saveDraft({...before,thinking:{[A]:'off'}}),/Unsupported native thinking/);assert.equal(x.p.config,before);assert.equal(x.writes,0);
});

for(const [text,expected]of [['0',0],['0.001',1],['60.001',60001],['300',300000],['300.001',null],['301',null],['-1',null],['1e2',null]])test('response-start seconds input '+text,()=>assert.equal(secondsToMs(text,300),expected));
test('response-start control is separate, validated and atomically saved only after review',async()=>{
 const x=await fixture();assert.equal(x.p.config.responseStartTimeoutMs,0);
 x.steps.push(starts('Response-start limit:'),APPLY);x.inputs.push('301','bad','1.25');x.confirmations.push((_t,m)=>{assert.match(m,/Response-start limit: 1.25s/);assert.equal(x.writes,0);return true;});
 await x.run();assert.equal(x.p.config.responseStartTimeoutMs,1250);assert.equal(x.p.config.maxWaitMs,0);assert.equal(x.writes,1);
});
test('response-start draft cancellation and Reset preserve used quota and disable only on Apply',async()=>{
 const x=await fixture();const before=x.p.config;x.steps.push(starts('Response-start limit:'),CANCEL);x.inputs.push('60');await x.run();assert.equal(x.p.config,before);assert.equal(x.writes,0);
 await x.p.saveDraft({...x.p.config,responseStartTimeoutMs:60000});x.p.started(A);x.steps.push('Reset draft',APPLY);x.confirmations.push(true,true);await x.run();assert.equal(x.p.config.responseStartTimeoutMs,0);assert.equal(x.p.quota.describe(A).remaining,1);
});
for(const value of [-1,300001,NaN,Infinity,null,'60',0.5])test('invalid persisted response-start limit '+String(value)+' is rejected',async()=>{
 const x=await fixture(),before=x.p.config;await assert.rejects(x.p.saveDraft({...before,responseStartTimeoutMs:value}),/0 to 300 seconds/);assert.equal(x.p.config,before);assert.equal(x.writes,0);
});
for(const apply of [false,true])test('custom scrollable final review '+(apply?'Apply':'Escape')+' has no second confirmation',async()=>{
 const x=await fixture();x.steps.push(starts('Response-start limit:'),APPLY);x.inputs.push('60');
 x.ctx.ui.custom=async factory=>{let approved;const component=factory({terminal:{rows:12},requestRender(){}},{},{},v=>approved=v);const lines=component.render(24);assert.ok(lines.length<=12);component.handleInput(apply?'\r':'\x1b');return approved;};
 x.ctx.ui.confirm=async()=>{throw Error('Unexpected second confirmation');};await x.run();assert.equal(x.writes,apply?1:0);assert.equal(x.p.config.responseStartTimeoutMs,apply?60000:0);
});
