# Ember V2-M0-D — Benchmark & Cost Baseline Report

- **Status**: M0 Evidence Deliverable (`feat/v2-m0-benchmark-baseline`, Architect Review Revised)
- **Date**: 2026-11-19
- **Role**: Performance and Reliability Engineer
- **V1 Reference Baseline SHA**: `ee660f52f02cad196cf724f0f818df3789fe3e8c` (`main`, P0B-09c 1,000-agent load)
- **Probe / Harness Implementation SHA**: `14812da44197a365a4e08d4148c034e23f8a4c1e` + current PR revision (clean worktree after commit)
- **Related**: [ADR-0005](../adr/0005-cloudflare-native-runtime-v2.md), [ADR-0006](../adr/0006-experience-first-device-powered-runtime-v2.md), [P0B-09c Local Benchmark](../P0B-09C-BENCHMARK.md), [V1 Architecture Baseline](v1-architecture-baseline.md)

---

## 0. Evidence Classification, Guardrails & Provenance

Per ADR-0006 and V2-M0-D requirements, this report strictly separates four evidence classes. **Local loopback or `workerd` latencies are never presented as global production SLAs, local SQLite cursor counts are never claimed as verified Cloudflare billing invoices, and ADR-0006 `50 ms / 200 ms / 250 ms` numbers are engineering targets—not certified M0 acceptance results.**

| Label                                     | Meaning                                                                                                                                            | Source in this Deliverable                                                                                                       |
| :---------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------- |
| **`[Measured: Local V1 PG]`**             | Real HTTP + Hono + Worker + PostgreSQL 17 execution over `127.0.0.1` loopback (`FakeLlm` / `DeterministicExecutor`, zero external network calls).  | `benchmarks/v2-m0/v1-baseline.json`, `benchmarks/v2-m0/v1-load-1000/`                                                            |
| **`[Measured: Local V2 workerd Probe]`**  | Real local Cloudflare `workerd` runtime via Wrangler `4.158.0` executing SQLite-backed `AgentHeadDO` + `GlobalBudgetDO` + local D1 (`D1_CONTROL`). | `benchmarks/v2-m0/sqlite-probe.json`, `benchmarks/v2-m0/timing-methodology.json`                                                 |
| **`[Simulated: Synthetic]`**              | Deterministic jittered RTT injection, Node/V8 synthetic SSE CPU proxy, and offline model-routing profiles.                                         | `benchmarks/v2-m0/rtt-simulation.json`, `benchmarks/v2-m0/timing-methodology.json`, `benchmarks/v2-m0/model-routing-matrix.json` |
| **`[Estimated: ADR-0006 Cloud Formula]`** | Reproducible cost & sensitivity model using ADR-0006 official published rates (verified 2026-11-19) and modeled/repo-verified vectors.             | `benchmarks/v2-m0/cost-model.json`                                                                                               |

### Machine & Local-Only Safety Guardrails

- **Host OS**: `Darwin 27.2.0` (`arm64` / `Apple M1`, 8 cores, 16 GB RAM)
- **Node.js / PG / Wrangler**: `v24.11.0`, `PostgreSQL 17.11 (Homebrew)`, `wrangler@4.158.0` (`workerd 1.20261104.1`)
- **Local-Only Guard** ([local-guard.ts](../../apps/benchmark/src/local-guard.ts)): V2 local benchmark refuses remote/cloud DB hosts, production/staging DB names, `EMBER_ENV=production|staging`, `NODE_ENV=production`, invalid concurrency values, and ignores general `DATABASE_URL` fallback—even when `--enable-local-load` is set.
- **External LLM / Daytona / Cloud Deploy / CI**: **Disabled (0 real calls, 0 cloud resources, 0 GitHub Actions runs requested)**.

---

## 1. Reproducible Commands & Raw Artifacts

```bash
# 1. Run all V2-M0-D suites in one command
TEST_DATABASE_URL="postgres://ember:ember_local_dev_only@127.0.0.1:5432/ember_test" \
  pnpm bench:local --suite all --enable-local-load \
  --concurrency-levels 1,10,25,50 --requests-per-level 50 \
  --probe-iterations 40 --rtt-samples 20 --seed 42 \
  --out-dir benchmarks/v2-m0

# 2. Run the canonical 1,000-agent / 100-concurrency V1 task-load benchmark
TEST_DATABASE_URL="postgres://ember:ember_local_dev_only@127.0.0.1:5432/ember_test" \
  pnpm bench:local --agents 1000 --concurrency 100 --warmup 50 \
  --total-requests 1000 --task-mix "fast:70,standard:30" --seed 42 \
  --enable-local-load --out-dir benchmarks/v2-m0/v1-load-1000

# 3. Run individual suites or custom ADR-0006 cost sensitivity calculation
pnpm bench:local --suite sqlite-probe --probe-iterations 40 --out-dir benchmarks/v2-m0
pnpm bench:local --suite timing --probe-iterations 40 --out-dir benchmarks/v2-m0
pnpm bench:local --suite rtt-sim --rtt-samples 20 --seed 42 --out-dir benchmarks/v2-m0
pnpm bench:local --suite cost-model --mau 10000 --allowance-ratio 0.5 --do-write-rows 25 --device-offload 0.5
pnpm bench:local --suite model-routing --out-dir benchmarks/v2-m0
```

