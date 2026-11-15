-- 0020_b3_notes_action_items.sql
-- B3-A1: Notes -> Action Items delegation & durable execution. Additive only; 0001-0019 are immutable.
--
-- Scope:
--   * Widen `tasks.kind` CHECK to allow `'notes.action_items'` and add nullable `tasks.title`.
--   * Update `ember_task_event_payload_is_valid` allowlist for `'notes.action_items'`.
--   * Add partial unique index preventing duplicate `outcome_reference` rows per `(tenant_id, task_id)`.
--   * Add optional `task_id` attribution on `model_budget_incidents` (not an FK so evidence survives deletion).
--   * Add `task_model_attempts`: per-Task persistent model attempt & budget ledger spanning retries/Runs,
--     separate from `model_turn_attempts` while sharing global and tenant daily money buckets.

-- ---------------------------------------------------------------------------
-- 1. Widen tasks.kind and add optional bounded tasks.title.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS title text;

DO $$
DECLARE
  kind_constraint record;
BEGIN
  FOR kind_constraint IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'tasks'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%mock.chat%'
  LOOP
    EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', kind_constraint.conname);
  END LOOP;

  ALTER TABLE tasks
    ADD CONSTRAINT tasks_kind_check CHECK (
      kind IN ('mock.chat', 'mock.compute', 'mock.file', 'mock.approval', 'notes.action_items')
    );

  ALTER TABLE tasks
    DROP CONSTRAINT IF EXISTS tasks_title_check;
  ALTER TABLE tasks
    ADD CONSTRAINT tasks_title_check CHECK (
      title IS NULL OR (char_length(title) BETWEEN 1 AND 128 AND btrim(title) <> '')
    );
END $$;

