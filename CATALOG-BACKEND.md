# Central catalog backend and client boundary

The backend collects public Kilo and OVH metadata and publishes a self-contained GitHub Pages snapshot. Pi reads it at startup and explicit `/free-refresh`; inference goes directly to the selected model provider. The site is not an inference proxy. No provider credentials, inference calls, accounts or paid activation are needed for collection.

## Version 2 contract

The fixed client endpoint is:

```text
https://aminmzadev.github.io/pi-free-catalog/catalog/v2/latest.json
```

The site also contains `catalog/v2/schema.json` and the current build's run-specific proof file:

```text
catalog/v2/runs/<run-id>/<snapshot-sha256>.json
```

The proof and `latest.json` contain identical canonical bytes. The site is not an accumulating archive: later deployments can remove older proof paths, but do not overwrite a proof path with different snapshot bytes. Custom hosts and caller-supplied endpoint URLs are not accepted.

`ci/catalog/schema-v2.json` describes the envelope. The data-only contract in `src/snapshot-contract.js` is shared by client and backend; it has no CI dependencies or fetching. Its semantic validator additionally enforces source identities, hashes, producer identity, canonical UTC timestamps, complete inventories, fixed-point reconciliation, summaries, row/byte limits and quality gates.

The snapshot contains:

- `schemaVersion: 2`, separate from the local saved-cache schema and npm version;
- `generatedAt`, the observation/build time, not proof that every source is fresh;
- `producer`, including the repository, workflow, exact commit and run ID;
- `rulesHash`, fingerprinting `src/catalog.js`, `src/lifecycle.js` and `src/ovh.js`;
- `sources`, exactly `kilo`, `ovh`, and `ovhmeta`, with source URLs, complete payloads, fresh/retained status, original fetch times, latest attempt times, row counts, hashes and bounded structured failure records;
- `catalog`, with every remaining-provider inventory record, changes and bounded history, not merely a free-chat allowlist;
- `summary` and `quality`, reproduced and checked against the production rules;
- `integrity`, the SHA-256 of the canonical payload without its integrity field.

Object keys are sorted recursively; array order is preserved. This is a project-specific deterministic JSON encoding. The exact deployed file has a separate SHA-256 transferred from collection to the deployment job. Source `bodySha256` hashes decoded received bytes before JSON normalization; `dataSha256` hashes the complete normalized source payload.

Hashes detect corruption and substitution, not independent origin authentication. HTTPS and the controlled repository/deployment pipeline remain the trust boundary.

## Fetching and last-known-good

The production source allowlist contains three URLs:

```text
https://api.kilo.ai/api/gateway/models
https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models
https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2
```

Requests are anonymous GETs, with redirects disabled, 20-second request timeouts and a 16 MiB decoded upstream body limit. Previous snapshots are bounded at 32 MiB. Kilo rows are limited to 10,000 and each OVH inventory/catalog to 2,000 before reconciliation. Growth past a bound requires review. No inference or mutation is used to resolve a source failure.

Previous snapshots must validate before their LKG is used. A source failure preserves its complete previous payload, original successful `fetchedAt` and source hash, while updating the failure/attempt bookkeeping. It never pretends an old fetch is new. A missing LKG blocks publication. If all three sources fail, no replacement is deployed; partially retained data can produce an explicitly degraded, validated snapshot.

Large source-row or eligible-model declines require separate manual review. Time cannot move backwards. Fresh paid, withdrawn or retired evidence cannot be masked by the previous free set. Ordinary collection does not silently reset history.

The client can try direct recovery when Pages is unavailable, invalid, older than local source evidence or has source data older than 45 minutes. That threshold does not disable justified cached inference. There is no background metadata polling, prompt-triggered refresh, model-switch refresh or thinking-menu fetch. Concurrent startup/manual operations are deduplicated and shutdown cancels pending work.

## Reviewed v1 retirement and migration

The v2 artifact does not retain the old v1 feed or schema. Older extension packages are not modified or unpublished; they can use their existing direct-source fallback when v1 is unavailable.

