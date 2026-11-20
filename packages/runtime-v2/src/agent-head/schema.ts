import type {
  ApprovalStatus,
  ExecutionPath,
  RunStatus,
  TaskEventPhase,
  TaskKind,
  TaskStatus,
} from '@ember/domain';
import {
  computeMigrationChecksumSync,
  createEventRecoveryDoMigration,
  type AgentHeadMigrationStep,
} from '../migrations.js';
import type { BudgetSyncIncidentReason } from '../recovery/envelope.js';
import type { TurnExecutionMode } from '../recovery/ports.js';

export const DEFAULT_AGENT_HEAD_BUSINESS_DO_MIGRATION_VERSION = 1;

export type TurnStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type TurnFailureReason = 'timeout' | 'internal_error';
export type ConversationMessageKind =
  'user' | 'ember' | 'activity' | 'task_reference' | 'commitment_reference' | 'outcome_reference';
export type TaskExecutionTarget = 'cloud' | 'device';
export type RunExecutorKind = 'interactive' | 'queue_worker' | 'device';
export type ModelAttemptSubjectType = 'turn' | 'task';
export type ModelAttemptProviderId = 'fake' | 'openai' | 'openrouter';
export type ModelAttemptBudgetMode = 'disabled_echo_only' | 'simulated_full_protocol' | 'real';
export type ModelAttemptState =
  'reserved' | 'settled' | 'unknown_billed' | 'released' | 'conservative_billed';
export type AgentSpendScopeKind = 'tenant' | 'principal';

