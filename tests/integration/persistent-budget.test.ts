import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunExecutionContext, RunGrant } from '@ember/contracts';
import type { AuthContext, LeasedRun } from '@ember/domain';
import { isDomainError } from '@ember/domain';
import {
  DeterministicExecutionRouter,
  DeterministicExecutor,
  type BudgetPolicy,
} from '@ember/execution';
import {
  PostgresAgentRepository,
  PostgresBudgetLedger,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
} from '@ember/postgres';
import { stepCost } from '../../apps/worker/src/budget-plan.js';
import { createDurableRunHandler } from '../../apps/worker/src/durable-run-handler.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { chatCommand, createTenantFixture, type TenantFixture } from './support/fixtures.js';
import { ManualClock, databaseNow, readTask } from './support/leases.js';
import { createP06Infra, grantOfContext, type P06Infra } from './support/p0b06.js';

/**
 * P0B-08b — persistent, transactional budget enforcement against a real database.
 *
 * P0B-08a proved the *policy* (an immutable in-process ledger). This suite proves the durable
 * authority the Worker actually asks: one row per `(tenant, run, operation)`, decided under a
 * Tenant-scoped serialization point, charged before the step and never refunded by a crash.
 *
 * Assertions read committed rows through a second pool (`db.observerPool`) wherever the subject
 * is "was anything written", so a rolled-back decision cannot look like a write.
 */

const WORKER_ID = 'worker-p0b08b-budget';
const LEASE_MS = 5_000;

const PRODUCE = stepCost('produce');
const PUBLISH = stepCost('publish');
const PARTIAL_PRODUCE = Object.freeze({
  steps: 0,
  units: 1,
  elapsedMs: 10,
  concurrencySlots: 0,
});

/** No artificial limits: used when a case is about accounting rather than refusal. */
const PERMISSIVE: BudgetPolicy = Object.freeze({
  policyId: 'p0b08b-test-permissive',
  policyVersion: 1,
  maxRunSteps: 1_000,
  maxRunUnits: 1_000_000,
  maxRunElapsedMs: 10_000_000,
  maxTenantDailyUnits: 1_000_000,
  maxConcurrentSlots: 64,
});

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenant: TenantFixture;
let ctx: AuthContext;
let agentId: string;
let clock: ManualClock;
let queue: PostgresLeaseQueue;
let reader: PostgresRunExecutionContextReader;
let infra: P06Infra;

const logger = createWorkerLogger({ level: 'error', sink: () => undefined });

/** Trusted policy revision, derived from the permissive baseline per case. */
function policyWith(patch: Partial<BudgetPolicy>): BudgetPolicy {
  return Object.freeze({ ...PERMISSIVE, ...patch });
}

function ledgerWith(policy: BudgetPolicy = PERMISSIVE): PostgresBudgetLedger {
  return new PostgresBudgetLedger(db.pool, { policy });
}

function handlerWith(policy: BudgetPolicy) {
  return createDurableRunHandler({
    contextReader: reader,
    router: new DeterministicExecutionRouter(),
    executor: new DeterministicExecutor({ sandboxExecDurationMs: 1 }),
    blobs: infra.blobs,
    checkpoints: infra.checkpoints,
    committer: infra.committer,
    workspaces: infra.workspaces,
    budget: ledgerWith(policy),
    clock,
    logger,
  });
}

interface Attempt {
  readonly taskId: string;
  readonly lease: LeasedRun;
  readonly context: RunExecutionContext;
  readonly grant: RunGrant;
}

async function syncClock(): Promise<void> {
  // `now()` has microsecond precision and a JS Date truncates to milliseconds, so the clock is
  // nudged one millisecond past it to model the round trip of a claim. Never move it backwards:
  // a case may already have advanced it deliberately (past a retry delay).
  const candidate = (await databaseNow(db.pool)).getTime() + 1;

  if (candidate > clock.now().getTime()) {
    clock.set(new Date(candidate));
  }
}

/** Re-claim an existing Task, which is how a crashed Run is retried on a new epoch. */
async function claimNextFor(taskId: string): Promise<Attempt> {
  await syncClock();
  const lease = await queue.claimNext(WORKER_ID, clock.now());

  if (lease === null || lease.taskId !== taskId) {
    throw new Error(
      `expected to claim ${taskId}, received ${lease === null ? 'null' : lease.taskId}`,
    );
  }

  const context = await reader.read(lease, clock.now());

  return { taskId, lease, context, grant: grantOfContext(context) };
}

