// Phase A recovery path: one mocked unavailable Pages GET plus seven direct-source GETs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import extension from '../index.js';
import { fetcher } from './helpers.mjs';

// Actual Pi/SDK and production extension; ALL HTTP in this file is mocked, not live proof.
async function environment(run){
 const dir=await mkdtemp(join(tmpdir(),'ovh-session-')),before=globalThis.fetch,prior=process.env.PI_CODING_AGENT_DIR;
 const wires=[],statuses=[],errors=[];let catalogs=0,offline=false,session;
 process.env.PI_CODING_AGENT_DIR=dir;
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/chat/completions')){
   wires.push({url:String(input),body:JSON.parse(init.body),headers:Object.fromEntries(init.headers)});
   return new Response('data: {"id":"x","model":"'+JSON.parse(init.body).model+'","choices":[{"index":0,"delta":{"content":"323"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }
  catalogs++;if(offline)throw new Error('Mock metadata outage');return fetcher()(input,init);
 };
 try{
  const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});await loader.reload();
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(dir)}));
  await session.bindExtensions({mode:'tui',uiContext:{setStatus:(k,v)=>statuses.push({key:k,value:v}),setFooter(){},notify(){}},onError:e=>errors.push(e)});
  await run({session,wires,statuses,errors,get catalogs(){return catalogs;},offline:()=>offline=true});
 }finally{
  if(session){await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}
  globalThis.fetch=before;if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior;
  await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
}

test('actual Pi two-provider coexistence: full Kilo/OVH inventories registered, native thinking two-way controls exact per-provider HTTP',async()=>environment(async x=>{
 const s=x.session;assert.equal(x.catalogs,4);
 assert.equal(s.modelRuntime.getAllModels().filter(m=>m.provider==='free-kilo').length,17);
 assert.equal(s.modelRuntime.getAllModels().filter(m=>m.provider==='free-ovh').length,10);
 assert.ok(!s.modelRuntime.getAllModels().some(m=>m.provider==='free-zen'));
 for(const [provider,id] of [['free-kilo','reflection/beam-free'],['free-kilo','thinkingmachines/inkling-small:free'],['free-ovh','gpt-oss-120b']]){
  await s.setModel(s.modelRuntime.getModel(provider,id));await s.prompt('/free-thinking high');assert.equal(s.thinkingLevel,'high');s.setThinkingLevel('low');await s.prompt('17 * 19');
  const w=x.wires.at(-1);assert.equal(w.body.model,id);assert.equal(provider==='free-kilo'?w.body.reasoning.effort:w.body.reasoning_effort,'low');
  assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'stop');assert.equal(x.catalogs,4);
  assert.ok(w.body.tools.some(t=>t.function.name==='read'));if(provider==='free-ovh'){assert.ok(!w.headers.authorization);assert.ok(!w.body.tools.some(t=>t.function.strict===true));}
 }
 assert.deepEqual(x.errors,[]);assert.match(x.statuses.filter(s=>s.key==='free-catalog').at(-1).value,/^Free chat: Kilo \d+ · OVH \d+$/);
}));

test('actual Pi OVH wait is visible and abortable; cancelling a tool-continuation-sized next prompt does not send HTTP or fetch catalogs',async()=>environment(async x=>{
 const s=x.session;await s.setModel(s.modelRuntime.getModel('free-ovh','gpt-oss-120b'));s.setThinkingLevel('low');await s.prompt('17 * 19');assert.equal(x.wires.length,1);
 const timeout=setTimeout(()=>{void s.abort();},40);try{await s.prompt('17 * 19');}finally{clearTimeout(timeout);}
 assert.equal(x.wires.length,1);assert.equal(x.catalogs,4);
 assert.ok(x.statuses.some(s=>s.key==='free-ovh-activity'&&/^OVH wait /.test(s.value)));
 assert.equal(x.statuses.filter(s=>s.key==='free-ovh-activity').at(-1).value,undefined);
 assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'aborted');assert.deepEqual(x.errors,[]);
}));

test('actual Pi failed manual refresh leaves cached OVH inference usable without catalog fetches during prompt',async()=>environment(async x=>{
 const s=x.session;x.offline();await s.prompt('/free-refresh');assert.equal(x.catalogs,8);
 await s.setModel(s.modelRuntime.getModel('free-ovh','gpt-oss-120b'));s.setThinkingLevel('low');await s.prompt('17 * 19');
 assert.equal(x.catalogs,8);assert.equal(x.wires.length,1);assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'stop');assert.deepEqual(x.errors,[]);
}));

test('production OVH provider overrides SDK retry settings to zero and returns original 429, not an automatic retry/fallback',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ovh-sdk-')),before=globalThis.fetch,prior=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 const configs=new Map();let calls=0,notices=[];
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/chat/completions')){calls++;return Response.json({error:{message:'OVH anonymous quota test',type:'rate_limit_error'}},{status:429,headers:{'retry-after':'60'}});}
  return fetcher()(input,init);
 };
 try{
  await extension({registerProvider:(id,c)=>configs.set(id,c),registerCommand(){},on(){},getThinkingLevel:()=> 'low',setThinkingLevel(){},sendMessage(){}});
  const config=configs.get('free-ovh'),model={...config.models.find(m=>m.id==='gpt-oss-120b'),provider:'free-ovh'};
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),1000);let last;
  try{const stream=config.streamSimple(model,normalizeContext({messages:[{role:'user',content:'test',timestamp:1}]}),{reasoning:'low',maxRetries:3,signal:controller.signal});for await(const event of stream)notices.push(event.type);last=await stream.result();}finally{clearTimeout(timeout);}
  assert.equal(calls,1);assert.equal(last.stopReason,'error');assert.match(last.errorMessage,/429|quota/);assert.ok(!controller.signal.aborted);assert.ok(notices.includes('error'));
 }finally{globalThis.fetch=before;if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior;await rm(dir,{recursive:true,force:true});}
});
