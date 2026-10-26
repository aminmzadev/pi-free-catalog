import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { sha256, canonical, seal } from '../catalog/core.mjs';
const workflow=await readFile(new URL('../../.github/workflows/catalog.yml',import.meta.url),'utf8');
const originalPublish=await readFile(new URL('../../.github/workflows/publish.yml',import.meta.url),'utf8');

test('catalog schedule is every 15 minutes off the hour; manual inputs are explicit booleans',()=>{
 assert.match(workflow,/cron: '7,22,37,52 \* \* \* \*'/);assert.match(workflow,/workflow_dispatch:/);assert.equal((workflow.match(/type: boolean/g)||[]).length,2);assert.equal((workflow.match(/default: false/g)||[]).length,2);
 assert.ok(!/^  (push|release|pull_request|pull_request_target):/m.test(workflow));
});
test('collector has read-only permission and no npm install, credentials or inference job',()=>{
 const collector=workflow.split('\n  collect:\n')[1].split('\n  deploy:\n')[0];
 assert.match(collector,/permissions:\s+contents: read/);assert.ok(!/id-token:|pages: write|contents: write|secrets\.|npm (?:ci|install|publish)|NODE_AUTH_TOKEN|NPM_TOKEN/.test(collector));
 assert.match(collector,/node --test ci\/test\/catalog\*\.test\.mjs/);assert.match(collector,/node ci\/catalog\/collect\.mjs/);
});
test('one concurrency lock covers build, deploy and cleanup; all jobs guard exact repository and main',()=>{
 assert.match(workflow,/concurrency:\s+group: catalog-pages\s+cancel-in-progress: false/);
 assert.equal((workflow.match(/if: github.repository == 'aminmzadev\/pi-free-catalog' && github.ref == 'refs\/heads\/main'/g)||[]).length,3);
 assert.equal((workflow.match(/ref: \$\{\{ github.sha \}\}/g)||[]).length,3);
});
test('Pages deployment verifies artifact ID, digest and independent build hash before deploying',()=>{
 const deployment=workflow.split('\n  deploy:\n')[1].split('\n  cleanup:\n')[0];
 assert.match(deployment,/pages: write/);assert.match(deployment,/id-token: write/);assert.match(deployment,/name: github-pages/);assert.ok(!deployment.includes('npm-publish'));
 assert.match(deployment,/artifact-ids: \$\{\{ needs.collect.outputs.artifact-id \}\}/);assert.match(deployment,/digest-mismatch: error/);assert.match(deployment,/EXPECTED_SNAPSHOT_SHA256: \$\{\{ needs.collect.outputs.snapshot-sha256 \}\}/);
 assert.ok(deployment.indexOf('node ci/catalog/verify-pages.mjs')<deployment.indexOf('uses: actions/deploy-pages@'));assert.ok(!deployment.includes('node ci/catalog/collect.mjs'));assert.ok(deployment.indexOf('node ci/catalog/verify-live.mjs')>deployment.indexOf('uses: actions/deploy-pages@'));
});
test('all catalog actions use official owners and full immutable commit SHAs',()=>{
 for(const line of workflow.split('\n').filter(l=>l.includes('uses:')))assert.match(line,/uses: actions\/[a-z-]+@[a-f0-9]{40} # v/);
});
test('catalog cannot dispatch npm publish and npm release triggers remain unchanged',()=>{
 assert.ok(!/workflow_run:|repository_dispatch:|\/dispatches|gh release|npm publish|npm version/.test(workflow));
 assert.match(originalPublish,/release:\s+types: \[published\]/);assert.ok(!originalPublish.includes('workflow_run:'));
});
test('actual CLI bootstraps, retains LKG, validates exact Pages tar and removes stale output on failure',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'catalog-pipeline-')), repo=join(temp,'repo');await mkdir(repo);
 const exec=(command,args,env={},cwd=repo)=>spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,...env}});
 const success=result=>assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 try{
  const names=['src/snapshot-contract.js','src/catalog.js','src/lifecycle.js','src/ovh.js','ci/lib.mjs','ci/catalog/core.mjs','ci/catalog/deployment-path.mjs','ci/catalog/collect.mjs','ci/catalog/verify-pages.mjs','ci/catalog/verify-live.mjs','ci/catalog/schema-v1.json'];
  for(const name of names){await mkdir(join(repo,name.substring(0,name.lastIndexOf('/'))),{recursive:true});await copyFile(new URL('../../'+name,import.meta.url),join(repo,name));}
  await writeFile(join(repo,'package.json'),'{"type":"module","private":true}');await writeFile(join(repo,'.gitignore'),'artifacts/\n');
  success(exec('git',['init','-q','-b','main']));success(exec('git',['add','.']));success(exec('git',['-c','user.name=Catalog Test','-c','user.email=ci@example.invalid','commit','-qm','Offline fixture test repository']));
  const commit=exec('git',['rev-parse','HEAD']).stdout.trim();
  const map={kilo:'kilo',zen:'opencode',official:'opencode-capabilities',modelsdev:'models-dev',pi:'pi-opencode-catalog',ovh:'ovh-models',ovhmeta:'ovh-catalog'};
  const fixtures=Object.fromEntries(await Promise.all(Object.entries(map).map(async([name,file])=>[name,JSON.parse(gunzipSync(await readFile(new URL('../../test/fixtures/'+file+'.json.gz',import.meta.url))))])));
  await writeFile(join(temp,'fixtures.json'),JSON.stringify(fixtures));
  const mock=join(temp,'mock.mjs'),previous=join(temp,'previous.json');
  await writeFile(mock,`import {readFileSync} from 'node:fs';\nimport {createRequire,syncBuiltinESMExports} from 'node:module';\nif(process.env.TEST_FAST_CLOCK==='true'){let time=0;Object.defineProperty(performance,'now',{value:()=>time});createRequire(import.meta.url)('node:timers/promises').setTimeout=async ms=>{time+=ms;};syncBuiltinESMExports();}\nimport {SOURCES,PREVIOUS_URL} from ${JSON.stringify(new URL('file://'+join(repo,'ci/catalog/core.mjs')).href)};\nconst fixtures=JSON.parse(readFileSync(${JSON.stringify(join(temp,'fixtures.json'))}));\nglobalThis.fetch=async(url,init)=>{if(init.method!=='GET'||init.redirect!=='error')throw Error('Unsafe request');if(new URL(url).origin+new URL(url).pathname===PREVIOUS_URL){if(!new URL(url).searchParams.has('catalog_read'))throw Error('Warm CDN cache must not be used');if(process.env.TEST_PREVIOUS==='404')return new Response(null,{status:404});return new Response(readFileSync(${JSON.stringify(previous)}));}if(new URL(url).pathname.startsWith('/pi-free-catalog/catalog/v1/runs/')){const expected='https://aminmzadev.github.io/pi-free-catalog/catalog/v1/runs/'+process.env.GITHUB_RUN_ID+'/'+process.env.EXPECTED_SNAPSHOT_SHA256+'.json';if(new URL(url).origin+new URL(url).pathname!==expected)throw Error('Wrong immutable identity');return new Response(readFileSync(${JSON.stringify(join(repo,'artifacts/catalog/site'))}+'/'+new URL(url).pathname.slice('/pi-free-catalog/'.length)));}const name=Object.keys(SOURCES).find(n=>SOURCES[n]===url);if(!name)throw Error('Unapproved URL');if(process.env.TEST_FAILURE==='all'||process.env.TEST_FAILURE===name)throw Error('Offline');return Response.json(fixtures[name]);};\n`);
  const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'aminmzadev/pi-free-catalog',GITHUB_REF:'refs/heads/main',GITHUB_SHA:commit,GITHUB_RUN_ID:'4242',GITHUB_EVENT_NAME:'workflow_dispatch',CATALOG_BOOTSTRAP:'true',CATALOG_APPROVE_LARGE_CHANGES:'false',TEST_PREVIOUS:'404',TEST_FAILURE:'',GITHUB_OUTPUT:join(temp,'outputs'),GITHUB_STEP_SUMMARY:join(temp,'summary'),NODE_OPTIONS:''};
  const cli=changes=>exec(process.execPath,['--import',mock,'ci/catalog/collect.mjs'],{...env,...changes});
  success(cli({}));const snapshotFile=join(repo,'artifacts/catalog/site/catalog/v1/latest.json');const firstText=await readFile(snapshotFile,'utf8'),first=JSON.parse(firstText);assert.equal(first.quality.freshSources,7);await writeFile(previous,firstText);
  const uniqueFile=join(repo,'artifacts/catalog/site/catalog/v1/runs/4242/'+sha256(firstText)+'.json');
  assert.equal(await readFile(uniqueFile,'utf8'),firstText);
  await mkdir(join(repo,'artifacts/catalog/download'),{recursive:true});
  success(exec('tar',['-cf',join(repo,'artifacts/catalog/download/artifact.tar'),'-C',join(repo,'artifacts/catalog/site'),'.']));
  const verify=hash=>exec(process.execPath,['ci/catalog/verify-pages.mjs'],{...env,EXPECTED_SNAPSHOT_SHA256:hash});
  success(verify(sha256(firstText)));
  // A swapped/missing/extra run-specific file must fail even when latest.json is correct.
  await writeFile(uniqueFile,'{}');
  success(exec('tar',['-cf',join(repo,'artifacts/catalog/download/artifact.tar'),'-C',join(repo,'artifacts/catalog/site'),'.']));
  assert.notEqual(verify(sha256(firstText)).status,0);
  await rm(uniqueFile);
  success(exec('tar',['-cf',join(repo,'artifacts/catalog/download/artifact.tar'),'-C',join(repo,'artifacts/catalog/site'),'.']));
  assert.notEqual(verify(sha256(firstText)).status,0);
  await writeFile(uniqueFile,firstText);
  await writeFile(join(repo,'artifacts/catalog/site/catalog/v1/runs/4242/unexpected.json'),firstText);
  success(exec('tar',['-cf',join(repo,'artifacts/catalog/download/artifact.tar'),'-C',join(repo,'artifacts/catalog/site'),'.']));
  assert.notEqual(verify(sha256(firstText)).status,0);
  await rm(join(repo,'artifacts/catalog/site/catalog/v1/runs/4242/unexpected.json'));
  success(exec('tar',['-cf',join(repo,'artifacts/catalog/download/artifact.tar'),'-C',join(repo,'artifacts/catalog/site'),'.']));
  success(verify(sha256(firstText)));

  success(exec(process.execPath,['--import',mock,'ci/catalog/verify-live.mjs'],{...env,TEST_PREVIOUS:'valid',EXPECTED_SNAPSHOT_SHA256:sha256(firstText)}));
  const liveReport=JSON.parse(await readFile(join(repo,'artifacts/catalog/live-verification.json'),'utf8'));
  assert.equal(liveReport.verified,true);assert.equal(liveReport.attempts.length,1);assert.equal(liveReport.expectedSHA256,sha256(firstText));
  success(exec(process.execPath,['--import',mock,'ci/catalog/verify-live.mjs','--deployment'],{...env,EXPECTED_SNAPSHOT_SHA256:sha256(firstText)}));
  assert.equal(JSON.parse(await readFile(join(repo,'artifacts/catalog/deployment-verification.json'),'utf8')).outcome,'verified');
  success(exec(process.execPath,['--import',mock,'ci/catalog/verify-live.mjs','--freshness'],{...env,TEST_PREVIOUS:'valid',EXPECTED_SNAPSHOT_SHA256:sha256(firstText)}));
  const freshnessReport=JSON.parse(await readFile(join(repo,'artifacts/catalog/freshness-verification.json'),'utf8'));
  assert.equal(freshnessReport.outcome,'verified');
  assert.match(await readFile(join(temp,'outputs'),'utf8'),/latest_verified=true/);
  await writeFile(previous,canonical(seal({...first,producer:{...first.producer,runId:'4241'}}))+'\n');
  const deferred=exec(process.execPath,['--import',mock,'ci/catalog/verify-live.mjs','--freshness'],{...env,TEST_PREVIOUS:'valid',TEST_FAST_CLOCK:'true',EXPECTED_SNAPSHOT_SHA256:sha256(firstText)});
  success(deferred);assert.match(deferred.stderr,/::warning::/);
  const deferredReport=JSON.parse(await readFile(join(repo,'artifacts/catalog/freshness-verification.json'),'utf8'));
  assert.equal(deferredReport.verified,false);assert.equal(deferredReport.outcome,'deferred');assert.equal(deferredReport.attempts.length,18);assert.ok(deferredReport.attempts.every(a=>a.receivedProducer?.runId==='4241'&&a.validSnapshot===true));
  assert.match(await readFile(join(temp,'outputs'),'utf8'),/latest_verified=false/);
  await writeFile(previous,'{}');
  const corruptFreshness=exec(process.execPath,['--import',mock,'ci/catalog/verify-live.mjs','--freshness'],{...env,TEST_PREVIOUS:'valid',TEST_FAST_CLOCK:'true',EXPECTED_SNAPSHOT_SHA256:sha256(firstText)});
  assert.notEqual(corruptFreshness.status,0);assert.equal(JSON.parse(await readFile(join(repo,'artifacts/catalog/freshness-verification.json'),'utf8')).outcome,'failed');
  await writeFile(previous,firstText);
  const badLive=exec(process.execPath,['--import',mock,'ci/catalog/verify-live.mjs'],{...env,TEST_PREVIOUS:'valid',EXPECTED_SNAPSHOT_SHA256:'invalid'});
  assert.notEqual(badLive.status,0);assert.equal(JSON.parse(await readFile(join(repo,'artifacts/catalog/live-verification.json'),'utf8')).reason,'configuration-error');
  assert.notEqual(verify('0'.repeat(64)).status,0);
  success(cli({CATALOG_BOOTSTRAP:'false',GITHUB_EVENT_NAME:'schedule',TEST_PREVIOUS:'valid',TEST_FAILURE:'ovh'}));
  const next=JSON.parse(await readFile(snapshotFile,'utf8'));assert.equal(next.sources.ovh.status,'retained');assert.equal(next.sources.ovh.fetchedAt,first.sources.ovh.fetchedAt);assert.equal(next.sources.ovh.dataSha256,first.sources.ovh.dataSha256);
  assert.notEqual(cli({CATALOG_BOOTSTRAP:'false',GITHUB_EVENT_NAME:'schedule',TEST_PREVIOUS:'valid',TEST_FAILURE:'all'}).status,0);
  await assert.rejects(access(snapshotFile));await assert.rejects(access(join(repo,'artifacts/catalog/report.json')));assert.equal(JSON.parse(await readFile(join(repo,'artifacts/catalog/failure.json'),'utf8')).deployable,false);
  assert.notEqual(cli({GITHUB_EVENT_NAME:'schedule'}).status,0,'Scheduled bootstrap must be forbidden');
  assert.notEqual(cli({GITHUB_REF:'refs/heads/other'}).status,0,'Non-main branch must be forbidden');
  assert.notEqual(cli({GITHUB_REPOSITORY:'fork/other'}).status,0,'Fork must be forbidden');
  success(cli({}));await writeFile(previous,'{');assert.notEqual(cli({CATALOG_BOOTSTRAP:'false',TEST_PREVIOUS:'corrupt'}).status,0);await assert.rejects(access(snapshotFile));
  for(const [name,type]of[['../escape','file'],['escape','symlink'],['catalog/v1/latest.json','duplicate']]){
   const code=`import tarfile,io,sys\nwith tarfile.open(sys.argv[1],'w') as t:\n m=tarfile.TarInfo(sys.argv[2])\n if sys.argv[3]=='symlink':\n  m.type=tarfile.SYMTYPE;m.linkname='/etc/passwd';t.addfile(m)\n else:\n  b=b'{}';m.size=len(b);t.addfile(m,io.BytesIO(b))\n  if sys.argv[3]=='duplicate':t.addfile(m,io.BytesIO(b))\n`;
   success(exec('python3',['-c',code,join(repo,'artifacts/catalog/download/artifact.tar'),name,type]));assert.notEqual(verify(sha256(firstText)).status,0,'Unsafe tar must fail');
  }
 }finally{await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('public verification diagnostics upload on failure without weakening deployment permissions',()=>{
 const deployment=workflow.split('\n  deploy:\n')[1].split('\n  cleanup:\n')[0];
 assert.match(deployment,/name: Preserve public verification diagnostics\n        if: always\(\)/);
 assert.match(deployment,/name: catalog-live-verification/);assert.match(deployment,/artifacts\/catalog\/deployment-verification.json/);assert.match(deployment,/artifacts\/catalog\/freshness-verification.json/);assert.match(deployment,/retention-days: 14/);
 assert.equal((deployment.match(/permissions:/g)||[]).length,1);assert.ok(!/continue-on-error: true|contents: write|secrets\./.test(deployment));
});


test('publication and freshness have distinct proofs and stale latest gates cleanup', () => {
 const deployment=workflow.split('\n  deploy:\n')[1].split('\n  cleanup:\n')[0];
 const cleanup=workflow.split('\n  cleanup:\n')[1];
 assert.match(deployment,/latest-verified: \$\{\{ steps.freshness.outputs.latest_verified \}\}/);
 assert.ok(deployment.indexOf('verify-live.mjs --deployment') < deployment.indexOf('verify-live.mjs --freshness'));
 assert.match(cleanup,/needs.deploy.outputs.latest-verified == 'true'/);
 assert.match(cleanup,/if: steps.retention_preview.outputs.cleanup_ready == 'true'/);
 assert.doesNotMatch(workflow,/continue-on-error/);
});
