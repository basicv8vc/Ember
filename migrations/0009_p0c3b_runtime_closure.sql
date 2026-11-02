-- P0-C3B runtime closure indexes.
--
-- Additive migration only. Lane C's merged implementation has no durable Consent schema or
-- transactional revocation path, so this migration deliberately does not create a consent
-- table. Outcome publication stays fail-closed until that upstream persistence contract exists.

-- The Occurrence lookup is used to resolve the Task claimed by a Worker.
CREATE INDEX IF NOT EXISTS occurrences_tenant_task_idx
  ON commitment_occurrences (tenant_id, task_id)
  WHERE task_id IS NOT NULL;

-- Terminal reconciliation sweeps dispatched occurrences whose Task already finished.
CREATE INDEX IF NOT EXISTS occurrences_dispatched_reap_idx
  ON commitment_occurrences (updated_at)
  WHERE status = 'dispatched';
