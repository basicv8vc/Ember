# Cloudflare Workers deployment and smoke test

This directory prepares the approved Workers Free + Hyperdrive test deployment for Issue #134.
It does not create resources, alter DNS, or run migrations. PR #138 must remain Draft.

## Deployment configuration

`apps/api/wrangler.jsonc` is the source of truth for Worker name, `workers.dev`, and non-secret Apple
verifier settings. It currently contains an all-zero Hyperdrive ID placeholder. The config leaves
`limits.cpu_ms` unset: Workers Free uses its 10 ms CPU default, while an explicit limit was rejected
by Cloudflare with error 100328 in the prior Free-plan probe.
After the authorized test database is available, create exactly one Hyperdrive config and replace
that placeholder with its ID before deployment. The test config must use the PG17 runtime role
`ember_worker`, a direct/unpooled PostgreSQL origin connection, and disabled query caching.

Use the Workers Free plan only. Check the final `workers.dev` URL before running the smoke test. If
Cloudflare presents a paid upgrade or any billable add-on, stop before accepting it or proceeding.

## Secret inventory

| Value                                                                                                                                                                     | Secret?          | Location/use                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBER_ENV=production`                                                                                                                                                    | No               | Wrangler `vars`; keeps the Worker on the production-policy path with dev sign-in denied.                                                 |
| `EMBER_APPLE_BUNDLE_ID=com.basicv8vc.ember`                                                                                                                               | No               | Wrangler `vars`; public iOS Bundle ID used as the exact token audience.                                                                  |
| `EMBER_APPLE_CLOCK_SKEW_SECONDS`, `EMBER_APPLE_MAX_TOKEN_AGE_SECONDS`, `EMBER_APPLE_JWKS_TIMEOUT_MS`, `EMBER_APPLE_JWKS_COOLDOWN_MS`, `EMBER_APPLE_JWKS_CACHE_MAX_AGE_MS` | No               | Wrangler `vars`; bounded verifier settings, no credentials.                                                                              |
| Worker-level secrets                                                                                                                                                      | None required    | Current API runtime does not need a separate application secret binding.                                                                 |
| `HYPERDRIVE.connectionString`                                                                                                                                             | Yes              | Private Hyperdrive binding to the test database; not exposed as a plaintext Worker `var`.                                                |
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
[Hyperdrive transaction pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/).

## Smoke test

The smoke runner accepts only an HTTPS `ember-cloud-api.*.workers.dev` URL. It does not disable TLS
verification, accept a custom domain, print response bodies, or log tokens, nonces, message text, or
database identifiers. Each result includes HTTP wall time; this is not Worker CPU time.

First run the no-credential preflight after deploy:

```sh
pnpm smoke:cloudflare -- --base-url https://ember-cloud-api.<account-subdomain>.workers.dev --mode preflight
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
  | pnpm smoke:cloudflare -- --base-url https://ember-cloud-api.<account-subdomain>.workers.dev --mode full
unset PRIMARY_APPLE_TOKEN PRIMARY_RAW_NONCE SECONDARY_APPLE_TOKEN SECONDARY_RAW_NONCE
```

`full` runs preflight, submits the primary Apple assertion concurrently twice (one session must win,
one must be rejected), verifies replay rejection and `/v1/me`, writes one synthetic B1 message,
retries its submission concurrently, reads the Unknown ACK receipt and transcript, then proves a
second Apple tenant sees the first tenant's conversation/submission as `NOT_FOUND`. The first
Apple-authenticated bootstrap provisions the main Conversation; there is no separate create
Conversation route. The message and running Turn remain as synthetic test rows in the test database.

Without a secondary identity, the runner reports tenant isolation as `NOT VERIFIED` and exits 2.
The runner does not inject a dev identity or bypass Apple verification. Cloud DB interruption/recovery,
cryptographic negative cases requiring Apple-signed fixtures, and performance percentiles remain
separate checks; a smoke pass does not claim those results.

## Deployment sequence

1. Confirm Agent D's PG17 Free test database and securely obtain its direct connection details.
2. Apply migrations `0001`–`0017` and the least-privilege role bootstrap on a separate direct
   connection. Never migrate through Hyperdrive transaction pooling.
3. Create exactly one uncached Hyperdrive config using the `ember_worker` role and update the
   placeholder binding ID in `apps/api/wrangler.jsonc`.
4. Run `pnpm --filter @ember/api build:worker` (dry-run), then deploy the one Worker with
   `pnpm deploy:api:worker`. Record the HTTPS `workers.dev` URL and redacted resource identifiers.
5. Run `preflight`, then `full`; only after core B1 and Apple checks pass, collect Cloudflare CPU,
   wall latency percentiles, Hyperdrive query latency, recovery, and low-concurrency measurements.
