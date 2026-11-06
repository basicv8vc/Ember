# P0-C4 — E2B Isolation & Security Gap Report

> **Status:** Unverified (no real sandbox was created)  
> **Scope:** `packages/sandbox-e2b`, `apps/cli/src/sandbox-smoke-e2b`  
> **Date:** 2026-11-06

---

## 0. How to read this

Each item is classified as:

- **CONTROLLED** — the adapter enforces it and the enforcement is covered by a test.
- **UNVERIFIED** — implemented, but its real-world effect depends on E2B behaviour that has not
  been observed. A green test here means "the adapter asks for this", not "the vendor does it".
- **GAP** — not adequately addressed. Must be closed before any production use.

Nothing in this report has been validated on real E2B infrastructure. Treat every **UNVERIFIED**
row as **GAP** until the smoke run proves otherwise.

## 1. Required boundaries from the task

| Requirement                                              | Status                                                 | Where it stands                                                                                                                   |
| :------------------------------------------------------- | :----------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox never holds Ember DB credentials                 | **CONTROLLED**                                         | `create()` sends no `envs`; no DSN is ever in scope of the vendor call. Template-baked secrets are out of our control (**G-9**).  |
| Sandbox never holds LLM provider keys                    | **CONTROLLED**                                         | same mechanism; no key is passed or mounted.                                                                                      |
| No real user conversation as test data                   | **CONTROLLED**                                         | the smoke payload is `ember-e2b-smoke:<uuid>`; the provider is not wired to any user path.                                        |
| Explicit limits on paths, command execution, output size | **CONTROLLED** (paths/output) / **PARTIAL** (commands) | path confinement + 64 KiB stream caps + 8 KiB command cap are enforced; argv allowlist is a speed bump, not a boundary (**G-5**). |
| Check E2B default egress permissions                     | **UNVERIFIED**                                         | SDK omits `allowInternetAccess` when unset → server default applies. The adapter always sends `false` explicitly (**G-1**).       |
| Assess metadata / internal-service reachability          | **UNVERIFIED**                                         | `denyOut` covers IMDS + RFC1918, but microVM placement and proxy behaviour are unproven (**G-2**).                                |
| Orphan resource recovery after abnormal exit             | **PARTIAL**                                            | short TTL + metadata-tagged sweeper (**G-3**).                                                                                    |

## 2. Gap register

### G-1 — Server-side egress default when the field is unset

**Severity:** High · **Status:** UNVERIFIED

`Sandbox.create` only sends `allow_internet_access` when the caller sets it. Ember always sets
it (`false` under `deny-all`), so this is safe _for Ember's path_. The risk is upstream: a future
call site that forgets the field inherits whatever the project default is.

_Mitigation:_ `create()` has no code path that omits the field — `allowInternetAccess` is a
required member of `E2bCreateSandboxRequest`.
_Close it:_ one real run confirming `info.allowInternetAccess === false` (the harness records
this as `observedAllowInternetAccess`).

### G-2 — Metadata endpoint reachability from inside the microVM

**Severity:** Critical · **Status:** UNVERIFIED

This is the single most important open question. E2B runs on third-party cloud infrastructure;
if a sandbox can reach `169.254.169.254`, an attacker-controlled workload can attempt instance
credential theft.

_Implemented control:_ `denyOut` includes `169.254.169.254/32`, `169.254.170.2/32`,
`100.100.100.200/32`, plus `0.0.0.0/0` and RFC1918. The harness runs three TCP connect probes
(IMDS, Alibaba metadata, `1.1.1.1:443` as a positive control) and refuses to mark the report
`PASS` unless all are denied.
_Close it:_ the probe must return `connected: false` for all three. Until then, assume reachable.

### G-3 — Partial-allocation orphan

**Severity:** Medium · **Status:** PARTIAL

If `create()` succeeds at the vendor but the client crashes before recording `sandboxId`, the
sandbox is untracked. It dies at its vendor TTL (120 s in this PoC) — that bound is the primary
mitigation.

_Implemented control:_ every sandbox is tagged `ember_owner=e2b-sandbox-poc`,
`ember_tenant_id`, `ember_run_id`; `sweepOrphanedSandboxes()` lists by tag and kills;
`--sweep-orphans` runs before a smoke run.
_Residual:_ the sweeper is manual in this PoC — no scheduled reconciler exists yet.

### G-4 — Lexical-only path confinement (symlink escape)

**Severity:** Medium · **Status:** GAP

`resolveConfinedPath` rejects `..`, absolute paths, empty segments, backslashes and control
characters — but it is lexical. A caller that can execute `python3` can create a symlink inside
`/tmp/ember` pointing at `/etc/passwd` and then call `putTextFile`/`getTextFile` through it.

_Why it is bounded today:_ the sandbox holds no Ember secret, so the worst case is reading its
own throwaway filesystem.
_Close it:_ resolve symlinks server-side (`realpath`) before transfer, or drop the text-file
extension entirely once the ArtifactStore contract lands.

