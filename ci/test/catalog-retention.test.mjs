import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pruneDeployments, validateContext, ownedRecord, statusOwner, githubApi, publicVerifier, PRUNE_POLICY, PRUNE_PUBLIC_POLICY } from '../catalog/prune-deployments.mjs';
import { snapshotFixture } from '../../test/snapshot-helper.mjs';
import { canonical, sha256, rulesHash, seal } from '../catalog/core.mjs';

const repository = 'aminmzadev/pi-free-catalog';
const context = { repository, ref: 'refs/heads/main', commit: 'a'.repeat(40), runId: '1000', attempt: '1', event: 'schedule', expected: 'b'.repeat(64) };
const link = (run, job) => `https://github.com/${repository}/actions/runs/${run}/job/${job}`;
const run = (runId, commit, extra = {}) => ({ id: Number(runId), head_sha: commit, head_branch: 'main', repository: { full_name: repository }, head_repository: { full_name: repository }, path: '.github/workflows/catalog.yml', event: 'schedule', run_attempt: 1, status: 'completed', ...extra });
const job = (runId, jobId, commit, extra = {}) => ({ id: Number(jobId), run_id: Number(runId), head_sha: commit, name: 'deploy', status: 'completed', conclusion: 'success', steps: [{ name: 'Verify run-specific public deployment', status: 'completed', conclusion: 'success' }, { name: 'Verify public Pages bytes and snapshot after bounded propagation wait', status: 'completed', conclusion: 'success' }], ...extra });
const record = (recordId, commit, at, extra = {}) => ({ id: recordId, sha: commit, created_at: at, task: 'deploy', environment: 'github-pages', original_environment: 'github-pages', ref: 'main', performed_via_github_app: { slug: 'github-actions', id: 15368 }, ...extra });

function harness({ records, hook, publicHook, policy } = {}) {
 let time = 0, publicCalls = 0;
 const current = record(3000, context.commit, '2026-10-24T10:00:00Z');
 const old = record(2000, 'c'.repeat(40), '2026-10-24T09:00:00Z');
 const state = { records: structuredClone(records ?? [current, old]), statuses: { 3000: { state: 'success', log_url: link(1000, 5000) }, 2000: { state: 'success', log_url: link(100, 500) } },
  runs: { 1000: run(1000, context.commit, { status: 'in_progress' }), 100: run(100, old.sha) },
  jobs: { 5000: job(1000, 5000, context.commit), 500: job(100, 500, old.sha) }, calls: [], writes: [], reports: [], sleeps: [], current, old };
 const api = async (path, options) => {
  const { method, body } = options;
  const row = { path, method, body, at: time }; state.calls.push(row);
  if (method !== 'GET') state.writes.push(row);
  if (hook) await hook(state, row);
  if (path.startsWith('/deployments?')) {
   const query = new URLSearchParams(path.split('?')[1]); const size = Number(query.get('per_page')), page = Number(query.get('page'));
   return structuredClone(state.records.filter(d => d.environment === 'github-pages').slice((page - 1) * size, page * size));
  }
  let m = path.match(/^\/deployments\/(\d+)\/statuses(?:\?per_page=1)?$/);
  if (m) {
   if (method === 'POST') { state.statuses[m[1]] = { ...state.statuses[m[1]], ...body }; return structuredClone(state.statuses[m[1]]); }
   return state.statuses[m[1]] ? [structuredClone(state.statuses[m[1]])] : [];
  }
  m = path.match(/^\/deployments\/(\d+)$/);
  if (m) {
   if (method === 'DELETE') { state.records = state.records.filter(d => d.id !== Number(m[1])); return null; }
   return structuredClone(state.records.find(d => d.id === Number(m[1])));
  }
  m = path.match(/^\/actions\/runs\/(\d+)\/attempts\/\d+\/jobs\?per_page=100$/);
  if (m) return { total_count: 1, jobs: [structuredClone(state.jobs[5000])] };
  m = path.match(/^\/actions\/runs\/(\d+)$/); if (m) return structuredClone(state.runs[m[1]]);
  m = path.match(/^\/actions\/jobs\/(\d+)$/); if (m) return structuredClone(state.jobs[m[1]]);
  throw Error('Unexpected fixture API route');
 };
 return { state, advance: ms => { time += ms; }, execute: extra => pruneDeployments({ context: { ...context }, api, apply: true,
  verifyPublic: async c => { assert.deepEqual(c, context); publicCalls++; return publicHook ? publicHook(state, publicCalls) : true; },
  now: () => time, sleep: async ms => { state.sleeps.push(ms); time += ms; }, onReport: async r => state.reports.push(r), policy: policy ?? PRUNE_POLICY, ...extra }) };
}

