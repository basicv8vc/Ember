# Ember V2 — Final Isolated Staging Deployment Authorization Request

- **Status:** **PENDING CTO / FOUNDER APPROVAL** (no cloud resources provisioned or deployed)
- **Date:** 2026-11-20
- **Owner:** Agent A (Infrastructure, Runtime Reliability & Cost)
- **Verified Baseline:** `origin/main @ febeabc` (`#203` V2 staging config/preflight + `#204` `/healthz`, `/readyz`, configurable queue routing)
- **Related:** [V2 Staging Readiness](./V2-STAGING-READINESS.md), [Product Alpha Roadmap](./product/PRODUCT-ALPHA-ROADMAP.md), [ADR-0006](./adr/0006-experience-first-device-powered-runtime-v2.md), [V1 Ember Cloud](./cloud-staging.md)

---

## 1. Requested Decision Summary

This request asks the CTO / Founder to authorize **Stage 1: Isolated V2 Cloud Staging (Fake Provider Only)**.

- **Authorized if approved:**
  1. One-time provisioning of the isolated Cloudflare V2 staging resources listed in §3.
  2. Implementing the final pre-deploy code gate (§5, staging host allowlist + approved auth scheme) and deploying `ember-v2-staging` with `EMBER_MODEL_MODE="fake"`.
  3. Running post-deploy `/healthz`, `/readyz`, anonymous `/v1/me` (`401`), fake-provider turn, and `RecoverySweeper` smoke verification against the isolated V2 staging endpoint.
- **Explicitly OUT OF SCOPE (require separate future approvals):**
  - Real LLM / OpenRouter / Daytona provider-canary calls (`$0` external provider spend in this request).
  - Any modification to V1 Ember Cloud (`ember-cloud-api-staging`, `ember-assistant-turn-runtime-staging`, `ember-api.slowfast.dev`, Neon `ember_staging`, R2 `ember-blobs-staging`).
  - Repointing production/Alpha iOS traffic or migrating any real V1 user state.

---

## 2. Environment Specification

| Property             | Value                                                                                                                                 | Notes                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Cloud account        | Existing Cloudflare Workers Paid account                                                                                              | Shared account plan; strictly isolated bindings                                                             |
| Environment label    | `EMBER_ENV="v2-staging"`                                                                                                              | Distinct from V1 `staging` and local `local`                                                                |
| Isolation guard      | `EMBER_V2_STAGING_ISOLATED="true"`                                                                                                    | Verified by `infra/cloudflare/v2-staging-preflight.mjs`                                                     |
| Model execution mode | `EMBER_MODEL_MODE="fake"`                                                                                                             | Fail-closed; zero external LLM/Daytona secrets bound                                                        |
| Proposed hostname    | **Option 1 (Recommended):** `ember-v2-staging.slowfast.dev` (custom domain)<br>**Option 2:** `ember-v2-staging.<account>.workers.dev` | Currently disabled (`workers_dev: false`, no routes) until approved; never touches `ember-api.slowfast.dev` |
| Local dry-run bundle | `wrangler deploy --dry-run --config wrangler.v2-staging.jsonc`                                                                        | Verified passing (`1336.40 KiB` / gzip `234.74 KiB`) on `febeabc`                                           |

---

## 3. Resource Provisioning Manifest (Zero V1 Collision)

Config source: [wrangler.v2-staging.jsonc](../apps/api/wrangler.v2-staging.jsonc). Automated zero-collision guard: [v2-staging-preflight.mjs](../infra/cloudflare/v2-staging-preflight.mjs).

