# OpenRouter Adapter and P1 Security Gates

| field                          | value                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| status                         | CTO-selected route recorded; paid Smoke remains blocked on remaining preflight gates |
| provider ID                    | `openrouter`                                                                         |
| approved model ID              | `nvidia/nemotron-3.5-lightning` (exact OpenRouter catalog ID; paid base model)       |
| upstream                       | DeepInfra only (`deepinfra`)                                                         |
| published price checked        | 2026-11-11: $0.06 / 1M input tokens; $0.16 / 1M output tokens                        |
| maximum B2 attempt estimate    | $0.000562 at 8,000 input / 512 output tokens                                         |
| approval window                | 2026-11-11 through 2026-11-12 UTC, inclusive                                         |
| paid calls made by this change | none                                                                                 |

This document supplements `L4B-FIRST-REAL-LLM-RESPONSE.md`. The time-limited CTO record is present in `APPROVED_REAL_MODELS` and `infra/staging/model-authorization.json`. The request pins `deepinfra`, disables provider fallback, sets `data_collection: "deny"`, requires `zdr: true`, and disables model reasoning. OpenRouter's current exact-model endpoint APIs list the DeepInfra endpoint in the ZDR catalog and list its price at $0.06/M input and $0.16/M output. At the B2 caps of 8,000 input and 512 output tokens, the rounded-up estimate is 562 micro-USD ($0.000562), below the $0.005 per-attempt ceiling. These are catalog facts, not account-specific qualification or proof of a completed request ([model endpoint list](https://openrouter.ai/api/v1/models/nvidia/nemotron-3.5-lightning/endpoints), [ZDR endpoint list](https://openrouter.ai/api/v1/endpoints/zdr), [provider pricing page](https://openrouter.ai/nvidia/nemotron-3.5-lightning/providers)).

The route's public provider metadata currently marks DeepInfra as no-training and zero-retention ([OpenRouter provider directory](https://openrouter.ai/providers)). The request also applies OpenRouter's per-request `data_collection: "deny"` and `zdr: true` filters. However, DeepInfra's [Terms of Service](https://deepinfra.com/terms) say its ZDR promise applies to models it hosts, while data sent to a third-party model made available through its service is governed by third-party terms. The public text does not clearly state whether that exception covers this NVIDIA model served on DeepInfra. Treat the route-level ZDR listing as verified metadata, but do not treat contractual no-training/ZDR applicability as verified until DeepInfra confirms the classification for this exact endpoint. Endpoint policy and price can change, so both must be checked again immediately before any real Smoke. This authorization does not enable execution: all resident Staging configuration stays `EMBER_MODEL_EXECUTION=disabled`.

## Provider and model policy

The adapter accepts an exact model ID from server configuration and pins the request to OpenRouter's Chat Completions URL. The API key is sent only as a server-side bearer header. Redirects and ambient credentials are disabled. The adapter sends one model ID, no model list, no tool declarations, no streaming request, and no automatic paid-model fallback. The approved reasoning setting is `none`, sent as `reasoning: { enabled: false }`.