| Raw Artifact                                                                                                                     | Suite / Scope                                                                            | Provenance                                                      |
| :------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- | :-------------------------------------------------------------- |
| [v1-baseline.json](../../benchmarks/v2-m0/v1-baseline.json)                                                                      | V1 B1 Chat + Task Submit + Status Reads + Concurrency Sweep + Exact Row Deltas           | `[Measured: Local V1 PG]`                                       |
| [load-benchmark-2026-11-19T12-02-37-470Z.json](../../benchmarks/v2-m0/v1-load-1000/load-benchmark-2026-11-19T12-02-37-470Z.json) | Canonical 1,000-agent / 100-concurrency V1 Task Load Baseline (`main @ ee660f5`)         | `[Measured: Local V1 PG]`                                       |
| [sqlite-probe.json](../../benchmarks/v2-m0/sqlite-probe.json)                                                                    | Local `workerd` `AgentHeadDO` + `GlobalBudgetDO` + `D1_CONTROL` Probe & Storage Growth   | `[Measured: Local V2 workerd Probe]`                            |
| [timing-methodology.json](../../benchmarks/v2-m0/timing-methodology.json)                                                        | Simplified 2-RPC vs Joint A/B 3-RPC Seam Timing, Synthetic Stream CPU, Budget Contention | `[Measured: Local V2 workerd Probe]` + `[Simulated: Synthetic]` |
| [rtt-simulation.json](../../benchmarks/v2-m0/rtt-simulation.json)                                                                | 5-Region RTT Simulation across Simplified & Joint A/B Seam Modes                         | `[Simulated: Synthetic]`                                        |
| [cost-model.json](../../benchmarks/v2-m0/cost-model.json)                                                                        | ADR-0006 Reference Cost Matrix & Multi-Parameter Sensitivity Sweeps                      | `[Estimated: ADR-0006 Cloud Formula]`                           |
| [model-routing-matrix.json](../../benchmarks/v2-m0/model-routing-matrix.json)                                                    | Repo-Derived Model Routing Evaluation Matrix (Privacy & Approval Gated)                  | `[Simulated: Synthetic]` + Repo Verified Rates                  |

---

## 2. V1 Local Performance Baseline `[Measured: Local V1 PG]`

### 2.1 Concurrency Sweep: B1 Conversation vs Task Submission vs Status Reads

Measured against isolated PostgreSQL 17 schemas (`50` operations per workload per concurrency level; B1 turns processed by `FakeTurnResponder` at `25 ms` poll interval; tasks processed by `DeterministicExecutor` at `25 ms` poll loop; all `50/50` succeeded at every level).

| Concurrency | Chat `N`/`OK` | Chat ACK P50 / P95 (ms) | Chat E2E P50 / P95 (ms) | Chat Throughput (turn/s) | Task `N`/`OK` | Task ACK P50 / P95 (ms) | Task E2E P50 / P95 (ms) | Task Throughput (task/s) | Status Read P95 (ms) |
| ----------: | :-----------: | ----------------------: | ----------------------: | -----------------------: | :-----------: | ----------------------: | ----------------------: | -----------------------: | -------------------: |
|       **1** |    50 / 50    |             5.83 / 9.88 |           31.14 / 47.77 |                    31.12 |    50 / 50    |            5.08 / 12.75 |         109.28 / 133.66 |                     9.53 |                 3.21 |
|      **10** |    50 / 50    |            4.63 / 60.56 |          57.10 / 116.56 |                   149.84 |    50 / 50    |            4.30 / 36.42 |          85.11 / 185.88 |                    99.09 |                10.49 |
|      **25** |    50 / 50    |           29.39 / 74.56 |         116.24 / 195.20 |                   171.97 |    50 / 50    |           22.62 / 49.66 |         233.40 / 356.03 |                    98.27 |                19.18 |
|      **50** |    50 / 50    |           64.02 / 78.80 |         257.51 / 339.99 |                   145.57 |    50 / 50    |           48.00 / 62.07 |         470.22 / 547.11 |                    88.88 |                22.53 |

### 2.2 Status & History Read Scaling (`GET`)

