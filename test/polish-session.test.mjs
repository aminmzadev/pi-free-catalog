// Actual Pi sessions, SDK parsing and filesystem tools. Every HTTP response is a local fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import extension from '../index.js';
import { ACTIVITY_TYPE, OWNED_STATUS_KEYS, recentActivity } from '../src/pool-activity.js';
import { fixtures, fetcher } from './helpers.mjs';
const A='gpt-oss-120b',B='gpt-oss-20b';
const counters=n=>({'ratelimit-limit':'2','x-ratelimit-limit-minute':'2','ratelimit-remaining':String(n),'x-ratelimit-remaining-minute':String(n),'ratelimit-reset':'40'});
const chunk=(id,delta,finish='stop')=>`data: ${JSON.stringify({id:'offline',model:id,choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
const sse=(id,delta,finish='stop',headers={})=>new Response(chunk(id,delta,finish)+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream',...headers}});
async function environment(run,{timeout=80,enabled=true,ui}={}) {
 const dir=await mkdtemp(join(tmpdir(),'polish-pi-')),oldDir=process.env.PI_CODING_AGENT_DIR,oldFetch=globalThis.fetch;
 const menu=[],inputs=[];let approve=false;
 const footerCalls=[]; const resizeListeners=process.stdout.listenerCount('resize');
 const wires=[],statuses=new Map([['foreign-extension','keep me']]),errors=[],notices=[],events=[];
 let session,metadata=0,response=(_n,b)=>sse(b.model,{content:'done'},'stop',counters(1));
 process.env.PI_CODING_AGENT_DIR=dir;await mkdir(join(dir,'free-catalog'));
 await writeFile(join(dir,'free-catalog/ovh-pool.json'),JSON.stringify({schemaVersion:1,enabled,models:[A,B],thinking:{[A]:'high',[B]:'low'},maxWaitMs:0,responseStartTimeoutMs:timeout}));
 if(ui!==undefined)await writeFile(join(dir,'free-catalog/ui.json'),JSON.stringify(ui));
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/chat/completions')){const b=JSON.parse(init.body);wires.push(b);return response(wires.length,b,init);}
  metadata++;return fetcher()(url,init);
 };
 async function start() {
  initTheme('dark');const settings=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.create(dir,join(dir,'sessions'))}));
  session.subscribe(e=>events.push(e));
  await session.bindExtensions({mode:'tui',uiContext:{setStatus:(k,v)=>v===undefined?statuses.delete(k):statuses.set(k,v),setFooter:factory=>footerCalls.push(factory),notify:s=>notices.push(s),select:async(_t,options)=>{const choice=menu.shift();return typeof choice==='function'?choice(options):choice;},confirm:async()=>false,input:async()=>inputs.shift(),custom:async(factory)=>{
   let value;const component=factory({terminal:{rows:12},requestRender(){}},{fg:(_k,s)=>s},{},v=>value=v);
   for(const w of [24,32,40,80])for(const line of component.render(w))assert.ok(visibleWidth(line)<=w);
   component.handleInput(approve?'\r':'\x1b');return value;
  }},onError:e=>errors.push(e)});
  await session.setModel(session.modelRuntime.getModel('free-ovh',A));
 }
 try {
  await start();
  await run({get session(){return session;},restart:async()=>{await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();await start();},dir,wires,statuses,errors,notices,events,menu,inputs,footerCalls,setApprove:v=>approve=v,setResponse:fn=>response=fn,get metadata(){return metadata;}});
 } finally {
  if(session){await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}
  assert.equal(process.stdout.listenerCount('resize'),resizeListeners);
  globalThis.fetch=oldFetch;if(oldDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldDir;
  await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
}
function assertClean(x,shutdown=false) {if(shutdown)assert.equal(x.statuses.get('free-catalog'),undefined);else assert.match(x.statuses.get('free-catalog'), /^Free chat: Kilo \d+ · Zen \d+ · OVH \d+$/);assert.deepEqual([...x.statuses].filter(([key])=>key!=='free-catalog'),[['foreign-extension','keep me']]);assert.deepEqual(x.errors,[]);}

test('real Pi: silent HTTP start advances once, buffers source start, persists diagnostics outside LLM context and resumes them',async()=>environment(async x=>{
 let signal;
 x.setResponse((n,b,init)=>{if(n===1){signal=init.signal;assert.ok(x.statuses.has('free-ovh-activity'));return new Promise(()=>{});}return sse(b.model,{content:'finished on fallback'},'stop',counters(1));});
 await x.session.prompt('Keep the conversation intact.');assert.deepEqual(x.wires.map(b=>b.model),[A,B]);assert.ok(signal.aborted);
 assert.equal(x.session.model.id,B);assert.deepEqual(x.wires.map(b=>b.reasoning_effort),['high','low']);
 assert.equal(x.events.filter(e=>e.type==='message_start'&&e.message.role==='assistant').length,1);
 let branch=x.session.sessionManager.getBranch();const records=branch.filter(e=>e.type==='custom'&&e.customType===ACTIVITY_TYPE);assert.equal(records.length,1);assert.deepEqual(records[0].data.steps.map(s=>s.state),['timed-out','responded']);
 const renderer=x.session.extensionRunner.getEntryRenderer(ACTIVITY_TYPE);assert.equal(typeof renderer,'function');
 for(const width of [24,32,40,80])for(const line of renderer(records[0],{expanded:true},{fg:(_k,s)=>s}).render(width))assert.ok(visibleWidth(line)<=width);
 // Status mounts a real component factory, returns Escape, performs neither metadata nor inference.
 const wireCount=x.wires.length,metadata=x.metadata;await x.session.prompt('/free-ovh-pool status');assert.equal(x.wires.length,wireCount);assert.equal(x.metadata,metadata);
 await x.session.prompt('Continue without any repeated actions.');assert.equal(x.wires[2].model,A);
 assert.doesNotMatch(JSON.stringify(x.wires[2].messages),/free-ovh-pool-activity|timed-out|OVH pool:/);
 assert.equal(x.events.filter(e=>e.type==='tool_execution_start').length,0);assertClean(x);
 const path=x.session.sessionManager.getSessionFile();assert.ok(path);const resumed=SessionManager.open(path);assert.equal(recentActivity({sessionManager:resumed}).length,2);
 assert.equal(x.metadata,8);
}));
test('real SDK: HTTP 200 headers, role-only SSE and keepalives do not count; late source output never reaches Pi',async()=>environment(async x=>{
 let late,cancelled=false;
 x.setResponse((n,b)=>n===1?new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': keepalive\n\n'+chunk(b.model,{role:'assistant'},null)));late=()=>{try{c.enqueue(new TextEncoder().encode(chunk(b.model,{content:'FORBIDDEN_LATE_SOURCE'})+'data: [DONE]\n\n'));c.close();}catch(e){assert.equal(e.code,'ERR_INVALID_STATE');}};},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream',...counters(0)}}):sse(b.model,{content:'B only'}));
 await x.session.prompt('test');assert.deepEqual(x.wires.map(b=>b.model),[A,B]);late();await delay(20);assert.ok(cancelled);
 assert.doesNotMatch(JSON.stringify(x.session.messages),/FORBIDDEN_LATE_SOURCE/);assert.equal(x.session.messages.filter(m=>m.role==='assistant').length,1);assertClean(x);
}));
for(const variant of ['thinking','text','tool'])test('real SDK: '+variant+' activity prevents timeout despite a later long silence',async()=>environment(async x=>{
 x.setResponse((n,b)=>{
  if(n>1)return sse(b.model,{content:'tool complete'});
  const delta=variant==='thinking'?{reasoning_content:'working'}:variant==='text'?{content:'working'}:{tool_calls:[{index:0,id:'once',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'printf once > tool.txt'})}}]};
  return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(chunk(b.model,delta,null)));setTimeout(()=>{c.enqueue(new TextEncoder().encode(chunk(b.model,{},variant==='tool'?'tool_calls':'stop')+'data: [DONE]\n\n'));c.close();},150);}}),{headers:{'content-type':'text/event-stream',...counters(1)}});
 });
 await x.session.prompt('test');assert.ok(x.wires.every(w=>w.model===A));assert.equal(x.session.model.id,A);
 if(variant==='tool'){assert.equal(x.events.filter(e=>e.type==='tool_execution_end').length,1);assert.equal(await readFile(join(x.dir,'tool.txt'),'utf8'),'once');}
 assert.equal(x.session.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'stop');assertClean(x);
}));
test('real Pi: completed read/write/edit/bash effects survive silent next inference and execute exactly once',async()=>environment(async x=>{
 await writeFile(join(x.dir,'input.txt'),'input evidence\n');
 const calls=[['read',{path:'input.txt'}],['write',{path:'output.txt',content:'alpha\n'}],['edit',{path:'output.txt',oldText:'alpha',newText:'beta'}],['bash',{command:'printf "once\\n" >> actions.txt'}]];
 x.setResponse((n,b)=>{
  if(n===1)return sse(b.model,{reasoning_content:'Fixture plan',tool_calls:calls.map(([name,args],index)=>({index,id:'completed_'+index,type:'function',function:{name,arguments:JSON.stringify(args)}}))},'tool_calls',counters(1));
  if(n===2)return new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/event-stream',...counters(0)}});
  return sse(b.model,{content:'All four completed results retained.'},'stop',counters(1));
 });
 await x.session.prompt('Perform these four tools once, preserving their results.');assert.deepEqual(x.wires.map(b=>b.model),[A,A,B]);
 assert.equal(x.events.filter(e=>e.type==='tool_execution_end').length,4);assert.equal(await readFile(join(x.dir,'actions.txt'),'utf8'),'once\n');assert.equal(await readFile(join(x.dir,'output.txt'),'utf8'),'beta\n');
 assert.equal(x.wires[2].messages.filter(m=>m.role==='tool').length,4);assert.equal(x.session.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'stop');assertClean(x);
}));
for(const status of [401,403,429,503])test('real SDK: known HTTP '+status+' with delayed error body never rotates',async()=>environment(async x=>{
 x.setResponse(()=>new Response(new ReadableStream({start(c){setTimeout(()=>{c.enqueue(new TextEncoder().encode(JSON.stringify({error:{message:'GENUINE_'+status,scope:status===429?'provider':undefined}})));c.close();},150);}}),{status,headers:{'content-type':'application/json','retry-after':'60'}}));
 await x.session.prompt('test');assert.equal(x.wires.length,1);assert.equal(x.session.model.id,A);assert.equal(x.session.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'error');assertClean(x);
}));
test('real Pi: aborting a silent request cancels the whole chain and cleans UI without touching foreign status',async()=>environment(async x=>{
 x.setResponse(()=>{queueMicrotask(()=>void x.session.abort());return new Promise(()=>{});});await x.session.prompt('test');assert.equal(x.wires.length,1);assert.equal(x.session.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'aborted');assertClean(x);
}));
test('actual Pi extension events clear only owned state across lifecycle boundaries and provider changes',async()=>environment(async x=>{
 for(const type of ['agent_end','agent_settled','turn_end','session_before_switch','session_before_fork','session_before_tree','session_tree','session_compact','session_compact_failed']){
  for(const key of OWNED_STATUS_KEYS)x.statuses.set(key,'stale');await x.session.extensionRunner.emit({type});assertClean(x);
 }
 for(const key of OWNED_STATUS_KEYS)x.statuses.set(key,'stale');await x.session.setModel(x.session.modelRuntime.getModel('free-kilo','reflection/beam-free'));assertClean(x);
 for(const key of OWNED_STATUS_KEYS)x.statuses.set(key,'stale');await x.session.extensionRunner.emit({type:'session_shutdown'});assertClean(x,true);
 assert.equal(x.wires.length,0);
}));

for(const stage of ['fetch','body'])test('real SDK: '+stage+' network failure before the deadline keeps its original error and does not rotate',async()=>environment(async x=>{
 x.setResponse(()=>stage==='fetch'?new Promise((_r,reject)=>setTimeout(()=>reject(Error('ORIGINAL_NETWORK_FAILURE')),20)):new Response(new ReadableStream({start(c){setTimeout(()=>c.error(Error('ORIGINAL_NETWORK_FAILURE')),20);}}),{headers:{'content-type':'text/event-stream'}}));
 await x.session.prompt('test');assert.equal(x.wires.length,1);assert.equal(x.session.model.id,A);assert.equal(x.session.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'error');assertClean(x);
}));

test('real Pi editor explicitly saves response-start seconds independently and disabling clears owned UI',async()=>environment(async x=>{
 x.setApprove(true);x.menu.push(o=>o.find(v=>v.startsWith('Response-start limit:')),'Apply settings');x.inputs.push('60');
 await x.session.prompt('/free-ovh-pool');let saved=JSON.parse(await readFile(join(x.dir,'free-catalog/ovh-pool.json')));assert.equal(saved.responseStartTimeoutMs,60000);assert.equal(saved.maxWaitMs,0);
 for(const key of OWNED_STATUS_KEYS)x.statuses.set(key,'stale');
 x.menu.push(o=>o.find(v=>v.startsWith('Pool:')),'Apply settings');await x.session.prompt('/free-ovh-pool');saved=JSON.parse(await readFile(join(x.dir,'free-catalog/ovh-pool.json')));
 assert.equal(saved.enabled,false);assert.equal(saved.responseStartTimeoutMs,60000);assert.equal(x.wires.length,0);assert.equal(x.metadata,8);assertClean(x);
}));
test('real Pi: timed-out attempt retains received exhausted-quota evidence even after disabling the pool',async()=>environment(async x=>{
 x.setResponse((n,b)=>n===1?new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/event-stream',...counters(0)}}):sse(b.model,{content:'B finished'},'stop',counters(1)));
 await x.session.prompt('test');assert.deepEqual(x.wires.map(w=>w.model),[A,B]);
 x.setApprove(true);x.menu.push(o=>o.find(v=>v.startsWith('Pool:')),'Apply settings');await x.session.prompt('/free-ovh-pool');
 await x.session.setModel(x.session.modelRuntime.getModel('free-ovh',A));const timer=setTimeout(()=>void x.session.abort(),25);
 try{await x.session.prompt('must not bypass the spent A quota');}finally{clearTimeout(timer);}
 assert.equal(x.wires.length,2);assert.equal(x.session.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'aborted');assertClean(x);
}));


test('real Pi: independent counts menu/commands are immediate, saved, restored, and never claim a foreign footer',async()=>environment(async x=>{
 const s=x.session,model=s.model,thinking=s.thinkingLevel,poolFile=join(x.dir,'free-catalog/ovh-pool.json');
 const originalPool=await readFile(poolFile,'utf8'),metadata=x.metadata,messages=structuredClone(s.messages);
 assert.equal(x.statuses.get('free-catalog'),'Free chat: Kilo 17 · Zen 9 · OVH 10');
 await s.prompt('/free-footer counts off');assert.equal(x.statuses.has('free-catalog'),false);assert.equal(x.footerCalls.length,0);
 assert.deepEqual(JSON.parse(await readFile(join(x.dir,'free-catalog/ui.json'))),{footer:'default',chatCounts:false});
 x.menu.push(o=>o[0],undefined);await s.prompt('/free-footer');assert.equal(x.statuses.get('free-catalog'),'Free chat: Kilo 17 · Zen 9 · OVH 10');
 x.menu.push(undefined);await s.prompt('/free-footer');assert.equal(x.footerCalls.length,0);
 await s.prompt('/free-footer compact');const claimed=x.footerCalls.length;assert.equal(claimed,1);
 await s.prompt('/free-footer counts off');assert.equal(x.footerCalls.length,claimed);
 await s.prompt('/free-footer --help');assert.equal(x.statuses.has('free-catalog'),false);
 await s.prompt('/free-footer counts maybe');assert.equal(x.statuses.has('free-catalog'),false);
 assert.deepEqual(JSON.parse(await readFile(join(x.dir,'free-catalog/ui.json'))),{footer:'compact',chatCounts:false});
 assert.equal(s.model,model);assert.equal(s.thinkingLevel,thinking);assert.deepEqual(s.messages,messages);
 assert.equal(await readFile(poolFile,'utf8'),originalPool);assert.equal(x.metadata,metadata);assert.equal(x.wires.length,0);
 await x.restart();assert.equal(x.statuses.has('free-catalog'),false);
 await x.session.prompt('/free-footer counts on');assert.equal(x.statuses.get('free-catalog'),'Free chat: Kilo 17 · Zen 9 · OVH 10');
 assert.deepEqual(x.errors,[]);
},{timeout:0}));

test('real Pi: display writes fail visibly without rollback, recover, and restart from the last successful save',async()=>environment(async x=>{
 const path=join(x.dir,'free-catalog/ui.json');await mkdir(path);
 await x.session.prompt('/free-footer counts off');assert.equal(x.statuses.has('free-catalog'),false);
 assert.match(x.notices.at(-1),/Not saved:/);assert.equal(x.wires.length,0);
 await rm(path,{recursive:true});await x.restart();
 assert.equal(x.statuses.get('free-catalog'),'Free chat: Kilo 17 · Zen 9 · OVH 10');
 await x.session.prompt('/free-footer counts off');assert.equal(x.statuses.has('free-catalog'),false);
 assert.deepEqual(JSON.parse(await readFile(path)),{footer:'default',chatCounts:false});
 await x.restart();assert.equal(x.statuses.has('free-catalog'),false);assert.deepEqual(x.errors,[]);
},{timeout:0}));

test('real Pi: rapid independent display commands keep the newest combined preference and pool/thinking intact',async()=>environment(async x=>{
 const file=join(x.dir,'free-catalog/ovh-pool.json'),before=await readFile(file,'utf8'),metadata=x.metadata,thinking=x.session.thinkingLevel;
 await Promise.all(['counts off','compact','counts on','default','counts off','compact'].map(arg=>x.session.prompt('/free-footer '+arg)));
 assert.deepEqual(JSON.parse(await readFile(join(x.dir,'free-catalog/ui.json'))),{footer:'compact',chatCounts:false});
 assert.equal(x.statuses.has('free-catalog'),false);assert.equal(await readFile(file,'utf8'),before);
 assert.equal(x.metadata,metadata);assert.equal(x.wires.length,0);assert.equal(x.session.thinkingLevel,thinking);assert.deepEqual(x.errors,[]);
},{timeout:0}));

test('real Pi: toggles during an owned pending response neither dispatch nor hand off nor alter the transcript',async()=>environment(async x=>{
 let release,started;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r);
 x.setResponse((_n,b)=>{started();return gate.then(()=>sse(b.model,{content:'finished'},'stop',counters(1)));});
 const turn=x.session.prompt('Offline pending response fixture');
 try {
  await began;const model=x.session.model,thinking=x.session.thinkingLevel,messages=structuredClone(x.session.messages),metadata=x.metadata;
  const pool=await readFile(join(x.dir,'free-catalog/ovh-pool.json'),'utf8');
  for(const arg of ['counts off','counts on','counts off'])await x.session.prompt('/free-footer '+arg);
  assert.equal(x.wires.length,1);assert.equal(x.session.model,model);assert.equal(x.session.thinkingLevel,thinking);
  assert.deepEqual(x.session.messages,messages);assert.equal(x.metadata,metadata);
  assert.equal(await readFile(join(x.dir,'free-catalog/ovh-pool.json'),'utf8'),pool);
 } finally {release();await turn;}
 assert.equal(x.wires.length,1);assert.equal(x.statuses.has('free-catalog'),false);
 assert.deepEqual([...x.statuses],[['foreign-extension','keep me']]);
 await x.session.prompt('/free-footer counts on');assertClean(x);
},{timeout:0}));

for(const [label,ui,expected] of [['legacy compact',{footer:'compact'},true],['invalid mode independent false',{footer:'broken',chatCounts:false},false],['invalid boolean',{footer:'default',chatCounts:'false'},true]])
 test('real Pi preferences: '+label,async()=>environment(async x=>{assert.equal(x.statuses.has('free-catalog'),expected);assert.equal(x.wires.length,0);assert.deepEqual(x.errors,[]);},{timeout:0,ui}));
