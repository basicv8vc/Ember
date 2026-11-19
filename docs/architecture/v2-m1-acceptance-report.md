# Ember V2-M1 — Runtime Integration & Acceptance Report

- **Status:** **D0 PASSED | D1 HARNESS VERIFIED | D4 A+B4 EARLY INTEGRATION COMPLETE | D5 CI RESTORATION PR `#181` OPEN | FULL D2 (`F-1..F-23` / `FI-01..FI-16`) & D3 BLOCKED AWAITING A/B/E/F CONVERGENCE**
- **Date:** 2026-11-19
- **Role:** Performance, Integration & Reliability Engineer (V2-M1-D)
- **Baseline `main` SHA:** `1ba860ce3cb4378ada3cdadf95aef311137c8321` (merged `#175`; prior M0 baseline `6da1b483b6a854199a0f2eef27e53abc770be6cc`)
- **Related:** [A + B4 Early Integration Report (D4)](./v2-m1-ab-early-integration-report.md), [M0 Post-Merge Verification Report](./v2-m0-verification-report.md), [V2-M0-A Contract](./v2-m0-runtime-contract.md), [V2-M0-B Contract](./v2-m0-event-recovery-contract.md), [V2-M0-D Benchmark Report](./v2-m0-benchmark-report.md), [ADR-0006](../adr/0006-experience-first-device-powered-runtime-v2.md)

> [!IMPORTANT]
> **Evidence & Anti-Masquerading Discipline:** On `main @ 1ba860ce3cb4378ada3cdadf95aef311137c8321`, D0 (`#172`) and D1 (`#175`) are merged, while owner runtime modules remain in unmerged PRs: Agent A (`#177` @ `39ad82e`), Agent B1–B4 (`#173/#174/#176/#178` @ `2045c93`), Agent E (`#179` @ `3432745`), and Agent F (`#180` @ `0066cc4`). D4 temporarily combined A + B4 (`temp/v2-m1-ab-early-integration`, not merged to `main`) and verified the A+B4 critical path in local `workerd`; full end-to-end acceptance (`F-1..F-23`, `FI-01..FI-16`) and D3 benchmarks remain honestly **BLOCKED** until A, B, E, and F converge into an executable runtime entrypoint.

---

## 0. D4 / D5 / D6 Incremental Integration & CI Status

| Stream                                                  | Scope & Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Commit / PR Reference                                                                                             | Current Status                             |
| :------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- | :----------------------------------------- |
| **D4 — A + B4 Early Integration**                       | Audited single-schema, single-migration, single-alarm, `budget_sync` relay, and lease authority across A (`#177`) + B1–B4 (`#173/#174/#176/#178`). Executed real `workerd` critical path (uncovered 3-RPC, `TestGlobalBudgetDO` settle via DO `alarm()`, idle D1 retire, covered 0-D1-I/O check, durable handoff → `durable_turn` queue). Found 3 merge conflicts, 1 `TS2308` compile blocker (`GlobalBudgetSettleResult`), 1 B `workerd` module-loader blocker, 2 alarm bugs, 1 queue ACK bug, and A↔B constructor circularity. | A `39ad82e`, B4 `2045c93`; report: [v2-m1-ab-early-integration-report.md](./v2-m1-ab-early-integration-report.md) | **COMPLETE (Findings Reported to Owners)** |
| **D5 — Restore GitHub Actions CI**                      | Fixed `pnpm lint` before `pnpm build` failure (224 ESLint errors on clean runners in Run `44538871733`), formatted 2 historical Neon docs (`neon-postgres-provider-decision*.md`), added `v2-runtime` `ubuntu-latest` CI job (`pnpm build` + V2 unit + real local `workerd` M0/M1 integration tests under Fake Provider & `contents: read`), and explicitly marked full M1 E2E Gate `BLOCKED` in `$GITHUB_STEP_SUMMARY`.                                                                                                         | PR `#181` (`chore/v2-m1-d5-restore-ci` @ `b1e0677`, Run `44543133180` ✓)                                          | **OPEN (Non-Blocking CI PR)**              |
| **D6.1 — A + B Core & Recovery Loop**                   | Uncovered + covered 3-RPC Fast Path, `budget_sync` outbox relay, D1 registration/retire, and `handoffTurnToDurable` → Queue claim/commit verified on temp A+B4 branch using `TestGlobalBudgetDO`; blocked on main by `TS2308` + B1–B4/A fixes & merges.                                                                                                                                                                                                                                                                          | Temp `workerd` pass (`1379ms`); PRs `#173/#174/#176/#177/#178`                                                    | **TEMP VERIFIED / MERGE BLOCKED ON FIXES** |
| **D6.2 — A + B + E Global Budget Authority**            | Replace `TestGlobalBudgetDO` with Agent E's `GlobalBudgetDO` (`#179` @ `3432745e388a756336d262ffce4f257aee005faa`) once A+B merge/unblock.                                                                                                                                                                                                                                                                                                                                                                                       | PR `#179`                                                                                                         | **NEXT AFTER A+B MERGE**                   |
| **D6.3 — A + B + E + F Full HTTP/SSE & Full M1 Matrix** | Wire Edge API / Interactive Executor (`#180` @ `0066cc4338cb7b67f839f1d3e498c7df946da203`) with `EMBER_V2_RUNTIME_CONFIG` and run full `F-1..F-23`, `FI-01..FI-16`, and D3 `1/10/25/50` + `1,000 Agent / 100 concurrency`.                                                                                                                                                                                                                                                                                                       | PR `#180`                                                                                                         | **BLOCKED (Awaiting A+B+E+F Convergence)** |

