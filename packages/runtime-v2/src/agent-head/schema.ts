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

/** Canonical ordered AgentHeadDO migrations (A v1 business tables + B v2 event/recovery tables). */
export function createDefaultAgentHeadMigrations(): readonly AgentHeadMigrationStep[] {
  return [createAgentHeadBusinessDoMigration(), createEventRecoveryDoMigration()];
}