test('retention production policy is bounded and mutation rate is conservative', () => {
 assert.deepEqual(PRUNE_POLICY, { maxPages: 10, pageSize: 100, maxDeletes: 100, budgetMs: 480000, requestTimeoutMs: 10000, mutationIntervalMs: 1100 });
});

test('only superseded record is inactivated and deleted after complete plan; current remains', async () => {
 const h = harness(), r = await h.execute(); assert.equal(r.succeeded, true); assert.equal(r.reason, 'current-only'); assert.equal(r.protectedId, 3000);
 assert.deepEqual(h.state.writes.map(x => [x.path, x.method]), [['/deployments/2000/statuses', 'POST'], ['/deployments/2000', 'DELETE']]);
 assert.equal(h.state.writes[0].body.auto_inactive, false); assert.ok(h.state.writes[1].at - h.state.writes[0].at >= 1100);
 assert.equal(h.state.reports[0].actions.length, 0); assert.equal(h.state.reports[0].candidates.length, 1); assert.equal(h.state.records[0].id, 3000);
});

test('dry run performs no writes and returns a complete inventory and deletion plan', async () => {
 const h = harness(), r = await h.execute({ apply: false }); assert.equal(r.succeeded, true); assert.equal(r.reason, 'dry-run-no-writes');
 assert.equal(r.candidates.length, 1); assert.equal(r.before.length, 2); assert.deepEqual(h.state.writes, []);
});

test('already inactive old record is deleted without posting a redundant status', async () => {
 const h = harness(); h.state.statuses[2000].state = 'inactive'; const r = await h.execute(); assert.equal(r.succeeded, true); assert.deepEqual(h.state.writes.map(x => x.method), ['DELETE']);
});

for (const [label, patch] of [
 ['fork', { repository: 'someone/else' }], ['other branch', { ref: 'refs/heads/other' }], ['pull request', { event: 'pull_request' }],
 ['release', { event: 'release' }], ['invalid SHA', { commit: 'main' }], ['invalid run', { runId: '../1' }], ['invalid attempt', { attempt: '0' }], ['invalid hash', { expected: 'x' }],
]) test('retention rejects ' + label + ' before any request', async () => {
 const h = harness(), r = await h.execute({ context: { ...context, ...patch } }); assert.equal(r.succeeded, false); assert.deepEqual(h.state.calls, []);
});

for (const [label, alter] of [
 ['wrong workflow', s => { s.runs[1000].path = '.github/workflows/other.yml'; }],
 ['wrong attempt', s => { s.runs[1000].run_attempt = 2; }],
 ['wrong head', s => { s.runs[1000].head_sha = 'd'.repeat(40); }],
 ['fork head', s => { s.runs[1000].head_repository.full_name = 'fork/repo'; }],
 ['failed deploy', s => { s.jobs[5000].conclusion = 'failure'; }],
 ['running deploy', s => { s.jobs[5000].status = 'in_progress'; }],
 ['failed public verification step', s => { s.jobs[5000].steps[0].conclusion = 'failure'; }],
]) test('retention rejects ' + label + ' without writes', async () => {
 const h = harness(); alter(h.state); const r = await h.execute(); assert.equal(r.succeeded, false); assert.deepEqual(h.state.writes, []);
});

test('a false public verifier never authorizes any write', async () => {
 const h = harness({ publicHook: () => false }), r = await h.execute(); assert.equal(r.succeeded, false); assert.equal(r.reason, 'public-snapshot-unverified'); assert.deepEqual(h.state.writes, []);
});

test('same SHA is not proof of the current deployment: exact run and job must match', async () => {
 const h = harness(); h.state.statuses[3000].log_url = link(999, 999); const r = await h.execute(); assert.equal(r.reason, 'ambiguous-current-deployment'); assert.deepEqual(h.state.writes, []);
});

test('two plausible current records abort rather than choosing an array position', async () => {
 const h = harness(); h.state.records.push({ ...h.state.current, id: 3001 }); h.state.statuses[3001] = h.state.statuses[3000];
 const r = await h.execute(); assert.equal(r.reason, 'ambiguous-current-deployment'); assert.deepEqual(h.state.writes, []);
});

for (const state of ['queued', 'pending', 'in_progress', 'unknown']) test('old ' + state + ' record is retained', async () => {
 const h = harness(); h.state.statuses[2000].state = state; const r = await h.execute(); assert.equal(r.succeeded, true); assert.equal(r.reason, 'protected-records-retained'); assert.deepEqual(h.state.writes, []);
});