| Endpoint                                   | `c=1` P50 / P95 (req/s)     | `c=10` P50 / P95 (req/s)       | `c=25` P50 / P95 (req/s)        | `c=50` P50 / P95 (req/s)        |
| :----------------------------------------- | :-------------------------- | :----------------------------- | :------------------------------ | :------------------------------ |
| `GET /v1/tasks/:id`                        | 1.56 / 3.21 ms (`586.37/s`) | 6.20 / 10.49 ms (`1,413.15/s`) | 15.07 / 19.18 ms (`1,548.76/s`) | 22.31 / 22.53 ms (`1,948.08/s`) |
| `GET /v1/conversations/:id/messages`       | 6.85 / 8.95 ms (`142.86/s`) | 8.51 / 12.12 ms (`1,101.73/s`) | 22.79 / 28.23 ms (`1,026.57/s`) | 43.10 / 44.20 ms (`1,092.77/s`) |
| `GET /v1/conversations/:id/turns/:turn_id` | 7.35 / 9.73 ms (`135.77/s`) | 5.82 / 8.85 ms (`1,653.23/s`)  | 17.46 / 26.42 ms (`1,332.08/s`) | 28.31 / 29.87 ms (`1,573.81/s`) |

### 2.3 Canonical 1,000-Agent / 100-Concurrency Task Load Baseline (`main @ ee660f5`)

- **Provisioning**: `1,000` agents + `1,000` version-0 workspaces in `478 ms` (`2,091.9 agents/s`, P95 = `19.55 ms`, `0` resident processes/sandboxes).
- **Closed Loop (`N = 1,000`, `70%` `mock.chat` / `30%` `mock.compute`, `100` concurrent HTTP)**:
  - `1,000 / 1,000` succeeded (`0` lost); Durable Ack P50 = `4.45 ms`, P95 = `39.23 ms`, P99 = `50.95 ms`.
  - Queue Wait P50 = `731.00 ms`, P95 = `1,013.40 ms`; Task Completion P50 = `1,151.39 ms`, P95 = `1,556.55 ms`.
  - Peak RSS `393.0 MB`, Peak PG active connections `51`, Worker peak in-flight `40 / 100`, Peak live Fake Sandboxes `2` (`0` idle).

### 2.4 V1 PostgreSQL Exact Row Deltas & `pg_stat_user_tables` Attribution Caveat

Because PG17 `pg_stat_user_tables` buffers per-backend tuple statistics across idle `pg.Pool` connections (so pooled runs like `c=10` can under-report collector deltas—explicitly flagged `pgStatAttributionComplete: false`), we measure **deterministic `SELECT COUNT(*)` deltas** (`exactNetRowsInserted`) alongside raw `pg_stat_user_tables` observations:

| Workload                    | `c` | `N` / `OK` | Exact Net Rows Inserted (`COUNT(*)`) | Exact Rows / Op | `pg_stat` Tuple Mutations (`ins+upd+del`) | `pg_stat` Attribution Complete?       |
| :-------------------------- | --: | :--------: | -----------------------------------: | --------------: | ----------------------------------------: | :------------------------------------ |
| `v1_b1_conversation_turn`   |   1 |  50 / 50   |    **150** (`100` msgs + `50` turns) |        **3.00** |          254 (`5.08`/op; observed sample) | `false` (pool collector lag on msgs)  |
| `v1_b1_conversation_turn`   |  10 |  50 / 50   |                              **150** |        **3.00** |                           120 (`2.40`/op) | `false` (`INCOMPLETE_POOL_STATS_LAG`) |
| `v1_b1_conversation_turn`   |  25 |  50 / 50   |                              **150** |        **3.00** |                           114 (`2.28`/op) | `false` (`INCOMPLETE_POOL_STATS_LAG`) |
| `v1_b1_conversation_turn`   |  50 |  50 / 50   |                              **150** |        **3.00** |                           121 (`2.42`/op) | `false` (`INCOMPLETE_POOL_STATS_LAG`) |
| `v1_durable_task_lifecycle` |   1 |  50 / 50   |                  **900** (12 tables) |       **18.00** |       1,397 (`27.94`/op; observed sample) | `false` (pool collector lag)          |
| `v1_durable_task_lifecycle` |  10 |  50 / 50   |                              **850** |       **17.00** |                           350 (`7.00`/op) | `false` (`INCOMPLETE_POOL_STATS_LAG`) |
| `v1_durable_task_lifecycle` |  25 |  50 / 50   |                              **850** |       **17.00** |                        1,080 (`21.60`/op) | `false` (`INCOMPLETE_POOL_STATS_LAG`) |
| `v1_durable_task_lifecycle` |  50 |  50 / 50   |                              **850** |       **17.00** |                        1,328 (`26.56`/op) | `false` (`INCOMPLETE_POOL_STATS_LAG`) |

**Takeaway**: Deterministic `COUNT(*)` confirms every B1 conversation turn inserts **3** net rows (`2` `conversation_messages` + `1` `assistant_turns`, plus `UPDATE`s on `conversations` and `assistant_turns`), while every V1 durable task inserts **17–18** net rows across 10+ tables (`tasks`, `runs`, `task_events`, `budget_operations`, `staged_blobs`, `artifacts`, `blobs`, `step_checkpoints`, `workspace_versions`, `task_results`, `operation_receipts`).

---

## 3. Isolated Local DO SQLite, GlobalBudgetDO & D1 Probe `[Measured: Local V2 workerd Probe]`

