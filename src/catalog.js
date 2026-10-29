import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { migrateCatalogState } from "./provider-removal.js";
import { lifecycle, explicitDeadlines, validDeadline } from "./lifecycle.js";
import { OVH_BASE, ovhRecord, ovhMetadata, validateOvhCatalog, createOvhPacer } from "./ovh.js";
export { lifecycle } from "./lifecycle.js";

export const SOURCES = Object.freeze({
  kilo: "https://api.kilo.ai/api/gateway/models",
  ovh: `${OVH_BASE}/models`,
  ovhmeta: "https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2",
});
export const PROVIDERS = Object.freeze({ kilo: "free-kilo", ovh: "free-ovh" });
export const recordKey = (service, id) => JSON.stringify([service, id]);
export const clone = (v) => structuredClone(v);
export const isRecord = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export const array = (v) => (Array.isArray(v) ? v : []);
export const modelRows = (doc) => array(Array.isArray(doc) ? doc : doc?.data);
export function number(v) {
  if (!["string", "number"].includes(typeof v)) return null;
  const text = String(v).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const mantissa = text.split(/e/i)[0],
    nonzero = /[1-9]/.test(mantissa);
  if (!nonzero) return 0;
  const n = Number(text),
    sign = text.startsWith("-") ? -1 : 1;
  // Never turn a tiny positive monetary amount into zero via IEEE underflow.
  return Number.isFinite(n) && n !== 0
    ? n
    : sign * (n === 0 ? Number.MIN_VALUE : Number.MAX_VALUE);
}
export function priceClass(cost, input = "input", output = "output") {
  if (!isRecord(cost)) return "unknown";
  const values = [];
  const visit = (object) => {
    for (const [key, value] of Object.entries(object)) {
      // models.dev tier is a selector descriptor, not a monetary charge.
      if (
        key === "tier" &&
        value &&
        typeof value === "object" &&
        typeof value.type === "string"
      )
        continue;
      if (Array.isArray(value)) {
        for (const item of value)
          if (item && typeof item === "object") visit(item);
          else values.push(null);
      } else if (value && typeof value === "object") visit(value);
      else values.push(number(value));
    }
  };
  visit(cost);
  if (values.some((v) => v !== null && v > 0)) return "paid";
  if (
    number(cost[input]) === null ||
    number(cost[output]) === null ||
    values.some((v) => v === null || v < 0)
  )
    return "unknown";
  return "zero";
}
function rows(doc) {
  const a = Array.isArray(doc) ? doc : doc?.data;
  if (!Array.isArray(a) || a.length === 0)
    throw new Error("Empty or invalid model list; preserve last known state");
  const seen = new Set();
  for (const m of a) {
    if (
      !isRecord(m) ||
      typeof m.id !== "string" ||
      !m.id.trim() ||
      seen.has(m.id)
    )
      throw new Error("Invalid/duplicate model ID");
    seen.add(m.id);
  }
  return a;
}
export function validateSource(name, data) {
  if (name === "ovhmeta") return validateOvhCatalog(data);
  if (["kilo", "ovh"].includes(name)) {
    rows(data);
    return data;
  }
  throw new Error("Unknown metadata source");
}
// Snapshot provenance belongs to the selected record, not merely the latest source fetch.
function metadataProvenance(source, sources, old, retained = false) {
  if (retained)
    return clone(
      old?.metadataProvenance || {
        source: old?.evidence || source || null,
        fetchedAt: null,
      },
    );
  return {
    source: source || null,
    fetchedAt: sources[source]?.fetchedAt || null,
  };
}
/** Old caches without proof remain unknown; absence alone proves no history. */
export function listingOrigin(entry, state) {
  if (
    entry.listed ||
    entry.lastListed ||
    entry.listingOrigin === "recorded-listed"
  )
    return "recorded-listed";
  if (
    (state?.history || []).some(
      (c) =>
        c.service === entry.service &&
        c.id === entry.id &&
        (c.from?.listed === true || c.to?.listed === true),
    )
  )
    return "recorded-listed";
  return entry.listingOrigin === "metadata-only" ? "metadata-only" : "unknown";
}
export const reportVisible = (e) =>
  e.classification !== "paid" || e.wasFree === true;
