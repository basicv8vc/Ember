import type {
  D1DatabaseLike,
  DurableObjectStorageLike,
  QueueLike,
  SqlStorageLike,
} from '../storage.js';
import { relayDueBudgetSyncBatch, type GlobalBudgetSettlePort } from './budget-sync.js';
import type { V2DispatchEnvelope } from './envelope.js';
import type { OutboxCoordinator } from './outbox.js';
import type {
  AgentHeadRecoveryPort,
  AuthoritativeBusinessPort,
  RecoveryAdmissionPort,
  RecoveryRegistryPort,
} from './ports.js';
import type { RecoveryRegistryStatus, V2QueueName, V2RecoveryCoverageRow } from './schema.js';
import type { ScheduleRepository } from './schedules.js';

export const D1_RECOVERY_GRACE_MS = 45_000;
export const DEFAULT_ALARM_BATCH_LIMIT = 10;
export const DEFAULT_POSTPONE_MIN_DELTA_MS = 5_000;

export class RecoveryUnavailableError extends Error {
  readonly code = 'DB_UNAVAILABLE' as const;
  readonly httpStatus = 503 as const;

  constructor(message = 'Recovery registry unavailable') {
    super(message);
    this.name = 'RecoveryUnavailableError';
  }
}

export function formatRecoveryAgentKey(tenantId: string, agentId: string): string {
  return `${tenantId}:${agentId}`;
}

export interface AgentRecoveryTargetPort extends Pick<
  AgentHeadRecoveryPort,
  'reconcileFromRegistry' | 'confirmRegistryPlan'
> {
  /** Executes DO due alarm/recovery flush when Sweeper finds `keep_armed` after DO Alarm exhaustion. */
  runRecoveryAlarmCycle(nowMs: number): Promise<void>;
}

/**
 * D1-backed implementation of `RecoveryRegistryPort` enforcing generation CAS
 * and always returning authoritative stored D1 values rather than echoing request arguments.
 */
