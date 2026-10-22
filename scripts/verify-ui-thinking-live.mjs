/** Opt-in live proof: fresh catalogs, actual Pi AgentSession, no mocks or personal auth.
 * Run in a clean HOME with PI_CODING_AGENT_DIR isolated, after npm install.
 * node scripts/verify-ui-thinking-live.mjs /absolute/evidence-directory
 * Makes up to ~14 short free-model requests. This is not run by npm test.
 */
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import dc from "node:diagnostics_channel";
import fs from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.js";
import { assessToolWorkflow, assertModelCompleted } from "./live-checks.mjs";
const root = resolve(process.argv[2] || "live-proof");
await mkdir(root, { recursive: true });
const wireFile = join(root, "wire.jsonl"),
  requests = new WeakMap();
let requestCount = 0;
const log = (x) =>
  fs.appendFileSync(
    wireFile,
    JSON.stringify({ at: new Date().toISOString(), ...x }) + "\n",
  );
dc.subscribe("undici:request:create", ({ request }) => {
  if (
    request.method === "POST" &&
    /api\.kilo\.ai|opencode\.ai/.test(String(request.origin))
  )
    requests.set(request, { id: ++requestCount, parts: [] });
});
dc.subscribe("undici:request:bodyChunkSent", ({ request, chunk }) => {
  const x = requests.get(request);
  if (x) x.parts.push(Buffer.from(chunk));
});
dc.subscribe("undici:request:bodySent", ({ request }) => {
  const x = requests.get(request);
  if (x)
    log({
      kind: "request",
      id: x.id,
      url: String(request.origin) + request.path,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(x.parts).toString()),
    });
});
dc.subscribe("undici:request:headers", ({ request, response }) => {
  const x = requests.get(request);
  if (x) log({ kind: "response", id: x.id, http: response.statusCode });
});
const statuses = new Map(),
  notes = [],
  errors = [],
  result = { at: new Date().toISOString(), cases: [], errors };
let session;
const save = () =>
  writeFile(join(root, "results.json"), JSON.stringify(result, null, 2));
