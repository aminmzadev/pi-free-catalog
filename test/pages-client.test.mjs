import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { SOURCES, reconcile, recordKey } from '../src/catalog.js';
import { PagesCatalog, PAGES_URL, metadataResponse } from '../src/catalog-client.js';
import { canonical, seal, validateSnapshot, rulesHash, dataHash } from '../src/snapshot-contract.js';
import { fixtures, fetcher, sources } from './helpers.mjs';
import { snapshotFixture, pagesFetcher, isPages } from './snapshot-helper.mjs';
const at='2026-10-22T00:00:00.000Z', clock=Date.parse(at);
const snapshot=await snapshotFixture();
const local=()=>reconcile(sources(),{},at);
const entry=recordKey('kilo','thinkingmachines/inkling-small:free');
function client(fetch,extra={}){return new PagesCatalog({fetch,now:()=>clock,...extra});}

test('healthy Pages snapshot requires one anonymous GET, controlled cache buster, and no direct requests',async()=>{
 const urls=[];const c=client(async(url,init)=>{
  urls.push(String(url));const parsed=new URL(url);assert.equal(parsed.origin+parsed.pathname,PAGES_URL);assert.deepEqual([...parsed.searchParams.keys()],['catalog_read']);assert.match(parsed.searchParams.get('catalog_read'),/^[a-f0-9-]{36}$/);
  assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.deepEqual(Object.keys(init.headers).sort(),['accept','cache-control','user-agent']);return Response.json(snapshot);
 });
 await c.refresh();assert.equal(urls.length,1);assert.equal(c.lastRefresh.transport,'pages');assert.equal(c.state.refreshedAt,at);assert.equal(c.state.delivery.snapshotGeneratedAt,at);assert.equal(c.state.sources.kilo.fetchedAt,at);assert.equal(c.state.entries[entry].classification,'free');
});
test('shared contract fingerprints the unchanged modules and validates a backend-compatible fixture',async()=>{
 validateSnapshot(snapshot,{expectedRules:await rulesHash(),now:clock});assert.equal(snapshot.rulesHash,await rulesHash());
});
test('concurrent startup/manual refreshes coalesce into one Pages request',async()=>{
 let calls=0,release;const gate=new Promise(r=>release=r);const c=client(async()=>{calls++;await gate;return Response.json(snapshot);});const a=c.refresh(),b=c.refresh();release();await Promise.all([a,b]);assert.equal(calls,1);
});
test('each explicit refresh uses a new cache-busting key',async()=>{
 const urls=[];const c=client(pagesFetcher(snapshot,{trace:urls}));await c.refresh();await c.refresh();assert.equal(new Set(urls).size,2);
});
for(const [label,respond]of[
 ['HTTP503',()=>new Response(null,{status:503})],['HTML',()=>new Response('<html>not a catalog</html>')],['malformed JSON',()=>new Response('{')],['unsupported version',()=>Response.json({...snapshot,schemaVersion:999})],['wrong repository',()=>Response.json(seal({...snapshot,producer:{...snapshot.producer,repository:'fork/other'}}))],['wrong rules hash',()=>Response.json(seal({...snapshot,rulesHash:'b'.repeat(64)}))],['future timestamp',()=>Response.json(seal({...snapshot,generatedAt:'2099-01-01T00:00:00.000Z'}))],['invalid integrity',()=>Response.json({...snapshot,integrity:{algorithm:'sha256',payloadHash:'0'.repeat(64)}})],['wrong source URL',()=>{const s=structuredClone(snapshot);s.sources.kilo.url='https://evil.invalid';return Response.json(seal(s));}],['omitted inventory ID',()=>{const s=structuredClone(snapshot);delete s.catalog.entries[entry];return Response.json(seal(s));}],
])test('invalid Pages safely recovers through existing direct rules: '+label,async()=>{
 const urls=[];const delegate=fetcher();const c=client(async(url,init)=>{urls.push(String(url));return isPages(url)?respond():delegate(url,init);});await c.refresh();assert.equal(c.lastRefresh.transport,'direct');assert.equal(urls.length,4);assert.equal(c.state.entries[entry].classification,'free');assert.deepEqual(new Set(urls.filter(u=>!isPages(u))),new Set(Object.values(SOURCES)));
});
test('unavailable Pages plus failed direct refresh preserves exact in-memory and on-disk cache',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pages-preserve-'));try{
  const file=join(dir,'catalog.json'),prior=local();await writeFile(file,gzipSync(JSON.stringify(prior)));const bytes=await readFile(file);
  const c=client(async()=>{throw Error('offline');},{file});await c.load();const original=c.state;await c.refresh();assert.equal(c.state,original);assert.deepEqual(await readFile(file),bytes);c.assertUsable('kilo','thinkingmachines/inkling-small:free');assert.equal(c.lastRefresh.transport,'cache');assert.match(c.refreshWarning,/saved catalog/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('no cache plus no network never invents models or persists an empty replacement',async()=>{
 let saved=0;const c=client(async()=>{throw Error('offline');},{file:'unused',persist:async()=>saved++});await c.refresh();assert.equal(saved,0);assert.equal(Object.keys(c.state.entries).length,0);assert.equal(c.lastRefresh.transport,'empty');assert.throws(()=>c.assertUsable('kilo','thinkingmachines/inkling-small:free'));
});
test('Pages timeout is bounded even when a fetch mock ignores AbortSignal; direct recovery still works',async()=>{
 // AbortSignal.timeout is unrefed; keep the fixture process alive through slow setup.
 const hold=setTimeout(()=>{},10000),delegate=fetcher();try{
  const c=client((url,init)=>isPages(url)?new Promise(()=>{}):delegate(url,init),{pagesTimeout:10});await c.refresh();assert.equal(c.lastRefresh.transport,'direct');c.assertUsable('kilo','thinkingmachines/inkling-small:free');
 }finally{clearTimeout(hold);}
});
test('direct-source timeouts cannot strand startup when fetch ignores cancellation',async()=>{
 // AbortSignal.timeout is unrefed; keep the fixture process alive through slow setup.
 const hold=setTimeout(()=>{},10000);try{
  const c=client(async url=>isPages(url)?new Response(null,{status:503}):await new Promise(()=>{}),{timeout:10});c.state=local();const before=c.state;await c.refresh();assert.equal(c.state,before);assert.equal(c.lastRefresh.transport,'cache');
 }finally{clearTimeout(hold);}
});
test('caller cancellation never starts direct fallback or changes cache',async()=>{
 let requests=0;const controller=new AbortController();const c=client(async()=>{requests++;controller.abort();return new Response('{}');});c.state=local();const before=c.state;await assert.rejects(c.refresh({signal:controller.signal}));assert.equal(c.state,before);assert.equal(requests,1);assert.equal(c.lastAttempt,0);
});
test('Pages cannot roll back newer local source evidence',async()=>{
 const old=local();for(const s of Object.values(old.sources))s.fetchedAt=new Date(clock+60000).toISOString();old.refreshedAt=new Date(clock+60000).toISOString();
 const c=client(async url=>isPages(url)?Response.json(snapshot):new Response(null,{status:503}),{now:()=>clock+120000});c.state=old;await c.refresh();assert.equal(c.state,old);assert.equal(c.lastRefresh.transport,'cache');
});
test('degraded but recent Pages preserves actual retained-source timestamps and provenance',async()=>{
 const s=await snapshotFixture({retained:['ovhmeta']});const c=client(pagesFetcher(s));await c.refresh();assert.equal(c.lastRefresh.transport,'pages');assert.equal(c.state.sources.ovhmeta.fresh,false);assert.equal(c.state.sources.ovhmeta.fetchedAt,s.sources.ovhmeta.fetchedAt);assert.match(c.state.sources.ovhmeta.error,/Retained/);
});
test('soft source age triggers direct recovery but never disables existing cached inference',async()=>{
 const urls=[],delegate=fetcher();const c=client(async(url,init)=>{urls.push(String(url));return isPages(url)?Response.json(snapshot):delegate(url,init);},{now:()=>clock+3600000});await c.refresh();assert.equal(c.lastRefresh.transport,'direct');assert.equal(urls.length,4);
 const d=client(async url=>isPages(url)?Response.json(snapshot):new Response(null,{status:503}),{now:()=>clock+3600000});d.state=local();const old=d.state;await d.refresh();assert.equal(d.state,old);d.assertUsable('kilo','thinkingmachines/inkling-small:free');
});
test('cold install can keep a validated stale Pages last-known-good if all direct requests fail',async()=>{
 const c=client(async url=>isPages(url)?Response.json(snapshot):new Response(null,{status:503}),{now:()=>clock+3600000});await c.refresh();assert.equal(c.lastRefresh.transport,'stale-pages');assert.equal(c.state.sources.kilo.fetchedAt,at);c.assertUsable('kilo','thinkingmachines/inkling-small:free');assert.ok(c.refreshWarning);
});
test('local-only records, firstSeen, and history survive Pages adoption without remaining falsely listed',async()=>{
 const old=local(),key=recordKey('kilo','local-history-only');old.entries[key]={...structuredClone(old.entries[recordKey('kilo','reflection/beam-free')]),id:'local-history-only',raw:{id:'local-history-only'},firstSeen:'2026-10-01T00:00:00.000Z'};
 old.entries[entry].firstSeen='2026-10-01T00:00:00.000Z';const event={at:'2026-10-01T00:00:00.000Z',service:'kilo',id:'local-history-only',from:null,to:{classification:'free',listed:true,lifecycle:'active'}};old.history.push(event);
 const c=client(pagesFetcher(snapshot));c.state=old;await c.refresh();assert.ok(c.state.entries[key]);assert.equal(c.state.entries[key].listed,false);assert.equal(c.state.entries[entry].firstSeen,'2026-10-01T00:00:00.000Z');assert.ok(c.state.history.some(e=>dataHash(e)===dataHash(event)));
});
test('current lifecycle deadlines are enforced without promoting upstream timestamps or listings',async()=>{
 const future=Date.parse('2026-11-06T00:00:00.000Z');const c=client(pagesFetcher(snapshot),{now:()=>future,softSourceAge:Infinity});await c.refresh();assert.equal(c.state.sources.ovhmeta.fetchedAt,at);assert.ok(Object.values(c.state.entries).some(e=>e.service==='ovh'&&e.lifecycle==='retired'));for(const e of Object.values(c.state.entries).filter(e=>e.lifecycle==='retired'))assert.throws(()=>c.assertUsable(e.service,e.id));
});
test('validated Pages cache is gzip-persisted and reloads without a network request',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pages-disk-'));try{
  const file=join(dir,'nested/catalog.json');const c=client(pagesFetcher(snapshot),{file});await c.refresh();const persisted=JSON.parse(gunzipSync(await readFile(file)));assert.equal(persisted.delivery.transport,'pages');const d=client(()=>{throw Error('load must not fetch');},{file});await d.load();assert.equal(canonical(d.state),canonical(c.state));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('failed persistence leaves the old disk cache intact, activates only validated memory, and warns',async()=>{
 const c=client(pagesFetcher(snapshot),{file:'unused',persist:async()=>{throw Error('disk full');}});c.state=local();await c.refresh();assert.equal(c.state.delivery.transport,'pages');assert.match(c.cacheWarning,/could not be saved/);
});
test('corrupt gzip and redirected cached source URLs cannot poison memory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pages-invalid-cache-'));try{
  const file=join(dir,'catalog.json');await writeFile(file,Buffer.from([0x1f,0x8b,0,0]));const c=client(()=>{}, {file});await c.load();assert.ok(c.cacheWarning);assert.equal(Object.keys(c.state.entries).length,0);
  const s=local();s.sources.kilo.url='https://evil.invalid';await writeFile(file,JSON.stringify(s));await c.load();assert.equal(Object.keys(c.state.entries).length,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('request and response limits reject SSRF, credential URLs, oversized bodies and stalled readers',async()=>{
 let called=0;await assert.rejects(metadataResponse(async()=>{called++;},'https://evil.invalid',{pages:true}));assert.equal(called,0);
 let cancelled=false;const c=client(async()=>({status:200,body:{getReader:()=>({read:async()=>({done:false,value:{byteLength:33*1024*1024}}),cancel:async()=>{cancelled=true;}})}}));await c.refresh();assert.equal(cancelled,true);assert.equal(c.lastRefresh.transport,'empty');
 // AbortSignal.timeout is unrefed; keep the fixture process alive through slow setup.
 const hold=setTimeout(()=>{},10000);try{let cancelledReader=false;await assert.rejects(metadataResponse(async()=>({status:200,body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:async()=>{cancelledReader=true;}})}}),PAGES_URL,{pages:true,timeout:10}));assert.ok(cancelledReader);}finally{clearTimeout(hold);}
});
test('ensureFresh, request guards, elapsed time and OVH pacing access never refresh metadata',async()=>{
 let count=0;const c=client(async()=>{count++;return Response.json(snapshot);});await c.refresh();const pacer=c.ovhPacer;for(let i=0;i<4;i++){await c.ensureFresh();c.assertUsable('kilo','thinkingmachines/inkling-small:free');}assert.equal(count,1);assert.equal(c.ovhPacer,pacer);
});
test('new paid Pages evidence overrides local free history instead of unioning free lists',async()=>{
 const data=structuredClone(fixtures);const m=data.kilo.data.find(m=>m.id==='thinkingmachines/inkling-small:free');m.isFree=false;m.pricing={prompt:1,completion:2};const s=await snapshotFixture({data});const c=client(pagesFetcher(s));c.state=local();assert.equal(c.state.entries[entry].classification,'free');await c.refresh();assert.notEqual(c.state.entries[entry].classification,'free');assert.throws(()=>c.assertUsable('kilo','thinkingmachines/inkling-small:free'));
});
test('HTTP-error body cleanup cannot hang the bounded refresh',async()=>{
 let cancelled=false;await assert.rejects(metadataResponse(async()=>({status:503,body:{cancel:()=>{cancelled=true;return new Promise(()=>{});}}}),PAGES_URL,{pages:true,timeout:10}),/503/);assert.ok(cancelled);
});

test('metadata User-Agent version follows the prepared release manifest without credentials',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));let seen;
 await metadataResponse(async(url,init)=>{seen=init;return Response.json({ok:true});},PAGES_URL,{pages:true});
 assert.equal(seen.headers['user-agent'],`pi-free-catalog/${pkg.version}`);assert.equal(seen.credentials,'omit');assert.equal(seen.headers.authorization,undefined);
});