export class D1RecoveryRegistry implements RecoveryRegistryPort {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async upsertCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly generation: number;
    readonly recoveryAtMs: number;
    readonly nowMs: number;
  }): Promise<{
    readonly accepted: boolean;
    readonly currentGeneration: number;
    readonly actualRecoveryAtMs: number | null;
  }> {
    const key = formatRecoveryAgentKey(cmd.tenantId, cmd.agentId);

    await this.#db
      .prepare(
        `INSERT INTO v2_recovery_registry (
          agent_key, tenant_id, agent_id, generation, next_recovery_at_ms,
          retry_not_before_ms, status, sweep_lease_owner, sweep_lease_expires_at_ms,
          recovery_attempts, last_error_code, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, NULL, 'armed', NULL, NULL, 0, NULL, ?)
        ON CONFLICT (agent_key) DO UPDATE SET
          generation = excluded.generation,
          next_recovery_at_ms = CASE
            WHEN excluded.generation > v2_recovery_registry.generation THEN excluded.next_recovery_at_ms
            ELSE MIN(v2_recovery_registry.next_recovery_at_ms, excluded.next_recovery_at_ms)
          END,
          retry_not_before_ms = NULL,
          status = 'armed',
          sweep_lease_owner = NULL,
          sweep_lease_expires_at_ms = NULL,
          recovery_attempts = 0,
          last_error_code = NULL,
          updated_at_ms = excluded.updated_at_ms
        WHERE excluded.generation > v2_recovery_registry.generation
           OR (
             excluded.generation = v2_recovery_registry.generation
             AND excluded.next_recovery_at_ms <= v2_recovery_registry.next_recovery_at_ms
           )`,
      )
      .bind(key, cmd.tenantId, cmd.agentId, cmd.generation, cmd.recoveryAtMs, cmd.nowMs)
      .run();

    const stored = await this.#db
      .prepare(
        'SELECT generation, next_recovery_at_ms FROM v2_recovery_registry WHERE agent_key = ?',
      )
      .bind(key)
      .first<{ generation: number; next_recovery_at_ms: number }>();

    if (stored === null) {
      return {
        accepted: false,
        currentGeneration: cmd.generation,
        actualRecoveryAtMs: null,
      };
    }

    const accepted =
      stored.generation === cmd.generation && stored.next_recovery_at_ms <= cmd.recoveryAtMs;
    return {
      accepted,
      currentGeneration: stored.generation,
      actualRecoveryAtMs: stored.next_recovery_at_ms,
    };
  }

  async postponeCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly expectedPrevGen: number;
    readonly newGeneration: number;
    readonly nextRecoveryAtMs: number;
    readonly nowMs: number;
  }): Promise<{
    readonly updated: boolean;
    readonly currentGeneration: number;
    readonly actualRecoveryAtMs: number | null;
  }> {
    if (cmd.newGeneration <= cmd.expectedPrevGen) {
      const existing = await this.getCoverage({ tenantId: cmd.tenantId, agentId: cmd.agentId });
      return {
        updated: false,
        currentGeneration: existing.currentGeneration ?? cmd.expectedPrevGen,
        actualRecoveryAtMs: existing.actualRecoveryAtMs,
      };
    }

    const key = formatRecoveryAgentKey(cmd.tenantId, cmd.agentId);
    const res = await this.#db
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
      .bind(cmd.newGeneration, cmd.nextRecoveryAtMs, cmd.nowMs, key, cmd.expectedPrevGen)
      .run();

    const stored = await this.#db
      .prepare(
        'SELECT generation, next_recovery_at_ms FROM v2_recovery_registry WHERE agent_key = ?',
      )
      .bind(key)
      .first<{ generation: number; next_recovery_at_ms: number }>();

    if (stored === null) {
      return {
        updated: false,
        currentGeneration: cmd.expectedPrevGen,
        actualRecoveryAtMs: null,
      };
    }

    return {
      updated: (res.meta?.changes ?? 0) > 0 && stored.generation === cmd.newGeneration,
      currentGeneration: stored.generation,
      actualRecoveryAtMs: stored.next_recovery_at_ms,
    };
  }

  async retireCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly retireUpToGen: number;
  }): Promise<{ readonly retired: boolean }> {
    const key = formatRecoveryAgentKey(cmd.tenantId, cmd.agentId);
    const res = await this.#db
      .prepare(
        `DELETE FROM v2_recovery_registry
         WHERE agent_key = ?
           AND generation <= ?`,
      )
      .bind(key, cmd.retireUpToGen)
      .run();

    return {
      retired: (res.meta?.changes ?? 0) > 0,
    };
  }

  async getCoverage(cmd: { readonly tenantId: string; readonly agentId: string }): Promise<{
    readonly exists: boolean;
    readonly currentGeneration: number | null;
    readonly actualRecoveryAtMs: number | null;
    readonly status: RecoveryRegistryStatus | null;
    readonly retryNotBeforeMs: number | null;
  }> {
    const key = formatRecoveryAgentKey(cmd.tenantId, cmd.agentId);
    const row = await this.#db
      .prepare(
        `SELECT generation, next_recovery_at_ms, status, retry_not_before_ms
         FROM v2_recovery_registry
         WHERE agent_key = ?`,
      )
      .bind(key)
      .first<{
        generation: number;
        next_recovery_at_ms: number;
        status: RecoveryRegistryStatus;
        retry_not_before_ms: number | null;
      }>();

    if (row === null) {
      return {
        exists: false,
        currentGeneration: null,
        actualRecoveryAtMs: null,
        status: null,
        retryNotBeforeMs: null,
      };
    }

    return {
      exists: true,
      currentGeneration: row.generation,
      actualRecoveryAtMs: row.next_recovery_at_ms,
      status: row.status,
      retryNotBeforeMs: row.retry_not_before_ms,
    };
  }
}

/**
 * DO SQLite coverage state machine implementing `RecoveryAdmissionPort` (J2 + J3):
 * - Zero D1 I/O when `coverage_state === 'covered'` and `covered_recovery_at_ms <= required`
 * - Persists `pending_kind` (`ensure | postpone | retire`) before async D1 CAS
 * - Self-heals pending rows & D1 ACK loss in `reconcileFromRegistry` even when clients are offline
 */
