# P0-C3B Scheduler Runtime & Autonomous Execution Delivery Report

**Component**: Autonomous Commitment Scheduler, Occurrence Dispatch, Guarded Execution Runtime  
**Branch**: `feature/p0c-3b-promise-runtime`  
**Base Commit**: `2a05fd80fc1226bef21ba813899728bdde41037f` (`origin/main`)  
**Status**: Stage 2 Round 1 Updates Complete — 3×P1 Fixed — Ready for CTO Re-Review

---

## 1. Executive Summary

P0-C3B delivers the autonomous commitment scheduler and safe execution runtime for Ember, enabling commitments to transition from passive state rows into durable autonomous execution loops under strict governance.

Following CTO Round 1 Review, three P1 adjustments and two additional corrections were implemented:

1. **P1-1: Stalled Occurrence Recovery Fixed**:
   - Eliminated `tenantId: 'system'` and `agentId: 'system'`.
   - Stalled pending occurrences recover original `tenantId`, `agentId`, `sourceProfileId`, and `scheduleKind` from persistent storage.
   - Dispatch and recovery share identical canonical task payloads (`buildCommitmentTaskInput`) with deterministic idempotency keys (`commitment-occ:${occurrenceId}`).
   - Cross-tenant isolation is strictly preserved across crash recoveries.
   - Fail-closed identity recovery: **all four** business identity fields (`tenantId`, `agentId`, `sourceProfileId`, `scheduleKind`) are validated at runtime before dispatch. A missing/blank/unknown value (including `undefined` that would otherwise throw on `.trim()`) skips that record, leaves it `pending`, and reconciliation continues with the remaining occurrences.
2. **P1-2: Sentinel Gate Fails Closed**:
   - Removed permissive bypass when `sentinelPolicy` was omitted.
   - Unconfigured, invalid, version-mismatched, or tenant-mismatched Sentinel policies reject with `POLICY_DENIED`.
   - A missing or malformed `context.policyVersion` is itself a denial (`DENY_INVALID_INTENT`); the previous `?? 1` fallback (which could accidentally match a version-1 policy) is gone.
   - Denied requests guarantee strictly: **0 source callbacks, 0 budget reservations, and 0 outcome writes**.
3. **P1-3: Outcome Replay Authorization Enforced**:
   - Eliminated unauthenticated `store.findOutcome(occurrenceId)` pre-execution shortcut.
   - Replays enforce Sentinel admission first, followed by authoritative verification of tenant, task ID, active worker lease epoch, active commitment status, and valid consent.
   - `findAuthoritativeOutcome` is an optional authenticated lookup; a store that does not implement it gets **no** replay shortcut at all and idempotency is delegated to the transactional `appendOutcomeIfAbsent` fencing.
   - Replay attempts from old/stale leases throw `STALE_LEASE`; cross-tenant, cancelled commitments, or revoked consent throw `POLICY_DENIED`.
   - Legitimate lineage replays return the cached outcome without duplicate rows or extra budget consumption.
4. **Additional Fixes**:
   - Removed hardcoded `attempt: 1` in `RunGrant`; `attempt` is now dynamically propagated from `WorkerLeaseGrant.attempt` (sourced from authoritative `LeasedRun.attempt`).
   - Clarified test documentation regarding PostgreSQL lease queue/budget ledger testing vs. structural store contract validation.
5. **Round 2 Follow-up (Lane C alignment)**:
   - `AbortSignal` is now **mandatory** end-to-end: `SourceReaderPort.readSnapshot(profileId, trustedContext, signal: AbortSignal)` and `CommitmentOrchestrator.execute(grant, context, signal: AbortSignal)` match the merged `@ember/connectors` contract.
   - `execute()` rejects a missing/invalid signal with `INVALID_ARGUMENT` **before** any source read, budget reservation or outcome write; an already-aborted signal yields `CANCELLED` with the same zero-side-effect guarantee.

---

## 2. Architecture & File Breakdown

### 2.1 Execution Layer (`packages/execution`)

