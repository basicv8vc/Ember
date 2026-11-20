import { DomainError, isTerminalTaskStatus } from '@ember/domain';
import { V2_TIMING_LIMITS } from '../contracts/constants.js';
import {
  PROACTIVE_RECENT_RUNS_LIMIT,
  type ProactiveDeliveryMode,
  type ProactiveScheduleCommand,
  type ProactiveScheduleCreateInput,
  type ProactiveScheduleDetail,
  type ProactiveScheduleKind,
  type ProactiveScheduleList,
  type ProactiveScheduleResponse,
  type ProactiveScheduleRunSnapshot,
  type ProactiveScheduleSnapshot,
} from '../contracts/proactive-schedules.js';
import {
  assertValidIanaTimezone,
  computeNextScheduleFireAtMs,
  findNextCronTzFireAtMs,
  parseCronExpression,
} from '../recovery/cron-tz.js';
import type { EventRuntimeCoordinatorPort } from '../recovery/ports.js';
import type {
  MisfirePolicy,
  ScheduleKind,
  ScheduleSourceKind,
  V2ScheduleRow,
} from '../recovery/schema.js';
import { ScheduleRepository } from '../recovery/schedules.js';
import { assertHeadScopeSync, sha256Hex, sqlExecAll, sqlExecMaybe } from './queries.js';
import type { ProactiveScheduleRow, TaskRow } from './schema.js';
import { toIsoTimestamp } from './state-machine.js';
import { appendTaskEventSync } from './task-execution.js';
import {
  confirmOrVerifyCoverageInTxSync,
  prepareObligationCoverageAsync,
  type CoverageHelperDeps,
} from './turn-commit.js';

interface JoinedScheduleRow extends V2ScheduleRow {
  readonly principal_id: string;
  readonly idempotency_key: string;
  readonly kind: ProactiveScheduleKind;
  readonly title: string;
  readonly prompt: string;
  readonly delivery_mode: ProactiveDeliveryMode;
  readonly digest: string;
  readonly ps_created_at_ms: number;
  readonly ps_updated_at_ms: number;
}

interface JoinedRunRow {
  readonly occurrence_seq: number;
  readonly task_id: string;
  readonly scheduled_for_ms: number;
  readonly status: TaskRow['status'];
  readonly linked_message_id: string | null;
  readonly summary_text: string | null;
  readonly detail_text: string | null;
  readonly reason_code: string | null;
  readonly produced_at_ms: number | null;
}

const JOINED_SCHEDULE_SELECT = `
  SELECT s.*,
         p.principal_id,
         p.idempotency_key,
         p.kind,
         p.title,
         p.prompt,
         p.delivery_mode,
         p.digest,
         p.created_at_ms AS ps_created_at_ms,
         p.updated_at_ms AS ps_updated_at_ms
    FROM proactive_schedules p
    JOIN v2_schedules s ON s.schedule_id = p.schedule_id`;

function mapSourceKind(kind: ProactiveScheduleKind): ScheduleSourceKind {
  switch (kind) {
    case 'reminder':
      return 'reminder';
    case 'brief':
      return 'commitment';
    case 'follow_up':
      return 'deferred_task';
  }
}

function defaultDeliveryMode(kind: ProactiveScheduleKind): ProactiveDeliveryMode {
  return kind === 'reminder' ? 'direct_reminder' : 'model_brief';
}

