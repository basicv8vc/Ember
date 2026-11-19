import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

/**
 * Isolated, simplified M0-B protocol probe (NOT an end-to-end Workers/DO/D1 proof).
 *
 * Uses two in-memory `node:sqlite` databases (`AgentHeadDO` SQLite and `D1RecoveryRegistry`),
 * test-only fake business tables (`probe_turns_and_tasks`, `probe_committed_results`,
 * `probe_global_budget_ledger` simulating Agent A's authoritative tables), and a virtual clock
 * to deterministically verify the canonical shared DDL and J1–J5 protocol invariants defined in
 * `docs/architecture/v2-m0-event-recovery-contract.md`.
 */

const V2_TOTAL_DEADLINE_MS = 600_000;
const V2_INTERACTIVE_PHASE_MS = 120_000;
const V2_INTERACTIVE_LEASE_MS = 45_000;
const V2_INTERACTIVE_RENEW_INTERVAL_MS = 15_000;
const B1_TOTAL_DEADLINE_MS = 60_000;
const B1_FAST_HANDOFF_MS = 22_000;
const B1_FAST_LEASE_MS = 25_000;

const OUTBOX_IMMEDIATE_GRACE_MS = 2_000;
const OUTBOX_REENQUEUE_GRACE_MS = 60_000;
const OUTBOX_MIN_RETRY_FLOOR_MS = 5_000;
const OUTBOX_RETRY_HEADROOM_MS = 5_000;
const D1_RECOVERY_GRACE_MS = 45_000;
const SWEEPER_CADENCE_MS = 60_000;
const SWEEP_LEASE_MS = 30_000;
const MAX_ALARM_RETRIES = 6;
const QUARANTINE_THRESHOLD = 3;

type CoverageState = 'uncovered' | 'registering' | 'covered';
type PendingKind = 'ensure' | 'postpone' | 'retire';
type RegistryStatus = 'armed' | 'backoff' | 'quarantined';
type ExecutionMode = 'interactive_fast' | 'durable_queue' | 'device_node';
type BusinessStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'retryable_failed'
  | 'completed'
  | 'failed'
  | 'cancelled';
type D1FaultMode = 'healthy' | 'unavailable' | 'uncertain_timeout';

interface V2DispatchEnvelope {
  readonly schemaVersion: 2;
  readonly eventId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly entityKind: 'turn' | 'task' | 'schedule_occurrence' | 'handoff';
  readonly entityId: string;
  readonly queueName: 'durable_turn' | 'agent_task';
  readonly fenceEpoch: number;
}

interface BudgetSyncPayload {
  readonly kind: 'budget_sync';
  readonly op: 'settle' | 'release';
  readonly subjectType: 'turn' | 'task';
  readonly subjectId: string;
  readonly operationId: string;
  readonly revision: number;
  readonly amountMicroUsd: number;
}

class VirtualClock {
  nowMs: number;

  constructor(initialMs = 1_700_000_000_000) {
    this.nowMs = initialMs;
  }

  advanceBy(ms: number): number {
    this.nowMs += ms;
    return this.nowMs;
  }
}

class ProtocolError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function cappedReenqueueAtMs(nowMs: number, deadlineAtMs: number): number {
  const remainingWindow = Math.max(
    nowMs + OUTBOX_MIN_RETRY_FLOOR_MS,
    deadlineAtMs - OUTBOX_RETRY_HEADROOM_MS,
  );
  return Math.min(nowMs + OUTBOX_REENQUEUE_GRACE_MS, remainingWindow);
}

/**
 * Canonical D1 `v2_recovery_registry` simulator.
 * Enforces J2 (returns actual DB generation & timestamp) and J3 (`next_recovery_at_ms` is immutable
 * on Sweeper backoff/quarantine; separate `retry_not_before_ms` + owner/generation CAS).
 */
class D1RecoveryRegistry {
  readonly db: DatabaseSync;
  faultMode: D1FaultMode = 'healthy';
  reads = 0;
  writes = 0;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      CREATE TABLE v2_recovery_registry (
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
      );
      CREATE INDEX idx_v2_recovery_due
        ON v2_recovery_registry (next_recovery_at_ms, agent_key)
        WHERE status IN ('armed', 'backoff', 'quarantined');
    `);
  }

  private maybeInjectFault(commitAnywayOnUncertain?: () => void): void {
    if (this.faultMode === 'unavailable') {
      throw new ProtocolError('DB_UNAVAILABLE', 503, 'D1 recovery registry unavailable');
    }
    if (this.faultMode === 'uncertain_timeout') {
      commitAnywayOnUncertain?.();
      throw new ProtocolError('DB_UNAVAILABLE', 503, 'D1 recovery registry response timed out');
    }
  }

  readCoverage(cmd: { readonly tenantId: string; readonly agentId: string }): {
    readonly exists: boolean;
    readonly currentGeneration: number | null;
    readonly actualRecoveryAtMs: number | null;
    readonly status: RegistryStatus | null;
  } {
    this.maybeInjectFault();
    this.reads += 1;
    const row = this.db
      .prepare(
        `SELECT generation, next_recovery_at_ms, status
         FROM v2_recovery_registry
         WHERE agent_key = ?`,
      )
      .get(`${cmd.tenantId}:${cmd.agentId}`) as
      { generation: number; next_recovery_at_ms: number; status: RegistryStatus } | undefined;

    if (!row) {
      return { exists: false, currentGeneration: null, actualRecoveryAtMs: null, status: null };
    }
    return {
      exists: true,
      currentGeneration: row.generation,
      actualRecoveryAtMs: row.next_recovery_at_ms,
      status: row.status,
    };
  }

  upsertCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly generation: number;
    readonly recoveryAtMs: number;
    readonly nowMs: number;
  }): {
    readonly accepted: boolean;
    readonly currentGeneration: number;
    readonly actualRecoveryAtMs: number | null;
  } {
    const agentKey = `${cmd.tenantId}:${cmd.agentId}`;
    const execute = (): {
      accepted: boolean;
      currentGeneration: number;
      actualRecoveryAtMs: number | null;
    } => {
      this.writes += 1;
      const result = this.db
        .prepare(
          `INSERT INTO v2_recovery_registry (
            agent_key, tenant_id, agent_id, generation, next_recovery_at_ms,
            retry_not_before_ms, status, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, NULL, 'armed', ?)
          ON CONFLICT (agent_key) DO UPDATE SET
            generation = excluded.generation,
            next_recovery_at_ms = CASE
              WHEN v2_recovery_registry.next_recovery_at_ms < excluded.next_recovery_at_ms
              THEN v2_recovery_registry.next_recovery_at_ms
              ELSE excluded.next_recovery_at_ms
            END,
            retry_not_before_ms = NULL,
            status = 'armed',
            sweep_lease_owner = NULL,
            sweep_lease_expires_at_ms = NULL,
            recovery_attempts = 0,
            last_error_code = NULL,
            updated_at_ms = excluded.updated_at_ms
          WHERE v2_recovery_registry.generation < excluded.generation`,
        )
        .run(agentKey, cmd.tenantId, cmd.agentId, cmd.generation, cmd.recoveryAtMs, cmd.nowMs);

      this.reads += 1;
      const actual = this.db
        .prepare(
          'SELECT generation, next_recovery_at_ms FROM v2_recovery_registry WHERE agent_key = ?',
        )
        .get(agentKey) as { generation: number; next_recovery_at_ms: number } | undefined;

      return {
        accepted: Number(result.changes) > 0,
        currentGeneration: actual?.generation ?? 0,
        actualRecoveryAtMs: actual?.next_recovery_at_ms ?? null,
      };
    };

    if (this.faultMode === 'uncertain_timeout') {
      this.maybeInjectFault(() => {
        execute();
      });
    }
    this.maybeInjectFault();
    return execute();
  }

  postponeCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly expectedPrevGen: number;
    readonly newGeneration: number;
    readonly nextRecoveryAtMs: number;
    readonly nowMs: number;
  }): {
    readonly updated: boolean;
    readonly currentGeneration: number;
    readonly actualRecoveryAtMs: number | null;
  } {
    const agentKey = `${cmd.tenantId}:${cmd.agentId}`;
    const execute = (): {
      updated: boolean;
      currentGeneration: number;
      actualRecoveryAtMs: number | null;
    } => {
      this.writes += 1;
      const result = this.db
        .prepare(
          `UPDATE v2_recovery_registry
           SET generation = ?,
               next_recovery_at_ms = ?,
               retry_not_before_ms = NULL,
               status = 'armed',
               sweep_lease_owner = NULL,
               sweep_lease_expires_at_ms = NULL,
               recovery_attempts = 0,
               last_error_code = NULL,
               updated_at_ms = ?
           WHERE agent_key = ?
             AND generation = ?`,
        )
        .run(cmd.newGeneration, cmd.nextRecoveryAtMs, cmd.nowMs, agentKey, cmd.expectedPrevGen);

      this.reads += 1;
      const actual = this.db
        .prepare(
          'SELECT generation, next_recovery_at_ms FROM v2_recovery_registry WHERE agent_key = ?',
        )
        .get(agentKey) as { generation: number; next_recovery_at_ms: number } | undefined;

      return {
        updated: Number(result.changes) > 0,
        currentGeneration: actual?.generation ?? 0,
        actualRecoveryAtMs: actual?.next_recovery_at_ms ?? null,
      };
    };

    if (this.faultMode === 'uncertain_timeout') {
      this.maybeInjectFault(() => {
        execute();
      });
    }
    this.maybeInjectFault();
    return execute();
  }

  retireCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly retireUpToGen: number;
  }): { readonly retired: boolean } {
    const agentKey = `${cmd.tenantId}:${cmd.agentId}`;
    const execute = (): { retired: boolean } => {
      this.writes += 1;
      const result = this.db
        .prepare(
          `DELETE FROM v2_recovery_registry
           WHERE agent_key = ?
             AND generation <= ?`,
        )
        .run(agentKey, cmd.retireUpToGen);
      return { retired: Number(result.changes) > 0 };
    };

    if (this.faultMode === 'uncertain_timeout') {
      this.maybeInjectFault(() => {
        execute();
      });
    }
    this.maybeInjectFault();
    return execute();
  }

  claimDueMarkers(input: {
    readonly sweeperId: string;
    readonly nowMs: number;
    readonly limit: number;
  }): Array<{
    readonly agentKey: string;
    readonly tenantId: string;
    readonly agentId: string;
    readonly generation: number;
    readonly nextRecoveryAtMs: number;
  }> {
    this.maybeInjectFault();
    const rows = this.db
      .prepare(
        `SELECT agent_key, tenant_id, agent_id, generation, next_recovery_at_ms
         FROM v2_recovery_registry
         WHERE status IN ('armed', 'backoff', 'quarantined')
           AND next_recovery_at_ms <= ?
           AND (retry_not_before_ms IS NULL OR retry_not_before_ms <= ?)
           AND (sweep_lease_expires_at_ms IS NULL OR sweep_lease_expires_at_ms <= ?)
         ORDER BY next_recovery_at_ms ASC, agent_key ASC
         LIMIT ?`,
      )
      .all(input.nowMs, input.nowMs, input.nowMs, input.limit) as Array<{
      agent_key: string;
      tenant_id: string;
      agent_id: string;
      generation: number;
      next_recovery_at_ms: number;
    }>;

    this.reads += Math.max(1, rows.length);
    const claimed: Array<{
      agentKey: string;
      tenantId: string;
      agentId: string;
      generation: number;
      nextRecoveryAtMs: number;
    }> = [];

    for (const row of rows) {
      this.writes += 1;
      const res = this.db
        .prepare(
          `UPDATE v2_recovery_registry
           SET sweep_lease_owner = ?,
               sweep_lease_expires_at_ms = ?,
               updated_at_ms = ?
           WHERE agent_key = ?
             AND generation = ?
             AND (sweep_lease_expires_at_ms IS NULL OR sweep_lease_expires_at_ms <= ?)`,
        )
        .run(
          input.sweeperId,
          input.nowMs + SWEEP_LEASE_MS,
          input.nowMs,
          row.agent_key,
          row.generation,
          input.nowMs,
        );
      if (Number(res.changes) > 0) {
        claimed.push({
          agentKey: row.agent_key,
          tenantId: row.tenant_id,
          agentId: row.agent_id,
          generation: row.generation,
          nextRecoveryAtMs: row.next_recovery_at_ms,
        });
      }
    }

    return claimed;
  }

  /**
   * J3: CAS on (agent_key, generation, sweep_lease_owner).
   * NEVER alters `next_recovery_at_ms`; only advances `retry_not_before_ms` & status.
   */
  recordSweepFailure(input: {
    readonly agentKey: string;
    readonly generation: number;
    readonly sweeperId: string;
    readonly errorCode: string;
    readonly nowMs: number;
  }): { readonly applied: boolean } {
    this.maybeInjectFault();
    const current = this.db
      .prepare('SELECT recovery_attempts FROM v2_recovery_registry WHERE agent_key = ?')
      .get(input.agentKey) as { recovery_attempts: number } | undefined;
    if (!current) {
      return { applied: false };
    }
    const nextAttempts = current.recovery_attempts + 1;
    const nextStatus: RegistryStatus =
      nextAttempts >= QUARANTINE_THRESHOLD ? 'quarantined' : 'backoff';
    const delayMs =
      nextStatus === 'quarantined' ? 120_000 : Math.min(60_000, 15_000 * nextAttempts);

    this.writes += 1;
    const res = this.db
      .prepare(
        `UPDATE v2_recovery_registry
         SET status = ?,
             retry_not_before_ms = ?,
             recovery_attempts = ?,
             sweep_lease_owner = NULL,
             sweep_lease_expires_at_ms = NULL,
             last_error_code = ?,
             updated_at_ms = ?
         WHERE agent_key = ?
           AND generation = ?
           AND sweep_lease_owner = ?`,
      )
      .run(
        nextStatus,
        input.nowMs + delayMs,
        nextAttempts,
        input.errorCode,
        input.nowMs,
        input.agentKey,
        input.generation,
        input.sweeperId,
      );
    return { applied: Number(res.changes) > 0 };
  }

  snapshot(agentKey: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM v2_recovery_registry WHERE agent_key = ?').get(agentKey);
  }

  resetMeters(): void {
    this.reads = 0;
    this.writes = 0;
  }
}

class SimulatedQueueBus {
  readonly deliveries: Array<{ envelope: V2DispatchEnvelope; readyAtMs: number }> = [];
  failNextSends = 0;
  duplicateNextSend = false;

  send(envelope: V2DispatchEnvelope, nowMs: number): void {
    if (this.failNextSends > 0) {
      this.failNextSends -= 1;
      throw new ProtocolError('QUEUE_UNAVAILABLE', 503, 'Simulated Queue.send failure');
    }
    this.deliveries.push({ envelope, readyAtMs: nowMs });
    if (this.duplicateNextSend) {
      this.duplicateNextSend = false;
      this.deliveries.push({ envelope, readyAtMs: nowMs });
    }
  }
}

class FakeGlobalBudgetAuthority {
  readonly settled = new Map<string, BudgetSyncPayload>();
  failNextSettles = 0;

  settleGlobal(payload: BudgetSyncPayload): { readonly acked: boolean } {
    if (this.failNextSettles > 0) {
      this.failNextSettles -= 1;
      throw new ProtocolError('BUDGET_UNAVAILABLE', 503, 'Simulated global budget outage');
    }
    const key = `${payload.operationId}:${payload.revision}`;
    this.settled.set(key, payload);
    return { acked: true };
  }
}

class AgentHeadDOProbe {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  readonly agentId: string;
  readonly clock: VirtualClock;
  readonly registry: D1RecoveryRegistry;
  readonly queue: SimulatedQueueBus;
  readonly globalBudget: FakeGlobalBudgetAuthority;

  // Fault-injection seams
  alarmFailureBudget = 0;
  alarmRetryExhaustedAtMs: number | null = null;
  alarmRetryDelaysMs = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000];
  crashAfterD1BeforeDoCommit = false;
  crashAfterPendingPersistBeforeD1 = false;
  crashAfterD1CasLoseAck = false;
  crashAfterQueueSendBeforeOutboxUpdate = false;
  rpcUnavailable = false;
  onBeforeRemoteRetirement?: () => Promise<void> | void;

  // Alarm simulation state
  armedAlarmAtMs: number | null = null;
  alarmRetriesUsed = 0;
  alarmDead = false;
  transcriptEpoch = 0;

  constructor(opts: {
    tenantId: string;
    agentId: string;
    clock: VirtualClock;
    registry: D1RecoveryRegistry;
    queue: SimulatedQueueBus;
    globalBudget?: FakeGlobalBudgetAuthority;
  }) {
    this.tenantId = opts.tenantId;
    this.agentId = opts.agentId;
    this.clock = opts.clock;
    this.registry = opts.registry;
    this.queue = opts.queue;
    this.globalBudget = opts.globalBudget ?? new FakeGlobalBudgetAuthority();
    this.db = new DatabaseSync(':memory:');

    this.db.exec(`
      -- Canonical Agent B shared DDL: v2_schedules
      CREATE TABLE v2_schedules (
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
      );
      CREATE INDEX idx_v2_schedules_due
        ON v2_schedules (next_fire_at_ms, schedule_id)
        WHERE status = 'active';
      CREATE UNIQUE INDEX idx_v2_schedules_source
        ON v2_schedules (source_kind, source_id);

