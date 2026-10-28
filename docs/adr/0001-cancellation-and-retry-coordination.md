# ADR-0001 — Cancellation and Retry Coordination

- **Status:** Accepted
- **Decision date:** 2026-10-28
- **Owner:** Ember Architecture / CTO
- **Decision:** OQ-1 — allow `retryable_failed → cancelled`
- **Scope:** P0-B; implementation starts in P0B-04 (durable scheduling) and continues through P0B-08 (external cancellation API)
- **Supersedes:** The OQ-1 open question in P0B-02/P0B-03 documentation. Existing, already-applied migrations are immutable.

## Context

Ember's P0B-02 Task state machine currently permits `retryable_failed → queued | failed`, but not direct cancellation. P0B-03 persists `tasks.cancel_requested_at` without applying cancellation. P0B-04 will introduce multiple workers, durable leases, a retry scheduler and a reaper. Without a documented ordering rule, a cancellation can race with retry scheduling, task claim, worker completion or lease expiry and unexpectedly create another Run or overwrite the desired final status.

We need an explicit policy that remains correct after process restarts and with multiple independent workers. PostgreSQL is the authoritative coordination point; process-local cancellation flags and worker memory are only best-effort aids.

## Decision

**OQ-1 is resolved: `retryable_failed → cancelled` is a legal Task transition.** This is an additive change to the P0B-02 Task transition graph. No other previously prohibited transition becomes legal.

### 1. Task status and cancellation intent

