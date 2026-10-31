# Ember P0-C1A — Local Sandbox Smoke Harness Evidence

> **Phase:** P0-C1A (Provider-Neutral Sandbox Smoke Harness — Local Fake Increment)  
> **Authority:** `Ember_P0C1A_Sandbox_Local_Smoke_Prompt.md`  
> **Status:** Draft PR Verification Evidence  
> **Date:** 2026-10-31  
> **Base SHA:** `322c42b147822236be0be96657879a3341d41ce7`

---

## 1. Executive Summary & Cost / Isolation Boundaries

This document provides operational instructions, example reports, and verification evidence for the **P0-C1A Provider-Neutral Sandbox Smoke Harness**.

### ⚠️ Strict Safety & Cost Boundary Declarations

- **Zero Paid Cloud Invocations:** No cloud provider APIs, third-party vendor SDKs, SaaS tokens, or paid infrastructure were configured or invoked.
- **Zero Network Traffic:** The local harness runs strictly in-process with memory isolation only. No outbound HTTP/TCP sockets or Docker daemons are used.
- **Candidate Cloud Providers `NOT_MEASURED`:** Cloudflare, E2B, Daytona, and Boat are explicitly marked `NOT_MEASURED`. Any attempt to pass `--provider <vendor>` exits with a non-zero exit code (1) and makes **zero network requests and zero implicit fallbacks**.
- **No Synthetic Benchmark Claims:** Local execution speed or simulated usage does **not** constitute cold start, latency, cost, or security isolation evidence for any vendor.
- **Contract Parity Only:** This deliverable verifies provider-neutral lifecycle orchestration (`capabilities → create → waitReady → exec → readOutput → usage → stop → destroy`) fail-closed cleanup, and telemetry serialization.

---

## 2. Operational Guide

### 2.1 Running the Local Smoke Harness

The harness is executable via root `pnpm`:

```bash
# Standard run (prints human summary followed by machine-readable JSON)
pnpm sandbox:smoke:local

# Pure machine-readable JSON output (suitable for piping into jq)
pnpm sandbox:smoke:local --json

# Human summary only
pnpm sandbox:smoke:local --format summary

# Custom timeout (between 100 and 60000 ms)
pnpm sandbox:smoke:local --timeout-ms 5000
```

### 2.2 Strict Provider & Flag Guardrails

Passing any cloud provider or unrecognized argument fails immediately with exit code 1:

```bash
# Cloud provider rejection (no network calls, no fallback)
pnpm sandbox:smoke:local --provider cloudflare
# Output:
# [ERROR] Provider "cloudflare" is NOT_MEASURED in local smoke harness. Candidate cloud backends require external credentials, budget authorizations, and isolation review. Zero network calls or implicit fallbacks were executed.
# Exit code: 1

# Unrecognized argument rejection
pnpm sandbox:smoke:local --unknown-flag
# Output:
# [ERROR] Unrecognized argument "--unknown-flag". Run with --help for supported options.
# Exit code: 1
```

---

## 3. Example Execution Reports

### 3.1 Human-Readable Summary

