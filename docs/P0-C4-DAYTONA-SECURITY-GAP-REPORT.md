# P0-C4: Daytona Security Gap Report

**Date:** 2026-11-06
**Branch:** `feature/daytona-sandbox-poc`
**Scope:** Daytona sandbox provider adapter and smoke harness
**Severity scale:** CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## Summary

12 security gaps identified (G-1 through G-12). One is CRITICAL-OPEN and blocks
production adoption. Three are verified/closed after real testing.

| Severity | Count | IDs                   |
| :------- | :---: | :-------------------- |
| CRITICAL |   2   | G-1, G-2 ❌           |
| HIGH     |   3   | G-3 ✅, G-4, G-12     |
| MEDIUM   |   4   | G-5 ⚠️, G-6, G-7, G-8 |
| LOW      |   2   | G-9, G-10             |
| INFO     |   1   | G-11 ✅               |

**Real-testing status (2026-11-06, second pass):** layered egress probes (DNS / public-IP
TCP / metadata TCP / metadata HTTP / HTTPS) deployed and measured over 3+ real runs
(runs 06–08, evidence `docs/evidence/p0c4-daytona-run-0{6,7,8}.json`). Findings:

- **G-2 refined:** `169.254.169.254:80` accepts TCP (4/4 runs), but the HTTP layer answers
  **`403` with `Server: envoy`** on both the IMDSv1 root and the IMDSv2 token endpoint.
  That is the Daytona egress proxy _forbidding_ the request — **no metadata service
  response has ever been observed, and credential exposure is NOT proven** (the probe
  never reads response bodies and never requests `user-data` or IAM credential paths).
  The isolation gap is now precisely characterised: **L4 is not filtered; L7 is gated by
  an HTTP proxy (envoy) that denies non-whitelisted destinations.**
- **Same L4/L7 split for public egress:** raw TCP to `1.1.1.1:443` connects, while DNS
  resolution and HTTPS to `example.com` fail. The "deny-all" is an HTTP-layer policy.
- **G-3 scope corrected:** cross-tenant checks prove the _Ember adapter's_ tenant-scoped
  bookkeeping and separate-sandbox filesystems. They are **not** evidence that the Daytona
  control plane enforces cross-account isolation (see G-3).
- **G-12 promoted from INFO to decision-relevant:** official Daytona docs confirm Tier 1/2
  sandbox-level network settings are **not enforced**; strict block-all requires Tier 3+
  (see G-12 and the tier appendix).

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

### G-2 — Link-local metadata path is not dropped at the network layer (CRITICAL) — GAP CONFIRMED, CREDENTIAL EXPOSURE UNPROVEN

**Description (second pass, per CTO review 2026-11-06).** A TCP connect alone proves
nothing about HTTP reachability and nothing about credentials. The probe was therefore
redesigned as five layers, each measured separately:

| Layer            | Probe                                             | Result (runs 06–08)                           |
| :--------------- | :------------------------------------------------ | :-------------------------------------------- |
| L3 DNS           | `gethostbyname('example.com')`                    | **blocked** (`gaierror`)                      |
| L4 public TCP    | connect `1.1.1.1:443`                             | **connects**                                  |
| L4 metadata TCP  | connect `169.254.169.254:80`                      | **connects** (4/4 runs)                       |
| L7 metadata HTTP | `GET /latest/meta-data/`, `PUT /latest/api/token` | **`403`, `Server: envoy`** (status code only) |
| L7 public HTTPS  | `urlopen('https://example.com')`                  | **blocked** (`URLError`)                      |

**What this proves:**

- A **network isolation gap exists**: `networkBlockAll: true` does not drop link-local
  traffic at L3/L4. `169.254.169.254:80` completes a TCP handshake.
- The HTTP layer is gated by an **HTTP egress proxy (`envoy`)** that answers `403` for
  both the IMDSv1 root and the IMDSv2 token endpoint. `Server: envoy` means the response
  came from the proxy, **not** from any cloud metadata service.

