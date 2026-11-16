import { DomainError, type TaskStatus } from '@ember/domain';
import type pg from 'pg';
import { z } from 'zod';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface B3TaskDispatchEnvelope {
  readonly schemaVersion: 1;
  /** Stable PostgreSQL outbox key: the Task ID. */
  readonly eventId: string;
  readonly tenantId: string;
  readonly taskId: string;
}

export interface B3TaskDispatchEvent extends B3TaskDispatchEnvelope {
  readonly kind: 'python.agent';
  readonly status: TaskStatus;
  readonly leaseRemainingMs: number;
  readonly deadlineAt: string | null;
  readonly nextRunAt: string | null;
}

interface B3TaskDispatchOutboxRow {
  readonly task_id: string;
  readonly tenant_id: string;
  readonly status: TaskStatus;
  readonly lease_remaining_ms: number | string;
  readonly deadline_at: Date | string | null;
  readonly next_run_at: Date | string | null;
}

const identitySchema = z.object({
  eventId: z.string().regex(UUID_PATTERN),
  tenantId: z.string().regex(UUID_PATTERN),
  taskId: z.string().regex(UUID_PATTERN),
});

const claimSchema = z.object({
  limit: z.number().int().min(1).max(100),
  workerId: z.string().min(1).max(128),
  leaseMs: z.number().int().min(1_000).max(60_000),
});

const delaySchema = z.number().int().min(1_000).max(86_400_000);

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : toIsoTimestamp(value);
}

function toEvent(row: B3TaskDispatchOutboxRow): B3TaskDispatchEvent {
  const leaseRemaining = Number(row.lease_remaining_ms);
  return Object.freeze({
    schemaVersion: 1,
    eventId: row.task_id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    kind: 'python.agent',
    status: row.status,
    leaseRemainingMs:
      Number.isFinite(leaseRemaining) && leaseRemaining > 0 ? Math.trunc(leaseRemaining) : 0,
    deadlineAt: row.deadline_at === null ? null : toIso(row.deadline_at),
    nextRunAt: row.next_run_at === null ? null : toIso(row.next_run_at),
  });
}

/**
 * Parse a closed, prompt-free transport envelope for `python.agent` Tasks.
 * Queue payloads are wake-up hints only; runtime workers resolve state from PostgreSQL.
 */
export function parseB3TaskDispatchEnvelope(value: unknown): B3TaskDispatchEnvelope | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(',') !== 'eventId,schemaVersion,taskId,tenantId') {
    return null;
  }

  const parsed = identitySchema.safeParse(candidate);
  if (
    !parsed.success ||
    candidate.schemaVersion !== 1 ||
    parsed.data.eventId !== parsed.data.taskId
  ) {
    return null;
  }

  return Object.freeze({ schemaVersion: 1, ...parsed.data });
}

/**
 * Insert beside a `python.agent` Task inside the creating transaction.
 */
export async function insertB3TaskDispatchOutbox(
  client: Pick<pg.PoolClient, 'query'>,
  command: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly nextDispatchAt?: string | Date | null;
  },
): Promise<void> {
  const parsed = z
    .object({
      tenantId: z.string().regex(UUID_PATTERN),
      taskId: z.string().regex(UUID_PATTERN),
    })
    .safeParse({ tenantId: command.tenantId, taskId: command.taskId });

  if (!parsed.success) {
    throw new DomainError('INVALID_ARGUMENT', 'invalid B3 task outbox identity');
  }

  const nextDispatchAt =
    command.nextDispatchAt === undefined || command.nextDispatchAt === null
      ? null
      : typeof command.nextDispatchAt === 'string'
        ? command.nextDispatchAt
        : command.nextDispatchAt.toISOString();

  await client.query(
    `INSERT INTO b3_task_dispatch_outbox (tenant_id, task_id, kind, next_dispatch_at)
     VALUES ($1, $2, 'python.agent', COALESCE($3::timestamptz, clock_timestamp()))
     ON CONFLICT (task_id) DO UPDATE
       SET next_dispatch_at = EXCLUDED.next_dispatch_at,
           completed_at = NULL,
           dispatch_lease_owner = NULL,
           dispatch_lease_expires_at = NULL`,
    [parsed.data.tenantId, parsed.data.taskId, nextDispatchAt],
  );
}