The approved route is `only: ["deepinfra"]`, `allow_fallbacks: false`, `data_collection: "deny"`, `zdr: true`, and `require_parameters: true`. The adapter derives OpenRouter's `max_price` prompt/completion caps from the pinned DeepInfra rate row. If no endpoint satisfies the exact provider, data, ZDR, parameter, and price policy, the request must fail. See OpenRouter's [provider routing guide](https://openrouter.ai/docs/guides/routing/provider-selection) and [ZDR endpoint API](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints-zdr).

The exact endpoint metadata returned on 2026-11-11 identifies DeepInfra's `nvidia/nemotron-3.5-lightning` endpoint, `bf16` quantization, and prices of $0.06/M input and $0.16/M output. The adapter uses the provider-reported response cost when present, rounded upward to micro-USD. If usage is absent or malformed, the responder books the full reservation as unknown usage; if a valid token count is returned without provider cost, the estimate uses the pinned rate row.

## Authorization scope and effective budget

The code-owned approval marks this route `executionScope: "smoke_only"`. `loadWorkerConfig()` defaults to the trusted `resident_worker` purpose, so `apps/worker/src/index.ts` cannot resolve this model for the resident B2 responder. The dedicated `model:smoke` call site supplies `paid_smoke` directly in code; the purpose is not read from an environment variable, CLI option, or database value. The CLI hard-caps one Turn and also checks the approval's `maxPaidSmokeTurns` before it opens the Smoke database. The attempt ledger's `principalDailyTurns` is a separate daily budget.

The approval caps are $0.005 per attempt, $0.005 principal daily, $0.005 tenant daily, $0.005 global daily, and one principal Turn per UTC day. `maxPaidSmokeTurns: 1` is an independent CLI run limit. Runtime resolution checks all five budget dimensions against the code-owned caps. When Smoke budget variables are absent, the resolver uses the Smoke-only approval caps. For a resident Worker, absent variables still resolve to the existing Worker defaults ($0.25 principal, $1 tenant, $5 global, 60 principal Turns); those defaults exceed this approval and are refused. Staging preflight likewise evaluates absent variables at their actual Worker defaults and refuses values above the approval. Setting lower explicit limits is accepted.

## Server configuration

The configuration contract remains provider-neutral:

```dotenv
EMBER_MODEL_EXECUTION=disabled
EMBER_MODEL_PROVIDER=openrouter
EMBER_MODEL_ID=nvidia/nemotron-3.5-lightning
EMBER_MODEL_API_KEY=<secret-store reference; isolated Smoke environment only>
```

Do not put the key in iOS configuration, client logs, application logs, checked-in files, or client-visible evidence. The normal Staging Worker must not receive or use the Smoke key. Configure the key only in the isolated Smoke execution environment after secure delivery and all other preflight gates pass. Compose continues to blank the credential for API, migration, and edge containers.

Switching any isolated process to `real` is still refused unless the exact dated code approval, exact provider/model price row, route policy, valid server credential, and budget ceilings all pass. The first real Smoke also requires a matching `EMBER_MODEL_SMOKE_APPROVAL`. Keep the resident Staging Runtime disabled. Do not extend the dated authorization without a new CTO approval.

## P1-A — re-check authorization at every outbound boundary

Boot-time resolution is not a permanent grant. Both real adapters synchronously re-check the live authorization immediately before `fetch`. The callback re-evaluates the approval's UTC-day expiry, price provenance, and model shutdown date. A retry or subsequent provider attempt passes through the same check.

If approval expires after an attempt row is reserved but before the request is sent, the adapter returns `not_sent`; the responder releases that reservation and terminates the Turn without retrying. If a request already left the process before expiry, its outcome remains billed or unknown-billed under the existing audit rules; expiry blocks new requests, not settlement of an in-flight request.

## P1-B — isolate the first real Smoke

The `model:smoke` command is one-shot and does not start the resident Worker loop. It requires a dedicated `EMBER_MODEL_SMOKE_DATABASE_URL` whose database name differs from `DATABASE_URL`, rejects a Smoke database containing any assistant Turn, and refuses if an `ember` or `ember-worker` connection is present. It then creates one Turn, passes that exact Turn identity as `onlyTurn`, sets the responder's attempt ceiling to one, and runs one responder pass. Evidence fails unless exactly one Turn was examined and exactly one attempt numbered 1 was written and settled.

A normal Worker uses `DATABASE_URL`; never point it at the Smoke database. Provision and migrate a fresh dedicated database before the run. A separate schema in a Worker-visible database is not sufficient isolation because the candidate poller can still see pending Turns.

Because the approval is not globally consumed across Smoke databases, operators must treat it as one-shot and obtain fresh CTO approval before any second Smoke, including on a new or reset database.

## CTO checklist for a future first real Smoke

Every item must be recorded before the operator runs the Smoke:

1. Confirm the exact current approval ID, model `nvidia/nemotron-3.5-lightning`, upstream `deepinfra` only, expiry 2026-11-12 UTC inclusive, no provider fallback, `data_collection=deny`, ZDR required, and reasoning disabled.
2. Re-check the exact DeepInfra endpoint's ZDR eligibility, price, and supported parameters. Obtain authoritative confirmation that DeepInfra's no-training/ZDR commitments apply to its hosted `nvidia/nemotron-3.5-lightning` endpoint despite the third-party-model clause; also verify OpenRouter account eligibility, balance, and the dedicated key's cumulative $1 spending limit without exposing the key in chat, logs, or Git.
3. Pass the complete Unit, PostgreSQL 17 Integration, and E2E suites; obtain independent PR review; verify the exact reviewed HEAD and current code/manifest parity, including `smoke_only` scope and all five budget ceilings.
4. Confirm the 8,000-input / 512-output worst-case reservation is $0.000562, below $0.005, and that the Smoke permits one run Turn, one principal Turn per UTC day, and exactly one provider attempt.
5. Configure `EMBER_MODEL_API_KEY` only in an isolated Smoke environment. Provision a fresh PostgreSQL 17 Smoke database, apply required migrations, verify it differs from `DATABASE_URL`, contains no assistant Turns, and has no resident Worker connections. Confirm the normal Worker cannot access it.
6. Keep the normal Staging Runtime at `EMBER_MODEL_EXECUTION=disabled`. Review the printed Smoke plan (approval ID, provider/model, price version, database target, one Turn, one attempt, and cost ceiling). The operator must restate the approval ID in `EMBER_MODEL_SMOKE_APPROVAL` and pass `--confirm`.
7. Only after all checks pass, submit `PREFLIGHT_PASS` to the CTO. Then run exactly `pnpm model:smoke -- --max-turns=1 --confirm`. Stop after the result, reconcile the provider dashboard with the single attempt, and attach content-free evidence. Never automatically rerun an uncertain or failed Smoke.

## Verification covered by this Draft

Mock-only adapter tests cover the fixed origin, exact model and provider route, credentials placement, reported and estimated usage, malformed usage, invalid response bodies, HTTP 401/403/408/429/5xx mapping, transport failure, abort, and authorization changes between attempts. Responder tests cover retry refusal and reservation release; PostgreSQL integration tests cover provider ID audit persistence, budget hard refusal, and exact-Turn scoping. The E2E path uses no real model request. No `model:smoke` command was run.
