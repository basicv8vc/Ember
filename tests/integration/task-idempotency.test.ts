import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InvalidArgumentError,
  isDomainError,
  type AuthContext,
  type DomainError,
  type TaskCommand,
} from '@ember/domain';
import { PostgresAgentRepository, PostgresTaskRepository } from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  chatCommand,
  computeCommand,
  createTenantFixture,
  type TenantFixture,
} from './support/fixtures.js';

const CONCURRENCY = 24;

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let agentA: Awaited<ReturnType<PostgresAgentRepository['create']>>;
let agentA2: Awaited<ReturnType<PostgresAgentRepository['create']>>;
let agentB: Awaited<ReturnType<PostgresAgentRepository['create']>>;
let ctxA: AuthContext;
let ctxB: AuthContext;

function newKey(prefix = 'key'): string {
  return `${prefix}-${randomUUID()}`;
}

async function expectDomainFailure(
  promise: Promise<unknown>,
  code: DomainError['code'],
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

async function rowCount(
  table: 'tasks' | 'task_events',
  where: string,
  params: readonly unknown[],
): Promise<number> {
  const result = await db.observerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
    [...params],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function taskRows(tenantId: string, key: string): Promise<number> {
  return rowCount('tasks', 'tenant_id = $1 AND idempotency_key = $2', [tenantId, key]);
}

async function eventRows(taskId: string): Promise<number> {
  return rowCount('task_events', 'task_id = $1', [taskId]);
}

interface StoredTask {
  digest: string;
  accepted_at: Date;
  updated_at: Date;
  status: string;
}

async function storedTask(tenantId: string, taskId: string): Promise<StoredTask> {
  const result = await db.observerPool.query<StoredTask>(
    'SELECT digest, accepted_at, updated_at, status FROM tasks WHERE tenant_id = $1 AND id = $2',
    [tenantId, taskId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('expected task row');
  }
  return row;
}

beforeAll(async () => {
  // Enough independent connections for every concurrent create to own one.
  db = await createTestDatabase({ maxConnections: CONCURRENCY + 8 });
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);

  tenantA = await createTenantFixture(db.pool, 'idempotency tenant A');
  tenantB = await createTenantFixture(db.pool, 'idempotency tenant B');

  ctxA = { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 };
  ctxB = { tenantId: tenantB.tenantId, principalId: tenantB.principalId, policyVersion: 1 };

  agentA = await agents.create(ctxA, { name: 'idempotency agent A' });
  agentA2 = await agents.create(ctxA, { name: 'idempotency agent A2' });
  agentB = await agents.create(ctxB, { name: 'idempotency agent B' });
});

afterAll(async () => {
  await db?.close();
});

describe('B-T07 concurrent idempotency', () => {
  it(`creates exactly one task for ${CONCURRENCY} concurrent identical requests`, async () => {
    const key = newKey('concurrent');
    const command = chatCommand(agentA.agentId, key, 'concurrent prompt');

    const receipts = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => tasks.create(ctxA, command)),
    );

    const taskIds = new Set(receipts.map((receipt) => receipt.taskId));
    expect(taskIds.size).toBe(1);
    expect(receipts.filter((receipt) => receipt.replayed === false)).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.replayed === true)).toHaveLength(CONCURRENCY - 1);

    const taskId = receipts[0]?.taskId;
    expect(taskId).toBeDefined();
    expect(await taskRows(ctxA.tenantId, key)).toBe(1);
    expect(await eventRows(taskId as string)).toBe(1);

    const acceptedTimes = new Set(receipts.map((receipt) => receipt.acceptedAt));
    expect(acceptedTimes.size).toBe(1);

    const events = await tasks.listEvents(ctxA, taskId as string);
    expect(events).toHaveLength(1);
    expect(events[0]?.sequence).toBe(1);
    expect(events[0]?.phase).toBe('accepted');
  });

  it('allows different tenants to reuse the same idempotency key', async () => {
    const key = newKey('shared');

    const [taskA, taskB] = await Promise.all([
      tasks.create(ctxA, chatCommand(agentA.agentId, key, 'tenant A')),
      tasks.create(ctxB, chatCommand(agentB.agentId, key, 'tenant B')),
    ]);

    expect(taskA.taskId).not.toBe(taskB.taskId);
    expect(taskA.replayed).toBe(false);
    expect(taskB.replayed).toBe(false);
    expect(await taskRows(ctxA.tenantId, key)).toBe(1);
    expect(await taskRows(ctxB.tenantId, key)).toBe(1);
    expect(await tasks.get(ctxA, taskB.taskId)).toBeNull();
    expect(await tasks.get(ctxB, taskA.taskId)).toBeNull();
  });

  it('replays equivalent JSON with different property order and deadline offsets', async () => {
    const key = newKey('canonical');
    const first: TaskCommand = {
      agentId: agentA.agentId,
      idempotencyKey: key,
      kind: 'mock.chat',
      input: { prompt: 'same', maxOutputTokens: 32 },
      deadlineAt: '2026-12-01T00:00:00Z',
    };
    const second: TaskCommand = {
      deadlineAt: '2026-12-01T08:00:00+08:00',
      input: { maxOutputTokens: 32, prompt: 'same' },
      kind: 'mock.chat',
      idempotencyKey: key,
      agentId: agentA.agentId,
    };

    const created = await tasks.create(ctxA, first);
    const replayed = await tasks.create(ctxA, second);

    expect(replayed.replayed).toBe(true);
    expect(replayed.taskId).toBe(created.taskId);
    expect(replayed.acceptedAt).toBe(created.acceptedAt);
    expect(await taskRows(ctxA.tenantId, key)).toBe(1);
    expect(await eventRows(created.taskId)).toBe(1);
  });

  it('never creates two tasks when equivalent and conflicting requests race', async () => {
    const key = newKey('mixed-race');
    const firstVariant = chatCommand(agentA.agentId, key, 'variant A');
    const secondVariant = chatCommand(agentA.agentId, key, 'variant B');
    const commands = Array.from({ length: CONCURRENCY }, (_, index) =>
      index % 2 === 0 ? firstVariant : secondVariant,
    );

    const settled = await Promise.allSettled(
      commands.map((command) => tasks.create(ctxA, command)),
    );
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof tasks.create>>> =>
        result.status === 'fulfilled',
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
    for (const rejection of rejected) {
      expect(isDomainError(rejection.reason)).toBe(true);
      expect((rejection.reason as DomainError).code).toBe('IDEMPOTENCY_CONFLICT');
    }

    const taskIds = new Set(fulfilled.map((result) => result.value.taskId));
    expect(taskIds.size).toBe(1);
    expect(await taskRows(ctxA.tenantId, key)).toBe(1);
    expect(await eventRows([...taskIds][0] as string)).toBe(1);
  });

  it('rejects an oversized UTF-8 command without creating a task', async () => {
    const key = newKey('oversized');
    const command: TaskCommand = {
      agentId: agentA.agentId,
      idempotencyKey: key,
      kind: 'mock.compute',
      input: { operation: 'sha256', text: '你'.repeat(30_000) },
    };

    const error = await expectDomainFailure(tasks.create(ctxA, command), 'INVALID_ARGUMENT');
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect((error as InvalidArgumentError).issues.some((issue) => issue.code === 'too_big')).toBe(
      true,
    );
    expect(await taskRows(ctxA.tenantId, key)).toBe(0);
  });
});

