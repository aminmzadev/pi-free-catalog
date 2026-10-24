import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,initTheme} from '@earendil-works/pi-coding-agent';
import extension from '../index.js';
import {Catalog,reconcile,recordKey,summary} from '../src/catalog.js';
import {thinkingProfile,selectThinking,thinkingFields} from '../src/models.js';
import {modelReport} from '../src/catalog-report.js';
import {fixtures,sources,fetcher} from './helpers.mjs';
const t1='2026-10-20T00:00:00.000Z',t2='2026-10-21T00:00:00.000Z',t3='2026-10-22T00:00:00.000Z';
const snapshots=(data,time)=>Object.fromEntries(Object.entries(sources(data)).map(([k,v])=>[k,{...v,fetchedAt:time}]));
async function withFactory(fn){
 const dir=await mkdtemp(join(tmpdir(),'six-factory-')),prior=process.env.PI_CODING_AGENT_DIR,original=globalThis.fetch;
 const configs=new Map(),commands=new Map(),events=new Map(),statuses=new Map(),output=[];let level='low';
 const ctx={hasUI:false,model:{provider:'free-kilo',id:'reflection/beam-free'},ui:{setStatus:(k,v)=>statuses.set(k,v)}};
 const pi={registerProvider:(k,v)=>configs.set(k,v),registerCommand:(k,v)=>commands.set(k,v),on:(k,v)=>events.set(k,v),sendMessage:m=>output.push(m.content),getThinkingLevel:()=>level,setThinkingLevel:v=>{level=v;}};
 process.env.PI_CODING_AGENT_DIR=dir;let adapter=fetcher();globalThis.fetch=(...args)=>adapter(...args);
 try{await extension(pi);await events.get('session_start')({},ctx);await fn({dir,configs,commands,events,statuses,output,ctx,pi,setFetch:value=>adapter=value});}
 finally{globalThis.fetch=original;if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior;await rm(dir,{recursive:true,force:true});}
}

test('F1: inspect separates auto control, Pi level and exact effective native choice; default and native overrides remain distinct',()=>withFactory(async x=>{
 await x.commands.get('free-thinking').handler('',x.ctx);let p=JSON.parse(x.output.at(-1));
 assert.equal(p.selected,'auto');assert.equal(p.controlMode,'auto');assert.match(p.controlMeaning,/Follow Pi/);assert.equal(p.piThinking,'low');assert.equal(p.effectiveNativeMode,'low');assert.deepEqual(p.effectiveNativeParameters,{reasoning:{enabled:true,effort:'low'}});
 await x.commands.get('free-thinking').handler('default',x.ctx);await x.commands.get('free-thinking').handler('',x.ctx);p=JSON.parse(x.output.at(-1));assert.equal(p.controlMode,'default');assert.equal(p.effectiveNativeMode,'provider-default');assert.deepEqual(p.effectiveNativeParameters,{});assert.doesNotMatch(p.controlMeaning,/Follow Pi/);
 await x.commands.get('free-thinking').handler('high',x.ctx);await x.commands.get('free-thinking').handler('',x.ctx);p=JSON.parse(x.output.at(-1));assert.equal(p.controlMode,'high');assert.equal(p.effectiveNativeMode,'high');assert.equal(p.piThinking,'high');
 await x.commands.get('free-thinking').handler('auto',x.ctx);await x.commands.get('free-thinking').handler('',x.ctx);p=JSON.parse(x.output.at(-1));assert.equal(p.controlMode,'auto');assert.equal(p.effectiveNativeMode,'high');
}));