```text
================================================================================
Ember Sandbox Smoke Harness (Local Fake Simulation)
================================================================================
Schema Version:        1.0.0
Test ID:               d29c657c-9880-4114-ad67-da413f30048a
Provider:              fake
Mode:                  LOCAL_SIMULATION
Status:                PASS
Total Wall Clock:      3.94 ms

--- Lifecycle Phases ---
• capabilities    : PASS    (0.01 ms)
• create          : PASS    (2.07 ms)
• waitReady       : PASS    (0.11 ms)
• exec            : PASS    (1.52 ms)
• readOutput      : PASS    (0.05 ms)
• usage           : PASS    (0.03 ms)
• stop            : PASS    (0.01 ms)
• destroy         : PASS    (0.01 ms)

--- Resource & Telemetry Footprint ---
Usage Source:          SIMULATED
CPU Seconds:           0.001000
Memory GiB*Seconds:    0.000500
Egress Bytes:          0

--- Security & Measurement Boundaries ---
Real Isolation:        NOT_MEASURED (Process memory isolation only; no VM/container)
Vendor Cold Start:     NOT_MEASURED (null)
Vendor Cost:           NOT_MEASURED (null)
Cost Source:           NOT_MEASURED

--- Cleanup Status ---
Stop Status:           COMPLETED
Destroy Status:        COMPLETED
Resource Verification: VERIFIED_ZERO
Leak Status:           VERIFIED_CLEAN
Sandbox Stopped:       true
Sandbox Destroyed:     true
Resources Leaked:      false

--- Important Limitations ---
• Fake sandbox runs strictly in-process with memory isolation only; it provides NO VM, container, or network boundary.
• Snapshot and resume capabilities are UNSUPPORTED and fail-closed.
• Network policy enforcement is UNSUPPORTED; capabilities.networkPolicy is false.
• Vendor latency, cold-start latency, and cloud execution costs are NOT_MEASURED.
• This harness evaluates the provider-neutral lifecycle contract, not third-party cloud infrastructure.
================================================================================
```

### 3.2 Machine-Readable JSON Report

```json
{
  "schemaVersion": "1.0.0",
  "testId": "d29c657c-9880-4114-ad67-da413f30048a",
  "provider": "fake",
  "mode": "LOCAL_SIMULATION",
  "status": "PASS",
  "phases": {
    "capabilities": {
      "phase": "capabilities",
      "status": "PASS",
      "durationMs": 0.01,
      "details": {
        "shell": false,
        "browser": false,
        "filesystemSnapshot": false,
        "memoryResume": false,
        "diskSurvivesStop": false,
        "forkFromSnapshot": false,
        "persistentVolume": false,
        "networkPolicy": false
      }
    },
    "create": {
      "phase": "create",
      "status": "PASS",
      "durationMs": 2.07,
      "details": {
        "sandboxId": "5098a1df-01c8-8716-be64-996df0fd18f6"
      }
    },
    "waitReady": {
      "phase": "waitReady",
      "status": "PASS",
      "durationMs": 0.11
    },
    "exec": {
      "phase": "exec",
      "status": "PASS",
      "durationMs": 1.52,
      "details": {
        "exitCode": 0,
        "operation": "sha256"
      }
    },
    "readOutput": {
      "phase": "readOutput",
      "status": "PASS",
      "durationMs": 0.05,
      "details": {
        "stdoutDigestMatches": true,
        "stderrEmpty": true
      }
    },
    "usage": {
      "phase": "usage",
      "status": "PASS",
      "durationMs": 0.03,
      "details": {
        "cpuSeconds": 0.001,
        "memoryGiBSeconds": 0.0005,
        "egressBytes": 0
      }
    },
    "stop": {
      "phase": "stop",
      "status": "PASS",
      "durationMs": 0.01
    },
    "destroy": {
      "phase": "destroy",
      "status": "PASS",
      "durationMs": 0.01
    }
  },
  "timing": {
    "totalWallMs": 3.94,
    "phaseDurationsMs": {
      "capabilities": 0.01,
      "create": 2.07,
      "waitReady": 0.11,
      "exec": 1.52,
      "readOutput": 0.05,
      "usage": 0.03,
      "stop": 0.01,
      "destroy": 0.01
    }
  },
  "usageSource": "SIMULATED",
  "usage": {
    "cpuSeconds": 0.001,
    "memoryGiBSeconds": 0.0005,
    "egressBytes": 0
  },
  "realIsolationStatus": "NOT_MEASURED",
  "vendorColdStartMs": null,
  "vendorCostUsd": null,
  "costSource": "NOT_MEASURED",
  "capabilities": {
    "shell": false,
    "browser": false,
    "filesystemSnapshot": false,
    "memoryResume": false,
    "diskSurvivesStop": false,
    "forkFromSnapshot": false,
    "persistentVolume": false,
    "networkPolicy": false
  },
  "cleanup": {
    "stopStatus": "COMPLETED",
    "destroyStatus": "COMPLETED",
    "leakStatus": "VERIFIED_CLEAN",
    "resourceVerification": "VERIFIED_ZERO",
    "stopSucceeded": true,
    "destroySucceeded": true,
    "resourcesLeaked": false
  },
  "error": null,
  "limitations": [
    "Fake sandbox runs strictly in-process with memory isolation only; it provides NO VM, container, or network boundary.",
    "Snapshot and resume capabilities are UNSUPPORTED and fail-closed.",
    "Network policy enforcement is UNSUPPORTED; capabilities.networkPolicy is false.",
    "Vendor latency, cold-start latency, and cloud execution costs are NOT_MEASURED.",
    "This harness evaluates the provider-neutral lifecycle contract, not third-party cloud infrastructure."
  ]
}
```

