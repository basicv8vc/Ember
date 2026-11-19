# Ember V2-M0-D — Benchmark & Cost Baseline Report

- **Status**: M0 Evidence Deliverable (`feat/v2-m0-benchmark-baseline`)
- **Date**: 2026-11-19
- **Role**: Performance and Reliability Engineer
- **Git Baseline SHA**: `ee660f52f02cad196cf724f0f818df3789fe3e8c`
- **Related**: [ADR-0005](../adr/0005-cloudflare-native-runtime-v2.md), [ADR-0006](../adr/0006-experience-first-device-powered-runtime-v2.md), [P0B-09c Local Benchmark](../P0B-09C-BENCHMARK.md), [V1 Architecture Baseline](v1-architecture-baseline.md)

---

## 0. Evidence Classification & Guardrails

Per ADR-0006 and V2-M0-D requirements, this report strictly separates four evidence classes. **Local loopback or `workerd` latencies are never presented as global production SLAs, and local SQLite cursor counts are never claimed as verified Cloudflare billing invoices.**

| Label                                     | Meaning                                                                                                                                           | Source in this Deliverable                                                                                                       |
| :---------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------- |
| **`[Measured: Local V1 PG]`**             | Real HTTP + Hono + Worker + PostgreSQL 17 execution over `127.0.0.1` loopback (`FakeLlm` / `DeterministicExecutor`, zero external network calls). | `benchmarks/v2-m0/v1-baseline.json`, `benchmarks/v2-m0/v1-load-1000/`                                                            |
| **`[Measured: Local V2 workerd Probe]`**  | Real local Cloudflare `workerd` runtime via Wrangler `4.158.0` executing SQLite-backed `AgentHeadDO` + local D1 (`D1_CONTROL`).                   | `benchmarks/v2-m0/sqlite-probe.json`, `benchmarks/v2-m0/timing-methodology.json`                                                 |
| **`[Simulated: Synthetic]`**              | Deterministic jittered RTT injection, synthetic SSE CPU micro-benchmark, and offline model-routing evaluation profiles.                           | `benchmarks/v2-m0/rtt-simulation.json`, `benchmarks/v2-m0/timing-methodology.json`, `benchmarks/v2-m0/model-routing-matrix.json` |
| **`[Estimated: ADR-0006 Cloud Formula]`** | Reproducible cost & sensitivity model using ADR-0006 official published rates (verified 2026-11-19) and modeled workload/probe vectors.           | `benchmarks/v2-m0/cost-model.json`                                                                                               |

### Machine & Runtime Environment

- **Host OS**: `Darwin 27.2.0` (`arm64` / `Apple M1`, 8 cores, 16 GB RAM)
- **Node.js**: `v24.11.0`
- **PostgreSQL**: `PostgreSQL 17.11 (Homebrew) on aarch64-apple-darwin25.6.0`
- **Wrangler / workerd**: `wrangler@4.158.0` (`@cloudflare/workerd-darwin-arm64@1.20261104.1`)
- **External LLM / Daytona / Cloud Deploy**: **Disabled (0 real calls)**

---

## 1. Reproducible Commands & Raw Artifacts

All benchmarks reuse `apps/benchmark` and `pnpm bench:local` (preserving 100% backward compatibility with P0B-09c flags).

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

