// Integration-only regressions. Public HTTP is replaced with factual metadata fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as backend from '../catalog/core.mjs';
import * as contract from '../../src/snapshot-contract.js';
import { fixtures } from '../../test/helpers.mjs';
import { snapshotFixture } from '../../test/snapshot-helper.mjs';

const now = '2026-10-22T00:00:00.000Z';
const producer = { repository: contract.REPOSITORY, workflow: 'catalog.yml', commit: 'a'.repeat(40), runId: '42' };

test('integrated backend re-exports the shipped snapshot contract rather than a divergent validator', () => {
  for (const name of ['sha256', 'canonical', 'dataHash', 'normalize', 'timestamp', 'rulesHash', 'project', 'rowCount', 'asState', 'seal', 'validateSnapshot']) {
    assert.equal(backend[name], contract[name], name);
  }
});

test('integrated collector output satisfies the shipped client contract with exactly seven anonymous fixture GETs', async () => {
  const requests = [];
  const expectedRules = await contract.rulesHash();
  const snapshot = await backend.collect({ now, producer, expectedRules, fetcher: async (url, init) => {
    const source = contract.SOURCE_NAMES.find(name => contract.SOURCES[name] === url);
    assert.ok(source, 'Only approved metadata URLs may be requested');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.ok(!new Headers(init.headers).has('authorization'));
    assert.ok(!new Headers(init.headers).has('cookie'));
    requests.push(source);
    return Response.json(fixtures[source]);
  } });
  assert.deepEqual(requests.sort(), [...contract.SOURCE_NAMES].sort());
  assert.equal(contract.validateSnapshot(snapshot, { expectedRules, now: Date.parse(now) }), snapshot);
  const clientFixture = await snapshotFixture({ at: now });
  assert.deepEqual(snapshot.catalog.entries, clientFixture.catalog.entries);
  assert.deepEqual(snapshot.summary, clientFixture.summary);
  assert.equal(snapshot.rulesHash, clientFixture.rulesHash);
});

test('client and backend both reject a resealed but semantically inconsistent snapshot', async () => {
  const snapshot = await snapshotFixture({ at: now });
  const expectedRules = await contract.rulesHash();
  for (const module of [backend, contract]) {
    assert.equal(module.validateSnapshot(snapshot, { expectedRules, now: Date.parse(now) }), snapshot);
    const changed = structuredClone(snapshot);
    changed.summary.ovh.free++;
    assert.throws(() => module.validateSnapshot(contract.seal(changed), { expectedRules, now: Date.parse(now) }), /Summary mismatch/);
  }
});
