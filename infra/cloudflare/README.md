# Cloudflare Workers deployment and smoke test

This runbook covers the isolated Staging configuration for PR #146. The API remains
PostgreSQL-first; Cloudflare Queues carry wake-up envelopes only, while the PostgreSQL outbox is
authoritative. No D1 binding or model execution is introduced. The active `ember-cloud-api` Worker
and its existing Hyperdrive are not deployment targets for this PR.

## Current environment evidence (2026-11-10)

- The existing Worker at `https://ember-cloud-api.10kpaper.workers.dev` passed the seven-check
  preflight. This is the previously deployed PR #138 version, not the branch described by the new
  API integration PR.
- A temporary remote Worker using the configured Hyperdrive binding connected to PostgreSQL 17.11
  as `ember_worker` (`session_user` matched), with `statement_timeout=5s`, no superuser flag, and no
  `neon_superuser` membership. The `0017` nonce schema/table exists and the role has nonce INSERT
  and DELETE privileges. The probe returned no connection string and did not use the rotated test
  owner credential.
- Migration `0018_b1_turn_dispatch_outbox.sql` is in the API branch but has not been applied to the
  Staging database. Migrations must use a separate authorized direct migration connection, never
  Hyperdrive. Do not deploy the outbox writer before `0018` and its minimal runtime grant are applied.
- Agent D created the isolated Queues `ember-staging-assistant-turns` and
  `ember-staging-assistant-turns-dlq`. A read-only Wrangler inventory showed zero producers and
  consumers on both. The existing `ember-assistant-turns` Queue already has a producer and consumer;
  Staging must not attach to it.
- No Staging API Hyperdrive exists in the current read-only inventory. The Staging Wrangler config
  uses a non-deployable ID placeholder until a dedicated API Hyperdrive for `ember_staging` is
  provisioned and verified.
- The signed Apple flow, nonce replay, tenant isolation, and message/Turn smoke still require fresh
  assertions from two disposable Apple test accounts. The iOS Lead owns that final live acceptance.

## Deployment configuration

`apps/api/wrangler.staging.jsonc` names the separate Worker `ember-cloud-api-staging`, sets
`EMBER_ENV=staging`, keeps Apple audience `com.basicv8vc.ember`, and binds
`TURN_DISPATCH_QUEUE` to `ember-staging-assistant-turns`. Its `HYPERDRIVE` binding must use a
dedicated Staging API Hyperdrive; the current ID is deliberately a placeholder. The package's
`dev:worker`, `build:worker`, and `deploy:worker` scripts all use this Staging config. No command in
this PR targets the active `ember-cloud-api` Worker.

Check the final `workers.dev` URL before running the smoke test. This PR creates no cloud resource,
changes no plan, and calls no model.

## Secret inventory

