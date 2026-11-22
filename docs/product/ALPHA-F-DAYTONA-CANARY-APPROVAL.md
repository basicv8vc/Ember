# Product Alpha — Agent F: V2 Bounded G4 Daytona Canary Approval Packet

**Status:** **Code & readiness tooling merged on `main` (`b89997e`, PR #262); `EMBER_SANDBOX_MODE="fake"` remains active on `ember-v2-staging` with `DAYTONA_API_KEY` unbound and `$0.00` external spend. Awaiting explicit Founder spend/scope authorization before binding Daytona secrets or executing any remote G4 canary run.**  
**Owner:** Agent F (Tools & Execution)  
**Date:** 2026-11-22  
**Related:** [ALPHA-F-DAYTONA-CANARY-READINESS.md](./ALPHA-F-DAYTONA-CANARY-READINESS.md), [ALPHA-A-REAL-LLM-CANARY-APPROVAL.md](./ALPHA-A-REAL-LLM-CANARY-APPROVAL.md), [PRODUCT-ALPHA-ACCEPTANCE.md](./PRODUCT-ALPHA-ACCEPTANCE.md), [ADR-0006](../adr/0006-experience-first-device-powered-runtime-v2.md)

---

## 1. Requested Decision Summary

This packet requests **separate explicit Founder spend & scope authorization** (with CTO oversight) for a **single bounded G4 Daytona provider-canary** (`1–3` synthetic runs) on the isolated V2 staging Worker (`https://ember-v2-staging.slowfast.dev`) to verify real sandbox execution for _"Analyze data and deliver a file"_.

### Authorized Scope (When Approved)

- **Target:** Isolated `ember-v2-staging` only (`EMBER_ENV="v2-staging"`, `EMBER_V2_STAGING_ISOLATED="true"`, `EMBER_V2_ALLOWED_HOST="ember-v2-staging.slowfast.dev"`).
- **Runs:** `1–3` synthetic, zero-PII runs using `g4-canary-sales.csv` (`66` bytes, `< 1 KiB`) via `infra/cloudflare/v2-g4-daytona-canary.mjs`:
  1. Direct upload -> `POST /v2/tasks/python` (+ idempotent replay check) -> `DaytonaSandboxProvider` -> SHA-256 downloadable output artifact (`text/csv`).
  2. Natural-language chat upload -> `POST /v1/conversations/:id/messages` (`attachment_ids` -> `delegate_python_agent`) -> `task_reference` card -> SHA-256 downloadable output artifact.
  3. In-flight cancellation probe (`POST /v2/tasks/python` with `time.sleep(20)` -> `POST /v1/me/tasks/:id/cancel` returning HTTP `200`/`202` -> terminal `cancelled`/`failed` with `0` committed output artifacts).
- **Post-run:** Mandatory Daytona orphan sweep (`sweepOrphanedSandboxes` for `ember-v2-staging:canary`) confirming `0` live sandboxes, followed by immediate restore to `EMBER_SANDBOX_MODE="fake"` and `EMBER_MODEL_MODE="fake"`.

### Explicitly Out of Scope

- Broad tenant rollout, production cutover, or any changes to V1 (`ember-api.slowfast.dev` / Hyperdrive / Neon / V1 R2).
- Real user files or personal data in canary runs.
- Recurring real-model proactive briefs (`EMBER_MODEL_ALLOW_RECURRING_BRIEFS` remains `"false"`).
- Outbound network access from Daytona sandboxes (`networkBlockAll: true`) or external connectors.

---

## 2. Model + Daytona Modes, Routing & Sandbox Profile

| Control                | Pinned G4 Canary Value                                                                                                                                                                                                 | Enforcement Location                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Model mode & provider  | `EMBER_MODEL_MODE="real"`, `EMBER_MODEL_PROVIDER="openrouter"`                                                                                                                                                         | `apps/api/src/local-v2/model-runtime.ts`, `infra/cloudflare/v2-staging-preflight.mjs`      |
| Pinned model & route   | `deepseek/deepseek-v4.1-flash-1017` (`deepinfra` only, `allow_fallbacks: false`, `zdr: true`, `data_collection: 'deny'`, `require_parameters: true`, `reasoningEffort: 'none'` -> `{ reasoning: { enabled: false } }`) | `packages/model-gateway/src/rates.ts` (`APPROVED_REAL_MODELS`), `providers/shared.ts`      |
| Recurring brief policy | `EMBER_MODEL_ALLOW_RECURRING_BRIEFS="false"`                                                                                                                                                                           | `apps/api/src/local-v2/runtime-config.ts`, `runtime-durable.ts`                            |
| Sandbox mode & owner   | `EMBER_SANDBOX_MODE="daytona"`, `EMBER_SANDBOX_OWNER="ember-v2-staging:canary"`                                                                                                                                        | `apps/api/src/local-v2/runtime-config.ts`, `v2-staging-preflight.mjs`                      |
| Sandbox profile        | `snapshot: "daytona-small"`, `sandboxClass: "container"`, `1 vCPU`, `1 GiB RAM`, `3 GiB disk`, `ephemeral: true`, `networkBlockAll: true` (`deny-all`)                                                                 | `apps/api/src/local-v2/python-agent-runner.ts`, `packages/sandbox-daytona/src/provider.ts` |
| Workers transport      | `useDeprecatedPolling: true` (HTTP polling; no Socket.IO background WebSockets)                                                                                                                                        | `apps/api/src/local-v2/python-agent-runner.ts`                                             |

---

## 3. Isolated Tenant & Secret Posture

Both model ingress and Daytona execution enforce fail-closed allowlists before any external API call:

| Binding                             | Type                                 | Requirement                                                   |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `EMBER_MODEL_ALPHA_SCOPE`           | Plaintext var (deploy override only) | Must be `"allowlist"`                                         |
| `EMBER_MODEL_ALPHA_TENANT_IDS`      | Worker secret                        | Single allowlisted internal/Founder V2 tenant UUID            |
| `EMBER_DAYTONA_ALLOWED_TENANTS`     | Worker secret                        | Same allowlisted internal/Founder V2 tenant UUID (`1` tenant) |
| `EMBER_MODEL_API_KEY`               | Worker secret                        | Dedicated OpenRouter key capped at `$1.00` lifetime spend     |
| `DAYTONA_API_KEY`                   | Worker secret                        | Dedicated Daytona API key (currently **unbound**)             |
| `EMBER_V2_STAGING_ALLOWED_SUBJECTS` | Worker secret (optional)             | Verified Founder Apple `sub` when restricting Apple login     |

- Checked-in `apps/api/wrangler.v2-staging.jsonc` keeps `EMBER_MODEL_MODE="fake"` and `EMBER_SANDBOX_MODE="fake"`; `v2-staging-preflight.mjs` forbids plaintext secrets in config.
- `POST /v2/tasks/python` enforces `authorizeModelTurn` at ingress (`edge-worker.ts`), and `executeV2PythonAgentTask` checks `EMBER_DAYTONA_ALLOWED_TENANTS` (`sandbox_tenant_not_allowed`) before model reservation or sandbox allocation.

---

## 4. Hard Budget & Runtime Ceilings

| Layer                                                                   | Enforced Hard Bound                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G3/G4 Model Attempt & Daily Caps (`AgentHeadDO` + `GlobalBudgetDO`)** | Per-attempt `<= 5,000` µUSD (`$0.005`), Principal daily `<= 50,000` µUSD (`$0.05`) and `<= 20` turns/day, Tenant daily `<= 50,000` µUSD (`$0.05`), Global daily `<= 100,000` µUSD (`$0.10`), OpenRouter key lifetime cap `$1.00`   |
| **Python Task Model Ceiling (`PYTHON_AGENT_LIMITS`)**                   | `maxTaskCostMicroUsd = 30,000` (`$0.03`/task), `<= 4` LLM calls/run (`<= 6`/task), `<= 3` Python execs/run (`<= 4`/task), `<= 1` sandbox/run (`<= 2`/task)                                                                         |
| **Daytona Lifetime & Timeouts (`DAYTONA_SANDBOX_LIMITS`)**              | `maxSandboxLifetimeSec = 120s`, `idleStopMinutes = 2`, `autoDeleteMinutesAfterStop = 0`, `maxTtlMinutes = 5`, `maxReadyDeadlineMs = 90s`, `maxExecTimeoutMs = 60s`, task `deadline_at_ms <= 120s`                                  |
| **Artifact & Payload Caps**                                             | Inline DO output artifact `<= 1 MiB` (`V2_MAX_INLINE_ARTIFACT_BYTES`), aggregate task files `<= 32 MiB`, `<= 5` output artifacts/task, blocked active web MIME types (`text/html`, `image/svg+xml`, JS), safe ASCII filenames only |
| **Expected Canary Spend (Estimated)**                                   | LLM: `~$0.001–$0.005` total across 1–3 synthetic runs; Daytona (`daytona-small`): `~$0.002–$0.005` per 1-minute run (`< $0.05` total)                                                                                              |

---

## 5. Pre-Flight, Execution, Abort & Cleanup Evidence Plan

### Step 1 — Pre-Flight & Dry-Run (Zero External Spend)

```bash
node infra/cloudflare/v2-staging-preflight.mjs \
  --allow-real-llm-canary \
  --allow-daytona-canary \
  --model-mode=real \
  --sandbox-mode=daytona \
  --require-provisioned \
  --verify-secrets
```

### Step 2 — Bounded Synthetic Canary Execution (Post-Authorization Only)

```bash
node infra/cloudflare/v2-g4-daytona-canary.mjs \
  --base-url https://ember-v2-staging.slowfast.dev \
  --bearer-token "$CANARY_BEARER_TOKEN" \
  --confirm-founder-authorization \
  --owner ember-v2-staging:canary \
  --include-nl-chat \
  --sweep-orphans
```

### Step 3 — Immediate Kill-Switch, Orphan Sweep & Rollback

1. **Immediate mode kill-switch / rollback to Fake baseline** (capture the active Fake version ID via `pnpm --filter @ember/api exec wrangler deployments list --name ember-v2-staging --config wrangler.v2-staging.jsonc` before switching modes; repo-recorded Fake baseline in `PRODUCT-ALPHA-ACCEPTANCE.md` is `7998cfe1-dbd2-439e-83b6-927951484377`):
   ```bash
   pnpm --filter @ember/api exec wrangler rollback <fake-version-id> --name ember-v2-staging --config wrangler.v2-staging.jsonc --yes
   ```
2. **Secret kill-switch** (immediately disables Daytona allocation on boot):
   ```bash
   pnpm --filter @ember/api exec wrangler secret delete DAYTONA_API_KEY --name ember-v2-staging --config wrangler.v2-staging.jsonc
   ```
3. **Independent Daytona control-plane orphan sweep** (must report `liveCount === 0`, `failed: []`):
   ```bash
   DAYTONA_API_KEY="$DAYTONA_API_KEY" node infra/cloudflare/v2-g4-daytona-canary.mjs \
     --sweep-only \
     --owner ember-v2-staging:canary \
     --confirm-founder-authorization
   ```

### Required Acceptance Evidence to Record

- Deployed `ember-v2-staging` Version ID and `main` commit SHA (`>= b89997e`), plus restored Fake rollback Version ID after canary closure.
- Direct task & NL chat delegation `task_id`s, `simulated: false`, `model_label: "deepseek/deepseek-v4.1-flash-1017"`, progress event count, and downloaded output artifact filename, size, security headers, and SHA-256 digest.
- In-flight cancellation `task_id`, `statusBeforeCancel`, HTTP `200`/`202` cancel ACK, terminal status (`cancelled`/`failed`), and `0` committed run artifacts.
- `sweepOrphans` output confirming `liveCount === 0` (`0` orphan sandboxes) and observed OpenRouter + Daytona dashboard spend vs. `GlobalBudgetDO` ledger.

---

## 6. Sign-Off Checklist

- [x] **CTO Code & Readiness Review:** PR #262 reviewed and merged as `b89997e` (2026-11-22).
- [ ] **Founder Authorization:** Explicit approval to bind `DAYTONA_API_KEY` + `EMBER_DAYTONA_ALLOWED_TENANTS` and execute `1–3` synthetic G4 Daytona canary runs on `ember-v2-staging` under the ceilings in §4, followed by immediate restore to `EMBER_SANDBOX_MODE="fake"`.