for (const [label, alter] of [
 ['foreign ref', s => { s.records[1].ref = 'preview'; }],
 ['foreign app', s => { s.records[1].performed_via_github_app = { slug: 'other', id: 10 }; }],
 ['newer timestamp', s => { s.records[1].created_at = '2026-10-24T11:00:00Z'; }],
 ['impossible date', s => { s.records[1].created_at = '2026-02-31T00:00:00Z'; }],
 ['unowned log URL', s => { s.statuses[2000].log_url = 'https://example.com/private'; }],
 ['other workflow', s => { s.runs[100].path = '.github/workflows/other.yml'; }],
 ['old run executing', s => { s.runs[100].status = 'in_progress'; }],
 ['old job executing', s => { s.jobs[500].status = 'in_progress'; }],
 ['old job SHA mismatch', s => { s.jobs[500].head_sha = 'd'.repeat(40); }],
 ['old run SHA mismatch', s => { s.runs[100].head_sha = 'd'.repeat(40); }],
]) test('ambiguous ' + label + ' is retained', async () => {
 const h = harness(); alter(h.state); const r = await h.execute(); assert.equal(r.succeeded, true); assert.deepEqual(h.state.writes, []);
});

test('npm publication environment is outside every deletion plan', async () => {
 const h = harness(); h.state.records.push({ ...h.state.old, id: 4000, environment: 'npm-publish', original_environment: 'npm-publish' });
 const r = await h.execute(); assert.equal(r.succeeded, true); assert.ok(h.state.records.some(d => d.id === 4000)); assert.ok(!JSON.stringify(h.state.writes).includes('4000'));
});

test('complete multi-page inventory is read before pruning a shrinking list', async () => {
 const h = harness({ policy: { ...PRUNE_POLICY, pageSize: 1 } }); const r = await h.execute(); assert.equal(r.succeeded, true); assert.equal(r.before.length, 2);
 assert.ok(h.state.calls.some(x => x.path.endsWith('per_page=1&page=3'))); assert.equal(r.actions.length, 1);
});

test('pagination and deletion caps fail closed before any write', async () => {
 const h = harness({ policy: { ...PRUNE_POLICY, pageSize: 1, maxPages: 1 } }); const r = await h.execute(); assert.equal(r.reason, 'pagination-limit'); assert.deepEqual(h.state.writes, []);
 const many = harness({ policy: { ...PRUNE_POLICY, maxDeletes: 1 } }); many.state.records.push({ ...many.state.old, id: 2001 }); many.state.statuses[2001] = { ...many.state.statuses[2000] };
 const result = await many.execute(); assert.equal(result.reason, 'deletion-limit'); assert.deepEqual(many.state.writes, []);
});

test('public producer change between planning and pruning stops all writes', async () => {
 const h = harness({ publicHook: (_s, n) => n < 3 }); const r = await h.execute(); assert.equal(r.succeeded, false); assert.equal(r.reason, 'public-snapshot-changed'); assert.deepEqual(h.state.writes, []);
});

test('new concurrent deployment detected during preview is not touched', async () => {
 const h = harness({ publicHook: (s, n) => { if (n === 2) s.records.unshift({ ...s.current, id: 4000 }); return true; } });
 const r = await h.execute(); assert.equal(r.reason, 'newer-or-changed-deployment'); assert.deepEqual(h.state.writes, []);
});

test('candidate moving to in-progress during the throttling wait is never deleted', async () => {
 const h = harness(); const result = await h.execute({ sleep: async ms => { h.advance(ms); h.state.statuses[2000].state = 'in_progress'; } });
 assert.equal(result.succeeded, false); assert.equal(result.reason, 'candidate-write-race'); assert.deepEqual(h.state.writes.map(x => x.method), ['POST']);
});

test('inactivation failure prevents DELETE and persists a partial report', async () => {
 const h = harness({ hook: (_s, row) => { if (row.method === 'POST') throw Error('private token must not be logged'); } });
 const r = await h.execute(); assert.equal(r.succeeded, false); assert.deepEqual(h.state.writes.map(x => x.method), ['POST']); assert.ok(h.state.reports.length > 1); assert.ok(!JSON.stringify(r).includes('private token'));
});

test('delete refusal is not retried or bypassed', async () => {
 const h = harness({ hook: (_s, row) => { if (row.method === 'DELETE') throw Error('refused'); } }); const r = await h.execute();
 assert.equal(r.succeeded, false); assert.equal(h.state.writes.filter(x => x.method === 'DELETE').length, 1); assert.equal(r.actions[0].stage, 'inactive');
});

