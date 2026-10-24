import { isDeepStrictEqual } from 'node:util';
import { PROVIDERS, recordKey } from './catalog.js';
import { LEVELS, selectThinking } from './models.js';

export function freeModelKey(model) {
  const service = Object.entries(PROVIDERS).find(
    ([, provider]) => provider === model?.provider,
  )?.[0];
  return service
    ? { service, id: model.id, key: recordKey(service, model.id) }
    : null;
}
/** Only claim a Pi equivalent when it produces exactly the same native parameters. */
export function piLevelForNative(entry, state, mode) {
  if (['auto', 'default'].includes(mode)) return null;
  const target = selectThinking(entry, state, mode);
  const levels = LEVELS.includes(mode)
    ? [mode, ...LEVELS.filter((x) => x !== mode)]
    : LEVELS;
  for (const level of levels) {
    try {
      if (
        isDeepStrictEqual(selectThinking(entry, state, 'auto', level), target)
      )
        return level;
    } catch {}
  }
  return null;
}
/** Events improve UI responsiveness; the current Pi state is authoritative at request time. */
export function thinkingSync({
  pi,
  catalog,
  getSelection,
  setSelection,
  save,
  output,
}) {
  let bound = null,
    mirroring = false;
  function mirror(level) {
    if (pi.getThinkingLevel() === level) return;
    mirroring = true;
    try {
      pi.setThinkingLevel(level);
    } finally {
      mirroring = false;
    }
  }
  function resolveSelection(service, id) {
    const key = recordKey(service, id),
      mode = getSelection(service, id),
      level = pi.getThinkingLevel();
    if (bound?.key === key && !mirroring && level !== bound.level) {
      bound.level = level;
      if (mode !== 'auto') {
        setSelection(key, 'auto');
        // Update memory synchronously, before a request can observe the old override.
        const ctx = bound.ctx;
        void save().catch((error) =>
          output(`Could not save thinking preference: ${error}`, ctx),
        );
      }
      return 'auto';
    }
    return mode;
  }
  function status(ctx) {
    // Pi already displays the active model/thinking. Do not leave duplicate labels behind.
    ctx.ui.setStatus('free-thinking', undefined);
  }
  function restore(ctx) {
    const model = freeModelKey(ctx.model);
    bound = model
      ? { key: model.key, level: pi.getThinkingLevel(), ctx }
      : null;
    if (model) {
      const entry = catalog.state.entries[model.key],
        mode = getSelection(model.service, model.id);
      if (entry && mode === 'auto') {
        // Re-apply even when unchanged: Pi's public setter clamps against the NEW model.
        mirroring = true;
        try { pi.setThinkingLevel(pi.getThinkingLevel()); } finally { mirroring = false; }
      }
      if (entry && !['auto', 'default'].includes(mode)) {
        try {
          const level = piLevelForNative(entry, catalog.state, mode);
          if (level !== null) mirror(level);
        } catch (error) {
          output(`Saved thinking is no longer supported: ${error}`, ctx);
        }
      }
      bound.level = pi.getThinkingLevel();
    }
    status(ctx);
  }
  function reconcile(ctx) {
    const model = freeModelKey(ctx.model);
    if (model && model.key === bound?.key)
      resolveSelection(model.service, model.id);
    status(ctx);
  }
  async function selected(_event, ctx) {
    // Model-switch preliminary events must not erase the target model's saved choice.
    if (mirroring || freeModelKey(ctx.model)?.key !== bound?.key) return;
    reconcile(ctx);
  }
  function applyNative(mode, ctx) {
    const model = freeModelKey(ctx.model),
      entry = model && catalog.state.entries[model.key];
    if (!entry) return;
    bound = { key: model.key, level: pi.getThinkingLevel(), ctx };
    if (mode === 'auto') {
      mirroring = true;
      try { pi.setThinkingLevel(pi.getThinkingLevel()); } finally { mirroring = false; }
    }
    if (!['auto', 'default'].includes(mode)) {
      const level = piLevelForNative(entry, catalog.state, mode);
      if (level !== null) mirror(level);
    }
    bound.level = pi.getThinkingLevel();
    status(ctx);
  }
  return {
    restore,
    selected,
    applyNative,
    status,
    reconcile,
    resolveSelection,
    unbind: () => {
      bound = null;
    },
  };
}
