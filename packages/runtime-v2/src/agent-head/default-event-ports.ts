import type { Id } from '@ember/domain';
import { OutboxConstraintError, validateOutboxEnqueueCommand } from '../recovery/envelope.js';
import type { EventRuntimeCoordinatorPort, RecoveryAdmissionPort } from '../recovery/ports.js';
import type {
  OrdinaryOutboxEntityKind,
  OutboxEntityKind,
  V2DispatchOutboxRow,
  V2QueueName,
  V2RecoveryCoverageRow,
} from '../recovery/schema.js';
import type { DurableObjectStorageLike, SqlStorageLike } from '../storage.js';
import { sqlExecMaybe, sqlExecOne } from './queries.js';

export type PendingAlarmIntent =
  { readonly kind: 'set'; readonly atMs: number } | { readonly kind: 'delete' };

/**
 * Default synchronous SQLite implementation of `RecoveryAdmissionPort` & `EventRuntimeCoordinatorPort`
 * backed by Agent B's canonical DO tables (`v2_recovery_coverage`, `v2_dispatch_outbox`, `v2_schedules`).
 *
 * All SQLite operations run synchronously inside the caller's `storage.transactionSync()`;
 * the resulting platform alarm side effect is flushed via `flushPendingAlarmOp()` immediately
 * after `transactionSync()` returns.
 */
