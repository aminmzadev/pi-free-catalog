// Repository-only deployment-record retention. Never deletes environments, Pages sites or artifacts.
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundedBody } from '../lib.mjs';
import { readJSON, PREVIOUS_URL, MAX_SNAPSHOT_BYTES, validateSnapshot, rulesHash } from './core.mjs';

const REPO = 'aminmzadev/pi-free-catalog';
const API = `https://api.github.com/repos/${REPO}`;
const ENVIRONMENT = 'github-pages';
const VERIFY_STEP = 'Verify public Pages bytes and snapshot after bounded propagation wait';
export const PRUNE_POLICY = Object.freeze({ maxPages: 10, pageSize: 100, maxDeletes: 100, budgetMs: 480000, requestTimeoutMs: 10000, mutationIntervalMs: 1100 });
const id = x => /^(?:[1-9][0-9]{0,15})$/.test(String(x)) && Number.isSafeInteger(Number(x));
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const terminal = new Set(['success', 'failure', 'error', 'inactive']);
class SafetyError extends Error { constructor(code) { super(code); this.code = code; } }
const requireSafe = (condition, code) => { if (!condition) throw new SafetyError(code); };
const timestamp = value => {
 if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return NaN;
 const ms = Date.parse(value);
 return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : NaN;
};

export function validateContext(c) {
 requireSafe(c?.repository === REPO && c.ref === 'refs/heads/main', 'repository-or-branch');
 requireSafe(sha(c.commit) && id(c.runId) && id(c.attempt), 'execution-identity');
 requireSafe(['schedule', 'workflow_dispatch'].includes(c.event), 'event');
 requireSafe(typeof c.expected === 'string' && /^[a-f0-9]{64}$/.test(c.expected), 'snapshot-hash');
 return c;
}

export function ownedRecord(d) {
 return Boolean(d && id(d.id) && d.environment === ENVIRONMENT && d.original_environment === ENVIRONMENT && d.ref === 'main'
  && d.task === 'deploy' && sha(d.sha) && Number.isFinite(timestamp(d.created_at))
  && d.performed_via_github_app?.slug === 'github-actions' && d.performed_via_github_app?.id === 15368);
}

export function statusOwner(s) {
 if (!s || typeof s.log_url !== 'string') return null;
 const match = s.log_url.match(/^https:\/\/github\.com\/aminmzadev\/pi-free-catalog\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/);
 return match && id(match[1]) && id(match[2]) ? { runId: match[1], jobId: match[2] } : null;
}

