// Always invokes --dry-run. An existing-version refusal is an explicit negative test, not a publish success.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { json, checkArtifact, registryJson, assertUnpublished, checkDryRunResult, REGISTRY, PACKAGE, run } from './lib.mjs';
assert.ok(process.env.EXPECTED_SHA256,'Missing tested-artifact hash');
const pkg=await json('package.json');
const options={expectedSha256:process.env.EXPECTED_SHA256,commit:run('git',['rev-parse','HEAD']).trim()};
const {file,receipt}=await checkArtifact('artifacts/release',pkg,options);
const published=await registryJson(`${REGISTRY}/${PACKAGE}/${receipt.version}`,{allow404:true});
if(published){assert.equal(published.name,PACKAGE);assert.equal(published.version,receipt.version);}
else await assertUnpublished(receipt.version);
const result=spawnSync('npm',['publish',file,'--dry-run','--ignore-scripts','--access=public','--tag=latest',`--registry=${REGISTRY}/`],{encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,NPM_CONFIG_COLOR:'false'}});
if(result.error)throw result.error;
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
const mode=checkDryRunResult(result.status,result.stderr||'',Boolean(published),receipt.version);
await checkArtifact('artifacts/release',pkg,options);
await writeFile('artifacts/release/dry-run.json',JSON.stringify({mode,name:receipt.name,version:receipt.version,sha256:receipt.sha256,npmExitStatus:result.status,actuallyPublished:false,oidcAuthorizationTested:false},null,2)+'\n');
console.log(`PASS: ${mode}. No publication or OIDC authorization was performed.`);
