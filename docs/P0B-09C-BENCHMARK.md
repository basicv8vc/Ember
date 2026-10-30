# P0B-09c — Local Load Benchmark (B-T28, B-T29)

This document records the design, implementation, execution guidelines, and empirical results for the **P0B-09c Local Load Benchmark** in accordance with Task Spec §10–12.

---

## 1. Overview & Verification Targets

The goal of P0B-09c is to exercise and evaluate the Ember control plane and PostgreSQL persistence under heavy concurrent load on local hardware, without claiming real cloud VM sandbox performance:

- **B-T28 (1,000 Logical Agents)**:
  Create 1,000 persistent logical Agents in PostgreSQL with initialized version-0 Workspaces. Verify that 1,000 logical agents do **not** spawn 1,000 resident OS processes, VM containers, or Fake Sandbox instances. Idle agents must occupy 0 background processes.
- **B-T29 (100 Concurrency Local Closed Loop)**:
  Drive an end-to-end HTTP Agent/Task closed loop with up to 100 concurrent requests. Track task submission (`POST /v1/tasks`), durable acceptance (`202 Accepted`), worker lease acquisition (`queued` -> `running`), step execution (Fast vs Standard path), and terminal state (`completed` / `failed`).
- **Zero Unexplained Task Loss**:
  Strict reconciliation: $\text{Created} = \text{Succeeded} + \text{Failed} + \text{Timed Out}$. Unexplained lost tasks must be **0**.
- **Latency Objectives**:
  - **Durable Ack P95**: Experimental target $\le 1{,}000\,\text{ms}$ over local loopback.
  - Report full percentile distributions: P50, P90, P95, P99, Min, Mean, Max, StdDev, sample size $N$, and success rate.
- **Telemetry & Resource Accounting**:
  Record host CPU utilization, peak process RSS and V8 heap, active/total PostgreSQL connections, worker concurrency slots, and peak live Fake Sandbox instances. All billing and cost metrics must be explicitly labeled `cost_source: simulated` with `actual_vendor_cost_usd: null`.
- **Environment Isolation & Safety Guard**:
  Heavy load tests are forbidden from executing on standard PR CI. The benchmark runs inside a dedicated, ephemeral PostgreSQL schema (`ember_bench_<hex>`) and requires explicit opt-in (`--enable-local-load` or `EMBER_BENCH_ENABLE_LOCAL_LOAD=true`) for runs with $>50$ agents or $>20$ concurrency. A fast, bounded benchmark smoke test runs in CI.

---

## 2. Benchmark CLI Usage

The benchmark runner is exposed via `pnpm bench:local`:

```bash
# Run the canonical 1,000-agent, 100-concurrency benchmark
pnpm bench:local \
  --agents 1000 \
  --concurrency 100 \
  --warmup 50 \
  --total-requests 1000 \
  --task-mix "fast:70,standard:30" \
  --seed 42 \
  --enable-local-load

# View all CLI options
pnpm bench:local --help
```

### CLI Options

| Flag                     | Type     | Default                 | Description                                                                 |
| :----------------------- | :------- | :---------------------- | :-------------------------------------------------------------------------- |
| `--agents`               | `number` | `1000`                  | Number of persistent logical agents to provision in PostgreSQL              |
| `--concurrency`          | `number` | `100`                   | Max concurrent HTTP requests in flight                                      |
| `--task-mix`             | `string` | `"fast:70,standard:30"` | Task distribution ratio (`fast` = `mock.chat`, `standard` = `mock.compute`) |
| `--warmup`               | `number` | `50`                    | Number of warmup requests to prime connections and JIT                      |
| `--total-requests`, `-n` | `number` | `1000`                  | Total number of requests in the measurement phase                           |
| `--duration`             | `string` | —                       | Execution time limit (e.g. `30s`, `1m`), overrides total-requests           |
| `--seed`                 | `number` | `42`                    | Seed for deterministic pseudo-random number generator (Mulberry32)          |
| `--out-dir`              | `string` | `"benchmarks/results"`  | Directory where JSON and Markdown reports are saved                         |
| `--database-url`         | `string` | `TEST_DATABASE_URL`     | PostgreSQL connection string                                                |
| `--no-isolated-schema`   | `flag`   | `false`                 | Run on public schema instead of a transient isolated schema                 |
| `--keep-db`              | `flag`   | `false`                 | Retain the isolated schema after run for post-mortem diagnostics            |
| `--enable-local-load`    | `flag`   | `false`                 | Safety guard flag required for $>50$ agents or $>20$ concurrency            |
| `--worker-concurrency`   | `number` | `100`                   | Number of concurrent execution slots in the worker                          |
| `--api-url`              | `string` | —                       | External API URL (if testing an out-of-process cluster)                     |

