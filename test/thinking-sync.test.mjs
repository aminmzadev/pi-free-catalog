import test from 'node:test';import assert from 'node:assert/strict';
import {thinkingSync,piLevelForNative} from '../src/thinking-sync.js';
import {recordKey} from '../src/catalog.js';import {state} from './helpers.mjs';
const st=state(),get=(s,id)=>st.entries[recordKey(s,id)];
test('exact reverse mapping covers Kilo variants effort including max',()=>{
 for(const [s,id] of [['kilo','reflection/beam-free'],['kilo','thinkingmachines/inkling-small:free']])for(const level of (id==='reflection/beam-free'?['low','medium','high','xhigh','max']:['low','medium','high','max']))assert.equal(piLevelForNative(get(s,id),st,level),level);
});
test('explicit effort reverse mapping is instant -> off and thinking -> high',()=>{
 const e=get('kilo','poolside/laguna-s-2.1:free');assert.equal(piLevelForNative(e,st,'instant'),'off');assert.equal(piLevelForNative(e,st,'thinking'),'high');
});
test('provider default and unknown future variants never claim an exact Pi level',()=>{
 assert.equal(piLevelForNative(get('kilo','thinkingmachines/inkling-small:free'),st,'default'),null);
 const s=structuredClone(st),e=s.entries[recordKey('kilo','reflection/beam-free')];e.metadata.opencode.variants['new-ultra']={reasoning:{enabled:true,effort:'future-effort'}};
 assert.equal(piLevelForNative(e,s,'new-ultra'),null);
});
function setup(){
 let level='medium',saved=0;const prefs={},statuses=new Map();const ctx={model:{provider:'free-kilo',id:'thinkingmachines/inkling-small:free'},ui:{setStatus:(k,v)=>statuses.set(k,v)}};
 const key=()=>recordKey(ctx.model.provider==='free-kilo'?'kilo':'kilo',ctx.model.id);
 let sync;const pi={getThinkingLevel:()=>level,setThinkingLevel:n=>{const previousLevel=level;level=n;if(n!==previousLevel)void sync.selected({level:n,previousLevel},ctx);}};
 sync=thinkingSync({pi,catalog:{state:st},getSelection:(s,id)=>prefs[recordKey(s,id)]||'auto',setSelection:(k,m)=>prefs[k]=m,save:async()=>{saved++;},output:()=>{}});
 return {pi,sync,ctx,prefs,statuses,key,get saves(){return saved;}};
}
test('native -> Pi updates actual level, internal event does not erase preference or recurse',()=>{
 const x=setup();x.sync.restore(x.ctx);x.prefs[x.key()]='max';x.sync.applyNative('max',x.ctx);assert.equal(x.pi.getThinkingLevel(),'max');assert.equal(x.prefs[x.key()],'max');assert.equal(x.saves,0);
});
test('Pi -> native removes stale override immediately and affects only current free model',async()=>{
 const x=setup();x.prefs[x.key()]='max';const other=recordKey('kilo','reflection/beam-free');x.prefs[other]='high';x.sync.restore(x.ctx);x.pi.setThinkingLevel('low');assert.equal(x.prefs[x.key()],'auto');assert.equal(x.prefs[other],'high');assert.equal(x.saves,1);
});
test('model-switch preliminary thinking event cannot erase target preference',async()=>{
 const x=setup();x.sync.restore(x.ctx);x.ctx.model={provider:'free-kilo',id:'reflection/beam-free'};x.prefs[x.key()]='max';await x.sync.selected({level:'low',previousLevel:'medium'},x.ctx);assert.equal(x.prefs[x.key()],'max');x.sync.restore(x.ctx);assert.equal(x.pi.getThinkingLevel(),'max');
});
test('non-free models are unaffected; default override does not leave persistent labels',async()=>{
 const x=setup();x.prefs[x.key()]='default';x.sync.restore(x.ctx);assert.equal(x.statuses.get('free-thinking'),undefined);x.pi.setThinkingLevel('low');assert.equal(x.prefs[x.key()],'auto');assert.equal(x.statuses.get('free-thinking'),undefined);
 x.ctx.model={provider:'anthropic',id:'anything'};await x.sync.selected({level:'high',previousLevel:'low'},x.ctx);x.sync.restore(x.ctx);assert.equal(x.statuses.get('free-thinking'),undefined);assert.equal(x.saves,1);
});
test('unmapped future native mode remains usable without a persistent label',()=>{
 const x=setup();const e=st.entries[x.key()];e.metadata.opencode.variants['future-effort']={reasoning:{enabled:true,effort:'future-effort'}};
 try{x.prefs[x.key()]='future-effort';x.sync.restore(x.ctx);assert.equal(x.pi.getThinkingLevel(),'medium');assert.equal(x.statuses.get('free-thinking'),undefined);}finally{delete e.metadata.opencode.variants['future-effort'];}
});
