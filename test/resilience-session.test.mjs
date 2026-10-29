// Phase A recovery path: one mocked unavailable Pages GET plus seven direct-source GETs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import extension from '../index.js';
import {fetcher} from './helpers.mjs';

// Real Pi sessions/SDK, deliberately mocked catalog and inference HTTP.
async function environment(run){
 const dir=await mkdtemp(join(tmpdir(),'free-resilience-')),before=globalThis.fetch,prior=process.env.PI_CODING_AGENT_DIR;
 let online=true,catalogCalls=0,gate=Promise.resolve(),release;const wires=[],statuses=new Map(),notes=[],errors=[],sessions=[];
 process.env.PI_CODING_AGENT_DIR=dir;
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/chat/completions')){
   wires.push(JSON.parse(init.body));return new Response('data: {"id":"x","choices":[{"index":0,"delta":{"content":"323"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }
  catalogCalls++;if(!online)throw new Error('Simulated catalog outage');return fetcher()(input,init);
 };
 async function start(){
  const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
  const blocker=pi=>pi.on('thinking_level_select',()=>gate);
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[blocker,extension]});await loader.reload();
  const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(dir)});sessions.push(session);
  await session.bindExtensions({mode:'tui',uiContext:{setStatus:(k,v)=>v===undefined?statuses.delete(k):statuses.set(k,v),setFooter:()=>{},notify:(text)=>notes.push(text)},onError:e=>errors.push(e)});return session;
 }
 const close=async s=>{await s.extensionRunner.emit({type:'session_shutdown'});s.dispose();sessions.splice(sessions.indexOf(s),1);};
 try{await run({start,close,dir,wires,statuses,notes,errors,get catalogCalls(){return catalogCalls;},offline:()=>online=false,block:()=>{gate=new Promise(resolve=>release=resolve);},unblock:()=>{release?.();gate=Promise.resolve();}});}
 finally{release?.();for(const s of sessions)await close(s);globalThis.fetch=before;if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior;await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}
test('real Pi: delayed thinking events cannot leave native parameters behind current Pi selection',async()=>environment(async x=>{
 const s=await x.start();assert.equal(x.catalogCalls,4);const preferenceKeys=[];
 for(const [provider,id] of [['free-kilo','reflection/beam-free'],['free-kilo','thinkingmachines/inkling-small:free']]){
  await s.setModel(s.modelRuntime.getModel(provider,id));await s.prompt('/free-thinking high');
  x.block();
  for(const level of (id==='reflection/beam-free'?['low','max','medium','xhigh','high']:['low','max','medium','high'])){
   s.setThinkingLevel(level);await s.prompt('17 * 19');const wire=x.wires.at(-1);
   assert.equal(provider==='free-kilo'?wire.reasoning.effort:wire.reasoning?.effort,level);
  }
  x.unblock();await new Promise(r=>setImmediate(r));
  preferenceKeys.push(JSON.stringify([provider==='free-kilo'?'kilo':'kilo',id]));
 }
 await x.close(s);const saved=JSON.parse(await readFile(join(x.dir,'free-catalog/thinking.json'),'utf8'));for(const key of preferenceKeys)assert.equal(saved[key],'auto');
 assert.equal(x.catalogCalls,4);assert.deepEqual(x.errors,[]);
}));
test('real Pi: failed startup/manual refresh leaves chat working and footer quiet',async()=>environment(async x=>{
 let s=await x.start();assert.equal(x.catalogCalls,4);await x.close(s);x.offline();
 s=await x.start();assert.equal(x.catalogCalls,8);assert.ok(x.notes.some(x=>x.includes('Chat remains available')));
 for(const [provider,id] of [['free-kilo','reflection/beam-free'],['free-kilo','thinkingmachines/inkling-small:free']]){
  await s.setModel(s.modelRuntime.getModel(provider,id));s.setThinkingLevel('low');await s.prompt('17 * 19');assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'stop');
 }
 assert.equal(x.catalogCalls,8);
 await s.prompt('/free-refresh');await new Promise(r=>setImmediate(r));assert.equal(x.catalogCalls,12);
 await s.prompt('17 * 19');assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'stop');assert.equal(x.catalogCalls,12);
 assert.match(x.statuses.get('free-catalog'),/^Free chat: Kilo \d+ · OVH \d+$/);assert.ok(![...x.statuses.values()].some(v=>/STALE|no advertised controls/.test(v)));
 assert.deepEqual(x.errors,[]);
}));
test('real Pi: controls/default-only status stays absent without hiding manual default/unmapped notices',async()=>environment(async x=>{
 const s=await x.start();const m=s.modelRuntime.getAllModels().find(m=>m.provider==='free-kilo'&&Object.values(m.thinkingLevelMap||{}).every(v=>v===null)&&m.type!=='classifier');assert.ok(m);
 await s.setModel(m);assert.equal(x.statuses.get('free-thinking'),undefined);assert.equal(x.catalogCalls,4);assert.deepEqual(x.errors,[]);
}));
