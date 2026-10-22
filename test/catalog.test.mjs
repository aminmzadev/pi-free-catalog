import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { Catalog, reconcile, recordKey, summary, priceClass, validateSource } from '../src/catalog.js';
import { registrations, report } from '../src/models.js';
import { fixtures, sources, state, fetcher } from './helpers.mjs';

const key=recordKey;
test('all 400 Kilo and 85 live Zen IDs are classified; 17 Kilo + 9 Zen chat + classifier; no omissions',()=>{
 const s=state(), counts=summary(s);
 assert.equal(counts.kilo.listed,400);assert.equal(counts.zen.listed,85);
 assert.equal(counts.kilo.free,17);assert.equal(counts.zen.freeChat,9);assert.equal(counts.zen.classifier,1);
 assert.equal(registrations(s,'kilo').length,17);assert.equal(registrations(s,'zen').length,10);
 const expected=fixtures.kilo.data.filter(m=>m.isFree).map(m=>m.id).sort();
 assert.deepEqual(registrations(s,'kilo').map(m=>m.id).sort(),expected);
 for(const id of ['big-pickle','beam-free','jev-1.13-free'])assert.ok(registrations(s,'zen').some(m=>m.id===id));
});
test('future free IDs WITHOUT any free suffix appear automatically on both services',()=>{
 const data=structuredClone(fixtures);
 data.kilo.data.push({id:'vendor/completely-new',name:'New',isFree:true,pricing:{prompt:'0',completion:'0'},context_length:12345,max_completion_tokens:321});
 data.zen.data.push({id:'unannounced-name'});
 data.official.opencode.models['unannounced-name']={id:'unannounced-name',cost:{input:0,output:0},limit:{context:56789,output:987}};
 const s=reconcile(sources(data));
 assert.ok(registrations(s,'kilo').some(m=>m.id==='vendor/completely-new'));
 assert.ok(registrations(s,'zen').some(m=>m.id==='unannounced-name'));
});
test('all future Kilo explicit free models stay in discovery even with absent/dynamic prices',()=>{
 const d=structuredClone(fixtures);d.kilo.data.push({id:'new-no-price',isFree:true},{id:'new-dynamic',isFree:true,pricing:{prompt:'-1',completion:'-1'}});
 const s=reconcile(sources(d));for(const id of ['new-no-price','new-dynamic'])assert.equal(s.entries[key('kilo',id)].classification,'free');
});
for(const [name,cost,expected] of [
 ['zero',{input:0,output:'0'},'zero'],['missing',{},'unknown'],['negative',{input:-1,output:0},'unknown'],
 ['invalid',{input:'garbage',output:0},'unknown'],['boolean',{input:false,output:0},'unknown'],
 ['paid',{input:1,output:0},'paid'],['paid-cache',{input:0,output:0,cache_read:1},'paid'],
 ['null',{input:null,output:0},'unknown'],['empty-string',{input:'',output:0},'unknown'],
 ['paid-nested-tiers',{input:0,output:0,tiers:[{input:1}]},'paid'],
 ['zero-nested-tiers',{input:0,output:0,tiers:[{input:0,output:0,tier:{type:'context',size:100000}}]},'zero'],
])test(`strict JSON price classification: ${name}`,()=>assert.equal(priceClass(cost),expected));
test('name free is not evidence; missing price never becomes zero',()=>{
 const d=structuredClone(fixtures);d.zen.data.push({id:'paid-but-free-in-name'},{id:'mystery'});
 d.official.opencode.models['paid-but-free-in-name']={id:'paid-but-free-in-name',cost:{input:10,output:20}};
 const s=reconcile(sources(d));assert.equal(s.entries[key('zen','paid-but-free-in-name')].classification,'paid');assert.equal(s.entries[key('zen','mystery')].classification,'unknown');
 assert.ok(report(s).includes('mystery'));assert.ok(!registrations(s,'zen').some(m=>m.id==='mystery'));
});
test('Kilo false flag zero token Lyria is reported as conflict, not free',()=>{
 const s=state();const conflicts=Object.values(s.entries).filter(e=>e.service==='kilo'&&e.classification==='conflict');assert.equal(conflicts.length,2);for(const e of conflicts)assert.ok(report(s).includes(e.id));
});
test('fresh price conflicts across registries are visible and blocked, not silently resolved free',()=>{
 const d=structuredClone(fixtures);d.modelsdev.opencode.models['big-pickle'].cost.input=1;
 const s=reconcile(sources(d));assert.equal(s.entries[key('zen','big-pickle')].classification,'conflict');assert.ok(report(s).includes('big-pickle'));
});
test('every-run updates context, output, modalities, name, tool/reasoning metadata',()=>{
 const old=state(),d=structuredClone(fixtures),m=d.official.opencode.models['beam-free'];
 m.limit={context:654321,output:4321};m.name='Renamed Beam';m.modalities={input:['text','image'],output:['text']};m.tool_call=false;m.reasoning_options=[{type:'effort',values:['new-native-level']}];
 const s=reconcile(sources(d),old),e=s.entries[key('zen','beam-free')],p=registrations(s,'zen').find(m=>m.id==='beam-free');
 assert.equal(p.contextWindow,654321);assert.equal(p.maxTokens,4321);assert.equal(p.name,'Renamed Beam');assert.deepEqual(p.input,['text','image']);assert.equal(e.metadata.tool_call,false);assert.deepEqual(e.metadata.reasoning_options,m.reasoning_options);
});
test('successful catalog disappearance is NOT retirement; history retained; reappearance restores',()=>{
 const old=state(),d=structuredClone(fixtures);d.kilo.data=d.kilo.data.filter(m=>m.id!=='reflection/beam-free');
 const gone=reconcile(sources(d),old),e=gone.entries[key('kilo','reflection/beam-free')];
 assert.equal(e.lifecycle,'not-listed');assert.equal(e.listed,false);assert.ok(report(gone).includes('reflection/beam-free'));
 const restored=reconcile(sources(),gone);assert.equal(restored.entries[key('kilo','reflection/beam-free')].lifecycle,'active');assert.equal(restored.entries[key('kilo','reflection/beam-free')].firstSeen,e.firstSeen);
});
test('explicit retirement removed from selectable only; deprecated remains selectable',()=>{
 const d=structuredClone(fixtures);d.kilo.data.find(m=>m.id==='reflection/beam-free').status='retired';d.official.opencode.models['big-pickle'].status='deprecated';
 const s=reconcile(sources(d),state());assert.equal(s.entries[key('kilo','reflection/beam-free')].lifecycle,'retired');assert.ok(!registrations(s,'kilo').some(m=>m.id==='reflection/beam-free'));assert.ok(report(s).includes('reflection/beam-free'));assert.ok(registrations(s,'zen').some(m=>m.id==='big-pickle'));
});
test('free to paid transition is detected without hiding its history',()=>{
 const d=structuredClone(fixtures);const m=d.kilo.data.find(m=>m.id==='stealth/glyph-cluster');m.isFree=false;m.pricing={prompt:'0.001',completion:'0.002'};
 const s=reconcile(sources(d),state());assert.equal(s.entries[key('kilo',m.id)].classification,'paid');assert.ok(report(s).includes(m.id));assert.ok(!registrations(s,'kilo').some(p=>p.id===m.id));
});
test('35 metadata-zero absent Zen models remain individually reported, not called retired',()=>{
 const s=state();assert.equal(summary(s).zen.historical,35);
 for(const e of Object.values(s.entries).filter(e=>e.service==='zen'&&!e.listed&&e.wasFree)){assert.equal(e.lifecycle,'not-listed');assert.ok(report(s).includes(e.id));}
});
test('classifier is registered as native classifier, never faked as chat',()=>{
 const p=registrations(state(),'zen').find(m=>m.id==='jev-1.13-free');assert.equal(p.type,'classifier');assert.equal(p.api,'typesafe-system-one');assert.equal(p.contextWindow,32000);assert.equal(p.maxTokens,undefined);
});
test('unsupported future free operation stays visible with explicit transport notice',()=>{
 const d=structuredClone(fixtures);d.kilo.data.push({id:'new-free-image',isFree:true,architecture:{output_modalities:['image']}});
 const s=reconcile(sources(d));assert.equal(s.entries[key('kilo','new-free-image')].classification,'free');assert.ok(report(s).includes('Pi transport not implemented'));
});
for(const [name,data] of [['empty',{data:[]}],['missing',{}],['duplicate',{data:[{id:'x'},{id:'x'}]}],['bad id',{data:[{id:22}]}]])test(`invalid catalog fails safely: ${name}`,()=>assert.throws(()=>validateSource('kilo',data)));
test('network failure keeps cached free models callable and never retires them',async()=>{
 const c=new Catalog({fetch:fetcher()});await c.refresh();c.fetcher=fetcher(fixtures,['kilo','zen','official','modelsdev','pi']);await c.refresh();
 assert.equal(registrations(c.state,'kilo').length,17);assert.equal(registrations(c.state,'zen').length,10);assert.equal(c.state.entries[key('kilo','reflection/beam-free')].lifecycle,'active');assert.equal(c.assertUsable('kilo','reflection/beam-free').classification,'free');
});
test('startup load is followed by new network calls, updates saved cache, concurrent refresh deduplicates',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-free-test-'));try{
 const file=join(dir,'catalog.json');let calls=0;
 const fetch=async(...a)=>{calls++;return fetcher()(...a);};
 const a=new Catalog({file,fetch});await a.refresh();assert.equal(calls,7);
 const b=new Catalog({file,fetch});await b.load();await Promise.all([b.refresh(),b.refresh()]);assert.equal(calls,14);
 assert.equal(JSON.parse(gunzipSync(await readFile(file)).toString('utf8')).schemaVersion,1);assert.equal(summary(b.state).kilo.free,17);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('saved state is gzipped and compact, round-trips, and legacy plain caches still load',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-free-gz-'));try{
 const file=join(dir,'catalog.json');
 const a=new Catalog({file,fetch:fetcher()});await a.refresh();
 const raw=await readFile(file);
 assert.equal(raw[0],0x1f);assert.equal(raw[1],0x8b);
 const parsed=JSON.parse(gunzipSync(raw).toString('utf8'));assert.equal(parsed.schemaVersion,1);
 const pretty=Buffer.byteLength(JSON.stringify(parsed,null,2));
 assert.ok(raw.length*3<pretty,`gzipped ${raw.length} should be far below pretty ${pretty}`);
 const b=new Catalog({file,fetch:fetcher()});await b.load();
 assert.equal(summary(b.state).kilo.free,17);
 assert.equal(Object.keys(b.state.entries).length,Object.keys(parsed.entries).length);
 const legacy=join(dir,'legacy.json');await writeFile(legacy,JSON.stringify(parsed,null,2));
 const c=new Catalog({file:legacy,fetch:fetcher()});await c.load();assert.equal(summary(c.state).kilo.free,17);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('fresh paid price beats stale free source and blocks dispatch',async()=>{
 const c=new Catalog({fetch:fetcher()});await c.refresh();const d=structuredClone(fixtures);d.modelsdev.opencode.models['big-pickle'].cost={input:5,output:5};d.pi=d.pi.filter(m=>m.id!=='big-pickle');
 c.fetcher=fetcher(d,['official']);await c.refresh();assert.equal(c.state.entries[key('zen','big-pickle')].classification,'paid');assert.throws(()=>c.assertUsable('zen','big-pickle'));
});
test('corrupt cache is recoverable with network refresh',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-free-corrupt-'));try{const file=join(dir,'catalog.json');await writeFile(file,'not-json');const c=new Catalog({file,fetch:fetcher()});await c.load();assert.ok(c.cacheWarning);await c.refresh();assert.equal(summary(c.state).kilo.free,17);}finally{await rm(dir,{recursive:true,force:true});}
});
test('cancellable refresh reports failures without destructive retirement',async()=>{
 const c=new Catalog({fetch:fetcher()});await c.refresh();
 c.fetcher=async(_url,{signal})=>{if(signal.aborted)throw signal.reason;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 const controller=new AbortController();controller.abort();await assert.rejects(c.refresh({signal:controller.signal}));assert.equal(summary(c.state).kilo.free,17);assert.ok(Object.values(c.state.sources).every(s=>s.fresh));c.assertUsable('kilo','reflection/beam-free');
});
test('tiny nonzero decimal/exponent prices never underflow into free',()=>{
 assert.equal(priceClass({input:'1e-9999',output:0}),'paid');assert.equal(priceClass({input:'-1e-9999',output:0}),'unknown');assert.equal(priceClass({input:'0e9999',output:'-0'}),'zero');assert.equal(priceClass({input:'0x0',output:0}),'unknown');
});
test('retirement metadata updates even after a model disappears from the live catalog',()=>{
 const old=state(),d=structuredClone(fixtures);d.zen.data=d.zen.data.filter(m=>m.id!=='beam-free');d.official.opencode.models['beam-free'].status='retired';d.official.opencode.models['beam-free'].name='Retired Beam';
 const s=reconcile(sources(d),old),e=s.entries[key('zen','beam-free')];assert.equal(e.lifecycle,'retired');assert.equal(e.name,'Retired Beam');assert.equal(e.listed,false);assert.ok(report(s).includes('Retired Beam')||report(s).includes('beam-free'));
});
test('failed empty snapshot preserves listed free IDs instead of retiring them',async()=>{
 const c=new Catalog({fetch:fetcher()});await c.refresh();const d=structuredClone(fixtures);d.kilo={data:[]};c.fetcher=fetcher(d);await c.refresh();assert.equal(summary(c.state).kilo.free,17);assert.equal(c.state.sources.kilo.fresh,false);assert.equal(c.state.entries[key('kilo','reflection/beam-free')].lifecycle,'active');
});
test('bulk future catalog growth without free naming never loses a free LLM',()=>{
 const d=structuredClone(fixtures);const ids=Array.from({length:100},(_,i)=>`model-🧪-${i}/new.route`);
 for(const id of ids){d.kilo.data.push({id,isFree:true,context_length:4096,max_completion_tokens:512});d.zen.data.push({id});d.official.opencode.models[id]={id,cost:{input:0,output:0},limit:{context:4096,output:512}};}
 const s=reconcile(sources(d));for(const service of ['kilo','zen']){const found=new Set(registrations(s,service).map(m=>m.id));for(const id of ids)assert.ok(found.has(id),`${service}/${id}`);}
});
test('live exact-ID Pi API hints select Responses without guessing from model name',()=>{
 const d=structuredClone(fixtures),id='new-native-response';d.zen.data.push({id});d.official.opencode.models[id]={id,cost:{input:0,output:0},limit:{context:10000,output:1000}};d.pi.push({id,type:'chat',api:'openai-responses',cost:{input:0,output:0},contextWindow:10000,maxTokens:1000});
 assert.equal(registrations(reconcile(sources(d)),'zen').find(m=>m.id===id).api,'openai-responses');
});
