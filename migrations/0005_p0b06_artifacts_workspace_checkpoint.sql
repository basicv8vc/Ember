-- P0B-06: durable artifacts, workspace CAS/history/conflicts, step checkpoints and
-- idempotent result-commit receipts.
--
-- Forward-only. Migrations 0001-0004 are already merged and immutable.
--
-- Invariants encoded here rather than only in TypeScript:
--   * every P0B-06 row is tenant-owned and child rows use composite (tenant_id, ...)
--     foreign keys, so a cross-tenant artifact/workspace/checkpoint reference is rejected
--     even by direct SQL;
--   * content identity is the SHA-256 digest plus byte size; the physical storage key is
--     internal metadata and is never a logical Artifact/Workspace/Checkpoint id;
--   * a staged blob is not an Artifact: it is private until a trusted transaction publishes
--     artifact metadata that references a durable blob row;
--   * Workspace versions are immutable history: one row per committed version, with an
--     explicit parent version and a manifest digest;
--   * one idempotency receipt per (tenant, task, operation) makes a result commit replay
--     read the original receipt instead of writing a second result.

-- ---------------------------------------------------------------------------
-- Blobs and their private staging area
-- ---------------------------------------------------------------------------

-- A durable, immutable byte object. `storage_key` is an internal relative key inside the
-- controlled blob root; it never contains a host absolute path and is never returned to a
-- client as an identity.
CREATE TABLE blobs (
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size        bigint      NOT NULL CHECK (size >= 0 AND size <= 104857600),
  media_type  text        NOT NULL CHECK (length(media_type) BETWEEN 1 AND 128),
  storage_key text        NOT NULL CHECK (
                            storage_key ~ '^blobs/[0-9a-f-]{36}/[0-9a-f]{64}$'
                          ),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256),
  UNIQUE (tenant_id, storage_key)
);

-- Bytes that were written and verified inside the private staging area but are not yet
-- publishable. `state` is intentionally separate from Artifact existence: a row here can
-- never be downloaded through the Artifact API.
CREATE TABLE staged_blobs (
  id          uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  task_id     uuid,
  run_id      uuid,
  lease_epoch bigint      CHECK (lease_epoch IS NULL OR lease_epoch >= 0),
  sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size        bigint      NOT NULL CHECK (size >= 0 AND size <= 104857600),
  media_type  text        NOT NULL CHECK (length(media_type) BETWEEN 1 AND 128),
  storage_key text        NOT NULL CHECK (
                            storage_key ~ '^staging/[0-9a-f-]{36}/[0-9a-f]{64}$'
                          ),
  state       text        NOT NULL DEFAULT 'pending' CHECK (
                            state IN ('pending', 'published', 'abandoned')
                          ),
  created_at  timestamptz NOT NULL DEFAULT now(),
  settled_at  timestamptz,
  UNIQUE (tenant_id, id),
  -- Deliberately NOT unique on (tenant_id, storage_key): the same bytes may be uploaded
  -- repeatedly by the same tenant (another Task, another attempt) and each upload keeps its
  -- own attempt identity. The physical staging file is content-addressed and shared.
  CHECK (state = 'pending' OR settled_at IS NOT NULL)
);

CREATE INDEX staged_blobs_pending_idx
  ON staged_blobs (created_at, id)
  WHERE state = 'pending';

-- GC and publish both resolve a staging file through its key, so the lookup needs an index
-- even though duplicates are legal.
CREATE INDEX staged_blobs_storage_key_idx ON staged_blobs (tenant_id, storage_key);

-- ---------------------------------------------------------------------------
-- Artifacts
-- ---------------------------------------------------------------------------

-- Published artifact metadata. A row here is the only thing that makes bytes readable
-- through the tenant-scoped Artifact API.
CREATE TABLE artifacts (
  id          uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  task_id     uuid,
  run_id      uuid,
  -- Provenance of the publishing writer. `user` means a verified AuthContext upload,
  -- `run` means a fenced Run commit.
  created_by  text        NOT NULL CHECK (created_by IN ('user', 'run')),
  sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size        bigint      NOT NULL CHECK (size >= 0 AND size <= 104857600),
  media_type  text        NOT NULL CHECK (length(media_type) BETWEEN 1 AND 128),
  -- `task` artifacts are collected with their Task; `user` artifacts are user-retained and
  -- must never be garbage collected by staging cleanup.
  retention   text        NOT NULL DEFAULT 'task' CHECK (retention IN ('task', 'user')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, sha256) REFERENCES blobs (tenant_id, sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, task_id, run_id)
    REFERENCES runs (tenant_id, task_id, id) ON DELETE RESTRICT
);

CREATE INDEX artifacts_tenant_created_idx ON artifacts (tenant_id, created_at, id);
CREATE INDEX artifacts_task_idx ON artifacts (tenant_id, task_id, created_at);
-- Keeps the referenced blob row (and therefore its retention) discoverable by GC.
CREATE INDEX artifacts_blob_idx ON artifacts (tenant_id, sha256);

