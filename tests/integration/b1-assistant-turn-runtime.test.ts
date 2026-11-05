import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { B1AssistantTurnDtoSchema } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import {
  B1_ASSISTANT_TURN_FAILURE_MESSAGE,
  B1_ASSISTANT_TURN_MODEL_LABEL,
  PostgresB1AssistantTurnRepository,
} from '../../packages/postgres/src/repositories/b1-assistant-turn-repository.js';
import { PostgresB1ConversationWriteRepository } from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import { createFakeTurnResponder } from '../../apps/worker/src/b1/fake-turn-responder.js';
import { backendPid, createTestDatabase, type TestDatabase } from './support/database.js';

const SECRET_SOURCE = 'private source text: turn fixture 7e89d';

interface Fixture {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly sourceMessageId: string;
  readonly sourceText: string;
}

let db: TestDatabase;
let repository: PostgresB1AssistantTurnRepository;
let competingRepository: PostgresB1AssistantTurnRepository;
let writer: PostgresB1ConversationWriteRepository;

async function createFixture(sourceText = SECRET_SOURCE): Promise<Fixture> {
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'turn test']);
  await db.pool.query(
    'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
    [agentId, tenantId, 'turn test agent'],
  );
  await db.pool.query(
    "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
    [conversationId, tenantId, agentId],
  );
  const submitted = await writer.submitUserMessage({
    tenantId,
    conversationId,
    request: {
      client_submission_id: randomUUID(),
      text: sourceText,
      transcript_epoch: 0,
    },
  });

  return {
    tenantId,
    conversationId,
    turnId: submitted.receipt.turn.turn_id,
    sourceMessageId: submitted.receipt.message.message_id,
    sourceText,
  };
}

function identity(fixture: Fixture) {
  return {
    tenantId: fixture.tenantId,
    conversationId: fixture.conversationId,
    turnId: fixture.turnId,
  };
}

async function readTurn(fixture: Fixture) {
  const turn = await repository.getTurn(identity(fixture));
  expect(turn).not.toBeNull();
  return turn!;
}

async function readAssistantMessages(fixture: Fixture) {
  const result = await db.observerPool.query<{
    id: string;
    sequence: string;
    text: string;
    model_label: string;
    simulated: boolean;
  }>(
    `
SELECT id, sequence, text, model_label, simulated
  FROM conversation_messages
 WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'
 ORDER BY sequence`,
    [fixture.tenantId, fixture.conversationId],
  );

  return result.rows;
}

async function taskSnapshot(tenantId: string): Promise<{
  readonly tasks: readonly unknown[];
  readonly results: readonly unknown[];
}> {
  const tasks = await db.observerPool.query<{ readonly row: unknown }>(
    'SELECT row_to_json(t) AS row FROM tasks t WHERE tenant_id = $1 ORDER BY id',
    [tenantId],
  );
  const results = await db.observerPool.query<{ readonly row: unknown }>(
    'SELECT row_to_json(r) AS row FROM task_results r WHERE tenant_id = $1 ORDER BY id',
    [tenantId],
  );

  return { tasks: tasks.rows.map(({ row }) => row), results: results.rows.map(({ row }) => row) };
}

async function addUnrelatedTaskAndResult(fixture: Fixture): Promise<void> {
  const taskId = randomUUID();
  await db.pool.query(
    `
INSERT INTO tasks (id, tenant_id, agent_id, kind, input, digest, idempotency_key)
VALUES ($1, $2, (SELECT agent_id FROM conversations WHERE id = $3), 'mock.chat',
        '{"prompt":"task is unrelated to the assistant turn"}'::jsonb, repeat('a', 64), $4)`,
    [taskId, fixture.tenantId, fixture.conversationId, `task-key-${taskId.slice(0, 8)}`],
  );
  await db.pool.query(
    `
INSERT INTO task_results (id, tenant_id, task_id, result_state)
VALUES ($1, $2, $3, 'pending')`,
    [randomUUID(), fixture.tenantId, taskId],
  );
}

async function countAssistantMessages(fixture: Fixture): Promise<number> {
  const result = await db.observerPool.query<{ readonly count: string }>(
    `
SELECT count(*)::text AS count
  FROM conversation_messages
 WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'`,
    [fixture.tenantId, fixture.conversationId],
  );

  return Number(result.rows[0]?.count ?? 0);
}

