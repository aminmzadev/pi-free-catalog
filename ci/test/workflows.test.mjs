// Focused policy assertions, not a YAML parser. Pinned actionlint validates full Actions semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const ci=await readFile(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
const publish=await readFile(new URL('../../.github/workflows/publish.yml',import.meta.url),'utf8');
const pkg=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
test('every third-party action is official and pinned to an immutable full commit',()=>{for(const content of [ci,publish])for(const line of content.split('\n').filter(l=>l.includes('uses:')))assert.match(line,/uses: actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@[0-9a-f]{40} # v/);});
test('CI covers main pushes and PRs on both exact Node/npm versions',()=>{
 assert.match(ci,/push:\s+branches: \[main\]/);assert.match(ci,/pull_request:\s+branches: \[main\]/);
 for(const version of ['22.19.0','26.0.0','10.9.3','11.12.1'])assert.ok(ci.includes("'"+version+"'"));
 assert.ok(ci.includes('npm ci --ignore-scripts'));assert.ok(ci.includes('npm run verify'));assert.ok(ci.includes('node ci/test-installed.mjs'));
});
test('only guarded publish job obtains OIDC; dispatch stays build/dry-run only',()=>{
 const [,build,publisher]=publish.split(/\n  (?:build|publish):\n/);assert.ok(build&&publisher);assert.ok(!build.includes('id-token:'));assert.equal((publish.match(/id-token: write/g)||[]).length,1);assert.ok(!ci.includes('id-token:'));
 assert.match(publisher,/if: .*github\.event_name == 'release'.*github\.event\.action == 'published'.*draft == false.*prerelease == false/);
 assert.match(publish,/release:\s+types: \[published\]/);assert.ok(!/^  (push|schedule|pull_request):/m.test(publish));assert.match(publisher,/environment: npm-publish/);assert.match(publish,/group: npm-publish-pi-free-catalog\s+cancel-in-progress: false/);
});
test('publisher downloads immutable same-run artifact ID with independent SHA256',()=>{
 assert.match(publish,/artifact-id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);assert.match(publish,/artifact-ids: \$\{\{ needs\.build\.outputs\.artifact-id \}\}/);assert.match(publish,/EXPECTED_SHA256: \$\{\{ needs\.build\.outputs\.sha256 \}\}/);assert.match(publish,/digest-mismatch: error/);
 const publisher=publish.split('\n  publish:\n')[1];assert.ok(!publisher.includes('npm pack'));assert.ok(!publisher.includes('npm ci'));assert.ok(!publisher.includes('npm install'));
});
test('no persistent npm secrets, pull_request_target or persisted checkout credentials',()=>{for(const content of [ci,publish]){assert.ok(!/secrets\.(?:NPM_TOKEN|NODE_AUTH_TOKEN)|pull_request_target|persist-credentials: true|contents: write|packages: write/.test(content));assert.equal((content.match(/uses: actions\/checkout@/g)||[]).length,(content.match(/persist-credentials: false/g)||[]).length);}});
test('repo-only automation never becomes mandatory shipped tests or runtime dependency',()=>{
 assert.ok(!pkg.files.some(p=>p.startsWith('ci')||p.startsWith('.github')));assert.ok(!Object.values(pkg.scripts).some(s=>s.includes('ci/')));assert.deepEqual(Object.keys(pkg.devDependencies).sort(),['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','@earendil-works/pi-tui']);
});