async function claim(
  label: string,
  scope: { ctx: AuthContext; agentId: string } = { ctx, agentId },
): Promise<Attempt> {
  const receipt = await tasks.create(
    scope.ctx,
    chatCommand(scope.agentId, `${label}-${randomUUID()}`),
  );

  return claimNextFor(receipt.taskId);
}

interface OperationRow {
  operation_id: string;
  state: string;
  lease_epoch: string;
  reserved_units: string;
  consumed_units: string;
  reserved_slots: number;
  consumed_slots: number;
  utc_day: string;
}

/** Committed budget rows, read outside the writer. */
async function operations(runId: string, tenantId = tenant.tenantId): Promise<OperationRow[]> {
  const result = await db.observerPool.query<OperationRow>(
    `SELECT operation_id, state, lease_epoch::text AS lease_epoch,
            reserved_units::text AS reserved_units, consumed_units::text AS consumed_units,
            reserved_slots, consumed_slots, to_char(utc_day, 'YYYY-MM-DD') AS utc_day
       FROM budget_operations
      WHERE tenant_id = $1 AND run_id = $2
      ORDER BY operation_id`,
    [tenantId, runId],
  );

  return result.rows;
}

/** Age a live reservation past its lease boundary without waiting for wall-clock seconds. */
async function expireReservation(runId: string): Promise<void> {
  await db.pool.query(
    `UPDATE budget_operations SET expires_at = now() - interval '1 millisecond'
      WHERE tenant_id = $1 AND run_id = $2 AND state = 'reserved'`,
    [tenant.tenantId, runId],
  );
}

async function countFiles(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries.filter((entry) => entry.isFile()).length;
}

