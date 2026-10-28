import { describe, expect, it } from 'vitest';
import type { LeasedRun } from '@ember/domain';
import { PostgresRunExecutionContextReader } from '@ember/postgres';

/** The pool seam the reader needs, without importing the driver into unit tests. */
type ContextPool = ConstructorParameters<typeof PostgresRunExecutionContextReader>[0];

const TENANT = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const T0 = new Date('2026-10-28T00:00:00.000Z');
const LEASE_MS = 30_000;
const LEASE_EXPIRES_AT = new Date(T0.getTime() + LEASE_MS);

const LEASE: LeasedRun = Object.freeze({
  tenantId: TENANT,
  taskId: TASK,
  runId: RUN,
  attempt: 1,
  leaseEpoch: 2,
  leaseExpiresAt: LEASE_EXPIRES_AT.toISOString(),
});

/** One row exactly as the single SELECT statement returns it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: TENANT,
    task_id: TASK,
    agent_id: AGENT,
    kind: 'mock.chat',
    input: { prompt: 'deterministic mock prompt' },
    task_status: 'running',
    attempt_count: 1,
    task_lease_epoch: '2',
    current_run_id: RUN,
    task_lease_expires_at: LEASE_EXPIRES_AT,
    deadline_at: null,
    cancel_requested_at: null,
    run_id: RUN,
    run_attempt: 1,
    run_lease_epoch: '2',
    run_status: 'running',
    worker_id: 'worker-test',
    leased_until: LEASE_EXPIRES_AT,
    policy_version: 3,
    // Statement time reported by PostgreSQL for this row.
    evaluated_at: T0,
    ...overrides,
  };
}

interface StubPool {
  readonly parameters: unknown[][];
  readonly pool: ContextPool;
}

/** Minimal `pg.Pool` seam: the reader issues exactly one parameterised statement. */
function stubPool(rows: Record<string, unknown>[]): StubPool {
  const parameters: unknown[][] = [];

  const pool = {
    query: (_sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => {
      parameters.push(values);
      return Promise.resolve({ rows });
    },
  } as unknown as ContextPool;

  return { parameters, pool };
}

function readerWith(
  rows: Record<string, unknown>[],
  now: Date = T0,
): { reader: PostgresRunExecutionContextReader; stub: StubPool } {
  const stub = stubPool(rows);

  return {
    reader: new PostgresRunExecutionContextReader(stub.pool, {
      now: () => new Date(now.getTime()),
    }),
    stub,
  };
}

describe('run execution context reader lease evaluation', () => {
  it('returns a frozen context for a live lease and never trusts client inputs as SQL', async () => {
    const { reader, stub } = readerWith([row()]);

    const context = await reader.read(LEASE, T0);

    expect(context.taskId).toBe(TASK);
    expect(context.runId).toBe(RUN);
    expect(context.kind).toBe('mock.chat');
    expect(context.attempt).toBe(1);
    expect(context.leaseEpoch).toBe(2);
    expect(context.policyVersion).toBe(3);
    expect(context.leaseExpiresAt).toBe(LEASE_EXPIRES_AT.toISOString());
    expect(Object.isFrozen(context)).toBe(true);
    // Tenant, task and run are bound as parameters, never interpolated into the statement.
    expect(stub.parameters).toEqual([[TENANT, TASK, RUN]]);
  });

  it('rejects a lease that had already expired at statement time', async () => {
    // The worker sampled its clock a minute *before* the statement ran, so only database time
    // can reveal that the lease was already gone when the row was read.
    const expired = new Date(T0.getTime() - 1_000);
    const { reader } = readerWith([
      row({ task_lease_expires_at: expired, leased_until: expired, evaluated_at: T0 }),
    ]);

    await expect(reader.read(LEASE, new Date(T0.getTime() - 60_000))).rejects.toMatchObject({
      code: 'STALE_LEASE',
    });
  });

  it('rejects a lease that expires while the statement is in flight', async () => {
    const late = new Date(LEASE_EXPIRES_AT.getTime() + 1_000);
    const { reader } = readerWith([row({ evaluated_at: T0 })], late);

    // The pre-query sample was valid; the hand-off re-validation is what rejects it.
    await expect(reader.read(LEASE, T0)).rejects.toMatchObject({ code: 'STALE_LEASE' });
  });

  it('rejects a task whose deadline elapsed at statement time', async () => {
    const { reader } = readerWith([
      row({ deadline_at: new Date(T0.getTime() - 1_000), evaluated_at: T0 }),
    ]);

    await expect(reader.read(LEASE, new Date(T0.getTime() - 60_000))).rejects.toMatchObject({
      code: 'DEADLINE_EXCEEDED',
    });
  });

  it('reports a committed cancellation before any lease verdict (ADR-0001)', async () => {
    const expired = new Date(T0.getTime() - 1_000);
    const { reader } = readerWith([
      row({
        task_lease_expires_at: expired,
        leased_until: expired,
        cancel_requested_at: new Date(T0.getTime() - 2_000),
        evaluated_at: T0,
      }),
    ]);

    await expect(reader.read(LEASE, T0)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects a Run that is not visible in the tenant', async () => {
    const { reader } = readerWith([]);

    await expect(reader.read({ ...LEASE, runId: AGENT }, T0)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects an epoch that no longer matches the fence', async () => {
    const { reader } = readerWith([row({ run_lease_epoch: '3', evaluated_at: T0 })]);

    await expect(reader.read(LEASE, T0)).rejects.toMatchObject({ code: 'STALE_LEASE' });
  });
});
