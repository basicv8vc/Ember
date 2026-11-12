import { DomainError } from '@ember/domain';
import type pg from 'pg';
import { z } from 'zod';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface B1TurnDispatchEnvelope {
  readonly schemaVersion: 1;
  /** Stable PostgreSQL outbox key; currently the Assistant Turn ID. */
  readonly eventId: string;
  readonly tenantId: string;
  readonly turnId: string;
}

export type B1TurnDispatchStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface B1TurnDispatchEvent extends B1TurnDispatchEnvelope {
  readonly conversationId: string;
  readonly status: B1TurnDispatchStatus;
  readonly deadlineAt: string;
  readonly leaseExpiresAt: string | null;
  /** Remaining live lease measured against PostgreSQL's clock, never the Worker clock. */
  readonly leaseRemainingMs: number;
}

interface B1TurnDispatchOutboxRow {
  readonly turn_id: string;
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly status: B1TurnDispatchStatus;
  readonly deadline_at: Date | string;
  readonly lease_expires_at: Date | string | null;
  readonly lease_remaining_ms: number | string;
}

const identitySchema = z.object({
  eventId: z.string().regex(UUID_PATTERN),
  tenantId: z.string().regex(UUID_PATTERN),
  turnId: z.string().regex(UUID_PATTERN),
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

function toEvent(row: B1TurnDispatchOutboxRow): B1TurnDispatchEvent {
  return Object.freeze({
    schemaVersion: 1,
    eventId: row.turn_id,
    tenantId: row.tenant_id,
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    status: row.status,
    deadlineAt: toIso(row.deadline_at),
    leaseExpiresAt: row.lease_expires_at === null ? null : toIso(row.lease_expires_at),
    leaseRemainingMs: Math.max(0, Math.ceil(Number(row.lease_remaining_ms))),
  });
}

/**
 * Parse a closed, prompt-free transport envelope. Queue fields are hints only; runtime code must
 * resolve the event from PostgreSQL and use the tenant/conversation returned by that lookup.
 */
export function parseB1TurnDispatchEnvelope(value: unknown): B1TurnDispatchEnvelope | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(',') !== 'eventId,schemaVersion,tenantId,turnId') {
    return null;
  }

  const parsed = identitySchema.safeParse(candidate);
  if (
    !parsed.success ||
    candidate.schemaVersion !== 1 ||
    parsed.data.eventId !== parsed.data.turnId
  ) {
    return null;
  }

  return Object.freeze({ schemaVersion: 1, ...parsed.data });
}

/**
 * Insert beside the Assistant Turn, inside the same transaction that stores the user Message and
 * Turn. This helper intentionally does not start or commit a transaction of its own.
 */
export async function insertB1TurnDispatchOutbox(
  client: Pick<pg.PoolClient, 'query'>,
  command: { readonly tenantId: string; readonly turnId: string },
): Promise<void> {
  const parsed = z
    .object({ tenantId: z.string().regex(UUID_PATTERN), turnId: z.string().regex(UUID_PATTERN) })
    .safeParse(command);

  if (!parsed.success) {
    throw new DomainError('INVALID_ARGUMENT', 'invalid Assistant Turn outbox identity');
  }

  await client.query(
    `INSERT INTO b1_turn_dispatch_outbox (tenant_id, turn_id)
     VALUES ($1, $2)`,
    [parsed.data.tenantId, parsed.data.turnId],
  );
}

