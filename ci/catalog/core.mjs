// Repository-only backend. The extension does not import this module.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SOURCES, validateSource, validateState, reconcile, summary, modelRows } from '../../src/catalog.js';
export { SOURCES };
export const REPOSITORY = 'aminmzadev/pi-free-catalog';
export const PREVIOUS_URL = 'https://aminmzadev.github.io/pi-free-catalog/catalog/v1/latest.json';
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const SOURCE_NAMES = Object.keys(SOURCES).sort();
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  const clean = JSON.parse(JSON.stringify(value));
  const sort = (v, depth = 0) => {
    assert.ok(depth <= 80, 'JSON nesting exceeds limit');
    if (Array.isArray(v)) return v.map(x => sort(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k], depth + 1)]));
    return v;
  };
  return JSON.stringify(sort(clean));
}
export const dataHash = value => sha256(canonical(value));
export const normalize = value => JSON.parse(canonical(value));
function keys(value, expected, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `Unexpected ${label} fields`);
}
export function timestamp(value) {
  assert.equal(typeof value, 'string');
  assert.ok(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'Timestamp must be canonical UTC');
  return Date.parse(value);
}
export async function rulesHash() {
  const files = ['catalog.js', 'lifecycle.js', 'ovh.js'];
  return dataHash(await Promise.all(files.map(async name => [name, sha256(await readFile(new URL('../../src/' + name, import.meta.url)))])));
}
export function project(name, value) {
  validateSource(name, value);
  assert.ok(rowCount(name,value) <= (name === 'ovh' || name === 'ovhmeta' ? 2000 : 10000),'Source row count exceeds safety limit');
  // The production reconciler only reads this complete provider slice. No eligible OpenCode IDs are filtered.
  return normalize(['official', 'modelsdev'].includes(name) ? { opencode: { models: value.opencode.models } } : value);
}
export function rowCount(name, data) {
  return ['official', 'modelsdev'].includes(name) ? Object.keys(data.opencode.models).length : name === 'ovhmeta' ? data.length : modelRows(data).length;
}
export function asState(snapshot) {
  return { schemaVersion: 1, refreshedAt: snapshot.generatedAt, sources: snapshot.sources, ...snapshot.catalog };
}
export function seal(snapshot) {
  const clean = normalize(snapshot); delete clean.integrity;
  return { ...clean, integrity: { algorithm: 'sha256', payloadHash: dataHash(clean) } };
}
export function validateSnapshot(snapshot, { expectedRules, now = Date.now() } = {}) {
  keys(snapshot, ['schemaVersion','generatedAt','producer','rulesHash','sources','catalog','summary','quality','integrity'], 'snapshot');
  assert.equal(snapshot.schemaVersion, 1, 'Unsupported snapshot version');
  const generated = timestamp(snapshot.generatedAt);
  assert.ok(generated <= now + 300000, 'Snapshot is from the future');
  keys(snapshot.producer, ['repository','workflow','commit','runId'], 'producer');
  assert.equal(snapshot.producer.repository, REPOSITORY); assert.equal(snapshot.producer.workflow, 'catalog.yml');
  assert.equal(typeof snapshot.producer.commit,'string'); assert.equal(snapshot.producer.commit.length,40);
  assert.match(snapshot.producer.commit, /^[a-f0-9]{40}$/);
  assert.ok(snapshot.producer.runId === null || (typeof snapshot.producer.runId === 'string' && /^[1-9][0-9]*$(?![\s\S])/.test(snapshot.producer.runId)));
  assert.equal(typeof snapshot.rulesHash,'string'); assert.equal(snapshot.rulesHash.length,64);
  assert.match(snapshot.rulesHash, /^[a-f0-9]{64}$/);
  if (expectedRules) assert.equal(snapshot.rulesHash, expectedRules, 'Rules migration requires explicit review');
  keys(snapshot.sources, SOURCE_NAMES, 'sources');
  let fresh = 0;
  for (const name of SOURCE_NAMES) {
    const source = snapshot.sources[name];
    keys(source, ['url','fresh','status','fetchedAt','attemptedAt','data','dataSha256','bodySha256','rowCount','failure','consecutiveFailures','firstFailureAt'], `source ${name}`);
    assert.equal(source.url, SOURCES[name]); assert.equal(typeof source.fresh, 'boolean');
    assert.equal(source.status, source.fresh ? 'fresh' : 'retained');
    const fetched = timestamp(source.fetchedAt), attempted = timestamp(source.attemptedAt);
    assert.ok(fetched <= generated && attempted === generated, 'Source timestamp mismatch');
    validateSource(name, source.data); assert.equal(canonical(project(name, source.data)), canonical(source.data), 'Source is not normalized');
    assert.equal(source.dataSha256, dataHash(source.data)); assert.equal(typeof source.bodySha256,'string'); assert.equal(source.bodySha256.length,64); assert.match(source.bodySha256, /^[a-f0-9]{64}$/);
    assert.equal(source.rowCount, rowCount(name, source.data));
    assert.ok(Number.isSafeInteger(source.consecutiveFailures) && source.consecutiveFailures >= 0);
    if (source.fresh) {
      fresh++; assert.equal(fetched, generated); assert.equal(source.failure, null); assert.equal(source.firstFailureAt, null); assert.equal(source.consecutiveFailures, 0);
    } else {
      assert.ok(source.consecutiveFailures > 0); assert.ok(timestamp(source.firstFailureAt) >= fetched && timestamp(source.firstFailureAt) <= generated);
      keys(source.failure, ['code','httpStatus'], 'failure');
      assert.ok(['network','timeout','http','size','json','source'].includes(source.failure.code));
      assert.ok(source.failure.httpStatus === null || (Number.isInteger(source.failure.httpStatus) && source.failure.httpStatus >= 100 && source.failure.httpStatus <= 599));
    }
  }
  assert.ok(fresh > 0, 'An all-failed run must never deploy');
  keys(snapshot.catalog, ['entries','changes','history'], 'catalog');
  const state = validateState(asState(snapshot));
  assert.ok(Object.keys(state.entries).length > 0 && Object.keys(state.entries).length <= 30000);
  assert.ok(state.history.length <= 2000);
  for (const source of ['kilo','zen','ovh']) for (const row of modelRows(snapshot.sources[source].data)) {
    assert.ok(Object.hasOwn(state.entries, JSON.stringify([source,row.id])), 'Listed ID was omitted');
  }
  // Fixed-point check: the existing production rules must reproduce every stored entry, including stale verdicts/history.
  assert.equal(canonical(reconcile(snapshot.sources, state, snapshot.generatedAt).entries), canonical(state.entries), 'Reconciliation mismatch');
  assert.equal(canonical(snapshot.summary), canonical(summary(state)), 'Summary mismatch');
  keys(snapshot.quality, ['status','freshSources','retainedSources','largeChanges','largeChangesApproved'], 'quality');
  assert.equal(snapshot.quality.status, fresh === SOURCE_NAMES.length ? 'fresh' : 'degraded');
  assert.equal(snapshot.quality.freshSources, fresh); assert.equal(snapshot.quality.retainedSources, SOURCE_NAMES.length - fresh);
  assert.equal(typeof snapshot.quality.largeChangesApproved, 'boolean');
  assert.ok(Array.isArray(snapshot.quality.largeChanges));
  for (const change of snapshot.quality.largeChanges) {
    keys(change, ['kind','name','before','after'], 'change');
    assert.ok(['source-rows','eligible-models'].includes(change.kind));
    assert.ok(change.kind === 'source-rows' ? SOURCE_NAMES.includes(change.name) : ['kilo','zen','ovh'].includes(change.name));
    assert.ok(Number.isSafeInteger(change.before) && change.before > 0 && Number.isSafeInteger(change.after) && change.after >= 0 && change.after < change.before / 2);
  }
  assert.ok(!snapshot.quality.largeChanges.length || snapshot.quality.largeChangesApproved, 'Large change requires manual review');
  keys(snapshot.integrity, ['algorithm','payloadHash'], 'integrity'); assert.equal(snapshot.integrity.algorithm, 'sha256');
  const payload = { ...snapshot }; delete payload.integrity;
  assert.equal(snapshot.integrity.payloadHash, dataHash(payload), 'Snapshot integrity mismatch');
  assert.ok(Buffer.byteLength(canonical(snapshot)) <= MAX_SNAPSHOT_BYTES, 'Snapshot exceeds size limit');
  return snapshot;
}
export class FetchFailure extends Error {
  constructor(code, httpStatus = null) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
export async function readJSON(url, { fetcher = globalThis.fetch, maxBytes = MAX_SOURCE_BYTES, timeoutMs = 20000, cacheBust = false } = {}) {
  assert.ok(Object.values(SOURCES).includes(url) || url === PREVIOUS_URL, 'URL outside fixed allowlist');
  assert.ok(!cacheBust || url === PREVIOUS_URL, 'Cache busting is limited to the fixed Pages endpoint');
  // Cache-Control alone does not evict an already-warm GitHub Pages CDN entry.
  // Only this backend-generated UUID query is permitted; callers cannot supply a URL/query.
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