| Resource Type            | Name / Binding                                                   | Provisioning Command (Post-Approval Only)                                                                             | V1 Overlap |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| Worker                   | `ember-v2-staging`                                               | `wrangler deploy --config wrangler.v2-staging.jsonc`                                                                  | None       |
| Durable Objects (SQLite) | `AGENT_HEAD` (`AgentHeadDO`), `GLOBAL_BUDGET` (`GlobalBudgetDO`) | Declared in `migrations: [{ tag: "v1" }]`                                                                             | None       |
| D1 Database              | `ember-v2-staging-recovery` (`D1_RECOVERY`)                      | `wrangler d1 create ember-v2-staging-recovery` + apply `packages/runtime-v2/migrations/0001_v2_recovery_registry.sql` | None       |
| Queue (Durable Turns)    | `ember-v2-staging-durable-turn` (`DURABLE_TURN_QUEUE`)           | `wrangler queues create ember-v2-staging-durable-turn`                                                                | None       |
| Queue DLQ (Turns)        | `ember-v2-staging-durable-turn-dlq`                              | `wrangler queues create ember-v2-staging-durable-turn-dlq`                                                            | None       |
| Queue (Agent Tasks)      | `ember-v2-staging-agent-task` (`AGENT_TASK_QUEUE`)               | `wrangler queues create ember-v2-staging-agent-task`                                                                  | None       |
| Queue DLQ (Tasks)        | `ember-v2-staging-agent-task-dlq`                                | `wrangler queues create ember-v2-staging-agent-task-dlq`                                                              | None       |
| Cron Trigger             | `* * * * *` (`RecoverySweeper`)                                  | Declared in `wrangler.v2-staging.jsonc`                                                                               | None       |
| Hyperdrive / Neon / R2   | **None**                                                         | Not bound                                                                                                             | None       |

---

## 4. Budget & Cost Envelope

> **Measurement vs. estimate:** Local `workerd` meter counts (`43` DO rows written/event, `262` DO rows read/event, `0.6` D1 writes/event, `1` Queue op/event) are **measured** ([m1-cost-reestimation.json](../benchmarks/v2-m1/m1-cost-reestimation.json)). Monthly dollar figures below are **model estimates** under ADR-0006 pricing, not Cloudflare invoices.

| Item                                                                                  | Monthly Cap / Estimate                           | Basis                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers Paid base plan                                                     | `$0` incremental (`$5/mo` already active for V1) | Existing account                                                                                                                              |
| V2 Staging usage (1–5 internal testers, `< 5,000` turns/mo + 43,200 1-min cron ticks) | **`~$0.00/mo` estimated**                        | All meters (`~50k` reqs, `~25k` DO reqs, `~215k` DO writes, `~3k` D1 writes, `~15k` Queue ops) are `< 3%` of Workers Paid included allowances |
| Approved staging spend ceiling                                                        | **`<= $10/mo`**                                  | ADR-0006 cloud PoC envelope                                                                                                                   |
| External LLM / Daytona provider spend                                                 | **`$0/mo`**                                      | `EMBER_MODEL_MODE="fake"`; no provider API keys configured                                                                                    |

---

## 5. Authentication & Access Control Scheme

Currently, `apps/api/src/local-v2/edge-worker.ts` and `runtime-worker.ts` **intentionally fail closed** for non-loopback hosts and non-local `EMBER_ENV`. Upon approval of one option below, Agent A will implement the minimal staging host/auth gate (reusing existing repository auth modules; no new auth framework):

### Option A (Recommended): Apple Sign In + Isolated D1 Sessions + Subject Allowlist

- **Identity verification:** Reuse existing `createAppleIdentityVerifier` + `loadCloudflareAppleVerifierConfig` (`apps/api/src/cloudflare-worker-apple-config.ts`) with `EMBER_APPLE_BUNDLE_ID="com.basicv8vc.ember"`, Apple JWKS verification, and D1-backed Apple nonce replay protection.
- **Session store:** Reuse existing `createSessionService` storing SHA-256 session token digests in the isolated `ember-v2-staging-recovery` D1 database (separate from V1 Neon).
- **Access restriction:**
  - `dev` identity provider is **strictly denied** (`DENY_DEV_PROVIDER`).
  - Host allowlist restricts requests to the approved staging hostname only (all other hosts return `404`).
  - Optional Cloudflare Worker secret `EMBER_V2_STAGING_ALLOWED_SUBJECTS` restricts session minting to approved Founder / QA Apple subject IDs only.
