import { deploymentPath, deploymentURL } from './deployment-path.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { run, outputs } from '../lib.mjs';
import { loadPrevious, collect, rulesHash, canonical, sha256, REPOSITORY } from './core.mjs';
const bootstrap = process.env.CATALOG_BOOTSTRAP === 'true';
const allowLargeChanges = process.env.CATALOG_APPROVE_LARGE_CHANGES === 'true';
// Never leave an old successful output eligible for a later failed invocation.
await rm('artifacts/catalog/site',{recursive:true,force:true});
await mkdir('artifacts/catalog',{recursive:true});
for (const file of ['report.json','failure.json','rejected-candidate.json']) await rm('artifacts/catalog/'+file,{force:true});
try {
const sha = run('git',['rev-parse','HEAD']).trim();
if (process.env.GITHUB_ACTIONS === 'true') {
  assert.equal(process.env.GITHUB_REPOSITORY,REPOSITORY); assert.equal(process.env.GITHUB_REF,'refs/heads/main');
  assert.equal(process.env.GITHUB_SHA,sha); assert.ok(['schedule','workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME));
  if (bootstrap || allowLargeChanges) assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');
  assert.equal(run('git',['status','--porcelain','--untracked-files=normal']).trim(),'','Checkout is modified');
}

  const expectedRules=await rulesHash(), previous=await loadPrevious({bootstrap,expectedRules});
  const snapshot=await collect({previous,expectedRules,allowLargeChanges,producer:{repository:REPOSITORY,workflow:'catalog.yml',commit:sha,runId:process.env.GITHUB_RUN_ID || null}});
  const text=canonical(snapshot)+'\n';
  const site='artifacts/catalog/site';await mkdir(site+'/catalog/v2',{recursive:true});
  // Publish only this run proof. Future deployments may remove old proof URLs, never overwrite their content.
  const uniquePath=deploymentPath(snapshot.producer.runId,sha256(text));
  await mkdir(site+'/'+uniquePath.slice(0,uniquePath.lastIndexOf('/')),{recursive:true});
  await writeFile(site+'/'+uniquePath,text);
  await writeFile(site+'/catalog/v2/latest.json',text);
  await writeFile(site+'/catalog/v2/schema.json',await readFile(new URL('./schema-v2.json',import.meta.url)));
  await writeFile(site+'/index.html','<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pi Free Catalog</title><h1>Pi Free Catalog</h1><p>Public model metadata. This site does not proxy inference.</p><p><a href="catalog/v2/latest.json">Version 2 snapshot</a> | <a href="catalog/v2/schema.json">JSON Schema</a></p></html>\n');
  await writeFile('artifacts/catalog/report.json',JSON.stringify({generatedAt:snapshot.generatedAt,producer:snapshot.producer,quality:snapshot.quality,summary:snapshot.summary,snapshotSHA256:sha256(text),deploymentURL:deploymentURL(snapshot.producer.runId,sha256(text)),sources:Object.fromEntries(Object.entries(snapshot.sources).map(([name,s])=>[name,{status:s.status,fetchedAt:s.fetchedAt,attemptedAt:s.attemptedAt,rowCount:s.rowCount,failure:s.failure}]))},null,2)+'\n');
  await outputs({ snapshot_sha256:sha256(text) });
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,`## Catalog snapshot\n\nStatus: **${snapshot.quality.status}**. Fresh sources: ${snapshot.quality.freshSources}/7.\n\nSHA256: \`${sha256(text)}\`\n\nSee report.json for original per-source fetchedAt timestamps and failures.\n`,{flag:'a'});
  console.log(`Validated snapshot: ${snapshot.quality.status}, ${snapshot.quality.freshSources}/7 fresh sources, SHA256 ${sha256(text)}`);
} catch (error) {
  await rm('artifacts/catalog/site',{recursive:true,force:true});
  if (error.candidate) await writeFile('artifacts/catalog/rejected-candidate.json',canonical(error.candidate)+'\n');
  await writeFile('artifacts/catalog/failure.json',JSON.stringify({status:'failed',deployable:false,error:String(error.message).slice(0,8192),details:error.details || null},null,2)+'\n');
  console.error('Catalog build failed; no deployable site was produced. See failure.json.');process.exitCode=1;
}
