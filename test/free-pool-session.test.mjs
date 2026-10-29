// Real Pi loader/session/SDK, with only local HTTP fixtures. No live inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,initTheme } from '@earendil-works/pi-coding-agent';
import extension from '../index.js';
import { freePoolDefaults,validateFreePool,rotationDefaults,parsePoolKey } from '../src/free-pool.js';
import { K,K2,A,B } from './free-pool-helper.mjs';
import { fetcher,fixtures } from './helpers.mjs';
const sse=(model,delta={content:'done'},finish='stop',headers={})=>new Response(`data: ${JSON.stringify({id:'offline',model,choices:[{index:0,delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream',...headers}});
async function environment(run,{models=[K,K2],weights={},cycles=0,responseStartTimeoutMs=0,response=(_n,b)=>sse(b.model),thinking={},mutateFixture,initiallyLegacy=false,legacyGeneral=false,select=async()=>undefined,confirm=async()=>false,custom=async()=>false}={}){
 const dir=await mkdtemp(join(tmpdir(),'general-session-')),oldDir=process.env.PI_CODING_AGENT_DIR,oldFetch=globalThis.fetch,resize=process.stdout.listenerCount('resize');
 const statuses=new Map([['foreign','keep me']]),wires=[],errors=[],notices=[],events=[];let metadata=0,session;
 const config=validateFreePool({...freePoolDefaults(),enabled:true,models,weights,cycles,scheduling:'round-robin',responseStartTimeoutMs,thinking});
 await mkdir(join(dir,'free-catalog'));
 if(initiallyLegacy)await writeFile(join(dir,'free-catalog/ovh-pool.json'),JSON.stringify({schemaVersion:1,enabled:false,models:['gpt-oss-120b','gpt-oss-20b'],thinking:{},maxWaitMs:0}));
 else await writeFile(join(dir,'free-catalog/free-pool.json'),JSON.stringify({schemaVersion:2,...(legacyGeneral?{}:{policyVersion:3,modelBarriers:{}}),config,rotation:rotationDefaults(),barriers:{},ovhCooldowns:{models:{},providerUntil:0},ovhReservations:{},approvedProviders:[...new Set(models.map(k=>parsePoolKey(k).service))].sort()}));
 process.env.PI_CODING_AGENT_DIR=dir;
 const data=structuredClone(fixtures);mutateFixture?.(data);const metadataFetch=fetcher(data);
 globalThis.fetch=async(input,init)=>{
  if((init?.method??'GET').toUpperCase()==='POST'){
   const b=JSON.parse(init.body);wires.push({body:b,url:String(input),headers:new Headers(init.headers)});return response(wires.length,b,init,String(input));
  }
  metadata++;return metadataFetch(input,init);
 };
 async function start(){
  initTheme('dark');const settings=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.inMemory(dir)}));
  session.subscribe(e=>events.push(e));
  await session.bindExtensions({mode:'tui',uiContext:{setStatus:(k,v)=>v===undefined?statuses.delete(k):statuses.set(k,v),setFooter(){},custom,notify:text=>notices.push(text),select,confirm,input:async()=>undefined},onError:e=>errors.push(e)});
  const first=parsePoolKey(models[0]);await session.setModel(session.modelRuntime.getModel(first.provider,first.id));
 }
 try{
  await start();await run({get session(){return session;},dir,wires,statuses,errors,notices,events,get metadata(){return metadata;},restart:async()=>{await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();await start();}});
 }finally{
  if(session){await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}
  globalThis.fetch=oldFetch;if(oldDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldDir;
  assert.equal(process.stdout.listenerCount('resize'),resize);await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
}

test('actual Pi Kilo siblings only round robin rotates providers, preserves exact routes/anonymous identity, and performs no prompt metadata fetch',()=>environment(async x=>{
 const count=x.metadata;
 for(let i=0;i<4;i++)await x.session.prompt('Offline fixture only');
 assert.deepEqual(x.wires.map(w=>w.body.model),['reflection/beam-free','thinkingmachines/inkling-small:free','reflection/beam-free','thinkingmachines/inkling-small:free']);
 assert.deepEqual(x.wires.map(w=>new URL(w.url).host),['api.kilo.ai','api.kilo.ai','api.kilo.ai','api.kilo.ai']);
 assert.equal(x.wires[0].headers.get('x-kilo-free'),'true');assert.equal(x.wires[0].headers.has('authorization'),false);assert.equal(x.wires[1].headers.has('authorization'),false);assert.equal(x.wires[1].headers.get('x-kilo-free'),'true');
 assert.equal(x.metadata,count);assert.deepEqual(x.errors,[]);assert.equal(x.statuses.get('foreign'),'keep me');assert.match(x.statuses.get('free-catalog'),/^Free chat:/);
 assert.equal(x.session.messages.filter(m=>m.role==='assistant').length,4);
}));
test('actual Pi mixed 3/4/1 sequence keeps per-model native thinking, finite cycles pause and restart does not refill allowance',()=>environment(async x=>{
 for(let i=0;i<8;i++)await x.session.prompt('Offline fixture only');
 assert.deepEqual(x.wires.map(w=>w.body.model),['reflection/beam-free','reflection/beam-free','reflection/beam-free','thinkingmachines/inkling-small:free','thinkingmachines/inkling-small:free','thinkingmachines/inkling-small:free','thinkingmachines/inkling-small:free','gpt-oss-120b']);
 assert.equal(x.wires[0].body.reasoning.effort,'high');assert.equal(x.wires[3].body.reasoning.effort,'low');assert.equal(x.wires[7].body.reasoning_effort,'high');assert.equal(x.wires[7].headers.has('authorization'),false);
 await x.session.prompt('Must pause');assert.equal(x.wires.length,8);assert.match(x.session.messages.at(-1).errorMessage,/paused/);
 await x.restart();await x.session.prompt('Still paused');assert.equal(x.wires.length,8);assert.match(x.session.messages.at(-1).errorMessage,/paused/);assert.deepEqual(x.errors,[]);
},{models:[K,K2,A],weights:{[K]:3,[K2]:4,[A]:1},cycles:1,thinking:{[K]:'high',[K2]:'low',[A]:'high'}}));
test('actual Pi completed tool runs exactly once, with its result handed across provider boundaries',()=>environment(async x=>{
 await x.session.prompt('Execute one harmless fixture tool, then summarize.');
 assert.deepEqual(x.wires.map(w=>w.body.model),['reflection/beam-free','thinkingmachines/inkling-small:free']);
 assert.equal(x.events.filter(e=>e.type==='tool_execution_start').length,1);
 assert.equal(await readFile(join(x.dir,'one.txt'),'utf8'),'once\n');
 assert.equal(x.wires[1].body.messages.filter(m=>m.role==='tool').length,1);assert.deepEqual(x.errors,[]);
},{response:(n,b)=>n===1?sse(b.model,{role:'assistant',tool_calls:[{index:0,id:'once',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'printf "once\\n" >> one.txt'})}}]},'tool_calls'):sse(b.model)}));
for(const status of [401,403,503])test('actual Pi HTTP '+status+' never replays a rejected response through another provider',()=>environment(async x=>{
 await x.session.prompt('Offline error');assert.equal(x.wires.length,1);assert.equal(x.session.messages.at(-1).stopReason,'error');assert.deepEqual(x.errors,[]);
},{response:()=>new Response(JSON.stringify({error:{message:'Fixture rejection'}}),{status,headers:{'content-type':'application/json','retry-after':'1'}})}));
test('actual Pi silent owned deadline can advance across providers once, discards late source and spends both reservations',()=>environment(async x=>{
 await x.session.prompt('Offline timeout fixture');assert.deepEqual(x.wires.map(w=>w.body.model),['reflection/beam-free','thinkingmachines/inkling-small:free']);assert.equal(x.session.messages.at(-1).stopReason,'stop');
 assert.equal(x.session.messages.filter(m=>m.role==='assistant').length,1);const saved=JSON.parse(await readFile(join(x.dir,'free-catalog/free-pool.json')));assert.equal(saved.rotation.completed,1);assert.deepEqual(x.errors,[]);
},{responseStartTimeoutMs:100,response:(n,b)=>n===1?new Promise(()=>{}):sse(b.model)}));
test('actual Pi pending response abort cancels the chain, clears transient UI and preserves catalog/foreign statuses',async()=>{
 let started;const began=new Promise(resolve=>started=resolve);
 await environment(async x=>{
  const pending=x.session.prompt('Offline abort');await began;await x.session.abort();await pending;
  assert.equal(x.wires.length,1);assert.equal(x.session.messages.at(-1).stopReason,'aborted');assert.equal(x.statuses.has('free-ovh-activity'),false);assert.match(x.statuses.get('free-catalog'),/^Free chat:/);assert.equal(x.statuses.get('foreign'),'keep me');
 },{response:()=>{started();return new Promise(()=>{});}});
});
test('actual Pi status/preview/help/footer and cancelled edit do not dispatch, refresh or consume the rotation',()=>environment(async x=>{
 const file=join(x.dir,'free-catalog/free-pool.json'),before=await readFile(file,'utf8'),metadata=x.metadata;
 for(const cmd of ['/free-pool status','/free-pool preview','/free-pool --help','/free-pool','/free-ovh-pool','/free-footer counts off','/free-footer counts on'])await x.session.prompt(cmd);
 assert.equal(await readFile(file,'utf8'),before);assert.equal(x.wires.length,0);assert.equal(x.metadata,metadata);assert.deepEqual(x.errors,[]);
}));

function eventsResponse(events){return new Response(events.map(([type,data])=>`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});}
function responsesFixture(model){
 const item={type:'message',id:'msg_fixture',role:'assistant',content:[{type:'output_text',text:'done',annotations:[]}],status:'completed'};
 const response={id:'resp_fixture',object:'response',created_at:1,status:'completed',model,output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
 return eventsResponse([
  ['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],
  ['response.output_item.added',{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}}],
  ['response.content_part.added',{type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}}],
  ['response.output_text.delta',{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'done'}],
  ['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],
  ['response.completed',{type:'response.completed',response}],
 ]);
}
for(const api of ['openai-responses'])test('native SDK declared '+api+' falls back to completions without rewriting model IDs or replaying history',()=>environment(async x=>{
 await x.session.prompt('Offline protocol fixture');assert.equal(x.wires.length,1,JSON.stringify(x.session.messages.at(-1)));assert.equal(x.session.messages.at(-1).stopReason,'stop',JSON.stringify(x.session.messages.at(-1)));
 await x.session.prompt('Offline second turn');assert.equal(x.wires.length,2);assert.equal(x.wires[1].body.model,'thinkingmachines/inkling-small:free',JSON.stringify({last:x.session.messages.at(-1),saved:JSON.parse(await readFile(join(x.dir,'free-catalog/free-pool.json'))),wires:x.wires.map(w=>w.url)}));assert.equal(x.session.messages.at(-1).stopReason,'stop');assert.deepEqual(x.errors,[]);
 assert.ok(x.wires[0].url.endsWith(api==='anthropic-messages'?'/messages':'/responses'));
},{mutateFixture:data=>{const row=data.kilo.data.find(r=>r.id==='reflection/beam-free');row.openclaw={api_adapter:api};if(api==='anthropic-messages')row.opencode.ai_sdk_provider='anthropic';},response:(_n,b,_init,url)=>url.endsWith('/responses')?responsesFixture(b.model):sse(b.model)}));

test('unverified Anthropic beta-query transport is explicitly skipped, never bypasses anonymous guards or loses the catalog entry',()=>environment(async x=>{
 await x.session.prompt('Offline unsupported protocol');assert.equal(x.wires.length,1);assert.equal(x.wires[0].body.model,'thinkingmachines/inkling-small:free');assert.ok(x.session.modelRuntime.getAllModels().some(m=>m.provider==='free-kilo'&&m.id==='reflection/beam-free'));
 const records=x.session.sessionManager.getBranch().filter(e=>e.type==='custom');assert.ok(records.some(e=>e.data?.steps?.some(s=>s.state==='unavailable')));assert.deepEqual(x.errors,[]);
},{mutateFixture:data=>{const row=data.kilo.data.find(r=>r.id==='reflection/beam-free');row.openclaw={api_adapter:'anthropic-messages'};row.opencode.ai_sdk_provider='anthropic';}}));

test('actual Pi reviewed OVH-to-Kilo siblings migration activates native routing, defaults to RR and leaves the old file/model intact',async()=>{
 const choices=[()=> 'Edit model order',o=>o.find(v=>v==='free-kilo / reflection/beam-free'),o=>o.find(v=>v==='free-kilo / thinkingmachines/inkling-small:free'),()=> 'Use this order',o=>o.find(v=>v.startsWith('Pool:')),()=> 'Apply settings'];
 await environment(async x=>{
  const file=join(x.dir,'free-catalog/ovh-pool.json'),old=await readFile(file,'utf8'),model=x.session.model,metadata=x.metadata;
  await x.session.prompt('/free-pool');assert.equal(x.session.model.provider,model.provider);assert.equal(x.session.model.id,model.id);assert.equal(await readFile(file,'utf8'),old);assert.equal(x.metadata,metadata);
  const saved=JSON.parse(await readFile(join(x.dir,'free-catalog/free-pool.json')));assert.equal(saved.config.scheduling,'auto');assert.deepEqual(saved.config.models,[K,K2]);assert.equal(saved.config.enabled,true);
  await x.session.prompt('first fixture');await x.session.prompt('second fixture');assert.deepEqual(x.wires.map(w=>w.body.model),['reflection/beam-free','thinkingmachines/inkling-small:free']);assert.deepEqual(x.errors,[]);
 },{initiallyLegacy:true,select:async(_title,options)=>{const f=choices.shift();assert.ok(f);return f(options);},custom:async()=>true});
});

test('actual Pi general status renders Free Pool with durable HTTP provenance and no diagnostic requests or context entries',async()=>{
 let headings=[],views=[];
 await environment(async x=>{
  await x.session.prompt('Local fixture rejection');assert.equal(x.wires.length,2);
  const file=join(x.dir,'free-catalog/free-pool.json'),saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.cooldownEvidence[0].status,429);assert.equal(saved.cooldownEvidence[0].source,'retry-after');assert.equal(saved.cooldownEvidence[0].retryAfter,'90');assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_PROVIDER_BODY/);
  await x.restart();const metadata=x.metadata,messages=JSON.stringify(x.session.messages),model=[x.session.model.provider,x.session.model.id];
  for(const cmd of ['/free-pool status','/free-ovh-pool status','/free-pool preview'])await x.session.prompt(cmd);
  assert.ok(headings.length>=2);assert.ok(headings.every(t=>t==='Free Pool'));assert.match(views.join('\n'),/HTTP 429/);assert.match(views.join('\n'),/provider Retry-After: 90/);assert.match(views.join('\n'),/HISTORICAL/);
  assert.equal(x.wires.length,2);assert.equal(x.metadata,metadata);assert.equal(JSON.stringify(x.session.messages),messages);assert.deepEqual([x.session.model.provider,x.session.model.id],model);assert.equal(x.statuses.get('foreign'),'keep me');assert.deepEqual(x.errors,[]);
 },{response:()=>new Response('{"error":{"message":"PRIVATE_PROVIDER_BODY"}}',{status:429,headers:{'retry-after':'90'}}),custom:async factory=>{const view=factory({terminal:{rows:80},requestRender(){}},null,null,()=>{});const first=view.render(200);headings.push(first[0]);views.push(first.join('\n'));view.handleInput('\x1b[F');views.push(view.render(200).join('\n'));return false;}});
});
test('actual Pi unmigrated OVH-only status keeps its genuine legacy heading',async()=>{
 const headings=[];
 await environment(async x=>{
  await x.session.prompt('/free-ovh-pool status');assert.deepEqual(headings,['OVH pool']);assert.equal(x.wires.length,0);assert.deepEqual(x.errors,[]);
 },{initiallyLegacy:true,custom:async factory=>{const view=factory({terminal:{rows:30},requestRender(){}},null,null,()=>{});headings.push(view.render(80)[0]);return false;}});
});

