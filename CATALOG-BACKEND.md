# Central catalog backend (phase 1-3 only)

This backend collects public metadata and deploys a self-contained snapshot to GitHub Pages. **The extension does not consume this endpoint yet.** No extension, inference, routing, thinking, model-fallback or customer refresh behavior is changed. No version bump, npm publication or GitHub Release is part of this work.

## Data flow

`catalog.yml -> offline tests -> collect.mjs -> validateSnapshot -> immutable Pages artifact -> independent artifact verification -> deploy-pages`

The default public URLs, once this repository's Pages site is enabled and successfully deployed, are:

- `https://aminmzadev.github.io/pi-free-catalog/catalog/v1/latest.json`
- `https://aminmzadev.github.io/pi-free-catalog/catalog/v1/schema.json`

These are metadata endpoints, not inference proxies. They do not fix a customer's connectivity to model inference services. GitHub Pages custom domains/paths are not auto-discovered; changing the fixed previous-snapshot URL requires an explicit reviewed change.

## Version 1 contract

The machine-readable envelope schema is `ci/catalog/schema-v1.json`. `core.mjs` is the authoritative semantic validator and adds checks that JSON Schema alone cannot express: source identity, cross-field timestamps, fixed-point reconciliation, source/data hashes, quality thresholds and summaries.

The single JSON document contains:

- `schemaVersion: 1`: a backend transport contract, separate from the extension cache and npm version.
- `generatedAt`: canonical UTC build timestamp. **Not** proof that all sources are fresh.
- `producer`: exact repository, catalog workflow, commit SHA and Actions run ID (null for local execution).
- `rulesHash`: fingerprint of the unchanged production `src/catalog.js`, `src/lifecycle.js` and `src/ovh.js` files.
- `sources`: all seven source payloads and original URLs, `fresh`/`retained` status, `fetchedAt`, `attemptedAt`, row count, data and response hashes, structured failure code, consecutive failure count and first-failure time.
- `catalog`: reconciled entries, changes and bounded history. Entries include all inventory IDs/classifications, not only currently eligible chat models. Historical and classifier records are not silently removed.
- `summary`: the production reconciler's per-provider counts.
- `quality`: fresh/retained counts, fresh/degraded status and reviewed large declines.
- `integrity`: SHA256 of the canonical payload without the integrity field.

Canonicalization sorts object keys recursively, preserves array order and uses Node's JSON serialization/UTF-8. It is a project-specific deterministic encoding, not a claim to implement an external canonical-JSON standard. The whole deployed JSON file has a separate SHA256 transferred independently between build and deployment jobs.

`bodySha256` hashes the received decoded HTTP body before JSON normalization. `dataSha256` hashes the normalized published source payload. For the two broad registry sources, **all OpenCode models and their complete model records** are retained, while unrelated provider registries are omitted. The production rules only read this slice; offline tests prove identical reconciliation using full fixtures versus projected input. A response hash does not let clients reconstruct discarded unrelated providers.

Hashes detect corruption and cross-job substitution. A hash delivered with a file does not independently authenticate its origin; trust still depends on HTTPS, the controlled Pages deployment and repository/workflow governance.

## Fetching and last-known-good (LKG)

Only the fixed production metadata URLs and this site's fixed previous-snapshot URL are allowed. Requests are GET-only, anonymous, without credentials, with redirects disabled, a 20-second timeout and a 16 MiB decoded upstream body limit. Previous snapshots are bounded at 32 MiB. Source rows are limited to 10,000 (2,000 for each OVH inventory/catalog) before reconciliation to bound cross-record work; legitimate growth past these limits requires explicit review. Failures are not retried aggressively; the next scheduled run can recover. HTTP 429 is retained as a failure, not bypassed through IP rotation or alternate accounts. No inference requests are made.

