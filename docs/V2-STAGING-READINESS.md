# Ember V2 — Isolated Staging Readiness, Cost Estimate & Rollback Plan

Status: **Approved & deployed to isolated Cloudflare staging (`https://ember-v2-staging.slowfast.dev`, Version `0a8a0216-5daa-4300-8e6a-531aea090d8c`, `EMBER_MODEL_MODE="fake"`).**  
Owner: Agent A (Infrastructure, Runtime Reliability & Cost)  
Baseline: `origin/main @ 0355f66` + `feat/alpha-a4-v2-staging-deploy` (2026-11-20)  
Related: [Final Deployment Authorization Request](./V2-STAGING-DEPLOYMENT-AUTHORIZATION.md), [Product Alpha Roadmap](./product/PRODUCT-ALPHA-ROADMAP.md), [ADR-0006](./adr/0006-experience-first-device-powered-runtime-v2.md), [V1 Ember Cloud](./cloud-staging.md), [M1-A7 Cost & Recovery Report](./architecture/v2-m1-a7-opt8-alarm-recovery-report.md)

---

## 1. Approval Request Summary

No cloud resources have been created or modified. This document requests **separate CTO/Owner approval** for an **isolated V2 staging environment** on the existing Cloudflare account:

- **Requested scope (Stage 1 — Fake-provider cloud staging):**
  - Provision 1 isolated Worker (`ember-v2-staging`), 1 isolated D1 database (`ember-v2-staging-recovery`), and 4 isolated Queues (`ember-v2-staging-durable-turn`, `ember-v2-staging-agent-task`, and their DLQs).
  - Run with `EMBER_MODEL_MODE="fake"` only (`0` external LLM or Daytona spend).
  - Keep `workers_dev: false` and `preview_urls: false` until routing/auth is approved.
- **Explicitly NOT requested here (require separate approvals):**
  - Real LLM / OpenRouter / Daytona provider-canary calls.
  - V1 traffic cutover, iOS endpoint repointing, or Neon V1-to-V2 user migration.
  - Any modification to V1 Workers, Queues, Hyperdrive, R2, or Neon `ember_staging`.

---

## 2. Isolated Resource Inventory (Zero V1 Overlap)

Configuration file: [wrangler.v2-staging.jsonc](../apps/api/wrangler.v2-staging.jsonc).  
Automated isolation check: [v2-staging-preflight.mjs](../infra/cloudflare/v2-staging-preflight.mjs).

| Resource                 | Existing V1 Ember Cloud (Untouched)                                       | Proposed V2 Staging (Isolated)                                             |
| ------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| API / Runtime Worker     | `ember-cloud-api-staging`, `ember-assistant-turn-runtime-staging`         | `ember-v2-staging`                                                         |
| Durable Objects (SQLite) | None                                                                      | `AGENT_HEAD` (`AgentHeadDO`), `GLOBAL_BUDGET` (`GlobalBudgetDO`)           |
| Database                 | Neon `ember_staging` via Hyperdrive `f7da9cff26b843fda8187764f9b81b25`    | D1 `ember-v2-staging-recovery` (`D1_RECOVERY`)                             |
| Queues + DLQs            | `ember-staging-assistant-turns`(+dlq), `ember-staging-agent-tasks`(+dlq)  | `ember-v2-staging-durable-turn`(+dlq), `ember-v2-staging-agent-task`(+dlq) |
| R2 Buckets               | `ember-blobs-staging`                                                     | None (deferred until artifact upload staging slice)                        |
| Public Route             | `ember-api.slowfast.dev` / `ember-cloud-api-staging.10kpaper.workers.dev` | Disabled (`workers_dev: false`) until approved                             |
| Cron                     | `*/30`, `0 */6`, `* * * * *` (V1 async runtime)                           | `* * * * *` (V2 independent `RecoverySweeper`)                             |
| Model Provider           | OpenRouter (V1 Private Alpha)                                             | `fake` (`EMBER_MODEL_MODE="fake"`)                                         |

Local dry-run verification (zero cloud calls):

```sh
pnpm build
node infra/cloudflare/v2-staging-preflight.mjs
pnpm run test:unit -- tests/unit/v2-staging-preflight.test.ts
```

---

## 3. Cost Estimate (Measured Local Telemetry vs. Estimated Cloud Staging)

> **Evidence boundary:** Local `workerd` write/read counts are **measured** ([m1-cost-reestimation.json](../benchmarks/v2-m1/m1-cost-reestimation.json)). Cloudflare monthly dollar totals are **model estimates** based on ADR-0006 pricing, not production invoices. Speculative runtime optimization is frozen per the Product Alpha roadmap.

### 3.1 Isolated V2 Staging (1–5 internal testers, `< 5,000` turns/month, fake provider)

