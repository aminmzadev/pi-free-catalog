import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { reconcile, summary } from '../../src/catalog.js';
import { collect, loadPrevious, readJSON, validateSnapshot, seal, canonical, project, dataHash, sha256, rulesHash, asState, SOURCE_NAMES, SOURCES, PREVIOUS_URL, REPOSITORY, FetchFailure } from '../catalog/core.mjs';
const files={kilo:'kilo',zen:'opencode',official:'opencode-capabilities',modelsdev:'models-dev',pi:'pi-opencode-catalog',ovh:'ovh-models',ovhmeta:'ovh-catalog'};
const fixtures=Object.fromEntries(await Promise.all(Object.entries(files).map(async([name,file])=>[name,JSON.parse(gunzipSync(await readFile(new URL('../../test/fixtures/'+file+'.json.gz',import.meta.url))))])));
const now='2026-10-22T00:00:00.000Z',later='2026-10-22T01:00:00.000Z';
const producer={repository:REPOSITORY,workflow:'catalog.yml',commit:'a'.repeat(40),runId:null};
const rules=await rulesHash();
function fetcher(overrides={}){return async(url,init)=>{
 assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.ok(init.signal);assert.deepEqual(Object.keys(init.headers).sort(),['accept','cache-control','user-agent']);
 const name=SOURCE_NAMES.find(n=>SOURCES[n]===url);assert.ok(name,'No unapproved URL or inference request');
 if(Object.hasOwn(overrides,name))return overrides[name](init);
 return Response.json(fixtures[name]);
};}
const build=(options={})=>collect({now,producer,expectedRules:rules,fetcher:fetcher(),...options});
const baseline=await build();