export class RecoveryCoverageCoordinator implements RecoveryAdmissionPort {
  readonly #sql: SqlStorageLike;
  readonly #storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly #tenantId: string;
  readonly #agentId: string;
  readonly #business: Pick<AuthoritativeBusinessPort, 'earliestRequiredDiscoveryAtMsSync'>;
  readonly #graceMs: number;

  constructor(cmd: {
    readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
    readonly tenantId: string;
    readonly agentId: string;
    readonly business: Pick<AuthoritativeBusinessPort, 'earliestRequiredDiscoveryAtMsSync'>;
    readonly graceMs?: number;
  }) {
    this.#sql = cmd.storage.sql;
    this.#storage = cmd.storage;
    this.#tenantId = cmd.tenantId;
    this.#agentId = cmd.agentId;
    this.#business = cmd.business;
    this.#graceMs = cmd.graceMs ?? D1_RECOVERY_GRACE_MS;
  }

  getCoverageRowSync(): V2RecoveryCoverageRow | null {
    const rows = this.#sql
      .exec<V2RecoveryCoverageRow & Record<string, never>>(
        'SELECT * FROM v2_recovery_coverage WHERE id = 1',
      )
      .toArray();
    return rows[0] ?? null;
  }

  /**
   * Computes earliest required D1 discovery timestamp across business obligations,
   * active schedules (+ grace), and pending/enqueued/dlq outbox items (+ grace, including `budget_sync`).
   */
  computeEarliestOpenDiscoveryAtMsSync(nowMs: number): number | null {
    const candidates: number[] = [];

    const businessDue = this.#business.earliestRequiredDiscoveryAtMsSync(nowMs);
    if (businessDue !== null) {
      candidates.push(businessDue);
    }

    const schedMin = this.#sql
      .exec<{ min_fire: number | null }>(
        `SELECT MIN(next_fire_at_ms) AS min_fire
         FROM v2_schedules
         WHERE status = 'active'`,
      )
      .toArray()[0]?.min_fire;
    if (schedMin !== null && schedMin !== undefined) {
      candidates.push(schedMin + this.#graceMs);
    }

    const outboxMin = this.#sql
      .exec<{ min_att: number | null }>(
        `SELECT MIN(next_attempt_at_ms) AS min_att
         FROM v2_dispatch_outbox
         WHERE state IN ('pending', 'enqueued', 'dead_lettered')`,
      )
      .toArray()[0]?.min_att;
    if (outboxMin !== null && outboxMin !== undefined) {
      candidates.push(outboxMin + this.#graceMs);
    }

    if (candidates.length === 0) {
      return null;
    }
    return Math.min(...candidates);
  }

  private ensureCoverageRowInitializedSync(nowMs: number): V2RecoveryCoverageRow {
    const existing = this.getCoverageRowSync();
    if (existing !== null) {
      return existing;
    }
    this.#sql.exec(
      `INSERT INTO v2_recovery_coverage (
        id, tenant_id, agent_id, generation, coverage_state, covered_recovery_at_ms,
        pending_kind, pending_prev_generation, pending_target_at_ms, armed_alarm_at_ms,
        alarm_fail_count, last_d1_sync_at_ms, updated_at_ms
      ) VALUES (1, ?, ?, 0, 'uncovered', NULL, NULL, NULL, NULL, NULL, 0, NULL, ?)
      ON CONFLICT (id) DO NOTHING`,
      this.#tenantId,
      this.#agentId,
      nowMs,
    );
    return this.getCoverageRowSync()!;
  }

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
    const row = this.ensureCoverageRowInitializedSync(nowMs);

    if (
      row.coverage_state === 'covered' &&
      row.covered_recovery_at_ms !== null &&
      row.pending_kind === null &&
      row.covered_recovery_at_ms <= requiredRecoveryAtMs
    ) {
      return {
        kind: 'covered',
        generation: row.generation,
        coveredRecoveryAtMs: row.covered_recovery_at_ms,
      };
    }

    const openD = this.computeEarliestOpenDiscoveryAtMsSync(nowMs);
    const pendingTarget =
      row.pending_kind === 'ensure' || row.pending_kind === 'postpone'
        ? row.pending_target_at_ms
        : null;

    const minCandidates = [requiredRecoveryAtMs];
    if (openD !== null) {
      minCandidates.push(openD);
    }
    if (pendingTarget !== null) {
      minCandidates.push(pendingTarget);
    }
    const targetAtMs = Math.min(...minCandidates);
    const prevGen = row.generation;
    const nextGen = prevGen + 1;

    this.#sql.exec(
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
      prevGen,
      targetAtMs,
      nowMs,
    );

