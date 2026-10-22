import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { recordKey } from "../src/catalog.js";
import { fixtures, fetcher } from "./helpers.mjs";
import extension from "../index.js";

test("actual Pi session restores generic on/low effort, clamps selector, and sends exact native parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "effort-architecture-session-")),
    oldDir = process.env.PI_CODING_AGENT_DIR,
    original = globalThis.fetch;
  const id = "arbitrary-vendor/not-laguna",
    d = structuredClone(fixtures),
    wires = [],
    errors = [];
  let session;
  d.kilo.data.push({
    id,
    isFree: true,
    context_length: 16000,
    max_completion_tokens: 1000,
    opencode: {
      variants: {
        instant: { reasoning: { enabled: false, effort: "none" } },
        on: { reasoning: { enabled: true, effort: "low" } },
      },
    },
  });
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/chat/completions")) {
      wires.push(JSON.parse(init.body));
      return new Response(
        'data: {"id":"x","choices":[{"index":0,"delta":{"content":"323"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return fetcher(d)(input, init);
  };
  try {
    await mkdir(join(dir, "free-catalog"));
    await writeFile(
      join(dir, "free-catalog/thinking.json"),
      JSON.stringify({ [recordKey("kilo", id)]: "on" }),
    );
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
      uiContext: { setStatus() {}, setFooter() {}, notify() {} },
      onError: (e) => errors.push(e),
    });
    await session.setModel(session.modelRuntime.getModel("free-kilo", id));
    assert.equal(session.thinkingLevel, "low");
    assert.deepEqual(session.getAvailableThinkingLevels(), ["off", "low"]);
    await session.prompt("17*19?");
    assert.deepEqual(wires.at(-1).reasoning, { enabled: true, effort: "low" });
    session.setThinkingLevel("off");
    await session.prompt("17*19?");
    assert.deepEqual(wires.at(-1).reasoning, {
      enabled: false,
      effort: "none",
    });
    await session.prompt("/free-thinking on");
    assert.equal(session.thinkingLevel, "low");
    await session.prompt("17*19?");
    assert.deepEqual(wires.at(-1).reasoning, { enabled: true, effort: "low" });
    assert.deepEqual(errors, []);
    assert.equal(wires.length, 3);
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    globalThis.fetch = original;
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