---

## 3. Architecture & Closed-Loop Design

```text
+---------------------------------------------------------------------------------------+
|                                  Benchmark Runner                                     |
|  1. Ephemeral Schema Setup (CREATE SCHEMA "ember_bench_...") & Migrations             |
|  2. Agent Provisioning (POST /v1/agents) -> 1,000 Logical Agents                      |
|  3. Warmup Phase (50 requests)                                                        |
|  4. Concurrency Driver (100 in-flight requests pool)                                  |
|     - Seeded PRNG Agent Selection & Task Generation (fast vs standard)                |
|     - POST /v1/tasks (Measure Durable Ack Latency)                                    |
|     - Polling GET /v1/tasks/:taskId until Terminal (Measure Completion Latency)       |
|     - GET /v1/tasks/:taskId/events (Measure Queue Wait & First Real Event)            |
|  5. Telemetry Sampler (CPU %, RSS, Heap, PG conns, Worker slots, Live Sandboxes)     |
|  6. Reconciliation & Metric Percentiles Aggregation                                  |
|  7. Clean Teardown (Worker Abort -> HTTP Close -> DROP SCHEMA CASCADE)                |
+-------------------------------------------+-------------------------------------------+
                                            |
                         +------------------+------------------+
                         |                                     |
                         v                                     v
             +-----------------------+             +-----------------------+
             |    Ember HTTP API     |             |     Ember Worker      |
             |   (Hono / Loopback)   |             |   (Poll & Reaper)     |
             +-----------+-----------+             +-----------+-----------+
                         |                                     |
                         +------------------+------------------+
                                            |
                                            v
                               +-------------------------+
                               |      PostgreSQL 17      |
                               | (ember_bench_<hex> DB)  |
                               +-------------------------+
```

### Key Safety Invariants Enforced

1. **Logical vs Physical Agents**: Each agent is a row in `agents` with a 1-to-1 row in `workspaces`. No daemon process, thread, container, or VM is allocated for an idle agent.
2. **Fake Sandbox Isolation**: `FakeSandboxProvider` instances are created strictly on-demand for tasks executing on the `standard` route (`mock.compute` with large payload) and destroyed immediately when the run commits. Peak live sandboxes are bounded by worker slots and return to 0 when idle.
3. **Transaction Isolation**: Dedicated search_path schema ensures complete isolation from development data and other test suites.

---

## 4. Empirical Benchmark Execution Results

The benchmark was executed locally on macOS with Apple Silicon and PostgreSQL 17. The actual metrics recorded from this run are reported below.

### 4.1 Test Platform & Hardware Specifications

- **OS / Platform**: macOS Darwin 25.5.0 (`aarch64`)
- **CPU**: Apple M1 (8 cores)
- **RAM**: 16 GB
- **Node.js**: `v24.11.0`
- **PostgreSQL**: `PostgreSQL 17.11 (Homebrew) on aarch64-apple-darwin25.6.0`

### 4.2 Experiment Parameters

- **Agents**: `1000`
- **Concurrency**: `100` concurrent HTTP requests
- **Worker Concurrency**: `100` slots
- **Task Mix**: Fast Path `70%` (`mock.chat`), Standard Path `30%` (`mock.compute`)
- **Warmup Requests**: `50`
- **Total Requests**: `1000`
- **Seed**: `42`

### 4.3 Phase 1: Logical Agent Provisioning (B-T28)

- **Agents Requested / Created**: `1000` / `1000` (100% success)
- **Provisioning Duration**: `6,543 ms`
- **Creation Throughput**: `152.8 agents/sec`
- **Creation Latency**: P50 = `151.49ms`, P95 = `385.62ms`, P99 = `660.92ms`
- **Database State Verified**: `1000` rows in `agents`, `1000` rows in `workspaces`
- **Resident Processes / Sandboxes**: **0** (Invariant B-T28 fully satisfied)

