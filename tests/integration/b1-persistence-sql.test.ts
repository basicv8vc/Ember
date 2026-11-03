import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * B1-1 negative database acceptance checks, against real PostgreSQL 17.
 * Auth/API/model execution are deliberately not exercised in this schema-only slice.
 */
describe('B1-1: durable Conversation and Consumer SQL invariants', () => {
  let db: TestDatabase;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const principalId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const otherPrincipalId = randomUUID();
  const otherAgentId = randomUUID();
  const otherConversationId = randomUUID();
  let nextSequence = 0;

  const sequence = (): number => ++nextSequence;

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4)', [
      tenantId,
      'B1 alpha',
      otherTenantId,
      'B1 other',
    ]);
    await db.pool.query(
      `INSERT INTO principals (id, tenant_id, role)
       VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
      [principalId, tenantId, otherPrincipalId, otherTenantId],
    );
    await db.pool.query(
      `INSERT INTO agents (id, tenant_id, name, policy_version)
       VALUES ($1, $2, 'Ember', 1), ($3, $4, 'Ember', 1)`,
      [agentId, tenantId, otherAgentId, otherTenantId],
    );
    await db.pool.query(
      `INSERT INTO conversations (id, tenant_id, agent_id, kind)
       VALUES ($1, $2, $3, 'main'), ($4, $5, $6, 'main')`,
      [conversationId, tenantId, agentId, otherConversationId, otherTenantId, otherAgentId],
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  it('creates Consumer, Session, Conversation, Turn and Task Result tables', async () => {
    const rows = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [
        [
          'consumers',
          'consumer_identities',
          'consumer_sessions',
          'conversations',
          'conversation_messages',
          'assistant_turns',
          'task_results',
        ],
      ],
    );
    expect(rows.rows.map((row) => row.table_name)).toEqual([
      'assistant_turns',
      'consumer_identities',
      'consumer_sessions',
      'consumers',
      'conversation_messages',
      'conversations',
      'task_results',
    ]);
  });

  it('enforces exactly one Consumer per tenant even for different principals', async () => {
    const firstConsumer = randomUUID();
    await db.pool.query('INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)', [
      firstConsumer,
      tenantId,
      principalId,
    ]);
    const secondPrincipal = randomUUID();
    await db.pool.query("INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')", [
      secondPrincipal,
      tenantId,
    ]);
    await expect(
      db.pool.query('INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)', [
        randomUUID(),
        tenantId,
        secondPrincipal,
      ]),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'consumers_one_per_tenant_unique',
    });
  });

  it("rejects another tenant's Conversation using a composite FK", async () => {
    await expect(
      db.pool.query(
        `INSERT INTO conversation_messages
           (id, tenant_id, conversation_id, sequence, kind, text, client_submission_id)
         VALUES ($1, $2, $3, $4, 'user', 'foreign conversation', $5)`,
        [randomUUID(), tenantId, otherConversationId, sequence(), randomUUID()],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'conversation_messages_conversation_fk',
    });
  });

  it('rejects an unexpected extra field on the strict user variant', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO conversation_messages
           (id, tenant_id, conversation_id, sequence, kind, text,
            client_submission_id, model_label)
         VALUES ($1, $2, $3, $4, 'user', 'hello', $5, 'forbidden')`,
        [randomUUID(), tenantId, conversationId, sequence(), randomUUID()],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'conversation_messages_shape_check',
    });
  });

  it('refuses using an Ember message as a Turn source (generated-column FK)', async () => {
    const emberId = randomUUID();
    await db.pool.query(
      `INSERT INTO conversation_messages
         (id, tenant_id, conversation_id, sequence, kind, text, model_label, simulated)
       VALUES ($1, $2, $3, $4, 'ember', 'reply', 'ember-fake-llm-1', true)`,
      [emberId, tenantId, conversationId, sequence()],
    );
    await expect(
      db.pool.query(
        `INSERT INTO assistant_turns
           (id, tenant_id, conversation_id, source_message_id, deadline_at)
         VALUES ($1, $2, $3, $4, clock_timestamp() + interval '60 seconds')`,
        [randomUUID(), tenantId, conversationId, emberId],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'assistant_turns_source_message_fk',
    });
  });

  it('refuses a non-Ember response even for a same-tenant completed Turn', async () => {
    const sourceId = randomUUID();
    const invalidResponseId = randomUUID();
    for (const id of [sourceId, invalidResponseId]) {
      await db.pool.query(
        `INSERT INTO conversation_messages
           (id, tenant_id, conversation_id, sequence, kind, text, client_submission_id)
         VALUES ($1, $2, $3, $4, 'user', 'hello', $5)`,
        [id, tenantId, conversationId, sequence(), randomUUID()],
      );
    }
    await expect(
      db.pool.query(
        `INSERT INTO assistant_turns
           (id, tenant_id, conversation_id, source_message_id, response_message_id,
            status, deadline_at)
         VALUES ($1, $2, $3, $4, $5, 'completed',
                 clock_timestamp() + interval '60 seconds')`,
        [randomUUID(), tenantId, conversationId, sourceId, invalidResponseId],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'assistant_turns_response_message_fk',
    });
  });

  it('accepts a completed Turn only with a valid same-conversation Ember response', async () => {
    const sourceId = randomUUID();
    const responseId = randomUUID();
    await db.pool.query(
      `INSERT INTO conversation_messages
         (id, tenant_id, conversation_id, sequence, kind, text, client_submission_id)
       VALUES ($1, $2, $3, $4, 'user', 'hello', $5)`,
      [sourceId, tenantId, conversationId, sequence(), randomUUID()],
    );
    await db.pool.query(
      `INSERT INTO conversation_messages
         (id, tenant_id, conversation_id, sequence, kind, text, model_label, simulated)
       VALUES ($1, $2, $3, $4, 'ember', 'reply', 'ember-fake-llm-1', true)`,
      [responseId, tenantId, conversationId, sequence()],
    );
    const result = await db.pool.query<{ status: string }>(
      `INSERT INTO assistant_turns
         (id, tenant_id, conversation_id, source_message_id,
          response_message_id, status, deadline_at)
       VALUES ($1, $2, $3, $4, $5, 'completed',
               clock_timestamp() + interval '60 seconds')
       RETURNING status`,
      [randomUUID(), tenantId, conversationId, sourceId, responseId],
    );
    expect(result.rows[0]?.status).toBe('completed');
  });
});
