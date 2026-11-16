-- 0021_b3_python_agent.sql
-- B3-B1: Daytona Python Agent Loop, Neon PG bytea storage & pre-delegation staged uploads.
-- Additive only; migrations 0001-0020 are immutable.

-- ---------------------------------------------------------------------------
-- 1. Widen tasks.kind CHECK & ember_task_event_payload_is_valid for 'python.agent'.
-- ---------------------------------------------------------------------------

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
      kind IN (
        'mock.chat',
        'mock.compute',
        'mock.file',
        'mock.approval',
        'notes.action_items',
        'python.agent'
      )
    );
END $$;

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
             'mock.chat',
             'mock.compute',
             'mock.file',
             'mock.approval',
             'notes.action_items',
             'python.agent'
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
-- 2. Widen task_model_attempts ceiling to 6 (placement §11.3 cumulative cap)
--    and index budget_operations per-Task for sandbox/python execution accounting.
-- ---------------------------------------------------------------------------

ALTER TABLE task_model_attempts
  DROP CONSTRAINT IF EXISTS task_model_attempts_attempt_no_check;

ALTER TABLE task_model_attempts
  ADD CONSTRAINT task_model_attempts_attempt_no_check CHECK (attempt_no BETWEEN 1 AND 6);

CREATE INDEX IF NOT EXISTS budget_operations_task_idx
  ON budget_operations (tenant_id, task_id, state);

-- ---------------------------------------------------------------------------
-- 3. Preserve safe filenames on published artifacts (nullable for legacy rows).
-- ---------------------------------------------------------------------------

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS filename text;

ALTER TABLE artifacts
  DROP CONSTRAINT IF EXISTS artifacts_filename_check;

ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_filename_check CHECK (
    filename IS NULL
    OR (
      char_length(filename) BETWEEN 1 AND 128
      AND filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      AND filename NOT LIKE '%..%'
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Edge-safe Neon PostgreSQL bytea backing storage (<= 256 KiB per object).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bytea_staged_blobs (
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  storage_key text        NOT NULL CHECK (
                            storage_key ~ '^staging/[0-9a-f-]{36}/[0-9a-f]{64}$'
                          ),
  sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size        integer     NOT NULL CHECK (size BETWEEN 0 AND 262144),
  media_type  text        NOT NULL CHECK (length(media_type) BETWEEN 1 AND 128),
  bytes       bytea       NOT NULL CHECK (
                            octet_length(bytes) = size
                            AND octet_length(bytes) <= 262144
                          ),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, storage_key)
);

CREATE TABLE IF NOT EXISTS bytea_blobs (
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  storage_key text        NOT NULL CHECK (
                            storage_key ~ '^blobs/[0-9a-f-]{36}/[0-9a-f]{64}$'
                          ),
  sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size        integer     NOT NULL CHECK (size BETWEEN 0 AND 262144),
  media_type  text        NOT NULL CHECK (length(media_type) BETWEEN 1 AND 128),
  bytes       bytea       NOT NULL CHECK (
                            octet_length(bytes) = size
                            AND octet_length(bytes) <= 262144
                          ),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, storage_key),
  UNIQUE (tenant_id, sha256)
);

