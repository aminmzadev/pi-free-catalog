import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJSON, validateSnapshot, rulesHash, PREVIOUS_URL, MAX_SNAPSHOT_BYTES, canonical, sha256, FetchFailure } from './core.mjs';

export const LIVE_POLICY = Object.freeze({ attempts: 18, intervalMs: 10000, budgetMs: 180000, requestTimeoutMs: 20000 });
const HEADERS = ['date','age','cache-control','etag','last-modified','x-cache','x-proxy-cache','x-served-by','x-github-request-id'];
const text = value => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 256);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const producer = data => ({
 commit: typeof data?.producer?.commit === 'string' && /^[a-f0-9]{40}$/.test(data.producer.commit) ? data.producer.commit : null,
 runId: typeof data?.producer?.runId === 'string' && /^[1-9][0-9]{0,30}$/.test(data.producer.runId) ? data.producer.runId : null,
});

/** Repository-only verifier. Test injection never changes the production CLI policy. */
export async function verifyPublicSnapshot({ expected, commit, runId, expectedRules, fetcher = globalThis.fetch,
 now = () => performance.now(), sleep = delay, log = console.log, policy = LIVE_POLICY } = {}) {
 if (!hash(expected)) throw Error('Invalid EXPECTED_SNAPSHOT_SHA256; no request was sent.');
 if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid GITHUB_SHA; no request was sent.');
 if (typeof runId !== 'string' || !/^[1-9][0-9]{0,30}$/.test(runId)) throw Error('Invalid GITHUB_RUN_ID; no request was sent.');
 for (const key of ['attempts','intervalMs','budgetMs','requestTimeoutMs']) assert.ok(Number.isSafeInteger(policy[key]) && policy[key] > 0, 'Invalid verification policy');
 const rules = expectedRules ?? await rulesHash();
 const start = now();
 const report = { schemaVersion: 1, endpoint: PREVIOUS_URL, expectedSHA256: expected, expectedProducer: { commit, runId },
  policy: { ...policy }, verified: false, reason: null, attempts: [] };
 log(`Public Pages verification: expected_sha256=${expected}, expected_commit=${commit}, expected_run=${runId}; maximum ${policy.attempts} attempts within ${policy.budgetMs / 1000}s.`);
 for (let attempt = 1; attempt <= policy.attempts; attempt++) {
  const remaining = Math.floor(policy.budgetMs - (now() - start));
  if (remaining <= 0) break;
  const timeoutMs = Math.min(policy.requestTimeoutMs, remaining);
  const row = { attempt, elapsedMs: Math.ceil(now() - start), stage: 'fetch', httpStatus: null, headers: {}, receivedSHA256: null, receivedProducer: null, verified: false };
  const controller = new AbortController(); let timer;
  try {
   const task = readJSON(PREVIOUS_URL, { maxBytes: MAX_SNAPSHOT_BYTES, cacheBust: true, timeoutMs,
    fetcher: async (url, init) => {
     const response = await fetcher(url, { ...init, signal: AbortSignal.any([init.signal, controller.signal]) });
     row.httpStatus = response.status;
     for (const key of HEADERS) { const value = response.headers?.get(key); if (value !== null && value !== undefined) row.headers[key] = text(value); }
     return response;
    } });
   // Also bound a stalled body/custom transport: do not depend on fetch alone
   // honoring the abort. The controller cancels the normal native fetch/body.
   const limit = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new FetchFailure('timeout')); }, timeoutMs); });
   const { data, bodySha256 } = await Promise.race([task, limit]);
   row.receivedSHA256 = bodySha256; row.receivedProducer = producer(data);
   row.stage = 'file-hash'; assert.equal(bodySha256, expected, 'Public file bytes differ from validated build');
   row.stage = 'contract'; const snapshot = validateSnapshot(data, { expectedRules: rules });
   row.stage = 'producer'; assert.equal(snapshot.producer.commit, commit); assert.equal(snapshot.producer.runId, runId);
   row.stage = 'canonical-bytes'; assert.equal(sha256(canonical(snapshot) + '\n'), expected);
   row.stage = 'budget'; assert.ok(now() - start <= policy.budgetMs, 'Verification exceeded overall budget');
   row.stage = 'verified'; row.verified = true; report.verified = true;
  } catch (error) {
   // Never dump assertions' actual/expected snapshot objects, response bodies,
   // arbitrary error messages, credentials or unrelated response headers.
   row.error = { code: error instanceof FetchFailure ? error.code : error?.code === 'ERR_ASSERTION' ? 'validation' : 'unexpected',
    ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}) };
  } finally { clearTimeout(timer); }
  row.elapsedMs = Math.ceil(now() - start); report.attempts.push(row);
  log(`Public Pages attempt ${attempt}/${policy.attempts}: ${JSON.stringify(row)}`);
  if (report.verified) { log(`Public Pages snapshot VERIFIED: exact bytes, contract, commit/run; attempt ${attempt}/${policy.attempts}.`); break; }
  const left = policy.budgetMs - (now() - start);
  if (attempt < policy.attempts && left > 0) await sleep(Math.min(policy.intervalMs, left));
 }
 report.elapsedMs = Math.ceil(now() - start);
 report.reason = report.verified ? 'verified' : report.elapsedMs >= policy.budgetMs ? 'budget-exhausted' : 'attempts-exhausted';
 return report;
}

async function main() {
 let report;
 try {
  report = await verifyPublicSnapshot({ expected: process.env.EXPECTED_SNAPSHOT_SHA256, commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID });
 } catch {
  report = { schemaVersion: 1, verified: false, reason: 'configuration-error', attempts: [] };
 }
 await mkdir('artifacts/catalog', { recursive: true });
 await writeFile('artifacts/catalog/live-verification.json', JSON.stringify(report, null, 2) + '\n');
 if (!report.verified) {
  console.error('Pages deployment may already have succeeded, but public verification did not finish. Inspect artifacts/catalog/live-verification.json for stages, hashes and cache headers; do not reset history or bypass validation.');
  process.exitCode = 1;
 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