---

## 1. Evidence Classification & Isolation Guardrails

| Evidence Tag                              | Source & Scope                                                                                                                                                                                                                                                                                                       | Status on `6da1b48`                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **`[Verified: Harness Smoke workerd]`**   | Real local `workerd` (`wrangler@4.158.0` `createTestHarness`) running `AgentHeadDO` (SQLite + Alarm + Eviction), `GlobalBudgetDO` (SQLite), D1 (`v2_recovery_registry`), Queues (`durable_turn`, `agent_task`, `*_dlq`), R2, Scheduled Cron (`* * * * *`), `V2FaultInjector`, and loopback `FakeModelGatewayServer`. | **PASSED** (`tests/integration/v2-m1-harness-smoke.test.ts`, `benchmarks/v2-m1/m1-harness-smoke.json`)                        |
| **`[Blocked: Awaiting A/B M1 Runtime]`**  | End-to-end validation of B1 compatibility, `F-1..F-23`, `FI-01..FI-16`, and full 3-RPC Fast Path / 1,000-Agent measurements against A/B's real runtime (`resolveAbRuntimeTarget()`).                                                                                                                                 | **BLOCKED** (awaiting A/B M1 PRs; `tests/integration/v2-m1-acceptance.test.ts` skips A/B suite cleanly with zero fake passes) |
| **`[Simulated: Regional RTT]`**           | Synthetic regional latency profiles (`near-region`, `apac-intra`, `eu-us-east`, `apac-us-west`, `cross-global`) from `apps/benchmark/src/rtt-simulation.ts`.                                                                                                                                                         | **Ready** for D3 overlay once A/B runtime runs                                                                                |
| **`[Estimated: ADR-0006 Cloud Formula]`** | Re-estimated monthly runtime costs across non-20-row write amplification vectors (`benchmarks/v2-m1/m1-cost-reestimation.json`).                                                                                                                                                                                     | **COMPLETE**                                                                                                                  |
| **`[Pending: Cloud Canary]`**             | Real Cloudflare production DO duration billing, hibernation wakeup latency, Workers CPU invoices, and multi-region WAN RTT.                                                                                                                                                                                          | **Pending** (prohibited in M1)                                                                                                |

### V1 & Cloud Isolation Controls

Implemented in [local-v2-guard.ts](../../apps/benchmark/src/v2-m1/local-v2-guard.ts) and [local-runtime-harness.ts](../../apps/benchmark/src/v2-m1/local-runtime-harness.ts):