/** Dependency injection is for offline tests. The production CLI supplies fixed API/public verifiers. */
export async function pruneDeployments({ context, api, verifyPublic, apply = false, now = () => performance.now(), sleep = delay,
 onReport = async () => {}, policy = PRUNE_POLICY } = {}) {
 const report = { schemaVersion: 1, mode: apply ? 'apply' : 'dry-run', environment: ENVIRONMENT,
  expectedCommit: context?.commit, expectedRunId: context?.runId, protectedId: null, stage: 'configuration',
  before: [], observedStatuses: {}, candidates: [], retained: [], actions: [], remaining: [], succeeded: false, reason: null };
 const start = now(); let lastMutation = -Infinity;
 const persist = () => onReport(structuredClone(report));
 const budget = () => requireSafe(now() - start < policy.budgetMs, 'budget-exhausted');
 const call = async (path, method = 'GET', body) => { budget(); const result = await api(path, { method, body }); budget(); return result; };
 const status = async d => {
  const rows = await call(`/deployments/${d.id}/statuses?per_page=1`);
  requireSafe(Array.isArray(rows) && rows.length <= 1, 'status-shape');
  const latest = rows[0] ?? null; report.observedStatuses[d.id] = latest; return latest;
 };
 const list = async () => {
  const result = []; const ids = new Set();
  for (let page = 1; page <= policy.maxPages; page++) {
   const rows = await call(`/deployments?environment=${ENVIRONMENT}&per_page=${policy.pageSize}&page=${page}`);
   requireSafe(Array.isArray(rows) && rows.length <= policy.pageSize, 'deployment-list');
   for (const row of rows) { requireSafe(id(row?.id) && !ids.has(row.id), 'deployment-identity'); ids.add(row.id); result.push(row); }
   if (rows.length < policy.pageSize) return result;
  }
  throw new SafetyError('pagination-limit');
 };
 const sameRecord = (a, b) => ownedRecord(a) && ownedRecord(b) && a.id === b.id && a.sha === b.sha && a.created_at === b.created_at;
 let current;
 const guardCurrent = async (publicCheck = true) => {
  const newest = await call(`/deployments?environment=${ENVIRONMENT}&per_page=1&page=1`);
  requireSafe(Array.isArray(newest) && newest.length === 1 && sameRecord(newest[0], current), 'newer-or-changed-deployment');
  // List responses contain full deployment records; the newest record is independently checked above.
  const s = await status(current); const owner = statusOwner(s);
  requireSafe(s?.state === 'success' && owner?.runId === String(context.runId) && owner.jobId === String(report.jobId), 'current-status-changed');
  if (publicCheck) { requireSafe(await verifyPublic(context), 'public-snapshot-changed'); budget(); }
 };
 const mutate = async (path, method, body, beforeWrite) => {
  const wait = Math.max(0, policy.mutationIntervalMs - (now() - lastMutation));
  requireSafe(now() - start + wait < policy.budgetMs, 'budget-exhausted');
  if (wait) await sleep(wait);
  // Recheck after rate-limit waiting, immediately before each write.
  await guardCurrent(false); await beforeWrite(); lastMutation = now();
  return call(path, method, body);
 };
 try {
  validateContext(context);
  requireSafe(typeof api === 'function' && typeof verifyPublic === 'function', 'missing-verifier');
  for (const k of Object.keys(PRUNE_POLICY)) requireSafe(Number.isSafeInteger(policy[k]) && policy[k] > 0, 'policy');
  report.stage = 'verified-deploy-job';
  const run = await call(`/actions/runs/${context.runId}`);
  requireSafe(String(run?.id) === String(context.runId) && run.head_sha === context.commit && run.head_branch === 'main'
   && run.repository?.full_name === REPO && run.head_repository?.full_name === REPO
   && run.path === '.github/workflows/catalog.yml' && run.event === context.event && Number(run.run_attempt) === Number(context.attempt), 'run-provenance');
  const jobs = await call(`/actions/runs/${context.runId}/attempts/${context.attempt}/jobs?per_page=100`);
  requireSafe(Array.isArray(jobs?.jobs) && jobs.total_count === jobs.jobs.length && jobs.jobs.length <= 100, 'job-pagination');
  const matches = jobs.jobs.filter(j => j.name === 'deploy');
  requireSafe(matches.length === 1, 'ambiguous-deploy-job');
  const job = matches[0];
  requireSafe(id(job.id) && String(job.run_id) === String(context.runId) && job.head_sha === context.commit && job.status === 'completed'
   && job.conclusion === 'success' && job.steps?.some(s => s.name === VERIFY_STEP && s.status === 'completed' && s.conclusion === 'success'), 'deploy-not-verified');
  report.jobId = job.id;
  report.stage = 'public-snapshot'; requireSafe(await verifyPublic(context), 'public-snapshot-unverified'); budget();
  report.stage = 'inventory';
  const inventory = await list();
  report.before = structuredClone(inventory);
  const possible = [];
  for (const d of inventory.filter(d => ownedRecord(d) && d.sha === context.commit)) {
   const s = await status(d); const owner = statusOwner(s);
   if (s?.state === 'success' && owner?.runId === String(context.runId) && owner.jobId === String(job.id)) possible.push(d);
  }
  requireSafe(possible.length === 1, 'ambiguous-current-deployment');
  current = possible[0]; report.protectedId = current.id;
  await guardCurrent();
  const cache = new Map();
  report.stage = 'plan';
  // Finish the complete paginated inventory and plan before mutating a shrinking collection.
  for (const d of inventory) {
   if (d.id === current.id) { report.retained.push({ id: d.id, reason: 'current' }); continue; }
   if (!ownedRecord(d) || timestamp(d.created_at) >= timestamp(current.created_at)) { report.retained.push({ id: d.id, reason: 'scope-or-age' }); continue; }
   const s = await status(d); const owner = statusOwner(s);
   if (!terminal.has(s?.state) || !owner || owner.runId === String(context.runId)) { report.retained.push({ id: d.id, reason: 'running-or-unknown' }); continue; }
   if (!cache.has(owner.runId)) cache.set(owner.runId, await call(`/actions/runs/${owner.runId}`));
   const source = cache.get(owner.runId);
   if (source?.path !== '.github/workflows/catalog.yml' || source.head_sha !== d.sha || source.head_branch !== 'main'
    || source.repository?.full_name !== REPO || source.head_repository?.full_name !== REPO
    || !['schedule', 'workflow_dispatch'].includes(source.event) || source.status !== 'completed') {
    report.retained.push({ id: d.id, reason: 'unproven-owner' }); continue;
   }
   const oldJob = await call(`/actions/jobs/${owner.jobId}`);
   if (String(oldJob?.id) !== owner.jobId || String(oldJob.run_id) !== owner.runId || oldJob.head_sha !== d.sha || oldJob.name !== 'deploy'
    || oldJob.status !== 'completed' || !['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale', 'startup_failure'].includes(oldJob.conclusion)) {
    report.retained.push({ id: d.id, reason: 'job-not-terminal' }); continue;
   }
   report.candidates.push({ id: d.id, sha: d.sha, createdAt: d.created_at, runId: owner.runId, jobId: owner.jobId, state: s.state });
  }
  requireSafe(report.candidates.length <= policy.maxDeletes, 'deletion-limit');
  await persist();
  if (!apply) { report.succeeded = true; report.reason = 'dry-run-no-writes'; report.stage = 'complete'; await persist(); return report; }
  report.stage = 'pruning';
  for (const candidate of report.candidates) {
   requireSafe(await verifyPublic(context), 'public-snapshot-changed'); budget();
   const original = inventory.find(d => d.id === candidate.id);
   // Each mutation below rechecks the current record and full candidate identity after throttling.
   // The plan state selects the operation; candidateGuard freshly checks identity/status before every write.
   const s = { state: candidate.state };
   const candidateGuard = async required => {
    const d = await call(`/deployments/${candidate.id}`); const state = await status(d); const who = statusOwner(state);
    requireSafe(sameRecord(d, original) && d.id !== current.id && terminal.has(state?.state)
     && who?.runId === candidate.runId && who.jobId === candidate.jobId && (!required || state.state === required), 'candidate-write-race');
   };
   const action = { id: candidate.id, stage: 'prepared' }; report.actions.push(action); await persist();
   if (s.state !== 'inactive') {
    const response = await mutate(`/deployments/${candidate.id}/statuses`, 'POST', { state: 'inactive', auto_inactive: false, log_url: `https://github.com/${REPO}/actions/runs/${candidate.runId}/job/${candidate.jobId}`, description: 'Superseded by verified Pages deployment' }, () => candidateGuard());
    requireSafe(response?.state === 'inactive', 'inactivation-unconfirmed');
    action.stage = 'inactive'; await persist();
   }
   // candidateGuard('inactive') below confirms the POST outcome immediately before DELETE.
   await mutate(`/deployments/${candidate.id}`, 'DELETE', undefined, () => candidateGuard('inactive'));
   action.stage = 'deleted'; await persist();
  }
  report.stage = 'final-verification'; await guardCurrent();
  const remaining = await list();
  report.remaining = remaining.map(d => ({ id: d.id, sha: d.sha, environment: d.environment }));
  requireSafe(remaining.some(d => sameRecord(d, current)), 'current-record-missing');
  requireSafe(report.actions.filter(a => a.stage === 'deleted').every(a => !remaining.some(d => d.id === a.id)), 'deletion-not-confirmed');
  report.succeeded = true; report.reason = remaining.length === 1 ? 'current-only' : 'protected-records-retained'; report.stage = 'complete';
 } catch (error) {
  report.reason = error instanceof SafetyError ? error.code : 'request-or-validation-failed';
 }
 await persist(); return report;
}

