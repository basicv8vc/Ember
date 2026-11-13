# Ember Cloud Staging

This is the isolated Cloudflare Workers + Queues + Hyperdrive + Neon deployment for iOS acceptance. It is separate from Production and the existing Free Runtime PoC.

## Resource inventory

| Resource             | Staging value                                                            |
| -------------------- | ------------------------------------------------------------------------ |
| Neon project         | `ember-cloudflare-free-experiment` (`silent-boat-95177889`)              |
| Neon branch          | `staging` (`br-sparkling-bird-a1cfzgxs`), schema-only child branch       |
| PostgreSQL database  | `ember_staging` (OID `24578`)                                            |
| Migration version    | `0018` (applied in order from an empty database; `0019` is not applied)  |
| API Worker           | `ember-cloud-api-staging`                                                |
| Async Runtime Worker | `ember-assistant-turn-runtime-staging`                                   |
| Hyperdrive           | `ember-staging-neon-hyperdrive` (`f7da9cff26b843fda8187764f9b81b25`)     |
| Queue                | `ember-staging-assistant-turns` (`6de4ce5b63424458bf707322c9e84e3d`)     |
| Dead-letter Queue    | `ember-staging-assistant-turns-dlq` (`5fd4f3b60a19462996e208447bde9e91`) |
| Model execution      | `disabled`                                                               |
| Apple audience       | `com.basicv8vc.ember`                                                    |

The API and runtime share the Staging database through one `HYPERDRIVE` binding and use the dedicated Staging Queue pair. The Runtime config sets `EMBER_TURN_DISPATCH_QUEUE_NAME` and `EMBER_TURN_DISPATCH_DLQ_NAME` to those same queue names; defaults still preserve the Free Runtime PoC contract. Never copy IDs from the Production or Free Runtime configs. No custom DNS route is configured; the API uses its Cloudflare `workers.dev` hostname.

## Prerequisites

1. Confirm `wrangler whoami` reports the intended Cloudflare account and Workers Paid is active.
2. Create a Neon SQL-scoped read/write role for `ember_staging`, with no `neon_superuser` membership, and grant only application DML on `public` and `ember_private`. Do not use the Console-created `ember_staging_runtime` role as an application identity; Neon assigns Console-created roles `neon_superuser` privileges.
3. Verify `ember_staging_runtime_app` has no `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`, or `BYPASSRLS` attributes and is not a member of `neon_superuser`.
4. Create the Hyperdrive config against the Neon `staging` branch and `ember_staging`, require TLS, and use the scoped runtime credential. Set `HYPERDRIVE_ID` in both Staging configs only after the config exists.
5. Verify the Queue and DLQ exist and have no Production/PoC consumers before deploying either Worker.

Do not put passwords, connection URIs, API tokens, or signing keys in these files, Git, PR descriptions, or logs. Set secrets with `wrangler secret put` from a protected local file or secure stdin.

## Verify provisioned resources

These checks are read-only. Create a resource only if the check shows it is absent; never recreate or repoint Production or PoC resources.

```sh
pnpm exec wrangler queues info ember-staging-assistant-turns
pnpm exec wrangler queues info ember-staging-assistant-turns-dlq
pnpm exec wrangler hyperdrive list
```

If a Staging Queue is missing, create only that named Staging Queue with `wrangler queues create <name>`. Create Hyperdrive `ember-staging-neon-hyperdrive` once from the protected runtime credential, with TLS `require` (encrypted; Cloudflare validates the server certificate with WebPKI), query caching disabled, and origin connection limit `5`. Cloudflare verify modes require uploading a CA certificate; they are not configured for this deployment. Record its ID, then set that same ID as `HYPERDRIVE` in both Worker configs. Do not put the credential on a logged command line or in source control.

## Deploy and verify

From the repository root, validate and deploy each Worker separately:

```sh
pnpm exec wrangler deploy --config apps/api/wrangler.staging.jsonc --dry-run
pnpm exec wrangler deploy --config apps/cloud-async-runtime/wrangler.staging.jsonc --dry-run
pnpm exec wrangler deploy --config apps/api/wrangler.staging.jsonc
pnpm exec wrangler deploy --config apps/cloud-async-runtime/wrangler.staging.jsonc
```

