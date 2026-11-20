# Product Alpha — Agent F: Daytona Provider-Canary Readiness & Approval Request

Status: **Local fake-provider slice verified (PR #211); awaiting explicit CTO/Owner approval before any real Daytona provider-canary call.**  
Owner: Agent F (Tools & Execution)  
Date: 2026-11-20  
Related: [Product Alpha Roadmap](./PRODUCT-ALPHA-ROADMAP.md), [ADR-0006](../adr/0006-experience-first-device-powered-runtime-v2.md), [P0-C4 Daytona Integration Plan](../P0-C4-DAYTONA-INTEGRATION-PLAN.md), [P0-C4 Daytona Security Gap Report](../P0-C4-DAYTONA-SECURITY-GAP-REPORT.md)

---

## 1. Approval Request Summary

No real Daytona sandbox has been created or billed during Product Alpha F1. This document requests **separate CTO/Owner approval** for a **single bounded Daytona provider-canary** in the isolated staging environment to close the real-provider acceptance gap for the *"Analyze data and deliver a file"* scenario:

- **Requested canary scope (1–3 synthetic runs, founder/internal allowlisted tenant only):**
  - Upload a synthetic CSV (`< 10 KiB`) via `POST /v1/me/uploads`.
  - Delegate a `python.agent` task (`delegate_python_agent`) through the existing staging path (`apps/cloud-async-runtime` → `DaytonaSandboxProvider`).
  - Verify bounded Python execution, progress events (`GET /v1/me/tasks/:id/events`), authorized downloadable output artifact (`GET /v1/me/tasks/:id/artifacts` + `GET /v1/me/artifacts/:artifactId`), and confirmed sandbox destruction (`0` live sandboxes after completion).
- **Explicitly NOT requested here:**
  - Broad tenant rollout or production cutover.
  - External connectors, network egress from sandboxes, or new subscriptions.
  - Modifying V1 wire contracts or shared schemas.

---

## 2. Pre-Canary Local Evidence (Measured, Zero External Spend)

The full bounded data-processing vertical slice is validated locally with fake providers in **PR #211** (`feat/alpha-f-bounded-data-task` @ `976af9d`):

| Check | Command | Measured Result |
| --- | --- | --- |
| Fake sandbox & handler unit tests | `pnpm exec vitest run --config vitest.unit.config.ts tests/unit/b3-fake-python-sandbox.test.ts tests/unit/b3-python-agent-executor.test.ts` | **13/13 passed** |
| Full HTTP + Postgres E2E | `pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/b3-python-agent-http.test.ts` | **2/2 passed** (upload → delegate → bounded CSV analysis → progress events → authorized CSV download → cross-tenant 404 → transient crash retry without duplicate artifacts → clean cancellation) |
| Build & static checks | `pnpm run build && pnpm run typecheck && pnpm exec eslint ...` | **Pass** (0 errors, 0 warnings) |

*Evidence boundary:* Local fake-provider tests verify task delegation, lease/checkpoint recovery, artifact authorization headers, and tenant isolation; they are development evidence, **not** a real Daytona provider pass.

---

## 3. Hard Runtime & Spend Bounds (Code-Enforced)

All limits below are enforced in `packages/contracts/src/task-schemas.ts` (`PYTHON_AGENT_LIMITS`), `apps/worker/src/b3/python-agent-executor.ts`, and `packages/sandbox-daytona/src/provider.ts`:

| Control | Enforced Bound |
| --- | --- |
| Sandbox profile | `daytona-small`, `sandboxClass: 'container'`, `ephemeral: true`, `networkBlockAll: true` |
| Wall-clock lifetime / exec timeout | `sandboxLifetimeSec <= 120s`, `execTimeoutMs <= 60s`, `readyDeadlineMs <= 90s` |
| Per-Run / Per-Task caps | `<= 1` sandbox/run (`<= 2`/task), `<= 3` Python execs/run (`<= 4`/task), `<= 4` LLM calls/run (`<= 6`/task) |
| Model spend ceiling | `maxTaskCostMicroUsd = 30,000` (`$0.03` max per task), plus existing daily principal/tenant/global ceilings |
| File & artifact bounds | `<= 15 MiB` per file, `<= 32 MiB` total per task, `<= 5` output artifacts, blocked active web MIME types (`text/html`, `image/svg+xml`, JS), safe ASCII filenames only |
| Estimated Daytona compute cost (estimate) | `~$0.002–$0.005` per 1-minute `daytona-small` canary run (`< $0.05` total for the 1–3 run canary) |

---

## 4. Canary Execution & Kill-Switch Checklist (Post-Approval Only)

1. **Pre-flight:** Confirm `EMBER_ENV=staging`, `EMBER_MODEL_ALPHA_SCOPE=allowlist` (internal test tenant only), and `DAYTONA_API_KEY` scoped to staging.
2. **Run canary:** Execute 1 synthetic CSV analysis task + 1 cancellation check; record commit SHA, task ID, artifact SHA-256, measured latency, and observed cost.
3. **Verify zero leaked sandboxes:** Confirm `DaytonaSandboxProvider.destroy()` succeeded in logs and `DaytonaSandboxReconciler` reports `0` live sandboxes for the canary owner label.
4. **Immediate kill-switch / rollback:**
   - Remove/unset `DAYTONA_API_KEY` in staging Worker secrets → `resolveCloudDaytonaConfig()` immediately returns `{ kind: 'disabled' }` (fail-closed for `python.agent` without disrupting chat turns or `notes.action_items`).
   - Optionally set `EMBER_MODEL_EXECUTION=disabled` to halt all model execution.
