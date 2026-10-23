import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { verifyPublicSnapshot, LIVE_POLICY } from '../catalog/verify-live.mjs';
import { collect, rulesHash, SOURCE_NAMES, SOURCES, PREVIOUS_URL, REPOSITORY, canonical, seal, sha256 } from '../catalog/core.mjs';
const files={kilo:'kilo',zen:'opencode',official:'opencode-capabilities',modelsdev:'models-dev',pi:'pi-opencode-catalog',ovh:'ovh-models',ovhmeta:'ovh-catalog'};
const fixtures=Object.fromEntries(await Promise.all(Object.entries(files).map(async([k,f])=>[k,JSON.parse(gunzipSync(await readFile(new URL('../../test/fixtures/'+f+'.json.gz',import.meta.url))))])));
const rules=await rulesHash(),commit='a'.repeat(40),runId='4242';
const good=await collect({now:'2026-10-22T00:00:00.000Z',producer:{repository:REPOSITORY,workflow:'catalog.yml',commit,runId},expectedRules:rules,fetcher:async url=>{const name=SOURCE_NAMES.find(n=>SOURCES[n]===url);assert.ok(name,'No network URL outside fixture map');return Response.json(fixtures[name]);}});
const bytes=canonical(good)+'\n',expected=sha256(bytes),old=seal({...good,producer:{...good.producer,runId:'4241'}}),oldBytes=canonical(old)+'\n';
function harness(fetcher,extra={}){
 let time=0;const logs=[],sleeps=[],requests=[];
 return {logs,sleeps,requests,run:()=>verifyPublicSnapshot({expected,commit,runId,expectedRules:rules,log:s=>logs.push(s),now:()=>time,sleep:async ms=>{sleeps.push(ms);time+=ms;},fetcher:async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin+u.pathname,PREVIOUS_URL);assert.deepEqual([...u.searchParams.keys()],['catalog_read']);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.ok(init.signal);requests.push({url,init});return fetcher(requests.length,url,init);
 },...extra})};
}
const goodResponse=()=>new Response(bytes,{headers:{'content-type':'application/json','age':'0','x-cache':'MISS'}});