Deploy the API before enabling the queue consumer. Keep `EMBER_MODEL_EXECUTION=disabled` in the deployed Runtime. Its configured Queue/DLQ name variables must match the Wrangler consumer bindings exactly. Record the Git SHA, Worker version IDs, and HTTPS hostname. Check `GET /healthz`, `GET /readyz`, and anonymous `GET /v1/me` (expected `401`):

```sh
curl -i https://<STAGING_WORKERS_DEV_HOST>/healthz
curl -i https://<STAGING_WORKERS_DEV_HOST>/readyz
curl -i https://<STAGING_WORKERS_DEV_HOST>/v1/me
```

Verify the deployed API's Apple audience and database readiness, then run the isolated Fake Model queue flow against the Staging database and Queue. Restore and redeploy `EMBER_ENV=staging` plus `EMBER_MODEL_EXECUTION=disabled` immediately after that test. Never add a real provider key or run a paid model call as part of this runbook.

## Update and rollback

1. Deploy from a reviewed Git SHA, run the two dry-runs, then deploy the API and Runtime with their Staging configs.
2. Repeat the health, readiness, anonymous-auth, database, Queue, Turn persistence, and duplicate-delivery checks. Save the deployment SHA and Worker version IDs with the results.
3. If a deployment fails acceptance, list versions and roll back that Worker only:

   ```sh
   pnpm exec wrangler versions list --config apps/api/wrangler.staging.jsonc
   pnpm exec wrangler rollback <previous-version-id> --config apps/api/wrangler.staging.jsonc --name ember-cloud-api-staging
   ```

   Use `apps/cloud-async-runtime/wrangler.staging.jsonc` and `ember-assistant-turn-runtime-staging` for the Runtime. Do not alter Production, shared DNS, or existing PoC resources.

4. Check health and readiness again after rollback. Database migrations are forward-only here; do not delete data or run `0019` as part of this Staging deployment.

## Current acceptance record

Checked 2026-11-10. **STAGING READY for iOS Cloud/API integration and Fake Model acceptance. Real Apple sign-in and the real-model Smoke remain pending their separate authorization/credentials.**

- HTTPS Base URL: <https://ember-cloud-api-staging.10kpaper.workers.dev>
- Deployed source SHA: `8359cf68f6161dcfc78a514a43294f58af779b61` (includes integrated runtime code from `e1ae1d3f4acdc52e4c45a61bfb5f622829bbd9b3`). API version `6b3e8fb8-b1bd-40ff-a6d3-9405e54478c2`; Runtime version `63991c95-9702-499f-acc4-cf66c772f756`.
- Workers Paid is active. Both Workers use their isolated Staging configs; no custom DNS record was changed. Existing Production, Free PoC, old Queues, Hyperdrive configs, and Neon data were retained.
- Neon: project `silent-boat-95177889`, branch `br-sparkling-bird-a1cfzgxs`, database `ember_staging` (OID `24578`). The migration ledger has 18 entries through `0018`; `0019` is absent. Migrations `0001`–`0018` were applied in order from an empty Staging database, and the migration runner reports all 18 already applied on rerun.
- Runtime DB identity is `ember_staging_runtime_app` (the Hyperdrive user), with TLS required. Direct PostgreSQL TLS verification and Worker readiness both succeeded. The role has no elevated role attributes or `neon_superuser` membership, has no schema CREATE or migration-ledger access, and has only the application DML grants. The console-created `ember_staging_runtime` identity is not used by Hyperdrive.
- Hyperdrive: `ember-staging-neon-hyperdrive` / `f7da9cff26b843fda8187764f9b81b25`; TLS `require`, caching disabled, origin limit 5. Queue: `ember-staging-assistant-turns` / `6de4ce5b63424458bf707322c9e84e3d`; DLQ: `ember-staging-assistant-turns-dlq` / `5fd4f3b60a19462996e208447bde9e91`. Each is attached only to the Staging Workers.
- Live HTTP checks: `/healthz` `200`; `/readyz` `200` with database `up`; anonymous `/v1/me` `401`. Deployed Apple audience is `com.basicv8vc.ember`. No valid Apple identity token was available, so live Apple sign-in was not exercised. The existing health payload still labels its code version `cloudflare-poc`; deployment identity is recorded by the SHA and Cloudflare Worker version IDs above.
- Remote Fake E2E passed: a synthetic test session created a Turn (`201`); replaying the same client submission returned `200` with the identical receipt; the Queue consumer persisted one simulated reply and the API read the Turn as completed. Re-delivering the same Queue envelope left exactly one reply and the Turn completed. The test session was revoked afterward; the isolated test Turn remains as acceptance evidence. Queue backlog was zero after the check.
- The Runtime was temporarily deployed in the isolated test mode for Fake E2E, then restored as version `63991c95-9702-499f-acc4-cf66c772f756` with `EMBER_ENV=staging`, `EMBER_MODEL_EXECUTION=disabled`, and the Staging Queue/DLQ names. No provider secret or real/paid LLM call was used.
- Local verification on integrated code HEAD `e1ae1d3f4acdc52e4c45a61bfb5f622829bbd9b3`: unit tests passed (89 files, 1,564 tests), typecheck passed, and build passed. GitHub checks did not pass; the recorded #146/#147 jobs failed before workflow steps started, so this record does not claim CI success.

