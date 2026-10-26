import { deploymentURL } from './deployment-path.mjs';
// Backend transport/collector. Contract semantics are shared with the shipped client.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SOURCES, reconcile, summary } from '../../src/catalog.js';
import { REPOSITORY, PREVIOUS_URL, MAX_SOURCE_BYTES, MAX_SNAPSHOT_BYTES, SOURCE_NAMES, sha256, canonical, dataHash, normalize, timestamp, rulesHash, project, rowCount, asState, seal, validateSnapshot } from '../../src/snapshot-contract.js';
export { SOURCES };
export { REPOSITORY, PREVIOUS_URL, MAX_SOURCE_BYTES, MAX_SNAPSHOT_BYTES, SOURCE_NAMES, sha256, canonical, dataHash, normalize, timestamp, rulesHash, project, rowCount, asState, seal, validateSnapshot } from '../../src/snapshot-contract.js';
export class FetchFailure extends Error {
  constructor(code, httpStatus = null) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
export async function readJSON(url, { fetcher = globalThis.fetch, maxBytes = MAX_SOURCE_BYTES, timeoutMs = 20000, cacheBust = false } = {}) {
  assert.ok(Object.values(SOURCES).includes(url) || url === PREVIOUS_URL, 'URL outside fixed allowlist');
  assert.ok(!cacheBust || url === PREVIOUS_URL, 'Cache busting is limited to the fixed Pages endpoint');
  // Cache-Control alone does not evict an already-warm GitHub Pages CDN entry.
  // Only this backend-generated UUID query is permitted; callers cannot supply a URL/query.
  return readAllowedJSON(url, {fetcher,maxBytes,timeoutMs,cacheBust});
}
export async function readDeploymentJSON({ runId, expected, fetcher = globalThis.fetch, timeoutMs = 20000 } = {}) {
  return readAllowedJSON(deploymentURL(runId,expected), {fetcher,maxBytes:MAX_SNAPSHOT_BYTES,timeoutMs,cacheBust:true});
}
async function readAllowedJSON(url, {fetcher,maxBytes,timeoutMs,cacheBust}) {
  const requestURL = cacheBust ? url + '?catalog_read=' + randomUUID() : url;
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try { response = await fetcher(requestURL, { method: 'GET', redirect: 'error', cache: 'no-store', signal, headers: { accept:'application/json','cache-control':'no-cache','user-agent':'pi-free-catalog-backend/1' } }); }
  catch { throw new FetchFailure(signal.aborted ? 'timeout' : 'network'); }
  if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw new FetchFailure('http', response.status); }
  const reader = response.body?.getReader(); if (!reader) throw new FetchFailure('json');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maxBytes) throw new FetchFailure('size'); chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof FetchFailure ? error : new FetchFailure(signal.aborted ? 'timeout' : 'network');
  }
  const body = Buffer.concat(chunks);
  try { return { data:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)), bodySha256:sha256(body) }; }
  catch { throw new FetchFailure('json'); }
}
export async function loadPrevious({ bootstrap = false, fetcher = globalThis.fetch, now = Date.now(), expectedRules } = {}) {
  try {
    const { data } = await readJSON(PREVIOUS_URL,{fetcher,maxBytes:MAX_SNAPSHOT_BYTES,cacheBust:true});
    assert.ok(!bootstrap, 'Bootstrap is forbidden when a previous snapshot exists');
    return validateSnapshot(data,{now,expectedRules});
  } catch (error) {
    if (bootstrap && error instanceof FetchFailure && error.httpStatus === 404) return null;
    throw error; // Never silently cold-start after corruption, network errors, incompatible rules or HTTP 5xx.
  }
}
export function largeChanges(previous, sources, state, now) {
  if (!previous) return [];
  const changes = [];
  for (const name of SOURCE_NAMES) {
    const before = previous.sources[name].rowCount, after = sources[name].rowCount;
    if (after < before / 2) changes.push({kind:'source-rows',name,before,after});
  }
  // Apply already-known deadlines at the current time before comparing eligibility counts.
  const baseline = summary(reconcile(previous.sources, asState(previous), now));
  const next = summary(state);
  for (const name of ['kilo','zen','ovh']) if (baseline[name].free > 0 && next[name].free < baseline[name].free / 2)
    changes.push({kind:'eligible-models',name,before:baseline[name].free,after:next[name].free});
  return changes;
}
export async function collect({ previous = null, now = new Date().toISOString(), fetcher = globalThis.fetch, producer, expectedRules, allowLargeChanges = false } = {}) {
  timestamp(now); assert.ok(expectedRules, 'Missing rule fingerprint');
  if (previous) { validateSnapshot(previous,{now:Date.parse(now),expectedRules}); assert.ok(timestamp(previous.generatedAt) <= timestamp(now), 'Time moved backwards'); }
  const sources = Object.fromEntries(await Promise.all(SOURCE_NAMES.map(async name => {
    try {
      const response = await readJSON(SOURCES[name],{fetcher});
      let data; try { data = project(name,response.data); } catch { throw new FetchFailure('source'); }
      return [name,{url:SOURCES[name],fresh:true,status:'fresh',fetchedAt:now,attemptedAt:now,data,dataSha256:dataHash(data),bodySha256:response.bodySha256,rowCount:rowCount(name,data),failure:null,consecutiveFailures:0,firstFailureAt:null}];
    } catch (error) {
      const prior = previous?.sources[name];
      const failure = error instanceof FetchFailure ? {code:error.code,httpStatus:error.httpStatus} : {code:'source',httpStatus:null};
      if (!prior) return [name,{missing:true,failure}];
      return [name,{...structuredClone(prior),fresh:false,status:'retained',attemptedAt:now,failure,consecutiveFailures:prior.consecutiveFailures+1,firstFailureAt:prior.firstFailureAt || now}];
    }
  })));
  const missing=Object.entries(sources).filter(([,s])=>s.missing);
  if(missing.length){const error=new Error('No last-known-good; bootstrap requires all sources');error.details=Object.fromEntries(missing.map(([name,s])=>[name,s.failure]));throw error;}
  const fresh = Object.values(sources).filter(s => s.fresh).length; assert.ok(fresh > 0, 'All sources failed; preserve previous deployment');
  const state = reconcile(sources,previous ? asState(previous) : {},now);
  const changes = largeChanges(previous,sources,state,now);
  const snapshot = seal({schemaVersion:1,generatedAt:now,producer,rulesHash:expectedRules,sources,catalog:{entries:state.entries,changes:state.changes,history:state.history},summary:summary(state),quality:{status:fresh===SOURCE_NAMES.length?'fresh':'degraded',freshSources:fresh,retainedSources:SOURCE_NAMES.length-fresh,largeChanges:changes,largeChangesApproved:allowLargeChanges}});
  if (changes.length && !allowLargeChanges) {
    const error = new Error('Large source/eligibility decline: review rejected-candidate.json before manual approval'); error.candidate=snapshot; throw error;
  }
  return validateSnapshot(snapshot,{expectedRules,now:Date.parse(now)});
}
