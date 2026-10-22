import { PROVIDERS, isRecord, array, modelRows } from "./catalog.js";
import { OVH_BASE } from "./ovh.js";
export const LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export function thinkingProfile(entry, state) {
  const m = isRecord(entry.metadata) ? entry.metadata : {},
    choices = Object.create(null);
  let controlSource = entry.evidence;
  let controlsFromHint = false;
  if (entry.service === "kilo") {
    for (const [key, value] of Object.entries(
      isRecord(m.opencode?.variants) ? m.opencode.variants : {},
    )) {
      if (isRecord(value))
        choices[key] = { label: key, params: structuredClone(value) };
    }
  }
  if (!Object.keys(choices).length) {
    for (const option of array(
      m.reasoning_options ?? m.opencode?.reasoning_options,
    )) {
      if (!isRecord(option)) continue;
      if (option.type === "effort" && Array.isArray(option.values))
        for (const effort of option.values) {
          if (typeof effort === "string")
            choices[effort] = {
              label: effort,
              params:
                entry.service === "kilo"
                  ? { reasoning: { enabled: effort !== "none", effort } }
                  : { reasoning_effort: effort },
            };
        }
      if (option.type === "toggle") {
        choices.off = {
          label: "off",
          params:
            entry.service === "kilo"
              ? { reasoning: { enabled: false } }
              : { thinking: { type: "disabled" } },
        };
        choices.on = {
          label: "on",
          params:
            entry.service === "kilo"
              ? { reasoning: { enabled: true } }
              : { thinking: { type: "enabled" } },
        };
      }
    }
  }
  const piModels = modelRows(state?.sources?.pi?.data);
  const hint =
    entry.service === "zen"
      ? piModels.find((x) => x.id === entry.id)
      : undefined;
  if (!Object.keys(choices).length) {
    const sourceMap = isRecord(m.thinkingLevelMap)
      ? m.thinkingLevelMap
      : isRecord(hint?.thinkingLevelMap)
        ? hint.thinkingLevelMap
        : {};
    if (sourceMap === hint?.thinkingLevelMap) {
      controlSource = "pi";
      controlsFromHint = true;
    }
    for (const [level, effort] of Object.entries(sourceMap)) {
      if (typeof effort === "string")
        choices[level] = { label: level, params: { reasoning_effort: effort } };
    }
  }
  // Route Pi controls by explicit provider effort first, never by a model ID.
  // Keep the selected native choice as well as the SDK's string-valued map:
  // a toggle without an advertised effort has no exact Pi effort equivalent.
  const map = Object.fromEntries(LEVELS.map((level) => [level, null]));
  const piChoices = Object.create(null);
  const candidates = Object.entries(choices)
    .map(([key, choice]) => {
      const r = choice.params.reasoning;
      const effort = r?.effort ?? choice.params.reasoning_effort;
      let level = null,
        priority = 0;
      if (r?.enabled === false || choice.params.thinking?.type === "disabled") {
        level = "off";
        priority = 4;
      } else if (typeof effort === "string") {
        level =
          effort === "none" ? "off" : LEVELS.includes(effort) ? effort : null;
        priority = 3;
      } else if (LEVELS.includes(key)) {
        level = key;
        priority = 2;
      } else if (key === "none" || key === "instant") {
        level = "off";
        priority = 1;
      }
      return { key, level, effort, priority };
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        Number(b.key === b.level) - Number(a.key === a.level) ||
        a.key.localeCompare(b.key),
    );
  for (const { key, level, effort } of candidates) {
    if (!level || Object.hasOwn(piChoices, level)) continue;
    piChoices[level] = key;
    map[level] =
      typeof effort === "string" ? effort : level === "off" ? "none" : level;
  }
  const reasoning =
    Object.keys(choices).length > 0 ||
    m.reasoning === true ||
    array(m.supported_parameters).includes("reasoning");
  return {
    reasoning,
    choices,
    map,
    piChoices,
    source: Object.keys(choices).length
      ? "provider metadata"
      : "provider-default-only",
    provenance: {
      source: controlSource || null,
      fresh: controlsFromHint
        ? state?.sources?.pi?.fresh === true
        : entry.metadataRetained === false &&
          state?.sources?.[controlSource]?.fresh === true,
      fetchedAt: controlsFromHint
        ? state?.sources?.pi?.fetchedAt || null
        : entry.metadataProvenance?.fetchedAt || null,
      documentFetchedAt: state?.sources?.[controlSource]?.fetchedAt || null,
    },
    note: Object.keys(choices).length
      ? null
      : "No advertised selectable thinking values; provider default is preserved, not invented.",
  };
}
export function piModel(entry, state) {
  const m = isRecord(entry.metadata) ? entry.metadata : {},
    kilo = entry.service === "kilo";
  const input = array(
    m.architecture?.input_modalities ?? m.modalities?.input ?? m.input,
  );
  const context = m.context_length ?? m.limit?.context ?? m.contextWindow;
  const max =
    m.top_provider?.max_completion_tokens ??
    m.max_completion_tokens ??
    m.limit?.output ??
    m.maxTokens;
  const warnings = [];
  // Required Pi numeric fields: explicitly labelled fallbacks, never claimed as verified limits.
  const contextWindow =
    Number.isSafeInteger(context) && context > 0 ? context : 8192;
  const maxTokens = Number.isSafeInteger(max) && max > 0 ? max : 2048;
  if (contextWindow !== context)
    warnings.push("context unknown; local safety fallback 8192");
  if (entry.type === "chat" && maxTokens !== max)
    warnings.push("output limit unknown; local safety fallback 2048");
  const profile = thinkingProfile(entry, state);
  const hint =
    entry.service === "zen"
      ? modelRows(state.sources.pi?.data).find((x) => x.id === entry.id)
      : null;
  let api =
    typeof m.api === "string"
      ? m.api
      : typeof hint?.api === "string"
        ? hint.api
        : "openai-completions";
  if (kilo) {
    api =
      (typeof m.openclaw?.api_adapter === "string"
        ? m.openclaw.api_adapter
        : null) ||
      (m.opencode?.ai_sdk_provider === "anthropic"
        ? "anthropic-messages"
        : "openai-completions");
  } else if (!m.api && !hint?.api) {
    const npm = m.provider?.npm;
    if (npm === "@ai-sdk/anthropic") api = "anthropic-messages";
    if (npm === "@ai-sdk/openai") api = "openai-responses";
  }
  if (entry.service === "ovh") api = "openai-completions";
  const base = {
    id: entry.id,
    name: `${entry.name}${entry.service === "ovh" && m.tool_call === false ? " [chat-only; tools not advertised]" : ""}${entry.fresh ? "" : " [cached]"}${entry.lifecycle === "deprecated" ? " [deprecated]" : ""}${warnings.length ? " [limits unverified]" : ""}`,
    type: entry.type,
    api,
    input: input.includes("image") ? ["text", "image"] : ["text"],
    cost: { ...cost },
    baseUrl: entry.service === "ovh" ? OVH_BASE : kilo
      ? "https://api.kilo.ai/api/gateway"
      : "https://opencode.ai/inference/v1",
  };
  if (entry.type === "classifier") return { ...base, contextWindow };
  if (entry.type !== "chat") return null;
  // Pi-native compatibility overrides from the live Pi catalog are keyed by exact ID.
  const compat = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsStrictMode: entry.service !== "ovh",
    maxTokensField: "max_tokens",
    ...(isRecord(hint?.compat) ? hint.compat : {}),
    ...(isRecord(m.compat) ? m.compat : {}),
  };
  if (kilo) {
    compat.thinkingFormat = "openrouter";
    if (m.opencode?.ai_sdk_provider === "anthropic")
      delete compat.thinkingFormat;
  }
  if (m.interleaved?.field === "reasoning_content")
    compat.requiresReasoningContentOnAssistantMessages = true;
  return {
    ...base,
    reasoning: profile.reasoning,
    thinkingLevelMap: profile.map,
    contextWindow,
    maxTokens,
    compat,
  };
}
export function registrations(state, service) {
  return Object.values(state.entries)
    .filter(
      (e) =>
        e.service === service &&
        e.classification === "free" &&
        e.listed &&
        e.lifecycle !== "retired",
    )
    .map((e) => piModel(e, state))
    .filter(Boolean);
}
export function selectThinking(entry, state, selection = "auto", piLevel) {
  const p = thinkingProfile(entry, state);
  if (selection === "default") return {};
  if (selection !== "auto") {
    const selected = Object.hasOwn(p.choices, selection)
      ? p.choices[selection]
      : undefined;
    if (!selected)
      throw new Error(
        `Unsupported native thinking '${selection}'. Available: default, auto, ${Object.keys(p.choices).join(", ") || "(provider default only)"}`,
      );
    const params = thinkingFields(selected.params);
    if (!Object.keys(params).length)
      throw new Error(
        `Native thinking '${selection}' has no supported payload fields; use default or auto`,
      );
    return params;
  }
  if (
    !Object.keys(p.choices).length ||
    Object.values(p.map).every((value) => value === null)
  )
    return {};
  if (!piLevel) return {};
  const key = p.piChoices[piLevel];
  if (key === undefined)
    throw new Error(
      `Pi thinking '${piLevel}' is not advertised for ${entry.id}. Use /free-thinking default or a native value: ${Object.keys(p.choices).join(", ")}`,
    );
  const selected = p.choices[key];
  const params = thinkingFields(selected.params);
  if (!Object.keys(params).length)
    throw new Error(
      `Native thinking for Pi '${piLevel}' has no supported payload fields; use default`,
    );
  return params;
}
const FIELDS = [
  "reasoning",
  "reasoning_effort",
  "thinking",
  "enable_thinking",
  "thinking_budget",
  "thinking_budget_tokens",
  "reasoning_budget",
  "verbosity",
];
export function thinkingFields(params) {
  if (!isRecord(params)) return {};
  return Object.fromEntries(
    FIELDS.filter((k) => Object.hasOwn(params, k)).map((k) => [
      k,
      structuredClone(params[k]),
    ]),
  );
}
export function applyThinking(payload, params) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Invalid inference payload");
  const result = { ...payload };
  for (const field of FIELDS) delete result[field];
  return { ...result, ...thinkingFields(params) };
}
export { report } from "./catalog-report.js";
