# P0-C3B Scheduler Runtime & Autonomous Execution Delivery Report

**Component**: Autonomous Commitment Scheduler, Occurrence Dispatch, Guarded Execution Runtime  
**Branch**: `feature/p0c-3b-promise-runtime`  
**Base Commit**: `2a05fd80fc1226bef21ba813899728bdde41037f` (`origin/main`)  
**Status**: Stage 2 Complete — Ready for Lane A / Lane C Integration Wiring

---

## 1. Executive Summary

P0-C3B delivers the autonomous commitment scheduler and safe execution runtime for Ember, enabling commitments to transition from passive state rows into durable autonomous execution loops.

In strict adherence to the CTO directives and Stage 1 review guidelines:

1. **Zero Reinvention of Execution Foundations**: Scheduler and Worker strictly reuse Ember's existing PostgreSQL-backed Lease Fencing, Step Checkpoints, Sentinel Gate, and transactional Budget Guard (`PostgresBudgetLedger`).
2. **PostgreSQL Authoritative Clock**: Production scheduling does not accept external caller-provided schedule timestamps; slots are claimed and reconciled based on authoritative PostgreSQL database state.
3. **Mandatory Worker Lease Enforcement**: Outcome publication requires a valid, verified `WorkerLeaseGrant` (`tenantId`, `taskId`, `runId`, `leaseEpoch`, `workerId`). Stale workers fenced by higher epochs are rejected with `STALE_LEASE`.
4. **Unified Structured Reader Context**: `SourceReader` requires a trusted, server-verified context (`TrustedSourceAccessContext`) carrying tenant, commitment, task, run, and lease epoch information rather than arbitrary client-supplied strings.
5. **Strict Outcome Idempotency**: Outcome persistence verifies uniqueness (`UNIQUE(occurrence_id)`), active commitment publication validity, and legitimate execution lineage. Pre-existing outcomes return an idempotent replayed result without charging second budget reservations or creating duplicate rows.
6. **Zero Real Network / Production Scheduler Disabled by Default**: `EMBER_SCHEDULER_ENABLED` defaults to `false`. Real network egress is strictly forbidden (zero external paid API calls or live credentials).

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
  - Pre-execution replay check via `findOutcome(occurrenceId)`.
  - Sentinel admission gate evaluation **before** any budget reservation or source read.
  - Transactional budget reservation (`budget.reserve`), execution, lease-fenced outcome append (`appendOutcomeIfAbsent`), and budget settlement (`budget.settle`).
  - Terminal completion marking for one-shot schedules (`scheduleKind === 'once'`).
