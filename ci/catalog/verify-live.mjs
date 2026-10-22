import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readJSON, validateSnapshot, rulesHash, PREVIOUS_URL, MAX_SNAPSHOT_BYTES, canonical, sha256 } from './core.mjs';
const expected=process.env.EXPECTED_SNAPSHOT_SHA256;
assert.equal(typeof expected,'string');assert.equal(expected.length,64);assert.match(expected,/^[a-f0-9]{64}$/);
const rules=await rulesHash();let verified=false;
for(let attempt=1;attempt<=6;attempt++){
 try{
  const {data,bodySha256}=await readJSON(PREVIOUS_URL,{maxBytes:MAX_SNAPSHOT_BYTES});
  assert.equal(bodySha256,expected,'Public file bytes differ from validated build');
  const snapshot=validateSnapshot(data,{expectedRules:rules});
  assert.equal(snapshot.producer.commit,process.env.GITHUB_SHA);assert.equal(snapshot.producer.runId,process.env.GITHUB_RUN_ID);
  assert.equal(sha256(canonical(snapshot)+'\n'),expected);
  verified=true;console.log(`Public Pages snapshot VERIFIED: exact bytes, contract, commit/run; attempt ${attempt}/6.`);break;
 }catch{
  console.log(`Public Pages verification not yet passed (${attempt}/6).`);
  if(attempt<6)await delay(10000);
 }
}
assert.ok(verified,'Pages deployment may already have succeeded, but public verification did not finish. Inspect propagation/run diagnostics; do not reset history or bypass validation.');