export interface AgentHeadMetaRow {
  readonly id: 1;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly policy_version: number;
  readonly home_region: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface ConversationRow {
  readonly id: string;
  readonly kind: 'main';
  readonly last_sequence: number;
  readonly transcript_epoch: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface ConversationMessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly sequence: number;
  readonly kind: ConversationMessageKind;
  readonly text: string | null;
  readonly model_label: string | null;
  readonly simulated: number | null;
  readonly source: string | null;
  readonly task_id: string | null;
  readonly commitment_id: string | null;
  readonly outcome_json: string | null;
  readonly client_submission_id: string | null;
  readonly created_at_ms: number;
}

export interface MessageAttachmentRow {
  readonly message_id: string;
  readonly position: number;
  readonly upload_id: string;
  readonly filename: string;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly r2_key: string;
  readonly sha256: string;
}

export interface AssistantTurnRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly source_message_id: string;
  readonly response_message_id: string | null;
  readonly status: TurnStatus;
  readonly failure_reason: TurnFailureReason | null;
  readonly execution_mode: TurnExecutionMode;
  readonly deadline_at_ms: number;
  readonly interactive_deadline_ms: number | null;
  readonly lease_epoch: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at_ms: number | null;
  readonly claim_count: number;
  readonly cancel_requested_at_ms: number | null;
  readonly provider_job_handle: string | null;
  readonly handoff_reason: string | null;
  readonly linked_task_id: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface TaskRow {
  readonly id: string;
  readonly kind: TaskKind;
  readonly title: string | null;
  readonly input_json: string;
  readonly digest: string;
  readonly idempotency_key: string;
  readonly status: TaskStatus;
  readonly execution_path: ExecutionPath;
  readonly execution_target: TaskExecutionTarget;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly current_run_id: string | null;
  readonly lease_epoch: number;
  readonly lease_expires_at_ms: number | null;
  readonly next_run_at_ms: number;
  readonly deadline_at_ms: number | null;
  readonly cancel_requested_at_ms: number | null;
  readonly provider_job_handle: string | null;
  readonly linked_message_id: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface RunRow {
  readonly id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly lease_epoch: number;
  readonly status: RunStatus;
  readonly worker_id: string;
  readonly executor_kind: RunExecutorKind;
  readonly leased_until_ms: number;
  readonly provider_job_handle: string | null;
  readonly checkpoint_ref: string | null;
  readonly started_at_ms: number;
  readonly finished_at_ms: number | null;
  readonly updated_at_ms: number;
}

export interface TaskEventRow {
  readonly id: string;
  readonly task_id: string;
  readonly sequence: number;
  readonly phase: TaskEventPhase;
  readonly payload_json: string;
  readonly trace_id: string;
  readonly occurred_at_ms: number;
}

export interface TaskResultRow {
  readonly task_id: string;
  readonly summary_text: string | null;
  readonly detail_text: string | null;
  readonly model_label: string;
  readonly simulated: number;
  readonly truncated: number;
  readonly reason_code: string;
  readonly produced_at_ms: number;
}

export interface ApprovalRow {
  readonly id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly lease_epoch: number;
  readonly action_digest: string;
  readonly status: ApprovalStatus;
  readonly expires_at_ms: number;
  readonly decided_at_ms: number | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface ModelAttemptRow {
  readonly subject_type: ModelAttemptSubjectType;
  readonly subject_id: string;
  readonly attempt_no: number;
  readonly operation_id: string;
  readonly principal_id: string;
  readonly utc_day: string;
  readonly lease_epoch: number;
  readonly provider_id: ModelAttemptProviderId;
  readonly model_label: string;
  readonly rate_version: string;
  readonly budget_mode: ModelAttemptBudgetMode;
  readonly state: ModelAttemptState;
  readonly outcome_code: string | null;
  readonly reserved_micro_usd: number;
  readonly applied_cost_micro_usd: number | null;
  readonly observed_cost_micro_usd: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly billing_basis: string | null;
  readonly overage_micro_usd: number;
  readonly settlement_revision: number;
  readonly global_grant_id: string | null;
  readonly global_grant_expires_ms: number | null;
  readonly global_synced_at_ms: number | null;
  readonly send_authorizing_at_ms: number | null;
  readonly send_started_at_ms: number | null;
  readonly started_at_ms: number;
  readonly settled_at_ms: number | null;
}

export interface AgentSpendDayRow {
  readonly scope_kind: AgentSpendScopeKind;
  readonly scope_id: string;
  readonly utc_day: string;
  readonly reserved_micro_usd: number;
  readonly consumed_micro_usd: number;
  readonly overage_micro_usd: number;
  readonly turns_started: number;
  readonly updated_at_ms: number;
}

export interface AgentBudgetIncidentRow {
  readonly id: string;
  readonly scope_kind: AgentSpendScopeKind;
  readonly scope_id: string;
  readonly utc_day: string;
  readonly reason: BudgetSyncIncidentReason;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly attempt_no: number | null;
  readonly observed_micro_usd: number;
  readonly applied_micro_usd: number;
  readonly overage_micro_usd: number;
  readonly reservation_micro_usd: number;
  readonly detected_at_ms: number;
  readonly resolved_at_ms: number | null;
  readonly resolved_by: string | null;
  readonly resolution_note: string | null;
}

/**
 * Canonical Agent A-owned SQLite DDL statements per V2-M0-A §4.1.
 * Shared B-owned tables (`v2_schedules`, `v2_dispatch_outbox`, `v2_recovery_coverage`) live
 * strictly in `src/recovery/schema.ts` and are installed alongside these in the unified DO migration.
 */
export const V2_AGENT_HEAD_BUSINESS_DO_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS agent_head_meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id      TEXT    NOT NULL,
  agent_id       TEXT    NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 0),
  home_region    TEXT,
  created_at_ms  INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS conversations (
  id               TEXT    PRIMARY KEY,
  kind             TEXT    NOT NULL DEFAULT 'main' CHECK (kind = 'main'),
  last_sequence    INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  transcript_epoch INTEGER NOT NULL DEFAULT 0 CHECK (transcript_epoch >= 0),
  created_at_ms    INTEGER NOT NULL,
  updated_at_ms    INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS conversation_messages (
  id                   TEXT    PRIMARY KEY,
  conversation_id      TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence             INTEGER NOT NULL CHECK (sequence >= 1),
  kind                 TEXT    NOT NULL CHECK (
    kind IN ('user', 'ember', 'activity', 'task_reference', 'commitment_reference', 'outcome_reference')
  ),
  text                 TEXT,
  model_label          TEXT,
  simulated            INTEGER CHECK (simulated IS NULL OR simulated IN (0, 1)),
  source               TEXT,
  task_id              TEXT,
  commitment_id        TEXT,
  outcome_json         TEXT,
  client_submission_id TEXT,
  created_at_ms        INTEGER NOT NULL,
  UNIQUE (conversation_id, sequence),
  CHECK (
    (kind = 'user' AND text IS NOT NULL AND length(text) BETWEEN 1 AND 4096
      AND client_submission_id IS NOT NULL AND model_label IS NULL AND simulated IS NULL
      AND source IS NULL AND task_id IS NULL AND commitment_id IS NULL AND outcome_json IS NULL)
    OR
    (kind = 'ember' AND text IS NOT NULL AND length(text) BETWEEN 1 AND 8192
      AND model_label IS NOT NULL AND simulated IN (0, 1)
      AND client_submission_id IS NULL AND source IS NULL AND task_id IS NULL
      AND commitment_id IS NULL AND outcome_json IS NULL)
    OR
    (kind = 'activity' AND text IS NOT NULL AND length(text) BETWEEN 1 AND 280
      AND source IS NOT NULL AND model_label IS NULL AND simulated IS NULL
      AND client_submission_id IS NULL AND task_id IS NULL AND commitment_id IS NULL AND outcome_json IS NULL)
    OR
    (kind = 'task_reference' AND task_id IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND client_submission_id IS NULL AND commitment_id IS NULL AND outcome_json IS NULL)
    OR
    (kind = 'commitment_reference' AND commitment_id IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND client_submission_id IS NULL AND task_id IS NULL AND outcome_json IS NULL)
    OR
    (kind = 'outcome_reference' AND outcome_json IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND client_submission_id IS NULL AND task_id IS NULL AND commitment_id IS NULL)
  )
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_submission
  ON conversation_messages (client_submission_id) WHERE client_submission_id IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_task_link
  ON conversation_messages (task_id) WHERE task_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conv_seq
  ON conversation_messages (conversation_id, sequence);`,
  `CREATE TABLE IF NOT EXISTS message_attachments (
  message_id  TEXT    NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL CHECK (position >= 0),
  upload_id   TEXT    NOT NULL,
  filename    TEXT    NOT NULL,
  media_type  TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL CHECK (size_bytes >= 0),
  r2_key      TEXT    NOT NULL,
  sha256      TEXT    NOT NULL,
  PRIMARY KEY (message_id, position)
);`,
  `CREATE TABLE IF NOT EXISTS assistant_turns (
  id                      TEXT    PRIMARY KEY,
  conversation_id         TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id       TEXT    NOT NULL UNIQUE REFERENCES conversation_messages(id) ON DELETE CASCADE,
  response_message_id     TEXT    UNIQUE REFERENCES conversation_messages(id) ON DELETE CASCADE,
  status                  TEXT    NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  failure_reason          TEXT    CHECK (failure_reason IS NULL OR failure_reason IN ('timeout', 'internal_error')),
  execution_mode          TEXT    NOT NULL DEFAULT 'fast_interactive'
    CHECK (execution_mode IN ('fast_interactive', 'durable_queue', 'device')),
  deadline_at_ms          INTEGER NOT NULL,
  interactive_deadline_ms INTEGER,
  lease_epoch             INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_owner             TEXT,
  lease_expires_at_ms     INTEGER,
  claim_count             INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  cancel_requested_at_ms  INTEGER,
  provider_job_handle     TEXT,
  handoff_reason          TEXT,
  linked_task_id          TEXT,
  created_at_ms           INTEGER NOT NULL,
  updated_at_ms           INTEGER NOT NULL,
  CHECK ((lease_owner IS NULL) = (lease_expires_at_ms IS NULL)),
  CHECK (status != 'running' OR response_message_id IS NULL),
  CHECK (status NOT IN ('completed', 'failed') OR response_message_id IS NOT NULL),
  CHECK ((status = 'failed' AND failure_reason IS NOT NULL) OR (status != 'failed' AND failure_reason IS NULL))
);`,
  `CREATE INDEX IF NOT EXISTS idx_turns_running_lease
  ON assistant_turns (status, lease_expires_at_ms, deadline_at_ms) WHERE status = 'running';`,
  `CREATE TABLE IF NOT EXISTS tasks (
  id                     TEXT    PRIMARY KEY,
  kind                   TEXT    NOT NULL CHECK (
    kind IN ('mock.chat', 'mock.compute', 'mock.file', 'mock.approval', 'notes.action_items', 'python.agent')
  ),
  title                  TEXT,
  input_json             TEXT    NOT NULL,
  digest                 TEXT    NOT NULL,
  idempotency_key        TEXT    NOT NULL UNIQUE,
  status                 TEXT    NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'waiting_approval', 'retryable_failed', 'completed', 'failed', 'cancelled')
  ),
  execution_path         TEXT    NOT NULL CHECK (execution_path IN ('fast', 'standard', 'heavy')),
  execution_target       TEXT    NOT NULL DEFAULT 'cloud' CHECK (execution_target IN ('cloud', 'device')),
  attempt_count          INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts           INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  current_run_id         TEXT,
  lease_epoch            INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at_ms    INTEGER,
  next_run_at_ms         INTEGER NOT NULL,
  deadline_at_ms         INTEGER,
  cancel_requested_at_ms INTEGER,
  provider_job_handle    TEXT,
  linked_message_id      TEXT,
  created_at_ms          INTEGER NOT NULL,
  updated_at_ms          INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_due
  ON tasks (status, next_run_at_ms) WHERE status IN ('queued', 'retryable_failed');`,
  `CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT    PRIMARY KEY,
  task_id             TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt             INTEGER NOT NULL CHECK (attempt >= 1),
  lease_epoch         INTEGER NOT NULL CHECK (lease_epoch >= 1),
  status              TEXT    NOT NULL CHECK (
    status IN ('created', 'running', 'succeeded', 'failed_retryable', 'failed_terminal', 'lease_expired', 'cancelled')
  ),
  worker_id           TEXT    NOT NULL,
  executor_kind       TEXT    NOT NULL CHECK (executor_kind IN ('interactive', 'queue_worker', 'device')),
  leased_until_ms     INTEGER NOT NULL,
  provider_job_handle TEXT,
  checkpoint_ref      TEXT,
  started_at_ms       INTEGER NOT NULL,
  finished_at_ms      INTEGER,
  updated_at_ms       INTEGER NOT NULL,
  UNIQUE (task_id, attempt)
);`,
  `CREATE TABLE IF NOT EXISTS task_events (
  id             TEXT    PRIMARY KEY,
  task_id        TEXT    NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  sequence       INTEGER NOT NULL CHECK (sequence >= 1),
  phase          TEXT    NOT NULL CHECK (
    phase IN ('accepted', 'leased', 'started', 'progress', 'waiting_approval',
              'approval_granted', 'approval_denied', 'retry_scheduled', 'completed', 'failed', 'cancelled')
  ),
  payload_json   TEXT    NOT NULL,
  trace_id       TEXT    NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  UNIQUE (task_id, sequence),
  CHECK (phase != 'accepted' OR sequence = 1)
);`,
  `CREATE TABLE IF NOT EXISTS task_results (
  task_id        TEXT    PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
  summary_text   TEXT,
  detail_text    TEXT,
  model_label    TEXT    NOT NULL,
  simulated      INTEGER NOT NULL CHECK (simulated IN (0, 1)),
  truncated      INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  reason_code    TEXT    NOT NULL,
  produced_at_ms INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT    PRIMARY KEY,
  task_id       TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id        TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  lease_epoch   INTEGER NOT NULL,
  action_digest TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  expires_at_ms INTEGER NOT NULL,
  decided_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS model_attempts (
  subject_type            TEXT    NOT NULL CHECK (subject_type IN ('turn', 'task')),
  subject_id              TEXT    NOT NULL,
  attempt_no              INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 6),
  operation_id            TEXT    NOT NULL UNIQUE,
  principal_id            TEXT    NOT NULL,
  utc_day                 TEXT    NOT NULL,
  lease_epoch             INTEGER NOT NULL CHECK (lease_epoch >= 0),
  provider_id             TEXT    NOT NULL CHECK (provider_id IN ('fake', 'openai', 'openrouter')),
  model_label             TEXT    NOT NULL,
  rate_version            TEXT    NOT NULL,
  budget_mode             TEXT    NOT NULL CHECK (budget_mode IN ('disabled_echo_only', 'simulated_full_protocol', 'real')),
  state                   TEXT    NOT NULL CHECK (
    state IN ('reserved', 'settled', 'unknown_billed', 'released', 'conservative_billed')
  ),
  outcome_code            TEXT,
  reserved_micro_usd      INTEGER NOT NULL CHECK (reserved_micro_usd BETWEEN 0 AND 5000),
  applied_cost_micro_usd  INTEGER,
  observed_cost_micro_usd INTEGER,
  input_tokens            INTEGER,
  output_tokens           INTEGER,
  billing_basis           TEXT,
  overage_micro_usd       INTEGER NOT NULL DEFAULT 0 CHECK (overage_micro_usd >= 0),
  settlement_revision     INTEGER NOT NULL DEFAULT 0 CHECK (settlement_revision >= 0),
  global_grant_id         TEXT,
  global_grant_expires_ms INTEGER,
  global_synced_at_ms     INTEGER,
  send_authorizing_at_ms  INTEGER,
  send_started_at_ms      INTEGER,
  started_at_ms           INTEGER NOT NULL,
  settled_at_ms           INTEGER,
  PRIMARY KEY (subject_type, subject_id, attempt_no)
);`,
  `CREATE TABLE IF NOT EXISTS agent_spend_days (
  scope_kind         TEXT    NOT NULL CHECK (scope_kind IN ('tenant', 'principal')),
  scope_id           TEXT    NOT NULL,
  utc_day            TEXT    NOT NULL,
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  consumed_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (consumed_micro_usd >= 0),
  overage_micro_usd  INTEGER NOT NULL DEFAULT 0 CHECK (overage_micro_usd >= 0),
  turns_started      INTEGER NOT NULL DEFAULT 0 CHECK (turns_started >= 0),
  updated_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, utc_day)
);`,
  `CREATE TABLE IF NOT EXISTS agent_budget_incidents (
  id                    TEXT    PRIMARY KEY,
  scope_kind            TEXT    NOT NULL CHECK (scope_kind IN ('tenant', 'principal')),
  scope_id              TEXT    NOT NULL,
  utc_day               TEXT    NOT NULL,
  reason                TEXT    NOT NULL CHECK (reason IN ('day_ceiling_exceeded', 'reservation_exceeded', 'usage_missing')),
  subject_type          TEXT,
  subject_id            TEXT,
  attempt_no            INTEGER,
  observed_micro_usd    INTEGER NOT NULL,
  applied_micro_usd     INTEGER NOT NULL,
  overage_micro_usd     INTEGER NOT NULL,
  reservation_micro_usd INTEGER NOT NULL,
  detected_at_ms        INTEGER NOT NULL,
  resolved_at_ms        INTEGER,
  resolved_by           TEXT,
  resolution_note       TEXT
);`,
] as const;

/**
 * Create the A-owned AgentHeadDO business schema migration step (v1), executed alongside
 * Agent B's `createEventRecoveryDoMigration(2)` through the single `applyAgentHeadMigrations` entrypoint.
 */
export function createAgentHeadBusinessDoMigration(
  version = DEFAULT_AGENT_HEAD_BUSINESS_DO_MIGRATION_VERSION,
): AgentHeadMigrationStep {
  return {
    version,
    name: 'v2_agent_head_business_core',
    statements: V2_AGENT_HEAD_BUSINESS_DO_STATEMENTS,
    checksum: computeMigrationChecksumSync(V2_AGENT_HEAD_BUSINESS_DO_STATEMENTS),
  };
}

const DEVICE_EXECUTION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS device_registrations (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    token_digest TEXT NOT NULL,
    capability TEXT NOT NULL,
    capability_version INTEGER NOT NULL,
    ready_until_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS device_task_placements (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL,
    device_id TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_device_task_placements
    ON device_task_placements (principal_id, device_id, task_id)`,
] as const;