const X='["kilo","xingchen-agi/xing4.0-29b-a4b:free"]';
test('actual Pi user-reported XingChen shared-upstream 429 advances to another Kilo model in the SAME response',()=>environment(async x=>{
 const metadata=x.metadata;await x.session.prompt('Local fixture only');assert.deepEqual(x.wires.map(w=>w.body.model),['xingchen-agi/xing4.0-29b-a4b:free','reflection/beam-free']);assert.equal(x.session.messages.at(-1).stopReason,'stop');assert.equal(x.session.messages.filter(m=>m.role==='assistant').length,1);assert.equal(x.metadata,metadata);assert.deepEqual(x.errors,[]);
 const saved=JSON.parse(await readFile(join(x.dir,'free-catalog/free-pool.json')));assert.deepEqual(saved.barriers,{});assert.ok(saved.modelBarriers[X].until);assert.equal(saved.modelBarriers[K],undefined);assert.equal(saved.cooldownEvidence[0].scope,'model');assert.equal(saved.rotation.paused,false);
},{models:[X,K],response:(n,b)=>n===1?Response.json({message:'Provider returned error',code:429,metadata:{raw:'xingchen-agi/xing4.0-29b-a4b:free is temporarily rate-limited upstream.',provider_name:'Phala',limit_source:'upstream_provider_shared_pool'}},{status:429}):sse(b.model)}));
test('actual Pi respects an explicit broad server scope and skips all cooled Kilo siblings for OVH',()=>environment(async x=>{
 await x.session.prompt('Local fixture only');assert.deepEqual(x.wires.map(w=>w.body.model),['xingchen-agi/xing4.0-29b-a4b:free','gpt-oss-120b']);assert.equal(x.session.messages.at(-1).stopReason,'stop');assert.deepEqual(x.errors,[]);
},{models:[X,K,A],response:(n,b)=>n===1?Response.json({message:'server declares service scope'},{status:429,headers:{'x-ratelimit-scope':'service','retry-after':'30'}}):sse(b.model)}));
test('actual Pi completed tool effect occurs once when a tool continuation receives 429 then succeeds elsewhere',()=>environment(async x=>{
 await x.session.prompt('Local tool fixture');assert.deepEqual(x.wires.map(w=>w.body.model),['reflection/beam-free','reflection/beam-free','thinkingmachines/inkling-small:free']);assert.equal(x.events.filter(e=>e.type==='tool_execution_start').length,1);assert.equal(await readFile(join(x.dir,'once429.txt'),'utf8'),'once\n');assert.equal(x.wires[2].body.messages.filter(m=>m.role==='tool').length,1);assert.equal(x.session.messages.at(-1).stopReason,'stop');assert.deepEqual(x.errors,[]);
},{weights:{[K]:2},response:(n,b)=>n===1?sse(b.model,{role:'assistant',tool_calls:[{index:0,id:'once429',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'printf "once\\n" >> once429.txt'})}}]},'tool_calls'):n===2?new Response('{}',{status:429}):sse(b.model)}));
test('actual Pi authorized old finite settings migrate to continuous and survive process/session restart',()=>environment(async x=>{
 for(let n=0;n<4;n++)await x.session.prompt('Local continuous fixture');assert.equal(x.wires.length,4);const saved=JSON.parse(await readFile(join(x.dir,'free-catalog/free-pool.json')));assert.equal(saved.config.cycles,0);assert.equal(saved.policyVersion,3);assert.equal(saved.rotation.paused,false);await x.restart();await x.session.prompt('After restart');assert.equal(x.wires.length,5);assert.deepEqual(x.errors,[]);
},{cycles:1,legacyGeneral:true}));
test('actual Pi OVH 429 may advance to Kilo while preserving OVH reservations and broad OVH cooldown',()=>environment(async x=>{
 await x.session.prompt('Local OVH fixture');assert.deepEqual(x.wires.map(w=>w.body.model),['gpt-oss-120b','reflection/beam-free']);assert.equal(x.session.messages.at(-1).stopReason,'stop');const saved=JSON.parse(await readFile(join(x.dir,'free-catalog/free-pool.json')));assert.equal(saved.ovhReservations['gpt-oss-120b'].length,1);assert.ok(saved.ovhCooldowns.providerUntil>0);assert.deepEqual(x.errors,[]);
},{models:[A,K],response:(n,b)=>n===1?new Response('{}',{status:429,headers:{'retry-after':'60'}}):sse(b.model)}));
test('actual native Responses 429 advances safely to completions within one response',()=>environment(async x=>{
 await x.session.prompt('Local Responses rejection');assert.equal(x.wires.length,2);assert.ok(x.wires[0].url.endsWith('/responses'));assert.ok(x.wires[1].url.endsWith('/chat/completions'));assert.equal(x.session.messages.at(-1).stopReason,'stop');assert.equal(x.session.messages.filter(m=>m.role==='assistant').length,1);assert.deepEqual(x.errors,[]);
},{mutateFixture:data=>{data.kilo.data.find(r=>r.id==='reflection/beam-free').openclaw={api_adapter:'openai-responses'};},response:(n,b)=>n===1?new Response('{}',{status:429}):sse(b.model)}));
