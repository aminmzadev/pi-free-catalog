import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog, priceClass, recordKey, reconcile } from '../src/catalog.js';
import { thinkingProfile, registrations } from '../src/models.js';
import { thinkingSync } from '../src/thinking-sync.js';
import { fixtures, sources, state, fetcher } from './helpers.mjs';

for (const cost of [
  { input: 1 },
  { output: 1 },
  { input: 'dynamic', output: 0, cache_read: 1 },
  { input: 0, tiers: [{ output: 1 }] },
]) {
  test(`positive monetary evidence dominates incomplete pricing: ${JSON.stringify(cost)}`, () =>
    assert.equal(priceClass(cost), 'paid'));
}
test('partial positive Kilo prices conflict with an explicit free flag', () => {
  const d = structuredClone(fixtures);
  d.kilo.data.push({
    id: 'partial-paid',
    isFree: true,
    pricing: { prompt: '.001' },
  });
  const c = new Catalog();
  c.state = reconcile(sources(d));
  assert.equal(
    c.state.entries[recordKey('kilo', 'partial-paid')].classification,
    'conflict',
  );
  assert.throws(() => c.assertUsable('kilo', 'partial-paid'));
});
test('partial positive Zen update cannot reactivate last-known free pricing', () => {
  const d = structuredClone(fixtures);
  d.official.opencode.models['beam-free'].cost = { input: 1 };
  delete d.modelsdev.opencode.models['beam-free'];
  d.pi = d.pi.filter((m) => m.id !== 'beam-free');
  const c = new Catalog();
  c.state = reconcile(sources(d), state());
  assert.equal(
    c.state.entries[recordKey('zen', 'beam-free')].classification,
    'paid',
  );
  assert.throws(() => c.assertUsable('zen', 'beam-free'));
});
test('a cancelled pre-switch must not detach current-model thinking synchronization', () => {
  let level = 'high',
    mode = 'high';
  const s = state();
  const ctx = {
    model: { provider: 'free-zen', id: 'beam-free' },
    ui: { setStatus() {} },
  };
  const sync = thinkingSync({
    pi: {
      getThinkingLevel: () => level,
      setThinkingLevel: (l) => {
        level = l;
      },
    },
    catalog: { state: s },
    getSelection: () => mode,
    setSelection: (_, m) => {
      mode = m;
    },
    save: async () => {},
    output() {},
  });
  sync.restore(ctx);
  // The committed lifecycle must not unbind on an intention that another extension can cancel.
  // Full extension event wiring is checked separately against a real Pi runtime.
  level = 'low';
  sync.reconcile(ctx);
  assert.equal(mode, 'auto');
});
test('parseable invalid cache is rejected and a network refresh can recover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'free-shape-'));
  try {
    const file = join(dir, 'catalog.json');
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        entries: {},
        sources: {},
        history: {},
      }),
    );
    const c = new Catalog({ file, fetch: fetcher() });
    await c.load();
    assert.ok(c.cacheWarning);
    await c.refresh();
    assert.ok(registrations(c.state, 'kilo').length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('malformed optional capability fields do not disable unrelated models or hide the affected ID', () => {
  const d = structuredClone(fixtures);
  d.kilo.data.push({
    id: 'bad-optional-fields',
    isFree: true,
    reasoning_options: {},
    architecture: { input_modalities: true, output_modalities: {} },
    supported_parameters: {},
    context_length: 'unknown',
  });
  const s = reconcile(sources(d));
  const models = registrations(s, 'kilo');
  assert.ok(models.some((m) => m.id === 'reflection/beam-free'));
  assert.ok(models.some((m) => m.id === 'bad-optional-fields'));
  assert.equal(
    s.entries[recordKey('kilo', 'bad-optional-fields')].raw.architecture
      .input_modalities,
    true,
  );
});
test('retirement in a second fresh registry is preserved after disappearance', () => {
  const d = structuredClone(fixtures);
  d.zen.data = d.zen.data.filter((m) => m.id !== 'beam-free');
  d.modelsdev.opencode.models['beam-free'].status = 'retired';
  const s = reconcile(sources(d), state());
  assert.equal(s.entries[recordKey('zen', 'beam-free')].lifecycle, 'retired');
});
test('metadata-only paid/zero conflict is retained accurately and not callable', () => {
  const d = structuredClone(fixtures),
    id = 'metadata-conflict';
  d.official.opencode.models[id] = { id, cost: { input: 0, output: 0 } };
  d.modelsdev.opencode.models[id] = { id, cost: { input: 1, output: 0 } };
  const s = reconcile(sources(d));
  assert.equal(s.entries[recordKey('zen', id)].classification, 'conflict');
  assert.equal(s.entries[recordKey('zen', id)].listed, false);
});
test('known retirement deadlines are enforced locally without a refresh', () => {
  const d = structuredClone(fixtures),
    id = 'reflection/beam-free',
    deadline = '2099-01-01T00:00:00Z';
  d.kilo.data.find((m) => m.id === id).retirement_date = deadline;
  let now = Date.parse('2098-12-31T23:00:00Z');
  const c = new Catalog({ now: () => now });
  c.state = reconcile(sources(d), {}, new Date(now).toISOString());
  assert.doesNotThrow(() => c.assertUsable('kilo', id));
  now = Date.parse(deadline);
  assert.throws(() => c.assertUsable('kilo', id), /retir/i);
});
test('cached thinking choices never claim live evidence', () => {
  const s = state();
  for (const source of Object.values(s.sources)) source.fresh = false;
  const p = thinkingProfile(s.entries[recordKey('zen', 'beam-free')], s);
  assert.ok(Object.keys(p.choices).length);
  assert.doesNotMatch(p.source, /live/i);
});
test('accepted wrapped Pi hints have the same effect as array hints', () => {
  const s = state(),
    e = s.entries[recordKey('zen', 'beam-free')];
  delete e.metadata.reasoning_options;
  delete e.metadata.thinkingLevelMap;
  s.sources.pi.data = {
    data: [
      { id: e.id, api: 'openai-responses', thinkingLevelMap: { low: 'low' } },
    ],
  };
  const m = registrations(s, 'zen').find((m) => m.id === e.id);
  assert.equal(m.api, 'openai-responses');
  assert.ok(thinkingProfile(e, s).choices.low);
});
