# Ember Cloud Staging

This is the isolated Cloudflare Workers + Queues + Hyperdrive + Neon deployment for iOS acceptance. It is separate from Production and the existing Free Runtime PoC.

## Resource inventory

| Resource             | Staging value                                                            |
| -------------------- | ------------------------------------------------------------------------ |
| Neon project         | `ember-cloudflare-free-experiment` (`silent-boat-95177889`)              |
| Neon branch          | `staging` (`br-sparkling-bird-a1cfzgxs`), schema-only child branch       |
| PostgreSQL database  | `ember_staging`                                                          |
| Migration version    | `0018` (applied in order from an empty database; `0019` is not applied)  |
| API Worker           | `ember-cloud-api-staging`                                                |
| Async Runtime Worker | `ember-assistant-turn-runtime-staging`                                   |
| Hyperdrive           | `ember-staging-neon-hyperdrive` (ID is set after creation)               |
| Queue                | `ember-staging-assistant-turns` (`6de4ce5b63424458bf707322c9e84e3d`)     |
| Dead-letter Queue    | `ember-staging-assistant-turns-dlq` (`5fd4f3b60a19462996e208447bde9e91`) |
| Model execution      | `disabled`                                                               |
| Apple audience       | `com.basicv8vc.ember`                                                    |

The API and runtime share the Staging database through one `HYPERDRIVE` binding and use the dedicated Staging Queue pair. Never copy IDs from the Production or Free Runtime configs. No custom DNS route is configured; the API uses its Cloudflare `workers.dev` hostname.

## Prerequisites

1. Confirm `wrangler whoami` reports the intended Cloudflare account and Workers Paid is active.
2. Create a Neon SQL-scoped read/write role for `ember_staging`, with no `neon_superuser` membership, and grant only application DML on `public` and `ember_private`. Do not use the Console-created `ember_staging_runtime` role as an application identity; Neon assigns Console-created roles `neon_superuser` privileges.
3. Verify its `LOGIN` role has no `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`, or `BYPASSRLS` attributes and is not a member of `neon_superuser`.
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

If a Staging Queue is missing, create only that named Staging Queue with `wrangler queues create <name>`. Create Hyperdrive `ember-staging-neon-hyperdrive` once from the protected runtime credential, with TLS `verify-full`, query caching disabled, and an origin connection limit appropriate to the Neon Free compute. Record its ID, then set that same ID as `HYPERDRIVE` in both Worker configs. Do not put the credential on a logged command line or in source control.

## Deploy and verify

From the repository root, validate and deploy each Worker separately:

```sh
pnpm exec wrangler deploy --config apps/api/wrangler.staging.jsonc --dry-run
pnpm exec wrangler deploy --config apps/cloud-async-runtime/wrangler.staging.jsonc --dry-run
pnpm exec wrangler deploy --config apps/api/wrangler.staging.jsonc
pnpm exec wrangler deploy --config apps/cloud-async-runtime/wrangler.staging.jsonc
```

Deploy the API before enabling the queue consumer. Keep `EMBER_MODEL_EXECUTION=disabled` in the deployed Runtime. Record the Git SHA, Worker version IDs, and HTTPS hostname. Check `GET /healthz`, `GET /readyz`, and anonymous `GET /v1/me` (expected `401`):

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

Fill in the deployed HTTPS URL, SHA, resource IDs, exact migration-ledger result, verification outcomes, and any blockers after remote deployment. A local build or test result is not evidence that a Cloudflare Worker or Hyperdrive deployment succeeded.
