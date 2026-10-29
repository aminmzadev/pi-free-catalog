import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { visibleWidth } from '@earendil-works/pi-tui';
import { FooterSettings, normalizeFooterSettings, chatCountsText, chatCountsStatus, editFooterSettings } from '../src/footer-settings.js';
import { poolActivityUI, OWNED_STATUS_KEYS } from '../src/pool-activity.js';

const blank = () => ({ entries: {} });
const entry = (type = 'chat', extra = {}) => ({ listed: true, classification: 'free', lifecycle: 'active', type, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

for (const [name, raw, expected] of [
  ['missing', undefined, { footer: 'default', chatCounts: true }],
  ['null', null, { footer: 'default', chatCounts: true }],
  ['array', ['compact', false], { footer: 'default', chatCounts: true }],
  ['legacy compact', { footer: 'compact' }, { footer: 'compact', chatCounts: true }],
  ['legacy default', { footer: 'default' }, { footer: 'default', chatCounts: true }],
  ['independently valid counts', { footer: 'broken', chatCounts: false }, { footer: 'default', chatCounts: false }],
  ['independently valid mode', { footer: 'compact', chatCounts: 'false' }, { footer: 'compact', chatCounts: true }],
  ['numeric is not boolean', { chatCounts: 0 }, { footer: 'default', chatCounts: true }],
  ['valid false', { footer: 'compact', chatCounts: false, unknown: 'ignored' }, { footer: 'compact', chatCounts: false }],
]) test(`footer preferences: ${name}`, () => assert.deepEqual(normalizeFooterSettings(raw), expected));

for (const [name, read] of [
  ['missing file', async () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); }],
  ['permission failure', async () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); }],
  ['truncated JSON', async () => '{"footer":'],
  ['oversized JSON', async () => JSON.stringify({ footer: 'compact', chatCounts: false, extra: 'x'.repeat(65536) })],
]) test(`footer preference read: ${name}`, async () => {
  const settings = new FooterSettings({ file: 'display', read });
  assert.deepEqual(await settings.load(), { footer: 'default', chatCounts: true });
  await settings.close();
});

test('rapid mixed writes: immediate display, immutable FIFO snapshots, failed write recovery, reload', async () => {
  const gates = [], writes = []; let disk = JSON.stringify({ footer: 'default' });
  const settings = new FooterSettings({ file: 'display', read: async () => disk, persist: async (file, snapshot) => {
    assert.equal(file, 'display'); assert.ok(Object.isFrozen(snapshot));
    writes.push(snapshot); const gate = deferred(); gates.push(gate); await gate.promise;
    disk = JSON.stringify(snapshot);
  } });
  await settings.load();
  const first = settings.set({ chatCounts: false });
  const firstFailure = assert.rejects(first, /write failed/);
  const second = settings.set({ footer: 'compact' });
  const third = settings.set({ chatCounts: true });
  assert.deepEqual(settings.value, { footer: 'compact', chatCounts: true });
  await tick(); assert.equal(gates.length, 1);
  gates[0].reject(Error('write failed')); await firstFailure;
  await tick(); assert.equal(gates.length, 2); assert.equal(writes[1].chatCounts, false);
  gates[1].resolve(); await second;
  await tick(); assert.equal(gates.length, 3);
  gates[2].resolve(); await third;
  assert.deepEqual(writes, [
    { footer: 'default', chatCounts: false }, { footer: 'compact', chatCounts: false }, { footer: 'compact', chatCounts: true },
  ]);
  await settings.close();
  const restarted = new FooterSettings({ file: 'display', read: async () => disk });
  assert.deepEqual(await restarted.load(), { footer: 'compact', chatCounts: true });
  await restarted.close();
});

test('an older asynchronous load cannot erase a newer display choice', async () => {
  const gate = deferred();
  const settings = new FooterSettings({ file: 'display', read: () => gate.promise, persist: async () => {} });
  const loading = settings.load(); await tick();
  await settings.set({ chatCounts: false });
  gate.resolve('{"footer":"compact","chatCounts":true}');
  await loading;
  assert.deepEqual(settings.value, { footer: 'default', chatCounts: false });
  await settings.close();
});

test('invalid patches cannot change memory or disk; close drains writes and rejects late choices', async () => {
  const gate = deferred(); let saves = 0;
  const settings = new FooterSettings({ file: 'display', persist: async () => { saves++; await gate.promise; } });
  for (const patch of [null, [], {}, { chatCounts: 0 }, { chatCounts: 'off' }, { footer: 'bad' }, { pool: false }]) {
    assert.throws(() => settings.set(patch), /Invalid/);
    assert.deepEqual(settings.value, { footer: 'default', chatCounts: true });
  }
  const writing = settings.set({ chatCounts: false });
  let closed = false; const closing = settings.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(saves, 1);
  assert.throws(() => settings.set({ chatCounts: true }), /closed/);
  gate.resolve(); await Promise.all([writing, closing]);
  assert.equal(closed, true);
  await settings.load(); assert.equal(settings.value.chatCounts, false);
});

