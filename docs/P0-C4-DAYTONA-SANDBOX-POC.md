# P0-C4: Daytona Sandbox Provider PoC

**Status:** Real measurement **BLOCKED** — no `DAYTONA_API_KEY` in this environment.
**Date:** 2026-11-06
**Branch:** `feature/daytona-sandbox-poc`
**Base:** `main@c6c9c3d650f977f3783fa73b941f677639a449ff`
**Provider:** Daytona (`@daytonaio/sdk@0.230.0`)

---

## 1. Executive Summary

Daytona is now the primary sandbox provider candidate for Ember V1. This PoC delivers a
complete `DaytonaSandboxProvider` adapter implementing the existing provider-neutral
`SandboxProvider` contract, a real-remote smoke harness covering all required lifecycle
steps, and 51 unit tests driven by an in-memory fake SDK client.

**Key finding from architecture review:** Daytona's default sandbox class is a
**shared-kernel container** (not a VM). The `linux-vm` class is opt-in and available.
This has direct implications for isolation guarantees and is documented in the Security
Gap Report.

---

## 2. Deliverables

| Deliverable         | Location                                     | Lines |
| :------------------ | :------------------------------------------- | ----: |
| Adapter package     | `packages/sandbox-daytona`                   | 1,972 |
| Smoke harness CLI   | `apps/cli/src/sandbox-smoke-daytona`         | 1,720 |
| Contract tests      | `tests/unit/daytona-sandbox-adapter.test.ts` |   558 |
| Harness tests       | `tests/unit/daytona-smoke-harness.test.ts`   |   315 |
| Fake SDK client     | `tests/unit/support/fake-daytona-client.ts`  |   390 |
| Security Gap Report | `docs/P0-C4-DAYTONA-SECURITY-GAP-REPORT.md`  |     — |

---

## 3. SDK Integration

- **Package:** `@daytonaio/sdk@0.230.0` (pinned)
- **Transport:** REST via `@daytona/api-client`
- **Key methods used:** `Daytona.create()`, `Sandbox.process.executeCommand()`,
  `Sandbox.fs.uploadFile()` / `downloadFile()`, `Sandbox.delete()`, `Daytona.list()`
- **Session-based execution:** Commands run in named sessions (`sessionId`), enabling
  cancellation via `Sandbox.process.deleteSession()`.

### Sandbox Class Comparison

| Capability             | Container (default)                | Linux VM (opt-in)    |
| :--------------------- | :--------------------------------- | :------------------- |
| Isolation              | Shared kernel (namespaces/cgroups) | Full VM (own kernel) |
| Cold start             | Fast (~2–5 s)                      | Slower (~10–30 s)    |
| Pause/Resume           | No                                 | Yes                  |
| Fork                   | No                                 | Yes                  |
| Hot snapshot           | No                                 | Yes                  |
| Cost                   | Lower                              | Higher               |
| Kernel exploit surface | Shared with host                   | Isolated             |

**Recommendation:** For V1 production, use `linux-vm` class where the workload handles
untrusted input. Container class is acceptable for controlled, first-party code.

---

## 4. Contract Mapping

The adapter implements the existing `SandboxProvider` interface without modification:

| Contract Method               | Daytona Implementation                                 | Notes                                                     |
| :---------------------------- | :----------------------------------------------------- | :-------------------------------------------------------- |
| `create(spec)`                | `Daytona.create()` with labels, TTL, resource limits   | Labels encode `owner`, `tenant`, `run` for reconciliation |
| `waitReady(id, deadlineMs)`   | Polls `Sandbox.refreshData()` until state is `started` | Verifies post-allocation resources                        |
| `exec(id, argv, timeout)`     | `Sandbox.process.executeCommand()` in a named session  | POSIX-quoted argv, program allowlist                      |
| `readOutput(id, ref)`         | In-memory retained output map                          | Bounded to 64 KiB/stream, 32 outputs/sandbox              |
| `putTextFile(id, path, text)` | `Sandbox.fs.uploadFile()`                              | Path confinement under workspace root                     |
| `getTextFile(id, path)`       | `Sandbox.fs.downloadFile()`                            | Same path confinement                                     |
| `textFileExists(id, path)`    | `Sandbox.fs.getFileDetails()`                          |                                                           |
| `usage(id)`                   | Derived from allocated resources × elapsed time        | Basis: `NOMINAL_TEMPLATE`                                 |
| `stop(id)`                    | `Sandbox.stop()`                                       |                                                           |
| `destroy(id)`                 | `Sandbox.delete()`                                     |                                                           |
| `verifyNoLiveSandboxes()`     | `Daytona.list({ labels })` filtered by owner           | Returns `VERIFIED_ZERO` from vendor control plane         |

