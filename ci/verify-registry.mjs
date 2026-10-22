import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { json, checkArtifact, checkPublishedBytes, registryJson, boundedBody, tarballUrl, REGISTRY, PACKAGE, run } from './lib.mjs';
assert.ok(process.env.EXPECTED_SHA256, 'Missing tested-artifact hash');
const { receipt } = await checkArtifact('artifacts/release',await json('package.json'),{expectedSha256:process.env.EXPECTED_SHA256,commit:run('git',['rev-parse','HEAD']).trim()});
const attempts = []; let verified = false;
// At most 12 attempts, with bounded per-request time and a 20-minute job timeout.
// A failed verification never retries npm publish or attempts to repair latest.
for (let attempt=1; attempt<=12; attempt++) {
  try {
    const version = await registryJson(`${REGISTRY}/${PACKAGE}/${receipt.version}`);
    const tags = await registryJson(`${REGISTRY}/-/package/${PACKAGE}/dist-tags`);
    const url = tarballUrl(version.dist,receipt.version);
    const response = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{'cache-control':'no-cache'}});
    assert.equal(response.status,200,`Tarball HTTP ${response.status}`);
    const bytes = await boundedBody(response,5*1024*1024);
    checkPublishedBytes(receipt,version,tags,bytes);
    attempts.push({attempt,at:new Date().toISOString(),result:'verified'});
    await writeFile('artifacts/release/registry-verification.json',JSON.stringify({name:receipt.name,version:receipt.version,sha256:receipt.sha256,bytes:bytes.length,latest:tags.latest,attempts},null,2)+'\n');
    verified=true; console.log(`Registry version/latest/exact downloaded TGZ: VERIFIED ${receipt.version} ${receipt.sha256}`); break;
  } catch (error) {
    attempts.push({attempt,at:new Date().toISOString(),result:'not-yet-verified',error:error.message});
    await writeFile('artifacts/release/registry-verification.json',JSON.stringify({verified:false,attempts},null,2)+'\n');
    console.log(`Registry verification attempt ${attempt}/12 has not passed.`);
    if (attempt<12) await delay(15000);
  }
}
assert.ok(verified,'Publication could have succeeded but registry verification did not finish. Inspect npm and this run; NEVER blindly republish.');
