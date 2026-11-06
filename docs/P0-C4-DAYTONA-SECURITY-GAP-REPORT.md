# P0-C4: Daytona Security Gap Report

**Date:** 2026-11-06
**Branch:** `feature/daytona-sandbox-poc`
**Scope:** Daytona sandbox provider adapter and smoke harness
**Severity scale:** CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## Summary

12 security gaps identified (G-1 through G-12). One is CRITICAL-CONFIRMED and blocks
production adoption. Three are verified/closed after real testing.

| Severity | Count | IDs                   |
| :------- | :---: | :-------------------- |
| CRITICAL |   2   | G-1, G-2 ❌           |
| HIGH     |   2   | G-3 ✅, G-4           |
| MEDIUM   |   4   | G-5 ⚠️, G-6, G-7, G-8 |
| LOW      |   2   | G-9, G-10             |
| INFO     |   2   | G-11 ✅, G-12         |

**Real-testing status (2026-11-06):** 3 smoke runs completed. Cross-tenant isolation (G-3)
and SDK pinning (G-11) verified closed. Metadata endpoint reachability (G-2) confirmed
as a real vulnerability. Crash-recovery reconciler (G-5) partially verified.

---

## Gap Register

### G-1 — Container class shares host kernel (CRITICAL)

**Description:** Daytona's default sandbox class (`container`) runs on a shared kernel.
A kernel-level exploit in the sandbox can potentially escape to the host or other sandboxes.

**Evidence:** Daytona documentation states container sandboxes use namespaces and cgroups
for isolation, not a separate kernel. The `linux-vm` class provides full VM isolation.

**Impact:** Sandbox escape via kernel vulnerability; cross-sandbox data leakage.

**Mitigation:**

- Use `linux-vm` class for any workload that processes untrusted input
- Keep container class only for first-party, controlled code
- Monitor for kernel CVEs affecting the host kernel version

**Status:** OPEN — requires production configuration decision.

---

### G-2 — Cloud metadata endpoint reachable despite networkBlockAll (CRITICAL) — CONFIRMED

**Description:** `networkBlockAll: true` blocks public internet egress (confirmed:
`egressBlocked: true`), but `169.254.169.254:80` (cloud metadata endpoint) remains
**reachable** from inside the sandbox. Confirmed across 3 real runs.

**Impact:** A compromised sandbox can query the cloud metadata service to obtain IAM
credentials, instance identity, user-data (which may contain secrets), and network
configuration. This is the single most exploited sandbox escape vector in cloud environments.

**Evidence (3/3 runs):**

- `metadataEndpointReachable: true`
- `egressBlocked: true` (public internet blocked)
- `networkBlockAllReported: true` (vendor acknowledges the setting)

**Mitigation:**

- **Immediate:** Add `169.254.169.254/32` to `networkAllowList` deny rules (if supported)
- **Alternative:** Switch to `linux-vm` class, which has an isolated network stack
- **Belt-and-suspenders:** Set `AWS_EC2_METADATA_DISABLED=true` or equivalent in the
  sandbox environment (adapter currently passes no envs — this would be an exception)
- **Verify:** Re-run `egressProbe` after mitigation; require `metadataEndpointReachable: false`

**Status:** ❌ CONFIRMED — blocks production adoption.

---

### G-3 — Cross-tenant filesystem isolation (HIGH) — VERIFIED ✅

**Description:** Each sandbox has its own filesystem. Verified across 3 real runs:
file written by tenant A is **not visible** to tenant B (`crossTenantFileVisible: false`),
and cross-tenant sandbox handles are rejected (`crossTenantHandleDenied: true`).

**Impact:** Resolved. Tenant isolation is confirmed at the filesystem and control-plane level.

**Status:** ✅ VERIFIED — closed.

---

### G-4 — API key handling not verified in all code paths (HIGH)

**Description:** The API key is passed via environment variable (`DAYTONA_API_KEY`) and
read by the SDK client. The smoke harness sanitizes reports to avoid leaking the key, but
the full code path from env var to SDK call has not been audited for logging or error
message leakage.

**Impact:** API key could appear in logs, error messages, or crash dumps.

**Mitigation:**

- Audit all `console.log` / `console.error` paths for key leakage
- Ensure error messages from the SDK are sanitized before reporting
- The existing `sanitizeText()` function redacts `dtn_*` patterns; verify coverage

**Status:** PARTIALLY MITIGATED — sanitizer exists; full audit pending.

---

### G-5 — Idle-stop backstop timing (MEDIUM) — PARTIALLY VERIFIED

**Description:** The adapter sets `idleStopMinutes: 2` and `autoDeleteMinutesAfterStop: 0`
as the primary orphan control. The crash-recovery test (reconciler sweep) verified that
orphans are reclaimed (`orphanSweptCount: 1`, `orphanSweepFailures: 0` across 3 runs).
However, the vendor-side idle-stop timer has not been independently verified — the
reconciler runs at `minAgeMs: 0`, so it reclaims orphans before the idle timer fires.

**Mitigation:**

