import type { D1DatabaseLike } from '../storage.js';
import type { RecoveryRegistryPort } from './ports.js';
import type { AgentRecoveryTargetPort } from './registry.js';
import type { RecoveryRegistryStatus, V2RecoveryRegistryRow } from './schema.js';

export const DEFAULT_SWEEPER_BATCH_LIMIT = 50;
export const DEFAULT_SWEEP_LEASE_MS = 30_000;
export const DEFAULT_KEEP_ARMED_RECHECK_MS = 15_000;
export const DEFAULT_BACKOFF_STEP_MS = 15_000;
export const DEFAULT_BACKOFF_MAX_MS = 300_000;
export const DEFAULT_QUARANTINE_THRESHOLD = 10;

export interface QuarantineAlertEvent {
  readonly tenantId: string;
  readonly agentId: string;
  readonly generation: number;
  readonly nextRecoveryAtMs: number;
  readonly retryNotBeforeMs: number;
  readonly recoveryAttempts: number;
  readonly errorCode: string;
}

export interface RecoverySweeperResult {
  readonly scannedCount: number;
  readonly leaseAcquiredCount: number;
  readonly repairedEnsureCount: number;
  readonly retiredCount: number;
  readonly postponedCount: number;
  readonly keptArmedCount: number;
  readonly backoffCount: number;
  readonly quarantinedCount: number;
  readonly noopStaleCount: number;
}

export interface RecoveryTargetResolverPort {
  getRecoveryTarget(tenantId: string, agentId: string): AgentRecoveryTargetPort;
}

function sanitizeErrorCode(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().slice(0, 120);
  }
  return 'SWEEP_RPC_FAILED';
}

export function computeRecoveryBackoff(cmd: {
  readonly nextAttempts: number;
  readonly nowMs: number;
  readonly backoffStepMs?: number;
  readonly backoffMaxMs?: number;
  readonly quarantineThreshold?: number;
}): {
  readonly status: Exclude<RecoveryRegistryStatus, 'armed'>;
  readonly retryNotBeforeMs: number;
} {
  const stepMs = cmd.backoffStepMs ?? DEFAULT_BACKOFF_STEP_MS;
  const maxMs = cmd.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const threshold = cmd.quarantineThreshold ?? DEFAULT_QUARANTINE_THRESHOLD;
  const delayMs = Math.min(maxMs, stepMs * Math.max(1, cmd.nextAttempts));
  const status: Exclude<RecoveryRegistryStatus, 'armed'> =
    cmd.nextAttempts >= threshold ? 'quarantined' : 'backoff';
  return {
    status,
    retryNotBeforeMs: cmd.nowMs + delayMs,
  };
}

/**
 * Per-minute (`* * * * *`) Scheduled Worker independent recovery sweeper (V2-M0-B §4).
 * - Scans only due entries in `v2_recovery_registry` (zero fleet polling, zero idle wakeups)
 * - Uses strict generation- & owner-fenced CAS sweep leases
 * - Preserves `next_recovery_at_ms` unchanged on failure, updating only `retry_not_before_ms` & `status`
 */
export class RecoverySweeper {
  readonly #db: D1DatabaseLike;
  readonly #registry: RecoveryRegistryPort;
  readonly #targets: RecoveryTargetResolverPort;
  readonly #onQuarantine?: (event: QuarantineAlertEvent) => void;

  constructor(cmd: {
    readonly db: D1DatabaseLike;
    readonly registry: RecoveryRegistryPort;
    readonly targets: RecoveryTargetResolverPort;
    readonly onQuarantine?: (event: QuarantineAlertEvent) => void;
  }) {
    this.#db = cmd.db;
    this.#registry = cmd.registry;
    this.#targets = cmd.targets;
    this.#onQuarantine = cmd.onQuarantine;
  }

