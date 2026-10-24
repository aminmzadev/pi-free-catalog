// Actual Pi loader/session/SDK/tools. All metadata and inference HTTP is mocked; no live service calls.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, FooterComponent, initTheme } from '@earendil-works/pi-coding-agent';
import extension from '../index.js';
import { fixtures, fetcher } from './helpers.mjs';
const A='gpt-oss-120b',B='gpt-oss-20b';
const confirmed=id=>Response.json({error:{type:'rate_limit_error',scope:'model',model:id,period:'minute',limit:2}},{status:429,headers:{'retry-after':'60'}});
function sse(id,delta,finish='stop'){return new Response(`data: ${JSON.stringify({id:'mock',model:id,choices:[{index:0,delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}
async function environment(run,{initialConfig,response=(_n,body)=>sse(body.model,{content:'ok'}),data=fixtures,select,confirm,setupSelect,setupReview,setupInput}={}){
 const dir=await mkdtemp(join(tmpdir(),'pool-pi-')),prior=process.env.PI_CODING_AGENT_DIR,original=globalThis.fetch;
 const wires=[],statuses=new Map(),errors=[],notices=[],sessions=[],executions=[];let metadata=0,editorSteps=[],editorInput;
 process.env.PI_CODING_AGENT_DIR=dir;
 if(initialConfig){const {mkdir}=await import('node:fs/promises');await mkdir(join(dir,'free-catalog'));await writeFile(join(dir,'free-catalog/ovh-pool.json'),JSON.stringify(initialConfig));}
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/chat/completions')){
   const body=JSON.parse(init.body);wires.push(body);assert.equal(new Headers(init.headers).has('authorization'),false);return response(wires.length,body,init);
  }
  metadata++;return fetcher(data)(url,init);
 };
 async function start(){
  const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(dir)});sessions.push(session);
  session.subscribe(e=>{if(e.type==='tool_execution_start')executions.push({id:e.toolCallId,name:e.toolName});});
  await session.bindExtensions({mode:'tui',uiContext:{custom:async()=>undefined,setStatus:(k,v)=>v===undefined?statuses.delete(k):statuses.set(k,v),setFooter(){},notify:s=>notices.push(s),select:async(title,options)=>{if(editorSteps.length){const step=editorSteps.shift();return typeof step==='function'?step(options):step;}return select?select(title,options):undefined;},confirm:async(title,message)=>title==='Apply OVH pool settings?'?(setupReview?setupReview(title,message):true):(confirm?confirm(title,message):false),input:async()=>editorInput??(setupInput?await setupInput():undefined)},onError:e=>errors.push(e)});
  await session.setModel(session.modelRuntime.getModel('free-ovh',A));session.setThinkingLevel('low');return session;
 }
 async function configure(s,models=[A,B]){
  editorSteps=['Edit model order',...models.map(id=>options=>options.find(x=>x.endsWith(`[${id}]`))),'Use this order','Edit per-model thinking',...models.flatMap(id=>[options=>options.find(x=>x.startsWith(id+' —')),'Follow Pi level (auto)']),'Back',options=>options.find(x=>x.startsWith('Pool:')),'Apply settings'];
  await s.prompt('/free-ovh-pool');assert.equal(editorSteps.length,0);
 }
 async function settings(s,{wait,enabled}={}){
  editorSteps=[];if(wait!==undefined){editorInput=String(wait/1000);editorSteps.push(options=>options.find(x=>x.startsWith('Maximum wait:')));}
  if(enabled!==undefined)editorSteps.push(options=>options.find(x=>x.startsWith('Pool:')));
  editorSteps.push('Apply settings');await s.prompt('/free-ovh-pool');assert.equal(editorSteps.length,0);editorInput=undefined;
 }

 try{await run({start,configure,settings,dir,wires,statuses,errors,notices,executions,get metadata(){return metadata;}});}
 finally{for(const s of sessions){await s.extensionRunner.emit({type:'session_shutdown'});s.dispose();}globalThis.fetch=original;if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior;await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}

test('real Pi: default OFF preserves original 429 and never sends a fallback request',async()=>environment(async x=>{
 const s=await x.start();await s.prompt('hello');assert.equal(x.wires.length,1);assert.equal(s.model.id,A);assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'error');await s.prompt('/free-ovh-pool status');assert.match(x.notices.at(-1),/OFF \(default\)/);assert.equal(x.metadata,8);assert.deepEqual(x.errors,[]);
},{response:(_n,body)=>confirmed(body.model)}));
test('real Pi: one confirmed rejection is not retried; handoff occurs at the NEXT inference boundary with thinking/model identity preserved',async()=>environment(async x=>{
 const s=await x.start();await x.configure(s);await s.prompt('/free-thinking high');const saved=await readFile(join(x.dir,'free-catalog/thinking.json'));
 // A target with a different saved control mode must not be silently selected.
 await s.setModel(s.modelRuntime.getModel('free-ovh',B));await s.prompt('/free-thinking high');await s.setModel(s.modelRuntime.getModel('free-ovh',A));
 await s.prompt('first request');assert.equal(x.wires.length,1);assert.equal(s.model.id,A);assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'error');
 const before=await readFile(join(x.dir,'free-catalog/thinking.json'));await s.prompt('continue without repeating actions');assert.equal(x.wires.length,2);assert.equal(x.wires[1].model,B);assert.equal(s.model.id,B);assert.equal(s.thinkingLevel,'high');assert.equal(x.wires[1].reasoning_effort,'high');assert.deepEqual(await readFile(join(x.dir,'free-catalog/thinking.json')),before);assert.ok(x.wires[1].messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('first request')));assert.equal(x.metadata,8);assert.deepEqual(x.errors,[]);
},{response:(n,body)=>n===1?confirmed(body.model):sse(body.model,{content:'continued'})}));
for(const [label,response]of[
 ['unknown-scope429',()=>Response.json({error:{type:'rate_limit_error',message:'rate limit'}},{status:429,headers:{'retry-after':'60'}})],
 ['provider-wide429',()=>Response.json({error:{type:'rate_limit_error',scope:'provider'}},{status:429,headers:{'retry-after':'60'}})],
 ['authentication',()=>Response.json({error:{type:'authentication_error'}},{status:401})],
 ['invalid-request',()=>Response.json({error:{type:'invalid_request_error'}},{status:400})],
 ['network-failure',()=>{throw Error('mock disconnected');}],
])test('real Pi: '+label+' never switches models or retries the failed request',async()=>environment(async x=>{
 const s=await x.start();await x.configure(s);await s.prompt('test');assert.equal(x.wires.length,1);assert.equal(s.model.id,A);await s.prompt('explicit next request');assert.equal(x.wires.length,['authentication','invalid-request','network-failure'].includes(label)?2:1);assert.equal(s.model.id,A);assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'error');assert.equal(x.metadata,8);assert.deepEqual(x.errors,[]);
},{response}));
test('real Pi: an opted-in exhausted pool returns a clear error without another network attempt; configuration persists',async()=>environment(async x=>{
 let s=await x.start();await x.configure(s);await s.prompt('first');await s.prompt('second');assert.deepEqual(x.wires.map(b=>b.model),[A,B]);await s.prompt('third');assert.equal(x.wires.length,2);assert.match(s.messages.filter(m=>m.role==='assistant').at(-1).errorMessage,/No permitted compatible OVH model is ready/);assert.deepEqual(JSON.parse(await readFile(join(x.dir,'free-catalog/ovh-pool.json'))).models,[A,B]);await x.settings(s,{enabled:false});assert.equal(JSON.parse(await readFile(join(x.dir,'free-catalog/ovh-pool.json'))).enabled,false);assert.equal(x.metadata,8);assert.deepEqual(x.errors,[]);
},{response:(_n,body)=>confirmed(body.model)}));
test('real Pi: bounded waiting is visible and cancellable, and cancellation sends no request',async()=>environment(async x=>{
 const s=await x.start();await x.configure(s);await s.prompt('first');await s.prompt('second');await x.settings(s,{wait:60000});let timer;try{timer=setTimeout(()=>void s.abort(),30);await s.prompt('wait for pool');}finally{clearTimeout(timer);}assert.equal(x.wires.length,2);assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'aborted');assert.equal(x.statuses.has('free-ovh-pool-wait'),false);assert.deepEqual(x.errors,[]);
},{response:(_n,body)=>confirmed(body.model)}));
test('real Pi: reasoning-bearing read/write/edit/bash results survive fallback and priority failback without duplicated side effects',async()=>{
 const calls=[
  ['read',{path:'input.txt'}],['write',{path:'output.txt',content:'alpha\n'}],['edit',{path:'output.txt',oldText:'alpha',newText:'beta'}],['bash',{command:'printf "once\\n" >> actions.txt'}],
 ];
 await environment(async x=>{
  await writeFile(join(x.dir,'input.txt'),'input evidence\n');const s=await x.start();await x.configure(s);
  // One actual assistant response requests all four tools. Pi, not the pool, executes them.
  let ended=0;s.subscribe(e=>{if(e.type==='tool_execution_end'&&++ended===4)mock.timers.tick(31000);});
  await s.prompt('Run the four requested tools and keep their results.');assert.deepEqual(x.executions.map(e=>e.name).sort(),['bash','edit','read','write']);assert.equal(x.wires.length,2);assert.equal(s.model.id,A);assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'error');
  const toolResults=s.messages.filter(m=>m.role==='toolResult');assert.equal(toolResults.length,4);for(const m of toolResults)assert.equal(m.isError,false);
  const before=JSON.stringify(toolResults);assert.equal(await readFile(join(x.dir,'output.txt'),'utf8'),'beta\n');assert.equal(await readFile(join(x.dir,'actions.txt'),'utf8'),'once\n');
  await s.prompt('Continue from the completed results; do not run any tools again.');assert.equal(s.model.id,B);assert.equal(s.thinkingLevel,'low');assert.equal(x.wires.length,3);assert.equal(x.wires[2].model,B);assert.equal(x.wires[2].reasoning_effort,'low');assert.equal(x.executions.length,4);assert.equal(JSON.stringify(s.messages.filter(m=>m.role==='toolResult')),before);assert.equal(await readFile(join(x.dir,'output.txt'),'utf8'),'beta\n');assert.equal(await readFile(join(x.dir,'actions.txt'),'utf8'),'once\n');
  const wire=x.wires[2];assert.equal(wire.messages.filter(m=>m.role==='tool').length,4);assert.deepEqual(wire.messages.filter(m=>m.role==='assistant'&&m.tool_calls).flatMap(m=>m.tool_calls).map(t=>t.function.name).sort(),['bash','edit','read','write']);assert.equal(x.metadata,8);assert.deepEqual(x.errors,[]);
  // B is healthy; only A's cooldown expires. Recovery does not switch mid-stream or on a timer.
  mock.timers.tick(60000);assert.equal(s.model.id,B);
  await s.prompt('Use the recovered primary and retain all completed tool results.');
  assert.equal(s.model.id,A);assert.equal(s.thinkingLevel,'low');assert.deepEqual(x.wires.map(b=>b.model),[A,A,B,A]);
  assert.equal(x.executions.length,4);assert.equal(JSON.stringify(s.messages.filter(m=>m.role==='toolResult')),before);
  assert.equal(x.wires[3].messages.filter(m=>m.role==='tool').length,4);
  assert.equal(await readFile(join(x.dir,'output.txt'),'utf8'),'beta\n');assert.equal(await readFile(join(x.dir,'actions.txt'),'utf8'),'once\n');
  assert.equal(x.metadata,8);assert.deepEqual(x.errors,[]);
 },{response:(n,body)=>n===1?sse(body.model,{role:'assistant',reasoning_content:'internal planning is expendable',tool_calls:calls.map(([name,args],index)=>({index,id:'call_'+name,type:'function',function:{name,arguments:JSON.stringify(args)}}))},'tool_calls'):n===2?confirmed(body.model):sse(body.model,{reasoning_content:'internal continuation is expendable',content:'All results retained; no tools rerun.'})});
});
test('real Pi: partial stream failures never switch mid-stream or retry against another pool model',async()=>{
 let controller;
 await environment(async x=>{
  const s=await x.start();await x.configure(s);let partial=false;
  s.subscribe(e=>{if(e.type==='message_update'&&e.assistantMessageEvent?.type==='text_delta'){partial=true;controller.error(Error('mock partial stream disconnected'));}});
  await s.prompt('test partial stream');assert.ok(partial);assert.equal(x.wires.length,1);assert.equal(s.model.id,A);assert.equal(s.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'error');await s.prompt('explicit later request');assert.equal(x.wires.length,2);assert.equal(s.model.id,A);assert.deepEqual(x.errors,[]);
 },{response:(_n,body)=>new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:'partial',model:body.model,choices:[{index:0,delta:{content:'partial'},finish_reason:null}]})}\n\n`));}}),{headers:{'content-type':'text/event-stream'}})});
});