const NATIVE_DEVICE_PLACEMENT_STATEMENTS = [
  `ALTER TABLE device_task_placements
     ADD COLUMN capability TEXT NOT NULL DEFAULT 'mock.compute'
       CHECK (capability IN ('mock.compute', 'device.text.process'))`,
  `ALTER TABLE device_task_placements
     ADD COLUMN capability_version INTEGER NOT NULL DEFAULT 1 CHECK (capability_version = 1)`,
] as const;

export const DEFAULT_AGENT_HEAD_WRITE_OPT_MIGRATION_VERSION = 5;

/**
 * M1-A6 DO SQLite write-amplification migration (v5, after M2-F2 v4):
 * - OPT-1: Drop duplicate `idx_messages_conv_seq` (covered by `UNIQUE(conversation_id, sequence)`).
 * - OPT-2: Convert `assistant_turns.response_message_id` from full UNIQUE to partial UNIQUE index.
 * - OPT-5: Rebuild small PK-lookup tables (`assistant_turns`, `model_attempts`,
 *   `agent_spend_days`, `v2_dispatch_outbox`) as `WITHOUT ROWID`, preserving all rows,
 *   UNIQUE/CHECK/FOREIGN KEY constraints, and non-OPT-6 indexes.
 */
export const V2_AGENT_HEAD_WRITE_OPT_V4_STATEMENTS = [
  `DROP INDEX IF EXISTS idx_messages_conv_seq;`,
  `CREATE TABLE assistant_turns_v4 (
  id                      TEXT    PRIMARY KEY,
  conversation_id         TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id       TEXT    NOT NULL UNIQUE REFERENCES conversation_messages(id) ON DELETE CASCADE,
  response_message_id     TEXT    REFERENCES conversation_messages(id) ON DELETE CASCADE,
  status                  TEXT    NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  failure_reason          TEXT    CHECK (failure_reason IS NULL OR failure_reason IN ('timeout', 'internal_error')),
  execution_mode          TEXT    NOT NULL DEFAULT 'fast_interactive'
    CHECK (execution_mode IN ('fast_interactive', 'durable_queue', 'device')),
  deadline_at_ms          INTEGER NOT NULL,
  interactive_deadline_ms INTEGER,
  lease_epoch             INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_owner             TEXT,
  lease_expires_at_ms     INTEGER,
  claim_count             INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  cancel_requested_at_ms  INTEGER,
  provider_job_handle     TEXT,
  handoff_reason          TEXT,
  linked_task_id          TEXT,
  created_at_ms           INTEGER NOT NULL,
  updated_at_ms           INTEGER NOT NULL,
  CHECK ((lease_owner IS NULL) = (lease_expires_at_ms IS NULL)),
  CHECK (status != 'running' OR response_message_id IS NULL),
  CHECK (status NOT IN ('completed', 'failed') OR response_message_id IS NOT NULL),
  CHECK ((status = 'failed' AND failure_reason IS NOT NULL) OR (status != 'failed' AND failure_reason IS NULL))
) WITHOUT ROWID;`,
  `INSERT INTO assistant_turns_v4 (
  id, conversation_id, source_message_id, response_message_id, status, failure_reason,
  execution_mode, deadline_at_ms, interactive_deadline_ms, lease_epoch, lease_owner,
  lease_expires_at_ms, claim_count, cancel_requested_at_ms, provider_job_handle,
  handoff_reason, linked_task_id, created_at_ms, updated_at_ms
) SELECT
  id, conversation_id, source_message_id, response_message_id, status, failure_reason,
  execution_mode, deadline_at_ms, interactive_deadline_ms, lease_epoch, lease_owner,
  lease_expires_at_ms, claim_count, cancel_requested_at_ms, provider_job_handle,
  handoff_reason, linked_task_id, created_at_ms, updated_at_ms
FROM assistant_turns;`,
  `DROP TABLE assistant_turns;`,
  `ALTER TABLE assistant_turns_v4 RENAME TO assistant_turns;`,
  `CREATE INDEX IF NOT EXISTS idx_turns_running_lease
  ON assistant_turns (status, lease_expires_at_ms, deadline_at_ms) WHERE status = 'running';`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_response_message
  ON assistant_turns (response_message_id) WHERE response_message_id IS NOT NULL;`,
  `CREATE TABLE model_attempts_v4 (
  subject_type            TEXT    NOT NULL CHECK (subject_type IN ('turn', 'task')),
  subject_id              TEXT    NOT NULL,
  attempt_no              INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 6),
  operation_id            TEXT    NOT NULL UNIQUE,
  principal_id            TEXT    NOT NULL,
  utc_day                 TEXT    NOT NULL,
  lease_epoch             INTEGER NOT NULL CHECK (lease_epoch >= 0),
  provider_id             TEXT    NOT NULL CHECK (provider_id IN ('fake', 'openai', 'openrouter')),
  model_label             TEXT    NOT NULL,
  rate_version            TEXT    NOT NULL,
  budget_mode             TEXT    NOT NULL CHECK (budget_mode IN ('disabled_echo_only', 'simulated_full_protocol', 'real')),
  state                   TEXT    NOT NULL CHECK (
    state IN ('reserved', 'settled', 'unknown_billed', 'released', 'conservative_billed')
  ),
  outcome_code            TEXT,
  reserved_micro_usd      INTEGER NOT NULL CHECK (reserved_micro_usd BETWEEN 0 AND 5000),
  applied_cost_micro_usd  INTEGER,
  observed_cost_micro_usd INTEGER,
  input_tokens            INTEGER,
  output_tokens           INTEGER,
  billing_basis           TEXT,
  overage_micro_usd       INTEGER NOT NULL DEFAULT 0 CHECK (overage_micro_usd >= 0),
  settlement_revision     INTEGER NOT NULL DEFAULT 0 CHECK (settlement_revision >= 0),
  global_grant_id         TEXT,
  global_grant_expires_ms INTEGER,
  global_synced_at_ms     INTEGER,
  send_authorizing_at_ms  INTEGER,
  send_started_at_ms      INTEGER,
  started_at_ms           INTEGER NOT NULL,
  settled_at_ms           INTEGER,
  PRIMARY KEY (subject_type, subject_id, attempt_no)
) WITHOUT ROWID;`,
  `INSERT INTO model_attempts_v4 (
  subject_type, subject_id, attempt_no, operation_id, principal_id, utc_day, lease_epoch,
  provider_id, model_label, rate_version, budget_mode, state, outcome_code,
  reserved_micro_usd, applied_cost_micro_usd, observed_cost_micro_usd, input_tokens,
  output_tokens, billing_basis, overage_micro_usd, settlement_revision, global_grant_id,
  global_grant_expires_ms, global_synced_at_ms, send_authorizing_at_ms, send_started_at_ms,
  started_at_ms, settled_at_ms
) SELECT
  subject_type, subject_id, attempt_no, operation_id, principal_id, utc_day, lease_epoch,
  provider_id, model_label, rate_version, budget_mode, state, outcome_code,
  reserved_micro_usd, applied_cost_micro_usd, observed_cost_micro_usd, input_tokens,
  output_tokens, billing_basis, overage_micro_usd, settlement_revision, global_grant_id,
  global_grant_expires_ms, global_synced_at_ms, send_authorizing_at_ms, send_started_at_ms,
  started_at_ms, settled_at_ms
