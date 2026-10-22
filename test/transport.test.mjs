import test from 'node:test';import assert from 'node:assert/strict';
import { Catalog,recordKey } from '../src/catalog.js';
import { scopedFetch, requestPayload, sessionId } from '../src/transport.js';
import { fixtures,fetcher } from './helpers.mjs';
const catalog=new Catalog({fetch:fetcher()});await catalog.refresh();
const input={model:'reflection/beam-free',messages:[{role:'user',content:'hi'}],stream:true};
const url='https://api.kilo.ai/api/gateway/chat/completions';
function setup(service='kilo',id=input.model,output=new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})) {
 const calls=[];const f=scopedFetch({catalog,service,model:{id},session:'ses_test',getFetch:()=>async(...a)=>{calls.push(a);return output;}});return {f,calls};
}
test('Kilo strips all personal auth variants, preserves free header, never modifies global fetch',async()=>{
 const original=globalThis.fetch,{f,calls}=setup();await f(url,{method:'POST',body:JSON.stringify(input),headers:{Authorization:'SECRET','x-api-key':'SECRET','api-key':'SECRET'}});
 const h=calls[0][1].headers;assert.equal(h.has('authorization'),false);assert.equal(h.has('x-api-key'),false);assert.equal(h.has('api-key'),false);assert.equal(h.get('x-kilo-free'),'true');assert.equal(globalThis.fetch,original);assert.equal(calls[0][1].redirect,'error');
});
test('Zen uses only public anonymous bearer and stable session, no personal key',async()=>{
 const {f,calls}=setup('zen','beam-free');await f('https://opencode.ai/inference/v1/chat/completions',{method:'POST',headers:{authorization:'private-secret'},body:JSON.stringify({...input,model:'beam-free'})});
 const h=calls[0][1].headers;assert.equal(h.get('authorization'),'Bearer public');assert.equal(h.get('x-opencode-session'),'ses_test');assert.match(h.get('user-agent'),/pi-free-catalog/);
});
for(const bad of ['https://evil.example/chat/completions','https://api.kilo.ai/api/gateway/../paid','https://api.kilo.ai/api/gateway/chat/completions?alternate=true','https://api.kilo.ai.evil.example/api/gateway/chat/completions','https://user:password@api.kilo.ai/api/gateway/chat/completions'])test(`URL boundary rejects ${bad}`,async()=>{const {f,calls}=setup();await assert.rejects(f(bad,{method:'POST',body:JSON.stringify(input)}));assert.equal(calls.length,0);});
test('GET inference rejected',async()=>{const {f,calls}=setup();await assert.rejects(f(url,{method:'GET'}));assert.equal(calls.length,0);});
test('rewritten model ID rejected before any network request',async()=>{const {f,calls}=setup();await assert.rejects(f(url,{method:'POST',body:JSON.stringify({...input,model:'paid-model'})}),/rewritten/);assert.equal(calls.length,0);});
test('paid model cannot be called even with matching payload',async()=>{const {f,calls}=setup('zen','jev-1.13');await assert.rejects(f('https://opencode.ai/inference/v1/systemone',{method:'POST',body:JSON.stringify({model:'jev-1.13'})}),/not a currently/);assert.equal(calls.length,0);});
test('HTTP 404/429 are passed through and NOT reclassified as retirement',async()=>{
 for(const status of [404,429]){const response=new Response('upstream error',{status});const {f}=setup('kilo',input.model,response);assert.equal((await f(url,{method:'POST',body:JSON.stringify(input)})).status,status);assert.equal(catalog.state.entries[recordKey('kilo',input.model)].lifecycle,'active');}
});
test('Unicode SSE, empty text, tool chunks and partial bytes pass through exactly, no lossy SSE fixer',async()=>{
 const bytes=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello 🧠"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\ndata: [DONE]\n\n');
 const response=new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}}));
 const {f}=setup('kilo',input.model,response);const actual=await f(url,{method:'POST',body:JSON.stringify(input)});assert.equal(actual,response);assert.deepEqual(new Uint8Array(await actual.arrayBuffer()),bytes);
});
test('AbortSignal is passed through unchanged',async()=>{const {f,calls}=setup(),c=new AbortController();await f(url,{method:'POST',body:JSON.stringify(input),signal:c.signal});assert.equal(calls[0][1].signal,c.signal);});
test('onPayload chains original hook and applies native thinking without rewriting model/tools',async()=>{
 const hook=requestPayload({catalog,service:'kilo',id:input.model,getSelection:()=> 'low',piLevel:'high',original:async p=>({...p,temperature:0.2})});
 const tools=[{type:'function',function:{name:'read'}}],p=await hook({...input,tools,reasoning_effort:'high'});
 assert.equal(p.model,input.model);assert.deepEqual(p.tools,tools);assert.equal(p.temperature,0.2);assert.equal(p.reasoning.effort,'low');assert.equal(p.reasoning_effort,undefined);
});
test('session ID has native prefix/time layout; no account/API tokens involved',()=>assert.match(sessionId(1792211338000),/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/));