export function githubApi({ token, fetcher = globalThis.fetch, timeoutMs = PRUNE_POLICY.requestTimeoutMs } = {}) {
 requireSafe(typeof token === 'string' && token.length > 0, 'missing-token');
 return async (path, { method = 'GET', body } = {}) => {
  const read = /^\/(?:deployments\?environment=github-pages&per_page=(?:1|100)&page=[1-9][0-9]*|deployments\/[1-9][0-9]*(?:\/statuses\?per_page=1)?|actions\/runs\/[1-9][0-9]*(?:\/attempts\/[1-9][0-9]*\/jobs\?per_page=100)?|actions\/jobs\/[1-9][0-9]*)$/;
  const write = (method === 'POST' && /^\/deployments\/[1-9][0-9]*\/statuses$/.test(path) && body?.state === 'inactive' && body.auto_inactive === false)
   || (method === 'DELETE' && /^\/deployments\/[1-9][0-9]*$/.test(path) && body === undefined);
  requireSafe(method === 'GET' ? read.test(path) && body === undefined : write, 'api-allowlist');
  const response = await fetcher(API + path, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), cache: 'no-store',
   headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'pi-free-catalog-retention', 'cache-control': 'no-cache' },
   ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const expected = method === 'DELETE' ? 204 : method === 'POST' ? 201 : 200;
  if (response.status !== expected) { await response.body?.cancel().catch(() => {}); throw new SafetyError(`api-http-${response.status}`); }
  if (expected === 204) return null;
  const bytes = await boundedBody(response, 4 * 1024 * 1024);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new SafetyError('api-json'); }
 };
}