GitHub Pages serves responses with a CDN cache lifetime (observed `max-age=600`). `Cache-Control: no-cache` alone did not avoid a warm edge returning the prior deployment during real refresh testing. Backend reads of the fixed previous-snapshot endpoint therefore append a freshly generated `catalog_read=<UUID>` query and request `cache: no-store`; the host/path remain fixed, caller-supplied queries are forbidden, and upstream source requests are unchanged. This is CDN metadata freshness handling, not inference rate-limit evasion. Public consumers using the plain URL can still see CDN lag; future extension integration must handle source ages explicitly.

Before fetching sources, the previous public snapshot must pass full contract, source, integrity, summary and production-rule validation. A corrupt, incompatible or unreachable previous snapshot is a **hard failure**, never permission to reset history. Rule changes require an explicit migration plan; they must not silently erase the old snapshot.

For each failed upstream, copy its complete previous valid payload, original successful `fetchedAt`, response/data hashes and row count. Only the attempt timestamp/failure bookkeeping changes. No timestamp is promoted to fresh merely because a new file was built. Healthy sources can update independently; production reconciliation receives the previous catalog state so retained price decisions and historical IDs remain intact.

Already-known lifecycle deadlines are applied at the actual new generation time. Keeping an old source does not freeze known retirement dates. Retention is metadata preservation, not a promise of continued inference entitlement or service availability.

If **all seven** sources fail, no replacement snapshot is deployed. If some fail but every source has valid LKG, a validated degraded snapshot may be deployed. There is no arbitrary TTL that pretends old data is new; age is transparent in each source's timestamps. This phase adds no client behavior or cache-expiration policy.

## Quality gates

HTTP 200/JSON syntax is insufficient. The backend reuses production source validation and verifies complete inventory representation, exact source URLs, hashes, valid UTC timestamps, source bookkeeping, production-rule reproducibility and summary equality. Histories, payload sizes and JSON nesting are bounded.

A decline of **more than 50%** in either a source's row count or a provider's eligible/free inventory compared with the previous snapshot blocks deployment and creates `rejected-candidate.json`. The eligibility baseline first applies already-known lifecycle deadlines at the current time, so a previously announced deadline alone is not mistaken for an unexplained price/catalog collapse.

This threshold is an operational review trigger, **not proof that the upstream is wrong**. It deliberately does not silently substitute stale data for a structurally valid newly paid/removed catalog. A maintainer must inspect the rejected candidate, public source evidence and report before rerunning manually with `approve_large_changes: true`. That switch only acknowledges the size-of-change gate; it does not bypass schema checks, missing bootstrap sources, unknown rules, hashes, source allowlists or security checks. Historical IDs remain in the reconciliation history even when fresh valid inventories no longer list them.

Smaller valid changes use normal production rules; unknown prices/capabilities remain unknown, not fabricated. A record's name is never the entitlement filter.

## Workflow and permissions

`.github/workflows/catalog.yml` runs at UTC minutes 7, 22, 37 and 52 each hour, with manual dispatch. GitHub scheduling can be delayed, dropped or disabled for inactive public repositories; 15 minutes is a desired cadence, not an availability guarantee. Monitor source ages and workflow failures, not just file generation times.

- Both jobs are guarded to the exact repository and `main`, and checkout the event SHA.
- A workflow-wide `catalog-pages` concurrency group covers collection and deployment. Running executions are not cancelled by newer ones; older pending runs may be replaced by GitHub's concurrency queue behavior.
- Collector permissions: `contents: read` only. It uses built-in Node modules and existing source/fixtures; **no dependency installation, npm credentials or OIDC write permission**.
- Deployment permissions: `contents: read`, `pages: write`, `id-token: write`, using the separate `github-pages` environment. This OIDC permission is for Pages, not npm.
- Official actions are pinned to full commit SHAs. Checkout does not persist credentials.
- The deployment job downloads the immutable same-run artifact ID with digest checks, inspects its tar without extracting paths, rejects traversal/symlinks/extra files/duplicates, verifies the independently transferred JSON SHA256, reruns contract validation, checks commit/run identity, then deploys that same artifact. No upstream collection/rebuilding occurs there. A final public verification makes at most six bounded GET attempts, checking exact file bytes, contract and commit/run identity after CDN propagation. If that final verification fails, deployment may already have succeeded; inspect the run rather than resetting history.
- Diagnostics last 14 days; Pages build artifacts last 7 days. Artifacts are forensic evidence, never the extension's public data endpoint.

