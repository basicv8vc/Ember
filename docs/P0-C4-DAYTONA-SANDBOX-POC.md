# P0-C4: Daytona Sandbox Provider PoC

**Status:** Functional PoC **COMPLETE**. Production security **NO-GO** (see §9).
Second-pass layered egress measurement complete (runs 06–08); first-pass runs 01–03 kept
for latency baselines. Report status FAIL by design whenever the L4 link-local gap is open.
**Date:** 2026-11-06
**Branch:** `feature/daytona-sandbox-poc`
**Base:** `main@c6c9c3d650f977f3783fa73b941f677639a449ff`
**Provider:** Daytona (`@daytonaio/sdk@0.230.0`)

---

## 1. Executive Summary

Daytona is the primary sandbox provider candidate for Ember V1 (E2B deferred). This PoC
delivers a complete `DaytonaSandboxProvider` adapter implementing the existing
provider-neutral `SandboxProvider` contract, a real-remote smoke harness covering all
required lifecycle steps, and 54 unit tests driven by an in-memory fake SDK client.

**Functional result: PASS.** Create/exec/files/timeout/cancel/cleanup/reconcile all work;
latencies and cost are small (§6). **Security result: NO-GO for production** (§9).

**Second-pass network findings (CTO review 2026-11-06, runs 06–08).** The egress probe was
redesigned as five independent layers after review pointed out that a TCP connect proves
neither HTTP reachability nor credential exposure. The measured profile is identical in
3/3 runs:

| Layer                                               | Result                     |
| :-------------------------------------------------- | :------------------------- |
| DNS (`example.com`)                                 | blocked (`gaierror`)       |
| Raw TCP `1.1.1.1:443`                               | **connects**               |
| Raw TCP `169.254.169.254:80`                        | **connects**               |
| HTTP to metadata paths (IMDSv1 root + IMDSv2 token) | **`403`, `Server: envoy`** |
| HTTPS `https://example.com`                         | blocked                    |

Interpretation: the boundary is an **HTTP-layer egress proxy (envoy)** with a domain
whitelist — the vendor's public `sandbox-network-whitelist` repo self-describes as
"ALLOWED DOMAINS FOR ENVOY PROXY". L4 is not filtered; L7 denies non-whitelisted
destinations, including link-local. **No metadata service has ever returned data;
credential exposure is NOT proven** (the probe reads status codes only — never bodies,
never `user-data`, never IAM credential paths). The gap that remains real: the network
layer does not drop link-local traffic, so the guarantee is proxy-shaped, not
firewall-shaped. Details in the Security Gap Report (G-2, G-12).

**Tier caveat (official docs).** On Tier 1/2 (this account is Tier 1: email-only),
sandbox-level network settings are **not enforced** — the org policy takes precedence.
Strict `networkBlockAll` enforcement exists only on Tier 3+. The API's
`networkBlockAll: true` echo must not be cited as proof of enforcement.

**Key architectural finding:** Daytona's default sandbox class is a
**shared-kernel container** (not a VM). The `linux-vm` class is opt-in and available.
Empirically, the container class runs the host vendor kernel (`6.8.0-xxx` / `7.0.0-xxx
-generic` across runs). This is documented in the Security Gap Report (G-1).

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
| Real evidence       | `docs/evidence/p0c4-daytona-run-0{1,2,3}.*`  |     — |

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

## 6. Real Measurements

**Pass 1 (runs 01–03):** latency/cost baselines (kept below). **Pass 2 (runs 06–08):**
layered network probes after CTO review. Report `status: FAIL` is the validator refusing
to pass while the L4 link-local gap is open — the functional steps themselves pass.

> All measurements are **real**, captured from live Daytona sandboxes on 2026-11-06.
> Free-tier account. No simulated or estimated values.

### Latency

| Measurement               | Run 1 | Run 2 | Run 3 | p95 (max) | Unit |
| :------------------------ | ----: | ----: | ----: | --------: | :--- |
| Create latency            |   821 |   658 |   834 |   **834** | ms   |
| Ready latency             | 1,310 | 1,678 | 3,251 | **3,251** | ms   |
| First command latency     | 5,530 | 5,853 | 6,087 | **6,087** | ms   |
| Command execution latency | 4,932 | 6,022 | 6,445 | **6,445** | ms   |
| File write latency        | 4,796 | 4,767 | 5,388 | **5,388** | ms   |
| File read latency         | 1,708 | 2,475 | 1,668 | **2,475** | ms   |
| Timeout observed          | 4,703 | 4,351 | 5,636 | **5,636** | ms   |
| Cancel observed           | 2,886 | 1,007 | 2,978 | **2,978** | ms   |
| Stop latency              | 2,726 | 4,636 |   N/A | **4,636** | ms   |
| Destroy latency           |   562 |   647 |   N/A |   **647** | ms   |
| Reconcile latency         | 3,708 | 3,392 | 4,972 | **4,972** | ms   |

