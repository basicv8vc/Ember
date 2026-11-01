# P0-C1 Sandbox Smoke Harness Specification

> **Status:** Draft / Specification Only (P0-B Deliverable)  
> **Date:** 2026-10-31  
> **Target Phase:** P0-C1 (Multi-Provider Sandbox Evaluation)  
> **Authority:** `Personal_Agent_Platform_P0-B_Minimum_Vertical_Slice_Task_Spec.md` §15, §16

---

## 1. Executive Summary & Cost Safety Boundary

This document specifies the provider-neutral smoke testing harness designed for **P0-C1**, evaluating four candidate runtime sandbox backends:

1. **Cloudflare** (Workerd / Workers / Containers)
2. **E2B** (Firecracker MicroVMs)
3. **Daytona** (Workspace Dev Environments / Containers)
4. **Boat** (Fly.io / Firecracker-based lightweight sandbox architecture)

### ⚠️ Strict Cost & Security Boundary (P0-B Non-Goal)

- **Zero Paid Cloud Invocations:** In accordance with P0-B §15 ("阶段边界与非目标"), **no external paid cloud accounts, sandbox credentials, or SaaS API keys are registered, configured, or invoked during P0-B**.
- **No Synthetic Benchmarks:** Performance figures for all four providers are strictly **`NOT MEASURED`**. No ranking or vendor selection may be inferred from P0-B simulation.
- **Explicit Human Authorization Required:** Transitioning to P0-C1 execution requires explicit human authorization, designated budget limits, quota ceilings, and approved isolation reviews. Any suggested figures (such as a proposed \$10.00 USD spend ceiling) are design proposals for user review only and do not constitute authorization.

---

## 2. Provider-Neutral Sandbox Contract

All candidate backends must implement the standard `SandboxProvider` contract defined in `@ember/contracts`:

```typescript
export interface SandboxProvider {
  /** Explicit provider capabilities */
  capabilities(): Promise<SandboxCapabilities>;

  /** Create a sandbox instance with bounded spec and resource ceilings */
  create(spec: SandboxSpec): Promise<{ sandboxId: Id }>;

  /** Wait until sandbox enters ready state or throw on timeout */
  waitReady(sandboxId: Id, deadlineMs: number): Promise<void>;

  /** Execute a bounded, allowlisted command inside the sandbox */
  exec(sandboxId: Id, argv: readonly string[], timeoutMs: number): Promise<SandboxExecResult>;

  /** Stream or read stdout/stderr output */
  readOutput(sandboxId: Id, ref: Id): Promise<string>;

  /** Transfer artifact to/from controlled root (with integrity validation) */
  putFile(sandboxId: Id, path: string, artifactRef: Id): Promise<void>;
  getFile(sandboxId: Id, path: string): Promise<{ artifactRef: Id }>;

  /** Optional checkpoint snapshot and resume */
  snapshot?(sandboxId: Id): Promise<{ restoreRef: string }>;
  resume?(sandboxId: Id): Promise<void>;

  /** Graceful shutdown */
  stop(sandboxId: Id): Promise<void>;

  /** Idempotent permanent cleanup */
  destroy(sandboxId: Id): Promise<void>;

  /** Usage and billing telemetry */
  usage(sandboxId: Id): Promise<SandboxUsageRecord>;
}
```

---

## 3. Four-Provider Adaptation Architecture

```
                               ┌────────────────────────────────┐
                               │   P0-C1 Smoke Test Contract    │
                               │  (Provider-Neutral Test Suite) │
                               └───────────────┬────────────────┘
                                               │
               ┌───────────────────────┬───────┴───────────────┬────────────────────────┐
               │                       │                       │                        │
               ▼                       ▼                       ▼                        ▼
       ┌───────────────┐       ┌───────────────┐       ┌───────────────┐        ┌───────────────┐
       │  Cloudflare   │       │      E2B      │       │    Daytona    │        │     Boat      │
       │    Adapter    │       │    Adapter    │       │    Adapter    │        │    Adapter    │
       └───────┬───────┘       └───────┬───────┘       └───────┬───────┘        └───────┬───────┘
               │                       │                       │                        │
       [ workerd / API ]       [ Firecracker API ]    [ Daytona Daemon API ]    [ Fly / Machine API ]
```

### 3.1 Cloudflare Adapter

- **Runtime Mechanism:** Cloudflare Workers / workerd container runtime.
- **Artifact Transfer:** R2 object storage binding or presigned HTTP upload.
- **Lifecycle Mapping:** Worker isolate instantiation -> execution -> ephemeral disposal.
- **Constraints:** Limited POSIX primitives, distinct execution timeout limits.

### 3.2 E2B Adapter

- **Runtime Mechanism:** E2B Firecracker MicroVMs.
- **Artifact Transfer:** E2B filesystem API (`filesystem.write` / `filesystem.read`).
- **Lifecycle Mapping:** `Sandbox.create()` -> `sandbox.commands.run()` -> `sandbox.close()`.
- **Constraints:** MicroVM cold start latency, billed per-second runtime.

### 3.3 Daytona Adapter

- **Runtime Mechanism:** Daytona Container / Workspace runtime.
- **Artifact Transfer:** Daytona workspace toolbox / exec API.
- **Lifecycle Mapping:** Workspace provisioning -> SSH / exec -> Workspace destroy.
- **Constraints:** Workspace lifecycle management, network namespace isolation.

### 3.4 Boat (Lightweight MicroVM / Fly Machine)

- **Runtime Mechanism:** Standalone Firecracker microVM or Fly.io transient Machine.
- **Artifact Transfer:** Ephemeral volume mount or presigned S3/MinIO bucket.
- **Lifecycle Mapping:** Machine create -> Machine start -> exec -> Machine stop & destroy.
- **Constraints:** Regional instance placement, unattached volume garbage collection.

