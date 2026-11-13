# Ember Cloud

Ember Cloud is the only shared cloud environment for development, verification, and Private Alpha. The existing Cloudflare Workers, Queues, Hyperdrive, and Neon branch whose provider names include `staging` continue to serve the existing HTTPS endpoint. Those names are implementation details; no Production or historical PoC resource is a release target.

## Existing resources

| Resource                         | Existing Ember Cloud target                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| API endpoint                     | <https://ember-cloud-api-staging.10kpaper.workers.dev>                              |
| Neon project / branch / database | `silent-boat-95177889` / `staging` (`br-sparkling-bird-a1cfzgxs`) / `ember_staging` |
| API Worker                       | `ember-cloud-api-staging`                                                           |
| Async Runtime Worker             | `ember-assistant-turn-runtime-staging`                                              |
| Hyperdrive                       | `ember-staging-neon-hyperdrive` (`f7da9cff26b843fda8187764f9b81b25`)                |
| Queue / DLQ                      | `ember-staging-assistant-turns` / `ember-staging-assistant-turns-dlq`               |
| Apple audience                   | `com.basicv8vc.ember`                                                               |

The API and Runtime share the existing Neon database through Hyperdrive and use the existing Queue pair. Keep the endpoint stable for the iOS app. Do not create a second cloud environment or copy resources from the legacy `production` branch or Free Runtime PoC.

## Develop and deploy

From the repository root:

```sh
pnpm cloud:deploy -- --dry-run
pnpm cloud:deploy
```

The deploy command checks Wrangler and Neon access, confirms the existing internal model secrets are present, builds both Worker bundles, applies pending repository migrations to Neon branch `staging` with role `ember_staging_migrator`, deploys the API, verifies API/database readiness and anonymous auth, then deploys the Async Runtime and repeats the API checks. A failed deploy or health check rolls affected Workers back to their previously active Cloudflare versions. Database migrations remain forward-only; inspect and repair a failed migration before retrying.

Manual rollback uses the active version captured before the release:

```sh
pnpm --filter @ember/api exec wrangler deployments list --name ember-cloud-api-staging --config wrangler.staging.jsonc
pnpm --filter @ember/api exec wrangler rollback <previous-version-id> --name ember-cloud-api-staging --config wrangler.staging.jsonc --yes
pnpm --filter @ember/cloud-async-runtime exec wrangler deployments list --name ember-assistant-turn-runtime-staging --config wrangler.staging.jsonc
pnpm --filter @ember/cloud-async-runtime exec wrangler rollback <previous-version-id> --name ember-assistant-turn-runtime-staging --config wrangler.staging.jsonc --yes
```

The Cloudflare OAuth login and Neon CLI profile must have write access to the existing Worker and Admin access to project `silent-boat-95177889`. Migration credentials are obtained transiently from Neon CLI and are not written to files or logs. Provider keys and Tenant allowlists are Worker secrets, not source-controlled variables.

## Internal real-model testing

The Async Runtime uses OpenRouter → DeepInfra → `nvidia/nemotron-3.5-lightning`, with provider fallback disabled. Real calls run only for Tenant IDs explicitly listed in the Worker secret `EMBER_MODEL_ALPHA_TENANT_IDS`; missing or malformed allowlists fail closed. A Tenant allowlist permits that account's Conversations to continue across Turns, while API authentication and database tenant predicates continue to isolate every user's data.

Each Turn has a `$0.005` reservation ceiling and exactly one provider attempt. Daily ledger limits are `$0.25` per principal, `$1` per Tenant, `$1` global, and at most 60 Turns per principal. Queue redelivery remains available for recovery; the database reservation, one-send fence, attempt record, and idempotent outbox prevent a second paid send for an already-started Turn. OpenRouter's existing dedicated key retains its `$1` lifetime spend cap as the final provider-side limit. A missing or exhausted provider allowance surfaces as a failed Turn; the Runtime does not switch providers or bypass the cap.

Only the internal Tenant allowlist receives real model execution. Keep external Alpha users out of that allowlist. The API key is stored only as Cloudflare secret `EMBER_MODEL_API_KEY`; it must not appear in iOS configuration, source files, or logs.

## Private Alpha acceptance

Before inviting external users, verify Apple Sign In and authenticated `/v1/me`, create or restore a Conversation, complete at least five consecutive real Turns with `simulated=false`, verify prior messages are present in model context, and relaunch the iOS app to confirm transcript persistence. Check tenant isolation with a second account and verify that no internal test Conversation appears in its UI. Confirm the Neon recovery window remains enabled and that the OpenRouter key still has its `$1` lifetime cap.

For each release, the public checks are `GET /healthz` (200), `GET /readyz` (200 with `checks.database = "up"`), and anonymous `GET /v1/me` (401 `UNAUTHENTICATED`). The current code-level service label may still say `cloudflare-poc`; the stable workers.dev hostname and Cloudflare Worker version identify the deployed service.