- **Fail-Closed Preflight Before Runtime Startup**: Refuses `EMBER_ENV=production|staging`, `NODE_ENV=production`, `EMBER_MODEL_MODE=real`, `EMBER_DAYTONA_ENABLED=true`, and any non-loopback URL before starting `FakeModelGatewayServer`, `V2FaultInjector`, or `workerd` (zero processes started on rejection).
- **Pinned Immutable Worker Vars**: `EMBER_ENV='test'`, `EMBER_MODEL_MODE='fake'`, `EMBER_B1_FAKE_RESPONDER_ENABLED='true'`, `EMBER_V2_ISOLATED_HARNESS='true'`, `EMBER_DAYTONA_ENABLED='false'`, `FAKE_MODEL_GATEWAY_URL`, and `V2_FAULT_CONTROL_URL` are pinned after validation; attempts by `options.vars` to override pinned keys or inject `DAYTONA_*`, V1 DB URLs, or provider credentials fail closed.
- **Strict JSON/JSONC Config & Selected `env` Validation**: Uses `parseStrictJsonc` (supporting line/block comments and trailing commas; failing closed on malformed input or unsupported formats such as TOML), resolves `env.<selectedEnv>` if specified, rejects single `route`, `routes`, `custom_domain`, `domains`, `zone_id`, `account_id`, `hyperdrive`, `remote: true`, `preview_database_id`/`preview_id`/`preview_bucket_name`, external `services`, cross-script `durable_objects[].script_name`, and unsafe vars; also refuses config directories containing `.dev.vars` or `.env` files to prevent accidental secret inheritance.
- **Startup Cleanup & Isolated State**: Assigns `#wranglerHarness` before `listen()` and wraps `FakeModelGatewayServer` + `V2FaultInjector` + Wrangler startup in `try/catch` cleanup (`dispose()`), running inside an ephemeral temp directory on loopback ports (`127.0.0.1:0`).

---

## 2. D1 — Local Integration Harness & Fault Injection Toolkit

Deliverables added under [apps/benchmark/src/v2-m1/](../../apps/benchmark/src/v2-m1/index.ts):

1. **Local `workerd` Topology Launcher** ([local-runtime-harness.ts](../../apps/benchmark/src/v2-m1/local-runtime-harness.ts)):
   - Uses Wrangler `4.158.0` `createTestHarness` to boot `AgentHeadDO` (SQLite + Alarm + `evictDurableObject`), `GlobalBudgetDO` (SQLite), `D1_RECOVERY`, `DURABLE_TURN_QUEUE` (`durable_turn` -> `durable_turn_dlq` after 5 retries), `AGENT_TASK_QUEUE` (`agent_task` -> `agent_task_dlq`), `R2_BLOBS`, and `* * * * *` `scheduled()` cron trigger.
   - **Strict Target & D1 Migration Separation**: `target: { kind: 'harness_smoke' }` uses a smoke-only `HARNESS_SMOKE_D1_RECOVERY_STATEMENTS` fixture solely to verify harness plumbing; `target: { kind: 'ab_runtime', configPath, env? }` selected via `EMBER_V2_RUNTIME_CONFIG` **never** applies D-owned copied DDL—it runs Agent B's real Wrangler `migrations_dir` via `applyD1Migrations` and fails closed if the D1 binding or `v2_recovery_registry` table is missing.
2. **Loopback `FakeModelGatewayServer`** ([fake-model-gateway-server.ts](../../apps/benchmark/src/v2-m1/fake-model-gateway-server.ts)):
   - Zero-egress loopback HTTP/SSE provider aligned with `@ember/model-gateway` (`FakeModelGateway`, preserving `ember-fake-model-gateway-1` labeling) and Agent F/A/B/E integration hooks without inventing a second gateway contract; supports `fast_ok`, `stream_sse`, `slow_handoff` (with `providerJobHandle` issuance + `/v2/fake-model/jobs/:handle` polling), `missing_handle_hang`, `usage_missing`, `late_charge_revision` (`/v2/fake-model/revisions/:operationId`), `error_5xx`, `rate_limited`, and full call/abort auditing.
3. **Deterministic Fault Injection Toolkit** ([fault-injector.ts](../../apps/benchmark/src/v2-m1/fault-injector.ts)):
   - Programmable D1 fault modes (`healthy`, `unavailable`, `uncertain_timeout_committed`, `uncertain_timeout_aborted`), GlobalBudget fault modes (`unavailable`, `timeout`, `grant_expired`, `halt_*`, `conflict_payload`), Queue/DLQ controls (`duplicateCount`, `forceDlq`, 7 `ForgedEnvelopePreset` builders), 8 crash hook points (`after_do_pending_before_d1` through `alarm_exhaust_6_retries`), `DST_TRANSITION_FIXTURES` (`spring_forward_2026_ny`, `fall_back_2026_ny`), virtual clock advancement, and synchronized `runConcurrentRace` barrier.

