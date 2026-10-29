import test from "node:test";
import assert from "node:assert/strict";
import { thinkingProfile, selectThinking, LEVELS } from "../src/models.js";
import { piLevelForNative, thinkingSync } from "../src/thinking-sync.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { piModel } from "../src/models.js";
import { recordKey } from "../src/catalog.js";
const state = { sources: {}, entries: {} };
function entry(variants, service = "kilo") {
  return {
    service,
    id: "arbitrary-vendor/arbitrary-model",
    name: "Unrelated model",
    type: "chat",
    classification: "free",
    listed: true,
    lifecycle: "active",
    fresh: true,
    raw: {},
    metadata:
      service === "kilo"
        ? { opencode: { variants } }
        : { reasoning_options: variants },
  };
}

for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"])
  test(`explicit ${effort} effort takes precedence over generic thinking mode name`, () => {
    const e = entry({
      instant: { reasoning: { enabled: false, effort: "none" } },
      thinking: { reasoning: { enabled: true, effort } },
    });
    assert.equal(piLevelForNative(e, state, "thinking"), effort);
    assert.deepEqual(selectThinking(e, state, "auto", effort), {
      reasoning: { enabled: true, effort },
    });
    assert.deepEqual(getSupportedThinkingLevels(piModel(e, state)), [
      "off",
      effort,
    ]);
  });
for (const name of ["deliberate", "on", "unfamiliar-mode", "low"])
  test(`explicit high effort is authoritative even when the native mode is named ${name}`, () => {
    const e = entry({
      [name]: { reasoning: { enabled: true, effort: "high" } },
    });
    assert.equal(piLevelForNative(e, state, name), "high");
    assert.equal(thinkingProfile(e, state).piChoices.high, name);
  });
test("an explicit low effort on a native mode named high does not create a false high mapping", () => {
  const e = entry({ high: { reasoning: { effort: "low" } } });
  assert.equal(piLevelForNative(e, state, "high"), "low");
  assert.equal(thinkingProfile(e, state).map.high, null);
});
test("unknown explicit effort is preserved natively and never replaced by a familiar mode name", () => {
  for (const name of ["thinking", "on", "high"]) {
    const e = entry({
      [name]: { reasoning: { enabled: true, effort: "future-effort" } },
    });
    assert.equal(piLevelForNative(e, state, name), null);
    assert.ok(
      Object.values(thinkingProfile(e, state).map).every((x) => x === null),
    );
    assert.deepEqual(selectThinking(e, state, name), {
      reasoning: { enabled: true, effort: "future-effort" },
    });
  }
});
test("explicit disable takes precedence over a contradictory effort without rewriting native parameters", () => {
  const e = entry({
    thinking: { reasoning: { enabled: false, effort: "high" } },
  });
  assert.equal(piLevelForNative(e, state, "thinking"), "off");
  assert.deepEqual(selectThinking(e, state, "auto", "off"), {
    reasoning: { enabled: false, effort: "high" },
  });
});
test("bare Kilo toggle has no invented medium or high effort", () => {
  const e = entry({
    off: { reasoning: { enabled: false } },
    on: { reasoning: { enabled: true } },
  });
  const p = thinkingProfile(e, state);
  assert.equal(p.map.medium, null);
  assert.equal(p.map.high, null);
  assert.equal(piLevelForNative(e, state, "on"), null);
  assert.deepEqual(selectThinking(e, state, "on"), {
    reasoning: { enabled: true },
  });
  assert.deepEqual(selectThinking(e, state, "auto", "off"), {
    reasoning: { enabled: false },
  });
  assert.throws(
    () => selectThinking(e, state, "auto", "medium"),
    /not advertised/,
  );
});

test("thinking enabled with a token budget is not silently labelled as a Pi effort", () => {
  const e = entry({
    thinking: { thinking: { type: "enabled", budget_tokens: 1234 } },
  });
  assert.equal(piLevelForNative(e, state, "thinking"), null);
  assert.deepEqual(selectThinking(e, state, "thinking"), {
    thinking: { type: "enabled", budget_tokens: 1234 },
  });
});
test("top-level reasoning_effort obeys the same precedence architecture", () => {
  const e = entry({ thinking: { reasoning_effort: "low" } });
  assert.equal(piLevelForNative(e, state, "thinking"), "low");
  assert.deepEqual(selectThinking(e, state, "auto", "low"), {
    reasoning_effort: "low",
  });
});

