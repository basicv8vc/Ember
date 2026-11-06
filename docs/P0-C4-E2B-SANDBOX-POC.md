# P0-C4 — E2B Sandbox Provider PoC

> **Status:** Adapter + harness complete; **real vendor measurement BLOCKED (no E2B credential)**  
> **Branch:** `feature/e2b-sandbox-poc`  
> **Base:** `main@c6c9c3d650f977f3783fa73b941f677639a449ff`  
> **Date:** 2026-11-06  
> **Verdict:** **NO-GO** for adopting E2B as the V1 sandbox runtime today — see §9

---

## 1. What this PoC answers

Whether E2B is a viable on-demand Agent Sandbox Runtime for Ember V1, measured against the
existing provider-neutral `SandboxProvider` contract, with a hard cost and isolation ceiling.

It does **not** touch the B1/B2 execution path: nothing in `apps/api`, `apps/worker` or
`packages/execution` imports the adapter (verified by grep, §8).

## 2. Honest status up front

| Question                                               | Answer                                              |
| :----------------------------------------------------- | :-------------------------------------------------- |
| Adapter implemented against the contract?              | **Yes** — `packages/sandbox-e2b`                    |
| Smoke CLI implemented for the required 9-step flow?    | **Yes** — `pnpm sandbox:smoke:e2b`                  |
| Contract tests executed?                               | **Yes** — 49 new tests, all passing                 |
| A real E2B sandbox ever created?                       | **No.** No `E2B_API_KEY` exists in this environment |
| Any latency / cost / isolation figure measured on E2B? | **No.** Every number in §5 is `NOT_MEASURED`        |
| Is any part of this marked production-ready?           | **No**                                              |

The blocked run is recorded verbatim in `docs/evidence/p0c4-e2b-blocked-run.{txt,json}`
(exit code **3**, `status: "BLOCKED"`). A blocked run is deliberately _not_ `PASS` and _not_
`FAIL`: the harness cannot distinguish "vendor is fine" from "vendor is broken" without a call,
and reporting either would be fabrication.

Reproduce the block:

```bash
pnpm sandbox:smoke:e2b --format summary   # exit 3, status BLOCKED
```

## 3. Deliverables in this branch

| Path                                     | Purpose                                                           |
| :--------------------------------------- | :---------------------------------------------------------------- |
| `packages/sandbox-e2b/src/port.ts`       | Narrow port over E2B; the only surface Ember may touch            |
| `packages/sandbox-e2b/src/sdk-client.ts` | Official `e2b` SDK (pinned `2.63.0`) bound to that port           |
| `packages/sandbox-e2b/src/provider.ts`   | `E2BSandboxProvider implements SandboxProvider`                   |
| `packages/sandbox-e2b/src/command.ts`    | argv → POSIX-quoted shell command, program allowlist              |
| `packages/sandbox-e2b/src/paths.ts`      | Confined path resolution + UTF-8-bounded truncation               |
| `packages/sandbox-e2b/src/limits.ts`     | TTL / concurrency / argv / output / file ceilings, egress presets |
| `apps/cli/src/sandbox-smoke-e2b/`        | Real-remote smoke harness: runner, schema, CLI, sanitizer         |
| `tests/unit/e2b-sandbox-adapter.test.ts` | 36 contract tests (Mock SDK, no network)                          |
| `tests/unit/e2b-smoke-harness.test.ts`   | 13 harness/CLI/report-invariant tests                             |
| `docs/P0-C4-E2B-SECURITY-GAP-REPORT.md`  | Isolation gap analysis                                            |
| `docs/evidence/p0c4-e2b-blocked-run.*`   | Machine + human record of the blocked attempt                     |

## 4. Contract mapping

The `SandboxProvider` contract is preserved exactly — no signature changes, no new required
methods. Vendor-specific capability is exposed through **additive** methods on the concrete
class only.