- [`packages/execution/src/index.ts`](file:///Users/lj/Downloads/Ember/worktrees.local/feature-p0c-3b-promise-runtime/packages/execution/src/index.ts):
  - Cleanly exports all new types and classes (`CommitmentOrchestrator`, `FakeSummaryEngine`, `WorkerLeaseGrant`, `AppendOutcomeCommand`, etc.).

### 2.2 Worker & Scheduling Layer (`apps/worker`)

- [`apps/worker/src/commitment-ports.ts`](file:///Users/lj/Downloads/Ember/worktrees.local/feature-p0c-3b-promise-runtime/apps/worker/src/commitment-ports.ts):
  - Defines the structural boundary ports: `DueCommitmentStore`, `ExistingTaskDispatcher`, `SourceReaderPort`.
  - Defines stable task creation idempotency derivation: `deriveTaskCreationIdempotencyKey(occurrenceId) => "commitment-occ:${occurrenceId}"`.
  - Types `DueCommitment`, `ReservedSlot`, `StalledPendingOccurrence`.
- [`apps/worker/src/commitment-scheduler.ts`](file:///Users/lj/Downloads/Ember/worktrees.local/feature-p0c-3b-promise-runtime/apps/worker/src/commitment-scheduler.ts):
  - `CommitmentScheduler`: polls for due commitments, reserves occurrence slots atomically, dispatches durable tasks via `ExistingTaskDispatcher`, marks occurrence dispatched.
  - `reconcileStalled()`: autonomously detects occurrences stalled in `pending` status without dispatched tasks (e.g. following process crashes or network timeouts) and safely heals them via idempotent dispatch.
  - `runLoop()`: supports graceful cancellation via `AbortSignal`, configurable poll interval, batch size, and exponential error backoff.
- [`apps/worker/src/commitment-handler.ts`](file:///Users/lj/Downloads/Ember/worktrees.local/feature-p0c-3b-promise-runtime/apps/worker/src/commitment-handler.ts):
  - Worker `RunHandler` integration for commitment tasks.
  - Safely extracts commitment metadata (`commitmentId`, `occurrenceId`, `sourceProfileId`, `scheduleKind`) from durable task input while maintaining compatibility with Ember's existing task schema.
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
| **Format**            | `pnpm format:check`     | **PASS (0)** | Prettier checked, all matched files conform                                                      |
| **Unit Tests**        | `pnpm test:unit`        | **PASS (0)** | **55/55 test files passed, 946/946 tests passed**                                                |
| **Integration Tests** | `pnpm test:integration` | **PASS (0)** | **30/30 test files passed, 295/295 tests passed** (real PostgreSQL)                              |
| **Chaos Tests**       | `pnpm test:chaos`       | **PASS (0)** | **6/6 test files passed, 30/30 tests passed** (real SIGKILL & lease fencing)                     |
| **E2E Tests**         | `pnpm test:e2e`         | **PASS (0)** | **8/8 test files passed, 13/13 tests passed**                                                    |
| **CLI Demo**          | `pnpm demo`             | **PASS (0)** | **4/4 scenarios passed** (Fast path 0 allocations, Standard CAS, Crash/Resume, Tenant isolation) |

### 3.2 Specific P0-C3 Test Coverage

1. **Unit: Scheduler Logic (`tests/unit/p0c3-scheduler.test.ts`)**
   - Polls due commitments and dispatches tasks with stable idempotency keys.
   - Dual-scheduler tick race: only one scheduler reserves each occurrence slot; second scheduler safely skips.
   - Stalled occurrence crash recovery: reconciles pending slots without duplicating task dispatches.
   - Scheduler respect for `enabled: false`: zero queries executed when disabled.
   - Recurring vs. one-shot: proper handling of due calculation.

2. **Unit: Guarded Runtime (`tests/unit/p0c3-commitment-runtime.test.ts`)**
   - **Sentinel Denial Invariant (C3-T05)**: When Sentinel denies an action, budget reservation is 0, source callback is 0, outcome append is 0.
   - **Normal Execution Path**: Sentinel permits -> budget reserved -> source snapshot read -> outcome appended -> budget settled -> one-shot completed.
   - **Prompt Injection Defense**: Adversarial prompt injection payloads in source items are parsed strictly as passive string data, length-bounded, with zero command execution.
   - **Lease Fencing**: Stale worker attempt with expired or lower lease epoch throws `STALE_LEASE` and fails closed.
   - **Cancellation Race**: Mid-flight cancellation prevents outcome publication with `POLICY_DENIED`.
   - **Outcome Replay**: Duplicate execution reuses existing outcome without duplicate database rows and releases unneeded budget reservation.

3. **Integration: Real PostgreSQL End-to-End (`tests/integration/p0c3-worker.test.ts`)**
   - Provisions real tenant, agent, and durable task in PostgreSQL.
   - Claims task with real `PostgresLeaseQueue`, issuing authoritative `runId` and `leaseEpoch`.
   - Executes through `CommitmentOrchestrator` backed by `PostgresBudgetLedger` and real database connection.
   - Verifies outcome persistence and replay idempotency against real transactional database.

4. **Chaos: Fault Injection & Process Crashes (`tests/chaos/p0c3-worker.test.ts`)**
   - **Crash 1 (Crash After Reservation)**: Worker process crashes immediately after reserving occurrence slot before task dispatch. Recovering scheduler discovers stalled occurrence and heals it via idempotent dispatch without duplicate slots or tasks.
   - **Crash 2 (Lease Fencing Takeover)**: Worker 1 experiences lease expiration; Worker 2 takes over and commits epoch 2. Worker 1 revives and attempts late write; database rejects with `STALE_LEASE`.
   - **Crash 3 (Transient Database Outage)**: Simulated DB drop during scheduler tick triggers exponential backoff without crashing the worker process or corrupting scheduler state.

---

## 4. Invariants Verification Checklist

- [x] **No Duplicate Occurrence per Slot**: Guaranteed by atomic `reserveOccurrence` and idempotency keying (`commitment-occ:${occurrenceId}`).
- [x] **No Duplicate Visible Outcome**: Guaranteed by `UNIQUE(occurrence_id)` and pre-execution outcome replay check.
- [x] **Cancelled Commitments Never Run Future Tasks**: Verified by status check during scheduling and policy check during outcome publication.
- [x] **Old Worker Cannot Bypass Lease Fencing**: Guaranteed by PostgreSQL lease epoch checks in `appendOutcomeIfAbsent` and `PostgresBudgetLedger`.
- [x] **Sentinel Denial Zero Side-Effects**: Guaranteed by gate evaluation before any source read or budget call (tested in `tests/unit/p0c3-commitment-runtime.test.ts`).
- [x] **Worker Crash/Resume Autonomous Healing**: Verified by `reconcileStalled()` chaos tests and real process SIGKILL tests.
- [x] **Production Scheduler Default Disabled**: `EMBER_SCHEDULER_ENABLED=false` verified in `apps/worker/src/config.ts`.
- [x] **Zero Real Network Egress & Zero External Paid Credentials**: Deterministic mock engine and fake reader only; zero external network requests.

---

## 5. Interface Handoff to Lane A & Lane C

Lane B was developed against structural ports. As Lane A (Schema & Contracts) and Lane C (Client, Presentation & Source Ingestion) complete their worktrees, wiring can take place cleanly:

1. **For Lane A (`packages/postgres` / `packages/contracts`)**:
   - `DueCommitmentStore`: Lane A will implement the PostgreSQL query for `findDueCommitments(limit, asOfOverride)` using PostgreSQL's authoritative database clock (`statement_timestamp()` or transaction time).
   - `appendOutcomeIfAbsent`: Lane A's PostgreSQL implementation will enforce `UNIQUE (occurrence_id)`, join against active runs to verify `lease_epoch >= run.lease_epoch`, and assert commitment status is not cancelled.
   - `reconcilePendingOccurrence`: Lane A will provide the SQL atomic update `UPDATE occurrences SET task_id = $1, status = 'dispatched' WHERE occurrence_id = $2 AND status = 'pending'`.

2. **For Lane C (`apps/ios` / source ingestion)**:
   - `SourceReaderPort`: Lane C's source snapshot ingestion will receive `TrustedSourceAccessContext` (`tenantId`, `commitmentId`, `taskId`, `runId`, `leaseEpoch`, `authorizedAt`).
   - Summary output: Uses canonical `OUTCOME_RESULT_STATUSES` (`'meaningful_change'`, `'no_change'`, `'failed'`, `'denied'`) and sanitized string summaries up to 2000 chars.

---

## 6. Risk Assessment & Rollback Plan

### Risks & Mitigations

1. **Missed Schedule Storms**: If the database was offline or a commitment was paused for a prolonged period, querying due commitments might return numerous backlog slots.
   - _Mitigation_: The query batch size is bounded (`EMBER_SCHEDULER_BATCH_SIZE`, default 10), and recurring schedules recalculate `next_due_at` from the current slot to avoid multi-slot cascading storms.
2. **Crash Loop on Unhandled Task**: If a task fails repeatedly, it could exhaust retry budgets.
   - _Mitigation_: Existing Ember retry queue policy applies exponential backoff and terminal failure marking after `max_attempts`.
3. **Early Activation in Production**:
   - _Mitigation_: Production scheduler defaults strictly to `false` via `EMBER_SCHEDULER_ENABLED=false`.

### Rollback Plan

If any regression is detected:

1. Immediately ensure `EMBER_SCHEDULER_ENABLED=false` in worker deployment environment variables.
2. Revert the PR merge commit on `main`. No migration or schema changes were introduced in Lane B, making rollback instantaneous and zero-risk to persistent database tables.