async function installTurnUpdateSleepTrigger(fixture: Fixture): Promise<void> {
  await db.pool.query(`
CREATE FUNCTION hold_one_test_turn_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id = '${fixture.turnId}'::uuid AND OLD.status = 'running' THEN
    PERFORM pg_sleep(0.2);
  END IF;
  RETURN NEW;
END;
$$`);
  await db.pool.query(`
CREATE TRIGGER hold_one_test_turn_update
BEFORE UPDATE ON assistant_turns FOR EACH ROW
EXECUTE FUNCTION hold_one_test_turn_update()`);
}

async function deleteTranscriptLikeContract(fixture: Fixture): Promise<void> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
      fixture.tenantId,
      fixture.conversationId,
    ]);
    await client.query(
      'UPDATE conversations SET transcript_epoch = transcript_epoch + 1 WHERE tenant_id = $1 AND id = $2',
      [fixture.tenantId, fixture.conversationId],
    );
    await client.query(
      'DELETE FROM assistant_turns WHERE tenant_id = $1 AND conversation_id = $2',
      [fixture.tenantId, fixture.conversationId],
    );
    await client.query(
      'DELETE FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2',
      [fixture.tenantId, fixture.conversationId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe('B1-5 assistant Turn runtime on PostgreSQL 17', () => {
  beforeAll(async () => {
    db = await createTestDatabase({ maxConnections: 12 });
    const version = await db.pool.query<{ readonly server_version_num: string }>(
      'SHOW server_version_num',
    );
    const versionNumber = Number(version.rows[0]?.server_version_num ?? 0);
    expect(versionNumber).toBeGreaterThanOrEqual(170000);
    expect(versionNumber).toBeLessThan(180000);
    repository = new PostgresB1AssistantTurnRepository(db.pool);
    competingRepository = new PostgresB1AssistantTurnRepository(db.pool);
    writer = new PostgresB1ConversationWriteRepository(db.pool);
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  it('reads a running Turn, publishes one clearly simulated reply atomically, and leaves Tasks/results unchanged', async () => {
    const fixture = await createFixture();
    await addUnrelatedTaskAndResult(fixture);
    const beforeTasks = await taskSnapshot(fixture.tenantId);
    const running = await readTurn(fixture);
    expect(running.status).toBe('running');
    expect(B1AssistantTurnDtoSchema.safeParse(running).success).toBe(true);

    const responder = createFakeTurnResponder({ repository });
    const summary = await responder.processOnce();
    const completed = await readTurn(fixture);
    const messages = await readAssistantMessages(fixture);
    const afterTasks = await taskSnapshot(fixture.tenantId);

    expect(summary.completed).toBe(1);
    expect(completed.status).toBe('completed');
    expect(completed.response_message_id).toBe(messages[0]?.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text.startsWith('[Simulated reply')).toBe(true);
    expect(messages[0]).toMatchObject({
      model_label: B1_ASSISTANT_TURN_MODEL_LABEL,
      simulated: true,
    });
    expect(afterTasks).toEqual(beforeTasks);
  });

  it('makes completion retries and a post-commit worker restart idempotent', async () => {
    const fixture = await createFixture();
    const responder = createFakeTurnResponder({
      repository,
      generator: { generate: () => Promise.resolve({ text: 'deterministic fake result' }) },
    });
    await responder.processOnce();
    const first = await readTurn(fixture);
    const retried = await repository.finishTurn({
      ...identity(fixture),
      result: {
        status: 'completed',
        text: '[Simulated reply — not generated by a live model] duplicate attempt',
        modelLabel: B1_ASSISTANT_TURN_MODEL_LABEL,
        simulated: true,
      },
    });
    const restartedWorker = createFakeTurnResponder({ repository });
    const restartSummary = await restartedWorker.processOnce();

    expect(retried).toEqual(first);
    expect(restartSummary.examined).toBe(0);
    expect(await countAssistantMessages(fixture)).toBe(1);
  });

  it('recovers an uncommitted in-flight reply after a simulated worker restart', async () => {
    const fixture = await createFixture();
    const shutdown = new AbortController();
    const crashedWorker = createFakeTurnResponder({
      repository,
      generator: {
        generate() {
          shutdown.abort();
          return Promise.resolve({ text: 'generated but not committed' });
        },
      },
    });
    const abandoned = await crashedWorker.processOnce(shutdown.signal);
    expect(abandoned.skipped).toBeGreaterThan(0);
    expect((await readTurn(fixture)).status).toBe('running');
    expect(await countAssistantMessages(fixture)).toBe(0);

    const restartedWorker = createFakeTurnResponder({
      repository,
      generator: { generate: () => Promise.resolve({ text: 'reply from restarted worker' }) },
    });
    expect((await restartedWorker.processOnce()).completed).toBe(1);
    expect((await readTurn(fixture)).status).toBe('completed');
    expect(await countAssistantMessages(fixture)).toBe(1);
  });

  it('lets two independent workers overlap while publishing exactly one response', async () => {
    const fixture = await createFixture();
    let generated = 0;
    let releaseBoth!: () => void;
    const bothAtGenerator = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const generator = {
      async generate() {
        generated += 1;
        if (generated === 2) releaseBoth();
        await bothAtGenerator;
        return { text: 'same deterministic response' };
      },
    };
    const workerA = createFakeTurnResponder({ repository, generator });
    const workerB = createFakeTurnResponder({ repository: competingRepository, generator });

    const results = await Promise.all([workerA.processOnce(), workerB.processOnce()]);

    expect(generated).toBe(2);
    expect(results.reduce((sum, result) => sum + result.completed + result.skipped, 0)).toBe(2);
    expect(results.every((result) => result.failed === 0 && result.timedOut === 0)).toBe(true);
    expect(await countAssistantMessages(fixture)).toBe(1);
    expect((await readTurn(fixture)).status).toBe('completed');
    expect(db.pool.totalCount).toBeGreaterThanOrEqual(2);
  });

  it('rolls back a response Message and sequence allocation when terminal publication fails', async () => {
    const fixture = await createFixture();
    const before = await db.observerPool.query<{ readonly last_sequence: string }>(
      'SELECT last_sequence::text FROM conversations WHERE tenant_id = $1 AND id = $2',
      [fixture.tenantId, fixture.conversationId],
    );
    await db.pool.query(`
CREATE FUNCTION force_one_test_turn_update_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id = '${fixture.turnId}'::uuid THEN
    RAISE EXCEPTION 'forced test failure with private source text';
  END IF;
  RETURN NEW;
END;
$$`);
    await db.pool.query(`
CREATE TRIGGER force_one_test_turn_update_failure
BEFORE UPDATE ON assistant_turns FOR EACH ROW
EXECUTE FUNCTION force_one_test_turn_update_failure()`);

    let caught: unknown;
    try {
      await repository.finishTurn({
        ...identity(fixture),
        result: {
          status: 'completed',
          text: '[Simulated reply — not generated by a live model] must roll back',
          modelLabel: B1_ASSISTANT_TURN_MODEL_LABEL,
          simulated: true,
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).publicMessage).not.toContain('private source text');
    expect((await readTurn(fixture)).status).toBe('running');
    expect(await countAssistantMessages(fixture)).toBe(0);
    const after = await db.observerPool.query<{ readonly last_sequence: string }>(
      'SELECT last_sequence::text FROM conversations WHERE tenant_id = $1 AND id = $2',
      [fixture.tenantId, fixture.conversationId],
    );
    expect(after.rows[0]?.last_sequence).toBe(before.rows[0]?.last_sequence);
  });

  it('records internal failure with one fixed safe simulated assistant Message', async () => {
    const fixture = await createFixture();
    const failure = await repository.finishTurn({
      ...identity(fixture),
      result: {
        status: 'failed',
        failureReason: 'internal_error',
        safeMessage: `never show this: ${fixture.sourceText}`,
      },
    });
    const messages = await readAssistantMessages(fixture);

    expect(failure.status).toBe('failed');
    expect(failure.failure_reason).toBe('internal_error');
    expect(failure.response_message_id).toBe(messages[0]?.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      text: B1_ASSISTANT_TURN_FAILURE_MESSAGE,
      model_label: B1_ASSISTANT_TURN_MODEL_LABEL,
      simulated: true,
    });
    expect(messages[0]?.text).not.toContain(fixture.sourceText);
  });

  it('turns an expired running row into failed/timeout on poll and emits its safe response', async () => {
    const fixture = await createFixture();
    await db.pool.query(
      "UPDATE assistant_turns SET deadline_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [fixture.turnId],
    );

    const turn = await readTurn(fixture);
    const messages = await readAssistantMessages(fixture);

    expect(turn.status).toBe('failed');
    expect(turn.failure_reason).toBe('timeout');
    expect(turn.response_message_id).toBe(messages[0]?.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe(B1_ASSISTANT_TURN_FAILURE_MESSAGE);
  });

  it('sweeps an abandoned expired Turn without waiting for its 60-second deadline', async () => {
    const fixture = await createFixture();
    await db.pool.query(
      "UPDATE assistant_turns SET deadline_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [fixture.turnId],
    );
    const responder = createFakeTurnResponder({ repository });

    expect(await responder.sweepExpiredOnce()).toBe(1);
    expect((await readTurn(fixture)).failure_reason).toBe('timeout');
    expect(await countAssistantMessages(fixture)).toBe(1);
  });

  it('cancels before completion, prevents publication, and makes terminal cancellation idempotent', async () => {
    const fixture = await createFixture();
    const cancelled = await repository.cancelTurn(identity(fixture));
    const repeat = await competingRepository.cancelTurn(identity(fixture));
    const lateFinish = await repository.finishTurn({
      ...identity(fixture),
      result: {
        status: 'completed',
        text: '[Simulated reply — not generated by a live model] too late',
        modelLabel: B1_ASSISTANT_TURN_MODEL_LABEL,
        simulated: true,
      },
    });

    expect(cancelled.status).toBe('cancelled');
    expect(repeat).toEqual(cancelled);
    expect(lateFinish.status).toBe('cancelled');
    expect(await countAssistantMessages(fixture)).toBe(0);
  });

  it('serializes a cancellation/completion race on separate PostgreSQL connections', async () => {
    const fixture = await createFixture();
    await installTurnUpdateSleepTrigger(fixture);

    const [cancelResult, completionResult] = await Promise.all([
      competingRepository.cancelTurn(identity(fixture)),
      repository.finishTurn({
        ...identity(fixture),
        result: {
          status: 'completed',
          text: '[Simulated reply — not generated by a live model] race winner',
          modelLabel: B1_ASSISTANT_TURN_MODEL_LABEL,
          simulated: true,
        },
      }),
    ]);
    const finalTurn = await readTurn(fixture);
    const messages = await readAssistantMessages(fixture);

    expect(['cancelled', 'completed']).toContain(finalTurn.status);
    expect(cancelResult.status).toBe(finalTurn.status);
    expect(completionResult.status).toBe(finalTurn.status);
    expect(messages).toHaveLength(finalTurn.status === 'completed' ? 1 : 0);
    if (finalTurn.status === 'completed') {
      expect(finalTurn.response_message_id).toBe(messages[0]?.id);
    }
    expect(db.pool.totalCount).toBeGreaterThanOrEqual(2);
  });

  it('keeps transcript deletion and completion ordered so deleted source content cannot reappear', async () => {
    const fixture = await createFixture();
    const results = await Promise.allSettled([
      deleteTranscriptLikeContract(fixture),
      repository.finishTurn({
        ...identity(fixture),
        result: {
          status: 'completed',
          text: '[Simulated reply — not generated by a live model] must not resurrect',
          modelLabel: B1_ASSISTANT_TURN_MODEL_LABEL,
          simulated: true,
        },
      }),
    ]);
    const remaining = await db.observerPool.query<{ readonly count: string }>(
      `
SELECT count(*)::text AS count FROM conversation_messages
 WHERE tenant_id = $1 AND conversation_id = $2`,
      [fixture.tenantId, fixture.conversationId],
    );

    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(Number(remaining.rows[0]?.count ?? 0)).toBe(0);
    expect(await countAssistantMessages(fixture)).toBe(0);
  });

  it('returns indistinguishable repository not-found errors for foreign and unknown Turns', async () => {
    const fixture = await createFixture();
    const otherTenant = randomUUID();
    const foreign = await repository.getTurn({ ...identity(fixture), tenantId: otherTenant });
    const missing = await repository.getTurn({
      ...identity(fixture),
      turnId: randomUUID(),
    });

    expect(foreign).toBeNull();
    expect(missing).toBeNull();
    const errors = await Promise.allSettled([
      repository.cancelTurn({ ...identity(fixture), tenantId: otherTenant }),
      repository.cancelTurn({ ...identity(fixture), turnId: randomUUID() }),
    ]);
    expect(errors.every((result) => result.status === 'rejected')).toBe(true);
    for (const result of errors) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(DomainError);
        expect((result.reason as DomainError).publicMessage).toBe('Resource not found');
      }
    }
  });

  it('does not mutate existing Tasks or Task Results while completing a Turn', async () => {
    const fixture = await createFixture();
    await addUnrelatedTaskAndResult(fixture);
    const before = await taskSnapshot(fixture.tenantId);

    await repository.finishTurn({
      ...identity(fixture),
      result: {
        status: 'completed',
        text: '[Simulated reply — not generated by a live model] independent of tasks',
        modelLabel: B1_ASSISTANT_TURN_MODEL_LABEL,
        simulated: true,
      },
    });

    expect(await taskSnapshot(fixture.tenantId)).toEqual(before);
  });

  it('uses separate checked-out sessions for the overlapping race participants', async () => {
    const clientA = await db.pool.connect();
    const clientB = await db.pool.connect();
    try {
      const pidA = await backendPid(clientA);
      const pidB = await backendPid(clientB);
      expect(pidA).not.toBe(pidB);
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});