| Value                                                                                                                                                                     | Secret?          | Location/use                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBER_ENV=staging`                                                                                                                                                       | No               | Staging Wrangler `vars`; shared environment policy denies development sign-in.                                                           |
| `EMBER_APPLE_BUNDLE_ID=com.basicv8vc.ember`                                                                                                                               | No               | Wrangler `vars`; public iOS Bundle ID used as the exact token audience.                                                                  |
| `EMBER_APPLE_CLOCK_SKEW_SECONDS`, `EMBER_APPLE_MAX_TOKEN_AGE_SECONDS`, `EMBER_APPLE_JWKS_TIMEOUT_MS`, `EMBER_APPLE_JWKS_COOLDOWN_MS`, `EMBER_APPLE_JWKS_CACHE_MAX_AGE_MS` | No               | Wrangler `vars`; bounded verifier settings, no credentials.                                                                              |
| Worker-level secrets                                                                                                                                                      | None required    | Current API runtime does not need a separate application secret binding.                                                                 |
| `HYPERDRIVE.connectionString`                                                                                                                                             | Yes              | Dedicated Staging API Hyperdrive binding to `ember_staging`; not exposed as a plaintext Worker `var`.                                    |
| PostgreSQL migration credential                                                                                                                                           | Yes              | Separate controlled direct connection for migrations only. Never configure it in the Worker or Hyperdrive.                               |
| Apple identity token and raw nonce for smoke                                                                                                                              | Yes, short-lived | Passed to the smoke process through stdin, held in memory, and never printed or written to a report. Use a dedicated test Apple account. |
| Ember `ems_` session token                                                                                                                                                | Yes              | Created in memory by the smoke process; never printed or written to a report.                                                            |
| Cloudflare deploy authorization                                                                                                                                           | Yes              | Existing local Wrangler OAuth login only; it is not a Worker binding or repository secret.                                               |

No Worker-level secrets are required by the current API runtime. If a future change introduces one,
declare its name under Wrangler `secrets.required` and inject it with Cloudflare's `wrangler secret
put` prompt or the dashboard Secret field. Never pass its value as a shell argument, store it in
`vars`, or commit it. Hyperdrive credentials belong to the Hyperdrive configuration, not an
application `wrangler secret` binding.

Create the Hyperdrive config through the Cloudflare dashboard's official Hyperdrive form so the
database connection string is entered into Cloudflare's resource configuration instead of a shell
argument. Wrangler's `--connection-string`, `--password`, and `--origin-password` options put the
credential in process arguments and are not suitable for this handoff.

Official references: [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[Hyperdrive connection](https://developers.cloudflare.com/hyperdrive/get-started/), and
[Hyperdrive transaction pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/),
and [Queues pricing and included operations](https://developers.cloudflare.com/queues/platform/pricing/).

## Smoke test

The smoke runner accepts only an HTTPS `ember-cloud-api-staging.*.workers.dev` URL. It does not disable TLS
verification, accept a custom domain, print response bodies, or log tokens, nonces, message text, or
database identifiers. Each result includes HTTP wall time; this is not Worker CPU time.

First run the no-credential preflight after deploy:

```sh
pnpm smoke:cloudflare -- --base-url https://ember-cloud-api-staging.<account-subdomain>.workers.dev --mode preflight
```

Then run the B1 flow with two distinct test Apple accounts. Obtain each fresh identity token and the
matching raw nonce from the iOS test sign-in. Enter them silently in the shell; `printf` sends the
JSON through stdin, and the smoke runner consumes it without echoing or saving it:

```sh
read -rs PRIMARY_APPLE_TOKEN
read -rs PRIMARY_RAW_NONCE
read -rs SECONDARY_APPLE_TOKEN
read -rs SECONDARY_RAW_NONCE
printf '{"primary":{"identity_token":"%s","nonce":"%s"},"secondary":{"identity_token":"%s","nonce":"%s"}}' \
  "$PRIMARY_APPLE_TOKEN" "$PRIMARY_RAW_NONCE" "$SECONDARY_APPLE_TOKEN" "$SECONDARY_RAW_NONCE" \
  | pnpm smoke:cloudflare -- --base-url https://ember-cloud-api-staging.<account-subdomain>.workers.dev --mode full
unset PRIMARY_APPLE_TOKEN PRIMARY_RAW_NONCE SECONDARY_APPLE_TOKEN SECONDARY_RAW_NONCE
```

`full` runs preflight, submits the primary Apple assertion concurrently twice (one session must win,
one must be rejected), verifies replay rejection and `/v1/me`, rotates the Cloud Session, writes one
synthetic B1 message and deliberately drops the client connection after commit, recovers the Unknown
ACK, retries the exact submission, reads/cancels the Turn and transcript, then proves a second Apple
tenant sees the first tenant's Conversation/submission as `NOT_FOUND`. The first Apple-authenticated
bootstrap provisions the main Conversation; there is no separate create Conversation route. The
synthetic Message and cancelled Turn remain in the test database; no model is invoked.

Without a secondary identity, the runner reports tenant isolation as `NOT VERIFIED` and exits 2.
The runner does not inject a dev identity or bypass Apple verification. Cloud DB interruption/recovery,
cryptographic negative cases requiring Apple-signed fixtures, and performance percentiles remain
separate checks; a smoke pass does not claim those results.

## Deployment sequence

1. Obtain an authorized direct migration connection for the isolated Staging Neon database; do not
   use the old owner credential or the Worker/Hyperdrive connection.
2. Apply `0018_b1_turn_dispatch_outbox.sql`, then apply the `ember_worker` role bootstrap so it gains
   only `INSERT` on `public.b1_turn_dispatch_outbox`. Confirm the migration history and grants over
   the direct connection.
3. Use the existing isolated Queues `ember-staging-assistant-turns` and
   `ember-staging-assistant-turns-dlq`; keep the outbox relay and B2 Turn executor in Agent B's
   runtime, not in the API Worker.
4. Provision a dedicated Staging API Hyperdrive for `ember_staging`, replace the placeholder ID in
   `wrangler.staging.jsonc`, then run `pnpm --filter @ember/api build:worker` (dry-run). Deploy only
   the Worker named `ember-cloud-api-staging` and verify its runtime role through that Hyperdrive.
5. Run `preflight`, then have the iOS Lead perform `full` with two disposable Apple test accounts.
   Record only redacted resource identifiers and HTTP statuses; collect latency/recovery metrics in
   a later bounded run.