A collector failure removes any stale local deployable output. The upload/deploy steps require success. The previously deployed Pages site remains the recovery state; failures never publish an empty replacement. No generated catalog files are committed into main every 15 minutes.

## Initial deployment

1. Enable this repository's GitHub Pages with **GitHub Actions** as its build source; use the standard project URL above.
2. Restrict the separate `github-pages` environment to the `main` branch. Do not reuse/change the npm-publish environment.
3. Wait for repository CI and all offline tests to pass.
4. Run **Catalog -> Run workflow -> main**, with `bootstrap: true` and `approve_large_changes: false`.
5. Bootstrap is accepted **only** if the previous endpoint returns HTTP 404 and **all seven real sources** fetch and validate successfully. No fixture, stale artifact or empty default can seed production. If the previous endpoint already exists, bootstrap is refused.
6. Independently download the deployed snapshot/schema, validate the snapshot and compare the exact file SHA256 with the workflow output. Confirm the resulting Pages URL.
7. Leave bootstrap false for all later scheduled/manual runs. Review several real cycles (preferably a day) before planning extension integration.

A genuinely lost Pages deployment, a rules/schema migration or a custom-domain move needs an explicit recovery/migration procedure. Do not abuse bootstrap to hide a failed previous-snapshot read.

## Local/offline testing

Use the pinned Node 22.19.0 or 26.0.0 runtime:

```sh
node ci/check.mjs
node --test ci/test/catalog*.test.mjs
node ci/lint-workflows.mjs
```

The tests exercise the existing factual fixtures, not real inference: direct-versus-snapshot parity; complete ID coverage; per-source outages; malformed/HTML/empty/duplicate payloads; HTTP 429/5xx; retained timestamps and recovery; known lifecycle deadlines; large-change review; corrupt/incompatible/absent previous state; response limits/timeouts/URL allowlists; actual CLI behavior in an isolated temporary git repository; cross-job hash checks and unsafe tar rejection; and workflow permissions/triggers.

The normal CI matrix also runs the separate preexisting extension tests and installed-TGZ Pi-loader checks. Backend files are repository-only and excluded by the existing package manifest. The npm package/version, lockfile, runtime source and shipped tests remain unchanged.

## Deliberately deferred

- Extension consumption of Pages, startup/manual refresh changes and direct-fetch fallback integration.
- Any model-routing/fallback, thinking or inference transport changes.
- npm version bumps, GitHub Releases, npm publishing and Trusted Publisher activation deadlines.

Official references:
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments

## Public verification after deployment

The Pages deploy action succeeding and the newly deployed bytes being visible
from a runner's CDN edge are separate events. The final verifier preserves exact
file SHA-256, snapshot contract/rules/integrity, producer commit/run and canonical
byte checks. It makes up to 18 cache-busted GETs with 10-second retry intervals,
within one 180-second monotonic budget. Each request/body is bounded by the
smaller of 20 seconds and the remaining overall budget. The deployment job keeps
its existing 10-minute limit and deployment action timeout; no integrity check is
weakened, and no redeploy/rebuild happens during verification.

Each attempt logs the stage, HTTP status, expected/received hash, received producer
identity, elapsed time and an allowlisted set of cache/CDN headers. Full metadata
bodies, cookies, authorization headers and arbitrary exception payloads are never
logged. `artifacts/catalog/live-verification.json` is uploaded as the
`catalog-live-verification` diagnostic artifact on success or failure (14-day
retention), and is not a runtime endpoint or part of the published catalog.
A final non-match still fails the job. Its red status does not itself mean the
deploy action failed or that Pages rolled the published file back. Check the
recorded attempt stages and producer identity before changing any configuration;
never reset history or bypass validation to make a delayed deployment green.
