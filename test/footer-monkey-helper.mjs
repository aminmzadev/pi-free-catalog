// UI/state adversarial simulation, not a live-provider or Android certification.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InteractiveMode, initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { FooterSettings, chatCountsStatus, editFooterSettings } from '../src/footer-settings.js';
import { footerController } from '../src/footer.js';
import { poolActivityUI, OWNED_STATUS_KEYS } from '../src/pool-activity.js';

export const DEFAULT_SEEDS = Array.from({ length: 32 }, (_, i) => (Math.imul(i + 1, 0x9e3779b9) ^ 0xdecafbad) >>> 0);
export function configuredSeeds() {
  if (!process.env.FOOTER_MONKEY_SEED) return DEFAULT_SEEDS;
  const text = process.env.FOOTER_MONKEY_SEED;
  if (!/^(?:\d+|0x[\da-f]{1,8})$/i.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > 0xffffffff) throw Error('FOOTER_MONKEY_SEED must be a uint32');
  return [Number(text)];
}
export function configuredSteps() {
  const text = process.env.FOOTER_MONKEY_STEPS ?? '400';
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 10000) throw Error('FOOTER_MONKEY_STEPS must be 1..10000');
  return Number(text);
}
function generator(seed) {
  let a = seed >>> 0;
  return n => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ a >>> 15, a | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) % n;
  };
}
const names = ['catalog-refresh', 'catalog-change', 'counts-toggle', 'footer-mode', 'model-provider-change', 'pool-wait', 'resize', 'reply-abort-error', 'stale-status-cleanup', 'foreign-status', 'foreign-footer', 'corrupt-restart', 'rapid-writes', 'display-menu', 'shutdown-late-restart', 'timer-tick', 'headless-transition', 'pool-config-change'];
// Deliberately no production summary/normalizer calls in this reference oracle.
function expectedSettings(raw) {
  let data; try { data = JSON.parse(raw); } catch { data = {}; }
  if (!data || Array.isArray(data) || typeof data !== 'object') data = {};
  return { footer: data.footer === 'compact' ? 'compact' : 'default', chatCounts: data.chatCounts === false ? false : true };
}
function expectedCounts(rows) {
  const result = [0, 0];
  for (const row of Object.values(rows)) {
    if (row.listed && row.type === 'chat' && row.classification === 'free' && row.lifecycle !== 'retired') {
      const i = ['kilo', 'ovh'].indexOf(row.service); if (i >= 0) result[i]++;
    }
  }
  return result;
}