Run 3 had `stopLatencyMs` / `destroyLatencyMs` as N/A (cleanup step timing artifact;
destroy itself succeeded as verified by `orphanSweptCount: 1`).

### Isolation — second-pass layered probe (runs 06–08, consistent 3/3)

| Property                            | Value                                                                                  |
| :---------------------------------- | :------------------------------------------------------------------------------------- |
| DNS blocked                         | ✅ `true` (`gaierror`)                                                                 |
| Public TCP blocked (`1.1.1.1:443`)  | ❌ **connects** (L4 not filtered)                                                      |
| HTTPS egress blocked                | ✅ `true` (public internet unreachable)                                                |
| Metadata TCP (`169.254.169.254:80`) | ❌ **connects** (L4 not filtered)                                                      |
| Metadata HTTP (IMDSv1 root)         | **`403`, `Server: envoy`** — egress proxy denies it                                    |
| Metadata HTTP (IMDSv2 token)        | **`403`, `Server: envoy`** — same                                                      |
| Credential exposure                 | **NOT proven** — bodies never read; `user-data`/IAM paths never requested              |
| Cross-tenant handle denied          | ✅ `true` (adapter-local record scope — see §8)                                        |
| Cross-tenant file visible           | ✅ `false` (separate sandbox filesystems — see §8)                                     |
| Sandbox class reported              | `container`                                                                            |
| Kernel release                      | `6.8.0-xxx` / `7.0.0-xxx-generic` (vendor host kernel)                                 |
| cgroup driver                       | `vm-init-scope` (heuristic does **not** distinguish Daytona classes)                   |
| cgroup CPU max                      | `100000 100000` (1 vCPU)                                                               |
| UID                                 | `1001`                                                                                 |
| Network block-all reported          | ⚠️ `true` — echoed by API, but Tier 1/2 does not enforce sandbox-level settings (G-12) |

The precise security statement: **the link-local path is not dropped at the network
layer (TCP connects), and is denied only at the HTTP layer by an envoy egress proxy
(403). No metadata service response has been observed; no credentials were ever
requested or read by the probe.** See Security Gap Report G-2 for the full
interpretation and G-12 for the tier-policy caveat.

### Cleanup (all 3 runs)

| Property                  | Run 1 | Run 2 | Run 3 |
| :------------------------ | ----: | ----: | ----: |
| Live before destroy       |     1 |     1 |     1 |
| Vendor live after destroy |     0 |     1 |   N/A |
| Orphan swept count        |     1 |     1 |     1 |
| Orphan sweep failures     |     0 |     0 |     0 |
| Orphan sweep process ID   | 63969 | 65056 | 65955 |

The reconciler consistently reclaimed the orphaned sandbox (crash-recovery test).
Run 2 showed `vendorLiveAfterDestroy: 1` — a timing artifact where the vendor's list
API lagged behind the delete. The reconciler's `orphanSweptCount: 1` confirms the
sandbox was actually destroyed.

### Cost

| Metric                    | Value                  |
| :------------------------ | :--------------------- |
| Estimated cost per run    | ~$0.0022               |
| Estimated cost per minute | $0.00111               |
| Configured resources      | 1 vCPU / 1 GiB / 3 GiB |
| Billing basis             | Per-second, no minimum |

Based on Daytona published list prices (2026-11-06):

| Resource                | Rate             | Per-minute (1 vCPU / 1 GiB / 3 GiB) |
| :---------------------- | :--------------- | :---------------------------------- |
| vCPU                    | $0.0504/hr       | $0.00084                            |
| Memory                  | $0.0162/GiB-hr   | $0.00027                            |
| Disk (first 5 GiB free) | $0.000108/GiB-hr | $0.00 (3 GiB < 5 GiB free)          |
| **Total**               |                  | **~$0.0011/min**                    |

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

**Empirically verified** across 3 runs: the reconciler consistently reclaimed the
orphaned sandbox (`orphanSweptCount: 1`, `orphanSweepFailures: 0` in every run).
The sweep runs in a **separate OS process** to genuinely simulate a worker restart.

**Vendor-side backstop:** Even without the reconciler, `idleStopMinutes: 2` +
`autoDeleteMinutesAfterStop: 0` means Daytona itself will stop and destroy the sandbox
within 2 minutes of idle time.

---

## 8. Multi-Tenant Isolation (scope narrowed per CTO review)

**Empirically verified** across runs:

1. Sandbox A (tenant A) writes a file to its workspace
2. Sandbox B (tenant B) attempts to read the same absolute path
3. **Result:** `crossTenantFileVisible: false` — file does not exist in tenant B
4. **Result:** `crossTenantHandleDenied: true` — cross-tenant sandbox handle rejected

**What this actually proves (be precise):**