test('budget expiry prevents requests and writes after the deadline', async () => {
 const h = harness({ policy: { ...PRUNE_POLICY, budgetMs: 2 }, publicHook: () => { h.advance(3); return true; } });
 const r = await h.execute(); assert.equal(r.reason, 'budget-exhausted'); assert.deepEqual(h.state.writes, []);
});

test('API transport has fixed repository routes, no redirects, and exact method/status contracts', async () => {
 const calls = []; const api = githubApi({ token: 'fixture-token', fetcher: async (url, init) => { calls.push({ url, init }); return Response.json([]); } });
 await api('/deployments?environment=github-pages&per_page=100&page=1'); assert.equal(calls[0].init.redirect, 'error'); assert.ok(calls[0].url.startsWith('https://api.github.com/repos/aminmzadev/pi-free-catalog/'));
 for (const path of ['/environments/github-pages', '/pages', '/actions/runs/1/cancel', 'https://evil.example/']) await assert.rejects(api(path, { method: 'DELETE' }));
 await assert.rejects(api('/deployments/2000/statuses', { method: 'POST', body: { state: 'inactive', auto_inactive: true } })); assert.equal(calls.length, 1);
});

for (const status of [301, 403, 404, 422, 429, 500]) test('API HTTP ' + status + ' fails closed without retries', async () => {
 let calls = 0; const api = githubApi({ token: 'fixture-token', fetcher: async () => { calls++; return new Response(null, { status }); } });
 await assert.rejects(api('/deployments/2000', { method: 'DELETE' }), new RegExp('api-http-' + status)); assert.equal(calls, 1);
});

test('public verifier checks actual snapshot hash and contract without forwarding API credentials', async () => {
 const snapshot = await snapshotFixture(); const bytes = canonical(snapshot) + '\n'; const expectedRules = await rulesHash();
 const c = { ...context, commit: snapshot.producer.commit, runId: snapshot.producer.runId, expected: sha256(bytes) }; let requests = 0;
 const once = { attempts: 1, intervalMs: 1, budgetMs: 10000, requestTimeoutMs: 10000 };
 const verify = publicVerifier({ expectedRules, policy: once, fetcher: async (url, init) => {
  requests++; assert.equal(new URL(url).origin + new URL(url).pathname, 'https://aminmzadev.github.io/pi-free-catalog/catalog/v1/latest.json');
  assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, undefined); return new Response(bytes);
 } });
 assert.equal(await verify(c), true); await assert.rejects(verify({ ...c, expected: '0'.repeat(64) })); await assert.rejects(verify({ ...c, runId: '999' })); assert.equal(requests, 3);
 const corrupt = canonical(seal({ ...snapshot, rulesHash: '0'.repeat(64) })) + '\n';
 await assert.rejects(publicVerifier({ expectedRules, policy: once, fetcher: async () => new Response(corrupt) })({ ...c, expected: sha256(corrupt) }));
});

test('production CLI rejects local apply without Actions and defaults to no writes', async () => {
 const result = spawnSync(process.execPath, ['ci/catalog/prune-deployments.mjs', '--apply'], { cwd: new URL('../../', import.meta.url), env: { ...process.env, GITHUB_ACTIONS: '', GH_DEPLOYMENTS_TOKEN: '' }, encoding: 'utf8' });
 assert.notEqual(result.status, 0); assert.ok(!result.stdout.includes('Bearer'));
});

test('cleanup is success-gated, token-scoped, environment-free and retains pre-write evidence', async () => {
 const wf = await readFile(new URL('../../.github/workflows/catalog.yml', import.meta.url), 'utf8'); const cleanup = wf.split('\n  cleanup:\n')[1];
 assert.match(cleanup, /needs: \[collect, deploy\]/); assert.match(cleanup, /needs.deploy.result == 'success'/);
 assert.match(cleanup, /contents: read\n      actions: read\n      deployments: write/); assert.doesNotMatch(cleanup, /pages: write|id-token: write|environment:|secrets\.|npm-publish|continue-on-error/);
 assert.ok(cleanup.indexOf('--dry-run') < cleanup.indexOf('catalog-deployment-retention-plan')); assert.ok(cleanup.indexOf('catalog-deployment-retention-plan') < cleanup.indexOf('--apply'));
 assert.match(cleanup, /name: Preserve deployment-retention results\n        if: always\(\)/);
 assert.match(wf, /group: catalog-pages\n  cancel-in-progress: false/); assert.equal((wf.match(/deployments: write/g) ?? []).length, 1);
});

