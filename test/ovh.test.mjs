import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { Catalog, PROVIDERS, SOURCES, reconcile, recordKey, summary, validateSource } from '../src/catalog.js';
import { registrations, thinkingProfile, selectThinking, piModel } from '../src/models.js';
import { modelReport, clean } from '../src/catalog-report.js';
import { scopedFetch, anonymousHeaders } from '../src/transport.js';
import { OVH_BASE, ovhRecord, createOvhPacer, cancellableDelay } from '../src/ovh.js';
import { fixtures, sources, state, fetcher } from './helpers.mjs';
const key=id=>recordKey('ovh',id), id='gpt-oss-120b';
const stamp='2026-10-22T00:00:00.000Z';
const start=()=>{const c=new Catalog();c.state=state();return c;};
const rich=(d,name=id)=>ovhRecord(name,d.ovhmeta);
const send=(f,body={model:id},init={})=>f(OVH_BASE+'/chat/completions',{method:'POST',body:JSON.stringify(body),...init});

test('OVH factual inventory: all 22 records retained; 10 chat, 12 other, nine declared tool-capable, not 22 agent-tested models',()=>{
 const s=state(),n=summary(s).ovh,models=registrations(s,'ovh');
 assert.equal(PROVIDERS.ovh,'free-ovh');assert.equal(Object.keys(SOURCES).length,7);
 assert.equal(n.listed,22);assert.equal(n.freeChat,10);assert.equal(n.otherFree,12);assert.equal(models.length,10);
 assert.equal(Object.values(s.entries).filter(e=>e.service==='ovh'&&e.type==='chat'&&e.metadata.tool_call).length,9);
 assert.ok(models.every(m=>m.type==='chat'&&m.baseUrl===OVH_BASE&&m.api==='openai-completions'));
 assert.ok(!models.some(m=>m.id==='bge-m3'||m.id.includes('whisper')||m.id.includes('Guard')));
 assert.equal(registrations(s,'kilo').length,17);assert.equal(registrations(s,'zen').length,10);
 assert.ok(registrations(s,'zen').some(m=>m.type==='classifier'));
});

test('OVH exact identity/alias join rejects fuzzy names, substrings and ambiguous aliases; unknown runtime models remain visible but cannot infer',()=>{
 const d=structuredClone(fixtures);assert.equal(ovhRecord('openai/gpt-oss-120b',d.ovhmeta)?.name,id);
 assert.equal(ovhRecord('GPT-OSS-120B',d.ovhmeta),null);assert.equal(ovhRecord('gpt-oss',d.ovhmeta),null);
 d.ovh.data.push({id:'new-free-unmatched',pricing:{prompt:'0',completion:'0'},ovh:{anonymousRateLimit:2}});
 rich(d,'gpt-oss-20b').metadata.aliases.push(id);assert.equal(ovhRecord(id,d.ovhmeta),null);
 const c=start();c.state=reconcile(sources(d));
 for(const name of [id,'new-free-unmatched']){assert.equal(c.state.entries[key(name)].classification,'unknown');assert.throws(()=>c.assertUsable('ovh',name));assert.ok(!registrations(c.state,'ovh').some(m=>m.id===name));}
 assert.equal(c.state.entries[key('new-free-unmatched')].listed,true);
});

test('OVH entitlement is the documented anonymous lane, NOT commercial zero pricing or a free-looking name',()=>{
 const d=structuredClone(fixtures),s=state(),e=s.entries[key(id)];
 assert.ok(Number(e.raw.pricing.prompt)>0);assert.equal(e.classification,'free');assert.deepEqual(piModel(e,s).cost,{input:0,output:0,cacheRead:0,cacheWrite:0});
 assert.deepEqual(e.cost,e.raw.pricing);assert.equal(e.metadata.ovh.anonymousRateLimit,2);
 delete rich(d).metadata.usage_information.rate_limit.rate_limit_api_anonymous;
 const changed=reconcile(sources(d),s);assert.equal(changed.entries[key(id)].classification,'unknown');assert.ok(!registrations(changed,'ovh').some(m=>m.id===id));
 assert.match(modelReport(e,s),/commercial prices do not apply/i);assert.match(modelReport(e,s),/not a live-test verdict/);
 assert.match(modelReport(e,s),/2 requests\/minute\/IP\/model/);
});

