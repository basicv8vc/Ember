import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  B1SendMessageReceiptSchema,
  type B1SendMessageReceipt,
  type B1SendMessageRequest,
} from '@ember/contracts';
import { DomainError } from '@ember/domain';
import {
  B1_MESSAGE_QUOTA_LIMIT,
  B1_TURN_DEADLINE_SECONDS,
  PostgresB1ConversationWriteRepository,
} from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import { backendPid, createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * B1-3A: the Conversation message write transaction, against a real PostgreSQL 17.
 *
 * Everything here runs at the persistence boundary — no HTTP, no Auth, no model egress — because
 * the properties under test (atomicity, idempotency, tenant isolation, sequence allocation, quota)
 * are decided by one transaction and its row lock. Concurrency always uses separate database
 * connections, so a guarantee is never the accident of one process being fast.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let db: TestDatabase;
let writerA: PostgresB1ConversationWriteRepository;
let writerB: PostgresB1ConversationWriteRepository;

/** Two tenants: the second one only ever acts as the foreign caller. */
const tenantA = randomUUID();
const tenantB = randomUUID();

interface Conversation {
  readonly tenantId: string;
  readonly conversationId: string;
}

async function createConversation(tenantId: string, label: string): Promise<Conversation> {
  const agentId = randomUUID();
  const conversationId = randomUUID();

  await db.pool.query(
    'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
    [agentId, tenantId, `${label} agent`],
  );
  await db.pool.query(
    "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
    [conversationId, tenantId, agentId],
  );

  return { tenantId, conversationId };
}

/** A tenant nobody else writes to, so "zero rows in this tenant" is a claim that can actually fail. */
async function createIsolatedConversation(label: string): Promise<Conversation> {
  const tenantId = randomUUID();

  await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, label]);

  return createConversation(tenantId, label);
}

function request(input: {
  readonly text?: string;
  readonly clientSubmissionId?: string;
  readonly transcriptEpoch?: number;
}): B1SendMessageRequest {
  return {
    client_submission_id: input.clientSubmissionId ?? randomUUID(),
    text: input.text ?? 'Book me a table for two on Friday',
    transcript_epoch: input.transcriptEpoch ?? 0,
  };
}

async function submit(
  writer: PostgresB1ConversationWriteRepository,
  conversation: Conversation,
  input: Parameters<typeof request>[0] = {},
): Promise<{ readonly replayed: boolean; readonly receipt: B1SendMessageReceipt }> {
  return writer.submitUserMessage({
    tenantId: conversation.tenantId,
    conversationId: conversation.conversationId,
    request: request(input),
  });
}

async function expectDomainError(
  operation: Promise<unknown>,
  code: DomainError['code'],
): Promise<DomainError> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof DomainError)) {
      throw new Error(`expected a ${code} DomainError, got ${String(error)}`);
    }
    expect(error.code).toBe(code);

    return error;
  }

  throw new Error(`expected the operation to fail with ${code}`);
}

async function countRows(sql: string, values: readonly unknown[] = []): Promise<number> {
  const result = await db.observerPool.query<{ readonly count: string }>(sql, [...values]);

  return Number(result.rows[0]?.count ?? '0');
}

/**
 * A foreign Conversation and an unknown Conversation must not be distinguishable (ISO-3), so the
 * comparison is on the whole public shape, not only on the status code.
 */
function publicErrorShape(error: DomainError): { readonly code: string; readonly message: string } {
  return { code: error.code, message: error.publicMessage };
}

async function readConversationRow(conversationId: string): Promise<{
  readonly last_sequence: number;
  readonly transcript_epoch: number;
  readonly updated_at: Date;
}> {
  const result = await db.observerPool.query<{
    last_sequence: string;
    transcript_epoch: string;
    updated_at: Date;
  }>('SELECT last_sequence, transcript_epoch, updated_at FROM conversations WHERE id = $1', [
    conversationId,
  ]);
  const row = result.rows[0];

  if (row === undefined) {
    throw new Error('conversation row is missing');
  }

  return {
    last_sequence: Number(row.last_sequence),
    transcript_epoch: Number(row.transcript_epoch),
    updated_at: row.updated_at,
  };
}

/** Every message written through this runtime is paired with exactly one Turn, and vice versa. */
async function assertNoOrphanedMessagesOrTurns(): Promise<void> {
  const orphanedMessages = await countRows(`
SELECT count(*)
  FROM conversation_messages m
  LEFT JOIN assistant_turns t ON t.tenant_id = m.tenant_id AND t.source_message_id = m.id
 WHERE m.kind = 'user' AND t.id IS NULL
`);
  const danglingTurns = await countRows(`
SELECT count(*)
  FROM assistant_turns t
  LEFT JOIN conversation_messages m ON m.tenant_id = t.tenant_id AND m.id = t.source_message_id
 WHERE m.id IS NULL
`);

  expect({ orphanedMessages, danglingTurns }).toEqual({ orphanedMessages: 0, danglingTurns: 0 });
}

