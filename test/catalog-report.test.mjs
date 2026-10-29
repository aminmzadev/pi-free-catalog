import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcile,
  recordKey,
  summary,
  listingOrigin,
  validateState,
  Catalog,
} from "../src/catalog.js";
import {
  report,
  modelReport,
  summaryReport,
  sourceReport,
  visibleEntries,
  refreshReport,
} from "../src/catalog-report.js";
import { registrations, thinkingProfile } from "../src/models.js";
import { fixtures, sources, state } from "./helpers.mjs";
const id = "reflection/beam-free",
  key = recordKey("kilo", id),
  at = "2026-10-21T06:00:00.000Z";
const pick = (s, service, name) => s.entries[recordKey(service, name)];


test('a disappeared Kilo model retains its recorded deprecation and native metadata',()=>{const d=structuredClone(fixtures);d.kilo.data.find(m=>m.id===id).status='deprecated';const prior=reconcile(sources(d));d.kilo.data=d.kilo.data.filter(m=>m.id!==id);const next=reconcile(sources(d),prior),text=modelReport(next.entries[key],next);assert.match(text,/status=deprecated/);assert.match(text,/1,048,576 tokens/);assert.match(text,/131,072 tokens/);assert.match(text,/low:.*reasoning.*low/);assert.doesNotMatch(text,/model is active/);});

test("previously listed disappearance and reappearance preserve listing origin", () => {
  const original = state(),
    d = structuredClone(fixtures);
  d.kilo.data = d.kilo.data.filter((m) => m.id !== "thinkingmachines/inkling-small:free");
  const gone = reconcile(sources(d), original),
    e = pick(gone, "kilo", "thinkingmachines/inkling-small:free");
  assert.equal(listingOrigin(e, gone), "recorded-listed");
  assert.equal(summary(gone).kilo.previouslyListedNowAbsent, 1);
  assert.match(
    modelReport(e, gone),
    /Previously recorded as listed; now absent/,
  );
  const returned = reconcile(sources(), gone);
  assert.equal(pick(returned, "kilo", "thinkingmachines/inkling-small:free").listed, true);
  assert.equal(summary(returned).kilo.previouslyListedNowAbsent, 0);
});

test('old absent cache without listing evidence stays unknown',()=>{const old=state(),e=old.entries[key];e.listed=false;e.lifecycle='not-listed';delete e.listingOrigin;delete e.lastListed;delete e.metadataProvenance;delete e.metadataRetained;old.history=[];const d=structuredClone(fixtures);d.kilo.data=d.kilo.data.filter(m=>m.id!==id);const next=reconcile(sources(d),old);assert.equal(listingOrigin(next.entries[key],next),'unknown');assert.equal(summary(next).kilo.absentListingHistoryUnknown,1);assert.match(modelReport(next.entries[key],next),/earlier listing history is unavailable/);});
test("old cache history can establish a recorded listing without lastListed", () => {
  const s = state(),
    e = s.entries[key];
  delete e.listingOrigin;
  delete e.lastListed;
  s.history.push({
    service: "kilo",
    id,
    from: { listed: true },
    to: { listed: false },
  });
  assert.equal(listingOrigin(e, s), "recorded-listed");
});
test("old cache provenance timestamp remains unknown rather than using latest source time", () => {
  const s = state(),
    e = s.entries[key];
  delete e.metadataProvenance;
  const text = modelReport(e, s);
  assert.match(text, /Record fetched: not recorded/);
  assert.match(text, /Older cache has no per-record fetch provenance/);
});
test("failed source fetch shows saved snapshot date separately from attempted date", () => {
  const old = state(),
    src = sources();
  for (const source of Object.values(src)) {
    source.fresh = false;
    source.attemptedAt = at;
    source.error = "Timeout";
  }
  const s = reconcile(src, old),
    text = sourceReport(s);
  assert.match(text, /Last successful fetch: 2026-10-17T04:28:58Z/);
  assert.match(text, /attempted at 2026-10-21T06:00:00.000Z/);
  assert.match(
    modelReport(pick(s, "kilo", "reflection/beam-free"), s),
    /snapshot does not establish current availability/,
  );
  assert.equal(summary(s).kilo.free, 17);
});

