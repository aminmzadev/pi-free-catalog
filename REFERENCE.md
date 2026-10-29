# pi-free-catalog technical reference

Detailed behavior, evidence rules, compatibility boundaries and test harnesses for pi-free-catalog. For installation and everyday use, start at the [project page](https://github.com/aminmzadev/pi-free-catalog).

This reference describes evidence rules, request boundaries and local verification. The README covers everyday use.

## What appears in the catalog?

The goal is to keep the full picture visible, not just the models that happened to work in a test.

- Every live model ID is checked. The words `free` or `paid` in a model's name do not determine its classification.
- All currently listed, confirmed-free chat models are registered, including models with unknown limits, limited tool support, or previous inference errors.
- Models with uncertain or conflicting prices remain in `/free-catalog` and `/free-export`, with calls blocked until they can be verified.
- Previously free, missing, deprecated, and retired models remain in the report and history. They do not quietly disappear from the evidence.
- An unfamiliar operation or transport stays in the report with a clear unsupported notice. Being listed is not a promise that every future protocol is implemented.

### How free pricing is checked

For **Kilo**, the catalog's explicit `isFree: true` flag is the starting point. A positive charge conflicts with that flag and blocks the model. Zero prices alongside `isFree: false` are also treated as a conflict. Missing or dynamic prices are retained as evidence when the explicit free flag is present.


For **OVHcloud**, official anonymous rate-limit metadata establishes the no-account lane; commercial input/output prices are not assumed to be zero. The runtime list is joined to the rich catalog by exact ID, exact name, or an explicitly declared alias. Ambiguous matches and new models without anonymous entitlement remain unknown, not free. The full commercial rate card and rich record are retained in exports; Pi's effective cost is zero only for the anonymous lane.

The extension cannot verify information that an upstream service does not publish. It keeps that uncertainty visible instead of guessing.

## OVH anonymous access and limits

OVH documents an anonymous quota of **2 requests/minute/IP/model**, including each tool continuation. No signup, personal key, billing activation, or payment is used here. Commercial API prices and authenticated quotas describe a different lane. See [OVH AI Endpoints getting started](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started) and [billing/lifecycle documentation](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-billing).

- Outside the enabled pool, the legacy transport spaces same-model starts by at least 31 seconds. The pool uses independent quota accounting instead. The TUI shows a cancellable wait status; cancelling a turn cancels its queued wait and clears that status.
- A 429 extends the next same-model gate using `Retry-After` seconds or HTTP date. A missing/invalid value uses a conservative local delay. For standalone/legacy OVH, the original upstream response is returned without replay; the extension does not automatically retry, rotate IPs, or activate paid access. Model changes require the explicitly enabled pool described below; an optional silent-start timeout is its narrowly scoped same-inference exception. SDK retries are disabled for OVH. Pi's independent agent retry preferences still belong to the user; disable them when you want the run to stop at the first upstream error.
- Pacing is **per running extension**, not coordinated across processes or other clients sharing your public IP. The upstream quota is authoritative; local accounting cannot guarantee capacity.
- All eligible text-generation models remain registered, including a model without advertised tools. Its picker name says `chat-only; tools not advertised`. This is a capability limitation, not a fabricated live-test result. Reasoning without advertised effort values keeps the provider default; no thinking selector is invented.
- Embedding, safety/moderation, speech, and image-generation entries remain visible in reports/exports, but are not routed through the chat endpoint. Image **inputs** for a text-generation model are a separate advertised capability.
- The rich catalog's `available: false` website flag alone does not prove API retirement; an explicit EOL date still applies. Catalog/metadata failure retains previously justified anonymous models, while a fresh withdrawal of anonymous entitlement blocks them.

### Optional OVH priority pool (default OFF)

`/free-ovh-pool` opens the single draft editor, `status` is read-only and
`--help` explains current usage.
The editor combines ordered selections, per-model native thinking, explicit
ON/OFF, readiness wait (0–60 seconds), response-start limit (0–300 seconds), and optional active primary selection.
Final review precedes one atomic settings write. Cancel saves no partial order.
Reset still requires Apply and never clears live quota/cooldown state. Model
selection uses Pi's public API after saving and is reported separately if it fails.

Before every inference, the highest-priority eligible, compatible and ready
selection wins. The source's confirmed model-minute cooldown, validated successful
quota exhaustion, successful conservative local allowance exhaustion, or source
conversation incompatibility permits checking later selections. Failed auth,
network, invalid request, unknown 429 and provider-wide limits are not quota
rotation evidence. Independent restoration of a ready higher priority remains
possible. No unselected model is added. Newly enabling requires two eligible
selections, but a later unavailable selection is retained and does not disable
an otherwise usable primary.

Managed requests have exactly one pacing authority. Successful anonymous responses
must be associated with the guarded exact OVH chat endpoint/model and an explicit
2 req/m catalog entitlement. Both limit headers must equal 2, both remaining
headers must agree at 0 or 1, and relative reset must be an integer 1–60 seconds.
Other windows, contradictory scope/model fields and malformed counters fail
closed. Relative reset is based on receipt plus one second, not an inferred epoch
or a potentially skewed client/server wall-clock subtraction. Rising counters
cannot mint slots in the same known window. A fresh window can roll forward near
the prior reset. Missing headers fall back to two actual attempts per 61-second
local rolling window; positive successful accounting is needed to rotate.
Ambiguous failed sends are not refunded. Pool serialization prevents competing
managed requests taking the same slot. Observations continue while OFF, and
configuration changes do not erase them. Legacy transport guards/pacing remain
for unmanaged requests. Pool-managed requests do not also wait in the legacy
31-second gate; its server Retry-After observations remain respected.

The strict 429 classifier retains its structured model-minute and captured OVH
correlation-ID contracts. The observed response body must match the captured
`API rate limit exceeded` JSON, inference correlation ID, exact anonymous endpoint
and agreeing exhausted minute headers. A valid positive Retry-After and consistent
reset are required; conflicting scope, unknown formats or provider-wide evidence
fail closed. Confirmed readiness follows the evidence's Retry-After rather than a
fixed 31-second minimum. Provider-wide barriers apply before every candidate.
For standalone/legacy OVH, the original response is returned without automatic replay; SDK retries are zero. The general pool's explicitly authorized pre-activity 429 policy is described below.

Compatibility validates actual conservative transcript/tools/system and output
fit, not relative advertised context sizes. A smaller destination is accepted if
the request fits; otherwise continue through later selected models. Explicit
caller output budgets are preserved; implicit output is capped for the destination.
No conversation is truncated or silently compacted. Native thinking is validated
for each target's own saved pool mode and does not need to match the source's
mode, parameters or reasoning capability. New selections default to provider
default; auto can fail at an unadvertised Pi level. Outside-pool preferences are
not rewritten by handoffs. Running/unresolved tools, pending/deferred state,
ambiguous IDs, missing tool support and unverified multimodal budgeting still
prevent unsafe transfer. Foreign reasoning/signatures may be discarded by Pi;
visible messages and completed results remain intact. Final payload and current
eligibility/configuration are rechecked before HTTP.

One cancellable preflight budget covers pool locking and readiness before the
actual dispatch. At HTTP dispatch its timer is disarmed. Caller/shutdown cancellation
remains effective; later provider exceptions and SDK error events retain their
original identity instead of becoming scheduling timeouts. Status separates
metadata eligibility, last evaluated conversation compatibility, quota knowledge
and concrete blocking reasons; it makes no unevaluated compatibility claim.
Menus/status/help never fetch metadata or inference. Quotas are not coordinated
across independent clients/processes on the same public IP; capacity is not
reserved or guaranteed. No identities, accounts or IPs are rotated.

The October 22 fixture has 22 runtime records, ten chat models, and nine chat models advertising tools. These are snapshot facts, **not nine live-verified agents** or permanent counts. Verification of one model does not certify the rest, long-context limits, every thinking level, mobile networks, or an anonymous SLA.

## Refreshes and model history

At extension startup and explicit `/free-refresh`, the extension first tries the public [catalog snapshot](https://aminmzadev.github.io/pi-free-catalog/catalog/v2/latest.json) on GitHub Pages. A healthy snapshot needs one metadata GET instead of three upstream GETs. The shipped client validates the version, repository, exact production rules fingerprint, timestamps, integrity, inventories, and structural limits before adopting it. Downloaded content is JSON data, never executable code. The hash detects corruption and incompatibility; it is not an independent signature. HTTPS and the repository publishing pipeline remain the trust boundary.

A usable local cache is registered immediately, without waiting for the network. One bounded startup refresh then runs; it is cancelled on shutdown, not repeated on a timer. Without a cache, startup waits for its bounded initial refresh. Pages requests use a new cache-busting key, disable caching, and reject redirects. If Pages is unavailable, invalid, incompatible, older than local source evidence, or contains source data older than 45 minutes, the client falls back to the existing three direct-source checks. After startup, only `/free-refresh` starts another refresh. Concurrent refresh requests share one in-flight operation. Sending messages, changing thinking, waiting past five minutes, and Pi's internal model-registry refresh do not trigger catalog network requests. Reloading the extension starts a new startup check.

A failed refresh does not erase or disable the last known free catalog. The 45-minute threshold is a reason to try direct recovery, not an expiry that disables cached inference. On a cold install with no local records, a fully validated older Pages snapshot can remain the last-known-good if all direct checks fail; it is labelled with its original source timestamps. Valid Pages data is reconciled with local history and earlier `firstSeen` dates, not blindly unioned with old free-model lists. New paid, withdrawn, or retired evidence still applies. Cached free models stay selectable and requests are sent to their normal anonymous endpoints. A catalog outage is not an inference outage: if the endpoint is reachable, chat and tools can still work. If the model is missing or unavailable upstream, its actual response is returned without a freshness-guard error. A first run without either a usable cache or a successful fetch cannot invent a model list.

Changes are handled according to what the sources actually say:

| Change | What happens |
|---|---|
| Explicit retirement | The model is removed from callable models and kept in history. |
| Missing from a successful catalog response | It is marked `not-listed`, not assumed retired. It can return if listed again. |
| Deprecated, but still listed and free | It remains available with a deprecation label. |
| Free model becomes paid | Free access is blocked; the model remains in the report. |
| Timeout, 404, 429, or capacity error | The error is recorded, not treated as proof of retirement. |

The cache is stored in `free-catalog/catalog.json` inside Pi's agent directory, normally `~/.pi/agent/free-catalog/`. Despite the filename, the cache is compact, gzip-compressed JSON. Older plain-JSON caches still load. It retains raw source responses, timestamps, classifications, and lifecycle history; the recent change log is limited to 2,000 events, but the model inventory is not.

`/free-export` writes readable, uncompressed JSON for inspection. Pages has a 6-second timeout and 32 MiB response limit. Direct checks run concurrently with a 12-second timeout and a 16 MiB response limit per source. Compressed and expanded local caches are limited to 64 MiB. Successful updates are atomically persisted; a save failure warns while keeping validated in-memory data and the previous disk cache. A successful fetch reflects the upstream data at that moment, not a guarantee that every source agrees instantly.

## Commands

| Command | What it does |
|---|---|
| `/free-catalog` | Open a scrollable, searchable catalog separating provider listing, pricing evidence, metadata timestamps, lifecycle declarations, and registration reasons. |
| `/free-refresh` | Try Pages, recover through direct sources if needed, and reconcile the model lists. |
| `/free-pool` | Review the general pool across providers, thinking, weighted visits and cycle allowance. |
| `/free-pool status` / `preview` | Inspect availability/state or configured visits; no inference. |
| `/free-ovh-pool` | Inspect or explicitly configure the optional OVH pool; default OFF. |
| `/free-thinking` | Show the current model's native thinking options and selection. |
| `/free-thinking MODE` | Choose `auto`, `default`, or an advertised native mode. |
| `/free-footer` | Open independent chat-count and footer-appearance display settings. |
| `/free-footer counts on` / `counts off` | Immediately show/hide free chat counts, saved independently; default ON. |
| `/free-footer compact` | Opt into the custom footer on the current free model. |
| `/free-footer default` | Release our footer if we still own it; leave other extensions alone. |
| `/free-export [PATH]` | Export the complete catalog, including source data and all live IDs, even paid ones. |

Use `--help` with any of these commands for detailed usage without fetching catalogs, writing files, or changing preferences. The menu uses short summaries; Pi itself adds source labels and controls narrow-screen layout. This package does not patch Pi's editor or source badges. Footer modes and current native thinking modes have argument completion.

### Reading the catalog

`/free-catalog` uses labelled model blocks instead of pipe-separated rows. In interactive Pi, use arrows or PageUp/PageDown to scroll, Home/End to jump, type to search by exact or partial model ID, Ctrl+U to clear the search, and Escape to close. Searching is case-insensitive. Nothing is hidden by a default search. Print/RPC output uses the same plain-text facts. Opening or searching the viewer never fetches sources or changes preferences.

Provider lists answer **which IDs are listed**. Pricing/capability registries answer **what information is recorded for an ID**. A zero-price metadata record can exist outside the provider list. That record remains visible but is not registered or callable. A successful metadata fetch is not an inference test.

Each record separates provider-list presence and snapshot timestamp, accepted pricing evidence and disagreements, selected metadata record timestamp, lifecycle declarations, registration/exclusion reasons, token limits, advertised native thinking controls, and HTTP responses observed in the running session. Older caches without per-record timestamps say that the timestamp is not recorded; they do not inherit a newer document timestamp. Local numeric safety fallbacks are labelled explicitly.

Summary counts are not independent buckets:

- **Listed free models** excludes recorded retirements and includes all operation types. Chat, classifier, and other operation counts are subtotals of it.
- **Insufficient price evidence** and **conflicting price evidence** are separate counts among listed records. Both are blocked by the free-only guard.
- **Previously recorded as listed, now absent**, **metadata-only with no recorded provider listing**, and **earlier listing history unavailable** are distinct groups of absent records shown in the report. None proves that the provider once successfully served the model.
- **Explicitly retired with free history/evidence** may overlap other listing/history counts. Absence, deprecation, HTTP errors, and quota failures are not automatically retirement.

Ordinary paid records with no free history are excluded from this report, exactly as before; complete JSON export retains them. The machine-facing `summary()` helper retains `uncertain` and `historical` as legacy compatibility aliases, but commands no longer display those ambiguous labels. New explicit counters are used instead. The `classifier` count now excludes recorded retirements consistently with the free total.

## Thinking that matches the model

Use Pi's normal thinking selector or shortcut as usual. In `auto` mode, the extension translates the selected level into a setting the provider actually advertises. It does not invent effort levels for models that only have an on/off switch.

You can also choose a native mode directly. For example, after selecting an appropriate model:

```text
/free-thinking low
/free-thinking instant
/free-thinking thinking
/free-thinking auto
/free-thinking default
```

These are examples for different models, not options supported by every model. Kilo Beam advertises effort levels such as `low`, `medium`, `high`, `xhigh`, and `max`. Toggle models use modes such as `instant` and `thinking`. OVH effort settings are sent as `reasoning_effort`; Kilo settings use the provider's native parameters. The available choices come from live metadata, so check `/free-thinking` rather than relying on a fixed list.

### Pi and native choices stay in sync

When a native mode has an exact Pi equivalent, `/free-thinking` updates Pi's actual level too. For example, an effort model's `low` maps to Pi `low`. Explicit advertised effort takes precedence over the native mode name. For example, a native `thinking` variant carrying `effort: high` maps to Pi `high`, not `medium`; the same rule applies to any model or native mode name. Explicit disable maps to Pi `off`. A bare enabled toggle or a token budget without an advertised effort has no exact Pi effort equivalent and is not assigned a fictional `medium` or `high`.

Changing the level in Pi then releases the previous native override for that model and returns it to `auto`. The current level is also checked before a turn and at payload construction, so another extension delaying an event cannot leave an old override on the wire. This prevents an old native setting from silently overriding what the Pi footer shows. Pi's omitted `reasoning` option for `off` is handled explicitly, so an advertised disabled mode is sent when available.

There are a few limits worth knowing:

- `default` leaves thinking to the provider; it is not another spelling of `off`.
- A native mode without an exact Pi equivalent remains selectable through `/free-thinking`. The status bar labels that override rather than pretending Pi's fixed level names cover it.
- Choosing the same Pi level again does not emit a change event in Pi. Use `/free-thinking auto`, or change the level, to release an override.
- Saved native preferences return when you start a session or switch back to a model. They can take precedence over Pi's initial level. Choose `auto` if you want Pi to control it instead.
- If a provider advertises no adjustable controls, its default is preserved. Unsupported effort or disable settings are never guessed.

`/free-thinking` without an argument separates the control mode (`auto` = Follow Pi, `default`, or explicit native override), Pi's current level, the effective native choice (or `provider-default`), and exact request parameters. The older `selected` JSON field remains an alias for compatibility. If refresh removes the current auto-follow level, the extension immediately asks Pi's public setter to clamp against the newly registered model before the next inference. Explicit removed native overrides are deliberately not remapped: choose `/free-thinking auto` or a valid advertised mode to recover. If a saved native mode becomes unavailable, inspection still shows its error and the recovery commands; no substitute native mode is silently invented. Historical and metadata-only records use the same evidence/provenance policy as listed models. Retained metadata keeps its original timestamp; a legacy cache without that proof stays unknown rather than receiving a fictional fetch time. Thinking evidence includes its source, the selected record's fetch timestamp when known, and the source document's latest fetch timestamp separately. Pi owns its standardized level names and generic selector descriptions; approximate token-budget descriptions in that selector are not provider-specific guarantees. If a preference cannot be saved, the running-session change is explicitly labelled unsaved.

Preferences are saved per provider and model in `thinking.json` beside the cache.

## A quieter footer

The normal Pi footer is the default. A persistent `Free chat: Kilo … · OVH …` status counts listed, confirmed-free, non-retired chat models in the current catalog—not just pool members or models eligible for the current prompt. Classifiers, embeddings and other non-chat types are excluded. Replies, errors, aborts, model/provider changes and temporary pool cleanup do not clear this count. No persistent pool path or duplicate model/thinking label is added; only a short transient OVH waiting indicator accompanies it. Full inventories and evidence remain available in commands and exports.

Run `/free-footer` to open display settings, or `/free-footer counts on` / `counts off` directly. Choices take effect immediately; Escape closes the menu without further changes, not undoing choices already made. In non-interactive modes, the no-argument command reports the current settings. Counts are ON by default and independent of compact/default appearance, pool enablement, selected model, thinking and quota. Display commands perform no metadata refresh or inference.

Preferences are saved as `{"footer":"default","chatCounts":true}` in `free-catalog/ui.json` inside the agent directory. Legacy files with only `footer` keep that mode and default counts to ON. Each field is validated separately; invalid JSON uses defaults. Rapid changes are saved as serialized immutable atomic snapshots, so the newest combined choice wins. A write failure is reported and does not roll back the session display; restart uses the last successful save. Later successful changes can persist the current choices.

Counts shorten with terminal width and update on interactive resize without fetching sources. Only their own status key is cleared when hidden or shut down, and resize listeners are removed. Pi still clips the combined status line; another extension's complete custom footer may choose not to render extension statuses. Count controls never claim, clear or replace that footer.

Pi has one custom-footer slot and no public composition/ownership getter. Two extensions cannot safely combine arbitrary complete footers automatically. If you want this package to hide only the `(free-kilo)` or `(free-ovh)` prefix, select a free model and explicitly run `/free-footer compact`. This reuses Pi's exported renderer and preserves the other statistics and statuses. Provider IDs and model-picker entries never change.

The preference is saved in `ui.json`. An existing explicitly saved compact preference is respected at startup. If another extension subsequently replaces our footer, its disposal notification relinquishes our ownership. Model switches will not reclaim or erase that extension's footer. `/free-footer default` releases our footer only while we still own it; it cannot resurrect a custom footer that an explicit compact command previously replaced. Run compact again only when you intend to claim the slot.

Leaving a free model releases an owned compact footer; returning to a free model does not automatically claim the slot again. Print, JSON and RPC modes are unaffected. The implementation and ownership tests use Pi's public APIs and exported renderer, verified on Pi 1.4.0.

## Requests, tools, and safety

Requests use Pi's own OpenAI Completions, Responses, Anthropic Messages, and native classifier implementations. Pi's SDK handles streaming, tool calls and results, Unicode, cancellation, usage, and finish reasons. The extension does not replace the global HTTP client or add its own SSE parser.

Known explicit retirement deadlines are also checked locally before requests, without fetching catalogs again. `retirement_date`, `retired_at`, and Kilo's native `expiration_date` share one calendar-valid ISO parser. Date-only deadlines start at midnight UTC. Corrected or removed dates are reconciled on refresh; stale evidence cannot bypass a known deadline. OVH's explicit DD/MM/YYYY EOL field is normalized into the same lifecycle policy.

Before each HTTP request, a scoped guard checks the model ID, approved endpoint, last-known free classification and lifecycle. It does not require a recent catalog fetch. It blocks redirects and paid fallback, and removes Authorization, x-api-key, and api-key headers before installing public/anonymous headers. Kilo requests carry no Authorization header. OVH uses a separate allowlisted header set: no caller credentials, Authorization, API keys, cookies, or payment headers. The User-Agent identifies this integration; no provider identities are rotated.

Anonymous access can break if a service changes its policy or protocol requirements. This package does not promise permanent access, unlimited quota, universal tool support, or a particular response speed. An inference error does not blacklist a model or turn off tools to make a test pass.

Full capability metadata is retained in exports. This chat integration supports text and image inputs; other advertised modalities are not presented as implemented. When required limits are unknown, the model is labelled accordingly and uses local safety defaults of 8,192 context tokens and 2,048 output tokens. Those are not claimed provider limits.

## Development and testing

Development verification requires Python 3 as well as the runtime requirements above; Python is used only for testing the bundled Python harnesses, not by the extension.

From the release source ZIP or a complete source checkout:

```bash
npm ci
npm run verify
```

Verification checks syntax, runs the offline tests, and inspects the npm package contents. The tests cover catalog classification, lifecycle changes, anonymous free-only guards, compressed caches, failed-refresh continuity, zero per-message catalog fetches, delayed thinking events, the actual Pi session and SDK, root-entry display labels, and Pi's footer renderer and ownership handoff. Network responses in the offline tests are mocked. Passing them is not a claim that every upstream model works.

### Reproducible footer adversarial tests

`npm test` includes directed preference/width/lifecycle tests, real Pi sessions with fixture HTTP, and an adversarial UI/state simulator using the actual Pi footer slot and renderer. Its default run uses 32 fixed seeds × 400 random operations (12,800), plus exact-replay and failure-recorder checks. Operations combine catalog changes, count toggles, pool waits and completion/error/abort cleanup, model/provider changes, narrow widths, corrupt preferences, failed/delayed/rapid saves, restarts, headless transitions and foreign extensions. An independent state oracle checks counts, visibility, ownership, listener/timer cleanup and unchanged side-effect sentinels; real-session tests separately check production command wiring during a pending response. These checks are not exhaustive and do not predict every failure.

```bash
npm run test:footer-monkey
FOOTER_MONKEY_SEED=42 FOOTER_MONKEY_STEPS=2000 npm run test:footer-monkey
```

Seeds are uint32 values; steps can be 1–10,000. Failures save the seed, complete operation prefix and state to `test-results/footer-monkey-SEED-failure.json`, with a replay command in the error. `FOOTER_MONKEY_FAILURE_DIR` changes that directory. If writing the report fails, the trace is included in the error instead. Each passing seed reports its trace digest and event coverage. The simulator uses local data and controlled timers; no live inference or quota is consumed. It is not Android certification.

For an optional live catalog check without inference:

```bash
node scripts/catalog.mjs ./catalog-inspection.json
```

For a bounded OVH-specific live tool check, use a fresh HOME and agent directory:

```bash
HOME=/path/to/clean-home PI_CODING_AGENT_DIR=/path/to/clean-agent \
  node scripts/verify-ovh-live.mjs /path/to/evidence
```

This uses the actual production extension through Pi's loader, a six-request hard cap, a 210-second deadline, and a test-only 4,096-token output cap. It checks ordered successful read/write/edit/bash calls, actual nonce-bearing file contents, an independent Python SHA256 verifier, unchanged fixtures, declared response model IDs, exact thinking parameters, no credentials, and zero catalog fetches during inference. Add `--installed` after a clean `pi install` to load only the installed declaration, rather than adding the local entrypoint. All network traffic is real; the audit wrapper only records and restricts it. Live artifacts are kept outside the release.

For separate Kilo live inference checks, use `scripts/verify-ui-thinking-live.mjs` in an isolated HOME with `PI_CODING_AGENT_DIR` set to a fresh directory. It runs Pi's actual agent session with the default read, write, edit, and bash tools, checks thinking parameters, and verifies real file changes. It normally makes about 14 inference requests across two Kilo models, with SDK/agent retries disabled and a 24-request budget. `--toggle-only` runs the separate toggle checks. Model errors stop the run; inspect the result JSON and wire log rather than relying on a confident final answer.

The broader opt-in CLI harnesses, `scripts/live_pi.py` and `scripts/observe_live.py`, are also included. They require Python 3 and the `PI_NODE`, `PI_CLI`, `PI_TEST_DISPATCHER`, and `FREE_TEST_DIR` environment variables. Their test-only wire recorder is never loaded by the extension. The Python census accepts gzip and legacy plain-JSON caches. An isolated HOME is not an operating-system sandbox for bash. Wire evidence may contain prompts and tool content; keep it private.

Concurrent Pi processes use independent in-memory snapshots. Atomic writes prevent torn files, but this release does not promise cross-process merging of preferences or cache snapshots; use separate agent directories when independent simultaneous writers are required.

Do not commit or publish credentials, `.npmrc`, caches, or live test outputs. Review the source and the upstream services' terms before use; the code's MIT license does not grant service access.

## Catalog sources

- https://api.kilo.ai/api/gateway/models
- https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models
- https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2


## Response-start timeout and context-free pool activity

The persisted `responseStartTimeoutMs` is an integer from 0 to 300000. Missing
values are read as zero without changing existing model order, thinking,
enabled state or readiness budget. Zero disables this feature. The editor
accepts seconds with up to three decimal places and saves it in the same
reviewed atomic draft as the other settings. Cancel performs no write; Reset
proposes a disabled timer but does not erase quota or cooldowns.

The readiness deadline starts at pool coordination and is disarmed at the first
actual HTTP send. The response-start deadline begins at that send, not during
lock acquisition, model switching, payload construction or tool execution. A
per-attempt monotonic deadline and abort controller are independent from caller,
shutdown and session/model-change cancellation. A known non-success HTTP
response or observed network failure disarms the response-start timer so a slow
error-body reader cannot turn authentication, 429 or other failures into rotation.
The specific locally owned deadline is the sole timeout rotation trigger; SDK,
caller and provider errors are not equivalent triggers.

Empty structural SDK events are buffered until first meaningful output or a
terminal provider event, with a 32-event cap. Non-whitespace text/thinking output
or tool-call activity commits that attempt and disarms the timer permanently.
There is no mid-stream idle/total-generation timeout. A silent expired attempt
is canceled and invalidated before selection continues to later configured
models, skipping unavailable, non-fitting and cooling candidates without probing
them. Each selected model can send at most once in that logical inference;
exhaustion is explicit, with skip reasons. A subsequent inference reconsiders
normal primary priority. Late events and headers from an invalidated attempt
cannot enter the winning outer assistant stream. Fetch/iterator waits are
abort-aware even with a signal-ignoring fixture adapter. The coordinator does
not wait indefinitely for a canceled provider's final result or iterator return.

Completed tool results remain in the original transcript; this does not restart
the agent turn or re-execute completed tools. SDK usage for the winning response
may not include work performed by a timed-out attempt. Zero usage in a local
error object means no usage was reported, not a quota refund. Every actual send
continues to reserve quota, and valid received quota observations remain intact.
Client cancellation cannot guarantee server-side cancellation.

Diagnostics use `appendEntry` and `registerEntryRenderer`, never `sendMessage`.
Only version, timestamp, duration, outcome and allowlisted step metadata (model
ID, diagnostic state, actual-send flag, elapsed time) are stored. No prompts,
thinking text, tool results, arbitrary exception strings or raw provider errors
are copied into these entries. Each entry has at most 24 steps, with omission
counts; identifiers are terminal-sanitized and capped at 256 UTF-16 code units.
The status viewer reads at most 20 matching entries from the current branch and
wraps/paginates using terminal cell widths. Session history itself remains Pi's
append-only history; this feature does not rewrite/delete old session entries.
Entries survive resume but do not participate in model context.

Only namespace-owned transient status keys are cleared by pool cleanup; the
independent catalog count remains unless hidden or shut down. No persistent
model-path or duplicate native-thinking labels are added. Transient indicators follow
terminal resize and native footer aggregate-width truncation. They clear on
success, abort, error, disable, external model/provider selection, session
switch/fork/tree/compaction lifecycle events and shutdown. A saved compact footer
is claimed on first startup or explicit user selection, not reclaimed from
another extension on subsequent session/model transitions. Shutdown releases it
only if ownership has not already been relinquished.


## General Free Pool

The OVH chapters above describe preserved legacy behavior. `/free-pool` adds a single mixed-provider scheduler on that foundation; `/free-ovh-pool` keeps the old editor until a general configuration is saved, then forwards to the new settings. No automatic additions or automatic activation occur. A first general review can import the old selection, thinking, waits and enablement exactly; existing runtime quota remains conservative. The legacy file remains untouched.

The general schema is version 2 in `free-catalog/free-pool.json`, with `config`, durable `rotation`, `approvedProviders`, explicit service `barriers`, exact-key `modelBarriers`, `cooldownEvidence`, `policyVersion: 3`, `ovhCooldowns` and `ovhReservations`. Exact model identities are JSON-encoded `[service,id]` tuples, not display names or slash parsing. Configuration snapshots are immutable; saves/reservations are serialized atomic writes. New targets require eligibility and provider-routing consent. Structural changes and new cycle allowances require an explicit reviewed restart. Invalid runtime pauses an otherwise valid enabled pool; invalid settings disable it visibly, never falling back silently to a different saved scheduler.

Automatic mode is round robin without OVH and priority with OVH. Explicit scheduling overrides it. Priority returns to the first ready compatible entry; weights and finite cycles do not covertly transform it into rotation. Finite cycles are accepted only in round robin. OVH weights are 1–2 (default 2); other providers 1–100 (default 1). These are requests per visit, not rate limits. Each HTTP send, including tool continuation or a subsequently failed/cancelled attempt, consumes its reservation. No request is generated to fill a visit. Skipped visits count toward pass completion but do not invent sends or quota usage.

After a finite pass allowance is exhausted, selected models remain managed but paused: there is no unmanaged escape hatch or silent reset. Restart preserves position/allowance. Explicit restart can reauthorize visits, but does not clear cooldowns or refund provider quota. Pre-wire durable reservation can underuse a visit after a crash/abort, by design. Persistence failure pauses further sends. Model/tool/context/cancellation checks repeat after reservation before the wire.

The established OVH ledger and durable reservations remain unchanged. General-pool HTTP 429 before meaningful activity may now select another untried ready compatible model within the same logical response. No identity is retried and no completed tool effect is rerun. Text/thinking/tool-call activity commits the attempt permanently. Persistence failure, caller abort, changed eligibility, unsafe boundary and explicit broader cooldowns still prevent another send. Auth/network/invalid-request/other HTTP failures do not authorize replay. The separate owned silent-start deadline retains its established behavior.

Kilo unknown 429 gates only the exact requested model, not its whole service. Retry-After supplies time, never inferred scope. Without a valid value the existing 61-second package backoff applies only to that model. A recognized explicit X-Ratelimit-Scope value (provider, service, global, account, ip; case-insensitive) creates a server-declared service gate. Generic prose and the user-reported upstream_provider_shared_pool body field do not create blanket gates. Every actual attempt, including rejection, consumes its conservative reservation. When all untried candidates are unavailable the chain terminates rather than looping, while continuous scheduling remains enabled for later requests.

Public native Provider registration on Pi 1.4.0 guards every declared API instead of the compatibility registration's single-API stream hook. Complete model/classifier inventories remain visible. Verified pool transports are native OpenAI Completions/Responses. Anthropic's SDK beta-query endpoint is not accepted by the unchanged anonymous guard; it is explicitly unavailable in pool status while retained in the catalog. There is no credential lookup, identity impersonation or route-guard bypass to make a model pass.

### General pool verification

```sh
npm run test:pool-monkey
FREE_POOL_MONKEY_SEED=42 FREE_POOL_MONKEY_STEPS=10000 npm run test:pool-monkey
npm run verify:general-loader
```

The scheduler monkey suite uses 32 deterministic seeds × 500 events, an independent transition/persistence oracle, exact replay, and failure-recorder checks. It combines weighted sends, absent/incompatible visits, time changes, provider cooldowns, disk failures, edits, explicit resets and valid/corrupt runtime restarts. Seed/trace failures go to `test-results/free-pool-SEED-failure.json` (override with `FREE_POOL_MONKEY_FAILURE_DIR`); if writing fails, the prefix is included in the error. This scheduler simulation uses controlled eligibility, with separate actual Pi SDK/session tests for production wiring, transport, tools and cancellation. Existing footer monkey tests are retained.

The general bundled-CLI verifier tests bare-folder versus installed-peer loading, Kilo-only and mixed pools, actual native SDK fixture POSTs, persisted rotation across separate CLI processes, and finite pauses. All sockets are blocked and every response is local; these fixture POSTs are not live inference. No automated suite proves all schedules safe or certifies Android or current provider availability.


### Pool diagnostics and provenance

The schema remains version 2. An optional `cooldownEvidence` array, capped at 128
records, stores only service, exact model, HTTP status, observation/deadline times,
model/service scope, deadline source, Retry-After validity and its valid bounded
value. No body/error text, prompts, reasoning, tools or credentials are copied.
Missing evidence in existing files means unknown provenance, not a new observed
response. Invalid optional evidence is ignored with a diagnostic warning; it
cannot clear or change enforcement barriers, refill quota or pause an otherwise
valid runtime. Corrupt enforcement/runtime still follows the established
fail-closed rules. Shorter later headers do not become the attributed origin of
a longer older barrier. OVH effective ledger gates may include earlier constraints;
quota/reservation waits are not labelled as new provider rejections.

The current Kilo policy is model-local by default, with an explicitly declared header required for a broader gate. The provenance record's scope explains the chosen enforcement. The 61-second fallback is labelled package policy, not provider capacity. The old blanket-blocking and no-429-failover policy is superseded for the general pool; standalone/legacy OVH behavior is not broadened.

Current status uses a timestamped local snapshot, not the cached text of an old
selection. The last selection and bounded response history are labelled historical.
General viewers and collapsed activity point to Free Pool and `/free-pool status`;
unmigrated OVH viewers/history retain the legacy labels. Activity may add only
allowlisted compatibility/failure codes with fixed English explanations. These
remain context-free metadata, not raw error bodies or conversation content.

Runtime and unsaved-draft previews show the conditional schedule from the relevant
cursor/allowance, including remaining requests in the visit, skipped-pass semantics
and finite pause. They never invoke compatibility probing, metadata refresh or
inference. Failure codes distinguish readiness expiration, incompatible selection,
finite exhaustion and runtime review, without allowing quota/cooldown resets.

Additional reproducible provenance stress checks:

```sh
npm run test:pool-diagnostics-monkey
FREE_POOL_DIAGNOSTICS_SEED=42 FREE_POOL_DIAGNOSTICS_STEPS=10000 npm run test:pool-diagnostics-monkey
```

The default provenance suite uses eight fixed seeds × 300 events across 12
categories, independent expected deadline/evidence state, valid/malformed history
reloads, failed storage, expiry, explicit rotation restart and read-only reports.
Failures retain seed and complete operation prefix; `FREE_POOL_DIAGNOSTICS_FAILURE_DIR`
overrides the failure directory. This supplements, rather than replaces, the
existing scheduler/footer monkey and real native SDK/CLI fixture tests.


### Explicit continuity upgrade and adversarial verification

This local update carries the user's explicit choice of continuous scheduling and
pre-activity 429 failover. Existing schema-2 general files without a policy marker
are upgraded atomically to policyVersion 3. All recoverable Kilo response
model deadlines are preserved locally, not only the longest old blanket deadline.
Unrecoverable package-inferred blanket gates are retired with a visible notice;
OVH quota, reservations, cooldowns and enablement/consent remain unchanged. Valid
finite-only exhaustion can be unpaused, retaining cursor and counters. Corrupt
runtime is never unpaused and migration storage failure blocks managed dispatch.
The marker prevents overwriting later explicitly reviewed finite settings.

The continuity chain is bounded by distinct selected identities, buffers discarded
pre-activity structural events, and never forwards a failed attempt's terminal
error before the approved replacement completes. A per-attempt owned signal makes
HTTP 429 distinct from generic SDK/network errors. Both Completions and Responses
paths are tested through real Pi sessions with local HTTP fixtures.

```sh
npm run test:pool-continuity-monkey
npm run verify:general-loader -- --continuity
FREE_POOL_CONTINUITY_SEED=42 FREE_POOL_CONTINUITY_STEPS=10000 npm run test:pool-continuity-monkey
```

Eight default seeds × 200 turns use an independent weighted-cursor, cooldown and
attempt oracle, mixing ready/missing candidates, successes, 429s, auth/server errors,
post-activity rejection and network failures. Seed-zero replay and persisted/inline
failure recording are covered. This is reproducible fixture coverage, not live or
phone certification or an exhaustive guarantee.

## Provider retirement in 0.1.8

Only Kilo and OVH are registered by this extension. The retired provider namespace, routes, headers, native classifier dependency, discovery registries and UI choices are removed. Models offered independently by Kilo or OVH are not filtered by their names. Kilo's own upstream `opencode` metadata fields still describe Kilo variants and adapters; reading those fields does not contact or register OpenCode.

Saved catalogs are migrated in memory before validation and registration. Only removed-provider entries, source documents and their events are retired. Remaining entries, first-seen dates, lifecycle evidence and history are preserved, as are the original source timestamps. Invalid remaining data is still rejected. Loading does not rewrite the disk cache or fetch metadata.

Thinking preferences for removed models are discarded from the active extension state. Other preferences are unchanged. Pools containing removed members retain their remaining order, weights, thinking choices, cycle counters, cooldowns and OVH reservations, but are disabled and paused with a durable review requirement. Re-enablement requires explicit review, consent and restart. Failed persistence does not enable the pool or replace the old disk state. No active-model replacement is selected automatically.

The new Pages contract is version 2. The workflow publishes only v2 paths. The existing v1 feed is not copied into future site artifacts. Older packages are not modified or unpublished; when their v1 feed is unavailable they retain their existing direct-source fallback behavior. The v2 client itself fetches only v2 or the three Kilo/OVH sources.

On the backend, only a missing v2 endpoint (HTTP 404) permits a one-way attempt to migrate the previous v1 snapshot. Migration accepts only the pinned published 0.1.7 production-rules fingerprint, checks payload integrity and fully validates the derived v2 Kilo/OVH semantics. It preserves remaining LKG and history rather than bootstrapping an empty catalog. Corrupt/incompatible existing v2 data or network/HTTP failures do not authorize fallback or a history reset. See CATALOG-BACKEND.md.
