import assert from 'node:assert/strict';

// Repository-only identity constructor. No caller-supplied host, path or query.
export function deploymentPath(runId, hash) {
 assert.equal(typeof runId, 'string');
 assert.match(runId, /^[1-9][0-9]{0,30}$/);
 assert.equal(typeof hash, 'string');
 assert.match(hash, /^[a-f0-9]{64}$/);
 return `catalog/v1/runs/${runId}/${hash}.json`;
}
export function deploymentURL(runId, hash) {
 return 'https://aminmzadev.github.io/pi-free-catalog/' + deploymentPath(runId, hash);
}