-- ---------------------------------------------------------------------------
-- Workspace versions (immutable history) and pending conflicts
-- ---------------------------------------------------------------------------

-- Workspace version 0 is the empty workspace and has no row here. Every committed version
-- after that is immutable and points at its parent so a common base stays verifiable.
CREATE TABLE workspace_versions (
  tenant_id         uuid        NOT NULL,
  workspace_id      uuid        NOT NULL,
  version           integer     NOT NULL CHECK (version >= 1),
  parent_version    integer     NOT NULL CHECK (parent_version >= 0),
  manifest          jsonb       NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  manifest_digest   text        NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  created_by_run_id uuid,
  lease_epoch       bigint      CHECK (lease_epoch IS NULL OR lease_epoch >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, version),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces (tenant_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_run_id) REFERENCES runs (tenant_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX workspace_versions_created_idx
  ON workspace_versions (tenant_id, workspace_id, created_at DESC);

-- A pending conflict preserves both candidate manifests and their provenance. It is written
-- in its own bounded, idempotent, non-terminal transaction: the failing result commit is
-- rolled back in full and the Task is never reported as completed.
CREATE TABLE workspace_conflicts (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  base_version       integer     NOT NULL CHECK (base_version >= 0),
  current_version    integer     NOT NULL CHECK (current_version >= 1),
  candidate_manifest jsonb       NOT NULL CHECK (jsonb_typeof(candidate_manifest) = 'object'),
  candidate_digest   text        NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  conflict_paths     jsonb       NOT NULL CHECK (jsonb_typeof(conflict_paths) = 'array'),
  task_id            uuid,
  run_id             uuid,
  lease_epoch        bigint,
  -- Stable de-duplication key so a retried writer records one conflict, not many.
  dedupe_key         text        NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  status             text        NOT NULL DEFAULT 'pending' CHECK (
                       status IN ('pending', 'resolved')
                     ),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, workspace_id, dedupe_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces (tenant_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX workspace_conflicts_pending_idx
  ON workspace_conflicts (tenant_id, workspace_id, created_at DESC)
  WHERE status = 'pending';


-- ---------------------------------------------------------------------------
-- Step checkpoints
-- ---------------------------------------------------------------------------

-- One committed logical step. A checkpoint is recoverable input only after its transaction
-- committed; it stores no host path, credential or harness-private session.
CREATE TABLE step_checkpoints (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL,
  task_id           uuid        NOT NULL,
  run_id            uuid        NOT NULL,
  attempt           integer     NOT NULL CHECK (attempt >= 1),
  lease_epoch       bigint      NOT NULL CHECK (lease_epoch >= 0),
  schema_version    integer     NOT NULL CHECK (schema_version >= 1),
  step_id           text        NOT NULL CHECK (step_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  step_sequence     integer     NOT NULL CHECK (step_sequence >= 1),
  input_digest      text        NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  executor_version  text        NOT NULL CHECK (length(executor_version) BETWEEN 1 AND 64),
  cursor            jsonb       NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(cursor) = 'object'),
  workspace_version integer     CHECK (workspace_version IS NULL OR workspace_version >= 0),
  artifacts         jsonb       NOT NULL DEFAULT '[]'::jsonb
                      CHECK (jsonb_typeof(artifacts) = 'array'),
  external_effects  jsonb       NOT NULL DEFAULT '[]'::jsonb
                      CHECK (jsonb_typeof(external_effects) = 'array'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- A step is identified by its stable id plus the digest of the deterministic input, so a
  -- replayed Step cannot silently commit different work under the same identity.
  UNIQUE (tenant_id, task_id, step_id, input_digest),
  -- Monotonic per-Task cursor as well, so history is ordered without trusting a client.
  UNIQUE (tenant_id, task_id, step_sequence),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, task_id, run_id)
    REFERENCES runs (tenant_id, task_id, id) ON DELETE RESTRICT
);

CREATE INDEX step_checkpoints_latest_idx
  ON step_checkpoints (tenant_id, task_id, step_sequence DESC);

-- ---------------------------------------------------------------------------
-- Result commit receipts
-- ---------------------------------------------------------------------------

-- One immutable receipt per (tenant, task, operation). A lost ACK can therefore be answered
-- read-only with the original result instead of granting another write.
CREATE TABLE operation_receipts (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  task_id        uuid        NOT NULL,
  run_id         uuid        NOT NULL,
  attempt        integer     NOT NULL CHECK (attempt >= 1),
  lease_epoch    bigint      NOT NULL CHECK (lease_epoch >= 0),
  operation_id   text        NOT NULL CHECK (
                   operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
                 ),
  request_digest text        NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  receipt        jsonb       NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, task_id, operation_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, task_id, run_id)
    REFERENCES runs (tenant_id, task_id, id) ON DELETE RESTRICT
);