Executed in local `workerd` (`wrangler@4.158.0`, `40` iterations/op) comparing `AgentHeadDO` (SQLite), `GlobalBudgetDO` (SQLite), and `D1_CONTROL` (local Miniflare D1).

### 3.1 Simplified 2-RPC & Lifecycle Operations (DO SQLite vs Local D1)

| Operation                        | DO Logical Stmts / Mut | DO `rowsRead` (Mean) | DO `rowsWritten` (Mean) | DO `setAlarm` | DO Latency P50 / P95 (ms) | D1 `rowsRead` (Mean) | D1 `rowsWritten` (Mean) | D1 Latency P50 / P95 (ms) |
| :------------------------------- | :--------------------: | -------------------: | ----------------------: | :-----------: | :-----------------------: | -------------------: | ----------------------: | :-----------------------: |
| `normal_turn_prepare`            |         7 / 5          |                 9.10 |               **13.00** |     **1**     |        4.30 / 5.79        |                10.45 |               **16.00** |        4.01 / 5.45        |
| `normal_turn_commit`             |         6 / 5          |                 5.00 |                **9.00** |       0       |        3.34 / 5.04        |                 5.03 |                **9.03** |        3.25 / 4.92        |
| `task_submit`                    |         2 / 2          |                 0.00 |                **6.00** |     **1**     |        3.19 / 4.20        |                 0.97 |                **9.00** |        2.88 / 4.40        |
| `task_claim_complete`            |         4 / 3          |                 4.00 |                **5.00** |       0       |        3.09 / 4.66        |                 4.00 |                **5.00** |        2.88 / 4.31        |
| `lease_renewal`                  |         2 / 1          |                 2.00 |                **2.00** |     **1**     |        3.48 / 4.44        |                 2.00 |                **2.00** |        3.00 / 4.19        |
| `alarm_batch_dispatch` (5 items) |         7 / 5          |                11.00 |               **10.00** |     **1**     |        3.54 / 4.96        |                10.00 |               **10.00** |        3.76 / 5.21        |
| `retry_schedule`                 |         2 / 1          |                 2.00 |                **2.00** |     **1**     |        3.27 / 4.17        |                 3.00 |                **5.00** |        3.17 / 4.19        |

### 3.2 Representative Joint A/B M1 Seam Operations (`3` DO RPCs + `GlobalBudgetDO` + Uncovered D1)

| Engine             | Operation                 | `rowsRead` (Mean) | `rowsWritten` (Mean) | `setAlarm` | Latency P50 / P95 (ms) |
| :----------------- | :------------------------ | ----------------: | -------------------: | :--------: | :--------------------: |
| `do_sqlite`        | `mark_attempt_sent`       |              2.00 |             **1.00** |     0      |      3.33 / 4.06       |
| `do_sqlite`        | `budget_sync_commit`      |              2.00 |             **8.00** |     0      |      3.26 / 4.91       |
| `global_budget_do` | `global_budget_reserve`   |              2.00 |             **4.00** |     0      |      2.68 / 4.33       |
| `global_budget_do` | `global_budget_authorize` |              3.00 |             **2.00** |     0      |      2.65 / 3.70       |
| `global_budget_do` | `global_budget_settle`    |              3.00 |             **3.00** |     0      |      2.94 / 5.00       |
| `d1_local`         | `d1_recovery_register`    |              0.75 |             **3.00** |     0      |      2.33 / 3.04       |
| `d1_local`         | `d1_recovery_confirm`     |              1.00 |             **0.00** |     0      |      2.24 / 3.72       |

> [!NOTE]
> **Probe Limitations & Calibration Caveats**:
>
> 1. Observed `SqlStorageCursor.rowsRead`/`rowsWritten` and `D1.meta.rows_read`/`rows_written` are **local `workerd` runtime cursor counters**, NOT verified Cloudflare production billing invoices.
> 2. In this probe, `await this.ctx.storage.setAlarm(...)` is called _after_ `transactionSync()`, and `normal_turn_commit` does not implement full business fencing (run/epoch/deletion checks). Local `alarmRealFireVerified = true` (`alarmRealFireDelayMs = 3 ms`) only demonstrates local `workerd` alarm invocation—it does **not** prove atomic DB+Alarm durability, 6-retry exhaustion recovery, or full V2 semantics.
> 3. The simplified 2-RPC turn (`13 + 9 = 22` DO `rowsWritten`) excludes `mark_attempt_sent` (`+1` DO write), `budget_sync` outbox writes, `GlobalBudgetDO` (`4 + 2 + 3 = 9` DO writes on the global authority), and uncovered D1 `d1_recovery_register` (`+3` D1 writes). ADR-0006's `20` DO rows written/event is a **cost-modeling assumption**, not a pass/fail gate.

### 3.3 Storage Growth Curve (`0` to `300` Turns)

