import test from 'node:test';import assert from 'node:assert/strict';
import { completions as streamSimple } from '../src/sdk.js';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { Catalog } from '../src/catalog.js';import { registrations } from '../src/models.js';
import { scopedFetch,requestPayload } from '../src/transport.js';import { fetcher } from './helpers.mjs';
const catalog=new Catalog({fetch:fetcher()});await catalog.refresh();
const model={...registrations(catalog.state,'kilo').find(m=>m.id==='reflection/beam-free'),provider:'free-kilo'};
function sse(chunks){const text=chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join('')+'data: [DONE]\n\n';const bytes=new TextEncoder().encode(text);return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=2)c.enqueue(bytes.slice(i,i+2));c.close();}}),{headers:{'content-type':'text/event-stream'}});}
const chunk=(delta,finish_reason=null)=>({id:'chatcmpl_test',object:'chat.completion.chunk',created:1,model:model.id,choices:[{index:0,delta,finish_reason}]});
const context=normalizeContext({systemPrompt:'Test.',messages:[{role:'user',content:'Hi',timestamp:1}],tools:[{name:'read',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}]});
async function run(response,extra={}){
 const calls=[];const fetch=scopedFetch({catalog,service:'kilo',model,session:'test',getFetch:()=>async(...args)=>{calls.push(args);return response;}});
 const stream=streamSimple(model,context,{apiKey:'public',reasoning:'low',maxTokens:128,maxRetries:0,fetch,onPayload:requestPayload({catalog,service:'kilo',id:model.id,getSelection:()=> 'low',piLevel:'low'}),...extra});
 const events=[];for await(const e of stream)events.push(e);const result=await stream.result();return {calls,events,result};
}
test('real Pi SDK parses Unicode stream, terminal event, tools declaration and zero-cost usage',async()=>{
 const response=sse([chunk({role:'assistant',content:'Hello 🧠'}),{...chunk({},'stop'),usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}]);
 const {events,result,calls}=await run(response);assert.equal(result.stopReason,'stop');assert.equal(result.content[0].text,'Hello 🧠');assert.equal(result.usage.totalTokens,10);assert.equal(result.usage.cost.total,0);assert.equal(events.filter(e=>e.type==='done'||e.type==='error').length,1);
 const body=JSON.parse(calls[0][1].body);assert.equal(body.reasoning.effort,'low');assert.equal(body.tools[0].function.name,'read');
});
test('real Pi SDK assembles split tool JSON into valid arguments',async()=>{
 const {result}=await run(sse([chunk({role:'assistant',tool_calls:[{index:0,id:'call_one',type:'function',function:{name:'read',arguments:'{"pa'}}]}),chunk({tool_calls:[{index:0,function:{arguments:'th":"a.txt"}'}}]}),chunk({},'tool_calls')]));
 assert.equal(result.stopReason,'toolUse');const tool=result.content.find(c=>c.type==='toolCall');assert.equal(tool.name,'read');assert.deepEqual(tool.arguments,{path:'a.txt'});
});
test('real Pi SDK handles empty successful text without inventing content',async()=>{
 const {result}=await run(sse([chunk({role:'assistant',content:''}),chunk({},'stop')]));assert.equal(result.stopReason,'stop');assert.equal(result.content.filter(c=>c.type==='text').map(c=>c.text).join(''),'');
});
test('real Pi SDK reports malformed SSE as error, not fake success',async()=>{
 const {result,events}=await run(new Response('data: {invalid-json}\n\n',{headers:{'content-type':'text/event-stream'}}));assert.equal(result.stopReason,'error');assert.equal(events.filter(e=>e.type==='done'||e.type==='error').length,1);
});
test('real Pi SDK reports context overflow without rewriting it as retirement',async()=>{
 const {result}=await run(Response.json({error:{message:'context_length_exceeded',type:'invalid_request_error'}},{status:400}));assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/context_length_exceeded/);
});
test('real Pi SDK cancellation becomes aborted, not successful completion',async()=>{
 const controller=new AbortController();controller.abort();const {result}=await run(sse([chunk({content:'x'}),chunk({},'stop')]),{signal:controller.signal});assert.equal(result.stopReason,'aborted');
});