-- ---------------------------------------------------------------------------
-- 5. Pre-delegation tenant-private staged uploads (24h TTL, <= 10 unbound/user)
--    and optional message attachment references.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_staged_uploads (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  principal_id  uuid        NOT NULL,
  filename      text        NOT NULL CHECK (
                              char_length(filename) BETWEEN 1 AND 128
                              AND filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                              AND filename NOT LIKE '%..%'
                            ),
  media_type    text        NOT NULL CHECK (
                              media_type IN ('text/plain', 'text/csv', 'text/markdown')
                            ),
  sha256        text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size          integer     NOT NULL CHECK (size BETWEEN 0 AND 262144),
  bytes         bytea       NOT NULL CHECK (
                              octet_length(bytes) = size
                              AND octet_length(bytes) <= 262144
                            ),
  status        text        NOT NULL DEFAULT 'unbound' CHECK (status IN ('unbound', 'bound')),
  bound_task_id uuid,
  artifact_id   uuid,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  bound_at      timestamptz,
  CONSTRAINT user_staged_uploads_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT user_staged_uploads_principal_fk
    FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT user_staged_uploads_task_fk
    FOREIGN KEY (tenant_id, bound_task_id)
    REFERENCES tasks (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT user_staged_uploads_state_shape_check CHECK (
    (status = 'unbound' AND bound_task_id IS NULL AND artifact_id IS NULL AND bound_at IS NULL)
    OR (status = 'bound' AND bound_task_id IS NOT NULL AND artifact_id IS NOT NULL AND bound_at IS NOT NULL)
  ),
  CONSTRAINT user_staged_uploads_expiry_order_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS user_staged_uploads_principal_unbound_idx
  ON user_staged_uploads (tenant_id, principal_id, created_at)
  WHERE status = 'unbound';

CREATE INDEX IF NOT EXISTS user_staged_uploads_expiry_idx
  ON user_staged_uploads (expires_at, id)
  WHERE status = 'unbound';

CREATE TABLE IF NOT EXISTS conversation_message_attachments (
  tenant_id        uuid        NOT NULL,
  conversation_id  uuid        NOT NULL,
  message_id       uuid        NOT NULL,
  upload_id        uuid        NOT NULL,
  position         integer     NOT NULL CHECK (position BETWEEN 0 AND 4),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, message_id, upload_id),
  UNIQUE (tenant_id, message_id, position),
  FOREIGN KEY (tenant_id, conversation_id, message_id)
    REFERENCES conversation_messages (tenant_id, conversation_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, upload_id)
    REFERENCES user_staged_uploads (tenant_id, id)
    ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 6. Durable scheduling outbox for python.agent Tasks (B3-B1 queue wake-up).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS b3_task_dispatch_outbox (
  task_id                    uuid        PRIMARY KEY,
  tenant_id                  uuid        NOT NULL,
  kind                       text        NOT NULL CHECK (kind IN ('python.agent')),
  created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_dispatch_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_enqueued_at           timestamptz,
  dispatch_attempts          integer     NOT NULL DEFAULT 0,
  dispatch_lease_owner       text,
  dispatch_lease_expires_at  timestamptz,
  completed_at               timestamptz,
  last_error_code            text,
  CONSTRAINT b3_task_dispatch_outbox_task_fk
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT b3_task_dispatch_outbox_attempts_check
    CHECK (dispatch_attempts >= 0),
  CONSTRAINT b3_task_dispatch_outbox_lease_check
    CHECK ((dispatch_lease_owner IS NULL) = (dispatch_lease_expires_at IS NULL)),
  CONSTRAINT b3_task_dispatch_outbox_error_code_check
    CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS b3_task_dispatch_outbox_due_idx
  ON b3_task_dispatch_outbox (next_dispatch_at, task_id)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS b3_task_dispatch_outbox_tenant_idx
  ON b3_task_dispatch_outbox (tenant_id, task_id);

-- ---------------------------------------------------------------------------
-- 7. Conditional additive grants for the shared Ember Cloud runtime role
--    when present (no-op in local/integration databases without this role).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ember_staging_runtime_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.tasks TO ember_staging_runtime_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.runs TO ember_staging_runtime_app;
    GRANT SELECT, INSERT ON TABLE public.task_events TO ember_staging_runtime_app;
    GRANT SELECT, INSERT ON TABLE public.task_results TO ember_staging_runtime_app;
    GRANT SELECT, INSERT ON TABLE public.step_checkpoints TO ember_staging_runtime_app;
    GRANT SELECT, INSERT ON TABLE public.artifacts TO ember_staging_runtime_app;
    GRANT SELECT, INSERT ON TABLE public.blobs TO ember_staging_runtime_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staged_blobs TO ember_staging_runtime_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.budget_operations TO ember_staging_runtime_app;
    GRANT SELECT, UPDATE ON TABLE public.approvals TO ember_staging_runtime_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.task_model_attempts TO ember_staging_runtime_app;
    GRANT SELECT, INSERT, DELETE ON TABLE public.bytea_staged_blobs TO ember_staging_runtime_app;
    GRANT SELECT, INSERT, DELETE ON TABLE public.bytea_blobs TO ember_staging_runtime_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_staged_uploads TO ember_staging_runtime_app;
    GRANT SELECT, INSERT ON TABLE public.conversation_message_attachments TO ember_staging_runtime_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.b3_task_dispatch_outbox TO ember_staging_runtime_app;
  END IF;
END $$;