test("fresh replacement metadata updates its own record provenance", () => {
  const old = state(),
    src = sources();
  for (const x of Object.values(src)) x.fetchedAt = at;
  const s = reconcile(src, old),
    e = pick(s, "kilo", "thinkingmachines/inkling-small:free");
  assert.equal(e.metadataProvenance.fetchedAt, at);
  assert.equal(e.metadataRetained, false);
  assert.equal(thinkingProfile(e, s).provenance.fresh, true);
});
test("unknown prices and conflicting prices have separate consistent counters", () => {
  const s = state();
  for (const service of ["kilo", "ovh"]) {
    const n = summary(s)[service];
    assert.equal(n.uncertain, n.unknownPrice + n.conflictingPrice);
    assert.equal(n.free, n.freeChat + n.classifier + n.otherFree);
  }
  assert.match(summaryReport(s), /insufficient price evidence/);
  assert.match(summaryReport(s), /conflicting price evidence/);
});

test("other free operation count explains free versus freeChat without hiding unsupported operations", () => {
  const d = structuredClone(fixtures);
  d.kilo.data.push({
    id: "image-test",
    isFree: true,
    architecture: { output_modalities: ["image"] },
  });
  const s = reconcile(sources(d)),
    n = summary(s).kilo;
  assert.equal(n.otherFree, 1);
  assert.equal(n.free, 18);
  assert.equal(n.freeChat, 17);
  assert.match(
    modelReport(pick(s, "kilo", "image-test"), s),
    /Pi transport not implemented/,
  );
});