  async sweepDueAgents(cmd: {
    readonly sweeperId: string;
    readonly nowMs: number;
    readonly batchLimit?: number;
    readonly leaseMs?: number;
    readonly keepArmedRecheckMs?: number;
    readonly backoffStepMs?: number;
    readonly backoffMaxMs?: number;
    readonly quarantineThreshold?: number;
  }): Promise<RecoverySweeperResult> {
    const limit = Math.max(1, Math.min(cmd.batchLimit ?? DEFAULT_SWEEPER_BATCH_LIMIT, 200));
    const leaseMs = cmd.leaseMs ?? DEFAULT_SWEEP_LEASE_MS;
    const keepArmedRecheckMs = cmd.keepArmedRecheckMs ?? DEFAULT_KEEP_ARMED_RECHECK_MS;

    const candidatesResult = await this.#db
      .prepare(
        `SELECT agent_key, tenant_id, agent_id, generation, next_recovery_at_ms,
                retry_not_before_ms, status, recovery_attempts
         FROM v2_recovery_registry
         WHERE status IN ('armed', 'backoff', 'quarantined')
           AND next_recovery_at_ms <= ?
           AND (retry_not_before_ms IS NULL OR retry_not_before_ms <= ?)
           AND (sweep_lease_expires_at_ms IS NULL OR sweep_lease_expires_at_ms <= ?)
         ORDER BY next_recovery_at_ms ASC, agent_key ASC
         LIMIT ?`,
      )
      .bind(cmd.nowMs, cmd.nowMs, cmd.nowMs, limit)
      .all<
        Pick<
          V2RecoveryRegistryRow,
          | 'agent_key'
          | 'tenant_id'
          | 'agent_id'
          | 'generation'
          | 'next_recovery_at_ms'
          | 'retry_not_before_ms'
          | 'status'
          | 'recovery_attempts'
        >
      >();

    const candidates = candidatesResult.results;
    if (candidates.length === 0) {
      return {
        scannedCount: 0,
        leaseAcquiredCount: 0,
        repairedEnsureCount: 0,
        retiredCount: 0,
        postponedCount: 0,
        keptArmedCount: 0,
        backoffCount: 0,
        quarantinedCount: 0,
        noopStaleCount: 0,
      };
    }

    let leaseAcquiredCount = 0;
    let repairedEnsureCount = 0;
    let retiredCount = 0;
    let postponedCount = 0;
    let keptArmedCount = 0;
    let backoffCount = 0;
    let quarantinedCount = 0;
    let noopStaleCount = 0;

    for (const row of candidates) {
      const leaseExpiresAtMs = cmd.nowMs + leaseMs;
      const leaseRes = await this.#db
        .prepare(
          `UPDATE v2_recovery_registry
           SET sweep_lease_owner = ?,
               sweep_lease_expires_at_ms = ?,
               updated_at_ms = ?
           WHERE agent_key = ?
             AND generation = ?
             AND (sweep_lease_expires_at_ms IS NULL OR sweep_lease_expires_at_ms <= ?)`,
        )
        .bind(cmd.sweeperId, leaseExpiresAtMs, cmd.nowMs, row.agent_key, row.generation, cmd.nowMs)
        .run();

      if ((leaseRes.meta?.changes ?? 0) === 0) {
        continue;
      }
      leaseAcquiredCount += 1;

      const target = this.#targets.getRecoveryTarget(row.tenant_id, row.agent_id);

      try {
        const plan = await target.reconcileFromRegistry({
          tenantId: row.tenant_id,
          agentId: row.agent_id,
          expectedGen: row.generation,
          nowMs: cmd.nowMs,
        });

        switch (plan.action) {
          case 'repair_ensure': {
            const upsert = await this.#registry.upsertCoverage({
              tenantId: row.tenant_id,
              agentId: row.agent_id,
              generation: plan.generation,
              recoveryAtMs: plan.recoveryAtMs,
              nowMs: cmd.nowMs,
            });
            await target.confirmRegistryPlan({
              generation: plan.generation,
              actualRecoveryAtMs: upsert.actualRecoveryAtMs,
              applied: upsert.accepted,
            });
            // Run immediate alarm recovery tick if repaired target is already due
            if (upsert.accepted && plan.recoveryAtMs <= cmd.nowMs) {
              await target.runRecoveryAlarmCycle(cmd.nowMs);
            }
            repairedEnsureCount += 1;
            break;
          }

          case 'retire': {
            const ret = await this.#registry.retireCoverage({
              tenantId: row.tenant_id,
              agentId: row.agent_id,
              retireUpToGen: plan.retireUpToGen,
            });
            await target.confirmRegistryPlan({
              generation: plan.retireUpToGen + 1,
              actualRecoveryAtMs: null,
              applied: ret.retired,
            });
            retiredCount += 1;
            break;
          }