const deadlines = explicitDeadlines;
function life(records, now) {
  const states = records.map((raw) => lifecycle(raw, now));
  return states.includes("retired")
    ? "retired"
    : states.includes("deprecated")
      ? "deprecated"
      : "active";
}
/** No name/suffix/allowlist predicate exists in discovery. Every live ID is classified. */
export function reconcile(
  sources,
  previous = {},
  now = new Date().toISOString(),
) {
  const entries = {},
    changes = [],
    at = Date.parse(now);
  for (const service of Object.keys(PROVIDERS)) {
    const source = sources[service];
    const live = source?.data ? rows(source.data) : [];
    for (const raw of live) {
      const key = recordKey(service, raw.id),
        old = previous.entries?.[key];
      let meta, metaSource, classification, cost, fresh, provenance, retained;
      if (service === "kilo") {
        meta = raw;
        metaSource = "kilo";
        cost = raw.pricing;
        const price = priceClass(cost, "prompt", "completion");
        classification =
          raw.isFree === true
            ? price === "paid"
              ? "conflict"
              : "free"
            : price === "zero"
              ? "conflict"
              : price === "paid"
                ? "paid"
                : "unknown";
        fresh = source.fresh === true;
        provenance = metadataProvenance(metaSource, sources);
        retained = !fresh;
      } else if (service === "ovh") {
        const sourceMeta = sources.ovhmeta;
        const rich = ovhRecord(raw.id, sourceMeta?.data);
        meta = ovhMetadata(raw, rich);
        metaSource = rich ? "ovhmeta" : "ovh";
        const canRetain = !rich && sourceMeta?.fresh !== true && old?.classification === "free";
        if (canRetain) meta = clone(old.metadata);
        classification = (rich || canRetain) && meta.ovh?.anonymousRateLimit > 0 ? "free" : "unknown";
        if (canRetain) metaSource = old.evidence;
        cost = raw.pricing; // Commercial rate card is NOT anonymous-lane pricing.
        fresh = source.fresh === true && sourceMeta?.fresh === true && !!rich;
        retained = canRetain || (rich ? sourceMeta?.fresh !== true : source.fresh !== true);
        provenance = metadataProvenance(metaSource, sources, old, canRetain);
      }
      const records = [raw, meta];
      const output = array(
        service === "ovh"
          ? meta.architecture?.output_modalities
          : raw.architecture?.output_modalities,
      );
      const advertisedType = service !== "kilo" ? meta.type : raw.type;
      const type =
        typeof advertisedType === "string" && advertisedType
          ? advertisedType
            : output.includes("text")
              ? "chat"
              : output.includes("image")
                ? "image"
                : output.includes("audio")
                  ? "other"
                  : "chat";
      entries[key] = {
        service,
        id: raw.id,
        name:
          typeof meta.name === "string"
            ? meta.name
            : typeof raw.name === "string"
              ? raw.name
              : raw.id,
        type,
        classification,
        lifecycle: life(records, at),
        listed: true,
        listingOrigin: "recorded-listed",
        metadataProvenance: provenance,
        metadataRetained: retained,
        fresh,
        evidence: metaSource,
        evidenceSources: [],
        retirementDates: deadlines([raw, meta]),
        wasFree: classification === "free" || old?.wasFree === true,
        firstSeen: old?.firstSeen || now,
        lastListed: source.fresh ? now : old?.lastListed || now,
        updatedAt: now,
        raw: clone(raw),
        metadata: clone(meta),
        cost: clone(cost),
      };
    }
    // Preserve every historical record. Absence is NOT proof of retirement.
    for (const [key, old] of Object.entries(previous.entries || {})) {
      if (old.service !== service || entries[key]) continue;
      const meta = old.metadata;
      const records = [old.raw, meta];
      // No explicit active declaration: an omitted status cannot erase known retirement.
      const retired =
        life(records, at) === "retired" ||
        (old.lifecycle === "retired" &&
          !records.some(
            (r) => String(r?.status ?? r?.lifecycle).toLowerCase() === "active",
          ));
      entries[key] = {
        ...clone(old),
        listingOrigin: listingOrigin(old, previous),
        wasFree: old.wasFree,
        retirementDates: deadlines([old.raw, meta]),
        metadataRetained: true,
        metadataProvenance: metadataProvenance(old.evidence, sources, old, true),
        fresh: false,
        listed: source?.fresh ? false : old.listed,
        lifecycle: retired
          ? "retired"
          : source?.fresh
            ? "not-listed"
            : old.lifecycle,
        updatedAt: now,
      };
    }
  }
  for (const [key, e] of Object.entries(entries)) {
    const old = previous.entries?.[key];
    if (
      !old ||
      ["classification", "lifecycle", "listed"].some((f) => old[f] !== e[f])
    )
      changes.push({
        at: now,
        service: e.service,
        id: e.id,
        from: old
          ? {
              classification: old.classification,
              lifecycle: old.lifecycle,
              listed: old.listed,
            }
          : null,
        to: {
          classification: e.classification,
          lifecycle: e.lifecycle,
          listed: e.listed,
        },
      });
  }
  return {
    schemaVersion: 1,
    refreshedAt: now,
    sources,
    entries,
    changes,
    history: [...(previous.history || []), ...changes].slice(-2000),
  };
}
export function summary(state) {
  const result = {};
  for (const service of Object.keys(PROVIDERS)) {
    const a = Object.values(state.entries).filter((e) => e.service === service);
    result[service] = {
      listed: a.filter((e) => e.listed).length,
      free: a.filter(
        (e) =>
          e.listed && e.classification === "free" && e.lifecycle !== "retired",
      ).length,
      freeChat: a.filter(
        (e) =>
          e.listed &&
          e.classification === "free" &&
          e.lifecycle !== "retired" &&
          e.type === "chat",
      ).length,
      classifier: a.filter(
        (e) =>
          e.listed &&
          e.classification === "free" &&
          e.lifecycle !== "retired" &&
          e.type === "classifier",
      ).length,
      uncertain: a.filter(
        (e) => e.listed && ["conflict", "unknown"].includes(e.classification),
      ).length,
      // Legacy API aliases kept for existing consumers; never used as UI labels.
      historical: a.filter((e) => !e.listed && e.wasFree).length,
      unknownPrice: a.filter((e) => e.listed && e.classification === "unknown")
        .length,
      conflictingPrice: a.filter(
        (e) => e.listed && e.classification === "conflict",
      ).length,
      otherFree: a.filter(
        (e) =>
          e.listed &&
          e.classification === "free" &&
          e.lifecycle !== "retired" &&
          !["chat", "classifier"].includes(e.type),
      ).length,
      previouslyListedNowAbsent: a.filter(
        (e) =>
          reportVisible(e) &&
          !e.listed &&
          listingOrigin(e, state) === "recorded-listed",
      ).length,
      metadataOnlyNotListed: a.filter(
        (e) =>
          reportVisible(e) &&
          !e.listed &&
          listingOrigin(e, state) === "metadata-only",
      ).length,
      absentListingHistoryUnknown: a.filter(
        (e) =>
          reportVisible(e) &&
          !e.listed &&
          listingOrigin(e, state) === "unknown",
      ).length,
      retired: a.filter((e) => e.wasFree && e.lifecycle === "retired").length,
    };
  }
  return result;
}
export async function atomicJSON(file, data, { gzip = false } = {}) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  // Compact when gzipping: indentation is pure waste for machine-read state.
  const body = gzip
    ? gzipSync(JSON.stringify(data))
    : JSON.stringify(data, null, 2);
  try {
    await writeFile(temp, body, { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}
export const isGzip = (buf) =>
  buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
/** Validate persisted contracts before any data reaches reconciliation or model projection. */
export function validateState(state) {
  if (
    !isRecord(state) ||
    state.schemaVersion !== 1 ||
    !isRecord(state.entries) ||
    !isRecord(state.sources) ||
    (state.history !== undefined && !Array.isArray(state.history)) ||
    (state.changes !== undefined && !Array.isArray(state.changes))
  )
    throw new Error("Invalid catalog cache schema");
  for (const [name, source] of Object.entries(state.sources)) {
    if (
      !Object.hasOwn(SOURCES, name) ||
      !isRecord(source) ||
      typeof source.fresh !== "boolean"
    )
      throw new Error("Invalid cached source");
    if (source.data !== undefined) validateSource(name, source.data);
  }
  for (const [key, entry] of Object.entries(state.entries)) {
    if (
      !isRecord(entry) ||
      !Object.hasOwn(PROVIDERS, entry.service) ||
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      key !== recordKey(entry.service, entry.id) ||
      !isRecord(entry.raw) ||
      !isRecord(entry.metadata) ||
      !["free", "paid", "conflict", "unknown"].includes(entry.classification) ||
      !["active", "deprecated", "retired", "not-listed"].includes(
        entry.lifecycle,
      ) ||
      typeof entry.listed !== "boolean" ||
      (entry.listingOrigin !== undefined &&
        !["recorded-listed", "metadata-only", "unknown"].includes(
          entry.listingOrigin,
        )) ||
      (entry.metadataRetained !== undefined &&
        typeof entry.metadataRetained !== "boolean") ||
      (entry.metadataProvenance !== undefined &&
        (!isRecord(entry.metadataProvenance) ||
          (entry.metadataProvenance.source !== null &&
            !Object.hasOwn(SOURCES, entry.metadataProvenance.source)) ||
          (entry.metadataProvenance.fetchedAt !== null &&
            (typeof entry.metadataProvenance.fetchedAt !== "string" ||
              !Number.isFinite(
                Date.parse(entry.metadataProvenance.fetchedAt),
              ))))) ||
      (entry.retirementDates !== undefined &&
        (!Array.isArray(entry.retirementDates) ||
          entry.retirementDates.some(
            (d) => typeof d !== "string" || !Number.isFinite(Date.parse(d)),
          )))
    )
      throw new Error("Invalid cached model entry");
  }
  for (const event of [...(state.history || []), ...(state.changes || [])])
    if (!isRecord(event)) throw new Error("Invalid cached history");
  return {
    ...state,
    history: state.history || [],
    changes: state.changes || [],
  };
}
export class Catalog {
  constructor({
    file,
    fetch: fetcher = globalThis.fetch,
    timeout = 12000,
    now = () => Date.now(),
  } = {}) {
    this.file = file;
    this.fetcher = fetcher;
    this.timeout = timeout;
    this.now = now;
    this.ovhPacer = createOvhPacer({ now });
    this.state = { schemaVersion: 1, sources: {}, entries: {}, history: [] };
    this.lastAttempt = 0;
  }
  async load() {
    if (!this.file) return;
    try {
      // Accepts gzipped state (current) and plain JSON (pre-0.1.2 catalogs).
      const buf = await readFile(this.file);
      const text = isGzip(buf)
        ? gunzipSync(buf).toString("utf8")
        : buf.toString("utf8");
      const state = JSON.parse(text);
      this.state = validateState(migrateCatalogState(state));
    } catch (error) {
      if (error.code !== "ENOENT") this.cacheWarning = String(error);
    }
  }
  async refresh({ signal } = {}) {
    if (this.inflight) return this.inflight;
    this.inflight = this._refresh(signal).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
  async _refresh(signal) {
    const old = this.state,
      sources = {},
      previousAttempt = this.lastAttempt;
    this.lastAttempt = this.now();
    await Promise.all(
      Object.entries(SOURCES).map(async ([name, url]) => {
        try {
          const timeout = AbortSignal.timeout(this.timeout),
            combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
          const response = await this.fetcher(url, {
            signal: combined,
            headers: {
              accept: "application/json",
              "cache-control": "no-cache",
              "user-agent": "pi-free-catalog/0.1.8",
            },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          // Bound registry bodies (currently ~6 MB) and cancel oversized/aborted reads.
          let bytes = 0;
          const chunks = [];
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 16 * 1024 * 1024)
                throw new Error("Catalog exceeds 16 MiB");
              chunks.push(Buffer.from(value));
            }
          } catch (e) {
            await reader.cancel().catch(() => {});
            throw e;
          }
          const data = validateSource(
            name,
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
          sources[name] = {
            url,
            fresh: true,
            fetchedAt: new Date(this.now()).toISOString(),
            data,
          };
        } catch (error) {
          sources[name] = {
            ...clone(old.sources?.[name] || {}),
            url,
            fresh: false,
            error: String(error),
            attemptedAt: new Date(this.now()).toISOString(),
          };
        }
      }),
    );
    // A caller cancelling its background registry refresh is not a network failure.
    // Never let Pi's startup refresh cancellation invalidate a successful startup snapshot.
    if (signal?.aborted) {
      this.lastAttempt = previousAttempt;
      throw signal.reason || new Error("Catalog refresh cancelled");
    }
    this.state = reconcile(sources, old, new Date(this.now()).toISOString());
    if (this.file)
      try {
        await atomicJSON(this.file, this.state, { gzip: true });
      } catch (e) {
        this.cacheWarning = String(e);
      }
    return this.state;
  }
  /** Backward-compatible snapshot accessor. Refreshes are explicit, never age-triggered. */
  async ensureFresh() {
    return this.state;
  }
  assertUsable(service, id) {
    if (!Object.hasOwn(PROVIDERS, service)) throw new Error("Unknown free provider");
    const e = this.state.entries[recordKey(service, id)];
    if (
      !e ||
      e.classification !== "free" ||
      !e.listed ||
      e.lifecycle === "retired"
    )
      throw new Error(
        `Free catalog guard: ${service}/${id} is not a currently listed confirmed-free model; use /free-catalog`,
      );
    const dates = [...(e.retirementDates || []).filter(validDeadline), ...deadlines([e.raw, e.metadata])];
    if (dates.some((date) => Date.parse(date) <= this.now()))
      throw new Error(
        `Free catalog guard: ${service}/${id} has reached its announced retirement date; use /free-catalog`,
      );
    return e;
  }
}
