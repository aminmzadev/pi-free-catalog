import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { createCatalogViewer, showCatalog } from "../src/catalog-viewer.js";
import { visibleEntries } from "../src/catalog-report.js";
import { state, fetcher } from "./helpers.mjs";
import extension from "../index.js";
function setup(s = state(), rows = 24) {
  let closed = 0,
    renders = 0;
  const tui = { terminal: { rows }, requestRender: () => renders++ };
  const viewer = createCatalogViewer(s, { tui, done: () => closed++ });
  viewer.focused = true;
  return {
    viewer,
    tui,
    get closed() {
      return closed;
    },
    get renders() {
      return renders;
    },
  };
}
const text = (lines) => stripTerminalSequences(lines.join("\n"));
for (const width of [1, 10, 24, 35, 50, 80, 160])
  test(`viewport stays within ${width} terminal columns and a bounded number of rows`, () => {
    const { viewer } = setup(),
      rendered = viewer.render(width);
    assert.ok(rendered.length <= 16);
    for (const line of rendered)
      assert.ok(
        visibleWidth(line) <= width,
        `${visibleWidth(line)} > ${width}: ${line}`,
      );
  });
test("short terminal still renders a bounded minimum viewport", () => {
  const x = setup(state(), 12);
  assert.equal(x.viewer.render(35).length, 4);
});
test("arrow/page scrolling, home and end clamp to document bounds", () => {
  const x = setup(),
    v = x.viewer;
  const first = text(v.render(70));
  assert.match(first, /Lines 1-/);
  v.handleInput("\x1b[B");
  assert.match(text(v.render(70)), /Lines 2-/);
  v.handleInput("\x1b[6~");
  assert.doesNotMatch(text(v.render(70)), /Lines 2-/);
  v.handleInput("\x1b[F");
  const end = text(v.render(70));
  assert.match(end, /Lines \d+-(\d+) \/ \1/);
  v.handleInput("\x1b[B");
  assert.equal(text(v.render(70)), end);
  v.handleInput("\x1b[H");
  assert.match(text(v.render(70)), /Lines 1-/);
  v.handleInput("\x1b[A");
  assert.match(text(v.render(70)), /Lines 1-/);
});
test("ID search exposes full model ID, and Ctrl+U clears search back to summary", () => {
  const x = setup(),
    v = x.viewer;
  v.render(80);
  v.handleInput("reflection/beam-free");
  let screen = text(v.render(80));
  assert.match(screen, /1 of \d+ report records match/);
  assert.match(screen, /reflection\/beam-free/);
  assert.match(screen, /Search active/);
  v.handleInput("\x15");
  screen = text(v.render(80));
  assert.match(screen, /FREE MODEL CATALOG/);
  assert.doesNotMatch(screen, /Search active/);
});
test("search is case-insensitive and an empty result is clearly identified", () => {
  const x = setup(),
    v = x.viewer;
  v.render(80);
  v.handleInput("REFLECTION/BEAM-FREE");
  assert.match(text(v.render(80)), /1 of \d+/);
  v.handleInput("\x15");
  v.handleInput("no-such-model-id");
  assert.match(text(v.render(80)), /0 of \d+ report records match/);
});
test("narrow wrapping preserves the complete long identifier across accessible lines", () => {
  const s = state(),
    e = structuredClone(visibleEntries(s)[0]);
  e.id = "a-very-long-model-identifier-with-no-shortened-suffix-1234567890";
  s.entries.long = e;
  const x = setup(s),
    v = x.viewer;
  v.render(24);
  v.handleInput(e.id);
  let collected = "";
  for (let i = 0; i < 15; i++) {
    collected += text(v.render(24).slice(2, -1)).replaceAll("\n", "");
    v.handleInput("\x1b[6~");
  }
  assert.ok(collected.includes(e.id));
});
test("resizing and invalidation preserve a valid scroll position and column bounds", () => {
  const x = setup(),
    v = x.viewer;
  v.render(100);
  v.handleInput("\x1b[F");
  v.invalidate();
  for (const width of [35, 80, 24])
    for (const line of v.render(width)) assert.ok(visibleWidth(line) <= width);
});
test("Escape and Ctrl+C close without modifying the catalog", () => {
  const s = state(),
    before = structuredClone(s),
    x = setup(s);
  x.viewer.render(80);
  x.viewer.handleInput("\x1b");
  assert.equal(x.closed, 1);
  const y = setup(s);
  y.viewer.handleInput("\x03");
  assert.equal(y.closed, 1);
  assert.deepEqual(s, before);
});
test("opening, searching, scrolling and closing cause no network calls", async () => {
  const s = state(),
    before = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Unexpected network");
  };
  try {
    const x = setup(s);
    x.viewer.render(35);
    x.viewer.handleInput("laguna");
    x.viewer.render(35);
    x.viewer.handleInput("\x1b[6~");
    x.viewer.render(35);
    x.viewer.handleInput("\x1b");
    await showCatalog(s, { hasUI: false, mode: "print" }, () => {});
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = before;
  }
});
test("all report records are present by default; search is explicit and reversible", () => {
  const s = state(),
    x = setup(s);
  assert.match(
    text(x.viewer.render(100)),
    new RegExp(`${visibleEntries(s).length} records; none filtered by search`),
  );
  x.viewer.handleInput("fledge");
  x.viewer.render(100);
  x.viewer.handleInput("\x15");
  assert.match(text(x.viewer.render(100)), /none filtered by search/);
});
test("noninteractive output is labelled plain text rather than a giant notification or pipe table", async () => {
  let result;
  await showCatalog(
    state(),
    { hasUI: false, mode: "print" },
    (s) => (result = s),
  );
  assert.match(result, /Provider listing/);
  assert.match(result, /Selected metadata record/);
  assert.doesNotMatch(result, /\| chat \|/);
});
test("actual Pi AgentSession dispatches /free-catalog through public custom UI without refreshing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-viewer-pi-")),
    before = globalThis.fetch,
    oldDir = process.env.PI_CODING_AGENT_DIR;
  let session,
    fetches = 0,
    opened = 0;
  const errors = [];
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.fetch = async (...args) => {
    fetches++;
    return fetcher()(...args);
  };
  try {
    initTheme("dark");
    const settings = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [extension],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(dir),
    }));
    await session.bindExtensions({
      mode: "tui",
      uiContext: {
        setStatus() {},
        setFooter() {},
        notify() {},
        custom: async (factory) => {
          opened++;
          let closed = false;
          const component = await factory(
            { terminal: { rows: 24 }, requestRender() {} },
            null,
            null,
            () => (closed = true),
          );
          component.focused = true;
          assert.match(text(component.render(50)), /FREE MODEL CATALOG/);
          component.handleInput("reflection/beam-free");
          assert.match(text(component.render(80)), /reflection\/beam-free/);
          component.handleInput("\x1b");
          assert.equal(closed, true);
        },
      },
      onError: (e) => errors.push(e),
    });
    const initial = fetches;
    await session.prompt("/free-catalog");
    assert.equal(opened, 1);
    assert.equal(fetches, initial);
    assert.deepEqual(errors, []);
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    globalThis.fetch = before;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

// The real 50-column PTY caught a host-routing issue missed by component-only tests.
test("catalog requests a focused public overlay so Pi chat scrolling cannot consume paging keys", async () => {
  let options,
    closed = false;
  await showCatalog(
    state(),
    {
      hasUI: true,
      mode: "tui",
      ui: {
        custom: async (factory, opts) => {
          options = opts;
          const component = factory(
            { terminal: { rows: 24 }, requestRender() {} },
            null,
            null,
            () => (closed = true),
          );
          component.render(50);
          component.handleInput("\x1b[6~");
          assert.match(text(component.render(50)), /Lines 14-/);
          component.handleInput("\x1b");
        },
      },
    },
    () => {
      throw new Error("Must not use notification");
    },
  );
  assert.equal(options.overlay, true);
  assert.notEqual(options.overlayOptions.nonCapturing, true);
  assert.equal(options.overlayOptions.width, "100%");
  assert.equal(closed, true);
});
