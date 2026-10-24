import { FooterComponent } from '@earendil-works/pi-coding-agent';
import { freeModelKey } from './thinking-sync.js';

/** Reuse Pi's exported renderer, with a local read-only view (never mutate core/provider IDs). */
export function freeFooter(pi, ctx, tui, footerData) {
  const session = {
    get state() {
      return { model: ctx.model, thinkingLevel: pi.getThinkingLevel() };
    },
    get model() {
      return ctx.model;
    },
    get sessionManager() {
      return ctx.sessionManager;
    },
    getContextUsage: () => ctx.getContextUsage(),
    // This footer is installed only for our three anonymous, non-subscription providers.
    modelRuntime: { isUsingSubscription: () => false },
  };
  const data = {
    getGitBranch: () => footerData.getGitBranch(),
    getExtensionStatuses: () => footerData.getExtensionStatuses(),
    getAvailableProviderCount: () => 1,
    onBranchChange: (fn) => footerData.onBranchChange(fn),
  };
  const component = new FooterComponent(session, data);
  const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
  return {
    invalidate: () => component.invalidate(),
    dispose: () => {
      unsubscribe();
      component.dispose();
    },
    render(width) {
      component.setAutoCompactEnabled(
        pi.getSettings().compaction?.enabled !== false,
      );
      return component.render(width);
    },
  };
}
/** Pi exposes one footer slot, not a composable provider-label filter.
 * Claim it only on explicit opt-in/startup restoration. Disposal relinquishes ownership;
 * never clear somebody else's footer or automatically reclaim it on a model change.
 */
export function footerController({ pi, getMode }) {
  let owned = null;
  const update = (ctx, { claim = false } = {}) => {
    if (ctx.mode !== 'tui') return;
    const eligible = getMode() === 'compact' && freeModelKey(ctx.model);
    if (!eligible) {
      if (owned?.active) ctx.ui.setFooter(undefined);
      owned = null;
      return;
    }
    if (!claim || owned?.active) return;
    const token = { active: true };
    owned = token;
    ctx.ui.setFooter((tui, _theme, data) => {
      const component = freeFooter(pi, ctx, tui, data);
      return {
        render: (width) => component.render(width),
        invalidate: () => component.invalidate(),
        dispose: () => {
          token.active = false;
          component.dispose();
        },
      };
    });
  };
  update.release = ctx => {
    if (owned?.active) ctx?.ui.setFooter(undefined);
    owned = null;
  };
  return update;
}