### PoC-only extensions (not in base contract)

- `putTextFile` / `getTextFile` / `textFileExists` — file round-trip without `ArtifactStore`
- `verifyNoLiveSandboxes` — independent cleanup audit from vendor control plane
- `sweepOrphanedSandboxes` — reconciler for crash-recovery testing

---

## 5. Security Controls

| Control                      | Implementation                                                                 |
| :--------------------------- | :----------------------------------------------------------------------------- |
| No Ember secrets in sandbox  | `create()` passes no `envVars`                                                 |
| Network isolation            | `networkBlockAll: true` + `networkAllowList` deny-all by default               |
| Post-allocation verification | `waitReady` fails closed if vendor reports internet enabled or over-allocation |
| No shell injection           | Every argv token POSIX single-quoted; program allowlist gates `argv[0]`        |
| Bounded blast radius         | 120 s TTL, 2 concurrent, 16 tokens, 8 KiB command, 64 KiB/stream, 256 KiB/file |
| Path confinement             | All file paths resolve under `/home/daytona/ember`; traversal rejected         |
| Orphan recovery              | `idleStopMinutes: 2` + `autoDeleteMinutesAfterStop: 0` (vendor-side reclaim)   |
| Multi-tenant isolation       | Labels encode tenant; cross-tenant access tested in smoke                      |
| Independent cleanup audit    | `VERIFIED_ZERO` from `Daytona.list()`; a `PASS` without it is rejected         |

---

## 6. Measurement Table (BLOCKED)

> **No real measurements exist.** The `DAYTONA_API_KEY` was not available in this
> environment. The harness reports `status: "BLOCKED"` with exit code 3. Every
> measurement stays `null`. No simulated value is promoted to a real one.

| Measurement                     | Value                       | Basis                            |
| :------------------------------ | :-------------------------- | :------------------------------- |
| Create latency                  | `null`                      | BLOCKED                          |
| Ready latency                   | `null`                      | BLOCKED                          |
| First command latency           | `null`                      | BLOCKED                          |
| Command execution latency       | `null`                      | BLOCKED                          |
| File round-trip latency         | `null`                      | BLOCKED                          |
| Timeout behavior                | `null`                      | BLOCKED                          |
| Cancel latency                  | `null`                      | BLOCKED                          |
| Stop/Destroy latency            | `null`                      | BLOCKED                          |
| Memory/CPU configuration        | 1 vCPU / 1 GiB (configured) | Config, not measured             |
| Estimated cost per minute       | ~$0.0011                    | From published rates (see below) |
| Actual usage / remaining credit | `null`                      | BLOCKED                          |
| Failure and cleanup behavior    | `null`                      | BLOCKED                          |

### Estimated cost model (not a measurement)

Based on Daytona published list prices (2026-11-06):

| Resource                | Rate             | Per-minute (1 vCPU / 1 GiB / 3 GiB) |
| :---------------------- | :--------------- | :---------------------------------- |
| vCPU                    | $0.0504/hr       | $0.00084                            |
| Memory                  | $0.0162/GiB-hr   | $0.00027                            |
| Disk (first 5 GiB free) | $0.000108/GiB-hr | $0.00 (3 GiB < 5 GiB free)          |
| **Total**               |                  | **~$0.0011/min**                    |