test('F2: persistent chat-only footer counts preserve classifier registration',()=>withFactory(async x=>{
 const counts=summary(reconcile(sources()));assert.notEqual(counts.zen.free,counts.zen.freeChat);assert.equal(counts.kilo.freeChat,17);assert.equal(counts.zen.freeChat,9);
 assert.equal(x.statuses.get('free-catalog'),'Free chat: Kilo 17 · Zen 9 · OVH 10');
 assert.equal(x.configs.get('free-zen').models.find(m=>m.id==='jev-1.13-free').type,'classifier');
 const d=structuredClone(fixtures);d.kilo.data.push({id:'new-classifier-not-chat',type:'image',isFree:true});x.setFetch(fetcher(d));await x.commands.get('free-refresh').handler('',x.ctx);
 assert.equal(x.statuses.get('free-catalog'),'Free chat: Kilo 17 · Zen 9 · OVH 10');
 d.kilo.data.push({...d.kilo.data.find(row=>row.id==='reflection/beam-free'),id:'new-free-chat'});
 await x.commands.get('free-refresh').handler('',x.ctx);
 assert.equal(x.statuses.get('free-catalog'),'Free chat: Kilo 18 · Zen 9 · OVH 10');
 await x.commands.get('free-footer').handler('counts off',x.ctx);
 d.kilo.data.find(row=>row.id==='new-free-chat').type='embedding';
 await x.commands.get('free-refresh').handler('',x.ctx);assert.equal(x.statuses.get('free-catalog'),undefined);
 await x.commands.get('free-footer').handler('counts on',x.ctx);
 assert.equal(x.statuses.get('free-catalog'),'Free chat: Kilo 17 · Zen 9 · OVH 10');
}));

