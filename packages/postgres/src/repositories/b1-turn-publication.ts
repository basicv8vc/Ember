import { randomUUID } from 'node:crypto';
import { B1AssistantTurnDtoSchema, type B1AssistantTurnDto } from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import { FAKE_LLM_MODEL } from '@ember/execution';
import type pg from 'pg';
import { toIsoTimestamp } from './support.js';

/**
 * Shared Turn publication primitives.
 *
 * B1-5 and B2 both publish an `ember` message and a terminal Turn in one transaction. That
 * guarantee (B1 T-2) must not exist twice, so the SQL lives here and each repository supplies only
 * its own admission rule: B1-5 publishes simulated text, B2 publishes under a lease fence.
 */

/** Every B1 assistant Message is explicitly marked as simulated and uses this model label. */
export const B1_ASSISTANT_TURN_MODEL_LABEL = FAKE_LLM_MODEL;

/** Fixed user-safe text; exception, SQL and provider details never enter a failed reply. */
export const B1_ASSISTANT_TURN_FAILURE_MESSAGE =
  'This simulated reply could not be completed. Please try again.';

export interface PendingAssistantTurn {
  readonly tenantId: Id;
  readonly conversationId: Id;
  readonly turnId: Id;
}

export interface AssistantTurnSourceMessage extends PendingAssistantTurn {
  readonly text: string;
  readonly deadlineAt: string;
}

/** What gets stamped on the `ember` row. Real output is `simulated: false` with a pinned label. */
export interface AssistantModelIdentity {
  readonly label: string;
  readonly simulated: boolean;
}

export const SIMULATED_MODEL_IDENTITY: AssistantModelIdentity = Object.freeze({
  label: B1_ASSISTANT_TURN_MODEL_LABEL,
  simulated: true,
});

export interface TurnRow {
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

/** Select list shared by every read, so a missing column cannot hide in one code path. */
export function turnColumns(alias: string): string {
  return [
    `${alias}.id`,
    `${alias}.conversation_id`,
    `${alias}.source_message_id`,
    `${alias}.status`,
    `${alias}.created_at`,
    `${alias}.updated_at`,
    `${alias}.response_message_id`,
    `${alias}.failure_reason`,
    `${alias}.deadline_at`,
  ].join(', ');
}

export function toTurnDto(row: TurnRow): B1AssistantTurnDto {
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

/**
 * Lock the conversation row, then the turn row.
 *
 * This order is the same everywhere a message is appended: it serializes `sequence` allocation with
 * appends and makes transcript deletion win cleanly instead of racing a stale responder.
 */
export async function lockTurn(
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
SELECT ${turnColumns('t')}
  FROM assistant_turns t
 WHERE t.tenant_id = $1 AND t.conversation_id = $2 AND t.id = $3
 FOR UPDATE`,
    [identity.tenantId, identity.conversationId, identity.turnId],
  );

  return turn.rows[0] ?? null;
}

/** Deadline check uses the database clock: a skewed worker must not extend its own budget. */
export async function isExpired(client: pg.PoolClient, row: TurnRow): Promise<boolean> {
  const result = await client.query<{ readonly expired: boolean }>(
    'SELECT $1::timestamptz <= clock_timestamp() AS expired',
    [row.deadline_at],
  );

  return result.rows[0]?.expired ?? true;
}

export async function allocateSequence(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
): Promise<string | number> {
  const result = await client.query<{ readonly last_sequence: string | number }>(
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

/**
 * Insert the assistant reply with the model identity the caller earned.
 *
 * `simulated` is written explicitly: a row can never inherit `true` from a default and then be
 * served as if it were a real answer.
 */
export async function insertTurnResponse(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
  text: string,
  model: AssistantModelIdentity,
): Promise<Id> {
  const responseMessageId = randomUUID();
  const sequence = await allocateSequence(client, identity);

  await client.query(
    `
INSERT INTO conversation_messages
       (id, tenant_id, conversation_id, sequence, kind, text, model_label, simulated)
VALUES ($1, $2, $3, $4::bigint, 'ember', $5, $6, $7)`,
    [
      responseMessageId,
      identity.tenantId,
      identity.conversationId,
      sequence,
      text,
      model.label,
      model.simulated,
    ],
  );

  return responseMessageId;
}

/**
 * `running` → `completed`.
 *
 * The database clock is sampled once for both fields. If the deadline crossed while the reply was
 * being written, the same transaction converts the not-yet-visible message to fixed timeout text
 * and commits `failed/timeout`, so a late answer is never exposed as a completion.
 */
export async function markTurnCompleted(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
  responseMessageId: Id,
): Promise<TurnRow | null> {
  const updated = await client.query<TurnRow>(
    `
WITH decision AS (SELECT clock_timestamp() AS now)
UPDATE assistant_turns t
   SET status = CASE WHEN t.deadline_at <= decision.now THEN 'failed' ELSE 'completed' END,
       failure_reason = CASE WHEN t.deadline_at <= decision.now THEN 'timeout' ELSE NULL END,
       response_message_id = $4,
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = decision.now
  FROM decision
 WHERE t.tenant_id = $1 AND t.conversation_id = $2 AND t.id = $3 AND t.status = 'running'
RETURNING ${turnColumns('t')}`,
    [identity.tenantId, identity.conversationId, identity.turnId, responseMessageId],
  );
  const row = updated.rows[0];

  if (row === undefined) {
    return null;
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

  return row;
}

/** `running` → `failed`, always with the fixed user-safe text and a closed failure reason. */
export async function markTurnFailed(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
  responseMessageId: Id,
  requestedReason: 'timeout' | 'internal_error',
): Promise<TurnRow | null> {
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
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = decision.now
  FROM decision
 WHERE t.tenant_id = $1 AND t.conversation_id = $2 AND t.id = $3 AND t.status = 'running'
RETURNING ${turnColumns('t')}`,
    [
      identity.tenantId,
      identity.conversationId,
      identity.turnId,
      requestedReason,
      responseMessageId,
    ],
  );

  return updated.rows[0] ?? null;
}