export class DefaultEventRuntimePorts
  implements RecoveryAdmissionPort, EventRuntimeCoordinatorPort
{
  private pendingAlarmIntent: PendingAlarmIntent | null = null;
  private alarmConsumedInCurrentCycle = false;

  constructor(
    private readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'setAlarm' | 'deleteAlarm'>,
    private readonly tenantId: Id,
    private readonly agentId: Id,
    private readonly earliestBusinessAlarmAtMsSync: (sql: SqlStorageLike) => number | null,
  ) {}

  ensureCoverageRowSync(nowMs: number): V2RecoveryCoverageRow {
    this.storage.sql.exec(
      `INSERT INTO v2_recovery_coverage (
         id, tenant_id, agent_id, generation, coverage_state, updated_at_ms
       ) VALUES (1, ?, ?, 0, 'uncovered', ?)
       ON CONFLICT (id) DO NOTHING`,
      this.tenantId,
      this.agentId,
      nowMs,
    );
    return this.getCoverageRowSync();
  }

  getCoverageRowSync(): V2RecoveryCoverageRow {
    return sqlExecOne<V2RecoveryCoverageRow>(
      this.storage.sql,
      `SELECT * FROM v2_recovery_coverage WHERE id = 1`,
    );
  }

  /**
   * Checks whether existing D1 coverage covers `requiredRecoveryAtMs` with 0 D1 writes;
   * otherwise atomically bumps `generation += 1` and records `'registering'` (`pending_kind = 'ensure'`).
   */
  inspectCoverageSync(
    requiredRecoveryAtMs: number,
    nowMs: number,
  ):
    | {
        readonly kind: 'covered';
        readonly generation: number;
        readonly coveredRecoveryAtMs: number;
      }
    | {
        readonly kind: 'register';
        readonly generation: number;
        readonly targetAtMs: number;
      } {
    const cov = this.ensureCoverageRowSync(nowMs);
    if (
      cov.coverage_state === 'covered' &&
      cov.covered_recovery_at_ms !== null &&
      cov.covered_recovery_at_ms <= requiredRecoveryAtMs
    ) {
      return {
        kind: 'covered',
        generation: cov.generation,
        coveredRecoveryAtMs: cov.covered_recovery_at_ms,
      };
    }

    const nextGen = cov.generation + 1;
    const targetAtMs =
      cov.coverage_state === 'registering' &&
      cov.pending_kind === 'ensure' &&
      cov.pending_target_at_ms !== null
        ? Math.min(cov.pending_target_at_ms, requiredRecoveryAtMs)
        : requiredRecoveryAtMs;

    this.storage.sql.exec(
      `UPDATE v2_recovery_coverage
          SET generation = ?,
              coverage_state = 'registering',
              covered_recovery_at_ms = NULL,
              pending_kind = 'ensure',
              pending_prev_generation = ?,
              pending_target_at_ms = ?,
              updated_at_ms = ?
        WHERE id = 1`,
      nextGen,
      cov.generation,
      targetAtMs,
      nowMs,
    );

    return {
      kind: 'register',
      generation: nextGen,
      targetAtMs,
    };
  }

  /**
   * Fast-forwards local coverage generation above both local `generation` and D1's observed
   * `d1Generation` during self-healing recovery (V2-M0-A §8.3 rule 4).
   */
  fastForwardEnsureSync(
    observedD1Generation: number,
    requiredRecoveryAtMs: number,
    nowMs: number,
  ): { readonly generation: number; readonly targetAtMs: number } {
    const cov = this.ensureCoverageRowSync(nowMs);
    const nextGen = Math.max(cov.generation, observedD1Generation) + 1;
    const targetAtMs =
      cov.pending_kind === 'ensure' && cov.pending_target_at_ms !== null
        ? Math.min(cov.pending_target_at_ms, requiredRecoveryAtMs)
        : requiredRecoveryAtMs;

    this.storage.sql.exec(
      `UPDATE v2_recovery_coverage
          SET generation = ?,
              coverage_state = 'registering',
              covered_recovery_at_ms = NULL,
              pending_kind = 'ensure',
              pending_prev_generation = ?,
              pending_target_at_ms = ?,
              updated_at_ms = ?
        WHERE id = 1`,
      nextGen,
      Math.max(cov.generation, observedD1Generation),
      targetAtMs,
      nowMs,
    );

    return { generation: nextGen, targetAtMs };
  }

  planPostponeSync(
    expectedPrevGen: number,
    nextRecoveryAtMs: number,
    nowMs: number,
  ): {
    readonly expectedPrevGen: number;
    readonly newGeneration: number;
    readonly nextRecoveryAtMs: number;
  } {
    const cov = this.ensureCoverageRowSync(nowMs);
    const baseGen = Math.max(cov.generation, expectedPrevGen);
    const newGeneration = baseGen + 1;

    this.storage.sql.exec(
      `UPDATE v2_recovery_coverage
          SET generation = ?,
              coverage_state = 'registering',
              covered_recovery_at_ms = NULL,
              pending_kind = 'postpone',
              pending_prev_generation = ?,
              pending_target_at_ms = ?,
              updated_at_ms = ?
        WHERE id = 1`,
      newGeneration,
      baseGen,
      nextRecoveryAtMs,
      nowMs,
    );

    return {
      expectedPrevGen: baseGen,
      newGeneration,
      nextRecoveryAtMs,
    };
  }

  planRetireSync(expectedPrevGen: number, nowMs: number): { readonly retireUpToGen: number } {
    const cov = this.ensureCoverageRowSync(nowMs);
    const nextGen = Math.max(cov.generation, expectedPrevGen) + 1;
    const retireUpToGen = nextGen - 1;

    this.storage.sql.exec(
      `UPDATE v2_recovery_coverage
          SET generation = ?,
              coverage_state = 'uncovered',
              covered_recovery_at_ms = NULL,
              pending_kind = NULL,
              pending_prev_generation = NULL,
              pending_target_at_ms = NULL,
              last_d1_sync_at_ms = ?,
              updated_at_ms = ?
        WHERE id = 1`,
      nextGen,
      nowMs,
      nowMs,
    );

    return { retireUpToGen };
  }

  confirmCoverageSync(cmd: {
    readonly generation: number;
    readonly actualRecoveryAtMs: number | null;
    readonly applied: boolean;
    readonly earliestRequiredRecoveryMs: number;
    readonly nowMs: number;
  }): boolean {
    const cov = this.ensureCoverageRowSync(cmd.nowMs);
    if (cov.generation !== cmd.generation || cov.coverage_state !== 'registering') {
      return false;
    }
    if (!cmd.applied || cov.pending_kind === null || cmd.actualRecoveryAtMs === null) {
      return false;
    }
    if (cmd.actualRecoveryAtMs > cmd.earliestRequiredRecoveryMs) {
      return false;
    }

    this.storage.sql.exec(
      `UPDATE v2_recovery_coverage
          SET coverage_state = 'covered',
              covered_recovery_at_ms = ?,
              pending_kind = NULL,
              pending_prev_generation = NULL,
              pending_target_at_ms = NULL,
              last_d1_sync_at_ms = ?,
              updated_at_ms = ?
        WHERE id = 1 AND generation = ?`,
      cmd.actualRecoveryAtMs,
      cmd.nowMs,
      cmd.nowMs,
      cmd.generation,
    );
    return true;
  }

  enqueueDurableOutboxSync(cmd: {
    readonly outboxId: string;
    readonly entityKind: OutboxEntityKind;
    readonly entityId: string;
    readonly queueName: V2QueueName | null;
    readonly payloadJson: string;
    readonly operationId?: string;
    readonly revision?: number;
    readonly fenceEpoch: number;
    readonly nextAttemptAtMs: number;
  }): void {
    const validated = validateOutboxEnqueueCommand(cmd);
    const nowMs = cmd.nextAttemptAtMs;

    if (validated.entityKind === 'budget_sync' && validated.operationId !== undefined) {
      const existing = sqlExecMaybe<V2DispatchOutboxRow>(
        this.storage.sql,
        `SELECT * FROM v2_dispatch_outbox
          WHERE entity_kind = 'budget_sync' AND operation_id = ? AND revision = ?`,
        validated.operationId,
        validated.revision,
      );

      if (existing !== null) {
        if (existing.payload_json === validated.payloadJson) {
          return;
        }
        throw new OutboxConstraintError(
          'BUDGET_SYNC_REVISION_CONFLICT',
          `Conflicting budget_sync payload at operationId=${validated.operationId} revision=${validated.revision}`,
        );
      }
    }

    this.storage.sql.exec(
      `INSERT INTO v2_dispatch_outbox (
         outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id, revision,
         state, next_attempt_at_ms, publish_attempts, dlq_count, fence_epoch, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, 0, ?, ?, ?)
       ON CONFLICT (outbox_id) DO NOTHING`,
      validated.outboxId,
      validated.entityKind,
      validated.entityId,
      validated.queueName,
      validated.payloadJson,
      validated.operationId ?? null,
      validated.revision,
      validated.nextAttemptAtMs,
      validated.fenceEpoch,
      nowMs,
      nowMs,
    );
  }

  cancelEntityOutboxSync(
    entityKind: OrdinaryOutboxEntityKind,
    entityId: string,
    nowMs: number,
  ): void {
    if ((entityKind as string) === 'budget_sync') {
      throw new OutboxConstraintError(
        'BUDGET_SYNC_CANNOT_BE_CANCELLED',
        'J5 hard invariant: budget_sync outbox items must never be cancelled by business operations',
      );
    }

    this.storage.sql.exec(
      `UPDATE v2_dispatch_outbox
          SET state = 'cancelled',
              updated_at_ms = ?
        WHERE entity_kind = ?
          AND entity_id = ?
          AND state IN ('pending', 'enqueued', 'dead_lettered')`,
      nowMs,
      entityKind,
      entityId,
    );
  }

  ackOutboxSync(outboxId: string, fenceEpoch: number, nowMs: number): void {
    this.storage.sql.exec(
      `UPDATE v2_dispatch_outbox
          SET state = 'acked',
              updated_at_ms = ?
        WHERE outbox_id = ?
          AND fence_epoch = ?
          AND state IN ('pending', 'enqueued', 'dead_lettered')`,
      nowMs,
      outboxId,
      fenceEpoch,
    );
  }

  applyOutboxDeadLetterSync(cmd: {
    readonly outboxId: string;
    readonly fenceEpoch: number;
    readonly errorCode: string;
    readonly nextAttemptAtMs: number;
    readonly nowMs: number;
  }): boolean {
    const existing = this.storage.sql
      .exec<{ readonly state: string }>(
        `SELECT state FROM v2_dispatch_outbox WHERE outbox_id = ? AND fence_epoch = ?`,
        cmd.outboxId,
        cmd.fenceEpoch,
      )
      .toArray()[0];

    if (existing === undefined || existing.state === 'acked' || existing.state === 'cancelled') {
      return false;
    }

    this.storage.sql.exec(
      `UPDATE v2_dispatch_outbox
          SET state = 'dead_lettered',
              dlq_count = dlq_count + 1,
              last_error_code = ?,
              next_attempt_at_ms = ?,
              updated_at_ms = ?
        WHERE outbox_id = ? AND fence_epoch = ?`,
      cmd.errorCode,
      cmd.nextAttemptAtMs,
      cmd.nowMs,
      cmd.outboxId,
      cmd.fenceEpoch,
    );
    return true;
  }

  /**
   * Marks the previously armed platform Alarm as consumed (e.g. on entering `alarm()` or
   * `reconcileFromRegistry()`), ensuring `recomputeAlarmSync()` treats `prevArmed = null`.
   */
  markAlarmConsumedSync(nowMs: number): void {
    this.ensureCoverageRowSync(nowMs);
    this.storage.sql.exec(
      `UPDATE v2_recovery_coverage SET armed_alarm_at_ms = NULL, updated_at_ms = ? WHERE id = 1`,
      nowMs,
    );
    this.alarmConsumedInCurrentCycle = true;
  }

  recomputeAlarmSync(nowMs: number): number | null {
    const cov = this.ensureCoverageRowSync(nowMs);
    const prevArmed = this.alarmConsumedInCurrentCycle ? null : cov.armed_alarm_at_ms;
    this.alarmConsumedInCurrentCycle = false;

    const businessDue = this.earliestBusinessAlarmAtMsSync(this.storage.sql);
    const outboxRow = this.storage.sql
      .exec<{ readonly m: number | null }>(
        `SELECT MIN(next_attempt_at_ms) AS m
           FROM v2_dispatch_outbox
          WHERE state IN ('pending', 'enqueued', 'dead_lettered')`,
      )
      .one();
    const schedRow = this.storage.sql
      .exec<{ readonly m: number | null }>(
        `SELECT MIN(next_fire_at_ms) AS m
           FROM v2_schedules
          WHERE status = 'active'`,
      )
      .one();

    const candidates = [businessDue, outboxRow.m, schedRow.m].filter(
      (v): v is number => v !== null,
    );
    const nextAlarmAtMs = candidates.length === 0 ? null : Math.min(...candidates);

    if (nextAlarmAtMs !== prevArmed) {
      this.storage.sql.exec(
        `UPDATE v2_recovery_coverage
            SET armed_alarm_at_ms = ?,
                updated_at_ms = ?
          WHERE id = 1`,
        nextAlarmAtMs,
        nowMs,
      );

      if (nextAlarmAtMs === null) {
        if (prevArmed !== null) {
          this.pendingAlarmIntent = { kind: 'delete' };
        }
      } else {
        this.pendingAlarmIntent = { kind: 'set', atMs: nextAlarmAtMs };
      }
    }

    return nextAlarmAtMs;
  }

  /** Executes any queued `setAlarm` / `deleteAlarm` platform call outside `transactionSync`. */
  async flushPendingAlarmOp(): Promise<void> {
    const intent = this.pendingAlarmIntent;
    this.pendingAlarmIntent = null;
    if (intent === null) {
      return;
    }
    if (intent.kind === 'delete') {
      await this.storage.deleteAlarm();
      return;
    }
    await this.storage.setAlarm(intent.atMs);
  }
}