export async function runFooterMonkey(seed, steps = 400, { injectFailureAt = -1, failureDir } = {}) {
  initTheme('dark');
  const random = generator(seed), trace = [], coverage = {}, terminal = new EventEmitter(), branch = new EventEmitter();
  terminal.columns = 80; const foreignResize = () => {}; terminal.on('resize', foreignResize);
  let foreignText = 'foreign extension alive', state = { entries: {} }, disk = '{}', oracleDisk = disk;
  let oracle = { footer: 'default', chatCounts: true }, settings, counts, activity, footer, waiting = false, foreignFooter;
  const statuses = new Map([['foreign-extension', foreignText]]), plans = [], jobs = [], writeErrors = [], activeTimers = new Set(), oldCallbacks = [];
  const effects = { metadata: 0, inference: 0, setModel: 0, setThinking: 0, quota: { spent: 2, remaining: 0 }, transcript: ['existing tool result'] };
  let pool = { enabled: false, models: ['A', 'B'], thinking: { A: 'high', B: 'low' }, maxWaitMs: 0, responseStartTimeoutMs: 0 };
  let footerCalls = 0, lastRenderedColumns = terminal.columns;
  const manager = { getCwd: () => '/offline', getSessionName: () => 'seeded test', getEntries: () => [], getEntryCount: () => 0, getSessionId: () => 'seed', getLeafId: () => 'leaf' };
  const ctx = { mode: 'tui', hasUI: true, model: { provider: 'free-ovh', id: 'A', contextWindow: 32768 }, sessionManager: manager, getContextUsage: () => undefined, ui: {} };
  const data = { getGitBranch: () => 'main', getAvailableProviderCount: () => 3, getExtensionStatuses: () => statuses,
    onBranchChange(fn) { branch.on('change', fn); return () => branch.off('change', fn); } };
  const native = Object.create(InteractiveMode.prototype);
  native.ui = { requestRender() {} }; native.footerDataProvider = data;
  native.footer = { render: () => ['stock footer'] }; native.footerContainer = { clear() {}, addChild() {} };
  ctx.ui.setStatus = (key, value) => {
    if (key === 'free-catalog') lastRenderedColumns = terminal.columns;
    return value === undefined ? statuses.delete(key) : statuses.set(key, value);
  };
  ctx.ui.setFooter = factory => { footerCalls++; native.setExtensionFooter(factory); };
  const pi = { getThinkingLevel: () => 'high', getSettings: () => ({ compaction: { enabled: false } }), appendEntry() {},
    setModel() { effects.setModel++; }, setThinkingLevel() { effects.setThinking++; } };
  const timers = { setInterval(fn, ms) { assert.equal(ms, 1000); const handle = { fn, unref() {} }; activeTimers.add(handle); oldCallbacks.push(fn); return handle; }, clearInterval(handle) { activeTimers.delete(handle); } };
  const makeCatalog = () => {
    const entries = {};
    for (let i = 0, n = 10 + random(55); i < n; i++) entries[`record-${i}`] = {
      service: ['kilo', 'ovh'][random(2)], type: ['chat', 'chat', 'classifier', 'embedding', 'image', 'unknown'][random(6)],
      listed: random(5) !== 0, classification: ['free', 'free', 'paid', 'unknown'][random(4)],
      lifecycle: ['active', 'provisional', 'retired', 'deprecated'][random(4)],
    };
    state = { entries };
  };
  async function boot() {
    settings = new FooterSettings({ file: 'offline-ui.json', read: async () => disk, persist: async (_file, snapshot) => {
      const plan = plans.shift(); assert.ok(plan, 'every write has an independent expected snapshot');
      assert.deepEqual(snapshot, plan.expected);
      for (let i = 0; i < plan.delay; i++) await new Promise(resolve => setImmediate(resolve));
      if (plan.fail) throw Error('simulated atomic write failure');
      disk = JSON.stringify(snapshot); oracleDisk = JSON.stringify(plan.expected);
    } });
    await settings.load(); oracle = expectedSettings(oracleDisk);
    counts = chatCountsStatus({ getState: () => state, getEnabled: () => settings.value.chatCounts, terminal });
    activity = poolActivityUI(pi, { terminal, timers });
    footer = footerController({ pi, getMode: () => settings.value.footer });
    counts.update(ctx); footer(ctx); waiting = false;
  }
  function write(patch, fail = false, delay = 0) {
    oracle = { ...oracle, ...patch }; plans.push({ expected: { ...oracle }, fail, delay });
    const job = settings.set(patch).then(() => { if (fail) writeErrors.push(Error('expected failure was lost')); }, error => {
      if (!fail || !/simulated atomic write failure/.test(error.message)) writeErrors.push(error);
    });
    jobs.push(job); counts.update(ctx);
    if (patch.footer) footer(ctx, { claim: patch.footer === 'compact' });
  }
  async function drain() {
    await Promise.all(jobs.splice(0)); await settings.settled();
    if (writeErrors.length) throw writeErrors[0];
    assert.deepEqual(plans, []); assert.equal(disk, oracleDisk);
  }
  function check() {
    assert.deepEqual(settings.value, oracle);
    assert.equal(statuses.get('foreign-extension'), foreignText);
    assert.equal(effects.metadata + effects.inference + effects.setModel + effects.setThinking, 0);
    assert.deepEqual(effects.quota, { spent: 2, remaining: 0 }); assert.deepEqual(effects.transcript, ['existing tool result']);
    assert.equal(activeTimers.size, waiting ? 1 : 0);
    assert.equal(terminal.listenerCount('resize'), 1 + (oracle.chatCounts && ctx.hasUI ? 1 : 0) + (waiting ? 1 : 0));
    const text = statuses.get('free-catalog');
    if (!oracle.chatCounts) assert.equal(text, undefined);
    else {
      // Headless modes intentionally subscribe to no terminal resize events.
      const [k, o] = expectedCounts(state.entries), width = ctx.hasUI ? terminal.columns : lastRenderedColumns;
      assert.equal(typeof text, 'string'); assert.ok(visibleWidth(text) <= width);
      const full = `Free chat: Kilo ${k} · OVH ${o}`, minimum = `K${k} O${o}`;
      if (width >= full.length) assert.equal(text, full);
      else if (width >= minimum.length) assert.deepEqual((text.match(/\d+/g) ?? []).map(Number), [k, o]);
      else assert.equal(text, minimum.slice(0, width));
      assert.doesNotMatch(text, /pool|thinking|model|\x1b|\n/i);
    }
    if (!waiting) for (const key of OWNED_STATUS_KEYS) assert.equal(statuses.has(key), false, key);
    else assert.ok(visibleWidth(statuses.get('free-ovh-activity')) <= terminal.columns);
    if (native.customFooter && ctx.mode === 'tui') for (const width of [8, 24, 80, 200]) {
      const lines = native.customFooter.render(width); assert.ok(lines.every(line => typeof line === 'string'));
      if (width === 200 && native.customFooter !== foreignFooter) {
        const plain = lines.join('\n').replace(/\x1b\[[\d;]*m/g, '');
        assert.ok(plain.includes(foreignText.replace(/\x1b\[[\d;]*m/g, '').replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim()));
        if (oracle.chatCounts) assert.ok(plain.includes(text));
      }
    }
  }
  async function shutdown() {
    const oldCounts = counts, currentSettings = settings;
    counts.dispose(); activity.clear(ctx); waiting = false; footer.release(ctx);
    await settings.close(); await drain();
    oldCounts.update(ctx); terminal.emit('resize'); for (const fn of oldCallbacks.splice(0)) fn();
    assert.throws(() => currentSettings.set({ chatCounts: true }), /closed/);
    assert.deepEqual([...statuses], [['foreign-extension', foreignText]]);
    assert.equal(activeTimers.size, 0); assert.deepEqual(terminal.listeners('resize'), [foreignResize]);
    assert.equal(branch.listenerCount('change'), 0);
  }
  makeCatalog(); await boot();
  try {
    for (let step = 0; step < steps; step++) {
      const op = random(names.length), name = names[op], detail = { step, op: name };
      trace.push(detail); coverage[name] = (coverage[name] ?? 0) + 1;
      if (step === injectFailureAt) throw Error('Injected trace-recorder test failure');
      const before = structuredClone({ pool, model: ctx.model, effects }), previousForeign = native.customFooter === foreignFooter && foreignFooter;
      const callsBefore = footerCalls; let mayClaim = false;
      switch (op) {
        case 0: makeCatalog(); counts.update(ctx); break;
        case 1: {
          const keys = Object.keys(state.entries), key = keys[random(keys.length)];
          detail.key = key; state.entries[key].listed = !state.entries[key].listed; counts.update(ctx); break;
        }
        case 2: detail.enabled = random(2) === 1; detail.fail = random(7) === 0; detail.delay = random(3); write({ chatCounts: detail.enabled }, detail.fail, detail.delay); break;
        case 3: detail.mode = random(2) ? 'compact' : 'default'; mayClaim = detail.mode === 'compact'; write({ footer: detail.mode }); break;
        case 4: ctx.model = { provider: ['free-kilo', 'free-kilo', 'free-ovh', 'paid-provider'][random(4)], id: `model-${random(30)}`, contextWindow: 32768 }; detail.model = { ...ctx.model }; activity.clear(ctx); waiting = false; counts.update(ctx); footer(ctx); break;
        case 5: detail.label = random(2) ? 'start' : 'wait'; activity.wait(ctx, 90000, detail.label); waiting = ctx.hasUI; break;
        case 6: terminal.columns = [1, 2, 4, 7, 8, 12, 20, 24, 32, 40, 80, 200][random(12)]; detail.width = terminal.columns; terminal.emit('resize'); break;
        case 7: detail.outcome = ['responded', 'aborted', 'error'][random(3)]; activity.clear(ctx); waiting = false; break;
        case 8: for (const key of OWNED_STATUS_KEYS) statuses.set(key, 'obsolete'); activity.clear(ctx); waiting = false; break;
        case 9: foreignText = `foreign-${random(10000)} ` + ['日本語 📎', '\x1b[31mcolored\x1b[0m', 'tab\tline\nnext', 'normal'][random(4)]; detail.text = foreignText; statuses.set('foreign-extension', foreignText); break;
        case 10: foreignFooter = { render: () => ['foreign footer'], dispose() {} }; ctx.ui.setFooter(() => foreignFooter); break;
        case 11: {
          await drain();
          const raw = ['{', 'null', '[]', '{"footer":"compact"}', '{"footer":"broken","chatCounts":false}', '{"footer":"default","chatCounts":"false"}', '{"chatCounts":0}', '{"footer":"compact","chatCounts":false}'][random(8)];
          detail.raw = raw; await shutdown(); disk = raw; oracleDisk = raw; await boot(); break;
        }
        case 12: {
          detail.writes = [];
          for (let n = 1 + random(12); n > 0; n--) {
            const patch = random(3) ? { chatCounts: random(2) === 1 } : { footer: random(2) ? 'compact' : 'default' };
            const fail = random(4) === 0, delay = random(3); detail.writes.push({ patch, fail, delay });
            if (patch.footer === 'compact') mayClaim = true;
            write(patch, fail, delay); check();
          }
          await drain(); break;
        }
        case 13: {
          const toggle = random(2) === 1; detail.toggle = toggle; let selected = false;
          const menuCtx = { ...ctx, hasUI: true, ui: { select: async (_title, options) => toggle && !selected ? (selected = true, options[0]) : undefined } };
          await editFooterSettings({ ctx: menuCtx, getSettings: () => settings.value, apply: async patch => write(patch), output() {} }); break;
        }
        case 14: await shutdown(); await boot(); break;
        case 15: for (const timer of activeTimers) timer.fn(); break;
        case 16: ctx.mode = ['tui', 'rpc', 'print', 'json'][random(4)]; detail.mode = ctx.mode; ctx.hasUI = ctx.mode === 'tui'; activity.clear(ctx); waiting = false; counts.update(ctx); footer(ctx); break;
        case 17: pool = { ...pool, enabled: !pool.enabled, maxWaitMs: random(61) * 1000 }; detail.enabled = pool.enabled; detail.maxWaitMs = pool.maxWaitMs; activity.clear(ctx); waiting = false; break;
      }
      if (op !== 17) assert.deepEqual(pool, before.pool);
      if (op !== 4) assert.deepEqual(ctx.model, before.model);
      assert.deepEqual(effects, before.effects);
      if (previousForeign && !mayClaim && op !== 10) { assert.equal(native.customFooter, previousForeign); assert.equal(footerCalls, callsBefore); }
      check();
    }
    await drain(); check(); await shutdown();
    return { seed, steps, coverage, digest: createHash('sha256').update(JSON.stringify(trace)).digest('hex') };
  } catch (error) {
    let path = '';
    try {
      const dir = failureDir ?? process.env.FOOTER_MONKEY_FAILURE_DIR ?? join(process.cwd(), 'test-results'); await mkdir(dir, { recursive: true });
      const candidate = join(dir, `footer-monkey-${seed}-failure.json`);
      await writeFile(candidate, JSON.stringify({ seed, steps, trace, oracle, disk, counts: expectedCounts(state.entries), statuses: [...statuses], error: error.stack }, null, 2) + '\n');
      path = candidate;
    } catch { /* The seed and complete trace remain in the test error if disk is unwritable. */ }
    throw new Error(`Footer monkey failed (seed=${seed}).\nReplay: FOOTER_MONKEY_SEED=${seed} FOOTER_MONKEY_STEPS=${steps} npm run test:footer-monkey\nFailure trace: ${path || JSON.stringify(trace)}\n${error.message}`, { cause: error });
  } finally {
    counts?.dispose(); activity?.clear(ctx); footer?.release(ctx); native.customFooter?.dispose?.();
    await settings?.close(); await Promise.all(jobs);
    terminal.removeListener('resize', foreignResize);
  }
}
