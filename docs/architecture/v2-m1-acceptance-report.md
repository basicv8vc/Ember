# Ember V2-M1 — Runtime Integration & Acceptance Report

- **Status:** **D0 PASSED | D1 HARNESS READY & VERIFIED | D2 & FULL D3 BLOCKED AWAITING A/B M1 RUNTIME MERGE**
- **Date:** 2026-11-19
- **Role:** Performance, Integration & Reliability Engineer (V2-M1-D)
- **Baseline `main` SHA:** `6da1b483b6a854199a0f2eef27e53abc770be6cc`
- **Branch / Worktree:** `feat/v2-m1-d-runtime-acceptance` (`worktrees.local/v2-m1-d-runtime-acceptance`)
- **Related:** [M0 Post-Merge Verification Report](./v2-m0-verification-report.md), [V2-M0-A Contract](./v2-m0-runtime-contract.md), [V2-M0-B Contract](./v2-m0-event-recovery-contract.md), [V2-M0-D Benchmark Report](./v2-m0-benchmark-report.md), [ADR-0006](../adr/0006-experience-first-device-powered-runtime-v2.md)

> [!IMPORTANT]
> **Evidence & Anti-Masquerading Discipline:** On `main @ 6da1b483b6a854199a0f2eef27e53abc770be6cc`, Agent A and Agent B have merged their M0 contracts (`#170`, `#171`) and M0-D probes (`#172`), but have **not** yet merged M1 production runtime code (`AgentHeadDO`, `GlobalBudgetDO`, `RecoverySweeper`, `ExecutionWorker`, or V2 Edge API adapters). Per V2-M1-D rules, this worktree **does not** implement a duplicate Agent Runtime and **never** presents M0 probes or harness smoke wiring as E2E A/B acceptance proof.

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

Implemented in [local-v2-guard.ts](../../apps/benchmark/src/v2-m1/local-v2-guard.ts):

- Refuses `EMBER_ENV=production|staging`, `NODE_ENV=production`, `EMBER_MODEL_MODE=real`, `EMBER_DAYTONA_ENABLED=true`, and any non-loopback target/gateway URL.
- Inspects Wrangler configs via `assertIsolatedWranglerConfig` to reject `routes`, `hyperdrive`, or forbidden V1/cloud `vars` (`DATABASE_URL`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `DAYTONA_API_KEY`, `CLOUDFLARE_API_TOKEN`).
- Boots inside an ephemeral OS temp directory (`mkdtempSync`) with isolated `.wrangler` state and loopback-only HTTP servers (`127.0.0.1:0`).

---

## 2. D1 — Local Integration Harness & Fault Injection Toolkit

Deliverables added under [apps/benchmark/src/v2-m1/](../../apps/benchmark/src/v2-m1/index.ts):

1. **Local `workerd` Topology Launcher** ([local-runtime-harness.ts](../../apps/benchmark/src/v2-m1/local-runtime-harness.ts)):
   - Uses Wrangler `4.158.0` `createTestHarness` to boot `AgentHeadDO` (SQLite + Alarm + `evictDurableObject`), `GlobalBudgetDO` (SQLite), `D1_RECOVERY` (auto-initialized with M0-B canonical `v2_recovery_registry` DDL), `DURABLE_TURN_QUEUE` (`durable_turn` -> `durable_turn_dlq` after 5 retries), `AGENT_TASK_QUEUE` (`agent_task` -> `agent_task_dlq`), `R2_BLOBS`, and `* * * * *` `scheduled()` cron trigger.
   - Explicitly separates `target: { kind: 'harness_smoke' }` (infra smoke check) from `target: { kind: 'ab_runtime', configPath }` (A/B's real Wrangler worker).
2. **Loopback `FakeModelGatewayServer`** ([fake-model-gateway-server.ts](../../apps/benchmark/src/v2-m1/fake-model-gateway-server.ts)):
   - Zero-egress loopback HTTP/SSE provider supporting `fast_ok`, `stream_sse`, `slow_handoff` (with `providerJobHandle` issuance + `/v2/fake-model/jobs/:handle` polling), `missing_handle_hang`, `usage_missing`, `late_charge_revision` (`/v2/fake-model/revisions/:operationId`), `error_5xx`, `rate_limited`, and full call/abort auditing.
3. **Deterministic Fault Injection Toolkit** ([fault-injector.ts](../../apps/benchmark/src/v2-m1/fault-injector.ts)):
   - Programmable D1 fault modes (`healthy`, `unavailable`, `uncertain_timeout_committed`, `uncertain_timeout_aborted`), GlobalBudget fault modes (`unavailable`, `timeout`, `grant_expired`, `halt_*`, `conflict_payload`), Queue/DLQ controls (`duplicateCount`, `forceDlq`, 7 `ForgedEnvelopePreset` builders), 8 crash hook points (`after_do_pending_before_d1` through `alarm_exhaust_6_retries`), `DST_TRANSITION_FIXTURES` (`spring_forward_2026_ny`, `fall_back_2026_ny`), virtual clock advancement, and synchronized `runConcurrentRace` barrier.

### Harness Smoke Verification Results `[Verified: Harness Smoke workerd]`

Command:

- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/v2-m1-harness-smoke.test.ts tests/integration/v2-m1-acceptance.test.ts` → **2 files passed** (`v2-m1-harness-smoke.test.ts`: 1/1 passed in `1308 ms`; `v2-m1-acceptance.test.ts`: 1 passed, 1 skipped awaiting A/B M1 runtime).
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

Once Agent A & B merge their M1 Wrangler runtime, setting `EMBER_V2_RUNTIME_CONFIG=<path/to/wrangler.jsonc>` activates `resolveAbRuntimeTarget()` so the full matrix executes against the real `workerd` runtime.

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

Generated via `pnpm bench:local --suite m1-cost-reestimate --out-dir benchmarks/v2-m1` ([m1-cost-reestimation.json](../../benchmarks/v2-m1/m1-cost-reestimation.json)). `ADR-0006` `20 rows/event` is treated strictly as an illustrative planning baseline—not a mandatory hard constraint:

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