- **Device execution routes (`/v2/devices/*`):** Continue requiring both valid B1 bearer session and persistent 32-byte `X-Device-Token` bound by digest to the authenticated account and device.

### Option B (Alternative — Fake-Provider Smoke Only): Operator Bearer Token / Cloudflare Access

- Restrict the staging endpoint behind Cloudflare Access (or a single rotated staging operator secret) strictly for synthetic fake-provider smoke validation prior to enabling Apple Sign In on V2 staging. `dev` provider remains denied on the public edge.

---

## 6. Verification, Rollback & Teardown Measures

### Pre-Deploy & Post-Deploy Gates

1. Run `pnpm build && node infra/cloudflare/v2-staging-preflight.mjs --require-provisioned` (must pass with real provisioned D1 `database_id`, zero V1 collision, and clean `wrangler deploy --dry-run`).
2. Capture previous active Worker version (for subsequent deploys):
   ```sh
   pnpm --filter @ember/api exec wrangler deployments list --name ember-v2-staging --config wrangler.v2-staging.jsonc --json
   ```
3. Apply forward-only D1 migration (`0001_v2_recovery_registry.sql`), then deploy `ember-v2-staging`.
4. Verify immediately after deploy:
   - `GET /healthz` → `200` (`status: "ok"`, `service: "ember-v2-staging"` / `ember-v2-edge`)
   - `GET /readyz` → `200` (`status: "ready"`, `checks.d1_recovery.status: "up"`)
   - Anonymous `GET /v1/me` → `401 UNAUTHENTICATED`
   - V1 regression check: `https://ember-api.slowfast.dev/healthz` and `/readyz` remain `200`.

### Rollback Procedure

- **Immediate code rollback (any failed check or runtime defect):**
  ```sh
  pnpm --filter @ember/api exec wrangler rollback <previous-version-id> --name ember-v2-staging --config wrangler.v2-staging.jsonc --yes
  ```
- **Forward-only schema discipline:** D1 migrations (`packages/runtime-v2/migrations/`) and DO SQLite migrations (`v1`+) are strictly additive/forward-only. Never drop or rename columns in place during staging rollouts.
- **Zero V1 blast radius:** Because `ember-v2-staging` shares no Worker, Queue, D1, Hyperdrive, Neon DB, R2 bucket, or route with V1, rollback or deletion cannot affect V1 Ember Cloud.

### Full Environment Teardown (Emergency Abort / Decommission)

1. `pnpm --filter @ember/api exec wrangler delete --name ember-v2-staging --config wrangler.v2-staging.jsonc` (immediately stops HTTP traffic, queue consumers, and 1-min cron).
2. Delete the 4 isolated queues (`ember-v2-staging-durable-turn`, `ember-v2-staging-durable-turn-dlq`, `ember-v2-staging-agent-task`, `ember-v2-staging-agent-task-dlq`).
3. Delete D1 database `ember-v2-staging-recovery` and remove the staging custom DNS record (if Option 1 was used).

---

## 7. CTO / Founder Sign-Off Checklist

Please confirm the following 4 items to authorize provisioning and deployment:

- [ ] **Provisioning approved:** Authorize creating the isolated Cloudflare resources in §3 (`ember-v2-staging`, `ember-v2-staging-recovery`, 4 `ember-v2-staging-*` queues).
- [ ] **Hostname selected:** Option 1 (`ember-v2-staging.slowfast.dev`, recommended) or Option 2 (`workers.dev`).
- [ ] **Auth scheme selected:** Option A (Apple Sign In + D1 sessions + optional subject allowlist, recommended) or Option B (operator-only smoke).
- [ ] **Budget confirmed:** `<= $10/mo` staging envelope (`~$0` estimated incremental) with `EMBER_MODEL_MODE="fake"` (`$0` external LLM/Daytona spend).