async function prompt(text, timeout = 120000) {
  let timer;
  try {
    await Promise.race([
      session.prompt(text),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Live prompt deadline"));
          void session.abort().catch(() => {});
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function chat(label, provider, id, setup) {
  await session.setModel(session.modelRuntime.getModel(provider, id));
  await setup();
  const before = requestCount,
    start = performance.now();
  await prompt("What is 17 multiplied by 19? Answer only the number.");
  const last = session.messages.filter((m) => m.role === "assistant").at(-1);
  const text = (last?.content || [])
    .filter((x) => x.type === "text")
    .map((x) => x.text)
    .join("");
  const c = {
    label,
    provider,
    id,
    piThinking: session.thinkingLevel,
    seconds: (performance.now() - start) / 1000,
    answer: text,
    stopReason: last?.stopReason,
    errorMessage: last?.errorMessage,
    pass: /\b323\b/.test(text) && last?.stopReason !== "error",
    apiRequests: requestCount - before,
  };
  result.cases.push(c);
  await save();
  console.log(label, c.pass, c.seconds.toFixed(2), session.thinkingLevel);
  if (last?.stopReason === "error" || last?.stopReason === "aborted")
    throw new Error(
      "Live model error; stopped without retries/fallback: " +
        (last.errorMessage || last.stopReason),
    );
}
async function tools(provider, id) {
  await session.setModel(session.modelRuntime.getModel(provider, id));
  session.setThinkingLevel("low");
  const dir = join(root, provider + "-tools");
  await mkdir(dir, { recursive: true });
  const token = randomBytes(12).toString("hex"),
    fixture = "TOKEN=" + token + "\n",
    expected = "stage=done\nTOKEN=" + token + "\n";
  const verifier = `import pathlib,hashlib,json\np=pathlib.Path(__file__).parent/'result.txt'\nb=p.read_bytes()\nassert b.decode()==${JSON.stringify(expected)}\nprint(json.dumps({'verified':True,'sha256':hashlib.sha256(b).hexdigest()}))\n`;
  await writeFile(join(dir, "fixture.txt"), fixture);
  await writeFile(join(dir, "verify.py"), verifier);
  await unlink(join(dir, "result.txt")).catch(() => {});
  const events = [],
    start = performance.now(),
    before = requestCount;
  const unsub = session.subscribe((e) => {
    if (e.type.startsWith("tool_execution_")) events.push(e);
  });
  try {
    await prompt(
      `Use the actual read, write, edit, bash tools, in that order. Work only inside ${dir}. Do not access network, credentials or environment variables. Read ${dir}/fixture.txt with read. Write ${dir}/result.txt with write, exactly two lines: stage=raw and TOKEN=<the token from fixture.txt>, ending with a newline. Use edit to replace stage=raw with stage=done. Use bash to run python3 ${dir}/verify.py. Do not alter fixture.txt or verify.py. Do not substitute bash for read/write/edit. After verification answer exactly DONE <TOKEN> <sha256 printed by verifier>.`,
      180000,
    );
  } finally {
    unsub();
  }
  const data = await readFile(join(dir, "result.txt"), "utf8").catch(() => ""),
    sha = createHash("sha256").update(data).digest("hex");
  const last = session.messages.filter((m) => m.role === "assistant").at(-1),
    answer = (last?.content || [])
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("");
  const verification = assessToolWorkflow({
    events,
    cwd: root,
    dir,
    data,
    expected,
    answer,
    last,
    sha,
    token,
    fixtureUnchanged:
      (await readFile(join(dir, "fixture.txt"), "utf8")) === fixture,
    verifierUnchanged:
      (await readFile(join(dir, "verify.py"), "utf8")) === verifier,
  });
  const c = {
    label: provider + "-four-tools",
    provider,
    id,
    piThinking: session.thinkingLevel,
    seconds: (performance.now() - start) / 1000,
    sha,
    token,
    answer,
    apiRequests: requestCount - before,
    events,
    ...verification,
  };
  result.cases.push(c);
  await save();
  console.log(c.label, c.pass, c.seconds.toFixed(2));
  assertModelCompleted(last);
}
try {
  const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false, maxRetries: 0 },
      compaction: { enabled: false },
    }),
    agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("Set isolated PI_CODING_AGENT_DIR");
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      async (pi) =>
        extension({
          ...pi,
          // Test-only request budget and retry policy; do not alter headers or payloads.
          registerProvider: (id, config) =>
            pi.registerProvider(id, {
              ...config,
              streamSimple: (model, context, options = {}) =>
                config.streamSimple(model, context, {
                  ...options,
                  maxRetries: 0,
                  onPayload: async (payload, currentModel) => {
                    if (requestCount >= 24)
                      throw new Error("Live request budget exhausted");
                    return options.onPayload
                      ? await options.onPayload(payload, currentModel)
                      : undefined;
                  },
                }),
            }),
        }),
    ],
  });
  await loader.reload();
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
  }));
  await session.bindExtensions({
    mode: "print",
    uiContext: {
      setStatus: (k, v) =>
        v === undefined ? statuses.delete(k) : statuses.set(k, v),
      notify: (...x) => notes.push(x),
    },
    onError: (e) => errors.push(e),
  });
  result.defaultTools = session.getActiveToolNames();
  if (
    !["read", "write", "edit", "bash"].every((x) =>
      result.defaultTools.includes(x),
    )
  )
    throw new Error("Default tools missing");
  result.models = session.modelRuntime
    .getAllModels()
    .filter((m) => m.provider === "free-kilo" || m.provider === "free-zen")
    .map((m) => ({
      id: m.id,
      provider: m.provider,
      thinkingLevelMap: m.thinkingLevelMap,
    }));
  await save();
  if (!process.argv.includes("--toggle-only"))
    for (const [provider, id] of [
      ["free-kilo", "reflection/beam-free"],
      ["free-zen", "beam-free"],
    ]) {
      await chat(provider + "-slash-low", provider, id, () =>
        session.prompt("/free-thinking low"),
      );
      await session.prompt("/free-thinking high");
      if (session.thinkingLevel !== "high")
        throw new Error("Slash did not change Pi");
      await chat(provider + "-pi-low-after-high", provider, id, async () =>
        session.setThinkingLevel("low"),
      );
      await tools(provider, id);
    }
  if (process.argv.includes("--toggle-only")) {
    const provider = "free-kilo",
      id = process.argv.includes("--toggle-model")
        ? process.argv[process.argv.indexOf("--toggle-model") + 1]
        : "poolside/laguna-s-2.1:free";
    await chat("toggle-native-thinking", provider, id, async () => {
      await session.prompt("/free-thinking thinking");
      if (session.thinkingLevel !== "high")
        throw new Error("Expected advertised high effort to map to Pi high");
    });
    await chat("toggle-native-instant", provider, id, () =>
      session.prompt("/free-thinking instant"),
    );
    await chat("toggle-Pi-high", provider, id, async () => {
      session.setThinkingLevel("high");
    });
    await chat("toggle-Pi-off", provider, id, async () => {
      session.setThinkingLevel("high");
      session.setThinkingLevel("off");
    });
  }
  result.pass =
    result.cases.length === (process.argv.includes("--toggle-only") ? 4 : 6) &&
    result.cases.every((x) => x.pass) &&
    errors.length === 0;
  result.notes = notes;
  result.done = true;
} catch (error) {
  result.fatal = String(error.stack || error);
  result.pass = false;
  console.error(result.fatal);
} finally {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
  }
  await save();
}
if (!result.pass) process.exitCode = 1;
