import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { verifyLocalLoader } from '../scripts/verify-local-loader.mjs';

test('real bundled Pi loads bare folders and installed-peer layouts with pool OFF/ON, and enabled helpers work offline', {timeout:180000}, async()=>{
 const rows=await verifyLocalLoader(fileURLToPath(new URL('../',import.meta.url)));
 assert.equal(rows.length,4);
 for(const row of rows){
  assert.equal(row.exitCode,0);
  assert.equal(row.poolHelperProbePassed,true);
  assert.equal(row.nonGETAttempts,0);
 }
});
