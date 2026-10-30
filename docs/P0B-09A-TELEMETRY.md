# Ember P0B-09A: Telemetry & Observability Foundation

## 1. Executive Summary & Specification Alignment

This document outlines the architecture, data models, privacy guardrails, and metrics design for Ember P0B-09A Telemetry & Observability, fulfilling **Section 10 of `Personal_Agent_Platform_P0-B_Minimum_Vertical_Slice_Task_Spec.md`**.

### Core Guarantees

- **Local & OpenTelemetry-Compatible**: Local OpenTelemetry-style span, trace, and metric representations without requiring external cloud collectors, remote endpoints, or paid SaaS services.
- **Privacy & Secret Redaction**: Zero leakage of raw prompts, bearer auth tokens, private keys, or raw tenant identifiers into logs or metrics.
- **Strict Cost Semantics**: Usage records strictly mandate `cost_source = "simulated"` and `actual_vendor_cost_usd = null`.
- **Statistically Sound Quantiles**: Quantile calculation (P50, P95, P99) preserves sample counts alongside failure, timeout, and cancellation counts.
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
│   ├── collector.ts    # RunTraceCollector for lifecycle stage timing
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
| `trace_id`     | `string`         | 32-character hexadecimal trace identifier             | Matches `/^[0-9a-f]{32}$/`                                    |
| `tenant_hash`  | `string`         | SHA-256 hash of `tenant_id` truncated to 16 hex chars | Matches `/^[0-9a-f]{16}$/`                                    |
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

| Duration Field          | Formula                            | Purpose                                                         |
| :---------------------- | :--------------------------------- | :-------------------------------------------------------------- |
| `queue_wait_ms`         | `lease_acquired - runnable`        | Time spent waiting in the lease queue before worker acquisition |
| `gateway_persist_ms`    | `durable_ack - request_received`   | Gateway intake overhead before acknowledging the client         |
| `fake_sandbox_ready_ms` | `sandbox_ready - sandbox_create`   | Sandbox creation/initialization latency                         |
| `task_wall_ms`          | `task_terminal - request_received` | End-to-end total lifecycle duration                             |

---

## 4. Quantile Reporting & Failure Tracking

### 4.1 Statistical Calculation

Quantiles (P50, P95, P99) are computed using the **R7 linear interpolation method** (standard in statistical software and NumPy):
$$h = (N - 1) \times p + 1$$
$$\text{Quantile} = x_{\lfloor h \rfloor} + (h - \lfloor h \rfloor) \times (x_{\lceil h \rceil} - x_{\lfloor h \rfloor})$$

### 4.2 Failure Tracking Invariant

Reporting latencies solely on successful runs produces survivorship bias. `MetricsAggregator` strictly enforces tracking:

- `sample_count`: Total number of attempts measured.
- `failed_count`: Number of runs ending in `failed`.
- `timeout_count`: Number of runs ending in `timed_out`.
- `cancelled_count`: Number of runs ending in `cancelled`.

```typescript
export interface PercentileReport {
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly p99_ms: number;
  readonly min_ms: number;
  readonly max_ms: number;
  readonly mean_ms: number;
  readonly sample_count: number;
  readonly failed_count: number;
  readonly timeout_count: number;
  readonly cancelled_count: number;
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
  readonly trace_id: string;
  readonly tenant_hash: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly provider: 'fake';
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly simulated_cost_usd: number;
  readonly cost_source: 'simulated';
  readonly actual_vendor_cost_usd: null;
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

### 6.2 Secret Masking Patterns

The privacy engine automatically filters:

- **Bearer Tokens**: `Bearer [A-Za-z0-9-_.]+` $\rightarrow$ `Bearer [REDACTED]`
- **Dev Auth Tokens**: `dev-auth-[A-Za-z0-9_-]+` $\rightarrow$ `[REDACTED]`
- **URI Credentials**: `postgres://user:password@host` $\rightarrow$ `postgres://user:[REDACTED]@host`
- **Private Keys**: `-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----` $\rightarrow$ `[REDACTED_PRIVATE_KEY]`
- **User Prompts & Instructions**: Replaced with `[REDACTED_PROMPT]` or `[REDACTED]` based on field context.

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
    "trace_id": "8fa3c959779df3f587d60527376a267e",
    "tenant_hash": "2f41bb9ff7d45731",
    "task_id": "7ac16c27-3932-4752-96ea-45b78fbe296e",
    "run_id": "bc115682-1234-4567-890a-abcdef123456",
    "provider": "fake",
    "input_tokens": 120,
    "output_tokens": 45,
    "total_tokens": 165,
    "simulated_cost_usd": 0.000495,
    "cost_source": "simulated",
    "actual_vendor_cost_usd": null
  }
}
```

---

## 8. Integration Dependencies & Strategy for PR #20

### 8.1 Isolation Rationale

PR #20 is actively implementing core worker loop and database synchronization logic in:

- `apps/worker/src/poll-loop.ts`
- `apps/worker/src/durable-run-handler.ts`
- `packages/postgres/src/repositories/task-repository.ts`

To ensure **zero merge conflicts**, P0B-09A provides all observability infrastructure inside the dedicated package `@ember/telemetry` with 100% test coverage and validation.

### 8.2 Post-PR #20 Integration Checklist

Once PR #20 is merged to `main`, integrate `@ember/telemetry` into the worker runtime via the following straightforward steps:

1. **Add Dependency**:
   Add `@ember/telemetry: "workspace:*"` to `apps/worker/package.json` and `apps/api/package.json`.

2. **Instrument Gateway (`apps/api/src/tasks/routes.ts`)**:
   - Initialize `RunTraceCollector` at `request_received`.
   - Record `durable_ack` when inbox task insertion succeeds.
   - Attach `traceparent` / `trace_id` to the response headers and task record.

3. **Instrument Worker Poll Loop (`apps/worker/src/poll-loop.ts`)**:
   - Record `lease_acquired` timestamp upon successful `claim()`.
   - Pass collector context into `DurableRunHandler`.

4. **Instrument Execution Pipeline (`apps/worker/src/durable-run-handler.ts`)**:
   - Record `sandbox_create` and `sandbox_ready` around `FakeSandbox` setup.
   - Record `checkpoint_committed` upon checkpoint save.
   - Record `task_terminal` and emit `RunTraceRecord` and `SimulatedUsageRecord`.
   - Feed durations into `MetricsAggregator` for local metrics export.