      -- Canonical Agent B shared DDL: v2_dispatch_outbox (ordinary queues + internal budget_sync)
      CREATE TABLE v2_dispatch_outbox (
        outbox_id            TEXT    PRIMARY KEY,
        entity_kind          TEXT    NOT NULL CHECK (entity_kind IN ('turn', 'task', 'schedule_occurrence', 'handoff', 'budget_sync')),
        entity_id            TEXT    NOT NULL,
        queue_name           TEXT    CHECK (queue_name IS NULL OR queue_name IN ('durable_turn', 'agent_task')),
        payload_json         TEXT    NOT NULL,
        operation_id         TEXT,
        revision             INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
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
          (entity_kind IN ('turn', 'task', 'schedule_occurrence', 'handoff') AND queue_name IN ('durable_turn', 'agent_task'))
        )
      );
      CREATE INDEX idx_v2_outbox_due
        ON v2_dispatch_outbox (next_attempt_at_ms, outbox_id)
        WHERE state IN ('pending', 'enqueued', 'dead_lettered');
      CREATE UNIQUE INDEX idx_v2_outbox_budget_sync_op_rev
        ON v2_dispatch_outbox (operation_id, revision)
        WHERE entity_kind = 'budget_sync';

      -- Canonical Agent B shared DDL: v2_recovery_coverage
      CREATE TABLE v2_recovery_coverage (
        id                      INTEGER PRIMARY KEY CHECK (id = 1),
        tenant_id               TEXT    NOT NULL,
        agent_id                TEXT    NOT NULL,
        generation              INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= 9007199254740991),
        coverage_state          TEXT    NOT NULL DEFAULT 'uncovered'
                                CHECK (coverage_state IN ('uncovered', 'registering', 'covered')),
        covered_recovery_at_ms  INTEGER,
        pending_kind            TEXT    CHECK (pending_kind IS NULL OR pending_kind IN ('ensure', 'postpone', 'retire')),
        pending_prev_generation INTEGER,
        pending_target_at_ms    INTEGER,
        armed_alarm_at_ms       INTEGER,
        alarm_fail_count        INTEGER NOT NULL DEFAULT 0,
        last_d1_sync_at_ms      INTEGER,
        updated_at_ms           INTEGER NOT NULL
      );

      -- TEST-ONLY FAKE of Agent A's authoritative tables (assistant_turns + tasks + runs + model_attempts).
      -- NOT production DDL! In production, Agent A owns these tables exclusively.
      CREATE TABLE probe_turns_and_tasks (
        target_kind             TEXT    NOT NULL CHECK (target_kind IN ('turn', 'task')),
        target_id               TEXT    NOT NULL,
        execution_mode          TEXT    NOT NULL CHECK (execution_mode IN ('interactive_fast', 'durable_queue', 'device_node')),
        status                  TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'retryable_failed', 'completed', 'failed', 'cancelled')),
        active_run_id           TEXT,
        lease_epoch             INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0 AND lease_epoch <= 9007199254740991),
        lease_owner             TEXT,
        lease_expires_at_ms     INTEGER,
        interactive_deadline_ms INTEGER,
        deadline_at_ms          INTEGER NOT NULL,
        transcript_epoch        INTEGER NOT NULL DEFAULT 0,
        provider_job_handle     TEXT,
        send_started_at_ms      INTEGER,
        cancel_requested_at_ms  INTEGER,
        attempt_count           INTEGER NOT NULL DEFAULT 0,
        next_action_at_ms       INTEGER,
        updated_at_ms           INTEGER NOT NULL,
        PRIMARY KEY (target_kind, target_id)
      );

      CREATE TABLE probe_committed_results (
        target_id       TEXT    PRIMARY KEY,
        run_id          TEXT    NOT NULL,
        lease_epoch     INTEGER NOT NULL,
        result_text     TEXT    NOT NULL,
        committed_at_ms INTEGER NOT NULL
      );
    `);

    this.db
      .prepare(
        `INSERT INTO v2_recovery_coverage (
          id, tenant_id, agent_id, generation, coverage_state, updated_at_ms
        ) VALUES (1, ?, ?, 0, 'uncovered', ?)`,
      )
      .run(this.tenantId, this.agentId, this.clock.nowMs);
  }

  private transactionSync<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = fn();
      this.db.exec('COMMIT');
      return res;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private getCoverage(): {
    generation: number;
    coverage_state: CoverageState;
    covered_recovery_at_ms: number | null;
    pending_kind: PendingKind | null;
    pending_prev_generation: number | null;
    pending_target_at_ms: number | null;
    armed_alarm_at_ms: number | null;
  } {
    return this.db
      .prepare(
        `SELECT generation, coverage_state, covered_recovery_at_ms,
                pending_kind, pending_prev_generation, pending_target_at_ms, armed_alarm_at_ms
         FROM v2_recovery_coverage WHERE id = 1`,
      )
      .get() as {
      generation: number;
      coverage_state: CoverageState;
      covered_recovery_at_ms: number | null;
      pending_kind: PendingKind | null;
      pending_prev_generation: number | null;
      pending_target_at_ms: number | null;
      armed_alarm_at_ms: number | null;
    };
  }

  /** Simulates A's AuthoritativeBusinessPort.earliestRequiredDiscoveryAtMsSync(). */
  private earliestRequiredDiscoveryAtMsSync(extraCandidateBoundMs?: number): number | null {
    const bizMin = this.db
      .prepare(
        `SELECT MIN(next_action_at_ms) AS m
         FROM probe_turns_and_tasks
         WHERE status IN ('queued', 'running', 'retryable_failed') AND next_action_at_ms IS NOT NULL`,
      )
      .get() as { m: number | null };
    const outboxMin = this.db
      .prepare(
        `SELECT MIN(next_attempt_at_ms) AS m
         FROM v2_dispatch_outbox
         WHERE state IN ('pending', 'enqueued', 'dead_lettered')`,
      )
      .get() as { m: number | null };
    const schedMin = this.db
      .prepare(`SELECT MIN(next_fire_at_ms) AS m FROM v2_schedules WHERE status = 'active'`)
      .get() as { m: number | null };

    const candidates: number[] = [];
    if (bizMin.m !== null) candidates.push(bizMin.m + D1_RECOVERY_GRACE_MS);
    if (outboxMin.m !== null) candidates.push(outboxMin.m + D1_RECOVERY_GRACE_MS);
    if (schedMin.m !== null) candidates.push(schedMin.m + D1_RECOVERY_GRACE_MS);
    if (extraCandidateBoundMs !== undefined) candidates.push(extraCandidateBoundMs);

    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  private computeEarliestAlarmAtMs(): number | null {
    const bizMin = this.db
      .prepare(
        `SELECT MIN(next_action_at_ms) AS m
         FROM probe_turns_and_tasks
         WHERE status IN ('queued', 'running', 'retryable_failed') AND next_action_at_ms IS NOT NULL`,
      )
      .get() as { m: number | null };
    const outboxMin = this.db
      .prepare(
        `SELECT MIN(next_attempt_at_ms) AS m
         FROM v2_dispatch_outbox
         WHERE state IN ('pending', 'enqueued', 'dead_lettered')`,
      )
      .get() as { m: number | null };
    const schedMin = this.db
      .prepare(`SELECT MIN(next_fire_at_ms) AS m FROM v2_schedules WHERE status = 'active'`)
      .get() as { m: number | null };

    const candidates = [bizMin.m, outboxMin.m, schedMin.m].filter((v): v is number => v !== null);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  private recomputeAlarmSync(): number | null {
    const earliest = this.computeEarliestAlarmAtMs();
    this.db
      .prepare(
        'UPDATE v2_recovery_coverage SET armed_alarm_at_ms = ?, updated_at_ms = ? WHERE id = 1',
      )
      .run(earliest, this.clock.nowMs);
    this.armedAlarmAtMs = earliest;
    if (earliest !== null) {
      this.alarmDead = false;
      this.alarmRetriesUsed = 0;
    }
    return earliest;
  }

  /**
   * J2: Implements RecoveryAdmissionPort.inspectCoverageSync + confirmCoverageSync
   * with durable pending_kind/target, authoritative D1 receipt validation, and 1 bounded retry on stale upsert.
   */
  private ensureCoverageBeforeCommit(requiredRecoveryAtMs: number): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const plan = this.transactionSync(() => {
        const cov = this.getCoverage();
        if (
          cov.coverage_state === 'covered' &&
          cov.covered_recovery_at_ms !== null &&
          cov.covered_recovery_at_ms <= requiredRecoveryAtMs
        ) {
          return { covered: true as const, generation: cov.generation };
        }
        const nextGen = cov.generation + 1;
        const earliestAll =
          this.earliestRequiredDiscoveryAtMsSync(requiredRecoveryAtMs) ?? requiredRecoveryAtMs;
        const targetAtMs =
          cov.pending_target_at_ms !== null
            ? Math.min(cov.pending_target_at_ms, earliestAll)
            : earliestAll;

        this.db
          .prepare(
            `UPDATE v2_recovery_coverage
             SET generation = ?,
                 coverage_state = 'registering',
                 covered_recovery_at_ms = NULL,
                 pending_kind = 'ensure',
                 pending_prev_generation = ?,
                 pending_target_at_ms = ?,
                 updated_at_ms = ?
             WHERE id = 1`,
          )
          .run(nextGen, cov.generation, targetAtMs, this.clock.nowMs);
        return { covered: false as const, generation: nextGen, targetAtMs };
      });

      if (plan.covered) {
        return;
      }

      if (this.crashAfterPendingPersistBeforeD1) {
        this.crashAfterPendingPersistBeforeD1 = false;
        throw new ProtocolError(
          'SIMULATED_CRASH',
          500,
          'Simulated crash after persisting pending_kind before D1 CAS',
        );
      }

      const receipt = this.registry.upsertCoverage({
        tenantId: this.tenantId,
        agentId: this.agentId,
        generation: plan.generation,
        recoveryAtMs: plan.targetAtMs,
        nowMs: this.clock.nowMs,
      });

      if (this.crashAfterD1CasLoseAck) {
        this.crashAfterD1CasLoseAck = false;
        throw new ProtocolError('ACK_LOST', 503, 'Simulated crash / lost ACK right after D1 CAS');
      }

      if (this.crashAfterD1BeforeDoCommit) {
        this.crashAfterD1BeforeDoCommit = false;
        throw new ProtocolError('SIMULATED_CRASH', 500, 'Simulated DO crash after D1 registration');
      }

      const confirmed = this.transactionSync(() => {
        const cov = this.getCoverage();
        const earliestAll =
          this.earliestRequiredDiscoveryAtMsSync(requiredRecoveryAtMs) ?? requiredRecoveryAtMs;
        // J2: Must match current pending plan generation AND actual D1 timestamp must cover all obligations!
        if (
          cov.generation !== plan.generation ||
          cov.pending_kind !== 'ensure' ||
          !receipt.accepted ||
          receipt.currentGeneration !== plan.generation ||
          receipt.actualRecoveryAtMs === null ||
          receipt.actualRecoveryAtMs > earliestAll
        ) {
          // Advance generation past any higher D1 generation before bounded retry
          const bumped = Math.max(cov.generation, receipt.currentGeneration) + 1;
          this.db
            .prepare(
              `UPDATE v2_recovery_coverage
               SET generation = ?,
                   coverage_state = 'registering',
                   pending_kind = 'ensure',
                   pending_target_at_ms = ?,
                   updated_at_ms = ?
               WHERE id = 1`,
            )
            .run(bumped, earliestAll, this.clock.nowMs);
          return false;
        }

        this.db
          .prepare(
            `UPDATE v2_recovery_coverage
             SET coverage_state = 'covered',
                 covered_recovery_at_ms = ?,
                 pending_kind = NULL,
                 pending_prev_generation = NULL,
                 pending_target_at_ms = NULL,
                 last_d1_sync_at_ms = ?,
                 updated_at_ms = ?
             WHERE id = 1`,
          )
          .run(receipt.actualRecoveryAtMs, this.clock.nowMs, this.clock.nowMs);
        return true;
      });

      if (confirmed) {
        return;
      }
    }

    throw new ProtocolError('DB_UNAVAILABLE', 503, 'Unable to confirm authoritative D1 coverage');
  }

  /** Fast Path prepareTurn: pre-admits conservative nowMs + 45s bound (J3). */
  prepareFastTurn(input: {
    readonly turnId: string;
    readonly ownerId: string;
    readonly b1Compat60s?: boolean;
  }): {
    readonly runId: string;
    readonly leaseEpoch: number;
    readonly interactiveDeadlineMs: number;
    readonly totalDeadlineMs: number;
  } {
    const nowMs = this.clock.nowMs;
    const leaseMs = input.b1Compat60s ? B1_FAST_LEASE_MS : V2_INTERACTIVE_LEASE_MS;
    const interactiveDeadlineMs =
      nowMs + (input.b1Compat60s ? B1_FAST_HANDOFF_MS : V2_INTERACTIVE_PHASE_MS);
    const totalDeadlineMs =
      nowMs + (input.b1Compat60s ? B1_TOTAL_DEADLINE_MS : V2_TOTAL_DEADLINE_MS);
    const leaseExpiresAtMs = nowMs + leaseMs;
    // J3: Pre-admit conservative bound (now + 45s) covering early completion or immediate budget_sync
    const requiredRecoveryAtMs = nowMs + D1_RECOVERY_GRACE_MS;

    this.ensureCoverageBeforeCommit(requiredRecoveryAtMs);

    const runId = randomUUID();
    const committed = this.transactionSync(() => {
      const cov = this.getCoverage();
      if (
        cov.coverage_state !== 'covered' ||
        cov.covered_recovery_at_ms === null ||
        cov.covered_recovery_at_ms > requiredRecoveryAtMs
      ) {
        return false;
      }

      this.db
        .prepare(
          `INSERT INTO probe_turns_and_tasks (
            target_kind, target_id, execution_mode, status, active_run_id,
            lease_epoch, lease_owner, lease_expires_at_ms,
            interactive_deadline_ms, deadline_at_ms, transcript_epoch,
            send_started_at_ms, attempt_count, next_action_at_ms, updated_at_ms
          ) VALUES ('turn', ?, 'interactive_fast', 'running', ?, 1, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
        )
        .run(
          input.turnId,
          runId,
          input.ownerId,
          leaseExpiresAtMs,
          interactiveDeadlineMs,
          totalDeadlineMs,
          this.transcriptEpoch,
          Math.min(leaseExpiresAtMs, interactiveDeadlineMs, totalDeadlineMs),
          nowMs,
        );
      this.recomputeAlarmSync();
      return true;
    });

    if (!committed) {
      return this.prepareFastTurn(input);
    }

    return { runId, leaseEpoch: 1, interactiveDeadlineMs, totalDeadlineMs };
  }

  markAttemptSent(input: {
    readonly turnId: string;
    readonly runId: string;
    readonly leaseEpoch: number;
    readonly leaseOwner: string;
    readonly providerJobHandle?: string | null;
  }): void {
    const nowMs = this.clock.nowMs;
    this.transactionSync(() => {
      const row = this.db
        .prepare(
          `SELECT status, active_run_id, lease_epoch, lease_owner, lease_expires_at_ms,
                  deadline_at_ms, cancel_requested_at_ms, send_started_at_ms
           FROM probe_turns_and_tasks WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .get(input.turnId) as
        | {
            status: BusinessStatus;
            active_run_id: string | null;
            lease_epoch: number;
            lease_owner: string | null;
            lease_expires_at_ms: number | null;
            deadline_at_ms: number;
            cancel_requested_at_ms: number | null;
            send_started_at_ms: number | null;
          }
        | undefined;

      if (
        !row ||
        row.status !== 'running' ||
        row.active_run_id !== input.runId ||
        row.lease_epoch !== input.leaseEpoch ||
        row.lease_owner !== input.leaseOwner ||
        row.lease_expires_at_ms === null ||
        row.lease_expires_at_ms <= nowMs ||
        row.deadline_at_ms <= nowMs ||
        row.cancel_requested_at_ms !== null ||
        row.send_started_at_ms !== null
      ) {
        throw new ProtocolError('FENCED', 409, 'Send authorization rejected');
      }

      this.db
        .prepare(
          `UPDATE probe_turns_and_tasks
           SET send_started_at_ms = ?, provider_job_handle = ?, updated_at_ms = ?
           WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .run(nowMs, input.providerJobHandle ?? null, nowMs, input.turnId);
    });
  }

  renewTurnLease(input: {
    readonly turnId: string;
    readonly runId: string;
    readonly leaseEpoch: number;
    readonly leaseOwner: string;
    readonly leaseMs?: number;
  }): boolean {
    const nowMs = this.clock.nowMs;
    const leaseMs = input.leaseMs ?? V2_INTERACTIVE_LEASE_MS;
    return this.transactionSync(() => {
      const row = this.db
        .prepare(
          `SELECT status, active_run_id, lease_epoch, lease_owner, lease_expires_at_ms,
                  deadline_at_ms, cancel_requested_at_ms, interactive_deadline_ms
           FROM probe_turns_and_tasks WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .get(input.turnId) as
        | {
            status: BusinessStatus;
            active_run_id: string | null;
            lease_epoch: number;
            lease_owner: string | null;
            lease_expires_at_ms: number | null;
            deadline_at_ms: number;
            cancel_requested_at_ms: number | null;
            interactive_deadline_ms: number | null;
          }
        | undefined;

      if (
        !row ||
        row.status !== 'running' ||
        row.active_run_id !== input.runId ||
        row.lease_epoch !== input.leaseEpoch ||
        row.lease_owner !== input.leaseOwner ||
        row.lease_expires_at_ms === null ||
        row.lease_expires_at_ms <= nowMs ||
        row.deadline_at_ms <= nowMs ||
        row.cancel_requested_at_ms !== null
      ) {
        return false;
      }

      const nextExpires = Math.min(nowMs + leaseMs, row.deadline_at_ms);
      const nextAction =
        row.interactive_deadline_ms !== null
          ? Math.min(nextExpires, row.interactive_deadline_ms, row.deadline_at_ms)
          : Math.min(nextExpires, row.deadline_at_ms);

      this.db
        .prepare(
          `UPDATE probe_turns_and_tasks
           SET lease_expires_at_ms = ?, next_action_at_ms = ?, updated_at_ms = ?
           WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .run(nextExpires, nextAction, nowMs, input.turnId);
      this.recomputeAlarmSync();
      return true;
    });
  }

  /**
   * J4: Agent A owns handoff; checks current server time, lease owner, expiry, interactive/total
   * deadlines, cancel, transcript epoch, run identity; NEVER extends `deadline_at_ms`!
   */
  handoffTurnToDurable(input: {
    readonly turnId: string;
    readonly runId: string;
    readonly leaseEpoch: number;
    readonly leaseOwner: string;
    readonly providerJobHandle?: string | null;
  }): {
    readonly nextLeaseEpoch: number;
    readonly outboxId: string;
    readonly deadlineAtMs: number;
  } {
    const nowMs = this.clock.nowMs;
    const requiredRecoveryAtMs = nowMs + OUTBOX_IMMEDIATE_GRACE_MS + D1_RECOVERY_GRACE_MS;
    this.ensureCoverageBeforeCommit(requiredRecoveryAtMs);

    const outboxId = `handoff:${input.turnId}:ep:${input.leaseEpoch + 1}`;

    const result = this.transactionSync(() => {
      const row = this.db
        .prepare(
          `SELECT execution_mode, status, active_run_id, lease_epoch, lease_owner,
                  lease_expires_at_ms, interactive_deadline_ms, deadline_at_ms,
                  transcript_epoch, cancel_requested_at_ms, provider_job_handle
           FROM probe_turns_and_tasks
           WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .get(input.turnId) as
        | {
            execution_mode: ExecutionMode;
            status: BusinessStatus;
            active_run_id: string | null;
            lease_epoch: number;
            lease_owner: string | null;
            lease_expires_at_ms: number | null;
            interactive_deadline_ms: number | null;
            deadline_at_ms: number;
            transcript_epoch: number;
            cancel_requested_at_ms: number | null;
            provider_job_handle: string | null;
          }
        | undefined;

      if (
        !row ||
        row.execution_mode !== 'interactive_fast' ||
        row.status !== 'running' ||
        row.active_run_id !== input.runId ||
        row.lease_epoch !== input.leaseEpoch ||
        row.lease_owner !== input.leaseOwner ||
        row.lease_expires_at_ms === null ||
        row.lease_expires_at_ms <= nowMs ||
        (row.interactive_deadline_ms !== null && nowMs >= row.interactive_deadline_ms) ||
        nowMs >= row.deadline_at_ms ||
        row.cancel_requested_at_ms !== null ||
        row.transcript_epoch !== this.transcriptEpoch
      ) {
        throw new ProtocolError(
          'FENCED',
          409,
          'Handoff rejected: expired/fenced/cancelled/wrong owner',
        );
      }

      const bumpedEpoch = row.lease_epoch + 1;
      const handle = input.providerJobHandle ?? row.provider_job_handle;
      const envelope: V2DispatchEnvelope = {
        schemaVersion: 2,
        eventId: outboxId,
        tenantId: this.tenantId,
        agentId: this.agentId,
        entityKind: 'handoff',
        entityId: input.turnId,
        queueName: 'durable_turn',
        fenceEpoch: bumpedEpoch,
      };

      // Preserve `deadline_at_ms` unchanged — NEVER extend total deadline on handoff!
      this.db
        .prepare(
          `UPDATE probe_turns_and_tasks
           SET execution_mode = 'durable_queue',
               status = 'queued',
               active_run_id = NULL,
               lease_epoch = ?,
               lease_owner = NULL,
               lease_expires_at_ms = NULL,
               provider_job_handle = ?,
               next_action_at_ms = ?,
               updated_at_ms = ?
           WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .run(bumpedEpoch, handle, row.deadline_at_ms, nowMs, input.turnId);

      this.db
        .prepare(
          `INSERT INTO v2_dispatch_outbox (
            outbox_id, entity_kind, entity_id, queue_name, payload_json,
            state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
          ) VALUES (?, 'handoff', ?, 'durable_turn', ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          outboxId,
          input.turnId,
          JSON.stringify(envelope),
          nowMs + OUTBOX_IMMEDIATE_GRACE_MS,
          bumpedEpoch,
          nowMs,
          nowMs,
        );

      this.recomputeAlarmSync();
      return {
        nextLeaseEpoch: bumpedEpoch,
        deadlineAtMs: row.deadline_at_ms,
        envelope,
      };
    });

    this.tryImmediatePublish(outboxId, result.envelope, result.deadlineAtMs);
    return {
      nextLeaseEpoch: result.nextLeaseEpoch,
      outboxId,
      deadlineAtMs: result.deadlineAtMs,
    };
  }

  /** Fast Path commitTurn + atomic `budget_sync` outbox insertion (J5). */
  commitFastTurn(input: {
    readonly turnId: string;
    readonly runId: string;
    readonly leaseEpoch: number;
    readonly resultText: string;
    readonly operationId?: string;
    readonly amountMicroUsd?: number;
  }): void {
    const nowMs = this.clock.nowMs;
    let budgetSyncItem: { outboxId: string; payload: BudgetSyncPayload } | null = null;

    this.transactionSync(() => {
      const row = this.db
        .prepare(
          `SELECT status, active_run_id, lease_epoch, cancel_requested_at_ms
           FROM probe_turns_and_tasks WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .get(input.turnId) as
        | {
            status: BusinessStatus;
            active_run_id: string | null;
            lease_epoch: number;
            cancel_requested_at_ms: number | null;
          }
        | undefined;

      if (
        !row ||
        row.status !== 'running' ||
        row.active_run_id !== input.runId ||
        row.lease_epoch !== input.leaseEpoch
      ) {
        throw new ProtocolError('STALE_LEASE', 409, 'Fenced stale fast-path commit');
      }

      if (row.cancel_requested_at_ms !== null) {
        this.db
          .prepare(
            `UPDATE probe_turns_and_tasks
             SET status = 'cancelled', active_run_id = NULL, lease_owner = NULL,
                 lease_expires_at_ms = NULL, next_action_at_ms = NULL, updated_at_ms = ?
             WHERE target_kind = 'turn' AND target_id = ?`,
          )
          .run(nowMs, input.turnId);
        this.recomputeAlarmSync();
        return;
      }

      this.db
        .prepare(
          `INSERT INTO probe_committed_results (target_id, run_id, lease_epoch, result_text, committed_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.turnId, input.runId, input.leaseEpoch, input.resultText, nowMs);

      this.db
        .prepare(
          `UPDATE probe_turns_and_tasks
           SET status = 'completed', active_run_id = NULL, lease_owner = NULL,
               lease_expires_at_ms = NULL, next_action_at_ms = NULL, updated_at_ms = ?
           WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .run(nowMs, input.turnId);

      if (input.operationId !== undefined) {
        const payload: BudgetSyncPayload = {
          kind: 'budget_sync',
          op: 'settle',
          subjectType: 'turn',
          subjectId: input.turnId,
          operationId: input.operationId,
          revision: 1,
          amountMicroUsd: input.amountMicroUsd ?? 100,
        };
        const outboxId = `budget_sync:${input.operationId}:rev:1`;
        this.db
          .prepare(
            `INSERT INTO v2_dispatch_outbox (
              outbox_id, entity_kind, entity_id, queue_name, payload_json,
              operation_id, revision, state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
            ) VALUES (?, 'budget_sync', ?, NULL, ?, ?, 1, 'pending', ?, 0, ?, ?)`,
          )
          .run(
            outboxId,
            input.operationId,
            JSON.stringify(payload),
            input.operationId,
            nowMs,
            nowMs,
            nowMs,
          );
        budgetSyncItem = { outboxId, payload };
      }

      this.recomputeAlarmSync();
    });

    if (budgetSyncItem !== null) {
      this.tryRelayBudgetSync(budgetSyncItem);
    }
  }

  /** J5: Enqueue immutable late settlement revision (operationId, revision >= 2). */
  enqueueLateBudgetCorrection(input: {
    readonly operationId: string;
    readonly revision: number;
    readonly subjectId: string;
    readonly correctedMicroUsd: number;
  }): string {
    const nowMs = this.clock.nowMs;
    this.ensureCoverageBeforeCommit(nowMs + D1_RECOVERY_GRACE_MS);

    const outboxId = `budget_sync:${input.operationId}:rev:${input.revision}`;
    const payload: BudgetSyncPayload = {
      kind: 'budget_sync',
      op: 'settle',
      subjectType: 'turn',
      subjectId: input.subjectId,
      operationId: input.operationId,
      revision: input.revision,
      amountMicroUsd: input.correctedMicroUsd,
    };

    this.transactionSync(() => {
      this.db
        .prepare(
          `INSERT INTO v2_dispatch_outbox (
            outbox_id, entity_kind, entity_id, queue_name, payload_json,
            operation_id, revision, state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
          ) VALUES (?, 'budget_sync', ?, NULL, ?, ?, ?, 'pending', ?, 0, ?, ?)`,
        )
        .run(
          outboxId,
          input.operationId,
          JSON.stringify(payload),
          input.operationId,
          input.revision,
          nowMs,
          nowMs,
          nowMs,
        );
      this.recomputeAlarmSync();
    });

    this.tryRelayBudgetSync({ outboxId, payload });
    return outboxId;
  }

  private tryRelayBudgetSync(item: { outboxId: string; payload: BudgetSyncPayload }): void {
    try {
      const res = this.globalBudget.settleGlobal(item.payload);
      if (res.acked) {
        this.transactionSync(() => {
          this.db
            .prepare(
              "UPDATE v2_dispatch_outbox SET state = 'acked', updated_at_ms = ? WHERE outbox_id = ?",
            )
            .run(this.clock.nowMs, item.outboxId);
          this.recomputeAlarmSync();
        });
      }
    } catch {
      this.transactionSync(() => {
        this.db
          .prepare(
            "UPDATE v2_dispatch_outbox SET next_attempt_at_ms = ?, updated_at_ms = ? WHERE outbox_id = ? AND state = 'pending'",
          )
          .run(this.clock.nowMs + 5_000, this.clock.nowMs, item.outboxId);
        this.recomputeAlarmSync();
      });
    }
  }

  /** Accept Durable Task + optional future Schedule atomically after coverage admission. */
  acceptDurableTask(input: {
    readonly taskId: string;
    readonly deadlineMs?: number;
    readonly scheduleAtMs?: number;
  }): { readonly outboxId: string; readonly deadlineAtMs: number } {
    const nowMs = this.clock.nowMs;
    const deadlineAtMs = nowMs + (input.deadlineMs ?? 300_000);
    const requiredRecoveryAtMs = nowMs + OUTBOX_IMMEDIATE_GRACE_MS + D1_RECOVERY_GRACE_MS;

    this.ensureCoverageBeforeCommit(requiredRecoveryAtMs);

    const outboxId = `task:${input.taskId}:ep:0`;
    const envelope: V2DispatchEnvelope = {
      schemaVersion: 2,
      eventId: outboxId,
      tenantId: this.tenantId,
      agentId: this.agentId,
      entityKind: 'task',
      entityId: input.taskId,
      queueName: 'agent_task',
      fenceEpoch: 0,
    };

    this.transactionSync(() => {
      this.db
        .prepare(
          `INSERT INTO probe_turns_and_tasks (
            target_kind, target_id, execution_mode, status, lease_epoch,
            deadline_at_ms, transcript_epoch, attempt_count, next_action_at_ms, updated_at_ms
          ) VALUES ('task', ?, 'durable_queue', 'queued', 0, ?, ?, 0, ?, ?)`,
        )
        .run(input.taskId, deadlineAtMs, this.transcriptEpoch, deadlineAtMs, nowMs);

      this.db
        .prepare(
          `INSERT INTO v2_dispatch_outbox (
            outbox_id, entity_kind, entity_id, queue_name, payload_json,
            state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
          ) VALUES (?, 'task', ?, 'agent_task', ?, 'pending', ?, 0, ?, ?)`,
        )
        .run(
          outboxId,
          input.taskId,
          JSON.stringify(envelope),
          nowMs + OUTBOX_IMMEDIATE_GRACE_MS,
          nowMs,
          nowMs,
        );

      if (input.scheduleAtMs !== undefined) {
        this.db
          .prepare(
            `INSERT INTO v2_schedules (
              schedule_id, tenant_id, agent_id, source_kind, source_id, schedule_kind,
              next_fire_at_ms, status, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, 'reminder', ?, 'once', ?, 'active', ?, ?)`,
          )
          .run(
            randomUUID(),
            this.tenantId,
            this.agentId,
            `rem:${input.taskId}`,
            input.scheduleAtMs,
            nowMs,
            nowMs,
          );
      }

      this.recomputeAlarmSync();
    });

    this.tryImmediatePublish(outboxId, envelope, deadlineAtMs);
    return { outboxId, deadlineAtMs };
  }

  /** J5: Cancel ordinary Turn/Task & clear transcript — NEVER cancels `budget_sync`! */
  requestCancel(targetKind: 'turn' | 'task', targetId: string): void {
    const nowMs = this.clock.nowMs;
    this.transactionSync(() => {
      const row = this.db
        .prepare('SELECT status FROM probe_turns_and_tasks WHERE target_kind = ? AND target_id = ?')
        .get(targetKind, targetId) as { status: BusinessStatus } | undefined;
      if (!row) return;

      if (
        row.status === 'queued' ||
        row.status === 'retryable_failed' ||
        row.status === 'waiting_approval'
      ) {
        this.db
          .prepare(
            `UPDATE probe_turns_and_tasks
             SET status = 'cancelled', cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
                 next_action_at_ms = NULL, updated_at_ms = ?
             WHERE target_kind = ? AND target_id = ?`,
          )
          .run(nowMs, nowMs, targetKind, targetId);
        this.db
          .prepare(
            `UPDATE v2_dispatch_outbox
             SET state = 'cancelled', updated_at_ms = ?
             WHERE entity_id = ? AND entity_kind <> 'budget_sync'
               AND state IN ('pending', 'enqueued', 'dead_lettered')`,
          )
          .run(nowMs, targetId);
      } else if (row.status === 'running') {
        this.db
          .prepare(
            `UPDATE probe_turns_and_tasks
             SET cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?), updated_at_ms = ?
             WHERE target_kind = ? AND target_id = ?`,
          )
          .run(nowMs, nowMs, targetKind, targetId);
      }
      this.recomputeAlarmSync();
    });
  }

  clearTranscript(): void {
    const nowMs = this.clock.nowMs;
    this.transactionSync(() => {
      this.transcriptEpoch += 1;
      this.db
        .prepare(
          `UPDATE probe_turns_and_tasks
           SET status = 'cancelled', cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
               active_run_id = NULL, lease_owner = NULL, lease_expires_at_ms = NULL,
               next_action_at_ms = NULL, updated_at_ms = ?
           WHERE target_kind = 'turn' AND status NOT IN ('completed', 'failed', 'cancelled')`,
        )
        .run(nowMs, nowMs);
      this.db
        .prepare(
          `UPDATE v2_dispatch_outbox
           SET state = 'cancelled', updated_at_ms = ?
           WHERE entity_kind IN ('turn', 'handoff')
             AND state IN ('pending', 'enqueued', 'dead_lettered')`,
        )
        .run(nowMs);
      this.recomputeAlarmSync();
    });
  }

  private tryImmediatePublish(
    outboxId: string,
    envelope: V2DispatchEnvelope,
    deadlineAtMs: number,
  ): void {
    try {
      this.queue.send(envelope, this.clock.nowMs);
      if (this.crashAfterQueueSendBeforeOutboxUpdate) {
        this.crashAfterQueueSendBeforeOutboxUpdate = false;
        return;
      }
      this.transactionSync(() => {
        const nextAt = cappedReenqueueAtMs(this.clock.nowMs, deadlineAtMs);
        this.db
          .prepare(
            `UPDATE v2_dispatch_outbox
             SET state = 'enqueued',
                 publish_attempts = publish_attempts + 1,
                 last_enqueued_at_ms = ?,
                 next_attempt_at_ms = ?,
                 updated_at_ms = ?
             WHERE outbox_id = ? AND state = 'pending'`,
          )
          .run(this.clock.nowMs, nextAt, this.clock.nowMs, outboxId);
        this.recomputeAlarmSync();
      });
    } catch {
      // Immediate hint failed; outbox remains 'pending' and DO Alarm fires within 2s!
    }
  }

  tickAlarmIfDue(): boolean {
    if (this.armedAlarmAtMs === null || this.alarmDead || this.clock.nowMs < this.armedAlarmAtMs) {
      return false;
    }

    if (this.alarmFailureBudget > 0) {
      this.alarmFailureBudget -= 1;
      this.db
        .prepare(
          'UPDATE v2_recovery_coverage SET alarm_fail_count = alarm_fail_count + 1 WHERE id = 1',
        )
        .run();
      if (this.alarmRetriesUsed < MAX_ALARM_RETRIES) {
        const delay = this.alarmRetryDelaysMs[this.alarmRetriesUsed] ?? 64_000;
        this.alarmRetriesUsed += 1;
        this.armedAlarmAtMs = this.clock.nowMs + delay;
      } else {
        this.alarmDead = true;
        this.armedAlarmAtMs = null;
        this.alarmRetryExhaustedAtMs = this.clock.nowMs;
      }
      return true;
    }

    this.processDueWork('alarm');
    return true;
  }

  processDueWork(trigger: 'alarm' | 'registry_recovery'): void {
    const nowMs = this.clock.nowMs;

    const { toPublish, budgetSyncs } = this.transactionSync(() => {
      const dueBiz = this.db
        .prepare(
          `SELECT target_kind, target_id, status, lease_epoch, lease_expires_at_ms,
                  interactive_deadline_ms, deadline_at_ms, cancel_requested_at_ms, send_started_at_ms
           FROM probe_turns_and_tasks
           WHERE status IN ('queued', 'running', 'retryable_failed')
             AND next_action_at_ms IS NOT NULL
             AND next_action_at_ms <= ?
           ORDER BY next_action_at_ms ASC
           LIMIT 10`,
        )
        .all(nowMs) as Array<{
        target_kind: 'turn' | 'task';
        target_id: string;
        status: BusinessStatus;
        lease_epoch: number;
        lease_expires_at_ms: number | null;
        interactive_deadline_ms: number | null;
        deadline_at_ms: number;
        cancel_requested_at_ms: number | null;
        send_started_at_ms: number | null;
      }>;

      for (const item of dueBiz) {
        if (item.cancel_requested_at_ms !== null) {
          this.db
            .prepare(
              `UPDATE probe_turns_and_tasks
               SET status = 'cancelled', active_run_id = NULL, lease_owner = NULL,
                   lease_expires_at_ms = NULL, next_action_at_ms = NULL, updated_at_ms = ?
               WHERE target_kind = ? AND target_id = ?`,
            )
            .run(nowMs, item.target_kind, item.target_id);
          continue;
        }
        if (item.deadline_at_ms <= nowMs) {
          // ADR-0002 / total-deadline expiration (no extension!)
          this.db
            .prepare(
              `UPDATE probe_turns_and_tasks
               SET status = 'failed', active_run_id = NULL, lease_owner = NULL,
                   lease_expires_at_ms = NULL, next_action_at_ms = NULL, updated_at_ms = ?
               WHERE target_kind = ? AND target_id = ?`,
            )
            .run(nowMs, item.target_kind, item.target_id);
          this.db
            .prepare(
              `UPDATE v2_dispatch_outbox
               SET state = 'acked', updated_at_ms = ?
               WHERE entity_id = ? AND entity_kind <> 'budget_sync'
                 AND state IN ('pending', 'enqueued', 'dead_lettered')`,
            )
            .run(nowMs, item.target_id);
          continue;
        }
        if (
          item.status === 'running' &&
          ((item.lease_expires_at_ms !== null && item.lease_expires_at_ms <= nowMs) ||
            (item.interactive_deadline_ms !== null && item.interactive_deadline_ms <= nowMs))
        ) {
          // Silent executor loss or interactive phase expiry -> fence old epoch & enqueue durable reconcile!
          const bumpedEpoch = item.lease_epoch + 1;
          const outboxId = `reconcile:${item.target_id}:ep:${bumpedEpoch}`;
          const env: V2DispatchEnvelope = {
            schemaVersion: 2,
            eventId: outboxId,
            tenantId: this.tenantId,
            agentId: this.agentId,
            entityKind: item.target_kind === 'turn' ? 'handoff' : 'task',
            entityId: item.target_id,
            queueName: 'durable_turn',
            fenceEpoch: bumpedEpoch,
          };
          this.db
            .prepare(
              `UPDATE probe_turns_and_tasks
               SET execution_mode = 'durable_queue',
                   status = 'queued',
                   active_run_id = NULL,
                   lease_epoch = ?,
                   lease_owner = NULL,
                   lease_expires_at_ms = NULL,
                   next_action_at_ms = ?,
                   updated_at_ms = ?
               WHERE target_kind = ? AND target_id = ?`,
            )
            .run(bumpedEpoch, item.deadline_at_ms, nowMs, item.target_kind, item.target_id);

          this.db
            .prepare(
              `INSERT INTO v2_dispatch_outbox (
                outbox_id, entity_kind, entity_id, queue_name, payload_json,
                state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, 'durable_turn', ?, 'pending', ?, ?, ?, ?)
              ON CONFLICT (outbox_id) DO NOTHING`,
            )
            .run(
              outboxId,
              item.target_kind === 'turn' ? 'handoff' : 'task',
              item.target_id,
              JSON.stringify(env),
              nowMs,
              bumpedEpoch,
              nowMs,
              nowMs,
            );
        }
      }

      // Materialize due schedules
      const dueSchedules = this.db
        .prepare(
          `SELECT schedule_id, schedule_kind, interval_seconds, next_fire_at_ms, occurrence_seq
           FROM v2_schedules
           WHERE status = 'active' AND next_fire_at_ms <= ?
           ORDER BY next_fire_at_ms ASC, schedule_id ASC
           LIMIT 10`,
        )
        .all(nowMs) as Array<{
        schedule_id: string;
        schedule_kind: 'once' | 'interval' | 'cron_tz';
        interval_seconds: number | null;
        next_fire_at_ms: number;
        occurrence_seq: number;
      }>;

      for (const sched of dueSchedules) {
        const nextSeq = sched.occurrence_seq + 1;
        const occId = `sched:${sched.schedule_id}:${nextSeq}`;
        const deadlineAtMs = nowMs + 300_000;
        const env: V2DispatchEnvelope = {
          schemaVersion: 2,
          eventId: occId,
          tenantId: this.tenantId,
          agentId: this.agentId,
          entityKind: 'schedule_occurrence',
          entityId: occId,
          queueName: 'agent_task',
          fenceEpoch: 0,
        };
        this.db
          .prepare(
            `INSERT INTO probe_turns_and_tasks (
              target_kind, target_id, execution_mode, status, lease_epoch,
              deadline_at_ms, transcript_epoch, attempt_count, next_action_at_ms, updated_at_ms
            ) VALUES ('task', ?, 'durable_queue', 'queued', 0, ?, ?, 0, ?, ?)`,
          )
          .run(occId, deadlineAtMs, this.transcriptEpoch, deadlineAtMs, nowMs);
        this.db
          .prepare(
            `INSERT INTO v2_dispatch_outbox (
              outbox_id, entity_kind, entity_id, queue_name, payload_json,
              state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
            ) VALUES (?, 'schedule_occurrence', ?, 'agent_task', ?, 'pending', ?, 0, ?, ?)`,
          )
          .run(occId, occId, JSON.stringify(env), nowMs, nowMs, nowMs);

        if (sched.schedule_kind === 'once') {
          this.db
            .prepare(
              `UPDATE v2_schedules
               SET status = 'completed', occurrence_seq = ?, last_fired_at_ms = ?, updated_at_ms = ?
               WHERE schedule_id = ?`,
            )
            .run(nextSeq, nowMs, nowMs, sched.schedule_id);
        } else if (sched.schedule_kind === 'interval' && sched.interval_seconds !== null) {
          const stepMs = sched.interval_seconds * 1_000;
          let nextFire = sched.next_fire_at_ms + stepMs;
          while (nextFire <= nowMs) nextFire += stepMs;
          this.db
            .prepare(
              `UPDATE v2_schedules
               SET occurrence_seq = ?, last_fired_at_ms = ?, next_fire_at_ms = ?, updated_at_ms = ?
               WHERE schedule_id = ?`,
            )
            .run(nextSeq, nowMs, nextFire, nowMs, sched.schedule_id);
        }
      }

      // Collect due external outbox + internal budget_sync items
      const dueOutbox = this.db
        .prepare(
          `SELECT o.outbox_id, o.entity_kind, o.entity_id, o.payload_json, t.deadline_at_ms
           FROM v2_dispatch_outbox o
           LEFT JOIN probe_turns_and_tasks t ON t.target_id = o.entity_id
           WHERE o.state IN ('pending', 'enqueued', 'dead_lettered')
             AND o.next_attempt_at_ms <= ?
           ORDER BY o.next_attempt_at_ms ASC, o.outbox_id ASC
           LIMIT 20`,
        )
        .all(nowMs) as Array<{
        outbox_id: string;
        entity_kind: string;
        entity_id: string;
        payload_json: string;
        deadline_at_ms: number | null;
      }>;

      if (trigger === 'registry_recovery') {
        this.alarmDead = false;
      }
      this.recomputeAlarmSync();

      return {
        toPublish: dueOutbox.filter((r) => r.entity_kind !== 'budget_sync'),
        budgetSyncs: dueOutbox.filter((r) => r.entity_kind === 'budget_sync'),
      };
    });

    for (const bs of budgetSyncs) {
      this.tryRelayBudgetSync({
        outboxId: bs.outbox_id,
        payload: JSON.parse(bs.payload_json) as BudgetSyncPayload,
      });
    }

    for (const row of toPublish) {
      const env = JSON.parse(row.payload_json) as V2DispatchEnvelope;
      const deadlineAtMs = row.deadline_at_ms ?? nowMs + OUTBOX_REENQUEUE_GRACE_MS;
      try {
        this.queue.send(env, nowMs);
        this.transactionSync(() => {
          const nextAt = cappedReenqueueAtMs(nowMs, deadlineAtMs);
          this.db
            .prepare(
              `UPDATE v2_dispatch_outbox
               SET state = 'enqueued',
                   publish_attempts = publish_attempts + 1,
                   last_enqueued_at_ms = ?,
                   next_attempt_at_ms = ?,
                   updated_at_ms = ?
               WHERE outbox_id = ? AND state IN ('pending', 'enqueued', 'dead_lettered')`,
            )
            .run(nowMs, nextAt, nowMs, row.outbox_id);
          this.recomputeAlarmSync();
        });
      } catch {
        // Leave due for next alarm / sweep
      }
    }
  }

  /**
   * J2 + J3: Independent Sweeper reconciliation & pending coverage repair (even when observedGen lags!).
   */
  async reconcileFromRegistry(expectedGeneration: number): Promise<void> {
    if (this.rpcUnavailable) {
      throw new ProtocolError('RPC_UNAVAILABLE', 503, 'Simulated DO RPC outage');
    }

    this.processDueWork('registry_recovery');

    // J2: If local DO had an unconfirmed/crashed pending plan, read actual D1 first to repair safely!
    const preCov = this.transactionSync(() => this.getCoverage());
    let actualD1: ReturnType<D1RecoveryRegistry['readCoverage']> | null = null;
    if (preCov.pending_kind !== null || preCov.coverage_state === 'registering') {
      actualD1 = this.registry.readCoverage({ tenantId: this.tenantId, agentId: this.agentId });
    }

    const plan = this.transactionSync(() => {
      const cov = this.getCoverage();
      const earliestRequired = this.earliestRequiredDiscoveryAtMsSync();

      // J2: Never return noop_stale while obligations or pending_kind='ensure' exist!
      if (earliestRequired === null) {
        if (actualD1 !== null && !actualD1.exists) {
          // Remote retire already completed before ACK loss -> settle locally as uncovered
          this.db
            .prepare(
              `UPDATE v2_recovery_coverage
               SET coverage_state = 'uncovered',
                   covered_recovery_at_ms = NULL,
                   pending_kind = NULL,
                   pending_prev_generation = NULL,
                   pending_target_at_ms = NULL,
                   updated_at_ms = ?
               WHERE id = 1`,
            )
            .run(this.clock.nowMs);
          return { action: 'done' as const };
        }

        const nextGen =
          Math.max(cov.generation, expectedGeneration, actualD1?.currentGeneration ?? 0) + 1;
        this.db
          .prepare(
            `UPDATE v2_recovery_coverage
             SET generation = ?,
                 coverage_state = 'uncovered',
                 covered_recovery_at_ms = NULL,
                 pending_kind = 'retire',
                 pending_prev_generation = ?,
                 pending_target_at_ms = NULL,
                 updated_at_ms = ?
             WHERE id = 1`,
          )
          .run(nextGen, expectedGeneration, this.clock.nowMs);
        return { action: 'retire' as const, retireUpToGen: nextGen - 1, generation: nextGen };
      }

      // Obligations exist! Check if actual D1 already covers earliestRequired at current generation after ACK loss
      if (
        actualD1 !== null &&
        actualD1.exists &&
        actualD1.currentGeneration === cov.generation &&
        actualD1.actualRecoveryAtMs !== null &&
        actualD1.actualRecoveryAtMs <= earliestRequired &&
        cov.pending_kind === 'ensure'
      ) {
        this.db
          .prepare(
            `UPDATE v2_recovery_coverage
             SET coverage_state = 'covered',
                 covered_recovery_at_ms = ?,
                 pending_kind = NULL,
                 pending_prev_generation = NULL,
                 pending_target_at_ms = NULL,
                 last_d1_sync_at_ms = ?,
                 updated_at_ms = ?
             WHERE id = 1`,
          )
          .run(actualD1.actualRecoveryAtMs, this.clock.nowMs, this.clock.nowMs);
        return { action: 'done' as const };
      }

      // If pending_kind='ensure' crashed before D1 CAS or actual D1 is missing/too late -> repair_ensure!
      const targetAtMs =
        cov.pending_kind === 'ensure' && cov.pending_target_at_ms !== null
          ? Math.min(cov.pending_target_at_ms, earliestRequired)
          : earliestRequired;

      const nextGen =
        Math.max(cov.generation, expectedGeneration, actualD1?.currentGeneration ?? 0) + 1;
      const needsEnsureRepair =
        cov.pending_kind === 'ensure' ||
        actualD1?.exists === false ||
        (actualD1?.actualRecoveryAtMs !== null &&
          actualD1?.actualRecoveryAtMs !== undefined &&
          actualD1.actualRecoveryAtMs > targetAtMs);

      this.db
        .prepare(
          `UPDATE v2_recovery_coverage
           SET generation = ?,
               coverage_state = 'registering',
               covered_recovery_at_ms = NULL,
               pending_kind = ?,
               pending_prev_generation = ?,
               pending_target_at_ms = ?,
               updated_at_ms = ?
           WHERE id = 1`,
        )
        .run(
          nextGen,
          needsEnsureRepair ? 'ensure' : 'postpone',
          expectedGeneration,
          targetAtMs,
          this.clock.nowMs,
        );

      return needsEnsureRepair
        ? { action: 'repair_ensure' as const, nextGen, targetAtMs }
        : { action: 'postpone' as const, prevGenInD1: expectedGeneration, nextGen, targetAtMs };
    });

    if (plan.action === 'done') {
      return;
    }

    if (this.onBeforeRemoteRetirement) {
      await this.onBeforeRemoteRetirement();
    }

    if (this.crashAfterPendingPersistBeforeD1) {
      this.crashAfterPendingPersistBeforeD1 = false;
      throw new ProtocolError(
        'SIMULATED_CRASH',
        500,
        'Simulated crash after DO pending repair persist before D1 CAS',
      );
    }

    if (plan.action === 'retire') {
      const retired = this.registry.retireCoverage({
        tenantId: this.tenantId,
        agentId: this.agentId,
        retireUpToGen: plan.retireUpToGen,
      });
      if (retired.retired) {
        this.transactionSync(() => {
          const cov = this.getCoverage();
          if (cov.generation === plan.generation && cov.pending_kind === 'retire') {
            this.db
              .prepare(
                `UPDATE v2_recovery_coverage
                 SET pending_kind = NULL, pending_prev_generation = NULL, updated_at_ms = ?
                 WHERE id = 1`,
              )
              .run(this.clock.nowMs);
          }
        });
      }
      return;
    }

    if (plan.action === 'repair_ensure') {
      const receipt = this.registry.upsertCoverage({
        tenantId: this.tenantId,
        agentId: this.agentId,
        generation: plan.nextGen,
        recoveryAtMs: plan.targetAtMs,
        nowMs: this.clock.nowMs,
      });
      this.transactionSync(() => {
        const cov = this.getCoverage();
        const earliest = this.earliestRequiredDiscoveryAtMsSync();
        if (
          cov.generation === plan.nextGen &&
          receipt.accepted &&
          receipt.actualRecoveryAtMs !== null &&
          (earliest === null || receipt.actualRecoveryAtMs <= earliest)
        ) {
          this.db
            .prepare(
              `UPDATE v2_recovery_coverage
               SET coverage_state = 'covered',
                   covered_recovery_at_ms = ?,
                   pending_kind = NULL,
                   pending_prev_generation = NULL,
                   pending_target_at_ms = NULL,
                   last_d1_sync_at_ms = ?,
                   updated_at_ms = ?
               WHERE id = 1`,
            )
            .run(receipt.actualRecoveryAtMs, this.clock.nowMs, this.clock.nowMs);
        }
      });
      return;
    }

    const updated = this.registry.postponeCoverage({
      tenantId: this.tenantId,
      agentId: this.agentId,
      expectedPrevGen: plan.prevGenInD1,
      newGeneration: plan.nextGen,
      nextRecoveryAtMs: plan.targetAtMs,
      nowMs: this.clock.nowMs,
    });

    if (updated.updated && updated.actualRecoveryAtMs !== null) {
      this.transactionSync(() => {
        const cov = this.getCoverage();
        const earliest = this.earliestRequiredDiscoveryAtMsSync();
        if (
          cov.generation === plan.nextGen &&
          (earliest === null || updated.actualRecoveryAtMs! <= earliest)
        ) {
          this.db
            .prepare(
              `UPDATE v2_recovery_coverage
               SET coverage_state = 'covered',
                   covered_recovery_at_ms = ?,
                   pending_kind = NULL,
                   pending_prev_generation = NULL,
                   pending_target_at_ms = NULL,
                   last_d1_sync_at_ms = ?,
                   updated_at_ms = ?
               WHERE id = 1`,
            )
            .run(updated.actualRecoveryAtMs, this.clock.nowMs, this.clock.nowMs);
        }
      });
    }
  }

  /**
   * J5: Strict closed Outbox envelope verification BEFORE any claim/state write.
   * Rejects unknown outbox_id, budget_sync, queue mismatch, tenant/agent mismatch,
   * AND both stale (<) and forged future (>) fenceEpoch!
   */
  consumeQueueDelivery(
    envelope: V2DispatchEnvelope,
    actualQueueName: 'durable_turn' | 'agent_task',
    workerId: string,
  ): 'acked' | 'rejected' {
    if (envelope.tenantId !== this.tenantId || envelope.agentId !== this.agentId) {
      return 'rejected';
    }

    const claim = this.transactionSync(() => {
      const outbox = this.db
        .prepare(
          `SELECT outbox_id, entity_kind, entity_id, queue_name, state, fence_epoch
           FROM v2_dispatch_outbox
           WHERE outbox_id = ?`,
        )
        .get(envelope.eventId) as
        | {
            outbox_id: string;
            entity_kind: string;
            entity_id: string;
            queue_name: string | null;
            state: string;
            fence_epoch: number;
          }
        | undefined;

      if (
        !outbox ||
        outbox.entity_kind === 'budget_sync' ||
        outbox.queue_name === null ||
        outbox.queue_name !== actualQueueName ||
        outbox.queue_name !== envelope.queueName ||
        outbox.entity_kind !== envelope.entityKind ||
        outbox.entity_id !== envelope.entityId ||
        outbox.fence_epoch !== envelope.fenceEpoch
      ) {
        return { kind: 'rejected' as const };
      }

      if (outbox.state === 'acked' || outbox.state === 'cancelled') {
        return { kind: 'noop' as const };
      }

      const target = this.db
        .prepare(
          `SELECT target_kind, status, lease_epoch, lease_expires_at_ms,
                  deadline_at_ms, cancel_requested_at_ms, provider_job_handle, send_started_at_ms
           FROM probe_turns_and_tasks
           WHERE target_id = ?`,
        )
        .get(outbox.entity_id) as
        | {
            target_kind: 'turn' | 'task';
            status: BusinessStatus;
            lease_epoch: number;
            lease_expires_at_ms: number | null;
            deadline_at_ms: number;
            cancel_requested_at_ms: number | null;
            provider_job_handle: string | null;
            send_started_at_ms: number | null;
          }
        | undefined;

      if (!target || envelope.fenceEpoch !== target.lease_epoch) {
        // Reject BOTH stale (<) and future/forged (>) epochs!
        return { kind: 'rejected' as const };
      }

      if (target.cancel_requested_at_ms !== null) {
        this.db
          .prepare(
            `UPDATE probe_turns_and_tasks
             SET status = 'cancelled', next_action_at_ms = NULL, updated_at_ms = ?
             WHERE target_kind = ? AND target_id = ?`,
          )
          .run(this.clock.nowMs, target.target_kind, outbox.entity_id);
        this.db
          .prepare(
            "UPDATE v2_dispatch_outbox SET state = 'cancelled', updated_at_ms = ? WHERE outbox_id = ?",
          )
          .run(this.clock.nowMs, outbox.outbox_id);
        this.recomputeAlarmSync();
        return { kind: 'noop' as const };
      }

      if (
        target.status === 'completed' ||
        target.status === 'failed' ||
        target.status === 'cancelled'
      ) {
        this.db
          .prepare(
            "UPDATE v2_dispatch_outbox SET state = 'acked', updated_at_ms = ? WHERE outbox_id = ?",
          )
          .run(this.clock.nowMs, outbox.outbox_id);
        this.recomputeAlarmSync();
        return { kind: 'noop' as const };
      }

      if (
        target.status === 'running' &&
        target.lease_expires_at_ms !== null &&
        target.lease_expires_at_ms > this.clock.nowMs
      ) {
        return { kind: 'noop' as const };
      }

      if (target.deadline_at_ms <= this.clock.nowMs) {
        this.db
          .prepare(
            `UPDATE probe_turns_and_tasks
             SET status = 'failed', next_action_at_ms = NULL, updated_at_ms = ?
             WHERE target_kind = ? AND target_id = ?`,
          )
          .run(this.clock.nowMs, target.target_kind, outbox.entity_id);
        this.db
          .prepare(
            "UPDATE v2_dispatch_outbox SET state = 'acked', updated_at_ms = ? WHERE outbox_id = ?",
          )
          .run(this.clock.nowMs, outbox.outbox_id);
        this.recomputeAlarmSync();
        return { kind: 'noop' as const };
      }

      const runId = randomUUID();
      const bumpedEpoch = target.lease_epoch + 1;
      const leaseExpires = Math.min(this.clock.nowMs + 30_000, target.deadline_at_ms);

      this.db
        .prepare(
          `UPDATE probe_turns_and_tasks
           SET status = 'running',
               active_run_id = ?,
               lease_epoch = ?,
               lease_owner = ?,
               lease_expires_at_ms = ?,
               attempt_count = attempt_count + 1,
               next_action_at_ms = ?,
               updated_at_ms = ?
           WHERE target_kind = ? AND target_id = ?`,
        )
        .run(
          runId,
          bumpedEpoch,
          workerId,
          leaseExpires,
          leaseExpires,
          this.clock.nowMs,
          target.target_kind,
          outbox.entity_id,
        );
      this.db
        .prepare(
          "UPDATE v2_dispatch_outbox SET state = 'acked', updated_at_ms = ? WHERE outbox_id = ?",
        )
        .run(this.clock.nowMs, outbox.outbox_id);
      this.recomputeAlarmSync();

      return {
        kind: 'execute' as const,
        targetKind: target.target_kind,
        targetId: outbox.entity_id,
        runId,
        leaseEpoch: bumpedEpoch,
        providerJobHandle: target.provider_job_handle,
        sendStartedAtMs: target.send_started_at_ms,
      };
    });

    if (claim.kind === 'rejected') {
      return 'rejected';
    }
    if (claim.kind === 'noop') {
      return 'acked';
    }

    // J4: Never blindly replay an uncertain provider call!
    const resultText =
      claim.providerJobHandle !== null
        ? `resumed:${claim.providerJobHandle}`
        : claim.sendStartedAtMs !== null
          ? 'reconciled_uncertain_outcome'
          : `executed:${claim.targetId}`;

    this.transactionSync(() => {
      const current = this.db
        .prepare(
          `SELECT status, active_run_id, lease_epoch, deadline_at_ms
           FROM probe_turns_and_tasks WHERE target_kind = ? AND target_id = ?`,
        )
        .get(claim.targetKind, claim.targetId) as {
        status: BusinessStatus;
        active_run_id: string | null;
        lease_epoch: number;
        deadline_at_ms: number;
      };
      if (
        current.status !== 'running' ||
        current.active_run_id !== claim.runId ||
        current.lease_epoch !== claim.leaseEpoch ||
        current.deadline_at_ms <= this.clock.nowMs
      ) {
        return;
      }
      this.db
        .prepare(
          `INSERT INTO probe_committed_results (target_id, run_id, lease_epoch, result_text, committed_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(claim.targetId, claim.runId, claim.leaseEpoch, resultText, this.clock.nowMs);
      this.db
        .prepare(
          `UPDATE probe_turns_and_tasks
           SET status = 'completed', active_run_id = NULL, lease_owner = NULL,
               lease_expires_at_ms = NULL, next_action_at_ms = NULL, updated_at_ms = ?
           WHERE target_kind = ? AND target_id = ?`,
        )
        .run(this.clock.nowMs, claim.targetKind, claim.targetId);
      this.recomputeAlarmSync();
    });

    return 'acked';
  }

  onDispatchDeadLetter(outboxId: string, fenceEpoch: number, errorCode: string): boolean {
    const nowMs = this.clock.nowMs;
    return this.transactionSync(() => {
      const row = this.db
        .prepare(
          'SELECT dlq_count, fence_epoch, entity_kind FROM v2_dispatch_outbox WHERE outbox_id = ?',
        )
        .get(outboxId) as
        { dlq_count: number; fence_epoch: number; entity_kind: string } | undefined;
      if (!row || row.fence_epoch !== fenceEpoch || row.entity_kind === 'budget_sync') {
        return false;
      }
      const nextCount = row.dlq_count + 1;
      const backoffMs = Math.min(60_000, 5_000 * nextCount);
      this.db
        .prepare(
          `UPDATE v2_dispatch_outbox
           SET state = 'dead_lettered',
               dlq_count = ?,
               last_error_code = ?,
               next_attempt_at_ms = ?,
               updated_at_ms = ?
           WHERE outbox_id = ?`,
        )
        .run(nextCount, errorCode, nowMs + backoffMs, nowMs, outboxId);
      this.recomputeAlarmSync();
      return true;
    });
  }

  committedResults(): Array<{ target_id: string; lease_epoch: number; result_text: string }> {
    return this.db
      .prepare('SELECT target_id, lease_epoch, result_text FROM probe_committed_results')
      .all() as Array<{ target_id: string; lease_epoch: number; result_text: string }>;
  }
}

function nextDailyZonedFireMs(params: {
  readonly afterMs: number;
  readonly timezone: string;
  readonly hour: number;
  readonly minute: number;
  readonly lastFiredLocalDate?: string;
}): { readonly fireAtMs: number; readonly localDate: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: params.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const partsOf = (ms: number): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(ms))) {
      if (p.type !== 'literal') out[p.type] = p.value;
    }
    return out;
  };

  const startMin = Math.floor(params.afterMs / 60_000) * 60_000 + 60_000;
  let lastLocalDate = params.lastFiredLocalDate ?? '';
  for (let offsetMin = 0; offsetMin < 48 * 60; offsetMin += 1) {
    const candidateMs = startMin + offsetMin * 60_000;
    const p = partsOf(candidateMs);
    const localDate = `${p.year}-${p.month}-${p.day}`;
    const totalMin = Number(p.hour) * 60 + Number(p.minute);
    const targetMin = params.hour * 60 + params.minute;

    if (localDate !== lastLocalDate && totalMin >= targetMin) {
      return { fireAtMs: candidateMs, localDate };
    }
    if (localDate === lastLocalDate && totalMin < targetMin) {
      lastLocalDate = localDate;
    }
  }
  throw new Error('Unreachable cron_tz window');
}

describe('V2-M0-B Event Runtime & Recovery Protocol Probe (J1–J5)', () => {
  it('guarantees zero synchronous D1 I/O on covered turns and clean retirement when idle', async () => {
    const clock = new VirtualClock(1_700_000_000_000);
    const registry = new D1RecoveryRegistry();
    const queue = new SimulatedQueueBus();
    const agent = new AgentHeadDOProbe({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      clock,
      registry,
      queue,
    });

    const t1 = agent.prepareFastTurn({ turnId: 'turn-1', ownerId: 'edge-1' });
    expect(registry.writes).toBe(1);
    agent.commitFastTurn({
      turnId: 'turn-1',
      runId: t1.runId,
      leaseEpoch: t1.leaseEpoch,
      resultText: 'ok-1',
    });

    registry.resetMeters();
    for (let i = 2; i <= 10; i += 1) {
      clock.advanceBy(2_000);
      const turn = agent.prepareFastTurn({ turnId: `turn-${i}`, ownerId: 'edge-1' });
      agent.commitFastTurn({
        turnId: `turn-${i}`,
        runId: turn.runId,
        leaseEpoch: turn.leaseEpoch,
        resultText: `ok-${i}`,
      });
    }
    expect(registry.reads).toBe(0);
    expect(registry.writes).toBe(0);

    clock.advanceBy(100_000);
    const due = registry.claimDueMarkers({ sweeperId: 'sweep-1', nowMs: clock.nowMs, limit: 10 });
    expect(due).toHaveLength(1);
    await agent.reconcileFromRegistry(due[0]!.generation);
    expect(registry.snapshot('tenant-1:agent-1')).toBeUndefined();
    expect(agent.committedResults()).toHaveLength(10);
  });

  it('J2: rejects stale upsert, repairs crash-before-D1-CAS and crash/ACK-loss-after-CAS without client traffic', async () => {
    const clock = new VirtualClock();
    const registry = new D1RecoveryRegistry();
    const queue = new SimulatedQueueBus();
    const agent = new AgentHeadDOProbe({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      clock,
      registry,
      queue,
    });

    // 1. Seed older D1 marker gen=5 (e.g. from higher-gen concurrent writer), while DO local gen=1 -> stale upsert fails & repairs!
    registry.upsertCoverage({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      generation: 5,
      recoveryAtMs: clock.nowMs + 100_000, // too late for new nowMs + 45s obligation!
      nowMs: clock.nowMs,
    });
    // prepareFastTurn tries gen=1 (rejected with actual gen=5), then auto-bumps to gen=6 and confirms actual <= now+45s!
    const t1 = agent.prepareFastTurn({ turnId: 'turn-stale-repair', ownerId: 'edge-1' });
    agent.commitFastTurn({
      turnId: 'turn-stale-repair',
      runId: t1.runId,
      leaseEpoch: 1,
      resultText: 'ok-1',
    });
    const snap1 = registry.snapshot('tenant-1:agent-1') as {
      generation: number;
      next_recovery_at_ms: number;
    };
    expect(snap1.generation).toBe(7);
    expect(snap1.next_recovery_at_ms).toBeLessThanOrEqual(clock.nowMs + D1_RECOVERY_GRACE_MS);

    // 2. Crash AFTER persisting pending_kind='ensure' BEFORE D1 CAS:
    //    First schedule future work at T0+600s and postpone D1 marker to T0+645s (gen=8).
    const futureSchedAt = clock.nowMs + 600_000;
    const { outboxId: schedTaskOutbox } = agent.acceptDurableTask({
      taskId: 'task-sched-base',
      scheduleAtMs: futureSchedAt,
    });
    agent.consumeQueueDelivery(
      queue.deliveries.find((d) => d.envelope.eventId === schedTaskOutbox)!.envelope,
      'agent_task',
      'exec-1',
    );
    clock.advanceBy(100_000);
    const duePostpone = registry.claimDueMarkers({
      sweeperId: 'sweep-postpone',
      nowMs: clock.nowMs,
      limit: 10,
    });
    expect(duePostpone).toHaveLength(1);
    await agent.reconcileFromRegistry(duePostpone[0]!.generation); // postpones D1 to futureSchedAt + 45s

    // Now an earlier obligation arrives (D = now+47s < futureSchedAt+45s) -> DO persists pending_kind='ensure' (gen+1) & crashes before D1 CAS!
    agent.crashAfterPendingPersistBeforeD1 = true;
    expect(() => agent.acceptDurableTask({ taskId: 'task-crash-before-d1' })).toThrow(
      /pending_kind before D1 CAS/,
    );

    // Sweeper wakes DO on the D1 marker -> observedGen < DO gen, yet DO MUST repair (NOT noop_stale)!
    clock.nowMs = futureSchedAt + D1_RECOVERY_GRACE_MS;
    const due1 = registry.claimDueMarkers({
      sweeperId: 'sweep-j2-a',
      nowMs: clock.nowMs,
      limit: 10,
    });
    expect(due1).toHaveLength(1);
    await agent.reconcileFromRegistry(due1[0]!.generation);
    const covAfter1 = agent.db
      .prepare('SELECT coverage_state, pending_kind FROM v2_recovery_coverage WHERE id = 1')
      .get();
    expect(covAfter1).toEqual({ coverage_state: 'covered', pending_kind: null });

    // 3. Crash / ACK loss AFTER D1 CAS succeeded on a fresh uncovered agent -> DO stays 'registering',
    //    Sweeper reads actual D1 via readCoverage and confirms 'covered' without client traffic!
    const agent3 = new AgentHeadDOProbe({
      tenantId: 'tenant-1',
      agentId: 'agent-ack-loss',
      clock,
      registry,
      queue,
    });
    const futureSched3 = clock.nowMs + 600_000;
    agent3.crashAfterD1CasLoseAck = true;
    expect(() =>
      agent3.acceptDurableTask({ taskId: 'task-ack-lost', scheduleAtMs: futureSched3 }),
    ).toThrow(/lost ACK/);
    expect(
      agent3.db
        .prepare('SELECT coverage_state, pending_kind FROM v2_recovery_coverage WHERE id = 1')
        .get(),
    ).toEqual({ coverage_state: 'registering', pending_kind: 'ensure' });

    clock.advanceBy(60_000);
    const due2 = registry.claimDueMarkers({
      sweeperId: 'sweep-j2-b',
      nowMs: clock.nowMs,
      limit: 10,
    });
    expect(due2.some((d) => d.agentId === 'agent-ack-loss')).toBe(true);
    const d2 = due2.find((d) => d.agentId === 'agent-ack-loss')!;
    await agent3.reconcileFromRegistry(d2.generation);
    // Since no obligations committed in agent3 before crash, reconcile retires cleanly to 'uncovered', pending_kind=NULL
    expect(
      agent3.db
        .prepare('SELECT coverage_state, pending_kind FROM v2_recovery_coverage WHERE id = 1')
        .get(),
    ).toEqual({ coverage_state: 'uncovered', pending_kind: null });
    expect(registry.snapshot('tenant-1:agent-ack-loss')).toBeUndefined();
  });

  it('J3: preserves next_recovery_at_ms during Sweeper backoff/quarantine, keeps covered turns at 0 D1 I/O, and rejects stale sweep callbacks', async () => {
    const clock = new VirtualClock();
    const registry = new D1RecoveryRegistry();
    const queue = new SimulatedQueueBus();
    const agent = new AgentHeadDOProbe({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      clock,
      registry,
      queue,
    });

    const t1 = agent.prepareFastTurn({ turnId: 'turn-1', ownerId: 'edge-1' });
    agent.commitFastTurn({ turnId: 'turn-1', runId: t1.runId, leaseEpoch: 1, resultText: 'ok-1' });
    const initialMarker = registry.snapshot('tenant-1:agent-1') as {
      next_recovery_at_ms: number;
      generation: number;
    };

    // Simulate DO RPC outage across 3 Sweeper attempts -> moves D1 row into backoff then quarantined!
    agent.rpcUnavailable = true;
    clock.advanceBy(60_000);
    for (let i = 0; i < 3; i += 1) {
      const claimed = registry.claimDueMarkers({
        sweeperId: `sweep-${i}`,
        nowMs: clock.nowMs,
        limit: 10,
      });
      expect(claimed).toHaveLength(1);
      await expect(agent.reconcileFromRegistry(claimed[0]!.generation)).rejects.toThrow(
        /RPC outage/,
      );
      registry.recordSweepFailure({
        agentKey: claimed[0]!.agentKey,
        generation: claimed[0]!.generation,
        sweeperId: `sweep-${i}`,
        errorCode: 'RPC_UNAVAILABLE',
        nowMs: clock.nowMs,
      });
      clock.advanceBy(60_000);
    }

    const qRow = registry.snapshot('tenant-1:agent-1') as {
      status: RegistryStatus;
      next_recovery_at_ms: number;
      retry_not_before_ms: number;
    };
    expect(qRow.status).toBe('quarantined');
    // J3: next_recovery_at_ms MUST NOT have been pushed forward!
    expect(qRow.next_recovery_at_ms).toBe(initialMarker.next_recovery_at_ms);
    expect(qRow.retry_not_before_ms).toBeGreaterThan(clock.nowMs);

    // Covered Fast Path turn STILL succeeds with ZERO D1 I/O while D1 row is quarantined!
    registry.resetMeters();
    const t2 = agent.prepareFastTurn({
      turnId: 'turn-covered-during-quarantine',
      ownerId: 'edge-1',
    });
    expect(registry.reads).toBe(0);
    expect(registry.writes).toBe(0);
    agent.commitFastTurn({
      turnId: 'turn-covered-during-quarantine',
      runId: t2.runId,
      leaseEpoch: 1,
      resultText: 'ok-2',
    });

    // Stale sweeper callback (wrong owner) CANNOT mutate quarantined/claimed marker
    clock.advanceBy(130_000);
    const activeClaim = registry.claimDueMarkers({
      sweeperId: 'sweep-live',
      nowMs: clock.nowMs,
      limit: 10,
    });
    expect(activeClaim).toHaveLength(1);
    const staleFail = registry.recordSweepFailure({
      agentKey: 'tenant-1:agent-1',
      generation: activeClaim[0]!.generation,
      sweeperId: 'sweep-stale-ghost',
      errorCode: 'STALE',
      nowMs: clock.nowMs,
    });
    expect(staleFail.applied).toBe(false);

    // Dependency restores -> quarantined marker is STILL in due index and recovers automatically!
    agent.rpcUnavailable = false;
    await agent.reconcileFromRegistry(activeClaim[0]!.generation);
    expect(registry.snapshot('tenant-1:agent-1')).toBeUndefined();
  });

  it('J4: enforces live continuously renewed >120s handoff, preserves total deadline, and rejects expired/cancelled/wrong-owner handoffs', () => {
    const clock = new VirtualClock();
    const registry = new D1RecoveryRegistry();
    const queue = new SimulatedQueueBus();
    const agent = new AgentHeadDOProbe({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      clock,
      registry,
      queue,
    });

    // 1. Live continuously renewed >120s handoff (15s renewals up to 110s, total deadline 600s unchanged!)
    const tLong = agent.prepareFastTurn({ turnId: 'turn-renewed', ownerId: 'edge-live' });
    agent.markAttemptSent({
      turnId: 'turn-renewed',
      runId: tLong.runId,
      leaseEpoch: 1,
      leaseOwner: 'edge-live',
      providerJobHandle: 'resp_job_789',
    });

    for (let step = 1; step <= 7; step += 1) {
      clock.advanceBy(V2_INTERACTIVE_RENEW_INTERVAL_MS); // 15s * 7 = 105s
      expect(
        agent.renewTurnLease({
          turnId: 'turn-renewed',
          runId: tLong.runId,
          leaseEpoch: 1,
          leaseOwner: 'edge-live',
        }),
      ).toBe(true);
    }
    clock.advanceBy(5_000); // 110s (within 105-115s transfer window, live 45s lease, < 120s interactive, < 600s total)

    // Wrong owner rejected
    expect(() =>
      agent.handoffTurnToDurable({
        turnId: 'turn-renewed',
        runId: tLong.runId,
        leaseEpoch: 1,
        leaseOwner: 'edge-other',
      }),
    ).toThrow(/Fenced|Handoff rejected/);

    // Valid handoff preserves original totalDeadlineMs (no deadline extension!)
    const handoff = agent.handoffTurnToDurable({
      turnId: 'turn-renewed',
      runId: tLong.runId,
      leaseEpoch: 1,
      leaseOwner: 'edge-live',
    });
    expect(handoff.deadlineAtMs).toBe(tLong.totalDeadlineMs);
    expect(handoff.nextLeaseEpoch).toBe(2);

    // Old Fast Path epoch=1 commit is fenced
    expect(() =>
      agent.commitFastTurn({
        turnId: 'turn-renewed',
        runId: tLong.runId,
        leaseEpoch: 1,
        resultText: 'stale',
      }),
    ).toThrow(/Fenced stale fast-path commit/);

    // Cancelled turn handoff is rejected
    const tCancelled = agent.prepareFastTurn({
      turnId: 'turn-cancelled-handoff',
      ownerId: 'edge-c',
    });
    agent.requestCancel('turn', 'turn-cancelled-handoff');
    expect(() =>
      agent.handoffTurnToDurable({
        turnId: 'turn-cancelled-handoff',
        runId: tCancelled.runId,
        leaseEpoch: 1,
        leaseOwner: 'edge-c',
      }),
    ).toThrow(/Handoff rejected/);

    // Durable execution resumes handle once
    const env = queue.deliveries.find((d) => d.envelope.entityId === 'turn-renewed')!.envelope;
    agent.consumeQueueDelivery(env, 'durable_turn', 'exec-1');
    expect(agent.committedResults().find((r) => r.target_id === 'turn-renewed')?.result_text).toBe(
      'resumed:resp_job_789',
    );

    // 2. Expired lease (jump 50s without renewal) MUST reject handoff!
    const tExp = agent.prepareFastTurn({ turnId: 'turn-expired-lease', ownerId: 'edge-2' });
    clock.advanceBy(50_000);
    expect(() =>
      agent.handoffTurnToDurable({
        turnId: 'turn-expired-lease',
        runId: tExp.runId,
        leaseEpoch: 1,
        leaseOwner: 'edge-2',
      }),
    ).toThrow(/Handoff rejected/);

    // 3. Total deadline hold after handoff: when total deadline elapses, DO fails without extension!
    const tHold = agent.prepareFastTurn({ turnId: 'turn-total-hold', ownerId: 'edge-3' });
    agent.markAttemptSent({
      turnId: 'turn-total-hold',
      runId: tHold.runId,
      leaseEpoch: 1,
      leaseOwner: 'edge-3',
      providerJobHandle: null, // missing handle -> uncertain outcome if reconciled
    });
    clock.advanceBy(10_000);
    const holdHandoff = agent.handoffTurnToDurable({
      turnId: 'turn-total-hold',
      runId: tHold.runId,
      leaseEpoch: 1,
      leaseOwner: 'edge-3',
    });
    clock.nowMs = holdHandoff.deadlineAtMs;
    agent.tickAlarmIfDue();
    const failedHold = agent.db
      .prepare("SELECT status FROM probe_turns_and_tasks WHERE target_id = 'turn-total-hold'")
      .get();
    expect(failedHold).toEqual({ status: 'failed' });

    // 4. B1 60s compat mode bounded 22s handoff / 25s lease
    const tB1 = agent.prepareFastTurn({ turnId: 'turn-b1', ownerId: 'edge-b1', b1Compat60s: true });
    expect(tB1.totalDeadlineMs - clock.nowMs).toBe(B1_TOTAL_DEADLINE_MS);
    expect(tB1.interactiveDeadlineMs - clock.nowMs).toBe(B1_FAST_HANDOFF_MS);
  });

  it('J5: validates closed outbox envelopes, rejects future/mismatched epochs, caps B1 re-enqueue grace, and preserves budget_sync across cancel/clear', async () => {
    const clock = new VirtualClock();
    const registry = new D1RecoveryRegistry();
    const queue = new SimulatedQueueBus();
    const globalBudget = new FakeGlobalBudgetAuthority();
    const agent = new AgentHeadDOProbe({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      clock,
      registry,
      queue,
      globalBudget,
    });

    // 1. Closed envelope validation: reject unknown outbox_id, wrong queue, wrong entity_kind, and FUTURE epoch!
    const { outboxId, deadlineAtMs } = agent.acceptDurableTask({
      taskId: 'task-j5',
      deadlineMs: B1_TOTAL_DEADLINE_MS,
    });
    // B1 re-enqueue grace is capped below 60s total deadline (55s < 60s)
    const outboxRow = agent.db
      .prepare('SELECT next_attempt_at_ms FROM v2_dispatch_outbox WHERE outbox_id = ?')
      .get(outboxId) as { next_attempt_at_ms: number };
    expect(outboxRow.next_attempt_at_ms).toBeLessThan(deadlineAtMs);

    // Reject forged future fenceEpoch > 0
    expect(
      agent.consumeQueueDelivery(
        {
          schemaVersion: 2,
          eventId: outboxId,
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          entityKind: 'task',
          entityId: 'task-j5',
          queueName: 'agent_task',
          fenceEpoch: 99,
        },
        'agent_task',
        'worker-bad',
      ),
    ).toBe('rejected');

    // Reject wrong queueName
    expect(
      agent.consumeQueueDelivery(
        {
          schemaVersion: 2,
          eventId: outboxId,
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          entityKind: 'task',
          entityId: 'task-j5',
          queueName: 'durable_turn',
          fenceEpoch: 0,
        },
        'durable_turn',
        'worker-bad',
      ),
    ).toBe('rejected');

    // Reject unknown outbox_id
    expect(
      agent.consumeQueueDelivery(
        {
          schemaVersion: 2,
          eventId: 'unknown-outbox',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          entityKind: 'task',
          entityId: 'task-j5',
          queueName: 'agent_task',
          fenceEpoch: 0,
        },
        'agent_task',
        'worker-bad',
      ),
    ).toBe('rejected');

    // Verify zero mutation from all rejected deliveries
    expect(
      agent.db
        .prepare(
          "SELECT status, lease_epoch FROM probe_turns_and_tasks WHERE target_id = 'task-j5'",
        )
        .get(),
    ).toEqual({ status: 'queued', lease_epoch: 0 });

    // 2. budget_sync survives cancelTurn & clearTranscript, blocks retirement until global ACK, supports rev 1 + rev 2!
    globalBudget.failNextSettles = 2; // force budget_sync outbox to stay pending across clearTranscript & sweep!
    const tFast = agent.prepareFastTurn({ turnId: 'turn-budget', ownerId: 'edge-1' });
    agent.commitFastTurn({
      turnId: 'turn-budget',
      runId: tFast.runId,
      leaseEpoch: 1,
      resultText: 'done',
      operationId: 'op-123',
      amountMicroUsd: 250,
    });
    agent.enqueueLateBudgetCorrection({
      operationId: 'op-123',
      revision: 2,
      subjectId: 'turn-budget',
      correctedMicroUsd: 310,
    });

    // Clear transcript + cancel -> budget_sync MUST remain pending and MUST NOT be cancelled or retired!
    agent.clearTranscript();
    agent.requestCancel('turn', 'turn-budget');
    const pendingBudget = agent.db
      .prepare(
        "SELECT COUNT(*) AS c FROM v2_dispatch_outbox WHERE entity_kind = 'budget_sync' AND state = 'pending'",
      )
      .get();
    expect(pendingBudget).toEqual({ c: 2 });

    // Sweeper wakes DO while globalBudget is healthy again -> relays rev 1 & rev 2, then next sweep retires!
    clock.advanceBy(60_000);
    const dueBs = registry.claimDueMarkers({
      sweeperId: 'sweep-bs',
      nowMs: clock.nowMs,
      limit: 10,
    });
    expect(dueBs).toHaveLength(1);
    await agent.reconcileFromRegistry(dueBs[0]!.generation);

    expect(globalBudget.settled.get('op-123:1')?.amountMicroUsd).toBe(250);
    expect(globalBudget.settled.get('op-123:2')?.amountMicroUsd).toBe(310);

    // Reject trying to inject budget_sync over external Queue!
    expect(
      agent.consumeQueueDelivery(
        {
          schemaVersion: 2,
          eventId: 'budget_sync:op-123:rev:1',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          entityKind: 'task',
          entityId: 'op-123',
          queueName: 'agent_task',
          fenceEpoch: 0,
        },
        'agent_task',
        'worker-bad',
      ),
    ).toBe('rejected');
  });

  it('recovers offline agent within <= 2m detection and <= 5m dispatch/re-arm after initial Alarm + all 6 retries fail', async () => {
    const clock = new VirtualClock(1_700_000_000_000);
    const registry = new D1RecoveryRegistry();
    const queue = new SimulatedQueueBus();
    const agent = new AgentHeadDOProbe({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      clock,
      registry,
      queue,
    });

    queue.failNextSends = 1;
    agent.alarmFailureBudget = 7;

    const futureScheduleAtMs = clock.nowMs + 600_000;
    agent.acceptDurableTask({ taskId: 'task-offline-1', scheduleAtMs: futureScheduleAtMs });
    expect(queue.deliveries).toHaveLength(0);

    const startMs = clock.nowMs;
    let detectedAtMs: number | null = null;
    let recoveredAtMs: number | null = null;

    for (let sec = 1; sec <= 400; sec += 1) {
      clock.advanceBy(1_000);
      agent.tickAlarmIfDue();

      if ((clock.nowMs - startMs) % SWEEPER_CADENCE_MS === 0 && agent.alarmDead) {
        const due = registry.claimDueMarkers({
          sweeperId: `cron-${sec}`,
          nowMs: clock.nowMs,
          limit: 10,
        });
        if (due.length > 0) {
          detectedAtMs ??= clock.nowMs;
          await agent.reconcileFromRegistry(due[0]!.generation);
          if (queue.deliveries.length > 0 && agent.armedAlarmAtMs !== null) {
            recoveredAtMs ??= clock.nowMs;
            break;
          }
        }
      }
    }

    expect(agent.alarmRetryExhaustedAtMs).not.toBeNull();
    expect(detectedAtMs! - agent.alarmRetryExhaustedAtMs!).toBeLessThanOrEqual(120_000);
    expect(recoveredAtMs! - agent.alarmRetryExhaustedAtMs!).toBeLessThanOrEqual(300_000);

    for (const item of queue.deliveries) {
      agent.consumeQueueDelivery(item.envelope, item.envelope.queueName, 'exec-worker-1');
    }
    expect(agent.committedResults()).toHaveLength(1);
    expect(agent.armedAlarmAtMs).toBe(futureScheduleAtMs);
  });

  it('evaluates DST spring-forward and fall-back cron_tz schedules deterministically without double-firing', () => {
    const beforeSpring = Date.parse('2026-03-08T06:50:00Z');
    const spring = nextDailyZonedFireMs({
      afterMs: beforeSpring,
      timezone: 'America/New_York',
      hour: 2,
      minute: 30,
    });
    expect(spring.localDate).toBe('2026-03-08');
    expect(spring.fireAtMs).toBe(Date.parse('2026-03-08T07:00:00Z'));

    const beforeFall = Date.parse('2026-11-01T05:00:00Z');
    const fallFirst = nextDailyZonedFireMs({
      afterMs: beforeFall,
      timezone: 'America/New_York',
      hour: 1,
      minute: 30,
    });
    expect(fallFirst.fireAtMs).toBe(Date.parse('2026-11-01T05:30:00Z'));

    const fallNext = nextDailyZonedFireMs({
      afterMs: fallFirst.fireAtMs,
      timezone: 'America/New_York',
      hour: 1,
      minute: 30,
      lastFiredLocalDate: fallFirst.localDate,
    });
    expect(fallNext.localDate).toBe('2026-11-02');
    expect(fallNext.fireAtMs).toBe(Date.parse('2026-11-02T06:30:00Z'));
  });

  it('guards concurrent retirement race, D1 outage fail-closed vs covered Fast Path, and uncertain postponement timeout', async () => {
    const clock = new VirtualClock();
    const registry = new D1RecoveryRegistry();
    const queue = new SimulatedQueueBus();
    const agent = new AgentHeadDOProbe({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      clock,
      registry,
      queue,
    });

    // 1. D1 unavailable: uncovered fails closed with 0 business rows; covered succeeds with 0 D1 I/O!
    registry.faultMode = 'unavailable';
    expect(() => agent.prepareFastTurn({ turnId: 'turn-uncovered', ownerId: 'edge-1' })).toThrow(
      /unavailable/i,
    );
    expect(agent.db.prepare('SELECT COUNT(*) AS c FROM probe_turns_and_tasks').get()).toEqual({
      c: 0,
    });

    registry.faultMode = 'healthy';
    const t1 = agent.prepareFastTurn({ turnId: 'turn-1', ownerId: 'edge-1' });
    agent.commitFastTurn({ turnId: 'turn-1', runId: t1.runId, leaseEpoch: 1, resultText: 'ok-1' });

    registry.faultMode = 'unavailable';
    registry.resetMeters();
    const t2 = agent.prepareFastTurn({ turnId: 'turn-2', ownerId: 'edge-1' });
    agent.commitFastTurn({ turnId: 'turn-2', runId: t2.runId, leaseEpoch: 1, resultText: 'ok-2' });
    expect(registry.reads).toBe(0);
    expect(registry.writes).toBe(0);

    // 2. Concurrent retirement vs newly accepted turn -> new turn's D1 marker survives!
    registry.faultMode = 'healthy';
    clock.advanceBy(100_000);
    const dueRetire = registry.claimDueMarkers({
      sweeperId: 'sweep-r',
      nowMs: clock.nowMs,
      limit: 10,
    });
    expect(dueRetire).toHaveLength(1);

    let acceptedDuringRetire = false;
    agent.onBeforeRemoteRetirement = () => {
      if (!acceptedDuringRetire) {
        acceptedDuringRetire = true;
        agent.prepareFastTurn({ turnId: 'turn-race', ownerId: 'edge-race' });
      }
    };
    await agent.reconcileFromRegistry(dueRetire[0]!.generation);
    agent.onBeforeRemoteRetirement = undefined;
    const markerAfterRace = registry.snapshot('tenant-1:agent-1') as
      { generation: number } | undefined;
    expect(markerAfterRace).toBeDefined();
    expect(markerAfterRace!.generation).toBeGreaterThan(dueRetire[0]!.generation);

    // 3. Uncertain postponement timeout does NOT revert DO coverage_state to 'covered'!
    const turnRace = agent.db
      .prepare("SELECT active_run_id FROM probe_turns_and_tasks WHERE target_id = 'turn-race'")
      .get() as { active_run_id: string };
    agent.commitFastTurn({
      turnId: 'turn-race',
      runId: turnRace.active_run_id,
      leaseEpoch: 1,
      resultText: 'ok-race',
    });
    agent.acceptDurableTask({ taskId: 'task-later', scheduleAtMs: clock.nowMs + 600_000 });
    for (const d of queue.deliveries) {
      agent.consumeQueueDelivery(d.envelope, d.envelope.queueName, 'exec-1');
    }

    clock.advanceBy(100_000);
    const duePostpone = registry.claimDueMarkers({
      sweeperId: 'sweep-p',
      nowMs: clock.nowMs,
      limit: 10,
    });
    expect(duePostpone).toHaveLength(1);
    registry.faultMode = 'uncertain_timeout';
    await expect(agent.reconcileFromRegistry(duePostpone[0]!.generation)).rejects.toThrow(
      /timed out/i,
    );
    expect(
      agent.db.prepare('SELECT coverage_state FROM v2_recovery_coverage WHERE id = 1').get(),
    ).toEqual({ coverage_state: 'registering' });
  });
});
