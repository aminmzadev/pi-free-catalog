// Real installed Pi loader/session/SDK with exclusively mocked metadata and inference HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import extension from '../index.js';
import { snapshotFixture, isPages } from './snapshot-helper.mjs';
const snapshot=await snapshotFixture();
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function environment(run){
 const dir=await mkdtemp(join(tmpdir(),'pages-pi-')),prior=process.env.PI_CODING_AGENT_DIR,original=globalThis.fetch;
 const sessions=[],requests=[],wires=[],errors=[],signals=[],notes=[];let gate=null;
 process.env.PI_CODING_AGENT_DIR=dir;
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/chat/completions')){wires.push(JSON.parse(init.body));return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"content":"323"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}
  requests.push(String(url));assert.ok(isPages(url),'Healthy Pages path must never fetch direct sources');signals.push(init.signal);if(gate)await gate.promise;return Response.json(snapshot);
 };
 async function start(){
  const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(dir)});sessions.push(session);
  await session.bindExtensions({mode:'print',uiContext:{setStatus(){},notify:s=>notes.push(s)},onError:e=>errors.push(e)});return session;
 }
 async function close(s){await s.extensionRunner.emit({type:'session_shutdown'});s.dispose();sessions.splice(sessions.indexOf(s),1);}
 try{await run({start,close,requests,wires,errors,signals,notes,cache:join(dir,'free-catalog/catalog.json'),block:()=>gate=deferred()});}
 finally{gate?.resolve();for(const s of [...sessions])await close(s);globalThis.fetch=original;if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior;await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}
async function promptly(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Cached startup waited for network')),2000))]);}finally{clearTimeout(timer);}}
async function infer(s){await s.setModel(s.modelRuntime.getModel('free-kilo','thinkingmachines/inkling-small:free'));s.setThinkingLevel('off');await s.prompt('17 * 19');assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'stop');}

test('real Pi healthy Pages startup registers both providers and no retired provider using exactly one metadata GET',async()=>environment(async x=>{
 const s=await x.start();assert.equal(x.requests.length,1);const models=s.modelRuntime.getAllModels();for(const [provider,count]of[['free-kilo',17],['free-ovh',10]])assert.equal(models.filter(m=>m.provider===provider).length,count);assert.ok(!models.some(m=>m.provider==='free-zen'));
 await infer(s);await infer(s);assert.equal(x.requests.length,1);assert.equal(x.wires.length,2);await s.prompt('/free-refresh');assert.equal(x.requests.length,2);await infer(s);assert.equal(x.requests.length,2);assert.deepEqual(x.errors,[]);
}));
test('real Pi cached startup and inference work while its single startup Pages request is still pending',async()=>environment(async x=>{
 const first=await x.start();await x.close(first);const gate=x.block();const s=await promptly(x.start());assert.equal(x.requests.length,2);await infer(s);assert.equal(x.requests.length,2);assert.equal(x.wires.length,1);
 // Explicit refresh joins the pending startup operation rather than issuing a second GET.
 const manual=s.prompt('/free-refresh');await new Promise(r=>setImmediate(r));assert.equal(x.requests.length,2);gate.resolve();await manual;assert.equal(x.requests.length,2);await infer(s);assert.equal(x.requests.length,2);assert.deepEqual(x.errors,[]);
}));
test('real Pi shutdown cancels a non-cooperative startup fetch without direct fallback or disk replacement',async()=>environment(async x=>{
 const first=await x.start();await x.close(first);const bytes=await readFile(x.cache),gate=x.block();const s=await promptly(x.start());await infer(s);await promptly(x.close(s));assert.equal(x.signals.at(-1).aborted,true);assert.deepEqual(await readFile(x.cache),bytes);gate.resolve();await new Promise(r=>setImmediate(r));assert.equal(x.requests.length,2);assert.deepEqual(await readFile(x.cache),bytes);assert.deepEqual(x.errors,[]);
}));
