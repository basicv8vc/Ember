-- 0008_p0c3_commitments.sql
-- P0-C3A: Durable Commitment, Occurrence, and Outcome storage with tenant isolation,
-- optimistic concurrency (CAS), and idempotent scheduling slots.
--
-- Additive migration only. Existing migrations 0001-0007 are immutable.

CREATE TABLE IF NOT EXISTS commitments (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  agent_id            uuid        NOT NULL,
  title               text        NOT NULL,
  status              text        NOT NULL DEFAULT 'active',
  schedule_kind       text        NOT NULL,
  interval_seconds    integer,
  next_due_at         timestamptz,
  source_profile_id   text        NOT NULL,
  version             integer     NOT NULL DEFAULT 1,
  idempotency_key     text,
  request_fingerprint text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commitments_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT commitments_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT commitments_agent_tenant_fk FOREIGN KEY (tenant_id, agent_id)
    REFERENCES agents (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT commitments_title_length_check CHECK (
    char_length(title) >= 1 AND char_length(title) <= 140
  ),
  CONSTRAINT commitments_status_check CHECK (
    status IN ('active', 'paused', 'completed', 'cancelled')
  ),
  CONSTRAINT commitments_schedule_kind_check CHECK (
    schedule_kind IN ('once', 'interval')
  ),
  CONSTRAINT commitments_interval_bounds_check CHECK (
    (schedule_kind = 'once' AND interval_seconds IS NULL) OR
    (schedule_kind = 'interval' AND interval_seconds >= 900 AND interval_seconds <= 2592000)
  ),
  CONSTRAINT commitments_source_profile_format_check CHECK (
    source_profile_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
  ),
  CONSTRAINT commitments_version_positive_check CHECK (version >= 1)
);

-- Index for due work discovery by scheduler using authoritative DB clock
CREATE INDEX IF NOT EXISTS commitments_due_scheduling_idx
  ON commitments (next_due_at)
  WHERE status = 'active' AND next_due_at IS NOT NULL;

-- Index for tenant-scoped listing in reverse chronological order
CREATE INDEX IF NOT EXISTS commitments_tenant_listing_idx
  ON commitments (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS commitment_occurrences (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  commitment_id uuid        NOT NULL,
  scheduled_for timestamptz NOT NULL,
  task_id       uuid,
  status        text        NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT occurrences_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT occurrences_tenant_commitment_fk FOREIGN KEY (tenant_id, commitment_id)
    REFERENCES commitments (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT occurrences_unique_slot UNIQUE (commitment_id, scheduled_for),
  CONSTRAINT occurrences_status_check CHECK (
    status IN ('pending', 'dispatched', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT occurrences_task_tenant_fk FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id) ON DELETE RESTRICT
);

-- Index for occurrence history for a commitment
CREATE INDEX IF NOT EXISTS occurrences_commitment_order_idx
  ON commitment_occurrences (commitment_id, scheduled_for DESC);

-- Index for orphan pending occurrence sweeps during crash recovery
CREATE INDEX IF NOT EXISTS occurrences_pending_reap_idx
  ON commitment_occurrences (created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS commitment_outcomes (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  commitment_id uuid        NOT NULL,
  occurrence_id uuid        NOT NULL,
  task_id       uuid        NOT NULL,
  summary       text        NOT NULL,
  result_status text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outcomes_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT outcomes_tenant_commitment_fk FOREIGN KEY (tenant_id, commitment_id)
    REFERENCES commitments (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT outcomes_tenant_occurrence_fk FOREIGN KEY (tenant_id, occurrence_id)
    REFERENCES commitment_occurrences (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT outcomes_tenant_task_fk FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT outcomes_occurrence_unique UNIQUE (occurrence_id),
  CONSTRAINT outcomes_summary_length_check CHECK (
    char_length(summary) >= 1 AND char_length(summary) <= 2000
  ),
  CONSTRAINT outcomes_result_status_check CHECK (
    result_status IN ('meaningful_change', 'no_change', 'failed', 'denied')
  )
);

-- Index for user inbox chronological outcome queries
CREATE INDEX IF NOT EXISTS outcomes_commitment_order_idx
  ON commitment_outcomes (commitment_id, created_at DESC, id DESC);
