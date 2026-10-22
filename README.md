# pi-free-catalog

Find anonymous free models from **Kilo**, **OpenCode Zen**, and **OVHcloud** in Pi, without keeping a model list up to date yourself.

The package adds three providers: `free-kilo`, `free-zen`, and `free-ovh`. It checks live catalogs, prices, and anonymous entitlement whenever Pi loads the extension, then makes eligible models available in the model picker. Models with unverified or conflicting free access stay visible in the catalog report, but cannot be called as free.

No personal API key, account setup, or running OpenCode CLI is needed for the public endpoints used here. This is an independent community integration, not an official Kilo, OpenCode, or OVHcloud client. Upstream availability, quotas, and access policies still apply.

**Requirements:** a compatible Pi host and Node.js 22.19 or later. This release is verified with Pi 1.4.0. Licensed under MIT; maintained by `aminmza`.

## Get started

```bash
pi install npm:pi-free-catalog
pi
```

Open Pi's model picker and choose a model from `free-kilo`, `free-zen`, or `free-ovh`.

Before publication, use the extracted local source folder for testing. The versioned npm command works only after that version is published. For a reproducible registry install, specify the version:

```bash
pi install npm:pi-free-catalog@0.1.6
```

To try the published package for one run without saving it to your settings:

```bash
pi -e npm:pi-free-catalog
```

This is a Pi extension, not a standalone agent. Install it with `pi install`, rather than `npm install -g`.

### Use a local copy

For development, extract the release source ZIP and keep the extracted folder somewhere permanent:

```bash
pi install ./pi-free-catalog-0.1.6
pi
```

Pi loads local packages from their original folder, so do not move or delete it while the package is installed. If you are replacing an npm installation, remove that installation first:

```bash
pi remove npm:pi-free-catalog
```

Avoid loading both copies at once. From the source folder, `pi -e .` is another way to test a local copy without saving a new package entry.

## What appears in the catalog?

The goal is to keep the full picture visible, not just the models that happened to work in a test.

- Every live model ID is checked. The words `free` or `paid` in a model's name do not determine its classification.
- All currently listed, confirmed-free chat models are registered, including models with unknown limits, limited tool support, or previous inference errors.
- Models with uncertain or conflicting prices remain in `/free-catalog` and `/free-export`, with calls blocked until they can be verified.
- Previously free, missing, deprecated, and retired models remain in the report and history. They do not quietly disappear from the evidence.
- Native classifiers, such as Zen's `jev-1.13-free`, are registered separately rather than presented as chat models.
- An unfamiliar operation or transport stays in the report with a clear unsupported notice. Being listed is not a promise that every future protocol is implemented.

### How free pricing is checked

For **Kilo**, the catalog's explicit `isFree: true` flag is the starting point. A positive charge conflicts with that flag and blocks the model. Zero prices alongside `isFree: false` are also treated as a conflict. Missing or dynamic prices are retained as evidence when the explicit free flag is present.

For **Zen**, the live model list is joined by exact ID with official OpenCode metadata, models.dev, and Pi's model metadata. The check includes input, output, cache, and tiered charges. Missing prices are unknown, not assumed to be zero. For an already confirmed-free model, incomplete metadata can retain its last-known free evidence instead of disabling chat. New models without free evidence, fresh paid prices, and price conflicts are still blocked.

For **OVHcloud**, official anonymous rate-limit metadata establishes the no-account lane; commercial input/output prices are not assumed to be zero. The runtime list is joined to the rich catalog by exact ID, exact name, or an explicitly declared alias. Ambiguous matches and new models without anonymous entitlement remain unknown, not free. The full commercial rate card and rich record are retained in exports; Pi's effective cost is zero only for the anonymous lane.

The extension cannot verify information that an upstream service does not publish. It keeps that uncertainty visible instead of guessing.

## OVH anonymous access and limits

OVH documents an anonymous quota of **2 requests/minute/IP/model**, including each tool continuation. No signup, personal key, billing activation, or payment is used here. Commercial API prices and authenticated quotas describe a different lane. See [OVH AI Endpoints getting started](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started) and [billing/lifecycle documentation](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-billing).

