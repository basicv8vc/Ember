import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunExecutionContext } from '@ember/contracts';
import type { AuthContext, LeasedRun, TaskKind } from '@ember/domain';
import {
  createDefaultSentinelPolicy,
  DeterministicExecutionRouter,
  DeterministicExecutor,
  type SentinelPolicy,
  type SimulatedExecutor,
} from '@ember/execution';
import {
  PostgresAgentRepository,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
} from '@ember/postgres';
import { createRunHandler } from '../../apps/worker/src/run-handler.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  chatCommand,
  computeCommand,
  createTenantFixture,
  type TenantFixture,
} from './support/fixtures.js';
import { ManualClock, databaseNow, readTask } from './support/leases.js';

const WORKER_ID = 'worker-sentinel-nondurable-test';

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenant: TenantFixture;
let ctx: AuthContext;
let agentId: string;
let clock: ManualClock;
let queue: PostgresLeaseQueue;
let reader: PostgresRunExecutionContextReader;

const logger = createWorkerLogger({ level: 'error', sink: () => undefined });

async function syncClock(): Promise<void> {
  const candidate = (await databaseNow(db.pool)).getTime() + 1;
  if (candidate > clock.now().getTime()) {
    clock.set(new Date(candidate));
  }
}

interface Attempt {
  readonly taskId: string;
  readonly lease: LeasedRun;
  readonly context: RunExecutionContext;
}

async function claimNextFor(taskId: string): Promise<Attempt> {
  await syncClock();
  const lease = await queue.claimNext(WORKER_ID, clock.now());

  if (lease === null || lease.taskId !== taskId) {
    throw new Error(
      `expected to claim ${taskId}, received ${lease === null ? 'null' : lease.taskId}`,
    );
  }

  const context = await reader.read(lease, clock.now());
  return { taskId, lease, context };
}

function makeNonDurableHandler(options: {
  readonly sentinelPolicy?:
    SentinelPolicy | ((context: RunExecutionContext) => SentinelPolicy | undefined);
  readonly omitSentinelPolicy?: boolean;
  readonly executor?: SimulatedExecutor;
  readonly reader?:
    | PostgresRunExecutionContextReader
    | { read: (run: LeasedRun, now: Date) => Promise<RunExecutionContext> };
}) {
  return createRunHandler({
    contextReader: options.reader ?? reader,
    router: new DeterministicExecutionRouter(),
    executor: options.executor ?? new DeterministicExecutor({ sandboxExecDurationMs: 1 }),
    clock,
    logger,
    sentinelPolicy: options.omitSentinelPolicy ? undefined : options.sentinelPolicy,
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  tenant = await createTenantFixture(db.pool);
  ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 };
  agentId = (await agents.create(ctx, { name: 'nondurable sentinel agent' })).agentId;
  clock = new ManualClock(new Date('2026-11-01T00:00:00.000Z'));
  queue = new PostgresLeaseQueue(db.pool, {
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 2_000,
    baseDelayMs: 100,
    capDelayMs: 100,
    reaperBatchSize: 10,
    clock,
  });
  reader = new PostgresRunExecutionContextReader(db.pool, clock);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.pool.query(
    `UPDATE tasks SET next_run_at = now() + interval '1 day'
      WHERE status IN ('queued', 'retryable_failed')`,
  );
});