-- ---------------------------------------------------------------------------
-- 2. Extend the closed task_events payload validator for 'notes.action_items'.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ember_task_event_payload_is_valid(payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry record;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
    RETURN false;
  END IF;

  FOR entry IN SELECT key, value FROM jsonb_each(payload) LOOP
    CASE entry.key
      WHEN 'taskKind' THEN
        IF jsonb_typeof(entry.value) <> 'string'
           OR (entry.value #>> '{}') NOT IN (
             'mock.chat', 'mock.compute', 'mock.file', 'mock.approval', 'notes.action_items'
           ) THEN
          RETURN false;
        END IF;
      WHEN 'route' THEN
        IF jsonb_typeof(entry.value) <> 'string'
           OR (entry.value #>> '{}') NOT IN ('fast', 'standard', 'heavy') THEN
          RETURN false;
        END IF;
      WHEN 'fromStatus', 'toStatus' THEN
        IF jsonb_typeof(entry.value) <> 'string'
           OR (entry.value #>> '{}') NOT IN (
             'queued', 'running', 'waiting_approval', 'retryable_failed',
             'completed', 'failed', 'cancelled'
           ) THEN
          RETURN false;
        END IF;
      WHEN 'runStatus' THEN
        IF jsonb_typeof(entry.value) <> 'string'
           OR (entry.value #>> '{}') NOT IN (
             'created', 'running', 'succeeded', 'failed_retryable',
             'failed_terminal', 'lease_expired', 'cancelled'
           ) THEN
          RETURN false;
        END IF;
      WHEN 'errorCode' THEN
        IF jsonb_typeof(entry.value) <> 'string'
           OR (entry.value #>> '{}') NOT IN (
             'INVALID_ARGUMENT', 'UNAUTHENTICATED', 'NOT_FOUND', 'POLICY_DENIED',
             'BUDGET_EXCEEDED', 'IDEMPOTENCY_CONFLICT', 'WORKSPACE_VERSION_CONFLICT',
             'STALE_LEASE', 'DB_UNAVAILABLE', 'SANDBOX_NOT_READY', 'EXECUTION_TIMEOUT',
             'MOCK_TOOL_FAILED', 'DEADLINE_EXCEEDED', 'CANCELLED',
             'INVALID_STATE_TRANSITION'
           ) THEN
          RETURN false;
        END IF;
      WHEN 'runId', 'artifactId', 'sandboxId' THEN
        IF jsonb_typeof(entry.value) <> 'string'
           OR (entry.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RETURN false;
        END IF;
      WHEN 'attempt', 'workspaceVersion', 'durationMs', 'policyVersion' THEN
        IF jsonb_typeof(entry.value) <> 'number'
           OR (entry.value #>> '{}') !~ '^(0|[1-9][0-9]*)$' THEN
          RETURN false;
        END IF;
      WHEN 'replayed', 'cancelRequested', 'simulated' THEN
        IF jsonb_typeof(entry.value) <> 'boolean' THEN
          RETURN false;
        END IF;
      ELSE
        RETURN false;
    END CASE;
  END LOOP;

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. At most one outcome_reference message per Task in conversation_messages.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_outcome_task_unique
  ON conversation_messages (tenant_id, ((outcome ->> 'task_id')))
  WHERE kind = 'outcome_reference' AND (outcome ? 'task_id');

-- ---------------------------------------------------------------------------
-- 4. Optional Task attribution on durable model budget incidents.
-- ---------------------------------------------------------------------------

ALTER TABLE model_budget_incidents
  ADD COLUMN IF NOT EXISTS task_id uuid;

-- ---------------------------------------------------------------------------
-- 5. Per-Task model execution budget & attempt ledger (across Runs/retries).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_model_attempts (
  tenant_id               uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  task_id                 uuid        NOT NULL,
  run_id                  uuid        NOT NULL,
  lease_epoch             bigint      NOT NULL CHECK (lease_epoch >= 0),
  attempt_no              integer     NOT NULL,
  operation_id            uuid        NOT NULL,
  principal_id            uuid        NOT NULL,
  utc_day                 date        NOT NULL,
  provider_id             text        NOT NULL,
  model_label             text        NOT NULL CHECK (char_length(model_label) BETWEEN 1 AND 128),
  rate_version            text        NOT NULL CHECK (char_length(rate_version) BETWEEN 1 AND 128),
  state                   text        NOT NULL,
  outcome_code            text,
  reserved_micro_usd      bigint      NOT NULL,
  applied_cost_micro_usd  bigint,
  observed_cost_micro_usd bigint,
  input_tokens            integer,
  output_tokens           integer,
  billing_basis           text,
  overage_micro_usd       bigint      NOT NULL DEFAULT 0,
  send_started_at         timestamptz,
  started_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at              timestamptz,
  CONSTRAINT task_model_attempts_pkey
    PRIMARY KEY (tenant_id, task_id, attempt_no),
  CONSTRAINT task_model_attempts_operation_unique
    UNIQUE (tenant_id, operation_id),
  -- Per-Task cumulative attempt ceiling enforced in SQL (<= V1 ceiling of 6 in placement doc §11.3).
  CONSTRAINT task_model_attempts_attempt_no_check CHECK (attempt_no BETWEEN 1 AND 4),
  CONSTRAINT task_model_attempts_provider_check CHECK (provider_id IN ('openai', 'openrouter')),
  CONSTRAINT task_model_attempts_state_check
    CHECK (state IN ('reserved', 'settled', 'unknown_billed', 'released', 'conservative_billed')),
  CONSTRAINT task_model_attempts_outcome_check CHECK (
    outcome_code IS NULL
    OR outcome_code IN (
      'ok', 'model_timeout', 'model_unavailable', 'model_rate_limited',
      'model_auth_failed', 'model_invalid_output', 'client_cancelled', 'not_sent',
      'usage_missing'
    )
  ),
  CONSTRAINT task_model_attempts_reserved_check
    CHECK (reserved_micro_usd BETWEEN 1 AND 5000),
  CONSTRAINT task_model_attempts_applied_check CHECK (
    applied_cost_micro_usd IS NULL
    OR applied_cost_micro_usd BETWEEN 0 AND reserved_micro_usd
  ),
  CONSTRAINT task_model_attempts_observed_check
    CHECK (observed_cost_micro_usd IS NULL OR observed_cost_micro_usd >= 0),
  CONSTRAINT task_model_attempts_tokens_check CHECK (
    (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
  ),
  CONSTRAINT task_model_attempts_billing_basis_check CHECK (
    billing_basis IS NULL
    OR billing_basis IN ('provider_usage', 'conservative_reservation', 'not_billed')
  ),
  CONSTRAINT task_model_attempts_state_shape_check CHECK (
    (state = 'reserved'
      AND outcome_code IS NULL AND applied_cost_micro_usd IS NULL AND settled_at IS NULL)
    OR (state = 'settled'
      AND outcome_code IS NOT NULL AND applied_cost_micro_usd IS NOT NULL
      AND settled_at IS NOT NULL)
    OR (state = 'unknown_billed'
      AND outcome_code IS NOT NULL AND applied_cost_micro_usd IS NULL
      AND settled_at IS NOT NULL)
    OR (state = 'released'
      AND outcome_code IS NOT NULL AND applied_cost_micro_usd = 0
      AND settled_at IS NOT NULL)
    OR (state = 'conservative_billed'
      AND outcome_code IS NOT NULL
      AND applied_cost_micro_usd = reserved_micro_usd
      AND billing_basis = 'conservative_reservation'
      AND settled_at IS NOT NULL)
  ),
  CONSTRAINT task_model_attempts_overage_check CHECK (
    overage_micro_usd >= 0
    AND (
      observed_cost_micro_usd IS NULL
      OR applied_cost_micro_usd IS NULL
      OR overage_micro_usd = observed_cost_micro_usd - applied_cost_micro_usd
    )
  ),
  CONSTRAINT task_model_attempts_task_fk
    FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_model_attempts_run_fk
    FOREIGN KEY (tenant_id, run_id) REFERENCES runs (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_model_attempts_principal_fk
    FOREIGN KEY (tenant_id, principal_id) REFERENCES principals (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS task_model_attempts_day_idx
  ON task_model_attempts (utc_day, tenant_id);

CREATE INDEX IF NOT EXISTS task_model_attempts_principal_day_idx
  ON task_model_attempts (tenant_id, principal_id, utc_day);

CREATE INDEX IF NOT EXISTS task_model_attempts_open_idx
  ON task_model_attempts (utc_day, tenant_id)
  WHERE state = 'unknown_billed';
