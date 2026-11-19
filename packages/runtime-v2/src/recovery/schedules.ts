import type { SqlStorageLike } from '../storage.js';
import {
  assertValidIanaTimezone,
  computeNextScheduleFireAtMs,
  findNextCronTzFireAtMs,
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  parseCronExpression,
} from './cron-tz.js';
import type { AuthoritativeBusinessPort } from './ports.js';
import type {
  MisfirePolicy,
  ScheduleKind,
  ScheduleSourceKind,
  ScheduleStatus,
  V2ScheduleRow,
} from './schema.js';

export const DEFAULT_DUE_SCHEDULE_BATCH_LIMIT = 10;

export interface UpsertScheduleCommand {
  readonly scheduleId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly sourceKind: ScheduleSourceKind;
  readonly sourceId: string;
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds: number | null;
  readonly cronExpr: string | null;
  readonly timezone?: string;
  readonly firstFireAtMs?: number;
  readonly misfirePolicy?: MisfirePolicy;
  readonly nowMs: number;
}

export interface ProcessDueSchedulesResult {
  readonly processedCount: number;
  readonly materialized: ReadonlyArray<{
    readonly scheduleId: string;
    readonly occurrenceSeq: number;
    readonly nextFireAtMs: number | null;
    readonly status: 'active' | 'completed';
  }>;
  readonly isolatedErrors: ReadonlyArray<{
    readonly scheduleId: string;
    readonly errorMessage: string;
  }>;
}

function validateScheduleCommand(cmd: UpsertScheduleCommand): {
  readonly timezone: string;
  readonly misfirePolicy: MisfirePolicy;
  readonly nextFireAtMs: number;
} {
  const timezone = cmd.timezone ?? 'UTC';
  assertValidIanaTimezone(timezone);
  const misfirePolicy = cmd.misfirePolicy ?? 'coalesce_latest';

  if (cmd.scheduleKind === 'once') {
    if (
      cmd.firstFireAtMs === undefined ||
      !Number.isSafeInteger(cmd.firstFireAtMs) ||
      cmd.firstFireAtMs < 0
    ) {
      throw new Error("Schedule kind 'once' requires a valid non-negative integer firstFireAtMs");
    }
    return { timezone, misfirePolicy, nextFireAtMs: cmd.firstFireAtMs };
  }

  if (cmd.scheduleKind === 'interval') {
    if (
      cmd.intervalSeconds === null ||
      !Number.isSafeInteger(cmd.intervalSeconds) ||
      cmd.intervalSeconds < MIN_INTERVAL_SECONDS ||
      cmd.intervalSeconds > MAX_INTERVAL_SECONDS
    ) {
      throw new Error(
        `Schedule kind 'interval' requires integer intervalSeconds in [${MIN_INTERVAL_SECONDS}..${MAX_INTERVAL_SECONDS}]`,
      );
    }
    const nextFireAtMs = cmd.firstFireAtMs ?? cmd.nowMs + cmd.intervalSeconds * 1_000;
    return { timezone, misfirePolicy, nextFireAtMs };
  }

  if (cmd.cronExpr === null || cmd.cronExpr.trim().length === 0) {
    throw new Error("Schedule kind 'cron_tz' requires non-empty cronExpr");
  }
  parseCronExpression(cmd.cronExpr);
  const nextFireAtMs =
    cmd.firstFireAtMs ??
    findNextCronTzFireAtMs({
      cronExpr: cmd.cronExpr,
      timezone,
      afterUtcMs: cmd.nowMs,
      lastFiredAtMs: null,
    });
  return { timezone, misfirePolicy, nextFireAtMs };
}

/**
 * DO SQLite `v2_schedules` repository operating strictly inside DO `transactionSync()`.
 * Owns trigger timing and atomic `occurrence_seq` increments; delegates business creation
 * to `AuthoritativeBusinessPort.materializeScheduleOccurrenceSync`.
 */
export class ScheduleRepository {
  readonly #sql: SqlStorageLike;

  constructor(sql: SqlStorageLike) {
    this.#sql = sql;
  }

  upsertScheduleSync(cmd: UpsertScheduleCommand): V2ScheduleRow {
    const validated = validateScheduleCommand(cmd);

    this.#sql.exec(
      `INSERT INTO v2_schedules (
        schedule_id, tenant_id, agent_id, source_kind, source_id, schedule_kind,
        interval_seconds, cron_expr, timezone, next_fire_at_ms, last_fired_at_ms,
        occurrence_seq, misfire_policy, status, version, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, 'active', 1, ?, ?)
      ON CONFLICT (source_kind, source_id) DO UPDATE SET
        schedule_kind = excluded.schedule_kind,
        interval_seconds = excluded.interval_seconds,
        cron_expr = excluded.cron_expr,
        timezone = excluded.timezone,
        next_fire_at_ms = excluded.next_fire_at_ms,
        misfire_policy = excluded.misfire_policy,
        status = 'active',
        version = v2_schedules.version + 1,
        updated_at_ms = excluded.updated_at_ms`,
      cmd.scheduleId,
      cmd.tenantId,
      cmd.agentId,
      cmd.sourceKind,
      cmd.sourceId,
      cmd.scheduleKind,
      cmd.intervalSeconds,
      cmd.cronExpr,
      validated.timezone,
      validated.nextFireAtMs,
      validated.misfirePolicy,
      cmd.nowMs,
      cmd.nowMs,
    );

