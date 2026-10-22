import {
  Input,
  matchesKey,
  Key,
  wrapTextWithAnsi,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { report, modelReport, visibleEntries } from "./catalog-report.js";

/** Read-only, bounded viewport. No host renderer replacement, refresh, timers, or writes. */
export function createCatalogViewer(state, { tui, done, health = {} }) {
  const input = new Input({
    prompt: "ID search: ",
    placeholder: "type a model ID; empty shows every report record",
  });
  let offset = 0,
    lines = [],
    cacheKey,
    width = 80,
    page = 12,
    focused = false;
  const all = visibleEntries(state).length;
  const clamp = () => {
    offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - page)));
  };
  return {
    get focused() {
      return focused;
    },
    set focused(value) {
      focused = value;
      input.focused = value;
    },
    invalidate() {
      cacheKey = undefined;
      input.invalidate();
    },
    render(columns) {
      width = Math.max(1, columns);
      // Reserve room for Pi's surrounding UI, while remaining usable on short terminals.
      const height = Math.max(4, Math.min(30, (tui.terminal?.rows || 24) - 8));
      page = Math.max(1, height - 3);
      const query = input.getValue(),
        key = `${width}\n${query}`;
      if (key !== cacheKey) {
        const text = query.trim()
          ? [
              "MODEL ID SEARCH",
              `${visibleEntries(state, query).length} of ${all} report records match. Clear the search to return to counts and source details.`,
              ...visibleEntries(state, query).map((e) => reportModel(e)),
            ].join("\n\n")
          : report(state, { health });
        lines = text
          .split("\n")
          .flatMap((line) =>
            wrapTextWithAnsi(line, width).map((part) =>
              truncateToWidth(part, width, ""),
            ),
          );
        cacheKey = key;
      }
      clamp();
      const header = truncateToWidth(
        "Free catalog | Esc close | arrows/PgUp/PgDn scroll | Home/End",
        width,
      );
      const body = lines.slice(offset, offset + page);
      while (body.length < page) body.push("");
      const footer = truncateToWidth(
        `Lines ${lines.length ? offset + 1 : 0}-${Math.min(offset + page, lines.length)} / ${lines.length} | ${query.trim() ? "Search active" : `${all} records; none filtered by search`}`,
        width,
      );
      return [header, ...input.render(width), ...body, footer];
    },
    handleInput(data) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        done();
        return;
      }
      if (matchesKey(data, Key.up)) offset--;
      else if (matchesKey(data, Key.down)) offset++;
      else if (matchesKey(data, Key.pageUp)) offset -= page;
      else if (matchesKey(data, Key.pageDown)) offset += page;
      else if (matchesKey(data, Key.home)) offset = 0;
      else if (matchesKey(data, Key.end)) offset = lines.length;
      else {
        const before = input.getValue();
        input.handleInput(data);
        if (input.getValue() !== before) {
          offset = 0;
          cacheKey = undefined;
        }
      }
      clamp();
      tui.requestRender();
    },
  };
  function reportModel(entry) {
    // The shared presenter is also used for plain-text output.
    return modelReport(entry, state, { health });
  }
}

export async function showCatalog(state, ctx, output, health = {}) {
  if (ctx.hasUI && ctx.mode === "tui" && typeof ctx.ui.custom === "function")
    // A focused public overlay receives PageUp/PageDown/Home/End. In Pi's
    // alternate-screen editor slot those keys belong to the chat viewport.
    await ctx.ui.custom(
      (tui, _theme, _keybindings, done) =>
        createCatalogViewer(state, { tui, done, health }),
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
      },
    );
  else output(report(state, { health }), ctx);
}
