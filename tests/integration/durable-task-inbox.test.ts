import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isDomainError,
  type AuthContext,
  type DomainError,
  type DomainErrorCode,
} from '@ember/domain';
import {
  createPool,
  loadDatabaseConfig,
  PostgresAgentRepository,
  PostgresTaskRepository,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { chatCommand, createTenantFixture, type TenantFixture } from './support/fixtures.js';

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let agentA: Awaited<ReturnType<PostgresAgentRepository['create']>>;
let agentB: Awaited<ReturnType<PostgresAgentRepository['create']>>;
let ctxA: AuthContext;
let ctxB: AuthContext;

function newKey(prefix = 'key'): string {
  return `${prefix}-${randomUUID()}`;
}

async function expectDomainFailure(
  promise: Promise<unknown>,
  code: DomainErrorCode,
): Promise<DomainError> {
  let caught: unknown;

  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(isDomainError(caught)).toBe(true);
  const domainError = caught as DomainError;
  expect(domainError.code).toBe(code);
  return domainError;
}

async function countByKey(tenantId: string, idempotencyKey: string): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM tasks WHERE tenant_id = $1 AND idempotency_key = $2',
    [tenantId, idempotencyKey],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function countEvents(taskId: string): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM task_events WHERE task_id = $1',
    [taskId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function insertRun(
  tenantId: string,
  taskId: string,
  attempt = 1,
  status = 'created',
): Promise<string> {
  const runId = randomUUID();

  await db.pool.query(
    `INSERT INTO runs (id, tenant_id, task_id, attempt, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [runId, tenantId, taskId, attempt, status],
  );

  return runId;
}

async function currentRunId(tenantId: string, taskId: string): Promise<string | null> {
  const result = await db.pool.query<{ current_run_id: string | null }>(
    'SELECT current_run_id FROM tasks WHERE tenant_id = $1 AND id = $2',
    [tenantId, taskId],
  );
  return result.rows[0]?.current_run_id ?? null;
}

async function installAcceptedEventFailureTrigger(): Promise<void> {
  await db.pool.query(`
    CREATE OR REPLACE FUNCTION p0b03_reject_accepted_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected accepted event failure';
    END;
    $$;
    CREATE TRIGGER p0b03_reject_accepted_event_trg
      BEFORE INSERT ON task_events
      FOR EACH ROW EXECUTE FUNCTION p0b03_reject_accepted_event();
  `);
}

async function removeAcceptedEventFailureTrigger(): Promise<void> {
  await db.pool.query(`
    DROP TRIGGER IF EXISTS p0b03_reject_accepted_event_trg ON task_events;
    DROP FUNCTION IF EXISTS p0b03_reject_accepted_event();
  `);
}

async function installCommitFailureTrigger(): Promise<void> {
  await db.pool.query(`
    CREATE OR REPLACE FUNCTION p0b03_reject_commit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected commit failure';
    END;
    $$;
    CREATE CONSTRAINT TRIGGER p0b03_reject_commit_trg
      AFTER INSERT ON tasks
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION p0b03_reject_commit();
  `);
}

async function removeCommitFailureTrigger(): Promise<void> {
  await db.pool.query(`
    DROP TRIGGER IF EXISTS p0b03_reject_commit_trg ON tasks;
    DROP FUNCTION IF EXISTS p0b03_reject_commit();
  `);
}

async function installWorkspaceFailureTrigger(): Promise<void> {
  await db.pool.query(`
    CREATE OR REPLACE FUNCTION p0b03_reject_workspace()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected workspace failure';
    END;
    $$;
    CREATE TRIGGER p0b03_reject_workspace_trg
      BEFORE INSERT ON workspaces
      FOR EACH ROW EXECUTE FUNCTION p0b03_reject_workspace();
  `);
}

async function removeWorkspaceFailureTrigger(): Promise<void> {
  await db.pool.query(`
    DROP TRIGGER IF EXISTS p0b03_reject_workspace_trg ON workspaces;
    DROP FUNCTION IF EXISTS p0b03_reject_workspace();
  `);
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 12 });
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);

  tenantA = await createTenantFixture(db.pool, 'tenant A');
  tenantB = await createTenantFixture(db.pool, 'tenant B');

  ctxA = { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 };
  ctxB = { tenantId: tenantB.tenantId, principalId: tenantB.principalId, policyVersion: 1 };

  agentA = await agents.create(ctxA, { name: 'agent A' });
  agentB = await agents.create(ctxB, { name: 'agent B' });
});

afterAll(async () => {
  await db?.close();
});

describe('agent and workspace persistence', () => {
  it('creates an agent and its workspace atomically at version 0', async () => {
    const created = await agents.create(ctxA, { name: 'atomic agent' });

    expect(created.workspaceVersion).toBe(0);
    expect(created.policyVersion).toBe(1);

    const rows = await db.pool.query<{ version: number; name: string }>(
      `SELECT w.version, a.name
         FROM agents a
         JOIN workspaces w ON w.tenant_id = a.tenant_id AND w.agent_id = a.id
        WHERE a.tenant_id = $1 AND a.id = $2`,
      [ctxA.tenantId, created.agentId],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.version).toBe(0);
    expect(await agents.get(ctxB, created.agentId)).toBeNull();
  });

  it('rejects a principal that is not provisioned in the tenant', async () => {
    const hidden = await expectDomainFailure(
      agents.create(
        { tenantId: ctxB.tenantId, principalId: tenantA.principalId, policyVersion: 1 },
        { name: 'cross-tenant principal' },
      ),
      'UNAUTHENTICATED',
    );

    expect(hidden.publicMessage).toBe('Authentication required');
    expect(JSON.stringify(hidden)).not.toContain(tenantA.principalId);

    const rows = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agents WHERE tenant_id = $1 AND name = $2',
      [ctxB.tenantId, 'cross-tenant principal'],
    );
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('rolls the agent back when its workspace insert fails', async () => {
    const name = `rollback-${randomUUID()}`;
    await installWorkspaceFailureTrigger();

    try {
      await expectDomainFailure(agents.create(ctxA, { name }), 'DB_UNAVAILABLE');
    } finally {
      await removeWorkspaceFailureTrigger();
    }

    const rows = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agents WHERE tenant_id = $1 AND name = $2',
      [ctxA.tenantId, name],
    );
    expect(rows.rows[0]?.count).toBe('0');
  });
});

describe('B-T06 durable acknowledgement', () => {
  it('reads the committed task and first accepted event from an independent connection', async () => {
    const key = newKey('ack');
    const secretPrompt = `secret-prompt-${randomUUID()}`;
    const receipt = await tasks.create(ctxA, chatCommand(agentA.agentId, key, secretPrompt));

    expect(receipt.replayed).toBe(false);
    expect(receipt.status).toBe('queued');

    const observedTask = await db.observerPool.query<{
      status: string;
      accepted_at: Date;
      input: { prompt: string };
    }>('SELECT status, accepted_at, input FROM tasks WHERE tenant_id = $1 AND id = $2', [
      ctxA.tenantId,
      receipt.taskId,
    ]);
    expect(observedTask.rows).toHaveLength(1);
    expect(observedTask.rows[0]?.status).toBe('queued');
    expect(observedTask.rows[0]?.accepted_at.toISOString()).toBe(receipt.acceptedAt);
    expect(observedTask.rows[0]?.input.prompt).toBe(secretPrompt);

    const observedEvents = await db.observerPool.query<{
      sequence: number;
      phase: string;
      occurred_at: Date;
      payload: Record<string, unknown>;
    }>(
      `SELECT sequence, phase, occurred_at, payload
         FROM task_events
        WHERE tenant_id = $1 AND task_id = $2
        ORDER BY sequence`,
      [ctxA.tenantId, receipt.taskId],
    );
    expect(observedEvents.rows).toHaveLength(1);
    expect(observedEvents.rows[0]?.sequence).toBe(1);
    expect(observedEvents.rows[0]?.phase).toBe('accepted');
    expect(observedEvents.rows[0]?.occurred_at.toISOString()).toBe(receipt.acceptedAt);
    expect(observedEvents.rows[0]?.payload['taskKind']).toBe('mock.chat');
    expect(observedEvents.rows[0]?.payload['prompt']).toBeUndefined();
    expect(JSON.stringify(observedEvents.rows[0]?.payload)).not.toContain(secretPrompt);

    const events = await tasks.listEvents(ctxA, receipt.taskId);
    expect(events).toHaveLength(1);
    expect(events[0]?.phase).toBe('accepted');
    expect(JSON.stringify(events)).not.toContain(secretPrompt);
  });

  it('rolls back the task when the accepted event insert fails', async () => {
    const key = newKey('event-fail');
    await installAcceptedEventFailureTrigger();

    let failure: DomainError | undefined;
    try {
      failure = await expectDomainFailure(
        tasks.create(ctxA, chatCommand(agentA.agentId, key)),
        'DB_UNAVAILABLE',
      );
    } finally {
      await removeAcceptedEventFailureTrigger();
    }

    expect(failure?.publicMessage).toBe('Database is unavailable');
    expect(JSON.stringify(failure)).not.toContain('task_events');
    expect(JSON.stringify(failure)).not.toContain('injected');
    expect(await countByKey(ctxA.tenantId, key)).toBe(0);

    // The failed transaction left no task, so the same key creates exactly one durable task.
    const retried = await tasks.create(ctxA, chatCommand(agentA.agentId, key));
    expect(retried.replayed).toBe(false);
    expect(await countByKey(ctxA.tenantId, key)).toBe(1);
    expect(await countEvents(retried.taskId)).toBe(1);
  });

  it('does not acknowledge when COMMIT fails', async () => {
    const key = newKey('commit-fail');
    await installCommitFailureTrigger();

    try {
      await expectDomainFailure(
        tasks.create(ctxA, chatCommand(agentA.agentId, key)),
        'DB_UNAVAILABLE',
      );
    } finally {
      await removeCommitFailureTrigger();
    }

    expect(await countByKey(ctxA.tenantId, key)).toBe(0);

    const retried = await tasks.create(ctxA, chatCommand(agentA.agentId, key));
    expect(retried.replayed).toBe(false);
    expect(await countByKey(ctxA.tenantId, key)).toBe(1);
  });

  it('replays the same task after a lost acknowledgement and reflects current state', async () => {
    const key = newKey('lost-ack');
    const command = chatCommand(agentA.agentId, key, 'lost acknowledgement');
    const first = await tasks.create(ctxA, command);

    // Simulate commit succeeded but the client never received the receipt.
    const replay = await tasks.create(ctxA, command);

    expect(replay.replayed).toBe(true);
    expect(replay.taskId).toBe(first.taskId);
    expect(replay.acceptedAt).toBe(first.acceptedAt);
    expect(await countByKey(ctxA.tenantId, key)).toBe(1);
    expect(await countEvents(first.taskId)).toBe(1);

    await db.pool.query("UPDATE tasks SET status = 'running' WHERE tenant_id = $1 AND id = $2", [
      ctxA.tenantId,
      first.taskId,
    ]);

    const afterStateChange = await tasks.create(ctxA, command);
    expect(afterStateChange.replayed).toBe(true);
    expect(afterStateChange.taskId).toBe(first.taskId);
    expect(afterStateChange.status).toBe('running');
    expect(afterStateChange.acceptedAt).toBe(first.acceptedAt);
  });

  it('rejects with DB_UNAVAILABLE when the database cannot be reached', async () => {
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    expect(testDatabaseUrl).toBeDefined();

    const unreachable = new URL(testDatabaseUrl as string);
    unreachable.hostname = '127.0.0.1';
    unreachable.port = '1';

    const config = loadDatabaseConfig({
      DATABASE_URL: unreachable.toString(),
      EMBER_DB_CONNECT_TIMEOUT_MS: '300',
    });
    const unreachablePool = createPool({ ...config, maxConnections: 1 });

    try {
      const unreachableRepository = new PostgresTaskRepository(unreachablePool);
      await expectDomainFailure(
        unreachableRepository.create(ctxA, chatCommand(agentA.agentId, newKey('unreachable'))),
        'DB_UNAVAILABLE',
      );
    } finally {
      await unreachablePool.end();
    }
  });
});

describe('tenant-scoped reads and repository behaviour', () => {
  it('hides another tenant task from get/listEvents and refuses its agent', async () => {
    const key = newKey('tenant');
    const created = await tasks.create(ctxA, chatCommand(agentA.agentId, key));

    expect(await tasks.get(ctxB, created.taskId)).toBeNull();
    expect(await tasks.listEvents(ctxB, created.taskId)).toHaveLength(0);

    const foreignKey = newKey('foreign');
    const hidden = await expectDomainFailure(
      tasks.create(ctxB, chatCommand(agentA.agentId, foreignKey)),
      'NOT_FOUND',
    );

    expect(hidden.publicMessage).toBe('Resource not found');
    expect(JSON.stringify(hidden)).not.toContain(agentA.agentId);
    expect(await countByKey(ctxB.tenantId, foreignKey)).toBe(0);

    await expectDomainFailure(tasks.requestCancel(ctxB, created.taskId), 'NOT_FOUND');
  });

  it('applies ADR-0001 cancellation to a queued task exactly once', async () => {
    const key = newKey('cancel');
    const created = await tasks.create(ctxA, chatCommand(agentA.agentId, key));

    await tasks.requestCancel(ctxA, created.taskId);
    const first = await db.pool.query<{ status: string; cancel_requested_at: Date }>(
      'SELECT status, cancel_requested_at FROM tasks WHERE tenant_id = $1 AND id = $2',
      [ctxA.tenantId, created.taskId],
    );

    expect(first.rows[0]?.status).toBe('cancelled');
    expect(first.rows[0]?.cancel_requested_at).toBeInstanceOf(Date);

    await tasks.requestCancel(ctxA, created.taskId);
    const second = await db.pool.query<{ status: string; cancel_requested_at: Date }>(
      'SELECT status, cancel_requested_at FROM tasks WHERE tenant_id = $1 AND id = $2',
      [ctxA.tenantId, created.taskId],
    );

    expect(second.rows[0]?.status).toBe('cancelled');
    expect(second.rows[0]?.cancel_requested_at.toISOString()).toBe(
      first.rows[0]?.cancel_requested_at.toISOString(),
    );
    expect(await countEvents(created.taskId)).toBe(2);

    const replay = await tasks.create(ctxA, chatCommand(agentA.agentId, key));
    expect(replay.status).toBe('cancelled');
  });
});

describe('database-enforced integrity', () => {
  it('has the tenant idempotency unique index in PostgreSQL', async () => {
    const indexes = await db.pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'tasks'",
    );

    const unique = indexes.rows.find(
      (row) =>
        row.indexdef.startsWith('CREATE UNIQUE INDEX') &&
        row.indexdef.includes('(tenant_id, idempotency_key)'),
    );
    expect(unique).toBeDefined();
  });

  it('rejects a direct SQL cross-tenant agent reference', async () => {
    const key = newKey('sql-cross');

    let caught: unknown;
    try {
      await db.pool.query(
        `INSERT INTO tasks (id, tenant_id, agent_id, kind, input, digest, idempotency_key)
         VALUES ($1, $2, $3, 'mock.chat', '{"prompt":"x"}'::jsonb, $4, $5)`,
        [randomUUID(), ctxB.tenantId, agentA.agentId, 'a'.repeat(64), key],
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: '23503' });
    expect(await countByKey(ctxB.tenantId, key)).toBe(0);
  });

  it('rejects a duplicate idempotency key even through direct SQL', async () => {
    const key = newKey('sql-dupe');
    const created = await tasks.create(ctxA, chatCommand(agentA.agentId, key));

    let caught: unknown;
    try {
      await db.pool.query(
        `INSERT INTO tasks (id, tenant_id, agent_id, kind, input, digest, idempotency_key)
         VALUES ($1, $2, $3, 'mock.chat', '{"prompt":"x"}'::jsonb, $4, $5)`,
        [randomUUID(), ctxA.tenantId, agentA.agentId, 'b'.repeat(64), key],
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: '23505' });
    expect(await countByKey(ctxA.tenantId, key)).toBe(1);
    expect(await tasks.get(ctxA, created.taskId)).not.toBeNull();
  });

  it('enforces event sequence, single accepted event and the payload allowlist', async () => {
    const created = await tasks.create(ctxA, chatCommand(agentA.agentId, newKey('event-rules')));

    const duplicateAccepted = db.pool.query(
      `INSERT INTO task_events (id, tenant_id, task_id, sequence, phase, payload, trace_id)
       VALUES ($1, $2, $3, 1, 'accepted', '{}'::jsonb, $4)`,
      [randomUUID(), ctxA.tenantId, created.taskId, randomUUID()],
    );
    await expect(duplicateAccepted).rejects.toMatchObject({ code: '23505' });

    const acceptedAtWrongSequence = db.pool.query(
      `INSERT INTO task_events (id, tenant_id, task_id, sequence, phase, payload, trace_id)
       VALUES ($1, $2, $3, 2, 'accepted', '{}'::jsonb, $4)`,
      [randomUUID(), ctxA.tenantId, created.taskId, randomUUID()],
    );
    await expect(acceptedAtWrongSequence).rejects.toMatchObject({ code: '23514' });

    const freeTextPayload = db.pool.query(
      `INSERT INTO task_events (id, tenant_id, task_id, sequence, phase, payload, trace_id)
       VALUES ($1, $2, $3, 2, 'progress', '{"prompt":"secret"}'::jsonb, $4)`,
      [randomUUID(), ctxA.tenantId, created.taskId, randomUUID()],
    );
    await expect(freeTextPayload).rejects.toMatchObject({ code: '23514' });

    const badSecretField = db.pool.query(
      `INSERT INTO task_events (id, tenant_id, task_id, sequence, phase, payload, trace_id)
       VALUES ($1, $2, $3, 2, 'progress', '{"taskKind":"not-a-kind"}'::jsonb, $4)`,
      [randomUUID(), ctxA.tenantId, created.taskId, randomUUID()],
    );
    await expect(badSecretField).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces task, run and workspace value constraints', async () => {
    const created = await tasks.create(ctxA, chatCommand(agentA.agentId, newKey('constraints')));

    await expect(
      db.pool.query("UPDATE tasks SET status = 'accepted' WHERE tenant_id = $1 AND id = $2", [
        ctxA.tenantId,
        created.taskId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      db.pool.query('UPDATE tasks SET attempt_count = -1 WHERE tenant_id = $1 AND id = $2', [
        ctxA.tenantId,
        created.taskId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      db.pool.query(
        `INSERT INTO runs (id, tenant_id, task_id, attempt)
         VALUES ($1, $2, $3, -1)`,
        [randomUUID(), ctxA.tenantId, created.taskId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      db.pool.query(
        `INSERT INTO runs (id, tenant_id, task_id, attempt, lease_epoch)
         VALUES ($1, $2, $3, 1, -1)`,
        [randomUUID(), ctxA.tenantId, created.taskId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      db.pool.query('UPDATE workspaces SET version = -1 WHERE tenant_id = $1 AND agent_id = $2', [
        ctxA.tenantId,
        agentA.agentId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts tasks.current_run_id only for a run of the same tenant and task', async () => {
    const created = await tasks.create(ctxA, chatCommand(agentA.agentId, newKey('current-run')));
    const runId = await insertRun(ctxA.tenantId, created.taskId);

    const updated = await db.pool.query(
      'UPDATE tasks SET current_run_id = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3',
      [runId, ctxA.tenantId, created.taskId],
    );
    expect(updated.rowCount).toBe(1);

    const view = await tasks.get(ctxA, created.taskId);
    expect(view?.currentRunId).toBe(runId);

    const constraint = await db.pool.query<{
      convalidated: boolean;
      definition: string;
    }>(
      `SELECT convalidated, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'tasks'::regclass AND conname = 'tasks_current_run_fk'`,
    );
    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0]?.convalidated).toBe(true);
    expect(constraint.rows[0]?.definition).toContain('tenant_id, id, current_run_id');
    expect(constraint.rows[0]?.definition).toContain('runs(tenant_id, task_id, id)');
  });

  it('rejects a cross-tenant, cross-task or missing current_run_id', async () => {
    const taskA = await tasks.create(ctxA, chatCommand(agentA.agentId, newKey('current-run-a')));
    const taskB = await tasks.create(ctxB, chatCommand(agentB.agentId, newKey('current-run-b')));
    const otherTaskA = await tasks.create(
      ctxA,
      chatCommand(agentA.agentId, newKey('current-run-a2')),
    );
    const runA = await insertRun(ctxA.tenantId, taskA.taskId);

    const update = (tenantId: string, taskId: string, runId: string) =>
      db.pool.query('UPDATE tasks SET current_run_id = $1 WHERE tenant_id = $2 AND id = $3', [
        runId,
        tenantId,
        taskId,
      ]);

    // Tenant B may not point at Tenant A's run.
    await expect(update(ctxB.tenantId, taskB.taskId, runA)).rejects.toMatchObject({
      code: '23503',
    });
    expect(await currentRunId(ctxB.tenantId, taskB.taskId)).toBeNull();

    // Same tenant, but another task's run is still invalid.
    await expect(update(ctxA.tenantId, otherTaskA.taskId, runA)).rejects.toMatchObject({
      code: '23503',
    });
    expect(await currentRunId(ctxA.tenantId, otherTaskA.taskId)).toBeNull();

    // A run that does not exist in this tenant is rejected as well.
    await expect(update(ctxA.tenantId, otherTaskA.taskId, randomUUID())).rejects.toMatchObject({
      code: '23503',
    });
    expect(await currentRunId(ctxA.tenantId, otherTaskA.taskId)).toBeNull();
  });

  it('reads events back in sequence order', async () => {
    const created = await tasks.create(ctxA, chatCommand(agentA.agentId, newKey('sequence')));

    await db.pool.query(
      `INSERT INTO task_events (id, tenant_id, task_id, sequence, phase, payload, trace_id)
       VALUES ($1, $2, $3, 2, 'progress', '{"toStatus":"running"}'::jsonb, $4)`,
      [randomUUID(), ctxA.tenantId, created.taskId, randomUUID()],
    );

    const events = await tasks.listEvents(ctxA, created.taskId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.phase)).toEqual(['accepted', 'progress']);
  });

  it('does not mistake a database error for a public domain message', async () => {
    const key = newKey('error-shape');
    const created = await tasks.create(
      ctxA,
      chatCommand(agentA.agentId, key, `secret-${randomUUID()}`),
    );

    const conflict = await expectDomainFailure(
      tasks.create(ctxA, chatCommand(agentA.agentId, key, `different-${randomUUID()}`)),
      'IDEMPOTENCY_CONFLICT',
    );

    expect(conflict.publicMessage).toBe('Idempotency key conflicts with an existing command');
    expect(JSON.stringify(conflict)).not.toContain('secret-');
    expect(await tasks.get(ctxA, created.taskId)).not.toBeNull();
  });
});