The Staging Cloud path is available to the iOS Lead at the HTTPS URL above. A local build or test result alone is not deployment evidence; the remote Worker, Hyperdrive, database, Queue, and HTTP results above are the deployment evidence.

## Staging Alpha real-model authorization (code-ready, disabled)

The Cloud Async Runtime has a separate, code-owned Alpha grant for OpenRouter model `nvidia/nemotron-3.5-lightning`, routed only to `deepinfra`. CTO re-approved this Staging Alpha scope on 2026-11-13 under `L4C3-B2-CLOUD-STAGING-ALPHA-2026-11-13`, valid through **2026-11-20 UTC inclusive**; after that date, obtain a fresh CTO approval instead of extending it. The existing `smoke_only` approval and its 2026-11-12 expiry remain unchanged, and neither grants real inference to the resident Node Worker.

The Staging Wrangler config keeps `EMBER_MODEL_EXECUTION=disabled`; it contains no API key or Alpha target. Before any separately approved enablement, create a synthetic test tenant and a new, empty Conversation, then configure the server-side `EMBER_MODEL_ALPHA_TENANT_ID`, `EMBER_MODEL_ALPHA_CONVERSATION_ID`, and `EMBER_MODEL_ALPHA_TURN_CREATED_AFTER` watermark before sending an iOS message. Set the watermark after any existing Turn in that Conversation. The Runtime selects the first Turn whose PostgreSQL `created_at` is later than the watermark, including terminal Turns, so historical Pending Turns and every later Turn stay unauthorized. The trusted Cloud Runtime callsite selects `staging_alpha`; environment variables, Queue envelopes, and iOS requests cannot select that purpose. Keep real user Conversations out of the allowlist.

B1 commits the Turn and its Outbox row together, then immediately sends a best-effort Queue wake. The Outbox Cron remains the recovery path if that wake fails. Configure and release the Runtime before submitting the iOS message; no post-submission redeploy is needed to discover the generated Turn ID.

The approval caps each provider attempt, principal, tenant, and global daily spend at **$0.005**, permits one principal daily Turn, binds the Turn to one provider attempt, and records a required **$1 lifetime limit** for the dedicated external API key. B2 persists that attempt ceiling at reservation time, so Queue redelivery or lease recovery cannot open another paid attempt after one has been reserved. Missing budget variables resolve to the approved ceilings; larger values refuse execution. Transport-level Queue redelivery remains for recovery but cannot authorize another provider attempt.

Before the first real call, the operator must use a dedicated OpenRouter API key with a **$1 USD key limit and no reset** (`limit_reset: null`), verify the limit and remaining allowance in OpenRouter, and store the key only as the Cloudflare Staging Runtime secret. OpenRouter documents per-key spending limits in its [Create API Key](https://openrouter.ai/docs/api/api-reference/api-keys/create-keys) and [Update API Key](https://openrouter.ai/docs/api/api-reference/api-keys/update-keys) APIs. This PR does not create, change, or install a key. Also confirm the approved provider privacy/routing requirements, verify that `0019_model_openrouter_provider.sql` is applied to the isolated Staging database, review the deployed Runtime SHA, and obtain CTO release approval. None of those operator actions or a paid call is performed by this change.