describe('B-T08 idempotency conflict', () => {
  it('returns a stable conflict for different kind, input, agent or deadline', async () => {
    const key = newKey('conflict');
    const original = chatCommand(agentA.agentId, key, 'original prompt');
    const created = await tasks.create(ctxA, original);
    const before = await storedTask(ctxA.tenantId, created.taskId);

    const variants: readonly { readonly label: string; readonly command: TaskCommand }[] = [
      { label: 'kind', command: computeCommand(agentA.agentId, key) },
      { label: 'input', command: chatCommand(agentA.agentId, key, 'different prompt') },
      { label: 'agent', command: chatCommand(agentA2.agentId, key, 'original prompt') },
      {
        label: 'deadline',
        command: chatCommand(agentA.agentId, key, 'original prompt', '2026-12-02T00:00:00Z'),
      },
    ];

    for (const variant of variants) {
      const conflict = await expectDomainFailure(
        tasks.create(ctxA, variant.command),
        'IDEMPOTENCY_CONFLICT',
      );
      expect(conflict.publicMessage).toBe('Idempotency key conflicts with an existing command');
      expect(JSON.stringify(conflict)).not.toContain('original prompt');
      expect(JSON.stringify(conflict)).not.toContain('different prompt');
      expect(variant.label.length).toBeGreaterThan(0);

      const after = await storedTask(ctxA.tenantId, created.taskId);
      expect(after.digest).toBe(before.digest);
      expect(after.status).toBe(before.status);
      expect(after.accepted_at.toISOString()).toBe(before.accepted_at.toISOString());
      expect(after.updated_at.toISOString()).toBe(before.updated_at.toISOString());
      expect(await taskRows(ctxA.tenantId, key)).toBe(1);
      expect(await eventRows(created.taskId)).toBe(1);
    }

    const replay = await tasks.create(ctxA, original);
    expect(replay.replayed).toBe(true);
    expect(replay.taskId).toBe(created.taskId);
  });
});
