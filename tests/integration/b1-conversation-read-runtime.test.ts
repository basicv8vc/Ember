import { randomUUID } from 'node:crypto';
import { B1ConversationPageSchema, B1SendMessageReceiptSchema } from '@ember/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  B1_MESSAGE_PAGE_DEFAULT_LIMIT,
  B1_MESSAGE_PAGE_MAX_LIMIT,
  PostgresB1ConversationReadRepository,
} from '../../packages/postgres/src/repositories/b1-conversation-read.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * B1-4A: the durable Conversation read side against real PostgreSQL 17.
 *
 * Every row here is direct SQL fixture data — no B1-3 write repository, no HTTP layer, no fake
 * production writer. A receipt is only proven immutable if the Turn transition that would change it is
 * written by hand exactly as the write path will write it, so the fixtures do that.
 */

interface ConversationFixture {
  readonly tenantId: string;
  readonly agentId: string;
  readonly conversationId: string;
}

/** RFC 3339 UTC, as `IsoDateTimeSchema` requires. Server-owned, so checked as shape not value. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface UserMessage {
  readonly kind: 'user';
  readonly message_id: string;
  readonly sequence: number;
  readonly text: string;
  readonly client_submission_id: string;
}

describe('B1-4A: Conversation read and Unknown-ACK recovery', () => {
  let db: TestDatabase;
  let repo: PostgresB1ConversationReadRepository;
  /** Per-conversation server sequence, mirrored into `conversations.last_sequence` as a writer would. */
  const sequences = new Map<string, number>();

  async function seedConversation(label: string): Promise<ConversationFixture> {
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, label]);
    await db.pool.query("INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')", [
      randomUUID(),
      tenantId,
    ]);
    await db.pool.query(
      'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
      [agentId, tenantId, `Ember ${label}`],
    );
    await db.pool.query(
      "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
      [conversationId, tenantId, agentId],
    );

    return { tenantId, agentId, conversationId };
  }

  async function allocateSequence(conversationId: string): Promise<number> {
    const next = (sequences.get(conversationId) ?? 0) + 1;
    sequences.set(conversationId, next);
    await db.pool.query('UPDATE conversations SET last_sequence = $2 WHERE id = $1', [
      conversationId,
      next,
    ]);

    return next;
  }

  async function insertMessage(input: {
    readonly fixture: ConversationFixture;
    readonly kind: string;
    readonly text?: string;
    readonly modelLabel?: string;
    readonly simulated?: boolean;
    readonly source?: string;
    readonly taskId?: string;
    readonly commitmentId?: string;
    readonly outcome?: unknown;
    readonly clientSubmissionId?: string;
    readonly sequence?: number;
  }): Promise<string> {
    const id = randomUUID();
    const sequence = input.sequence ?? (await allocateSequence(input.fixture.conversationId));
    await db.pool.query(
      `INSERT INTO conversation_messages
         (id, tenant_id, conversation_id, sequence, kind, text, model_label, simulated,
          source, task_id, commitment_id, outcome, client_submission_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        input.fixture.tenantId,
        input.fixture.conversationId,
        sequence,
        input.kind,
        input.text ?? null,
        input.modelLabel ?? null,
        input.simulated ?? null,
        input.source ?? null,
        input.taskId ?? null,
        input.commitmentId ?? null,
        input.outcome ?? null,
        input.clientSubmissionId ?? null,
      ],
    );

    return id;
  }

  function insertUserMessage(
    fixture: ConversationFixture,
    overrides: { readonly text?: string; readonly clientSubmissionId?: string } = {},
  ): Promise<string> {
    return insertMessage({
      fixture,
      kind: 'user',
      text: overrides.text ?? 'Book me a table for two on Friday',
      clientSubmissionId: overrides.clientSubmissionId ?? randomUUID(),
    });
  }

  function insertEmberMessage(fixture: ConversationFixture): Promise<string> {
    return insertMessage({
      fixture,
      kind: 'ember',
      text: 'I can do that.',
      modelLabel: 'ember-fake-llm-1',
      simulated: true,
    });
  }

  /** The Turn created alongside a user message (§6.4 S-1), starting out `running`. */
  async function insertTurn(
    fixture: ConversationFixture,
    sourceMessageId: string,
  ): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO assistant_turns (id, tenant_id, conversation_id, source_message_id, status, deadline_at)
       VALUES ($1, $2, $3, $4, 'running', now() + interval '30 seconds')`,
      [id, fixture.tenantId, fixture.conversationId, sourceMessageId],
    );

    return id;
  }

  /** `finishTurn` as B1-3 would do it: a response message plus the running -> completed transition. */
  async function completeTurn(fixture: ConversationFixture, turnId: string): Promise<void> {
    const responseId = await insertEmberMessage(fixture);
    await db.pool.query(
      `UPDATE assistant_turns
          SET status = 'completed', response_message_id = $2, updated_at = now()
        WHERE tenant_id = $1 AND id = $3`,
      [fixture.tenantId, responseId, turnId],
    );
  }

  async function failTurn(fixture: ConversationFixture, turnId: string): Promise<void> {
    const safeMessageId = await insertEmberMessage(fixture);
    await db.pool.query(
      `UPDATE assistant_turns
          SET status = 'failed', failure_reason = 'timeout', response_message_id = $2, updated_at = now()
        WHERE tenant_id = $1 AND id = $3`,
      [fixture.tenantId, safeMessageId, turnId],
    );
  }

  async function cancelTurn(fixture: ConversationFixture, turnId: string): Promise<void> {
    await db.pool.query(
      `UPDATE assistant_turns
          SET status = 'cancelled', updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [fixture.tenantId, turnId],
    );
  }

  /** §10.4 deletion as the clear-transcript route would do it: rows gone (Turns cascade), epoch +1. */
  async function deleteTranscript(fixture: ConversationFixture): Promise<void> {
    await db.pool.query('DELETE FROM conversation_messages WHERE tenant_id = $1', [
      fixture.tenantId,
    ]);
    await db.pool.query(
      'UPDATE conversations SET transcript_epoch = transcript_epoch + 1 WHERE id = $1',
      [fixture.conversationId],
    );
  }

  /** A second `main` Conversation for the same tenant, backed by its own Agent (C-1). */
  async function seedSiblingConversation(
    fixture: ConversationFixture,
    label: string,
  ): Promise<ConversationFixture> {
    const agentId = randomUUID();
    const conversationId = randomUUID();
    await db.pool.query(
      'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
      [agentId, fixture.tenantId, `Ember ${label}`],
    );
    await db.pool.query(
      "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
      [conversationId, fixture.tenantId, agentId],
    );

    return { tenantId: fixture.tenantId, agentId, conversationId };
  }

  async function seedTask(fixture: ConversationFixture): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO tasks (id, tenant_id, agent_id, kind, input, digest, idempotency_key)
       VALUES ($1, $2, $3, 'mock.chat', '{}'::jsonb, $4, $5)`,
      [id, fixture.tenantId, fixture.agentId, 'a'.repeat(64), `task-${id}`],
    );

    return id;
  }

  async function seedCommitment(fixture: ConversationFixture): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO commitments (id, tenant_id, agent_id, title, schedule_kind, source_profile_id)
       VALUES ($1, $2, $3, 'Read-side fixture', 'once', 'test.profile')`,
      [id, fixture.tenantId, fixture.agentId],
    );

    return id;
  }

  const readPageIn = (
    tenantId: string,
    conversationId: string,
    after = 0,
    limit = B1_MESSAGE_PAGE_DEFAULT_LIMIT,
  ) => repo.readMessages({ tenantId, conversationId, after, limit });

  const readPage = (
    fixture: ConversationFixture,
    after = 0,
    limit = B1_MESSAGE_PAGE_DEFAULT_LIMIT,
  ) => readPageIn(fixture.tenantId, fixture.conversationId, after, limit);

  const findReceipt = (fixture: ConversationFixture, clientSubmissionId: string) =>
    repo.findSubmissionReceipt({ tenantId: fixture.tenantId, clientSubmissionId });

  function requireUserMessage(message: unknown): UserMessage {
    if (
      typeof message !== 'object' ||
      message === null ||
      (message as { kind?: unknown }).kind !== 'user'
    ) {
      throw new Error('expected a user message');
    }

    return message as UserMessage;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    repo = new PostgresB1ConversationReadRepository(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('runs against a real PostgreSQL 17', async () => {
    const result = await db.pool.query<{ version: string }>('SELECT version() AS version');
    expect(result.rows[0]?.version).toMatch(/^PostgreSQL 17\./);
  });

  describe('1-2: main Conversation lookup and masking', () => {
    it('returns the tenant-qualified main Conversation with its current epoch', async () => {
      const fixture = await seedConversation('main lookup');
      await insertUserMessage(fixture);
      await insertEmberMessage(fixture);

      expect(await repo.getMainConversation(fixture.tenantId, fixture.agentId)).toEqual({
        conversationId: fixture.conversationId,
        tenantId: fixture.tenantId,
        agentId: fixture.agentId,
        transcriptEpoch: 0,
        lastSequence: 2,
      });
    });

    it('masks an unknown agent and another tenant agent identically', async () => {
      const own = await seedConversation('masking own');
      const other = await seedConversation('masking other');
      await insertUserMessage(other);

      // An agent id that was never issued and another tenant's agent id give the same answer: null.
      expect(await repo.getMainConversation(own.tenantId, randomUUID())).toBeNull();
      expect(await repo.getMainConversation(own.tenantId, other.agentId)).toBeNull();
      // The mask is not a blanket failure: the owner still resolves its own Conversation.
      expect(await repo.getMainConversation(own.tenantId, own.agentId)).not.toBeNull();
      expect(await repo.getMainConversation(other.tenantId, other.agentId)).not.toBeNull();
    });

    it('never resolves a tenant from a Conversation id', async () => {
      const own = await seedConversation('no tenant inference own');
      const other = await seedConversation('no tenant inference other');
      await insertUserMessage(other);

      // Another tenant's Conversation id is not a lookup key for its owner.
      await expect(readPageIn(own.tenantId, other.conversationId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(await repo.getMainConversation(own.tenantId, other.agentId)).toBeNull();
    });
  });

  describe('3-6: pagination', () => {
    it('returns a well-formed empty page for a Conversation with no messages', async () => {
      const fixture = await seedConversation('empty page');

      expect(await readPage(fixture)).toEqual({
        conversation_id: fixture.conversationId,
        transcript_epoch: 0,
        messages: [],
        next_after: 0,
        has_more: false,
      });
    });

    it('echoes the caller cursor as next_after for a page past the end', async () => {
      const fixture = await seedConversation('past the end');
      for (let index = 0; index < 3; index += 1) {
        await insertUserMessage(fixture);
      }

      const page = await readPage(fixture, 3, 10);

      // O-5: an empty page echoes `after` rather than inventing a cursor.
      expect(page.messages).toHaveLength(0);
      expect(page.next_after).toBe(3);
      expect(page.has_more).toBe(false);
      expect(page.transcript_epoch).toBe(0);
    });

    it('returns a single page of everything when the limit exceeds the history', async () => {
      const fixture = await seedConversation('single page');
      for (let index = 0; index < 4; index += 1) {
        await insertUserMessage(fixture);
      }

      const page = await readPage(fixture, 0, B1_MESSAGE_PAGE_MAX_LIMIT);

      expect(page.messages.map((message) => message.sequence)).toEqual([1, 2, 3, 4]);
      expect(page.next_after).toBe(4);
      expect(page.has_more).toBe(false);
    });

    it('walks multiple pages without duplicating or omitting a row', async () => {
      const fixture = await seedConversation('multiple pages');
      const total = 23;
      for (let index = 0; index < total; index += 1) {
        await insertUserMessage(fixture);
      }

      const seen: number[] = [];
      let cursor = 0;
      let pages = 0;

      for (;;) {
        const page = await readPage(fixture, cursor, 5);
        pages += 1;
        seen.push(...page.messages.map((message) => message.sequence));
        cursor = page.next_after;

        if (!page.has_more) {
          break;
        }

        if (pages > 20) {
          throw new Error('pagination did not terminate');
        }
      }

      expect(seen).toEqual(Array.from({ length: total }, (_, index) => index + 1));
      expect(pages).toBe(5);
      expect(new Set(seen).size).toBe(total);
    });

    it('honours exact cursor boundaries, including limit multiples', async () => {
      const fixture = await seedConversation('cursor boundaries');
      for (let index = 0; index < 10; index += 1) {
        await insertUserMessage(fixture);
      }

      // `after` is exclusive: the row at the cursor is never re-delivered.
      const second = await readPage(fixture, 1, 1);
      expect(second.messages.map((message) => message.sequence)).toEqual([2]);
      expect(second.has_more).toBe(true);

      // A page that exactly fills the limit with nothing left over reports no more history.
      const exact = await readPage(fixture, 0, 10);
      expect(exact.messages).toHaveLength(10);
      expect(exact.next_after).toBe(10);
      expect(exact.has_more).toBe(false);

      // One short of the limit reports more, and the following page carries exactly the last row.
      const almost = await readPage(fixture, 0, 9);
      expect(almost.has_more).toBe(true);
      expect(almost.next_after).toBe(9);
      const remainder = await readPage(fixture, almost.next_after, 9);
      expect(remainder.messages.map((message) => message.sequence)).toEqual([10]);
      expect(remainder.has_more).toBe(false);

      const afterEnd = await readPage(fixture, 10, 10);
      expect(afterEnd.messages).toHaveLength(0);
      expect(afterEnd.next_after).toBe(10);
    });

    it('enforces the contract bounds on limit and after', async () => {
      const fixture = await seedConversation('bounds');
      await insertUserMessage(fixture);

      const invalidCases = [
        { after: 0, limit: 0 },
        { after: 0, limit: B1_MESSAGE_PAGE_MAX_LIMIT + 1 },
        { after: -1, limit: 10 },
        { after: 1.5, limit: 10 },
        { after: 0, limit: 2.5 },
      ];

      for (const invalidCase of invalidCases) {
        await expect(readPage(fixture, invalidCase.after, invalidCase.limit)).rejects.toMatchObject(
          {
            code: 'INVALID_ARGUMENT',
          },
        );
      }

      // The legal extremes are accepted.
      expect((await readPage(fixture, 0, 1)).messages).toHaveLength(1);
      expect((await readPage(fixture, 0, B1_MESSAGE_PAGE_MAX_LIMIT)).messages).toHaveLength(1);
    });

    it('answers the identical NOT_FOUND for an absent and a foreign Conversation', async () => {
      const own = await seedConversation('notfound own');
      const other = await seedConversation('notfound other');
      await insertUserMessage(other);

      const absent = await readPageIn(own.tenantId, randomUUID())
        .then(() => null)
        .catch((error: unknown) => error);
      const foreign = await readPageIn(own.tenantId, other.conversationId)
        .then(() => null)
        .catch((error: unknown) => error);

      const shape = (error: unknown): { code: string; publicMessage: string } => ({
        code: String((error as { code?: unknown }).code),
        publicMessage: String((error as { publicMessage?: unknown }).publicMessage),
      });

      // ISO-3 / C-3: cross-tenant access is indistinguishable from non-existence, down to the text.
      expect(shape(foreign)).toEqual(shape(absent));
      expect(shape(absent).code).toBe('NOT_FOUND');
    });
  });

  describe('7: the six Message variants', () => {
    it('maps every variant into the frozen union and validates the DTO', async () => {
      const fixture = await seedConversation('six kinds');
      const taskId = await seedTask(fixture);
      const commitmentId = await seedCommitment(fixture);
      const clientSubmissionId = randomUUID();
      const outcome = {
        outcome_kind: 'meaningful_change',
        task_id: taskId,
        commitment_id: commitmentId,
      };

      const userId = await insertUserMessage(fixture, { clientSubmissionId });
      const emberId = await insertEmberMessage(fixture);
      const activityId = await insertMessage({
        fixture,
        kind: 'activity',
        text: 'Reviewed 3 sources',
        source: 'notes',
      });
      const taskRefId = await insertMessage({ fixture, kind: 'task_reference', taskId });
      const commitmentRefId = await insertMessage({
        fixture,
        kind: 'commitment_reference',
        commitmentId,
      });
      const outcomeRefId = await insertMessage({ fixture, kind: 'outcome_reference', outcome });

      const page = await readPage(fixture);

      expect(page.messages.map((message) => message.kind)).toEqual([
        'user',
        'ember',
        'activity',
        'task_reference',
        'commitment_reference',
        'outcome_reference',
      ]);
      // Re-parse with the frozen schema: what left the repository is wire data, not a superset.
      expect(B1ConversationPageSchema.safeParse(page).success).toBe(true);

      expect(page.messages).toMatchObject([
        {
          message_id: userId,
          sequence: 1,
          kind: 'user',
          text: 'Book me a table for two on Friday',
          client_submission_id: clientSubmissionId,
        },
        {
          message_id: emberId,
          sequence: 2,
          kind: 'ember',
          text: 'I can do that.',
          model_label: 'ember-fake-llm-1',
          simulated: true,
        },
        {
          message_id: activityId,
          sequence: 3,
          kind: 'activity',
          text: 'Reviewed 3 sources',
          source: 'notes',
        },
        { message_id: taskRefId, sequence: 4, kind: 'task_reference', task_id: taskId },
        {
          message_id: commitmentRefId,
          sequence: 5,
          kind: 'commitment_reference',
          commitment_id: commitmentId,
        },
        { message_id: outcomeRefId, sequence: 6, kind: 'outcome_reference', outcome },
      ]);
      // Server-owned timestamps are asserted as shape rather than pinned to a value.
      expect(page.messages).toHaveLength(6);
      for (const message of page.messages) {
        expect(message.created_at).toMatch(ISO_TIMESTAMP);
      }
    });

    it('returns client_submission_id on user rows and on no other kind (RD-5)', async () => {
      const fixture = await seedConversation('rd5');
      const taskId = await seedTask(fixture);
      const commitmentId = await seedCommitment(fixture);
      await insertUserMessage(fixture);
      await insertEmberMessage(fixture);
      await insertMessage({ fixture, kind: 'activity', text: 'Reviewed notes', source: 'notes' });
      await insertMessage({ fixture, kind: 'task_reference', taskId });
      await insertMessage({ fixture, kind: 'commitment_reference', commitmentId });
      await insertMessage({
        fixture,
        kind: 'outcome_reference',
        outcome: { outcome_kind: 'no_change', task_id: taskId, commitment_id: null },
      });

      const page = await readPage(fixture);

      // Exact field sets, so nothing but the frozen variant's own columns can reach the wire.
      expect(page.messages.map((message) => Object.keys(message).sort())).toEqual([
        ['client_submission_id', 'created_at', 'kind', 'message_id', 'sequence', 'text'],
        ['created_at', 'kind', 'message_id', 'model_label', 'sequence', 'simulated', 'text'],
        ['created_at', 'kind', 'message_id', 'sequence', 'source', 'text'],
        ['created_at', 'kind', 'message_id', 'sequence', 'task_id'],
        ['commitment_id', 'created_at', 'kind', 'message_id', 'sequence'],
        ['created_at', 'kind', 'message_id', 'outcome', 'sequence'],
      ]);
      expect(page.messages.map((message) => 'client_submission_id' in message)).toEqual([
        true,
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(Object.keys(page).sort()).toEqual([
        'conversation_id',
        'has_more',
        'messages',
        'next_after',
        'transcript_epoch',
      ]);
    });

    it('fails closed rather than coercing a row that matches no frozen variant (M-1)', async () => {
      const fixture = await seedConversation('malformed outcome');
      const taskId = await seedTask(fixture);
      await insertUserMessage(fixture);
      // The shape CHECK only requires `outcome IS NOT NULL`, so a malformed jsonb document is
      // reachable data. The frozen arm needs outcome_kind/task_id/commitment_id.
      await db.pool.query(
        `INSERT INTO conversation_messages
           (id, tenant_id, conversation_id, sequence, kind, outcome)
         VALUES ($1, $2, $3, 2, 'outcome_reference', $4::jsonb)`,
        [
          randomUUID(),
          fixture.tenantId,
          fixture.conversationId,
          JSON.stringify({ outcome_kind: 'unexpected', task_id: taskId }),
        ],
      );
      await db.pool.query('UPDATE conversations SET last_sequence = 2 WHERE id = $1', [
        fixture.conversationId,
      ]);

      await expect(readPage(fixture)).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
    });

    it('rejects a user row written without its submission id (shape CHECK)', async () => {
      const fixture = await seedConversation('shape guard');
      // M-1 has an upstream guard: the database rejects the row, so no read ever has to guess.
      await expect(
        db.pool.query(
          `INSERT INTO conversation_messages (id, tenant_id, conversation_id, sequence, kind, text)
           VALUES ($1, $2, $3, 1, 'user', 'no submission id')`,
          [randomUUID(), fixture.tenantId, fixture.conversationId],
        ),
      ).rejects.toThrow(/conversation_messages_shape_check/);
    });
  });

  describe('8: cross-tenant isolation of message history', () => {
    it('never returns another tenant rows in either direction (ISO-6)', async () => {
      const alice = await seedConversation('alice');
      const bob = await seedConversation('bob');
      await insertUserMessage(alice, { text: 'Alice plan' });
      await insertUserMessage(bob, { text: 'Bob plan' });

      const aliceFirst = requireUserMessage((await readPage(alice)).messages[0]);
      const bobFirst = requireUserMessage((await readPage(bob)).messages[0]);
      expect(aliceFirst.text).toBe('Alice plan');
      expect(bobFirst.text).toBe('Bob plan');

      // Bob cannot page Alice's Conversation even with a cursor taken from his own history.
      await expect(
        repo.readMessages({
          tenantId: bob.tenantId,
          conversationId: alice.conversationId,
          after: bobFirst.sequence,
          limit: 50,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // And the other direction, A reading B, fails the same way.
      await expect(
        repo.readMessages({
          tenantId: alice.tenantId,
          conversationId: bob.conversationId,
          after: aliceFirst.sequence,
          limit: 50,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('keeps identical message text in two tenants apart', async () => {
      const first = await seedConversation('same text first');
      const second = await seedConversation('same text second');
      const shared = 'Identical text in two tenants';
      const firstId = await insertUserMessage(first, { text: shared });
      await insertUserMessage(second, { text: shared });

      const page = await readPage(first);
      expect(page.messages).toHaveLength(1);
      expect(page.conversation_id).toBe(first.conversationId);
      expect(page.messages[0]?.message_id).toBe(firstId);
    });
  });

  describe('9-14: Unknown-ACK reconciliation', () => {
    it('returns null for a submission id that never committed', async () => {
      const fixture = await seedConversation('unknown submission');
      await insertUserMessage(fixture);

      expect(await findReceipt(fixture, randomUUID())).toBeNull();
    });

    it('reconstructs the original POST receipt for a known submission', async () => {
      const fixture = await seedConversation('known submission');
      const clientSubmissionId = randomUUID();
      const messageId = await insertUserMessage(fixture, {
        text: 'Remind me to call the clinic',
        clientSubmissionId,
      });
      const turnId = await insertTurn(fixture, messageId);

      const receipt = await findReceipt(fixture, clientSubmissionId);

      expect(receipt).not.toBeNull();
      // The frozen receipt schema is a `strictObject`, so a successful parse also proves the shape
      // carries no extra field.
      expect(B1SendMessageReceiptSchema.safeParse(receipt).success).toBe(true);
      expect(receipt?.message).toMatchObject({
        message_id: messageId,
        conversation_id: fixture.conversationId,
        sequence: 1,
        kind: 'user',
        text: 'Remind me to call the clinic',
        client_submission_id: clientSubmissionId,
      });
      expect(receipt?.turn).toMatchObject({ turn_id: turnId, status: 'running' });
      expect(receipt?.transcript_epoch).toBe(0);
      if (receipt === null) {
        return;
      }
      expect(receipt.message.created_at).toMatch(ISO_TIMESTAMP);
      expect(receipt.turn.created_at).toMatch(ISO_TIMESTAMP);
    });

    it('recovers a receipt with no conversation id in a two-conversation tenant (Decision 0002)', async () => {
      const first = await seedConversation('tenant-wide lookup first');
      const second = await seedSiblingConversation(first, 'tenant-wide lookup second');
      const clientSubmissionId = randomUUID();
      // The submission lands in the tenant's second Conversation.
      const messageId = await insertUserMessage(second, { clientSubmissionId });
      const turnId = await insertTurn(second, messageId);

      // The lookup key is (tenant, submission) alone. No conversation is named, and the answer is
      // still unambiguous because the tenant-wide unique key admits exactly one live row.
      const receipt = await repo.findSubmissionReceipt({
        tenantId: first.tenantId,
        clientSubmissionId,
      });

      expect(receipt?.message.message_id).toBe(messageId);
      expect(receipt?.message.conversation_id).toBe(second.conversationId);
      expect(receipt?.turn.turn_id).toBe(turnId);
    });

    it('refuses to narrow the Unknown-ACK lookup by conversation id', async () => {
      const fixture = await seedConversation('no conversation parameter');
      const clientSubmissionId = randomUUID();
      const messageId = await insertUserMessage(fixture, { clientSubmissionId });
      await insertTurn(fixture, messageId);

      // A conversation id is not part of the frozen surface, and it is not silently ignored either:
      // it fails closed, so no call site can narrow the key and change what an Unknown ACK means.
      await expect(
        repo.findSubmissionReceipt({
          tenantId: fixture.tenantId,
          clientSubmissionId,
          // @ts-expect-error the surface is { tenantId, clientSubmissionId } only.
          conversationId: fixture.conversationId,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

      // The same lookup without it succeeds.
      const receipt = await repo.findSubmissionReceipt({
        tenantId: fixture.tenantId,
        clientSubmissionId,
      });
      expect(receipt?.message.message_id).toBe(messageId);
    });

    it('distinguishes two tenants that reuse the same submission id', async () => {
      const alice = await seedConversation('shared submission alice');
      const bob = await seedConversation('shared submission bob');
      // CTO Decision 0002: different tenants may use the same submission id.
      const sharedSubmission = randomUUID();
      const aliceMessage = await insertUserMessage(alice, {
        text: 'Alice version',
        clientSubmissionId: sharedSubmission,
      });
      const bobMessage = await insertUserMessage(bob, {
        text: 'Bob version',
        clientSubmissionId: sharedSubmission,
      });
      await insertTurn(alice, aliceMessage);
      await insertTurn(bob, bobMessage);

      const aliceReceipt = await findReceipt(alice, sharedSubmission);
      const bobReceipt = await findReceipt(bob, sharedSubmission);

      expect(aliceReceipt?.message.message_id).toBe(aliceMessage);
      expect(bobReceipt?.message.message_id).toBe(bobMessage);
      expect(aliceReceipt?.message.text).toBe('Alice version');
      expect(bobReceipt?.message.text).toBe('Bob version');
      expect(aliceReceipt?.message.conversation_id).toBe(alice.conversationId);

      // A third tenant reads neither receipt, exactly as if the id had never been used.
      const stranger = await seedConversation('shared submission stranger');
      expect(await findReceipt(stranger, sharedSubmission)).toBeNull();
    });

    it('keeps the receipt byte-equivalent after the Turn completes', async () => {
      const fixture = await seedConversation('receipt after completion');
      const clientSubmissionId = randomUUID();
      const messageId = await insertUserMessage(fixture, { clientSubmissionId });
      const turnId = await insertTurn(fixture, messageId);

      const before = await findReceipt(fixture, clientSubmissionId);
      expect(before).not.toBeNull();
      if (before === null) {
        return;
      }

      await completeTurn(fixture, turnId);

      const after = await findReceipt(fixture, clientSubmissionId);
      expect(after).toEqual(before);
      // Byte-equivalent, not merely structurally equal.
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      expect(after?.turn.turn_id).toBe(turnId);
      // The acknowledged status stays `running`; the current status is a different question (§7.4).
      expect(after?.turn.status).toBe('running');

      const stored = await db.pool.query<{ status: string }>(
        'SELECT status FROM assistant_turns WHERE tenant_id = $1 AND id = $2',
        [fixture.tenantId, turnId],
      );
      expect(stored.rows[0]?.status).toBe('completed');

      // The completion is readable as new history rather than as a rewritten receipt.
      const page = await readPage(fixture);
      expect(page.messages.map((message) => message.kind)).toEqual(['user', 'ember']);
    });

    it('keeps the receipt stable after a failed and after a cancelled Turn', async () => {
      const failedFixture = await seedConversation('receipt after failure');
      const failedSubmission = randomUUID();
      const failedMessage = await insertUserMessage(failedFixture, {
        clientSubmissionId: failedSubmission,
      });
      const failedTurn = await insertTurn(failedFixture, failedMessage);
      const failedBefore = await findReceipt(failedFixture, failedSubmission);
      await failTurn(failedFixture, failedTurn);

      const failedAfter = await findReceipt(failedFixture, failedSubmission);
      expect(JSON.stringify(failedAfter)).toBe(JSON.stringify(failedBefore));
      expect(failedAfter?.turn.status).toBe('running');

      const cancelledFixture = await seedConversation('receipt after cancel');
      const cancelledSubmission = randomUUID();
      const cancelledMessage = await insertUserMessage(cancelledFixture, {
        clientSubmissionId: cancelledSubmission,
      });
      const cancelledTurn = await insertTurn(cancelledFixture, cancelledMessage);
      const cancelledBefore = await findReceipt(cancelledFixture, cancelledSubmission);
      await cancelTurn(cancelledFixture, cancelledTurn);

      const cancelledAfter = await findReceipt(cancelledFixture, cancelledSubmission);
      expect(JSON.stringify(cancelledAfter)).toBe(JSON.stringify(cancelledBefore));
      // A cancelled Turn may have no response message, so the receipt cannot have learned it by joining.
      expect(cancelledAfter?.turn.turn_id).toBe(cancelledTurn);

      const stored = await db.pool.query<{ status: string }>(
        `SELECT status, updated_at > created_at AS advanced
           FROM assistant_turns WHERE tenant_id = $1 AND id = $2`,
        [cancelledFixture.tenantId, cancelledTurn],
      );
      expect(stored.rows[0]).toEqual({ status: 'cancelled', advanced: true });
    });

    it('drops the receipt when the transcript is deleted (TE-6)', async () => {
      const fixture = await seedConversation('receipt after deletion');
      const clientSubmissionId = randomUUID();
      const messageId = await insertUserMessage(fixture, { clientSubmissionId });
      const turnId = await insertTurn(fixture, messageId);
      expect(await findReceipt(fixture, clientSubmissionId)).not.toBeNull();

      await deleteTranscript(fixture);

      expect(await findReceipt(fixture, clientSubmissionId)).toBeNull();
      // The message and its Turn are gone rather than tombstoned.
      const leftovers = await db.pool.query<{ messages: string; turns: string }>(
        `SELECT (SELECT count(*)::text FROM conversation_messages WHERE id = $1) AS messages,
                (SELECT count(*)::text FROM assistant_turns WHERE id = $2) AS turns`,
        [messageId, turnId],
      );
      expect(leftovers.rows[0]).toEqual({ messages: '0', turns: '0' });
      // History is absent from pages too, and the epoch is what tells the client (RD-6).
      const page = await readPage(fixture);
      expect(page.messages).toHaveLength(0);
      expect(page.transcript_epoch).toBe(1);
      expect(page.next_after).toBe(0);
    });

    it('reports the current transcript epoch everywhere it is exposed', async () => {
      const fixture = await seedConversation('epoch tracking');
      const staleSubmission = randomUUID();
      const staleMessage = await insertUserMessage(fixture, {
        clientSubmissionId: staleSubmission,
      });
      await insertTurn(fixture, staleMessage);

      expect(
        (await repo.getMainConversation(fixture.tenantId, fixture.agentId))?.transcriptEpoch,
      ).toBe(0);
      expect((await readPage(fixture)).transcript_epoch).toBe(0);
      expect((await findReceipt(fixture, staleSubmission))?.transcript_epoch).toBe(0);

      await deleteTranscript(fixture);
      // Post-deletion appends continue the sequence, so a stale cursor cannot resurrect old rows.
      const freshSubmission = randomUUID();
      const freshMessage = await insertUserMessage(fixture, {
        clientSubmissionId: freshSubmission,
      });
      const freshTurn = await insertTurn(fixture, freshMessage);

      const identity = await repo.getMainConversation(fixture.tenantId, fixture.agentId);
      expect(identity?.transcriptEpoch).toBe(1);
      expect(identity?.lastSequence).toBe(2);

      const page = await readPage(fixture);
      expect(page.transcript_epoch).toBe(1);
      expect(page.messages.map((message) => message.sequence)).toEqual([2]);
      // The deleted submission stays invisible, and the new one carries the new generation.
      expect(await findReceipt(fixture, staleSubmission)).toBeNull();
      const freshReceipt = await findReceipt(fixture, freshSubmission);
      expect(freshReceipt?.transcript_epoch).toBe(1);
      expect(freshReceipt?.turn.turn_id).toBe(freshTurn);

      // A second deletion increments again (§10.4 idempotence of the increment).
      await deleteTranscript(fixture);
      expect(
        (await repo.getMainConversation(fixture.tenantId, fixture.agentId))?.transcriptEpoch,
      ).toBe(2);
      expect((await readPage(fixture, 2)).transcript_epoch).toBe(2);
    });
  });

  describe('15: snapshot consistency under concurrent append and deletion', () => {
    it('never pairs an epoch with rows that only existed at an earlier epoch', async () => {
      const fixture = await seedConversation('concurrent deletion');
      const originalIds: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        originalIds.push(await insertUserMessage(fixture));
      }

      const deleter = await db.pool.connect();
      let settled = false;

      try {
        // Hold the deletion open, then commit it while readers are in flight, so a reader that
        // observed the epoch and the rows separately can catch the commit between its observations.
        await deleter.query('BEGIN');
        await deleter.query('DELETE FROM conversation_messages WHERE tenant_id = $1', [
          fixture.tenantId,
        ]);
        await deleter.query(
          'UPDATE conversations SET transcript_epoch = transcript_epoch + 1, updated_at = now() WHERE id = $1',
          [fixture.conversationId],
        );

        // Uncommitted: the page is still the pre-deletion transcript at the old epoch.
        const beforeCommit = await readPage(fixture);
        expect(beforeCommit.transcript_epoch).toBe(0);
        expect(beforeCommit.messages.map((message) => message.sequence)).toEqual(
          Array.from({ length: 12 }, (_, index) => index + 1),
        );

        const straddled = await Promise.all([
          readPage(fixture, 0, 2),
          deleter.query('COMMIT').then(() => 'committed' as const),
          readPage(fixture, 0, 3),
          readPage(fixture, 0, 50),
        ]);
        settled = true;

        for (const page of [straddled[0], straddled[2], straddled[3]]) {
          const ids = page.messages.map((message) => message.message_id);
          if (page.transcript_epoch === 0) {
            // Pre-commit snapshot: only rows that belonged to generation 0.
            expect(ids.every((id) => originalIds.includes(id))).toBe(true);
          } else {
            // Generation 1 must never be presented with rows from generation 0.
            expect(page.transcript_epoch).toBe(1);
            expect(ids.filter((id) => originalIds.includes(id))).toEqual([]);
            expect(page.messages).toHaveLength(0);
            expect(page.next_after).toBe(0);
            expect(page.has_more).toBe(false);
          }
          expect(B1ConversationPageSchema.safeParse(page).success).toBe(true);
        }

        const afterCommit = await readPage(fixture);
        expect(afterCommit.transcript_epoch).toBe(1);
        expect(afterCommit.messages).toHaveLength(0);
        expect(afterCommit.next_after).toBe(0);
        expect(afterCommit.has_more).toBe(false);
      } finally {
        if (!settled) {
          await deleter.query('ROLLBACK').catch(() => undefined);
        }
        deleter.release();
      }
    });

    it('proves a split epoch/messages read would contradict itself', async () => {
      // Control for the test above: the forbidden page is reachable if the two halves are read as
      // separate statements. The repository cannot produce it because it issues exactly one.
      const fixture = await seedConversation('split read control');
      for (let index = 0; index < 4; index += 1) {
        await insertUserMessage(fixture);
      }

      const rowsFirst = await db.pool.query<{ id: string }>(
        `SELECT id FROM conversation_messages
          WHERE tenant_id = $1 AND conversation_id = $2 AND sequence > 0
          ORDER BY sequence ASC LIMIT 50`,
        [fixture.tenantId, fixture.conversationId],
      );

      await deleteTranscript(fixture);

      const epochAfter = await db.pool.query<{ transcript_epoch: string }>(
        'SELECT transcript_epoch FROM conversations WHERE id = $1',
        [fixture.conversationId],
      );

      // Rows observed before the deletion, epoch observed after it: exactly the contradiction RD-6
      // cannot survive, and what a single statement makes unreachable.
      expect(rowsFirst.rows).toHaveLength(4);
      expect(epochAfter.rows[0]?.transcript_epoch).toBe('1');
    });

    it('keeps cursor metadata in step with rows appended concurrently', async () => {
      const fixture = await seedConversation('concurrent append');
      for (let index = 0; index < 6; index += 1) {
        await insertUserMessage(fixture);
      }

      const seen: number[] = [];
      let cursor = 0;
      let writerDone = false;
      let iterations = 0;

      const writer = (async () => {
        for (let index = 0; index < 6; index += 1) {
          await insertUserMessage(fixture);
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        writerDone = true;
      })();

      for (;;) {
        iterations += 1;
        const page = await readPage(fixture, cursor, 2);

        for (const message of page.messages) {
          seen.push(message.sequence);
        }

        // Metadata can only describe the rows that came back from the same snapshot.
        const last = page.messages.at(-1);
        expect(page.next_after).toBe(last === undefined ? cursor : last.sequence);
        expect(page.messages.length).toBeLessThanOrEqual(2);
        if (page.messages.length < 2) {
          // A short page proves the probe found nothing beyond it.
          expect(page.has_more).toBe(false);
        }
        cursor = page.next_after;

        if (!page.has_more && writerDone) {
          break;
        }
        if (iterations > 40 || seen.length > 60) {
          throw new Error('reader made no progress while the writer appended');
        }
        if (!page.has_more) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      }

      await writer;

      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      expect(new Set(seen).size).toBe(seen.length);
      const final = await readPage(fixture, 0, B1_MESSAGE_PAGE_MAX_LIMIT);
      expect(final.messages.map((message) => message.sequence)).toEqual(
        Array.from({ length: 12 }, (_, index) => index + 1),
      );
      // Nothing appended during the walk was skipped, and nothing was delivered twice.
      expect(new Set(seen)).toEqual(new Set(final.messages.map((message) => message.sequence)));
    });
  });
});