    return this.#sql
      .exec<V2ScheduleRow & Record<string, never>>(
        'SELECT * FROM v2_schedules WHERE source_kind = ? AND source_id = ?',
        cmd.sourceKind,
        cmd.sourceId,
      )
      .one();
  }

  setStatusSync(scheduleId: string, status: ScheduleStatus, nowMs: number): boolean {
    const existing = this.#sql
      .exec<{ schedule_id: string }>(
        'SELECT schedule_id FROM v2_schedules WHERE schedule_id = ?',
        scheduleId,
      )
      .toArray();
    if (existing.length === 0) {
      return false;
    }
    this.#sql.exec(
      `UPDATE v2_schedules
       SET status = ?, version = version + 1, updated_at_ms = ?
       WHERE schedule_id = ?`,
      status,
      nowMs,
      scheduleId,
    );
    return true;
  }

  getEarliestActiveFireAtMsSync(): number | null {
    const rows = this.#sql
      .exec<{ min_fire: number | null }>(
        `SELECT MIN(next_fire_at_ms) AS min_fire
         FROM v2_schedules
         WHERE status = 'active'`,
      )
      .toArray();
    return rows[0]?.min_fire ?? null;
  }

  /**
   * Atomically materializes up to `limit` due schedules in `(next_fire_at_ms ASC, schedule_id ASC)`
   * order inside the caller's active `transactionSync()`.
   * Isolates invalid schedule calculations before mutation. Business materialization errors
   * propagate to the caller so the transaction rolls back both schedule and business writes.
   */
  processDueSchedulesSync(
    business: AuthoritativeBusinessPort,
    nowMs: number,
    limit = DEFAULT_DUE_SCHEDULE_BATCH_LIMIT,
  ): ProcessDueSchedulesResult {
    const boundedLimit = Math.max(1, Math.min(limit, DEFAULT_DUE_SCHEDULE_BATCH_LIMIT));
    const dueRows = this.#sql
      .exec<V2ScheduleRow & Record<string, never>>(
        `SELECT * FROM v2_schedules
         WHERE status = 'active' AND next_fire_at_ms <= ?
         ORDER BY next_fire_at_ms ASC, schedule_id ASC
         LIMIT ?`,
        nowMs,
        boundedLimit,
      )
      .toArray();

    const materialized: Array<{
      readonly scheduleId: string;
      readonly occurrenceSeq: number;
      readonly nextFireAtMs: number | null;
      readonly status: 'active' | 'completed';
    }> = [];
    const isolatedErrors: Array<{ readonly scheduleId: string; readonly errorMessage: string }> =
      [];

    for (const row of dueRows) {
      const nextOccurrenceSeq = row.occurrence_seq + 1;
      let computed: ReturnType<typeof computeNextScheduleFireAtMs>;
      try {
        computed = computeNextScheduleFireAtMs({
          scheduleKind: row.schedule_kind,
          intervalSeconds: row.interval_seconds,
          cronExpr: row.cron_expr,
          timezone: row.timezone,
          currentNextFireAtMs: row.next_fire_at_ms,
          misfirePolicy: row.misfire_policy,
          nowMs,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown schedule error';
        this.#sql.exec(
          `UPDATE v2_schedules
           SET status = 'paused', version = version + 1, updated_at_ms = ?
           WHERE schedule_id = ?`,
          nowMs,
          row.schedule_id,
        );
        isolatedErrors.push({ scheduleId: row.schedule_id, errorMessage });
        continue;
      }

      // Both writes belong to the caller's transaction. A materialization error must
      // escape so schedule progress and any partial business writes roll back together.
      const persistedNextFire = computed.nextFireAtMs ?? row.next_fire_at_ms;
      this.#sql.exec(
        `UPDATE v2_schedules
         SET last_fired_at_ms = ?,
             occurrence_seq = ?,
             next_fire_at_ms = ?,
             status = ?,
             version = version + 1,
             updated_at_ms = ?
         WHERE schedule_id = ? AND version = ?`,
        nowMs,
        nextOccurrenceSeq,
        persistedNextFire,
        computed.newStatus,
        nowMs,
        row.schedule_id,
        row.version,
      );

      business.materializeScheduleOccurrenceSync(row.schedule_id, nextOccurrenceSeq, nowMs);

      materialized.push({
        scheduleId: row.schedule_id,
        occurrenceSeq: nextOccurrenceSeq,
        nextFireAtMs: computed.nextFireAtMs,
        status: computed.newStatus,
      });
    }

    return {
      processedCount: materialized.length,
      materialized,
      isolatedErrors,
    };
  }
}