| Contract method           | E2B mapping                                    | Notes                                                                      |
| :------------------------ | :--------------------------------------------- | :------------------------------------------------------------------------- |
| `capabilities()`          | static declaration                             | `shell: true`, `networkPolicy: true`, all snapshot/resume/volume `false`   |
| `create(spec)`            | `Sandbox.create(template, opts)`               | returns **before** ready; lifetime clamped to 120 s                        |
| `waitReady(id, deadline)` | poll `Sandbox.getInfo` → `state === 'running'` | then verifies allocated CPU/memory **and** that egress was actually denied |
| `exec(id, argv, timeout)` | `sandbox.commands.run(<quoted argv>)`          | argv is single-quoted per token; program allowlist enforced pre-call       |
| `readOutput(id, ref)`     | in-memory bounded buffer                       | refs are Ember UUIDs, capped at 64 KiB/stream, 32 entries/sandbox          |
| `putFile` / `getFile`     | **fail closed** (`POLICY_DENIED`)              | asset transfer needs the ArtifactStore CAS contract; not faked             |
| `snapshot` / `resume`     | **fail closed**                                | not implemented for this adapter                                           |
| `stop(id)`                | `Sandbox.kill(id)`                             | E2B has no suspend; idempotent                                             |
| `destroy(id)`             | `kill` if unconfirmed + purge local state      | idempotent                                                                 |
| `usage(id)`               | `Sandbox.getMetrics` integration               | reports its basis; `egressBytes` always 0 (not exposed)                    |

Additive PoC-only surface (not part of the contract, documented as such in code):

- `putTextFile` / `getTextFile` — confined to `/tmp/ember`, ≤256 KiB
- `verifyNoLiveSandboxes(metadata)` — control-plane audit used for `VERIFIED_ZERO`
- `sweepOrphanedSandboxes()` — kills anything tagged `ember_owner=e2b-sandbox-poc`
- `usageBasis()`, `execStats()`, `measuredResources()`, `sandboxState()`, `liveSandboxCount()`

### Why a port instead of calling the SDK directly

Three reasons, all load-bearing:

1. Every adapter branch (including vendor faults) is testable with zero network and zero spend.
2. `e2b` stays confined to one package; the SDK cannot leak into `@ember/execution`.
3. Timing captured in the concrete client is the vendor round-trip, not adapter overhead.

## 5. Measurement table

> Every cell below is `NOT_MEASURED`. No value is estimated, simulated or borrowed from
> E2B's marketing material. The Mock SDK produces numbers too — they are meaningless as
> vendor data and are therefore never surfaced in this table.

|  #  | Measurement                                          | Result             | Why                                                |
| :-: | :--------------------------------------------------- | :----------------- | :------------------------------------------------- |
|  1  | Create latency                                       | `NOT_MEASURED`     | no credential                                      |
|  2  | Ready latency (`state === running` verified)         | `NOT_MEASURED`     | no credential                                      |
|  3  | First command latency (`python -c print`)            | `NOT_MEASURED`     | no credential                                      |
|  4  | Warm command latency                                 | `NOT_MEASURED`     | no credential                                      |
|  5  | Stop latency                                         | `NOT_MEASURED`     | no credential                                      |
|  6  | Destroy latency                                      | `NOT_MEASURED`     | no credential                                      |
|  7  | Cleanup-verify latency                               | `NOT_MEASURED`     | no credential                                      |
|  8  | Timeout behaviour (observed vs requested, overshoot) | `NOT_MEASURED`     | no credential                                      |
|  9  | Allocated CPU / memory (vendor-reported)             | `NOT_MEASURED`     | no credential                                      |
| 10  | CPU-seconds / memory-GiB-seconds                     | `NOT_MEASURED`     | no credential                                      |
| 11  | Egress bytes per sandbox                             | `NOT_AVAILABLE`    | not exposed by the adapter API surface             |
| 12  | Estimated cost per minute                            | `NOT_MEASURED`     | needs an account-specific price                    |
| 13  | Actual usage / remaining credit                      | `REQUIRES_CONSOLE` | no billing endpoint used; confirm in E2B dashboard |
| 14  | Leak after destroy                                   | `NOT_MEASURED`     | no credential                                      |
| 15  | Metadata-endpoint reachability                       | `NOT_MEASURED`     | no credential                                      |