test('fixed production policy fits a three-minute verification budget and does not weaken comparisons',()=>assert.deepEqual(LIVE_POLICY,{attempts:18,intervalMs:10000,budgetMs:180000,requestTimeoutMs:20000}));
test('matching exact bytes/contract/producer/canonical representation succeed immediately',async()=>{
 const h=harness(goodResponse),r=await h.run();assert.equal(r.verified,true);assert.equal(r.attempts.length,1);assert.equal(r.attempts[0].receivedSHA256,expected);assert.deepEqual(r.attempts[0].receivedProducer,{commit,runId});assert.equal(r.reason,'verified');assert.deepEqual(h.sleeps,[]);
});
test('captured incident regression: seven stale responses then correct bytes succeed beyond old six-attempt cutoff',async()=>{
 const h=harness(n=>n<=7?new Response(oldBytes,{headers:{'age':'45','x-cache':'HIT'}}):goodResponse());const r=await h.run();
 assert.equal(r.verified,true);assert.equal(r.attempts.length,8);assert.equal(r.elapsedMs,70000);assert.equal(r.attempts[0].stage,'file-hash');assert.equal(r.attempts[0].receivedSHA256,sha256(oldBytes));assert.equal(r.attempts[0].receivedProducer.runId,'4241');assert.equal(r.attempts[0].headers.age,'45');assert.equal(new Set(h.requests.map(x=>x.url)).size,8);
});
test('permanently stale valid data never becomes success and retries remain bounded',async()=>{
 const h=harness(()=>new Response(oldBytes)),r=await h.run();assert.equal(r.verified,false);assert.equal(r.reason,'attempts-exhausted');assert.equal(r.attempts.length,18);assert.equal(r.elapsedMs,170000);assert.equal(h.sleeps.length,17);assert.ok(r.attempts.every(x=>x.stage==='file-hash'));
});
test('overall budget bounds the final sleep and prevents any further request',async()=>{
 const h=harness(()=>new Response(oldBytes),{policy:{...LIVE_POLICY,budgetMs:25000}}),r=await h.run();assert.equal(r.reason,'budget-exhausted');assert.equal(r.elapsedMs,25000);assert.deepEqual(h.sleeps,[10000,10000,5000]);assert.equal(h.requests.length,3);
});
for(const status of [404,429,500,503])test('temporary HTTP '+status+' is recorded and can recover without redeployment',async()=>{
 const h=harness(n=>n===1?new Response(null,{status}):goodResponse()),r=await h.run();assert.equal(r.verified,true);assert.equal(r.attempts[0].stage,'fetch');assert.equal(r.attempts[0].httpStatus,status);assert.equal(r.attempts[0].error.code,'http');assert.equal(r.attempts.length,2);
});
test('network error details are not dumped into diagnostic logs',async()=>{
 const h=harness(n=>{if(n===1)throw Error('Authorization: SECRET_TOKEN private-response');return goodResponse();}),r=await h.run();assert.equal(r.verified,true);assert.equal(r.attempts[0].error.code,'network');assert.ok(!JSON.stringify(r).includes('SECRET_TOKEN'));assert.ok(!h.logs.join('').includes('SECRET_TOKEN'));
});
test('invalid JSON is distinguished from a hash mismatch',async()=>{
 const h=harness(n=>n===1?new Response('{'):goodResponse()),r=await h.run();assert.equal(r.attempts[0].httpStatus,200);assert.equal(r.attempts[0].stage,'fetch');assert.equal(r.attempts[0].error.code,'json');assert.equal(r.verified,true);
});
test('diagnostics allowlist headers and never expose bodies, cookies or credentials',async()=>{
 const h=harness(()=>new Response(bytes,{headers:{'set-cookie':'SECRET_COOKIE','authorization':'SECRET_AUTH','x-private':'SECRET_PRIVATE','x-cache':'HIT','etag':'"safe"'}})),r=await h.run();assert.deepEqual(r.attempts[0].headers,{'etag':'"safe"','x-cache':'HIT'});for(const secret of ['SECRET_COOKIE','SECRET_AUTH','SECRET_PRIVATE','fixture private body'])assert.ok(!JSON.stringify(r).includes(secret));
});
test('untrusted producer identities are not emitted verbatim',async()=>{
 const body=JSON.stringify({producer:{commit:'secret\nlog injection',runId:'private'}});const h=harness(()=>new Response(body),{policy:{...LIVE_POLICY,attempts:1}}),r=await h.run();assert.deepEqual(r.attempts[0].receivedProducer,{commit:null,runId:null});assert.ok(!JSON.stringify(r).includes('log injection'));
});
for(const [label,data]of[
 ['integrity',{...good,integrity:{algorithm:'sha256',payloadHash:'0'.repeat(64)}}],
 ['schema',{...good,schemaVersion:999}],
 ['rules',seal({...good,rulesHash:'0'.repeat(64)})],
 ['summary',seal({...good,summary:{...good.summary,ovh:{...good.summary.ovh,freeChat:999}}})],
])test('matching bytes do not bypass '+label+' validation',async()=>{
 const body=canonical(data)+'\n',h=harness(()=>new Response(body),{expected:sha256(body),policy:{...LIVE_POLICY,attempts:1}}),r=await h.run();assert.equal(r.verified,false);assert.equal(r.attempts[0].stage,'contract');assert.equal(r.attempts[0].error.code,'validation');
});
for(const [key,value]of [['commit','b'.repeat(40)],['runId','9999']])test('matching valid bytes do not bypass producer '+key,async()=>{
 const h=harness(goodResponse,{[key]:value,policy:{...LIVE_POLICY,attempts:1}}),r=await h.run();assert.equal(r.verified,false);assert.equal(r.attempts[0].stage,'producer');
});
test('matching pretty JSON still fails canonical-byte verification',async()=>{
 const body=JSON.stringify(good,null,2)+'\n';const h=harness(()=>new Response(body),{expected:sha256(body),policy:{...LIVE_POLICY,attempts:1}}),r=await h.run();assert.equal(r.verified,false);assert.equal(r.attempts[0].stage,'canonical-bytes');
});
for(const extra of [{expected:undefined},{expected:'bad'},{commit:'bad'},{runId:null},{runId:'0'}])test('invalid environment fails before fetch: '+Object.keys(extra)[0]+'='+extra[Object.keys(extra)[0]],async()=>{const h=harness(()=>{throw Error('must never fetch');},extra);await assert.rejects(h.run(),/Invalid/);assert.equal(h.requests.length,0);});
test('stalled body is bounded even when a test response ignores abort',async()=>{
 const start=performance.now();const r=await verifyPublicSnapshot({expected,commit,runId,expectedRules:rules,log:()=>{},policy:{attempts:2,intervalMs:10,budgetMs:25,requestTimeoutMs:100},fetcher:async()=>new Response(new ReadableStream({start(){}}))});assert.equal(r.verified,false);assert.equal(r.reason,'budget-exhausted');assert.equal(r.attempts.length,1);assert.equal(r.attempts[0].error.code,'timeout');assert.ok(performance.now()-start<500);
});
