# Ember V2-M1 — Runtime Integration & Acceptance Report

- **Status:** **M1-D10 FINAL CONSOLIDATION COMPLETE — FUNCTIONAL, SAFETY & MULTI-TURN SSE ACCEPTANCE: `23/23` FULL `workerd` SUITE PASS (`0` FILTERED, `0` SAFETY VIOLATIONS ON `main @ b669b0e` + `#190 -> #191 -> #193`, DEFECTS #1–#7 RESOLVED); HISTORICAL D8 BENCHMARK `10k/100k` MAU COST OVERAGE RETAINED (COST OPTIMIZATION PURSUED INDEPENDENTLY BY AGENT A / `M1-A6`)**
- **Date:** 2026-11-20 (historical D0/D1/D4/D5/D6/D7/D8/D9 sections below preserved verbatim)
- **Role:** Performance, Integration & Reliability Engineer (V2-M1-D)
- **Latest Consolidated Baseline:** `origin/main @ b669b0e` (`#189` M2-F1 + `#194` M1-A5 merged) + separated PR stack `#190 -> #191 -> #193` (prior D9 `main @ 7dc9719` + `#190/#191`, D8 benchmark `main @ d3c559c` + `#185`, D7 `main @ 1131415` + `#188`, D6 `main @ a537e4f`, D0/D1 `1ba860c`, M0 `6da1b48`)
- **Related:** [A + B4 Early Integration Report (D4)](./v2-m1-ab-early-integration-report.md), [M0 Post-Merge Verification Report](./v2-m0-verification-report.md), [M1-A5 DO SQLite Write Amplification Analysis](./v2-m1-a5-do-sqlite-write-amplification-analysis.md), [V2-M0-A Contract](./v2-m0-runtime-contract.md), [V2-M0-B Contract](./v2-m0-event-recovery-contract.md), [V2-M0-D Benchmark Report](./v2-m0-benchmark-report.md), [ADR-0006](../adr/0006-experience-first-device-powered-runtime-v2.md)

> [!IMPORTANT]
> **M1-D10 Consolidated Verdict (`main @ b669b0e` + `#190 -> #191 -> #193`):**
>
> - **Latest D10 Functional & Safety Acceptance (Verified on Consolidated HEAD):** Executing the **complete un-filtered `23/23` `workerd` acceptance suite** ([v2-m1-full-runtime-acceptance.test.ts](../../tests/integration/v2-m1-full-runtime-acceptance.test.ts)) passes `23/23` (`0` safety violations, Defects `#1–#7` resolved), including Turn 22 post-Handoff verification (`44` messages in sequence `1..44`, `22` completed turns, `0` duplicate results/provider calls, and converged budget reservations across AgentHead & GlobalBudgetDO).
> - **Historical D8 Performance & Cost Benchmark Data (Not Re-Run in D9/D10):** Latency, D1 I/O, and cost estimates in **§14** ([m1-full-runtime.json](../../benchmarks/v2-m1/m1-full-runtime.json), [m1-cost-reestimation.json](../../benchmarks/v2-m1/m1-cost-reestimation.json)) are **historical D8 measurements** collected on `main @ d3c559c` + `#185`. The **`10k/100k` MAU Cloud Runtime cost overage conclusion remains open** (`57–61` DO `rowsWritten/event` measured in D8 -> `$412.53–$440.92` vs `$300` @ `10k`; `$4,602.85–$5,303.26` vs `$3,500` @ `100k`), and cost optimization is **independently pursued by Agent A (`M1-A6`)**. See **§16** for full D10 consolidation details.

---

## 0. D4 / D5 / D6 Incremental Integration & CI Status

| Stream                                                  | Scope & Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Commit / PR Reference                                                                                             | Current Status                             |
| :------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- | :----------------------------------------- |
| **D4 — A + B4 Early Integration**                       | Audited single-schema, single-migration, single-alarm, `budget_sync` relay, and lease authority across A (`#177`) + B1–B4 (`#173/#174/#176/#178`). Executed real `workerd` critical path (uncovered 3-RPC, `TestGlobalBudgetDO` settle via DO `alarm()`, idle D1 retire, covered 0-D1-I/O check, durable handoff → `durable_turn` queue). Found 3 merge conflicts, 1 `TS2308` compile blocker (`GlobalBudgetSettleResult`), 1 B `workerd` module-loader blocker, 2 alarm bugs, 1 queue ACK bug, and A↔B constructor circularity. | A `39ad82e`, B4 `2045c93`; report: [v2-m1-ab-early-integration-report.md](./v2-m1-ab-early-integration-report.md) | **COMPLETE (Findings Reported to Owners)** |
| **D5 — Restore GitHub Actions CI**                      | Fixed `pnpm lint` before `pnpm build` failure (224 ESLint errors on clean runners in Run `44538871733`), formatted 2 historical Neon docs (`neon-postgres-provider-decision*.md`), added `v2-runtime` `ubuntu-latest` CI job (`pnpm build` + V2 unit + real local `workerd` M0/M1 integration tests under Fake Provider & `contents: read`), and explicitly marked full M1 E2E Gate `BLOCKED` in `$GITHUB_STEP_SUMMARY`.                                                                                                         | PR `#181` (`chore/v2-m1-d5-restore-ci` @ `b1e0677`, Run `44543133180` ✓)                                          | **OPEN (Non-Blocking CI PR)**              |
| **D6.1 — A + B Core & Recovery Loop**                   | Uncovered + covered 3-RPC Fast Path, `budget_sync` outbox relay, D1 registration/retire, and `handoffTurnToDurable` → Queue claim/commit verified on temp A+B4 branch using `TestGlobalBudgetDO`; blocked on main by `TS2308` + B1–B4/A fixes & merges.                                                                                                                                                                                                                                                                          | Temp `workerd` pass (`1379ms`); PRs `#173/#174/#176/#177/#178`                                                    | **TEMP VERIFIED / MERGE BLOCKED ON FIXES** |
| **D6.2 — A + B + E Global Budget Authority**            | Replace `TestGlobalBudgetDO` with Agent E's `GlobalBudgetDO` (`#179` @ `3432745e388a756336d262ffce4f257aee005faa`) once A+B merge/unblock.                                                                                                                                                                                                                                                                                                                                                                                       | PR `#179`                                                                                                         | **NEXT AFTER A+B MERGE**                   |
| **D6.3 — A + B + E + F Full HTTP/SSE & Full M1 Matrix** | Wired `main @ a537e4f` A+B+E+F modules into real local `workerd` ([runtime-worker.ts](../../tests/integration/support/v2-m1-full-runtime/runtime-worker.ts)) and executed full `F-1..F-23`, `FI-01..FI-16`, and D3 `1/10/25/50` + `1,000 Agent / 100 concurrency` benchmarks.                                                                                                                                                                                                                                                    | `main @ a537e4f`; branch `test/v2-m1-full-runtime-acceptance`                                                     | **EXECUTED — NO-GO (5 Product Defects)**   |

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

---

## 6. D6 — Post-Merge Baseline Verification (`main @ a537e4f8f3f43d69915cb51a2cf301bdd18b49f7`)

Executed on branch `test/v2-m1-full-runtime-acceptance` branched cleanly from `main @ a537e4f8f3f43d69915cb51a2cf301bdd18b49f7` (with local PostgreSQL 16 `ember_test` on `127.0.0.1:5432` and host proxy variables cleared for loopback communication):

| Verification Gate               | Command / Scope                                                                      | Observed Result                                                                                                                    | Status   |
| :------------------------------ | :----------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- | :------- |
| Build, Typecheck, Lint & Format | `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check`                     | Exit `0` across all workspaces (`tsc -b`, `tsc --noEmit`, `eslint .`, `prettier --check .`)                                        | **PASS** |
| Unit Tests                      | `pnpm run test:unit`                                                                 | `118 passed (118)` files, `1796 passed (1796)` tests (`14.73s` post-edit)                                                          | **PASS** |
| Chaos Tests                     | `pnpm run test:chaos` (`TEST_DATABASE_URL` set)                                      | `6 passed (6)` files, `30 passed (30)` tests                                                                                       | **PASS** |
| Baseline Integration Tests      | `tests/integration` (56 files excluding new `v2-m1-full-runtime-acceptance.test.ts`) | `56 passed (56)` files, `604 passed \| 1 skipped (605)` (pre-existing `v2-m1-acceptance.test.ts` awaits `EMBER_V2_RUNTIME_CONFIG`) | **PASS** |
| E2E Tests                       | `pnpm run test:e2e` (`TEST_DATABASE_URL` set)                                        | `15 passed (15)` files, `56 passed (56)` tests                                                                                     | **PASS** |

---

## 7. D6 — Real Local `workerd` Full Acceptance Matrix (`F-1..F-23` & `FI-01..FI-16`)

Executed via [v2-m1-full-runtime-acceptance.test.ts](../../tests/integration/v2-m1-full-runtime-acceptance.test.ts) against real Cloudflare `workerd` (`wrangler@4.158.0`) assembling `AgentHeadDO`, `GlobalBudgetDO`, `AuthSessionDO`, `D1_RECOVERY`, `DURABLE_TURN_QUEUE`, `AGENT_TASK_QUEUE` (+ DLQs), Cron `* * * * *`, and loopback `FakeModelGatewayServer` (`[Verified: Full Runtime workerd]`).

- **Vitest Summary (`v2-m1-full-runtime-acceptance.test.ts`):** `11 passed | 9 failed (20)` (`45.90s`)
- **39-Item Matrix Tally:** **28 PASS**, **10 FAIL**, **1 N/A (Alternative Verified)**
- **Safety Counters (`afterAll` & benchmark runs):**
  - Duplicate Provider Calls: `0`
  - Duplicate Assistant Messages: `0`
  - Duplicate Commits: `0`
  - Lost Accepted Work (passing suite + concurrency sweep `1..50` + 1,000 agents / 100 concurrent): `0` _(Note: `F-5` / `FI-12` Covered D1-outage test stalled past 15s and risked silent turn loss in `claimDurableWork` due to Defect #3)_
  - Budget Overcommit: `0`

### 7.1 Functional Scenarios (`F-1..F-23`)

| ID     | Scenario                                                                                                     | Status                         | Evidence / Root Cause                                                                                                                                              |
| :----- | :----------------------------------------------------------------------------------------------------------- | :----------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `F-1`  | Concurrent identical submission idempotency (`1x 201 + Nx 200` replay)                                       | **FAIL**                       | Received `1x 201` + `4x 503` (0 replays) due to **Defect #1**                                                                                                      |
| `F-2`  | Same `client_submission_id` with differing payload/attachments (`409 IDEMPOTENCY_CONFLICT`)                  | **FAIL**                       | Received `503 DB_UNAVAILABLE` instead of `409 IDEMPOTENCY_CONFLICT` due to **Defect #2**                                                                           |
| `F-3`  | `clearTranscript` interleaved with Stage 2 `prepareTurn` aborts Stage 3 (`409`) & releases hold              | **FAIL**                       | Received `503` instead of `409` across DO RPC due to **Defect #2**                                                                                                 |
| `F-4`  | Uncovered path fails closed `503` during D1 outage; Direct reads succeed                                     | **PASS**                       | Verified HTTP `503` write fail-closed + `200` Direct reads                                                                                                         |
| `F-5`  | Covered path executes with `0` sync D1 ops during D1 outage; Unknown-ACK converges                           | **FAIL**                       | Timed out after `15000ms` due to **Defect #3** (alarm erases coverage + pre-ACK outbox loss)                                                                       |
| `F-6`  | GlobalBudget unavailable `503` & concurrent daily ceiling cap (`429 BUDGET_EXCEEDED`)                        | **FAIL**                       | `503` unavailable passed, concurrent burst returned `1x 201 + 5x 503` due to **Defect #1** & **Defect #2**                                                         |
| `F-7`  | Crash after `prepareTurn` before `markAttemptSent` releases hold (`0` charge)                                | **PASS**                       | Verified `released` state and `0` micro-USD consumed                                                                                                               |
| `F-8`  | Crash after `markAttemptSent` before provider fetch converges `unknown_billed`                               | **PASS**                       | Verified `unknown_billed` settlement and conservative billing                                                                                                      |
| `F-9`  | `markAttemptSent` guards (`cancelled`, `fenced`, `already_sent`)                                             | **FAIL**                       | Returned `{ authorized: false, reason: 'already_sent' }` instead of `'cancelled'` due to **Defect #5**                                                             |
| `F-10` | Client disconnect mid-stream hands off to `durable_queue`, polls handle once, commits once                   | **FAIL**                       | Edge SSE `/v2/.../messages/stream` closed immediately (`chunk.done === true`) due to **Defect #4**                                                                 |
| `F-11` | B1 interactive fast path vs durable queue                                                                    | **N/A (Alternative Verified)** | Per frozen B1 contract, `POST /v1/conversations/:id/messages` routes via `durable_queue` (`60s` deadline, `0` interactive lease) — verified                        |
| `F-12` | 15s interactive lease renewal + 120s handoff preserves 600s turn deadline                                    | **PASS**                       | Verified lease renewals, handoff, and single job-handle poll                                                                                                       |
| `F-13` | `unknown_commit` on D1 ACK loss + Sweeper reconciliation                                                     | **PASS**                       | Verified D1 sync recovery and idempotent reconciliation                                                                                                            |
| `F-14` | 7 consecutive DO Alarm failures recovered offline by Cron Sweeper `<= 5 min`                                 | **PASS**                       | Verified 7 alarm attempts before Sweeper recovery                                                                                                                  |
| `F-15` | GlobalBudget grant expiry + cross-agent `usage_missing` halt                                                 | **FAIL (Partial)**             | **Grant Expiry sub-test PASSED** via `GlobalBudgetDO.alarm()`; **Cross-Agent Halt sub-test FAILED** (timed out `15000ms` because stream trigger hit **Defect #4**) |
| `F-16` | Cross-tenant `404` isolation, refresh token rotation, reuse family revocation, zero prompt leak              | **FAIL**                       | Cross-tenant read returned `503` instead of `404` due to **Defect #2**                                                                                             |
| `F-17` | Concurrent Sweeper `retireCoverage`/`postponeCoverage` raced against `prepareTurn` never erases new coverage | **PASS**                       | Verified new generation survives Sweeper race                                                                                                                      |
| `F-18` | Durable Task multi-run retry caps (`<= 4` non-python / `<= 6` python attempts, cost caps)                    | **PASS**                       | Verified attempt and micro-USD boundary enforcement                                                                                                                |
| `F-19` | `registering` crash repair before D1 upsert completes                                                        | **PASS**                       | Verified Sweeper repairs `registering` head cleanly                                                                                                                |
| `F-20` | `budget_sync` recovery preserves future schedules                                                            | **PASS**                       | Verified future schedule rows survive recovery cycle                                                                                                               |
| `F-21` | Invalid handoffs (wrong epoch / wrong lease owner / post-commit) fenced cleanly                              | **PASS**                       | Verified stale/unauthorized handoff rejection                                                                                                                      |
| `F-22` | Forged queue envelopes / mismatched `fenceEpoch` ignored without state corruption                            | **PASS**                       | Verified strict envelope & fence validation                                                                                                                        |
| `F-23` | `budget_sync` survives `clearTranscript`; `rev=0` vs monotonic `rev>=1` deltas applied once                  | **PASS**                       | Verified `budget_sync` revision convergence after transcript reset                                                                                                 |

### 7.2 Fault-Injection Scenarios (`FI-01..FI-16`)

| ID      | Fault Scenario                                                                           | Status             | Evidence / Root Cause                                                                               |
| :------ | :--------------------------------------------------------------------------------------- | :----------------- | :-------------------------------------------------------------------------------------------------- |
| `FI-01` | Crash after DO `pending_registration` write before D1 ACK                                | **PASS**           | Verified Sweeper convergence                                                                        |
| `FI-02` | Crash after D1 registration before DO confirmation ACK                                   | **PASS**           | Verified generation CAS repair                                                                      |
| `FI-03` | Stale Sweeper CAS during concurrent turn preparation                                     | **PASS**           | Verified stale generation rejection                                                                 |
| `FI-04` | Duplicate queue delivery (`queueDuplicateCount = 2..3`)                                  | **PASS**           | Verified 0 duplicate commits or provider calls                                                      |
| `FI-05` | Crash after `commitDurableResult` / after `queue.send` before outbox ACK                 | **PASS**           | Verified idempotent retry and convergence                                                           |
| `FI-06` | `queueForceDlq` dead-letter convergence (`retry` exhaustion -> `dlq`)                    | **PASS**           | Verified DLQ consumer updates DO state cleanly                                                      |
| `FI-07` | Task retry & cost boundary enforcement under provider 5xx                                | **PASS**           | Verified hard cap halt without over-spend                                                           |
| `FI-08` | 7 consecutive alarm failures (`alarmFailCount = 7`) + backoff & Sweeper                  | **PASS**           | Verified offline detection `50s` and recovery `66s`                                                 |
| `FI-09` | Alarm / Sweeper quarantine of corrupt agent without blocking sibling tenants             | **PASS**           | Verified healthy sibling isolation                                                                  |
| `FI-10` | `retireCoverage` / `postponeCoverage` generation race vs new turn                        | **PASS**           | Verified generation monotonic guard                                                                 |
| `FI-11` | `postpone` D1 timeout / uncertain D1 outcome recovery                                    | **PASS**           | Verified D1 uncertain-timeout convergence                                                           |
| `FI-12` | D1 hard outage split (Uncovered fail-closed `503` vs Covered `0` sync D1 ops)            | **FAIL (Partial)** | Uncovered `503` fail-closed **PASSED**; Covered D1 outage execution **FAILED** due to **Defect #3** |
| `FI-13` | `slow_handoff` interactive->durable transition at 120s deadline                          | **PASS**           | Verified seamless handoff & single job poll                                                         |
| `FI-14` | `missing_handle_hang` timeout without provider job handle                                | **PASS**           | Verified safe failure without duplicate execution                                                   |
| `FI-15` | `GlobalBudgetDO` `conflict_payload` retains `budget_sync` outbox row without silent drop | **PASS**           | Verified `last_error_code` retention on non-acked `budget_sync` row                                 |
| `FI-16` | DST Spring-Forward / Fall-Back timezone schedule transitions                             | **PASS**           | Verified `DST_TRANSITION_FIXTURES` scheduling invariants                                            |

---

## 8. CTO Defect Report (5 Verified Runtime Defects on `main @ a537e4f`)

No production runtime modules were modified on this verification branch. Exact file/line locations and reproductions are reported below:

1. **Defect #1 [High] — Concurrent Uncovered `prepareTurn` Generation Race (`F-1`, `F-6`, Concurrency Contention)**
   - **Location:** [registry.ts](../../packages/runtime-v2/src/recovery/registry.ts#L386-L427) (`inspectCoverageSync`, `confirmCoverageSync`), [turn-service.ts](../../packages/runtime-v2/src/agent-head/turn-service.ts#L394-L404), [turn-service.ts](../../packages/runtime-v2/src/agent-head/turn-service.ts#L540-L562)
   - **Mechanism:** Each concurrent `prepareTurn` hitting an uncovered head increments `v2_recovery_coverage.generation` (`prevGen + 1`) while `coverage_state === 'registering'`. When request #1 awaits D1 upsert and returns to Stage 3 `confirmCoverageSync`, `row.generation !== cmd.generation`, causing Stage 3 to fail with `'recovery coverage lost or insufficient before commit'` (`503 DB_UNAVAILABLE`).
   - **Reproduction:** Send 5 concurrent `POST /v1/conversations/:id/messages` requests (identical `client_submission_id` for `F-1` or distinct IDs for `F-6`) to an uncovered `AgentHeadDO` -> observed `1x 201` + `4x 503` instead of `1x 201 + 4x 200` (`F-1`).

2. **Defect #2 [High] — `workerd` DO RPC Error Erasure in Edge Worker (`F-2`, `F-3`, `F-6`, `F-16`)**
   - **Location:** [edge-worker.ts](../../apps/api/src/local-v2/edge-worker.ts#L376-L383), [errors.ts](../../packages/domain/src/errors.ts#L165-L167)
   - **Mechanism:** Across real `workerd` Durable Object RPC, thrown `DomainError` instances lose their prototype chain (`instanceof DomainError === false`). `callRuntime()` catches the RPC error, checks `if (isDomainError(error))`, and overwrites every DO-thrown domain error (`409 IDEMPOTENCY_CONFLICT`, `409` Stage 3 abort, `429 BUDGET_EXCEEDED`, `404 NOT_FOUND`) into `503 DB_UNAVAILABLE`.
   - **Reproduction:** Submit conflicting `client_submission_id` (`F-2`), interleave `clearTranscript` during Stage 2 (`F-3`), or read another tenant's conversation (`F-16`) against real `workerd` DO RPC -> all return HTTP `503`.

3. **Defect #3 [Critical] — Covered Path D1 Postpone Race, Coverage Erasure on D1 Outage, and Pre-ACK Outbox Loss Risk (`F-5`, `FI-12`, Cost Amplification)**
   - **Location:** [recovery-service.ts](../../packages/runtime-v2/src/agent-head/recovery-service.ts#L111-L132) (`earliestRequiredDiscoveryAtMsSync`), [recovery-service.ts](../../packages/runtime-v2/src/agent-head/recovery-service.ts#L999-L1004) (`claimDurableWork`), [registry.ts](../../packages/runtime-v2/src/recovery/registry.ts#L795-L862) (`syncPostCycleCoverage`), [turn-commit.ts](../../packages/runtime-v2/src/agent-head/turn-commit.ts#L532)
   - **Mechanism:** (a) `earliestRequiredDiscoveryAtMsSync` adds `+45s` (`d1RecoveryGraceMs`) atop turn #1's `lease_expires_at_ms`, triggering `syncPostCycleCoverage` `postponeCoverage` during alarm processing. (b) `syncPostCycleCoverage` overwrites DO SQLite (`coverage_state = 'registering'`, `covered_recovery_at_ms = NULL`) **before** awaiting D1 `postponeCoverage`; when D1 is unavailable (`F-5`), `alarm()` throws and leaves valid coverage erased! (c) Next, `claimDurableWork` marks the outbox item `acked` **before** `executeAuthoritativeTurnCommit` (`turn-commit.ts:532`); when `commitDurableResult` throws on the D1 check due to the erased coverage, Queue retry sees an empty outbox and accepted work stalls/is lost. This also inflates steady-state D1 ops from `0` to `7.92 D1 writes/event` on covered turns.
   - **Reproduction:** Settle turn #1 on a covered head, inject `d1Mode = 'unavailable'`, and submit turn #2 (`F-5`) -> times out at `15000ms` without completion.

4. **Defect #4 [Critical] — `LoopbackFakeModelGateway` Uses `redirect: 'error'`, Rejected by `workerd` (`F-10`, `F-15` Cross-Agent Halt, `/v2/conversations/:id/messages/stream`)**
   - **Location:** [fake-loopback.ts](../../packages/model-gateway/src/fake-loopback.ts#L156-L159)
   - **Mechanism:** `LoopbackFakeModelGateway` calls `this.fetcher(this.origin + path, { ...init, signal, redirect: 'error' })`. Cloudflare `workerd`'s Fetch API only supports `"follow"` and `"manual"` and throws `TypeError: Invalid redirect value, must be one of "follow" or "manual"` immediately inside the Worker before reaching `FakeModelGatewayServer` (`totalCalls === 0`).
   - **Reproduction:** Invoke `POST /v2/conversations/:id/messages/stream` in real `workerd` -> SSE stream closes with error and `0` `turn.delta` frames (`edgeSseStreamProbe.sawDeltaEvent: false`).

5. **Defect #5 [Medium] — `markAttemptSent` Returns `'already_sent'` Instead of `'cancelled'` After `cancelTurn` (`F-9`)**
   - **Location:** [turn-service.ts](../../packages/runtime-v2/src/agent-head/turn-service.ts#L876-L901)
   - **Mechanism:** `cancelTurn()` sets `model_attempts.state = 'released'` and `turn.cancel_requested_at_ms`. Subsequent `markAttemptSent()` checks `attempt.send_started_at_ms !== null || attempt.state !== 'reserved'` at line 876 **before** checking `turn.cancel_requested_at_ms !== null` at line 899, returning `{ authorized: false, reason: 'already_sent' }` instead of `'cancelled'`.
   - **Reproduction:** Call `prepareTurn` -> `cancelTurn` -> `markAttemptSent` on `AgentHeadDO`.

---

## 9. D6 — Performance Benchmark Raw Results (`[Measured: Local workerd]`)

Executed via `pnpm bench:local --suite m1-full-runtime --enable-local-load --concurrency-levels 1,10,25,50 --requests-per-level 20 --out-dir benchmarks/v2-m1` ([m1-full-runtime.json](../../benchmarks/v2-m1/m1-full-runtime.json), `gitSha: a537e4f8f3f43d69915cb51a2cf301bdd18b49f7`, `wrangler@4.158.0`, FakeModelGateway delay `0 ms`, cost `120` micro-USD):

### 9.1 Core Path Latencies & Engineering Target Comparison

| Metric                                                                          | Target                    | Local `workerd` Measured                                    | M0 Baseline                     | Status                    |
| :------------------------------------------------------------------------------ | :------------------------ | :---------------------------------------------------------- | :------------------------------ | :------------------------ |
| **Uncovered B1 HTTP ACK** (`POST -> 201`, `n=20`)                               | `<= 250 ms` (near-region) | P50 `12.57` / P95 **`15.94`** / P99 `19.19 ms` (`20/20` ok) | `17.66 ms` P95                  | **PASS** (local loopback) |
| **Covered B1 HTTP ACK** (`POST -> 201`, `n=20`)                                 | `<= 250 ms` (near-region) | P50 `13.02` / P95 **`16.97`** / P99 `18.23 ms` (`20/20` ok) | `10.59 ms` P95                  | **PASS** (local loopback) |
| **3-RPC Fast Path ACK** (`prepareTurn` RPC, `n=20`)                             | —                         | P50 `9.14` / P95 `11.18` / P99 `13.77 ms` (`20/20` ok)      | —                               | Measured                  |
| **Runtime Overhead** (3-RPC `prepare+markSent+commit` excl. model, `n=20`)      | `<= 200 ms`               | P50 `20.99` / P95 **`25.15`** / P99 `26.57 ms` (`20/20` ok) | `31.44` cov / `38.45` uncov P95 | **PASS** (RPC fast path)  |
| **Global Budget Reserve + Authorize** (`GlobalBudgetDO`, `n=20`)                | `<= 50 ms`                | P50 `6.15` / P95 **`7.74`** / P99 `9.87 ms` (`20/20` ok)    | `11.49 ms` P95                  | **PASS** (local DO)       |
| **Fake Provider TTFT** (direct loopback SSE `delta`, `n=20`)                    | —                         | P50 `0.58` / P95 `1.21` / P99 `1.44 ms` (`20/20` ok)        | —                               | Measured                  |
| **Durable Dispatch Latency** (`POST -> completed`, `n=40`)                      | `<= 3,000 ms`             | P50 `32.51` / P95 **`54.15`** / P99 `55.07 ms` (`40/40` ok) | N/A in M0                       | **PASS**                  |
| **Edge SSE Stream** (`/v2/.../messages/stream`)                                 | Stream `turn.delta`       | HTTP `201`, **`sawDeltaEvent: false`**                      | N/A in M0                       | **FAIL** (Defect #4)      |
| **Offline Detection / Recovery** (virtual clock + 7 alarm fails + Cron Sweeper) | `<= 2 min` / `<= 5 min`   | **`50,000 ms`** detect / **`66,000 ms`** recover            | N/A in M0                       | **PASS**                  |
| **Concurrent Uncovered Contention** (`c=5` single head)                         | `1x 201 + 4x 200`         | `1x 201`, **`4x 503`**                                      | —                               | **FAIL** (Defect #1)      |

### 9.2 Concurrency Sweep & 1,000-Agent / 100-Concurrent Scalability

_(Pre-covered distinct agents used in sweep to avoid single-agent Defect #1 race; `0` duplicate provider calls / commits / assistant messages / lost work / budget overcommits across all passing runs)_

| Concurrency                | Samples | Success / Err | ACK P50 / P95 / P99 (ms)   | Durable Dispatch P50 / P95 / P99 (ms) |                   Throughput (req/s) | Safety Violations   |
| :------------------------- | ------: | ------------: | :------------------------- | :------------------------------------ | -----------------------------------: | :------------------ |
| `c=1`                      |    `20` |      `20 / 0` | `9.38 / 18.75 / 44.47`     | `29.74 / 57.44 / 60.11`               |                              `20.10` | `0 / 0 / 0 / 0 / 0` |
| `c=10`                     |    `20` |      `20 / 0` | `50.62 / 90.99 / 91.07`    | `532.87 / 941.51 / 990.07`            |                              `15.30` | `0 / 0 / 0 / 0 / 0` |
| `c=25`                     |    `25` |      `25 / 0` | `149.67 / 202.20 / 202.28` | `1617.97 / 1968.68 / 1990.05`         |                              `11.38` | `0 / 0 / 0 / 0 / 0` |
| `c=50`                     |    `50` |      `50 / 0` | `282.02 / 353.04 / 353.21` | `7113.19 / 8515.31 / 8569.71`         |                               `5.59` | `0 / 0 / 0 / 0 / 0` |
| **`1,000 Agents / c=100`** |   `100` |     `100 / 0` | `807.10 / 944.62 / 944.91` | `4399.15 / 5240.32 / 5282.06`         | — (`9,451 ms` prov; `861.56 MB` RSS) | `0 / 0 / 0 / 0 / 0` |

> [!NOTE]
> Local Miniflare serializes `durable_turn` queue batches (`max_batch_size=5`) inside a single host worker process, explaining the `50->100` concurrent durable queue latency increase (`5.24 s` P95 at `c=100`) and host RSS (`861.56 MB`); zero errors and zero safety violations occurred across all `100/100` concurrent submissions and `1,000` provisioned `AgentHeadDO` SQLite instances.

### 9.3 Regional RTT Simulation Overlay (`[Simulated: Regional RTT]` over `workerd` Measurements)

Applying `DEFAULT_REGIONAL_RTT_PROFILES` (`apps/benchmark/src/rtt-simulation.ts`) on top of local `workerd` baselines (`16.97 ms` ACK P95, `25.15 ms` runtime overhead P95, `7.74 ms` GlobalBudget check P95):

| Region Profile | Projected ACK P95 (ms) | Projected Runtime Overhead P95 (ms) | Projected GlobalBudget Check P95 (ms) | Notes                                                                  |
| :------------- | ---------------------: | ----------------------------------: | ------------------------------------: | :--------------------------------------------------------------------- |
| `near-region`  |                `40.97` |                             `53.15` |                               `23.74` | Within all M1 targets (`<= 250 / <= 200 / <= 50 ms`)                   |
| `apac-intra`   |               `116.97` |                        **`223.15`** |                           **`91.74`** | Exceeds `200 ms` overhead & `50 ms` GlobalBudget target across regions |
| `eu-us-east`   |               `190.97` |                        **`415.15`** |                          **`163.74`** | Transatlantic sequential DO RPC exceeds overhead budget                |
| `apac-us-west` |           **`278.97`** |                        **`625.15`** |                          **`247.74`** | Cross-ocean RTT dominates multi-hop serial RPC                         |
| `cross-global` |           **`411.97`** |                        **`950.15`** |                          **`377.74`** | Long-haul sequential hops                                              |

### 9.4 Measured Per-Event Resource Operations (`AgentHeadDO` + `GlobalBudgetDO` + `D1` + `Queue`)

| Execution Path (`n=20`)       | `AgentHead` Rows R / W | `GlobalBudget` Rows R / W |  Total DO Rows R / W |      D1 Ops (`R / W` rows) | Queue Sends | Alarm Set / Fire |
| :---------------------------- | ---------------------: | ------------------------: | -------------------: | -------------------------: | ----------: | ---------------: |
| **Covered 3-RPC Fast Path**   |       `166.40 / 42.00` |                   `8 / 9` |     `174.40 / 51.00` |     `2.00` (`1.00 / 3.00`) |      `0.00` |    `2.00 / 0.00` |
| **Covered B1 Durable Path**   |       `280.65 / 55.30` |                   `8 / 9` | **`288.65 / 64.30`** | **`7.00`** (`7.00 / 8.00`) |      `1.00` |    `4.00 / 1.30` |
| **Uncovered B1 Durable Path** |       `210.00 / 57.40` |                   `8 / 9` |     `218.00 / 66.40` |     `6.60` (`6.60 / 7.60`) |      `1.00` |    `4.00 / 1.65` |

---

## 10. D6 — Updated Monthly Cost Model Using Measured `workerd` Telemetry (`[Estimated: ADR-0006 Formula]`)

Updated via `benchmarks/v2-m1/m1-cost-reestimation.json` using measured Covered B1 Durable means (`289` DO rowsRead/event, `64` DO rowsWritten/event, `7.92` D1 rowsWritten/event after integer scaling, `1` Queue op/event) with `6-month` + `1x` dormant retention vs ADR-0006 `20 rows/event` planning baseline. Cloud Runtime, LLM, and Daytona Sandbox costs are reported strictly separately before totals:

| Scenario (`DO rowsW / D1 W / qOps / mo / dormant`)          |           MAU | Cloud Runtime / mo |           Cloud Target | LLM (Illustrative) | LLM (ZDR Flash) | Sandbox Gross | Sandbox 50% Offload | Combined Total (Ill. / ZDR+Offload) |
| :---------------------------------------------------------- | ------------: | -----------------: | ---------------------: | -----------------: | --------------: | ------------: | ------------------: | :---------------------------------- |
| `adr0006_planning_20rows_1k` (`20 / 0.2 / 1.2 / 0 / 0x`)    |       `1,000` |          **$9.33** |                  `$30` |        `$3,078.00` |       `$314.64` |     `$166.50` |            `$83.25` | `$3,253.83` / `$407.22`             |
| **`m1_measured_workerd_1k` (`64 / 7.92 / 1.0 / 6 / 1x`)**   |   **`1,000`** |        **`$7.72`** |       `$30` (**PASS**) |        `$3,078.00` |       `$314.64` |     `$166.50` |            `$83.25` | **`$3,252.22` / `$405.61`**         |
| `adr0006_planning_20rows_10k` (`20 / 0.2 / 1.2 / 0 / 0x`)   |      `10,000` |        **$176.07** |                 `$300` |       `$30,780.00` |     `$3,146.40` |   `$1,665.00` |           `$832.50` | `$32,621.07` / `$4,154.97`          |
| **`m1_measured_workerd_10k` (`64 / 7.92 / 1.0 / 6 / 1x`)**  |  **`10,000`** |      **`$518.76`** |   `$300` (**EXCEEDS**) |       `$30,780.00` |     `$3,146.40` |   `$1,665.00` |           `$832.50` | **`$32,963.76` / `$4,497.66`**      |
| `adr0006_planning_20rows_100k` (`20 / 0.2 / 1.2 / 0 / 0x`)  |     `100,000` |      **$2,204.80** |               `$3,500` |      `$307,800.00` |    `$31,464.00` |  `$16,650.00` |         `$8,325.00` | `$326,654.80` / `$41,993.80`        |
| **`m1_measured_workerd_100k` (`64 / 7.92 / 1.0 / 6 / 1x`)** | **`100,000`** |    **`$6,081.66`** | `$3,500` (**EXCEEDS**) |      `$307,800.00` |    `$31,464.00` |  `$16,650.00` |         `$8,325.00` | **`$330,531.66` / `$45,870.66`**    |

> [!WARNING]
> **Cost Finding:** At `1,000 MAU`, Workers Paid included allowances (`50M` DO rowsWritten/month) absorb the measured `64` DO rowsWritten/event, keeping Cloud Runtime at **$7.72/mo**. At `10,000–100,000 MAU`, measured `64` DO rowsWritten/event (`3.2x` the ADR-0006 `20`-row assumption) plus `7.92` D1 writes/event push Cloudflare Infrastructure costs **above ADR-0006 targets** (**$518.76 vs $300** at 10k MAU; **$6,081.66 vs $3,500** at 100k MAU). Fixing Defect #3 (`0` steady-state D1 I/O on covered turns) and coalescing DO SQLite writes on the commit path are required to return Cloud Runtime within `$300 / $3,500` targets at scale.

---

## 11. Known Test Scope & Environment Limitations

1. **Local Single-Host `workerd` vs Cloudflare Production:** All runtime numbers (`m1-full-runtime.json`) reflect single-process `wrangler createTestHarness()` (`workerd`) over loopback TCP/DO IPC (`FakeModelGatewayServer` at `0 ms` delay). Real production cold-start DO hibernation wakeup latency, global Anycast/colocation placement, production CPU billing, and D1 multi-AZ replication lag require an approved Canary Worker deploy.
2. **GlobalBudgetDO Row Accounting:** `AgentHeadDO` SQLite rows (`166–281` read, `42–57` written) were directly metered in `workerd`; `GlobalBudgetDO` production source was unmodified per verification isolation, so its per-turn contribution (`8` rows read / `9` rows written) retains the M0-measured `GlobalBudgetAuthorityCore` count.
3. **Edge SSE & Single-Head Concurrency Contention:** Because Defect #4 blocks `workerd` fetch with `redirect: 'error'` on `/v2/.../messages/stream` and Defect #1 fails concurrent uncovered `prepareTurn` with `503`, the 3-RPC Fast Path overhead benchmark measured DO RPC directly (`prepareTurn -> markAttemptSent -> FakeModelGateway -> commitTurn`) and the concurrency sweep (`1/10/25/50` and `1,000` agents) used pre-covered distinct agents.
4. **Cost Model Estimates:** Section 10 cost figures use `calculateAdr0006Cost()` published pricing formulas over measured `workerd` operational counts and remain model estimates, not live Cloudflare/LLM/Daytona invoices.

---

## 12. Final M1 Release Verdict

**Verdict: NO-GO for V2-M1 Production Release.**

`main @ a537e4f8f3f43d69915cb51a2cf301bdd18b49f7` passes all static/unit/chaos/E2E gates and executes single-turn covered/uncovered durable paths, recovery alarms, Sweeper repairs, DLQ handling, DST schedules, and multi-agent load with zero duplicate commits or budget overcommits. However, **Defects #1–#5** cause **9/20 acceptance tests (10/39 matrix items)** to fail — specifically breaking Edge SSE streaming (`F-10`, `/v2/.../messages/stream`), covered-path D1-outage resilience (`F-5`, `FI-12`), concurrent uncovered idempotency/ceiling admission (`F-1`, `F-6`), HTTP domain error propagation (`F-2`, `F-3`, `F-16`), and cancellation guard reason reporting (`F-9`) — alongside `64` DO rowsWritten/event inflating Cloud costs beyond `$300` / `$3,500` targets at `10k–100k` MAU. Re-verification against real `workerd` is required after owner fixes land.

---

## 13. D7 — Re-Verification on `main @ 1131415bd25ef3db7de5375a16735e3adf0974cf`

Per CTO D7 execution scope adjustment, acceptance verification ran directly against `main @ 1131415bd25ef3db7de5375a16735e3adf0974cf` (with [runtime-worker.ts](../../tests/integration/support/v2-m1-full-runtime/runtime-worker.ts) delegating `/v1/*` & `/v2/*` HTTP and Queue consumers directly to `apps/api/src/local-v2/worker.ts` and `AgentHeadDO` / `GlobalBudgetDO`). Performance Benchmark and Cost re-estimation are paused until Defect #6 is resolved.

### 13.1 D7 Acceptance Matrix Tally (`21 / 22` Tests Passed)

- **All 39 Matrix Items (`F-1..F-23`, `FI-01..FI-16`) — PASS (`38 PASS`, `1 N/A — Alternative Verified`):**
  - **D6 Defects #1–#5 Verified Fixed:**
    - **Defect #1 (`F-1`, `F-6`):** `F-1` (`1x 201 + 4x 200`, `totalCalls: 1`) and `F-6` (concurrent daily ceiling `429 BUDGET_EXCEEDED`, GlobalBudget unavailable `503`) **PASS**.
    - **Defect #2 (`F-2`, `F-3`, `F-6`, `F-16`):** Edge DO RPC domain error propagation (`409 IDEMPOTENCY_CONFLICT`, `409` Stage 3 abort, `429 BUDGET_EXCEEDED`, `404 NOT_FOUND`) **PASS**.
    - **Defect #3 (`F-5`, `FI-12`):** Covered path executes with `0` sync D1 ops during hard D1 outage and completes `unknown_billed` / `settled` recovery cleanly **PASS**.
    - **Defect #4 (`F-10`, `F-15` Cross-Agent Halt):** Real `/v2/conversations/:id/messages/stream` SSE streaming, client disconnect handoff to `durable_turn`, single provider job poll, and `usage_missing` cross-agent incident halt **PASS**.
    - **Defect #5 (`F-9`):** `markAttemptSent` prioritizes `cancelled` guard ahead of `already_sent` **PASS**.
  - **Remaining Matrix Items (`F-4`, `F-7`, `F-8`, `F-11 [N/A alt verified]`, `F-12`, `F-13`, `F-14`, `F-15 [Grant Expiry]`, `F-17`, `F-18`, `F-19`, `F-20`, `F-21`, `F-22`, `F-23`, `FI-01..FI-16`):** All **PASS**.
- **D7 Step 4B (`Crash after Provider send before Commit`) — PASS** (`1213ms` targeted run; `totalCalls === 1`, `unknown_billed` conservative `250` micro-USD settled, `0` duplicate sends).
- **D7 Step 4A (`Crash after Claim before markAttemptSent` pre-send retry) — FAIL / BLOCKED (Defect #6)**.

### 13.2 Newly Discovered Runtime Defect #6 (Blocking `D7 Step 4A`)

6. **Defect #6 [High] — Pre-Send Durable Turn Retry Fails After Lease Expiry (`reconcileTurnSync` Releases Attempt #1 Without Allocating a New Reserved Attempt) (`D7 Step 4A`)**
   - **Location:**
     - [recovery-service.ts](../../packages/runtime-v2/src/agent-head/recovery-service.ts#L427-L519) (`reconcileTurnSync`)
     - [recovery-service.ts](../../packages/runtime-v2/src/agent-head/recovery-service.ts#L1113-L1137) (`claimDurableWork`)
     - [turn-service.ts](../../packages/runtime-v2/src/agent-head/turn-service.ts#L886-L888) (`markAttemptSent`)
     - [durable-integration.ts](../../packages/runtime-v2/src/recovery/durable-integration.ts#L225-L245) (`executeRecoveredOrFreshDurableWork`)
   - **Mechanism:**
     1. After `claimDurableWork` claims epoch 1 (`turn.status = 'running'`, `claim_count = 1`) and crashes before `markAttemptSent` (`send_started_at_ms = NULL`), the 45s lease expires while still inside the 60s `deadline_at_ms`.
     2. `AgentHeadDO.alarm()` executes `reconcileTurnSync`, which immediately calls `settleOpenAttemptsForSubjectSync(..., 'not_sent', 'model_unavailable', nowMs)` (`recovery-service.ts#L427-L435`), transitioning `model_attempts` attempt #1 to `state = 'released'`.
     3. Because `!anyUncertain` and `computePreDeadlineRetryAtMs` returns `shouldRetry: true`, `reconcileTurnSync` (`L484-L518`) increments `lease_epoch` and enqueues `turn:<turnId>:epoch:<nextEpoch>` (`durable_turn`), **without** inserting/reserving a new `model_attempts` row (`attempt_no = 2`, `state = 'reserved'`).
     4. On retry delivery, `claimDurableWork` (`L1113-L1137`) calls `getLatestAttemptForSubjectSync` and puts the **already-released** attempt #1 into `contextJson`.
     5. `executeRecoveredOrFreshDurableWork` (`durable-integration.ts#L225`) calls `markAttemptSent({ attemptNo: 1, ... })`, which hits `attempt.state !== 'reserved'` (`turn-service.ts#L886-L888`) and rejects with `{ ok: false, reason: 'already_sent' }`.
     6. `executeRecoveredOrFreshDurableWork` (`L244`) degrades to `uncertainOutcome(context)` (`unknown_billed`), causing `commitDurableResult` to fail the turn instead of retrying the provider send.
   - **Reproduction:**
     - Run `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy pnpm vitest run -c vitest.integration.config.ts tests/integration/v2-m1-full-runtime-acceptance.test.ts -t "D7 Step 4A"`.
     - Or: submit `POST /v1/conversations/:id/messages` at `t0`, crash `claimDurableWork` at `after_claim_before_send`, advance clock to `t0 + 46_000` and invoke DO alarm (schedules retry at `t0 + 55_000`), advance clock to `t0 + 55_500` and invoke DO alarm (queue delivers retry).
   - **Actual Result:** Retry `markAttemptSent` rejects attempt #1 (`state = 'released'`) with `already_sent`; provider is never invoked (`totalCalls === 0`); test times out at `15000ms` waiting for `turn.status === 'completed'` and `attempt.state === 'settled'`.
   - **Expected Result:** Pre-send durable retry either allocates a fresh reserved `model_attempts` row (`attempt_no = 2` with active reservation/grant) before/on retry claim or preserves an open `reserved` attempt across pre-send retry so the retried queue worker calls the provider once (`totalCalls === 1`), completes the turn, and settles `165` micro-USD.

### 13.3 D7 Final Verification with PR `#188` Integrated (`22 / 22` PASS)

- **PR `#188` (`fix/v2-m1-d7-unsent-durable-retry`):**
  - Reviewed candidate fix in [recovery-service.ts](../../packages/runtime-v2/src/agent-head/recovery-service.ts) (`preserveUnsentReservation`): on `durable_queue` lease expiration before `turn.deadline_at_ms` with no provider handle, exactly one still-`reserved` attempt, `send_started_at_ms === null`, `send_authorizing_at_ms === null`, and valid `global_grant_expires_ms >= turn.deadline_at_ms` (or `disabled_echo_only`), preserves the open reservation across lease recovery instead of releasing it prematurely, while stale-worker fencing (`lease_epoch`, `lease_owner`) continues to reject prior workers.
  - Fixed Prettier formatting failure in [v2-m1-agent-head.test.ts](../../tests/unit/v2-m1-agent-head.test.ts) (`f057c3e1c83663b53589bda75d0b4773198229d0`), verified `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`, and `tests/unit/v2-m1-agent-head.test.ts` (`12/12 PASS`), and pushed to PR `#188`.
- **Full Real Local `workerd` Acceptance Suite (`v2-m1-full-runtime-acceptance.test.ts`):**
  - Integrated `fix/v2-m1-d7-unsent-durable-retry @ f057c3e` into `test/v2-m1-full-runtime-acceptance` (PR `#185`) and ran all 22 tests:
  - **Result:** **`22 passed (22)`** in `98.20s` (`D7 Step 4A` `656ms` PASS, `D7 Step 4B` `554ms` PASS, all `F-1..F-23` & `FI-01..FI-16` PASS with `F-11` N/A + alternative verified).
  - **Safety Counters:** Duplicate Provider Calls = `0`, Duplicate Assistant Messages = `0`, Duplicate Commits = `0`, Lost Accepted Work = `0`, Budget Overcommit = `0`.
  - **Benchmark / Cost Note:** Per D7 scope adjustment, Benchmark & Cost re-estimation (`§9–§10`) remain paused and were not re-run post-`1131415`/`#188`.

---

## 14. M1-D8 — Final Performance, Covered D1 I/O & Cost Verification (`main @ d3c559c` + PR `#185` @ `af93106`)

Executed via `pnpm bench:local --suite m1-full-runtime --enable-local-load --concurrency-levels 1,10,25,50 --requests-per-level 20 --out-dir benchmarks/v2-m1` ([m1-full-runtime.json](../../benchmarks/v2-m1/m1-full-runtime.json), [m1-cost-reestimation.json](../../benchmarks/v2-m1/m1-cost-reestimation.json), `gitSha: af93106e161d83e792c93c03b56cf6aefee364ec`, `wrangler@4.158.0`, FakeModelGateway `delay = 0 ms`, cost `120` micro-USD; zero runtime files modified). Per M1-D8 scope, the already-verified `22/22` acceptance suite (`§13.3`) was not re-executed.

### 14.1 Core Latency Metrics & ADR-0006 Target Comparison (`[Measured: Local workerd]`)

| Metric                                           | Workload & Timing Start                                        |        P50 |                        P95 |        P99 | ADR-0006 / M0 Target      |      D6 (`a537e4f`) P95 | D8 Status            |
| :----------------------------------------------- | :------------------------------------------------------------- | ---------: | -------------------------: | ---------: | :------------------------ | ----------------------: | :------------------- |
| **Covered HTTP ACK (`B1 POST`)**                 | Covered agent HTTP request -> `201` receipt (`n=20`)           | `12.70 ms` |             **`17.42 ms`** | `18.24 ms` | `<= 250 ms` (near-region) |              `16.97 ms` | **PASS**             |
| **Uncovered HTTP ACK (`B1 POST`)**               | Fresh uncovered agent HTTP request -> `201` (`n=20`)           | `13.94 ms` |             **`15.85 ms`** | `17.11 ms` | `<= 250 ms` (near-region) |              `15.94 ms` | **PASS**             |
| **3-RPC Fast Path ACK (`prepareTurn`)**          | `AgentHeadDO.prepareTurn` RPC -> `prepared` (`n=20`)           |  `9.02 ms` |             **`12.89 ms`** | `13.06 ms` | `<= 250 ms`               |              `12.23 ms` | **PASS**             |
| **Runtime Overhead (3-RPC Fast Path)**           | `(prepare + markSent + gateway + commit) - gatewayMs` (`n=20`) | `21.28 ms` |             **`25.02 ms`** | `25.53 ms` | `<= 200 ms`               |              `26.86 ms` | **PASS**             |
| **Fake Provider TTFT (`/v2/fake-model/stream`)** | Loopback SSE request -> first `event: delta` (`n=20`)          |  `0.50 ms` |              **`0.61 ms`** |  `1.12 ms` | Reference baseline        |               `0.73 ms` | **PASS**             |
| **GlobalBudget Reserve + Authorize**             | `reserveGlobal` + `authorizeGlobalSend` RPC (`n=20`)           |  `8.00 ms` |             **`11.17 ms`** | `11.45 ms` | `<= 50 ms`                |              `12.40 ms` | **PASS**             |
| **Durable Dispatch (`POST -> completed`)**       | Post-ACK -> DO `completed` + `global_synced_at_ms` (`n=40`)    | `52.99 ms` |             **`55.85 ms`** | `56.56 ms` | `<= 3,000 ms`             |              `54.15 ms` | **PASS**             |
| **Offline Detection / Recovery**                 | Virtual clock + 7 alarm failures + Cron Sweeper                |          — |                `50s / 66s` |          — | `<= 2m / <= 5m`           |             `50s / 66s` | **PASS**             |
| **Uncovered Contention (`5x` same head)**        | `5` concurrent `prepareTurn` on 1 uncovered head               |          — |             `5/5 HTTP 201` |          — | `0x 503` race             |        `4/5 503` (FAIL) | **PASS (Fixed)**     |
| **Edge SSE (`< 8` prior msgs)**                  | `POST /v2/conversations/:id/messages/stream` fresh head        |          — |  `HTTP 201, sawDelta=true` |          — | Stream `turn.delta`       | `sawDelta=false` (FAIL) | **PASS (Fixed)**     |
| **Edge SSE (`>= 8` prior msgs)**                 | `POST /v2/conversations/:id/messages/stream` (`42` msgs)       |          — | `HTTP 201, sawDelta=false` |          — | Stream `turn.delta`       |                     N/A | **FAIL (Defect #7)** |

> [!NOTE]
> Local `workerd` latencies reflect single-host loopback DO/Queue IPC (`FakeModelGateway delay = 0 ms`) and are **not** production global WAN SLAs. In the synthetic regional RTT overlay ([m1-full-runtime.json](../../benchmarks/v2-m1/m1-full-runtime.json#L426-L466)), near-region simulation yields `ACK P95 = 41.42 ms`, `Runtime Overhead P95 = 53.02 ms`, and `GlobalBudget Check P95 = 27.17 ms`.

### 14.2 Concurrency Sweep & 1,000 Logical Agents (`[Measured: Local workerd]`)

| Concurrency / Workload                 | Samples / Success | ACK P50 / P95 (ms) | Durable Dispatch P50 / P95 (ms) |                  Throughput (req/s) | Safety Violations         |
| :------------------------------------- | ----------------: | -----------------: | ------------------------------: | ----------------------------------: | :------------------------ |
| `c = 1` (pre-covered distinct agents)  |         `20 / 20` |    `11.85 / 18.25` |                 `53.06 / 56.09` |                             `15.01` | `0` across all 5 counters |
| `c = 10` (pre-covered distinct agents) |         `20 / 20` |    `50.70 / 94.89` |               `639.90 / 816.27` |                             `13.22` | `0` across all 5 counters |
| `c = 25` (pre-covered distinct agents) |         `25 / 25` |  `190.14 / 223.73` |           `1,677.80 / 2,265.81` |                              `9.86` | `0` across all 5 counters |
| `c = 50` (pre-covered distinct agents) |         `50 / 50` |  `332.84 / 382.34` |           `5,664.04 / 7,562.63` |                              `6.22` | `0` across all 5 counters |
| `1,000` Agents / `100` Concurrent      |       `100 / 100` |  `754.34 / 897.02` |           `5,648.74 / 8,067.15` | `~10.4s` provision, `901.28 MB` RSS | `0` across all 5 counters |

### 14.3 Covered Path D1 Operation Verification & Per-Event Resource Counts

| Path Measured (`AgentHeadDO` + M0 `GlobalBudgetDO 8R / 9W`)    |            DO Rows Read |       DO Rows Written |     D1 Ops | D1 Rows Read | D1 Rows Written | Queue Sends | Alarm Set / Fires |
| :------------------------------------------------------------- | ----------------------: | --------------------: | ---------: | -----------: | --------------: | ----------: | ----------------: |
| **`activeCoveredB1DurablePath` (`n=5`, coverage held active)** |     `233.0` (`225 + 8`) |   `56.6` (`47.6 + 9`) | **`0.00`** |   **`0.00`** |      **`0.00`** |         `1` |       `3.8 / 1.6` |
| `covered3RpcFastPath` (`n=20`, idle-retires between turns)     |   `177.4` (`169.4 + 8`) |     `51.0` (`42 + 9`) |     `1.00` |       `1.00` |          `3.00` |         `0` |       `2.0 / 0.0` |
| `coveredB1DurablePath` (`n=20`, sequential idle-cycle turns)   |   `268.9` (`260.9 + 8`) | `60.75` (`51.75 + 9`) |     `1.90` |       `1.90` |          `3.90` |         `1` |      `4.0 / 1.75` |
| `uncoveredB1DurablePath` (`n=20`, fresh uncovered agents)      | `181.55` (`173.55 + 8`) | `61.15` (`52.15 + 9`) |     `1.05` |       `1.05` |          `3.05` |         `1` |       `4.0 / 1.1` |

- **Covered Path D1 Verification Finding:** When an AgentHead already holds active D1 coverage (`activeCoveredB1DurablePath` — e.g. overlapping turns or scheduled recovery window), Defect #3's fix achieves **exact `0` D1 operations (`0` reads, `0` writes)** per covered turn (matching `F-5`). On sequential turns separated by full idle settlement (`coveredB1DurablePath`), `syncPostCycleCoverage` retires D1 coverage when `openD === null` and the next turn re-registers, reducing blended `80/20` D1 writes from **`7.92`** (D6 `a537e4f`) to **`3.73`** (`0.8 * 3.90 + 0.2 * 3.05`) on `d3c559c` (or **`0.61`** D1 writes/event under active-covered `80/20` steady state).

### 14.4 Updated Cost Model (`1,000 / 10,000 / 100,000` MAU — `[Estimated: ADR-0006 Formula over D8 Telemetry]`)

| Scenario (`DO rowsW / rowsR / D1 writes / Q ops`)       |           MAU |   Cloud Runtime | ADR-0006 Cloud Target  | LLM (Illustrative / ZDR-Flash) | Sandbox (Gross / 50% Offload) | Combined Total (Illust. / ZDR+Offload) |
| :------------------------------------------------------ | ------------: | --------------: | :--------------------- | -----------------------------: | ----------------------------: | -------------------------------------: |
| `adr0006_planning_20rows_1k` (`20 / 200 / 0.2 / 1.2`)   |       `1,000` |         `$9.33` | `< $15`                |          `$3,078.00 / $314.64` |            `$166.50 / $83.25` |                  `$3,253.83 / $407.22` |
| **`m1_d8_idle_cycle_1k` (`61 / 269 / 3.73 / 1`)**       |   **`1,000`** |     **`$7.72`** | `<= $15` (**PASS**)    |          `$3,078.00 / $314.64` |            `$166.50 / $83.25` |              **`$3,252.22 / $405.61`** |
| `m1_d8_active_cov_1k` (`57 / 233 / 0.61 / 1`)           |       `1,000` |         `$7.72` | `<= $15` (**PASS**)    |          `$3,078.00 / $314.64` |            `$166.50 / $83.25` |                  `$3,252.22 / $405.61` |
| `adr0006_planning_20rows_10k` (`20 / 200 / 0.2 / 1.2`)  |      `10,000` |       `$176.07` | `$300`                 |       `$30,780.00 / $3,146.40` |         `$1,665.00 / $832.50` |               `$32,621.07 / $4,154.97` |
| **`m1_d8_idle_cycle_10k` (`61 / 269 / 3.73 / 1`)**      |  **`10,000`** |   **`$440.92`** | `$300` (**EXCEEDS**)   |       `$30,780.00 / $3,146.40` |         `$1,665.00 / $832.50` |           **`$32,885.92 / $4,419.82`** |
| `m1_d8_active_cov_10k` (`57 / 233 / 0.61 / 1`)          |      `10,000` |       `$412.53` | `$300` (**EXCEEDS**)   |       `$30,780.00 / $3,146.40` |         `$1,665.00 / $832.50` |               `$32,857.53 / $4,391.43` |
| `adr0006_planning_20rows_100k` (`20 / 200 / 0.2 / 1.2`) |     `100,000` |     `$2,204.80` | `$3,500`               |     `$307,800.00 / $31,464.00` |      `$16,650.00 / $8,325.00` |             `$326,654.80 / $41,993.80` |
| **`m1_d8_idle_cycle_100k` (`61 / 269 / 3.73 / 1`)**     | **`100,000`** | **`$5,303.26`** | `$3,500` (**EXCEEDS**) |     `$307,800.00 / $31,464.00` |      `$16,650.00 / $8,325.00` |         **`$329,753.26 / $45,092.26`** |
| `m1_d8_active_cov_100k` (`57 / 233 / 0.61 / 1`)         |     `100,000` |     `$4,602.85` | `$3,500` (**EXCEEDS**) |     `$307,800.00 / $31,464.00` |      `$16,650.00 / $8,325.00` |             `$329,052.85 / $44,391.85` |

- **Cost Attribution:** Fixing Defect #3 lowered estimated Cloud Runtime at `100k` MAU by `$778/mo` (`$6,081.66 -> $5,303.26`, or `$4,602.85` under `0.61` D1 writes/event). However, **DO SQLite `rowsWritten` (`57–61` rows/event, `~2.9x–3.1x` ADR-0006's `20`-row assumption)** remains the dominant Cloud cost driver above `1k` MAU (`$412–$441` vs `$300` at `10k`; `$4,603–$5,303` vs `$3,500` at `100k`). LLM & Sandbox dominate total spend (`~88–99%` of total).

### 14.5 Newly Discovered Defect #7 (Exposed by D8 Multi-Turn SSE Probe; Zero Runtime Edits in D8)

7. **Defect #7 [High] — Multi-Turn Interactive SSE Fails on Turn 5+ (`prepareTurn` Appends New User Message to `LIMIT 8` Context, Producing `9 > maxContextMessages`)**
   - **Location:** [turn-service.ts#L366](../../packages/runtime-v2/src/agent-head/turn-service.ts#L366) (`readRecentTurnContextSync`), [turn-service.ts#L778-L786](../../packages/runtime-v2/src/agent-head/turn-service.ts#L778-L786) (`prepareTurn` Stage 3), [interactive-executor.ts#L159](../../apps/api/src/local-v2/interactive-executor.ts#L159), [context.ts#L88-L90](../../packages/model-gateway/src/context.ts#L88-L90) (`buildBoundedContext`).
   - **Mechanism:** `stage1.context = readRecentTurnContextSync(...)` loads up to `LIMIT 8` (`MODEL_LIMITS.maxContextMessages = 8`) prior messages. Once a conversation has `>= 8` messages (4+ completed turns), `stage1.context` has `8` rows, and Stage 3 returns `[...stage1.context, newUserMessage]` (**`9` rows**). `executeInteractive` calls `buildBoundedContext(prepared.context)`, which throws `ModelInputRefused('context_invalid')` on `rows.length > 8`, committing `status = 'failed', failure_reason = 'internal_error'` with `0` `turn.delta` frames.
   - **Reproduction:** Execute 20 fast turns on one conversation, then `POST /v2/conversations/:id/messages/stream` (`multiTurnSseContextProbe` in [m1-full-runtime.json](../../benchmarks/v2-m1/m1-full-runtime.json#L153-L158)).
   - **Expected:** `stage1` should read `maxContextMessages - 1` (`7`) prior messages (or slice `.slice(-MODEL_LIMITS.maxContextMessages)` in Stage 3) so `prepared.context.length <= 8`.

### 14.6 Final M1 Acceptance Verdict (`main @ d3c559c` + PR `#185`)

- **Functional, Durability & Safety Core:** **PASS (`22/22` acceptance tests, `0` duplicate provider calls/commits/messages, `0` lost accepted work, `0` budget overcommits, `0` D1 I/O on active covered turns, all ADR-0006 single-stream latency targets met).**
- **Release Verdict:** **CONDITIONAL / NO-GO FOR UNCONDITIONAL GA** — while V2-M1 durable execution, recovery, and budget safety are verified ready, **Defect #7** breaks `/v2/conversations/:id/messages/stream` interactive SSE after 4 prior turns (`>= 8` messages), and `57–61` DO `rowsWritten/event` exceeds ADR-0006 Cloud Runtime budgets at `10k/100k` MAU (`$412–$441` vs `$300`; `$4,603–$5,303` vs `$3,500`). Fix Defect #7 before shipping multi-turn interactive SSE, and schedule DO SQLite write coalescing if strict `$300 / $3,500` Cloud Runtime targets are enforced for `10k–100k` MAU.

---

## 15. M1-D9 — Multi-turn SSE Defect Closure (Defect #7 Resolved)

### 15.1 Fix Summary (`turn-service.ts` Stage 3 Bounded Read; Model Gateway Validation Unchanged)

- **Code Change (`packages/runtime-v2` only):** Per PR `#191` (`ff2235f`, integrated on `fix/v2-m1-d9-multi-turn-sse-closure`), [turn-service.ts](../../packages/runtime-v2/src/agent-head/turn-service.ts#L779-L784) removes the stale Stage 1 `readRecentTurnContextSync` pre-read and reads `readRecentTurnContextSync(this.deps.storage.sql, req.conversationId, undefined, sequence)` inside Stage 3 **after** inserting the current user message (`sequence`) and `message_attachments`.
- **Invariant Preserved:** `readRecentTurnContextSync` enforces `LIMIT maxContextMessages (8)` through `sequence`, guaranteeing at most `7` prior messages + `1` current user message (`<= 8` total rows) in strictly ascending `sequence` order with attachment metadata attached — identical to `claimDurableWork`.
- **Model Gateway Validation Unchanged:** [context.ts](../../packages/model-gateway/src/context.ts) (`buildBoundedContext` enforcing `maxContextMessages = 8`, monotonic `sequence`, and trailing `user` row) has **0** modifications (`git diff origin/main -- packages/model-gateway/` is empty).

### 15.2 Real Local `workerd` Regression & `multiTurnSseContextProbe` Re-Verification

- **20+ Continuous SSE Turn + Ordering + Attachments + Durable Handoff Test ([v2-m1-full-runtime-acceptance.test.ts](../../tests/integration/v2-m1-full-runtime-acceptance.test.ts) `D8 Defect #7 / D9`) — PASS (`82398ms`):**
  1. **20 Consecutive SSE Turns (`POST /v2/conversations/:id/messages/stream`):** All 20 turns completed with `HTTP 201`, `turn.accepted`, `turn.delta`, `turn.committed`, `totalCalls === 20`, `40` messages in strict `sequence = 1..40` alternating `user`/`ember`, and every assistant reply echoing its turn's current `Multi-turn request ${i + 1}` prompt.
  2. **Turn 21 Attachments & Context Window (`40` prior messages -> `sequence = 41`):** `prepareTurn` with `resolvedAttachments` (`d9-evidence.pdf`) returned `8` context rows (`sequence = [34..41]`) ending with the current user message (`sequence = 41`) and preserved attachment metadata, passing unmodified `buildBoundedContext()` (`8` messages) and committing `outcome = 'published'`.
  3. **Turn 22 Durable Handoff (`>= 42` prior messages):** `slow_handoff` on `/v2/conversations/:id/messages/stream` with mid-stream client disconnect (`AbortController`) handed off cleanly (`handoff_reason = 'client_disconnect_handoff'`), polled job handle once (`jobPollCount = 1`), and committed `Turn 22 durable handoff after 20+ turns` with `totalCalls = 21` (`0` duplicate provider calls).
- **Targeted `multiTurnSseContextProbe` Re-Verification (`42` prior messages) — PASS:**
  - Direct `workerd` probe after `21` committed turns (`42` prior messages) followed by `POST /v2/conversations/:id/messages/stream` returned `{"priorMessagesCount":42,"status":201,"sawDeltaEvent":true,"sawCommittedEvent":true,"committedStatus":"completed"}`.
- **Full Benchmark & Cost Optimization:** Not re-run / not modified per M1-D9 scope (`§14` measurements and `10k/100k` DO write cost variance remain as recorded).

### 15.3 Updated Final M1 Verdict

- **Functional, Durability, Safety, Latency & Multi-Turn SSE Acceptance:** **GO** — Defects `#1–#7` are all verified resolved, `23/23` acceptance tests in [v2-m1-full-runtime-acceptance.test.ts](../../tests/integration/v2-m1-full-runtime-acceptance.test.ts) pass (`D7 22/22` + `D8/D9` 20+ turn SSE closure), `0` safety violations, and all ADR-0006 single-stream latency and active-covered `0` D1 I/O targets pass.
- **Tracked Scale Cost Variance (Non-Functional):** `57–61` DO `rowsWritten/event` exceeds ADR-0006's `20`-row budget at `10k/100k` MAU (`$412.53–$440.92` vs `$300`; `$4,602.85–$5,303.26` vs `$3,500`) and is tracked for post-M1 DO SQLite write coalescing.

---

## 16. M1-D10 — Final Runtime Acceptance & Consolidation

### 16.1 Clean PR Stack Consolidation (`main @ b669b0e` -> `#190` -> `#191` -> `#193`)

To eliminate duplicated Runtime fixes, duplicated historical benchmark commits/files, and pre-`#185` branch history against latest `main` (`origin/main @ b669b0e`, including merged PR `#189` M2-F1 device execution and PR `#194` M1-A5 write amplification analysis), the M1 deliverables are cleanly separated in linear dependency order:

1. **PR `#190` (`docs/v2-m1-d8-final-benchmark`, `base: main`)**: Rebased cleanly onto `origin/main @ b669b0e`; contains only M1-D8 benchmark instrumentation, D8 JSON artifacts (`benchmarks/v2-m1/`), and D8 acceptance report updates (`§14`).
2. **PR `#191` (`fix/v2-m1-d8-multi-turn-context`, `base: docs/v2-m1-d8-final-benchmark`)**: Contains only PR `#191`'s Defect `#7` fix in [turn-service.ts](../../packages/runtime-v2/src/agent-head/turn-service.ts) (`Stage 3` bounded read `readRecentTurnContextSync(..., undefined, sequence)`, keeping [context.ts](../../packages/model-gateway/src/context.ts) unchanged) and the initial `D8 Defect #7` SSE test.
3. **PR `#193` (`fix/v2-m1-d9-multi-turn-sse-closure`, `base: fix/v2-m1-d8-multi-turn-context`)**: Contains only the D9 + D10 regression coverage expansion in [v2-m1-full-runtime-acceptance.test.ts](../../tests/integration/v2-m1-full-runtime-acceptance.test.ts) and acceptance report consolidation in [v2-m1-acceptance-report.md](./v2-m1-acceptance-report.md) (`§15` + `§16`), with zero Runtime or Benchmark JSON file duplication.

### 16.2 Explicit Separation: Historical D8 Performance Data vs. Latest D10 Functional Data

| Evidence Category                                      | Tested Commit / Baseline                                             | Execution Scope                                                                                                                                   | Status / Key Finding                                                                                                                                                                                                                                                                                                 |
| :----------------------------------------------------- | :------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Historical D8 Performance & Cost Benchmark (`§14`)** | `main @ d3c559c` + `#185` (archived in PR `#190`)                    | Full `m1-full-runtime` workerd benchmark & `ADR-0006` cost model; **not re-run in D9/D10**                                                        | Single-stream latency & active-covered `0` D1 I/O targets passed; `10k/100k` MAU Cloud Runtime exceeded ADR-0006 budget (`$412.53–$440.92` vs `$300` @ `10k`; `$4,602.85–$5,303.26` vs `$3,500` @ `100k`).                                                                                                           |
| **Latest D10 Functional & Safety Acceptance (`§16`)**  | Consolidated HEAD (`origin/main @ b669b0e` + `#190 -> #191 -> #193`) | Full **23/23** real local `workerd` suite (`vitest.integration.config.ts`, **no `-t` filter**), build, typecheck, lint, format check & unit tests | **`23/23` PASS (`180.81s`)**, `0` safety violations (`duplicateProviderCalls=0`, `duplicateAssistantMessages=0`, `duplicateCommits=0`, `lostAcceptedWork=0`, `budgetOvercommit=0`); Turn 22 Handoff verified with `44` messages (`sequence = 1..44`), `22` completed turns, and `0` unconverged budget reservations. |

### 16.3 Turn 22 Post-Handoff Invariant & Budget Convergence Check (D10)

Extending `D8 Defect #7 / D9` in [v2-m1-full-runtime-acceptance.test.ts](../../tests/integration/v2-m1-full-runtime-acceptance.test.ts) on the consolidated HEAD verifies end-to-end state convergence after Turn 22's `client_disconnect_handoff`:

- **Messages & Ordering:** `44` total messages (`22` `user` + `22` `ember`), strictly ascending `sequence = [1..44]`, `44` distinct message IDs (`0` duplicate messages).
- **Turns & Execution:** `22` turns, all `22` in `status === 'completed'`, `22` distinct turn IDs and `22` distinct `response_message_id` values; `FakeModelGateway` recorded `totalCalls === 21` (Turns `1..20` + Turn `22` SSE; Turn `21` exercised RPC attachment persistence) and `jobPollCount === 1` (`0` duplicate provider calls).
- **Budget Reservation Convergence:** All `22` `model_attempts` reached `state === 'settled'` with `global_synced_at_ms !== null`; AgentHead `local_spend_buckets` (`reserved_micro_usd === 0`), `GlobalBudgetDO` `global_spend_days` (`reserved_micro_usd === 0`), and `global_budget_reservations` (all rows `state === 'settled'`, `0` remaining `'reserved'` holds) converged cleanly.

### 16.4 Final M1 Verdict & Cost Optimization Ownership

- **Runtime Functional, Durability, Security & Multi-Turn SSE Verdict:** **GO** on consolidated HEAD (`origin/main @ b669b0e` + `#190 -> #191 -> #193`, Defects `#1–#7` resolved, `23/23` full `workerd` matrix passing).
- **10k / 100k MAU Cloud Cost Overage Conclusion Retained:** Historical D8 telemetry (`57–61` DO `rowsWritten/event`) and M1-A5's code audit ([v2-m1-a5-do-sqlite-write-amplification-analysis.md](./v2-m1-a5-do-sqlite-write-amplification-analysis.md), `58–62` including actual `10`-row `GlobalBudgetDO` writes) exceed ADR-0006's `$300 / $3,500` monthly Cloud Runtime budgets at `10k / 100k` MAU (`$412.53–$440.92` and `$4,602.85–$5,303.26` under D8). Per M1-D10 scope, cost optimization is **not modified in D10** and is tracked independently by **Agent A (`M1-A6`)**.
