// Actual Pi loader/session/SDK and real filesystem tools; zero upstream network.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fetcher } from './helpers.mjs';
const extension=(await import(process.env.OVH_EXTENSION_UNDER_TEST?pathToFileURL(process.env.OVH_EXTENSION_UNDER_TEST).href:'../index.js')).default;
const A='gpt-oss-120b',B='gpt-oss-20b';
const config=(extra={})=>({schemaVersion:1,models:[A,B],enabled:true,maxWaitMs:2000,thinking:{[A]:'high',[B]:'low'},...extra});
const counters=(remaining,reset=38)=>({'ratelimit-limit':'2','x-ratelimit-limit-minute':'2','ratelimit-remaining':String(remaining),'x-ratelimit-remaining-minute':String(remaining),'ratelimit-reset':String(reset)});
function sse(model,delta,finish='stop',headers={}){return new Response(`data: ${JSON.stringify({id:'offline',model,choices:[{index:0,delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream',...headers}});}
const tool=(id,command)=>({role:'assistant',reasoning_content:'Expendable fixture reasoning',tool_calls:[{index:0,id,type:'function',function:{name:'bash',arguments:JSON.stringify({command})}}]});
export async function environment(run,{initial=config(),response=(n,b)=>sse(b.model,{content:'ok'}),select=async()=>undefined,confirm=async()=>false,input=async()=>undefined}={}){
 const dir=await mkdtemp(join(tmpdir(),'ovh-unified-')),oldDir=process.env.PI_CODING_AGENT_DIR,oldFetch=globalThis.fetch;
 let session,metadata=0;const wires=[],errors=[],notices=[],tools=[],statuses=new Map();
 process.env.PI_CODING_AGENT_DIR=dir;
 await mkdir(join(dir,'free-catalog'));
 if(initial)await writeFile(join(dir,'free-catalog/ovh-pool.json'),JSON.stringify(initial));
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/chat/completions')){
   const b=JSON.parse(init.body);wires.push(b);assert.equal(new Headers(init.headers).has('authorization'),false);return response(wires.length,b,init);
  }
  metadata++;return fetcher()(url,init); // rejects every nonfixture URL
 };
 try{
  const settings=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.inMemory(dir)}));
  session.subscribe(e=>{if(e.type==='tool_execution_end')tools.push(e);});
  await session.bindExtensions({mode:'tui',uiContext:{custom:async()=>undefined,setStatus:(k,v)=>v===undefined?statuses.delete(k):statuses.set(k,v),setFooter(){},notify:s=>notices.push(s),select,confirm,input},onError:e=>errors.push(e)});
  await session.setModel(session.modelRuntime.getModel('free-ovh',A));session.setThinkingLevel('low');
  await run({session,dir,wires,errors,notices,tools,statuses,get metadata(){return metadata;}});
 }finally{
  if(session){await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}
  globalThis.fetch=oldFetch;if(oldDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldDir;
  await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
}

test('real Pi: rapid A1/tool/A2/tool/B1 uses independent native modes without 31s wait or duplicate tools',async()=>{
 await environment(async x=>{
  x.session.subscribe(e=>{if(e.type==='tool_execution_end'&&x.tools.length===1)mock.timers.tick(2000);});
  const start=performance.now();await x.session.prompt('Perform the requested harmless tools once and summarize.');
  assert.deepEqual(x.wires.map(b=>b.model),[A,A,B]);
  assert.deepEqual(x.wires.map(b=>b.reasoning_effort),['high','high','low']);
  assert.equal(x.tools.length,2);for(const t of x.tools)assert.equal(t.isError,false);
  assert.equal(await readFile(join(x.dir,'first.txt'),'utf8'),'once\n');assert.equal(await readFile(join(x.dir,'second.txt'),'utf8'),'once\n');
  assert.equal(x.wires[2].messages.filter(m=>m.role==='tool').length,2);
  assert.equal(x.session.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'stop');
  assert.equal(x.session.model.id,B);assert.equal(x.session.thinkingLevel,'low');
  assert.ok(performance.now()-start<2000,'ready requests should not use the wait budget');
  assert.equal(x.metadata,4);assert.deepEqual(x.errors,[]);
  await assert.rejects(readFile(join(x.dir,'free-catalog/thinking.json')),{code:'ENOENT'});
  mock.timers.tick(39000);await x.session.prompt('Continue without running tools again.');
  assert.deepEqual(x.wires.map(b=>b.model),[A,A,B,A]);assert.equal(x.session.thinkingLevel,'high');assert.equal(x.tools.length,2);
 },{response:(n,b)=>n===1?sse(b.model,tool('first','printf "once\\n" >> first.txt; ls -la'),'tool_calls',counters(1,40)):n===2?sse(b.model,tool('second','printf "once\\n" >> second.txt; pwd'),'tool_calls',counters(0)):sse(b.model,{content:'Both tools completed once; results retained.'},'stop',counters(1))});
});

test('real Pi: all quotas exhausted returns a genuine local preflight expiry and sends no extra request',async()=>{
 await environment(async x=>{
  await x.session.prompt('first');await x.session.prompt('second');await x.session.prompt('third');
  assert.deepEqual(x.wires.map(b=>b.model),[A,B]);
  assert.match(x.session.messages.filter(m=>m.role==='assistant').at(-1).errorMessage,/local wait budget expired before HTTP/);
  assert.deepEqual(x.errors,[]);
 // Give the first two ready fixture sends CPU headroom; the third still has
 // to expire locally, with no third HTTP and no changed production timeout.
 },{initial:config({maxWaitMs:500}),response:(_n,b)=>sse(b.model,{content:'done'},'stop',counters(0))});
});

test('real Pi: a delayed native provider stream error is not mislabeled as wait expiry',async()=>{
 await environment(async x=>{
  await x.session.prompt('test delayed failure');assert.equal(x.wires.length,1);
  const last=x.session.messages.filter(m=>m.role==='assistant').at(-1);
  assert.equal(last.stopReason,'error');assert.ok(!/wait.*expired/i.test(last.errorMessage));assert.match(last.errorMessage,/ORIGINAL_STREAM_ERROR/);
 },{initial:config({maxWaitMs:20}),response:()=>new Response(new ReadableStream({start(c){setTimeout(()=>c.error(Error('ORIGINAL_STREAM_ERROR')),60);}}),{headers:{'content-type':'text/event-stream'}})});
});

test('real Pi: provider-wide limits do not rotate to another model or automatically retry',async()=>{
 await environment(async x=>{
  await x.session.prompt('one');await x.session.prompt('two');assert.equal(x.wires.length,1);assert.equal(x.session.model.id,A);
 },{initial:config({maxWaitMs:0}),response:()=>Response.json({error:{scope:'provider',type:'rate_limit_error'}},{status:429,headers:{'retry-after':'60'}})});
});

test('real Pi: unknown arguments show current usage without configuration changes',async()=>{
 await environment(async x=>{
  const file=join(x.dir,'free-catalog/ovh-pool.json'),before=await readFile(file);
  for(const action of ['unexpected','--bad-option','unknown extra'])await x.session.prompt('/free-ovh-pool '+action);
  assert.deepEqual(await readFile(file),before);assert.equal(x.wires.length,0);assert.match(x.notices.at(-1),/Use \/free-ovh-pool/);assert.doesNotMatch(x.notices.at(-1),/migration|retired/i);assert.equal(x.metadata,4);
 });
});

test('real Pi: unified editor saves native per-model thinking, wait and real primary selection without inference',async()=>{
 let main=0,think=0;
 await environment(async x=>{
  await x.session.setModel(x.session.modelRuntime.getModel('free-ovh',B));
  await x.session.prompt('/free-ovh-pool');
  const c=JSON.parse(await readFile(join(x.dir,'free-catalog/ovh-pool.json'),'utf8'));
  assert.equal(c.maxWaitMs,1500);assert.equal(c.thinking[B],'high');assert.equal(x.session.model.id,A);
  assert.equal(x.wires.length,0);assert.equal(x.metadata,4);assert.deepEqual(x.errors,[]);
 },{select:async(title,options)=>{
  if(title.startsWith('OVH pool — configuration'))return [options.find(s=>s.startsWith('Maximum wait:')),'Edit per-model thinking',options.find(s=>s.startsWith('Select primary on Apply:')),'Apply settings'][main++];
  if(title.startsWith('OVH pool — per-model thinking'))return think++===0?options.find(s=>s.startsWith(B+' —')):'Back';
  if(title.startsWith('OVH pool thinking'))return 'Native: high';
  throw Error('Unexpected menu '+title);
 },input:async()=> '1.5',confirm:async()=>true});
});


test('real Pi: oversized context skips two smaller models and uses later model with its own native off mapping',async()=>{
 const C='Qwen3.8-27B',D='Qwen3.5-397B-A17B';
 await environment(async x=>{
  await x.session.prompt('x'.repeat(140000));assert.deepEqual(x.wires.map(b=>b.model),[C]);assert.equal(x.wires[0].reasoning_effort,'none');assert.equal(x.session.model.id,C);assert.equal(x.session.thinkingLevel,'off');assert.equal(x.session.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'stop');assert.ok(JSON.stringify(x.wires[0].messages).includes('x'.repeat(140000)));assert.equal(x.metadata,4);assert.deepEqual(x.errors,[]);
 },{initial:config({models:[A,B,C,D],thinking:{[A]:'high',[B]:'low',[C]:'none',[D]:'default'}})});
});


test('real Pi: turning OFF does not erase known exhaustion or send through an empty legacy gate',async()=>{
 let stage=0;
 await environment(async x=>{
  await x.session.prompt('consume A');assert.equal(x.wires.length,1);
  await x.session.prompt('/free-ovh-pool');const c=JSON.parse(await readFile(join(x.dir,'free-catalog/ovh-pool.json'),'utf8'));assert.equal(c.enabled,false);
  let timer;try{timer=setTimeout(()=>void x.session.abort(),30);await x.session.prompt('do not bypass known quota');}finally{clearTimeout(timer);}
  assert.equal(x.wires.length,1);assert.equal(x.session.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'aborted');assert.deepEqual(x.errors,[]);
 },{response:(_n,b)=>sse(b.model,{content:'done'},'stop',counters(0)),select:async(_t,o)=>stage++===0?o.find(s=>s.startsWith('Pool:')):'Apply settings',confirm:async()=>true});
});
