import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {loadPrevious,collect,rulesHash,PREVIOUS_URL,canonical,seal,SOURCES,validateSnapshot} from '../catalog/core.mjs';
import {LEGACY_URL,LEGACY_RULES_HASH,migrateLegacySnapshot} from '../../src/legacy-snapshot.js';
import {snapshotFixture} from '../../test/snapshot-helper.mjs';
import {fixtures} from '../../test/helpers.mjs';
const old=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/legacy-v1-snapshot.json.gz',import.meta.url))));
const rules=await rulesHash(),now=Date.parse('2026-10-22T01:00:00Z');
function edge({currentStatus=404,legacy=old,legacyStatus=200,current}={}){
 const seen=[];return {seen,fetcher:async(url,init)=>{const u=new URL(url),target=u.origin+u.pathname;seen.push(target);assert.deepEqual([...u.searchParams.keys()],['catalog_read']);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,undefined);if(target===PREVIOUS_URL)return current?Response.json(current):new Response(null,{status:currentStatus});assert.equal(target,LEGACY_URL);return legacyStatus===200?Response.json(legacy):new Response(null,{status:legacyStatus});}};
}
test('missing v2 migrates the reviewed v1 history without bootstrap or fake freshness',async()=>{
 const x=edge(),prior=await loadPrevious({expectedRules:rules,now,fetcher:x.fetcher});assert.deepEqual(x.seen,[PREVIOUS_URL,LEGACY_URL]);assert.equal(prior.schemaVersion,2);assert.equal(prior.generatedAt,old.generatedAt);assert.equal(prior.sources.kilo.fetchedAt,old.sources.kilo.fetchedAt);assert.deepEqual(prior.catalog.history,old.catalog.history.filter(e=>e.service!=='zen'));validateSnapshot(prior,{expectedRules:rules,now});
 const next=await collect({previous:prior,expectedRules:rules,now:new Date(now).toISOString(),producer:{...old.producer,runId:'99999'},fetcher:async url=>{const name=Object.keys(SOURCES).find(k=>SOURCES[k]===url);assert.ok(name);if(name==='kilo')throw Error('offline');return Response.json(fixtures[name]);}});
 assert.equal(next.sources.kilo.fresh,false);assert.equal(next.sources.kilo.fetchedAt,old.sources.kilo.fetchedAt);assert.deepEqual(next.sources.kilo.data,old.sources.kilo.data);assert.ok(next.catalog.history.some(e=>canonical(e)===canonical(old.catalog.history.find(e=>e.service==='kilo'))));
});
test('existing valid v2 never queries a legacy feed',async()=>{const current=await snapshotFixture(),x=edge({current});await loadPrevious({expectedRules:rules,now,fetcher:x.fetcher});assert.deepEqual(x.seen,[PREVIOUS_URL]);});
for(const status of [401,403,429,500,503])test('v2 HTTP '+status+' never falls back to old rules or resets history',async()=>{const x=edge({currentStatus:status});await assert.rejects(loadPrevious({expectedRules:rules,now,fetcher:x.fetcher}));assert.deepEqual(x.seen,[PREVIOUS_URL]);});
test('invalid existing v2 never falls back to a valid legacy snapshot',async()=>{const x=edge({current:{schemaVersion:999}});await assert.rejects(loadPrevious({expectedRules:rules,now,fetcher:x.fetcher}));assert.deepEqual(x.seen,[PREVIOUS_URL]);});
test('a legacy deployment forbids bootstrap; both missing still require explicit bootstrap',async()=>{
 const x=edge();await assert.rejects(loadPrevious({bootstrap:true,expectedRules:rules,now,fetcher:x.fetcher}),/Bootstrap is forbidden/);
 for(const bootstrap of [false,true]){const x=edge({legacyStatus:404});if(bootstrap)assert.equal(await loadPrevious({bootstrap,expectedRules:rules,now,fetcher:x.fetcher}),null);else await assert.rejects(loadPrevious({bootstrap,expectedRules:rules,now,fetcher:x.fetcher}));}
});
test('resealing corrupt remaining-model semantics or an unreviewed old fingerprint cannot authorize migration',()=>{
 for(const mutate of [s=>s.rulesHash='a'.repeat(64),s=>Object.values(s.catalog.entries).find(e=>e.service==='kilo'&&e.classification==='free').classification='paid',s=>s.sources.kilo.url='https://evil.invalid',s=>s.summary.kilo.free++]){const value=structuredClone(old);mutate(value);assert.throws(()=>migrateLegacySnapshot(seal(value),{expectedRules:rules,now}));}
 assert.equal(old.rulesHash,LEGACY_RULES_HASH);
});
test('migration never publishes a v1 path or reconnects the removed sources',async()=>{
 const collector=await readFile(new URL('../catalog/collect.mjs',import.meta.url),'utf8');assert.ok(!collector.includes('catalog/v1'));assert.ok(collector.includes('catalog/v2'));
 assert.deepEqual(Object.keys(SOURCES).sort(),['kilo','ovh','ovhmeta']);
});