async function countRows(table: 'artifacts' | 'step_checkpoints', taskId: string): Promise<string> {
  const result = await db.observerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1 AND task_id = $2`,
    [tenant.tenantId, taskId],
  );

  return result.rows[0]?.count ?? 'missing';
}

beforeAll(async () => {
  db = await createTestDatabase();
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  tenant = await createTenantFixture(db.pool);
  ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 3 };
  agentId = (await agents.create(ctx, { name: 'p0b08b budget agent' })).agentId;
  clock = new ManualClock(new Date('2026-10-29T00:00:00.000Z'));
  queue = new PostgresLeaseQueue(db.pool, {
    leaseDurationMs: LEASE_MS,
    heartbeatIntervalMs: 500,
    baseDelayMs: 100,
    capDelayMs: 100,
    reaperBatchSize: 10,
    clock,
  });
  reader = new PostgresRunExecutionContextReader(db.pool, clock);
  infra = await createP06Infra(db);
}, 30_000);

afterAll(async () => {
  await infra?.dispose();
  await db?.close();
});

beforeEach(async () => {
  // Each case starts from an empty ledger: the concurrency gauge and the UTC-day total are
  // Tenant-wide, so a leftover row from another case would make every number unreadable.
  await db.pool.query('DELETE FROM budget_operations');
  // Nothing may be claimed by this suite except the Task the case itself just created.
  await db.pool.query(
    `UPDATE tasks SET next_run_at = now() + interval '1 day'
      WHERE status IN ('queued', 'retryable_failed')`,
  );
});
interface Refusal {
  readonly code: string;
  readonly diagnostic: string;
}

/** Resolve a refusal into its stable code and internal diagnostic (a getter, not a field). */
async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  const error = await promise.then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (caught: unknown) => caught,
  );

  if (!isDomainError(error)) {
    throw new Error(`expected a DomainError, received ${String(error)}`);
  }

  return { code: error.code, diagnostic: error.diagnostic };
}

describe('P0B-08b durable budget ledger', () => {
  it('holds a reservation, settles it and reports the charge in the snapshot', async () => {
    const attempt = await claim('budget-charge');
    const ledger = ledgerWith();
    const operationId = 'step:produce:abc:1';

    const reserved = await ledger.reserve(attempt.grant, { operationId, cost: PRODUCE });

    expect(reserved).toMatchObject({
      tenantId: tenant.tenantId,
      taskId: attempt.taskId,
      runId: attempt.grant.runId,
      operationId,
      leaseEpoch: attempt.grant.leaseEpoch,
      state: 'reserved',
      replayed: false,
      settledAt: null,
    });
    expect(reserved.reserved).toEqual(PRODUCE);
    // A live reservation holds quota but has consumed nothing yet.
    expect(reserved.consumed).toEqual({
      steps: 0,
      units: 0,
      elapsedMs: 0,
      concurrencySlots: 0,
    });
    expect(reserved.utcDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(reserved.expiresAt)).toBeGreaterThan(0);

    // The live reservation already counts against every limit.
    expect(await ledger.snapshot(attempt.grant)).toMatchObject({
      tenantId: tenant.tenantId,
      runId: attempt.grant.runId,
      policyVersion: PERMISSIVE.policyVersion,
      runSteps: 1,
      runUnits: 5,
      runElapsedMs: 50,
      tenantDailyUnits: 5,
      concurrentSlots: 1,
    });

    const settled = await ledger.settle(attempt.grant, { operationId, consumed: PRODUCE });

    expect(settled.state).toBe('settled');
    expect(settled.consumed).toEqual(PRODUCE);
    expect(settled.settledAt).toEqual(expect.any(String));
    // The charge is recorded against the day it was taken from.
    expect(settled.utcDay).toBe(reserved.utcDay);

    // The slot is handed back, the consumption is not.
    expect(await ledger.snapshot(attempt.grant)).toMatchObject({
      runSteps: 1,
      runUnits: 5,
      runElapsedMs: 50,
      tenantDailyUnits: 5,
      concurrentSlots: 0,
    });

    expect(await operations(attempt.grant.runId)).toEqual([
      {
        operation_id: operationId,
        state: 'settled',
        lease_epoch: String(attempt.grant.leaseEpoch),
        reserved_units: '5',
        consumed_units: '5',
        reserved_slots: 1,
        consumed_slots: 1,
        utc_day: reserved.utcDay,
      },
    ]);
  });

  it('replays a lost acknowledgement even when the first reservation used the full allowance', async () => {
    const attempt = await claim('budget-replay');
    const ledger = ledgerWith(
      policyWith({
        maxRunSteps: PRODUCE.steps,
        maxRunUnits: PRODUCE.units,
        maxRunElapsedMs: PRODUCE.elapsedMs,
        maxTenantDailyUnits: PRODUCE.units,
        maxConcurrentSlots: PRODUCE.concurrencySlots,
      }),
    );
    const operationId = 'step:produce:abc:1';

    await ledger.reserve(attempt.grant, { operationId, cost: PRODUCE });
    const replay = await ledger.reserve(attempt.grant, { operationId, cost: PRODUCE });

    expect(replay).toMatchObject({ state: 'reserved', replayed: true, operationId });
    expect(replay.reserved).toEqual(PRODUCE);
    expect(await operations(attempt.grant.runId)).toHaveLength(1);
    expect((await ledger.snapshot(attempt.grant)).runUnits).toBe(5);

    await ledger.settle(attempt.grant, { operationId, consumed: PRODUCE });
    const settledAgain = await ledger.settle(attempt.grant, { operationId, consumed: PRODUCE });

    expect(settledAgain).toMatchObject({ state: 'settled', replayed: true });
    expect(settledAgain.consumed).toEqual(PRODUCE);
    expect(await operations(attempt.grant.runId)).toHaveLength(1);
    expect((await ledger.snapshot(attempt.grant)).runUnits).toBe(5);
  });

  it('refuses to resize a reservation that is already recorded', async () => {
    const attempt = await claim('budget-conflict');
    const ledger = ledgerWith(
      policyWith({
        maxRunSteps: PRODUCE.steps,
        maxRunUnits: PRODUCE.units,
        maxRunElapsedMs: PRODUCE.elapsedMs,
        maxTenantDailyUnits: PRODUCE.units,
        maxConcurrentSlots: PRODUCE.concurrencySlots,
      }),
    );
    const operationId = 'step:produce:abc:1';

    await ledger.reserve(attempt.grant, { operationId, cost: PRODUCE });

    const conflict = await refusal(
      ledger.reserve(attempt.grant, { operationId, cost: { ...PRODUCE, units: 999 } }),
    );

    expect(conflict.code).toBe('INVALID_ARGUMENT');
    expect(conflict.diagnostic).toContain('budget_reservation_conflict');
    // The original reservation is untouched: no quota was added or removed.
    expect(await operations(attempt.grant.runId)).toHaveLength(1);
    expect(await ledger.snapshot(attempt.grant)).toMatchObject({
      runUnits: 5,
      tenantDailyUnits: 5,
      concurrentSlots: 1,
    });
  });

  it('denies a step that cannot be paid for without writing a row', async () => {
    const attempt = await claim('budget-deny');
    // One unit short of the produce step: the policy is trusted config, so this is exactly the
    // situation a shipped limit creates.
    const ledger = ledgerWith(policyWith({ maxRunUnits: PRODUCE.units - 1 }));

    const denied = await refusal(
      ledger.reserve(attempt.grant, { operationId: 'step:produce:abc:1', cost: PRODUCE }),
    );

    expect(denied.code).toBe('BUDGET_EXCEEDED');
    expect(denied.diagnostic).toContain('dimension=run_units');

    // A denial rolls its transaction back: no reservation, so nothing to compensate later.
    expect(await operations(attempt.grant.runId)).toEqual([]);
    expect(await ledger.snapshot(attempt.grant)).toMatchObject({
      runSteps: 0,
      runUnits: 0,
      runElapsedMs: 0,
      concurrentSlots: 0,
    });
  });

  it('denies the next step once the Run has spent its step allowance', async () => {
    const attempt = await claim('budget-exhaust');
    const ledger = ledgerWith(policyWith({ maxRunSteps: 1 }));

    await ledger.reserve(attempt.grant, { operationId: 'step:produce:abc:1', cost: PRODUCE });
    await ledger.settle(attempt.grant, { operationId: 'step:produce:abc:1', consumed: PRODUCE });

    const denied = await refusal(
      ledger.reserve(attempt.grant, { operationId: 'step:publish:abc:1', cost: PUBLISH }),
    );

    expect(denied.code).toBe('BUDGET_EXCEEDED');
    expect(denied.diagnostic).toContain('dimension=run_steps');
    // The settled step is still charged; the denied one added nothing.
    expect(await operations(attempt.grant.runId)).toHaveLength(1);
    expect((await ledger.snapshot(attempt.grant)).runSteps).toBe(1);
  });

  it('treats a zero limit as a real, fail-closed limit', async () => {
    const attempt = await claim('budget-zero');
    const ledger = ledgerWith(policyWith({ maxConcurrentSlots: 0 }));

    const denied = await refusal(
      ledger.reserve(attempt.grant, { operationId: 'step:produce:abc:1', cost: PRODUCE }),
    );

    expect(denied.code).toBe('BUDGET_EXCEEDED');
    expect(denied.diagnostic).toContain('dimension=concurrency_slots');
    expect(await operations(attempt.grant.runId)).toEqual([]);
  });

  it('hands the concurrency slot back so the next step of the same Run can run', async () => {
    const attempt = await claim('budget-slot');
    const ledger = ledgerWith(policyWith({ maxConcurrentSlots: 1 }));

    await ledger.reserve(attempt.grant, { operationId: 'step:produce:abc:1', cost: PRODUCE });

    const blocked = await refusal(
      ledger.reserve(attempt.grant, { operationId: 'step:publish:abc:1', cost: PUBLISH }),
    );

    expect(blocked.code).toBe('BUDGET_EXCEEDED');
    expect(blocked.diagnostic).toContain('dimension=concurrency_slots');

    await ledger.settle(attempt.grant, { operationId: 'step:produce:abc:1', consumed: PRODUCE });

    // One slot is enough for a Run that finishes each step before starting the next.
    await expect(
      ledger.reserve(attempt.grant, { operationId: 'step:publish:abc:1', cost: PUBLISH }),
    ).resolves.toMatchObject({ state: 'reserved' });
    expect((await ledger.snapshot(attempt.grant)).concurrentSlots).toBe(1);
  });

  it('extends a live reservation when heartbeat renews its lease', async () => {
    const attempt = await claim('budget-heartbeat');
    const ledger = ledgerWith();
    const operationId = 'step:produce:heartbeat:1';
    const reserved = await ledger.reserve(attempt.grant, { operationId, cost: PRODUCE });
    const oldExpiry = Date.parse(reserved.expiresAt);

    clock.advance(1_000);

    await expect(queue.heartbeat(attempt.lease, clock.now())).resolves.toBe(true);

    const [operation, task] = await Promise.all([
      db.observerPool.query<{ expires_at: Date | string }>(
        `SELECT expires_at FROM budget_operations
          WHERE tenant_id = $1 AND run_id = $2 AND operation_id = $3`,
        [tenant.tenantId, attempt.grant.runId, operationId],
      ),
      db.observerPool.query<{ lease_expires_at: Date | string }>(
        'SELECT lease_expires_at FROM tasks WHERE tenant_id = $1 AND id = $2',
        [tenant.tenantId, attempt.taskId],
      ),
    ]);
    const reservationExpiry = new Date(operation.rows[0]!.expires_at).getTime();
    const taskExpiry = new Date(task.rows[0]!.lease_expires_at).getTime();

    expect(reservationExpiry).toBeGreaterThan(oldExpiry);
    expect(reservationExpiry).toBe(taskExpiry);
  });

  it('lets exactly one of many concurrent reservations hold the last slot', async () => {
    const attempt = await claim('budget-race');
    const ledger = ledgerWith(policyWith({ maxConcurrentSlots: 1 }));

    // Twelve reservations, one Tenant, one slot. Without the advisory lock every one of them
    // could observe the same spare slot and proceed; with it, exactly one decision can win.
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        ledger.reserve(attempt.grant, {
          operationId: `step:produce:race${index}:1`,
          cost: PRODUCE,
        }),
      ),
    );
    const granted = results.filter((result) => result.status === 'fulfilled');
    const denied = results.filter(
      (result) =>
        result.status === 'rejected' &&
        (result.reason as { code?: string } | undefined)?.code === 'BUDGET_EXCEEDED',
    );

    expect(granted).toHaveLength(1);
    expect(denied).toHaveLength(11);
    expect(await operations(attempt.grant.runId)).toHaveLength(1);
    expect(await ledger.snapshot(attempt.grant)).toMatchObject({
      runUnits: 5,
      concurrentSlots: 1,
    });
  });
});

describe('P0B-08b crash and retry accounting', () => {
  it('charges a dead attempt in full, fences it, and charges the retry separately', async () => {
    const first = await claim('budget-crash');
    // One slot for the whole Tenant: the retry can only reserve if the sweep released the slot
    // the dead attempt was holding.
    const ledger = ledgerWith(policyWith({ maxConcurrentSlots: 1 }));
    const produceId = 'step:produce:abc:1';

    const taken = await ledger.reserve(first.grant, { operationId: produceId, cost: PRODUCE });

    // An attempt that does not own the reservation cannot settle or release it: the row's own
    // lease epoch is the fence, so a re-claimed Run can never absorb an earlier attempt's work.
    const bumped = { ...first.grant, leaseEpoch: first.grant.leaseEpoch + 1 };
    const staleSettle = await refusal(
      ledger.settle(bumped, { operationId: produceId, consumed: PRODUCE }),
    );
    const staleRelease = await refusal(ledger.release(bumped, { operationId: produceId }));

    expect(staleSettle.code).toBe('STALE_LEASE');
    expect(staleRelease.code).toBe('STALE_LEASE');
    expect(await operations(first.grant.runId)).toMatchObject([{ state: 'reserved' }]);

    // The Worker dies after taking the reservation: its lease boundary passes and the queue
    // reports a bounded retry.
    await expireReservation(first.grant.runId);
    await expect(queue.finish(first.lease, 'failed_retryable')).resolves.toBe(true);
    expect((await readTask(db.pool, tenant.tenantId, first.taskId)).status).toBe(
      'retryable_failed',
    );

    clock.advance(1_000);

    const second = await claimNextFor(first.taskId);

    expect(second.grant.runId).not.toBe(first.grant.runId);
    expect(second.grant.leaseEpoch).toBeGreaterThan(first.grant.leaseEpoch);

    // The retry's decision sweeps the dead reservation before sizing the remaining quota.
    await expect(
      ledger.reserve(second.grant, { operationId: 'step:produce:abc:2', cost: PRODUCE }),
    ).resolves.toMatchObject({ state: 'reserved' });

    // Crashing a Worker refunds nothing: the dead attempt is charged at the full amount.
    expect(await operations(first.grant.runId)).toEqual([
      {
        operation_id: produceId,
        state: 'expired',
        lease_epoch: String(first.grant.leaseEpoch),
        reserved_units: '5',
        consumed_units: '5',
        reserved_slots: 1,
        consumed_slots: 1,
        utc_day: taken.utcDay,
      },
    ]);
    expect(await ledger.snapshot(first.grant)).toMatchObject({
      runUnits: 5,
      runElapsedMs: 50,
      // The dead reservation no longer holds a slot; the one live slot is the retry's.
      concurrentSlots: 1,
    });

    // The retry pays for its own execution instead of inheriting a free step.
    expect(await ledger.snapshot(second.grant)).toMatchObject({
      runUnits: 5,
      concurrentSlots: 1,
    });

    // Re-reporting the dead attempt's consumption neither charges nor refunds a second time.
    const lateSettle = await ledger.settle(first.grant, {
      operationId: produceId,
      consumed: PARTIAL_PRODUCE,
    });

    expect(lateSettle).toMatchObject({ state: 'expired', consumed: PRODUCE });
    expect((await ledger.snapshot(first.grant)).runUnits).toBe(5);
  });
});

describe('P0B-08b expiry wins over a late terminal request', () => {
  it('charges the full reservation when a partial settlement arrives before cleanup', async () => {
    const attempt = await claim('budget-expired-unswept-settle');
    const ledger = ledgerWith();
    const operationId = 'step:produce:late-settle:1';

    await ledger.reserve(attempt.grant, { operationId, cost: PRODUCE });
    await expireReservation(attempt.grant.runId);

    // No later reserve has swept this row. The database-time transition still sees expiry and
    // refuses to reduce the charge based on an old Worker report.
    const settled = await ledger.settle(attempt.grant, {
      operationId,
      consumed: PARTIAL_PRODUCE,
    });

    expect(settled).toMatchObject({ state: 'expired', consumed: PRODUCE });
    expect((await operations(attempt.grant.runId))[0]).toMatchObject({
      state: 'expired',
      reserved_units: String(PRODUCE.units),
      consumed_units: String(PRODUCE.units),
    });
    expect(await ledger.snapshot(attempt.grant)).toMatchObject({
      runUnits: PRODUCE.units,
      concurrentSlots: 0,
    });
  });

  it('charges the full reservation when release arrives after expiry but before cleanup', async () => {
    const attempt = await claim('budget-expired-unswept-release');
    const ledger = ledgerWith();
    const operationId = 'step:produce:late-release:1';

    await ledger.reserve(attempt.grant, { operationId, cost: PRODUCE });
    await expireReservation(attempt.grant.runId);

    const released = await ledger.release(attempt.grant, { operationId });

    expect(released).toMatchObject({ state: 'expired', consumed: PRODUCE });
    await expect(ledger.release(attempt.grant, { operationId })).resolves.toMatchObject({
      state: 'expired',
      consumed: PRODUCE,
      replayed: true,
    });
    expect((await operations(attempt.grant.runId))[0]).toMatchObject({
      state: 'expired',
      reserved_units: String(PRODUCE.units),
      consumed_units: String(PRODUCE.units),
    });
  });

  it('converges to the same full charge when late settlement races a reserve sweep', async () => {
    const oldAttempt = await claim('budget-expiry-race-old-worker');
    const ledger = ledgerWith();
    const oldOperationId = 'step:produce:expiry-race:old';

    await ledger.reserve(oldAttempt.grant, { operationId: oldOperationId, cost: PRODUCE });
    await expireReservation(oldAttempt.grant.runId);

    // A new Run in the same Tenant triggers cleanup while the old Worker reports a smaller
    // actual amount. Both transactions contend on the old operation row in PostgreSQL.
    const newAttempt = await claim('budget-expiry-race-new-worker');
    const [lateSettle, newReservation] = await Promise.all([
      ledger.settle(oldAttempt.grant, {
        operationId: oldOperationId,
        consumed: PARTIAL_PRODUCE,
      }),
      ledger.reserve(newAttempt.grant, {
        operationId: 'step:publish:expiry-race:new',
        cost: PUBLISH,
      }),
    ]);

    expect(lateSettle).toMatchObject({ state: 'expired', consumed: PRODUCE });
    expect(newReservation.state).toBe('reserved');
    expect((await operations(oldAttempt.grant.runId))[0]).toMatchObject({
      state: 'expired',
      reserved_units: String(PRODUCE.units),
      consumed_units: String(PRODUCE.units),
    });
    expect(await ledger.snapshot(oldAttempt.grant)).toMatchObject({ runUnits: PRODUCE.units });
  });
});

describe('P0B-08b refunds only what provably did not run', () => {
  it('releases a reservation taken for a step that never started', async () => {
    const attempt = await claim('budget-release');
    const ledger = ledgerWith();
    const operationId = 'step:produce:abc:1';

    await ledger.reserve(attempt.grant, { operationId, cost: PRODUCE });

    const released = await ledger.release(attempt.grant, { operationId });

    expect(released.state).toBe('released');
    // A released reservation consumed nothing, and the constraint on the row enforces that.
    expect(released.consumed).toEqual({
      steps: 0,
      units: 0,
      elapsedMs: 0,
      concurrencySlots: 0,
    });
    expect(await ledger.snapshot(attempt.grant)).toMatchObject({
      runSteps: 0,
      runUnits: 0,
      runElapsedMs: 0,
      tenantDailyUnits: 0,
      concurrentSlots: 0,
    });

    // Repeating the release is a replay, not a second refund.
    await expect(ledger.release(attempt.grant, { operationId })).resolves.toMatchObject({
      state: 'released',
      replayed: true,
    });

    // A released operation can never be charged afterwards.
    const settledAfterRelease = await refusal(
      ledger.settle(attempt.grant, { operationId, consumed: PRODUCE }),
    );

    expect(settledAfterRelease.code).toBe('INVALID_ARGUMENT');
    expect(settledAfterRelease.diagnostic).toContain('budget_operation_released');
    expect(await operations(attempt.grant.runId)).toMatchObject([{ state: 'released' }]);
  });

  it('refuses to refund an operation that already settled', async () => {
    const attempt = await claim('budget-refund-settled');
    const ledger = ledgerWith();
    const operationId = 'step:produce:abc:1';

    await ledger.reserve(attempt.grant, { operationId, cost: PRODUCE });
    await ledger.settle(attempt.grant, { operationId, consumed: PRODUCE });

    const refused = await refusal(ledger.release(attempt.grant, { operationId }));

    expect(refused.code).toBe('INVALID_ARGUMENT');
    expect(refused.diagnostic).toContain('budget_operation_already_charged');
    expect((await ledger.snapshot(attempt.grant)).runUnits).toBe(5);
  });
});

describe('P0B-08b UTC-day and Tenant scoping', () => {
  it('keeps a charge on the day it was taken and never re-dates a replay', async () => {
    const attempt = await claim('budget-day');
    // Exactly one step's worth of units per Tenant day.
    const ledger = ledgerWith(policyWith({ maxTenantDailyUnits: PRODUCE.units }));
    const operationId = 'step:produce:abc:1';

    const first = await ledger.reserve(attempt.grant, { operationId, cost: PRODUCE });
    await ledger.settle(attempt.grant, { operationId, consumed: PRODUCE });

    // Move the committed charge to yesterday, as if the step had run before midnight.
    await db.pool.query(
      `UPDATE budget_operations SET utc_day = utc_day - 1
        WHERE tenant_id = $1 AND run_id = $2`,
      [tenant.tenantId, attempt.grant.runId],
    );

    // Run counters span every day of the Run; the Tenant-day counter only sees today.
    expect(await ledger.snapshot(attempt.grant)).toMatchObject({
      runSteps: 1,
      runUnits: 5,
      runElapsedMs: 50,
      tenantDailyUnits: 0,
      concurrentSlots: 0,
    });

    // Today's allowance is therefore free again, and one step fits exactly.
    const second = await ledger.reserve(attempt.grant, {
      operationId: 'step:publish:abc:1',
      cost: PRODUCE,
    });

    expect(second.utcDay).toBe(first.utcDay);

    // ... and a third does not.
    const denied = await refusal(
      ledger.reserve(attempt.grant, { operationId: 'step:retry:abc:1', cost: PRODUCE }),
    );

    expect(denied.code).toBe('BUDGET_EXCEEDED');
    expect(denied.diagnostic).toContain('dimension=tenant_daily_units');

    // Replaying yesterday's operation today is refused instead of becoming a second charge:
    // the idempotency key is day-independent (P0B-08a section 6.1). A permissive revision is
    // used here so the replay check is reached instead of the (already exhausted) daily cap.
    const replay = await refusal(
      ledgerWith().reserve(attempt.grant, { operationId, cost: PRODUCE }),
    );

    expect(replay.code).toBe('INVALID_ARGUMENT');
    expect(replay.diagnostic).toContain('budget_operation_already_terminal');
    expect(await operations(attempt.grant.runId)).toHaveLength(2);
  });

  it('keeps two Tenants apart even when they use the same operation id', async () => {
    const attemptA = await claim('budget-tenant-a');
    // One slot for Tenant A only: Tenant B must not be able to consume A's gauge.
    const ledger = ledgerWith(policyWith({ maxConcurrentSlots: 1 }));

    const other = await createTenantFixture(db.pool);
    const otherCtx: AuthContext = {
      tenantId: other.tenantId,
      principalId: other.principalId,
      policyVersion: 3,
    };
    const otherAgent = (await agents.create(otherCtx, { name: 'p0b08b other agent' })).agentId;
    const attemptB = await claim('budget-tenant-b', { ctx: otherCtx, agentId: otherAgent });

    await ledger.reserve(attemptA.grant, { operationId: 'step:produce:abc:1', cost: PRODUCE });

    // The same operation id in another Tenant is a different charge, even with every slot of
    // the first Tenant taken.
    await expect(
      ledger.reserve(attemptB.grant, { operationId: 'step:produce:abc:1', cost: PRODUCE }),
    ).resolves.toMatchObject({ state: 'reserved' });

    expect(await ledger.snapshot(attemptA.grant)).toMatchObject({
      tenantId: tenant.tenantId,
      runUnits: 5,
      tenantDailyUnits: 5,
      concurrentSlots: 1,
    });
    expect(await ledger.snapshot(attemptB.grant)).toMatchObject({
      tenantId: other.tenantId,
      runSteps: 1,
      runUnits: 5,
      tenantDailyUnits: 5,
      concurrentSlots: 1,
    });

    expect(await operations(attemptB.grant.runId, other.tenantId)).toHaveLength(1);
    // Nothing of Tenant B is visible from Tenant A's scope.
    expect(await operations(attemptB.grant.runId)).toEqual([]);
  });
});

describe('P0B-08b the Worker refuses to run a step it cannot pay for', () => {
  it('fails the Run as terminal, before any simulated work or write', async () => {
    const attempt = await claim('budget-handler-deny');
    const handler = handlerWith(policyWith({ maxRunUnits: PRODUCE.units - 1 }));
    const filesBefore = await countFiles(infra.root.dir);

    const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));

    // `BUDGET_EXCEEDED` is not retryable, so the Run stops instead of paying again to fail again.
    expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

    expect(await countRows('artifacts', attempt.taskId)).toBe('0');
    expect(await countRows('step_checkpoints', attempt.taskId)).toBe('0');
    expect(await operations(attempt.grant.runId)).toEqual([]);
    await expect(infra.workspaces.load(ctx, agentId)).resolves.toMatchObject({ version: 0 });

    // Nothing was staged either: the refusal happened before the simulated step ran, which is
    // the property "deny before side effects" actually claims.
    expect(await countFiles(infra.root.dir)).toBe(filesBefore);
  });

  it('charges both durable steps exactly once and returns both slots', async () => {
    const attempt = await claim('budget-handler-commit');
    // One slot is enough because each step settles before the next one reserves.
    const handler = handlerWith(policyWith({ maxConcurrentSlots: 1 }));

    const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));

    expect(completion.type).toBe('committed');

    const rows = await operations(attempt.grant.runId);

    expect(
      rows.map((row) => [
        // `step:<name>:<input digest prefix>:<lease epoch>` — the digest and epoch are pinned.
        row.operation_id.replace(/:[0-9a-f]{16}:\d+$/, ''),
        row.state,
        row.consumed_units,
      ]),
    ).toEqual([
      ['step:produce', 'settled', String(PRODUCE.units)],
      ['step:publish', 'settled', String(PUBLISH.units)],
    ]);
    // Both steps are charged to the same Run and the same attempt.
    expect(new Set(rows.map((row) => row.lease_epoch))).toEqual(
      new Set([String(attempt.grant.leaseEpoch)]),
    );

    expect(await ledgerWith().snapshot(attempt.grant)).toMatchObject({
      runSteps: 2,
      runUnits: PRODUCE.units + PUBLISH.units,
      runElapsedMs: PRODUCE.elapsedMs + PUBLISH.elapsedMs,
      tenantDailyUnits: PRODUCE.units + PUBLISH.units,
      concurrentSlots: 0,
    });

    expect((await readTask(db.pool, tenant.tenantId, attempt.taskId)).status).toBe('completed');
  });
});