- The extension spaces same-model starts by at least 31 seconds. The TUI shows a cancellable wait status; cancelling a turn cancels its queued wait and clears that status.
- A 429 extends the next same-model gate using `Retry-After` seconds or HTTP date. A missing/invalid value uses a conservative local delay. The original upstream response is returned; the extension does not automatically retry, change model, rotate IPs, or activate paid access. SDK retries are disabled for OVH. Pi's independent agent retry preferences still belong to the user; disable them when you want the run to stop at the first upstream error.
- Pacing is **per running extension**, not coordinated across processes or other clients sharing your public IP. The upstream quota is authoritative; 31-second local spacing cannot guarantee capacity.
- All eligible text-generation models remain registered, including a model without advertised tools. Its picker name says `chat-only; tools not advertised`. This is a capability limitation, not a fabricated live-test result. Reasoning without advertised effort values keeps the provider default; no thinking selector is invented.
- Embedding, safety/moderation, speech, and image-generation entries remain visible in reports/exports, but are not routed through the chat endpoint or presented as Zen classifiers. Image **inputs** for a text-generation model are a separate advertised capability.
- The rich catalog's `available: false` website flag alone does not prove API retirement; an explicit EOL date still applies. Catalog/metadata failure retains previously justified anonymous models, while a fresh withdrawal of anonymous entitlement blocks them.

The October 22 fixture has 22 runtime records, ten chat models, and nine chat models advertising tools. These are snapshot facts, **not nine live-verified agents** or permanent counts. Verification of one model does not certify the rest, long-context limits, every thinking level, mobile networks, or an anonymous SLA.

## Refreshes and model history

All seven sources are fetched on every extension load, before initial model selection, including noninteractive runs. An existing cache does not skip that startup check. After startup, only `/free-refresh` fetches these sources again. Sending messages, changing thinking, waiting past five minutes, and Pi's internal model-registry refresh do not trigger catalog network requests. Reloading the extension starts a new startup check.

A failed refresh does not erase or disable the last known free catalog. Cached free models stay selectable and requests are sent to their normal anonymous endpoints. A catalog outage is not an inference outage: if the endpoint is reachable, chat and tools can still work. If the model is missing or unavailable upstream, its actual response is returned without a freshness-guard error. A first run without either a usable cache or a successful fetch cannot invent a model list.

Changes are handled according to what the sources actually say:

| Change | What happens |
|---|---|
| Explicit retirement | The model is removed from callable models and kept in history. |
| Missing from a successful catalog response | It is marked `not-listed`, not assumed retired. It can return if listed again. |
| Deprecated, but still listed and free | It remains available with a deprecation label. |
| Free model becomes paid | Free access is blocked; the model remains in the report. |
| Timeout, 404, 429, or capacity error | The error is recorded, not treated as proof of retirement. |

The cache is stored in `free-catalog/catalog.json` inside Pi's agent directory, normally `~/.pi/agent/free-catalog/`. Despite the filename, the cache is compact, gzip-compressed JSON. Older plain-JSON caches still load. It retains raw source responses, timestamps, classifications, and lifecycle history; the recent change log is limited to 2,000 events, but the model inventory is not.

`/free-export` writes readable, uncompressed JSON for inspection. Refreshes are bounded by a 12-second timeout and a 16 MiB response limit per source. A successful fetch reflects the upstream data at that moment, not a guarantee that every source agrees instantly.

## Commands

| Command | What it does |
|---|---|
| `/free-catalog` | Open a scrollable, searchable catalog separating provider listing, pricing evidence, metadata timestamps, lifecycle declarations, and registration reasons. |
| `/free-refresh` | Fetch the sources again and reconcile the model lists. |
| `/free-thinking` | Show the current model's native thinking options and selection. |
| `/free-thinking MODE` | Choose `auto`, `default`, or an advertised native mode. |
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

These are examples for different models, not options supported by every model. Kilo Beam advertises effort levels such as `low`, `medium`, `high`, `xhigh`, and `max`. Toggle models use modes such as `instant` and `thinking`. Zen and OVH effort settings are sent as `reasoning_effort`; Kilo settings use the provider's native parameters. The available choices come from live metadata, so check `/free-thinking` rather than relying on a fixed list.

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