    return {
      kind: 'register',
      generation: nextGen,
      targetAtMs,
    };
  }

  confirmCoverageSync(cmd: {
    readonly generation: number;
    readonly actualRecoveryAtMs: number | null;
    readonly applied: boolean;
    readonly earliestRequiredRecoveryMs: number;
    readonly nowMs: number;
  }): boolean {
    const row = this.getCoverageRowSync();
    if (
      row === null ||
      row.generation !== cmd.generation ||
      row.coverage_state !== 'registering' ||
      row.pending_kind === null
    ) {
      return false;
    }

    if (row.pending_kind === 'retire') {
      const openD = this.computeEarliestOpenDiscoveryAtMsSync(cmd.nowMs);
      if (!cmd.applied || openD !== null) {
        return false;
      }
      this.#sql.exec(
        `UPDATE v2_recovery_coverage
         SET coverage_state = 'uncovered',
             covered_recovery_at_ms = NULL,
             pending_kind = NULL,
             pending_prev_generation = NULL,
             pending_target_at_ms = NULL,
             last_d1_sync_at_ms = ?,
             updated_at_ms = ?
         WHERE id = 1 AND generation = ?`,
        cmd.nowMs,
        cmd.nowMs,
        cmd.generation,
      );
      return true;
    }

    if (
      !cmd.applied ||
      cmd.actualRecoveryAtMs === null ||
      cmd.actualRecoveryAtMs > cmd.earliestRequiredRecoveryMs
    ) {
      return false;
    }

    this.#sql.exec(
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

  /**
   * Admission helper for callers needing coverage before committing work:
   * - Covered fast path performs **0 D1 calls** even when D1 is down.
   * - Uncovered path registers via D1 CAS with stale-generation self-heal and fails closed (`503 DB_UNAVAILABLE`) if unconfirmed.
   */
  async ensureAdmissionCoverage(cmd: {
    readonly requiredRecoveryAtMs: number;
    readonly nowMs: number;
    readonly registry: RecoveryRegistryPort;
  }): Promise<{
    readonly generation: number;
    readonly coveredRecoveryAtMs: number;
    readonly d1Called: boolean;
  }> {
    const inspection = this.#storage.transactionSync(() =>
      this.inspectCoverageSync(cmd.requiredRecoveryAtMs, cmd.nowMs),
    );
    if (inspection.kind === 'covered') {
      return {
        generation: inspection.generation,
        coveredRecoveryAtMs: inspection.coveredRecoveryAtMs,
        d1Called: false,
      };
    }

    let attemptGen = inspection.generation;
    let attemptTarget = inspection.targetAtMs;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let upsertRes: Awaited<ReturnType<RecoveryRegistryPort['upsertCoverage']>>;
      try {
        upsertRes = await cmd.registry.upsertCoverage({
          tenantId: this.#tenantId,
          agentId: this.#agentId,
          generation: attemptGen,
          recoveryAtMs: attemptTarget,
          nowMs: cmd.nowMs,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'D1 upsert failed';
        throw new RecoveryUnavailableError(msg);
      }

      const confirmed = this.#storage.transactionSync(() => {
        const openD = this.computeEarliestOpenDiscoveryAtMsSync(cmd.nowMs);
        const requiredFloor =
          openD !== null ? Math.min(openD, cmd.requiredRecoveryAtMs) : cmd.requiredRecoveryAtMs;
        return this.confirmCoverageSync({
          generation: attemptGen,
          actualRecoveryAtMs: upsertRes.actualRecoveryAtMs,
          applied: upsertRes.accepted,
          earliestRequiredRecoveryMs: requiredFloor,
          nowMs: cmd.nowMs,
        });
      });

      if (confirmed && upsertRes.actualRecoveryAtMs !== null) {
        return {
          generation: attemptGen,
          coveredRecoveryAtMs: upsertRes.actualRecoveryAtMs,
          d1Called: true,
        };
      }

      // Remote had higher generation or conflicting target -> advance locally past remote & retry once
      if (attempt === 0) {
        const replanned = this.#storage.transactionSync(() => {
          const row = this.ensureCoverageRowInitializedSync(cmd.nowMs);
          const openD = this.computeEarliestOpenDiscoveryAtMsSync(cmd.nowMs);
          const minTargets = [cmd.requiredRecoveryAtMs, attemptTarget];
          if (openD !== null) {
            minTargets.push(openD);
          }
          if (upsertRes.actualRecoveryAtMs !== null) {
            minTargets.push(upsertRes.actualRecoveryAtMs);
          }
          const nextGen = Math.max(row.generation, upsertRes.currentGeneration) + 1;
          const nextTarget = Math.min(...minTargets);
          this.#sql.exec(
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
            row.generation,
            nextTarget,
            cmd.nowMs,
          );
          return { generation: nextGen, targetAtMs: nextTarget };
        });
        attemptGen = replanned.generation;
        attemptTarget = replanned.targetAtMs;
      }
    }

    throw new RecoveryUnavailableError(
      'Unable to confirm D1 recovery coverage within generation CAS',
    );
  }

  /**
   * Implements `AgentHeadRecoveryPort.reconcileFromRegistry` per V2-M0-A §8.2–§8.3 and V2-M0-B §5.2.
   * Never drops pending obligations to `noop_stale`; heals crash windows with offline clients.
   */
  reconcileFromRegistrySync(cmd: {
    readonly expectedGen: number;
    readonly nowMs: number;
    readonly postponeMinDeltaMs?: number;
  }): Awaited<ReturnType<AgentHeadRecoveryPort['reconcileFromRegistry']>> {
    const row = this.ensureCoverageRowInitializedSync(cmd.nowMs);
    const openD = this.computeEarliestOpenDiscoveryAtMsSync(cmd.nowMs);
    const postponeThreshold = cmd.postponeMinDeltaMs ?? DEFAULT_POSTPONE_MIN_DELTA_MS;

    // 1. Heal unfinished pending work (`ensure` / `postpone` / `retire`) or uncovered open obligations
    if (
      row.pending_kind !== null ||
      (openD !== null &&
        (row.coverage_state !== 'covered' ||
          row.covered_recovery_at_ms === null ||
          row.covered_recovery_at_ms > openD))
    ) {
      if (row.pending_kind === 'retire' && openD === null) {
        const nextGen = Math.max(row.generation, cmd.expectedGen) + 1;
        this.#sql.exec(
          `UPDATE v2_recovery_coverage
           SET generation = ?,
               coverage_state = 'uncovered',
               covered_recovery_at_ms = NULL,
               pending_kind = NULL,
               pending_prev_generation = NULL,
               pending_target_at_ms = NULL,
               updated_at_ms = ?
           WHERE id = 1`,
          nextGen,
          cmd.nowMs,
        );
        return {
          action: 'retire',
          retireUpToGen: nextGen - 1,
        };
      }

      const candidates: number[] = [];
      if (openD !== null) {
        candidates.push(openD);
      }
      if (
        (row.pending_kind === 'ensure' || row.pending_kind === 'postpone') &&
        row.pending_target_at_ms !== null
      ) {
        candidates.push(row.pending_target_at_ms);
      }
      if (candidates.length > 0) {
        const targetAtMs = Math.min(...candidates);
        const prevGen = row.generation;
        const nextGen = Math.max(prevGen, cmd.expectedGen) + 1;
        this.#sql.exec(
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
          prevGen,
          targetAtMs,
          cmd.nowMs,
        );
        return {
          action: 'repair_ensure',
          generation: nextGen,
          recoveryAtMs: targetAtMs,
        };
      }
    }

    // 2. Truly idle across business tables, schedules, and outbox (including budget_sync) -> retire
    if (openD === null) {
      const nextGen = Math.max(row.generation, cmd.expectedGen) + 1;
      this.#sql.exec(
        `UPDATE v2_recovery_coverage
         SET generation = ?,
             coverage_state = 'uncovered',
             covered_recovery_at_ms = NULL,
             pending_kind = NULL,
             pending_prev_generation = NULL,
             pending_target_at_ms = NULL,
             updated_at_ms = ?
         WHERE id = 1`,
        nextGen,
        cmd.nowMs,
      );
      return {
        action: 'retire',
        retireUpToGen: nextGen - 1,
      };
    }

    // 3. Covered by a newer local generation already? Check whether postpone or stale noop
    if (cmd.expectedGen < row.generation) {
      if (
        row.coverage_state === 'covered' &&
        row.covered_recovery_at_ms !== null &&
        row.covered_recovery_at_ms <= openD
      ) {
        return {
          action: 'noop_stale',
          currentGeneration: row.generation,
        };
      }
    }

    // 4. Only later future obligation remains -> record pending postpone before D1 CAS
    if (
      openD > cmd.nowMs &&
      (row.covered_recovery_at_ms === null ||
        openD - row.covered_recovery_at_ms >= postponeThreshold)
    ) {
      const prevGen = row.generation;
      const newGen = Math.max(prevGen, cmd.expectedGen) + 1;
      this.#sql.exec(
        `UPDATE v2_recovery_coverage
         SET generation = ?,
             coverage_state = 'registering',
             covered_recovery_at_ms = NULL,
             pending_kind = 'postpone',
             pending_prev_generation = ?,
             pending_target_at_ms = ?,
             updated_at_ms = ?
         WHERE id = 1`,
        newGen,
        prevGen,
        openD,
        cmd.nowMs,
      );
      return {
        action: 'postpone',
        expectedPrevGen: prevGen,
        newGeneration: newGen,
        nextRecoveryAtMs: openD,
      };
    }

    return {
      action: 'keep_armed',
      currentGeneration: row.generation,
    };
  }

  confirmRegistryPlanSync(cmd: {
    readonly generation: number;
    readonly actualRecoveryAtMs: number | null;
    readonly applied: boolean;
    readonly nowMs: number;
  }): { readonly confirmed: boolean } {
    const openD = this.computeEarliestOpenDiscoveryAtMsSync(cmd.nowMs);
    const confirmed = this.confirmCoverageSync({
      generation: cmd.generation,
      actualRecoveryAtMs: cmd.actualRecoveryAtMs,
      applied: cmd.applied,
      earliestRequiredRecoveryMs: openD ?? Number.MAX_SAFE_INTEGER,
      nowMs: cmd.nowMs,
    });
    return { confirmed };
  }

  /**
   * Synchronizes D1 after Alarm completion when DO became completely idle (retire)
   * or moved far forward to a future Schedule/Outbox (postpone).
   */
  async syncPostCycleCoverage(cmd: {
    readonly nowMs: number;
    readonly registry: RecoveryRegistryPort;
    readonly postponeMinDeltaMs?: number;
  }): Promise<'unchanged' | 'retired' | 'postponed'> {
    const plan = this.#storage.transactionSync<
      | { readonly kind: 'unchanged' }
      | { readonly kind: 'retire'; readonly retireUpToGen: number }
      | {
          readonly kind: 'postpone';
          readonly expectedPrevGen: number;
          readonly newGeneration: number;
          readonly nextRecoveryAtMs: number;
        }
    >(() => {
      const row = this.getCoverageRowSync();
      if (row === null || row.coverage_state !== 'covered' || row.pending_kind !== null) {
        return { kind: 'unchanged' };
      }
      const openD = this.computeEarliestOpenDiscoveryAtMsSync(cmd.nowMs);
      if (openD === null) {
        const nextGen = row.generation + 1;
        this.#sql.exec(
          `UPDATE v2_recovery_coverage
           SET generation = ?,
               coverage_state = 'registering',
               covered_recovery_at_ms = NULL,
               pending_kind = 'retire',
               pending_prev_generation = ?,
               pending_target_at_ms = NULL,
               updated_at_ms = ?
           WHERE id = 1`,
          nextGen,
          row.generation,
          cmd.nowMs,
        );
        return { kind: 'retire', retireUpToGen: nextGen - 1 };
      }

      const delta = cmd.postponeMinDeltaMs ?? DEFAULT_POSTPONE_MIN_DELTA_MS;
      if (row.covered_recovery_at_ms !== null && openD - row.covered_recovery_at_ms >= delta) {
        const newGen = row.generation + 1;
        this.#sql.exec(
          `UPDATE v2_recovery_coverage
           SET generation = ?,
               coverage_state = 'registering',
               covered_recovery_at_ms = NULL,
               pending_kind = 'postpone',
               pending_prev_generation = ?,
               pending_target_at_ms = ?,
               updated_at_ms = ?
           WHERE id = 1`,
          newGen,
          row.generation,
          openD,
          cmd.nowMs,
        );
        return {
          kind: 'postpone',
          expectedPrevGen: row.generation,
          newGeneration: newGen,
          nextRecoveryAtMs: openD,
        };
      }
      return { kind: 'unchanged' };
    });

    if (plan.kind === 'unchanged') {
      return 'unchanged';
    }

    if (plan.kind === 'retire') {
      const res = await cmd.registry.retireCoverage({
        tenantId: this.#tenantId,
        agentId: this.#agentId,
        retireUpToGen: plan.retireUpToGen,
      });
      this.#storage.transactionSync(() => {
        this.confirmCoverageSync({
          generation: plan.retireUpToGen + 1,
          actualRecoveryAtMs: null,
          applied: res.retired,
          earliestRequiredRecoveryMs: Number.MAX_SAFE_INTEGER,
          nowMs: cmd.nowMs,
        });
      });
      return res.retired ? 'retired' : 'unchanged';
    }

    const postponeRes = await cmd.registry.postponeCoverage({
      tenantId: this.#tenantId,
      agentId: this.#agentId,
      expectedPrevGen: plan.expectedPrevGen,
      newGeneration: plan.newGeneration,
      nextRecoveryAtMs: plan.nextRecoveryAtMs,
      nowMs: cmd.nowMs,
    });
    this.#storage.transactionSync(() => {
      const openD = this.computeEarliestOpenDiscoveryAtMsSync(cmd.nowMs);
      this.confirmCoverageSync({
        generation: plan.newGeneration,
        actualRecoveryAtMs: postponeRes.actualRecoveryAtMs,
        applied: postponeRes.updated,
        earliestRequiredRecoveryMs: openD ?? plan.nextRecoveryAtMs,
        nowMs: cmd.nowMs,
      });
    });
    return postponeRes.updated ? 'postponed' : 'unchanged';
  }
}