test('OVH limits/modalities/efforts are exact evidence; reasoning without declared levels invents no control, chat-only LLM stays visible',()=>{
 const s=state(),e=s.entries[key(id)],m=piModel(e,s),p=thinkingProfile(e,s);
 assert.equal(m.contextWindow,131072);assert.equal(m.maxTokens,131072);assert.equal(m.compat.supportsStrictMode,false);
 assert.deepEqual(Object.keys(p.choices),['low','medium','high']);assert.equal(p.map.max,null);assert.equal(p.map.off,null);
 assert.deepEqual(selectThinking(e,s,'auto','low'),{reasoning_effort:'low'});assert.deepEqual(selectThinking(e,s,'default','high'),{});
 const unknown=s.entries[key('Qwen3.6-27B')];assert.ok(unknown);assert.equal(thinkingProfile(unknown,s).reasoning,true);assert.deepEqual(Object.keys(thinkingProfile(unknown,s).choices),[]);
 assert.deepEqual(selectThinking(unknown,s,'auto','high'),{});
 const chatOnly=Object.values(s.entries).find(e=>e.service==='ovh'&&e.type==='chat'&&!e.metadata.tool_call);assert.ok(chatOnly);
 assert.match(piModel(chatOnly,s).name,/chat-only; tools not advertised/);assert.ok(registrations(s,'ovh').some(m=>m.id===chatOnly.id));
 assert.ok(registrations(s,'ovh').some(m=>m.input.includes('image')));
});

test('OVH unavailable website flag alone is not retirement; exact EOL date blocks at midnight UTC, updates and removals reconcile',()=>{
 const d=structuredClone(fixtures),name='Mistral-Small-3.2-24B-Instruct-2506';let now=Date.parse('2026-11-03T23:59:59.999Z');
 const c=new Catalog({now:()=>now});c.state=reconcile(sources(d),{},stamp);
 assert.equal(c.state.entries[key(name)].metadata.ovh.catalogAvailable,false);assert.equal(c.state.entries[key(name)].metadata.retirement_date,'2026-11-04');c.assertUsable('ovh',name);
 now++;assert.throws(()=>c.assertUsable('ovh',name),/retirement date/);
 rich(d,name).metadata.publishing_information.model_eol_date='05/12/2026';c.state=reconcile(sources(d),c.state,new Date(now).toISOString());c.assertUsable('ovh',name);
 delete rich(d,name).metadata.publishing_information.model_eol_date;c.state=reconcile(sources(d),c.state,new Date(now).toISOString());now=Date.parse('2027-01-01');c.assertUsable('ovh',name);
 for(const invalid of ['31/02/2026','04/11/garbage','None']){rich(d,name).metadata.publishing_information.model_eol_date=invalid;const s=reconcile(sources(d),{},stamp);assert.equal(s.entries[key(name)].metadata.retirement_date,undefined);}
});

test('OVH source validation rejects partial/duplicate/malformed catalogs, without discarding the last good document or fabricating freshness',async()=>{
 for(const change of [d=>d.ovhmeta=[],d=>d.ovhmeta.push(d.ovhmeta[0]),d=>delete d.ovhmeta[0].metadata,d=>d.ovhmeta[0].metadata={},d=>d.ovhmeta[0].metadata.aliases=[null],d=>rich(d).metadata.model_specs.capabilities.reasoning_efforts=[1],d=>d.ovh.data.push(d.ovh.data[0])]){
  const dir=await mkdtemp(join(tmpdir(),'ovh-source-'));try{
   let now=Date.parse(stamp);const c=new Catalog({file:join(dir,'catalog.json'),fetch:fetcher(),now:()=>now});await c.refresh();const old=structuredClone(c.state);
   const d=structuredClone(fixtures);change(d);now+=1000;c.fetcher=fetcher(d);await c.refresh();
   const which=JSON.stringify(d.ovh)===JSON.stringify(fixtures.ovh)?'ovhmeta':'ovh';assert.equal(c.state.sources[which].fresh,false);assert.equal(c.state.sources[which].fetchedAt,old.sources[which].fetchedAt);
   assert.deepEqual(c.state.sources[which].data,old.sources[which].data);c.assertUsable('ovh',id);assert.equal(c.state.entries[key(id)].fresh,false);
  }finally{await rm(dir,{recursive:true,force:true});}
 }
 assert.throws(()=>validateSource('ovh',[]));assert.throws(()=>validateSource('ovhmeta',[{}]));
});