test('bootstrap snapshot is self-contained, valid and uses existing exact reconciliation',()=>{
 assert.equal(baseline.quality.status,'fresh');assert.equal(baseline.quality.freshSources,7);
 const directSources=Object.fromEntries(SOURCE_NAMES.map(name=>[name,{url:SOURCES[name],fresh:true,fetchedAt:now,data:fixtures[name]}]));
 const direct=reconcile(directSources,{},now);
 assert.equal(canonical(direct.entries),canonical(baseline.catalog.entries));assert.deepEqual(summary(direct),baseline.summary);
 assert.equal(validateSnapshot(baseline,{expectedRules:rules,now:Date.parse(now)}),baseline);
});
test('complete OpenCode slices are preserved; unrelated registry providers alone are projected out',()=>{
 for(const name of ['official','modelsdev']){
  const input={...fixtures[name],unrelated:{models:{arbitrary:{}}}};
  assert.deepEqual(project(name,input),{opencode:{models:fixtures[name].opencode.models}});
  assert.deepEqual(Object.keys(baseline.sources[name].data.opencode.models),Object.keys(fixtures[name].opencode.models).sort());
 }
});
test('all listed inventory IDs are represented, not just free/chat/tool models',()=>{
 for(const name of ['kilo','zen','ovh'])for(const row of fixtures[name].data)assert.ok(baseline.catalog.entries[JSON.stringify([name,row.id])]);
 assert.equal(baseline.catalog.entries[JSON.stringify(['zen','jev-1.13-free'])].type,'classifier');
});
for(const name of SOURCE_NAMES)test('network failure retains complete last-known-good source: '+name,async()=>{
 const next=await build({previous:baseline,now:later,fetcher:fetcher({[name]:()=>{throw Error('offline');}})});
 const source=next.sources[name];assert.equal(source.status,'retained');assert.equal(source.fresh,false);assert.equal(source.fetchedAt,now);assert.equal(source.attemptedAt,later);assert.equal(source.dataSha256,baseline.sources[name].dataSha256);assert.equal(source.bodySha256,baseline.sources[name].bodySha256);assert.deepEqual(source.data,baseline.sources[name].data);assert.equal(source.failure.code,'network');assert.equal(source.consecutiveFailures,1);
 assert.deepEqual(Object.keys(next.catalog.entries),Object.keys(baseline.catalog.entries));assert.deepEqual(next.summary,baseline.summary);assert.equal(next.quality.status,'degraded');
});
for(const [label,response,code]of[
 ['malformed JSON',()=>new Response('{'),'json'],['HTML',()=>new Response('<html>Error</html>'),'json'],['empty list',()=>Response.json({data:[]}),'source'],['HTTP 429',()=>new Response(null,{status:429}),'http'],['HTTP 503',()=>new Response(null,{status:503}),'http'],['duplicate IDs',()=>Response.json({data:[{id:'same'},{id:'same'}]}),'source'],['missing IDs',()=>Response.json({data:[{}]}),'source'],
])test('invalid upstream data retains LKG: '+label,async()=>{
 const next=await build({previous:baseline,now:later,fetcher:fetcher({kilo:response})});assert.equal(next.sources.kilo.failure.code,code);assert.equal(next.sources.kilo.dataSha256,baseline.sources.kilo.dataSha256);assert.deepEqual(next.summary.kilo,baseline.summary.kilo);
});
test('repeated failures keep original fetchedAt and firstFailureAt; successful recovery resets failure state',async()=>{
 const fail=fetcher({ovhmeta:()=>new Response(null,{status:500})});
 const one=await build({previous:baseline,now:later,fetcher:fail});
 const two=await build({previous:one,now:'2026-10-22T02:00:00.000Z',fetcher:fail});
 assert.equal(two.sources.ovhmeta.consecutiveFailures,2);assert.equal(two.sources.ovhmeta.firstFailureAt,later);assert.equal(two.sources.ovhmeta.fetchedAt,now);
 const recovered=await build({previous:two,now:'2026-10-22T03:00:00.000Z'});assert.equal(recovered.sources.ovhmeta.consecutiveFailures,0);assert.equal(recovered.sources.ovhmeta.firstFailureAt,null);assert.equal(recovered.sources.ovhmeta.failure,null);
});
test('first deployment cannot seed missing sources from test fixtures or an empty state',async()=>await assert.rejects(build({fetcher:fetcher({zen:()=>{throw Error('offline');}})}),/No last-known-good/));
test('all upstream failures block publication instead of refreshing a stale generatedAt',async()=>await assert.rejects(build({previous:baseline,now:later,fetcher:async()=>{throw Error('offline');}}),/All sources failed/));
test('known lifecycle deadlines still apply after a metadata failure; no fabricated freshness',async()=>{
 const future='2026-11-06T00:00:00.000Z';
 const next=await build({previous:baseline,now:future,fetcher:fetcher({ovhmeta:()=>{throw Error('offline');}})});
 const entry=next.catalog.entries[JSON.stringify(['ovh','Mistral-Nemo-Instruct-2407'])];
 // All production lifecycle decisions must match reconciliation at the actual generation time.
 assert.equal(canonical(reconcile(next.sources,asState(baseline),future).entries),canonical(next.catalog.entries));
 assert.ok(Object.values(next.catalog.entries).some(e=>e.service==='ovh'&&e.lifecycle==='retired'));
 assert.equal(next.sources.ovhmeta.fetchedAt,now);assert.equal(next.quality.largeChanges.length,0);
 void entry;
});
test('a large valid inventory decline is quarantined, never mistaken for invalid JSON or silently deployed',async()=>{
 const reduced={...fixtures.kilo,data:fixtures.kilo.data.slice(0,1)};
 await assert.rejects(build({previous:baseline,now:later,fetcher:fetcher({kilo:()=>Response.json(reduced)})}),error=>Boolean(error.candidate&&error.candidate.quality.largeChanges.some(c=>c.kind==='source-rows'&&c.name==='kilo')));
 const approved=await build({previous:baseline,now:later,allowLargeChanges:true,fetcher:fetcher({kilo:()=>Response.json(reduced)})});assert.equal(approved.quality.largeChangesApproved,true);assert.equal(approved.sources.kilo.rowCount,1);
 for(const key of Object.keys(baseline.catalog.entries))assert.ok(approved.catalog.entries[key],'Historical ID must remain auditable');
});
test('large free-eligibility changes need review even when row counts remain stable',async()=>{
 const paid=structuredClone(fixtures.kilo);for(const row of paid.data){row.isFree=false;row.pricing={prompt:'1',completion:'1'};}
 await assert.rejects(build({previous:baseline,now:later,fetcher:fetcher({kilo:()=>Response.json(paid)})}),error=>Boolean(error.candidate?.quality.largeChanges.some(c=>c.kind==='eligible-models'&&c.name==='kilo')));
});
for(const [label,change]of[
 ['unsupported version',s=>s.schemaVersion=2],['future timestamp',s=>s.generatedAt='2099-01-01T00:00:00.000Z'],['missing source',s=>delete s.sources.zen],['wrong source URL',s=>s.sources.kilo.url='https://evil.invalid'],['tampered source',s=>s.sources.kilo.data.data[0].id='tampered'],['tampered data hash',s=>s.sources.kilo.dataSha256='0'.repeat(64)],['fake freshness',s=>s.sources.kilo.fetchedAt=later],['wrong summary',s=>s.summary.kilo.free++],['omitted model',s=>delete s.catalog.entries[Object.keys(s.catalog.entries)[0]]],['wrong producer',s=>s.producer.repository='fork/else'],['extra field',s=>s.unexpected=true],['history overflow',s=>s.catalog.history=Array(2001).fill({})],
])test('snapshot validator rejects '+label,()=>{const snapshot=structuredClone(baseline);change(snapshot);assert.throws(()=>validateSnapshot(seal(snapshot),{expectedRules:rules,now:Date.parse(now)}));});
test('snapshot integrity rejects tampering even when individual source data is unchanged',()=>{const s=structuredClone(baseline);s.producer.commit='b'.repeat(40);assert.throws(()=>validateSnapshot(s,{expectedRules:rules,now:Date.parse(now)}),/integrity/);});
test('rules mismatch fails closed until an explicit contract/rules migration',()=>assert.throws(()=>validateSnapshot(baseline,{expectedRules:'b'.repeat(64),now:Date.parse(now)}),/migration/));
test('time cannot move backwards between successful deployments',async()=>await assert.rejects(build({previous:baseline,now:'2026-10-21T00:00:00.000Z'})));
for(const status of [401,403,429,500,503])test('previous snapshot HTTP '+status+' cannot be treated as bootstrap',async()=>await assert.rejects(loadPrevious({bootstrap:true,expectedRules:rules,fetcher:async()=>new Response(null,{status})})));
test('only explicit bootstrap plus HTTP404 permits a first deployment',async()=>{
 const missing=async()=>new Response(null,{status:404});assert.equal(await loadPrevious({bootstrap:true,fetcher:missing}),null);await assert.rejects(loadPrevious({fetcher:missing}));
});
test('bootstrap cannot overwrite a live snapshot; normal reads validate it',async()=>{
 const fetcher=async url=>{const parsed=new URL(url);assert.equal(parsed.origin+parsed.pathname,PREVIOUS_URL);assert.deepEqual([...parsed.searchParams.keys()],['catalog_read']);assert.match(parsed.searchParams.get('catalog_read'),/^[a-f0-9-]{36}$/);return Response.json(baseline);};
 await assert.rejects(loadPrevious({bootstrap:true,expectedRules:rules,fetcher,now:Date.parse(later)}),/Bootstrap is forbidden/);
 assert.equal((await loadPrevious({expectedRules:rules,fetcher,now:Date.parse(later)})).integrity.payloadHash,baseline.integrity.payloadHash);
});
test('corrupt/malformed previous snapshot cannot be silently discarded',async()=>{
 for(const fetcher of [async()=>new Response('{'),async()=>Response.json({schemaVersion:999}),async()=>{throw Error('offline');}])await assert.rejects(loadPrevious({bootstrap:true,expectedRules:rules,fetcher}));
});
test('network transport bounds decoded body size and rejects invalid UTF8',async()=>{
 await assert.rejects(readJSON(SOURCES.zen,{maxBytes:3,fetcher:async()=>new Response('1234')}),e=>e instanceof FetchFailure&&e.code==='size');
 await assert.rejects(readJSON(SOURCES.zen,{fetcher:async()=>new Response(new Uint8Array([0xff]))}),e=>e.code==='json');
});
test('timeouts are distinguished from other network failures',async()=>{
 const keepAlive=setTimeout(()=>{},100);
 try{await assert.rejects(readJSON(SOURCES.zen,{timeoutMs:5,fetcher:async(url,{signal})=>await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}),e=>e.code==='timeout');}finally{clearTimeout(keepAlive);}
});
test('SSRF/credential/query URL variants fail before any request',async()=>{
 for(const url of ['http://127.0.0.1','https://registry.npmjs.org','https://user:secret@api.kilo.ai/api/gateway/models',PREVIOUS_URL+'?reset=1'])await assert.rejects(readJSON(url,{fetcher:()=>{throw Error('must not fetch');}}),/allowlist/);
});
test('hashes are deterministic and full OpenCode projection has its own payload identity',()=>{
 assert.equal(canonical({b:1,a:2}),canonical({a:2,b:1}));assert.equal(dataHash({a:2,b:1}),dataHash({b:1,a:2}));assert.equal(sha256('abc').length,64);
});
test('published JSON schema and handwritten semantic validator agree on envelope/source fields',async()=>{
 const schema=JSON.parse(await readFile(new URL('../catalog/schema-v1.json',import.meta.url),'utf8'));
 assert.equal(schema.properties.schemaVersion.const,1);assert.deepEqual([...schema.required].sort(),Object.keys(baseline).sort());assert.equal(schema.additionalProperties,false);
});
test('JSON schema source URLs/required fields match all real snapshot sources',async()=>{
 const schema=JSON.parse(await readFile(new URL('../catalog/schema-v1.json',import.meta.url),'utf8'));
 for(const name of SOURCE_NAMES){assert.equal(schema.properties.sources.properties[name].allOf[1].properties.url.const,SOURCES[name]);assert.deepEqual([...schema.$defs.source.required].sort(),Object.keys(baseline.sources[name]).sort());}
});
test('response body failures cancel the stream and do not publish partial JSON',async()=>{
 let cancelled=false;
 const body={getReader:()=>({read:async()=>{throw Error('connection reset');},cancel:async()=>{cancelled=true;}})};
 await assert.rejects(readJSON(SOURCES.zen,{fetcher:async()=>({status:200,body})}),e=>e.code==='network');assert.equal(cancelled,true);
});
test('declared source failures cannot be overridden by large-change approval during bootstrap',async()=>{
 await assert.rejects(build({allowLargeChanges:true,fetcher:fetcher({ovhmeta:()=>Response.json([])})}),/No last-known-good/);
});
test('producer fields and all-failed/fake source bookkeeping are validated independently of payload hash',()=>{
 for(const change of [s=>s.producer.commit+='\n',s=>s.producer.runId=42,s=>{s.sources.zen.status='retained';},s=>{s.sources.zen.consecutiveFailures=1;},s=>{s.sources.zen.failure={code:'http',httpStatus:500};}]){const s=structuredClone(baseline);change(s);assert.throws(()=>validateSnapshot(seal(s),{expectedRules:rules,now:Date.parse(now)}));}
});
test('source row limits bound reconciliation work and cannot be bypassed by review approval',()=>{
 assert.throws(()=>project('zen',{data:Array.from({length:10001},(_,i)=>({id:'model-'+i}))}),/safety limit/);
 assert.throws(()=>project('ovh',{data:Array.from({length:2001},(_,i)=>({id:'model-'+i}))}),/safety limit/);
});
test('recovery reads bypass a warm CDN using unique backend-generated query keys only',async()=>{
 const seen=[];
 const edge=async(url,init)=>{
  const parsed=new URL(url);assert.equal(parsed.origin+parsed.pathname,PREVIOUS_URL);assert.equal(init.cache,'no-store');assert.equal(init.headers['cache-control'],'no-cache');
  assert.deepEqual([...parsed.searchParams.keys()],['catalog_read']);const nonce=parsed.searchParams.get('catalog_read');assert.match(nonce,/^[a-f0-9-]{36}$/);seen.push(nonce);return Response.json(baseline);
 };
 await loadPrevious({expectedRules:rules,fetcher:edge,now:Date.parse(later)});await loadPrevious({expectedRules:rules,fetcher:edge,now:Date.parse(later)});assert.equal(new Set(seen).size,2);
 await assert.rejects(readJSON(SOURCES.zen,{cacheBust:true,fetcher:edge}),/limited/);
});
