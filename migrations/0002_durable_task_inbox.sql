-- P0B-03: durable task inbox.
--
-- Forward-only business schema for the minimum durable task slice. It does NOT implement
-- worker claiming, leases, fencing, retry scheduling, execution, artifacts, approvals,
-- budgets or an HTTP API. `runs` and the lease columns exist only so P0B-04 can build on a
-- reviewed schema.
--
-- Tenant isolation is expressed in the database, not only in repository code:
--   * tenant-owned rows carry an explicit tenant_id;
--   * child tables reference parents with composite (tenant_id, ...) foreign keys, so an
--     agent/workspace/task from another tenant cannot be attached even by direct SQL;
--   * idempotency is unique per tenant, not globally.

CREATE TABLE tenants (
  id         uuid        PRIMARY KEY,
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE principals (
  id         uuid        PRIMARY KEY,
  tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  role       text        NOT NULL CHECK (role IN ('owner', 'member', 'service')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX principals_tenant_idx ON principals (tenant_id);

CREATE TABLE agents (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  name           text        NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  policy_version integer     NOT NULL CHECK (policy_version >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX agents_tenant_created_idx ON agents (tenant_id, created_at, id);

-- One workspace per agent. The association is the workspace's (tenant_id, agent_id)
-- primary key; there is deliberately no agents.workspace_id column, so agent + workspace
-- creation has no circular foreign key. AgentRepository inserts both rows in one
-- transaction and rolls back both if either write fails.
CREATE TABLE workspaces (
  id           uuid        NOT NULL UNIQUE,
  tenant_id    uuid        NOT NULL,
  agent_id     uuid        NOT NULL,
  version      integer     NOT NULL DEFAULT 0 CHECK (version >= 0),
  manifest_ref text        CHECK (manifest_ref IS NULL OR length(manifest_ref) > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  PRIMARY KEY (tenant_id, agent_id),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES agents (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE tasks (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  agent_id            uuid        NOT NULL,
  kind                text        NOT NULL CHECK (
                        kind IN ('mock.chat', 'mock.compute', 'mock.file', 'mock.approval')
                      ),
  -- Validated TaskCommand.input, stored as JSON. Prompts and file content live here as
  -- business data; they are never copied into task_events.
  input               jsonb       NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  -- SHA-256 of the canonical command (agentId, kind, input, normalized deadlineAt).
  -- The idempotency key is intentionally not part of the digest.
  digest              text        NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  idempotency_key     text        NOT NULL CHECK (
                        length(idempotency_key) BETWEEN 8 AND 128
                        AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
                      ),
  status              text        NOT NULL DEFAULT 'queued' CHECK (
                        status IN (
                          'queued', 'running', 'waiting_approval', 'retryable_failed',
                          'completed', 'failed', 'cancelled'
                        )
                      ),
  attempt_count       integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts        integer     NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  -- Reserved for P0B-04. P0B-03 does not claim/lease/heartbeat or fence anything.
  current_run_id      uuid,
  lease_epoch         bigint      NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at    timestamptz,
  next_run_at         timestamptz NOT NULL DEFAULT now(),
  deadline_at         timestamptz,
  -- P0B-08 owns cooperative cancellation. P0B-03 only persists that a cancel was requested.
  cancel_requested_at timestamptz,
  accepted_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES agents (tenant_id, id) ON DELETE RESTRICT,
  CHECK (lease_expires_at IS NULL OR lease_expires_at >= created_at)
);

-- Scheduler-ready ordering for P0B-04. Nothing selects with these indexes yet.
CREATE INDEX tasks_schedule_idx ON tasks (status, next_run_at, created_at);
CREATE INDEX tasks_tenant_status_idx ON tasks (tenant_id, status, created_at, id);
CREATE INDEX tasks_tenant_agent_idx ON tasks (tenant_id, agent_id, created_at, id);
CREATE INDEX tasks_lease_expiry_idx ON tasks (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

-- Run shape reserved for P0B-04. No claim/lease/fencing implementation exists in P0B-03.
CREATE TABLE runs (
  id           uuid        PRIMARY KEY,
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  task_id      uuid        NOT NULL,
  attempt      integer     NOT NULL CHECK (attempt >= 1),
  lease_epoch  bigint      NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  status       text        NOT NULL DEFAULT 'created' CHECK (
                 status IN (
                   'created', 'running', 'succeeded', 'failed_retryable',
                   'failed_terminal', 'lease_expired', 'cancelled'
                 )
               ),
  worker_id    text        CHECK (worker_id IS NULL OR length(worker_id) BETWEEN 1 AND 128),
  leased_until timestamptz,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, task_id, attempt),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE RESTRICT,
  CHECK (finished_at IS NULL OR started_at IS NOT NULL),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX runs_tenant_task_idx ON runs (tenant_id, task_id, attempt);
CREATE INDEX runs_lease_expiry_idx ON runs (leased_until) WHERE status = 'running';

-- Closed, database-enforced event payload allowlist. It mirrors
-- TaskEventPayloadSchema in @ember/contracts: enums, UUIDs, non-negative integers and
-- booleans only. There is no free-text field, so a direct SQL insert cannot smuggle a
-- prompt, token, SQL fragment, host path or tool output into the event log.
CREATE FUNCTION ember_task_event_payload_is_valid(payload jsonb)
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
           OR (entry.value #>> '{}') NOT IN ('mock.chat', 'mock.compute', 'mock.file', 'mock.approval') THEN
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

CREATE TABLE task_events (
  id          uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL,
  task_id     uuid        NOT NULL,
  sequence    integer     NOT NULL CHECK (sequence >= 1),
  phase       text        NOT NULL CHECK (
                phase IN (
                  'accepted', 'leased', 'started', 'progress', 'waiting_approval',
                  'approval_granted', 'approval_denied', 'retry_scheduled',
                  'completed', 'failed', 'cancelled'
                )
              ),
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb
                CHECK (ember_task_event_payload_is_valid(payload)),
  trace_id    uuid        NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, task_id, sequence),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE RESTRICT,
  -- The first durable fact is the single `accepted` event at sequence 1.
  CHECK (phase <> 'accepted' OR sequence = 1)
);

-- At most one accepted event per task, enforced by the database as well as by the
-- create transaction.
CREATE UNIQUE INDEX task_events_one_accepted_idx
  ON task_events (tenant_id, task_id)
  WHERE phase = 'accepted';

CREATE INDEX task_events_task_order_idx ON task_events (tenant_id, task_id, sequence);
