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
  const siblingAgentId = randomUUID();
  const siblingConversationId = randomUUID();
  const taskId = randomUUID();
  const otherTaskId = randomUUID();
  const commitmentId = randomUUID();
  const otherCommitmentId = randomUUID();
  let nextSequence = 0;

  const sequence = (): number => ++nextSequence;

  async function insertMessage(input: {
    kind: string;
    conversationId?: string;
    tenantId?: string;
    text?: string | null;
    modelLabel?: string | null;
    simulated?: boolean | null;
    source?: string | null;
    taskId?: string | null;
    commitmentId?: string | null;
    outcome?: unknown;
    clientSubmissionId?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO conversation_messages
         (id, tenant_id, conversation_id, sequence, kind, text, model_label,
          simulated, source, task_id, commitment_id, outcome, client_submission_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        input.tenantId ?? tenantId,
        input.conversationId ?? conversationId,
        sequence(),
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
    await db.pool.query(
      `INSERT INTO agents (id, tenant_id, name, policy_version)
       VALUES ($1, $2, 'Sibling Ember', 1)`,
      [siblingAgentId, tenantId],
    );
    await db.pool.query(
      `INSERT INTO conversations (id, tenant_id, agent_id, kind)
       VALUES ($1, $2, $3, 'main')`,
      [siblingConversationId, tenantId, siblingAgentId],
    );
    await db.pool.query(
      `INSERT INTO tasks (id, tenant_id, agent_id, kind, input, digest, idempotency_key)
       VALUES ($1, $2, $3, 'mock.chat', '{}'::jsonb, $4, 'b1-alpha-task'),
              ($5, $6, $7, 'mock.chat', '{}'::jsonb, $8, 'b1-other-task')`,
      [
        taskId,
        tenantId,
        agentId,
        'a'.repeat(64),
        otherTaskId,
        otherTenantId,
        otherAgentId,
        'b'.repeat(64),
      ],
    );
    await db.pool.query(
      `INSERT INTO commitments (id, tenant_id, agent_id, title, schedule_kind, source_profile_id)
       VALUES ($1, $2, $3, 'Alpha test', 'once', 'test.profile'),
              ($4, $5, $6, 'Other test', 'once', 'test.profile')`,
      [commitmentId, tenantId, agentId, otherCommitmentId, otherTenantId, otherAgentId],
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

  it("rejects a Consumer linked to another tenant's Principal", async () => {
    const isolatedTenantId = randomUUID();
    await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
      isolatedTenantId,
      'B1 isolated principal FK',
    ]);
    await expect(
      db.pool.query('INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)', [
        randomUUID(),
        isolatedTenantId,
        principalId,
      ]),
    ).rejects.toMatchObject({ code: '23503', constraint: 'consumers_principal_fk' });
  });

  it('tenant-qualifies identity and session foreign keys and requires revoked-session reasons', async () => {
    const otherConsumerId = randomUUID();
    await db.pool.query('INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)', [
      otherConsumerId,
      otherTenantId,
      otherPrincipalId,
    ]);

    await expect(
      db.pool.query(
        `INSERT INTO consumer_identities (id, tenant_id, consumer_id, provider, provider_subject)
         VALUES ($1, $2, $3, 'dev', 'cross-tenant-identity')`,
        [randomUUID(), tenantId, otherConsumerId],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'consumer_identities_consumer_fk',
    });

    await expect(
      db.pool.query(
        `INSERT INTO consumer_sessions
           (id, tenant_id, consumer_id, token_digest, expires_at, idle_expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 hour')`,
        [randomUUID(), tenantId, otherConsumerId, Buffer.alloc(32, 1)],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'consumer_sessions_consumer_fk',
    });

    await expect(
      db.pool.query(
        `INSERT INTO consumer_sessions
           (id, tenant_id, consumer_id, token_digest, expires_at, idle_expires_at,
            revoked_at, revocation_reason)
         VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 hour',
                 now(), NULL)`,
        [randomUUID(), otherTenantId, otherConsumerId, Buffer.alloc(32, 2)],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'consumer_sessions_revocation_check',
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

  it('rejects cross-tenant Task and Commitment references and Task Results', async () => {
    await expect(
      insertMessage({ kind: 'task_reference', taskId: otherTaskId }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'conversation_messages_task_fk' });
    await expect(
      insertMessage({ kind: 'commitment_reference', commitmentId: otherCommitmentId }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'conversation_messages_commitment_fk' });
    await expect(
      db.pool.query(
        `INSERT INTO task_results (id, tenant_id, task_id, result_state)
         VALUES ($1, $2, $3, 'pending')`,
        [randomUUID(), tenantId, otherTaskId],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'task_results_task_fk' });
  });

  it('enforces the closed six-variant message union', async () => {
    const validMessages = [
      { kind: 'user', text: 'hello', clientSubmissionId: randomUUID() },
      { kind: 'ember', text: 'reply', modelLabel: 'ember-fake-test', simulated: true },
      { kind: 'activity', text: 'started', source: 'system' },
      { kind: 'task_reference', taskId },
      { kind: 'commitment_reference', commitmentId },
      {
        kind: 'outcome_reference',
        outcome: { outcome_kind: 'no_change', task_id: taskId, commitment_id: null },
      },
    ];
    for (const message of validMessages) {
      await insertMessage(message);
    }

    const malformedMessages = [
      { kind: 'user', text: 'hello', clientSubmissionId: randomUUID(), modelLabel: 'forbidden' },
      {
        kind: 'ember',
        text: 'reply',
        modelLabel: 'ember-fake-test',
        simulated: true,
        source: 'forbidden',
      },
      { kind: 'activity', text: 'started', source: 'system', simulated: true },
      { kind: 'task_reference', taskId, text: 'forbidden' },
      { kind: 'commitment_reference', commitmentId, modelLabel: 'forbidden' },
      { kind: 'outcome_reference', outcome: { outcome_kind: 'no_change' }, taskId },
      { kind: 'user', text: 'hello' },
      { kind: 'ember', text: 'reply', simulated: true },
      { kind: 'activity', text: 'started' },
      { kind: 'task_reference' },
      { kind: 'commitment_reference' },
      { kind: 'outcome_reference' },
      { kind: 'unknown', text: 'hello' },
    ];
    for (const message of malformedMessages) {
      await expect(insertMessage(message)).rejects.toMatchObject({ code: '23514' });
    }

    await expect(
      insertMessage({
        kind: 'activity',
        text: 'x'.repeat(281),
        source: 'system',
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'conversation_messages_text_bounds_check',
    });
    await expect(
      insertMessage({
        kind: 'user',
        text: 'x'.repeat(4097),
        clientSubmissionId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'conversation_messages_text_bounds_check',
    });
  });


  it('rejects a submission ID reused in a different conversation of the same tenant', async () => {
    const submissionId = randomUUID();
    await insertMessage({
      kind: 'user',
      text: 'original submission',
      clientSubmissionId: submissionId,
    });
    await expect(
      insertMessage({
        kind: 'user',
        conversationId: siblingConversationId,
        text: 'duplicate submission in a sibling conversation',
        clientSubmissionId: submissionId,
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'conversation_messages_tenant_submission_unique',
    });
  });

  it('allows the same submission ID in different tenants', async () => {
    const submissionId = randomUUID();
    const originalMessageId = await insertMessage({
      kind: 'user',
      text: 'tenant A submission',
      clientSubmissionId: submissionId,
    });
    const otherTenantMessageId = await insertMessage({
      kind: 'user',
      tenantId: otherTenantId,
      conversationId: otherConversationId,
      text: 'tenant B submission',
      clientSubmissionId: submissionId,
    });
    expect(otherTenantMessageId).not.toBe(originalMessageId);
  });

  it('accepts distinct submission IDs across conversations in one tenant', async () => {
    const originalMessageId = await insertMessage({
      kind: 'user',
      text: 'first distinct submission',
      clientSubmissionId: randomUUID(),
    });
    const siblingMessageId = await insertMessage({
      kind: 'user',
      conversationId: siblingConversationId,
      text: 'second distinct submission',
      clientSubmissionId: randomUUID(),
    });
    expect(siblingMessageId).not.toBe(originalMessageId);
  });

  it('enforces the Conversation Agent uniqueness and tenant-qualified Agent FK', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO conversations (id, tenant_id, agent_id, kind)
         VALUES ($1, $2, $3, 'main')`,
        [randomUUID(), tenantId, agentId],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'conversations_one_per_kind_unique' });

    await expect(
      db.pool.query(
        `INSERT INTO conversations (id, tenant_id, agent_id, kind)
         VALUES ($1, $2, $3, 'main')`,
        [randomUUID(), tenantId, otherAgentId],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'conversations_agent_fk' });
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

  it('rejects a cross-tenant Ember response for a completed Turn', async () => {
    const sourceId = await insertMessage({
      kind: 'user',
      text: 'same tenant source',
      clientSubmissionId: randomUUID(),
    });
    const foreignResponse = await insertMessage({
      kind: 'ember',
      tenantId: otherTenantId,
      conversationId: otherConversationId,
      text: 'foreign tenant response',
      modelLabel: 'ember-fake-test',
      simulated: true,
    });
    await expect(
      db.pool.query(
        `INSERT INTO assistant_turns
           (id, tenant_id, conversation_id, source_message_id, response_message_id,
            status, deadline_at)
         VALUES ($1, $2, $3, $4, $5, 'completed', now() + interval '60 seconds')`,
        [randomUUID(), tenantId, conversationId, sourceId, foreignResponse],
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

  it('rejects a failed Turn with a valid failure reason but no response message', async () => {
    const sourceId = await insertMessage({
      kind: 'user',
      text: 'failed turn without response',
      clientSubmissionId: randomUUID(),
    });
    await expect(
      db.pool.query(
        `INSERT INTO assistant_turns
           (id, tenant_id, conversation_id, source_message_id, response_message_id,
            status, failure_reason, deadline_at)
         VALUES ($1, $2, $3, $4, NULL, 'failed', 'timeout', now() + interval '60 seconds')`,
        [randomUUID(), tenantId, conversationId, sourceId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'assistant_turns_terminal_response_check',
    });
  });

  it('accepts a failed Turn with a same-conversation Ember response', async () => {
    const sourceId = await insertMessage({
      kind: 'user',
      text: 'failed turn with response',
      clientSubmissionId: randomUUID(),
    });
    const responseId = await insertMessage({
      kind: 'ember',
      text: 'The turn failed because it timed out.',
      modelLabel: 'ember-fake-test',
      simulated: true,
    });
    const result = await db.pool.query<{
      status: string;
      response_message_id: string;
    }>(
      `INSERT INTO assistant_turns
         (id, tenant_id, conversation_id, source_message_id, response_message_id,
          status, failure_reason, deadline_at)
       VALUES ($1, $2, $3, $4, $5, 'failed', 'timeout', now() + interval '60 seconds')
       RETURNING status, response_message_id`,
      [randomUUID(), tenantId, conversationId, sourceId, responseId],
    );
    expect(result.rows[0]).toEqual({
      status: 'failed',
      response_message_id: responseId,
    });
  });

  it('continues to allow a cancelled Turn without a response message', async () => {
    const sourceId = await insertMessage({
      kind: 'user',
      text: 'cancelled before response',
      clientSubmissionId: randomUUID(),
    });
    const result = await db.pool.query<{
      status: string;
      response_message_id: string | null;
    }>(
      `INSERT INTO assistant_turns
         (id, tenant_id, conversation_id, source_message_id, status, deadline_at)
       VALUES ($1, $2, $3, $4, 'cancelled', now() + interval '60 seconds')
       RETURNING status, response_message_id`,
      [randomUUID(), tenantId, conversationId, sourceId],
    );
    expect(result.rows[0]).toEqual({ status: 'cancelled', response_message_id: null });
  });

  it('rejects failed Turns without a failure reason and terminal-shape contradictions', async () => {
    const failedSource = await insertMessage({
      kind: 'user',
      text: 'failed turn',
      clientSubmissionId: randomUUID(),
    });
    await expect(
      db.pool.query(
        `INSERT INTO assistant_turns
           (id, tenant_id, conversation_id, source_message_id, status,
            failure_reason, deadline_at)
         VALUES ($1, $2, $3, $4, 'failed', NULL, now() + interval '60 seconds')`,
        [randomUUID(), tenantId, conversationId, failedSource],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'assistant_turns_failure_reason_check',
    });

    const runningSource = await insertMessage({
      kind: 'user',
      text: 'running turn',
      clientSubmissionId: randomUUID(),
    });
    const response = await insertMessage({
      kind: 'ember',
      text: 'response too early',
      modelLabel: 'ember-fake-test',
      simulated: true,
    });
    await expect(
      db.pool.query(
        `INSERT INTO assistant_turns
           (id, tenant_id, conversation_id, source_message_id,
            response_message_id, status, deadline_at)
         VALUES ($1, $2, $3, $4, $5, 'running', now() + interval '60 seconds')`,
        [randomUUID(), tenantId, conversationId, runningSource, response],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'assistant_turns_running_response_check',
    });

    await expect(
      db.pool.query(
        `INSERT INTO assistant_turns
           (id, tenant_id, conversation_id, source_message_id,
            response_message_id, status, deadline_at)
         VALUES ($1, $2, $3, $4, NULL, 'completed', now() + interval '60 seconds')`,
        [randomUUID(), tenantId, conversationId, runningSource],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'assistant_turns_terminal_response_check',
    });
  });

  it('accepts all three valid Task Result states and enforces one result per Task', async () => {
    const insertResult = (resultState: string, extraColumns = '', extraValues = '') =>
      db.pool.query(
        `INSERT INTO task_results (id, tenant_id, task_id, result_state${extraColumns})
         VALUES ($1, $2, $3, $4${extraValues})`,
        [randomUUID(), tenantId, taskId, resultState],
      );

    await insertResult('pending');
    await expect(insertResult('pending')).rejects.toMatchObject({
      code: '23505',
      constraint: 'task_results_task_unique',
    });
    await db.pool.query('DELETE FROM task_results WHERE tenant_id = $1 AND task_id = $2', [
      tenantId,
      taskId,
    ]);

    await insertResult(
      'available',
      ', summary_text, model_label, simulated, produced_at',
      ", 'summary', 'ember-fake-test', true, now()",
    );
    await db.pool.query('DELETE FROM task_results WHERE tenant_id = $1 AND task_id = $2', [
      tenantId,
      taskId,
    ]);

    await insertResult('unavailable', ', reason_code', ", 'no_text_output'");
  });

  it('rejects Task Result fields that contradict pending or unavailable state', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO task_results (id, tenant_id, task_id, result_state, reason_code)
         VALUES ($1, $2, $3, 'pending', 'no_text_output')`,
        [randomUUID(), tenantId, taskId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'task_results_shape_check' });

    await expect(
      db.pool.query(
        `INSERT INTO task_results (id, tenant_id, task_id, result_state, truncated)
         VALUES ($1, $2, $3, 'pending', true)`,
        [randomUUID(), tenantId, taskId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'task_results_shape_check' });

    await expect(
      db.pool.query(
        `INSERT INTO task_results
           (id, tenant_id, task_id, result_state, reason_code, model_label)
         VALUES ($1, $2, $3, 'unavailable', 'no_text_output', 'ember-fake-test')`,
        [randomUUID(), tenantId, taskId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'task_results_shape_check' });

    await expect(
      db.pool.query(
        `INSERT INTO task_results
           (id, tenant_id, task_id, result_state, reason_code, truncated)
         VALUES ($1, $2, $3, 'unavailable', 'no_text_output', true)`,
        [randomUUID(), tenantId, taskId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'task_results_shape_check' });

    await expect(
      db.pool.query(
        `INSERT INTO task_results (id, tenant_id, task_id, result_state, reason_code)
         VALUES ($1, $2, $3, 'unavailable', 'other_reason')`,
        [randomUUID(), tenantId, taskId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'task_results_reason_check' });
  });

  it('rejects Task Result text above the frozen bounds', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO task_results
           (id, tenant_id, task_id, result_state, summary_text,
            model_label, simulated, produced_at)
         VALUES ($1, $2, $3, 'available', $4, 'ember-fake-test', true, now())`,
        [randomUUID(), tenantId, taskId, 'x'.repeat(2049)],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'task_results_bounds_check' });
  });
});