describe('Lane P0-C2B: Non-Durable Worker Runtime Admission Gate', () => {
  it('allows mock.chat under standard policy and succeeds without writing terminal state directly', async () => {
    let executorCalled = false;
    const spiedExecutor: SimulatedExecutor = {
      execute: async (c, r, s) => {
        executorCalled = true;
        return new DeterministicExecutor({ sandboxExecDurationMs: 1 }).execute(c, r, s);
      },
    };

    const receipt = await tasks.create(
      ctx,
      chatCommand(agentId, `nondurable-chat-${randomUUID()}`),
    );
    const attempt = await claimNextFor(receipt.taskId);

    const standardPolicy = createDefaultSentinelPolicy({
      tenantId: tenant.tenantId,
      policyVersion: 1,
      allowMockWrite: false,
    });

    const handler = makeNonDurableHandler({
      sentinelPolicy: standardPolicy,
      executor: spiedExecutor,
    });

    const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
    expect(completion).toEqual({ type: 'finish', outcome: 'succeeded' });
    expect(executorCalled).toBe(true);

    // Terminal transition is owned by queue.finish()
    const finished = await queue.finish(attempt.lease, 'succeeded');
    expect(finished).toBe(true);

    const persisted = await readTask(db.pool, tenant.tenantId, attempt.taskId);
    expect(persisted.status).toBe('completed');
  });

  it('fails closed when policy denies mock.compute, with 0 executor calls and terminal failed Task', async () => {
    let executorCalled = false;
    const spiedExecutor: SimulatedExecutor = {
      execute: async () => {
        await Promise.resolve();
        executorCalled = true;
        throw new Error('should not execute');
      },
    };

    const receipt = await tasks.create(
      ctx,
      computeCommand(agentId, `nondurable-deny-${randomUUID()}`),
    );
    const attempt = await claimNextFor(receipt.taskId);

    // Policy only allows mock.read (mock.compute is disallowed)
    const policyOnlyRead = createDefaultSentinelPolicy({
      tenantId: tenant.tenantId,
      policyVersion: 1,
      allowedActions: ['mock.read'],
    });

    const handler = makeNonDurableHandler({
      sentinelPolicy: policyOnlyRead,
      executor: spiedExecutor,
    });

    const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
    expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });
    expect(executorCalled).toBe(false);

    const finished = await queue.finish(attempt.lease, 'failed_terminal');
    expect(finished).toBe(true);

    const persisted = await readTask(db.pool, tenant.tenantId, attempt.taskId);
    expect(persisted.status).toBe('failed');
  });

  it('denies mock.file when policy does not allow mock.write, with 0 executor calls', async () => {
    let executorCalled = false;
    const spiedExecutor: SimulatedExecutor = {
      execute: async () => {
        await Promise.resolve();
        executorCalled = true;
        throw new Error('should not execute');
      },
    };

    const receipt = await tasks.create(ctx, {
      agentId,
      idempotencyKey: `nondurable-file-${randomUUID()}`,
      kind: 'mock.file',
      input: { fileKey: 'test.txt', content: 'test content' },
    });
    const attempt = await claimNextFor(receipt.taskId);

    const policyWithoutWrite = createDefaultSentinelPolicy({
      tenantId: tenant.tenantId,
      policyVersion: 1,
      allowMockWrite: false,
    });

    const handler = makeNonDurableHandler({
      sentinelPolicy: policyWithoutWrite,
      executor: spiedExecutor,
    });

    const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
    expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });
    expect(executorCalled).toBe(false);
  });

  it('fails closed when policy tenantId mismatches context tenantId', async () => {
    let executorCalled = false;
    const spiedExecutor: SimulatedExecutor = {
      execute: async () => {
        await Promise.resolve();
        executorCalled = true;
        throw new Error('should not execute');
      },
    };

    const receipt = await tasks.create(
      ctx,
      chatCommand(agentId, `nondurable-tenant-${randomUUID()}`),
    );
    const attempt = await claimNextFor(receipt.taskId);

    const foreignPolicy = createDefaultSentinelPolicy({
      tenantId: '99999999-9999-4999-8999-999999999999',
      policyVersion: 1,
      allowMockWrite: true,
    });

    const handler = makeNonDurableHandler({
      sentinelPolicy: foreignPolicy,
      executor: spiedExecutor,
    });

    const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
    expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });
    expect(executorCalled).toBe(false);
  });

  it('fails closed when policyVersion mismatches context policyVersion', async () => {
    let executorCalled = false;
    const spiedExecutor: SimulatedExecutor = {
      execute: async () => {
        await Promise.resolve();
        executorCalled = true;
        throw new Error('should not execute');
      },
    };

    const receipt = await tasks.create(
      ctx,
      chatCommand(agentId, `nondurable-version-${randomUUID()}`),
    );
    const attempt = await claimNextFor(receipt.taskId);

    const wrongVersionPolicy = createDefaultSentinelPolicy({
      tenantId: tenant.tenantId,
      policyVersion: 42,
      allowMockWrite: true,
    });

    const handler = makeNonDurableHandler({
      sentinelPolicy: wrongVersionPolicy,
      executor: spiedExecutor,
    });

    const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
    expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });
    expect(executorCalled).toBe(false);
  });

  it('fails closed when policy is omitted/undefined in non-durable handler', async () => {
    let executorCalled = false;
    const spiedExecutor: SimulatedExecutor = {
      execute: async () => {
        await Promise.resolve();
        executorCalled = true;
        throw new Error('should not execute');
      },
    };

    const receipt = await tasks.create(
      ctx,
      chatCommand(agentId, `nondurable-missing-${randomUUID()}`),
    );
    const attempt = await claimNextFor(receipt.taskId);

    const handler = makeNonDurableHandler({
      omitSentinelPolicy: true,
      executor: spiedExecutor,
    });

    const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
    expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });
    expect(executorCalled).toBe(false);
  });

  it('blocks external.mutate in non-durable mode with 0 executor calls', async () => {
    let executorCalled = false;
    const spiedExecutor: SimulatedExecutor = {
      execute: async () => {
        await Promise.resolve();
        executorCalled = true;
        throw new Error('should not execute');
      },
    };

    const receipt = await tasks.create(
      ctx,
      chatCommand(agentId, `nondurable-mutate-${randomUUID()}`),
    );
    const attempt = await claimNextFor(receipt.taskId);

    const mutateReader = {
      read: async (run: LeasedRun, now: Date): Promise<RunExecutionContext> => {
        const real = await reader.read(run, now);
        return { ...real, kind: 'external.mutate' as unknown as TaskKind };
      },
    };

    const handler = makeNonDurableHandler({
      sentinelPolicy: createDefaultSentinelPolicy({
        tenantId: tenant.tenantId,
        policyVersion: 1,
        allowMockWrite: true,
      }),
      executor: spiedExecutor,
      reader: mutateReader,
    });

    const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
    expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });
    expect(executorCalled).toBe(false);
  });
});