test('F3: actual Pi refresh shrinks max to low/high, normalizes auto via public Pi API, then reaches HTTP; explicit removed native override is not silently remapped',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'six-real-refresh-')),oldDir=process.env.PI_CODING_AGENT_DIR,original=globalThis.fetch,d=structuredClone(fixtures),wires=[],errors=[];let session;
 const id='reflection/beam-free';process.env.PI_CODING_AGENT_DIR=dir;
 globalThis.fetch=async(input,init)=>{if(String(input).endsWith('/chat/completions')){wires.push(JSON.parse(init.body));return new Response('data: {"id":"regression","choices":[{"index":0,"delta":{"content":"323"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}return fetcher(d)(input,init);};
 try{
  initTheme('dark');const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}}),loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});await loader.reload();
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(dir)}));await session.bindExtensions({mode:'tui',uiContext:{setStatus(){},setFooter(){},notify(){}},onError:e=>errors.push(e)});
  await session.setModel(session.modelRuntime.getModel('free-kilo',id));session.setThinkingLevel('max');assert.equal(session.thinkingLevel,'max');
  const row=d.kilo.data.find(m=>m.id===id);row.context_length=12345;row.top_provider={max_completion_tokens:5678};row.opencode.variants={low:{reasoning:{enabled:true,effort:'low'}},high:{reasoning:{enabled:true,effort:'high'}}};
  await session.prompt('/free-refresh');assert.equal(session.model.contextWindow,12345);assert.equal(session.model.maxTokens,5678);assert.deepEqual(session.getAvailableThinkingLevels(),['low','high']);assert.ok(session.getAvailableThinkingLevels().includes(session.thinkingLevel));
  await session.prompt('17*19');assert.equal(wires.length,1);assert.equal(session.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'stop');assert.deepEqual(wires[0].reasoning,{enabled:true,effort:session.thinkingLevel});
  await session.prompt('/free-thinking high');assert.equal(session.thinkingLevel,'high');row.opencode.variants={low:{reasoning:{enabled:true,effort:'low'}}};await session.prompt('/free-refresh');await session.prompt('17*19');assert.equal(wires.length,1,'Removed explicit native mode must fail before HTTP');assert.match(session.messages.filter(m=>m.role==='assistant').at(-1).errorMessage,/Unsupported native thinking/);
  await session.prompt('/free-thinking auto');await session.prompt('17*19');assert.equal(wires.length,2);assert.deepEqual(wires.at(-1).reasoning,{enabled:true,effort:'low'});assert.deepEqual(errors,[]);
 }finally{if(session){await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}globalThis.fetch=original;if(oldDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldDir;await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('F4: factual expiration_date guards exact UTC boundary, survives outages and legacy cached deadline arrays, and accepts corrected/removed dates',()=>{
 const id='poolside/laguna-s-2.1:free',key=recordKey('kilo',id),before='2026-10-30T23:59:59.999Z';let now=Date.parse(before);
 const c=new Catalog({now:()=>now});c.state=reconcile(snapshots(fixtures,t1),{},t1);assert.equal(c.state.entries[key].raw.expiration_date,'2026-10-31');c.assertUsable('kilo',id);
 now=Date.parse('2026-10-31T00:00:00.000Z');assert.throws(()=>c.assertUsable('kilo',id),/retirement date/);assert.match(modelReport(c.state.entries[key],c.state,{now}),/expiration_date/);
 c.state.entries[key].retirementDates=[];assert.throws(()=>c.assertUsable('kilo',id),/retirement date/,'Old cache empty deadline array must not defeat native expiry');
 const stale=snapshots(fixtures,t1);for(const s of Object.values(stale))s.fresh=false;c.state=reconcile(stale,c.state,'2026-11-02T00:00:00Z');assert.throws(()=>c.assertUsable('kilo',id));
 const d=structuredClone(fixtures);d.kilo.data.find(m=>m.id===id).expiration_date='2026-12-01';c.state=reconcile(snapshots(d,t3),c.state,t3);c.assertUsable('kilo',id);delete d.kilo.data.find(m=>m.id===id).expiration_date;c.state=reconcile(snapshots(d,t3),c.state,t3);now=Date.parse('2027-01-01');c.assertUsable('kilo',id);
 for(const bad of ['garbage','2026-02-30',null,123]){d.kilo.data.find(m=>m.id===id).expiration_date=bad;const s=reconcile(snapshots(d,t3),{},t3);assert.notEqual(s.entries[key].lifecycle,'retired');}
});

test('F5: historical and metadata-only Zen accept fresh provenance, retain exact old timestamps after bad pricing/outages, switch sources, and do not invent legacy dates',()=>{
 for(const id of ['beam-free','fledge-alpha-free']){
  const key=recordKey('zen',id),first=reconcile(snapshots(fixtures,t1),{},t1),d=structuredClone(fixtures);d.zen.data=d.zen.data.filter(m=>m.id!==id);d.official.opencode.models[id].limit.context=12345;
  const second=reconcile(snapshots(d,t2),first,t2),e=second.entries[key];assert.equal(e.listed,false);assert.equal(e.metadata.limit.context,12345);assert.equal(e.metadataProvenance.fetchedAt,t2);assert.equal(e.metadataRetained,false);
  for(const name of ['official','modelsdev'])d[name].opencode.models[id].cost={};for(const m of (Array.isArray(d.pi)?d.pi:d.pi.data))if(m.id===id)m.cost={};
  const third=reconcile(snapshots(d,t3),second,t3),r=third.entries[key];assert.equal(r.metadataRetained,true);assert.equal(r.metadataProvenance.fetchedAt,t2);assert.equal(thinkingProfile(r,third).provenance.fresh,false);assert.equal(thinkingProfile(r,third).provenance.fetchedAt,t2);assert.equal(r.listingOrigin,id==='beam-free'?'recorded-listed':'metadata-only');
  const old=structuredClone(third);delete old.entries[key].metadataProvenance;const stale=snapshots(d,t3);for(const s of Object.values(stale))s.fresh=false;const fourth=reconcile(stale,old,t3);assert.equal(fourth.entries[key].metadataProvenance.fetchedAt,null);assert.equal(fourth.entries[key].metadataRetained,true);
  d.modelsdev.opencode.models[id].cost={input:0,output:0};const fifth=reconcile(snapshots(d,t3),third,t3);assert.equal(fifth.entries[key].evidence,'modelsdev');assert.equal(fifth.entries[key].metadataProvenance.fetchedAt,t3);assert.equal(fifth.entries[key].metadataRetained,false);
 }
});

test('F6: catalog and wire share every thinking field including enable_thinking; unrelated fields and terminal escapes cannot leak into displayed controls',()=>{
 const s=reconcile(sources()),e=s.entries[recordKey('kilo','reflection/beam-free')];
 const params={reasoning:{enabled:true,effort:'low'},reasoning_effort:'low',thinking:{type:'enabled'},enable_thinking:true,thinking_budget:128,thinking_budget_tokens:256,reasoning_budget:512,verbosity:'low',model:'must-not-display',tools:[{private:'no'}],temperature:0};
 e.metadata.opencode.variants={deliberate:params};const expected=thinkingFields(params);assert.deepEqual(selectThinking(e,s,'deliberate'),expected);assert.equal(expected.enable_thinking,true);
 const line=modelReport(e,s).split('\n').find(l=>l.includes('deliberate:'));assert.deepEqual(JSON.parse(line.slice(line.indexOf('{'))),expected);assert.doesNotMatch(line,/must-not-display|private|temperature/);
 e.metadata.opencode.variants['\u001b[31minjected']={enable_thinking:true};assert.doesNotMatch(modelReport(e,s),/\u001b/);
});
