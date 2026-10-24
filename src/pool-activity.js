import { Text, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { clean } from './catalog-report.js';
import { activityDetail, failureDetail } from './free-pool-diagnostics.js';

export const ACTIVITY_TYPE = 'free-ovh-pool-activity';
export const OWNED_STATUS_KEYS = Object.freeze([
  'free-thinking', 'free-ovh-pool', 'free-ovh-pool-thinking',
  'free-ovh-pool-wait', 'free-ovh-rate', 'free-ovh-activity',
]);
const STATES = new Set(['selected', 'responded', 'timed-out', 'error', 'aborted', 'unavailable', 'not-compatible', 'cooling', 'waiting', 'rate-limited']);
const OUTCOMES = new Set(['responded', 'error', 'aborted', 'exhausted']);
const number = (n, max = 86400000) => Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : 0;
const modelName = value => clean(typeof value === 'string' ? value : '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 256);
export const MAX_ACTIVITY_STEPS = 24;

/** Allowlisted diagnostics only: never persist prompts, reasoning, tool results or provider error bodies. */
export function boundedActivity(raw = {}) {
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  return {
    schemaVersion: 1,
    ...(raw.scope==='free'?{scope:'free'}:{}),
    ...(failureDetail(raw.failure)?{failure:raw.failure}:{}),
    at: number(raw.at, 8640000000000000),
    elapsedMs: number(raw.elapsedMs),
    outcome: OUTCOMES.has(raw.outcome) ? raw.outcome : 'error',
    steps: steps.slice(0, MAX_ACTIVITY_STEPS).map(step => ({
      model: modelName(step?.model), state: STATES.has(step?.state) ? step.state : 'error',
      sent: step?.sent === true, elapsedMs: number(step?.elapsedMs),
      ...(activityDetail(step?.detail)?{detail:step.detail}:{}),
    })),
    omitted: number(raw.omitted, 1000000) + Math.max(0, steps.length - MAX_ACTIVITY_STEPS),
  };
}
export function activityText(raw, expanded = true) {
  const data = boundedActivity(raw);
  const attempts = data.steps.filter(s => s.sent).length;
  const title = `${data.scope==='free'?'Free':'OVH'} pool: ${data.outcome}; ${attempts}${data.omitted ? '+' : ''} request${attempts === 1 && !data.omitted ? '' : 's'}.`;
  if (!expanded) return title + ` Details: /${data.scope==='free'?'free-pool':'free-ovh-pool'} status`;
  return [title, ...(data.failure?['Reason: '+failureDetail(data.failure)]:[]), ...data.steps.map((s, i) => `${i + 1}. ${s.model}\n   ${s.state}${s.sent ? ` after ${(s.elapsedMs / 1000).toFixed(2)}s` : ' (not sent)'}${s.detail?'\n   '+activityDetail(s.detail):''}`),
    ...(data.omitted ? [`${data.omitted} additional steps omitted.`] : [])].join('\n');
}
export function recentActivity(ctx, limit = 20) {
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  const result = [];
  for (let i = branch.length - 1; i >= 0 && result.length < Math.min(20, limit); i--) {
    const entry = branch[i];
    if (entry.type === 'custom' && entry.customType === ACTIVITY_TYPE && entry.data?.schemaVersion === 1)
      result.push(boundedActivity(entry.data));
  }
  return result;
}

/** Own only our status keys. The native footer remains responsible for aggregate-width clipping. */
export function poolActivityUI(pi, { terminal = process.stdout, timers = globalThis } = {}) {
  let owner, until = 0, kind = 'wait', ticker, label = 'OVH';
  const draw = () => {
    const width = Math.max(1, terminal.columns || 80);
    owner?.ui?.setStatus('free-ovh-activity', truncateToWidth(`${label} ${kind} ${Math.max(0, Math.ceil((until - performance.now()) / 1000))}s`, width, ''));
  };
  function clear(ctx = owner) {
    timers.clearInterval(ticker); ticker = undefined;
    terminal.removeListener?.('resize', draw);
    const contexts = new Set([owner, ctx]);
    for (const context of contexts) for (const key of OWNED_STATUS_KEYS) context?.ui?.setStatus(key, undefined);
    owner = undefined; until = 0;
  }
  pi.registerEntryRenderer?.(ACTIVITY_TYPE, (entry, { expanded }, theme) => {
    if (entry.data?.schemaVersion !== 1) return undefined;
    return new Text(theme.fg('muted', activityText(entry.data, expanded)), 0, 0);
  });
  return {
    clear,
    wait(ctx, ms, phase = 'wait', scope = 'OVH') {
      clear(ctx);
      if (!ms || !ctx?.hasUI) return;
      owner = ctx; label = scope; kind = phase === 'start' ? 'reply' : 'wait'; until = performance.now() + ms;
      terminal.on?.('resize', draw);
      ticker = timers.setInterval(draw, 1000); ticker.unref?.(); draw();
    },
    record(raw, ctx) {
      // appendEntry is session metadata, unlike sendMessage (which joins LLM context).
      try { pi.appendEntry?.(ACTIVITY_TYPE, boundedActivity(raw)); }
      catch { ctx?.ui?.notify?.('Could not save the pool activity report.', 'warning'); }
    },
  };
}

/** Read-only viewport using public Pi components/keys; no model or metadata requests. */
export function createPoolStatusViewer(text, { tui, done, confirm = false, title = 'OVH pool' }) {
  let offset = 0, lines = [], page = 1, cachedWidth;
  const clamp = () => { offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - page))); };
  return {
    invalidate() { cachedWidth = undefined; },
    render(columns) {
      const width = Math.max(1, columns);
      page = Math.max(1, Math.min(28, (tui.terminal?.rows || 24) - 6));
      if (cachedWidth !== width) {
        lines = text.split('\n').flatMap(line => wrapTextWithAnsi(line, width).map(part => truncateToWidth(part, width, '')));
        cachedWidth = width;
      }
      clamp();
      return [truncateToWidth(title, width, ''),
        ...lines.slice(offset, offset + page), truncateToWidth(`${offset + 1}-${Math.min(lines.length, offset + page)} / ${lines.length}`, width, ''),
        truncateToWidth(confirm ? 'Enter Apply | Esc Cancel' : 'Up/Down | Esc close', width, '')];
    },
    handleInput(data) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) { done(false); return; }
      if (confirm && matchesKey(data, Key.enter)) { done(true); return; }
      if (matchesKey(data, Key.up)) offset--;
      else if (matchesKey(data, Key.down)) offset++;
      else if (matchesKey(data, Key.pageUp)) offset -= page;
      else if (matchesKey(data, Key.pageDown)) offset += page;
      else if (matchesKey(data, Key.home)) offset = 0;
      else if (matchesKey(data, Key.end)) offset = lines.length;
      clamp(); tui.requestRender();
    },
  };
}
export async function showPoolStatus(pool, ctx, output) {
  const recent = recentActivity(ctx);
  const text = [pool.report(), '\nHistorical activity (newest first; not current readiness)',
    ...(recent.length ? recent.map(data => new Date(data.at).toISOString() + '\n' + activityText(data)) : ['No pool activity recorded in this session.'])].join('\n');
  if (ctx.hasUI && typeof ctx.ui.custom === 'function') {
    const viewed = await ctx.ui.custom((tui, _theme, _keys, done) => createPoolStatusViewer(text, { tui, done, title:pool.scope==='free'?'Free Pool':'OVH pool' }));
    if (viewed !== undefined) return;
  }
  output(text, ctx);
}