export interface AlarmCycleResult {
  readonly convergedBusinessCount: number;
  readonly materializedScheduleCount: number;
  readonly dispatchedOutboxCount: number;
  readonly ackedBudgetSyncCount: number;
  readonly nextAlarmAtMs: number | null;
}

/**
 * Single DO Alarm multiplexer coordinates:
 * - Bounded due business convergence (`<= 10`)
 * - Bounded due schedule materialization (`<= 10`)
 * - Outbound Queue dispatch (`<= 10`) + `budget_sync` relay (`<= 10`)
 * - On-demand `setAlarm` / `deleteAlarm` only when `T_alarm` changes (`!== armed_alarm_at_ms`)
 */
export class AlarmMultiplexer {
  readonly #storage: DurableObjectStorageLike;
  readonly #business: AuthoritativeBusinessPort;
  readonly #coordinator: OutboxCoordinator;
  readonly #schedules: ScheduleRepository;
  readonly #coverage: RecoveryCoverageCoordinator;

  constructor(cmd: {
    readonly storage: DurableObjectStorageLike;
    readonly business: AuthoritativeBusinessPort;
    readonly coordinator: OutboxCoordinator;
    readonly schedules: ScheduleRepository;
    readonly coverage: RecoveryCoverageCoordinator;
  }) {
    this.#storage = cmd.storage;
    this.#business = cmd.business;
    this.#coordinator = cmd.coordinator;
    this.#schedules = cmd.schedules;
    this.#coverage = cmd.coverage;
  }

