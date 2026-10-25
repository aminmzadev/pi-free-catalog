import test from 'node:test';
import assert from 'node:assert/strict';
import { publicVerifier } from '../catalog/prune-deployments.mjs';
import { snapshotFixture } from '../../test/snapshot-helper.mjs';
import { canonical, sha256, seal, rulesHash } from '../catalog/core.mjs';

async function fixture() {
 const current = await snapshotFixture();
 const old = seal({ ...current, producer: { ...current.producer, runId: '41' } });
 const bytes = canonical(current) + '\n';
 return { current, bytes, stale: canonical(old) + '\n', expectedRules: await rulesHash(),
  context: { expected: sha256(bytes), commit: current.producer.commit, runId: current.producer.runId } };
}
const policy = { attempts: 12, intervalMs: 5000, budgetMs: 60000, requestTimeoutMs: 5000 };
function clock() { let time = 0; return { now: () => time, sleep: async ms => { time += ms; }, elapsed: () => time }; }

test('cleanup tolerates stale CDN bytes only after receiving the exact current snapshot', async () => {
 const f = await fixture(), t = clock(), receipts = []; let calls = 0;
 const verify = publicVerifier({ expectedRules: f.expectedRules, ...t, policy, onObservation: r => receipts.push(r),
  fetcher: async (url, init) => {
   assert.equal(new URL(url).origin + new URL(url).pathname, 'https://aminmzadev.github.io/pi-free-catalog/catalog/v1/latest.json');
   assert.equal(init.method, 'GET'); assert.equal(init.headers.authorization, undefined); assert.equal(init.redirect, 'error');
   return new Response(++calls < 3 ? f.stale : f.bytes, { headers: { 'x-cache': calls < 3 ? 'HIT' : 'MISS' } });
  } });
 assert.equal(await verify(f.context), true); assert.equal(calls, 3); assert.equal(t.elapsed(), 10000);
 assert.equal(receipts.length, 1); assert.equal(receipts[0].verified, true);
 assert.deepEqual(receipts[0].attempts.map(a => a.receivedProducer.runId), ['41', '41', '42']);
});

test('permanently stale CDN responses exhaust a finite read-only attempt cap', async () => {
 const f = await fixture(), t = clock(), receipts = []; let calls = 0;
 const verify = publicVerifier({ expectedRules: f.expectedRules, ...t, policy, onObservation: r => receipts.push(r), fetcher: async () => { calls++; return new Response(f.stale); } });
 await assert.rejects(verify(f.context), /public-snapshot-unverified/);
 assert.equal(calls, 12); assert.equal(t.elapsed(), 55000); assert.equal(receipts[0].verified, false);
 assert.equal(receipts[0].reason, 'attempts-exhausted');
});

test('remaining retention budget limits verification and prevents further reads', async () => {
 const f = await fixture(), t = clock(), receipts = []; let calls = 0;
 const verify = publicVerifier({ expectedRules: f.expectedRules, ...t, policy, onObservation: r => receipts.push(r), fetcher: async () => { calls++; return new Response(f.stale); } });
 await assert.rejects(verify(f.context, { budgetMs: 5 }), /public-snapshot-unverified/);
 assert.equal(calls, 1); assert.equal(t.elapsed(), 5); assert.equal(receipts[0].reason, 'budget-exhausted');
});

test('matching bytes with a corrupt snapshot contract never pass', async () => {
 const f = await fixture(), t = clock(); let calls = 0;
 const corrupt = canonical(seal({ ...f.current, rulesHash: '0'.repeat(64) })) + '\n';
 const verify = publicVerifier({ expectedRules: f.expectedRules, ...t, policy, fetcher: async () => { calls++; return new Response(corrupt); } });
 await assert.rejects(verify({ ...f.context, expected: sha256(corrupt) }), /public-snapshot-unverified/); assert.equal(calls, 12);
});

test('a matching hash does not excuse the wrong producer run', async () => {
 const f = await fixture(), t = clock(); let calls = 0;
 const verify = publicVerifier({ expectedRules: f.expectedRules, ...t, policy, fetcher: async () => { calls++; return new Response(f.bytes); } });
 await assert.rejects(verify({ ...f.context, runId: '999' }), /public-snapshot-unverified/); assert.equal(calls, 12);
});

test('verification records safe metadata rather than arbitrary bodies or errors', async () => {
 const f = await fixture(), t = clock(), receipts = [];
 const verify = publicVerifier({ expectedRules: f.expectedRules, ...t, policy, onObservation: r => receipts.push(r), fetcher: async () => { throw Error('SECRET_ARBITRARY_NETWORK_ERROR'); } });
 await assert.rejects(verify(f.context)); assert.equal(receipts.length, 1);
 assert.ok(!JSON.stringify(receipts).includes('SECRET_ARBITRARY_NETWORK_ERROR'));
 assert.ok(receipts[0].attempts.every(a => a.receivedSHA256 === null));
});