The normal Pi footer is now the default. The extension contributes only the short `Free chat: Kilo … · Zen … · OVH …` status. These are chat subtotals, not totals including classifiers or embeddings. Non-chat inventories and subtotals remain visible in the catalog; Zen's native classifier remains registered separately. Source-failure IDs and ordinary "provider default / no advertised controls" messages do not appear in that status. Source health, errors and timestamps remain available through `/free-catalog` and `/free-export`. Important manual default/unmapped thinking overrides can still be labelled.

Pi has one custom-footer slot and no public composition/ownership getter. Two extensions cannot safely combine arbitrary complete footers automatically. If you want this package to hide only the `(free-kilo)`, `(free-zen)`, or `(free-ovh)` prefix, select a free model and explicitly run `/free-footer compact`. This reuses Pi's exported renderer and preserves the other statistics and statuses. Provider IDs and model-picker entries never change.

The preference is saved in `ui.json`. An existing explicitly saved compact preference is respected at startup. If another extension subsequently replaces our footer, its disposal notification relinquishes our ownership. Model switches will not reclaim or erase that extension's footer. `/free-footer default` releases our footer only while we still own it; it cannot resurrect a custom footer that an explicit compact command previously replaced. Run compact again only when you intend to claim the slot.

Leaving a free model releases an owned compact footer; returning to a free model does not automatically claim the slot again. Print, JSON and RPC modes are unaffected. The implementation and ownership tests use Pi's public APIs and exported renderer, verified on Pi 1.4.0.

## Requests, tools, and safety

Requests use Pi's own OpenAI Completions, Responses, Anthropic Messages, and native classifier implementations. Pi's SDK handles streaming, tool calls and results, Unicode, cancellation, usage, and finish reasons. The extension does not replace the global HTTP client or add its own SSE parser.

Known explicit retirement deadlines are also checked locally before requests, without fetching catalogs again. `retirement_date`, `retired_at`, and Kilo's native `expiration_date` share one calendar-valid ISO parser. Date-only deadlines start at midnight UTC. Corrected or removed dates are reconciled on refresh; stale evidence cannot bypass a known deadline. OVH's explicit DD/MM/YYYY EOL field is normalized into the same lifecycle policy.

Before each HTTP request, a scoped guard checks the model ID, approved endpoint, last-known free classification and lifecycle. It does not require a recent catalog fetch. It blocks redirects and paid fallback, and removes Authorization, x-api-key, and api-key headers before installing public/anonymous headers. Kilo requests carry no Authorization header. OVH uses a separate allowlisted header set: no caller credentials, Authorization, API keys, cookies, or payment headers. Zen uses the literal public placeholder `Bearer public`, compatible CLI headers, and a stable per-session ID. The User-Agent identifies this integration; no OpenCode binary is launched and no quota identities are rotated.

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

For separate Kilo/Zen live inference checks, use `scripts/verify-ui-thinking-live.mjs` in an isolated HOME with `PI_CODING_AGENT_DIR` set to a fresh directory. It runs Pi's actual agent session with the default read, write, edit, and bash tools, checks thinking parameters, and verifies real file changes. It normally makes about 14 inference requests across the two Beam models, with SDK/agent retries disabled and a 24-request budget. `--toggle-only` runs the separate toggle checks. Model errors stop the run; inspect the result JSON and wire log rather than relying on a confident final answer.

The broader opt-in CLI harnesses, `scripts/live_pi.py` and `scripts/observe_live.py`, are also included. They require Python 3 and the `PI_NODE`, `PI_CLI`, `PI_TEST_DISPATCHER`, and `FREE_TEST_DIR` environment variables. Their test-only wire recorder is never loaded by the extension. The Python census accepts gzip and legacy plain-JSON caches. An isolated HOME is not an operating-system sandbox for bash. Wire evidence may contain prompts and tool content; keep it private.

Concurrent Pi processes use independent in-memory snapshots. Atomic writes prevent torn files, but this release does not promise cross-process merging of preferences or cache snapshots; use separate agent directories when independent simultaneous writers are required.

Do not commit or publish credentials, `.npmrc`, caches, or live test outputs. Review the source and the upstream services' terms before use; the code's MIT license does not grant service access.

## Catalog sources

- https://api.kilo.ai/api/gateway/models
- https://opencode.ai/zen/v1/models
- https://models.opencode.ai/api.json
- https://models.dev/api.json
- https://pi.dev/api/models/providers/opencode?types=chat,image,classifier
- https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models
- https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2