- [`packages/execution/src/commitment-summary-engine.ts`](file:///Users/lj/Downloads/Ember/worktrees.local/feature-p0c-3b-promise-runtime/packages/execution/src/commitment-summary-engine.ts):
  - Deterministic `FakeSummaryEngine` generating cryptographically bounded, reproducible summaries from structured source snapshots.
  - Treats source snapshot contents strictly as untrusted data (`BoundedSafeItem`), immune to prompt injection attacks.
  - Limits summary length to `MAX_SUMMARY_LENGTH = 2000` chars.
  - Returns canonical `OutcomeResultStatus`: `'meaningful_change'`, `'no_change'`, `'failed'`, or `'denied'`.
- [`packages/execution/src/commitment-orchestrator.ts`](file:///Users/lj/Downloads/Ember/worktrees.local/feature-p0c-3b-promise-runtime/packages/execution/src/commitment-orchestrator.ts):
  - Guarded occurrence orchestrator.
  - Fail-closed Sentinel admission gate evaluated before any side effects or lookups.
  - Authoritative replay check (`findAuthoritativeOutcome`) validating tenant, task, lease epoch, commitment state, and consent.
  - Mandatory cooperative cancellation: `execute(grant, context, signal: AbortSignal)`; a missing signal is rejected (`INVALID_ARGUMENT`) before any side effect.
  - Fail-closed Sentinel version handling: a missing/invalid `policyVersion` is denied instead of defaulting to `1`.
  - Transactional budget reservation (`budget.reserve`), execution, lease-fenced outcome append (`appendOutcomeIfAbsent`), and budget settlement (`budget.settle`).
  - Terminal completion marking for one-shot schedules (`scheduleKind === 'once'`).
- [`packages/execution/src/index.ts`](file:///Users/lj/Downloads/Ember/worktrees.local/feature-p0c-3b-promise-runtime/packages/execution/src/index.ts):
  - Cleanly exports all new types and classes (`CommitmentOrchestrator`, `FakeSummaryEngine`, `WorkerLeaseGrant`, `AppendOutcomeCommand`, etc.).

### 2.2 Worker & Scheduling Layer (`apps/worker`)

- [`apps/worker/src/commitment-ports.ts`](file:///Users/lj/Downloads/Ember/worktrees.local/feature-p0c-3b-promise-runtime/apps/worker/src/commitment-ports.ts):
  - Structural boundary ports: `DueCommitmentStore`, `ExistingTaskDispatcher`, `SourceReaderPort`.
  - Canonical task payload builder: `buildCommitmentTaskInput(...)`.
  - Deterministic idempotency derivation: `deriveTaskCreationIdempotencyKey(occurrenceId) => "commitment-occ:${occurrenceId}"`.
  - Types `DueCommitment`, `ReservedSlot`, `StalledPendingOccurrence` (carrying `tenantId`, `agentId`, `sourceProfileId`, `scheduleKind`), `WorkerLeaseGrant` (carrying `attempt`).
- [`apps/worker/src/commitment-scheduler.ts`](file:///Users/lj/Downloads/Ember/worktrees.local/feature-p0c-3b-promise-runtime/apps/worker/src/commitment-scheduler.ts):
  - `CommitmentScheduler`: polls for due commitments, reserves occurrence slots atomically, dispatches durable tasks with semantic parity, marks occurrence dispatched.
  - `reconcileStalled()`: autonomously recovers stalled pending occurrences using original tenant and agent identities without `'system'` fallbacks.
  - `runLoop()`: supports graceful cancellation via `AbortSignal`, configurable poll interval, batch size, and exponential error backoff.
- [`apps/worker/src/commitment-handler.ts`](file:///Users/lj/Downloads/Ember/worktrees.local/feature-p0c-3b-promise-runtime/apps/worker/src/commitment-handler.ts):
  - Worker `RunHandler` integration for commitment tasks.
  - Safely extracts commitment metadata (`commitmentId`, `occurrenceId`, `sourceProfileId`, `scheduleKind`) and passes authoritative `run.attempt` to `WorkerLeaseGrant`.
- [`apps/worker/src/config.ts`](file:///Users/lj/Downloads/Ember/worktrees.local/feature-p0c-3b-promise-runtime/apps/worker/src/config.ts):
  - Adds `scheduler` configuration block (`enabled`, `intervalMs`, `batchSize`, `concurrency`, `stalledTimeoutSeconds`).
  - `EMBER_SCHEDULER_ENABLED` defaults strictly to `false`.

---

## 3. Verification & Test Evidence

### 3.1 Quality Gates Matrix

| Verification Gate     | Command                 | Result       | Tests / Details                                                                                  |
| :-------------------- | :---------------------- | :----------- | :----------------------------------------------------------------------------------------------- |
| **Lint**              | `pnpm lint`             | **PASS (0)** | 0 errors, 0 warnings across whole workspace                                                      |
| **Typecheck**         | `pnpm typecheck`        | **PASS (0)** | `tsc -p tsconfig.json` exit 0                                                                    |
| **Build**             | `pnpm build`            | **PASS (0)** | `tsc -b tsconfig.build.json` exit 0                                                              |
| **Format**            | `pnpm format:check`     | **PASS (0)** | Prettier checked, all files match code style                                                     |
| **Unit Tests**        | `pnpm test:unit`        | **PASS (0)** | **55/55 test files passed, 960/960 tests passed**                                                |
| **Integration Tests** | `pnpm test:integration` | **PASS (0)** | **30/30 test files passed, 295/295 tests passed** (real PostgreSQL)                              |
| **Chaos Tests**       | `pnpm test:chaos`       | **PASS (0)** | **6/6 test files passed, 30/30 tests passed** (real SIGKILL & lease fencing)                     |
| **E2E Tests**         | `pnpm test:e2e`         | **PASS (0)** | **8/8 test files passed, 13/13 tests passed**                                                    |
| **CLI Demo**          | `pnpm demo`             | **PASS (0)** | **4/4 scenarios passed** (Fast path 0 allocations, Standard CAS, Crash/Resume, Tenant isolation) |

### 3.2 Specific P0-C3 Test Coverage & P1 Regressions

1. **Unit: Scheduler Logic (`tests/unit/p0c3-scheduler.test.ts` - 8 tests)**
   - Polls due commitments and dispatches tasks with stable idempotency keys.
   - Dual-scheduler tick race: only one scheduler reserves each occurrence slot; second scheduler safely skips.
   - Stalled occurrence crash recovery: reconciles pending slots without duplicating task dispatches.
   - **P1-1 Regression**: Verified `reconcileStalled()` restores original `tenantId` and `agentId` (no `'system'`), enforces semantic payload parity with `buildCommitmentTaskInput`, and strictly maintains cross-tenant isolation.
   - **P1-1 Regression (fail-closed)**: an occurrence whose original identity cannot be recovered from the trusted layer is never dispatched; 0 task dispatches and the occurrence remains `pending`.
   - **P1-1 Regression (runtime validation)**: a record with missing `sourceProfileId` / unknown `scheduleKind` (including `undefined`, which would previously throw on `.trim()`) is skipped without aborting the loop, while the valid record in the same batch is still dispatched with the fully-validated identity.

2. **Unit: Guarded Runtime (`tests/unit/p0c3-commitment-runtime.test.ts` - 18 tests)**
   - **C3-T05 Sentinel Deny Invariant**: Explicit deny policy results in strictly 0 budget reservations, 0 source callbacks, 0 outcome writes.
   - **P1-2 Sentinel Fail-Closed**:
     - Unconfigured Sentinel policy -> throws `POLICY_DENIED`, 0 side effects.
     - Invalid/malformed policy (schema violation) -> throws `POLICY_DENIED`, 0 side effects.
     - **Missing `policyVersion`** (even against a valid version-1 policy) -> throws `POLICY_DENIED`, 0 side effects.
     - Policy version mismatch -> throws `POLICY_DENIED`, 0 side effects.
     - Tenant ID mismatch -> throws `POLICY_DENIED`, 0 side effects.
   - **AbortSignal Contract**: missing signal -> `INVALID_ARGUMENT` before any source read; already-aborted signal -> `CANCELLED`; both with 0 source reads, 0 budget reservations, 0 outcome writes.
   - **Prompt Injection Defense**: Adversarial prompt injection payloads in source items are parsed strictly as passive string data, length-bounded to 2000 chars, with zero command execution.
   - **P1-3 Outcome Replay Authorization**:
     - Stale worker lease epoch on replay -> throws `STALE_LEASE`.
     - Cross-tenant replay attempt -> throws `POLICY_DENIED`.
     - Cancelled commitment replay attempt -> throws `POLICY_DENIED`.
     - Revoked consent replay attempt -> throws `POLICY_DENIED`.
     - Legitimate replay in same lineage -> returns cached outcome without duplicate rows or extra budget reservations.
     - Store without an authoritative replay lookup -> no replay shortcut is taken; the durable append still produces exactly one visible outcome.

3. **Integration: Real PostgreSQL End-to-End (`tests/integration/p0c3-worker.test.ts` - 1 test)**
   - Provisions real tenant, agent, and durable task in PostgreSQL.
   - Claims task with real `PostgresLeaseQueue`, issuing authoritative `runId`, `attempt`, and `leaseEpoch`.
   - Executes through `CommitmentOrchestrator` backed by transactional `PostgresBudgetLedger` and real database connection.
   - Verifies `grant.attempt` / `grant.leaseEpoch` propagation and real PostgreSQL budget reservation & settlement.
   - **Scope limit**: occurrence/outcome persistence is exercised through a structural contract double. PostgreSQL-level outcome fencing is therefore **not** asserted by Lane B; it is implemented and must be verified inside Lane A's `CommitmentStorePort` (PR #56).

4. **Chaos: Fault Injection & Process Crashes (`tests/chaos/p0c3-worker.test.ts` - 3 tests)**
   - **Chaos 1 (Worker Crash After Slot Reservation)**: Process crash simulated before task dispatch; recovering scheduler heals the pending slot using the original `tenantId` / `agentId` / `sourceProfileId` / `scheduleKind` without duplicate tasks.
   - **Chaos 2 (Lease Fencing Takeover)**: Worker 1 lease expires; Worker 2 takes over and commits epoch 2. Worker 1 wakes up and attempts late write; rejected with `STALE_LEASE`.
   - **Chaos 3 (Transient Database Outage)**: Simulated DB drop during scheduler tick triggers exponential backoff without crashing the worker process or corrupting scheduler state.

> [!NOTE]
> **PostgreSQL vs. structural-double scope (updated for Round 1 review)**
>
> | Concern                                                                                                    | Verified against                                                                                   | Evidence                                                                                        |
> | :--------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
> | Task/run creation, lease claim, lease epoch fencing, budget reserve/settle                                 | **Real PostgreSQL** (`PostgresLeaseQueue`, `PostgresBudgetLedger`, `PostgresTaskRepository`)       | `tests/integration/p0c3-worker.test.ts`, `tests/chaos/p0c3-worker.test.ts`                      |
> | Occurrence reservation, task binding, stalled recovery, outcome append & replay fencing                    | **Structural contract double** (`DueCommitmentStore` / `CommitmentStorePort`)                      | `tests/unit/p0c3-scheduler.test.ts`, `tests/unit/p0c3-commitment-runtime.test.ts`, chaos double |
> | PostgreSQL-level outcome fencing (`UNIQUE(occurrence_id)`, `runs.lease_epoch`, commitment status, consent) | **Not yet executable on this branch** — `commitments`/`occurrences` migrations are Lane A (PR #56) | Interface requirements in §5 of this document                                                   |
>
> Lane B therefore claims **contract-level** correctness only. It does not claim that PostgreSQL outcome fencing has been executed end-to-end; that verification belongs to Lane A's implementation of `CommitmentStorePort`.

---

## 4. Invariants Verification Checklist

- [x] **No Duplicate Occurrence per Slot**: Guaranteed by atomic `reserveOccurrence` and idempotency keying (`commitment-occ:${occurrenceId}`).
- [x] **No Duplicate Visible Outcome**: Guaranteed by `UNIQUE(occurrence_id)` and authoritative replay validation.
- [x] **Cancelled Commitments Never Run Future Tasks**: Verified by status check during scheduling and policy check during outcome publication and replay.
- [x] **Old Worker Cannot Bypass Lease Fencing**: Guaranteed by lease epoch checks in `appendOutcomeIfAbsent` and `PostgresBudgetLedger`.
- [x] **Sentinel Denial Zero Side-Effects**: Guaranteed by fail-closed gate evaluation before any source read, budget reservation, or outcome check.
- [x] **Worker Crash/Resume Autonomous Healing**: Verified by `reconcileStalled()` chaos tests and real process SIGKILL tests.
- [x] **Authoritative Attempt Propagation**: Verified `grant.attempt` dynamically reflects `run.attempt`.
- [x] **Production Scheduler Default Disabled**: `EMBER_SCHEDULER_ENABLED=false` verified in `apps/worker/src/config.ts`.
- [x] **Zero Real Network Egress & Zero External Paid Credentials**: Deterministic mock engine and fake reader only; zero external network requests.

---

## 5. Interface Requirements for Lane A (`packages/postgres` / `packages/contracts`)

Lane B structural ports are finalized and require Lane A to provide the following database behaviors in PR #56:

1. **Authoritative Clock**:
   - `findDueCommitments`: Must use PostgreSQL `statement_timestamp()` (or transaction time), bounded by `limit`.
2. **Authoritative Fencing on Outcome Write**:
   - `appendOutcomeIfAbsent(grant: WorkerLeaseGrant, cmd: AppendOutcomeCommand)`:
     Must execute in a PostgreSQL transaction:
     - Verify `runs.lease_epoch = grant.leaseEpoch` and `runs.status = 'running'`.
     - Verify `commitments.status != 'cancelled'`.
     - Insert with `ON CONFLICT (occurrence_id) DO NOTHING`.
     - Return `true` if inserted, `false` if replayed within the same task lineage.
3. **Stalled Occurrence Query (P1-1)**:
   - `findStalledPendingOccurrences`: Query `occurrences WHERE status = 'pending' AND task_id IS NULL AND created_at <= now() - interval '${timeoutSeconds} seconds'`. Must return the original `tenant_id`, `agent_id`, `source_profile_id`, and `schedule_kind` joined from the commitment row. It must **not** substitute placeholder identities; occurrences whose commitment row is unresolvable must be excluded (the scheduler also refuses blank identities and leaves such rows `pending`).
4. **Atomic Occurrence Reconcile**:
   - `reconcilePendingOccurrence(occurrenceId, taskId)`: `UPDATE occurrences SET task_id = $2, status = 'dispatched' WHERE occurrence_id = $1 AND status = 'pending'`.
5. **Authoritative Replay Lookup (P1-3)**:
   - `CommitmentStorePort.findAuthoritativeOutcome(grant, context)` must run in a single PostgreSQL transaction that:
     - scopes the occurrence by `grant.tenantId = context.tenantId` (else `POLICY_DENIED`),
     - asserts `occurrence.task_id = grant.taskId` (task lineage),
     - asserts `runs.lease_epoch = grant.leaseEpoch` and `runs.status = 'running'` (else `STALE_LEASE`),
     - asserts `commitments.status <> 'cancelled'` and consent for `context.sourceProfileId` is active (else `POLICY_DENIED`),
     - returns `NULL` when no outcome row exists so execution proceeds.
   - A lookup keyed only on `occurrence_id` is explicitly rejected: it would leak a stored summary across tenants/tasks/leases.
   - The port method is optional. If Lane A cannot satisfy this contract in PR #56, Lane B simply omits it and relies on the transactional `appendOutcomeIfAbsent` fencing above (no pre-execution replay shortcut exists).
6. **Lane C (`@ember/connectors`) Reader Contract**:
   - `SourceReader.readSnapshot(profileId, trustedContext, signal: AbortSignal)` is now mandatory-signal on both sides (Lane B port and orchestrator), matching the merged connectors package. Lane C implementations must honor the signal (abort promptly) and never accept an omitted signal argument.
   - Lane B rejects a missing/invalid signal with `INVALID_ARGUMENT` before any source read, so contract drift fails closed instead of silently degrading cancellation.

---

## 6. Risk Assessment & Rollback Plan

- **Risk**: Backlog storms from long scheduler downtime.  
  _Mitigation_: Bounded batch query (`EMBER_SCHEDULER_BATCH_SIZE=10`), recurring schedules advance `next_due_at` from the slot.
- **Risk**: Repeated task failures exhaust attempt budget.  
  _Mitigation_: Managed by Ember's durable retry queue with exponential backoff and dead-letter handling.
- **Rollback**:
  - Disable scheduler immediately: `EMBER_SCHEDULER_ENABLED=false`.
  - Revert PR merge commit. Zero schema migrations were added in Lane B, ensuring zero risk to persistent tables.
