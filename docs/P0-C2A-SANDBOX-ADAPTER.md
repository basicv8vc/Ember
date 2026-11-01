# P0-C2A: Provider-Neutral Sandbox Runtime Adapter & Factory

> **Status:** Implementation Complete & DoD Verified  
> **Lane:** P0-C2A (Sandbox Runtime Integration)  
> **Baseline SHA:** `8ebf524812b2ca04ea91994acf1a473ef7c2b879`  
> **Target Branch:** `feature/p0c-2a-sandbox-runtime-integration`  
> **Authority:** RFC v0.2 ADR-005, P0-C1 Integration Report, P0-C2 Three-Lane Proposal v3

---

## 1. Executive Summary

Lane P0-C2A decouples Ember's execution engine (`DeterministicExecutor`) from concrete provider implementations by introducing a provider-neutral **Sandbox Runtime Adapter (`SandboxAdapter`)** and **Provider Factory Abstraction (`SandboxProviderFactory`)**.

This implementation strictly preserves and hardens:

1. **The 8-Phase Fail-Closed Lifecycle:** `capabilities` ➔ `create` ➔ `waitReady` ➔ `exec` ➔ `readOutput` ➔ `usage` ➔ `stop` ➔ `destroy`.
2. **Tri-State Leak Assessment:** Only reports `VERIFIED_CLEAN` when independent resource verification confirms zero active resources (`VERIFIED_ZERO`). Failures before allocation identity is established report `UNKNOWN` and fail closed (`resourcesLeaked: true`, overall status `FAIL`).
3. **Impenetrable Trust Boundary:** Untrusted provider exceptions are never reflected to clients, and provider errors cannot spoof internal harness timeouts (`ERR_PHASE_TIMEOUT` / `EXECUTION_TIMEOUT`).
4. **Deterministic Execution:** 100% deterministic SHA-256 output is maintained for `mock.compute` tasks, while Fast Path (`mock.chat`) strictly avoids sandbox allocation.

---

## 2. Architecture & Contracts

```mermaid
flowchart TD
    subgraph ExecutionEngine["DeterministicExecutor"]
        Router["RouteDecision"]
        FastPath["Fast Path (mock.chat)"]
        ComputePath["Standard Path (mock.compute)"]
    end

    subgraph FactoryLayer["SandboxProviderFactory"]
        FactoryContract["SandboxProviderFactory Contract"]
        FakeFactory["FakeSandboxProviderFactory"]
    end

    subgraph AdapterLayer["SandboxAdapter Layer"]
        Adapter["SandboxAdapter"]
        StateMachine["State Machine: create ➔ waitReady ➔ exec ➔ usage ➔ stop ➔ destroy"]
        TimeoutGuard["Bounded Timeouts & AbortLink"]
        Sanitizer["Domain Error Sanitizer"]
    end

    subgraph Providers["Concrete Providers"]
        FakeProvider["FakeSandboxProvider (In-Process)"]
        CloudCandidates["Cloud Providers (NOT_MEASURED)"]
    end

    ComputePath -->|createProvider(tenantId, runId, signal)| FactoryContract
    FactoryContract --> FakeFactory
    FakeFactory --> FakeProvider
    ComputePath -->|wrap with bounded options| Adapter
    Adapter --> StateMachine
    Adapter --> TimeoutGuard
    Adapter --> Sanitizer
    Adapter --> FakeProvider
    FastPath -->|0 allocations| Router
```

### 2.1 Contracts (`packages/contracts/src/interfaces.ts`)

```typescript
export interface SandboxProviderFactory {
  createProvider(context: {
    tenantId: Id;
    runId: Id;
    signal: AbortSignal; // trusted Run cancellation/lease-loss signal
  }): Promise<SandboxProvider>;
}

export interface SandboxAdapterOptions {
  readonly readyDeadlineMs?: number;
  readonly execTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}
```

### 2.2 SandboxAdapter (`packages/execution/src/sandbox-adapter.ts`)

The adapter wraps an arbitrary `SandboxProvider` instance with:

- **State Machine Enforcement:** Tracks lifecycle states (`created`, `ready`, `executed`, `stopped`, `destroyed`) per sandbox and prevents illegal transitions (e.g. calling `exec` before `waitReady`, or `readOutput` before `exec`).
- **Bounded Timeouts & Cancellation:** Races every async phase against configurable wall-clock timeouts and `AbortSignal` listeners using `withBoundedTimeout`.
- **Guaranteed Cleanup in `run()`:** Executes `create ➔ waitReady ➔ exec ➔ readOutput ➔ usage`, and unconditionally invokes bounded `stop()` and `destroy()` in `finally`.

---

## 3. Trust Boundary & Security Invariants

### 3.1 Sensitive Data Redaction