|                    Turn Count | DO SQLite `databaseSize` (Bytes) | Local D1 `size_after` (Bytes) |
| ----------------------------: | -------------------------------: | ----------------------------: |
|    **0** (initialized schema) |                           86,016 |                       155,648 |
|                        **50** |                          106,496 |                       200,704 |
|                       **150** |                          184,320 |                       270,336 |
|                       **300** |                          286,720 |                       380,928 |
| **Derived Net Growth / Turn** |           **`669.0 bytes/turn`** |        **`750.9 bytes/turn`** |

---

## 4. Timing Methodology: Simplified vs Joint A/B Seam, Streaming CPU & Budget Contention

### 4.1 Local `workerd` Timing Breakdown (`N = 40`, all `40/40` succeeded, `0` errors) `[Measured: Local V2 workerd Probe]`

1. **Simplified 2-RPC Microbenchmark (`1` D1 update + DO `prepare` + DO `commit`)**:
   - `d1CounterUpdateMs` P95: `4.97 ms`, `doPrepareMs` P95: `6.58 ms`, `doCommitMs` P95: `6.54 ms`.
   - **`ackMs`**: P50 = `8.13 ms`, P95 = **10.20** ms.
   - **`runtimeOverheadMs`**: P50 = `12.99 ms`, P95 = **16.36** ms.

2. **Representative M1 Joint A/B Seam (`GlobalBudgetDO reserve -> AgentHeadDO prepare -> [D1 reg+confirm if uncovered] -> GlobalBudgetDO authorize -> AgentHeadDO markAttemptSent -> AgentHeadDO commit+budget_sync -> GlobalBudgetDO settle`)**:
   - Component P95s: `globalBudgetReserve` = `5.84 ms`, `doPrepare` = `6.25 ms`, `d1UncoveredRegisterAndConfirm` = `8.68 ms`, `globalBudgetAuthorize` = `5.65 ms`, `doMarkAttemptSent` = `4.93 ms`, `doCommitWithBudgetSync` = `5.39 ms`, `globalBudgetSettle` = `5.31 ms`.
   - **`ackCoveredMs`**: P50 = `8.01 ms`, P95 = **10.59** ms (`ackUncoveredMs` P50 = `14.81 ms`, P95 = **17.66** ms).
   - **`runtimeOverheadCoveredMs`**: P50 = `24.19 ms`, P95 = **31.44** ms (roughly `2x` the simplified 2-RPC microbenchmark due to 3 DO RPCs + `GlobalBudgetDO` round-trips).
   - **`runtimeOverheadUncoveredMs`**: P50 = `30.78 ms`, P95 = **38.45** ms.

### 4.2 Synthetic Streaming CPU vs Wall Time `[Simulated: Synthetic]`

_(Measured via Node.js/V8 `process.cpuUsage()` over synthetic Web `ReadableStream`; NOT Cloudflare Workers isolate CPU.)_

| Stream Scenario            | Chunks x Bytes | Token Wait (ms/chunk) | Wall Time Mean / P95 (ms) | Active CPU Mean / P95 (ms) | Wait-Wall Share (%) |
| :------------------------- | :------------: | --------------------: | ------------------------: | -------------------------: | ------------------: |
| `burst_50_chunks_24B`      |   50 x 24 B    |                     0 |               0.08 / 0.16 |                0.12 / 0.33 |               0.00% |
| `burst_200_chunks_24B`     |   200 x 24 B   |                     0 |               0.19 / 0.22 |                0.47 / 0.94 |               0.00% |
| `paced_50_chunks_5ms_wait` |   50 x 24 B    |                     5 |           280.49 / 281.77 |                3.56 / 3.78 |          **98.73%** |

### 4.3 Global Budget Check Contention & Fail-Closed Invariant `[Measured: Local V2 workerd Probe]`

| Target Authority   | Mode                                 | Concurrency | `N` | Approved / Denied Expected / Errors | Over-Committed? | Latency P50 / P95 (ms) |
| :----------------- | :----------------------------------- | ----------: | --: | :---------------------------------: | :-------------: | ---------------------: |
| `global_budget_do` | `sequential_warm`                    |           1 |  30 |             30 / 0 / 0              |     `false`     |            3.63 / 4.66 |
| `global_budget_do` | `concurrent_contention`              |          20 |  40 |             40 / 0 / 0              |     `false`     |      27.69 / **46.49** |
| `global_budget_do` | `exhaustion_fail_closed` (`cap=50k`) |          20 |  20 |           **10 / 10 / 0**           |   **`false`**   |          27.42 / 27.50 |
| `d1_control_row`   | `sequential_warm`                    |           1 |  30 |             30 / 0 / 0              |     `false`     |            2.66 / 3.85 |
| `d1_control_row`   | `concurrent_contention`              |          20 |  40 |             40 / 0 / 0              |     `false`     |          22.90 / 27.40 |
| `d1_control_row`   | `exhaustion_fail_closed` (`cap=50k`) |          20 |  20 |           **10 / 10 / 0**           |   **`false`**   |          24.90 / 25.51 |