**What this does NOT prove (and must not be claimed):**

- **Credential exposure is NOT proven.** The probe never reads response bodies, never
  requests `user-data`, and never requests IAM credential paths. With `403/envoy` at L7,
  no metadata service has ever returned data on this account tier.
- IAM exposure via this vector is _actively unlikely_ on Tier 1 (the proxy forbids the
  request before any metadata service could answer), but "unlikely on Tier 1" is not the
  same as "impossible by construction" — the L4 hole means any non-HTTP protocol toward
  link-local space, or any envoy bypass, is not covered by the observed policy.

**Impact:** exfiltration of credentials via the classic SSRF→IMDS pattern is blocked at
L7 on Tier 1 by envoy, but the network layer does not enforce the boundary. The guarantee
is proxy-shaped, not firewall-shaped. On Tier 3+ (where sandbox-level `networkBlockAll` is
documented as strictly enforced) the behaviour is **untested** and must be re-measured.

**Corrected mitigations** (the first-pass list contained three errors — see "Retractions"):

1. **Tier upgrade to 3+ and re-measure.** Official docs: strict per-sandbox enforcement
   (`networkBlockAll` / allow lists) exists only on Tier 3/4; Tier 1/2 org policy
   "takes precedence" and cannot be overridden at the sandbox level. Strict block-all is
   the only vendor knob that plausibly drops L4 — verify, do not assume.
2. **`linux-vm` class test** (separate guest kernel). This addresses G-1 (kernel boundary).
   It is a _network-stack_ question whether link-local is dropped there — measure it.
   Note: on Tier 1/2 the org egress policy still applies to VMs.
3. **Confirm the policy with Daytona.** Ask whether the egress proxy (envoy) is in-path
   for _all_ protocols and all tiers, and whether link-local `169.254.0.0/16` is dropped
   at L3/L4 anywhere. Draft question prepared; channel: `security@daytona.io` or the
   `daytonaio/sandbox-network-whitelist` repo. **Not yet sent — awaiting approval.**
4. **Application-level:** never deliver secrets through `user-data`; use short-lived,
   audience-scoped tokens minted outside the sandbox and injected for one run.

**Retractions from the first-pass mitigation list:**

- ~~"Add `169.254.169.254/32` to `networkAllowList` deny rules"~~ — **wrong.** An allow
  list is not a deny list; and per official docs the options are mutually exclusive
  (`networkBlockAll` + a non-empty allow list returns `400`).
- ~~"`AWS_EC2_METADATA_DISABLED=true`"~~ — **ineffective.** It only stops the _AWS SDK_
  credential chain from consulting the metadata endpoint; raw HTTP/TCP access is
  unaffected.
- ~~"`linux-vm` … which has an isolated network stack"~~ — **assumption removed.** An
  independent kernel is a separate property from "network access is forbidden"; the VM
  test measures both properties separately.

**Status:** ❌ GAP CONFIRMED at L4 (TCP connect). L7 is proxy-denied (403 envoy);
credential exposure unproven and not observed. Blocks any "production-ready" claim.

---

### G-3 — Cross-tenant filesystem isolation (HIGH) — VERIFIED ✅ (scope narrowed per CTO review)

**Description:** Each sandbox has its own filesystem. Verified across runs: a file written
in tenant A's sandbox is **not visible** in tenant B's sandbox (`crossTenantFileVisible:
false`), and tenant B cannot exec through tenant A's sandbox id
(`crossTenantHandleDenied: true`).

**Scope of this evidence (important):**

- The file check runs `cat <absolute path>` _inside sandbox B_ — it proves two separate
  sandboxes have separate filesystems. That is expected vendor behaviour, not a deep
  control-plane claim.
- The handle check is enforced by the **Ember adapter's own tenant-scoped record map**:
  the adapter refuses an id it does not track before any vendor API call. It is therefore
  **not** a test of Daytona's control-plane/ cross-account isolation (whether a second
  Daytona API key could address the first org's sandboxes is a vendor question we have
  not tested and cannot test from a single account).

