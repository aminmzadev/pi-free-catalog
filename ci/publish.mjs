// This entrypoint cannot publish from a local shell, a PR, a fork, or a manual dry run.
import assert from 'node:assert/strict';
import { json, checkRelease, checkReleaseGit, checkArtifact, assertUnpublished, run, REGISTRY } from './lib.mjs';
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Publishing requires GitHub Actions');
assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'GitHub OIDC is unavailable');
assert.ok(process.env.EXPECTED_SHA256, 'Missing tested-artifact hash from the build job');
assert.ok(!process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN, 'Do not use persistent npm tokens');
const pkg = await json('package.json'), lock = await json('package-lock.json');
const release = checkRelease({ eventName:process.env.GITHUB_EVENT_NAME, repository:process.env.GITHUB_REPOSITORY, ref:process.env.GITHUB_REF, sha:process.env.GITHUB_SHA, event:await json(process.env.GITHUB_EVENT_PATH) },pkg,lock);
checkReleaseGit(release);
const { file } = await checkArtifact('artifacts/release',pkg,{expectedSha256:process.env.EXPECTED_SHA256,commit:release.commit});
await assertUnpublished(release.version);
// Tests and clean installed-TGZ checks already passed. Never rebuild or run package hooks here.
run('npm',['publish',file,'--ignore-scripts','--access=public','--tag=latest','--provenance',`--registry=${REGISTRY}/`],{inherit:true});
console.log('Publication request accepted. Registry visibility and exact bytes must still be verified.');
