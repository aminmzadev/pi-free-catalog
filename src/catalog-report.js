import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  SOURCES,
  PROVIDERS,
  summary,
  listingOrigin,
  reportVisible,
  recordKey,
  priceClass,
} from "./catalog.js";
import { LIFECYCLE_FIELDS, explicitDeadlines } from "./lifecycle.js";
import { piModel, thinkingProfile, thinkingFields } from "./models.js";

export const SOURCE_NAMES = Object.freeze({
  kilo: "Kilo provider list",
  zen: "Zen provider list",
  official: "Official OpenCode metadata",
  modelsdev: "models.dev OpenCode metadata",
  pi: "Pi OpenCode metadata",
  ovh: "OVH runtime model list",
  ovhmeta: "OVH anonymous entitlement and capability metadata",
});
// Public source strings are untrusted terminal input; raw originals remain in JSON export.
export const clean = (value) =>
  stripTerminalSequences(String(value ?? "")).replace(
    /[\x00-\x1f\x7f-\x9f]/g,
    " ",
  );
const stamp = (value) => (value ? clean(value) : "not recorded");
const sourceName = (source) => SOURCE_NAMES[source] || "Source not recorded";
const countFormat = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function visibleEntries(state, query = "") {
  const search = clean(query).toLowerCase().trim();
  return Object.values(state.entries || {})
    .filter(reportVisible)
    .filter((e) => !search || clean(e.id).toLowerCase().includes(search))
    .sort(
      (a, b) => a.service.localeCompare(b.service) || a.id.localeCompare(b.id),
    );
}
export function summaryReport(state) {
  const counts = summary(state),
    lines = [
      "CATALOG COUNTS",
      "Counts use each provider-list snapshot, not inference tests. Free operation counts are subtotals.",
    ];
  for (const service of Object.keys(PROVIDERS)) {
    const n = counts[service];
    lines.push(
      "",
      PROVIDERS[service],
      `  IDs in provider-list snapshot: ${n.listed}`,
      `  Listed free models, excluding recorded retirements: ${n.free}`,
      `    Chat: ${n.freeChat}`,
      `    Classifiers: ${n.classifier}`,
      `    Other operation types: ${n.otherFree}`,
      `  Listed models with insufficient price evidence: ${n.unknownPrice}`,
      `  Listed models with conflicting price evidence: ${n.conflictingPrice}`,
      "  Absent records shown in this report (separate groups):",
      `    Previously recorded as listed: ${n.previouslyListedNowAbsent}`,
      `    Metadata-only; no provider listing recorded: ${n.metadataOnlyNotListed}`,
      `    Earlier listing history unavailable: ${n.absentListingHistoryUnknown}`,
      `  Explicitly retired records with free history/evidence: ${n.retired}`,
    );
  }
  lines.push(
    "",
    "Retirement can overlap listing/history counts. Ordinary paid records with no free history are omitted from this report, but retained in /free-export.",
  );
  return lines.join("\n");
}
export function sourceReport(state) {
  const lines = [
    "SOURCE FETCHES",
    "Timestamps below identify successful document fetches, not successful model requests.",
  ];
  for (const key of Object.keys(SOURCES)) {
    const s = state.sources?.[key];
    lines.push(
      "",
      sourceName(key),
      `  Last successful fetch: ${stamp(s?.fetchedAt)}`,
    );
    if (!s) lines.push("  Latest attempt: no result recorded");
    else if (s.fresh) lines.push("  Latest attempt: succeeded");
    else
      lines.push(
        `  Latest attempt: failed or no successful response available; attempted at ${stamp(s.attemptedAt)}`,
        `  Error: ${clean(s.error || "No error detail recorded")}`,
        `  Saved document: ${s.data ? "available; retained for reconciliation" : "unavailable"}`,
      );
  }
  return lines.join("\n");
}
function declarations(raw) {
  if (!raw || typeof raw !== "object") return [];
  const out = [];
  if (typeof raw.status === "string" && raw.status)
    out.push(`status=${clean(raw.status)}`);
  if (typeof raw.lifecycle === "string" && raw.lifecycle)
    out.push(`lifecycle=${clean(raw.lifecycle)}`);
  if (raw.retired === true) out.push("retired=true");
  if (raw.deprecated === true) out.push("deprecated=true");
  for (const field of LIFECYCLE_FIELDS)
    if (typeof raw[field] === "string") out.push(`${field}=${clean(raw[field])}`);
  return out;
}
function priceReason(e) {
  if (e.service === "ovh") return e.classification === "free"
    ? "Documented anonymous entitlement accepted; commercial prices do not apply to this no-account lane"
    : "Anonymous entitlement is not established by the selected official metadata";
  if (e.service !== "kilo")
    return {
      free: "Free pricing evidence accepted",
      paid: "Positive monetary charge recorded",
      unknown: "Insufficient pricing evidence; free access is not established",
      conflict: "Conflicting zero-price and positive-charge evidence",
    }[e.classification];
  if (e.classification === "free")
    return "Kilo explicitly marks this model free; no positive charge overrides that flag";
  if (e.classification === "paid") return "Positive monetary charge recorded";
  if (e.classification === "conflict")
    return e.raw.isFree === true
      ? "Kilo free flag conflicts with a positive monetary charge"
      : "Zero pricing conflicts with the absence of an explicit true Kilo free flag";
  return "Insufficient pricing evidence and no accepted explicit Kilo free declaration";
}
export function modelReport(e, state, { health = {}, now = Date.now() } = {}) {
  const source = state.sources?.[e.service],
    model = piModel(e, state),
    profile = thinkingProfile(e, state);
  const origin = listingOrigin(e, state),
    provenance = e.metadataProvenance;
  const lines = [
    clean(e.id),
    `Provider: ${PROVIDERS[e.service]}`,
    `Operation: ${clean(e.type)}`,
  ];
  if (
    !(typeof (e.service === "kilo" ? e.raw.type : e.metadata.type) === "string")
  )
    lines.push(
      "  Operation type is derived by the existing catalog rules; no explicit type declaration was selected.",
    );
  lines.push(
    "",
    "Provider listing",
    `  ${e.listed ? "Present in" : "Absent from"} the last successfully fetched provider-list snapshot.`,
    `  Snapshot fetched: ${stamp(source?.fetchedAt)}`,
  );
  if (!source?.fresh)
    lines.push(
      "  Latest provider-list fetch did not succeed; this snapshot does not establish current availability.",
    );
  if (!e.listed)
    lines.push(
      "  Reason retained: " +
        (origin === "recorded-listed"
          ? "Previously recorded as listed; now absent from the provider-list snapshot."
          : origin === "metadata-only"
            ? "Found in metadata; no provider listing has been recorded."
            : "Saved record retained; earlier listing history is unavailable."),
    );
  if (e.lastListed)
    lines.push(`  Catalog listing-history timestamp: ${stamp(e.lastListed)}`);
  lines.push(
    "",
    "Pricing evidence",
    `  ${priceReason(e)}`,
    `  Selected evidence source: ${sourceName(e.evidence)}`,
  );
  if (e.metadataRetained || !provenance)
    lines.push(
      "  Decision/metadata retained from an earlier or saved record; not a newly accepted pricing verification.",
    );
  for (const evidence of e.evidenceSources || [])
    lines.push(
      `  ${sourceName(evidence.source)}: ${evidence.price === "zero" ? "zero prices" : evidence.price === "paid" ? "positive charge" : "insufficient price data"}; source fetch ${evidence.fresh ? "succeeded" : "did not succeed in this refresh"}`,
    );
  if (e.service === "kilo")
    lines.push(
      `  Explicit free flag: ${e.raw.isFree === true ? "true" : e.raw.isFree === false ? "false" : "not supplied"}; monetary fields: ${priceClass(e.cost, "prompt", "completion") === "zero" ? "zero" : priceClass(e.cost, "prompt", "completion") === "paid" ? "positive charge present" : "incomplete or non-decisive"}`,
    );
  lines.push(
    "",
    "Selected metadata record",
    `  Source: ${sourceName(provenance?.source || e.evidence)}`,
    `  Record fetched: ${stamp(provenance?.fetchedAt)}`,
  );
  if (!provenance)
    lines.push(
      "  Older cache has no per-record fetch provenance; the latest source timestamp is not substituted.",
    );
  const selectedSource = state.sources?.[provenance?.source || e.evidence];
  lines.push(
    `  Source document last fetched: ${stamp(selectedSource?.fetchedAt)}`,
    `  Latest source fetch: ${selectedSource?.fresh ? "succeeded; this alone does not prove the saved record was updated" : "did not succeed or has no recorded result"}`,
  );
  lines.push("", "Recorded lifecycle declarations");
  let found = false;
  for (const [label, raw] of [
    ["Provider record", e.raw],
    ["Selected metadata", e.metadata],
  ]) {
    const facts = declarations(raw);
    if (facts.length) {
      lines.push(`  ${label}: ${facts.join("; ")}`);
      found = true;
    }
  }
  for (const key of ["official", "modelsdev", "pi"]) {
    const sourceRecord = state.sources?.[key];
    const doc = sourceRecord?.data;
    const other =
      key === "pi"
        ? (Array.isArray(doc) ? doc : doc?.data || []).find(
            (m) => m.id === e.id,
          )
        : doc?.opencode?.models?.[e.id];
    const facts = declarations(other);
    if (e.service === "zen" && facts.length) {
      lines.push(
        `  ${sourceName(key)} record (document fetched ${stamp(sourceRecord.fetchedAt)}): ${facts.join("; ")}`,
      );
      found = true;
    }
  }
  if (e.lifecycle === "retired") {
    lines.push("  Catalog retains an explicit retirement decision.");
    found = true;
  }
  if (!found)
    lines.push(
      "  No lifecycle declaration found; this does not prove the model is active or online.",
    );
  for (const date of e.retirementDates || [])
    lines.push(
      `  Stored retirement deadline: ${clean(date)}${Date.parse(date) <= now ? " (reached; request guard blocks use)" : ""}`,
    );
  const eligible =
    e.classification === "free" &&
    e.listed &&
    e.lifecycle !== "retired" &&
    model !== null;
  const reasons = [];
  if (!e.listed) reasons.push("absent from the provider-list snapshot");
  if (e.classification !== "free")
    reasons.push(
      e.classification === "paid"
        ? "positive charge recorded"
        : e.classification === "conflict"
          ? "conflicting price evidence"
          : "insufficient price evidence",
    );
  if (e.lifecycle === "retired") reasons.push("explicit retirement recorded");
  if (model === null)
    reasons.push("Pi transport not implemented for this operation");
  lines.push(
    "",
    "Pi model registration",
    `  ${eligible ? "Included under the current catalog rules" : "Excluded: " + reasons.join("; ")}`,
  );
  const expired = [...(e.retirementDates || []), ...explicitDeadlines([e.raw,e.metadata])].some(d => Date.parse(d) <= now);
  if (eligible && expired)
    lines.push(
      "  Requests blocked: the stored retirement deadline has been reached.",
    );
  if (
    eligible &&
    ![
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "typesafe-system-one",
    ].includes(model.api)
  )
    lines.push(
      `  Requests blocked: transport ${clean(model.api)} is not implemented.`,
    );
  lines.push("  Registration and metadata do not prove successful inference.");
  const m = e.metadata,
    context = m.context_length ?? m.limit?.context ?? m.contextWindow;
  const output =
    m.top_provider?.max_completion_tokens ??
    m.max_completion_tokens ??
    m.limit?.output ??
    m.maxTokens;
  const valid = (n) => Number.isSafeInteger(n) && n > 0;
  lines.push("", "Token limits");
  lines.push(
    `  Context: ${valid(context) ? countFormat(context) + " tokens (recorded metadata)" : model ? countFormat(model.contextWindow) + " tokens (local safety fallback; provider limit unknown)" : "unknown; no local transport"}`,
  );
  lines.push(
    `  Maximum output: ${valid(output) ? countFormat(output) + " tokens (recorded metadata)" : e.type === "chat" && model ? countFormat(model.maxTokens) + " tokens (local safety fallback; provider limit unknown)" : "not recorded for this operation"}`,
  );
  lines.push(
    "  Context is the context-window budget, not an additional input allowance above output.",
  );
  lines.push("", "Advertised native thinking choices");
  const names = Object.keys(profile.choices);
  if (!names.length)
    lines.push(
      "  No selectable thinking values recorded; provider default will be used.",
    );
  else {
    for (const name of names) {
      const params = profile.choices[name].params;
      const controls = thinkingFields(params);
      lines.push(`  ${clean(name)}: ${clean(JSON.stringify(controls))}`);
    }
    lines.push(`  Controls source: ${sourceName(profile.provenance.source)}`);
    lines.push(
      `  Controls record fetched: ${stamp(profile.provenance.fetchedAt)}`,
    );
    lines.push(
      "  These are advertised choices, not the active selection. Use /free-thinking to inspect the active model.",
    );
  }
  if (e.service === "ovh") {
    lines.push("", "OVH anonymous access",
      `  Declared quota: ${clean(e.metadata.ovh?.anonymousRateLimit ?? "unknown")} requests/minute/IP/model; tool continuations count.`,
      `  Native tools declared: ${e.metadata.tool_call === true ? "yes (metadata, not a live-test verdict)" : "no; chat-only, not agent-verified"}`,
      `  Web catalog available flag: ${clean(e.metadata.ovh?.catalogAvailable)}; false alone is not API retirement.`,
      "  Commercial rate cards are retained in raw evidence; no account or payment is used.",
      "  Anonymous capacity has no verified SLA; pacing is local to this running extension.");
  }
  const observed = health[recordKey(e.service, e.id)];
  lines.push(
    "",
    "Observed HTTP response in this running session",
    observed
      ? `  HTTP ${clean(observed.http)} at ${stamp(observed.at)}; not a retirement or completed-inference verdict.`
      : "  None recorded for this model.",
  );
  return lines.join("\n");
}
export function report(state, options = {}) {
  const entries = visibleEntries(state, options.query);
  const lines = [
    "FREE MODEL CATALOG",
    "Pricing evidence, provider listing, and successful inference are different facts.",
    summaryReport(state),
    sourceReport(state),
    "MODEL RECORDS",
  ];
  if (options.query)
    lines.push(
      `ID search: ${clean(options.query)} (${entries.length} matching records)`,
    );
  if (!entries.length) lines.push("No matching model records.");
  let provider;
  for (const entry of entries) {
    if (entry.service !== provider) {
      provider = entry.service;
      lines.push(`=== ${PROVIDERS[provider]} ===`);
    }
    lines.push(modelReport(entry, state, options));
  }
  return lines.join("\n\n");
}

