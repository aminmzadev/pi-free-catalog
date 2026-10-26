import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { snapshotFixture } from '../../test/snapshot-helper.mjs';
import { canonical, seal, sha256 } from '../catalog/core.mjs';

for (const mode of ['valid-stale', 'corrupt']) test('real cleanup CLI ' + mode + ' permits no mutation and emits a false apply gate', async () => {
 const temp = await mkdtemp(join(tmpdir(),'cleanup-deferred-'));
 try {
  const snapshot = await snapshotFixture();
  const current = seal({ ...snapshot, producer: { ...snapshot.producer, runId: '1000' } });
  const stale = seal({ ...current, producer: { ...current.producer, runId: '999' } });
  const expected = sha256(canonical(current)+'\n'), repo='aminmzadev/pi-free-catalog', commit=current.producer.commit;
  const body = mode === 'valid-stale' ? canonical(stale)+'\n' : '{}';
  const fixtureRun = { id:1000, head_sha:commit, head_branch:'main', repository:{full_name:repo}, head_repository:{full_name:repo}, path:'.github/workflows/catalog.yml', event:'schedule', run_attempt:1 };
  const fixtureJob = { id:5000, run_id:1000, head_sha:commit, name:'deploy', status:'completed', conclusion:'success', steps:[
   {name:'Verify run-specific public deployment',status:'completed',conclusion:'success'},
   {name:'Verify public Pages bytes and snapshot after bounded propagation wait',status:'completed',conclusion:'success'}] };
  const trace=join(temp,'trace.json'), loader=join(temp,'offline.mjs');
  await writeFile(loader,`import {writeFileSync} from 'node:fs';
import {createRequire,syncBuiltinESMExports} from 'node:module';
let clock=0;Object.defineProperty(performance,'now',{value:()=>clock});createRequire(import.meta.url)('node:timers/promises').setTimeout=async ms=>{clock+=ms;};syncBuiltinESMExports();
const calls=[];
globalThis.fetch=async(url,init)=>{calls.push({url,method:init.method});writeFileSync(${JSON.stringify(trace)},JSON.stringify(calls));
 if(init.method!=='GET')throw Error('No writes allowed by fixture');
 const u=new URL(url);
 if(u.origin+u.pathname==='https://aminmzadev.github.io/pi-free-catalog/catalog/v1/latest.json'){
  if(init.headers.authorization)throw Error('Provider credential leaked');return new Response(${JSON.stringify(body)});}
 if(url==='https://api.github.com/repos/aminmzadev/pi-free-catalog/actions/runs/1000')return Response.json(${JSON.stringify(fixtureRun)});
 if(url==='https://api.github.com/repos/aminmzadev/pi-free-catalog/actions/runs/1000/attempts/1/jobs?per_page=100')return Response.json({total_count:1,jobs:[${JSON.stringify(fixtureJob)}]});
 throw Error('Unexpected fixture request');};`);
  // Isolate CLI outputs; use absolute module path while cwd points at the temp directory.
  const result=spawnSync(process.execPath,['--import',loader,new URL('../catalog/prune-deployments.mjs',import.meta.url).pathname,'--apply'],{
   cwd:temp,encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:repo,GITHUB_REF:'refs/heads/main',GITHUB_SHA:commit,
    GITHUB_RUN_ID:'1000',GITHUB_RUN_ATTEMPT:'1',GITHUB_EVENT_NAME:'schedule',EXPECTED_SNAPSHOT_SHA256:expected,
    GH_DEPLOYMENTS_TOKEN:'fixture-token',GITHUB_OUTPUT:join(temp,'outputs'),GITHUB_STEP_SUMMARY:join(temp,'summary'),NODE_OPTIONS:''}});
  const report=JSON.parse(await readFile(join(temp,'artifacts/catalog/deployment-retention.json'),'utf8'));
  assert.equal(report.succeeded,false);assert.deepEqual(report.actions,[]);assert.equal(report.publicChecks.length,1);
  assert.ok(JSON.parse(await readFile(trace,'utf8')).every(r=>r.method==='GET'));
  assert.match(await readFile(join(temp,'outputs'),'utf8'),/cleanup_ready=false/);
  if(mode==='valid-stale') {assert.equal(result.status,0,result.stderr);assert.equal(report.deferred,true);assert.equal(report.reason,'latest-freshness-deferred');assert.match(result.stderr,/::warning::/);}
  else {assert.notEqual(result.status,0);assert.equal(report.deferred,false);assert.equal(report.reason,'public-snapshot-unverified');}
 } finally {await rm(temp,{recursive:true,force:true});}
});