/** PostgreSQL-only authority for dispatch state; the Queue never grants a Turn lease. */
export class PostgresB1TurnDispatchOutboxRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Select the one Turn a pre-authorized Staging Alpha conversation may execute. This deliberately
   * includes terminal Turns: once the first Turn after the approval watermark exists, no later Turn
   * in that Conversation can become authorized after completion, cancellation, or queue recovery.
   */
  async getFirstTurnCreatedAfter(command: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly createdAfter: string;
  }): Promise<string | null> {
    const parsed = z
      .strictObject({
        tenantId: z.string().regex(UUID_PATTERN),
        conversationId: z.string().regex(UUID_PATTERN),
        createdAfter: z.string().datetime({ offset: true }),
      })
      .safeParse(command);
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid Assistant Turn authorization scope');
    }

    try {
      const result = await this.pool.query<{ readonly id: string }>(
        `SELECT id
           FROM assistant_turns
          WHERE tenant_id = $1
            AND conversation_id = $2
            AND created_at > $3::timestamptz
          ORDER BY created_at ASC, id ASC
          LIMIT 1`,
        [parsed.data.tenantId, parsed.data.conversationId, parsed.data.createdAfter],
      );
      return result.rows[0]?.id ?? null;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async getEvent(eventId: string): Promise<B1TurnDispatchEvent | null> {
    const parsed = z.string().regex(UUID_PATTERN).safeParse(eventId);
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid Assistant Turn outbox event id');
    }

    try {
      const result = await this.pool.query<B1TurnDispatchOutboxRow>(
        `SELECT o.turn_id,
                o.tenant_id,
                t.conversation_id,
                t.status,
                t.deadline_at,
                t.lease_expires_at,
                GREATEST(0, CEIL(EXTRACT(EPOCH FROM (t.lease_expires_at - clock_timestamp())) * 1000))
                  AS lease_remaining_ms
           FROM b1_turn_dispatch_outbox o
           JOIN assistant_turns t
             ON t.tenant_id = o.tenant_id AND t.id = o.turn_id
          WHERE o.turn_id = $1`,
        [parsed.data],
      );

      const row = result.rows[0];
      return row === undefined ? null : toEvent(row);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /** Claim due PostgreSQL outbox rows; callers publish Queue messages after this short transaction. */
  async claimDue(command: {
    readonly limit: number;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<readonly B1TurnDispatchEvent[]> {
    const parsed = claimSchema.safeParse(command);
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid Assistant Turn outbox claim');
    }

    try {
      return await withTransaction(this.pool, async (client) => {
        // Safety net for historical/API writers that committed a running Turn before the outbox
        // hook was deployed. Current API code inserts this row in the Turn transaction; this
        // reconciliation makes a missing hook visible as queued work instead of a silent orphan.
        await client.query(
          `INSERT INTO b1_turn_dispatch_outbox (tenant_id, turn_id)
           SELECT t.tenant_id, t.id
             FROM assistant_turns t
            WHERE t.status = 'running'
           ON CONFLICT (turn_id) DO NOTHING`,
        );

        await client.query(
          `UPDATE b1_turn_dispatch_outbox o
              SET completed_at = COALESCE(o.completed_at, clock_timestamp()),
                  dispatch_lease_owner = NULL,
                  dispatch_lease_expires_at = NULL
             FROM assistant_turns t
            WHERE t.tenant_id = o.tenant_id
              AND t.id = o.turn_id
              AND t.status <> 'running'
              AND o.completed_at IS NULL`,
        );

        const result = await client.query<B1TurnDispatchOutboxRow>(
          `WITH candidates AS (
             SELECT o.turn_id
               FROM b1_turn_dispatch_outbox o
               JOIN assistant_turns t
                 ON t.tenant_id = o.tenant_id AND t.id = o.turn_id
              WHERE t.status = 'running'
                AND o.completed_at IS NULL
                AND o.next_dispatch_at <= clock_timestamp()
                AND (o.dispatch_lease_expires_at IS NULL
                     OR o.dispatch_lease_expires_at <= clock_timestamp())
              ORDER BY o.next_dispatch_at, o.created_at, o.turn_id
              LIMIT $1::int
              FOR UPDATE OF o SKIP LOCKED
           )
           UPDATE b1_turn_dispatch_outbox o
              SET dispatch_lease_owner = $2,
                  dispatch_lease_expires_at = clock_timestamp() + ($3::int * interval '1 millisecond'),
                  dispatch_attempts = o.dispatch_attempts + 1
             FROM candidates c, assistant_turns t
            WHERE o.turn_id = c.turn_id
              AND t.tenant_id = o.tenant_id
              AND t.id = o.turn_id
           RETURNING o.turn_id, o.tenant_id, t.conversation_id, t.status,
                     t.deadline_at, t.lease_expires_at,
                     GREATEST(0, CEIL(EXTRACT(EPOCH FROM (t.lease_expires_at - clock_timestamp())) * 1000))
                       AS lease_remaining_ms`,
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
      throw new DomainError('INVALID_ARGUMENT', 'invalid Assistant Turn outbox publication');
    }

    try {
      const result = await this.pool.query(
        `UPDATE b1_turn_dispatch_outbox
            SET last_enqueued_at = clock_timestamp(),
                next_dispatch_at = clock_timestamp() + ($3::int * interval '1 millisecond'),
                dispatch_lease_owner = NULL,
                dispatch_lease_expires_at = NULL,
                last_error_code = NULL
          WHERE turn_id = $1
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
      throw new DomainError('INVALID_ARGUMENT', 'invalid Assistant Turn outbox release');
    }

    try {
      const result = await this.pool.query(
        `UPDATE b1_turn_dispatch_outbox
            SET next_dispatch_at = clock_timestamp() + ($3::int * interval '1 millisecond'),
                dispatch_lease_owner = NULL,
                dispatch_lease_expires_at = NULL,
                last_error_code = $4
          WHERE turn_id = $1
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

  /** Record a valid Queue delivery and push the reconciliation retry out from now. */
  async deferNextDispatch(eventId: string, delayMs: number): Promise<boolean> {
    const parsed = z
      .object({ eventId: z.string().regex(UUID_PATTERN), delayMs: delaySchema })
      .safeParse({ eventId, delayMs });
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid Assistant Turn outbox defer');
    }

    try {
      const result = await this.pool.query(
        `UPDATE b1_turn_dispatch_outbox
            SET last_enqueued_at = COALESCE(last_enqueued_at, clock_timestamp()),
                next_dispatch_at = clock_timestamp() + ($2::int * interval '1 millisecond')
          WHERE turn_id = $1 AND completed_at IS NULL`,
        [parsed.data.eventId, parsed.data.delayMs],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /** Complete only after PostgreSQL says the Turn is terminal. */
  async markCompleted(eventId: string): Promise<boolean> {
    const parsed = z.string().regex(UUID_PATTERN).safeParse(eventId);
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid Assistant Turn outbox event id');
    }

    try {
      const result = await this.pool.query(
        `UPDATE b1_turn_dispatch_outbox o
            SET completed_at = COALESCE(o.completed_at, clock_timestamp()),
                dispatch_lease_owner = NULL,
                dispatch_lease_expires_at = NULL
           FROM assistant_turns t
          WHERE o.turn_id = $1
            AND t.tenant_id = o.tenant_id
            AND t.id = o.turn_id
            AND t.status <> 'running'`,
        [parsed.data],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /** DLQ is a transport signal, not a terminal Turn state; make the DB row eligible for replay. */
  async makeDue(eventId: string, retryAfterMs: number): Promise<boolean> {
    const parsed = z
      .object({ eventId: z.string().regex(UUID_PATTERN), retryAfterMs: delaySchema })
      .safeParse({ eventId, retryAfterMs });
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid Assistant Turn outbox replay');
    }

    try {
      const result = await this.pool.query(
        `UPDATE b1_turn_dispatch_outbox o
            SET next_dispatch_at = clock_timestamp() + ($2::int * interval '1 millisecond'),
                dispatch_lease_owner = NULL,
                dispatch_lease_expires_at = NULL,
                last_error_code = 'queue_unavailable'
           FROM assistant_turns t
          WHERE o.turn_id = $1
            AND t.tenant_id = o.tenant_id
            AND t.id = o.turn_id
            AND t.status = 'running'
            AND o.completed_at IS NULL`,
        [parsed.data.eventId, parsed.data.retryAfterMs],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw asDomainError(error);
    }
  }
}
