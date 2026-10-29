import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, SOURCES, PROVIDERS, recordKey, validateState } from '../src/catalog.js';
import { PREVIOUS_URL } from '../src/snapshot-contract.js';
import { anonymousHeaders } from '../src/transport.js';
import * as sdk from '../src/sdk.js';
import { piModel } from '../src/models.js';
import { migrateCatalogState, migrateThinkingSelections } from '../src/provider-removal.js';
import { fixtures, sources } from './helpers.mjs';
const K = recordKey('kilo', 'reflection/beam-free');
test('0.1.8 registers exactly Kilo and OVH, without a Zen alias', () => assert.deepEqual(PROVIDERS, { kilo: 'free-kilo', ovh: 'free-ovh' }));
test('only the three Kilo/OVH metadata sources remain', () => assert.deepEqual(Object.keys(SOURCES).sort(), ['kilo', 'ovh', 'ovhmeta']));
test('the reviewed two-provider contract has a separate v2 endpoint', () => assert.equal(PREVIOUS_URL, 'https://aminmzadev.github.io/pi-free-catalog/catalog/v2/latest.json'));
test('removed provider headers are rejected, never emulated', () => assert.throws(() => anonymousHeaders('zen', 'unused')));
test('native OpenCode classifier dependency is gone', () => assert.equal(sdk.classify, undefined));
test('removed providers cannot create a Pi model', () => assert.throws(() => piModel({ service: 'zen', metadata: {}, type: 'chat' }, { sources: {} })));
test('the saved-catalog guard rejects a removed provider before any inference lookup', () => assert.throws(() => new Catalog().assertUsable('zen', 'anything'), /Unknown free provider/));
test('remaining providers keep their models without name-based filtering', async () => {
  const { reconcile, summary } = await import('../src/catalog.js');
  const state = reconcile(sources(fixtures), {}, '2026-10-22T00:00:00.000Z');
  const counts = summary(state);
  assert.deepEqual(Object.keys(counts).sort(), ['kilo', 'ovh']);
  assert.equal(counts.kilo.listed, 400); assert.equal(counts.kilo.freeChat, 17);
  assert.equal(counts.ovh.listed, 22); assert.equal(counts.ovh.freeChat, 10);
  for (const service of ['kilo', 'ovh']) for (const row of fixtures[service].data) assert.ok(state.entries[recordKey(service, row.id)], `${service}/${row.id}`);
});
test('a saved cache from an older version migrates in memory without touching remaining records', () => {
  const removed = recordKey('zen', 'retired-model');
  const raw = {
    schemaVersion: 1, refreshedAt: '2026-10-22T00:00:00.000Z',
    sources: { kilo: { url: SOURCES.kilo, fresh: true, fetchedAt: '2026-10-22T00:00:00.000Z' }, zen: { url: 'https://opencode.ai/zen/v1/models', fresh: true }, official: { fresh: true }, modelsdev: { fresh: true }, pi: { fresh: true } },
    entries: {
      [K]: { service: 'kilo', id: 'reflection/beam-free', name: 'Beam', type: 'chat', classification: 'free', lifecycle: 'active', listed: true, listingOrigin: 'recorded-listed', firstSeen: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', raw: { id: 'reflection/beam-free' }, metadata: { name: 'Beam' }, cost: { prompt: '0', completion: '0' } },
      [removed]: { service: 'zen', id: 'retired-model', name: 'Retired', type: 'chat', classification: 'free', lifecycle: 'retired', listed: false, listingOrigin: 'recorded-listed', firstSeen: '2026-09-01T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', raw: { id: 'retired-model' }, metadata: { name: 'Retired' }, cost: { input: 0, output: 0 } },
    },
    history: [{ at: '2026-10-01T00:00:00.000Z', service: 'kilo', id: 'reflection/beam-free', from: null, to: { classification: 'free', listed: true, lifecycle: 'active' } }, { at: '2026-10-02T00:00:00.000Z', service: 'zen', id: 'retired-model', from: { listed: true }, to: { listed: false } }],
  };
  const before = structuredClone(raw);
  const next = validateState(migrateCatalogState(raw));
  assert.deepEqual(raw, before, 'migration mutated the caller object');
  assert.deepEqual(Object.keys(next.entries), [K]);
  assert.deepEqual(next.entries[K], raw.entries[K], 'remaining provider record changed');
  assert.deepEqual(Object.keys(next.sources), ['kilo'], 'only a supported source remains');
  assert.deepEqual(next.history, [raw.history[0]]);
  assert.equal(next.schemaVersion, 1);
});
test('thinking preferences of remaining models survive; removed ones are dropped', () => {
  const raw = { [K]: 'high', [recordKey('zen', 'retired-model')]: 'low', [recordKey('ovh', 'gpt-oss-120b')]: 'default' };
  assert.deepEqual(migrateThinkingSelections(raw), { [K]: 'high', [recordKey('ovh', 'gpt-oss-120b')]: 'default' });
});