- Run a separate test: create a sandbox, do NOT call `destroy()` or the reconciler
- Verify the vendor stops the sandbox within 2 minutes + 30 seconds tolerance
- Verify the sandbox is deleted after stop

**Status:** ⚠️ PARTIALLY MITIGATED — reconciler works; vendor-side timer unverified.

---

### G-6 — Reconciler has no rate limiting (MEDIUM)

**Description:** `sweepOrphanedSandboxes` deletes all matching sandboxes in a loop with no
rate limiting. If called frequently or with a broad label filter, it could hit API rate
limits or delete sandboxes belonging to active runs.

**Mitigation:**

- Add a `maxDeletesPerSweep` parameter
- Add exponential backoff on API errors
- Ensure the reconciler is called at most once per interval (e.g., 5 minutes)

**Status:** OPEN — low risk in PoC; must fix before production.

---

### G-7 — Path confinement uses string prefix matching (MEDIUM)

**Description:** File path confinement resolves paths under `/home/daytona/ember` and
rejects traversal. The implementation uses string prefix matching rather than
`path.resolve()` + prefix check.

**Impact:** Edge cases like `/home/daytona/ember-evil` (sibling directory) might bypass
the check if the implementation is `/home/daytona/ember` + `/`.

**Mitigation:**

- Verify the implementation appends a `/` before the prefix check
- Add a test for `/home/daytona/ember-evil` and `/home/daytona/emberX`
- Use `path.resolve()` and check `resolved.startsWith(workspaceRoot + '/')`

**Status:** PARTIALLY MITIGATED — traversal tests exist; sibling-directory test missing.

---

### G-8 — Retained output memory not bounded across sandboxes (MEDIUM)

**Description:** Each sandbox retains up to 32 outputs × 64 KiB/stream = 4 MiB. The
provider tracks up to 16 sandboxes, giving a theoretical maximum of 64 MiB of retained
output. No global cap exists.

**Impact:** Under high concurrency, memory usage could grow unbounded.

**Mitigation:**

- Add a global retained-output byte cap (e.g., 128 MiB)
- Evict oldest outputs when the cap is reached
- Add a test that verifies the global cap

**Status:** OPEN — low risk in PoC (≤2 concurrent); must fix before production.

---

### G-9 — Program allowlist may be too restrictive for V1 (LOW)

**Description:** The adapter has a program allowlist (`python`, `node`, `bash`, `sh`,
`cat`, `ls`, `echo`, `true`, `false`, `sleep`, `timeout`). Real workloads may need
additional programs.

**Impact:** Legitimate commands could be rejected.

**Mitigation:**

- Review the allowlist with the V1 execution team
- Add a configuration option to extend the allowlist per tenant
- Log rejected programs for visibility

**Status:** OPEN — by design; extend as needed.

---

### G-10 — No audit logging of sandbox lifecycle events (LOW)

**Description:** The adapter does not emit structured audit logs for create, exec, destroy,
or reconciliation events. The smoke harness records step-level events in the report, but
the provider itself does not log.

**Impact:** Difficult to trace security incidents or cost anomalies in production.

**Mitigation:**

- Add structured logging (JSON) for all lifecycle transitions
- Include tenant, owner, run, and sandbox ID in every log entry
- Ship logs to a centralised system

**Status:** OPEN — required for production.

---

### G-11 — Daytona SDK version pinning (INFO)

**Description:** The SDK is pinned at `@daytonaio/sdk@0.230.0` in `package.json`. A
transitive or hoisted upgrade could silently change the transport contract.

**Mitigation:**

- The adapter asserts the SDK version at construction (similar to E2B adapter)
- CI should run `pnpm install --frozen-lockfile`

**Status:** MITIGATED — version pinned in lockfile.

---

### G-12 — Free tier network restrictions may affect egress probe (INFO)

**Description:** Daytona Tier 1 (free) accounts have network egress restrictions. The
egress probe may fail not because the adapter's policy works, but because the vendor
blocks egress at the tier level.

**Mitigation:**

- Document the tier restriction in the report
- Run the egress probe on both free and paid tiers if possible
- Distinguish between "adapter policy blocks egress" and "vendor tier blocks egress"

**Status:** INFORMATIONAL — document in measurement report.

---

## Production Readiness Checklist

Before marking the Daytona adapter as production-ready:

- [ ] G-1: Decide container vs `linux-vm` class; document rationale
- [ ] G-2: Run egress probe against real API; verify deny-all
- [ ] G-3: Run cross-tenant isolation test; verify filesystem separation
- [ ] G-4: Audit all logging paths for key leakage
- [ ] G-5: Verify idle-stop backstop timing empirically
- [ ] G-6: Add rate limiting to reconciler
- [ ] G-7: Add sibling-directory path traversal test
- [ ] G-8: Add global retained-output cap
- [ ] G-9: Review program allowlist with V1 team
- [ ] G-10: Add structured audit logging
- [ ] Run full smoke suite 5 times; record p95 latencies
- [ ] Confirm cost model against actual billing
- [ ] Penetration test sandbox isolation (if handling untrusted input)
