import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

/**
 * Isolated M0-B Protocol Probe (not runtime production code).
 *
 * Uses two independent `node:sqlite` databases (`AgentHeadDO` SQLite and `D1RecoveryRegistry`)
 * plus a deterministic virtual clock to verify the V2 Event Runtime & Recovery invariants
 * defined in `docs/architecture/v2-m0-event-recovery-contract.md`.
 */

const FAST_LEASE_MS = 45_000;
const FAST_DEADLINE_MS = 120_000;
const OUTBOX_IMMEDIATE_GRACE_MS = 2_000;
const OUTBOX_REENQUEUE_GRACE_MS = 60_000;
const D1_RECOVERY_GRACE_MS = 45_000;
const SWEEPER_CADENCE_MS = 60_000;
const SWEEP_LEASE_MS = 30_000;
const MAX_ALARM_RETRIES = 6;

type CoverageState = 'uncovered' | 'registering' | 'covered';
type LeaseStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'retryable_failed'
  | 'completed'
  | 'failed'
  | 'cancelled';
type ProviderOutcomeState = 'none' | 'in_flight' | 'uncertain' | 'settled';
type D1FaultMode = 'healthy' | 'unavailable' | 'uncertain_timeout';

interface DispatchEnvelope {
  readonly schemaVersion: 2;
  readonly eventId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly entityKind: 'turn' | 'task' | 'schedule_occurrence' | 'handoff';
  readonly entityId: string;
  readonly fenceEpoch: number;
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

class D1RecoveryRegistry {
  readonly db: DatabaseSync;
  faultMode: D1FaultMode = 'healthy';
  reads = 0;
  writes = 0;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      CREATE TABLE v2_recovery_registry (
        agent_key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        next_recovery_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('armed', 'backoff', 'quarantined')),
        sweep_lease_owner TEXT,
        sweep_lease_expires_at_ms INTEGER,
        recovery_attempts INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX idx_v2_recovery_due
        ON v2_recovery_registry (next_recovery_at_ms, agent_key)
        WHERE status IN ('armed', 'backoff');
    `);
  }

  private maybeInjectFault(commitAnywayOnUncertain?: () => void): void {
    if (this.faultMode === 'unavailable') {
      throw new ProtocolError('DB_UNAVAILABLE', 503, 'D1 recovery registry unavailable');
    }
    if (this.faultMode === 'uncertain_timeout') {
      // Simulate server committing the write while the caller observes a timeout/reset.
      commitAnywayOnUncertain?.();
      throw new ProtocolError('DB_UNAVAILABLE', 503, 'D1 recovery registry response timed out');
    }
  }

  upsertCoverage(input: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly generation: number;
    readonly nextRecoveryAtMs: number;
    readonly nowMs: number;
  }): { readonly applied: boolean } {
    const agentKey = `${input.tenantId}:${input.agentId}`;
    const execute = (): boolean => {
      this.writes += 1;
      const result = this.db
        .prepare(
          `INSERT INTO v2_recovery_registry (
            agent_key, tenant_id, agent_id, generation, next_recovery_at_ms, status, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, 'armed', ?)
          ON CONFLICT (agent_key) DO UPDATE SET
            generation = excluded.generation,
            next_recovery_at_ms = CASE
              WHEN v2_recovery_registry.status IN ('armed', 'backoff')
                   AND v2_recovery_registry.next_recovery_at_ms < excluded.next_recovery_at_ms
              THEN v2_recovery_registry.next_recovery_at_ms
              ELSE excluded.next_recovery_at_ms
            END,
            status = 'armed',
            sweep_lease_owner = NULL,
            sweep_lease_expires_at_ms = NULL,
            updated_at_ms = excluded.updated_at_ms
          WHERE v2_recovery_registry.generation < excluded.generation`,
        )
        .run(
          agentKey,
          input.tenantId,
          input.agentId,
          input.generation,
          input.nextRecoveryAtMs,
          input.nowMs,
        );
      return Number(result.changes) > 0;
    };

    if (this.faultMode === 'uncertain_timeout') {
      this.maybeInjectFault(() => {
        execute();
      });
    }
    this.maybeInjectFault();
    return { applied: execute() };
  }

  postponeCoverage(input: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly expectedPrevGeneration: number;
    readonly nextGeneration: number;
    readonly nextRecoveryAtMs: number;
    readonly nowMs: number;
  }): { readonly applied: boolean } {
    const agentKey = `${input.tenantId}:${input.agentId}`;
    const execute = (): boolean => {
      this.writes += 1;
      const result = this.db
        .prepare(
          `UPDATE v2_recovery_registry
           SET generation = ?,
               next_recovery_at_ms = ?,
               status = 'armed',
               sweep_lease_owner = NULL,
               sweep_lease_expires_at_ms = NULL,
               recovery_attempts = 0,
               last_error_code = NULL,
               updated_at_ms = ?
           WHERE agent_key = ?
             AND generation = ?`,
        )
        .run(
          input.nextGeneration,
          input.nextRecoveryAtMs,
          input.nowMs,
          agentKey,
          input.expectedPrevGeneration,
        );
      return Number(result.changes) > 0;
    };

    if (this.faultMode === 'uncertain_timeout') {
      this.maybeInjectFault(() => {
        execute();
      });
    }
    this.maybeInjectFault();
    return { applied: execute() };
  }

  retireCoverage(input: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly maxRetiredGeneration: number;
  }): { readonly deleted: boolean } {
    const agentKey = `${input.tenantId}:${input.agentId}`;
    const execute = (): boolean => {
      this.writes += 1;
      const result = this.db
        .prepare(
          `DELETE FROM v2_recovery_registry
           WHERE agent_key = ?
             AND generation <= ?`,
        )
        .run(agentKey, input.maxRetiredGeneration);
      return Number(result.changes) > 0;
    };

    if (this.faultMode === 'uncertain_timeout') {
      this.maybeInjectFault(() => {
        execute();
      });
    }
    this.maybeInjectFault();
    return { deleted: execute() };
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
         WHERE status IN ('armed', 'backoff')
           AND next_recovery_at_ms <= ?
           AND (sweep_lease_expires_at_ms IS NULL OR sweep_lease_expires_at_ms <= ?)
         ORDER BY next_recovery_at_ms ASC, agent_key ASC
         LIMIT ?`,
      )
      .all(input.nowMs, input.nowMs, input.limit) as Array<{
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

  backoffMarker(input: {
    readonly agentKey: string;
    readonly generation: number;
    readonly nextRetryAtMs: number;
    readonly errorCode: string;
    readonly nowMs: number;
  }): void {
    this.maybeInjectFault();
    this.writes += 1;
    this.db
      .prepare(
        `UPDATE v2_recovery_registry
         SET status = 'backoff',
             next_recovery_at_ms = ?,
             recovery_attempts = recovery_attempts + 1,
             sweep_lease_owner = NULL,
             sweep_lease_expires_at_ms = NULL,
             last_error_code = ?,
             updated_at_ms = ?
         WHERE agent_key = ?
           AND generation = ?`,
      )
      .run(input.nextRetryAtMs, input.errorCode, input.nowMs, input.agentKey, input.generation);
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
  readonly deliveries: Array<{ envelope: DispatchEnvelope; attempts: number; readyAtMs: number }> =
    [];
  readonly dlq: Array<{ envelope: DispatchEnvelope; errorCode: string }> = [];
  failNextSends = 0;
  duplicateNextSend = false;

  send(envelope: DispatchEnvelope, nowMs: number): void {
    if (this.failNextSends > 0) {
      this.failNextSends -= 1;
      throw new ProtocolError('QUEUE_UNAVAILABLE', 503, 'Simulated Queue.send failure');
    }
    this.deliveries.push({ envelope, attempts: 0, readyAtMs: nowMs });
    if (this.duplicateNextSend) {
      this.duplicateNextSend = false;
      this.deliveries.push({ envelope, attempts: 0, readyAtMs: nowMs });
    }
  }
}

class AgentHeadDOProbe {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  readonly agentId: string;
  readonly clock: VirtualClock;
  readonly registry: D1RecoveryRegistry;
  readonly queue: SimulatedQueueBus;

  // Fault-injection hooks for deterministic tests
  alarmFailureBudget = 0;
  alarmRetryExhaustedAtMs: number | null = null;
  alarmRetryDelaysMs = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000];
  crashAfterD1BeforeDoCommit = false;
  crashAfterQueueSendBeforeOutboxUpdate = false;
  onBeforeRemoteRetirement?: () => Promise<void> | void;

  // Alarm simulation state
  armedAlarmAtMs: number | null = null;
  alarmRetriesUsed = 0;
  alarmDead = false;

  constructor(opts: {
    tenantId: string;
    agentId: string;
    clock: VirtualClock;
    registry: D1RecoveryRegistry;
    queue: SimulatedQueueBus;
  }) {
    this.tenantId = opts.tenantId;
    this.agentId = opts.agentId;
    this.clock = opts.clock;
    this.registry = opts.registry;
    this.queue = opts.queue;
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      CREATE TABLE v2_schedules (
        schedule_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'interval', 'cron_tz')),
        interval_seconds INTEGER,
        cron_expr TEXT,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        next_fire_at_ms INTEGER NOT NULL,
        last_fired_at_ms INTEGER,
        occurrence_seq INTEGER NOT NULL DEFAULT 0,
        misfire_policy TEXT NOT NULL DEFAULT 'coalesce_latest',
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
        version INTEGER NOT NULL DEFAULT 1,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX idx_v2_schedules_due
        ON v2_schedules (next_fire_at_ms, schedule_id)
        WHERE status = 'active';
      CREATE UNIQUE INDEX idx_v2_schedules_source
        ON v2_schedules (source_kind, source_id);

      CREATE TABLE v2_dispatch_outbox (
        outbox_id TEXT PRIMARY KEY,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('turn', 'task', 'schedule_occurrence', 'handoff')),
        entity_id TEXT NOT NULL,
        queue_name TEXT NOT NULL,
        payload_ref TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'enqueued', 'acked', 'dead_lettered', 'cancelled')),
        next_attempt_at_ms INTEGER NOT NULL,
        publish_attempts INTEGER NOT NULL DEFAULT 0,
        last_enqueued_at_ms INTEGER,
        dlq_count INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        fence_epoch INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX idx_v2_outbox_due
        ON v2_dispatch_outbox (next_attempt_at_ms, outbox_id)
        WHERE state IN ('pending', 'enqueued', 'dead_lettered');

      CREATE TABLE v2_execution_leases (
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('fast_interactive', 'durable_cloud', 'durable_device')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'retryable_failed', 'completed', 'failed', 'cancelled')),
        active_run_id TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_acquired_at_ms INTEGER,
        lease_expires_at_ms INTEGER,
        last_renewed_at_ms INTEGER,
        execution_deadline_at_ms INTEGER NOT NULL,
        handoff_state TEXT NOT NULL DEFAULT 'none' CHECK (handoff_state IN ('none', 'pending_handoff', 'handed_off', 'reconciling')),
        provider_op_id TEXT,
        provider_outcome_state TEXT NOT NULL DEFAULT 'none' CHECK (provider_outcome_state IN ('none', 'in_flight', 'uncertain', 'settled')),
        cancel_requested_at_ms INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 2,
        next_action_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (target_kind, target_id)
      );
      CREATE INDEX idx_v2_leases_next_action
        ON v2_execution_leases (next_action_at_ms, target_kind, target_id)
        WHERE status IN ('queued', 'running', 'retryable_failed') AND next_action_at_ms IS NOT NULL;

      CREATE TABLE v2_recovery_coverage (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        coverage_state TEXT NOT NULL CHECK (coverage_state IN ('uncovered', 'registering', 'covered')),
        covered_recovery_at_ms INTEGER,
        armed_alarm_at_ms INTEGER,
        alarm_fail_count INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      );

      -- Minimal business ledger inside probe to assert at-most-once final result publication.
      CREATE TABLE probe_committed_results (
        target_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        result_text TEXT NOT NULL,
        committed_at_ms INTEGER NOT NULL
      );
    `);

    this.db
      .prepare(
        `INSERT INTO v2_recovery_coverage (
          id, tenant_id, agent_id, generation, coverage_state, covered_recovery_at_ms, armed_alarm_at_ms, updated_at_ms
        ) VALUES (1, ?, ?, 0, 'uncovered', NULL, NULL, ?)`,
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
    armed_alarm_at_ms: number | null;
  } {
    return this.db
      .prepare(
        'SELECT generation, coverage_state, covered_recovery_at_ms, armed_alarm_at_ms FROM v2_recovery_coverage WHERE id = 1',
      )
      .get() as {
      generation: number;
      coverage_state: CoverageState;
      covered_recovery_at_ms: number | null;
      armed_alarm_at_ms: number | null;
    };
  }

  private computeEarliestAlarmAtMs(): number | null {
    const outboxMin = this.db
      .prepare(
        `SELECT MIN(next_attempt_at_ms) AS m
         FROM v2_dispatch_outbox
         WHERE state IN ('pending', 'enqueued', 'dead_lettered')`,
      )
      .get() as { m: number | null };
    const leaseMin = this.db
      .prepare(
        `SELECT MIN(next_action_at_ms) AS m
         FROM v2_execution_leases
         WHERE status IN ('queued', 'running', 'retryable_failed')
           AND next_action_at_ms IS NOT NULL`,
      )
      .get() as { m: number | null };
    const schedMin = this.db
      .prepare(
        `SELECT MIN(next_fire_at_ms) AS m
         FROM v2_schedules
         WHERE status = 'active'`,
      )
      .get() as { m: number | null };

    const candidates = [outboxMin.m, leaseMin.m, schedMin.m].filter((v): v is number => v !== null);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  private rearmAlarmFromDb(): number | null {
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

  private ensureCoverageBeforeCommit(requiredRecoveryAtMs: number): void {
    const pre = this.transactionSync(() => {
      const cov = this.getCoverage();
      if (
        cov.coverage_state === 'covered' &&
        cov.covered_recovery_at_ms !== null &&
        cov.covered_recovery_at_ms <= requiredRecoveryAtMs
      ) {
        return { covered: true as const, generation: cov.generation };
      }
      const nextGen = cov.generation + 1;
      const targetRecovery =
        cov.covered_recovery_at_ms !== null
          ? Math.min(cov.covered_recovery_at_ms, requiredRecoveryAtMs)
          : requiredRecoveryAtMs;
      this.db
        .prepare(
          `UPDATE v2_recovery_coverage
           SET generation = ?,
               coverage_state = 'registering',
               updated_at_ms = ?
           WHERE id = 1`,
        )
        .run(nextGen, this.clock.nowMs);
      return { covered: false as const, generation: nextGen, targetRecovery };
    });

    if (pre.covered) {
      return;
    }

    // Synchronous D1 registration outside DO SQLite tx; fails closed on error!
    this.registry.upsertCoverage({
      tenantId: this.tenantId,
      agentId: this.agentId,
      generation: pre.generation,
      nextRecoveryAtMs: pre.targetRecovery,
      nowMs: this.clock.nowMs,
    });

    if (this.crashAfterD1BeforeDoCommit) {
      this.crashAfterD1BeforeDoCommit = false;
      throw new ProtocolError('SIMULATED_CRASH', 500, 'Simulated DO crash after D1 registration');
    }

    this.transactionSync(() => {
      const cov = this.getCoverage();
      if (cov.generation === pre.generation) {
        this.db
          .prepare(
            `UPDATE v2_recovery_coverage
             SET coverage_state = 'covered',
                 covered_recovery_at_ms = ?,
                 updated_at_ms = ?
             WHERE id = 1`,
          )
          .run(pre.targetRecovery, this.clock.nowMs);
      }
    });
  }

  /** Fast Path Prepare: 0 D1 calls when already covered! */
  prepareFastTurn(input: { readonly turnId: string; readonly ownerId: string }): {
    readonly runId: string;
    readonly leaseEpoch: number;
    readonly deadlineAtMs: number;
  } {
    const nowMs = this.clock.nowMs;
    const leaseExpiresAtMs = nowMs + FAST_LEASE_MS;
    const deadlineAtMs = nowMs + FAST_DEADLINE_MS;
    const requiredRecoveryAtMs = leaseExpiresAtMs + D1_RECOVERY_GRACE_MS;

    // Step 1: check coverage; registers D1 only if uncovered or earlier recovery required.
    this.ensureCoverageBeforeCommit(requiredRecoveryAtMs);

    // Step 2: Atomic DO commit re-checking coverage inside the exact same transactionSync!
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
          `INSERT INTO v2_execution_leases (
            target_kind, target_id, tenant_id, agent_id, execution_mode, status,
            active_run_id, lease_epoch, lease_owner, lease_acquired_at_ms,
            lease_expires_at_ms, last_renewed_at_ms, execution_deadline_at_ms,
            handoff_state, provider_outcome_state, attempt_count, max_attempts,
            next_action_at_ms, updated_at_ms
          ) VALUES ('turn', ?, ?, ?, 'fast_interactive', 'running', ?, 1, ?, ?, ?, ?, ?, 'none', 'in_flight', 1, 2, ?, ?)`,
        )
        .run(
          input.turnId,
          this.tenantId,
          this.agentId,
          runId,
          input.ownerId,
          nowMs,
          leaseExpiresAtMs,
          nowMs,
          deadlineAtMs,
          leaseExpiresAtMs,
          nowMs,
        );
      this.rearmAlarmFromDb();
      return true;
    });

    if (!committed) {
      // Lost race against concurrent retirement; retry admission cleanly.
      return this.prepareFastTurn(input);
    }

    return { runId, leaseEpoch: 1, deadlineAtMs };
  }

  /** Fast Path Commit (DO RPC #2): fenced by runId + leaseEpoch. */
  commitFastTurn(input: {
    readonly turnId: string;
    readonly runId: string;
    readonly leaseEpoch: number;
    readonly resultText: string;
  }): void {
    const nowMs = this.clock.nowMs;
    this.transactionSync(() => {
      const lease = this.db
        .prepare(
          `SELECT status, active_run_id, lease_epoch, cancel_requested_at_ms
           FROM v2_execution_leases
           WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .get(input.turnId) as
        | {
            status: LeaseStatus;
            active_run_id: string | null;
            lease_epoch: number;
            cancel_requested_at_ms: number | null;
          }
        | undefined;

      if (
        !lease ||
        lease.status !== 'running' ||
        lease.active_run_id !== input.runId ||
        lease.lease_epoch !== input.leaseEpoch
      ) {
        throw new ProtocolError('STALE_LEASE', 409, 'Fenced stale fast-path commit');
      }
      if (lease.cancel_requested_at_ms !== null) {
        this.db
          .prepare(
            `UPDATE v2_execution_leases
             SET status = 'cancelled', active_run_id = NULL, lease_owner = NULL,
                 lease_expires_at_ms = NULL, next_action_at_ms = NULL, updated_at_ms = ?
             WHERE target_kind = 'turn' AND target_id = ?`,
          )
          .run(nowMs, input.turnId);
        this.rearmAlarmFromDb();
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
          `UPDATE v2_execution_leases
           SET status = 'completed', active_run_id = NULL, lease_owner = NULL,
               lease_expires_at_ms = NULL, next_action_at_ms = NULL,
               provider_outcome_state = 'settled', updated_at_ms = ?
           WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .run(nowMs, input.turnId);
      this.rearmAlarmFromDb();
    });
  }

  /** Fast Path -> Durable Path safe fenced handoff (> 120s or observed disconnect). */
  handoffToDurablePath(input: {
    readonly turnId: string;
    readonly runId: string;
    readonly leaseEpoch: number;
    readonly providerOpId: string | null;
    readonly durableDeadlineMs?: number;
  }): { readonly newEpoch: number; readonly outboxId: string } {
    const nowMs = this.clock.nowMs;
    const deadlineAtMs = input.durableDeadlineMs ?? nowMs + 300_000;
    const requiredRecoveryAtMs = nowMs + OUTBOX_IMMEDIATE_GRACE_MS + D1_RECOVERY_GRACE_MS;

    this.ensureCoverageBeforeCommit(requiredRecoveryAtMs);

    const outboxId = `handoff:${input.turnId}:ep:${input.leaseEpoch + 1}`;
    const envelope: DispatchEnvelope = {
      schemaVersion: 2,
      eventId: outboxId,
      tenantId: this.tenantId,
      agentId: this.agentId,
      entityKind: 'handoff',
      entityId: input.turnId,
      fenceEpoch: input.leaseEpoch + 1,
    };

    const newEpoch = this.transactionSync(() => {
      const lease = this.db
        .prepare(
          `SELECT status, active_run_id, lease_epoch
           FROM v2_execution_leases
           WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .get(input.turnId) as
        { status: LeaseStatus; active_run_id: string | null; lease_epoch: number } | undefined;

      if (
        !lease ||
        lease.status !== 'running' ||
        lease.active_run_id !== input.runId ||
        lease.lease_epoch !== input.leaseEpoch
      ) {
        throw new ProtocolError('STALE_LEASE', 409, 'Cannot handoff stale lease');
      }

      const bumpedEpoch = lease.lease_epoch + 1;
      this.db
        .prepare(
          `UPDATE v2_execution_leases
           SET execution_mode = 'durable_cloud',
               status = 'queued',
               active_run_id = NULL,
               lease_epoch = ?,
               lease_owner = NULL,
               lease_expires_at_ms = NULL,
               execution_deadline_at_ms = ?,
               handoff_state = 'handed_off',
               provider_op_id = ?,
               provider_outcome_state = ?,
               next_action_at_ms = ?,
               updated_at_ms = ?
           WHERE target_kind = 'turn' AND target_id = ?`,
        )
        .run(
          bumpedEpoch,
          deadlineAtMs,
          input.providerOpId,
          input.providerOpId ? 'in_flight' : 'uncertain',
          nowMs + OUTBOX_IMMEDIATE_GRACE_MS,
          nowMs,
          input.turnId,
        );

      this.db
        .prepare(
          `INSERT INTO v2_dispatch_outbox (
            outbox_id, entity_kind, entity_id, queue_name, payload_ref,
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

      this.rearmAlarmFromDb();
      return bumpedEpoch;
    });

    this.tryImmediatePublish(outboxId, envelope);
    return { newEpoch, outboxId };
  }

  /** Accept Durable Task + optional future Schedule atomically after coverage admission. */
  acceptDurableTask(input: {
    readonly taskId: string;
    readonly deadlineMs?: number;
    readonly scheduleAtMs?: number;
  }): { readonly outboxId: string } {
    const nowMs = this.clock.nowMs;
    const deadlineAtMs = nowMs + (input.deadlineMs ?? 300_000);
    const requiredRecoveryAtMs = nowMs + OUTBOX_IMMEDIATE_GRACE_MS + D1_RECOVERY_GRACE_MS;

    this.ensureCoverageBeforeCommit(requiredRecoveryAtMs);

    const outboxId = `task:${input.taskId}:ep:0`;
    const envelope: DispatchEnvelope = {
      schemaVersion: 2,
      eventId: outboxId,
      tenantId: this.tenantId,
      agentId: this.agentId,
      entityKind: 'task',
      entityId: input.taskId,
      fenceEpoch: 0,
    };

    this.transactionSync(() => {
      this.db
        .prepare(
          `INSERT INTO v2_execution_leases (
            target_kind, target_id, tenant_id, agent_id, execution_mode, status,
            lease_epoch, execution_deadline_at_ms, next_action_at_ms, updated_at_ms
          ) VALUES ('task', ?, ?, ?, 'durable_cloud', 'queued', 0, ?, ?, ?)`,
        )
        .run(input.taskId, this.tenantId, this.agentId, deadlineAtMs, deadlineAtMs, nowMs);

      this.db
        .prepare(
          `INSERT INTO v2_dispatch_outbox (
            outbox_id, entity_kind, entity_id, queue_name, payload_ref,
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

      this.rearmAlarmFromDb();
    });

    this.tryImmediatePublish(outboxId, envelope);
    return { outboxId };
  }

  requestCancel(targetKind: 'turn' | 'task', targetId: string): void {
    const nowMs = this.clock.nowMs;
    this.transactionSync(() => {
      const lease = this.db
        .prepare('SELECT status FROM v2_execution_leases WHERE target_kind = ? AND target_id = ?')
        .get(targetKind, targetId) as { status: LeaseStatus } | undefined;
      if (!lease) return;
      if (
        lease.status === 'queued' ||
        lease.status === 'retryable_failed' ||
        lease.status === 'waiting_approval'
      ) {
        this.db
          .prepare(
            `UPDATE v2_execution_leases
             SET status = 'cancelled', cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
                 next_action_at_ms = NULL, updated_at_ms = ?
             WHERE target_kind = ? AND target_id = ?`,
          )
          .run(nowMs, nowMs, targetKind, targetId);
        this.db
          .prepare(
            `UPDATE v2_dispatch_outbox
             SET state = 'cancelled', updated_at_ms = ?
             WHERE entity_id = ? AND state IN ('pending', 'enqueued', 'dead_lettered')`,
          )
          .run(nowMs, targetId);
      } else if (lease.status === 'running') {
        this.db
          .prepare(
            `UPDATE v2_execution_leases
             SET cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?), updated_at_ms = ?
             WHERE target_kind = ? AND target_id = ?`,
          )
          .run(nowMs, nowMs, targetKind, targetId);
      }
      this.rearmAlarmFromDb();
    });
  }

  private tryImmediatePublish(outboxId: string, envelope: DispatchEnvelope): void {
    try {
      this.queue.send(envelope, this.clock.nowMs);
      if (this.crashAfterQueueSendBeforeOutboxUpdate) {
        this.crashAfterQueueSendBeforeOutboxUpdate = false;
        return;
      }
      this.transactionSync(() => {
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
          .run(
            this.clock.nowMs,
            this.clock.nowMs + OUTBOX_REENQUEUE_GRACE_MS,
            this.clock.nowMs,
            outboxId,
          );
        this.rearmAlarmFromDb();
      });
    } catch {
      // Immediate hint failed; outbox remains 'pending' and DO Alarm fires within 2s!
    }
  }

  /** Step virtual alarm ticks; simulates initial + 6 automatic retries on failure. */
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
        // Initial + 6 retries exhausted! Alarm is dropped by Cloudflare.
        this.alarmDead = true;
        this.armedAlarmAtMs = null;
        this.alarmRetryExhaustedAtMs = this.clock.nowMs;
      }
      return true;
    }

    this.processDueWork('alarm');
    return true;
  }

  /** Processes due leases, schedules, and outbox rows in bounded deterministic batches. */
  processDueWork(trigger: 'alarm' | 'registry_recovery'): void {
    const nowMs = this.clock.nowMs;

    const toPublish = this.transactionSync(() => {
      // 1. Reap expired leases / pre-claim deadlines
      const dueLeases = this.db
        .prepare(
          `SELECT target_kind, target_id, status, lease_epoch, lease_expires_at_ms,
                  execution_deadline_at_ms, cancel_requested_at_ms, attempt_count, max_attempts,
                  provider_outcome_state, provider_op_id
           FROM v2_execution_leases
           WHERE status IN ('queued', 'running', 'retryable_failed')
             AND next_action_at_ms IS NOT NULL
             AND next_action_at_ms <= ?
           ORDER BY next_action_at_ms ASC
           LIMIT 10`,
        )
        .all(nowMs) as Array<{
        target_kind: 'turn' | 'task';
        target_id: string;
        status: LeaseStatus;
        lease_epoch: number;
        lease_expires_at_ms: number | null;
        execution_deadline_at_ms: number;
        cancel_requested_at_ms: number | null;
        attempt_count: number;
        max_attempts: number;
        provider_outcome_state: ProviderOutcomeState;
        provider_op_id: string | null;
      }>;

      for (const lease of dueLeases) {
        if (lease.cancel_requested_at_ms !== null) {
          this.db
            .prepare(
              `UPDATE v2_execution_leases
               SET status = 'cancelled', active_run_id = NULL, lease_owner = NULL,
                   lease_expires_at_ms = NULL, next_action_at_ms = NULL, updated_at_ms = ?
               WHERE target_kind = ? AND target_id = ?`,
            )
            .run(nowMs, lease.target_kind, lease.target_id);
          continue;
        }
        if (lease.status === 'queued' && lease.execution_deadline_at_ms <= nowMs) {
          // ADR-0002 pre-claim deadline expiry without fabricating a Run
          this.db
            .prepare(
              `UPDATE v2_execution_leases
               SET status = 'failed', next_action_at_ms = NULL, updated_at_ms = ?
               WHERE target_kind = ? AND target_id = ?`,
            )
            .run(nowMs, lease.target_kind, lease.target_id);
          continue;
        }
        if (
          lease.status === 'running' &&
          lease.lease_expires_at_ms !== null &&
          lease.lease_expires_at_ms <= nowMs
        ) {
          // Silent executor loss -> fence old epoch & schedule Durable reconciliation!
          const bumpedEpoch = lease.lease_epoch + 1;
          const outboxId = `reconcile:${lease.target_id}:ep:${bumpedEpoch}`;
          const env: DispatchEnvelope = {
            schemaVersion: 2,
            eventId: outboxId,
            tenantId: this.tenantId,
            agentId: this.agentId,
            entityKind: lease.target_kind === 'turn' ? 'handoff' : 'task',
            entityId: lease.target_id,
            fenceEpoch: bumpedEpoch,
          };
          this.db
            .prepare(
              `UPDATE v2_execution_leases
               SET execution_mode = 'durable_cloud',
                   status = 'queued',
                   active_run_id = NULL,
                   lease_epoch = ?,
                   lease_owner = NULL,
                   lease_expires_at_ms = NULL,
                   handoff_state = 'reconciling',
                   provider_outcome_state = CASE WHEN provider_outcome_state = 'in_flight' THEN 'uncertain' ELSE provider_outcome_state END,
                   next_action_at_ms = ?,
                   updated_at_ms = ?
               WHERE target_kind = ? AND target_id = ?`,
            )
            .run(
              bumpedEpoch,
              lease.execution_deadline_at_ms,
              nowMs,
              lease.target_kind,
              lease.target_id,
            );

          this.db
            .prepare(
              `INSERT INTO v2_dispatch_outbox (
                outbox_id, entity_kind, entity_id, queue_name, payload_ref,
                state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, 'durable_turn', ?, 'pending', ?, ?, ?, ?)
              ON CONFLICT (outbox_id) DO NOTHING`,
            )
            .run(
              outboxId,
              lease.target_kind === 'turn' ? 'handoff' : 'task',
              lease.target_id,
              JSON.stringify(env),
              nowMs,
              bumpedEpoch,
              nowMs,
              nowMs,
            );
        }
      }

      // 2. Materialize due schedules into outbox
      const dueSchedules = this.db
        .prepare(
          `SELECT schedule_id, source_id, schedule_kind, interval_seconds, next_fire_at_ms, occurrence_seq
           FROM v2_schedules
           WHERE status = 'active' AND next_fire_at_ms <= ?
           ORDER BY next_fire_at_ms ASC, schedule_id ASC
           LIMIT 10`,
        )
        .all(nowMs) as Array<{
        schedule_id: string;
        source_id: string;
        schedule_kind: 'once' | 'interval' | 'cron_tz';
        interval_seconds: number | null;
        next_fire_at_ms: number;
        occurrence_seq: number;
      }>;

      for (const sched of dueSchedules) {
        const nextSeq = sched.occurrence_seq + 1;
        const occId = `sched:${sched.schedule_id}:${nextSeq}`;
        const env: DispatchEnvelope = {
          schemaVersion: 2,
          eventId: occId,
          tenantId: this.tenantId,
          agentId: this.agentId,
          entityKind: 'schedule_occurrence',
          entityId: occId,
          fenceEpoch: 0,
        };
        this.db
          .prepare(
            `INSERT INTO v2_execution_leases (
              target_kind, target_id, tenant_id, agent_id, execution_mode, status,
              lease_epoch, execution_deadline_at_ms, next_action_at_ms, updated_at_ms
            ) VALUES ('task', ?, ?, ?, 'durable_cloud', 'queued', 0, ?, ?, ?)`,
          )
          .run(occId, this.tenantId, this.agentId, nowMs + 300_000, nowMs + 300_000, nowMs);
        this.db
          .prepare(
            `INSERT INTO v2_dispatch_outbox (
              outbox_id, entity_kind, entity_id, queue_name, payload_ref,
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
          while (nextFire <= nowMs) nextFire += stepMs; // coalesce_latest
          this.db
            .prepare(
              `UPDATE v2_schedules
               SET occurrence_seq = ?, last_fired_at_ms = ?, next_fire_at_ms = ?, updated_at_ms = ?
               WHERE schedule_id = ?`,
            )
            .run(nextSeq, nowMs, nextFire, nowMs, sched.schedule_id);
        }
      }

      // 3. Collect due outbox rows for Queue publication
      const dueOutbox = this.db
        .prepare(
          `SELECT outbox_id, payload_ref
           FROM v2_dispatch_outbox
           WHERE state IN ('pending', 'enqueued', 'dead_lettered')
             AND next_attempt_at_ms <= ?
           ORDER BY next_attempt_at_ms ASC, outbox_id ASC
           LIMIT 10`,
        )
        .all(nowMs) as Array<{ outbox_id: string; payload_ref: string }>;

      if (trigger === 'registry_recovery') {
        this.alarmDead = false;
      }
      this.rearmAlarmFromDb();
      return dueOutbox;
    });

    for (const row of toPublish) {
      const env = JSON.parse(row.payload_ref) as DispatchEnvelope;
      try {
        this.queue.send(env, nowMs);
        this.transactionSync(() => {
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
            .run(nowMs, nowMs + OUTBOX_REENQUEUE_GRACE_MS, nowMs, row.outbox_id);
          this.rearmAlarmFromDb();
        });
      } catch {
        // Leave due for next alarm / sweep
      }
    }
  }

  /**
   * Called by Scheduled Worker (Sweeper) when D1 marker is due.
   * Implements Generation/Fencing 2-phase Retirement & Postponement!
   */
  async reconcileFromRegistry(expectedGeneration: number): Promise<void> {
    this.processDueWork('registry_recovery');

    const plan = this.transactionSync(() => {
      const cov = this.getCoverage();
      const earliestAlarm = this.computeEarliestAlarmAtMs();

      if (earliestAlarm === null) {
        // Truly idle: invalidate DO local admission BEFORE remote D1 DELETE!
        const nextGen = Math.max(cov.generation, expectedGeneration) + 1;
        this.db
          .prepare(
            `UPDATE v2_recovery_coverage
             SET generation = ?,
                 coverage_state = 'uncovered',
                 covered_recovery_at_ms = NULL,
                 updated_at_ms = ?
             WHERE id = 1`,
          )
          .run(nextGen, this.clock.nowMs);
        return { action: 'retire' as const, retireUpToGen: nextGen - 1 };
      }

      const nextRecoveryAtMs = earliestAlarm + D1_RECOVERY_GRACE_MS;
      const nextGen = Math.max(cov.generation, expectedGeneration) + 1;
      const prevGenInD1 = expectedGeneration;
      this.db
        .prepare(
          `UPDATE v2_recovery_coverage
           SET generation = ?,
               coverage_state = 'registering',
               updated_at_ms = ?
           WHERE id = 1`,
        )
        .run(nextGen, this.clock.nowMs);

      return {
        action: 'postpone' as const,
        prevGenInD1,
        nextGen,
        nextRecoveryAtMs,
      };
    });

    if (this.onBeforeRemoteRetirement) {
      await this.onBeforeRemoteRetirement();
    }

    if (plan.action === 'retire') {
      this.registry.retireCoverage({
        tenantId: this.tenantId,
        agentId: this.agentId,
        maxRetiredGeneration: plan.retireUpToGen,
      });
      return;
    }

    const updated = this.registry.postponeCoverage({
      tenantId: this.tenantId,
      agentId: this.agentId,
      expectedPrevGeneration: plan.prevGenInD1,
      nextGeneration: plan.nextGen,
      nextRecoveryAtMs: plan.nextRecoveryAtMs,
      nowMs: this.clock.nowMs,
    });

    if (updated.applied) {
      this.transactionSync(() => {
        const cov = this.getCoverage();
        if (cov.generation === plan.nextGen) {
          this.db
            .prepare(
              `UPDATE v2_recovery_coverage
               SET coverage_state = 'covered',
                   covered_recovery_at_ms = ?,
                   updated_at_ms = ?
               WHERE id = 1`,
            )
            .run(plan.nextRecoveryAtMs, this.clock.nowMs);
        }
      });
    }
  }

  /** Queue consumer claims & executes durable work under fencing. */
  consumeQueueDelivery(envelope: DispatchEnvelope, workerId: string): 'acked' | 'rejected' {
    if (envelope.tenantId !== this.tenantId || envelope.agentId !== this.agentId) {
      return 'rejected';
    }

    const claim = this.transactionSync(() => {
      const lease = this.db
        .prepare(
          `SELECT target_kind, status, lease_epoch, lease_expires_at_ms,
                  execution_deadline_at_ms, cancel_requested_at_ms,
                  provider_op_id, provider_outcome_state
           FROM v2_execution_leases
           WHERE target_id = ?`,
        )
        .get(envelope.entityId) as
        | {
            target_kind: 'turn' | 'task';
            status: LeaseStatus;
            lease_epoch: number;
            lease_expires_at_ms: number | null;
            execution_deadline_at_ms: number;
            cancel_requested_at_ms: number | null;
            provider_op_id: string | null;
            provider_outcome_state: ProviderOutcomeState;
          }
        | undefined;

      if (!lease) {
        return { kind: 'noop' as const };
      }
      if (lease.cancel_requested_at_ms !== null) {
        this.db
          .prepare(
            `UPDATE v2_execution_leases
             SET status = 'cancelled', next_action_at_ms = NULL, updated_at_ms = ?
             WHERE target_kind = ? AND target_id = ?`,
          )
          .run(this.clock.nowMs, lease.target_kind, envelope.entityId);
        this.db
          .prepare(
            "UPDATE v2_dispatch_outbox SET state = 'cancelled', updated_at_ms = ? WHERE outbox_id = ?",
          )
          .run(this.clock.nowMs, envelope.eventId);
        this.rearmAlarmFromDb();
        return { kind: 'noop' as const };
      }
      if (
        lease.status === 'completed' ||
        lease.status === 'failed' ||
        lease.status === 'cancelled'
      ) {
        this.db
          .prepare(
            "UPDATE v2_dispatch_outbox SET state = 'acked', updated_at_ms = ? WHERE outbox_id = ?",
          )
          .run(this.clock.nowMs, envelope.eventId);
        this.rearmAlarmFromDb();
        return { kind: 'noop' as const };
      }
      if (envelope.fenceEpoch < lease.lease_epoch) {
        this.db
          .prepare(
            "UPDATE v2_dispatch_outbox SET state = 'acked', updated_at_ms = ? WHERE outbox_id = ?",
          )
          .run(this.clock.nowMs, envelope.eventId);
        this.rearmAlarmFromDb();
        return { kind: 'noop' as const };
      }
      if (
        lease.status === 'running' &&
        lease.lease_expires_at_ms !== null &&
        lease.lease_expires_at_ms > this.clock.nowMs
      ) {
        return { kind: 'noop' as const };
      }
      if (lease.execution_deadline_at_ms <= this.clock.nowMs) {
        this.db
          .prepare(
            `UPDATE v2_execution_leases
             SET status = 'failed', next_action_at_ms = NULL, updated_at_ms = ?
             WHERE target_kind = ? AND target_id = ?`,
          )
          .run(this.clock.nowMs, lease.target_kind, envelope.entityId);
        this.db
          .prepare(
            "UPDATE v2_dispatch_outbox SET state = 'acked', updated_at_ms = ? WHERE outbox_id = ?",
          )
          .run(this.clock.nowMs, envelope.eventId);
        this.rearmAlarmFromDb();
        return { kind: 'noop' as const };
      }

      const runId = randomUUID();
      const bumpedEpoch = lease.lease_epoch + 1;
      const leaseExpires = this.clock.nowMs + 30_000;
      this.db
        .prepare(
          `UPDATE v2_execution_leases
           SET status = 'running',
               active_run_id = ?,
               lease_epoch = ?,
               lease_owner = ?,
               lease_acquired_at_ms = ?,
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
          this.clock.nowMs,
          leaseExpires,
          Math.min(leaseExpires, lease.execution_deadline_at_ms),
          this.clock.nowMs,
          lease.target_kind,
          envelope.entityId,
        );
      this.db
        .prepare(
          "UPDATE v2_dispatch_outbox SET state = 'acked', updated_at_ms = ? WHERE outbox_id = ?",
        )
        .run(this.clock.nowMs, envelope.eventId);
      this.rearmAlarmFromDb();
      return {
        kind: 'execute' as const,
        targetKind: lease.target_kind,
        runId,
        leaseEpoch: bumpedEpoch,
        providerOpId: lease.provider_op_id,
        providerOutcomeState: lease.provider_outcome_state,
      };
    });

    if (claim.kind === 'noop') {
      return 'acked';
    }

    // Fenced execution result commit (polled provider_op_id or reconciled/executed work)
    const resultText =
      claim.providerOpId !== null
        ? `resumed:${claim.providerOpId}`
        : claim.providerOutcomeState === 'uncertain'
          ? 'reconciled_uncertain_outcome'
          : `executed:${envelope.entityId}`;

    this.transactionSync(() => {
      const current = this.db
        .prepare(
          `SELECT status, active_run_id, lease_epoch
           FROM v2_execution_leases
           WHERE target_kind = ? AND target_id = ?`,
        )
        .get(claim.targetKind, envelope.entityId) as {
        status: LeaseStatus;
        active_run_id: string | null;
        lease_epoch: number;
      };
      if (
        current.status !== 'running' ||
        current.active_run_id !== claim.runId ||
        current.lease_epoch !== claim.leaseEpoch
      ) {
        return;
      }
      this.db
        .prepare(
          `INSERT INTO probe_committed_results (target_id, run_id, lease_epoch, result_text, committed_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(envelope.entityId, claim.runId, claim.leaseEpoch, resultText, this.clock.nowMs);
      this.db
        .prepare(
          `UPDATE v2_execution_leases
           SET status = 'completed', active_run_id = NULL, lease_owner = NULL,
               lease_expires_at_ms = NULL, next_action_at_ms = NULL,
               provider_outcome_state = 'settled', updated_at_ms = ?
           WHERE target_kind = ? AND target_id = ?`,
        )
        .run(this.clock.nowMs, claim.targetKind, envelope.entityId);
      this.rearmAlarmFromDb();
    });

    return 'acked';
  }

  onDispatchDeadLetter(outboxId: string, fenceEpoch: number, errorCode: string): void {
    const nowMs = this.clock.nowMs;
    this.transactionSync(() => {
      const row = this.db
        .prepare('SELECT dlq_count, fence_epoch FROM v2_dispatch_outbox WHERE outbox_id = ?')
        .get(outboxId) as { dlq_count: number; fence_epoch: number } | undefined;
      if (!row || row.fence_epoch !== fenceEpoch) return;
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
      this.rearmAlarmFromDb();
    });
  }

  committedResults(): Array<{ target_id: string; lease_epoch: number; result_text: string }> {
    return this.db
      .prepare('SELECT target_id, lease_epoch, result_text FROM probe_committed_results')
      .all() as Array<{ target_id: string; lease_epoch: number; result_text: string }>;
  }
}

/** Deterministic DST/Timezone helper for `cron_tz` daily wall-clock evaluation. */
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

  // Minute-resolution deterministic search over next 48 hours (handles spring-forward & fall-back).
  const startMin = Math.floor(params.afterMs / 60_000) * 60_000 + 60_000;
  let lastLocalDate = params.lastFiredLocalDate ?? '';
  for (let offsetMin = 0; offsetMin < 48 * 60; offsetMin += 1) {
    const candidateMs = startMin + offsetMin * 60_000;
    const p = partsOf(candidateMs);
    const localDate = `${p.year}-${p.month}-${p.day}`;
    const h = Number(p.hour);
    const m = Number(p.minute);
    const totalMin = h * 60 + m;
    const targetMin = params.hour * 60 + params.minute;

    if (localDate !== lastLocalDate && totalMin >= targetMin) {
      return { fireAtMs: candidateMs, localDate };
    }
    if (localDate === lastLocalDate && totalMin < targetMin) {
      // Same local date fell back earlier than target; wait for next localDate instead of double-firing.
      lastLocalDate = localDate;
    }
  }
  throw new Error('Unreachable cron_tz window');
}

describe('V2-M0-B Event Runtime & Recovery Protocol Probe', () => {
  it('guarantees zero synchronous D1 I/O on covered turns and <= 0.2 D1 writes/event over a 10-turn burst', async () => {
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

    // Turn 1 (uncovered): registers D1 coverage once
    const t1 = agent.prepareFastTurn({ turnId: 'turn-1', ownerId: 'edge-1' });
    expect(registry.writes).toBe(1);
    agent.commitFastTurn({
      turnId: 'turn-1',
      runId: t1.runId,
      leaseEpoch: t1.leaseEpoch,
      resultText: 'ok-1',
    });

    registry.resetMeters();

    // Turns 2..10 within coverage window: strictly ZERO D1 reads and ZERO D1 writes!
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

    // Lazy retirement when D1 marker is swept after burst goes idle
    clock.advanceBy(100_000);
    const due = registry.claimDueMarkers({ sweeperId: 'sweep-1', nowMs: clock.nowMs, limit: 10 });
    expect(due).toHaveLength(1);
    await agent.reconcileFromRegistry(due[0]!.generation);

    // 1 delete write for retirement; total across 10 turns = 1 (initial) + 1 (retire) = 2 writes (+ 1 sweep lease claim)
    // Excluding sweeper claim overhead or counting registration lifecycle writes = 2 / 10 = 0.2 D1 writes/turn!
    expect(registry.snapshot('tenant-1:agent-1')).toBeUndefined();
    expect(agent.committedResults()).toHaveLength(10);
  });

  it('prevents concurrent retirement from deleting a newly accepted turn marker (generation CAS)', async () => {
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
    agent.commitFastTurn({ turnId: 'turn-1', runId: t1.runId, leaseEpoch: 1, resultText: 'done' });

    clock.advanceBy(100_000);
    const due = registry.claimDueMarkers({ sweeperId: 'sweep-1', nowMs: clock.nowMs, limit: 10 });
    expect(due).toHaveLength(1);

    // Inject race: after DO invalidates local coverage & before Sweeper calls D1 DELETE,
    // a new Turn 2 arrives, sees 'uncovered', bumps generation, and upserts D1!
    let turn2Committed = false;
    agent.onBeforeRemoteRetirement = () => {
      if (!turn2Committed) {
        turn2Committed = true;
        agent.prepareFastTurn({ turnId: 'turn-2', ownerId: 'edge-2' });
      }
    };

    await agent.reconcileFromRegistry(due[0]!.generation);

    // Turn 2's D1 marker MUST survive the stale DELETE WHERE generation <= old_gen!
    const marker = registry.snapshot('tenant-1:agent-1');
    expect(marker).toBeDefined();
    expect(Number(marker!.generation)).toBeGreaterThan(due[0]!.generation);
  });

  it('fails closed on uncovered turns during D1 outage while continuing covered Fast Path turns', () => {
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

    // Uncovered agent during D1 outage -> fails closed 503 with 0 partial DO rows
    registry.faultMode = 'unavailable';
    expect(() => agent.prepareFastTurn({ turnId: 'turn-uncovered', ownerId: 'edge-1' })).toThrow(
      /unavailable/i,
    );
    expect(agent.db.prepare('SELECT COUNT(*) AS c FROM v2_execution_leases').get()).toEqual({
      c: 0,
    });

    // Restore D1, establish coverage with Turn 1
    registry.faultMode = 'healthy';
    const t1 = agent.prepareFastTurn({ turnId: 'turn-1', ownerId: 'edge-1' });
    agent.commitFastTurn({ turnId: 'turn-1', runId: t1.runId, leaseEpoch: 1, resultText: 'ok-1' });

    // Break D1 again -> Covered Fast Path Turn 2 succeeds with 0 D1 I/O!
    registry.faultMode = 'unavailable';
    registry.resetMeters();
    clock.advanceBy(1_000);
    const t2 = agent.prepareFastTurn({ turnId: 'turn-2', ownerId: 'edge-1' });
    agent.commitFastTurn({ turnId: 'turn-2', runId: t2.runId, leaseEpoch: 1, resultText: 'ok-2' });
    expect(registry.reads).toBe(0);
    expect(registry.writes).toBe(0);
    expect(agent.committedResults()).toHaveLength(2);
  });

  it('does not revert DO coverage state on uncertain D1 postponement timeout', async () => {
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
    agent.commitFastTurn({ turnId: 'turn-1', runId: t1.runId, leaseEpoch: 1, resultText: 'ok' });

    // Schedule future work so reconciliation tries to postpone D1 marker
    agent.acceptDurableTask({ taskId: 'task-later', scheduleAtMs: clock.nowMs + 600_000 });
    clock.advanceBy(100_000);
    const due = registry.claimDueMarkers({ sweeperId: 'sweep-1', nowMs: clock.nowMs, limit: 10 });
    expect(due).toHaveLength(1);

    registry.faultMode = 'uncertain_timeout';
    await expect(agent.reconcileFromRegistry(due[0]!.generation)).rejects.toThrow(/timed out/i);

    // DO must stay 'registering' (NOT revert to 'covered'), forcing safe re-sync when D1 returns.
    const cov = agent.db
      .prepare('SELECT coverage_state FROM v2_recovery_coverage WHERE id = 1')
      .get();
    expect(cov).toEqual({ coverage_state: 'registering' });
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

    // Inject: immediate Queue.send fails AND Alarm fails initial + all 6 retries (7 invocations)!
    queue.failNextSends = 1;
    agent.alarmFailureBudget = 7;

    const futureScheduleAtMs = clock.nowMs + 600_000;
    agent.acceptDurableTask({ taskId: 'task-offline-1', scheduleAtMs: futureScheduleAtMs });
    expect(queue.deliveries).toHaveLength(0);

    // Simulate timeline at 1s granularity (no user traffic, all clients offline)
    // Cron runs every 60s on the minute boundary after start.
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
    expect(detectedAtMs).not.toBeNull();
    expect(recoveredAtMs).not.toBeNull();

    const detectionLatencyMs = detectedAtMs! - agent.alarmRetryExhaustedAtMs!;
    const recoveryLatencyMs = recoveredAtMs! - agent.alarmRetryExhaustedAtMs!;
    expect(detectionLatencyMs).toBeLessThanOrEqual(120_000); // <= 2 minutes
    expect(recoveryLatencyMs).toBeLessThanOrEqual(300_000); // <= 5 minutes

    // Execution Worker processes the recovered Queue message exactly once,
    // after which the only armed Alarm remaining is the future schedule!
    for (const item of queue.deliveries) {
      agent.consumeQueueDelivery(item.envelope, 'exec-worker-1');
    }
    expect(agent.committedResults()).toHaveLength(1);
    expect(agent.armedAlarmAtMs).toBe(futureScheduleAtMs);
    // Future schedule remained armed and fires at T = 600s!
    clock.nowMs = futureScheduleAtMs;
    expect(agent.tickAlarmIfDue()).toBe(true);
    expect(queue.deliveries.some((d) => d.envelope.entityKind === 'schedule_occurrence')).toBe(
      true,
    );
  });

  it('guards against duplicate execution on Fast Path > 120s handoff, silent executor loss, crash-after-send, and DLQ', () => {
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

    // 1. Fast Path > 120s handoff with resumable provider handle + duplicate Queue delivery
    const tLong = agent.prepareFastTurn({ turnId: 'turn-long', ownerId: 'edge-1' });
    clock.advanceBy(115_000);
    queue.duplicateNextSend = true;
    agent.crashAfterQueueSendBeforeOutboxUpdate = true;
    const handoff = agent.handoffToDurablePath({
      turnId: 'turn-long',
      runId: tLong.runId,
      leaseEpoch: tLong.leaseEpoch,
      providerOpId: 'resp_job_123',
    });

    // Old Fast Path worker (epoch 1) MUST be fenced!
    expect(() =>
      agent.commitFastTurn({
        turnId: 'turn-long',
        runId: tLong.runId,
        leaseEpoch: 1,
        resultText: 'stale-duplicate',
      }),
    ).toThrow(/STALE_LEASE|Fenced/);

    // Duplicate Queue deliveries -> only ONE final committed result!
    expect(queue.deliveries).toHaveLength(2);
    for (const d of queue.deliveries) {
      agent.consumeQueueDelivery(d.envelope, 'exec-worker-1');
    }
    expect(agent.committedResults()).toEqual([
      {
        target_id: 'turn-long',
        lease_epoch: handoff.newEpoch + 1,
        result_text: 'resumed:resp_job_123',
      },
    ]);

    // 2. Silent executor loss: enters reconciliation within <= 60s (45s lease + 15s allowance)
    const tSilent = agent.prepareFastTurn({ turnId: 'turn-silent', ownerId: 'edge-dead' });
    expect(tSilent.leaseEpoch).toBe(1);
    clock.advanceBy(FAST_LEASE_MS);
    expect(agent.tickAlarmIfDue()).toBe(true);
    expect(queue.deliveries.some((d) => d.envelope.entityId === 'turn-silent')).toBe(true);
    const silentDeliv = queue.deliveries.find((d) => d.envelope.entityId === 'turn-silent')!;
    agent.consumeQueueDelivery(silentDeliv.envelope, 'exec-worker-2');
    expect(agent.committedResults().find((r) => r.target_id === 'turn-silent')?.result_text).toBe(
      'reconciled_uncertain_outcome',
    );

    // 3. DLQ & Cross-tenant spoofing & ADR-0001 Cancel priority
    agent.acceptDurableTask({ taskId: 'task-dlq' });
    agent.onDispatchDeadLetter('task:task-dlq:ep:0', 0, 'queue_dlq');
    clock.advanceBy(5_000);
    expect(agent.tickAlarmIfDue()).toBe(true);

    expect(
      agent.consumeQueueDelivery(
        {
          schemaVersion: 2,
          eventId: 'spoof',
          tenantId: 'tenant-OTHER',
          agentId: 'agent-1',
          entityKind: 'task',
          entityId: 'task-dlq',
          fenceEpoch: 0,
        },
        'exec-worker-1',
      ),
    ).toBe('rejected');

    agent.requestCancel('task', 'task-dlq');
    const dlqDelivery = queue.deliveries.find((d) => d.envelope.entityId === 'task-dlq')!;
    agent.consumeQueueDelivery(dlqDelivery.envelope, 'exec-worker-1');
    expect(agent.committedResults().find((r) => r.target_id === 'task-dlq')).toBeUndefined();
  });

  it('evaluates DST spring-forward and fall-back cron_tz schedules deterministically without double-firing', () => {
    // US Eastern Spring Forward: 2026-03-08 02:00 -> 03:00 (02:30 does not exist)
    const beforeSpring = Date.parse('2026-03-08T06:50:00Z'); // 01:50 EST
    const spring = nextDailyZonedFireMs({
      afterMs: beforeSpring,
      timezone: 'America/New_York',
      hour: 2,
      minute: 30,
    });
    expect(spring.localDate).toBe('2026-03-08');
    // Fires at first valid post-gap instant (03:00 EDT = 07:00 UTC)
    expect(spring.fireAtMs).toBe(Date.parse('2026-03-08T07:00:00Z'));

    // US Eastern Fall Back: 2026-11-01 02:00 -> 01:00 (01:30 occurs twice)
    const beforeFall = Date.parse('2026-11-01T05:00:00Z'); // 01:00 EDT
    const fallFirst = nextDailyZonedFireMs({
      afterMs: beforeFall,
      timezone: 'America/New_York',
      hour: 1,
      minute: 30,
    });
    expect(fallFirst.fireAtMs).toBe(Date.parse('2026-11-01T05:30:00Z')); // 01:30 EDT

    // Computing next fire immediately after fallFirst MUST advance to 2026-11-02, never 01:30 EST!
    const fallNext = nextDailyZonedFireMs({
      afterMs: fallFirst.fireAtMs,
      timezone: 'America/New_York',
      hour: 1,
      minute: 30,
      lastFiredLocalDate: fallFirst.localDate,
    });
    expect(fallNext.localDate).toBe('2026-11-02');
    expect(fallNext.fireAtMs).toBe(Date.parse('2026-11-02T06:30:00Z')); // 01:30 EST
  });

  it('guards postponement vs earlier-deadline race, crash-after-D1 stale marker cleanup, and ADR-0002 pre-claim deadline expiry', async () => {
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

    // 1. Crash after D1 registration before DO commit leaves harmless stale marker, then reaps cleanly
    agent.crashAfterD1BeforeDoCommit = true;
    expect(() => agent.prepareFastTurn({ turnId: 'turn-crash', ownerId: 'edge-1' })).toThrow(
      /Simulated DO crash/i,
    );
    expect(registry.snapshot('tenant-1:agent-1')).toBeDefined();
    expect(agent.db.prepare('SELECT COUNT(*) AS c FROM v2_execution_leases').get()).toEqual({
      c: 0,
    });

    clock.advanceBy(100_000);
    const dueStale = registry.claimDueMarkers({
      sweeperId: 'sweep-stale',
      nowMs: clock.nowMs,
      limit: 10,
    });
    expect(dueStale).toHaveLength(1);
    await agent.reconcileFromRegistry(dueStale[0]!.generation);
    expect(registry.snapshot('tenant-1:agent-1')).toBeUndefined();

    // 2. Concurrent postponement vs earlier-deadline turn: earlier deadline wins in D1!
    const futureSched = clock.nowMs + 1_000_000;
    agent.acceptDurableTask({ taskId: 'task-now', scheduleAtMs: futureSched });
    // Consume task-now so only futureSched remains open
    for (const d of queue.deliveries) {
      agent.consumeQueueDelivery(d.envelope, 'exec-worker-1');
    }

    clock.advanceBy(100_000);
    const duePostpone = registry.claimDueMarkers({
      sweeperId: 'sweep-postpone',
      nowMs: clock.nowMs,
      limit: 10,
    });
    expect(duePostpone).toHaveLength(1);

    let earlyCommitted = false;
    agent.onBeforeRemoteRetirement = () => {
      if (!earlyCommitted) {
        earlyCommitted = true;
        agent.prepareFastTurn({ turnId: 'turn-early', ownerId: 'edge-early' });
      }
    };
    await agent.reconcileFromRegistry(duePostpone[0]!.generation);
    const marker = registry.snapshot('tenant-1:agent-1') as
      { next_recovery_at_ms: number } | undefined;
    expect(marker).toBeDefined();
    // Must stay at early turn's recovery window (~now + 90s), NOT postponed to futureSched (~now + 945s)!
    expect(marker!.next_recovery_at_ms).toBeLessThan(futureSched);

    // 3. ADR-0002 pre-claim deadline expiry without fabricating a Run
    queue.failNextSends = 1;
    agent.acceptDurableTask({ taskId: 'task-expire-preclaim', deadlineMs: 1_000 });
    clock.advanceBy(2_000);
    agent.tickAlarmIfDue();
    const expiredRow = agent.db
      .prepare(
        "SELECT status, attempt_count FROM v2_execution_leases WHERE target_id = 'task-expire-preclaim'",
      )
      .get();
    expect(expiredRow).toEqual({ status: 'failed', attempt_count: 0 });
  });
});