function normalizeCreateInput(
  input: ProactiveScheduleCreateInput,
  nowMs: number,
): {
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds: number | null;
  readonly cronExpr: string | null;
  readonly timezone: string;
  readonly firstFireAtMs: number;
  readonly misfirePolicy: MisfirePolicy;
  readonly deliveryMode: ProactiveDeliveryMode;
} {
  const deliveryMode = input.deliveryMode ?? defaultDeliveryMode(input.kind);
  const misfirePolicy: MisfirePolicy = input.misfirePolicy ?? 'coalesce_latest';

  if (input.trigger.type === 'once') {
    const timezone = input.timezone ?? 'UTC';
    try {
      assertValidIanaTimezone(timezone);
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'invalid IANA timezone');
    }
    const fireAtMs = Date.parse(input.trigger.fireAt);
    if (!Number.isSafeInteger(fireAtMs) || fireAtMs < 0) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid once fireAt timestamp');
    }
    return {
      scheduleKind: 'once',
      intervalSeconds: null,
      cronExpr: null,
      timezone,
      firstFireAtMs: fireAtMs,
      misfirePolicy,
      deliveryMode,
    };
  }

  if (input.trigger.type === 'interval') {
    const timezone = input.timezone ?? 'UTC';
    try {
      assertValidIanaTimezone(timezone);
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'invalid IANA timezone');
    }
    const firstFireAtMs =
      input.trigger.firstFireAt !== undefined
        ? Date.parse(input.trigger.firstFireAt)
        : nowMs + input.trigger.intervalSeconds * 1_000;
    if (!Number.isSafeInteger(firstFireAtMs) || firstFireAtMs < 0) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid interval firstFireAt timestamp');
    }
    return {
      scheduleKind: 'interval',
      intervalSeconds: input.trigger.intervalSeconds,
      cronExpr: null,
      timezone,
      firstFireAtMs,
      misfirePolicy,
      deliveryMode,
    };
  }

  const timezone = input.trigger.timezone;
  if (input.timezone !== undefined && input.timezone !== timezone) {
    throw new DomainError('INVALID_ARGUMENT', 'timezone must match cron trigger timezone');
  }
  let firstFireAtMs: number;
  try {
    assertValidIanaTimezone(timezone);
    parseCronExpression(input.trigger.cronExpr);
    firstFireAtMs = findNextCronTzFireAtMs({
      cronExpr: input.trigger.cronExpr,
      timezone,
      afterUtcMs: nowMs,
      lastFiredAtMs: null,
    });
  } catch (error) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      error instanceof Error ? error.message : 'invalid cron schedule',
    );
  }
  return {
    scheduleKind: 'cron_tz',
    intervalSeconds: null,
    cronExpr: input.trigger.cronExpr,
    timezone,
    firstFireAtMs,
    misfirePolicy,
    deliveryMode,
  };
}

function toRunSnapshot(row: JoinedRunRow): ProactiveScheduleRunSnapshot {
  return {
    occurrenceSeq: row.occurrence_seq,
    taskId: row.task_id,
    status: row.status,
    summaryText: row.summary_text,
    detailText: row.detail_text,
    reasonCode: row.reason_code,
    resultMessageId: row.linked_message_id,
    scheduledFor: toIsoTimestamp(row.scheduled_for_ms),
    completedAt: row.produced_at_ms !== null ? toIsoTimestamp(row.produced_at_ms) : null,
  };
}

export class AgentHeadProactiveScheduleService {
  private readonly schedules: ScheduleRepository;

  constructor(
    private readonly deps: CoverageHelperDeps & {
      readonly eventCoordinator: EventRuntimeCoordinatorPort;
      readonly newId: () => string;
    },
  ) {
    this.schedules = new ScheduleRepository(deps.storage.sql);
  }

  private get sql() {
    return this.deps.storage.sql;
  }

  async execute(cmd: ProactiveScheduleCommand): Promise<ProactiveScheduleResponse> {
    assertHeadScopeSync(this.sql, cmd.tenantId, cmd.agentId);

    switch (cmd.kind) {
      case 'list':
        return this.list(cmd.principalId);
      case 'get':
        return this.get(cmd.principalId, cmd.scheduleId);
      case 'create':
        return this.create(cmd);
      case 'pause':
        return this.pause(cmd);
      case 'resume':
        return this.resume(cmd);
      case 'cancel':
        return this.cancel(cmd);
    }
  }

