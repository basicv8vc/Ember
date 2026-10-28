-- P0B-04: durable Worker leasing, fencing and bounded retry.
--
-- This is an additive, forward-only migration. The already-applied 0001–0003 files are
-- immutable; their checksums are verified by the migration runner.
--
-- 1. `lease_epoch` is exposed to TypeScript as a JavaScript number. Reject values that a
--    double cannot represent exactly so fencing can never be bypassed by precision loss.
-- 2. At most one *active* Run may exist per Task. Terminal Runs are allowed to accumulate
--    as audit history. Claims insert a Run as `created` and immediately transition it to
--    `running` in the same transaction while holding the Task row lock, so this partial
--    unique index is compatible with the Run lifecycle in @ember/domain.
-- 3. Deterministic claim ordering uses `(status, next_run_at, created_at, id)`.
-- 4. Deadline scans only need non-terminal Tasks with a deadline.

ALTER TABLE tasks
  ADD CONSTRAINT tasks_lease_epoch_safe_int_check
  CHECK (lease_epoch <= 9007199254740991);

ALTER TABLE runs
  ADD CONSTRAINT runs_lease_epoch_safe_int_check
  CHECK (lease_epoch <= 9007199254740991);

CREATE UNIQUE INDEX runs_one_active_per_task_idx
  ON runs (tenant_id, task_id)
  WHERE status IN ('created', 'running');

CREATE INDEX tasks_claim_order_idx
  ON tasks (status, next_run_at, created_at, id);

CREATE INDEX tasks_deadline_open_idx
  ON tasks (deadline_at)
  WHERE deadline_at IS NOT NULL
    AND status IN ('queued', 'retryable_failed', 'running');
