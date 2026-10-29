import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  Catalog,
  recordKey,
  reconcile,
  priceClass,
  validateState,
  atomicJSON,
} from '../src/catalog.js';
import {
  registrations,
  selectThinking,
  thinkingProfile,
} from '../src/models.js';
import {
  requestPayload,
  PACKAGE_VERSION,
  anonymousHeaders,
} from '../src/transport.js';
import { state, sources, fixtures, fetcher } from './helpers.mjs';

for (const invalid of [
  null,
  [],
  1,
  'state',
  { schemaVersion: 2, entries: {}, sources: {} },
  { schemaVersion: 1, entries: [], sources: {} },
  { schemaVersion: 1, entries: {}, sources: [] },
  { schemaVersion: 1, entries: {}, sources: {}, history: 'wrong' },
  { schemaVersion: 1, entries: {}, sources: {}, changes: {} },
]) {
  test(`invalid persisted root is rejected: ${JSON.stringify(invalid)}`, () =>
    assert.throws(() => validateState(invalid)));
}
for (const mutate of [
  (e) => {
    e.id = 9;
  },
  (e) => {
    e.metadata = [];
  },
  (e) => {
    e.raw = null;
  },
  (e) => {
    e.listed = 'true';
  },
  (e) => {
    e.classification = 'FREE';
  },
  (e) => {
    e.retirementDates = ['not-a-date'];
  },
]) {
  test(`invalid persisted entry is rejected: ${mutate}`, () => {
    const s = state();
    mutate(s.entries[recordKey('kilo', 'thinkingmachines/inkling-small:free')]);
    assert.throws(() => validateState(s));
  });
}
test('legacy absent history/changes migrate without discarding model entries', () => {
  const s = state();
  delete s.history;
  delete s.changes;
  const restored = validateState(s);
  assert.deepEqual(restored.history, []);
  assert.equal(
    Object.keys(restored.entries).length,
    Object.keys(s.entries).length,
  );
});
for (const value of [null, true, 12, 'wrong', {}, []]) {
  test(`malformed optional reasoning and modality shapes remain isolated: ${JSON.stringify(value)}`, () => {
    const d = structuredClone(fixtures),
      row = d.kilo.data.find((m) => m.id === 'reflection/beam-free');
    row.reasoning_options = value;
    row.opencode = { variants: value };
    row.architecture = { input_modalities: value, output_modalities: value };
    row.supported_parameters = value;
    const s = reconcile(sources(d));
    assert.ok(registrations(s, 'kilo').some((m) => m.id === row.id));
  });
}


test('cached-free models with no retirement remain callable arbitrarily later without network', () => {
  const c = new Catalog({ now: () => Date.parse('2199-01-01') });
  c.state = state();
  assert.doesNotThrow(() => c.assertUsable('kilo', 'thinkingmachines/inkling-small:free'));
});