FROM model_attempts;`,
  `DROP TABLE model_attempts;`,
  `ALTER TABLE model_attempts_v4 RENAME TO model_attempts;`,
  `CREATE TABLE agent_spend_days_v4 (
  scope_kind         TEXT    NOT NULL CHECK (scope_kind IN ('tenant', 'principal')),
  scope_id           TEXT    NOT NULL,
  utc_day            TEXT    NOT NULL,
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  consumed_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (consumed_micro_usd >= 0),
  overage_micro_usd  INTEGER NOT NULL DEFAULT 0 CHECK (overage_micro_usd >= 0),
  turns_started      INTEGER NOT NULL DEFAULT 0 CHECK (turns_started >= 0),
  updated_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, utc_day)
) WITHOUT ROWID;`,
  `INSERT INTO agent_spend_days_v4 (
  scope_kind, scope_id, utc_day, reserved_micro_usd, consumed_micro_usd,
  overage_micro_usd, turns_started, updated_at_ms
) SELECT
  scope_kind, scope_id, utc_day, reserved_micro_usd, consumed_micro_usd,
  overage_micro_usd, turns_started, updated_at_ms
FROM agent_spend_days;`,
  `DROP TABLE agent_spend_days;`,
  `ALTER TABLE agent_spend_days_v4 RENAME TO agent_spend_days;`,
  `CREATE TABLE v2_dispatch_outbox_v4 (
  outbox_id            TEXT    PRIMARY KEY,
  entity_kind          TEXT    NOT NULL CHECK (entity_kind IN ('turn', 'task', 'schedule_occurrence', 'handoff', 'budget_sync')),
  entity_id            TEXT    NOT NULL,
  queue_name           TEXT    CHECK (queue_name IS NULL OR queue_name IN ('durable_turn', 'agent_task')),
  payload_json         TEXT    NOT NULL,
  operation_id         TEXT,
  revision             INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state                TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'enqueued', 'acked', 'dead_lettered', 'cancelled')),
  next_attempt_at_ms   INTEGER NOT NULL,
  last_enqueued_at_ms  INTEGER,
  publish_attempts     INTEGER NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  dlq_count            INTEGER NOT NULL DEFAULT 0 CHECK (dlq_count >= 0),
  fence_epoch          INTEGER NOT NULL DEFAULT 0 CHECK (fence_epoch >= 0 AND fence_epoch <= 9007199254740991),
  last_error_code      TEXT,
  created_at_ms        INTEGER NOT NULL,
  updated_at_ms        INTEGER NOT NULL,
  CHECK (
    (entity_kind = 'budget_sync' AND queue_name IS NULL AND operation_id IS NOT NULL)
    OR
    (entity_kind IN ('turn', 'task', 'schedule_occurrence', 'handoff') AND queue_name IS NOT NULL AND queue_name IN ('durable_turn', 'agent_task'))
  )
) WITHOUT ROWID;`,
  `INSERT INTO v2_dispatch_outbox_v4 (
  outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id, revision,
  state, next_attempt_at_ms, last_enqueued_at_ms, publish_attempts, dlq_count,
  fence_epoch, last_error_code, created_at_ms, updated_at_ms
) SELECT
  outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id, revision,
  state, next_attempt_at_ms, last_enqueued_at_ms, publish_attempts, dlq_count,
  fence_epoch, last_error_code, created_at_ms, updated_at_ms
