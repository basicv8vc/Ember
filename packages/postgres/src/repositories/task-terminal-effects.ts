import type { OutcomeResultStatus } from '@ember/contracts';
import { type Id, type TaskTerminalStatus } from '@ember/domain';
import type pg from 'pg';

export interface TaskTerminalEffectsInput {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly status: TaskTerminalStatus;
  readonly occurredAt: Date | string;
}

const INSERT_UNAVAILABLE_RESULT_SQL = `
INSERT INTO task_results (
  id, tenant_id, task_id, result_state, reason_code, truncated, created_at, updated_at
)
VALUES ($1, $2, $3, 'unavailable', 'no_text_output', false, $4, $4)
ON CONFLICT (tenant_id, task_id) DO NOTHING
`;

const SELECT_RESULT_STATE_SQL = `
SELECT result_state
  FROM task_results
 WHERE tenant_id = $1 AND task_id = $2
`;

const SELECT_TASK_CONVERSATION_SQL = `
SELECT conversation_id
  FROM conversation_messages
 WHERE tenant_id = $1 AND task_id = $2 AND kind = 'task_reference'
 LIMIT 1
`;

const LOCK_CONVERSATION_SQL = `
SELECT id
  FROM conversations
 WHERE tenant_id = $1 AND id = $2
 FOR UPDATE
`;

const VERIFY_TASK_REF_SQL = `
SELECT 1
  FROM conversation_messages
 WHERE tenant_id = $1 AND conversation_id = $2 AND task_id = $3 AND kind = 'task_reference'
 LIMIT 1
`;

const CHECK_EXISTING_OUTCOME_SQL = `
SELECT 1
  FROM conversation_messages
 WHERE tenant_id = $1
   AND kind = 'outcome_reference'
   AND (outcome ->> 'task_id') = $2
 LIMIT 1
`;

const ALLOCATE_CONVERSATION_SEQ_SQL = `
UPDATE conversations
   SET last_sequence = last_sequence + 1,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1 AND id = $2
RETURNING last_sequence
`;

const INSERT_OUTCOME_REFERENCE_SQL = `
INSERT INTO conversation_messages (id, tenant_id, conversation_id, sequence, kind, outcome, created_at)
VALUES ($1, $2, $3, $4::bigint, 'outcome_reference', $5::jsonb, $6)
ON CONFLICT DO NOTHING
`;

function deriveOutcomeKind(
  status: TaskTerminalStatus,
  resultState: string | undefined,
): OutcomeResultStatus {
  switch (status) {
    case 'completed':
      return resultState === 'available' ? 'meaningful_change' : 'no_change';
    case 'cancelled':
      return 'denied';
    case 'failed':
      return 'failed';
  }
}

/**
 * Guarantee X-9 / W-1 terminal completeness inside the caller's Task-locked transaction:
 * 1. Ensure a `task_results` row exists (preserving an already-written `'available'` result,
 *    otherwise recording `'unavailable'` with `'no_text_output'`).
 * 2. If a live `task_reference` exists in a Conversation, post an idempotent `'outcome_reference'`
 *    in strict lock order (`tasks -> runs -> conversations`).
 *
 * Keeps zero `node:*` imports so this helper stays compatible with edge runtimes.
 */
export async function finalizeTaskTerminalEffects(
  client: pg.PoolClient,
  input: TaskTerminalEffectsInput,
): Promise<void> {
  await client.query(INSERT_UNAVAILABLE_RESULT_SQL, [
    globalThis.crypto.randomUUID(),
    input.tenantId,
    input.taskId,
    input.occurredAt,
  ]);

  const refLookup = await client.query<{ readonly conversation_id: string }>(
    SELECT_TASK_CONVERSATION_SQL,
    [input.tenantId, input.taskId],
  );
  const conversationId = refLookup.rows[0]?.conversation_id;

  if (conversationId === undefined) {
    return;
  }

  // Acquire the conversation lock strictly after the caller's Task lock (`tasks -> conversations`).
  const lockedConversation = await client.query<{ readonly id: string }>(LOCK_CONVERSATION_SQL, [
    input.tenantId,
    conversationId,
  ]);

  if (lockedConversation.rows[0] === undefined) {
    return;
  }

  const stillReferenced = await client.query(VERIFY_TASK_REF_SQL, [
    input.tenantId,
    conversationId,
    input.taskId,
  ]);

  if ((stillReferenced.rowCount ?? 0) === 0) {
    // Transcript cleared concurrently while closing the Task: Q-3 keeps results, no orphan outcome.
    return;
  }

  const existingOutcome = await client.query(CHECK_EXISTING_OUTCOME_SQL, [
    input.tenantId,
    input.taskId,
  ]);

  if ((existingOutcome.rowCount ?? 0) > 0) {
    return;
  }

  const resultStateRow = await client.query<{ readonly result_state: string }>(
    SELECT_RESULT_STATE_SQL,
    [input.tenantId, input.taskId],
  );
  const outcomeKind = deriveOutcomeKind(input.status, resultStateRow.rows[0]?.result_state);

  const sequenceRow = await client.query<{ readonly last_sequence: string | number }>(
    ALLOCATE_CONVERSATION_SEQ_SQL,
    [input.tenantId, conversationId],
  );
  const sequence = sequenceRow.rows[0]?.last_sequence;

  if (sequence === undefined) {
    return;
  }

  await client.query(INSERT_OUTCOME_REFERENCE_SQL, [
    globalThis.crypto.randomUUID(),
    input.tenantId,
    conversationId,
    sequence,
    JSON.stringify({
      outcome_kind: outcomeKind,
      task_id: input.taskId,
      commitment_id: null,
    }),
    input.occurredAt,
  ]);
}