test('fresh corrected retirement metadata clears the previous future deadline', () => {
  const d = structuredClone(fixtures);
  d.kilo.data.find(m=>m.id==='thinkingmachines/inkling-small:free').retirement_date =
    '2099-01-01T00:00:00Z';
  const old = reconcile(sources(d), {}, '2098-01-01T00:00:00Z');
  delete d.kilo.data.find(m=>m.id==='thinkingmachines/inkling-small:free').retirement_date;
  const c = new Catalog({ now: () => Date.parse('2100-01-01') });
  c.state = reconcile(sources(d), old, '2100-01-01T00:00:00Z');
  assert.doesNotThrow(() => c.assertUsable('kilo', 'thinkingmachines/inkling-small:free'));
});
test('thinking hooks obtain a consistent current level after an awaited original hook', async () => {
  const catalog = new Catalog();
  catalog.state = state();
  let level = 'high',
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const hook = requestPayload({
    catalog,
    service: 'kilo',
    id: 'thinkingmachines/inkling-small:free',
    getSelection: () => 'auto',
    piLevel: 'high',
    getPiLevel: () => level,
    original: async (payload) => {
      await gate;
      return { ...payload, temperature: 0.2 };
    },
  });
  const promise = hook({ model: 'thinkingmachines/inkling-small:free', tools: [{ name: 'read' }] });
  level = 'low';
  release();
  const body = await promise;
  assert.equal(body.reasoning.effort, 'low');
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.tools, [{ name: 'read' }]);
});
test('native prototype-property names are rejected unless explicitly advertised', () => {
  const s = state(),
    e = s.entries[recordKey('kilo', 'thinkingmachines/inkling-small:free')];
  for (const value of ['constructor', '__proto__', 'toString'])
    assert.throws(() => selectThinking(e, s, value), /Unsupported native/);
});
test('advertised special native names stay visible without modifying an object prototype', () => {
  const s = state(),
    e = s.entries[recordKey('kilo', 'reflection/beam-free')];
  e.metadata.opencode.variants = JSON.parse(
    '{"__proto__":{"reasoning":{"enabled":true,"effort":"future"}}}',
  );
  assert.ok(Object.keys(thinkingProfile(e, s).choices).includes('__proto__'));
  assert.deepEqual(selectThinking(e, s, '__proto__'), {
    reasoning: { enabled: true, effort: 'future' },
  });
});
test('unknown payload fields cannot silently masquerade as an implemented native mode', () => {
  const s = state(),
    e = s.entries[recordKey('kilo', 'reflection/beam-free')];
  e.metadata.opencode.variants.future = { future_budget: 99 };
  assert.ok(thinkingProfile(e, s).choices.future);
  assert.throws(() => selectThinking(e, s, 'future'), /no supported payload/);
});
test('the Python consumer reads actual production gzip and legacy JSON caches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'free-python-'));
  try {
    const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
    for (const gzip of [false, true]) {
      const file = join(dir, gzip ? 'gzip.json' : 'legacy.json');
      await atomicJSON(
        file,
        { schemaVersion: 1, entries: { kept: {} }, sources: {}, history: [] },
        { gzip },
      );
      const result = spawnSync(
        'python3',
        [
          '-c',
          'import sys;sys.path.insert(0,sys.argv[1]);from cache_io import read_catalog;print(len(read_catalog(sys.argv[2])["entries"]))',
          scripts,
          file,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), '1');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('gzip with structurally invalid JSON is rejected before projection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'free-gzip-shape-'));
  try {
    const file = join(dir, 'catalog.json');
    await writeFile(
      file,
      gzipSync(
        JSON.stringify({
          schemaVersion: 1,
          entries: {},
          sources: {},
          history: {},
        }),
      ),
    );
    const c = new Catalog({ file });
    await c.load();
    assert.ok(c.cacheWarning);
    assert.deepEqual(c.state.entries, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('version metadata matches the manifest without changing anonymous authentication', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(PACKAGE_VERSION, pkg.version);
  assert.match(
    anonymousHeaders('kilo', 's')['User-Agent'],
    new RegExp(pkg.version.replaceAll('.', '\\.')),
  );
  assert.equal(anonymousHeaders('kilo', 's').Authorization, undefined);
});
test('positive underflow is still paid even when another required base price is absent', () =>
  assert.equal(priceClass({ input: '1e-9999' }), 'paid'));

test('unmapped-only native controls preserve provider default in auto without inventing Pi levels', () => {
  const s = state(),
    e = s.entries[recordKey('kilo', 'reflection/beam-free')];
  e.metadata.opencode.variants = { 'future-mode': { thinking_budget: 1234 } };
  assert.deepEqual(selectThinking(e, s, 'auto', 'off'), {});
  assert.deepEqual(selectThinking(e, s, 'future-mode'), {
    thinking_budget: 1234,
  });
});
test('auto cannot silently accept unsupported fields under a familiar native level name', () => {
  const s = state(),
    e = s.entries[recordKey('kilo', 'reflection/beam-free')];
  e.metadata.opencode.variants = { high: { unsupported_budget: 1234 } };
  assert.throws(
    () => selectThinking(e, s, 'auto', 'high'),
    /no supported payload/,
  );
});
test('all registered Pi event names are present in the public host event contract', async () => {
  const source = await readFile(
    new URL('../src/index.js', import.meta.url),
    'utf8',
  );
  const types = await readFile(
    new URL(
      './core/extensions/types.d.ts',
      import.meta.resolve('@earendil-works/pi-coding-agent'),
    ),
    'utf8',
  );
  const supported = new Set(
    [...types.matchAll(/on\(event: ["']([^"']+)["']/g)].map((m) => m[1]),
  );
  for (const [, name] of source.matchAll(/pi\.on\(\s*["']([^"']+)["']/g))
    assert.ok(supported.has(name), name);
});