Provider exceptions are treated as untrusted. Any raw exception thrown by a provider is mapped via `sanitizeProviderError()`:

- Raw error messages, stack traces, and injected tokens (`Bearer`, database credentials, API keys) are strictly scrubbed.
- Trusted `DomainError` instances from `@ember/domain` (such as `POLICY_DENIED`) retain their machine-readable code, but their message is mapped to static safe text.

### 3.2 Anti-Spoofing Protections

- **No Spoofed Timeouts:** An untrusted provider that throws an error containing `ERR_PHASE_TIMEOUT` or a forged `EXECUTION_TIMEOUT` cannot deceive the harness. Genuine adapter/harness timeouts are internally branded (`Symbol('AdapterTimeoutBrand')`). Unbranded provider errors are mapped to `SANDBOX_NOT_READY`.
- **No False Cleanups:** Calling `stop()` and `destroy()` does not imply zero leakage. If `create()` fails or hangs before returning a `sandboxId`, the runner assumes the state is `UNKNOWN` and marks `resourcesLeaked: true`.

---

## 4. Tri-State Leak Assessment Model

| Leak Status      | Resource Verification                              | `resourcesLeaked` | Overall Smoke Status        | Condition                                                                                                    |
| :--------------- | :------------------------------------------------- | :---------------- | :-------------------------- | :----------------------------------------------------------------------------------------------------------- |
| `VERIFIED_CLEAN` | `VERIFIED_ZERO`                                    | `false`           | `PASS` (if all phases pass) | Independent verification explicitly confirms 0 active resources.                                             |
| `CONFIRMED_LEAK` | `ACTIVE_RESOURCES_DETECTED`                        | `true`            | `FAIL`                      | Independent verification detects lingering resources, or destroy explicitly failed.                          |
| `UNKNOWN`        | `CHECK_FAILED` / `NOT_SUPPORTED` / `NOT_ATTEMPTED` | `true`            | `FAIL`                      | Independent audit hook is missing, threw an exception, or creation failed before sandbox identity was known. |

---

## 5. Verification & Acceptance Evidence

### 5.1 Static Verification

- `pnpm format:check`: Passed with exit code 0.
- `pnpm lint`: Passed with exit code 0.
- `pnpm typecheck`: Passed with exit code 0 (`tsc -p tsconfig.json`).
- `pnpm build`: Passed with exit code 0 (`tsc -b tsconfig.build.json`).

### 5.2 Unit Tests (`pnpm test:unit`)

- **Files Passed:** 53 / 53 (exceeds ≥ 52 baseline)
- **Tests Passed:** 901 / 901 (exceeds ≥ 877 baseline)
- Added dedicated test suite `tests/unit/p0c-sandbox-adapter.test.ts` (18 tests) covering:
  - Normal lifecycle execution and automatic cleanup
  - State transition validations and out-of-order rejection
  - Bounded timeout enforcement on create, waitReady, exec, usage, stop, destroy
  - AbortSignal cancellation propagation
  - Adversarial error sanitization and timeout anti-spoofing
  - Pluggable `SandboxProviderFactory` injection in `DeterministicExecutor`
- Extended `tests/unit/p0c-sandbox-smoke-runner.test.ts` with factory lifecycle and tri-state leak verification.

### 5.3 Integration Tests (`pnpm test:integration`)

- Added `tests/integration/sandbox-adapter.test.ts`:
  - 10 concurrent compute executions through factory and adapter without crosstalk or leaks.
  - Cross-tenant isolation verification.

### 5.4 Demo CLI (`pnpm demo`)

- All 4 scenarios passed cleanly:
  1. Fast Path (mock.chat): Verified 0 sandboxes allocated.
  2. Standard Path (mock.compute): Verified created: 2, destroyed: 2, active lingering: 0.
  3. Crash / Resume: Verified fencing and single execution.
  4. Tenant Isolation: Verified cross-tenant authorization denial.

### 5.5 Sandbox Smoke Harness CLI

- `pnpm sandbox:smoke:local`: Exited with code 0 (`status: PASS`, `leakStatus: VERIFIED_CLEAN`, `resourceVerification: VERIFIED_ZERO`).
- `pnpm sandbox:smoke:local --json`: Exited with code 0 and valid machine-readable JSON.
- `pnpm sandbox:smoke:local --provider cloudflare`: Exited with code 1 (`Provider "cloudflare" is NOT_MEASURED`).

---

## 6. Attestation of Zero Paid Cloud Spend & Zero Network Egress

The undersigned agent attests:

1. **Zero Vendor Calls:** No calls were made to Cloudflare, E2B, Daytona, Boat, or any cloud API.
2. **Zero Paid Cloud Spend:** No vendor SDKs, API keys, or paid infrastructure were utilized.
3. **Process-Memory Isolation Only:** In-memory fake provider simulation only; no real VM or container isolation is claimed.