          case 'postpone': {
            const post = await this.#registry.postponeCoverage({
              tenantId: row.tenant_id,
              agentId: row.agent_id,
              expectedPrevGen: plan.expectedPrevGen,
              newGeneration: plan.newGeneration,
              nextRecoveryAtMs: plan.nextRecoveryAtMs,
              nowMs: cmd.nowMs,
            });
            await target.confirmRegistryPlan({
              generation: plan.newGeneration,
              actualRecoveryAtMs: post.actualRecoveryAtMs,
              applied: post.updated,
            });
            postponedCount += 1;
            break;
          }

          case 'keep_armed': {
            // Wake DO to flush due Alarm obligations & re-arm Alarm / sync coverage
            await target.runRecoveryAlarmCycle(cmd.nowMs);
            await this.#db
              .prepare(
                `UPDATE v2_recovery_registry
                 SET retry_not_before_ms = ?,
                     status = 'armed',
                     sweep_lease_owner = NULL,
                     sweep_lease_expires_at_ms = NULL,
                     recovery_attempts = 0,
                     last_error_code = NULL,
                     updated_at_ms = ?
                 WHERE agent_key = ?
                   AND generation = ?
                   AND sweep_lease_owner = ?`,
              )
              .bind(
                cmd.nowMs + keepArmedRecheckMs,
                cmd.nowMs,
                row.agent_key,
                row.generation,
                cmd.sweeperId,
              )
              .run();
            keptArmedCount += 1;
            break;
          }

          case 'noop_stale': {
            await this.#db
              .prepare(
                `UPDATE v2_recovery_registry
                 SET sweep_lease_owner = NULL,
                     sweep_lease_expires_at_ms = NULL,
                     updated_at_ms = ?
                 WHERE agent_key = ?
                   AND generation = ?
                   AND sweep_lease_owner = ?`,
              )
              .bind(cmd.nowMs, row.agent_key, row.generation, cmd.sweeperId)
              .run();
            noopStaleCount += 1;
            break;
          }
        }
      } catch (error) {
        const nextAttempts = row.recovery_attempts + 1;
        const backoff = computeRecoveryBackoff({
          nextAttempts,
          nowMs: cmd.nowMs,
          backoffStepMs: cmd.backoffStepMs,
          backoffMaxMs: cmd.backoffMaxMs,
          quarantineThreshold: cmd.quarantineThreshold,
        });
        const errorCode = sanitizeErrorCode(error);

        // Strictly retain next_recovery_at_ms unchanged; only gate retry_not_before_ms under CAS
        await this.#db
          .prepare(
            `UPDATE v2_recovery_registry
             SET retry_not_before_ms = ?,
                 status = ?,
                 sweep_lease_owner = NULL,
                 sweep_lease_expires_at_ms = NULL,
                 recovery_attempts = ?,
                 last_error_code = ?,
                 updated_at_ms = ?
             WHERE agent_key = ?
               AND generation = ?
               AND sweep_lease_owner = ?`,
          )
          .bind(
            backoff.retryNotBeforeMs,
            backoff.status,
            nextAttempts,
            errorCode,
            cmd.nowMs,
            row.agent_key,
            row.generation,
            cmd.sweeperId,
          )
          .run();

        if (backoff.status === 'quarantined') {
          quarantinedCount += 1;
          this.#onQuarantine?.({
            tenantId: row.tenant_id,
            agentId: row.agent_id,
            generation: row.generation,
            nextRecoveryAtMs: row.next_recovery_at_ms,
            retryNotBeforeMs: backoff.retryNotBeforeMs,
            recoveryAttempts: nextAttempts,
            errorCode,
          });
        } else {
          backoffCount += 1;
        }
      }
    }

    return {
      scannedCount: candidates.length,
      leaseAcquiredCount,
      repairedEnsureCount,
      retiredCount,
      postponedCount,
      keptArmedCount,
      backoffCount,
      quarantinedCount,
      noopStaleCount,
    };
  }
}