test('count eligibility uses actual free chat catalog entries, independently of registration or pool', () => {
  const state = blank();
  const kilo = {
    active: entry(), provisional: entry('chat', { lifecycle: 'provisional' }),
    classifier: entry('classifier'), embedding: entry('embedding'), image: entry('image'), unknown: entry('unknown'),
    paid: entry('chat', { classification: 'paid' }), retired: entry('chat', { lifecycle: 'retired' }),
    unlisted: entry('chat', { listed: false }), uncertain: entry('chat', { classification: 'unknown' }),
  };
  const removed = { chat: entry(), tiny: entry('classifier') };
  const ovh = { chat: entry('chat', { requiresKey: true }) };
  for (const [service, rows] of Object.entries({ kilo, removed, ovh })) for (const [id, row] of Object.entries(rows)) state.entries[`${service}:${id}`] = { ...row, service };
  assert.equal(chatCountsText(state, 200), 'Free chat: Kilo 2 · OVH 1');
  assert.equal(chatCountsText(state, 20), 'Free chat: K2 O1');
  assert.equal(chatCountsText(state, 6), 'K2 O1');
  for (let width = 1; width <= 120; width++) assert.ok(visibleWidth(chatCountsText(state, width)) <= width);
});

test('pool wait/response/abort/error cleanup never owns or clears persistent counts or foreign statuses', () => {
  assert.equal(OWNED_STATUS_KEYS.includes('free-catalog'), false);
  const terminal = new EventEmitter(); terminal.columns = 80;
  const foreignListener = () => {}; terminal.on('resize', foreignListener);
  const statuses = new Map([['foreign', 'alive']]); let enabled = true;
  const ctx = { hasUI: true, mode: 'interactive', ui: { setStatus: (k, v) => v === undefined ? statuses.delete(k) : statuses.set(k, v) } };
  const counts = chatCountsStatus({ getState: blank, getEnabled: () => enabled, terminal });
  const intervals = new Set(); const timers = { setInterval(fn) { const handle = { fn, unref() {} }; intervals.add(handle); return handle; }, clearInterval(handle) { intervals.delete(handle); } };
  const activity = poolActivityUI({ appendEntry() {} }, { terminal, timers });
  try {
    counts.update(ctx);
    for (const reason of ['reply', 'abort', 'error', 'model-change', 'pool-disabled']) {
      activity.wait(ctx, 5000, reason === 'reply' ? 'start' : 'wait');
      assert.equal(intervals.size, 1); assert.equal(terminal.listenerCount('resize'), 3);
      activity.clear(ctx);
      assert.equal(intervals.size, 0); assert.equal(terminal.listenerCount('resize'), 2);
      assert.equal(statuses.get('free-catalog'), 'Free chat: Kilo 0 · OVH 0');
      assert.equal(statuses.get('foreign'), 'alive');
    }
    terminal.columns = 7; terminal.emit('resize'); assert.ok(visibleWidth(statuses.get('free-catalog')) <= 7);
    enabled = false; counts.update(ctx);
    assert.equal(statuses.has('free-catalog'), false); assert.equal(terminal.listenerCount('resize'), 1);
    enabled = true; counts.update(ctx);
  } finally { activity.clear(ctx); counts.dispose(); }
  counts.update(ctx); terminal.emit('resize');
  assert.deepEqual([...statuses], [['foreign', 'alive']]);
  assert.deepEqual(terminal.listeners('resize'), [foreignListener]); assert.equal(intervals.size, 0);
});

test('counts move contexts safely; headless mode has no resize listener; late updates after shutdown do nothing', () => {
  const terminal = new EventEmitter(); terminal.columns = 80;
  const maps = [new Map([['foreign-a', 'A']]), new Map([['foreign-b', 'B']])];
  const contexts = maps.map((map, index) => ({ hasUI: index === 0, mode: index ? 'rpc' : 'interactive', ui: { setStatus: (k, v) => v === undefined ? map.delete(k) : map.set(k, v) } }));
  const counts = chatCountsStatus({ getState: blank, getEnabled: () => true, terminal });
  counts.update(contexts[0]); assert.equal(terminal.listenerCount('resize'), 1);
  counts.update(contexts[1]); assert.equal(maps[0].has('free-catalog'), false); assert.equal(maps[1].has('free-catalog'), true);
  assert.equal(terminal.listenerCount('resize'), 0);
  counts.dispose(); counts.update(contexts[0]); terminal.emit('resize');
  assert.deepEqual([...maps[0]], [['foreign-a', 'A']]); assert.deepEqual([...maps[1]], [['foreign-b', 'B']]);
});

test('display editor: independent immediate choices, Escape, malformed selection and headless summary', async () => {
  let value = { footer: 'default', chatCounts: true }; const patches = [], messages = [], menus = [];
  const choices = [options => options[0], options => options[1], () => 'compact', () => undefined];
  const ctx = { hasUI: true, ui: { async select(title, options) { menus.push({ title, options }); return choices.shift()(options); } } };
  const options = { ctx, getSettings: () => value, apply: async patch => { patches.push(patch); value = { ...value, ...patch }; }, output: text => messages.push(text) };
  await editFooterSettings(options);
  assert.deepEqual(patches, [{ chatCounts: false }, { footer: 'compact' }]);
  assert.match(menus[1].options[0], /OFF/); assert.match(menus[3].options[1], /compact/);
  await editFooterSettings({ ...options, ctx: { hasUI: false } }); assert.match(messages.at(-1), /compact.*OFF/);
  await editFooterSettings({ ...options, ctx: { hasUI: true, ui: { select: async () => 'unexpected' } } });
  assert.equal(patches.length, 2); assert.match(messages.at(-1), /nothing changed/);
});
