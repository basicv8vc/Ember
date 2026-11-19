/**
 * Canonical B-owned SQLite (DO) and D1 DDL definitions per V2-M0-B §2.2
 * and A/B Joint Review J1/J3/J5.
 */

export const MAX_FENCE_EPOCH = 9_007_199_254_740_991;

export type ScheduleSourceKind = 'commitment' | 'reminder' | 'deferred_task' | 'cleanup';

export type ScheduleKind = 'once' | 'interval' | 'cron_tz';

export type MisfirePolicy = 'coalesce_latest' | 'fire_once' | 'skip_missed';

export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface V2ScheduleRow {
  readonly schedule_id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly source_kind: ScheduleSourceKind;
  readonly source_id: string;
  readonly schedule_kind: ScheduleKind;
  readonly interval_seconds: number | null;
  readonly cron_expr: string | null;
  readonly timezone: string;
  readonly next_fire_at_ms: number;
  readonly last_fired_at_ms: number | null;
  readonly occurrence_seq: number;
  readonly misfire_policy: MisfirePolicy;
  readonly status: ScheduleStatus;
  readonly version: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export type OutboxEntityKind = 'turn' | 'task' | 'schedule_occurrence' | 'handoff' | 'budget_sync';

export type OrdinaryOutboxEntityKind = Exclude<OutboxEntityKind, 'budget_sync'>;

export type V2QueueName = 'durable_turn' | 'agent_task';

export type OutboxState = 'pending' | 'enqueued' | 'acked' | 'dead_lettered' | 'cancelled';

export interface V2DispatchOutboxRow {
  readonly outbox_id: string;
  readonly entity_kind: OutboxEntityKind;
  readonly entity_id: string;
  readonly queue_name: V2QueueName | null;
  readonly payload_json: string;
  readonly operation_id: string | null;
  readonly revision: number;
  readonly state: OutboxState;
  readonly next_attempt_at_ms: number;
  readonly last_enqueued_at_ms: number | null;
  readonly publish_attempts: number;
  readonly dlq_count: number;
  readonly fence_epoch: number;
  readonly last_error_code: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export type RecoveryCoverageState = 'uncovered' | 'registering' | 'covered';

export type RecoveryPendingKind = 'ensure' | 'postpone' | 'retire';

export interface V2RecoveryCoverageRow {
  readonly id: 1;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly generation: number;
  readonly coverage_state: RecoveryCoverageState;
  readonly covered_recovery_at_ms: number | null;
  readonly pending_kind: RecoveryPendingKind | null;
  readonly pending_prev_generation: number | null;
  readonly pending_target_at_ms: number | null;
  readonly armed_alarm_at_ms: number | null;
  readonly alarm_fail_count: number;
  readonly last_d1_sync_at_ms: number | null;
  readonly updated_at_ms: number;
}

export type RecoveryRegistryStatus = 'armed' | 'backoff' | 'quarantined';

export interface V2RecoveryRegistryRow {
  readonly agent_key: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly generation: number;
  readonly next_recovery_at_ms: number;
  readonly retry_not_before_ms: number | null;
  readonly status: RecoveryRegistryStatus;
  readonly sweep_lease_owner: string | null;
  readonly sweep_lease_expires_at_ms: number | null;
  readonly recovery_attempts: number;
  readonly last_error_code: string | null;
  readonly updated_at_ms: number;
}

export const V2_SCHEDULES_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS v2_schedules (
  schedule_id       TEXT    PRIMARY KEY,
  tenant_id         TEXT    NOT NULL,
  agent_id          TEXT    NOT NULL,
  source_kind       TEXT    NOT NULL CHECK (source_kind IN ('commitment', 'reminder', 'deferred_task', 'cleanup')),
  source_id         TEXT    NOT NULL,
  schedule_kind     TEXT    NOT NULL CHECK (schedule_kind IN ('once', 'interval', 'cron_tz')),
  interval_seconds  INTEGER CHECK (interval_seconds IS NULL OR (interval_seconds BETWEEN 60 AND 2592000)),
  cron_expr         TEXT,
  timezone          TEXT    NOT NULL DEFAULT 'UTC',
  next_fire_at_ms   INTEGER NOT NULL,
  last_fired_at_ms  INTEGER,
  occurrence_seq    INTEGER NOT NULL DEFAULT 0 CHECK (occurrence_seq >= 0),
  misfire_policy    TEXT    NOT NULL DEFAULT 'coalesce_latest'
                    CHECK (misfire_policy IN ('coalesce_latest', 'fire_once', 'skip_missed')),
  status            TEXT    NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at_ms     INTEGER NOT NULL,
  updated_at_ms     INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_v2_schedules_due
  ON v2_schedules (next_fire_at_ms, schedule_id)
  WHERE status = 'active';`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_schedules_source
  ON v2_schedules (source_kind, source_id);`,
] as const;

export const V2_DISPATCH_OUTBOX_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS v2_dispatch_outbox (
  outbox_id            TEXT    PRIMARY KEY,
  entity_kind          TEXT    NOT NULL CHECK (entity_kind IN ('turn', 'task', 'schedule_occurrence', 'handoff', 'budget_sync')),
  entity_id            TEXT    NOT NULL,
  queue_name           TEXT    CHECK (queue_name IS NULL OR queue_name IN ('durable_turn', 'agent_task')),
  payload_json         TEXT    NOT NULL,
  operation_id         TEXT,
  revision             INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state                TEXT    NOT NULL CHECK (state IN ('pending', 'enqueued', 'acked', 'dead_lettered', 'cancelled')),
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
);`,
  `CREATE INDEX IF NOT EXISTS idx_v2_outbox_due
  ON v2_dispatch_outbox (next_attempt_at_ms, outbox_id)
  WHERE state IN ('pending', 'enqueued', 'dead_lettered');`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_outbox_budget_sync_op_rev
  ON v2_dispatch_outbox (operation_id, revision)
  WHERE entity_kind = 'budget_sync';`,
] as const;

export const V2_RECOVERY_COVERAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS v2_recovery_coverage (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id                TEXT    NOT NULL,
  agent_id                 TEXT    NOT NULL,
  generation               INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= 9007199254740991),
  coverage_state           TEXT    NOT NULL DEFAULT 'uncovered' CHECK (coverage_state IN ('uncovered', 'registering', 'covered')),
  covered_recovery_at_ms   INTEGER,
  pending_kind             TEXT    CHECK (pending_kind IS NULL OR pending_kind IN ('ensure', 'postpone', 'retire')),
  pending_prev_generation  INTEGER CHECK (pending_prev_generation IS NULL OR pending_prev_generation >= 0),
  pending_target_at_ms     INTEGER,
  armed_alarm_at_ms        INTEGER,
  alarm_fail_count         INTEGER NOT NULL DEFAULT 0 CHECK (alarm_fail_count >= 0),
  last_d1_sync_at_ms       INTEGER,
  updated_at_ms            INTEGER NOT NULL,
  CHECK (coverage_state <> 'covered' OR covered_recovery_at_ms IS NOT NULL),
  CHECK (pending_kind IS NULL OR (pending_kind = 'retire' AND pending_target_at_ms IS NULL) OR (pending_kind IN ('ensure', 'postpone') AND pending_target_at_ms IS NOT NULL))
);`,
] as const;

export const V2_RECOVERY_REGISTRY_D1_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS v2_recovery_registry (
  agent_key                 TEXT    PRIMARY KEY,
  tenant_id                 TEXT    NOT NULL,
  agent_id                  TEXT    NOT NULL,
  generation                INTEGER NOT NULL CHECK (generation >= 0 AND generation <= 9007199254740991),
  next_recovery_at_ms       INTEGER NOT NULL,
  retry_not_before_ms       INTEGER,
  status                    TEXT    NOT NULL CHECK (status IN ('armed', 'backoff', 'quarantined')),
  sweep_lease_owner         TEXT,
  sweep_lease_expires_at_ms INTEGER,
  recovery_attempts         INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
  last_error_code           TEXT,
  updated_at_ms             INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_v2_recovery_due
  ON v2_recovery_registry (next_recovery_at_ms, agent_key)
  WHERE status IN ('armed', 'backoff', 'quarantined');`,
] as const;

export const V2_SCHEDULES_DDL = V2_SCHEDULES_STATEMENTS.join('\n\n');
export const V2_DISPATCH_OUTBOX_DDL = V2_DISPATCH_OUTBOX_STATEMENTS.join('\n\n');
export const V2_RECOVERY_COVERAGE_DDL = V2_RECOVERY_COVERAGE_STATEMENTS.join('\n\n');
export const V2_RECOVERY_REGISTRY_D1_DDL = V2_RECOVERY_REGISTRY_D1_STATEMENTS.join('\n\n');

export const V2_EVENT_RECOVERY_DO_STATEMENTS = [
  ...V2_SCHEDULES_STATEMENTS,
  ...V2_DISPATCH_OUTBOX_STATEMENTS,
  ...V2_RECOVERY_COVERAGE_STATEMENTS,
] as const;
