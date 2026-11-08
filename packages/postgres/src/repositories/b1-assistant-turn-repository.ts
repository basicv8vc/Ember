import { IdSchema, toInvalidArgumentError, type B1AssistantTurnDto } from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import type pg from 'pg';
import { z } from 'zod';
import type { B1AssistantTurnRepository } from './b1-interfaces.js';
import {
  B1_ASSISTANT_TURN_FAILURE_MESSAGE,
  B1_ASSISTANT_TURN_MODEL_LABEL,
  SIMULATED_MODEL_IDENTITY,
  insertTurnResponse,
  isExpired,
  lockTurn,
  markTurnCompleted,
  markTurnFailed,
  toTurnDto,
  turnColumns,
  type AssistantTurnSourceMessage,
  type PendingAssistantTurn,
  type TurnRow,
} from './b1-turn-publication.js';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

export {
  B1_ASSISTANT_TURN_FAILURE_MESSAGE,
  B1_ASSISTANT_TURN_MODEL_LABEL,
  type AssistantTurnSourceMessage,
  type PendingAssistantTurn,
} from './b1-turn-publication.js';

export const B1_ASSISTANT_TURN_BATCH_LIMIT = 100;

export interface PostgresB1AssistantTurnRepositoryOptions {
  /**
   * Whether a read of an overdue running Turn should terminalize it as a timeout. Shared APIs
   * disable this so polling cannot synthesize a reply; worker repositories keep the default
   * because their responder owns timeout terminalization. With this disabled, an explicit cancel
   * wins even after the deadline.
   */
  readonly expireOnRead?: boolean;
}

/**
 * B1-5 durable Turn lifecycle repository.
 *
 * Every lifecycle transaction locks `conversations` before `assistant_turns`. This is the same
 * order used by user-message submission and transcript deletion: it serializes sequence allocation
 * with appends and makes deletion win cleanly without a stale responder recreating content.
 *
 * This repository publishes **simulated** replies only. Publishing real model output requires the
 * lease fence in `PostgresModelTurnExecutionRepository`, so `simulated: false` is unreachable from
 * here by construction.
 */
export class PostgresB1AssistantTurnRepository implements B1AssistantTurnRepository {
  private readonly expireOnRead: boolean;

  constructor(
    private readonly pool: pg.Pool,
    options: PostgresB1AssistantTurnRepositoryOptions = {},
  ) {
    this.expireOnRead = options.expireOnRead ?? true;
  }

  async getTurn(command: {
    readonly tenantId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
  }): Promise<B1AssistantTurnDto | null> {
    const identity = parseIdentity(command);

    return withTransaction(this.pool, async (client) => {
      const locked = await lockTurn(client, identity);

      if (locked === null) {
        return null;
      }

      if (this.expireOnRead && locked.status === 'running' && (await isExpired(client, locked))) {
        return expireTurn(client, identity);
      }

      return toTurnDto(locked);
    });
  }

  async finishTurn(command: {
    readonly tenantId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
    readonly result:
      | {
          readonly status: 'completed';
          readonly text: string;
          readonly modelLabel: string;
          readonly simulated: boolean;
        }
      | {
          readonly status: 'failed';
          readonly failureReason: 'timeout' | 'internal_error';
          readonly safeMessage: string;
        };
  }): Promise<B1AssistantTurnDto> {
    const parsed = finishCommandSchema.safeParse(command);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const { tenantId, conversationId, turnId, result } = parsed.data;
    const identity = { tenantId, conversationId, turnId };

    return withTransaction(this.pool, async (client) => {
      const locked = await lockTurn(client, identity);

      if (locked === null) {
        throw new DomainError('NOT_FOUND', 'turn is not visible in this tenant');
      }

      // A completion/failure that committed earlier is the retry result. Never allocate a second
      // response Message, even when the caller lost the first acknowledgement.
      if (locked.status !== 'running') {
        return toTurnDto(locked);
      }

      if (result.status === 'failed') {
        return failRunningTurn(client, identity, result.failureReason);
      }

      return completeRunningTurn(client, identity, result.text);
    });
  }

  async cancelTurn(command: {
    readonly tenantId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
  }): Promise<B1AssistantTurnDto> {
    const identity = parseIdentity(command);

    return withTransaction(this.pool, async (client) => {
      const locked = await lockTurn(client, identity);

      if (locked === null) {
        throw new DomainError('NOT_FOUND', 'turn is not visible in this tenant');
      }

      if (locked.status !== 'running') {
        return toTurnDto(locked);
      }

      if (this.expireOnRead && (await isExpired(client, locked))) {
        return expireTurn(client, identity);
      }

      const updated = await client.query<TurnRow>(
        `
WITH decision AS (SELECT clock_timestamp() AS now)
UPDATE assistant_turns t
   SET status = 'cancelled',
       failure_reason = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = decision.now
  FROM decision
 WHERE t.tenant_id = $1 AND t.conversation_id = $2 AND t.id = $3
   AND t.status = 'running'
   AND ($4::boolean OR t.deadline_at > decision.now)
RETURNING ${turnColumns('t')}`,
        [identity.tenantId, identity.conversationId, identity.turnId, !this.expireOnRead],
      );
      const row = updated.rows[0];

      if (row === undefined) {
        // The deadline may have crossed after the first clock check. The turn row is still locked,
        // so timeout wins deterministically and publishes its safe Message in this transaction.
        return expireTurn(client, identity);
      }

      return toTurnDto(row);
    });
  }

