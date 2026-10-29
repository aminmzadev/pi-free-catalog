import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,initTheme} from '@earendil-works/pi-coding-agent';
import extension from '../src/index.js';import {fetcher} from './helpers.mjs';

// Actual Pi AgentSession, event runner, thinking clamp and SDK serialization.
// Catalog and inference HTTP are mocked deliberately: separate live runs verify the network.
test('real Pi session: slash <-> native selector, switches, footer and off wire payload',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'free-pi-session-'));const beforeFetch=globalThis.fetch,beforeDir=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=dir;const catalogFetch=fetcher(),wires=[],errors=[],statuses=new Map();let session,footerFactory;
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/chat/completions')){
   wires.push(JSON.parse(init.body));return new Response('data: {"id":"x","choices":[{"index":0,"delta":{"content":"323"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }
  return catalogFetch(input,init);
 };
 try{
  initTheme('dark');const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});await loader.reload();
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(dir)}));
  await session.bindExtensions({mode:'tui',uiContext:{setStatus:(k,v)=>v===undefined?statuses.delete(k):statuses.set(k,v),setFooter:factory=>{footerFactory=factory;},notify:()=>{}},onError:e=>errors.push(e)});
  const model=(s,id)=>session.modelRuntime.getModel(s,id);
  const beam=model('free-kilo','thinkingmachines/inkling-small:free'),laguna=model('free-kilo','poolside/laguna-s-2.1:free');assert.ok(beam&&laguna);
  await session.setModel(beam);await session.prompt('/free-thinking max');assert.equal(session.thinkingLevel,'max');
  await session.prompt('17*19?');assert.equal(wires.at(-1).reasoning?.effort,'max');
  session.setThinkingLevel('low');await session.prompt('17*19?');assert.equal(wires.at(-1).reasoning?.effort,'low');
  await session.prompt('/free-thinking default');await session.prompt('17*19?');assert.equal(wires.at(-1).reasoning?.effort,undefined);assert.equal(statuses.get('free-thinking'),undefined);
  session.setThinkingLevel('high');await session.prompt('17*19?');assert.equal(wires.at(-1).reasoning?.effort,'high');assert.equal(statuses.get('free-thinking'),undefined);
  await session.prompt('/free-thinking max');await session.setModel(laguna);await session.prompt('/free-thinking instant');assert.equal(session.thinkingLevel,'off');await session.prompt('17*19?');assert.deepEqual(wires.at(-1).reasoning,{enabled:false,effort:'none'});
  session.setThinkingLevel('medium');await session.prompt('17*19?');assert.deepEqual(wires.at(-1).reasoning,{enabled:true,effort:'high'});
  session.setThinkingLevel('off');await session.prompt('17*19?');assert.deepEqual(wires.at(-1).reasoning,{enabled:false,effort:'none'});
  await session.setModel(beam);assert.equal(session.thinkingLevel,'max'); // restored, not erased by Pi's preliminary level event
  await session.prompt('17*19?');assert.equal(wires.at(-1).reasoning?.effort,'max');
  assert.equal(footerFactory,undefined);await session.prompt('/free-footer compact');assert.equal(typeof footerFactory,'function');
  const data={getGitBranch:()=>null,getExtensionStatuses:()=>statuses,getAvailableProviderCount:()=>4,onBranchChange:()=>()=>{}};
  const component=footerFactory({requestRender:()=>{}},null,data);assert.doesNotMatch(component.render(180)[1],/free-kilo/);assert.match(component.render(180)[1],/inkling-small/);
  await session.prompt('/free-footer default');assert.equal(footerFactory,undefined);component.dispose();await session.prompt('/free-footer compact');assert.equal(typeof footerFactory,'function');
  const saved=JSON.parse(await readFile(join(dir,'free-catalog/thinking.json'),'utf8'));assert.equal(saved[JSON.stringify(['kilo','thinkingmachines/inkling-small:free'])],'max');assert.equal(saved[JSON.stringify(['kilo',laguna.id])],'auto');
  assert.deepEqual(errors,[]);assert.equal(wires.length,8);
 }finally{if(session){await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}globalThis.fetch=beforeFetch;if(beforeDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=beforeDir;await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});
