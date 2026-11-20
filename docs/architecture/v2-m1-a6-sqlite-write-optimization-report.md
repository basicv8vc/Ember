# V2 M1-A6 — DO SQLite Write Amplification Optimization Report

- **Date:** `2026-11-20`
- **Base:** `main @ b669b0e` (includes M1-A5 PR `#194` & M2-F1 Device Execution PR `#189`)
- **Scope Implemented:**
  - Live `GlobalBudgetDO` SQLite `rowsRead` / `rowsWritten` / `statements` telemetry in the local `workerd` benchmark harness (eliminating M0's hardcoded `8R / 9W` constants without modifying production `GlobalBudgetDO`)
  - **OPT-1:** Drop duplicate `idx_messages_conv_seq` on `conversation_messages` (via `AgentHeadDO` migration `v4`)
  - **OPT-2:** Convert `assistant_turns.response_message_id` from full `UNIQUE` to partial `UNIQUE INDEX idx_turns_response_message ... WHERE response_message_id IS NOT NULL` (via `v4`)
  - **OPT-3:** Guard `AlarmMultiplexer.runAlarmCycle` `alarm_fail_count = 0` reset with `AND alarm_fail_count > 0`
  - **OPT-4:** Replace SQLite `v2_recovery_coverage.armed_alarm_at_ms` read/write in `AlarmMultiplexer.syncPlatformAlarm` with in-process FIFO-serialized `storage.getAlarm()` (zero SQLite writes)
  - **OPT-5:** Rebuild small PK-lookup tables as `WITHOUT ROWID`: `assistant_turns`, `model_attempts`, `agent_spend_days`, `v2_dispatch_outbox` (`AgentHeadDO` `v4`), and `global_budget_reservations`, `global_budget_settlements` (`GlobalBudgetDO` automatic upgrade with `PRAGMA foreign_key_check`)
- **Explicitly Deferred (Per Plan):** OPT-6 (`idx_v2_outbox_budget_sync_op_rev`), OPT-7 (`global_grant_id UNIQUE`), and all Tier 2 / Tier 3 optimizations.
- **Safety Invariants:** Zero weakening of persistence, idempotency, fencing, recovery, or budget safety. Zero V1 changes. Zero cloud deployment.

---

## 1. Before vs After Measured DO SQLite Write Amplification (`[Measured: Local workerd]`)

Both BEFORE (unoptimized `main @ b669b0e` with live `GlobalBudgetDO` telemetry) and AFTER (OPT-1..5 applied) were measured in local `workerd` (`wrangler@4.158.0`, reproducible artifacts in `benchmarks/v2-m1/m1-full-runtime.json` and `benchmarks/v2-m1/m1-cost-reestimation.json`).

### 1.1 Four D8 Execution Paths — Before vs After

| Path                                                       | `AgentHeadDO` Writes (Before → After) | `GlobalBudgetDO` Writes (Before → After) | Total DO `rowsWritten` (Before → After) |             Delta             | `GlobalBudgetDO` `rowsRead` (Before → After) | D1 `rowsWritten` (After) |
| :--------------------------------------------------------- | :-----------------------------------: | :--------------------------------------: | :-------------------------------------: | :---------------------------: | :------------------------------------------: | -----------------------: |
| **`activeCoveredB1DurablePath`** (`n=5`, target `<= 44`)   |     `46.0` → **`35.0`** (`-11.0`)     |       `10.0` → **`8.0`** (`-2.0`)        |           `56.0` → **`43.0`**           | **`-13.0` (`-23.2%`) — PASS** |               `15.0` → `15.0`                |                   `0.00` |
| **`coveredB1DurablePath`** (`n=20`, sequential idle-cycle) |     `51.0` → **`38.0`** (`-13.0`)     |       `10.0` → **`8.0`** (`-2.0`)        |           `61.0` → **`46.0`**           |    **`-15.0` (`-24.6%`)**     |               `15.0` → `15.0`                |                   `3.40` |
| **`uncoveredB1DurablePath`** (`n=20`, fresh agent)         |     `52.0` → **`39.2`** (`-12.8`)     |       `10.0` → **`8.0`** (`-2.0`)        |           `62.0` → **`47.2`**           |    **`-14.8` (`-23.9%`)**     |               `15.0` → `15.0`                |                   `3.55` |
| **`covered3RpcFastPath`** (`n=20`, interactive fast path)  |     `42.0` → **`33.0`** (`-9.0`)      |       `10.0` → **`8.0`** (`-2.0`)        |           `52.0` → **`41.0`**           |    **`-11.0` (`-21.2%`)**     |               `15.0` → `15.0`                |                   `3.00` |

### 1.2 Live Measured `GlobalBudgetDO` Breakdown

Eliminating M0's hardcoded `8R / 9W` constant exposed the true `GlobalBudgetDO` per-turn SQLite I/O:

- **Before OPT-5:** `17` SQL statements, **`15` `rowsRead`**, **`10` `rowsWritten`** (`reserveGlobal = 5`, `authorizeGlobalSend = 1`, `settleGlobal = 4`).
- **After OPT-5 (`WITHOUT ROWID` on `global_budget_reservations` & `global_budget_settlements`):** `17` SQL statements, **`15` `rowsRead`**, **`8` `rowsWritten`** (`-2.0` writes/turn, `-20.0%`).

---

## 2. Before vs After Cost Re-Estimation (`10k / 100k` MAU)

Computed with `calculateAdr0006Cost()` (`apps/benchmark/src/cost-model.ts`) using D8's exact parameters (`independentRecoveryEnabled: true`, `monthsElapsed: 6`, `dormantRetainedRatio: 1.0`):

| Scenario (`DO rowsW / DO rowsR / D1 writes / Q ops`) | `10k MAU` Cloud Runtime | `10k` DO Write Cost | `100k MAU` Cloud Runtime | `100k` DO Write / D1 Write Cost |        Monthly Savings vs Before (`10k / 100k`) |
| :--------------------------------------------------- | ----------------------: | ------------------: | -----------------------: | ------------------------------: | ----------------------------------------------: |
| **BEFORE Idle-Cycle (`61 / 247 / 3.50 / 1.0`)**      |               `$439.89` |           `$367.24` |              `$5,271.80` |           `$4,122.40 / $428.80` |                                        Baseline |
| **BEFORE Active-Cov (`56 / 214 / 0.61 / 1.0`)**      |               `$405.69` |           `$333.04` |              `$4,534.45` |            `$3,780.40 / $33.45` |                                        Baseline |
| **AFTER Idle-Cycle (`46 / 252 / 3.43 / 1.0`)**       |           **`$337.29`** |           `$264.64` |          **`$4,236.22`** |           `$3,096.40 / $419.22` | **`-$102.60 (-23.3%)` / `-$1,035.58 (-19.6%)`** |
| **AFTER Active-Cov (`43 / 205 / 0.61 / 1.0`)**       |           **`$316.77`** |           `$244.12` |          **`$3,645.25`** |            `$2,891.20 / $33.45` |    **`-$88.92 (-21.9%)` / `-$889.20 (-19.6%)`** |
| **AFTER Fast Path (`41 / 177 / 0.61 / 0.0`)**        |           **`$300.76`** |           `$230.44` |          **`$3,481.49`** |            `$2,754.40 / $33.45` |                   — (100k **PASS** `<= $3,500`) |

---

## 3. Verification Matrix

- **Schema Upgrade, Foreign Key Integrity & Alarm Recovery (`tests/unit/v2-m1-a6-sqlite-write-opt.test.ts`):** **3/3 PASS**
  - Upgrades pre-v4 `AgentHeadDO` DB (`v1+v2+v3` → `v4`) preserving all existing rows, `UNIQUE` constraints, partial `UNIQUE` `response_message_id`, `WITHOUT ROWID`, and `PRAGMA foreign_key_check` + `ON DELETE CASCADE`.
  - Upgrades pre-OPT-5 `GlobalBudgetDO` DB to `WITHOUT ROWID` across all 4 tables (`global_spend_days`, `global_budget_reservations`, `global_budget_settlements`, `global_budget_incidents`) with `PRAGMA foreign_key_check` verification and preserved `UNIQUE`/`FOREIGN KEY` enforcement.
  - Verifies OPT-3 (`alarm_fail_count = 0` guard) and OPT-4 (`storage.getAlarm()` zero-write sync, consumed alarm re-arm, failure recovery, DO restart durability, and FIFO serialization of concurrent `syncPlatformAlarm` calls).
- **V2 Unit & Workerd Suites:** `v2-m1-agent-head` (`12/12`), `v2-m1-b1..b4` (`21/21` + `b3-workerd` + `b4-fi-matrix-workerd`), `v2-m1-global-budget` (`12/12` + `4/4` workerd), `v2-m1-runtime-contracts` (`4/4`), `v2-m1-runtime-assembly` (`5/5`) — **ALL PASS**.
- **M2 Device Execution Compatibility (PR `#189`, `tests/integration/v2-m2-device-execution-workerd.test.ts`):** **6/6 PASS** (`v3` device execution migration checksum untouched; `v4` upgrades cleanly after `v3`).
- **M1 Full Runtime E2E Acceptance (`tests/integration/v2-m1-full-runtime-acceptance.test.ts`):** **22/22 PASS** (`0` duplicate provider calls, `0` duplicate commits, `0` budget overcommits, `0` lost accepted work, `50s / 66s` offline detection/recovery).
- **Concurrency Sweep (`1 / 10 / 25 / 50`):** `100%` success, `0` safety violations across all 5 counters.

---

## 4. Remaining Optimization Recommendations (Phase 2)

`activeCoveredB1DurablePath` is now **`43` DO `rowsWritten/event`** — just **`3` writes/event above the `<= 40` break-even threshold** (`$296.25/mo` @ 10k, `$3,440.05/mo` @ 100k). Recommended next low-risk phase:

1. **OPT-8 (Reorder `syncAlarmAndRelayBudget` + `5–15 min` delayed D1 coverage retirement):** Eliminates spurious post-commit Alarm #2 and sequential-turn D1 retire/re-register churn (`-3.5` DO writes on idle-cycle and `-2.8` D1 writes/event, saving `~$400/mo` in D1 writes at `100k MAU`).
2. **OPT-9 (Single-row `agent_spend_days` per `(principal_id, utc_day)`):** **`-2.0` DO writes/event** (`43 → 41`).
3. **OPT-10 (Inline best-effort `queue.send()` after `prepareTurn` Stage 3 with `5s` outbox fallback):** **`-2.0` DO writes/event** (`41 → 39`), crossing cleanly below both `$300 / $3,500` targets (`$289 / $3,372`) while also cutting durable dispatch latency.
4. **Optional OPT-6 / OPT-7** (`-2.0` DO writes/event) and **Tier 3** (`OPT-12..14`) if additional headroom (`~30` rows/event, `$226 / $2,701`) is desired before `100k+` MAU.
