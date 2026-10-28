-- P0B-03 follow-up (PR #3 P1-1): make tasks.current_run_id tenant-safe and
-- task-safe at the database layer.
--
-- `tasks.current_run_id` is nullable and P0B-03 never sets it. P0B-04 will point it at a
-- run that belongs to the same tenant *and the same task*. The composite foreign key
-- compares (tenant_id, task_id, run_id) against runs(tenant_id, task_id, id), so a
-- cross-tenant run and a run from another task in the same tenant are both rejected.
--
-- The run must exist before the task pointer is updated; creating a task always starts
-- with current_run_id = NULL, so this does not introduce a circular insert requirement.
-- Deleting a referenced run is restricted: a future run-cleanup path must clear the task
-- pointer first (P0B-04).

ALTER TABLE runs
  ADD CONSTRAINT runs_tenant_task_id_key UNIQUE (tenant_id, task_id, id);

ALTER TABLE tasks
  ADD CONSTRAINT tasks_current_run_fk
  FOREIGN KEY (tenant_id, id, current_run_id)
  REFERENCES runs (tenant_id, task_id, id)
  ON DELETE RESTRICT;

-- Supports the referencing side of the composite FK during run deletion checks.
CREATE INDEX tasks_current_run_idx
  ON tasks (tenant_id, current_run_id)
  WHERE current_run_id IS NOT NULL;