test("a native Pi-named choice without an effort field retains its exact native payload", () => {
  const e = entry({
    high: { thinking: { type: "enabled", budget_tokens: 9999 } },
  });
  assert.equal(piLevelForNative(e, state, "high"), "high");
  assert.deepEqual(selectThinking(e, state, "auto", "high"), {
    thinking: { type: "enabled", budget_tokens: 9999 },
  });
});
test("mapping collisions are deterministic and prefer the exact effort-named choice", () => {
  const a = {
    thinking: { reasoning: { effort: "high" }, verbosity: "low" },
    high: { reasoning: { effort: "high" }, verbosity: "high" },
  };
  const b = Object.fromEntries(Object.entries(a).reverse());
  assert.deepEqual(
    thinkingProfile(entry(a), state).map,
    thinkingProfile(entry(b), state).map,
  );
  assert.equal(thinkingProfile(entry(a), state).piChoices.high, "high");
  assert.equal(piLevelForNative(entry(a), state, "thinking"), null); // Different verbosity means not equivalent.
  assert.deepEqual(selectThinking(entry(a), state, "thinking"), {
    reasoning: { effort: "high" },
    verbosity: "low",
  });
});
test("two native names with identical supported parameters can share an exact Pi equivalent", () => {
  const e = entry({
    a: { reasoning: { effort: "high" } },
    b: { reasoning: { effort: "high" } },
  });
  assert.equal(piLevelForNative(e, state, "a"), "high");
  assert.equal(piLevelForNative(e, state, "b"), "high");
});
test("mapping changes do not allow native variants to rewrite model IDs or tools", () => {
  const e = entry({
    thinking: {
      reasoning: { enabled: true, effort: "high" },
      model: "paid-model",
      tools: [],
      messages: [],
    },
  });
  assert.deepEqual(selectThinking(e, state, "auto", "high"), {
    reasoning: { enabled: true, effort: "high" },
  });
});
test("saved native mode restores corrected Pi level and subsequent Pi change releases the override", async () => {
  const e = entry({
    instant: { reasoning: { enabled: false, effort: "none" } },
    thinking: { reasoning: { enabled: true, effort: "high" } },
  });
  const key = recordKey("kilo", e.id),
    st = { sources: {}, entries: { [key]: e } },
    prefs = { [key]: "thinking" };
  let level = "medium",
    saves = 0,
    sync;
  const ctx = {
    model: { provider: "free-kilo", id: e.id },
    ui: { setStatus() {} },
  };
  const pi = {
    getThinkingLevel: () => level,
    setThinkingLevel: (n) => {
      level = n;
      void sync.selected({}, ctx);
    },
  };
  sync = thinkingSync({
    pi,
    catalog: { state: st },
    getSelection: () => prefs[key],
    setSelection: (k, v) => (prefs[k] = v),
    save: async () => {
      saves++;
    },
    output() {},
  });
  sync.restore(ctx);
  assert.equal(level, "high");
  assert.equal(prefs[key], "thinking");
  level = "off";
  await sync.selected({}, ctx);
  assert.equal(prefs[key], "auto");
  assert.equal(saves, 1);
  assert.deepEqual(selectThinking(e, st, prefs[key], level), {
    reasoning: { enabled: false, effort: "none" },
  });
});
test("unmapped enabled toggle remains effective without a fictional Pi effort or persistent label", () => {
  const e = entry({ on: { reasoning: { enabled: true } } }),
    key = recordKey("kilo", e.id),
    statuses = new Map();
  let level = "off";
  const ctx = {
    model: { provider: "free-kilo", id: e.id },
    ui: { setStatus: (k, v) => statuses.set(k, v) },
  };
  const sync = thinkingSync({
    pi: { getThinkingLevel: () => level, setThinkingLevel: (n) => (level = n) },
    catalog: { state: { sources: {}, entries: { [key]: e } } },
    getSelection: () => "on",
    setSelection() {},
    save: async () => {},
    output() {},
  });
  sync.restore(ctx);
  assert.equal(level, "off");
  assert.equal(statuses.get("free-thinking"), undefined);
  assert.equal(piLevelForNative(e, state, "on"), null);
  assert.deepEqual(selectThinking(e, state, "on"), {reasoning:{enabled:true}});
});
test("all Pi map entries are either null or an advertised native route, with no generic on=medium fallback", () => {
  const e = entry({
    thinking: { reasoning: { enabled: true } },
    instant: { reasoning: { enabled: false } },
    arbitrary: { reasoning: { effort: "low" } },
  });
  const p = thinkingProfile(e, state);
  for (const level of LEVELS)
    assert.equal(p.map[level] !== null, Object.hasOwn(p.piChoices, level));
  assert.deepEqual(Object.keys(p.piChoices).sort(), ["low", "off"]);
});
