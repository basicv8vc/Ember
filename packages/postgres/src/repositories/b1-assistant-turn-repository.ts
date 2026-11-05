import { randomUUID } from 'node:crypto';
import {
  B1AssistantTurnDtoSchema,
  IdSchema,
  toInvalidArgumentError,
  type B1AssistantTurnDto,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import { FAKE_LLM_MODEL } from '@ember/execution';
import type pg from 'pg';
import { z } from 'zod';
import type { B1AssistantTurnRepository } from './b1-interfaces.js';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

/** Every B1 assistant Message is explicitly marked as simulated and uses this model label. */
export const B1_ASSISTANT_TURN_MODEL_LABEL = FAKE_LLM_MODEL;

/** Fixed user-safe text; exception, SQL and provider details never enter a failed reply. */
export const B1_ASSISTANT_TURN_FAILURE_MESSAGE =
  'This simulated reply could not be completed. Please try again.';

export const B1_ASSISTANT_TURN_BATCH_LIMIT = 100;

export interface PendingAssistantTurn {
  readonly tenantId: Id;
  readonly conversationId: Id;
  readonly turnId: Id;
}

export interface AssistantTurnSourceMessage extends PendingAssistantTurn {
  readonly text: string;
  readonly deadlineAt: string;
}

/**
 * B1-5 durable Turn lifecycle repository.
 *
 * Every lifecycle transaction locks `conversations` before `assistant_turns`. This is the same
 * order used by user-message submission and transcript deletion: it serializes sequence allocation
 * with appends and makes deletion win cleanly without a stale responder recreating content.
 */
export class PostgresB1AssistantTurnRepository implements B1AssistantTurnRepository {
  constructor(private readonly pool: pg.Pool) {}

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

      if (locked.status === 'running' && (await isExpired(client, locked))) {
        return expireTurn(client, identity, locked);
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
        return failRunningTurn(client, identity, locked, result.failureReason);
      }

      return completeRunningTurn(client, identity, locked, result.text);
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

      if (await isExpired(client, locked)) {
        return expireTurn(client, identity, locked);
      }

      const updated = await client.query<TurnRow>(
        `
WITH decision AS (SELECT clock_timestamp() AS now)
UPDATE assistant_turns t
   SET status = 'cancelled',
       failure_reason = NULL,
       updated_at = decision.now
  FROM decision
 WHERE t.tenant_id = $1 AND t.conversation_id = $2 AND t.id = $3
   AND t.status = 'running' AND t.deadline_at > decision.now
RETURNING t.id, t.conversation_id, t.source_message_id, t.status, t.created_at, t.updated_at,
          t.response_message_id, t.failure_reason, t.deadline_at`,
        [identity.tenantId, identity.conversationId, identity.turnId],
      );
      const row = updated.rows[0];

      if (row === undefined) {
        // The deadline may have crossed after the first clock check. The turn row is still locked,
        // so timeout wins deterministically and publishes its safe Message in this transaction.
        return expireTurn(client, identity, locked);
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
      const result = await this.pool.query<PendingTurnRow>(
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
      const result = await this.pool.query<SourceMessageRow>(
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

interface TurnRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly source_message_id: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly response_message_id: string | null;
  readonly failure_reason: 'timeout' | 'internal_error' | null;
  readonly deadline_at: Date | string;
}

interface PendingTurnRow {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly turn_id: string;
}

interface SourceMessageRow {
  readonly text: string;
  readonly deadline_at: Date | string;
}

interface ConversationSequenceRow {
  readonly last_sequence: string | number;
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

function toTurnDto(row: TurnRow): B1AssistantTurnDto {
  return B1AssistantTurnDtoSchema.parse({
    turn_id: row.id,
    conversation_id: row.conversation_id,
    source_message_id: row.source_message_id,
    status: row.status,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    response_message_id: row.response_message_id,
    failure_reason: row.failure_reason,
  });
}

async function lockTurn(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
): Promise<TurnRow | null> {
  const conversation = await client.query<{ readonly id: string }>(
    `
SELECT id
  FROM conversations
 WHERE tenant_id = $1 AND id = $2
 FOR UPDATE`,
    [identity.tenantId, identity.conversationId],
  );

  if (conversation.rows[0] === undefined) {
    return null;
  }

  const turn = await client.query<TurnRow>(
    `
SELECT id, conversation_id, source_message_id, status, created_at, updated_at,
       response_message_id, failure_reason, deadline_at
  FROM assistant_turns
 WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3
 FOR UPDATE`,
    [identity.tenantId, identity.conversationId, identity.turnId],
  );

  return turn.rows[0] ?? null;
}

async function isExpired(client: pg.PoolClient, row: TurnRow): Promise<boolean> {
  const result = await client.query<{ readonly expired: boolean }>(
    'SELECT $1::timestamptz <= clock_timestamp() AS expired',
    [row.deadline_at],
  );

  return result.rows[0]?.expired ?? true;
}

async function allocateSequence(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
): Promise<string | number> {
  const result = await client.query<ConversationSequenceRow>(
    `
UPDATE conversations
   SET last_sequence = last_sequence + 1,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1 AND id = $2
RETURNING last_sequence`,
    [identity.tenantId, identity.conversationId],
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'locked conversation did not accept a sequence');
  }

  return row.last_sequence;
}

async function insertAssistantMessage(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
  sequence: string | number,
  responseMessageId: Id,
  text: string,
): Promise<void> {
  await client.query(
    `
INSERT INTO conversation_messages
       (id, tenant_id, conversation_id, sequence, kind, text, model_label, simulated)
VALUES ($1, $2, $3, $4::bigint, 'ember', $5, $6, true)`,
    [
      responseMessageId,
      identity.tenantId,
      identity.conversationId,
      sequence,
      text,
      B1_ASSISTANT_TURN_MODEL_LABEL,
    ],
  );
}

async function failRunningTurn(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
  _locked: TurnRow,
  requestedReason: 'timeout' | 'internal_error',
): Promise<B1AssistantTurnDto> {
  const responseMessageId = randomUUID();
  const sequence = await allocateSequence(client, identity);
  await insertAssistantMessage(
    client,
    identity,
    sequence,
    responseMessageId,
    B1_ASSISTANT_TURN_FAILURE_MESSAGE,
  );

  const updated = await client.query<TurnRow>(
    `
WITH decision AS (SELECT clock_timestamp() AS now)
UPDATE assistant_turns t
   SET status = 'failed',
       failure_reason = CASE
         WHEN $4::text = 'timeout' OR t.deadline_at <= decision.now THEN 'timeout'
         ELSE 'internal_error'
       END,
       response_message_id = $5,
       updated_at = decision.now
  FROM decision
 WHERE t.tenant_id = $1 AND t.conversation_id = $2 AND t.id = $3 AND t.status = 'running'
RETURNING t.id, t.conversation_id, t.source_message_id, t.status, t.created_at, t.updated_at,
          t.response_message_id, t.failure_reason, t.deadline_at`,
    [
      identity.tenantId,
      identity.conversationId,
      identity.turnId,
      requestedReason,
      responseMessageId,
    ],
  );
  const row = updated.rows[0];

  if (row === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'locked turn did not accept failure');
  }

  return toTurnDto(row);
}

async function expireTurn(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
  locked: TurnRow,
): Promise<B1AssistantTurnDto> {
  return failRunningTurn(client, identity, locked, 'timeout');
}

async function completeRunningTurn(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
  _locked: TurnRow,
  text: string,
): Promise<B1AssistantTurnDto> {
  const responseMessageId = randomUUID();
  const sequence = await allocateSequence(client, identity);
  await insertAssistantMessage(client, identity, sequence, responseMessageId, text);

  // The DB clock is sampled once for both fields. If the deadline crossed while the reply was
  // being written, the same transaction converts the not-yet-visible message to fixed timeout
  // text and commits failed/timeout instead of exposing a late completion.
  const updated = await client.query<TurnRow>(
    `
WITH decision AS (SELECT clock_timestamp() AS now)
UPDATE assistant_turns t
   SET status = CASE WHEN t.deadline_at <= decision.now THEN 'failed' ELSE 'completed' END,
       failure_reason = CASE WHEN t.deadline_at <= decision.now THEN 'timeout' ELSE NULL END,
       response_message_id = $4,
       updated_at = decision.now
  FROM decision
 WHERE t.tenant_id = $1 AND t.conversation_id = $2 AND t.id = $3 AND t.status = 'running'
RETURNING t.id, t.conversation_id, t.source_message_id, t.status, t.created_at, t.updated_at,
          t.response_message_id, t.failure_reason, t.deadline_at`,
    [identity.tenantId, identity.conversationId, identity.turnId, responseMessageId],
  );
  const row = updated.rows[0];

  if (row === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'locked turn did not accept completion');
  }

  if (row.status === 'failed' && row.failure_reason === 'timeout') {
    await client.query(
      `
UPDATE conversation_messages
   SET text = $4
 WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3 AND kind = 'ember'`,
      [
        identity.tenantId,
        identity.conversationId,
        responseMessageId,
        B1_ASSISTANT_TURN_FAILURE_MESSAGE,
      ],
    );
  }

  return toTurnDto(row);
}