/** Refresh acknowledgement is brief; full model facts belong in the catalog viewer. */
export function refreshReport(state) {
  const counts = summary(state);
  const failed = Object.entries(state.sources || {}).filter(
    ([, s]) => !s.fresh,
  );
  const lines = [
    `Catalog refresh: ${Object.values(state.sources || {}).filter((s) => s.fresh).length}/${Object.keys(SOURCES).length} source documents fetched successfully.`,
  ];
  if (failed.length)
    lines.push(
      `Failed sources: ${failed.map(([name]) => sourceName(name)).join("; ")}. Saved documents are retained where available; current availability is not established by a saved snapshot.`,
    );
  for (const service of Object.keys(PROVIDERS)) {
    const n = counts[service];
    lines.push(
      `${PROVIDERS[service]} provider-list snapshot: ${n.listed} IDs; ${n.free} listed free models excluding recorded retirements (${n.freeChat} chat, ${n.classifier} classifiers, ${n.otherFree} other operations).`,
    );
    lines.push(
      `  Listed pricing decisions: ${n.unknownPrice} insufficient evidence; ${n.conflictingPrice} conflicting evidence.`,
    );
  }
  lines.push(
    `Changed records: ${(state.changes || []).length}.`,
    "Full counts, absent records, fetch times, and exclusion reasons: /free-catalog",
    "Complete raw evidence and change history: /free-export",
  );
  return lines.join("\n");
}