**Impact:** Resolved for what it actually tests (adapter bookkeeping + per-sandbox
filesystems). Do **not** cite it as "Daytona control-plane cross-account isolation
proven".

**Status:** ✅ VERIFIED — within the scope above.

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

### G-12 — Tier-based network policy determines what any sandbox-level setting can do (HIGH after review)

**Description:** Official Daytona documentation (network-limits, retrieved 2026-11-06)
states:

> **Tier 1 & Tier 2:** Network access is restricted and **cannot be overridden at the
> sandbox level**. Organization-level network restrictions take precedence over
> sandbox-level settings. Even with `networkAllowList` or `domainAllowList` specified when
> creating a sandbox, the organization's network restrictions still apply.

> **Tier 3 & Tier 4:** … You can set custom network settings per sandbox. A sandbox-level
> `networkAllowList`, `domainAllowList`, or `networkBlockAll` replaces the default policy
> for that sandbox. **Enforcement is strict.**

> The options are mutually exclusive. Set at most one non-empty value. Sending a
> conflicting combination returns a `400` error.

Tier access requirements (official limits page): Tier 1 = email verified; Tier 2 = credit
card + $25 top-up; Tier 3 = $500 top-up; Tier 4 = $2,000 top-up every 30 days.

**Consequences for Ember:**

- The PoC account is Tier 1. `networkBlockAll: true` is **accepted and echoed back** on
  create, but per the docs it is **not enforced at the sandbox level** on Tier 1/2 — the
  organisation policy is what runs. The API's `networkBlockAll: true` response field must
  never be cited as proof of enforcement.