/** Edge-safe PostgreSQL outbox repository for `python.agent` Queue wake-up dispatch & reconciliation. */
export class PostgresB3TaskDispatchOutboxRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getEvent(eventId: string): Promise<B3TaskDispatchEvent | null> {
    const parsed = z.string().regex(UUID_PATTERN).safeParse(eventId);
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid B3 task outbox event id');
    }

    try {
      const result = await this.pool.query<B3TaskDispatchOutboxRow>(
        `SELECT o.task_id,
                o.tenant_id,
                t.status,
                CASE
                  WHEN t.status = 'running' AND t.lease_expires_at IS NOT NULL
                    THEN GREATEST(0, CEIL(EXTRACT(EPOCH FROM (t.lease_expires_at - clock_timestamp())) * 1000))::int
                  ELSE 0
                END AS lease_remaining_ms,
                t.deadline_at,
                t.next_run_at
           FROM b3_task_dispatch_outbox o
           JOIN tasks t
             ON t.tenant_id = o.tenant_id AND t.id = o.task_id
          WHERE o.task_id = $1`,
        [parsed.data],
      );
      const row = result.rows[0];
      return row === undefined ? null : toEvent(row);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async claimDue(command: {
    readonly limit: number;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<readonly B3TaskDispatchEvent[]> {
    const parsed = claimSchema.safeParse(command);
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid B3 task outbox claim');
    }

    try {
      return await withTransaction(this.pool, async (client) => {
        // Reconcile any python.agent Task missing an outbox row.
        await client.query(
          `INSERT INTO b3_task_dispatch_outbox (tenant_id, task_id, kind, next_dispatch_at)
           SELECT t.tenant_id, t.id, 'python.agent', COALESCE(t.next_run_at, clock_timestamp())
             FROM tasks t
            WHERE t.kind = 'python.agent'
              AND t.status IN ('queued', 'retryable_failed', 'running')
           ON CONFLICT (task_id) DO NOTHING`,
        );

        // Complete outbox entries whose Task is already terminal or waiting approval.
        await client.query(
          `UPDATE b3_task_dispatch_outbox o
              SET completed_at = COALESCE(o.completed_at, clock_timestamp()),
                  dispatch_lease_owner = NULL,
                  dispatch_lease_expires_at = NULL
             FROM tasks t
            WHERE t.tenant_id = o.tenant_id
              AND t.id = o.task_id
              AND t.status IN ('completed', 'failed', 'cancelled', 'waiting_approval')
              AND o.completed_at IS NULL`,
        );

        const result = await client.query<B3TaskDispatchOutboxRow>(
          `WITH candidates AS (
             SELECT o.task_id
               FROM b3_task_dispatch_outbox o
               JOIN tasks t
                 ON t.tenant_id = o.tenant_id AND t.id = o.task_id
               LEFT JOIN runs r
                 ON r.tenant_id = t.tenant_id AND r.id = t.current_run_id
              WHERE t.kind = 'python.agent'
                AND o.completed_at IS NULL
                AND o.next_dispatch_at <= clock_timestamp()
                AND (t.next_run_at IS NULL OR t.next_run_at <= clock_timestamp())
                AND (
                  t.status IN ('queued', 'retryable_failed')
                  OR (t.status = 'running' AND (r.leased_until IS NULL OR r.leased_until <= clock_timestamp()))
                )
                AND (o.dispatch_lease_expires_at IS NULL OR o.dispatch_lease_expires_at <= clock_timestamp())
              ORDER BY o.next_dispatch_at, o.created_at, o.task_id
              LIMIT $1::int
              FOR UPDATE OF o SKIP LOCKED
           )
           UPDATE b3_task_dispatch_outbox o
              SET dispatch_lease_owner = $2,
                  dispatch_lease_expires_at = clock_timestamp() + ($3::int * interval '1 millisecond'),
                  dispatch_attempts = o.dispatch_attempts + 1
             FROM candidates c, tasks t
            WHERE o.task_id = c.task_id
              AND t.tenant_id = o.tenant_id
              AND t.id = o.task_id
           RETURNING o.task_id,
                     o.tenant_id,
                     t.status,
                     CASE
                       WHEN t.status = 'running' AND t.lease_expires_at IS NOT NULL
                         THEN GREATEST(0, CEIL(EXTRACT(EPOCH FROM (t.lease_expires_at - clock_timestamp())) * 1000))::int
                       ELSE 0
                     END AS lease_remaining_ms,
                     t.deadline_at,
                     t.next_run_at`,
          [parsed.data.limit, parsed.data.workerId, parsed.data.leaseMs],
        );

        return Object.freeze(result.rows.map(toEvent));
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async markEnqueued(command: {
    readonly eventId: string;
    readonly workerId: string;
    readonly reenqueueAfterMs: number;
  }): Promise<boolean> {
    const parsed = z
      .object({
        eventId: z.string().regex(UUID_PATTERN),
        workerId: z.string().min(1).max(128),
        reenqueueAfterMs: delaySchema,
      })
      .safeParse(command);
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid B3 task outbox publication');
    }

    try {
      const result = await this.pool.query(
        `UPDATE b3_task_dispatch_outbox
            SET last_enqueued_at = clock_timestamp(),
                next_dispatch_at = clock_timestamp() + ($3::int * interval '1 millisecond'),
                dispatch_lease_owner = NULL,
                dispatch_lease_expires_at = NULL,
                last_error_code = NULL
          WHERE task_id = $1
            AND dispatch_lease_owner = $2
            AND completed_at IS NULL`,
        [parsed.data.eventId, parsed.data.workerId, parsed.data.reenqueueAfterMs],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async release(command: {
    readonly eventId: string;
    readonly workerId: string;
    readonly retryAfterMs: number;
    readonly errorCode: 'queue_unavailable' | 'database_unavailable';
  }): Promise<boolean> {
    const parsed = z
      .object({
        eventId: z.string().regex(UUID_PATTERN),
        workerId: z.string().min(1).max(128),
        retryAfterMs: delaySchema,
        errorCode: z.enum(['queue_unavailable', 'database_unavailable']),
      })
      .safeParse(command);
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid B3 task outbox release');
    }

    try {
      const result = await this.pool.query(
        `UPDATE b3_task_dispatch_outbox
            SET next_dispatch_at = clock_timestamp() + ($3::int * interval '1 millisecond'),
                dispatch_lease_owner = NULL,
                dispatch_lease_expires_at = NULL,
                last_error_code = $4
          WHERE task_id = $1
            AND dispatch_lease_owner = $2
            AND completed_at IS NULL`,
        [
          parsed.data.eventId,
          parsed.data.workerId,
          parsed.data.retryAfterMs,
          parsed.data.errorCode,
        ],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async deferNextDispatch(eventId: string, delayMs: number): Promise<boolean> {
    const parsed = z
      .object({ eventId: z.string().regex(UUID_PATTERN), delayMs: delaySchema })
      .safeParse({ eventId, delayMs });
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid B3 task outbox defer');
    }

    try {
      const result = await this.pool.query(
        `UPDATE b3_task_dispatch_outbox
            SET last_enqueued_at = COALESCE(last_enqueued_at, clock_timestamp()),
                next_dispatch_at = clock_timestamp() + ($2::int * interval '1 millisecond')
          WHERE task_id = $1 AND completed_at IS NULL`,
        [parsed.data.eventId, parsed.data.delayMs],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async markCompleted(eventId: string): Promise<boolean> {
    const parsed = z.string().regex(UUID_PATTERN).safeParse(eventId);
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid B3 task outbox event id');
    }

    try {
      const result = await this.pool.query(
        `UPDATE b3_task_dispatch_outbox o
            SET completed_at = COALESCE(o.completed_at, clock_timestamp()),
                dispatch_lease_owner = NULL,
                dispatch_lease_expires_at = NULL
           FROM tasks t
          WHERE o.task_id = $1
            AND t.tenant_id = o.tenant_id
            AND t.id = o.task_id
            AND t.status IN ('completed', 'failed', 'cancelled', 'waiting_approval')`,
        [parsed.data],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async makeDue(eventId: string, retryAfterMs: number): Promise<boolean> {
    const parsed = z
      .object({ eventId: z.string().regex(UUID_PATTERN), retryAfterMs: delaySchema })
      .safeParse({ eventId, retryAfterMs });
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid B3 task outbox replay');
    }

    try {
      const result = await this.pool.query(
        `UPDATE b3_task_dispatch_outbox o
            SET next_dispatch_at = clock_timestamp() + ($2::int * interval '1 millisecond'),
                dispatch_lease_owner = NULL,
                dispatch_lease_expires_at = NULL,
                last_error_code = 'queue_unavailable'
           FROM tasks t
          WHERE o.task_id = $1
            AND t.tenant_id = o.tenant_id
            AND t.id = o.task_id
            AND t.status IN ('queued', 'retryable_failed', 'running')
            AND o.completed_at IS NULL`,
        [parsed.data.eventId, parsed.data.retryAfterMs],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw asDomainError(error);
    }
  }
}