describe('B1-3A: atomic Conversation message submission on PostgreSQL 17', () => {
  beforeAll(async () => {
    db = await createTestDatabase({ maxConnections: 12 });

    for (const [tenantId, name] of [
      [tenantA, 'B1-3A tenant A'],
      [tenantB, 'B1-3A tenant B'],
    ] as const) {
      await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, name]);
      await db.pool.query("INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')", [
        randomUUID(),
        tenantId,
      ]);
    }

    // Two independent pools, so a "concurrent" call is genuinely two PostgreSQL backends.
    writerA = new PostgresB1ConversationWriteRepository(db.pool);
    writerB = new PostgresB1ConversationWriteRepository(db.observerPool);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('1. writes one message and one running turn on the first submission', async () => {
    const conversation = await createConversation(tenantA, 'first submission');
    const before = await readConversationRow(conversation.conversationId);
    const clientSubmissionId = randomUUID();

    const outcome = await submit(writerA, conversation, {
      clientSubmissionId,
      text: 'Book me a table for two on Friday',
    });

    expect(outcome.replayed).toBe(false);
    expect(outcome.receipt.message.client_submission_id).toBe(clientSubmissionId);
    expect(outcome.receipt.message.sequence).toBe(1);
    expect(outcome.receipt.transcript_epoch).toBe(0);

    const messages = await countRows(
      'SELECT count(*) FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2',
      [conversation.tenantId, conversation.conversationId],
    );
    const turns = await countRows(
      'SELECT count(*) FROM assistant_turns WHERE tenant_id = $1 AND conversation_id = $2',
      [conversation.tenantId, conversation.conversationId],
    );
    expect({ messages, turns }).toEqual({ messages: 1, turns: 1 });

    const storedTurn = await db.observerPool.query<{ status: string; seconds: number }>(
      `SELECT status,
              extract(epoch FROM (deadline_at - created_at))::int AS seconds
         FROM assistant_turns WHERE tenant_id = $1 AND conversation_id = $2`,
      [conversation.tenantId, conversation.conversationId],
    );
    expect(storedTurn.rows[0]).toEqual({ status: 'running', seconds: B1_TURN_DEADLINE_SECONDS });

    const after = await readConversationRow(conversation.conversationId);
    expect(after.last_sequence).toBe(1);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('writes one dispatch outbox row atomically and notifies only after commit', async () => {
    const conversation = await createIsolatedConversation('dispatch outbox commit');
    const submission = request({ text: 'durable dispatch wake' });
    const notifications: Array<{ readonly tenantId: string; readonly turnId: string }> = [];
    let visibleOutboxFromObserver: Promise<number> | undefined;
    const dispatchWriter = new PostgresB1ConversationWriteRepository(db.pool, {
      writeTurnDispatchOutbox: true,
      onTurnCommitted: (event) => {
        notifications.push(event);
        visibleOutboxFromObserver = countRows(
          `SELECT count(*) FROM b1_turn_dispatch_outbox
            WHERE tenant_id = $1 AND turn_id = $2`,
          [event.tenantId, event.turnId],
        );
      },
    });
    const command = {
      tenantId: conversation.tenantId,
      conversationId: conversation.conversationId,
      request: submission,
    };

    const first = await dispatchWriter.submitUserMessage(command);
    expect(first.replayed).toBe(false);
    expect(notifications).toEqual([
      { tenantId: conversation.tenantId, turnId: first.receipt.turn.turn_id },
    ]);
    if (visibleOutboxFromObserver === undefined) {
      throw new Error('post-commit notification did not run');
    }
    expect(await visibleOutboxFromObserver).toBe(1);

    const replay = await dispatchWriter.submitUserMessage(command);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(notifications).toHaveLength(1);
    expect(
      await countRows(
        `SELECT count(*) FROM b1_turn_dispatch_outbox
          WHERE tenant_id = $1 AND turn_id = $2`,
        [conversation.tenantId, first.receipt.turn.turn_id],
      ),
    ).toBe(1);
  });

  it('preserves a committed B1 receipt when the post-commit Queue wake fails', async () => {
    const conversation = await createIsolatedConversation('dispatch wake failure');
    const dispatchWriter = new PostgresB1ConversationWriteRepository(db.pool, {
      writeTurnDispatchOutbox: true,
      onTurnCommitted: () => {
        throw new Error('simulated Queue failure');
      },
    });

    const outcome = await submit(dispatchWriter, conversation, { text: 'wake failure receipt' });

    expect(outcome.replayed).toBe(false);
    expect(
      await countRows(
        `SELECT count(*) FROM b1_turn_dispatch_outbox
          WHERE tenant_id = $1 AND turn_id = $2`,
        [conversation.tenantId, outcome.receipt.turn.turn_id],
      ),
    ).toBe(1);
  });

  it('rolls back the Message and Turn when the transactional outbox insert fails', async () => {
    const conversation = await createIsolatedConversation('dispatch outbox rollback');
    let wakeCount = 0;
    const dispatchWriter = new PostgresB1ConversationWriteRepository(db.pool, {
      writeTurnDispatchOutbox: true,
      onTurnCommitted: () => {
        wakeCount += 1;
      },
    });

    await db.pool.query(`
CREATE FUNCTION ember_test_fail_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'forced outbox insert failure';
END
$fn$;
CREATE TRIGGER ember_test_fail_outbox_insert
  BEFORE INSERT ON b1_turn_dispatch_outbox FOR EACH ROW
  EXECUTE FUNCTION ember_test_fail_outbox_insert()
`);

    try {
      await expectDomainError(
        submit(dispatchWriter, conversation, { text: 'outbox failure rolls back the receipt' }),
        'DB_UNAVAILABLE',
      );

      expect((await readConversationRow(conversation.conversationId)).last_sequence).toBe(0);
      expect(
        await countRows('SELECT count(*) FROM conversation_messages WHERE tenant_id = $1', [
          conversation.tenantId,
        ]),
      ).toBe(0);
      expect(
        await countRows('SELECT count(*) FROM assistant_turns WHERE tenant_id = $1', [
          conversation.tenantId,
        ]),
      ).toBe(0);
      expect(
        await countRows('SELECT count(*) FROM b1_turn_dispatch_outbox WHERE tenant_id = $1', [
          conversation.tenantId,
        ]),
      ).toBe(0);
      expect(wakeCount).toBe(0);
    } finally {
      await db.pool.query(
        `DROP TRIGGER ember_test_fail_outbox_insert ON b1_turn_dispatch_outbox;
         DROP FUNCTION ember_test_fail_outbox_insert()`,
      );
    }
  });

  it('2. returns the exact canonical receipt structure, and only those fields', async () => {
    const conversation = await createConversation(tenantA, 'receipt shape');
    const outcome = await submit(writerA, conversation, { text: 'shape probe' });

    expect(Object.keys(outcome.receipt).sort()).toEqual(['message', 'transcript_epoch', 'turn']);
    expect(Object.keys(outcome.receipt.message).sort()).toEqual([
      'client_submission_id',
      'conversation_id',
      'created_at',
      'kind',
      'message_id',
      'sequence',
      'text',
    ]);
    expect(Object.keys(outcome.receipt.turn).sort()).toEqual(['created_at', 'status', 'turn_id']);
    expect(outcome.receipt.message.kind).toBe('user');
    expect(outcome.receipt.turn.status).toBe('running');
    expect(outcome.receipt.message.conversation_id).toBe(conversation.conversationId);
    // The frozen schema is the wire authority: a receipt this method returns must parse against it.
    expect(B1SendMessageReceiptSchema.safeParse(outcome.receipt).success).toBe(true);
    // bigint columns arrive through the driver as text; the DTO must be a real integer.
    expect(Number.isInteger(outcome.receipt.message.sequence)).toBe(true);
    expect(Number.isInteger(outcome.receipt.transcript_epoch)).toBe(true);
    // `created_at` is server-authored (O-4): a few seconds of tolerance against the DB clock.
    const serverTime = await db.observerPool.query<{ now: Date }>('SELECT now() AS now');
    const driftMs = Math.abs(
      new Date(outcome.receipt.message.created_at).getTime() -
        (serverTime.rows[0]?.now.getTime() ?? 0),
    );
    expect(driftMs).toBeLessThan(5_000);
  });

  it('3. rolls the whole transaction back under a forced failure', async () => {
    const conversation = await createIsolatedConversation('forced failure');
    const secretText = 'text that must never survive a rollback';

    await db.pool.query(`
CREATE FUNCTION ember_test_fail_turn_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'forced turn insert failure';
END
$fn$;
CREATE TRIGGER ember_test_fail_turn_insert
  BEFORE INSERT ON assistant_turns FOR EACH ROW
  EXECUTE FUNCTION ember_test_fail_turn_insert()
`);

    try {
      const error = await expectDomainError(
        submit(writerA, conversation, { text: secretText }),
        'DB_UNAVAILABLE',
      );

      // No SQL, no driver text and no message content reaches the public error shape.
      expect(error.publicMessage).toBe('Database is unavailable');
      const publicJson = JSON.stringify(error.toJSON());
      for (const forbidden of [secretText, 'INSERT', 'assistant_turns', 'forced turn insert']) {
        expect(publicJson).not.toContain(forbidden);
      }

      const before = await readConversationRow(conversation.conversationId);
      expect(before.last_sequence).toBe(0);

      const rows = await countRows(
        'SELECT count(*) FROM conversation_messages WHERE tenant_id = $1',
        [conversation.tenantId],
      );
      const turnRows = await countRows(
        'SELECT count(*) FROM assistant_turns WHERE tenant_id = $1',
        [conversation.tenantId],
      );
      expect({ rows, turnRows }).toEqual({ rows: 0, turnRows: 0 });
    } finally {
      await db.pool.query(
        `DROP TRIGGER ember_test_fail_turn_insert ON assistant_turns;
         DROP FUNCTION ember_test_fail_turn_insert()`,
      );
    }

    // The sequence bump and the metadata update happened before the failure, so a rollback that
    // only undid the inserts would leave a gap — the next send must still be sequence 1.
    const recovered = await submit(writerA, conversation, { text: 'retry after rollback' });
    expect(recovered.receipt.message.sequence).toBe(1);
  });

  it('4. replays an identical submission with the identical receipt and writes nothing new', async () => {
    const conversation = await createConversation(tenantA, 'replay');
    const clientSubmissionId = randomUUID();

    const first = await submit(writerA, conversation, { clientSubmissionId, text: 'same text' });
    const second = await submit(writerB, conversation, { clientSubmissionId, text: 'same text' });

    expect(second.replayed).toBe(true);
    expect(second.receipt).toEqual(first.receipt);

    const messages = await countRows(
      'SELECT count(*) FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2',
      [conversation.tenantId, conversation.conversationId],
    );
    const turns = await countRows(
      'SELECT count(*) FROM assistant_turns WHERE tenant_id = $1 AND conversation_id = $2',
      [conversation.tenantId, conversation.conversationId],
    );
    expect({ messages, turns }).toEqual({ messages: 1, turns: 1 });

    // S-2: nothing new is written, so the Conversation metadata is not touched by a replay either.
    const after = await readConversationRow(conversation.conversationId);
    expect(after.last_sequence).toBe(1);
  });

  it('5. replays the original POST receipt after the turn reached a terminal state', async () => {
    const conversation = await createConversation(tenantA, 'terminal replay');
    const clientSubmissionId = randomUUID();

    const first = await submit(writerA, conversation, { clientSubmissionId, text: 'answer me' });
    const turnRow = await db.pool.query<{ id: string }>(
      'SELECT id FROM assistant_turns WHERE tenant_id = $1 AND conversation_id = $2',
      [conversation.tenantId, conversation.conversationId],
    );
    const turnId = turnRow.rows[0]?.id;

    if (turnId === undefined) {
      throw new Error('the submission did not create a turn');
    }

    // The B1-3B responder commits one `ember` message and terminalizes the turn in one transaction.
    const responseId = randomUUID();
    await db.pool.query(
      `INSERT INTO conversation_messages
         (id, tenant_id, conversation_id, sequence, kind, text, model_label, simulated)
       VALUES ($1, $2, $3, 2, 'ember', 'Table booked.', 'ember-fake-llm-1', true)`,
      [responseId, conversation.tenantId, conversation.conversationId],
    );
    await db.pool.query(
      `UPDATE assistant_turns
          SET status = 'completed', response_message_id = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [conversation.tenantId, turnId, responseId],
    );
    await db.pool.query(
      'UPDATE conversations SET last_sequence = 2, updated_at = now() WHERE id = $1',
      [conversation.conversationId],
    );

    const replay = await submit(writerA, conversation, { clientSubmissionId, text: 'answer me' });

    expect(replay.replayed).toBe(true);
    // N-2: the recovery body is the POST body, so it still reports the turn as it was created.
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.receipt.turn.turn_id).toBe(turnId);
    expect(replay.receipt.turn.status).toBe('running');
    expect(replay.receipt.message.sequence).toBe(1);

    const terminal = await db.observerPool.query<{ status: string }>(
      'SELECT status FROM assistant_turns WHERE id = $1',
      [turnId],
    );
    expect(terminal.rows[0]?.status).toBe('completed');
  });

  it('6. conflicts on the same submission id with different text, writing nothing', async () => {
    const conversation = await createConversation(tenantA, 'text conflict');
    const clientSubmissionId = randomUUID();
    const original = 'original text';

    await submit(writerA, conversation, { clientSubmissionId, text: original });

    const error = await expectDomainError(
      submit(writerA, conversation, { clientSubmissionId, text: 'different text' }),
      'IDEMPOTENCY_CONFLICT',
    );
    // The rejected text never becomes public data or a stored row (G-4).
    expect(JSON.stringify(error.toJSON())).not.toContain('different text');

    const messages = await countRows(
      'SELECT count(*) FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2',
      [conversation.tenantId, conversation.conversationId],
    );
    const texts = await db.observerPool.query<{ text: string }>(
      'SELECT text FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2',
      [conversation.tenantId, conversation.conversationId],
    );
    expect({ count: messages, texts: texts.rows }).toEqual({
      count: 1,
      texts: [{ text: original }],
    });
    expect((await readConversationRow(conversation.conversationId)).last_sequence).toBe(1);
  });

  it('7. conflicts when one tenant reuses a submission id in another conversation', async () => {
    const first = await createConversation(tenantA, 'cross-conversation A');
    const second = await createConversation(tenantA, 'cross-conversation B');
    const clientSubmissionId = randomUUID();

    await submit(writerA, first, { clientSubmissionId, text: 'shared id' });

    await expectDomainError(
      submit(writerA, second, { clientSubmissionId, text: 'shared id' }),
      'IDEMPOTENCY_CONFLICT',
    );

    // Even with matching text, a second Conversation in the same tenant is a conflict (CTO 0002).
    const secondMessages = await countRows(
      'SELECT count(*) FROM conversation_messages WHERE conversation_id = $1',
      [second.conversationId],
    );
    expect(secondMessages).toBe(0);
    expect((await readConversationRow(second.conversationId)).last_sequence).toBe(0);

    // The same id in a different tenant is permitted, and each tenant keeps its own row.
    const foreignConversation = await createConversation(tenantB, 'cross-conversation C');
    const accepted = await submit(writerB, foreignConversation, {
      clientSubmissionId,
      text: 'shared id',
    });
    expect(accepted.replayed).toBe(false);
    expect(accepted.receipt.message.conversation_id).toBe(foreignConversation.conversationId);
  });

  it('8. keeps tenants isolated, and a foreign conversation looks exactly like a missing one', async () => {
    const owned = await createConversation(tenantA, 'isolation owned');
    const stranger = await createConversation(tenantB, 'isolation stranger');
    const submissionId = randomUUID();

    // Tenant B presenting tenant A's Conversation id: the tenant never comes from the path (C-5),
    // so A's row is simply not visible in B.
    const foreign = await expectDomainError(
      submit(
        writerB,
        { tenantId: tenantB, conversationId: owned.conversationId },
        {
          clientSubmissionId: submissionId,
        },
      ),
      'NOT_FOUND',
    );
    const unknown = await expectDomainError(
      submit(writerB, { tenantId: stranger.tenantId, conversationId: randomUUID() }),
      'NOT_FOUND',
    );
    expect(publicErrorShape(foreign)).toEqual(publicErrorShape(unknown));

    const ownedMessages = await countRows(
      'SELECT count(*) FROM conversation_messages WHERE conversation_id = $1',
      [owned.conversationId],
    );
    const ownedTurns = await countRows(
      'SELECT count(*) FROM assistant_turns WHERE conversation_id = $1',
      [owned.conversationId],
    );
    expect({ ownedMessages, ownedTurns }).toEqual({ ownedMessages: 0, ownedTurns: 0 });

    // The legitimate owner still succeeds afterwards, so the rejection wrote nothing globally.
    const accepted = await submit(writerA, owned, { clientSubmissionId: submissionId });
    expect(accepted.receipt.message.conversation_id).toBe(owned.conversationId);
  });

  it('9. fences a stale or invented transcript epoch without writing a row', async () => {
    const conversation = await createConversation(tenantA, 'epoch fence');
    const secretText = 'secret lunch plan';

    // §6.7's worked example: a deletion increments the epoch and erases messages and turns.
    await db.pool.query(
      `UPDATE conversations SET transcript_epoch = 1, updated_at = now() WHERE id = $1`,
      [conversation.conversationId],
    );

    const stale = await expectDomainError(
      submit(writerA, conversation, { text: secretText, transcriptEpoch: 0 }),
      'IDEMPOTENCY_CONFLICT',
    );
    const future = await expectDomainError(
      submit(writerA, conversation, { text: secretText, transcriptEpoch: 7 }),
      'IDEMPOTENCY_CONFLICT',
    );
    // TE-3: one wire body for both causes; only the internal diagnostic may differ.
    expect(publicErrorShape(stale)).toEqual(publicErrorShape(future));
    expect(JSON.stringify(stale.toJSON())).not.toContain(secretText);

    const messages = await countRows(
      'SELECT count(*) FROM conversation_messages WHERE conversation_id = $1',
      [conversation.conversationId],
    );
    const turns = await countRows(
      'SELECT count(*) FROM assistant_turns WHERE conversation_id = $1',
      [conversation.conversationId],
    );
    expect({ messages, turns }).toEqual({ messages: 0, turns: 0 });
    expect((await readConversationRow(conversation.conversationId)).last_sequence).toBe(0);

    // A deliberate new send with the current epoch is accepted, and echoes that generation.
    const accepted = await submit(writerA, conversation, { text: secretText, transcriptEpoch: 1 });
    expect(accepted.receipt.transcript_epoch).toBe(1);
  });

  it('10. allocates a gap-free server sequence and ignores client timestamps', async () => {
    const conversation = await createConversation(tenantA, 'sequence');

    const sequences: number[] = [];
    const stamps = ['1970-01-01T00:00:00Z', '2038-01-19T03:14:08Z', '2026-11-03T09:58:11Z'];

    for (const [index, clientCreatedAt] of stamps.entries()) {
      const outcome = await writerA.submitUserMessage({
        tenantId: conversation.tenantId,
        conversationId: conversation.conversationId,
        request: { ...request({ text: `message ${index}` }), client_created_at: clientCreatedAt },
      });
      sequences.push(outcome.receipt.message.sequence);
    }

    expect(sequences).toEqual([1, 2, 3]);
    expect((await readConversationRow(conversation.conversationId)).last_sequence).toBe(3);

    const ordered = await db.observerPool.query<{ sequence: string; text: string }>(
      `SELECT sequence, text FROM conversation_messages
        WHERE conversation_id = $1 ORDER BY sequence`,
      [conversation.conversationId],
    );
    // O-4: the 1970 and 2038 client stamps could not reorder anything — sequence is the only signal.
    expect(ordered.rows.map((row) => row.text)).toEqual(['message 0', 'message 1', 'message 2']);
  });

  it('11. serialises concurrent senders on one conversation across separate connections', async () => {
    const conversation = await createConversation(tenantA, 'concurrent appends');
    const submissions = Array.from({ length: 4 }, () => randomUUID());

    const outcomes = await Promise.all([
      writerA.submitUserMessage({
        tenantId: conversation.tenantId,
        conversationId: conversation.conversationId,
        request: request({ clientSubmissionId: submissions[0], text: 'racer one' }),
      }),
      writerB.submitUserMessage({
        tenantId: conversation.tenantId,
        conversationId: conversation.conversationId,
        request: request({ clientSubmissionId: submissions[1], text: 'racer two' }),
      }),
      writerA.submitUserMessage({
        tenantId: conversation.tenantId,
        conversationId: conversation.conversationId,
        request: request({ clientSubmissionId: submissions[2], text: 'racer three' }),
      }),
      writerB.submitUserMessage({
        tenantId: conversation.tenantId,
        conversationId: conversation.conversationId,
        request: request({ clientSubmissionId: submissions[3], text: 'racer four' }),
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.receipt.message.sequence).sort()).toEqual([
      1, 2, 3, 4,
    ]);
    expect(outcomes.every((outcome) => outcome.replayed === false)).toBe(true);

    // One deterministic observation of the lock: a sender must actually wait for the holder.
    const holder = await db.pool.connect();
    try {
      const holderPid = await backendPid(holder);
      await holder.query('BEGIN');
      await holder.query(
        'SELECT transcript_epoch FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [conversation.tenantId, conversation.conversationId],
      );

      const pending = writerA.submitUserMessage({
        tenantId: conversation.tenantId,
        conversationId: conversation.conversationId,
        request: request({ text: 'waiting for the lock holder' }),
      });

      const waiterPid = await waitForLockWait(db, holderPid);
      expect(waiterPid).toBeGreaterThan(0);

      await holder.query('COMMIT');
      const late = await pending;
      expect(late.receipt.message.sequence).toBe(5);
    } finally {
      holder.release();
    }

    // Gap-freedom (O-1) under all of the above: five appends, five distinct sequences.
    const sequences = await db.observerPool.query<{ sequence: string }>(
      'SELECT sequence FROM conversation_messages WHERE conversation_id = $1 ORDER BY sequence',
      [conversation.conversationId],
    );
    expect(sequences.rows.map((row) => Number(row.sequence))).toEqual([1, 2, 3, 4, 5]);
  });

  it('12. writes exactly one message and one turn for a racing identical submission', async () => {
    const conversation = await createConversation(tenantA, 'identical race');
    const clientSubmissionId = randomUUID();
    const text = 'the same message from two connections';

    const [first, second] = await Promise.all([
      writerA.submitUserMessage({
        tenantId: conversation.tenantId,
        conversationId: conversation.conversationId,
        request: request({ clientSubmissionId, text }),
      }),
      writerB.submitUserMessage({
        tenantId: conversation.tenantId,
        conversationId: conversation.conversationId,
        request: request({ clientSubmissionId, text }),
      }),
    ]);

    const receipts = [first.receipt, second.receipt];
    expect(receipts[0]?.message.message_id).toBe(receipts[1]?.message.message_id);
    expect(receipts[0]?.turn.turn_id).toBe(receipts[1]?.turn.turn_id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);

    const messages = await countRows(
      'SELECT count(*) FROM conversation_messages WHERE conversation_id = $1',
      [conversation.conversationId],
    );
    const turns = await countRows(
      'SELECT count(*) FROM assistant_turns WHERE conversation_id = $1',
      [conversation.conversationId],
    );
    expect({ messages, turns }).toEqual({ messages: 1, turns: 1 });

    // Deterministic version: an in-flight winner that has not committed yet must block the loser,
    // so the loser cannot observe "no row" and insert a duplicate of its own.
    const winner = await db.pool.connect();
    try {
      const winnerPid = await backendPid(winner);
      const messageId = randomUUID();
      const turnId = randomUUID();
      const loserSubmissionId = randomUUID();

      await winner.query('BEGIN');
      await winner.query(
        'SELECT transcript_epoch FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [conversation.tenantId, conversation.conversationId],
      );
      await winner.query(
        `INSERT INTO conversation_messages
           (id, tenant_id, conversation_id, sequence, kind, text, client_submission_id)
         VALUES ($1, $2, $3, 2, 'user', $4, $5)`,
        [messageId, conversation.tenantId, conversation.conversationId, text, loserSubmissionId],
      );
      await winner.query(
        `INSERT INTO assistant_turns (id, tenant_id, conversation_id, source_message_id, deadline_at)
         VALUES ($1, $2, $3, $4, now() + interval '60 seconds')`,
        [turnId, conversation.tenantId, conversation.conversationId, messageId],
      );
      await winner.query(
        'UPDATE conversations SET last_sequence = 2, updated_at = now() WHERE id = $1',
        [conversation.conversationId],
      );

      const loser = writerA.submitUserMessage({
        tenantId: conversation.tenantId,
        conversationId: conversation.conversationId,
        request: request({ clientSubmissionId: loserSubmissionId, text }),
      });

      await waitForLockWait(db, winnerPid);
      await winner.query('COMMIT');

      const outcome = await loser;
      expect(outcome.replayed).toBe(true);
      expect(outcome.receipt.message.message_id).toBe(messageId);
      expect(outcome.receipt.turn.turn_id).toBe(turnId);
      expect(outcome.receipt.message.sequence).toBe(2);

      const total = await countRows(
        'SELECT count(*) FROM conversation_messages WHERE conversation_id = $1',
        [conversation.conversationId],
      );
      expect(total).toBe(2);
    } finally {
      await winner.query('ROLLBACK').catch(() => undefined);
      winner.release();
    }
  });

  /**
   * The last line of defence, which the sequential cross-conversation case cannot reach: the same
   * submission id is committed by another transaction *while* this one is already past its dedupe
   * read, so only `UNIQUE (tenant_id, client_submission_id)` can stop it.
   */
  it('12b. conflicts on a submission id racing in from another conversation, writing nothing', async () => {
    const first = await createConversation(tenantA, 'cross-conversation race A');
    const second = await createConversation(tenantA, 'cross-conversation race B');
    const clientSubmissionId = randomUUID();
    const text = 'one submission id, two conversations';

    // The winner's row exists only inside an open transaction, so the loser's tenant-wide dedupe read
    // legitimately does not see it; the loser must be stopped by the index, not by luck.
    const winner = await db.pool.connect();
    try {
      const winnerPid = await backendPid(winner);
      const winnerMessageId = randomUUID();
      await winner.query('BEGIN');
      // Exactly what S-1 commits: message, Turn, and the counter that allocated the sequence.
      await winner.query(
        `INSERT INTO conversation_messages
           (id, tenant_id, conversation_id, sequence, kind, text, client_submission_id)
         VALUES ($1, $2, $3, 1, 'user', $4, $5)`,
        [winnerMessageId, first.tenantId, first.conversationId, text, clientSubmissionId],
      );
      await winner.query(
        `INSERT INTO assistant_turns (id, tenant_id, conversation_id, source_message_id, deadline_at)
         VALUES ($1, $2, $3, $4, now() + interval '60 seconds')`,
        [randomUUID(), first.tenantId, first.conversationId, winnerMessageId],
      );
      await winner.query(
        'UPDATE conversations SET last_sequence = 1, updated_at = now() WHERE id = $1',
        [first.conversationId],
      );

      const loser = submit(writerA, second, { clientSubmissionId, text });

      await waitForTransactionIdWait(db, winnerPid);
      await winner.query('COMMIT');

      // CTO Decision 0002: the same 409 as the sequential case, and the loser's own sequence bump is
      // rolled back with it, so the second Conversation is exactly as it was before the attempt.
      await expectDomainError(loser, 'IDEMPOTENCY_CONFLICT');
      expect((await readConversationRow(second.conversationId)).last_sequence).toBe(0);
      expect(
        await countRows('SELECT count(*) FROM conversation_messages WHERE conversation_id = $1', [
          second.conversationId,
        ]),
      ).toBe(0);
    } finally {
      await winner.query('ROLLBACK').catch(() => undefined);
      winner.release();
    }
  });

  it('13. enforces the rolling 24 h quota at its boundary and window', async () => {
    const conversation = await createConversation(tenantA, 'quota');
    const fill = B1_MESSAGE_QUOTA_LIMIT - 1;

    // Seed `fill` user messages, each with its own turn, so the quota boundary is the only variable.
    await db.pool.query(
      `WITH seeded AS (
         INSERT INTO conversation_messages
           (id, tenant_id, conversation_id, sequence, kind, text, client_submission_id)
         SELECT gen_random_uuid(), $1, $2, s, 'user', 'quota filler', gen_random_uuid()
           FROM generate_series(1, $3::int) AS s(s)
         RETURNING id, tenant_id, conversation_id
       )
       INSERT INTO assistant_turns (id, tenant_id, conversation_id, source_message_id, deadline_at)
       SELECT gen_random_uuid(), tenant_id, conversation_id, id, now() + interval '60 seconds'
         FROM seeded`,
      [conversation.tenantId, conversation.conversationId, fill],
    );
    await db.pool.query(
      'UPDATE conversations SET last_sequence = $2, updated_at = now() WHERE id = $1',
      [conversation.conversationId, fill],
    );

    // The 200th message inside the window is still inside the quota.
    const boundarySubmissionId = randomUUID();
    const boundary = await submit(writerA, conversation, {
      clientSubmissionId: boundarySubmissionId,
      text: 'the boundary message',
    });
    expect(boundary.receipt.message.sequence).toBe(B1_MESSAGE_QUOTA_LIMIT);

    const rejected = await expectDomainError(
      submit(writerA, conversation, { text: 'one message too many' }),
      'BUDGET_EXCEEDED',
    );
    expect(rejected.publicMessage).toBe('Budget exceeded');
    expect((await readConversationRow(conversation.conversationId)).last_sequence).toBe(
      B1_MESSAGE_QUOTA_LIMIT,
    );
    const afterRejection = await countRows(
      'SELECT count(*) FROM conversation_messages WHERE conversation_id = $1',
      [conversation.conversationId],
    );
    expect(afterRejection).toBe(B1_MESSAGE_QUOTA_LIMIT);

    // A rejected send must not cost a legitimate replay either (S-2 writes nothing new), and the
    // quota is spent by accepted submissions, not by retries of one that already committed.
    const replay = await submit(writerA, conversation, {
      clientSubmissionId: boundarySubmissionId,
      text: 'the boundary message',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(boundary.receipt);

    // Rolling window: aging the filler out of the window makes room again.
    await db.pool.query(
      `UPDATE conversation_messages
          SET created_at = now() - interval '25 hours'
        WHERE conversation_id = $1 AND kind = 'user' AND text = 'quota filler'`,
      [conversation.conversationId],
    );

    const afterWindow = await submit(writerA, conversation, { text: 'after the window rolled' });
    expect(afterWindow.replayed).toBe(false);
    expect(afterWindow.receipt.message.sequence).toBe(B1_MESSAGE_QUOTA_LIMIT + 1);
  });

  it('14. leaves no orphaned message or turn anywhere in the schema', async () => {
    await assertNoOrphanedMessagesOrTurns();
  });
});

/**
 * Poll until one backend is genuinely waiting on the Conversation row lock held by `holderPid`, so
 * a "concurrency" test fails loudly if the second writer never had to wait at all.
 */
async function waitForLockWait(database: TestDatabase, holderPid: number): Promise<number> {
  const deadline = Date.now() + 8_000;

  while (Date.now() < deadline) {
    const waiting = await database.adminPool.query<{ pid: number }>(
      `SELECT pid
         FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND $1 = ANY (pg_blocking_pids(pid))
          AND query LIKE '%FOR UPDATE%'`,
      [holderPid],
    );
    const pid = waiting.rows[0]?.pid;

    if (pid !== undefined) {
      return pid;
    }

    await sleep(20);
  }

  throw new Error(`no backend waited on the Conversation row lock held by ${holderPid}`);
}

/**
 * Poll until one backend is blocked on the uncommitted transaction of `holderPid` — the wait a
 * unique-index insertion pays when the winning tuple belongs to a writer that has not committed.
 */
async function waitForTransactionIdWait(
  database: TestDatabase,
  holderPid: number,
): Promise<number> {
  const deadline = Date.now() + 8_000;

  while (Date.now() < deadline) {
    const waiting = await database.adminPool.query<{ pid: number }>(
      `SELECT pid
         FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND wait_event = 'transactionid'
          AND $1 = ANY (pg_blocking_pids(pid))`,
      [holderPid],
    );
    const pid = waiting.rows[0]?.pid;

    if (pid !== undefined) {
      return pid;
    }

    await sleep(20);
  }

  throw new Error(`no backend waited on the uncommitted transaction of ${holderPid}`);
}