---

## 4. Contract Reconciliation & Interface Handoff to Agents B and C

1. **`SandboxProvider.readOutput()` in `@ember/contracts`:**
   - Pre-existing discrepancy: `FakeSandboxProvider` and `deterministic-executor.ts` already defined and called `readOutput(sandboxId: Id, ref: Id): Promise<string>`, but the method was omitted from `SandboxProvider` in `packages/contracts/src/interfaces.ts`.
   - Resolution: Added `readOutput(sandboxId: Id, ref: Id): Promise<string>` to `SandboxProvider` in `@ember/contracts`. No other signatures were modified.
2. **Provider-Neutral Runner Architecture:**
   - Located in `apps/cli/src/sandbox-smoke/`.
   - Exports `SandboxSmokeRunner` and `runSandboxSmoke`.
   - Future cloud adapters (Agent B/C) can implement `SandboxProvider` and plug into the same `SandboxSmokeRunner` without duplicating harness lifecycle logic or test assertion pipelines.
3. **Redaction & Safe Serialization:**
   - All errors and serialized outputs are sanitized via `formatSanitizedError` and `serializeSafeJson`, ensuring secrets, authorization bearer tokens, and connection strings are replaced with `[REDACTED]`.

---

## 5. Verification Commands & Test Execution Log

| Command                          | Exit Code | Observed Result / Test Counts                                                                                                                                                          |
| :------------------------------- | :-------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` |   **0**   | All 10 workspace projects resolved with frozen lockfile                                                                                                                                |
| `pnpm format:check`              |   **0**   | Prettier check clean across entire repository                                                                                                                                          |
| `pnpm lint`                      |   **0**   | ESLint passed with 0 errors and 0 warnings                                                                                                                                             |
| `pnpm typecheck`                 |   **0**   | TypeScript typecheck passed (`tsc -p tsconfig.json`)                                                                                                                                   |
| `pnpm build`                     |   **0**   | Monorepo build passed (`tsc -b tsconfig.build.json`)                                                                                                                                   |
| `pnpm test:unit`                 |   **0**   | **46 test files passed, 707 unit tests passed** (+2 test files, +31 new tests)                                                                                                         |
| `pnpm sandbox:smoke:local`       |   **0**   | Complete Fake lifecycle verified (8 phases PASS, 4.33ms)                                                                                                                               |
| `git diff --check`               |   **0**   | Zero trailing whitespace or merge conflict markers                                                                                                                                     |
| `pnpm demo --scenario fast`      |   **0**   | Fast Path invariants verified against isolated local loopback (145ms)                                                                                                                  |
| `pnpm test:integration`          |   **1**   | **Failed (exit 1)**: `TEST_DATABASE_URL is required for integration tests`. The integration harness requires `.env.local` which cannot be modified due to strict file ownership rules. |
| `pnpm test:chaos` / `test:e2e`   | _Skipped_ | Unrun: same prerequisite dependency on `.env.local` / `TEST_DATABASE_URL`.                                                                                                             |

---

## 6. Rollback Plan

If this branch needs to be rolled back:

1. Revert commit on `feature/p0c-1a-sandbox-local-smoke` or drop the branch.
2. The change has zero database schema migrations, zero shared mutable state, zero dependency bumps in `pnpm-lock.yaml`, and does not modify any worker or API server code.