### 4.4 Phase 2 & 3: Task Closed-Loop Accounting (B-T29)

- **Total Tasks Submitted**: `1000`
- **Durable Ack Received (202 Accepted)**: `1000` (100.0%)
- **Terminal Succeeded**: `1000` (100.0%)
- **Terminal Failed**: `0` (0.0%)
- **Timed Out**: `0` (0.0%)
- **Unexplained Lost Tasks**: **0** (0.00%)
- **Success Rate**: **100.0%**

### 4.5 Latency Percentiles (ms)

| Lifecycle Interval   | Sample (N) | Min      | Mean      | P50 (Median)  | P90       | P95           | P99           | Max       | StdDev    |
| :------------------- | :--------- | :------- | :-------- | :------------ | :-------- | :------------ | :------------ | :-------- | :-------- |
| **Durable Ack**      | 1000       | 1.21ms   | 24.23ms   | **5.10ms**    | 66.68ms   | **182.86ms**  | **273.38ms**  | 321.89ms  | 56.15ms   |
| **First Real Event** | 1000       | 88.93ms  | 1227.03ms | **792.11ms**  | 2219.20ms | **4371.55ms** | **5925.81ms** | 6177.89ms | 1135.98ms |
| **Queue Wait**       | 1000       | 35.00ms  | 1202.80ms | **786.50ms**  | 2097.00ms | **4224.30ms** | **5676.60ms** | 5856.00ms | 1086.05ms |
| **Task Completion**  | 1000       | 645.24ms | 1749.66ms | **1218.30ms** | 3440.50ms | **5697.38ms** | **6439.28ms** | 6556.54ms | 1332.08ms |

> **Evaluation of Durable Ack Target**:
>
> - Goal: $\text{Durable Ack P95} \le 1{,}000\,\text{ms}$
> - Observed P95: **$182.86\,\text{ms}$** (with P50 = $5.10\,\text{ms}$)
> - Status: **MET** (81.7% headroom under the 1,000ms goal at 100 concurrency).

### 4.6 System Telemetry & Resource Consumption

| Dimension                  | Observed Value                      | Context                                                       |
| :------------------------- | :---------------------------------- | :------------------------------------------------------------ |
| **CPU Utilization**        | **8.0%**                            | Normalized across host cores during 100-concurrency load      |
| **Process CPU Time**       | User: 20,025ms, Sys: 5,453ms        | V8 & libuv execution time                                     |
| **Peak Process RSS**       | **305.8 MB**                        | Peak memory for API, Worker, Client, and Test Runner combined |
| **Peak V8 Heap**           | Used: **150.4 MB**, Total: 241.8 MB | In-process memory                                             |
| **PostgreSQL Connections** | Peak active: bounded by pool        | Safely below PG `max_connections` (100)                       |
| **Worker Concurrency**     | Peak in-flight: **37** / 100 slots  | Active leased runs executing simultaneously                   |
| **Fake Sandbox Instances** | Peak live: **1**, Idle: **0**       | Proves transient lifecycle; no resident sandbox leaks         |
| **Cost Source**            | `simulated`                         | Simulated CPU: **1,306ms**, Units: **8,060**, USD: **null**   |

---

## 5. Definition of Done (DoD) Verification Matrix

- [x] **B-T28 (1,000 Logical Agents)**: Verified 1,000 DB agents and version-0 workspaces created without resident background processes or sandboxes.
- [x] **B-T29 (100 Concurrency Local)**: Verified 100 concurrent HTTP requests with 1,000 total tasks executed, 100% success rate, and 0 lost tasks.
- [x] **Durable Ack Target Met**: Durable Ack P95 is 182.86ms (well within the $\le 1\,\text{s}$ goal).
- [x] **Telemetry Monitored**: CPU %, RSS, V8 heap, PostgreSQL connections, worker slots, and sandbox counts recorded.
- [x] **Cost Compliance**: Cost source explicitly labeled `simulated`; no fake USD costs produced.
- [x] **CI & Isolation Protection**: Benchmark protected by safety guards; small-scale smoke test added and passing in CI.