| Meter                                | Workers Paid Included Allowance       | Estimated Staging Usage (5k turns/mo)   | Estimated Incremental Cost                         |
| ------------------------------------ | ------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| Workers Paid base fee                | $5/mo (already active for V1 account) | Shared account plan                     | **$0 incremental**                                 |
| Workers requests                     | 10,000,000 / mo                       | ~50,000 (incl. 43,200 1-min cron ticks) | $0.00                                              |
| DO requests                          | 1,000,000 / mo                        | ~25,000                                 | $0.00                                              |
| DO SQLite rows written               | 50,000,000 / mo                       | ~215,000 (43 rows/event measured)       | $0.00                                              |
| DO SQLite rows read                  | 25,000,000,000 / mo                   | ~1,310,000 (262 rows/event measured)    | $0.00                                              |
| DO SQLite storage                    | 5 GB-month                            | < 0.05 GB                               | $0.00                                              |
| D1 rows written                      | 5,000,000 / mo                        | ~3,000 (0.6 writes/event measured)      | $0.00                                              |
| Queues operations                    | 1,000,000 / mo                        | ~15,000 (3 ops/durable msg)             | $0.00                                              |
| External LLM / Daytona               | N/A                                   | Disabled (`EMBER_MODEL_MODE="fake"`)    | $0.00                                              |
| **Total estimated V2 staging delta** | —                                     | —                                       | **~$0/mo** (well inside ADR-0006 `$10/mo` PoC cap) |

### 3.2 Reference Scale Projections (from M1-A7 `m1-cost-reestimation.json`)

- `1k MAU`: `$7.72/mo`
- `10k MAU`: `$316.77/mo` Durable B1 / `$287.08/mo` Fast Path (target `<= $300/mo`)
- `100k MAU`: `$3,643.88/mo` Durable B1 / `$3,398.04/mo` Fast Path (target `<= $3,500/mo`)

---

## 4. Pre-Deploy Code Gates (Required Before Live Staging Deploy)

`wrangler.v2-staging.jsonc` currently bundles `apps/api/src/local-v2/runtime-worker.ts` cleanly in `--dry-run`, and **intentionally fails closed** if deployed as-is. Before live deployment (after approval), these small code slices must land:

1. **Health & Readiness probes (`/healthz`, `/readyz`):** ✅ Implemented on V2 edge/runtime worker (`GET /healthz`, `GET /readyz` probing `D1_RECOVERY` via `SELECT 1`).
2. **Staging-safe host/auth guard:** ✅ Implemented via `resolveV2AllowedHosts` (`ember-v2-staging.slowfast.dev`) and `createStagingV2Sessions` (Apple Sign In RS256 JWKS + D1 nonce replay fence + `DENY_DEV_PROVIDER` + optional `EMBER_V2_STAGING_ALLOWED_SUBJECTS`).
3. **Configurable queue names in `runtime-worker.ts`:** ✅ Implemented via `resolveV2QueueTarget` and `EMBER_V2_*_QUEUE_NAME` env vars in `wrangler.v2-staging.jsonc`.

---

## 5. Deployment Checklist (Post-Approval Only)

Run **only after** CTO/Owner approves cloud staging provisioning and the §4 code gates are merged:

1. **Provision isolated Cloudflare resources (one-time):**
   - `wrangler d1 create ember-v2-staging-recovery` → record returned `database_id` in `apps/api/wrangler.v2-staging.jsonc`.
   - `wrangler queues create ember-v2-staging-durable-turn`
   - `wrangler queues create ember-v2-staging-durable-turn-dlq`
   - `wrangler queues create ember-v2-staging-agent-task`
   - `wrangler queues create ember-v2-staging-agent-task-dlq`
2. **Run strict preflight (must pass with `--require-provisioned`):**
   ```sh
   pnpm build
   node infra/cloudflare/v2-staging-preflight.mjs --require-provisioned
   ```
3. **Apply D1 recovery migration (forward-only):**
   ```sh
   pnpm --filter @ember/api exec wrangler d1 migrations apply D1_RECOVERY --remote --config wrangler.v2-staging.jsonc
   ```
4. **Capture previous Worker version (for existing deployments):**
   ```sh
   pnpm --filter @ember/api exec wrangler deployments list --name ember-v2-staging --config wrangler.v2-staging.jsonc --json
   ```
5. **Deploy Worker:**
   ```sh
   pnpm --filter @ember/api exec wrangler deploy --config wrangler.v2-staging.jsonc --message "Ember V2 isolated staging"
   ```
6. **Post-deploy verification:**
   - `GET /healthz` → `200` (`{ "status": "ok" }`)
   - `GET /readyz` → `200` (`checks.d1_recovery = "up"`)
   - Anonymous `GET /v1/me` → `401 UNAUTHENTICATED`
   - Synthetic fake-provider turn + `RecoverySweeper` cron check; confirm V1 `https://ember-api.slowfast.dev/healthz` and `/readyz` remain `200`.

---

## 6. Rollback & Teardown Checklist

- **Immediate Worker rollback (code defect or failed post-deploy check):**
  ```sh
  pnpm --filter @ember/api exec wrangler rollback <previous-version-id> --name ember-v2-staging --config wrangler.v2-staging.jsonc --yes
  ```
- **Schema compatibility rule:** D1 migrations (`packages/runtime-v2/migrations/`) and DO SQLite migrations (`v1`+) are forward-only; never drop or rename columns in place during a staging rollout. If a migration fails, inspect and repair before retrying.
- **Zero-impact isolation guarantee:** Because `ember-v2-staging` shares zero bindings, queues, databases, or routes with V1, rolling back or deleting `ember-v2-staging` cannot disrupt V1 Ember Cloud or Neon `ember_staging`.
- **Full environment teardown (if staging is aborted):**
  1. Delete Worker `ember-v2-staging` (stops cron + queue consumers).
  2. Delete the 4 `ember-v2-staging-*` queues.
  3. Delete D1 database `ember-v2-staging-recovery`.
- **Note on future V1→V2 migration:** Per ADR-0006, a routing flip alone is not rollback once real user state moves. Real-user migration is explicitly out of scope for isolated staging.