FROM v2_dispatch_outbox;`,
  `DROP TABLE v2_dispatch_outbox;`,
  `ALTER TABLE v2_dispatch_outbox_v4 RENAME TO v2_dispatch_outbox;`,
  `CREATE INDEX IF NOT EXISTS idx_v2_outbox_due
  ON v2_dispatch_outbox (next_attempt_at_ms, outbox_id)
  WHERE state IN ('pending', 'enqueued', 'dead_lettered');`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_outbox_budget_sync_op_rev
  ON v2_dispatch_outbox (operation_id, revision)
  WHERE entity_kind = 'budget_sync';`,
] as const;

export function createAgentHeadWriteOptMigration(
  version = DEFAULT_AGENT_HEAD_WRITE_OPT_MIGRATION_VERSION,
): AgentHeadMigrationStep {
  return {
    version,
    name: 'v2_sqlite_write_opt_v1',
    statements: V2_AGENT_HEAD_WRITE_OPT_V4_STATEMENTS,
    checksum: computeMigrationChecksumSync(V2_AGENT_HEAD_WRITE_OPT_V4_STATEMENTS),
  };
}

/** Agent Head migrations share the existing DO database and recovery registry. */
export function createDefaultAgentHeadMigrations(): readonly AgentHeadMigrationStep[] {
  return [
    createAgentHeadBusinessDoMigration(),
    createEventRecoveryDoMigration(),
    {
      version: 3,
      name: 'v2_device_execution',
      statements: DEVICE_EXECUTION_STATEMENTS,
      checksum: computeMigrationChecksumSync(DEVICE_EXECUTION_STATEMENTS),
    },
    {
      version: 4,
      name: 'v2_native_device_placement',
      statements: NATIVE_DEVICE_PLACEMENT_STATEMENTS,
      checksum: computeMigrationChecksumSync(NATIVE_DEVICE_PLACEMENT_STATEMENTS),
    },
    createAgentHeadWriteOptMigration(),
  ];
}
