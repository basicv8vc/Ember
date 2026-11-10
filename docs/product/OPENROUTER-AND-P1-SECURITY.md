# OpenRouter Adapter and P1 Security Gates

| field                          | value                                                         |
| ------------------------------ | ------------------------------------------------------------- |
| status                         | Draft implementation; real execution remains disabled         |
| provider ID                    | `openrouter`                                                  |
| candidate model ID             | `openai/gpt-5.6-luna` (exact OpenRouter catalog ID)           |
| candidate price checked        | 2026-11-10: $0.20 / 1M input tokens; $1.20 / 1M output tokens |
| approved model IDs             | none                                                          |
| paid calls made by this change | none                                                          |

This document supplements `L4B-FIRST-REAL-LLM-RESPONSE.md`. A verified catalog price and a working adapter do not approve a paid call. `APPROVED_REAL_MODELS` and `infra/staging/model-authorization.json` stay empty, and staging continues to default to `EMBER_MODEL_EXECUTION=disabled`.

## Provider and model policy

The adapter accepts an exact model ID from the server configuration. Its endpoint is pinned to OpenRouter's Chat Completions URL; the API key is sent only as a server-side bearer header. Redirects and ambient credentials are disabled. The adapter sends no model list, tool declarations, streaming request, caller-controlled model choice, or automatic paid-model fallback.

The candidate OpenRouter route is recorded in the model approval as `only: ["openai"]`, `allow_fallbacks: false`, `data_collection: "deny"`, `zdr: true`, and `require_parameters: true`. The adapter also derives OpenRouter's `max_price` prompt/completion caps from the pinned rate row. This leaves OpenRouter's transport in place while restricting inference to eligible OpenAI endpoints at or below the reviewed rates. If no endpoint satisfies the reviewed policy, the request fails. OpenRouter documents these routing and data-handling controls in its [provider routing guide](https://openrouter.ai/docs/guides/routing/provider-selection) and [data-residency guide](https://openrouter.ai/blog/insights/ai-data-residency/).

OpenRouter's current catalog lists `openai/gpt-5.6-luna` at $0.20 per million input tokens and $1.20 per million output tokens ([model page](https://openrouter.ai/openai/gpt-5.6-luna)). The rate row records this price as provenance, not permission. The adapter disables automatic prompt-cache breakpoints for this rate row and uses OpenRouter's reported response cost when present, rounded upward to micro-USD; if its usage is absent or malformed, the existing responder books the full reservation as unknown usage. The rate-based estimate remains the fallback when a valid token count is returned without a provider cost.

Before adding an approval, the CTO must confirm the selected provider endpoint is available under the account and acceptable for the intended prompts. OpenRouter sends requests to the selected inference provider, whose terms govern provider processing; OpenRouter's privacy statement says it does not train on API inputs/outputs, but that does not replace the routed provider's terms ([privacy](https://openrouter.ai/pt-BR/privacy), [terms](https://openrouter.ai/zh-CN/terms)). `thinkingmachines/inkling-2-small:free` is not a chat candidate; do not use it for ordinary chat unless its current usage terms are re-reviewed and explicitly approved.

## Server configuration

The configuration contract remains provider-neutral:

```dotenv
EMBER_MODEL_EXECUTION=disabled
EMBER_MODEL_PROVIDER=openrouter
EMBER_MODEL_ID=openai/gpt-5.6-luna
EMBER_MODEL_API_KEY=<secret-store reference; worker only>
```

The API key must be provisioned only in the server Worker execution environment. Do not put it in iOS configuration, client logs, application logs, checked-in files, or client-visible evidence. Compose continues to blank the credential for API, migration, and edge containers. Keep the OpenRouter key in the deployment secret store and pass it through the existing `EMBER_MODEL_API_KEY` variable.

Switching to `real` is still refused unless all of the existing gates pass: exact code-side approval with dates, exact provider/model price row, provider-specific routing policy, valid server credential, and budget ceilings. The first live smoke also requires a matching `EMBER_MODEL_SMOKE_APPROVAL`. Do not add approval records or turn on `real` as part of adapter implementation.

## P1-A — re-check authorization at every outbound boundary

Boot-time resolution is not a permanent grant. Both real adapters call the live authorization callback synchronously immediately before `fetch`. The callback re-evaluates the approval's UTC-day expiry, price provenance, and model shutdown date. A retry or subsequent provider attempt passes through the same check.

If approval expires after an attempt row is reserved but before the request is sent, the adapter returns `not_sent`; the responder releases that reservation and terminates the Turn without retrying. If a request already left the process before expiry, its outcome remains billed or unknown-billed under the existing audit rules; expiry blocks new requests, not settlement of a request already in flight.

## P1-B — isolate the first real smoke

The `model:smoke` command is one-shot and does not start the resident Worker loop. It requires a dedicated `EMBER_MODEL_SMOKE_DATABASE_URL` with a database name different from `DATABASE_URL`, rejects a smoke database containing any assistant Turn, and refuses if an `ember` or `ember-worker` connection is present. It then creates one Turn, passes that exact Turn identity as `onlyTurn`, sets the responder's attempt ceiling to one, and runs one responder pass. Evidence is marked failed unless exactly one Turn was examined and exactly one attempt numbered 1 was written and settled.

A normal Worker uses `DATABASE_URL`; never point it at the smoke database. Provision and migrate a fresh dedicated database before the run. The database check is intentionally stricter than choosing a separate schema: a separate schema in a Worker-visible database would not isolate candidate polling.

## CTO checklist for a future first real smoke

Every item must be recorded before the operator runs the smoke:

1. Approve exact provider `openrouter`, exact model ID `openai/gpt-5.6-luna`, dated expiry, official price source, and the complete provider route (`openai` only, no provider fallback, `data_collection=deny`, ZDR required).
2. Re-check current price, endpoint eligibility, OpenRouter and upstream provider terms, expected data handling, and account limits. Confirm the intended prompt is allowed by both providers.
3. Add the same decision to `APPROVED_REAL_MODELS` and `infra/staging/model-authorization.json`; keep all ceilings at or below the existing $0.005 per-attempt and one-smoke-Turn limits. Do not list another model as a fallback.
4. Store the OpenRouter key in the Worker server secret store. Confirm it is absent from iOS bundles, API/edge/migration environments, logs, and Git.
5. Provision a fresh isolated PostgreSQL database, apply migrations through `0019`, set `EMBER_MODEL_SMOKE_DATABASE_URL`, and confirm it differs from runtime `DATABASE_URL`. Confirm it contains zero `assistant_turns` and no Worker is connected.
6. Review the printed plan (approval ID, provider/model, price version, database target, one Turn and per-attempt ceiling). The person executing must restate the approval ID in `EMBER_MODEL_SMOKE_APPROVAL` and pass `--confirm`.
7. Run only `pnpm model:smoke -- --max-turns=1 --confirm`. Stop after the result. Reconcile the provider dashboard/invoice with the single attempt and attach content-free evidence; do not automatically rerun a failed smoke.

## Verification covered by this Draft

Mock-only adapter tests cover the fixed origin and model, provider routing, credentials placement, reported and estimated usage, malformed usage, invalid response bodies, HTTP 401/403/408/429/5xx mapping, transport failure, abort, and authorization changes between attempts. Responder tests cover retry refusal and reservation release; PostgreSQL integration tests cover provider ID audit persistence, budget hard refusal, and exact-turn scoping. The E2E path uses no real model request. No `model:smoke` command was run.
