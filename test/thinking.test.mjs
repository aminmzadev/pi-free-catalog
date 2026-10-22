import test from 'node:test';import assert from 'node:assert/strict';
import { thinkingProfile, selectThinking, applyThinking, piModel } from '../src/models.js';
import { recordKey,reconcile } from '../src/catalog.js';import { state,sources,fixtures } from './helpers.mjs';
const s=state(),get=(service,id)=>s.entries[recordKey(service,id)];
test('Kilo toggle variants preserve native instant/thinking, not fictional low/high levels',()=>{
 const e=get('kilo','poolside/laguna-s-2.1:free');
 assert.deepEqual(Object.keys(thinkingProfile(e,s).choices),['instant','thinking']);
 assert.deepEqual(selectThinking(e,s,'instant'),{reasoning:{enabled:false,effort:'none'}});
 assert.deepEqual(selectThinking(e,s,'thinking'),{reasoning:{enabled:true,effort:'high'}});
 assert.throws(()=>selectThinking(e,s,'low'),/Unsupported native/);
});
test('Kilo effort mapping supports all advertised levels including max',()=>{
 const e=get('kilo','reflection/beam-free');for(const level of ['low','medium','high','xhigh','max'])assert.equal(selectThinking(e,s,level).reasoning.effort,level);assert.throws(()=>selectThinking(e,s,'off'));
});
test('Zen native effort values are emitted as reasoning_effort',()=>{
 const e=get('zen','beam-free');assert.deepEqual(selectThinking(e,s,'low'),{reasoning_effort:'low'});assert.deepEqual(selectThinking(e,s,'max'),{reasoning_effort:'max'});
});
test('Zen native none is preserved and mapped from Pi off without inventing a choice',()=>{
 const e=get('zen','nemotron-3.5-super-vl-free');assert.equal(selectThinking(e,s,'none').reasoning_effort,'none');assert.equal(selectThinking(e,s,'auto','off').reasoning_effort,'none');
});
test('future unfamiliar native variant stays selectable rather than silently discarded',()=>{
 const d=structuredClone(fixtures),m=d.kilo.data.find(m=>m.id==='reflection/beam-free');m.opencode.variants['new-ultra']={reasoning:{enabled:true,effort:'future-effort'},model:'paid-model'};
 const st=reconcile(sources(d)),e=st.entries[recordKey('kilo',m.id)];assert.deepEqual(selectThinking(e,st,'new-ultra'),{reasoning:{enabled:true,effort:'future-effort'}});
});
test('auto maps explicit native thinking high to Pi high',()=>assert.equal(selectThinking(get('kilo','poolside/laguna-s-2.1:free'),s,'auto','high').reasoning.effort,'high'));
test('unsupported Pi effort is rejected rather than silently sending a made-up value',()=>assert.throws(()=>selectThinking(get('kilo','reflection/beam-free'),s,'auto','minimal'),/not advertised/));
test('default preserves provider default and clears inherited thinking fields',()=>{
 const e=get('kilo','reflection/beam-free');assert.deepEqual(selectThinking(e,s,'default'),{});assert.deepEqual(applyThinking({model:e.id,messages:[],reasoning_effort:'high',thinking:{type:'enabled'}},{}),{model:e.id,messages:[]});
});
test('missing advertised choices only permits provider default, not fabricated settings',()=>{
 const e=get('zen','nemotron-3.5-lightning-free');assert.equal(thinkingProfile(e,s).source,'provider-default-only');assert.deepEqual(selectThinking(e,s,'auto','high'),{});assert.throws(()=>selectThinking(e,s,'low'));
});
test('unknown required context/output fields have labelled fallback, do not hide model',()=>{
 const e=structuredClone(get('kilo','reflection/beam-free'));delete e.metadata.context_length;delete e.metadata.top_provider;delete e.metadata.max_completion_tokens;
 const m=piModel(e,s);assert.equal(m.contextWindow,8192);assert.equal(m.maxTokens,2048);assert.match(m.name,/unverified/);
});
test('live authoritative context is not replaced by generic guesses',()=>{
 assert.equal(piModel(get('zen','beam-free'),s).contextWindow,1048576);assert.equal(piModel(get('zen','glm-5.3-flash-free'),s).contextWindow,200000);
});