  private list(principalId: string): ProactiveScheduleList {
    const rows = sqlExecAll<JoinedScheduleRow>(
      this.sql,
      `${JOINED_SCHEDULE_SELECT}
       WHERE p.principal_id = ?
       ORDER BY p.created_at_ms DESC, p.schedule_id DESC`,
      principalId,
    );
    return {
      schedules: rows.map((row) => this.toSnapshot(row)),
    };
  }

  private get(principalId: string, scheduleId: string): ProactiveScheduleDetail {
    const row = this.findOwnedScheduleSync(principalId, scheduleId);
    if (row === null) {
      throw new DomainError('NOT_FOUND', 'schedule not found');
    }
    const recentRuns = this.listRecentRunsSync(scheduleId, PROACTIVE_RECENT_RUNS_LIMIT);
    return {
      ...this.toSnapshot(row, recentRuns[0] ?? null),
      recentRuns,
    };
  }

  private async create(
    cmd: Extract<ProactiveScheduleCommand, { kind: 'create' }>,
  ): Promise<ProactiveScheduleSnapshot> {
    const { storage, eventCoordinator, recoveryHooks, nowMs } = this.deps;
    const preNow = nowMs();
    // Validate input & timezone/cron eagerly before coverage I/O.
    normalizeCreateInput(cmd.input, preNow);

    const deliveryMode = cmd.input.deliveryMode ?? defaultDeliveryMode(cmd.input.kind);
    const misfirePolicy = cmd.input.misfirePolicy ?? 'coalesce_latest';
    const digest = await sha256Hex(
      JSON.stringify({
        kind: cmd.input.kind,
        title: cmd.input.title,
        prompt: cmd.input.prompt,
        deliveryMode,
        trigger: cmd.input.trigger,
        timezone:
          cmd.input.trigger.type === 'cron'
            ? cmd.input.trigger.timezone
            : (cmd.input.timezone ?? 'UTC'),
        misfirePolicy,
      }),
    );

    const coverage = await prepareObligationCoverageAsync(this.deps, {
      tenantId: cmd.tenantId,
      agentId: cmd.agentId,
      shouldCoverSync: () => this.findByIdempotencyKeySync(cmd.input.idempotencyKey) === null,
    });

    const tx = storage.transactionSync(() => {
      const now = nowMs();
      const existing = this.findByIdempotencyKeySync(cmd.input.idempotencyKey);
      if (existing !== null) {
        if (existing.principal_id !== cmd.principalId || existing.digest !== digest) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'schedule idempotencyKey already used with different payload',
          );
        }
        const joined = this.findOwnedScheduleSync(cmd.principalId, existing.schedule_id);
        if (joined === null) {
          throw new DomainError('DB_UNAVAILABLE', 'schedule metadata inconsistent');
        }
        return {
          snapshot: { ...this.toSnapshot(joined), replayed: true },
          alarmAtMs: undefined as number | null | undefined,
          now,
        };
      }

      confirmOrVerifyCoverageInTxSync(
        this.deps,
        coverage,
        now + V2_TIMING_LIMITS.d1RecoveryGraceMs,
        now,
        'proactive schedule recovery coverage unavailable',
      );

      const normalized = normalizeCreateInput(cmd.input, now);
      const scheduleId = this.deps.newId();
      const sourceKind = mapSourceKind(cmd.input.kind);

      this.schedules.upsertScheduleSync({
        scheduleId,
        tenantId: cmd.tenantId,
        agentId: cmd.agentId,
        sourceKind,
        sourceId: scheduleId,
        scheduleKind: normalized.scheduleKind,
        intervalSeconds: normalized.intervalSeconds,
        cronExpr: normalized.cronExpr,
        timezone: normalized.timezone,
        firstFireAtMs: normalized.firstFireAtMs,
        misfirePolicy: normalized.misfirePolicy,
        nowMs: now,
      });

      this.sql.exec(
        `INSERT INTO proactive_schedules (
           schedule_id, principal_id, idempotency_key, kind, title, prompt,
           delivery_mode, digest, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        scheduleId,
        cmd.principalId,
        cmd.input.idempotencyKey,
        cmd.input.kind,
        cmd.input.title,
        cmd.input.prompt,
        normalized.deliveryMode,
        digest,
        now,
        now,
      );

      const alarmAtMs = eventCoordinator.recomputeAlarmSync(now);
      const created = this.findOwnedScheduleSync(cmd.principalId, scheduleId);
      if (created === null) {
        throw new DomainError('DB_UNAVAILABLE', 'created schedule missing');
      }

      return {
        snapshot: { ...this.toSnapshot(created, null), replayed: false },
        alarmAtMs,
        now,
      };
    });

    if (tx.alarmAtMs !== undefined && recoveryHooks.syncPlatformAlarm !== undefined) {
      await recoveryHooks.syncPlatformAlarm(tx.alarmAtMs, tx.now);
    }

    return tx.snapshot;
  }

  private async pause(
    cmd: Extract<ProactiveScheduleCommand, { kind: 'pause' }>,
  ): Promise<ProactiveScheduleSnapshot> {
    const { storage, eventCoordinator, recoveryHooks, nowMs } = this.deps;

    const tx = storage.transactionSync(() => {
      const now = nowMs();
      const row = this.findOwnedScheduleSync(cmd.principalId, cmd.scheduleId);
      if (row === null) {
        throw new DomainError('NOT_FOUND', 'schedule not found');
      }
      if (row.status === 'paused') {
        return {
          snapshot: this.toSnapshot(row),
          alarmAtMs: undefined as number | null | undefined,
          now,
        };
      }
      if (row.status === 'completed' || row.status === 'cancelled') {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          `cannot pause schedule in status '${row.status}'`,
        );
      }

      this.schedules.setStatusSync(row.schedule_id, 'paused', now);
      this.sql.exec(
        `UPDATE proactive_schedules SET updated_at_ms = ? WHERE schedule_id = ?`,
        now,
        row.schedule_id,
      );
      const alarmAtMs = eventCoordinator.recomputeAlarmSync(now);
      const updated = this.findOwnedScheduleSync(cmd.principalId, row.schedule_id)!;
      return { snapshot: this.toSnapshot(updated), alarmAtMs, now };
    });

    if (tx.alarmAtMs !== undefined && recoveryHooks.syncPlatformAlarm !== undefined) {
      await recoveryHooks.syncPlatformAlarm(tx.alarmAtMs, tx.now);
    }
    return tx.snapshot;
  }

  private async resume(
    cmd: Extract<ProactiveScheduleCommand, { kind: 'resume' }>,
  ): Promise<ProactiveScheduleSnapshot> {
    const { storage, eventCoordinator, recoveryHooks, nowMs } = this.deps;

    const coverage = await prepareObligationCoverageAsync(this.deps, {
      tenantId: cmd.tenantId,
      agentId: cmd.agentId,
      shouldCoverSync: () => {
        const row = this.findOwnedScheduleSync(cmd.principalId, cmd.scheduleId);
        return row !== null && row.status === 'paused';
      },
    });

    const tx = storage.transactionSync(() => {
      const now = nowMs();
      const row = this.findOwnedScheduleSync(cmd.principalId, cmd.scheduleId);
      if (row === null) {
        throw new DomainError('NOT_FOUND', 'schedule not found');
      }
      if (row.status === 'active') {
        return {
          snapshot: this.toSnapshot(row),
          alarmAtMs: undefined as number | null | undefined,
          now,
        };
      }
      if (row.status === 'completed' || row.status === 'cancelled') {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          `cannot resume schedule in status '${row.status}'`,
        );
      }

      confirmOrVerifyCoverageInTxSync(
        this.deps,
        coverage,
        now + V2_TIMING_LIMITS.d1RecoveryGraceMs,
        now,
        'proactive schedule recovery coverage unavailable',
      );

      let nextFireAtMs = row.next_fire_at_ms;
      if (row.schedule_kind !== 'once' && nextFireAtMs <= now) {
        const recomputed = computeNextScheduleFireAtMs({
          scheduleKind: row.schedule_kind,
          intervalSeconds: row.interval_seconds,
          cronExpr: row.cron_expr,
          timezone: row.timezone,
          currentNextFireAtMs: row.next_fire_at_ms,
          misfirePolicy: 'skip_missed',
          nowMs: now,
        });
        if (recomputed.nextFireAtMs !== null) {
          nextFireAtMs = recomputed.nextFireAtMs;
        }
      }

      this.sql.exec(
        `UPDATE v2_schedules
            SET status = 'active',
                next_fire_at_ms = ?,
                version = version + 1,
                updated_at_ms = ?
          WHERE schedule_id = ?`,
        nextFireAtMs,
        now,
        row.schedule_id,
      );
      this.sql.exec(
        `UPDATE proactive_schedules SET updated_at_ms = ? WHERE schedule_id = ?`,
        now,
        row.schedule_id,
      );
      const alarmAtMs = eventCoordinator.recomputeAlarmSync(now);
      const updated = this.findOwnedScheduleSync(cmd.principalId, row.schedule_id)!;
      return { snapshot: this.toSnapshot(updated), alarmAtMs, now };
    });

    if (tx.alarmAtMs !== undefined && recoveryHooks.syncPlatformAlarm !== undefined) {
      await recoveryHooks.syncPlatformAlarm(tx.alarmAtMs, tx.now);
    }
    return tx.snapshot;
  }

  private async cancel(
    cmd: Extract<ProactiveScheduleCommand, { kind: 'cancel' }>,
  ): Promise<ProactiveScheduleSnapshot> {
    const { storage, eventCoordinator, recoveryHooks, nowMs } = this.deps;

    const tx = storage.transactionSync(() => {
      const now = nowMs();
      const row = this.findOwnedScheduleSync(cmd.principalId, cmd.scheduleId);
      if (row === null) {
        throw new DomainError('NOT_FOUND', 'schedule not found');
      }
      if (row.status === 'cancelled') {
        return {
          snapshot: this.toSnapshot(row),
          alarmAtMs: undefined as number | null | undefined,
          now,
        };
      }
      // Load linked tasks before checking completed status: a `once` schedule transitions
      // to `completed` upon materialization while its linked task may still be in-flight.
      const linkedTasks = sqlExecAll<TaskRow>(
        this.sql,
        `SELECT t.*
           FROM proactive_schedule_runs r
           JOIN tasks t ON t.id = r.task_id
          WHERE r.schedule_id = ?`,
        row.schedule_id,
      );
      const hasInFlightTask = linkedTasks.some((task) => !isTerminalTaskStatus(task.status));
      if (row.status === 'completed' && !hasInFlightTask) {
        throw new DomainError('INVALID_STATE_TRANSITION', 'cannot cancel completed schedule');
      }

      this.schedules.setStatusSync(row.schedule_id, 'cancelled', now);
      this.sql.exec(
        `UPDATE proactive_schedules SET updated_at_ms = ? WHERE schedule_id = ?`,
        now,
        row.schedule_id,
      );

      // Cancel any in-flight tasks materialized by this schedule so no late effect commits.
      for (const task of linkedTasks) {
        if (isTerminalTaskStatus(task.status)) continue;
        eventCoordinator.cancelEntityOutboxSync('task', task.id, now);
        eventCoordinator.cancelEntityOutboxSync('handoff', task.id, now);
        if (task.status === 'running') {
          this.sql.exec(
            `UPDATE tasks
                SET cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
                    updated_at_ms = ?
              WHERE id = ?`,
            now,
            now,
            task.id,
          );
        } else {
          this.sql.exec(
            `UPDATE tasks
                SET status = 'cancelled',
                    cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
                    lease_expires_at_ms = NULL,
                    updated_at_ms = ?
              WHERE id = ?`,
            now,
            now,
            task.id,
          );
          appendTaskEventSync(this.sql, {
            id: this.deps.newId(),
            taskId: task.id,
            phase: 'cancelled',
            traceId: cmd.requestId,
            nowMs: now,
            payload: { reason: 'schedule_cancelled', scheduleId: row.schedule_id },
          });
        }
      }

      const alarmAtMs = eventCoordinator.recomputeAlarmSync(now);
      const updated = this.findOwnedScheduleSync(cmd.principalId, row.schedule_id)!;
      return { snapshot: this.toSnapshot(updated), alarmAtMs, now };
    });

    if (tx.alarmAtMs !== undefined && recoveryHooks.syncPlatformAlarm !== undefined) {
      await recoveryHooks.syncPlatformAlarm(tx.alarmAtMs, tx.now);
    }
    return tx.snapshot;
  }

  private findByIdempotencyKeySync(idempotencyKey: string): ProactiveScheduleRow | null {
    return sqlExecMaybe<ProactiveScheduleRow>(
      this.sql,
      `SELECT * FROM proactive_schedules WHERE idempotency_key = ?`,
      idempotencyKey,
    );
  }

  private findOwnedScheduleSync(principalId: string, scheduleId: string): JoinedScheduleRow | null {
    return sqlExecMaybe<JoinedScheduleRow>(
      this.sql,
      `${JOINED_SCHEDULE_SELECT}
       WHERE p.principal_id = ? AND p.schedule_id = ?`,
      principalId,
      scheduleId,
    );
  }

  private listRecentRunsSync(
    scheduleId: string,
    limit: number,
  ): readonly ProactiveScheduleRunSnapshot[] {
    const rows = sqlExecAll<JoinedRunRow>(
      this.sql,
      `SELECT r.occurrence_seq,
              r.task_id,
              r.scheduled_for_ms,
              t.status,
              t.linked_message_id,
              tr.summary_text,
              tr.detail_text,
              tr.reason_code,
              tr.produced_at_ms
         FROM proactive_schedule_runs r
         JOIN tasks t ON t.id = r.task_id
    LEFT JOIN task_results tr ON tr.task_id = t.id
        WHERE r.schedule_id = ?
        ORDER BY r.occurrence_seq DESC
        LIMIT ?`,
      scheduleId,
      limit,
    );
    return rows.map(toRunSnapshot);
  }

  private toSnapshot(
    row: JoinedScheduleRow,
    latestRunOverride?: ProactiveScheduleRunSnapshot | null,
  ): ProactiveScheduleSnapshot {
    const latestRun =
      latestRunOverride !== undefined
        ? latestRunOverride
        : (this.listRecentRunsSync(row.schedule_id, 1)[0] ?? null);
    return {
      scheduleId: row.schedule_id,
      kind: row.kind,
      title: row.title,
      prompt: row.prompt,
      deliveryMode: row.delivery_mode,
      status: row.status,
      scheduleKind: row.schedule_kind,
      intervalSeconds: row.interval_seconds,
      cronExpr: row.cron_expr,
      timezone: row.timezone,
      misfirePolicy: row.misfire_policy,
      nextFireAt: row.status === 'active' ? toIsoTimestamp(row.next_fire_at_ms) : null,
      lastFiredAt: row.last_fired_at_ms !== null ? toIsoTimestamp(row.last_fired_at_ms) : null,
      occurrenceCount: row.occurrence_seq,
      version: row.version,
      createdAt: toIsoTimestamp(row.ps_created_at_ms),
      updatedAt: toIsoTimestamp(Math.max(row.ps_updated_at_ms, row.updated_at_ms)),
      latestRun,
    };
  }
}