### Harness Smoke Verification Results `[Verified: Harness Smoke workerd]`

Command:

- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/v2-m1-harness-smoke.test.ts tests/integration/v2-m1-acceptance.test.ts` → **2 files passed** (`v2-m1-harness-smoke.test.ts`: 2/2 passed—infra smoke + `ab_runtime` fail-closed D1 migration gate; `v2-m1-acceptance.test.ts`: 1 passed, 1 skipped awaiting A/B M1 runtime).
- `pnpm bench:local --suite m1-harness-smoke --out-dir benchmarks/v2-m1` → raw JSON saved at [m1-harness-smoke.json](../../benchmarks/v2-m1/m1-harness-smoke.json):

| Harness Smoke Component (`N`, `OK / Err`) | P50 (ms) | P95 (ms) | P99 (ms) | Max (ms) | Verified Capability                                                      |
| ----------------------------------------- | -------: | -------: | -------: | -------: | ------------------------------------------------------------------------ |
| `doPing` (`15`, `15 / 0`)                 |     1.70 |     4.25 |     4.52 |     4.59 | `AgentHeadDO` SQLite + `setAlarm()` + `evictDurableObject()` persistence |
| `globalBudgetCheck` (`15`, `15 / 0`)      |     1.86 |     2.43 |     2.44 |     2.44 | `GlobalBudgetDO` SQLite round-trip                                       |
| `d1Lookup` (`15`, `15 / 0`)               |     1.68 |     2.27 |     2.36 |     2.38 | `D1_RECOVERY` canonical `v2_recovery_registry` schema                    |
| `fakeGatewayComplete` (`15`, `15 / 0`)    |     0.71 |     4.13 |     8.87 |    10.06 | Loopback `FakeModelGatewayServer` non-streaming                          |
| `fakeGatewayStreamSse` (`15`, `15 / 0`)   |    26.09 |    26.87 |    26.88 |    26.88 | Loopback `FakeModelGatewayServer` chunked SSE stream                     |
| `queueEnqueue` (`15`, `15 / 0`)           |     5.56 |    12.32 |    18.44 |    19.96 | `DURABLE_TURN_QUEUE` / `AGENT_TASK_QUEUE` + 5-retry DLQ routing          |
| `scheduledCron` (`5`, `5 / 0`)            |     4.43 |     6.10 |     6.34 |     6.40 | `* * * * *` Scheduled Worker trigger                                     |

---

## 3. D2 — End-to-End Acceptance Matrix (`F-1..F-23` & `FI-01..FI-16`) `[Blocked: Awaiting A/B M1 Runtime]`

All **39** scenarios (`23` from M0-A §10 `F-1..F-23` + `16` from M0-B §9 `FI-01..FI-16`) are catalogued in [acceptance-matrix.ts](../../apps/benchmark/src/v2-m1/acceptance-matrix.ts) and gated in [v2-m1-acceptance.test.ts](../../tests/integration/v2-m1-acceptance.test.ts).

| D2 Acceptance Area                                      | Mapped Scenarios                                                     | Required Faults / Triggers                                                                                                         | Current Status                |
| ------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| B1 API Compatibility & Idempotency                      | `F-1`, `F-2`                                                         | `concurrent_race`, `stage3_toctou`                                                                                                 | **BLOCKED (Awaiting A/B M1)** |
| Chat, Streaming & Client Disconnect                     | `F-7`, `F-8`, `F-10`                                                 | `crash:after_prepare_before_mark_sent`, `crash:after_mark_sent_before_provider_fetch`, `gateway:abort_on_disconnect`               | **BLOCKED (Awaiting A/B M1)** |
| Durable Tasks & Schedules / DST                         | `F-18`, `FI-06`, `FI-16`                                             | `gateway:error_5xx`, `virtual_clock:dst_spring_forward`, `virtual_clock:dst_fall_back`                                             | **BLOCKED (Awaiting A/B M1)** |
| Offline Recovery & Alarm Exhaustion                     | `F-14`, `F-20`, `FI-08`, `FI-09`                                     | `alarm:exhaust_6_retries`, `d1:unavailable`, `concurrent_race`                                                                     | **BLOCKED (Awaiting A/B M1)** |
| D1 Outages & Coverage Registry Races                    | `F-4`, `F-5`, `F-13`, `F-17`, `F-19`, `FI-01..FI-03`, `FI-10..FI-12` | `d1:unavailable`, `d1:uncertain_timeout_*`, `crash:after_do_pending_before_d1`, `crash:after_d1_before_confirm`, `concurrent_race` | **BLOCKED (Awaiting A/B M1)** |
| Queue Duplicates, Forged Envelopes & DLQ                | `F-22`, `FI-04`, `FI-05`, `FI-07`                                    | `queue:duplicate`, `queue:force_dlq`, `queue:forged_envelope`, crash hooks                                                         | **BLOCKED (Awaiting A/B M1)** |
| Cancellation, Tenant Isolation & Transcript Epoch       | `F-3`, `F-9`, `F-16`                                                 | `concurrent_race` (`clearTranscript`, `cancelTurn`), cross-tenant A↔B probes                                                       | **BLOCKED (Awaiting A/B M1)** |
| Budget Concurrency, Expiry, `usage_missing` & Revisions | `F-6`, `F-15`, `F-23`, `FI-15`                                       | `global_budget:unavailable/halt/grant_expired/conflict_payload`, `gateway:usage_missing`, `gateway:late_charge_revision`           | **BLOCKED (Awaiting A/B M1)** |
| Long-Reasoning Fast→Durable Handoff                     | `F-11`, `F-12`, `F-21`, `FI-13`, `FI-14`                             | `gateway:slow_handoff`, `gateway:missing_handle_hang`, `virtual_clock`                                                             | **BLOCKED (Awaiting A/B M1)** |

Once Agent A & B merge their M1 Wrangler runtime, setting `EMBER_V2_RUNTIME_CONFIG=<path/to/wrangler.jsonc>` activates `resolveAbRuntimeTarget()` so [v2-m1-acceptance.test.ts](../../tests/integration/v2-m1-acceptance.test.ts) runs against the real `workerd` runtime. Note:

- The current `ab_runtime` block in `v2-m1-acceptance.test.ts` is strictly a **boot sanity check** (`GET /v1/health` + Agent B D1 migration verification) and **cannot** be interpreted as passing all 39 `F-1..F-23` / `FI-01..FI-16` cases.
- Actual fault assertions and full D3 measurements will be wired and executed after owner modules (A/B/E/F) merge, explicitly verifying **budget revision ordering (`rev=0` initial vs monotonic `rev>=1` deltas & conflict rejection)** and **7 total DO Alarm attempts (`1 initial + 6 automatic retries`)** before Sweeper recovery.

---

## 4. D3 — Performance Targets & ADR-0006 Cost Re-Estimation

### 4.1 Engineering Targets vs Current Measurement Status

| Target                                               | Threshold               | Local `workerd` Status                      | Regional RTT Simulation Status                                  | Cloud Canary Status |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------- | --------------------------------------------------------------- | ------------------- |
| Near-region ACK P95                                  | `<= 250 ms`             | **Blocked** (awaiting A/B 3-RPC Fast Path)  | M0 seam baseline: `37.65 ms` (covered) / `63.65 ms` (uncovered) | **Pending**         |
| Runtime Overhead P95                                 | `<= 200 ms`             | **Blocked** (awaiting A/B 3-RPC Fast Path)  | M0 seam baseline: `70.69 ms` (covered) / `96.69 ms` (uncovered) | **Pending**         |
| Global Budget Check P95 (`reserve + authorize`)      | `<= 50 ms` (in Runtime) | **Blocked** (awaiting A/B `GlobalBudgetDO`) | M0 seam baseline: `26.69 ms` (near-region)                      | **Pending**         |
| Covered Path Sync D1 I/O                             | `0`                     | **Blocked** (awaiting A/B `AgentHeadDO`)    | N/A                                                             | **Pending**         |
| Duplicate Commit / Silent Loss / Unauthorized Budget | `0` / `0` / `0`         | **Blocked** (awaiting A/B M1 runtime)       | N/A                                                             | **Pending**         |

### 4.2 ADR-0006 Cost Re-Estimation Without Fixed `20 rows/event` Constraint `[Estimated: ADR-0006 Cloud Formula]`

Generated via `pnpm bench:local --suite m1-cost-reestimate --out-dir benchmarks/v2-m1` ([m1-cost-reestimation.json](../../benchmarks/v2-m1/m1-cost-reestimation.json)). All figures below are **model estimates only** (not measured cloud bills), and `ADR-0006` `20 rows/event` is treated strictly as an illustrative planning baseline—not a mandatory hard constraint:

| Scenario (`doWrite / d1Write / months / dormant`)          |     MAU | Cloud Runtime / mo |      ADR-0006 Envelope | Notes                                                         |
| ---------------------------------------------------------- | ------: | -----------------: | ---------------------: | ------------------------------------------------------------- |
| `adr0006_planning_20rows_1k` (`20 / 0.2 / 0 / 0x`)         |   1,000 |          **$9.33** | $30 target / $60 cond. | ADR-0006 steady-state reference                               |
| `m0_joint_seam_31rows_recovery_1k` (`31 / 1.0 / 6 / 1x`)   |   1,000 |          **$7.72** | $30 target / $60 cond. | 21.2M DO writes < 50M included allowance (`$0` write overage) |
| `adr0006_planning_20rows_10k` (`20 / 0.2 / 0 / 0x`)        |  10,000 |        **$176.07** |                   $300 | ADR-0006 steady-state reference                               |
| `m0_joint_seam_31rows_recovery_10k` (`31 / 1.0 / 6 / 1x`)  |  10,000 |        **$235.24** |                   $300 | Within growth envelope even at 31 rows/event + recovery       |
| `uncoalesced_45rows_recovery_10k` (`45 / 2.0 / 12 / 2x`)   |  10,000 |        **$365.34** |                   $300 | Exceeds $300 if uncoalesced + 2x dormant storage at month 12  |
| `m0_joint_seam_31rows_recovery_100k` (`31 / 1.0 / 6 / 1x`) | 100,000 |      **$2,883.27** |                 $3,500 | Within scale envelope at 31 rows/event + 6-mo growth          |
| `uncoalesced_45rows_recovery_100k` (`45 / 2.0 / 12 / 2x`)  | 100,000 |      **$4,321.08** |                 $3,500 | Exceeds $3,500 if uncoalesced at 45 rows/event + 2x dormant   |

---

## 5. Remaining Risks & Next Steps

1. **Primary Blocker — A/B M1 Runtime Merge:** D2 (`F-1..F-23`, `FI-01..FI-16`) and D3 (`1/10/25/50` + `1,000 Agent / 100 concurrency` full 3-RPC Fast Path measurements) cannot pass until Agent A and Agent B merge their M1 implementations.
2. **Multi-Region GlobalBudgetDO RTT Risk:** As established in M0-D (`v2-m0-benchmark-report.md` §5), sequential cross-region hops (`reserve + prepare + authorize + markAttemptSent + commit + settle`) exceed `200 ms` Runtime Overhead once intra-region RTT reaches `>= 38 ms` (`apac-intra` and beyond). Once A/B M1 lands, D3 will measure exact call counts and pinpoint whether colocated batching or bounded grants are needed without weakening GlobalBudget safety gates.
3. **DO SQLite Write & Dormant Storage Amplification:** At `10,000–100,000 MAU`, uncoalesced `>= 45 rows/event` combined with `12-month` + `2.0x` dormant retention pushes Cloud Runtime costs above ADR-0006 envelopes (`$365.34` at 10k, `$4,321.08` at 100k). Actual `rowsWritten` from A/B's `AgentHeadDO` + `GlobalBudgetDO` must be captured in D3 immediately after A/B merge.
4. **Cloud Canary Gap:** Local `workerd` cannot measure real Cloudflare DO hibernation wakeup latency, production isolate CPU billing, or D1 multi-AZ replication lag; those remain gated on future approved Canary testing.
