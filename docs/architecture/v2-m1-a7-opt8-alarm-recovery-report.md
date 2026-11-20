# V2 M1-A7 — OPT-8 Recovery & Alarm Cost Optimization Report

- **Date:** `2026-11-20`
- **Base:** M1-A6 PR `#196` (`cb25925`, rebased on `main @ f2987b6`)
- **Historical Snapshots Preserved:**
  - D8 baseline: `benchmarks/v2-m1/history/d8-m1-full-runtime.json`, `benchmarks/v2-m1/history/d8-m1-cost-reestimation.json`
  - A6 baseline: `benchmarks/v2-m1/history/a6-m1-full-runtime.json`, `benchmarks/v2-m1/history/a6-m1-cost-reestimation.json`
  - A7 OPT-8 current: `benchmarks/v2-m1/m1-full-runtime.json`, `benchmarks/v2-m1/m1-cost-reestimation.json`, `benchmarks/v2-m1/m1-full-runtime-bundle.json`
- **Scope Implemented (OPT-8 Only — Strictly No OPT-9..14):**
  1. **Reorder `syncAlarmAndRelayBudget` (`packages/runtime-v2/src/agent-head/turn-commit.ts` + callers in `turn-service.ts`, `agent-head-do.ts`, `recovery-service.ts`):**
     - Runs inline `relayBudgetSync(nowMs)` **first**, settling and ACKing `budget_sync` outbox rows before platform alarm synchronization.
     - Runs `syncPlatformAlarm(postRelayTarget, nowMs)` inside `finally` using a fresh post-relay `recomputeAlarmSync(nowMs)`.
     - On the happy path, eliminates spurious post-`commitTurn` Alarm #2 wakeups (`deleteAlarm()` when idle, or preserves earlier concurrent obligation deadlines).
     - On inline relay failure or uncaught throw, `finally` still arms the Alarm fallback for un-acked `budget_sync` outbox rows.
  2. **Minimal D1 Coverage Idle Grace Period (`packages/runtime-v2/src/recovery/registry.ts`, `durable-integration.ts`):**
     - Introduces `DEFAULT_COVERAGE_IDLE_GRACE_MS = 10 * 60_000` (10 min, configurable via `idleGraceMs` / `coverageIdleGraceMs`) in `RecoveryCoverageCoordinator.syncPostCycleCoverage`.
     - Defers DO-side Alarm-cycle D1 retirement during the idle grace window (`0` DO writes, `0` D1 writes), while preserving `RecoverySweeper` (`reconcileFromRegistrySync`) independent recovery, Generation CAS, Budget Outbox, and all Fencing semantics.
  3. **Sweeper Batch Drain Guard (`tests/integration/support/v2-m1-full-runtime/runtime-worker.ts`):**
     - Uses `batchLimit = 200` (Sweeper's existing supported upper bound) on `/_test/sweeper/run` so bursty idle agents never starve offline recovery of genuinely stuck agents.
- **Safety Invariants:** Zero V1 changes. Zero cloud deployment. Zero weakening of D1 independent recovery, Generation CAS, Budget Outbox, or Fencing.

---

## 1. Cross-Version Measured DO/D1 Ops & Alarm Wakeups (`D8 → A6 → A7 OPT-8`)

All three versions were measured on local `workerd` (`wrangler@4.158.0`, `concurrency=1,10,25,50`, `requests-per-level=20`):

| Path                                            | DO `rowsWritten/event` (D8 → A6 → **A7 OPT-8**) | D1 `rowsWritten/event` (D8 → A6 → **A7 OPT-8**) | Alarm Fires/event (D8 → A6 → **A7 OPT-8**) | `alarmSetCalls` (A6 → **A7**) |
| :---------------------------------------------- | :---------------------------------------------: | :---------------------------------------------: | :----------------------------------------: | :---------------------------: |
| **`activeCoveredB1DurablePath`** (`n=5`)        |         `56.60` → `43.00` → **`43.00`**         |          `0.00` → `0.00` → **`0.00`**           |        `1.60` → `1.40` → **`1.00`**        |       `3.0` → **`2.0`**       |
| **`coveredB1DurablePath`** (idle-cycle, `n=20`) | `60.75` → `45.95` → **`43.00`** (`-2.95` vs A6) |   `3.90` → `3.35` → **`0.00`** (**`-100%`**)    |        `1.75` → `1.65` → **`1.00`**        |       `4.0` → **`3.0`**       |
| **`uncoveredB1DurablePath`** (`n=20`)           |         `61.15` → `46.45` → **`46.00`**         |          `3.05` → `3.25` → **`3.00`**           |        `1.10` → `1.30` → **`1.00`**        |       `4.0` → **`3.0`**       |
| **`covered3RpcFastPath`** (`n=20`)              | `51.00` → `41.00` → **`39.00`** (`-2.00` vs A6) |   `3.00` → `3.00` → **`0.00`** (**`-100%`**)    |        `0.00` → `0.00` → **`0.00`**        |       `2.0` → **`1.0`**       |

### Engineering Latency & Offline Recovery Targets (`[Measured: Local workerd]`) — 6/6 PASS

| Metric                                            | Target                |        A6 Measured        |         **A7 OPT-8 Measured**         |  Status  |
| :------------------------------------------------ | :-------------------- | :-----------------------: | :-----------------------------------: | :------: |
| ACK P95 (covered B1 HTTP)                         | `<= 250 ms`           |        `13.64 ms`         | **`11.08 ms`** (uncovered `15.72 ms`) | **PASS** |
| Runtime Overhead P95 (3-RPC Fast Path, excl. LLM) | `<= 200 ms`           |        `27.36 ms`         |            **`21.46 ms`**             | **PASS** |
| Global Budget Reserve + Authorize P95             | `<= 50 ms`            |         `7.96 ms`         |             **`9.66 ms`**             | **PASS** |
| Durable Dispatch P95 (`POST -> completed`)        | `<= 3,000 ms`         |        `76.89 ms`         |            **`58.14 ms`**             | **PASS** |
| Offline Detection / Recovery                      | `<= 2m / <= 5m`       |        `50s / 66s`        |            **`50s / 66s`**            | **PASS** |
| Edge SSE Stream (`/v2/.../messages/stream`)       | Stream delta + commit | `HTTP 201, sawDelta=true` |     **`HTTP 201, sawDelta=true`**     | **PASS** |

---

## 2. D1 Coverage Idle Grace Period Experiment (`0 / 5 / 10 / 15` Minutes)

Evaluated via `tests/unit/v2-m1-a7-opt8-alarm-recovery.test.ts` (turn/schedule gaps of `3m`, `7m`, `12m`, `16m`) and full M1 `workerd` acceptance (`F-17`):

| Idle Grace Period           | Gaps Protected from Alarm-Cycle Churn (`3m / 7m / 12m / 16m`) |   `F-17` Post-Schedule Race (`+5m50s`)    | Idle D1 Residency After Alarm Cycle | Offline Detection / Recovery SLA | Recommendation                                          |
| :-------------------------- | :-----------------------------------------------------------: | :---------------------------------------: | :---------------------------------: | :------------------------------: | :------------------------------------------------------ |
| **`0 min`** (A6 Baseline)   |         `0 / 4` (retires immediately on every Alarm)          |    PASS (via legacy pre-retire timing)    |               `0 min`               |           `50s / 66s`            | High D1 & DO churn (`3.35` D1W/ev)                      |
| **`5 min`** (`300_000 ms`)  |                      `1 / 4` (`3m` only)                      |     Retires at `5m50s` post-schedule      |            Up to `5 min`            |           `50s / 66s`            | Too short for 5–10 min user think-time                  |
| **`10 min`** (`600_000 ms`) |                   **`2 / 4`** (`3m`, `7m`)                    | **PASS** (23/23 M1 acceptance unmodified) |           Up to `10 min`            |         **`50s / 66s`**          | **Selected Default (`DEFAULT_COVERAGE_IDLE_GRACE_MS`)** |
| **`15 min`** (`900_000 ms`) |                  `3 / 4` (`3m`, `7m`, `12m`)                  |                   PASS                    |   Up to `15 min` (+50% residency)   |           `50s / 66s`            | Longer D1 residency than needed for chat                |

> **Architectural note:** `RecoverySweeper` (`reconcileFromRegistrySync`) continues to retire truly idle agents (`openD === null`) on Sweeper scan (`* * * * *`) rather than deferring Sweeper with `retry_not_before_ms`, because suppressing Sweeper while keeping `coverage_state = 'covered'` would violate the `<= 2 min` offline detection bound if a new turn arrived and crashed during the suppressed window.

---

## 3. Cross-Version Cost Re-Estimation (`10k / 100k` MAU) & Acceptance Gap Analysis

Computed with `calculateAdr0006Cost()` (`independentRecovery.enabled: true`, `storageGrowth: { monthsElapsed: 6, dormantRetainedRatio: 1.0 }`):

| Scenario (`DO rowsW / DO rowsR / D1 writes / Q ops`)  | `10k MAU` Cloud Runtime | `10k` Target (`<= $300`) | `100k MAU` Cloud Runtime | `100k` Target (`<= $3,500`) | `100k` DO Write / D1 Write |
| :---------------------------------------------------- | ----------------------: | :----------------------: | -----------------------: | :-------------------------: | -------------------------: |
| **D8 Idle-Cycle (`60.75 / 247 / 3.90 / 1.0`)**        |               `$438.18` |            —             |              `$5,179.46` |              —              |      `$4,105.30 / $353.56` |
| **A6 Idle-Cycle (`45.95 / 292.3 / 3.35 / 1.0`)**      |               `$336.95` |            —             |              `$4,129.52` |              —              |      `$3,092.98 / $315.94` |
| **A7 OPT-8 Idle-Cycle (`43.0 / 262.1 / 0.00 / 1.0`)** |           **`$316.77`** |        `+$16.77`         |          **`$3,698.60`** |         `+$198.60`          |       `$2,891.20 / $86.80` |
| **A7 OPT-8 Active-Cov (`43.0 / 252.2 / 0.60 / 1.0`)** |           **`$316.77`** |        `+$16.77`         |          **`$3,739.64`** |         `+$239.64`          |      `$2,891.20 / $127.84` |
| **A7 OPT-8 Uncovered (`46.0 / 217.0 / 3.00 / 1.0`)**  |           **`$337.29`** |        `+$37.29`         |          **`$4,109.00`** |         `+$609.00`          |      `$3,096.40 / $292.00` |
| **A7 OPT-8 Fast Path (`39.0 / 186.55 / 0.00 / 0.0`)** |           **`$287.08`** |         **PASS**         |          **`$3,398.04`** |          **PASS**           |       `$2,617.60 / $86.80` |

In `benchmarks/v2-m1/m1-cost-reestimation.json` (`m1_measured_workerd_*` with `43 / 262 / 0.60 / 1.0`):

- **`1k MAU`:** `$7.72/mo`
- **`10k MAU`:** **`$316.77/mo`** (`-$20.52/mo` vs A6 `$337.29/mo`)
- **`100k MAU`:** **`$3,643.88/mo`** (**`-$578.66/mo` (`-13.7%`)** vs A6 `$4,222.54/mo`; D1 write cost reduced **`-92.1%`** from `$405.54` → `$32.08`)

### Honest Gap Report (Per Scope Guard — OPT-9..14 Not Implemented)

OPT-8 alone **fully meets** the Fast Path targets (`39` DO writes/event, `$287.08` @ 10k, `$3,398.04` @ 100k), **eliminates 100%** of sequential Idle-Cycle D1 writes (`3.35 → 0.00`) and post-`commitTurn` Alarm #2 wakeups (`1.65 → 1.00`), and slashes `100k MAU` Cloud Runtime by **`-$578.66/mo`**.

However, **Durable B1 Active-Covered / Idle-Cycle remains at `43.0` DO `rowsWritten/event`** (`3` writes/event above `<= 40`, `$16.77/mo` above `$300` @ 10k, and `$143.88/mo` above `$3,500` @ 100k in `m1-cost-reestimation.json`), because on an already-covered durable turn, Alarm #2 previously executed `0` SQLite writes (`AgentHeadDO` `35.0` + `GlobalBudgetDO` `8.0` = `43.0`). Closing the remaining `3` writes/event cleanly requires **OPT-9** (`agent_spend_days` single-row per `(principal_id, utc_day)`, `-2` writes) + **OPT-10** (inline best-effort `queue.send()`, `-2` writes) → `39` DO writes/event (`~$289 / ~$3,372`), which are intentionally held pending architect approval.

---

## 4. Verification Matrix

- `tests/unit/v2-m1-a7-opt8-alarm-recovery.test.ts`: **4/4 PASS** (reordered inline-first `budget_sync` relay, `finally` Alarm fallback on throw, active obligation alarm preservation, `5 / 10 / 15 min` idle grace + Sweeper Generation CAS).
- `tests/integration/v2-m1-full-runtime-acceptance.test.ts`: **23/23 PASS** (unmodified!).
- `tests/integration/v2-m2-device-execution-workerd.test.ts`: **6/6 PASS**.
- `tests/integration/v2-m1-a6-workerd-upgrade.test.ts`: **1/1 PASS**.
- `tests/integration/v2-m1-global-budget-workerd.test.ts`: **4/4 PASS**.
- `tests/integration/v2-m1-runtime-assembly.test.ts`: **5/5 PASS**.
- V2 Unit & B3/B4 Recovery/FI Suites (`a6-sqlite-write-opt`, `agent-head`, `b3-alarm-recovery`, `b3-alarm-recovery-workerd`, `b4-durable-integration`, `b4-fi-matrix-workerd`, `global-budget`, `runtime-contracts`): **42/42 PASS**.