The harness is wired to fill all fifteen rows in one run. `firstCommandLatencyMs` is the
create-to-usable number that matters for UX; `overshootMs` is the only honest way to describe
timeout quality (a vendor that honours 2 000 ms as 2 150 ms is different from one that
returns at 30 s).

## 6. Required minimum smoke — implemented, not executed

`apps/cli/src/sandbox-smoke-e2b/runner.ts` performs exactly the required flow, in this order:

| Required step                         | Implementation                          | Assertion                                                      |
| :------------------------------------ | :-------------------------------------- | :------------------------------------------------------------- |
| 1. Create sandbox                     | `provider.create`                       | id returned, TTL ≤ 120 s                                       |
| 2. Wait ready                         | `provider.waitReady`                    | vendor state `running` **and** resource/egress policy verified |
| 3. `python -c "print('hello ember')"` | `execHello`                             | stdout trimmed `=== 'hello ember'`                             |
| 4. Capture stdout/stderr/exit         | `readOutput` on both refs               | stderr empty, exit `0`                                         |
| 5. Write + read temp file             | `putTextFile` → `getTextFile` → `cat`   | adapter round-trip **and** in-guest visibility                 |
| 6. Bounded timeout test               | `time.sleep(30)` with 2 000 ms budget   | must raise `EXECUTION_TIMEOUT`, sandbox survives               |
| 7. Cancel / stop / destroy            | `stop` then `destroy` in `finally`      | both `COMPLETED`                                               |
| 8. Verify cleanup                     | `verifyNoLiveSandboxes({ember_run_id})` | zero live ids → `VERIFIED_ZERO`                                |
| 9. Record usage + elapsed             | `usage()` + per-phase timers            | basis stated, all latencies recorded                           |

Plus one step the task implies but does not enumerate: **`egressProbe`** (§7).

Ordering rationale: the timeout probe runs after the success probes so a hung command cannot
consume the budget before the primary assertions are recorded; the egress probe runs last so a
network fault cannot mask a lifecycle failure.

## 7. Isolation design (summary)

Full analysis in `docs/P0-C4-E2B-SECURITY-GAP-REPORT.md`. The controls this adapter enforces:

- **No secrets in the sandbox.** `create()` passes no `envs`. No DB DSN, no LLM key, no
  ArtifactStore credential is ever mounted.
- **Egress denied by default.** `allowInternetAccess: false` is always sent explicitly (the SDK
  omits the field when unset, which would leave the server default in force), plus `denyOut`
  covering `0.0.0.0/0`, `169.254.169.254/32`, `169.254.170.2/32`, `100.100.100.200/32` and
  RFC1918. Only the `deny-all` preset is reachable from the CLI.
- **Post-allocation verification.** `waitReady` fails closed if the vendor reports internet
  access enabled while the policy said denied, or allocates more CPU/memory than the spec.
- **argv is never interpolated.** Every token is single-quoted before it becomes a shell string;
  a program allowlist gates the first token.
- **Bounded everything.** 120 s TTL, 2 concurrent sandboxes, 16 argv tokens, 8 KiB command,
  64 KiB retained per stream, 256 KiB per file, 32 retained outputs.
- **Independent cleanup audit.** `VERIFIED_ZERO` comes from the vendor control plane, not from
  local bookkeeping, and a `PASS` report is rejected by `validateE2bSmokeReport` without it.

## 8. Verification log

All commands run in the worktree on Node `v24.22.2`, pnpm `12.15.0`.