A 120-second sandbox at 1 vCPU / 1 GiB costs approximately **$0.0022**.

### Free tier limits (from vendor documentation)

- **Concurrency:** Up to 10 vCPU / 10 GiB total across all sandboxes (Tier 1)
- **Network egress:** Restricted on Tier 1 and 2 (may affect egress probe)
- **Auto-stop:** Configurable; adapter sets 2-minute idle stop
- **No credit card required** for free tier

---

## 7. Crash Recovery & Reconciliation

The `sweepOrphanedSandboxes` reconciler:

1. Lists all sandboxes matching the owner label via `Daytona.list()`
2. Filters to those older than `minAgeMs` (default: 0)
3. Deletes each one via `Sandbox.delete()`
4. Returns `{ destroyed, failed, elapsedMs }`

The smoke harness tests this by:

1. Creating a sandbox in a dedicated crash tenant
2. Simulating a worker crash (not calling `destroy()`)
3. Running the reconciler
4. Verifying the orphan is reclaimed

**Vendor-side backstop:** Even without the reconciler, `idleStopMinutes: 2` +
`autoDeleteMinutesAfterStop: 0` means Daytona itself will stop and destroy the sandbox
within 2 minutes of idle time.

---

## 8. Multi-Tenant Isolation

The smoke harness tests cross-tenant isolation by:

1. Creating sandbox A (tenant A) and writing a file
2. Creating sandbox B (tenant B)
3. Attempting to read tenant A's file from tenant B's sandbox
4. Verifying the read fails (file does not exist in tenant B's filesystem)

**Expected result:** Each sandbox has its own filesystem. Tenant B cannot access tenant
A's files. Labels encode tenant for control-plane filtering.

---

## 9. GO / NO-GO Recommendation

### Verdict: **NO-GO for V1 adoption on this evidence**

Not a judgement on Daytona — a judgement on evidence. Zero measured latency, isolation,
or cost figures exist because no API key was available. The container-vs-VM isolation
question is architecturally understood but not empirically verified.

### Gates that would flip to GO

1. **Real smoke run** with `DAYTONA_API_KEY` (free tier): all 15 steps pass
2. **Measured latencies** within acceptable bounds (create < 10 s, exec < 2 s)
3. **Isolation verification:** cross-tenant read fails; egress probe confirms deny-all
4. **Crash recovery:** reconciler reclaims orphan within expected window
5. **Cost confirmation:** actual spend matches estimate within 20%
6. **Container vs VM decision:** choose `linux-vm` for untrusted workloads

### GO for one time-boxed measurement run

Once a key exists:

```bash
export DAYTONA_API_KEY=...   # free tier only
pnpm sandbox:smoke:daytona --out docs/evidence/p0c4-daytona-run-01.json
```

Expected: ~30 seconds, 120-second hard cap, ≤2 concurrent sandboxes.

---

## 10. Out of Scope / Not Touched

- No paid plan upgrade, no payment authorised or incurred
- No real user data, no production credentials, no host directory access
- No change to `DeterministicExecutor`, `SandboxAdapter`, or any migration
- Adapter is **not** marked production-ready anywhere
- `apps/api`, `apps/worker`, `packages/execution` do not import the adapter

---

## 11. Verification

| Command                      | Exit  | Result                            |
| :--------------------------- | :---: | :-------------------------------- |
| `tsc -p tsconfig.json`       |   0   | Clean                             |
| `tsc -b tsconfig.build.json` |   0   | Clean                             |
| `prettier --check .`         |   0   | Clean                             |
| `eslint` (new files)         |   0   | 0 errors / 0 warnings             |
| `vitest run` (new tests)     |   0   | 51/51 pass                        |
| `vitest run` (full suite)    |   1   | 1305 pass, 1 pre-existing failure |
| `pnpm sandbox:smoke:daytona` | **3** | `BLOCKED` — no credential         |

The 1 unit failure is **pre-existing on `main@c6c9c3d`**: `local-blob-store.test.ts`
(reproduces on pristine main).
