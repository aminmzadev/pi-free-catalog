// Repository-only checks against frozen 0.1.7 data. Never shipped and never fetched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, stat, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Catalog, reconcile, summary } from '../../src/catalog.js';
import { PagesCatalog } from '../../src/catalog-client.js';
import { canonical, rulesHash } from '../../src/snapshot-contract.js';
import { migrateCatalogState } from '../../src/provider-removal.js';
import { migrateLegacySnapshot } from '../../src/legacy-snapshot.js';
import { sources } from '../../test/helpers.mjs';

const at = '2026-10-22T00:00:00.000Z';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await readFile(new URL('./fixtures/manifest.json', import.meta.url), 'utf8'));
const load = async name => {
  const bytes = await readFile(new URL('./fixtures/' + name, import.meta.url));
  assert.equal(sha256(bytes), manifest[name].gzip_sha256, name + ' was modified');
  return JSON.parse(gunzipSync(bytes));
};
const legacy = await load('legacy-v1-snapshot.json.gz');
const golden = await load('remaining-providers-v0.1.7.json.gz');
const cacheState = snapshot => ({ schemaVersion: 1, refreshedAt: snapshot.generatedAt, sources: snapshot.sources, ...snapshot.catalog });

test('frozen 0.1.7 inputs match the Kilo/OVH reconciliation produced by unchanged rules', () => {
  const next = reconcile(sources(), {}, at);
  const entries = Object.fromEntries(Object.entries(next.entries).filter(([, e]) => e.service !== 'zen'));
  assert.equal(canonical({ entries, summary: summary(next) }), canonical(golden));
});
test('the frozen legacy cache migrates to exactly the same remaining records and history', () => {
  const migrated = migrateCatalogState(cacheState(legacy));
  const expected = Object.fromEntries(Object.keys(golden.entries).map(key => [key, migrated.entries[key]]));
  assert.deepEqual(migrated.entries, expected);
  assert.equal(Object.keys(migrated.entries).length, Object.keys(golden.entries).length);
  assert.deepEqual(Object.keys(migrated.sources).sort(), ['kilo', 'ovh', 'ovhmeta']);
  assert.deepEqual(migrated.history, legacy.catalog.history.filter(e => e.service !== 'zen'));
});
test('the snapshot migration keeps historical source evidence without inventing a new fetch', async () => {
  const rules = await rulesHash();
  const next = migrateLegacySnapshot(legacy, { expectedRules: rules, now: Date.parse('2026-10-22T01:00:00Z') });
  for (const name of ['kilo', 'ovh', 'ovhmeta']) {
    assert.deepEqual(next.sources[name], legacy.sources[name]);
    assert.equal(next.sources[name].fresh, true);
  }
  assert.equal(next.rulesHash, rules);
  assert.equal(next.generatedAt, legacy.generatedAt);
  assert.equal(next.quality.status, 'fresh');
  const key = JSON.stringify(['kilo', 'reflection/beam-free']);
  assert.equal(next.catalog.entries[key].firstSeen, legacy.catalog.entries[key].firstSeen);
});
test('actual saved-cache loading paths consume the frozen 0.1.7 cache without fetching or rewriting it', async () => {
  const raw = cacheState(legacy);
  const remaining = migrateCatalogState(structuredClone(raw));
  const dir = await mkdtemp(join(tmpdir(), 'removal-cache-'));
  try {
    const file = join(dir, 'catalog.json');
    await writeFile(file, JSON.stringify(raw, null, 2));
    const before = await readFile(file);
    for (const Type of [Catalog, PagesCatalog]) {
      const c = new Type({ file, fetch: () => { throw Error('load must never fetch'); }, now: () => Date.parse(legacy.generatedAt) });
      await c.load();
      assert.deepEqual(c.state.entries, remaining.entries, Type.name);
      assert.deepEqual(c.state.history, remaining.history, Type.name);
      assert.deepEqual(Object.keys(c.state.sources).sort(), ['kilo', 'ovh', 'ovhmeta'], Type.name);
      assert.deepEqual(await readFile(file), before, Type.name + ' rewrote the disk cache');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('historical provider fixtures and repository-only migration data stay out of the shipped package', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.1.8');
  assert.ok(pkg.files.every(entry => !entry.startsWith('ci/')), 'package must not ship repository-only automation');
  for (const name of ['opencode.json.gz', 'opencode-capabilities.json.gz', 'models-dev.json.gz', 'pi-opencode-catalog.json.gz', 'legacy-v1-snapshot.json.gz', 'remaining-providers-v0.1.7.json.gz'])
    await assert.rejects(stat(new URL('../../test/fixtures/' + name, import.meta.url)), 'fixture is still shipped: ' + name);
});