test('59 superseded deployments fit below the repository job-token hourly API budget', async () => {
 const h = harness(); h.state.records = [h.state.current];
 for (let i = 0; i < 59; i++) {
  const rid = 100 + i, jid = 500 + i, did = 2000 - i, commit = 'c'.repeat(40);
  h.state.records.push(record(did, commit, '2026-10-24T09:00:00Z'));
  h.state.statuses[did] = { state: 'success', log_url: link(rid, jid) };
  h.state.runs[rid] = run(rid, commit); h.state.jobs[jid] = job(rid, jid, commit);
 }
 const preview = await h.execute({ apply: false }); assert.equal(preview.succeeded, true); assert.deepEqual(h.state.writes, []);
 const r = await h.execute(); assert.equal(r.succeeded, true); assert.equal(r.reason, 'current-only'); assert.equal(r.actions.length, 59);
 assert.ok(h.state.calls.length < 975, 'Combined dry-run and apply must leave repository job-token rate-limit headroom');
 assert.equal(h.state.writes.length, 118); assert.equal(h.state.reports[0].before.length, 60);
 assert.deepEqual(h.state.reports[0].before[0], h.state.current);
});


test('retention public-read retry policy has finite attempt, request and elapsed limits', () => {
 assert.deepEqual(PRUNE_PUBLIC_POLICY, { attempts: 12, intervalMs: 5000, budgetMs: 60000, requestTimeoutMs: 5000 });
});

async function liveReadHarness({ staleForever = false, concurrent = false, budgetMs = PRUNE_POLICY.budgetMs } = {}) {
 const h = harness({ policy: { ...PRUNE_POLICY, budgetMs } });
 const raw = await snapshotFixture();
 const current = seal({ ...raw, producer: { ...raw.producer, commit: context.commit, runId: context.runId } });
 const stale = seal({ ...current, producer: { ...current.producer, runId: '999' } });
 const bytes = canonical(current) + '\n', oldBytes = canonical(stale) + '\n';
 let clock = 0, reads = 0; const observations = [];
 const now = () => clock, sleep = async ms => { clock += ms; };
 const verify = publicVerifier({ expectedRules: await rulesHash(), now, sleep, onObservation: r => observations.push(r), fetcher: async (_url, init) => {
  assert.equal(init.method, 'GET'); reads++;
  if (reads <= 2) assert.deepEqual(h.state.writes, []);
  if (concurrent && reads === 2) h.state.records.unshift({ ...h.state.current, id: 4000 });
  return new Response(staleForever || reads <= 2 ? oldBytes : bytes);
 } });
 const result = await h.execute({ context: { ...context, expected: sha256(bytes) }, now, sleep, verifyPublic: verify });
 return { h, result, observations, reads, elapsed: clock };
}

test('real public verifier recovers from stale cache before allowing any fixture mutation', async () => {
 const { h, result, observations } = await liveReadHarness();
 assert.equal(result.succeeded, true); assert.deepEqual(h.state.writes.map(w => w.method), ['POST', 'DELETE']);
 assert.equal(observations[0].attempts.length, 3); assert.ok(observations.every(o => o.verified));
});

test('real public verifier with persistently stale cache permits no fixture mutation', async () => {
 const { h, result, reads } = await liveReadHarness({ staleForever: true });
 assert.equal(result.reason, 'latest-freshness-deferred'); assert.equal(result.deferred,true); assert.equal(reads, 12); assert.deepEqual(h.state.writes, []);
});

test('new deployment appearing during public-read retries still blocks every fixture write', async () => {
 const { h, result } = await liveReadHarness({ concurrent: true });
 assert.equal(result.reason, 'newer-or-changed-deployment'); assert.deepEqual(h.state.writes, []);
});

test('public reads cannot exceed remaining overall retention budget or permit fixture writes', async () => {
 const { h, result, elapsed, reads } = await liveReadHarness({ staleForever: true, budgetMs: 6000 });
 assert.equal(result.reason, 'latest-freshness-deferred'); assert.equal(result.deferred,true); assert.equal(elapsed, 6000); assert.equal(reads, 2);
 assert.deepEqual(h.state.writes, []);
});


test('retention refuses missing run-specific deployment verification evidence', async () => {
 const h=harness();h.state.jobs[5000].steps=h.state.jobs[5000].steps.filter(s=>s.name!=='Verify run-specific public deployment');
 const r=await h.execute();assert.equal(r.reason,'deploy-not-verified');assert.deepEqual(h.state.writes,[]);
});
