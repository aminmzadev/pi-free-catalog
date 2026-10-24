# pi-free-catalog

**Free AI models, right inside Pi. Find your favorite, tune its thinking, or build a pool that fits the way you work.**

[![CI](https://github.com/aminmzadev/pi-free-catalog/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aminmzadev/pi-free-catalog/actions/workflows/ci.yml)
[![Catalog workflow](https://github.com/aminmzadev/pi-free-catalog/actions/workflows/catalog.yml/badge.svg?branch=main)](https://github.com/aminmzadev/pi-free-catalog/actions/workflows/catalog.yml)
[![Published npm version](https://img.shields.io/npm/v/pi-free-catalog?color=38bdf8&label=npm)](https://www.npmjs.com/package/pi-free-catalog)
[![Node.js 22.19 or later](https://img.shields.io/badge/Node.js-%E2%89%A522.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Tested with Pi 1.4.0](https://img.shields.io/badge/tested%20host-Pi%201.4.0-a5b4fc)](https://pi.dev)
[![MIT license](https://img.shields.io/badge/license-MIT-5eead4)](https://github.com/aminmzadev/pi-free-catalog/blob/main/LICENSE)

![Architecture: public metadata feeds become a validated Pages snapshot and local Pi catalog; inference goes directly to the selected provider, not through the catalog host.](https://raw.githubusercontent.com/aminmzadev/pi-free-catalog/main/docs/assets/catalog-overview.svg)

Use eligible **free AI models** from **Kilo**, **OpenCode Zen** and **OVHcloud AI Endpoints** in your [Pi coding agent](https://pi.dev). Explore their capabilities, adjust native thinking settings, and pick a model or build your own Free Pool. Only models with free-access evidence are eligible. No personal provider API key or paid fallback.

[Quick start](https://github.com/aminmzadev/pi-free-catalog#quick-start) · [Commands](https://github.com/aminmzadev/pi-free-catalog#everyday-commands) · [Free Pool](https://github.com/aminmzadev/pi-free-catalog#general-free-pool) · [Reference](https://github.com/aminmzadev/pi-free-catalog/blob/main/REFERENCE.md) · [Changelog](https://github.com/aminmzadev/pi-free-catalog/blob/main/CHANGELOG.md)

## Quick start

**Requirements:** Node.js **22.19+** and a compatible Pi host. Tested with **Pi 1.4.0**.

### Install

```bash
pi install npm:pi-free-catalog
pi
```

For a single session without saving an installation:

```bash
pi -e npm:pi-free-catalog
```

### Use a local checkout

```bash
git clone https://github.com/aminmzadev/pi-free-catalog.git
cd pi-free-catalog
pi -ne -e .
```

`-ne` disables automatic extension discovery for this test; `-e .` loads this copy. Run without a prompt to inspect it without sending inference. Normal startup can fetch metadata. No local `npm install` is needed for this Pi-hosted loading check.

To keep a local installation, use `pi install /absolute/path/to/pi-free-catalog`. Keep that directory in place. Remove an older registry installation with `pi remove npm:pi-free-catalog` first if necessary; loading both copies can register the extension twice.

### Find a model in Pi

| Provider ID | Service | What to expect |
|---|---|---|
| `free-kilo` | Kilo | Free model discovery with model-specific pricing and capabilities. |
| `free-zen` | OpenCode Zen | Model discovery, capability details and native thinking options. |
| `free-ovh` | OVHcloud AI Endpoints | Anonymous model access with per-model quota tracking. |

Open the model picker or inspect `/free-catalog`. New Free Pools start **OFF**, and the response-start limit is disabled unless you choose it.

Install through Pi rather than `npm install -g`; this package is an extension, not a standalone agent.

## What it does

- **Keeps model discovery out of your way.** A cached catalog is available immediately while startup refresh runs. Sending a prompt or switching models does not fetch catalog metadata.
- **Makes models easy to compare.** Search pricing, capabilities, thinking options and lifecycle details in one catalog.
- **Uses the model's own thinking controls.** Follow Pi's selector or choose an advertised native mode without inventing effort levels the provider does not offer.
- **Fits into Pi.** Streaming and tool calls use Pi's SDK. The normal footer stays the default, and the optional compact footer leaves model IDs unchanged.
- **Offers an opt-in general Free Pool.** Mix eligible Kilo, Zen and OVH chat models in your chosen order. Use priority or weighted round robin, with continuous or finite visits. New pools are OFF until enabled.

Provider rate limits and terms still apply. The catalog tracks pricing and lifecycle changes, while pool scheduling respects cooldowns and quota.

## Everyday commands

| Command | Use it to… |
|---|---|
| `/free-catalog` | Browse and search model evidence, source health, and registration reasons. |
| `/free-refresh` | Refresh metadata now; it does not send an inference request. |
| `/free-thinking` | See the current model's native thinking choices and effective setting. |
| `/free-thinking MODE` | Follow Pi with `auto`, use the provider's `default`, or select an advertised mode. |
| `/free-pool` | Configure the general Free Pool across Kilo, Zen and OVH. |
| `/free-pool status` / `preview` | Inspect runtime state or preview the configured visits, without sending requests. |
| `/free-ovh-pool` | Keep editing a legacy OVH setup; forwards to general settings after migration. |
| `/free-footer` | Open footer display settings, including the independent chat-count switch. |
| `/free-footer counts on` / `counts off` | Show or hide free chat counts; ON by default, saved independently. |
| `/free-footer compact` | Opt into a compact footer on the current free model. |
| `/free-footer default` | Release this extension's compact footer if it still owns the slot. |
| `/free-export [PATH]` | Export readable JSON, including raw source metadata and complete inventories. |

Add `--help` to a command for usage without fetching metadata, changing preferences, or writing an export. In the interactive catalog, type to search, use arrows or PageUp/PageDown to scroll, and press Escape to close.

The footer shows `Free chat: Kilo … · Zen … · OVH …` from the current catalog, excluding classifiers and other non-chat models. It remains after replies, errors, aborts and model changes; it is not a pool path. Narrow terminals use shorter labels. Use `/free-footer` or `/free-footer counts off` to hide it immediately, without refreshing metadata or changing the model, thinking, pool, quota, or compact/default appearance. Display choices are saved in `free-catalog/ui.json` inside the agent directory. A save failure is reported while the current session keeps your choice.

## General Free Pool

Open `/free-pool` to choose models, per-model thinking, requests per visit, scheduling and waiting limits. Review provider routing and Apply; Cancel/Escape keeps the saved settings. Selecting the first model is a separate opt-in. If your current model is outside the pool, select a configured model to start using it.

New pools start **OFF** and require at least two distinct eligible chat models. Applying settings does not change your active model unless you separately agree to that selection.

A same-response handoff is allowed only for an owned silent-start timeout or a qualifying HTTP 429 **before meaningful output or tool activity**. Completed tool effects are never replayed. Cross-provider use can share the conversation with each selected service; review that consent before enabling it.

<details>
<summary><strong>Scheduling, cooldowns, persistence and diagnostics</strong></summary>

Automatic scheduling defaults to **round robin for Kilo/Zen-only pools**, so an always-ready first model does not monopolize the pool. If any OVH model is present, Automatic uses ordered priority; you can explicitly select round robin or priority. Existing OVH setups keep their priority behavior until explicitly migrated.

In round robin, weights of `3 / 4 / 1` mean three actual requests to the first model, four to the second, one to the third, then repeat. **OVH accepts only 1 or 2 per visit, default 2.** Kilo/Zen default to 1 and allow 1–100; these are scheduling weights, not claims about provider capacity. The existing OVH quota ledger and server cooldowns always take precedence.
Requests-per-visit and cycle fields appear only in round-robin mode. Selecting
priority clears the finite cycle allowance in the draft, before review.

Cycles are scheduling passes, not repeated prompts: choose continuous, once, or N passes. Finite cycles require round robin and **pause** when complete; they do not silently reset on restart. Unavailable/incompatible visits can be skipped without an HTTP send, but count toward pass completion. Ordinary restarts preserve position and spent allowance. Reauthorizing a rotation requires a reviewed explicit restart and never refunds quota or clears cooldowns.

A reservation is atomically saved before a managed HTTP send. A crash or cancellation in that small interval may underuse a visit; it cannot grant that visit twice. Save failure blocks new managed requests and requires repair/review. Settings and runtime are in `free-catalog/free-pool.json`; the old `ovh-pool.json` is not overwritten. A saved general configuration takes precedence, so two schedulers never run together.

Switching occurs only at safe request boundaries, never after meaningful text, thinking or tool-call activity or during unresolved tool calls. Tool-continuation requests count, while completed tool effects are not repeated. The general pool now explicitly permits **pre-activity HTTP 429 failover** to an untried ready compatible model within the same response. Each exact provider/model gets at most one attempt in that logical inference; failed attempts are not refunded. Auth, network, invalid-request and other HTTP failures do not authorize replay. The owned silent response-start deadline remains a separate narrowly scoped exception.

**Kilo/Zen cooldowns are model-local by default**, using Retry-After or the labelled 61-second model-local package backoff when a 429 supplies no valid deadline. Retry-After alone is not evidence of a service-wide limit. An explicit `X-Ratelimit-Scope: provider|service|global|account|ip` declaration creates a broader gate that remains respected. No model RPM or paid/credential workaround is invented. If all configured candidates are cooling, incompatible or already attempted, the chain stops boundedly with an unavailable report; it does not disable a continuous pool or generate requests to finish loops.

Version 0.1.7 applies a one-time **continuous-mode upgrade** to existing general configurations: valid old finite-only pauses are removed, cursor/counters and OVH quota are kept, and the policy marker is durably saved before dispatch. Old blanket Kilo/Zen policy gates are reassigned to every recoverable originating model deadline; an untraceable blanket heuristic is retired with a visible notice, not guessed onto all models. Invalid runtime/storage is never automatically resumed. Later manually reviewed finite settings remain available and are not silently overwritten.

Cross-provider routing can disclose the conversation and tool results to every selected service; the review explicitly asks for this consent. Metadata eligibility is not live inference certification, particularly for Zen. The pool uses the unchanged anonymous route guards. Currently verified pool transports are native OpenAI Completions and Responses. Pi 1.4's Anthropic adapter adds a beta query rejected by those guards; such entries remain in the catalog and are explained as unsupported in pool status, not silently sent through an unguarded adapter.

### Understanding pool status and failures

`/free-pool status` separates the **current local cooldown snapshot** from the
**historical selection check and response evidence**, each with timestamps.
“No active local cooldown” is not a live provider check or a promise that the
model fits the current conversation. Historical “cooling down” can remain after
that block expires; it is clearly marked as history.

For new cooldowns, status records the triggering service/model, HTTP status,
observation time, deadline and source. Kilo/Zen gates default to the exact model;
broader gates need the explicit server scope header described above. The 61-second
fallback remains a package backoff, not a verified capacity limit. The latest 128
response records survive restart; status/preview sends no requests and stores no
prompts, tool results or raw provider bodies.

- **Readiness wait expired:** no compatible model became available within your
  waiting window. The response-start timer had not begun; restarting rotation
  does not remove cooldowns.
- **No compatible model:** the actual request needs capabilities or capacity
  that the selected models cannot safely provide. A longer wait cannot add tools.
- **Finite allowance exhausted:** the configured passes ended. Skipped visits
  count toward passes, not successful answers; explicitly review a restart or
  leave the pool if desired. Quotas are never refunded.

Preview shows the saved cursor, reserved/remaining requests for the current
visit and conditional future visits, stopping at the finite allowance. Draft
preview uses your unsaved settings and shows a new beginning only when Apply
would explicitly restart. Neither preview sends requests or fetches metadata.

</details>

## Architecture

The illustration separates metadata delivery from inference:

1. **Collect:** the backend fetches seven fixed public metadata sources for Kilo, Zen and OVHcloud.
2. **Validate:** schema, source integrity, production rules and historical evidence are checked before a Pages snapshot is deployed.
3. **Load:** Pi registers usable cached models, then refreshes at startup or explicit `/free-refresh`. Invalid or stale Pages data can trigger direct-source recovery.
4. **Infer directly:** prompts and tool results go from Pi to the selected upstream provider. The catalog host is not a prompt proxy.

The backend cron requests a 15-minute schedule; GitHub scheduling and CDN propagation can be delayed. This is **not a 15-minute freshness SLA**. Cached inference does not expire at the client's 45-minute recovery threshold.

## How a model qualifies as free

A name containing “free” is not enough. The extension checks provider listings against pricing and anonymous-access evidence:

- **Kilo:** starts with the explicit `isFree` flag. Conflicting positive charges block free access.
- **OpenCode Zen:** joins exact model IDs with official metadata, models.dev, and Pi metadata. Input, output, cache, and tiered charges matter; missing prices are not assumed to be zero.
- **OVHcloud:** checks the documented anonymous-access lane. A commercial rate card is not proof that the anonymous lane is paid, nor permission to use authenticated paid access.

Models with missing or conflicting evidence remain inspectable but are not newly registered as free. Incomplete refresh data can preserve an already confirmed-free model's last-known evidence; fresh paid, withdrawn, or retired evidence still blocks it.

Chat models appear in the picker. Native classifiers are registered separately, while embeddings and other unsupported operations stay in reports instead of being sent through a chat endpoint. A chat model without advertised tools is labelled accordingly.

## Refreshes that do not interrupt a conversation

On startup and explicit `/free-refresh`, the extension first tries the public [GitHub Pages catalog snapshot](https://aminmzadev.github.io/pi-free-catalog/catalog/v1/latest.json). A valid snapshot uses one metadata request instead of seven direct-source requests. It is checked for structure, timestamps, integrity, and compatibility with the production rules before use. Downloaded content is JSON data, never executable code.

If Pages is unavailable, invalid, incompatible, or too old, the client tries the seven sources directly. A failed refresh preserves usable cached evidence. The **45-minute source-age threshold triggers recovery; it does not expire cached inference**.

There is no catalog polling in the extension. After startup, only `/free-refresh` starts another refresh; prompts, model switches, and thinking changes do not. The separately scheduled backend can publish newer snapshots without forcing a refresh into your current session.

The cache lives in `free-catalog/catalog.json` inside Pi's agent directory, normally `~/.pi/agent/free-catalog/`. Despite its filename, it is gzip-compressed JSON. `/free-export` produces a readable copy.

Missing from a provider list, deprecated, retired, and temporarily failing are different states. A timeout or 429 is not treated as proof of retirement. History remains available in the catalog instead of silently disappearing.

## Thinking controls

Use Pi's normal thinking selector, or inspect `/free-thinking` before choosing a native mode:

```text
/free-thinking
/free-thinking auto
/free-thinking default
```

- `auto` follows Pi and maps its level to a supported native setting.
- `default` leaves thinking to the provider; it does **not** mean “off”.
- Other choices come from that model's metadata. One model's `low`, `instant`, or `thinking` may not exist on another.

When a native mode has an exact Pi equivalent, the extension updates Pi's actual level too. Changing Pi's level releases the previous native override for that model. Modes without an exact equivalent remain available through the thinking command; no fictional Pi level is assigned.

Preferences are saved per provider and model. If a saved choice disappears from the metadata, use `/free-thinking auto` or another advertised mode; the extension does not silently invent a replacement.

## Optional OVH priority pool

Existing OVH-only settings remain supported. For new mixed-provider setups, use `/free-pool`.

<details>
<summary><strong>OVH-only settings, timing limits and quota safety</strong></summary>

```text
/free-ovh-pool
/free-ovh-pool status
/free-ovh-pool --help
```

The first command opens settings. Choose your models in priority order, their
thinking settings, and whether the pool is ON or OFF. It starts OFF and needs
at least two eligible models before you enable it. Only models you select are used.

You can choose two different waiting limits:

- **Wait for an available model (0–60 seconds):** how long to wait before sending
  a request when the permitted models are busy or out of quota. Zero means do not wait.
- **Response-start limit (0–300 seconds):** after sending a request, how long to
  wait for the model to start responding. Zero disables this feature; it is the
  default, including for existing settings. Text, thinking and tool-call activity
  count as responding. Headers and keepalive messages do not.

If the second limit expires before a response starts, the program cancels that
attempt and tries the next ready model that can handle the conversation. A model
is sent at most one request in that inference. Once a model starts responding,
it stays selected until that request finishes or you cancel it. This is not a
limit on total thinking, generation or tool-execution time.

Use **Apply settings** to review everything in a scrollable screen, then press
Enter to save or Escape to cancel. No setting is saved before approval. You can
optionally select the first model as Pi's active model when applying; otherwise
the current model stays selected. Reset changes only the draft until Apply and
never restores used quota. Settings and active-model selection are separate:
a failure selecting the model after saving is reported accurately.

Thinking choices are saved separately for each pool model. Different models may
use different choices. New selections start with the provider default; `auto`
follows Pi. Pool settings do not rewrite your outside-pool thinking preferences.

The footer keeps Pi's active model display, not a permanent pool path or extra
thinking label. A short wait indicator disappears when the wait or request ends.
When switching, skipping, waiting or errors occur, a diagnostic report is saved
in the conversation history. It is **not sent to the model**. Use
`/free-ovh-pool status` for scrollable settings and the most recent 20 reports in
the current session branch. Each report retains at most 24 steps and no prompt,
reasoning text, tool-result content or raw provider error body.

### Quota and safety

OVH documents **2 anonymous requests per minute, per IP, per model**. Tool
continuations count too. Local scheduling uses validated quota headers when
available and conservative accounting otherwise; it cannot guarantee capacity
shared with other clients on your IP. A canceled or timed-out request still
counts. Canceling locally does not guarantee the server stopped processing it.

Before each inference, prefer the highest-priority ready model that can handle
the conversation, returning to the primary when possible. Models whose context,
output allowance, tools or thinking choices do not fit are skipped. Conversations
are not truncated and completed tools are not replayed. There is no switch during
an unfinished tool call or after meaningful response output.

Authentication errors, invalid requests, network failures and unknown/global
limits do not trigger the silent-start fallback. A rejected request is returned
without automatic replay. Confirmed model-specific limits can affect selection
on a subsequent inference; provider-wide limits remain barriers for every model.
The separate response-start limit is the only exception allowing another send
within the same inference, and only before meaningful output. OVH SDK retries
remain disabled.

The editor, status and help do not fetch metadata or send chat requests. Without
a terminal UI, the command shows status without changing settings. When the pool
is OFF, normal single-model pacing and all anonymous-access guards remain active.
More detailed contracts and test procedures are included in `REFERENCE.md`.

</details>

## Privacy and safety

Anonymous access means no personal credentials are required. It does **not** promise private processing, zero retention, or permission to send sensitive data. Prompts and tool results still go to the selected upstream provider; check its current terms before use.

Before each HTTP request, scoped guards check the model, approved endpoint, free-access evidence, and retirement deadlines. Redirects and paid fallback are blocked. Caller credentials are removed before public/anonymous headers are applied; Zen uses the literal public placeholder `Bearer public`, not your personal token.

This is an independent extension, not an official Kilo, OpenCode or OVHcloud product. Text and image inputs are supported where implemented. The catalog labels unknown limits and uses conservative local defaults.

The normal Pi footer remains the default. Compact mode uses Pi's public renderer and claims its single custom-footer slot only when explicitly requested. It does not rename providers, alter picker IDs, or patch Pi's editor. See the reference before combining custom-footer extensions.

## Troubleshooting

| Symptom | What to check |
|---|---|
| No models on a first run | Open `/free-catalog` for source errors. With neither a usable cache nor a successful fetch, the extension cannot invent a model list. |
| Metadata refresh fails | Check source health in `/free-catalog`. Previously justified cached models can still work if their inference endpoint is reachable. |
| An OVH request returns 429 | Respect the wait. Other clients on your IP may share the quota; another model is not a workaround for a provider-wide limit. |
| The pool does not switch | Check `/free-pool status` (or `/free-ovh-pool status` for a legacy setup): eligibility, target thinking, actual context fit, quota evidence and provider-wide barriers are separate. |
| A thinking choice no longer works | Inspect `/free-thinking`, then choose `auto` or a currently advertised native mode. |
| The extension appears twice | Remove either the local or npm installation; avoid loading both copies. |
| Another extension's footer disappears | Pi has one custom-footer slot. Keep the default mode unless you intend compact mode to replace the current custom footer. |

## Development and verification

From a complete source checkout, with a compatible Pi host and **Python 3** available:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
```

Python is used by test harnesses, not by the extension at runtime. Repository CI targets **Node 22.19.0 and 26.0.0** and separately checks automation and clean-installed package behavior.

Tests exercise Pi sessions, the SDK, the loader and filesystem tools with mocked upstream HTTP. Optional live harnesses make real requests, consume quota and can record prompts and tool content; review the [technical reference](https://github.com/aminmzadev/pi-free-catalog/blob/main/REFERENCE.md) before running them. A fresh HOME does not sandbox bash commands.

### Loader and documentation checks

```bash
npm run verify:local-loader
npm run verify:general-loader
npm run verify:general-loader -- --continuity
python3 ci/docs/render-overview.py --check
```

The local loader checks physical SDK absence/presence, pool OFF/ON layouts and saved footer controls, with metadata fixtures and all inference POSTs blocked. The general loader additionally exercises native fixture requests and durable mixed-provider rotation across separate CLI processes; no live inference is sent.

The packaged budget estimator retains the Pi AI 1.4.0 implementation and its usage/timestamp accounting; see [third-party notices](https://github.com/aminmzadev/pi-free-catalog/blob/main/THIRD-PARTY-NOTICES.md).

For architecture and maintenance details:

- [Catalog backend and snapshot contract](https://github.com/aminmzadev/pi-free-catalog/blob/main/CATALOG-BACKEND.md)
- [Full technical reference and source endpoints](https://github.com/aminmzadev/pi-free-catalog/blob/main/REFERENCE.md)
- [Report an issue](https://github.com/aminmzadev/pi-free-catalog/issues) with the package/Pi versions, model ID, and a redacted error. Do not post credentials or private wire logs.

## License

[MIT](https://github.com/aminmzadev/pi-free-catalog/blob/main/LICENSE). The code's license does not grant access to an upstream service or override its terms.
