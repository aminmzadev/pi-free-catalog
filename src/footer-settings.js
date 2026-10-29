import { readFile } from 'node:fs/promises';
import { atomicJSON, summary } from './catalog.js';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export function normalizeFooterSettings(raw) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.freeze({
    footer: ['default', 'compact'].includes(data.footer) ? data.footer : 'default',
    chatCounts: typeof data.chatCounts === 'boolean' ? data.chatCounts : true,
  });
}

/** Immediate session display; immutable, serialized atomic snapshots for disk.
 * A failed write does not silently undo a display choice or poison later saves.
 */
export class FooterSettings {
  constructor({ file, read = path => readFile(path, 'utf8'), persist = atomicJSON }) {
    this.file = file; this.read = read; this.persist = persist;
    this.current = normalizeFooterSettings(); this.pending = Promise.resolve();
    this.revision = 0; this.closed = false;
  }
  get value() { return this.current; }
  async load() {
    const revision = this.revision;
    await this.settled();
    let raw;
    try {
      const text = await this.read(this.file);
      if (typeof text === 'string' && Buffer.byteLength(text) <= 65536) raw = JSON.parse(text);
    } catch { /* Missing, unreadable or corrupt display preferences use safe defaults. */ }
    if (!this.closed && revision === this.revision) this.current = normalizeFooterSettings(raw);
    return this.current;
  }
  set(patch) {
    if (this.closed) throw Error('Footer settings are closed');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
        Object.keys(patch).some(k => !['footer', 'chatCounts'].includes(k)) ||
        ('footer' in patch && !['compact', 'default'].includes(patch.footer)) ||
        ('chatCounts' in patch && typeof patch.chatCounts !== 'boolean')) throw Error('Invalid footer setting');
    const snapshot = normalizeFooterSettings({ ...this.current, ...patch });
    this.current = snapshot; this.revision++;
    const task = this.pending.catch(() => {}).then(() => this.persist(this.file, snapshot));
    this.pending = task;
    return task;
  }
  async settled() { await this.pending.catch(() => {}); }
  async close() { this.closed = true; await this.settled(); }
}

function widthOf(terminal) {
  return Number.isFinite(terminal.columns) && terminal.columns !== 0 ? Math.max(1, Math.floor(terminal.columns)) : 80;
}
export function chatCountsText(state, width) {
  const counts = summary(state);
  const [k, o] = ['kilo', 'ovh'].map(service => counts[service].freeChat);
  const choices = [`Free chat: Kilo ${k} · OVH ${o}`, `Free chat: K${k} O${o}`, `K${k} O${o}`];
  // Pi's truncator can append an ANSI reset even to plain input; keep this label plain.
  return truncateToWidth(choices.find(text => visibleWidth(text) <= width) ?? choices.at(-1), width, '').replaceAll('\x1b[0m', '');
}

/** Persistent catalog summary, deliberately independent of transient pool cleanup.
 * It never claims a footer slot, starts a timer, fetches metadata or selects a model.
 */
export function chatCountsStatus({ getState, getEnabled, terminal = process.stdout }) {
  let ui, listening = false, disposed = false;
  const draw = () => {
    if (ui) ui.setStatus('free-catalog', getEnabled() ? chatCountsText(getState(), widthOf(terminal)) : undefined);
  };
  const removeListener = () => {
    if (listening) terminal.removeListener?.('resize', draw);
    listening = false;
  };
  return {
    update(ctx) {
      if (disposed) return;
      const next = ctx?.ui;
      if (ui && ui !== next) ui.setStatus('free-catalog', undefined);
      ui = next;
      removeListener();
      draw();
      if (ui && getEnabled() && ctx.hasUI && !['print', 'rpc', 'json'].includes(ctx.mode)) {
        terminal.on?.('resize', draw); listening = true;
      }
    },
    clear() { removeListener(); ui?.setStatus('free-catalog', undefined); ui = undefined; },
    dispose() { this.clear(); disposed = true; },
  };
}

export async function editFooterSettings({ ctx, getSettings, apply, output }) {
  if (!ctx.hasUI || typeof ctx.ui.select !== 'function') {
    const value = getSettings();
    output(`Footer: ${value.footer}. Chat counts: ${value.chatCounts ? 'ON' : 'OFF'}.`, ctx);
    return;
  }
  for (;;) {
    const value = getSettings();
    const counts = `Chat counts: ${value.chatCounts ? 'ON' : 'OFF'} — toggle`;
    const mode = `Footer: ${value.footer} — change`;
    const options = [counts, mode, 'Close'];
    const choice = await ctx.ui.select('Footer display\nEach choice applies immediately and is saved.', options);
    if (choice === undefined || choice === 'Close') return;
    if (choice === counts) await apply({ chatCounts: !getSettings().chatCounts }, ctx);
    else if (choice === mode) {
      const selected = await ctx.ui.select('Footer appearance', ['default', 'compact']);
      if (selected === undefined) continue;
      if (['default', 'compact'].includes(selected)) await apply({ footer: selected }, ctx);
      else output('Unknown footer choice; nothing changed.', ctx);
    } else { output('Unknown footer choice; nothing changed.', ctx); return; }
  }
}