  /** Read-only candidate scan; row ownership is rechecked under locks before every transition. */
  async listRunningTurns(limit = B1_ASSISTANT_TURN_BATCH_LIMIT): Promise<PendingAssistantTurn[]> {
    const parsed = listRunningSchema.safeParse({ limit });

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    try {
      const result = await this.pool.query<{
        readonly tenant_id: string;
        readonly conversation_id: string;
        readonly turn_id: string;
      }>(
        `
SELECT tenant_id, conversation_id, id AS turn_id
  FROM assistant_turns
 WHERE status = 'running'
 ORDER BY deadline_at ASC, created_at ASC, id ASC
 LIMIT $1::int`,
        [parsed.data.limit],
      );

      return result.rows.map((row) => ({
        tenantId: row.tenant_id,
        conversationId: row.conversation_id,
        turnId: row.turn_id,
      }));
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Load the immutable source text only while the exact tenant-qualified Turn is still running.
   * It is returned to the generator but never logged or included in a worker diagnostic.
   */
  async getSourceMessage(
    command: PendingAssistantTurn,
  ): Promise<AssistantTurnSourceMessage | null> {
    const identity = parseIdentity(command);

    try {
      const result = await this.pool.query<{
        readonly text: string;
        readonly deadline_at: Date | string;
      }>(
        `
SELECT m.text, t.deadline_at
  FROM assistant_turns t
  JOIN conversation_messages m
    ON m.tenant_id = t.tenant_id
   AND m.conversation_id = t.conversation_id
   AND m.id = t.source_message_id
   AND m.kind = 'user'
 WHERE t.tenant_id = $1 AND t.conversation_id = $2 AND t.id = $3
   AND t.status = 'running'`,
        [identity.tenantId, identity.conversationId, identity.turnId],
      );
      const row = result.rows[0];

      if (row === undefined) {
        return null;
      }

      return {
        ...identity,
        text: row.text,
        deadlineAt: toIsoTimestamp(row.deadline_at),
      };
    } catch (error) {
      throw asDomainError(error);
    }
  }
}

const identitySchema = z.strictObject({
  tenantId: IdSchema,
  conversationId: IdSchema,
  turnId: IdSchema,
});

const resultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'),
    text: z.string().min(1).max(8192),
    // B1-5 publishes simulated output only. Real output is reachable solely through the
    // lease-fenced B2 path, so this stays a literal instead of widening the frozen B1 seam.
    modelLabel: z.literal(B1_ASSISTANT_TURN_MODEL_LABEL),
    simulated: z.literal(true),
  }),
  z.strictObject({
    status: z.literal('failed'),
    failureReason: z.enum(['timeout', 'internal_error']),
    // Required by the frozen persistence interface, but not trusted or persisted. Every failure
    // gets B1_ASSISTANT_TURN_FAILURE_MESSAGE below, irrespective of caller-supplied text.
    safeMessage: z.string().min(1).max(8192),
  }),
]);

const finishCommandSchema = z.strictObject({
  ...identitySchema.shape,
  result: resultSchema,
});

const listRunningSchema = z.strictObject({
  limit: z.number().int().min(1).max(B1_ASSISTANT_TURN_BATCH_LIMIT),
});

function parseIdentity(command: PendingAssistantTurn): PendingAssistantTurn {
  const parsed = identitySchema.safeParse(command);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

async function completeRunningTurn(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
  text: string,
): Promise<B1AssistantTurnDto> {
  const responseMessageId = await insertTurnResponse(
    client,
    identity,
    text,
    SIMULATED_MODEL_IDENTITY,
  );
  const row = await markTurnCompleted(client, identity, responseMessageId);

  if (row === null) {
    throw new DomainError('DB_UNAVAILABLE', 'locked turn did not accept completion');
  }

  return toTurnDto(row);
}

async function failRunningTurn(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
  requestedReason: 'timeout' | 'internal_error',
): Promise<B1AssistantTurnDto> {
  const responseMessageId = await insertTurnResponse(
    client,
    identity,
    B1_ASSISTANT_TURN_FAILURE_MESSAGE,
    SIMULATED_MODEL_IDENTITY,
  );
  const row = await markTurnFailed(client, identity, responseMessageId, requestedReason);

  if (row === null) {
    throw new DomainError('DB_UNAVAILABLE', 'locked turn did not accept failure');
  }

  return toTurnDto(row);
}

async function expireTurn(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
): Promise<B1AssistantTurnDto> {
  return failRunningTurn(client, identity, 'timeout');
}