### G-5 — The command allowlist is not a security boundary

**Severity:** Medium · **Status:** GAP (accepted, documented)

`python3` and `sh`-adjacent programs are Turing-complete. An allowlist that permits `python3`
permits arbitrary filesystem and (policy-permitting) network behaviour inside the guest.

_What the allowlist actually buys:_ it stops accidental `curl | bash`, package installs and
container-escape tooling from being the _first_ token, and it keeps argv rendering auditable.
_What it does not buy:_ confinement. Real confinement must come from the guest boundary
(no secrets, no egress, short TTL) — which is exactly why G-1/G-2 matter more than this list.
_Close it:_ do not describe the allowlist as a sandbox control in any product copy or threat model.

### G-6 — No per-sandbox egress metering

**Severity:** Medium · **Status:** GAP

E2B exposes CPU/memory/disk metrics, not egress bytes. `usage().egressBytes` is hard-coded `0`
with `egressSource: 'NOT_MEASURED'`. Consequence: exfiltration cannot be detected by volume, and
egress cost cannot be attributed per run.

_Close it:_ either accept and document, or add a network proxy with byte accounting.

### G-7 — The API key is account-wide

**Severity:** High · **Status:** GAP

One `E2B_API_KEY` can create, list and kill every sandbox in the account, and `Sandbox.list`
enumerates across runs. Ember's per-run metadata filter is a _convention_, not an access control.

_Close it:_ scoped/project-level keys if E2B offers them, or a brokered control plane that holds
the key and issues narrow, short-lived operations. Also: never run the PoC key on a machine that
handles production data.

### G-8 — No client-side hard budget enforcement

**Severity:** Medium · **Status:** PARTIAL

The adapter caps TTL (120 s) and concurrency (2). Those bounds limit spend per run but do not
implement a budget: there is no counter, no kill switch, no alert. The `$10` ceiling is a design
intent enforced only by the vendor console.

_Close it:_ wire `BUDGET_EXCEEDED`-style enforcement into the factory before any automated use,
and set the vendor-side spend alert manually.

### G-9 — Template contents are trusted implicitly

**Severity:** Medium · **Status:** GAP

`SandboxSpec.imageDigest` is matched against a configured `templateDigest` label. E2B templates
are addressed by name/id, not content digest, so this proves _which template was requested_, not
_what is inside it_. A compromised or tampered template would be invisible to the adapter.

_Close it:_ pin template ids, build from a reviewed Dockerfile in CI, and record the build digest
out-of-band.

### G-10 — `stop` is not graceful

**Severity:** Low · **Status:** CONTROLLED (documented)

`SandboxProvider.stop` implies a graceful phase; E2B only offers `kill`. The adapter maps `stop`
to `kill` and does not pretend disk state survives. `capabilities.diskSurvivesStop === false`.

### G-11 — Retained output lives in process memory

**Severity:** Low · **Status:** CONTROLLED

stdout/stderr are held in a bounded map (64 KiB × 32 per sandbox, evicted FIFO) and dropped on
`destroy`. They are never persisted and never leave the worker process. A process crash loses
them — which is correct for a PoC and must be replaced by the ArtifactStore before artifacts
matter.

### G-12 — Timeout semantics depend on two clocks

**Severity:** Low · **Status:** UNVERIFIED

Effective command timeout is `min(requested, remaining TTL)`, sent to vendor **and** bounded
client-side. If the vendor's timeout is advisory, the client bound still applies — but the
reported latency would silently include the difference. The harness measures `overshootMs`
precisely so this cannot hide.

## 3. What a real run must prove before any GO

|  #  | Assertion                                                  | Evidence field                          |
| :-: | :--------------------------------------------------------- | :-------------------------------------- |
|  1  | `observedAllowInternetAccess === false`                    | `isolation.observedAllowInternetAccess` |
|  2  | all three egress probes `connected: false`                 | `isolation.egressProbes`                |
|  3  | `isolation.egressDeniedAsExpected === true`                | report                                  |
|  4  | `cleanup.resourceVerification === 'VERIFIED_ZERO'`         | report                                  |
|  5  | timeout overshoot < 500 ms                                 | `measurements.timeoutProbe.overshootMs` |
|  6  | `allocatedCpuCount * 1000 <= requestedCpuMilli`            | `measurements`                          |
|  7  | destroy latency observed, sandbox gone from `Sandbox.list` | `timing.destroyLatencyMs`               |

A run that fails any of 1–4 must be treated as a **security finding**, not a flaky test.

## 4. Attestation

For this branch, on 2026-11-06:

1. **No E2B API call was made.** No sandbox was created, listed or killed.
2. **No credential was used.** `E2B_API_KEY` is absent from the environment and from `.env.local`.
3. **No paid plan was upgraded** and no payment was authorised or incurred.
4. **No real user data** was read, transmitted or embedded in any fixture.
5. **No production path changed.** `apps/api`, `apps/worker` and `packages/execution` are
   untouched and import nothing from `@ember/sandbox-e2b`.
