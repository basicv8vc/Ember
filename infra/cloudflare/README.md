# Ember V2 on Cloudflare

Ember runs on the **V2 Cloudflare-native runtime** (`AgentHeadDO`, `GlobalBudgetDO`, D1 recovery registry, Queues, and R2 artifact storage). V1 has been retired from this repository; no V1 data migration or V1 compatibility target remains.

## Active V2 Worker Configurations

- **Isolated V2 Staging**: [wrangler.v2-staging.jsonc](../../apps/api/wrangler.v2-staging.jsonc) (`ember-v2-staging`, custom domain `ember-v2-staging.slowfast.dev`, D1 `ember-v2-staging-recovery`, R2 `ember-v2-staging-blobs`, and `ember-v2-staging-*` queues).
- **Local V2 Dev**: [wrangler.local-v2.jsonc](../../apps/api/wrangler.local-v2.jsonc) for local `workerd` development via `pnpm run dev:v2:local`.

## Preflight, Smoke & Deployment Authorization

- **Preflight & dry-run (safe locally, zero cloud changes)**:
  ```sh
  pnpm run build
  node infra/cloudflare/v2-staging-preflight.mjs
  ```
- **Smoke check (V2-only by default)**:
  ```sh
  node infra/cloudflare/v2-staging-smoke.mjs
  ```
- **Deploying to `ember-v2-staging`**: `pnpm run deploy:v2:staging` runs `v2-staging-preflight.mjs --require-provisioned` before `wrangler deploy --config wrangler.v2-staging.jsonc`. Per `AGENTS.md`, any live Cloudflare deployment, secret change, or provider canary still requires explicit Founder/CTO approval.

## Repository Cleanup vs Live V1 Cloud Retirement Checklist

Removing V1 source code, `wrangler.staging.jsonc`, and `infra/staging` from the repository does **not** undeploy or delete live V1 resources in Cloudflare or Neon. This repository-cleanup PR intentionally makes **zero** cloud infrastructure changes; the Founder/Owner (or an explicitly authorized operator action) must verify and tear down any remaining live V1 resources separately:

- **Cloudflare Workers & Routes**: disable/delete `ember-cloud-api-staging` (custom domain `ember-api.slowfast.dev`), `ember-assistant-turn-runtime-staging` (including its 3 Cron Triggers, especially `* * * * *`), and legacy experiment Workers (`ember-cloud-api`, `ember-cloudflare-free-runtime-experiment`, `ember-daytona-smoke-staging`).
- **Cloudflare Queues, Hyperdrive & R2**: delete V1 queues (`ember-staging-assistant-turns*`, `ember-staging-agent-tasks*`, `ember-assistant-turns*`, `ember-staging-daytona-smoke`), V1 Hyperdrive bindings, and `ember-blobs-staging` (confirming no V2 binding overlaps — V2 staging uses `ember-v2-staging-*`).
- **Neon Projects**: delete `silent-boat-95177889` (`ember_staging`) and `soft-hat-19698091` once V1 Workers/Crons are stopped (no PG dump or V1→V2 migration is required per Founder decision to abandon V1 test data).
- **Secrets**: unbind/rotate any unused V1-only secrets (`DATABASE_URL`, legacy OpenRouter/Daytona staging secrets) after verifying V1 Workers are deleted.