test('OVH full outage, partial rich outage, disk reload and later source withdrawal preserve only justified entitlement and provenance',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ovh-cache-'));try{
  let now=Date.parse(stamp);const file=join(dir,'catalog.json'),c=new Catalog({file,fetch:fetcher(),now:()=>now});await c.refresh();const original=c.state.entries[key(id)].metadataProvenance;
  now+=1000;c.fetcher=async()=>{throw new Error('offline');};await c.refresh();assert.deepEqual(c.state.entries[key(id)].metadataProvenance,original);assert.equal(c.state.entries[key(id)].metadataRetained,true);c.assertUsable('ovh',id);
  const b=new Catalog({file,fetch:async()=>{throw new Error('offline');},now:()=>now});await b.load();await b.refresh();b.assertUsable('ovh',id);
  const snap=sources();snap.ovhmeta={...snap.ovhmeta,data:null,fresh:false};b.state=reconcile(snap,b.state,new Date(now).toISOString());b.assertUsable('ovh',id);assert.deepEqual(b.state.entries[key(id)].metadataProvenance,original);
  const d=structuredClone(fixtures);rich(d).metadata.usage_information.rate_limit.rate_limit_api_anonymous=[];b.state=reconcile(sources(d),b.state,new Date(now).toISOString());assert.throws(()=>b.assertUsable('ovh',id));
  const empty=new Catalog({fetch:async()=>{throw new Error('offline');}});await empty.refresh();assert.equal(registrations(empty.state,'ovh').length,0);assert.throws(()=>empty.assertUsable('ovh',id));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('OVH scoped streaming transport sends no auth, cookies, payment or caller secret headers; model/tools/raw upstream stream unchanged',async()=>{
 const c=start(),body={model:id,stream:true,tools:[{type:'function',function:{name:'read'}}]},headers={authorization:'Bearer SECRET','x-api-key':'SECRET',cookie:'SECRET','x-payment':'SECRET','x-other-secret':'SECRET'};let calls=0;
 const response=new Response('data: upstream\n\n',{status:200});
 const f=scopedFetch({catalog:c,service:'ovh',model:{id},getFetch:()=>async(url,init)=>{calls++;assert.equal(url,OVH_BASE+'/chat/completions');assert.equal(init.redirect,'error');assert.deepEqual(JSON.parse(init.body),body);assert.deepEqual([...init.headers.keys()].sort(),['content-type','user-agent']);assert.match(init.headers.get('user-agent'),/^pi-free-catalog\//);assert.ok(!JSON.stringify([...init.headers]).includes('SECRET'));return response;}});
 assert.equal(await send(f,body,{headers}),response);assert.equal(calls,1);assert.equal(await response.text(),'data: upstream\n\n');assert.ok(!Object.keys(anonymousHeaders('ovh')).some(k=>k.toLowerCase()==='authorization'));
});

test('OVH URL/method/model allowlist refuses redirects, paid endpoints, query tricks and model fallback before network or pacing',async()=>{
 const c=start();let calls=0,waits=0;c.ovhPacer={wait:async()=>waits++,observe(){}};const f=scopedFetch({catalog:c,service:'ovh',model:{id},getFetch:()=>async()=>{calls++;return new Response();}});
 for(const [url,init] of [[OVH_BASE+'/responses',{}],[OVH_BASE+'/chat/completions?x=1',{}],[OVH_BASE+'/chat/completions/',{}],['https://oai.endpoints.kepler.ai.cloud.ovh.net.evil/v1/chat/completions',{}],[OVH_BASE.replace('https:','http:')+'/chat/completions',{}],[OVH_BASE+'/chat/completions',{method:'GET'}],[OVH_BASE+'/chat/completions',{body:JSON.stringify({model:'paid-fallback'})}]])
  await assert.rejects(f(url,{method:'POST',body:JSON.stringify({model:id}),...init}),/guard/);
 assert.equal(calls,0);assert.equal(waits,0);
});

test('OVH request-object path, abort signal and upstream 429 are preserved; no internal retry/fallback',async()=>{
 const c=start(),controller=new AbortController();let observed,calls=0;
 c.ovhPacer={wait:async(_id,{signal})=>{assert.equal(signal.aborted,false);},observe:(_id,r)=>observed=r};
 const upstream=new Response('slow down',{status:429,headers:{'retry-after':'60'}}),f=scopedFetch({catalog:c,service:'ovh',model:{id},getFetch:()=>async()=>{calls++;return upstream;}});
 const req=new Request(OVH_BASE+'/chat/completions',{method:'POST',body:JSON.stringify({model:id}),signal:controller.signal,headers:{authorization:'secret'}});
 assert.equal(await f(req),upstream);assert.equal(observed,upstream);assert.equal(calls,1);assert.equal(await upstream.text(),'slow down');
});

test('OVH rechecks local eligibility after pacing and cleans wait status even on cancellation',async()=>{
 const c=start();let calls=0;const statuses=[];
 c.ovhPacer={wait:async(_id,{onWait})=>{onWait(31000);c.state.entries[key(id)].classification='paid';}};
 const f=scopedFetch({catalog:c,service:'ovh',model:{id},onWait:ms=>statuses.push(ms),getFetch:()=>async()=>{calls++;}});
 await assert.rejects(send(f),/guard/);assert.deepEqual(statuses,[31000,0]);assert.equal(calls,0);
 c.state=state();c.ovhPacer={wait:async(_id,{onWait})=>{onWait(31000);throw new DOMException('Cancelled','AbortError');}};
 await assert.rejects(send(f),/Cancelled/);assert.equal(statuses.at(-1),0);assert.equal(calls,0);
});

test('OVH per-model pacing spaces concurrent starts conservatively, while different model IDs have independent gates',async()=>{
 let now=0;const waits=[],p=createOvhPacer({now:()=>now,sleep:async ms=>{waits.push(ms);now+=ms;}}),started=[];
 await Promise.all([1,2,3,4].map(async n=>{await p.wait(id);started.push([n,now]);}));
 assert.deepEqual(started,[[1,0],[2,31000],[3,62000],[4,93000]]);assert.deepEqual(waits,[31000,31000,31000]);
 await p.wait('different-model');assert.equal(now,93000);assert.deepEqual(waits,[31000,31000,31000]);
});

test('OVH Retry-After seconds/date extend only that model gate, malformed/missing values use conservative delay, non-429 does not delay',async()=>{
 for(const [value,expected] of [['90',90000],['0.5',31000],[new Date(Date.parse(stamp)+120000).toUTCString(),120000],['garbage',31000],[null,31000]]){
  let now=Date.parse(stamp);const initial=now,p=createOvhPacer({now:()=>now,sleep:async ms=>{now+=ms;}});await p.wait(id);
  p.observe(id,new Response('',{status:429,headers:value===null?{}:{'retry-after':value}}));await p.wait('other');assert.equal(now,initial);await p.wait(id);assert.equal(now-initial,expected);
 }
 let now=0;const p=createOvhPacer({now:()=>now,sleep:async ms=>{now+=ms;}});p.observe(id,new Response('',{status:200,headers:{'retry-after':'999'}}));await p.wait(id);assert.equal(now,0);
});

test('OVH in-flight Retry-After extends an already sleeping waiter; wait loops instead of dispatching early',async()=>{
 let now=0,release;const waits=[],p=createOvhPacer({now:()=>now,sleep:(ms)=>new Promise(r=>{waits.push(ms);release=()=>{now+=ms;r();};})});await p.wait(id);
 const second=p.wait(id);await new Promise(r=>setImmediate(r));assert.deepEqual(waits,[31000]);p.observe(id,new Response('',{status:429,headers:{'retry-after':'90'}}));release();await new Promise(r=>setImmediate(r));assert.deepEqual(waits,[31000,59000]);release();await second;assert.equal(now,90000);
});

test('OVH cancellation removes abort listeners and never lets a later request jump an earlier wait gate',async()=>{
 let now=0,release,enter;const p=createOvhPacer({now:()=>now,sleep:ms=>new Promise(r=>{release=()=>{now+=ms;r();};enter?.();})});await p.wait(id);
 const first=p.wait(id);await new Promise(r=>setImmediate(r));const controller=new AbortController(),cancelled=p.wait(id,{signal:controller.signal});controller.abort();await assert.rejects(cancelled,/abort/i);assert.equal(getEventListeners(controller.signal,'abort').length,0);
 let finished=false;const third=p.wait(id).then(()=>{finished=true;});await new Promise(r=>setImmediate(r));assert.equal(finished,false);release();await first;await new Promise(r=>setImmediate(r));assert.equal(finished,false);release();await third;assert.equal(now,62000);
 const pre=new AbortController();pre.abort();await assert.rejects(p.wait('new',{signal:pre.signal}),/abort/i);
 const ok=new AbortController();await p.wait('new',{signal:ok.signal});assert.equal(getEventListeners(ok.signal,'abort').length,0);
});

test('OVH real cancellable wait resolves/aborts and clears listeners, without a retry storm',async()=>{
 const success=new AbortController();await cancellableDelay(1,success.signal);assert.equal(getEventListeners(success.signal,'abort').length,0);
 const abort=new AbortController(),waiting=cancellableDelay(60000,abort.signal);abort.abort();await assert.rejects(waiting,/abort/i);assert.equal(getEventListeners(abort.signal,'abort').length,0);
 assert.throws(()=>cancellableDelay(1,abort.signal),/abort/i);
});

test('OVH metadata UI is sanitized while exact raw rich source evidence remains exportable',()=>{
 const d=structuredClone(fixtures);rich(d).name+='\u001b[31m';rich(d).metadata.aliases.push(id); // alias maintains exact identity
 const s=reconcile(sources(d)),e=s.entries[key(id)],report=modelReport(e,s);
 assert.ok(!report.includes('\u001b'));assert.ok(e.metadata.ovh.richRecord.name.includes('\u001b'));assert.equal(clean('\u001b[31mred'),'red');
});


test('OVH stale runtime with fresh rich metadata distinguishes retained inventory from newly selected metadata provenance',()=>{
 const old=state(),snap=sources();snap.ovh.fresh=false;snap.ovhmeta.fetchedAt='2026-10-22T02:00:00Z';
 const s=reconcile(snap,old),e=s.entries[key(id)];assert.equal(e.fresh,false);assert.equal(e.metadataRetained,false);assert.equal(e.metadataProvenance.fetchedAt,snap.ovhmeta.fetchedAt);assert.equal(thinkingProfile(e,s).provenance.fresh,true);
});

test('OVH malformed Retry-After cannot use permissive Date.parse to bypass conservative delay after a slow response',async()=>{
 for(const value of ['-10','123garbage','Oct 2027']){
  let now=Date.parse(stamp);const p=createOvhPacer({now:()=>now,sleep:async ms=>{now+=ms;}});await p.wait(id);now+=60000;const before=now;
  p.observe(id,new Response('',{status:429,headers:{'retry-after':value}}));await p.wait(id);assert.equal(now-before,31000);
 }
});
