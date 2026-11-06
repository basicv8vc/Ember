# P0-C4: Daytona → Execution Chain Integration Plan (minimal)

**Status:** plan only — no production execution path is modified by this document.
**Date:** 2026-11-06
**Prerequisite:** PR #125 merged (adapter `@ember/sandbox-daytona` + contract conformance).
**Scope discipline:** minimal end-to-end enablement behind a default-disabled feature flag. No new sandbox features, no UI, no billing.

---

## 1. Goal

One real path, off by default:

```
POST /v1/tasks (mock.compute)
  → PostgresLeaseQueue.claim
  → DeterministicExecutor.runInSandbox
  → DaytonaSandboxProvider (create → waitReady → exec → readOutput → destroy)
  → PostgresRunResultCommitter (artifact + run terminal state)
```

Everything else in the B1/B2 chain stays untouched.

## 2. Security responsibility boundary

| Owner       | Responsibility                                                                              |
| :---------- | :------------------------------------------------------------------------------------------ |
| **Daytona** | Underlying compute environment, infrastructure isolation (per CTO decision, 2026-11-06)     |
| **Ember**   | User authorization, credential management, execution time & resource limits, task recycling |

Ember-side guarantees the integration must preserve:

1. **Credential hygiene** — `DAYTONA_API_KEY` only from environment / secret store; never logged, never in reports (smoke harness already proves this invariant).
2. **Limits** — `SandboxSpec.cpuMilli / memoryMiB / maxLifetimeSec` honored via `SandboxAdapter` bounded timeouts + Daytona profile caps (`packages/sandbox-daytona/src/limits.ts`).
3. **Recycling** — `SandboxAdapter.run()` finally stop+destroy is the primary reaper; `sweepOrphanedSandboxes` reconciler is the crash backstop (verified: `orphanSwept: 1, failures: 0` across 8 runs). Wire the reconciler into the worker startup/shutdown path.
4. **Fail-closed defaults** — flag off in every environment including production until explicitly enabled by reviewed change (same posture as `EMBER_MODEL_EXECUTION`).

## 3. Feature flag (follow the B2 `EMBER_MODEL_EXECUTION` precedent)

`apps/worker/src/config.ts` — add, mirroring `resolveModelExecution()` fail-closed style:

```
EMBER_SANDBOX_PROVIDER = 'fake' | 'daytona'   (default: 'fake')
EMBER_DAYTONA_API_KEY                          (required iff provider=daytona)
EMBER_DAYTONA_SNAPSHOT      default 'daytona-small'
EMBER_DAYTONA_SANDBOX_CLASS default 'container'
```

Rules (throw `WorkerConfigError`, never silent-fallback):

- `daytona` + missing key → refuse to start.
- `daytona` in `production` environment → refuse to start until the flag is explicitly reviewed as a code change (keep this guard until G-1/G-2 disposition is accepted; per CTO the adapter is trusted, but production enablement is a separate deliberate step).
- `fake` / unset → current behavior byte-for-byte.

## 4. Wiring — 4 touch points, blast radius stops at the composition root

| #   | File                                                | Change                                                                                                                                                                                                                                                                  |
| :-- | :-------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/sandbox-daytona/src/factory.ts` (**new**) | `DaytonaSandboxProviderFactory implements SandboxProviderFactory` — `createProvider({tenantId, runId, signal})` assembles `DaytonaSandboxProvider` (reuse the option assembly from `DaytonaSmokeRunner.buildProvider`, `apps/cli/src/sandbox-smoke-daytona/runner.ts`). |
| 2   | `packages/sandbox-daytona/src/index.ts`             | Export the factory.                                                                                                                                                                                                                                                     |
| 3   | `apps/worker/src/config.ts`                         | Flag + resolver as in §3.                                                                                                                                                                                                                                               |
| 4   | `apps/worker/src/index.ts` (~L232)                  | `new DeterministicExecutor()` → `new DeterministicExecutor({ sandboxFactory: resolveSandboxFactory(config) })`; log the active `sandboxProvider` at startup.                                                                                                            |

**Zero changes** to `packages/contracts` (`DaytonaSandboxProvider` already `implements SandboxProvider`), `packages/execution` (`SandboxAdapter` trust boundary applies as-is: error sanitization, bounded timeouts, forced stop/destroy), `run-handler.ts`, `durable-run-handler.ts`, `poll-loop.ts`, `packages/postgres`.

### One semantic seam to close

`DeterministicExecutor` builds `SandboxSpec.imageDigest` from the hardcoded `FAKE_SANDBOX_IMAGE_DIGEST`; `DaytonaSandboxProvider.create` validates `spec.imageDigest === snapshotName`. The factory (or a thin map in the executor options) must translate the configured `EMBER_DAYTONA_SNAPSHOT` into the digest slot so the contract check passes. Keep the check — it is the pin that prevents silent snapshot drift.

## 5. Minimal end-to-end scenario (acceptance)

1. Start worker with `EMBER_SANDBOX_PROVIDER=daytona` + key in env (test/staging only).
2. `POST /v1/tasks` with kind `mock.compute` (the existing `sha256 <text>` scenario routes into `runInSandbox`).
3. Assert: run reaches `succeeded`; artifact contains the correct hash; a `DaytonaSandboxProvider` lifecycle log line exists for create/exec/destroy.
4. Assert: Daytona account shows **0 sandboxes** after completion (recycling works through the real chain).
5. Kill the worker mid-run; restart; assert the reconciler sweeps the orphan and the run converges to a terminal state (`lease_expired` / `retryable_failed`).
6. Re-run with `EMBER_SANDBOX_PROVIDER=unset` and assert the full existing suite still passes unchanged (default-off invariant).

## 6. Explicitly out of scope (this phase)

- Browser/filesystem-snapshot capabilities (`SandboxCapabilities` beyond `shell` + `networkPolicy`).
- `putFile`/`getFile` artifact-ref transport (today fail-closed; the chain only needs `exec` + `readOutput`).
- Multi-region, pooling, warm starts, cost dashboards.
- iOS surface for code execution results.
- Any change to B1 conversation persistence or B2 model execution paths.

## 7. Rollout

1. Land PR #125 (adapter only).
2. Land the 4-touch-point wiring PR with flag default `fake` — production-safe by construction.
3. Enable `daytona` in staging; run the §5 scenario; attach evidence to the PR.
4. Production enablement is a separate CTO decision, one env change + restart, reversible by flipping the flag back.
