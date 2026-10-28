# ADR-0002 — Pre-claim Deadline/Budget Failure (`queued → failed`)

- **Status:** Accepted with conditions (CTO P0B-04 Review Round 1, OQ-2)
- **Decision date:** 2026-10-28
- **Owner:** Ember Architecture / CTO
- **Decision:** OQ-2 — permit exactly one additive edge, `queued → failed`, only when a Task cannot be claimed
- **Scope:** P0B-04 durable scheduling; cancellation remains governed by ADR-0001
- **Supersedes:** The OQ-2 proposal placeholder in the P0B-04 implementation draft

## Context

The Task state machine had no legal way to terminalize a Task that is already past its deadline before any Run is claimed. The only alternatives were:

1. fabricate a `queued → running` transition and a Run that never existed; or
2. leave the Task in the queue forever while claiming Deadline acceptance passed.

Both are unacceptable. A Task that can never be claimed must converge to a terminal state without creating an execution attempt.

## Decision

Add **only** the edge `queued → failed` to the Task transition graph. It is a pre-claim failure path, not a general shortcut and not a replacement for `running → failed`.

### 1. Permitted conditions

The edge may be used only when the Task is not claimable for one of these reasons:

- `deadline_at` has already elapsed at the time the Claim or Reaper transaction holds the Task row lock; or
- the execution/attempt budget is already exhausted (`attempt_count >= max_attempts`) and no legal Run can be created.

It may not be used for a Task that has an active Run, for a business execution result, for a normal terminal failure of a Run, or to hide an internal error/corruption. `retryable_failed → failed` remains the existing legal edge for already-created failed attempts.

### 2. Mandatory preconditions

Under a Task row lock, the writer must verify:

- Task status is `queued` (the `retryable_failed` variant uses its existing edge);
- `cancel_requested_at IS NULL`; cancellation priority in ADR-0001 applies first;
- no `created` or `running` Run exists for the Task;
- the failure condition is still true after the lock is acquired;
- no Run, lease, attempt increment or epoch increment is created.

No in-memory-only transition is sufficient. The state update and its event must commit in the same transaction as all related authoritative writes.

### 3. Cancellation priority

If a committed `cancel_requested_at` is visible while the Task row is locked:

- transition `queued → cancelled`, not `queued → failed`;
- append the single `cancelled` terminal event;
- never schedule a retry or create a Run.

ADR-0001's cancellation semantics take precedence over deadline/budget failure.

### 4. Failure event

Every use of `queued → failed` appends exactly one `failed` event with:

- `fromStatus = "queued"`;
- `toStatus = "failed"`;
- `errorCode = "DEADLINE_EXCEEDED"` when the deadline has elapsed;
- no fabricated error code for an attempt-budget-only failure unless a stable domain code is later defined.

The event payload must pass the existing Zod and PostgreSQL allowlists. No prompt, free text, SQL, stack or host path is allowed.

### 5. Prohibitions

- No fabricated Run and no fake `queued → running` transition.
- No new Run after this edge commits.
- No attempt-count or lease-epoch change solely to bypass the state machine.
- No use of `queued → failed` for a currently running Task; that path remains `running → failed`.
- No same-state assignment or implicit no-op.
- Terminal states remain immutable.

## Consequences

- The Claim path and the Reaper may converge an unclaimable queued Task to `failed` under the Task row lock.
- Deadline expiry during a run still uses `running → failed`; only pre-claim expiry uses this edge.
- Retry exhaustion after a Run uses the existing `running`/`retryable_failed → failed` paths.
- The TaskStatus vocabulary and database CHECK remain unchanged because `failed` already exists.
- The complete 7×7 Task matrix is updated and all unrelated edges remain rejected.

## Implementation

- `TASK_TRANSITION_TABLE.queued` includes `failed`.
- `PostgresLeaseQueue.claimNext` checks the locked Task and calls the pre-claim convergence path; the Reaper has the same open-deadline scan.
- Failure events are appended through `appendTaskEvent` under the Task row lock.
- Tests cover: pre-claim deadline, attempt-budget exhaustion, cancellation precedence, no Run creation, unchanged attempt/epoch, and all negative state-machine edges.

## References

- ADR-0001 — Cancellation and Retry Coordination
- P0B-04 implementation and acceptance documents
- P0B-02 Task/Run state machines