A normal backend run first reads and validates v2. **Only a v2 HTTP 404** permits one attempt to read the fixed legacy v1 URL as migration input. A corrupt, incompatible, unauthorized, rate-limited, unavailable or unreachable existing v2 snapshot does not permit fallback to older rules or an empty starting state.

`src/legacy-snapshot.js` accepts only the published 0.1.7 production-rules fingerprint:

```text
5cf7d78a8622732cc69126b186ba814b5dc55b5458079e7323af6aaff157987d
```

It checks legacy envelope integrity and source inventory, removes only retired-provider data, preserves the remaining sources, entries, first-seen times and history, and constructs a version-2 candidate with the destination rules fingerprint. Full destination validation then checks exact Kilo/OVH URLs, source hashes, timestamps, semantic reconciliation, summaries and quality. This is a specific one-way migration, not acceptance of arbitrary old fingerprints or a disabled rules check.

An existing valid legacy deployment forbids bootstrap. Starting without either version requires explicit bootstrap and both endpoints returning HTTP 404; all three real sources must then validate. Corruption and network errors are not bootstrap permission. No fixtures or empty default can seed a production deployment.

The old v1 URL is read only for this missing-v2 migration. Neither the v2 client nor normal source collection contacts the removed provider's services.

## Exact artifact and public deployment verification

The collector builds the site once. Deployment downloads and verifies that exact artifact without rebuilding it. Tar inspection occurs without extraction and requires exactly the expected four files, safe directories/types, bounded sizes, identical latest/proof bytes, the expected file hash, valid contract, canonical representation and exact commit/run identity.

After `deploy-pages`, the workflow performs two distinct bounded public checks:

1. **Run-specific publication proof:** the unique run/hash URL must serve the exact expected bytes and identity. Missing or incorrect proof is a failure.
2. **Latest freshness:** the stable v2 URL must separately match the same exact snapshot. A validated canonical older run, or temporary unavailability, can be reported as **deferred**, with a warning and diagnostics. Corrupt, noncanonical, wrong-content same-run and unexpected newer-run data remain failures.

Deferral is never called verified. The workflow exports `latest_verified=false` and skips cleanup. Each public check retains the finite 18-attempt, 180-second overall, 20-second request policy; the deploy job allows 15 minutes for the two checks and the deployment action. Backend-generated UUID queries and no-store headers can reduce warm-edge caching but do not guarantee freshness at every CDN location.

## Guarded deployment-record cleanup

Cleanup requires successful unique proof and exact latest freshness. It retains all current/newest deployment protection, workflow provenance, repository/environment scope, complete-inventory, age, race, pacing, deletion-cap and deadline guards. Its dry-run output gates the apply step.

Public latest is rechecked during cleanup. If valid older data or temporary unavailability prevents exact confirmation, the operation explicitly defers and stops further mutations. It does not retry mutations, suppress arbitrary errors or hide actions already completed. A deferred preview sets `cleanup_ready=false` and blocks apply. Corrupt data, API failures, ambiguous inventory and race failures are not silently accepted.

Only bounded read operations are retried. No blanket `continue-on-error`, unbounded waiting, token forwarding to Pages or deployment-deletion replay is used.

## Verification and boundaries

Repository automation tests cover malformed/oversized/duplicate inventories, missing LKG, degraded retention, reviewed rule migration, corruption, semantic resealing, time rollback, large declines, exact tar validation, independent proof/freshness results, stale-data deferral, cleanup mutation prevention, provenance/race failures and finite budgets.

A frozen before/after golden comparison protects Kilo/OVH reconciliation and eligibility. Upgrade tests exercise plain/gzip saved caches and actual pool persistence, keeping remaining settings, cooldowns and OVH accounting without implicit re-enablement or a cycle refund.

The CI matrix verifies source behavior, automation, exact package contents and the real clean-installed Pi loader. Backend/workflow files remain outside the npm package; runtime modules never import `ci/`. Offline fixtures and SDK/session tests are not live provider certification.

The Catalog schedule and job permissions are unchanged. A source change does not by itself publish an npm version, create a GitHub Release or authorize an extra workflow dispatch.