export function publicVerifier({ expectedRules, fetcher = globalThis.fetch } = {}) {
 return async c => {
  // This request has no GitHub authorization header and can only reach the fixed public snapshot URL.
  const { data, bodySha256 } = await readJSON(PREVIOUS_URL, { cacheBust: true, maxBytes: MAX_SNAPSHOT_BYTES, timeoutMs: PRUNE_POLICY.requestTimeoutMs, fetcher });
  const snapshot = validateSnapshot(data, { expectedRules });
  requireSafe(bodySha256 === c.expected && snapshot.producer.commit === c.commit && snapshot.producer.runId === String(c.runId), 'public-producer-or-hash');
  return true;
 };
}

async function main() {
 const args = process.argv.slice(2); const apply = args.length === 1 && args[0] === '--apply';
 const output = 'artifacts/catalog/deployment-retention.json';
 await mkdir('artifacts/catalog', { recursive: true });
 let report;
 try {
  requireSafe(args.length <= 1 && (!args.length || ['--apply', '--dry-run'].includes(args[0])), 'cli-arguments');
  requireSafe(!apply || process.env.GITHUB_ACTIONS === 'true', 'apply-requires-actions');
  const context = { repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF, commit: process.env.GITHUB_SHA,
   runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, event: process.env.GITHUB_EVENT_NAME, expected: process.env.EXPECTED_SNAPSHOT_SHA256 };
  validateContext(context);
  const api = githubApi({ token: process.env.GH_DEPLOYMENTS_TOKEN });
  report = await pruneDeployments({ context, api, apply, verifyPublic: publicVerifier({ expectedRules: await rulesHash() }),
   onReport: r => writeFile(output, JSON.stringify(r, null, 2) + '\n') });
 } catch (error) { report = { succeeded: false, reason: error instanceof SafetyError ? error.code : 'configuration-error', mode: apply ? 'apply' : 'dry-run' }; }
 await writeFile(output, JSON.stringify(report, null, 2) + '\n');
 console.log(`Pages deployment retention: ${report.reason}; protected=${report.protectedId ?? 'none'}; deleted=${report.actions?.filter(a => a.stage === 'deleted').length ?? 0}; retained=${report.remaining?.length ?? 0}.`);
 if (!report.succeeded) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