| Command                                     | Exit  | Observed                                           |
| :------------------------------------------ | :---: | :------------------------------------------------- |
| `pnpm install --frozen-lockfile`            |   0   | 13 workspace projects resolved                     |
| `tsc -p tsconfig.json` (typecheck)          |   0   | clean                                              |
| `tsc -b tsconfig.build.json` (build)        |   0   | clean, incl. new `packages/sandbox-e2b` reference  |
| `prettier --check` (new/changed files)      |   0   | clean                                              |
| `eslint` (new/changed files)                |   0   | 0 errors, 0 warnings                               |
| `vitest run --config vitest.unit.config.ts` |   2   | **1304 tests / 78 files**; 1302 pass               |
| ↳ `e2b-sandbox-adapter.test.ts`             |   0   | 36/36 pass                                         |
| ↳ `e2b-smoke-harness.test.ts`               |   0   | 13/13 pass                                         |
| `pnpm sandbox:smoke:e2b`                    | **3** | `status: BLOCKED`, reason `E2B_API_KEY is not set` |
| `pnpm sandbox:smoke:local`                  |   0   | existing local Fake harness unaffected             |

Two failures, both **pre-existing on `main@c6c9c3d`** and unrelated to this branch:

- `tests/unit/local-blob-store.test.ts` — "is idempotent for concurrent installations", fails
  identically in the pristine `main` worktree.
- `tests/unit/test-registration-guard.test.ts` — 2 s default timeout; passes in isolation,
  times out only under 78-worker parallel load.

No production path was modified: `grep -rn "e2b" apps/api/src apps/worker/src
packages/execution/src` returns nothing.

## 9. GO / NO-GO recommendation

### NO-GO — do not adopt E2B as the V1 sandbox runtime on this evidence

The recommendation is a statement about **evidence**, not about E2B's quality. Three blocking
reasons:

1. **Zero measured data.** Not one latency, timeout, cleanup or isolation figure has been
   observed on real hardware. A runtime decision made on zero measurements is a guess.
2. **Unverified isolation.** Whether `denyOut` actually blocks `169.254.169.254` from inside an
   E2B microVM is the single most important security question here, and it is unanswered until
   the probe runs. Symlink escape on confined paths, absent per-sandbox egress metering, and
   account-wide API keys remain open (Gap Report G-2, G-4, G-6, G-7).
3. **Unverified cost.** Free-tier limits, per-second billing and quota behaviour are
   console-only facts. The $10 ceiling is a client-side design intent, not an enforced control.

### GO — for one time-boxed measurement run, then re-decide

This branch is ready to execute that run the moment a key exists. Concretely:

```bash
export E2B_API_KEY=...                    # Hobby/free tier only
pnpm sandbox:smoke:e2b --out docs/evidence/p0c4-e2b-run-01.json
```

Expected consumption: one sandbox, ~30 s of wall clock, hard-capped at 120 s by both the adapter
and the vendor, ≤2 concurrent. Actual spend and remaining credit must be read from the E2B
dashboard afterwards and pasted into the report — the harness will not invent them.

### What flips the verdict

| Gate                                               | Threshold              |
| :------------------------------------------------- | :--------------------- |
| Real run completes with all 12 steps `PASS`        | required               |
| `egressDeniedAsExpected === true` for all 3 probes | required               |
| `cleanup.leakStatus === 'VERIFIED_ZERO'`           | required               |
| p95 first-command latency over 5 runs              | < 3 000 ms             |
| Timeout overshoot                                  | < 500 ms               |
| Measured spend for 5 runs                          | within free credit     |
| Symlink escape on `putTextFile`                    | reproducible or closed |

If all gates hold, the recommendation moves to **GO with conditions** (scoped API key, vendor
quota cap, per-run budget enforcement in Ember). Until then, `FakeSandboxProvider` remains the
only provider wired into execution and no real-user code ever reaches E2B.

## 10. Explicit non-claims

- The adapter is **not** production-ready and is not marked as such anywhere in code.
- No B1/B2 path was changed; `DeterministicExecutor` and `SandboxAdapter` are untouched.
- No real user conversation, production credential or host directory was used.
- No paid plan was upgraded and no payment was authorised or incurred.
- Numbers produced by the Mock SDK tests are test fixtures, not vendor measurements.

## 11. Rollback

Delete the branch, or revert this merge commit. The change adds one workspace package, one CLI
directory, two test files and a pinned `e2b@2.63.0` dependency; it adds no migration, alters no
shared runtime state, and is imported by nothing outside its own tests and CLI.