test("absence and default active inference are never presented as explicit active or retirement", () => {
  const s = state(),
    e = structuredClone(s.entries[key]);
  delete e.metadata.status;
  delete e.raw.status;
  e.id = "no-lifecycle";
  const text = modelReport(e, s);
  assert.match(text, /No lifecycle declaration found/);
  assert.doesNotMatch(text, /retirement decision|status=active/);
});
test("unknown numeric limits are explicitly safety fallbacks in the report", () => {
  const s = state(),
    e = structuredClone(pick(s, "kilo", "reflection/beam-free"));
  delete e.metadata.context_length;
  delete e.metadata.top_provider;
  delete e.metadata.max_completion_tokens;
  const text = modelReport(e, s);
  assert.match(
    text,
    /8,192 tokens \(local safety fallback; provider limit unknown\)/,
  );
  assert.match(text, /2,048 tokens \(local safety fallback/);
});
test("recorded limits are not described as inference-tested or added input allowance", () => {
  const s = state(),
    text = modelReport(pick(s, "kilo", "thinkingmachines/inkling-small:free"), s);
  assert.match(text, /recorded metadata/);
  assert.match(text, /not an additional input allowance/);
});
test("missing selectable controls explains provider default without claiming reasoning impossible", () => {
  const s = state();
  assert.match(
    modelReport(pick(s, "kilo", "kilo-auto/free"), s),
    /No selectable thinking values recorded; provider default will be used/,
  );
});
test("HTTP errors are observed responses, not automatic retirement declarations", () => {
  const s = state(),
    e = pick(s, "kilo", "thinkingmachines/inkling-small:free"),
    health = { [recordKey("kilo", e.id)]: { http: 429, at } };
  assert.match(
    modelReport(e, s, { health }),
    /HTTP 429.*not a retirement or completed-inference verdict/,
  );
  assert.equal(e.lifecycle, "active");
});
test("elapsed stored deadline is shown even while old registration snapshot still includes model", () => {
  const s = state(),
    e = pick(s, "kilo", "thinkingmachines/inkling-small:free");
  e.retirementDates = ["2026-10-20T00:00:00Z"];
  assert.match(
    modelReport(e, s, { now: Date.parse(at) }),
    /Requests blocked: the stored retirement deadline/,
  );
});
test("viewer report retains the same visible IDs and cannot alter registration or request decisions", () => {
  const s = state(),
    before = structuredClone(s),
    models = registrations(s, "kilo"),
    c = new Catalog();
  c.state = s;
  const accepted = Object.values(s.entries).map((e) => {
    try {
      c.assertUsable(e.service, e.id);
      return true;
    } catch {
      return false;
    }
  });
  const text = report(s);
  for (const e of Object.values(s.entries).filter(
    (e) => e.classification !== "paid" || e.wasFree,
  ))
    assert.ok(text.includes(e.id));
  assert.deepEqual(s, before);
  assert.deepEqual(registrations(s, "kilo"), models);
  assert.deepEqual(
    Object.values(s.entries).map((e) => {
      try {
        c.assertUsable(e.service, e.id);
        return true;
      } catch {
        return false;
      }
    }),
    accepted,
  );
});
test("report excludes ordinary paid entries but preserves formerly-free paid entries and JSON evidence", () => {
  const s = state(),
    paid = Object.values(s.entries).find(
      (e) => e.classification === "paid" && !e.wasFree,
    );
  assert.ok(paid);
  assert.ok(!visibleEntries(s).includes(paid));
  assert.ok(Object.values(s.entries).includes(paid));
  paid.wasFree = true;
  assert.ok(visibleEntries(s).includes(paid));
  assert.ok(report(s).includes(paid.id));
});
test("case-insensitive model-ID search does not change the source data or summary totals", () => {
  const s = state(),
    before = summary(s);
  assert.ok(visibleEntries(s, "LAGUNA").length > 0);
  assert.equal(visibleEntries(s, "NO-SUCH-MODEL").length, 0);
  assert.deepEqual(summary(s), before);
});
test("untrusted model names and source errors cannot inject terminal control sequences", () => {
  const s = state(),
    e = structuredClone(s.entries[key]);
  e.id = "evil\x1b[2J\x07model";
  assert.doesNotMatch(modelReport(e, s), /\x1b|\x07/);
  s.sources.kilo.fresh = false;
  s.sources.kilo.error = "bad\x1b[31merror\x07";
  assert.doesNotMatch(sourceReport(s), /\x1b|\x07/);
});
test("optional per-record provenance survives schema-1 validation and bad additions are rejected", () => {
  const s = state();
  assert.equal(validateState(s).schemaVersion, 1);
  for (const value of [
    "invalid",
    { source: "not-a-source", fetchedAt: null },
    { source: "kilo", fetchedAt: "not-a-date" },
  ]) {
    const bad = structuredClone(s);
    bad.entries[key].metadataProvenance = value;
    assert.throws(() => validateState(bad), /Invalid cached model entry/);
  }
  const old = structuredClone(s);
  for (const e of Object.values(old.entries)) {
    delete e.metadataProvenance;
    delete e.metadataRetained;
    delete e.listingOrigin;
  }
  assert.equal(validateState(old).schemaVersion, 1);
});

test("refresh acknowledgement names fetch failures without dumping ambiguous JSON tags", () => {
  const s = state();
  s.sources.kilo.fresh = false;
  s.sources.kilo.error = "Timeout";
  const text = refreshReport(s);
  assert.match(text, /2\/3 source documents fetched successfully/);
  assert.match(text, /Failed sources: Kilo provider list/);
  assert.match(text, /17 chat, 0 classifiers, 0 other operations/);
  assert.match(text, /current availability is not established/);
  assert.match(text, /Full counts, absent records/);
  assert.doesNotMatch(text, /"historical"|"uncertain"|"listed"|"not-listed"/);
});
