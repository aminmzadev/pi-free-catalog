import test from 'node:test';
import assert from 'node:assert/strict';
import * as live from '../catalog/verify-live.mjs';
import { snapshotFixture } from '../../test/snapshot-helper.mjs';
import { canonical, seal, sha256, rulesHash, PREVIOUS_URL } from '../catalog/core.mjs';

const good = await snapshotFixture();
const bytes = canonical(good) + '\n', expected = sha256(bytes), commit = good.producer.commit, runId = good.producer.runId;
const rules = await rulesHash(), stale = canonical(seal({ ...good, producer: { ...good.producer, runId: '41' } })) + '\n';
const path = PREVIOUS_URL.replace('latest.json', `runs/${runId}/${expected}.json`);
function check(fetcher, extra = {}) {
 let now = 0; const urls = [];
 return { urls, execute: () => live.verifyPublicSnapshot({ expected, commit, runId, expectedRules: rules,
  policy: { attempts: 3, intervalMs: 1, budgetMs: 1000, requestTimeoutMs: 100 },
  now: () => now, sleep: async ms => { now += ms; }, log: () => {},
  fetcher: async (url, init) => { urls.push(url); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, undefined); return fetcher(url, urls.length); }, ...extra }) };
}

test('run-specific proof is fetched independently of stale latest.json', async () => {
 const h = check(url => new Response(new URL(url).pathname.includes('/runs/') ? bytes : stale), { target: 'deployment' });
 const result = await h.execute(); assert.equal(result.verified, true); assert.equal(result.endpoint, path); assert.equal(h.urls.length, 1);
 assert.equal(new URL(h.urls[0]).origin + new URL(h.urls[0]).pathname, path);
});
test('missing unique file remains a deployment failure, even if latest matches', async () => {
 const h = check(url => new URL(url).pathname.includes('/runs/') ? new Response(null, { status: 404 }) : new Response(bytes), { target: 'deployment' });
 const r = await h.execute(); assert.equal(r.verified, false); assert.equal(r.attempts.length, 3); assert.ok(r.attempts.every(a => a.httpStatus === 404));
});
test('missing unique file can propagate and recover without redeployment', async () => {
 const h = check((_url, count) => count < 3 ? new Response(null, { status: 404 }) : new Response(bytes), { target: 'deployment' });
 const r = await h.execute(); assert.equal(r.verified, true); assert.equal(r.attempts.length, 3); assert.equal(r.endpoint, path);
});
test('old bytes at the unique URL never count as deployment proof', async () => {
 const h = check(() => new Response(stale), { target: 'deployment' }); const r = await h.execute(); assert.equal(r.verified, false); assert.equal(r.endpoint, path);
});
test('only validated canonical older latest is classified as deferred freshness', async () => {
 const h = check(() => new Response(stale)); const r = await h.execute(); assert.equal(r.verified, false); assert.equal(live.freshnessState(r), 'deferred');
 assert.ok(r.attempts.every(a => a.validSnapshot === true));
});
test('wrong-content same-run, newer-run, malformed and noncanonical latest are invalid, not deferred', async () => {
 const bad = [
  canonical(seal({ ...good, producer: { ...good.producer, runId: '999' } })) + '\n',
  canonical(seal({ ...good, generatedAt: '2026-10-23T00:00:00.000Z' })) + '\n',
  '{}', JSON.stringify(JSON.parse(stale), null, 2) + '\n'
 ];
 for (const body of bad) { const r = await check(() => new Response(body)).execute(); assert.equal(live.freshnessState(r), 'invalid'); }
});
test('temporary unavailable latest is explicitly unconfirmed, not verified', async () => {
 const r = await check(() => new Response(null, { status: 503 })).execute(); assert.equal(r.verified, false); assert.equal(live.freshnessState(r), 'deferred');
});
test('unique verification never accepts corrupt contract or wrong identity even at a matching hash', async () => {
 const corrupt = canonical(seal({ ...good, rulesHash: '0'.repeat(64) })) + '\n';
 const r = await check(() => new Response(corrupt), { target: 'deployment', expected: sha256(corrupt) }).execute(); assert.equal(r.verified, false);
 const other = await check(() => new Response(bytes), { target: 'deployment', runId: '999' }).execute(); assert.equal(other.verified, false);
});
test('unique identity and target injection fail before any request', async () => {
 for (const extra of [{ target: 'https://evil.test' }, { target: 'deployment', runId: '../42' }, { target: 'deployment', expected: '../hash' }]) {
  const h = check(() => { throw Error('must not fetch'); }, extra); await assert.rejects(h.execute()); assert.equal(h.urls.length, 0);
 }
});
test('immutable proof alone is never classified as verified latest freshness', async () => {
 const r = await check(() => new Response(bytes), { target: 'deployment' }).execute(); assert.equal(live.freshnessState(r), 'invalid');
});