  /**
   * Synchronizes the platform DO Alarm on-demand only when target !== persisted `armed_alarm_at_ms`.
   */
  async syncPlatformAlarm(targetAlarmAtMs: number | null, nowMs: number): Promise<boolean> {
    const current = this.#storage.transactionSync(
      () => this.#coverage.getCoverageRowSync()?.armed_alarm_at_ms ?? null,
    );
    if (current === targetAlarmAtMs) {
      return false;
    }
    if (targetAlarmAtMs === null) {
      await this.#storage.deleteAlarm();
    } else {
      await this.#storage.setAlarm(targetAlarmAtMs);
    }
    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(
        `UPDATE v2_recovery_coverage
         SET armed_alarm_at_ms = ?, updated_at_ms = ?
         WHERE id = 1`,
        targetAlarmAtMs,
        nowMs,
      );
    });
    return true;
  }

  recordAlarmFailureSync(nowMs: number): number {
    return this.#storage.transactionSync(() => {
      this.#storage.sql.exec(
        `UPDATE v2_recovery_coverage
         SET alarm_fail_count = alarm_fail_count + 1, updated_at_ms = ?
         WHERE id = 1`,
        nowMs,
      );
      return this.#coverage.getCoverageRowSync()?.alarm_fail_count ?? 1;
    });
  }

  async runAlarmCycle(cmd: {
    readonly nowMs: number;
    readonly queues: Readonly<Record<V2QueueName, QueueLike<V2DispatchEnvelope>>>;
    readonly globalBudget: GlobalBudgetSettlePort;
    readonly registry?: RecoveryRegistryPort;
    readonly batchLimit?: number;
  }): Promise<AlarmCycleResult> {
    const limit = Math.max(1, Math.min(cmd.batchLimit ?? DEFAULT_ALARM_BATCH_LIMIT, 10));

    const phase1 = this.#storage.transactionSync(() => {
      const dueBusiness = this.#business.listDueBusinessActionsSync(cmd.nowMs, limit);
      for (const action of dueBusiness) {
        this.#business.convergeDueBusinessItemSync(action.targetKind, action.targetId, cmd.nowMs);
      }

      const scheduleRes = this.#schedules.processDueSchedulesSync(this.#business, cmd.nowMs, limit);

      this.#storage.sql.exec(
        `UPDATE v2_recovery_coverage
         SET alarm_fail_count = 0, updated_at_ms = ?
         WHERE id = 1`,
        cmd.nowMs,
      );

      return {
        convergedBusinessCount: dueBusiness.length,
        materializedScheduleCount: scheduleRes.processedCount,
      };
    });

    const outboxRes = await this.#coordinator.dispatchDueOrdinaryOutbox({
      nowMs: cmd.nowMs,
      queues: cmd.queues,
      limit,
    });

    const budgetRes = await relayDueBudgetSyncBatch({
      sql: this.#storage.sql,
      storage: this.#storage,
      coordinator: this.#coordinator,
      globalBudget: cmd.globalBudget,
      nowMs: cmd.nowMs,
      limit,
    });

    const nextAlarmAtMs = this.#storage.transactionSync(() =>
      this.#coordinator.recomputeAlarmSync(cmd.nowMs),
    );
    await this.syncPlatformAlarm(nextAlarmAtMs, cmd.nowMs);

    if (cmd.registry !== undefined) {
      await this.#coverage.syncPostCycleCoverage({
        nowMs: cmd.nowMs,
        registry: cmd.registry,
      });
    }

    return {
      convergedBusinessCount: phase1.convergedBusinessCount,
      materializedScheduleCount: phase1.materializedScheduleCount,
      dispatchedOutboxCount: outboxRes.sentCount,
      ackedBudgetSyncCount: budgetRes.ackedCount,
      nextAlarmAtMs,
    };
  }
}
