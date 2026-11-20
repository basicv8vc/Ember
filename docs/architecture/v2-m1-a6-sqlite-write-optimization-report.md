# V2 M1-A6 — DO SQLite Write Amplification Optimization Report

- **Date:** `2026-11-20`
- **Base:** `main @ f2987b6` (preserves merged PRs `#189`, `#190`, `#191`, `#192`, `#193`, `#194`)
- **Scope Implemented:**
  - Live `GlobalBudgetDO` SQLite `rowsRead` / `rowsWritten` / `statements` telemetry in the local `workerd` benchmark harness (eliminating M0's hardcoded `8R / 9W` constants without modifying production `GlobalBudgetDO`), with corrected latency/telemetry boundaries (`durableDispatchMs` stops before `/_test/global-budget/inspect`; `globalBudgetReserveAndAuthorizeMs` stops before cleanup `settleGlobal`)
  - **OPT-1:** Drop duplicate `idx_messages_conv_seq` on `conversation_messages` (via `AgentHeadDO` migration `v4`)
  - **OPT-2:** Convert `assistant_turns.response_message_id` from full `UNIQUE` to partial `UNIQUE INDEX idx_turns_response_message ... WHERE response_message_id IS NOT NULL` (via `v4`)
  - **OPT-3:** Guard `AlarmMultiplexer.runAlarmCycle` `alarm_fail_count = 0` reset with `AND alarm_fail_count > 0`
  - **OPT-4:** Replace SQLite `v2_recovery_coverage.armed_alarm_at_ms` read/write in `AlarmMultiplexer.syncPlatformAlarm` with in-process FIFO-serialized `storage.getAlarm()` (zero SQLite writes), hardened with a post-`getAlarm()` synchronous `recomputeAlarmSync(nowMs)` check (`effectiveTarget = min(targetAlarmAtMs, latestDbTarget)`) so stale `null` or later targets can never delete or postpone concurrently committed obligations
  - **OPT-5:** Rebuild small PK-lookup tables as `WITHOUT ROWID`: `assistant_turns`, `model_attempts`, `agent_spend_days`, `v2_dispatch_outbox` (`AgentHeadDO` `v4`), and `global_budget_reservations`, `global_budget_settlements` (`GlobalBudgetDO` automatic transactional upgrade with `PRAGMA foreign_key_check`)
- **Explicitly Deferred (Per Plan):** OPT-6 (`idx_v2_outbox_budget_sync_op_rev`), OPT-7 (`global_grant_id UNIQUE`), and all Tier 2 / Tier 3 optimizations.
- **Safety Invariants:** Zero weakening of persistence, idempotency, fencing, recovery, or budget safety. Zero V1 changes. Zero cloud deployment.

---

## 1. Before vs After Measured DO SQLite Write Amplification (`[Measured: Local workerd]`)

Both BEFORE (unoptimized baseline with live `GlobalBudgetDO` telemetry) and AFTER (OPT-1..5 applied on rebased HEAD) were measured in local `workerd` (`wrangler@4.158.0`, reproducible artifacts in `benchmarks/v2-m1/m1-full-runtime.json`, `benchmarks/v2-m1/m1-cost-reestimation.json`, and `benchmarks/v2-m1/m1-full-runtime-bundle.json`).

### 1.1 Four D8 Execution Paths — Before vs After

| Path                                                       | `AgentHeadDO` Writes (Before → After) | `GlobalBudgetDO` Writes (Before → After) | Total DO `rowsWritten` (Before → After) |             Delta             | Total DO `rowsRead` (After) | D1 `rowsWritten` (After) |
| :--------------------------------------------------------- | :-----------------------------------: | :--------------------------------------: | :-------------------------------------: | :---------------------------: | --------------------------: | -----------------------: |
| **`activeCoveredB1DurablePath`** (`n=5`, target `<= 44`)   |     `46.0` → **`35.0`** (`-11.0`)     |       `10.0` → **`8.0`** (`-2.0`)        |           `56.0` → **`43.0`**           | **`-13.0` (`-23.2%`) — PASS** |                     `244.2` |                   `0.00` |
| **`coveredB1DurablePath`** (`n=20`, sequential idle-cycle) |    `51.0` → **`37.95`** (`-13.05`)    |       `10.0` → **`8.0`** (`-2.0`)        |          `61.0` → **`45.95`**           |    **`-15.05` (`-24.7%`)**    |                     `292.3` |                   `3.35` |
| **`uncoveredB1DurablePath`** (`n=20`, fresh agent)         |    `52.0` → **`38.45`** (`-13.55`)    |       `10.0` → **`8.0`** (`-2.0`)        |          `62.0` → **`46.45`**           |    **`-15.55` (`-25.1%`)**    |                     `221.2` |                   `3.25` |
| **`covered3RpcFastPath`** (`n=20`, interactive fast path)  |     `42.0` → **`33.0`** (`-9.0`)      |       `10.0` → **`8.0`** (`-2.0`)        |           `52.0` → **`41.0`**           |    **`-11.0` (`-21.2%`)**     |                    `192.55` |                   `3.00` |

### 1.2 Live Measured `GlobalBudgetDO` Breakdown

Eliminating M0's hardcoded `8R / 9W` constant exposed the true `GlobalBudgetDO` per-turn SQLite I/O:

- **Before OPT-5:** `17` SQL statements, **`15` `rowsRead`**, **`10` `rowsWritten`** (`reserveGlobal = 5`, `authorizeGlobalSend = 1`, `settleGlobal = 4`).
- **After OPT-5 (`WITHOUT ROWID` on `global_budget_reservations` & `global_budget_settlements`):** `17` SQL statements, **`15` `rowsRead`**, **`8` `rowsWritten`** (`-2.0` writes/turn, `-20.0%`).

### 1.3 Engineering Latency & Runtime Targets (`[Measured: Local workerd]`) — 6/6 PASS

| Metric                                            | Target                             | Measured (Rebased Final HEAD)         | Status   |
| :------------------------------------------------ | :--------------------------------- | :------------------------------------ | :------- |
| ACK P95 (covered B1 HTTP)                         | `<= 250 ms` (near-region)          | **`13.64 ms`** (uncovered `18.24 ms`) | **PASS** |
| Runtime Overhead P95 (3-RPC Fast Path, excl. LLM) | `<= 200 ms`                        | **`27.36 ms`**                        | **PASS** |
| Global Budget Reserve + Authorize P95             | `<= 50 ms`                         | **`7.96 ms`**                         | **PASS** |
| Durable Dispatch P95 (`POST -> completed`)        | `<= 3,000 ms`                      | **`76.89 ms`**                        | **PASS** |
| Offline Detection / Recovery                      | `<= 2 min detect / <= 5 min recov` | **`50s detect / 66s recover`**        | **PASS** |
| Edge SSE Stream (`/v2/.../messages/stream`)       | Stream delta + commit/handoff      | **`HTTP 201, sawDelta=true`**         | **PASS** |

---

## 2. Before vs After Cost Re-Estimation (`10k / 100k` MAU)

Computed with `calculateAdr0006Cost()` (`apps/benchmark/src/cost-model.ts`) using D8's parameters (`independentRecovery.enabled: true`, `storageGrowth: { monthsElapsed: 6, dormantRetainedRatio: 1.0 }`):

| Scenario (`DO rowsW / DO rowsR / D1 writes / Q ops`) | `10k MAU` Cloud Runtime | `10k` DO Write Cost | `100k MAU` Cloud Runtime | `100k` DO Write / D1 Write Cost |        Monthly Savings vs Before (`10k / 100k`) |
| :--------------------------------------------------- | ----------------------: | ------------------: | -----------------------: | ------------------------------: | ----------------------------------------------: |
| **BEFORE Idle-Cycle (`61.0 / 247.0 / 3.50 / 1.0`)**  |               `$439.89` |           `$367.24` |              `$5,169.20` |           `$4,122.40 / $326.20` |                                        Baseline |
| **BEFORE Uncovered (`62.0 / 221.0 / 3.55 / 1.0`)**   |               `$446.73` |           `$374.08` |              `$5,241.02` |           `$4,190.80 / $329.62` |                                        Baseline |
| **BEFORE Active-Cov (`56.0 / 214.0 / 0.61 / 1.0`)**  |               `$405.69` |           `$333.04` |              `$4,629.52` |           `$3,780.40 / $128.52` |                                        Baseline |
| **BEFORE Fast Path (`52.0 / 192.0 / 0.61 / 0.0`)**   |               `$376.00` |           `$305.68` |              `$4,328.96` |           `$3,506.80 / $128.52` |                                        Baseline |
| **AFTER Idle-Cycle (`45.95 / 292.3 / 3.35 / 1.0`)**  |           **`$336.95`** |           `$264.30` |          **`$4,129.52`** |           `$3,092.98 / $315.94` | **`-$102.94 (-23.4%)` / `-$1,039.68 (-20.1%)`** |
| **AFTER Uncovered (`46.45 / 221.2 / 3.25 / 1.0`)**   |           **`$340.37`** |           `$267.72` |          **`$4,156.88`** |           `$3,127.18 / $309.10` | **`-$106.36 (-23.8%)` / `-$1,084.14 (-20.7%)`** |
| **AFTER Active-Cov (`43.0 / 244.2 / 0.61 / 1.0`)**   |           **`$316.77`** |           `$244.12` |          **`$3,740.32`** |           `$2,891.20 / $128.52` |    **`-$88.92 (-21.9%)` / `-$889.20 (-19.2%)`** |
| **AFTER Fast Path (`41.0 / 192.55 / 0.61 / 0.0`)**   |           **`$300.76`** |           `$230.44` |          **`$3,576.56`** |           `$2,754.40 / $128.52` |    **`-$75.24 (-20.0%)` / `-$752.40 (-17.4%)`** |

`benchmarks/v2-m1/m1-cost-reestimation.json` (`m1_measured_workerd_*` with rounded `46 / 292 / 3.33 / 1.0` and D8's `2x` D1 write multiplier) reports **`$7.72`** (`1k MAU`), **`$337.29`** (`10k MAU`), and **`$4,222.54`** (`100k MAU`).

---

## 3. Verification Matrix (Final Rebased HEAD)

- **Real `workerd` Persistent Pre-v4 → v4 Upgrade, Atomic Rollback, DO Eviction Restart & Retry (`tests/integration/v2-m1-a6-workerd-upgrade.test.ts` + `tests/integration/support/v2-m1-a6-upgrade.worker.mjs`):** **1/1 PASS**
  - Seeds persistent pre-v4 `AgentHeadDO` (`v1+v2+v3`, including historical messages, active execution lease, pending outbox, active `agent_spend_days`, and `assistant_turns` with both `NULL` and non-`NULL` `response_message_id`) and legacy `GlobalBudgetDO` (unsettled reservation, settled reservation, spend day, incident) in real `workerd` DO SQLite.
  - Evicts both DOs (`evictDurableObject`), injects migration failure mid-upgrade on both `AgentHeadDO` (`v4`) and `GlobalBudgetDO` (`WITHOUT ROWID`), and verifies full transactional rollback (schema stays pre-v4 / non-`WITHOUT ROWID`, all legacy rows intact, `PRAGMA foreign_key_check` clean).
  - Evicts both DOs a second time, retries upgrade to `v4` / `WITHOUT ROWID`, and verifies full data preservation, `PRAGMA foreign_key_check`, partial `UNIQUE` enforcement on `response_message_id`, `ON DELETE CASCADE`, and post-upgrade RPC execution (`prepareTurn`, `reserveGlobal`, `settleGlobal`).
- **Schema Upgrade, Foreign Key Integrity & Deterministic Stale-Alarm Concurrency (`tests/unit/v2-m1-a6-sqlite-write-opt.test.ts`):** **4/4 PASS**
  - Covers `AgentHeadDO` `v1+v2+v3 -> v4`, `GlobalBudgetDO` `WITHOUT ROWID` upgrade, OPT-3/OPT-4 invariants, and deterministic gated-`getAlarm()` concurrency races verifying a stale `syncPlatformAlarm(null)` or later timestamp can never delete or postpone a concurrently committed earlier alarm.
- **M1 Full Runtime E2E Acceptance (`tests/integration/v2-m1-full-runtime-acceptance.test.ts`):** **23/23 PASS** (`0` duplicate provider calls, `0` duplicate commits, `0` budget overcommits, `0` lost accepted work, `50s / 66s` offline detection/recovery, multi-turn Edge SSE context verified).
- **M2-F1 Device Execution Compatibility (PR `#189`, `tests/integration/v2-m2-device-execution-workerd.test.ts`):** **6/6 PASS** (`v3` device execution migration checksum untouched; `v4` upgrades cleanly after `v3`).
- **GlobalBudget & Assembly Workerd Suites:** `tests/integration/v2-m1-global-budget-workerd.test.ts` (**4/4 PASS**), `tests/integration/v2-m1-runtime-assembly.test.ts` (**5/5 PASS**).
- **V2 Unit & B3/B4 Recovery/FI Suites:** `v2-m1-agent-head`, `v2-m1-b3-alarm-recovery`, `v2-m1-b3-alarm-recovery-workerd`, `v2-m1-b4-durable-integration`, `v2-m1-b4-fi-matrix-workerd`, `v2-m1-global-budget`, `v2-m1-runtime-contracts` (**42/42 PASS**).
- **Concurrency Sweep (`1 / 10 / 25 / 50`):** `100%` success, `0` safety violations across all 5 counters.

---

## 4. Remaining Optimization Recommendations (Phase 2)

`activeCoveredB1DurablePath` is now **`43.0` DO `rowsWritten/event`** — just **`3` writes/event above the `<= 40` break-even threshold**. Recommended next low-risk phase:

1. **OPT-8 (Reorder `syncAlarmAndRelayBudget` + `5–15 min` delayed D1 coverage retirement):** Eliminates spurious post-commit Alarm #2 and sequential-turn D1 retire/re-register churn (`-3.5` DO writes on idle-cycle and `-2.8` D1 writes/event).
2. **OPT-9 (Single-row `agent_spend_days` per `(principal_id, utc_day)`):** **`-2.0` DO writes/event** (`43 → 41`).
3. **OPT-10 (Inline best-effort `queue.send()` after `prepareTurn` Stage 3 with `5s` outbox fallback):** **`-2.0` DO writes/event** (`41 → 39`), crossing cleanly below both `$300 / $3,500` targets while also cutting durable dispatch latency.
4. **Optional OPT-6 / OPT-7** (`-2.0` DO writes/event) and **Tier 3** (`OPT-12..14`) if additional headroom (`~30` rows/event) is desired before `100k+` MAU.