> [!WARNING]
> Even locally with zero WAN latency, `20`-way concurrent contention on a single `GlobalBudgetDO` reached **P95 = `46.49 ms`** (approaching ADR-0006's `50 ms` M1 target).

---

## 5. Regional RTT Simulation `[Simulated: Synthetic]`

Injected synthetic jittered RTTs (`seed = 42`, `20/20` succeeded, `0` errors) across 4 modes:

- `simplified_2_rpc_local_check` _(unapproved M0 hypothesis/microbenchmark only)_
- `m0_covered_joint_seam_colocated` _(M0 A/B contract: 3 DO RPCs + colocated `GlobalBudgetDO` reserve/authorize/settle)_
- `m0_covered_joint_seam_cross_region_budget` _(M0 A/B contract: 3 DO RPCs + cross-region `GlobalBudgetDO`)_
- `m0_uncovered_joint_seam_with_d1_registration` _(M0 A/B contract + D1 `recovery_register` + `recovery_confirm`)_

| Region (Client / Edge->DO / Control RTT) | Mode (`M0 Contract?`)                                   |  ACK P50 / P95 (ms) |  Runtime P50 / P95 (ms) | Budget P95 (ms) | Provisional Targets (`ACK<=250` / `RT<=200` / `B<=50`) |
| :--------------------------------------- | :------------------------------------------------------ | ------------------: | ----------------------: | --------------: | :----------------------------------------------------: |
| **near-region** (`12 / 4 / 8 ms`)        | `simplified_2_rpc_local_check` (`false`)                |       22.63 / 32.18 |           23.18 / 33.50 |            3.63 |                   PASS / PASS / PASS                   |
| **near-region** (`12 / 4 / 8 ms`)        | `m0_covered_joint_seam_colocated` (`true`)              |       35.73 / 45.97 |           62.38 / 70.69 |           26.69 |                 **PASS / PASS / PASS**                 |
| **near-region** (`12 / 4 / 8 ms`)        | `m0_covered_joint_seam_cross_region_budget` (`true`)    |       38.89 / 43.13 |           74.72 / 81.02 |           33.55 |                 **PASS / PASS / PASS**                 |
| **near-region** (`12 / 4 / 8 ms`)        | `m0_uncovered_joint_seam_with_d1_registration` (`true`) |       64.11 / 77.41 |          97.73 / 108.74 |           37.24 |                 **PASS / PASS / PASS**                 |
| **apac-intra** (`20 / 38 / 42 ms`)       | `simplified_2_rpc_local_check` (`false`)                |       66.75 / 71.92 |           90.35 / 97.64 |            2.56 |                   PASS / PASS / PASS                   |
| **apac-intra** (`20 / 38 / 42 ms`)       | `m0_covered_joint_seam_colocated` (`true`)              |     111.08 / 118.61 |     268.70 / **275.43** |       **93.94** |                   PASS / FAIL / FAIL                   |
| **apac-intra** (`20 / 38 / 42 ms`)       | `m0_covered_joint_seam_cross_region_budget` (`true`)    |     119.02 / 122.75 |     283.42 / **305.19** |      **104.77** |                   PASS / FAIL / FAIL                   |
| **apac-intra** (`20 / 38 / 42 ms`)       | `m0_uncovered_joint_seam_with_d1_registration` (`true`) |     209.35 / 227.32 |     372.32 / **386.82** |      **105.03** |                   PASS / FAIL / FAIL                   |
| **eu-us-east** (`18 / 78 / 78 ms`)       | `simplified_2_rpc_local_check` (`false`)                |     108.51 / 117.88 |         179.46 / 192.35 |            4.25 |                   PASS / PASS / PASS                   |
| **eu-us-east** (`18 / 78 / 78 ms`)       | `m0_covered_joint_seam_colocated` (`true`)              |     199.06 / 217.93 |     536.12 / **555.46** |      **191.67** |                   PASS / FAIL / FAIL                   |
| **eu-us-east** (`18 / 78 / 78 ms`)       | `m0_covered_joint_seam_cross_region_budget` (`true`)    |     199.61 / 214.97 |     535.95 / **547.82** |      **192.53** |                   PASS / FAIL / FAIL                   |
| **eu-us-east** (`18 / 78 / 78 ms`)       | `m0_uncovered_joint_seam_with_d1_registration` (`true`) | 355.36 / **368.47** |     684.93 / **697.12** |      **183.30** |                   FAIL / FAIL / FAIL                   |
| **apac-us-west** (`22 / 120 / 120 ms`)   | `m0_covered_joint_seam_colocated` (`true`)              | 297.36 / **313.75** |     809.13 / **834.90** |      **295.10** |                   FAIL / FAIL / FAIL                   |
| **apac-us-west** (`22 / 120 / 120 ms`)   | `m0_uncovered_joint_seam_with_d1_registration` (`true`) | 565.75 / **588.95** | 1,094.63 / **1,113.15** |      **293.48** |                   FAIL / FAIL / FAIL                   |
| **cross-global** (`25 / 185 / 185 ms`)   | `m0_covered_joint_seam_colocated` (`true`)              | 423.54 / **444.17** | 1,201.83 / **1,239.03** |      **412.74** |                   FAIL / FAIL / FAIL                   |
| **cross-global** (`25 / 185 / 185 ms`)   | `m0_uncovered_joint_seam_with_d1_registration` (`true`) | 815.87 / **834.37** | 1,587.93 / **1,628.43** |      **414.97** |                   FAIL / FAIL / FAIL                   |

**Regional Takeaway**: Under the full M0 3-RPC + `GlobalBudgetDO` (`reserve + authorize + settle`) joint seam, **only `near-region` meets the `200 ms` Runtime Overhead and `50 ms` Budget Check targets** (`70.69 ms` Runtime, `26.69 ms` Budget). Across `>= 38 ms` intra-region WAN hops (`apac-intra` and beyond), multiplying sequential round-trips (`reserve + prepare + authorize + markAttemptSent + commit + settle`) exceeds `200 ms` (`275–1,628 ms`). No preallocated grant mechanism is approved or implemented in M0; if M1 misses targets in multi-region testing, bounded grants with proven global caps or co-located batching should be evaluated separately.

---

## 6. ADR-0006 Cost Model & Sensitivity Analysis `[Estimated: ADR-0006 Cloud Formula]`

Implemented in [cost-model.ts](../../apps/benchmark/src/cost-model.ts), retaining the exact ADR-0006 15-cell reference matrix alongside near-term model cost estimates and parameter sensitivity sweeps.

### 6.1 Verified ADR-0006 Cloud Runtime Reference Matrix (USD/month)

|                 MAU | Weighted Events/mo (`684 * N`) | Full Allowance (100%) | 50% Allowance Remaining | Zero Allowance (0%) | ADR-0006 Budget Envelope |
| ------------------: | -----------------------------: | --------------------: | ----------------------: | ------------------: | -----------------------: |
|        **10** (PoC) |                          6,840 |             **$5.00** |               **$5.00** |          **$22.73** |                      $10 |
|     **100** (Alpha) |                         68,400 |             **$5.00** |               **$5.08** |          **$24.70** |                      $15 |
|    **1,000** (Beta) |                        684,000 |             **$9.33** |              **$10.43** |          **$44.62** |   $30 target / $60 cond. |
| **10,000** (Growth) |                      6,840,000 |           **$176.07** |             **$208.14** |         **$245.01** |                     $300 |
| **100,000** (Scale) |                     68,400,000 |         **$2,204.80** |           **$2,261.13** |       **$2,326.00** |                   $3,500 |

### 6.2 Parameter Sensitivity Highlights (Full Account Allowance Baseline)

1. **DO SQLite Write Amplification (`doRowsWrittenPerEvent`)**: At `10,000 MAU`, `10 -> 20 -> 30 -> 40 -> 60` rows/event = `$107.67 -> $176.07 -> $244.47 -> $312.87 -> $449.67`. At `100,000 MAU`, = `$1,520.80 -> $2,204.80 -> $2,888.80 -> $3,572.80 -> $4,940.80` (`+$684.00/mo` per `+10` writes/event). Under the joint A/B seam (`13 + 8 + 1 + 9 = 31` total DO writes across `AgentHeadDO` + `GlobalBudgetDO` per turn), steady-state `100k MAU` DO write charges would exceed ADR-0006's `20`-row assumption unless coalesced or audited in M4.
2. **DO Billable Active Duration (`0.128 GB`)**: At `10,000 MAU`, `0.5 s -> 2 s -> 5 s -> 10 s` = `$176.07 -> $188.57 -> $213.57 -> $276.07`; at `100,000 MAU`, = `$2,204.80 -> $2,379.80 -> $2,704.80 -> $3,254.80`.
3. **Worker Streaming & Processing CPU**: At `100,000 MAU`, `30 ms -> 40 ms -> 70 ms -> 110 ms` = `$2,191.12 -> $2,204.80 -> $2,245.84 -> $2,300.56` (`+$13.68/mo` per `+10 ms`/event).
4. **Storage Growth Stock + Dormancy (`3,500 B/event`, `2.0x` dormant at `5 MB/dormant`)**: At `10,000 MAU` (`1 -> 12` months), DO storage grows from `128.94 GB` (`$157.18` cloud) to `392.28 GB` (`$218.88` cloud); at `100,000 MAU` month 12, `3,922.80 GB` adds `$783.56` DO storage overage (`$2,632.87` cloud).
5. **Independent Recovery Overhead (`43,200` cron/mo + D1 writes/event)**: At `100,000 MAU`, `1` D1 write/event adds `+$32.93/mo` (`$2,237.73`); `2` D1 writes/event adds `+$101.33/mo` (`$2,306.13`).

### 6.3 Near-Term Model & Daytona Sandbox Estimates `[Estimated: ADR-0006 Cloud Formula + Repo Rates]`

|        MAU | LLM Cost Estimate (`5k` in / `1k` out per event)                      | Device Offload | Cloud Runtime |  LLM Spend |      Sandbox Net |          Combined Monthly |
| ---------: | :-------------------------------------------------------------------- | -------------: | ------------: | ---------: | ---------------: | ------------------------: |
|  **1,000** | `Nemotron-3.5-Lightning ZDR` (`$0.06/$0.16`, `internal stagingAlpha`) |       0% / 50% |         $9.33 |    $314.64 | $166.50 / $83.25 |     **$490.47 / $407.22** |
|  **1,000** | `DeepSeek-V4.1-Flash ZDR` (`$0.098/$0.294`, `internal stagingAlpha`)  |       0% / 50% |         $9.33 |    $536.26 | $166.50 / $83.25 |     **$712.09 / $628.84** |
|  **1,000** | `ADR-0006 Illustrative` (`$0.50/$2.00`, unapproved quote)             |       0% / 50% |         $9.33 |  $3,078.00 | $166.50 / $83.25 | **$3,253.83 / $3,170.58** |
| **10,000** | `DeepSeek-V4.1-Flash ZDR` (`$0.098/$0.294`, `internal stagingAlpha`)  |            50% |       $176.07 |  $5,362.56 |          $832.50 |             **$6,371.13** |
| **10,000** | `ADR-0006 Illustrative` (`$0.50/$2.00`, unapproved quote)             |             0% |       $176.07 | $30,780.00 |        $1,665.00 |            **$32,621.07** |

---

## 7. Model Routing Evaluation Matrix `[Simulated: Synthetic]`

All rates, provenance, `reasoningEffort`, ZDR/data-collection flags, and approval states are derived directly from `@ember/model-gateway` (`evaluationDateUtc = 2026-11-19`, `evalCaseCount = 8`, **0 real LLM calls**). Privacy-sensitive cases (`eval-private-1`) are ineligible (`privacyEligible = false`) on all cloud routes absent explicit consent.

| Route ID (`provider / model`)                                                    | Repo Approval & Rate Provenance                                                   |        Auth Eligible?        | Assumed Accuracy (Eligible) | Cap. / Priv. Eligible | Full Eligible Success | Cost / Success Task | Privacy / ZDR                               |
| :------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------- | :--------------------------: | --------------------------: | :-------------------: | --------------------: | ------------------: | :------------------------------------------ |
| `cloud-fast-zdr-nemotron` (`openrouter / nvidia/nemotron-3.5-lightning`)         | `smoke_expired_internal_staging_only` (`official_price_verified` `$0.06/$0.16`)   | **Yes** _(internal staging)_ |                       86.0% |       7/8 / 7/8       |                 75.0% |       **$0.000286** | ZDR + `dataCollection=deny` (DeepInfra)     |
| `cloud-vision-tools-deepseek` (`openrouter / deepseek/deepseek-v4.1-flash-1017`) | `smoke_expired_internal_staging_only` (`official_price_verified` `$0.098/$0.294`) | **Yes** _(internal staging)_ |                       92.7% |       8/8 / 7/8       |                 87.5% |       **$0.000403** | ZDR + `dataCollection=deny` (DeepInfra fp8) |
| `cloud-reasoning-gpt56-luna` (`openai / gpt-5.6-luna`)                           | `pending_cto_approval` (`unverified` `$0.20/$1.20`)                               |            **No**            |                       96.4% |       8/8 / 7/8       |                 87.5% |           $0.000979 | Non-ZDR / Pending review                    |
| `cloud-adr0006-illustrative` (`adr0006-budget-reference-model`)                  | `research_only` (`illustrative` `$0.50/$2.00`)                                    |            **No**            |                       94.9% |       8/8 / 7/8       |                 87.5% |           $0.002178 | Illustrative quote only                     |
| `device-local-mlx-small` (`apple-device-local`)                                  | `research_only` (`zero_egress_local` `$0/$0`)                                     |        **No** _(M2+)_        |                       81.4% |     5/8 / **8/8**     |                 37.5% |       **$0.000000** | On-device, zero cloud egress                |

### Authorization-Gated Routing Policy Summary

- **`simple_low_latency_chat`**: Primary `cloud-fast-zdr-nemotron`, Fallback `cloud-vision-tools-deepseek` _(internal stagingAlpha scope only; smoke grants expired)_.
- **`tool_calling_and_multimodal`**: Primary `cloud-vision-tools-deepseek`, Fallback `null` _(no second approved vision+tool route)_.
- **`privacy_sensitive_local_only`**: Primary `device-local-mlx-small` _(research-only pending M2+ device runtime)_, Fallback `null` _(private inputs remain local-only absent explicit user consent)_.
- **`complex_high_accuracy_reasoning`**: Primary `cloud-vision-tools-deepseek`, Fallback `null` _(`gpt-5.6-luna` is `pending_cto_approval` and excluded from fallbacks)_.