| Current Task status                | Behavior after an authorized cancellation request                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`                           | Atomically record cancellation intent and transition to `cancelled`; do not claim.                                                            |
| `retryable_failed`                 | Atomically record cancellation intent and transition directly to `cancelled`; do not requeue.                                                 |
| `waiting_approval`                 | Atomically record cancellation intent and transition to `cancelled`; pending approval must not resurrect the Task.                            |
| `running`                          | Atomically record cancellation intent, keep `running` until the active Run is resolved by the worker or reaper, and prohibit further retries. |
| `completed`, `failed`, `cancelled` | Idempotent terminal no-op: leave status, timestamps, final result and events unchanged.                                                       |

- `tasks.cancel_requested_at` is a **monotonic, write-once intent** while the Task is nonterminal. Repeated requests must not overwrite it, create duplicate events or reset retry schedules.
- Idempotent cancellation requests are API/repository semantics, **not** same-state Task FSM transitions. The existing FSM rule rejecting `cancelled → cancelled` remains unchanged.
- A caller may cancel only a Task visible in its trusted Tenant-scoped authorization context. Missing and foreign-tenant IDs remain indistinguishable to the caller.
- The Task's final status must be committed through the domain state machine and in the same database transaction as related authoritative Run and event updates.

### 2. Cancellation has priority over scheduling

The **database-committed cancellation intent** takes priority over any not-yet-committed scheduling or retry decision.

- A claim or retry/requeue transaction must lock and recheck the Task row and require `cancel_requested_at IS NULL` before creating or selecting a new Run.
- Once cancellation has committed, **no new Run may be created** for that Task; a previously committed active Run may still exist and must be resolved.
- A `retryable_failed` Task must follow legal edges `retryable_failed → queued → running` when scheduling the next attempt. Direct `retryable_failed → running` is prohibited even when implemented in one database transaction.
- Claim readiness requires the approved status, due `next_run_at`, retry budget and deadline conditions. A cancellation request may not be bypassed by a due timer or a cached task list.
- Scheduling must remain transactional and safe with multiple Worker processes; PostgreSQL row locks, conditional updates and fencing enforce correctness. An in-process mutex is not sufficient.

### 3. Running cancellation: cooperative execution, authoritative finalization

When a cancellation request commits while the Task is `running`:

1. Persist `cancel_requested_at` without assuming that the remote execution has already stopped.
2. On the worker's next cancellation observation (including heartbeat), stop renewing the lease and attempt to abort the running operation cooperatively.
3. Only a worker holding the **current, unexpired, matching Run/lease epoch** may finalize the Run; if cancellation intent is present when its finalization transaction acquires the Task lock, it cannot commit a Task success/failure/retry instead. Use a valid Run terminal outcome (typically `cancelled`) and Task `cancelled`.
4. If the worker crashes, cannot be contacted or fails to stop, the lease eventually expires. The reaper marks that Run `lease_expired` and resolves the Task as `cancelled`, **not** as `retryable_failed` or a fresh attempt, whenever the cancellation intent is visible.
5. A stale worker, after lease expiry or epoch replacement, cannot change the Task, Run, events, workspace or any authoritative result. Fencing checks occur inside the same transaction as state changes.

Stopping a local process or external request is best-effort; the guarantee is a durable, eventually terminal Task state, bounded by lease expiry/reaper progress, not instantaneous physical termination.

### 4. Race ordering is determined by database serialization

Take a Task-level row lock (`SELECT … FOR UPDATE` or an equivalent atomic conditional write) for each competing cancellation, claim, requeue, finish and reaper transition. Evaluate predicates **after** acquiring the relevant locks; each path uses a consistent lock order to avoid deadlocks.

| Race                                                            | Required result                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Cancel commits before claim/requeue                             | Claim/requeue fails or skips; no new Run is created.                                                            |
| Claim commits before cancel                                     | Its new Run is valid; cancellation records intent on `running`, and the Run must subsequently cancel or expire. |
| Cancel commits before worker finish                             | Worker finish may not commit `completed`, `failed` or a retry; resolve cancellation if lease/fencing permits.   |
| Worker finish commits a terminal Task before cancel             | Task stays terminal; later cancel is an idempotent no-op.                                                       |
| Cancel commits before retry timer fires                         | Retry scheduler skips; Task becomes/stays `cancelled`.                                                          |
| Cancel commits before reaper handles expired Run                | Reaper resolves the expired Run and leaves the Task `cancelled`; it may not requeue.                            |
| Reaper/retry/deadline terminal transition commits before cancel | The already-committed terminal status wins; later cancellation is a no-op.                                      |

If cancellation and expiry/retry conditions are both visible **at the time a transaction holds the Task lock**, apply cancellation first. Terminal states are immutable; never rewrite a previously committed `completed`/`failed` outcome.

### 5. Events, lease safety and persistence rules

- `accepted` stays sequence 1. Each actual Task transition appends a valid, schema-checked, allowlisted event atomically with the Task update; allocate sequence under Task-level serialization.
- For a Task, the `cancelled` terminal transition and its event occur **at most once**. A mere repeated cancellation request must not append duplicate terminal events.
- Do not store prompts, credentials, tokens, arbitrary exception text or file contents in state-transition event payloads or logs.
- A Run is never restarted after reaching `succeeded`, `failed_retryable`, `failed_terminal`, `lease_expired` or `cancelled`. A new retry is a fresh Run with a fresh lease epoch/attempt.
- Deadline expiry, maximum attempts and retry backoff do not override an already-committed cancellation intent. Other ambiguous deadline-only edges are **not** decided by this ADR.
- Existing tenant-safe foreign keys, idempotent Task creation, immutable migration history and the P0B-02 domain/contracts boundaries remain in force.

## Consequences and implementation plan

1. **P0B-04:** Add `retryable_failed → cancelled` to `TASK_TRANSITION_TABLE`; update associated exhaustive tests and obsolete OQ-1 comments. Implement atomic repository cancellation semantics, lease claim/heartbeat/finish/reaper/fencing, bounded retry and cancellation-first scheduling. Use additive migrations only where required.
2. **P0B-08:** Expose the authorized cancellation API and cooperative cancellation at the orchestration boundary; preserve this ADR's persistence and idempotency semantics.
3. Update documentation describing OQ-1 as open to reference this accepted ADR, without rewriting historical acceptance evidence or old migrations.
4. Do not introduce real LLM execution, cloud sandbox, paid deployment, HTTP/SSE features or unrelated Task transitions as part of this design decision.

This ADR records **approved behavior**, not a claim that the repository already implements it.

## Minimum acceptance tests (real PostgreSQL where concurrency matters)

- FSM unit tests permit `retryable_failed → cancelled` and continue to reject all unrelated invalid edges and same-state assignments.
- `queued`, `retryable_failed` and `waiting_approval` cancel atomically, producing one terminal transition/event; repeated requests are idempotent.
- Concurrent cancel-versus-claim and cancel-versus-retry with independent connections: **no Run appears after cancellation commits**.
- Claim-first-then-cancel: running Task records intent; worker stops renewal and cannot finalize success after observing cancellation; current valid Run can finalize as cancelled.
- Cancel-versus-worker-finish in both commit orders; winning terminal outcome never regresses.
- Cancel-versus-lease-expiry/reaper: the Run expires but no retry is scheduled; Task ends `cancelled`.
- Stale epoch/expired lease rejects heartbeat and finish; cancellation does not weaken fencing.
- Concurrent duplicate cancellation and crashes/restarts do not create duplicate terminal events or duplicate Runs.
- Cross-Tenant cancellation does not reveal or mutate another Tenant's Task.
- CI and local integration tests exercise transactional behavior; mocked in-process ordering alone does not satisfy the race criteria.

## References

- Personal Agent Platform Architecture RFC v0.2
- P0-B Minimum Vertical Slice engineering specification
- P0B-02 domain Task/Run state machines and contracts
- P0B-03 durable Task inbox / `tasks.cancel_requested_at`
- P0B-04 Worker/Lease/Fencing engineering task prompt
