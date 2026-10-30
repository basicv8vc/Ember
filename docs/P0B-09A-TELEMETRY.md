# Ember P0B-09A: Telemetry & Observability Foundation

## 1. Executive Summary & Specification Alignment

This document outlines the architecture, data models, privacy guardrails, and metrics design for Ember P0B-09A Telemetry & Observability, fulfilling **Section 10 of `Personal_Agent_Platform_P0-B_Minimum_Vertical_Slice_Task_Spec.md`**.

### 1.1 Scope Delineation (P0B-09A Foundation vs P0B-09A2 Runtime Integration)

- **PR #22 Deliverable (P0B-09A Foundation)**: Delivers the core `@ember/telemetry` workspace package containing local OpenTelemetry-compatible models, runtime Zod validation schemas, automated privacy scrubbing (tokens, dev credentials, prompts, tenant IDs), quantile reporting with sample/failure tracking, and unit + PostgreSQL integration verification.
- **Subsequent Step (P0B-09A2 Runtime Integration)**: Designed to wire `@ember/telemetry` directly into the live API gateway and worker execution loops (`apps/api/src/tasks/routes.ts`, `apps/worker/src/poll-loop.ts`, `apps/worker/src/durable-run-handler.ts`). This is staged separately to avoid merge conflicts with the active PR #20 and to utilize a persistent trace context that spans across process boundaries.

### 1.2 Core Guarantees

- **Local & OpenTelemetry-Compatible**: Local OpenTelemetry-style span, trace, and metric representations without requiring external cloud collectors, remote endpoints, or paid SaaS services.
- **Privacy & Secret Redaction**: Zero leakage of raw prompts, bearer auth tokens, private keys, or raw tenant identifiers into logs or metrics.
- **Strict Cost Semantics**: Usage records strictly mandate `cost_source = "simulated"` and `actual_vendor_cost_usd = null`.
- **Statistically Sound Quantiles**: Quantile calculation (P50, P95, P99) preserves sample counts alongside failure, timeout, and cancellation counts, and reports `observed_count` vs `missing_count`.
- **Low-Cardinality Metrics**: Low-cardinality metric labels prevent metric cardinality explosions in time-series aggregations.
- **PR #20 Non-Interference**: Implemented as an independent workspace package `@ember/telemetry` (`packages/telemetry`) to avoid merge conflicts with PR #20 (`apps/worker/src/poll-loop.ts`, `durable-run-handler.ts`).

---

## 2. Core Architecture (`packages/telemetry`)

The `@ember/telemetry` package provides modular building blocks:

```
packages/telemetry/
├── src/
│   ├── index.ts        # Public API surface
│   ├── types.ts        # OpenTelemetry-compatible interfaces and types
│   ├── schemas.ts      # Strict Zod runtime validation schemas
│   ├── privacy.ts      # Secret masking, prompt scrubbing & tenant hashing
│   ├── tracer.ts       # OpenTelemetry-compatible Tracer & Span implementation
│   ├── collector.ts    # RunTraceCollector for lifecycle stage timing & reconstruction
│   ├── metrics.ts      # Quantile calculation (R7) & MetricsAggregator
│   ├── usage.ts        # Simulated token usage and cost accounting
│   └── logger.ts       # Structured JSON line logger with privacy transformer
├── tsconfig.build.json
└── package.json
```

---

## 3. Field & Schema Specifications

### 3.1 Trace & Span Attributes

Every execution trace captures contextual fields conforming to OpenTelemetry semantic conventions:

| Field Name     | Type             | Description                                           | Invariant / Validation                                        |
| :------------- | :--------------- | :---------------------------------------------------- | :------------------------------------------------------------ |
| `trace_id`     | `string`         | 32-character lowercase hexadecimal trace identifier   | Strictly matches `/^[0-9a-f]{32}$/`                           |
| `tenant_hash`  | `string`         | SHA-256 hash of `tenant_id` truncated to 16 hex chars | Strictly matches `/^[0-9a-f]{16}$/`                           |
| `task_id`      | `UUID`           | Durable task identifier                               | Valid UUID                                                    |
| `run_id`       | `UUID`           | Active execution run identifier                       | Valid UUID                                                    |
| `path`         | `enum`           | Execution route path                                  | `'standard'` \| `'fast_path'`                                 |
| `route_reason` | `string`         | Routing decision explanation                          | Non-empty string (e.g. `'mock.compute:standard'`)             |
| `provider`     | `literal`        | LLM / Sandbox provider                                | Strictly `"fake"` in P0-B                                     |
| `attempt`      | `integer`        | Lease/execution attempt counter                       | `>= 1`                                                        |
| `lease_epoch`  | `integer`        | Worker fencing token epoch                            | `>= 1`                                                        |
| `error_code`   | `string \| null` | Terminal error classification                         | Nullable string (e.g., `'TASK_TIMEOUT'`, `'BUDGET_EXCEEDED'`) |

### 3.2 Stage Timestamps & Latency Metrics

`RunTraceCollector` records monotonic-derived timestamps at crucial lifecycle milestones:

1. `request_received`: HTTP Gateway accepted the task request.
2. `durable_ack`: Task persisted to durable inbox table.
3. `first_real_event`: First state transition event emitted to event store.
4. `runnable`: Run transitioned to `runnable` status in lease queue.
5. `lease_acquired`: Worker leased the run via `claim()`.
6. `sandbox_create`: Fake sandbox allocation started.
7. `sandbox_ready`: Fake sandbox initialized and ready.
8. `checkpoint_committed`: Run checkpoint persisted to storage.
9. `task_terminal`: Task transitioned to terminal state (`succeeded`, `failed`, `cancelled`, `timed_out`).

#### Computed Stage Durations

Durations are automatically calculated from stage timestamps:

| Duration Field          | Formula                            | Purpose                                                                                                          |
| :---------------------- | :--------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `queue_wait_ms`         | `lease_acquired - runnable`        | Time spent waiting in the lease queue before worker acquisition (strictly `null` if either timestamp is missing) |
| `gateway_persist_ms`    | `durable_ack - request_received`   | Gateway intake overhead before acknowledging the client                                                          |
| `fake_sandbox_ready_ms` | `sandbox_ready - sandbox_create`   | Sandbox creation/initialization latency                                                                          |
| `task_wall_ms`          | `task_terminal - request_received` | End-to-end total lifecycle duration                                                                              |

> [!IMPORTANT]
> `queue_wait_ms` starts strictly from `runnable`, rather than `durable_ack` or `request_received`. This guarantees that task retries, approval resumption, or re-queued runs record accurate queue waiting latencies for that specific execution cycle.

---

## 4. Quantile Reporting & Failure Tracking

### 4.1 Statistical Calculation

Quantiles (P50, P95, P99) are computed using the **R7 linear interpolation method** (standard in statistical software and NumPy):
$$h = (N - 1) \times p + 1$$
$$\text{Quantile} = x_{\lfloor h \rfloor} + (h - \lfloor h \rfloor) \times (x_{\lceil h \rceil} - x_{\lfloor h \rfloor})$$

### 4.2 Failure Tracking & Observed Count Invariant

Reporting latencies solely on successful runs produces survivorship bias. `MetricsAggregator` strictly enforces tracking:

- `sample_count`: Total number of attempts tracked across the window.
- `observed_count`: Number of runs with an actual valid, non-null measured duration for this specific metric.
- `missing_count`: Number of runs missing timestamps (e.g. fast path skipping sandbox, or unmeasured stages).
- `failed_count`: Number of runs ending in `failed`.
- `timeout_count`: Number of runs ending in `timed_out`.
- `cancelled_count`: Number of runs ending in `cancelled`.

```typescript
export interface PercentileReport {
  readonly metric_name: string;
  readonly sample_count: number;
  readonly observed_count: number;
  readonly missing_count: number;
  readonly success_count: number;
  readonly failed_count: number;
  readonly timeout_count: number;
  readonly cancelled_count: number;
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly p99_ms: number | null;
  readonly min_ms: number | null;
  readonly max_ms: number | null;
  readonly avg_ms: number | null;
}
```

### 4.3 Low-Cardinality Metric Labels

To prevent time-series database degradation, metric labels are restricted to a defined low-cardinality set:

- Allowed label dimensions: `task_type`, `path`, `status`, `error_code`.
- High-cardinality values (`task_id`, `run_id`, `trace_id`, `tenant_id`, prompts) are **prohibited** from metric label dimensions and must only be attached to Spans and Structured Logs.

---

## 5. Simulated Usage & Cost Modeling

In accordance with Section 10:

- `cost_source` is strictly enforced to `"simulated"`.
- `actual_vendor_cost_usd` is strictly enforced to `null`.

```typescript
export interface SimulatedUsageRecord {
  readonly usage_id: string;
  readonly trace_id: string;
  readonly tenant_hash: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly simulated_cpu_ms: number;
  readonly simulated_usage_units: number;
  readonly cost_source: 'simulated';
  readonly actual_vendor_cost_usd: null;
  readonly recorded_at: string;
}
```

Any attempt to produce records with external vendor cost or live provider tags triggers runtime schema validation failure.

---

## 6. Privacy & Redaction Engine

### 6.1 Tenant Obfuscation

Raw `tenant_id` strings are never logged directly. They are mapped using deterministic SHA-256:

```typescript
createTenantHash(tenantId) => sha256(tenantId).substring(0, 16)
```

In addition:

- Direct single-field `span.setAttribute('tenantId', id)` and `span.setAttribute('tenant_id', id)` automatically rewrite the key to `tenant_hash` and store `createTenantHash(id)`.
- `SpanRecordSchema` and `SpanAttributesSchema` strictly enforce at runtime that keys `'tenantId'` and `'tenant_id'` can never be serialized into Span records.

### 6.2 Secret Masking Patterns

The privacy engine automatically filters:

- **Bearer Tokens**: `Bearer [A-Za-z0-9-_.]+` $\rightarrow$ `Bearer [REDACTED]`
- **Dev Auth Tokens**: `dev-auth-[A-Za-z0-9_-]+` $\rightarrow$ `[REDACTED_DEV_TOKEN]`
- **URI Credentials**: `postgres://user:password@host` $\rightarrow$ `postgres://user:[REDACTED]@host`
- **Private Keys**: `-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----` $\rightarrow$ `[REDACTED_SECRET]`
- **User Prompts & Instructions**: Replaced with `[REDACTED_PROMPT]` or `[REDACTED]` based on field context.
- **Span Status & Exceptions**: `span.setStatus()` description, `recordException()` messages, and stack traces are comprehensively passed through `redactSecrets()`.

---

## 7. Sample Telemetry Outputs

### 7.1 OpenTelemetry Span Log Sample (JSON Line)

```json
{
  "timestamp": "2026-10-30T06:45:00.000Z",
  "level": "info",
  "message": "Span 'worker.execute_run' ended",
  "telemetry": {
    "name": "worker.execute_run",
    "trace_id": "8fa3c959779df3f587d60527376a267e",
    "span_id": "4b68e98ec7d32c49",
    "parent_span_id": "18f972b22596be11",
    "kind": "INTERNAL",
    "start_time_iso": "2026-10-30T06:44:59.850Z",
    "end_time_iso": "2026-10-30T06:45:00.000Z",
    "duration_ms": 150,
    "status": { "code": "OK" },
    "attributes": {
      "tenant_hash": "2f41bb9ff7d45731",
      "task_id": "7ac16c27-3932-4752-96ea-45b78fbe296e",
      "run_id": "bc115682-1234-4567-890a-abcdef123456",
      "path": "standard",
      "route_reason": "mock.compute:standard",
      "provider": "fake",
      "attempt": 1,
      "lease_epoch": 1,
      "error_code": null
    },
    "events": [
      {
        "name": "sandbox_ready",
        "time_iso": "2026-10-30T06:44:59.870Z",
        "attributes": { "sandbox_type": "fake" }
      }
    ]
  }
}
```

### 7.2 Run Lifecycle & Latency Summary (JSON Line)

```json
{
  "timestamp": "2026-10-30T06:45:00.010Z",
  "level": "info",
  "message": "Run trace completed",
  "trace": {
    "trace_id": "8fa3c959779df3f587d60527376a267e",
    "tenant_hash": "2f41bb9ff7d45731",
    "task_id": "7ac16c27-3932-4752-96ea-45b78fbe296e",
    "run_id": "bc115682-1234-4567-890a-abcdef123456",
    "path": "standard",
    "route_reason": "mock.compute:standard",
    "provider": "fake",
    "attempt": 1,
    "lease_epoch": 1,
    "error_code": null,
    "durations": {
      "queue_wait_ms": 35,
      "gateway_persist_ms": 12,
      "fake_sandbox_ready_ms": 18,
      "task_wall_ms": 150
    }
  }
}
```

### 7.3 Simulated Usage & Cost Record (JSON Line)

```json
{
  "timestamp": "2026-10-30T06:45:00.015Z",
  "level": "info",
  "message": "Simulated usage recorded",
  "usage": {
    "usage_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "trace_id": "8fa3c959779df3f587d60527376a267e",
    "tenant_hash": "2f41bb9ff7d45731",
    "task_id": "7ac16c27-3932-4752-96ea-45b78fbe296e",
    "run_id": "bc115682-1234-4567-890a-abcdef123456",
    "simulated_cpu_ms": 15,
    "simulated_usage_units": 1,
    "cost_source": "simulated",
    "actual_vendor_cost_usd": null,
    "recorded_at": "2026-10-30T06:45:00.015Z"
  }
}
```

---

## 8. Integration Architecture & Post-PR #20 Plan (P0B-09A2)

### 8.1 Process Boundary & Trace Reconstruction Challenge

In a production deployment or distributed setup:

1. When the HTTP Gateway accepts a request, only `request_received` and `durable_ack` occur; `run_id` does not yet exist.
2. The worker poll loop runs in a distinct process, claiming a run minutes later or after a system crash/restart.
3. Therefore, process memory cannot be shared between Gateway and Worker.

### 8.2 Reconstruction Solution (`RunTraceCollector.reconstruct`)

The `@ember/telemetry` module provides `RunTraceCollector.reconstruct()`, enabling independent workers or monitoring daemons to reconstruct full end-to-end traces from persisted database records:

- `tasks.created_at` $\rightarrow$ `request_received`
- `task_events.created_at` (for `accepted`) $\rightarrow$ `durable_ack`
- `runs.created_at` $\rightarrow$ `runnable`
- `runs.claimed_at` $\rightarrow$ `lease_acquired`
- `runs.finished_at` $\rightarrow$ `task_terminal`

### 8.3 Post-PR #20 Integration Checklist (P0B-09A2)

Once PR #20 merges into `main`, the runtime telemetry integration (P0B-09A2) will hook into:

1. `apps/api/src/tasks/routes.ts`: Initialize `trace_id` and attach `traceparent` header.
2. `apps/worker/src/poll-loop.ts`: Pass `trace_id` and lease timestamps to run execution context.
3. `apps/worker/src/durable-run-handler.ts`: Record sandbox lifecycle timestamps, invoke `createTraceRecord()`, and emit simulated usage and stage duration metrics.
