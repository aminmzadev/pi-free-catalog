// Shared, data-only snapshot contract. No fetching, execution or CI dependencies.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SOURCES, validateSource, validateState, reconcile, summary, modelRows } from './catalog.js';
export { SOURCES };
export const REPOSITORY = 'aminmzadev/pi-free-catalog';
export const PREVIOUS_URL = 'https://aminmzadev.github.io/pi-free-catalog/catalog/v2/latest.json';
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
  return dataHash(await Promise.all(files.map(async name => [name, sha256(await readFile(new URL('./' + name, import.meta.url)))])));
}
export function project(name, value) {
  validateSource(name, value);
  assert.ok(rowCount(name,value) <= (name === 'ovh' || name === 'ovhmeta' ? 2000 : 10000),'Source row count exceeds safety limit');
  return normalize(value);
}
export function rowCount(name, data) {
  return name === 'ovhmeta' ? data.length : modelRows(data).length;
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
  assert.equal(snapshot.schemaVersion, 2, 'Unsupported snapshot version');
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
  for (const source of ['kilo','ovh']) for (const row of modelRows(snapshot.sources[source].data)) {
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
    assert.ok(change.kind === 'source-rows' ? SOURCE_NAMES.includes(change.name) : ['kilo','ovh'].includes(change.name));
    assert.ok(Number.isSafeInteger(change.before) && change.before > 0 && Number.isSafeInteger(change.after) && change.after >= 0 && change.after < change.before / 2);
  }
  assert.ok(!snapshot.quality.largeChanges.length || snapshot.quality.largeChangesApproved, 'Large change requires manual review');
  keys(snapshot.integrity, ['algorithm','payloadHash'], 'integrity'); assert.equal(snapshot.integrity.algorithm, 'sha256');
  const payload = { ...snapshot }; delete payload.integrity;
  assert.equal(snapshot.integrity.payloadHash, dataHash(payload), 'Snapshot integrity mismatch');
  assert.ok(Buffer.byteLength(canonical(snapshot)) <= MAX_SNAPSHOT_BYTES, 'Snapshot exceeds size limit');
  return snapshot;
}
