import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { verifyGeneralLoader } from '../scripts/verify-general-loader.mjs';
test('native bundled CLI mixed-provider scheduling survives separate processes in host-only and local-peer layouts',{timeout:180000},async()=>{
 const rows=await verifyGeneralLoader(fileURLToPath(new URL('../',import.meta.url)));
 assert.equal(rows.length,4);
 for(const row of rows){assert.equal(row.rotation.paused,true);assert.equal(row.rotation.completed,1);assert.equal(row.launches.length,row.mixed?4:3);assert.equal(row.socketNetwork,false);}
});

test('actual bundled CLI continuity upgrade and model-local 429 fallback survive separate processes in host-only/local-peer layouts',{timeout:180000},async()=>{
 const rows=await verifyGeneralLoader(fileURLToPath(new URL('../',import.meta.url)),{continuity:true});assert.equal(rows.length,2);for(const row of rows){assert.equal(row.continuity,true);assert.equal(row.rotation.paused,false);assert.equal(row.launches.length,2);assert.equal(row.socketNetwork,false);}
});
