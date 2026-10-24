import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
test('actual npm pack excludes Python bytecode, caches, credentials and node_modules; contains all production modules',()=>{
 const result=spawnSync('npm',['pack','--dry-run','--ignore-scripts','--json'],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const parsed=JSON.parse(result.stdout);const packed=Array.isArray(parsed)?parsed[0]:Object.values(parsed)[0];assert.ok(packed&&Array.isArray(packed.files),'npm pack --json shape not recognised');const files=packed.files.map(f=>f.path);assert.ok(files.length>20);
 for(const path of files)assert.ok(!/(?:^|\/)(?:node_modules|__pycache__|\.npmrc|\.env)(?:\/|$)|\.pyc$/.test(path),path);
 for(const path of ['src/ovh-pool-editor.js','src/ovh-quota.js','src/ovh-pool-budget.js','THIRD-PARTY-NOTICES.md','scripts/verify-local-loader.mjs','test/local-loader.test.mjs','src/index.js','src/sdk.js','src/catalog.js','src/models.js','src/transport.js','src/ovh.js','src/lifecycle.js','scripts/verify-ovh-live.mjs','test/release-six.test.mjs','test/ovh.test.mjs','test/ovh-session.test.mjs','test/fixtures/ovh-models.json.gz','test/fixtures/ovh-catalog.json.gz','test/fixtures/kilo.json.gz'])assert.ok(files.includes(path),path);
});
test('Persian README is removed from source, English README and the published tarball',async()=>{
 const {readFile,access}=await import('node:fs/promises');
 await assert.rejects(access(new URL('../README-fa.md',import.meta.url)));
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));assert.ok(!pkg.files.includes('README-fa.md'));
 const readme=await readFile(new URL('../README.md',import.meta.url),'utf8');assert.ok(!readme.includes('README-fa.md'));
 const r=spawnSync('npm',['pack','--dry-run','--ignore-scripts','--json'],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8'});assert.equal(r.status,0);
 const d=JSON.parse(r.stdout),pack=Array.isArray(d)?d[0]:Object.values(d)[0];assert.ok(!pack.files.some(f=>f.path==='README-fa.md'));assert.ok(pack.files.some(f=>f.path==='src/footer.js'));assert.ok(pack.files.some(f=>f.path==='src/thinking-sync.js'));
});