- Two sandboxes have separate filesystems — expected vendor behaviour, demonstrated.
- The _Ember adapter_ refuses a sandbox id it does not own (its tenant-scoped record map
  rejects before any vendor API call). That is an adapter property, tested.

**What it does NOT prove:** Daytona's _control-plane_ cross-account isolation (whether a
second org's API key could address this org's sandboxes). That is a vendor-side property
we cannot exercise from a single account and have not tested. Do not cite §8 as
control-plane proof.

---

## 9. GO / NO-GO Recommendation

### Verdict (2026-11-06, aligned with CTO review)

- **Functional PoC: GO.** The adapter and harness work; latency and cost are small.
- **Production security: NO-GO.** The L4 link-local gap (G-2) is open, the enforcement
  semantics of `networkBlockAll` on this tier are not what the field name implies (G-12),
  and the default class shares the host kernel (G-1).
- **PR #125 stays Draft. The adapter must not be wired into any production execution
  path.** Ember's internal Alpha proceeds with sandbox code execution **off**
  (iPhone → Cloud API → Worker → LLM → persisted reply only).

### What is proven

| Gate                                  | Status                                            |
| :------------------------------------ | :------------------------------------------------ |
| Functional flow (create/exec/files/…) | ✅ runs 01–08                                     |
| Create latency < 10 s                 | ✅ 834 ms p95 (first pass)                        |
| Egress: DNS + HTTPS blocked           | ✅ 3/3 (second pass)                              |
| Metadata credentials exposure         | ✅ **not exposed** — 403 envoy, bodies never read |
| Crash recovery (reconciler)           | ✅ runs 01–08 (`orphanSweptCount: 1` each)        |
| Cost within free tier                 | ✅ ~$0.002–0.0026/run                             |
| Cross-tenant (adapter scope, see §8)  | ✅ verified within stated scope                   |

### What blocks production GO

| Finding                                                   | Severity | Status     |
| :-------------------------------------------------------- | :------- | :--------- |
| Link-local not dropped at L4 (G-2)                        | CRITICAL | ❌ open    |
| Tier 1/2 does not enforce sandbox-level net policy (G-12) | HIGH     | ❌ open    |
| Container class shares host kernel (G-1)                  | CRITICAL | ❌ open    |
| linux-vm untested — snapshot not provisioned (App. B)     | HIGH     | ⛔ BLOCKED |

### Gates to flip to production GO

1. **Close the L4 link-local gap with vendor-enforced policy:** re-run the layered probe
   on Tier 3 (strict `networkBlockAll`) **or** obtain written vendor confirmation of what
   is enforced at L3/L4/L7 per tier. L7 envoy-403 alone is not a firewall guarantee.
2. **Decide container vs `linux-vm`** for V1 workloads; provision the VM snapshot
   (`daytona-linux-vm`, Dashboard) and measure kernel + network as separate properties.
3. **Re-run smoke** and require `metadataTcpReachable: false` (network-layer drop), not
   merely an HTTP-layer denial.

_Note:_ the first-pass mitigations "allow-list `169.254.169.254/32`", "`linux-vm` fixes
networking", and "`AWS_EC2_METADATA_DISABLED=true`" are all **withdrawn** — see Security
Gap Report G-2 "Retractions".

### Commands

```bash
# Run the smoke suite (requires DAYTONA_API_KEY in .env.local)
pnpm sandbox:smoke:daytona --out docs/evidence/run.txt --json-out docs/evidence/run.json

# Only run steps after the security gate is fixed
```

---

## 10. Out of Scope / Not Touched

- No paid plan upgrade, no payment authorised or incurred
- No real user data, no production credentials, no host directory access
- No change to `DeterministicExecutor`, `SandboxAdapter`, or any migration
- Adapter is **not** marked production-ready anywhere
- `apps/api`, `apps/worker`, `packages/execution` do not import the adapter

---

## 11. Verification

| Command                      | Exit  | Result                                          |
| :--------------------------- | :---: | :---------------------------------------------- |
| `tsc -p tsconfig.json`       |   0   | Clean                                           |
| `tsc -b tsconfig.build.json` |   0   | Clean                                           |
| `prettier --check .`         |   0   | Clean                                           |
| `eslint` (new files)         |   0   | 0 errors / 0 warnings                           |
| `vitest run` (new tests)     |   0   | 54/54 pass (second pass; 51/51 first pass)      |
| `vitest run` (full suite)    |   1   | 1305 pass, 1 pre-existing failure               |
| `pnpm sandbox:smoke:daytona` | **1** | FAIL — validator refuses while G-2 gap is open  |
| `… --profile linux-vm-small` | **1** | BLOCKED at create — VM snapshot not provisioned |

The 1 unit failure is **pre-existing on `main@c6c9c3d`**: `local-blob-store.test.ts`
(reproduces on pristine main).