---

## 4. Universal Measurement & Telemetry Schema

### 4.1 P0-C1A Local Fake Simulation Schema

In P0-C1A, prior to cloud authorization and credentials, the provider-neutral harness executes against `FakeSandboxProvider` with `mode: 'LOCAL_SIMULATION'`. The schema enforces strict boundary invariants to prevent synthetic metrics from masquerading as cloud benchmarks:

- `provider: 'fake'`
- `mode: 'LOCAL_SIMULATION'`
- `usageSource: 'SIMULATED'`
- `realIsolationStatus: 'NOT_MEASURED'`
- `vendorColdStartMs: null`
- `vendorCostUsd: null`
- `costSource: 'NOT_MEASURED'`

```typescript
export interface SmokeReport {
  readonly schemaVersion: '1.0.0';
  readonly testId: string;
  readonly provider: 'fake';
  readonly mode: 'LOCAL_SIMULATION';
  readonly status: 'PASS' | 'FAIL';
  readonly phases: Record<SmokePhase, SmokePhaseDetail>;
  readonly timing: SmokeTimingReport;
  readonly usageSource: 'SIMULATED';
  readonly usage: SandboxUsageRecord | null;
  readonly realIsolationStatus: 'NOT_MEASURED';
  readonly vendorColdStartMs: null;
  readonly vendorCostUsd: null;
  readonly costSource: 'NOT_MEASURED';
  readonly capabilities: SandboxCapabilities | null;
  readonly cleanup: SmokeCleanupReport;
  readonly error: string | null;
  readonly limitations: readonly string[];
}
```

### 4.2 Candidate Cloud Provider Telemetry Record (Deferred to Authorized P0-C1)

For future P0-C1 evaluation upon explicit human authorization and budget approval, each smoke run across candidate cloud providers will populate the following standardized telemetry record:

```typescript
export interface SandboxSmokeRecord {
  /** Test scenario and provider metadata */
  readonly testId: string;
  readonly provider: 'cloudflare' | 'e2b' | 'daytona' | 'boat';
  readonly providerRegion: string;
  readonly environment: 'staging' | 'isolated-smoke';

  /** Lifecycle Timestamps (High-Resolution Wall Clock) */
  readonly requestedAt: string;
  readonly provisionAckAt: string;
  readonly readyAt: string;
  readonly execStartedAt: string;
  readonly execCompletedAt: string;
  readonly destroyedAt: string;

  /** Measured Intervals */
  readonly coldStartMs: number; // readyAt - requestedAt
  readonly execDurationMs: number; // execCompletedAt - execStartedAt
  readonly cleanupDurationMs: number; // destroyedAt - execCompletedAt
  readonly totalWallMs: number; // destroyedAt - requestedAt

  /** Resource & Billing Footprint */
  readonly reportedCpuSeconds: number;
  readonly reportedMemoryMbSeconds: number;
  readonly reportedEgressBytes: number;
  readonly reportedVendorCostUsd: number | null; // Nullable if billing API is asynchronous
  readonly costSource: 'vendor_api' | 'metered_formula';

  /** Reliability & Safety */
  readonly exitCode: number;
  readonly memoryLeakDetected: boolean;
  readonly processSurvivedDestroy: boolean;
}
```

---

## 5. Security Guardrails & Secret Management

### 5.1 Zero Credential Leakage

- All provider API tokens (`CF_API_TOKEN`, `E2B_API_KEY`, `DAYTONA_API_KEY`, `BOAT_AUTH_TOKEN`) must be injected exclusively via runtime environment variables.
- The Ember `@ember/telemetry` privacy scrubber must strip all provider keys, bearer headers, and account IDs from logs and telemetry traces (`[REDACTED]`).

### 5.2 Mandatory Cost & Resource Caps

Before activating any provider in P0-C1:

1. **Hard Spend Cap (Proposed Ceiling):** Each provider account must be configured with a hard billing alert and kill switch capped at **\$10.00 USD** (proposed ceiling subject to explicit user review and formal authorization; not an authorized expense under P0-B).
2. **Concurrency Ceiling:** Maximum **5 concurrent sandboxes** per provider during smoke validation.
3. **Hard Lifetime Ceiling:** Maximum **120 seconds** execution lifetime per sandbox, enforced by client-side `AbortSignal` and provider-level max lifetime config.
4. **Orphan Sweeper:** Automatic sweep script to detect and terminate any VM / container surviving longer than 300 seconds.

---

## 6. P0-C1 Provider Baseline Matrix (Design Only)

| Dimension              |   Cloudflare   |      E2B       |    Daytona     |      Boat      |
| :--------------------- | :------------: | :------------: | :------------: | :------------: |
| **P0-B Status**        |   Spec Only    |   Spec Only    |   Spec Only    |   Spec Only    |
| **Measured Latency**   | `NOT MEASURED` | `NOT MEASURED` | `NOT MEASURED` | `NOT MEASURED` |
| **Measured Cost**      | `NOT MEASURED` | `NOT MEASURED` | `NOT MEASURED` | `NOT MEASURED` |
| **P0-C1 Prerequisite** | Human Sign-off | Human Sign-off | Human Sign-off | Human Sign-off |
| **Adapter Code**       | Deferred P0-C1 | Deferred P0-C1 | Deferred P0-C1 | Deferred P0-C1 |

> [!IMPORTANT]
> Ember P0-B explicitly makes NO recommendation of Cloudflare as the default vendor. Selection among the four candidate platforms must be made purely on empirical evidence collected during the authorized P0-C1 benchmark execution.