- What we observe (DNS blocked, HTTPS blocked, L4 connects, L7 envoy 403) is the **org
  policy** (an egress proxy with a domain whitelist — the public
  `daytonaio/sandbox-network-whitelist` repo documents it as "ALLOWED DOMAINS FOR ENVOY
  PROXY"; it contains no link-local entries).
- Strict block-all semantics are documented **only** for Tier 3+. Whether strict block-all
  drops L4 and link-local there is **untested**.
- Budgeting: if production requires enforced network isolation, Tier 3 ($500 top-up) is
  the minimum documented path. This is a cost/decision item for CTO, not a code fix.

**Mitigation:** re-run the layered `egressProbe` on Tier 3 (or confirm with Daytona in
writing what Tier 1/2 and Tier 3/4 each enforce at L3/L4/L7) before any production
network-isolation claim.

**Status:** OPEN — decision-relevant; documents why the sandbox-level flag cannot clear
G-2 on the current tier.

---

## Production Readiness Checklist

Before marking the Daytona adapter as production-ready:

- [ ] G-1: Decide container vs `linux-vm` class; document rationale
- [ ] G-2: Close the L4 link-local gap (Tier 3 strict block-all test **or** written
      vendor confirmation that L4/link-local is dropped) — L7 envoy-403 is not sufficient
- [ ] G-3: (closed, scope documented) — do not cite as control-plane proof
- [ ] G-4: Audit all logging paths for key leakage
- [ ] G-5: Verify idle-stop backstop timing empirically
- [ ] G-6: Add rate limiting to reconciler
- [ ] G-7: Add sibling-directory path traversal test
- [ ] G-8: Add global retained-output cap
- [ ] G-9: Review program allowlist with V1 team
- [ ] G-10: Add structured audit logging
- [ ] G-12: Re-run layered egress probe on Tier 3 (or obtain vendor enforcement matrix)
- [ ] linux-vm: measure kernel independence AND network behaviour separately
- [ ] Run full smoke suite 5 times; record p95 latencies
- [ ] Confirm cost model against actual billing
- [ ] Penetration test sandbox isolation (if handling untrusted input)

---

## Appendix A — Tier policy evidence (2026-11-06)

**Sources (official):**

- `https://www.daytona.io/docs/en/network-limits/` — tier-based network restrictions,
  mutual exclusivity, strict enforcement on Tier 3/4. (Retrieved 2026-11-06.)
- `https://www.daytona.io/docs/en/limits` — tier access requirements:
  Tier 1 = email verified; Tier 2 = credit card + $25 top-up; Tier 3 = $500 top-up;
  Tier 4 = $2,000 top-up every 30 days.
- `https://github.com/daytonaio/sandbox-network-whitelist` (`whitelist.yaml`) — the
  essential-services domain whitelist, self-described as "ALLOWED DOMAINS FOR ENVOY PROXY".
  Contains package registries, git hosts, AI APIs, cloud SDK endpoints, etc. **Zero
  entries for `169.254.0.0/16`, link-local, or any metadata service.** No CIDR/IP section
  at all — it is a domain allow list.

**Observed behaviour on Tier 1 (this account):**

- `networkBlockAll: true` accepted at create and echoed back by the API — but per docs,
  sandbox-level settings are not enforced on Tier 1/2.
- DNS resolution: blocked. HTTPS to non-whitelisted domain: blocked.
- Raw TCP: connects (both `1.1.1.1:443` and `169.254.169.254:80`) — consistent with an
  HTTP-layer proxy (envoy) that terminates outbound TCP and filters at L7.
- Metadata HTTP: `403`, `Server: envoy` on both IMDSv1 and IMDSv2 token paths.

**Open question for Daytona (draft, not yet sent):**

> Under a Tier 1/2 organization policy, is `169.254.0.0/16` (link-local, cloud metadata)
> dropped at L3/L4, or only filtered at the HTTP proxy layer? Is the envoy egress proxy
> in-path for all protocols (raw TCP, UDP, non-HTTP) on all tiers? On Tier 3/4 with
> `networkBlockAll: true`, is link-local dropped at the network layer? We have measured
> TCP connects to `169.254.169.254:80` succeeding and HTTP requests being answered with
> `403 Server: envoy` — we want to document precisely what boundary is enforced where.

## Appendix B — linux-vm evidence (2026-11-06): BLOCKED at provisioning

**Goal (CTO item 3):** measure the VM class's kernel independence and its network
behaviour as two separate properties.

**Result: BLOCKED before any measurement.** The vendor catalog lists `daytona-linux-vm`
(class `linux-vm`, state `active`), but the snapshot is **not provisioned to this
organization**. Three access paths all fail:

| Path                                       | Error                                                                                                        |
| :----------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| `snapshot.get('daytona-linux-vm')`         | `DaytonaNotFoundError: Snapshot with name daytona-linux-vm not found`                                        |
| `snapshot.activate('daytona-linux-vm')`    | `DaytonaNotFoundError: … not found`                                                                          |
| `create({ snapshot: 'daytona-linux-vm' })` | `DaytonaValidationError: Snapshot daytona-linux-vm not found. Did you add it through the Daytona Dashboard?` |

Evidence: `docs/evidence/p0c4-daytona-vm-run-01.json` (first attempt used the wrong
snapshot name `daytona-vm-small` — "not available in region us"), and
`docs/evidence/p0c4-daytona-vm-run-02.json` (correct catalog name, still not provisioned).

**What is needed to unblock:** add the `daytona-linux-vm` snapshot to the organization in
the Daytona Dashboard (vendor error message points there explicitly), then re-run
`pnpm sandbox:smoke:daytona --profile linux-vm-small`. Until then, **no claim about VM
network isolation or kernel independence is made from this account.**

**Reminder for the eventual VM run:** report the two properties separately — (a) kernel
independence (`sandboxClassReported: 'linux-vm'`, `uname`, cgroup path; note the
`classifyCgroup` heuristic mislabels Daytona containers as `vm-init-scope`, so the
vendor-reported class field is authoritative), and (b) network behaviour (the same
five-layer probe). One does not imply the other.