test('real Pi: primary recovery during a healthy fallback stream waits for the NEXT inference boundary',async()=>{
 let controller;
 await environment(async x=>{
  const s=await x.start();await x.configure(s);await s.prompt('primary request');assert.equal(x.wires.length,1);
  let advanced=false;s.subscribe(event=>{
   if(!advanced&&event.type==='message_update'&&event.assistantMessageEvent?.type==='text_delta'&&s.model.id===B){
    advanced=true;mock.timers.tick(60000);assert.equal(s.model.id,B);assert.equal(x.wires.length,2);
    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();
   }
  });
  await s.prompt('healthy fallback stream');assert.ok(advanced);assert.equal(s.model.id,B);assert.equal(x.wires.length,2);
  await s.prompt('next request must use primary');assert.deepEqual(x.wires.map(b=>b.model),[A,B,A]);assert.equal(s.model.id,A);assert.equal(s.thinkingLevel,'low');assert.equal(x.metadata,8);assert.deepEqual(x.errors,[]);
 },{response:(n,body)=>n===1?confirmed(body.model):n===2?new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:'healthy',model:B,choices:[{index:0,delta:{content:'healthy fallback'},finish_reason:'stop'}]})}\n\n`));}}),{headers:{'content-type':'text/event-stream'}}):sse(body.model,{content:'primary restored'})});
});
test('real Pi: recovery during bash execution fails back only for the following inference, with exactly one side effect',async()=>{
 await environment(async x=>{
  const s=await x.start();await x.configure(s);await s.prompt('first primary request');assert.equal(x.wires.length,1);
  let toolStarted=false,toolEnded=false;
  s.subscribe(event=>{
   if(event.type==='tool_execution_start'){
    toolStarted=true;assert.equal(s.model.id,B);mock.timers.tick(60000);assert.equal(s.model.id,B);assert.equal(x.wires.length,2);
   }
   if(event.type==='tool_execution_end'){toolEnded=true;assert.equal(s.model.id,B);assert.equal(x.wires.length,2);}
  });
  await s.prompt('perform bash once then use its result');assert.ok(toolStarted&&toolEnded);
  assert.deepEqual(x.wires.map(b=>b.model),[A,B,A]);assert.equal(s.model.id,A);assert.equal(s.thinkingLevel,'low');
  assert.deepEqual(x.executions.map(e=>e.name),['bash']);assert.equal(await readFile(join(x.dir,'failback-once.txt'),'utf8'),'once\n');
  assert.equal(x.wires[2].messages.filter(m=>m.role==='tool').length,1);assert.ok(JSON.stringify(x.wires[2].messages).includes('perform bash once'));
  assert.equal(x.metadata,8);assert.deepEqual(x.errors,[]);
 },{response:(n,body)=>n===1?confirmed(body.model):n===2?sse(body.model,{reasoning_content:'expendable internal plan',tool_calls:[{index:0,id:'call_failback_once',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'printf "once\\n" >> failback-once.txt'})}}]},'tool_calls'):sse(body.model,{content:'completed once; primary restored'})});
});

test('real Pi: captured OVH headers trigger one subsequent fallback and restore recovered priority without changing native settings',async()=>{
 await environment(async x=>{
  const s=await x.start();await x.configure(s);await s.prompt('first request');assert.equal(x.wires.length,1);assert.equal(s.model.id,A);
  await s.prompt('new request after observed quota');assert.deepEqual(x.wires.map(b=>b.model),[A,B]);assert.equal(s.model.id,B);assert.equal(s.thinkingLevel,'low');
  mock.timers.tick(31000);assert.equal(s.model.id,B);await s.prompt('next request after recovery');assert.deepEqual(x.wires.map(b=>b.model),[A,B,A]);assert.equal(s.model.id,A);assert.equal(s.thinkingLevel,'low');assert.equal(x.metadata,8);assert.deepEqual(x.errors,[]);
 },{response:(n,body)=>{
  if(n!==1)return sse(body.model,{content:'ok'});
  const request_id='968bc57595ae7a6d59e2751cad03d322';const r=Response.json({message:'API rate limit exceeded',request_id},{status:429,headers:{'retry-after':'24','ratelimit-limit':'2','ratelimit-remaining':'0','ratelimit-reset':'24','x-ratelimit-limit-minute':'2','x-ratelimit-remaining-minute':'0','inference-id':request_id}});
  Object.defineProperty(r,'url',{value:'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions'});return r;
 }});
});


