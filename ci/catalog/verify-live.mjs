import { outputs } from '../lib.mjs';
import { deploymentURL } from './deployment-path.mjs';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJSON, readDeploymentJSON, validateSnapshot, rulesHash, PREVIOUS_URL, MAX_SNAPSHOT_BYTES, canonical, sha256, FetchFailure } from './core.mjs';

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
 now = () => performance.now(), sleep = delay, log = console.log, policy = LIVE_POLICY, target = 'latest' } = {}) {
 assert.ok(['latest','deployment'].includes(target), 'Invalid verification target');
 if (!hash(expected)) throw Error('Invalid EXPECTED_SNAPSHOT_SHA256; no request was sent.');
 if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid GITHUB_SHA; no request was sent.');
 if (typeof runId !== 'string' || !/^[1-9][0-9]{0,30}$/.test(runId)) throw Error('Invalid GITHUB_RUN_ID; no request was sent.');
 for (const key of ['attempts','intervalMs','budgetMs','requestTimeoutMs']) assert.ok(Number.isSafeInteger(policy[key]) && policy[key] > 0, 'Invalid verification policy');
 const endpoint = target === 'deployment' ? deploymentURL(runId,expected) : PREVIOUS_URL;
 const rules = expectedRules ?? await rulesHash();
 const start = now();
 const report = { schemaVersion: 1, endpoint, target, expectedSHA256: expected, expectedProducer: { commit, runId },
  policy: { ...policy }, verified: false, reason: null, attempts: [] };
 log(`Public Pages verification: expected_sha256=${expected}, expected_commit=${commit}, expected_run=${runId}; maximum ${policy.attempts} attempts within ${policy.budgetMs / 1000}s.`);
 for (let attempt = 1; attempt <= policy.attempts; attempt++) {
  const remaining = Math.floor(policy.budgetMs - (now() - start));
  if (remaining <= 0) break;
  const timeoutMs = Math.min(policy.requestTimeoutMs, remaining);
  const row = { attempt, elapsedMs: Math.ceil(now() - start), stage: 'fetch', httpStatus: null, headers: {}, receivedSHA256: null, receivedProducer: null, verified: false };
  const controller = new AbortController(); let timer;
  try {
   const reader = options => target === 'deployment' ? readDeploymentJSON({runId,expected,...options}) : readJSON(PREVIOUS_URL,{maxBytes:MAX_SNAPSHOT_BYTES,cacheBust:true,...options});
   const task = reader({ timeoutMs,
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
   // Distinguish an older validated snapshot from corruption; never soften a bad hash alone.
   if (bodySha256 !== expected) {
    try {
     const candidate = validateSnapshot(data,{expectedRules:rules});
     row.validSnapshot = sha256(canonical(candidate) + '\n') === bodySha256;
    } catch { row.validSnapshot = false; }
   }
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

export function freshnessState(report) {
 if (report?.target !== 'latest' || report.endpoint !== PREVIOUS_URL) return 'invalid';
 if (report.verified) return 'verified';
 if (!report.attempts?.length) return 'invalid';
 const deferrable = report.attempts.every(row => {
  if (['network','timeout'].includes(row.error?.code)) return true;
  if (row.error?.code === 'http' && [404,429,500,502,503,504].includes(row.httpStatus)) return true;
  return row.stage === 'file-hash' && row.validSnapshot === true
   && /^[1-9][0-9]{0,30}$/.test(row.receivedProducer?.runId ?? '')
   && BigInt(row.receivedProducer.runId) < BigInt(report.expectedProducer.runId);
 });
 return deferrable ? 'deferred' : 'invalid';
}

async function main() {
 const args = process.argv.slice(2);
 const mode = args.length === 0 ? 'strict-latest' : args.length === 1 && args[0] === '--deployment' ? 'deployment'
  : args.length === 1 && args[0] === '--freshness' ? 'freshness' : 'invalid';
 let report;
 try {
  assert.notEqual(mode,'invalid','Invalid verification mode');
  report = await verifyPublicSnapshot({ expected: process.env.EXPECTED_SNAPSHOT_SHA256, commit: process.env.GITHUB_SHA,
   runId: process.env.GITHUB_RUN_ID, target: mode === 'deployment' ? 'deployment' : 'latest' });
 } catch {
  report = { schemaVersion: 1, verified: false, reason: 'configuration-error', attempts: [] };
 }
 const state = freshnessState(report);
 report.outcome = report.verified ? 'verified' : mode === 'freshness' && state === 'deferred' ? 'deferred' : 'failed';
 await mkdir('artifacts/catalog', { recursive: true });
 const file = mode === 'deployment' ? 'deployment-verification.json' : mode === 'freshness' ? 'freshness-verification.json' : 'live-verification.json';
 await writeFile('artifacts/catalog/' + file, JSON.stringify(report, null, 2) + '\n');
 if (mode === 'freshness') {
  await outputs({ latest_verified: report.verified ? 'true' : 'false' });
  if (report.outcome === 'deferred') console.warn('::warning::Deployment proof passed, but latest.json freshness is NOT confirmed. Cleanup must be skipped. See catalog-live-verification diagnostics.');
 }
 if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,
  `## Catalog ${mode} verification\n\nOutcome: **${report.outcome}**. ${mode === 'deployment' ? 'This proves only the run-specific URL, not latest.json freshness.' : 'Cleanup requires exact latest.json verification.'}\n`,{flag:'a'});
 if (report.outcome === 'failed') {
  console.error('Public snapshot verification failed. Inspect verification diagnostics; do not reset history or bypass validation.');
  process.exitCode = 1;
 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
