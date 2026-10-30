-- 0007_p0b08d_persistent_mock_approval.sql
-- P0B-08d: Persistent Mock Approval repository, state transition guards, and expiry indexes.
--
-- Additive migration only. Existing migrations 0001-0006 are immutable.

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL,
  lease_epoch bigint NOT NULL,
  action_digest text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approvals_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT approvals_task_action_digest_unique UNIQUE (tenant_id, task_id, action_digest),
  CONSTRAINT approvals_lease_epoch_bounds_check CHECK (
    lease_epoch >= 1 AND lease_epoch <= 9007199254740991
  ),
  CONSTRAINT approvals_action_digest_hex_check CHECK (action_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT approvals_status_check CHECK (
    status IN ('pending', 'approved', 'denied', 'expired')
  ),
  CONSTRAINT approvals_decision_timestamps_check CHECK (
    (status = 'pending' AND decided_at IS NULL)
    OR (status IN ('approved', 'denied', 'expired') AND decided_at IS NOT NULL)
  ),
  CONSTRAINT approvals_expires_after_created_check CHECK (expires_at > created_at),
  CONSTRAINT approvals_task_tenant_fk FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT approvals_run_tenant_fk FOREIGN KEY (tenant_id, task_id, run_id)
    REFERENCES runs (tenant_id, task_id, id) ON DELETE RESTRICT
);

-- At most one pending approval may exist for a Task at any point in time.
CREATE UNIQUE INDEX approvals_one_pending_per_task_idx
  ON approvals (tenant_id, task_id)
  WHERE status = 'pending';

-- Supports bounded Reaper sweeps for pending approvals that have passed expires_at.
CREATE INDEX approvals_pending_expiry_idx
  ON approvals (expires_at, id)
  WHERE status = 'pending';

-- Supports tenant-scoped lookup of approvals for a Task in deterministic creation order.
CREATE INDEX approvals_tenant_task_created_idx
  ON approvals (tenant_id, task_id, created_at DESC, id DESC);

-- Supports Reaper sweeps of Tasks parked in waiting_approval (expiry, deadline, cancellation).
CREATE INDEX tasks_waiting_approval_reap_idx
  ON tasks (id)
  WHERE status = 'waiting_approval';

-- Enforce identity immutability and one-way transition from pending -> approved/denied/expired.
CREATE FUNCTION ember_enforce_approval_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch
     OR NEW.action_digest IS DISTINCT FROM OLD.action_digest
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'approval identity and expiry fields are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'pending' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'terminal approval status % cannot be overwritten by %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER approvals_enforce_transition_trigger
  BEFORE UPDATE ON approvals
  FOR EACH ROW
  EXECUTE FUNCTION ember_enforce_approval_transition();
