import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * ADR-0004 T-17: the database, not an application-level preflight SELECT,
 * rejects conflicting writers on separate PostgreSQL connections.
 */
describe('B1-1 T-17: concurrent SQL constraints', () => {
  let db: TestDatabase;
  const tenantId = randomUUID();
  const principalIds = [randomUUID(), randomUUID()];
  const agentIds = [randomUUID(), randomUUID()];
  const conversationIds = [randomUUID(), randomUUID()];
  let nextSequence = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
      tenantId,
      'B1 T-17',
    ]);
    for (const principalId of principalIds) {
      await db.pool.query(
        "INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')",
        [principalId, tenantId],
      );
    }
    for (let i = 0; i < agentIds.length; i += 1) {
      await db.pool.query(
        'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
        [agentIds[i], tenantId, `Ember ${i}`],
      );
      await db.pool.query(
        "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
        [conversationIds[i], tenantId, agentIds[i]],
      );
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  async function insertMessage(
    conversationId: string,
    kind: 'user' | 'ember',
  ): Promise<string> {
    const id = randomUUID();
    nextSequence += 1;
    if (kind === 'user') {
      await db.pool.query(
        `INSERT INTO conversation_messages
           (id, tenant_id, conversation_id, sequence, kind, text, client_submission_id)
         VALUES ($1, $2, $3, $4, 'user', 'message', $5)`,
        [id, tenantId, conversationId, nextSequence, randomUUID()],
      );
    } else {
      await db.pool.query(
        `INSERT INTO conversation_messages
           (id, tenant_id, conversation_id, sequence, kind, text, model_label, simulated)
         VALUES ($1, $2, $3, $4, 'ember', 'response', 'ember-fake-llm-1', true)`,
        [id, tenantId, conversationId, nextSequence],
      );
    }
    return id;
  }

  async function expectSecondWriterRejected(
    sql: string,
    firstArgs: readonly unknown[],
    secondArgs: readonly unknown[],
    expectedConstraint: string,
  ): Promise<void> {
    const first = await db.pool.connect();
    const second = await db.observerPool.connect();
    let firstOpen = false;
    let secondOpen = false;
    try {
      await first.query('BEGIN');
      firstOpen = true;
      await second.query('BEGIN');
      secondOpen = true;

      await first.query(sql, [...firstArgs]);
      // Start the second write while the first transaction is still open.
      // Resolve both outcomes explicitly so no rejection can become unhandled.
      const blocked = second.query(sql, [...secondArgs]).then(
        () => ({ accepted: true as const }),
        (error: unknown) => ({ accepted: false as const, error }),
      );

      await first.query('COMMIT');
      firstOpen = false;
      const outcome = await blocked;
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) {
        expect(outcome.error).toMatchObject({
          code: '23505',
          constraint: expectedConstraint,
        });
      }
    } finally {
      if (firstOpen) {
        await first.query('ROLLBACK');
      }
      if (secondOpen) {
        await second.query('ROLLBACK');
      }
      first.release();
      second.release();
    }
  }

  it('enforces one Consumer per tenant across two transactions', async () => {
    await expectSecondWriterRejected(
      'INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)',
      [randomUUID(), tenantId, principalIds[0]],
      [randomUUID(), tenantId, principalIds[1]],
      'consumers_one_per_tenant_unique',
    );
  });

  it('enforces one Assistant Turn per source user message', async () => {
    const source = await insertMessage(conversationIds[0]!, 'user');
    const responseA = await insertMessage(conversationIds[0]!, 'ember');
    const responseB = await insertMessage(conversationIds[0]!, 'ember');
    const sql = `INSERT INTO assistant_turns
      (id, tenant_id, conversation_id, source_message_id, response_message_id, status, deadline_at)
      VALUES ($1, $2, $3, $4, $5, 'completed', now() + interval '60 seconds')`;
    await expectSecondWriterRejected(
      sql,
      [randomUUID(), tenantId, conversationIds[0], source, responseA],
      [randomUUID(), tenantId, conversationIds[0], source, responseB],
      'assistant_turns_source_unique',
    );
  });

  it('enforces one Assistant Turn per response message', async () => {
    const sourceA = await insertMessage(conversationIds[0]!, 'user');
    const sourceB = await insertMessage(conversationIds[0]!, 'user');
    const response = await insertMessage(conversationIds[0]!, 'ember');
    const sql = `INSERT INTO assistant_turns
      (id, tenant_id, conversation_id, source_message_id, response_message_id, status, deadline_at)
      VALUES ($1, $2, $3, $4, $5, 'completed', now() + interval '60 seconds')`;
    await expectSecondWriterRejected(
      sql,
      [randomUUID(), tenantId, conversationIds[0], sourceA, response],
      [randomUUID(), tenantId, conversationIds[0], sourceB, response],
      'assistant_turns_response_unique',
    );
  });

  it('rejects a same-tenant Ember response from a different Conversation', async () => {
    const source = await insertMessage(conversationIds[0]!, 'user');
    const foreignResponse = await insertMessage(conversationIds[1]!, 'ember');
    await expect(
      db.pool.query(
        `INSERT INTO assistant_turns
           (id, tenant_id, conversation_id, source_message_id,
            response_message_id, status, deadline_at)
         VALUES ($1, $2, $3, $4, $5, 'completed', now() + interval '60 seconds')`,
        [randomUUID(), tenantId, conversationIds[0], source, foreignResponse],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'assistant_turns_response_message_fk',
    });
  });
});