# 3. Run individual V2-M0-D suites or custom ADR-0006 cost scenario
pnpm bench:local --suite sqlite-probe --probe-iterations 40 --out-dir benchmarks/v2-m0
pnpm bench:local --suite timing --probe-iterations 40 --out-dir benchmarks/v2-m0
pnpm bench:local --suite rtt-sim --rtt-samples 20 --seed 42 --out-dir benchmarks/v2-m0
pnpm bench:local --suite cost-model --mau 10000 --allowance-ratio 0.5 --do-write-rows 25 --device-offload 0.5
pnpm bench:local --suite model-routing --out-dir benchmarks/v2-m0
```

| Raw Artifact                                                                                                                     | Suite / Scope                                                                    | Provenance                                                      |
| :------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------- | :-------------------------------------------------------------- |
| [v1-baseline.json](../../benchmarks/v2-m0/v1-baseline.json)                                                                      | V1 B1 Chat + Task Submit + Status Reads + Concurrency Sweep + PG Tuple Mutations | `[Measured: Local V1 PG]`                                       |
| [load-benchmark-2026-11-19T12-02-37-470Z.json](../../benchmarks/v2-m0/v1-load-1000/load-benchmark-2026-11-19T12-02-37-470Z.json) | Canonical 1,000-agent / 100-concurrency V1 Task Load Baseline                    | `[Measured: Local V1 PG]`                                       |
| [sqlite-probe.json](../../benchmarks/v2-m0/sqlite-probe.json)                                                                    | Local `workerd` DO SQLite vs Local D1 Probe + Alarm + Storage Growth             | `[Measured: Local V2 workerd Probe]`                            |
| [timing-methodology.json](../../benchmarks/v2-m0/timing-methodology.json)                                                        | ACK, Runtime Overhead, Streaming CPU, Global Budget Check Contention             | `[Measured: Local V2 workerd Probe]` + `[Simulated: Synthetic]` |
| [rtt-simulation.json](../../benchmarks/v2-m0/rtt-simulation.json)                                                                | 5-Region RTT Simulation across 3 V2 Architecture Modes                           | `[Simulated: Synthetic]`                                        |
| [cost-model.json](../../benchmarks/v2-m0/cost-model.json)                                                                        | ADR-0006 Reference Cost Matrix & Multi-Parameter Sensitivity Sweeps              | `[Estimated: ADR-0006 Cloud Formula]`                           |
| [model-routing-matrix.json](../../benchmarks/v2-m0/model-routing-matrix.json)                                                    | Candidate Model Routing Evaluation Matrix                                        | `[Simulated: Synthetic]` + Repo Verified Rates                  |

---

## 2. V1 Local Performance Baseline `[Measured: Local V1 PG]`

### 2.1 Concurrency Sweep: B1 Conversation vs Task Submission vs Status Reads

Measured against isolated PostgreSQL 17 schemas (`50` operations per workload per concurrency level; B1 conversation turns processed by `FakeTurnResponder` at `25 ms` poll interval; tasks processed by `DeterministicExecutor` at `25 ms` poll interval).

| Concurrency | Chat ACK P50 / P95 (ms) | Chat E2E P50 / P95 (ms) | Chat Throughput (turn/s) | Task ACK P50 / P95 (ms) | Task E2E P50 / P95 (ms) | Task Throughput (task/s) | Task Status Read P95 (ms) |
| ----------: | ----------------------: | ----------------------: | -----------------------: | ----------------------: | ----------------------: | -----------------------: | ------------------------: |
|       **1** |            8.95 / 12.11 |           38.88 / 46.76 |                    26.00 |             3.98 / 6.52 |          88.95 / 112.07 |                    11.54 |                      2.06 |
|      **10** |            6.39 / 52.67 |          50.74 / 104.26 |                   161.91 |            3.83 / 19.63 |          88.04 / 138.55 |                   103.78 |                      8.20 |
|      **25** |          30.47 / 114.11 |         176.32 / 301.87 |                   118.68 |           18.68 / 53.82 |         212.56 / 376.39 |                   101.05 |                     16.76 |
|      **50** |           72.69 / 85.86 |         203.55 / 249.94 |                   196.89 |           46.72 / 58.84 |         422.72 / 500.81 |                    99.08 |                     18.92 |

### 2.2 Status & History Read Scaling (`GET`)

| Endpoint                                   | Concurrency = 1 (P50 / P95, req/s) | Concurrency = 10 (P50 / P95, req/s) | Concurrency = 25 (P50 / P95, req/s) | Concurrency = 50 (P50 / P95, req/s) |
| :----------------------------------------- | :--------------------------------- | :---------------------------------- | :---------------------------------- | :---------------------------------- |
| `GET /v1/tasks/:id`                        | 1.26 / 2.06 ms (`738.93/s`)        | 5.91 / 8.20 ms (`1,567.53/s`)       | 12.47 / 16.76 ms (`1,654.57/s`)     | 17.17 / 18.92 ms (`2,234.72/s`)     |
| `GET /v1/conversations/:id/messages`       | 4.74 / 9.81 ms (`192.49/s`)        | 7.60 / 10.44 ms (`1,266.00/s`)      | 21.61 / 29.24 ms (`1,047.92/s`)     | 42.66 / 43.58 ms (`1,081.16/s`)     |
| `GET /v1/conversations/:id/turns/:turn_id` | 3.91 / 4.58 ms (`253.26/s`)        | 4.44 / 5.37 ms (`2,151.61/s`)       | 13.92 / 18.66 ms (`1,657.48/s`)     | 22.52 / 23.75 ms (`1,972.43/s`)     |

### 2.3 Canonical 1,000-Agent / 100-Concurrency Task Load Baseline

- **Provisioning**: `1,000` agents + `1,000` version-0 workspaces created in `478 ms` (`2,091.9 agents/s`, creation P95 = `19.55 ms`, `0` resident processes/sandboxes).
- **Task Closed Loop (`N = 1,000`, `70%` `mock.chat` / `30%` `mock.compute`, `100` concurrent HTTP)**:
  - **Success / Loss**: `1,000 / 1,000` (`100%`), `0` lost tasks.
  - **Durable Ack**: P50 = `4.45 ms`, P95 = `39.23 ms`, P99 = `50.95 ms`.
  - **Queue Wait**: P50 = `731.00 ms`, P95 = `1,013.40 ms`, P99 = `1,277.05 ms` (worker poll-loop contention at 100 concurrency).
  - **Task Completion**: P50 = `1,151.39 ms`, P95 = `1,556.55 ms`, P99 = `1,864.44 ms`.
  - **Resources**: Peak RSS `393.0 MB`, Peak V8 Heap `176.7 MB`, Peak PG active connections `51` (out of 52 total), Worker peak in-flight `40 / 100`, Peak live Fake Sandboxes `2` (`0` idle).

### 2.4 V1 PostgreSQL Logical Database Mutations & Retained Bytes

Measured via `pg_stat_user_tables` (`n_tup_ins + n_tup_upd + n_tup_del`) and `pg_total_relation_size` across the isolated schema:

- **V1 B1 Conversation Turn (`200` total turns across 4 concurrency levels)**:
  - Cumulative logical PG tuple mutations: **`814` mutations / `200` turns = `4.07` logical mutations/turn** (primarily `conversation_messages` user+assistant inserts, `assistant_turns` insert+update, `conversations` epoch/sequence update; at `c=1` isolated without async flush lag: `6.0` mutations/turn).
  - Schema relation+index size after `200` turns + `50` provisioned users/agents: `2.70 MB` -> `6.16 MB` across sweep.
- **V1 Durable Task Lifecycle (`200` total tasks across 4 concurrency levels)**:
  - Cumulative logical PG tuple mutations: **`4,062` mutations / `200` tasks = `20.31` logical mutations/task** (at `c=1`: `26.96` mutations/task across `task_events`, `budget_operations`, `tasks`, `runs`, `staged_blobs`, `operation_receipts`, `artifacts`, `blobs`, `step_checkpoints`, `workspace_versions`, `workspaces`, `task_results`).
  - **Architectural Insight**: V1's relational decomposition across 12+ tables creates high per-task mutation fan-out and pool contention (`51` active PG connections at 100 concurrency), whereas V1's poll-loop architecture (`Queue Wait P95 = 1,013 ms` at `c=100`) also drives tail latency and Neon idle-compute sensitivity.

---

## 3. Isolated Local DO SQLite vs D1 Probe `[Measured: Local V2 workerd Probe]`

Executed inside local `workerd` (`wrangler@4.158.0`) comparing `AgentHeadDO` (SQLite-backed Durable Object with `transactionSync()` + `setAlarm()`) against `D1_CONTROL` (local Miniflare D1 database) across `40` iterations per operation.

### 3.1 Logical DB Operations, Physical Row Amplification & Latency Comparison

| Operation                        | DO Logical Stmts / Mut | DO `rowsRead` (Mean) | DO `rowsWritten` (Mean) | DO `setAlarm` Calls | DO Latency P50 / P95 (ms) | D1 `rowsRead` (Mean) | D1 `rowsWritten` (Mean) | D1 Latency P50 / P95 (ms) |
| :------------------------------- | :--------------------: | -------------------: | ----------------------: | :-----------------: | :-----------------------: | -------------------: | ----------------------: | :-----------------------: |
| `normal_turn_prepare`            |         7 / 5          |                 9.10 |               **13.00** |        **1**        |        3.92 / 4.82        |                10.45 |               **16.00** |        3.41 / 4.42        |
| `normal_turn_commit`             |         6 / 5          |                 5.00 |                **9.00** |          0          |        3.54 / 4.72        |                 5.03 |                **9.03** |        2.64 / 3.99        |
| `task_submit`                    |         2 / 2          |                 0.00 |                **6.00** |        **1**        |        3.15 / 4.02        |                 0.97 |                **9.00** |        2.09 / 2.67        |
| `task_claim_complete`            |         4 / 3          |                 4.00 |                **5.00** |          0          |        2.67 / 3.67        |                 4.00 |                **5.00** |        2.62 / 3.98        |
| `lease_renewal`                  |         2 / 1          |                 2.00 |                **2.00** |        **1**        |        2.94 / 3.72        |                 2.00 |                **2.00** |        2.56 / 3.61        |
| `alarm_batch_dispatch` (5 items) |         7 / 5          |                11.00 |               **10.00** |        **1**        |        2.88 / 3.82        |                10.00 |               **10.00** |        2.96 / 4.05        |
| `retry_schedule`                 |         2 / 1          |                 2.00 |                **2.00** |        **1**        |        2.65 / 3.47        |                 3.00 |                **5.00** |        2.51 / 3.53        |

> [!IMPORTANT]
> **Key Empirical Finding — Index Write Amplification & ADR-0006 Calibration**:
>
> 1. A complete Fast Path conversation turn (`normal_turn_prepare` + `normal_turn_commit`) executes **10 logical SQL mutations** across 5 tables, which causes **`22` physical `rowsWritten` (`2.2x` amplification)** and `14.1` `rowsRead` in DO SQLite—already slightly above ADR-0006's baseline assumption of `20` DO rows written/event _before_ adding `setAlarm()` calls (`1` per turn), lease renewals (`2` rows/renewal), or retries.
> 2. Why `2.2x–3.0x` amplification occurs: `TEXT PRIMARY KEY` (without `WITHOUT ROWID`) creates an implicit unique index B-tree, and each secondary index (`idx_messages_conv_seq`, `idx_messages_sub`, `idx_turns_status_lease`, `idx_outbox_status_due`) adds an extra physical row write on every `INSERT` and `DELETE`.
> 3. **Real Alarm Verification**: `alarmRealFireVerified = true` (`alarmRealFireDelayMs = 2 ms` over local `workerd` scheduler).
> 4. **DO-local vs D1-centric**: D1-centric adds `+3` `rowsWritten` on `normal_turn_prepare` (`16` vs `13`), `+3` on `task_submit` (`9` vs `6`), and `+3` on `retry_schedule` (`5` vs `2`) due to the recovery/routing index rows, while lacking co-located `transactionSync()` + `setAlarm()` atomicity per agent.

### 3.2 Storage Growth Curve (`0` to `300` Turns)

|                    Turn Count | DO SQLite `databaseSize` (Bytes) | Local D1 `size_after` (Bytes) |
| ----------------------------: | -------------------------------: | ----------------------------: |
|    **0** (initialized schema) |                           86,016 |                       155,648 |
|                        **50** |                          106,496 |                       200,704 |
|                       **150** |                          184,320 |                       270,336 |
|                       **300** |                          286,720 |                       380,928 |
| **Derived Net Growth / Turn** |           **`669.0 bytes/turn`** |        **`750.9 bytes/turn`** |

_(Caveat: SQLite allocates space in 4 KiB pages; at `684` events/month weighted average, `669 bytes/turn` equates to `~0.46 MB/month/active agent` of raw SQLite row+index growth excluding large R2 payloads and periodic `VACUUM` effects.)_

---

## 4. Timing Methodology: ACK, Runtime Overhead, Streaming CPU & Global Budget Check

### 4.1 Formal Measurement Definitions

1. **Durable ACK (`T_ack`)**: `t_http_ack - t_req_start = T_edge_auth + T_budget_check + T_do_prepare` (excludes model/provider I/O; ADR-0006 near-region P95 target: `<= 250 ms`).
2. **Runtime Overhead (`T_runtime`)**: `T_edge_auth + T_budget_check + T_do_prepare + T_do_commit + T_stream_cpu` (all non-model coordination; ADR-0006 near-region P95 target: `<= 200 ms`).
3. **Streaming CPU (`C_stream`)**: `(process.cpuUsage().user + system)` delta in milliseconds across SSE token emission (Workers Standard bills active CPU ms, not idle network wait wall time).
4. **Global Budget Check (`T_budget`)**: `t_atomic_reserve_ack - t_budget_rpc_start` measured both in isolation under contention and inside `T_runtime` (ADR-0006 M1 gate: `<= 50 ms` near-region P95 within `<= 200 ms` `T_runtime`).

### 4.2 Local `workerd` Turn Timing Breakdown (`N = 40`) `[Measured: Local V2 workerd Probe]`

| Interval                                        | Min (ms) | Mean (ms) | P50 (ms) |  P95 (ms) | P99 (ms) | Max (ms) |
| :---------------------------------------------- | -------: | --------: | -------: | --------: | -------: | -------: |
| `globalBudgetCheckMs` (D1 atomic reserve)       |     2.20 |      2.99 |     2.68 |  **4.53** |     6.66 |     7.95 |
| `doPrepareMs` (DO Fast Path prepare + alarm)    |     2.79 |      3.50 |     3.31 |  **4.24** |     5.21 |     5.55 |
| **`ackMs` (`T_budget + T_do_prepare`)**         |     5.04 |      6.49 |     6.21 |  **8.32** |    10.59 |    11.97 |
| `doCommitMs` (DO fenced commit)                 |     2.74 |      3.25 |     3.16 |  **3.84** |     3.92 |     3.98 |
| **`runtimeOverheadMs` (`T_ack + T_do_commit`)** |     7.80 |      9.75 |     9.48 | **11.46** |    13.78 |    15.06 |

### 4.3 Streaming CPU vs Wall Time `[Simulated: Synthetic]`

| Stream Scenario            | Chunks x Bytes | Token Wait (ms/chunk) | Wall Time Mean / P95 (ms) | Active CPU Mean / P95 (ms) | Wait-Wall Share (%) |
| :------------------------- | :------------: | --------------------: | ------------------------: | -------------------------: | ------------------: |
| `burst_50_chunks_24B`      |   50 x 24 B    |                     0 |               0.09 / 0.17 |                0.20 / 0.32 |               0.00% |
| `burst_200_chunks_24B`     |   200 x 24 B   |                     0 |               0.17 / 0.20 |                0.27 / 0.50 |               0.00% |
| `paced_50_chunks_5ms_wait` |   50 x 24 B    |                     5 |           282.69 / 285.67 |               7.58 / 10.38 |          **97.32%** |

> Validates ADR-0006's Workers Standard cost model: `97.32%` of paced streaming wall time is async I/O wait (`$0` Workers duration charge), while active JSON/SSE serialization consumes bounded CPU (`~0.2–10 ms`).

### 4.4 Global Budget Check Contention & Fail-Closed Invariant `[Measured: Local V2 workerd Probe]`

| Mode                                         | Concurrency | Attempts | Approved / Rejected | Over-Committed? | Latency P50 / P95 (ms) |
| :------------------------------------------- | ----------: | -------: | :-----------------: | :-------------: | ---------------------: |
| `sequential_warm`                            |           1 |       30 |       30 / 0        |     `false`     |            3.29 / 5.41 |
| `concurrent_contention`                      |          20 |       40 |       40 / 0        |     `false`     |      28.58 / **48.39** |
| `exhaustion_fail_closed` (`cap=50k, req=5k`) |          20 |       20 |     **10 / 10**     |   **`false`**   |          24.59 / 24.93 |

> [!WARNING]
> Even in local `workerd` without cross-region WAN RTT, `20`-way concurrent contention on a single global D1 budget row reached **P95 = `48.39 ms`** (right at the `50 ms` M1 gate). Single-row global D1 serialization will fail `<= 50 ms` under higher concurrency or cross-region RTT unless sharded/batched or backed by bounded preallocated grants.

---

## 5. Regional RTT Simulation `[Simulated: Synthetic]`

Injected deterministic jittered network delays (`seed = 42`, `20` samples per scenario) around real local `workerd` DO/D1 execution across 5 regional profiles and 3 architecture modes:

1. `covered_preallocated_grant`: Edge -> DO prepare + DO commit (`0` sync D1 registry I/O, `0` sync global budget RPC).
2. `covered_sync_global_budget`: Edge -> Sync Global Budget D1 -> DO prepare + DO commit (`0` sync D1 registry I/O, `+1` global budget RPC).
3. `uncovered_registry_plus_sync_budget`: Edge -> Sync D1 Registry Lookup -> Sync Global Budget D1 -> DO prepare + DO commit.

| Region (Simulated RTT: Client / Edge->DO / Control) | Architecture Mode                     |  ACK P50 / P95 (ms) | Runtime P50 / P95 (ms) | Budget P95 (ms) | Gates Met (`ACK<=250` / `RT<=200` / `B<=50`) |
| :-------------------------------------------------- | :------------------------------------ | ------------------: | ---------------------: | --------------: | :------------------------------------------: |
| **near-region** (`12 / 4 / 8 ms`)                   | `covered_preallocated_grant`          |       23.88 / 33.97 |          20.72 / 34.54 |            0.00 |            **PASS / PASS / PASS**            |
| **near-region** (`12 / 4 / 8 ms`)                   | `covered_sync_global_budget`          |       36.59 / 48.29 |          33.01 / 47.11 |           18.72 |            **PASS / PASS / PASS**            |
| **near-region** (`12 / 4 / 8 ms`)                   | `uncovered_registry_plus_sync_budget` |       49.18 / 59.14 |          48.38 / 56.99 |           17.72 |            **PASS / PASS / PASS**            |
| **apac-intra** (`20 / 38 / 42 ms`)                  | `covered_preallocated_grant`          |       67.11 / 73.45 |          91.03 / 98.34 |            0.00 |            **PASS / PASS / PASS**            |
| **apac-intra** (`20 / 38 / 42 ms`)                  | `covered_sync_global_budget`          |     116.23 / 123.78 |        137.39 / 147.77 |       **53.36** |            PASS / PASS / **FAIL**            |
| **apac-intra** (`20 / 38 / 42 ms`)                  | `uncovered_registry_plus_sync_budget` |     169.46 / 181.75 |    192.08 / **211.77** |       **57.22** |          PASS / **FAIL** / **FAIL**          |
| **eu-us-east** (`18 / 78 / 78 ms`)                  | `covered_preallocated_grant`          |     110.94 / 123.04 |    183.44 / **206.06** |            0.00 |            PASS / **FAIL** / PASS            |
| **eu-us-east** (`18 / 78 / 78 ms`)                  | `covered_sync_global_budget`          |     194.94 / 209.57 |    267.41 / **293.48** |       **95.49** |          PASS / **FAIL** / **FAIL**          |
| **eu-us-east** (`18 / 78 / 78 ms`)                  | `uncovered_registry_plus_sync_budget` | 291.36 / **307.25** |    359.77 / **380.89** |       **99.36** |            **FAIL / FAIL / FAIL**            |
| **apac-us-west** (`22 / 120 / 120 ms`)              | `covered_preallocated_grant`          |     160.53 / 171.15 |    271.96 / **288.67** |            0.00 |            PASS / **FAIL** / PASS            |
| **apac-us-west** (`22 / 120 / 120 ms`)              | `covered_sync_global_budget`          | 299.24 / **313.35** |    413.55 / **436.15** |      **142.92** |            **FAIL / FAIL / FAIL**            |
| **cross-global** (`25 / 185 / 185 ms`)              | `covered_preallocated_grant`          |     224.81 / 239.29 |    399.42 / **416.82** |            0.00 |            PASS / **FAIL** / PASS            |
| **cross-global** (`25 / 185 / 185 ms`)              | `covered_sync_global_budget`          | 429.28 / **442.93** |    607.50 / **623.12** |      **209.11** |            **FAIL / FAIL / FAIL**            |
| **cross-global** (`25 / 185 / 185 ms`)              | `uncovered_registry_plus_sync_budget` | 616.47 / **654.03** |    787.74 / **832.83** |      **214.53** |            **FAIL / FAIL / FAIL**            |

**Regional Conclusion**:

- Near-region colocated placement easily clears all ADR-0006 targets (`ACK <= 250 ms`, `Runtime <= 200 ms`, `Budget <= 50 ms`).
- Once `edge <-> DO` or `DO <-> Global Control` crosses regions (`>= 40 ms` RTT), synchronous per-turn D1 lookups or uncolocated global budget RPCs immediately breach `50 ms` Budget / `200 ms` Runtime Overhead gates. Using `locationHint` near the user + keeping covered turns free of sync registry I/O + evaluating bounded preallocated grants is essential.

---

## 6. ADR-0006 Cost Model & Sensitivity Analysis `[Estimated: ADR-0006 Cloud Formula]`

Implemented in [cost-model.ts](../../apps/benchmark/src/cost-model.ts), reproducing all ADR-0006 rounding rules (`ceil` for DO requests/duration and R2 operations/storage; prorated for DO SQLite rows/storage, D1, Workers, Queues, Observability).

### 6.1 Verified ADR-0006 Cloud Runtime Reference Matrix (USD/month)

|                 MAU | Weighted Events/mo (`684 * N`) | Full Allowance (100%) | 50% Allowance Remaining | Zero Allowance (0%) | ADR-0006 Budget Envelope |
| ------------------: | -----------------------------: | --------------------: | ----------------------: | ------------------: | -----------------------: |
|        **10** (PoC) |                          6,840 |             **$5.00** |               **$5.00** |          **$22.73** |                      $10 |
|     **100** (Alpha) |                         68,400 |             **$5.00** |               **$5.08** |          **$24.70** |                      $15 |
|    **1,000** (Beta) |                        684,000 |             **$9.33** |              **$10.43** |          **$44.62** |   $30 target / $60 cond. |
| **10,000** (Growth) |                      6,840,000 |           **$176.07** |             **$208.14** |         **$245.01** |                     $300 |
| **100,000** (Scale) |                     68,400,000 |         **$2,204.80** |           **$2,261.13** |       **$2,326.00** |                   $3,500 |

### 6.2 Parameter Sensitivity Analysis (Full Account Allowance Baseline)

1. **DO SQLite Write Amplification (`doRowsWrittenPerEvent`)**:
   - At `1,000 MAU`: `10`–`60` rows/event stays inside the `50M` included allowance (`$9.33` cloud total).
   - At `10,000 MAU`: `10 -> 20 -> 30 -> 40 -> 60` rows/event yields **`$107.67 -> $176.07 -> $244.47 -> $312.87 -> $449.67`** (`+$68.40/mo` per `+10` writes/event).
   - At `100,000 MAU`: `10 -> 20 -> 30 -> 40 -> 60` rows/event yields **`$1,520.80 -> $2,204.80 -> $2,888.80 -> $3,572.80 -> $4,940.80`** (`+$684.00/mo` per `+10` writes/event).
   - **Probe Calibration Note**: Our probe measured **`22` `rowsWritten`** per normal turn (`prepare + commit`). Adding `+1` `setAlarm()` and periodic renewals/retries easily pushes real mixed workloads to `25–30` rows/event (`~$2,547–$2,889/mo` at `100k MAU`), making secondary-index discipline critical.

2. **DO Billable Active Duration (`doDurationSecPerEvent` at `0.128 GB`)**:
   - At `10,000 MAU`: `0.5 s` -> `$176.07` (`$12.50` overage); `2.0 s` -> `$188.57` (`+$12.50`); `5.0 s` -> `$213.57` (`+$37.50`); `10.0 s` -> `$276.07` (`+$100.00`).
   - At `100,000 MAU`: `0.5 s` -> `$2,204.80` (`$50.00` overage); `2.0 s` -> `$2,379.80` (`+$175.00`); `5.0 s` -> `$2,704.80` (`+$500.00`); `10.0 s` -> `$3,254.80` (`+$1,050.00`). Holding a DO open during external LLM/Sandbox waits destroys unit economics.

3. **Worker Streaming & Processing CPU (`workerCpuMsPerEvent`)**:
   - At `100,000 MAU`: `30 ms` (`0 ms` stream) = `$2,191.12`; `40 ms` (`10 ms` stream) = `$2,204.80`; `70 ms` (`40 ms` stream) = `$2,245.84` (`+$13.68/mo` per `+10 ms` CPU/event).

4. **Storage Growth Stock + Dormant Retained Accounts (`3,500 B/event` DO growth, `2.0x` dormant ratio at `5 MB/dormant`)**:
   - At `10,000 MAU`, `months = 1` (`2x` dormant): `2.89 MB/active`, `128.94 GB` total DO storage (`$24.79` DO storage overage, `$157.18` cloud total). At `months = 12` (`2x` dormant): `29.23 MB/active`, `392.28 GB` total DO storage (`$77.46` DO storage overage, `$218.88` cloud total).
   - At `100,000 MAU`, `months = 12` (`2x` dormant): `3,922.80 GB` total DO storage (`$783.56` DO storage overage, `$2,632.87` cloud total).

5. **Independent Recovery Overhead (`43,200` cron invocations/mo + D1 recovery registry writes)**:
   - At `1,000 MAU` (full allowance): `+$0.00` (inside `50M` D1 write allowance); at `0%` allowance remaining with `2` D1 writes/event: `+$1.37/mo` (`$44.62 -> $45.99`).
   - At `100,000 MAU` (full allowance): `1` D1 write/event adds **`+$32.93/mo`** (`$2,237.73`); `2` D1 writes/event adds **`+$101.33/mo`** (`$2,306.13`).

6. **Variable LLM & Daytona Sandbox + Device Offload (`1,000` / `10,000` MAU)**:

|        MAU | LLM Profile (`5k` in / `1k` out per event) | Device Offload | Cloud Runtime |  LLM Spend | Sandbox Net | Combined Monthly |
| ---------: | :----------------------------------------- | -------------: | ------------: | ---------: | ----------: | ---------------: |
|  **1,000** | `Nemotron-3.5-Lightning ZDR ($0.06/$0.16)` |             0% |         $9.33 |    $314.64 |     $166.50 |      **$490.47** |
|  **1,000** | `Nemotron-3.5-Lightning ZDR ($0.06/$0.16)` |            50% |         $9.33 |    $314.64 |      $83.25 |      **$407.22** |
|  **1,000** | `DeepSeek-V4.1-Flash ZDR ($0.098/$0.294)`  |             0% |         $9.33 |    $536.26 |     $166.50 |      **$712.09** |
|  **1,000** | `DeepSeek-V4.1-Flash ZDR ($0.098/$0.294)`  |            50% |         $9.33 |    $536.26 |      $83.25 |      **$628.84** |
|  **1,000** | `ADR-0006 Illustrative ($0.50/$2.00)`      |             0% |         $9.33 |  $3,078.00 |     $166.50 |    **$3,253.83** |
|  **1,000** | `ADR-0006 Illustrative ($0.50/$2.00)`      |            50% |         $9.33 |  $3,078.00 |      $83.25 |    **$3,170.58** |
| **10,000** | `DeepSeek-V4.1-Flash ZDR ($0.098/$0.294)`  |            50% |       $176.07 |  $5,362.56 |     $832.50 |    **$6,371.13** |
| **10,000** | `ADR-0006 Illustrative ($0.50/$2.00)`      |             0% |       $176.07 | $30,780.00 |   $1,665.00 |   **$32,621.07** |

---

## 7. Model Routing Evaluation Matrix `[Simulated: Synthetic]`

Evaluated across `8` synthetic personal-agent benchmark tasks (`simple_chat`, `json_extraction`, `tool_use`, `vision_multimodal`, `private_local`) using conservative token estimation (`MODEL_LIMITS` / `estimateTokensConservative`) and repo pricing rows (`MODEL_RATE_ROWS` in `@ember/model-gateway`). **Zero live LLM calls were made; latency/accuracy/retry figures are M0 simulation profiles requiring M4 provider canary calibration.**

| Route ID (`provider / model`)                                                    | Approval & Rate Provenance                                           | Sim. TTFT P50 / P95 (ms) | Sim. Comp. P50 / P95 (ms) | Eval Accuracy / Success | Cost / Success Task | Tools / JSON / Vision | Privacy / ZDR                                   |
| :------------------------------------------------------------------------------- | :------------------------------------------------------------------- | -----------------------: | ------------------------: | :---------------------: | ------------------: | :-------------------: | :---------------------------------------------- |
| `cloud-fast-zdr-nemotron` (`openrouter / nvidia/nemotron-3.5-lightning`)         | `approved_smoke_staging` (`official_price_verified` `$0.06/$0.16`)   |                420 / 950 |             1,350 / 2,600 |      76.0% / 87.5%      |       **$0.000245** |    Yes / Yes / No     | **ZDR + `dataCollection=deny`** (DeepInfra)     |
| `cloud-vision-tools-deepseek` (`openrouter / deepseek/deepseek-v4.1-flash-1017`) | `approved_smoke_staging` (`official_price_verified` `$0.098/$0.294`) |              580 / 1,350 |             2,100 / 4,100 |     92.9% / 100.0%      |       **$0.000353** |  **Yes / Yes / Yes**  | **ZDR + `dataCollection=deny`** (DeepInfra fp8) |
| `cloud-reasoning-gpt56-luna` (`openai / gpt-5.6-luna`)                           | `pending_cto_approval` (`unverified` `$0.20/$1.20`)                  |              650 / 1,500 |             2,400 / 4,800 |     96.4% / 100.0%      |           $0.000856 |    Yes / Yes / Yes    | Non-ZDR / Pending review                        |
| `cloud-adr0006-illustrative` (`adr0006-budget-reference-model`)                  | `research_profile` (`illustrative` `$0.50/$2.00`)                    |              750 / 1,800 |             2,800 / 5,500 |     94.9% / 100.0%      |           $0.001906 |    Yes / Yes / Yes    | Illustrative only                               |
| `device-local-mlx-small` (`apple-device-local`)                                  | `research_profile` (`zero_egress_local` `$0/$0`)                     |                180 / 420 |             1,100 / 2,400 |      50.9% / 37.5%      |       **$0.000000** |     No / No / No      | **On-device, zero cloud egress**                |

### Deterministic M0/M1 Routing Policy Recommendations

1. **Simple / Low-Latency Chat**: Route to `cloud-fast-zdr-nemotron` (`$0.000245`/success, ZDR) with fallback to `cloud-vision-tools-deepseek`.
2. **Tool Calling & Multimodal Vision**: Route to `cloud-vision-tools-deepseek` (`$0.000353`/success, 100% synthetic capability coverage, ZDR + `tool_choice`).
3. **Privacy-Sensitive / Offline Device Node**: Route to `device-local-mlx-small` when authorized & locally feasible (zero raw prompt egress), falling back to ZDR cloud routes only with policy/user consent.
4. **Complex Reasoning**: Keep pinned on `cloud-vision-tools-deepseek` until `gpt-5.6-luna` (or another reasoning candidate) passes CTO approval, ZDR review, and M4 live canary testing.

---

## 8. Architectural Conclusions & M1/M4 Gates

1. **V2 Thin DO SQLite vs V1 PG**: V1 durable tasks touch `20–27` PG tuple mutations across 12+ tables and hit `51` active PG connections at 100 concurrency (`Queue Wait P95 = 1,013 ms`). Co-locating per-agent turn/task state in `AgentHeadDO` SQLite with `setAlarm()` eliminates poll-loop wait and pool exhaustion, keeping local Prepare/Commit P95 under `5 ms`.
2. **Index Write Amplification Must Be Managed**: Normal Fast Path turn already writes `22` physical SQLite rows (`10` logical mutations). Keep secondary indexes minimal, avoid unnecessary per-token/per-heartbeat writes, and reconcile observed Cloudflare invoice `rows_written` in M4.
3. **Regional Placement & Global Budget Gate**: Synchronous cross-region D1 RPCs break the `50 ms` Budget / `200 ms` Runtime Overhead gates once RTT exceeds `~40 ms`, and `20`-way single-row D1 contention hits `48.39 ms` locally. Use `locationHint` for Agent DOs, ensure covered turns perform `0` sync registry lookups, and evaluate bounded preallocated grants in M1.
4. **Inference & Offload Dominate Total Cost**: Cloud Runtime is `1%–15%` of total spend at scale depending on model choice. Adopting verified ZDR OpenRouter models (`$0.06–$0.098/M` input) cuts projected LLM spend by `~6x–10x` versus ADR-0006's illustrative `$0.50/$2.00` quote, and 50% device offload halves Daytona compute spend.
