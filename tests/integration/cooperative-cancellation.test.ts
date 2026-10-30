import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  BudgetLedger,
  BudgetLedgerSnapshot,
  BudgetOperation,
  BudgetReleaseRequest,
  BudgetReservationAmount,
  BudgetReserveRequest,
  BudgetSettleRequest,
  CommitReceipt,
  CommitStepRequest,
  RunGrant,
  RunResultCommitter,
} from '@ember/contracts';
import {
  DomainError,
  type AuthContext,
  type Id,
  type LeasedRun,
  type TaskStatus,
} from '@ember/domain';
import {
  DeterministicExecutionRouter,
  DeterministicExecutor,
  type BudgetPolicy,
  type SimulatedExecutionResult,
  type SimulatedExecutor,
} from '@ember/execution';
import {
  PostgresAgentRepository,
  PostgresApprovalRepository,
  PostgresArtifactStore,
  PostgresBudgetLedger,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
  type LeaseQueueConfigOverrides,
} from '@ember/postgres';
import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import { TaskCancelDtoSchema, type TaskCancelDto } from '../../apps/api/src/tasks/dto.js';
import { stepCost } from '../../apps/worker/src/budget-plan.js';
import {
  createDurableRunHandler,
  DURABLE_TASK_KINDS,
} from '../../apps/worker/src/durable-run-handler.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';
import { runPollLoop } from '../../apps/worker/src/poll-loop.js';
import type { RunHandler } from '../../apps/worker/src/run-handler.js';
import {
  createTestDatabase,
  type LockSession,
  type TestDatabase,
  type TestPool,
} from './support/database.js';
import {
  approvalCommand,
  chatCommand,
  createTenantFixture,
  type TenantFixture,
} from './support/fixtures.js';
import {
  createQueuedTask,
  databaseNow,
  listEventSnapshots,
  ManualClock,
  readRun,
  readTask,
  waitForTaskLockWaiter,
} from './support/leases.js';
import { createP06Infra, type P06Infra } from './support/p0b06.js';

/**
 * P0B-08c — Cancellation HTTP API, Cooperative Worker Cancellation & Concurrency Suite.
 *
 * Covers all 15 mandatory scenarios against real PostgreSQL with deterministic latches and
 * row-lock barriers (no arbitrary timer sleeps):
 *  1. Queued Task cancellation via `POST /v1/tasks/:taskId/cancel` (200 OK, terminal=true)
 *  2. Running Task cooperative cancellation via HTTP API + Worker poll loop (202 -> cancelled)
 *  3. Retryable (`retryable_failed`) Task cancellation (200 OK, terminal=true)
 *  4. Duplicate / idempotent cancellation (queued, running, completed, failed, cancelled)
 *  5. Non-existent Task (404 NOT_FOUND)
 *  6. Cross-Tenant cancellation (404 identical to missing, foreign Task untouched)
 *  7. Missing / invalid Bearer Token & malformed UUID (401 / 400)
 *  8. Cancel vs Claim concurrency race
 *  9. Cancel vs Finish concurrency race (both serialization orders)
 * 10. Cancel vs Checkpoint Commit (`commitStep`) concurrency race (both serialization orders)
 * 11. Cancel vs Reaper concurrency race
 * 12. No next step (`publish`) executed after cancellation during/after `produce`, while
 *     preserving already-committed `produce` Artifact and Checkpoint
 * 13. Late commit / finish from a stale lease epoch rejected (fencing)
 * 14. SSE stream disconnect & `Last-Event-ID` reconnect delivering the `cancelled` event
 * 15. Persistent Budget invariants under cancellation (release before execute, settle during
 *     execute, settle after side effects, and expiry after worker termination — no erroneous
 *     refund and no double charge)
 */

const WORKER_ID = 'worker-p0b08c';
const PRODUCE_COST = stepCost('produce');
const PUBLISH_COST = stepCost('publish');

const QUEUE_OPTIONS: LeaseQueueConfigOverrides = {
  baseDelayMs: 60_000,
  capDelayMs: 60_000,
  leaseDurationMs: 10_000,
  heartbeatIntervalMs: 100,
  reaperBatchSize: 10,
};

const PERMISSIVE_BUDGET_POLICY: BudgetPolicy = Object.freeze({
  policyId: 'p0b08c-test-permissive',
  policyVersion: 1,
  maxRunSteps: 1_000,
  maxRunUnits: 1_000_000,
  maxRunElapsedMs: 10_000_000,
  maxTenantDailyUnits: 1_000_000,
  maxConcurrentSlots: 64,
});

interface Latch {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createLatch(): Latch {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function grantFromLease(lease: LeasedRun, agentId: string, workerId: string): RunGrant {
  return Object.freeze({
    tenantId: lease.tenantId,
    taskId: lease.taskId,
    runId: lease.runId,
    agentId,
    attempt: lease.attempt,
    leaseEpoch: lease.leaseEpoch,
    workerId,
  });
}

/**
 * Hold `SELECT … FOR UPDATE` on a `tasks` row on a dedicated connection until the test
 * releases it, deterministically serializing contending transactions on PostgreSQL's row lock.
 */
async function holdTaskRowLock(
  pool: TestPool,
  tenantId: string,
  taskId: string,
): Promise<{ release: () => Promise<void>; blocker: LockSession }> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
    tenantId,
    taskId,
  ]);

  return {
    blocker: client,
    release: async (): Promise<void> => {
      try {
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Wait until exactly this Task-row lock has accumulated at least two distinct
 * request waiters. PostgreSQL may report a second waiter as blocked by the first
 * (a soft blocker) instead of the original lock holder, so walk the blocker chain.
 * This proves both HTTP requests were in flight before releasing the barrier.
 */
async function waitForTwoTaskLockWaiters(
  pool: TestPool,
  blocker: LockSession,
  timeoutMs = 5_000,
): Promise<void> {
  const pidResult = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const blockerPid = pidResult.rows[0]?.pid;
  if (blockerPid === undefined) {
    throw new Error('could not read the Task lock holder backend pid');
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(
      `WITH RECURSIVE waiters(pid) AS (
         SELECT a.pid
           FROM pg_stat_activity AS a
          WHERE a.datname = current_database()
            AND $1 = ANY(pg_blocking_pids(a.pid))
         UNION
         SELECT a.pid
           FROM pg_stat_activity AS a
           JOIN waiters AS w ON w.pid = ANY(pg_blocking_pids(a.pid))
          WHERE a.datname = current_database()
       )
       SELECT count(*)::text AS count FROM waiters`,
      [blockerPid],
    );
    if (Number(result.rows[0]?.count ?? '0') >= 2) {
      return;
    }
    // Poll PostgreSQL's actual lock graph; elapsed time never decides the winner.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('timed out waiting for both Task row lock contenders');
}

interface ParsedSseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

function parseSseFrames(raw: string): ParsedSseEvent[] {
  return raw
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith(':'))
    .map((block) => {
      let id = '';
      let event = '';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) {
          id = line.slice(4);
        } else if (line.startsWith('event: ')) {
          event = line.slice(7);
        } else if (line.startsWith('data: ')) {
          data = line.slice(6);
        }
      }
      return { id, event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

let db: TestDatabase;
let infra: P06Infra;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let artifacts: PostgresArtifactStore;
let approvals: PostgresApprovalRepository;
let queue: PostgresLeaseQueue;
let reader: PostgresRunExecutionContextReader;
let clock: ManualClock;

let tenantA: TenantFixture;
let tenantB: TenantFixture;
let ctxA: AuthContext;
let ctxB: AuthContext;
let tokenA: string;
let tokenB: string;
let agentA: Id;
let agentB: Id;
let app: ReturnType<typeof createApp>;

async function syncClock(): Promise<void> {
  const dbNow = await databaseNow(db.pool);
  clock.set(new Date(dbNow.getTime() + 50));
}

function buildHandler(
  options: {
    readonly executor?: SimulatedExecutor;
    readonly committer?: RunResultCommitter;
    readonly budget?: BudgetLedger;
  } = {},
): RunHandler {
  return createDurableRunHandler({
    contextReader: reader,
    router: new DeterministicExecutionRouter(),
    executor: options.executor ?? new DeterministicExecutor({ sandboxExecDurationMs: 1 }),
    blobs: infra.blobs,
    checkpoints: infra.checkpoints,
    committer: options.committer ?? infra.committer,
    workspaces: infra.workspaces,
    approvals,
    budget:
      options.budget ?? new PostgresBudgetLedger(db.pool, { policy: PERMISSIVE_BUDGET_POLICY }),
    clock,
    logger: createWorkerLogger({ level: 'error', sink: () => undefined }),
  });
}

async function postCancel(
  taskId: string,
  token: string | null = tokenA,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.request(`/v1/tasks/${taskId}/cancel`, {
    method: 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

async function postDecision(
  approvalId: string,
  decision: 'approve' | 'deny',
  token: string = tokenA,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.request(`/v1/approvals/${approvalId}/decision`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ decision }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

async function createAndPauseForApproval(
  keySuffix: string,
  beforeHandle?: (lease: LeasedRun) => Promise<void>,
) {
  const receipt = await tasks.create(
    ctxA,
    approvalCommand(agentA, `cancel-approval-${keySuffix}-${randomUUID()}`),
  );
  await syncClock();
  const lease1 = await queue.claimNext(WORKER_ID, clock.now());
  expect(lease1?.taskId).toBe(receipt.taskId);

  if (beforeHandle !== undefined) {
    await beforeHandle(lease1!);
  }

  const handler = buildHandler();
  const outcome1 = await handler.handle(lease1!, new AbortController().signal);
  expect(outcome1.type).toBe('committed');

  const taskRow = await readTask(db.pool, tenantA.tenantId, receipt.taskId);
  expect(taskRow.status).toBe('waiting_approval');

  const taskApprovals = await approvals.listByTask(ctxA, receipt.taskId);
  expect(taskApprovals).toHaveLength(1);
  const approval = taskApprovals[0]!;

  return {
    taskId: receipt.taskId,
    lease1: lease1!,
    approval,
  };
}

async function readBudgetOperations(
  runId: string,
  tenantId: string = tenantA.tenantId,
): Promise<
  readonly {
    operation_id: string;
    state: string;
    reserved_units: string;
    consumed_units: string;
    consumed_steps: number;
    consumed_slots: number;
  }[]
> {
  const result = await db.pool.query<{
    operation_id: string;
    state: string;
    reserved_units: string;
    consumed_units: string;
    consumed_steps: number;
    consumed_slots: number;
  }>(
    `SELECT operation_id, state, reserved_units::text, consumed_units::text,
            consumed_steps, consumed_slots
       FROM budget_operations
      WHERE tenant_id = $1 AND run_id = $2
      ORDER BY created_at ASC, operation_id ASC`,
    [tenantId, runId],
  );
  return result.rows;
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 24 });
  infra = await createP06Infra(db, { lease: QUEUE_OPTIONS });
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  artifacts = new PostgresArtifactStore(db.pool, infra.blobs);
  approvals = new PostgresApprovalRepository(db.pool);
  clock = new ManualClock(await databaseNow(db.pool));
  queue = new PostgresLeaseQueue(db.pool, {
    ...QUEUE_OPTIONS,
    clock,
    claimableKinds: DURABLE_TASK_KINDS,
  });
  reader = new PostgresRunExecutionContextReader(db.pool, clock);

  tenantA = await createTenantFixture(db.pool, 'P0B-08c Tenant A');
  tenantB = await createTenantFixture(db.pool, 'P0B-08c Tenant B');
  ctxA = { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 3 };
  ctxB = { tenantId: tenantB.tenantId, principalId: tenantB.principalId, policyVersion: 3 };
  tokenA = `dev-token-a-${randomUUID()}`;
  tokenB = `dev-token-b-${randomUUID()}`;
  agentA = (await agents.create(ctxA, { name: 'P0B-08c Agent A' })).agentId;
  agentB = (await agents.create(ctxB, { name: 'P0B-08c Agent B' })).agentId;

  app = createApp({
    authenticator: createDevTokenAuthenticator([
      {
        token: tokenA,
        tenantId: tenantA.tenantId,
        principalId: tenantA.principalId,
        policyVersion: 3,
      },
      {
        token: tokenB,
        tenantId: tenantB.tenantId,
        principalId: tenantB.principalId,
        policyVersion: 3,
      },
    ]),
    taskStore: tasks,
    artifactStore: artifacts,
    approvalStore: approvals,
  });
});

afterAll(async () => {
  await infra?.dispose();
  await db?.close();
});

beforeEach(async () => {
  await db.pool.query('DELETE FROM budget_operations');
  await db.pool.query('DELETE FROM approvals');
  await db.pool.query(
    `UPDATE tasks SET next_run_at = now() + interval '1 day'
      WHERE status IN ('queued', 'retryable_failed')`,
  );
});

describe('P0B-08c B1 & B2: HTTP Cancellation API, Auth, Tenant Isolation & Queued/Retryable Tasks', () => {
  it('1. cancels a queued Task immediately (200 OK, terminal=true), appends one cancelled event, and prevents Worker claim or fabricated Runs', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA, 'cancel-queued');

    const { status, body } = await postCancel(created.taskId);

    expect(status).toBe(200);
    const parsed: TaskCancelDto = TaskCancelDtoSchema.parse(body);
    expect(parsed).toMatchObject({
      task_id: created.taskId,
      status: 'cancelled',
      cancel_requested: true,
      terminal: true,
    });
    expect(parsed.cancel_requested_at).not.toBeNull();

    // Authoritative DB state: cancelled, no Run created, cannot be claimed.
    const row = await readTask(db.pool, tenantA.tenantId, created.taskId);
    expect(row.status).toBe('cancelled');
    expect(row.current_run_id).toBeNull();
    expect(row.attempt_count).toBe(0);

    await syncClock();
    const claimed = await queue.claimNext(WORKER_ID, clock.now());
    expect(claimed).toBeNull();

    const runsCount = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM runs WHERE tenant_id = $1 AND task_id = $2',
      [tenantA.tenantId, created.taskId],
    );
    expect(runsCount.rows[0]?.count).toBe('0');

    const events = await listEventSnapshots(db.pool, tenantA.tenantId, created.taskId);
    expect(events.map((e) => e.phase)).toEqual(['accepted', 'cancelled']);
    expect(events[1]?.payload).toMatchObject({
      fromStatus: 'queued',
      toStatus: 'cancelled',
      cancelRequested: true,
    });
  });

  it('3. cancels a retryable_failed Task immediately (200 OK, terminal=true) and prevents re-claim', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA, 'cancel-retryable');
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease?.taskId).toBe(created.taskId);

    await syncClock();
    await expect(queue.finish(lease!, 'failed_retryable')).resolves.toBe(true);
    expect((await readTask(db.pool, tenantA.tenantId, created.taskId)).status).toBe(
      'retryable_failed',
    );

    const { status, body } = await postCancel(created.taskId);
    expect(status).toBe(200);
    expect(TaskCancelDtoSchema.parse(body)).toMatchObject({
      task_id: created.taskId,
      status: 'cancelled',
      cancel_requested: true,
      terminal: true,
    });

    // Advance clock past retry backoff: the cancelled task must never be claimed again.
    clock.advance(120_000);
    await expect(queue.claimNext(WORKER_ID, clock.now())).resolves.toBeNull();

    const events = await listEventSnapshots(db.pool, tenantA.tenantId, created.taskId);
    expect(events.map((e) => e.phase)).toEqual([
      'accepted',
      'leased',
      'started',
      'retry_scheduled',
      'cancelled',
    ]);
    expect(events[4]?.payload).toMatchObject({
      fromStatus: 'retryable_failed',
      toStatus: 'cancelled',
      cancelRequested: true,
    });
  });

  it('4. duplicate cancellation is idempotent, preserves initial cancel_requested_at, and never emits duplicate terminal events', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA, 'cancel-idempotent');

    const first = await postCancel(created.taskId);
    const second = await postCancel(created.taskId);
    const third = await postCancel(created.taskId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(third.body).toEqual(first.body);

    const events = await listEventSnapshots(db.pool, tenantA.tenantId, created.taskId);
    expect(events.filter((e) => e.phase === 'cancelled')).toHaveLength(1);

    // Also verify idempotency on an already-completed Task: stays completed with 200 OK.
    const completedTask = await createQueuedTask(tasks, ctxA, agentA, 'cancel-already-completed');
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());
    await syncClock();
    await expect(queue.finish(lease!, 'succeeded')).resolves.toBe(true);

    const completedCancel = await postCancel(completedTask.taskId);
    expect(completedCancel.status).toBe(200);
    expect(TaskCancelDtoSchema.parse(completedCancel.body)).toMatchObject({
      task_id: completedTask.taskId,
      status: 'completed',
      cancel_requested: false,
      cancel_requested_at: null,
      terminal: true,
    });
    const completedEvents = await listEventSnapshots(
      db.pool,
      tenantA.tenantId,
      completedTask.taskId,
    );
    expect(completedEvents.map((e) => e.phase)).toEqual([
      'accepted',
      'leased',
      'started',
      'completed',
    ]);
  });

  it('5 & 6. returns identical 404 responses for non-existent and cross-Tenant Tasks without mutating foreign state', async () => {
    const foreignTask = await createQueuedTask(tasks, ctxB, agentB, 'cancel-foreign-tenant');
    const missingId = randomUUID();

    const missingRes = await postCancel(missingId, tokenA);
    const foreignRes = await postCancel(foreignTask.taskId, tokenA);

    expect(missingRes.status).toBe(404);
    expect(foreignRes.status).toBe(404);
    expect(missingRes.body).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
    expect(foreignRes.body).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });

    // Tenant B's Task is completely untouched.
    const untouched = await readTask(db.pool, tenantB.tenantId, foreignTask.taskId);
    expect(untouched.status).toBe('queued');
    expect(untouched.cancel_requested_at).toBeNull();
  });

  it('7. rejects missing token, invalid token, and malformed UUID before touching PostgreSQL', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA, 'cancel-auth-guard');

    const noToken = await postCancel(created.taskId, null);
    const badToken = await postCancel(created.taskId, 'Bearer-forged-token');
    const badUuid = await postCancel('not-a-valid-uuid', tokenA);

    expect(noToken.status).toBe(401);
    expect(badToken.status).toBe(401);
    expect(badUuid.status).toBe(400);

    const row = await readTask(db.pool, tenantA.tenantId, created.taskId);
    expect(row.status).toBe('queued');
    expect(row.cancel_requested_at).toBeNull();
    // Clean up queued task so later claimNext calls do not pick it up.
    await postCancel(created.taskId, tokenA);
  });
});

describe('P0B-08c B3: Running Task Cooperative Cancellation & Step Boundaries', () => {
  it('2. cooperatively cancels an in-flight Running Task via heartbeat -> AbortSignal -> fenced finish()', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA, 'cancel-running-cooperative');
    const enteredStep = createLatch();
    const baseExecutor = new DeterministicExecutor({ sandboxExecDurationMs: 1 });

    const blockingExecutor: SimulatedExecutor = {
      execute: async (context, route, signal): Promise<SimulatedExecutionResult> => {
        enteredStep.resolve();
        await waitForAbort(signal);
        return await baseExecutor.execute(context, route, signal);
      },
    };

    await syncClock();
    const stopLoop = new AbortController();
    const loopPromise = runPollLoop({
      queue,
      handler: buildHandler({ executor: blockingExecutor }),
      clock,
      workerId: WORKER_ID,
      concurrency: 1,
      heartbeatIntervalMs: 20,
      idleIntervalMs: 20,
      errorBackoffMs: 20,
      logger: createWorkerLogger({ level: 'error', sink: () => undefined }),
      signal: stopLoop.signal,
    });

    try {
      // Wait until the Worker is deterministically inside the `produce` step.
      await enteredStep.promise;

      // Cancel while running: HTTP API returns 202 Accepted with terminal=false.
      const cancelResponse = await postCancel(created.taskId);
      expect(cancelResponse.status).toBe(202);
      const firstDto = TaskCancelDtoSchema.parse(cancelResponse.body);
      expect(firstDto).toMatchObject({
        task_id: created.taskId,
        status: 'running',
        cancel_requested: true,
        terminal: false,
      });

      // Keep clock synced so heartbeat and finish timestamps remain valid against DB time.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await syncClock();
        const current = await readTask(db.pool, tenantA.tenantId, created.taskId);
        if (current.status === 'cancelled') {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      stopLoop.abort();
    }

    const summary = await loopPromise;
    const taskAfter = await readTask(db.pool, tenantA.tenantId, created.taskId);
    const runAfter = await readRun(
      db.pool,
      tenantA.tenantId,
      created.taskId,
      taskAfter.current_run_id ?? '',
    );

    expect(taskAfter.status).toBe('cancelled');
    expect(runAfter?.status).toBe('cancelled');
    expect(summary.claimed).toBe(1);
    expect(summary.finished).toBe(1);

    // Subsequent cancel call now sees the converged terminal state and returns 200 OK.
    const afterConverge = await postCancel(created.taskId);
    expect(afterConverge.status).toBe(200);
    expect(TaskCancelDtoSchema.parse(afterConverge.body)).toMatchObject({
      task_id: created.taskId,
      status: 'cancelled',
      cancel_requested: true,
      terminal: true,
    });
  });

  it('12. stops at the produce -> publish step boundary after cancellation, never starts publish, and preserves committed Artifact & Checkpoint', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA, 'cancel-after-produce-boundary');
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease?.taskId).toBe(created.taskId);

    const workspaceBefore = await infra.workspaces.load(ctxA, agentA);
    const stepCalls: string[] = [];

    // Wrap the real committer so that right after `produce` (`mode === 'progress'`) commits its
    // Artifact and Checkpoint in PostgreSQL, cancellation is requested via the HTTP API before
    // `publish` can begin.
    const boundaryCommitter: RunResultCommitter = {
      findReceipt: (grant, op) => infra.committer.findReceipt(grant, op),
      commitStep: async (grant: RunGrant, request: CommitStepRequest): Promise<CommitReceipt> => {
        if (request.checkpoint) {
          stepCalls.push(request.checkpoint.stepId);
        }
        const receipt = await infra.committer.commitStep(grant, request);
        if (request.mode === 'progress') {
          const res = await postCancel(created.taskId);
          expect(res.status).toBe(202);
        }
        return receipt;
      },
    };

    const handler = buildHandler({ committer: boundaryCommitter });

    await syncClock();
    const completion = await handler.handle(lease!, AbortSignal.timeout(10_000));

    expect(completion).toEqual({ type: 'finish', outcome: 'cancelled' });
    // `publish` was never invoked.
    expect(stepCalls).toEqual(['produce']);

    await syncClock();
    await expect(queue.finish(lease!, 'cancelled')).resolves.toBe(true);

    // Irreversible side effects of `produce` (Artifact + Checkpoint) remain intact and visible.
    const listRes = await app.request(`/v1/tasks/${created.taskId}/artifacts`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { artifacts: { artifact_id: string }[] };
    expect(listBody.artifacts).toHaveLength(1);

    const checkpoints = await db.pool.query<{ step_id: string }>(
      'SELECT step_id FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [tenantA.tenantId, created.taskId],
    );
    expect(checkpoints.rows.map((r) => r.step_id)).toEqual(['produce']);

    // Workspace was never updated because `publish` was never started.
    const workspaceAfter = await infra.workspaces.load(ctxA, agentA);
    expect(workspaceAfter.version).toBe(workspaceBefore.version);
  });
});

describe('P0B-08c B4 & 15: Persistent Budget Invariants under Cancellation', () => {
  it('15a. releases the reservation with 0 consumed when cancelled after budget.reserve but before step execution starts', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA, 'budget-cancel-pre-execute');
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease?.taskId).toBe(created.taskId);
    const grant = grantFromLease(lease!, agentA, WORKER_ID);

    let executorCalled = false;
    const spyExecutor: SimulatedExecutor = {
      execute: (): Promise<SimulatedExecutionResult> => {
        executorCalled = true;
        return Promise.reject(new Error('executor must not be called when cancelled pre-execute'));
      },
    };

    const realLedger = new PostgresBudgetLedger(db.pool, { policy: PERMISSIVE_BUDGET_POLICY });
    const cancelingAfterReserveLedger: BudgetLedger = {
      reserve: async (g: RunGrant, req: BudgetReserveRequest): Promise<BudgetOperation> => {
        const op = await realLedger.reserve(g, req);
        // Deterministically cancel in PostgreSQL right after `reserve` commits, before `execute` starts.
        const cancelRes = await postCancel(created.taskId);
        expect(cancelRes.status).toBe(202);
        return op;
      },
      settle: (g: RunGrant, req: BudgetSettleRequest): Promise<BudgetOperation> =>
        realLedger.settle(g, req),
      release: (g: RunGrant, req: BudgetReleaseRequest): Promise<BudgetOperation> =>
        realLedger.release(g, req),
      snapshot: (g: RunGrant): Promise<BudgetLedgerSnapshot> => realLedger.snapshot(g),
    };

    const handler = buildHandler({
      executor: spyExecutor,
      budget: cancelingAfterReserveLedger,
    });

    await syncClock();
    const completion = await handler.handle(lease!, AbortSignal.timeout(10_000));

    expect(completion).toEqual({ type: 'finish', outcome: 'cancelled' });
    expect(executorCalled).toBe(false);

    const ops = await readBudgetOperations(lease!.runId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      state: 'released',
      reserved_units: String(PRODUCE_COST.units),
      consumed_units: '0',
      consumed_steps: 0,
      consumed_slots: 0,
    });

    const snap = await realLedger.snapshot(grant);
    expect(snap).toMatchObject({
      runSteps: 0,
      runUnits: 0,
      concurrentSlots: 0,
    });

    await syncClock();
    await expect(queue.finish(lease!, 'cancelled')).resolves.toBe(true);
  });

  it('15b. settles full step cost (never refunds) when cancelled during step execution or after produce side effects', async () => {
    // Part 1: Cancelled during `produce` execution -> `produce` settled in full, `publish` never reserved.
    const duringTask = await createQueuedTask(tasks, ctxA, agentA, 'budget-cancel-mid-execute');
    await syncClock();
    const duringLease = await queue.claimNext(WORKER_ID, clock.now());
    const duringGrant = grantFromLease(duringLease!, agentA, WORKER_ID);
    const controller = new AbortController();

    const midCancelExecutor: SimulatedExecutor = {
      execute: async (_ctx, _route, signal): Promise<SimulatedExecutionResult> => {
        const res = await postCancel(duringTask.taskId);
        expect(res.status).toBe(202);
        controller.abort();
        await waitForAbort(signal);
        throw new DomainError('CANCELLED', 'aborted mid-execution');
      },
    };

    const ledger = new PostgresBudgetLedger(db.pool, { policy: PERMISSIVE_BUDGET_POLICY });
    const handler1 = buildHandler({ executor: midCancelExecutor, budget: ledger });

    await syncClock();
    const duringCompletion = await handler1.handle(duringLease!, controller.signal);
    expect(duringCompletion).toEqual({ type: 'finish', outcome: 'cancelled' });

    const duringOps = await readBudgetOperations(duringLease!.runId);
    expect(duringOps).toHaveLength(1);
    expect(duringOps[0]).toMatchObject({
      state: 'settled',
      reserved_units: String(PRODUCE_COST.units),
      consumed_units: String(PRODUCE_COST.units),
      consumed_steps: PRODUCE_COST.steps,
      consumed_slots: PRODUCE_COST.concurrencySlots,
    });
    expect(await ledger.snapshot(duringGrant)).toMatchObject({
      runSteps: PRODUCE_COST.steps,
      runUnits: PRODUCE_COST.units,
      concurrentSlots: 0,
    });
    await syncClock();
    await expect(queue.finish(duringLease!, 'cancelled')).resolves.toBe(true);

    // Part 2: Cancelled after `produce` committed side effects -> `produce` stays settled, `publish` never reserved.
    const afterSideEffectTask = await createQueuedTask(
      tasks,
      ctxA,
      agentA,
      'budget-cancel-post-side-effect',
    );
    await syncClock();
    const sideEffectLease = await queue.claimNext(WORKER_ID, clock.now());
    const sideEffectGrant = grantFromLease(sideEffectLease!, agentA, WORKER_ID);

    const postProduceCancelCommitter: RunResultCommitter = {
      findReceipt: (grant, op) => infra.committer.findReceipt(grant, op),
      commitStep: async (grant: RunGrant, request: CommitStepRequest): Promise<CommitReceipt> => {
        const receipt = await infra.committer.commitStep(grant, request);
        if (request.mode === 'progress') {
          await postCancel(afterSideEffectTask.taskId);
        }
        return receipt;
      },
    };

    const handler2 = buildHandler({
      committer: postProduceCancelCommitter,
      budget: ledger,
    });

    await syncClock();
    const postCompletion = await handler2.handle(sideEffectLease!, AbortSignal.timeout(10_000));
    expect(postCompletion).toEqual({ type: 'finish', outcome: 'cancelled' });

    const sideEffectOps = await readBudgetOperations(sideEffectLease!.runId);
    expect(sideEffectOps).toHaveLength(1);
    expect(sideEffectOps[0]).toMatchObject({
      state: 'settled',
      consumed_units: String(PRODUCE_COST.units),
      consumed_slots: PRODUCE_COST.concurrencySlots,
    });
    expect(await ledger.snapshot(sideEffectGrant)).toMatchObject({
      runSteps: PRODUCE_COST.steps,
      runUnits: PRODUCE_COST.units,
      concurrentSlots: 0,
    });
    expect(PUBLISH_COST.units).toBeGreaterThan(0);

    await syncClock();
    await expect(queue.finish(sideEffectLease!, 'cancelled')).resolves.toBe(true);
  });

  it('15c. expires an unsettled reservation and charges full cost when the Worker terminates and the lease expires', async () => {
    const shortQueue = new PostgresLeaseQueue(db.pool, {
      ...QUEUE_OPTIONS,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
      clock,
      claimableKinds: DURABLE_TASK_KINDS,
    });
    const created = await createQueuedTask(tasks, ctxA, agentA, 'budget-cancel-worker-crash');
    await syncClock();
    clock.advance(100);
    const lease = await shortQueue.claimNext(WORKER_ID, clock.now());
    expect(lease?.taskId).toBe(created.taskId);
    const grant = grantFromLease(lease!, agentA, WORKER_ID);

    const ledger = new PostgresBudgetLedger(db.pool, { policy: PERMISSIVE_BUDGET_POLICY });
    await ledger.reserve(grant, {
      operationId: `step:produce:crash:${lease!.leaseEpoch}`,
      cost: PRODUCE_COST,
    });

    // Request cancel while worker holds the reservation, then advance clock past lease expiry.
    const cancelRes = await postCancel(created.taskId);
    expect(cancelRes.status).toBe(202);

    clock.advance(2_000);
    // Mark the reservation expired relative to DB time, as would occur upon real clock progression.
    await db.pool.query(
      `UPDATE budget_operations SET expires_at = now() - interval '1 millisecond'
        WHERE tenant_id = $1 AND run_id = $2 AND state = 'reserved'`,
      [tenantA.tenantId, lease!.runId],
    );

    // Reaper converges the Run to `lease_expired` and the Task to `cancelled`.
    const reaped = await shortQueue.reapExpired(clock.now());
    expect(reaped).toBeGreaterThanOrEqual(1);

    // When an expired reservation is settled or swept, it is charged at full cost (no refund).
    const lateSettle = await ledger.settle(grant, {
      operationId: `step:produce:crash:${lease!.leaseEpoch}`,
      consumed: { units: 0, steps: 0, elapsedMs: 0, concurrencySlots: 0 },
    });
    expect(lateSettle).toMatchObject({
      state: 'expired',
      consumed: PRODUCE_COST,
    });

    const snap = await ledger.snapshot(grant);
    expect(snap).toMatchObject({
      runSteps: PRODUCE_COST.steps,
      runUnits: PRODUCE_COST.units,
      concurrentSlots: 0,
    });

    const ops = await readBudgetOperations(lease!.runId);
    expect(ops[0]).toMatchObject({
      state: 'expired',
      consumed_units: String(PRODUCE_COST.units),
      consumed_slots: PRODUCE_COST.concurrencySlots,
    });
  });
});

describe('P0B-08c B5: Deterministic Concurrency Races & Fencing', () => {
  it('8. Cancel vs Claim race: serializes cleanly on the Task row lock without creating a Run after cancel', async () => {
    // Subcase A: Cancel holds Task row lock first -> Claim sees cancelled task and returns null.
    const taskA = await createQueuedTask(tasks, ctxA, agentA, 'race-cancel-vs-claim-a');
    await syncClock();
    const lockA = await holdTaskRowLock(db.pool, tenantA.tenantId, taskA.taskId);

    const cancelPromiseA = postCancel(taskA.taskId);
    await waitForTaskLockWaiter(db.pool, lockA.blocker);
    const claimPromiseA = queue.claimNext(WORKER_ID, clock.now());

    await lockA.release();
    const [cancelResA, claimedA] = await Promise.all([cancelPromiseA, claimPromiseA]);

    expect(cancelResA.status).toBe(200);
    expect(cancelResA.body.status).toBe('cancelled');
    expect(claimedA).toBeNull();
    expect((await readTask(db.pool, tenantA.tenantId, taskA.taskId)).status).toBe('cancelled');

    // Subcase B: Concurrent Claim and Cancel launched simultaneously on the same Task.
    const taskB = await createQueuedTask(tasks, ctxA, agentA, 'race-cancel-vs-claim-b');
    await syncClock();
    const [cancelResB, claimedB] = await Promise.all([
      postCancel(taskB.taskId),
      queue.claimNext(WORKER_ID, clock.now()),
    ]);

    if (claimedB === null) {
      expect(cancelResB.status).toBe(200);
      expect(cancelResB.body.status).toBe('cancelled');
    } else {
      // Claim won the lock first, so Cancel observed `running` (202) and recorded `cancel_requested_at`.
      expect(cancelResB.status).toBe(202);
      expect(cancelResB.body.status).toBe('running');
      await syncClock();
      await expect(queue.finish(claimedB, 'succeeded')).resolves.toBe(true);
      // ADR-0001: finish() on a Run whose Task has `cancel_requested_at` converges to `cancelled`!
      expect((await readTask(db.pool, tenantA.tenantId, taskB.taskId)).status).toBe('cancelled');
    }
  });

  it('9. Cancel vs Finish race: both serialization orders preserve single-event state consistency', async () => {
    // Order 1: Cancel wins Task row lock before Finish('succeeded') -> converges to `cancelled`.
    const task1 = await createQueuedTask(tasks, ctxA, agentA, 'race-cancel-before-finish');
    await syncClock();
    const lease1 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease1?.taskId).toBe(task1.taskId);

    const lock1 = await holdTaskRowLock(db.pool, tenantA.tenantId, task1.taskId);
    const cancel1 = postCancel(task1.taskId);
    await waitForTaskLockWaiter(db.pool, lock1.blocker);
    await lock1.release();
    const cancelRes1 = await cancel1;
    expect(cancelRes1.status).toBe(202);

    await syncClock();
    await expect(queue.finish(lease1!, 'succeeded')).resolves.toBe(true);
    expect((await readTask(db.pool, tenantA.tenantId, task1.taskId)).status).toBe('cancelled');
    expect((await readRun(db.pool, tenantA.tenantId, task1.taskId, lease1!.runId))?.status).toBe(
      'cancelled',
    );
    const events1 = await listEventSnapshots(db.pool, tenantA.tenantId, task1.taskId);
    expect(events1.map((e) => e.phase)).toEqual(['accepted', 'leased', 'started', 'cancelled']);

    // Order 2: Finish('succeeded') holds Task row lock while Cancel waits -> Finish completes, Cancel is 200 completed no-op.
    const task2 = await createQueuedTask(tasks, ctxA, agentA, 'race-finish-before-cancel');
    await syncClock();
    const lease2 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease2?.taskId).toBe(task2.taskId);

    const lock2 = await holdTaskRowLock(db.pool, tenantA.tenantId, task2.taskId);
    await syncClock();
    const finish2 = queue.finish(lease2!, 'succeeded');
    await waitForTaskLockWaiter(db.pool, lock2.blocker);
    await lock2.release();
    await expect(finish2).resolves.toBe(true);

    const cancelRes2 = await postCancel(task2.taskId);
    expect(cancelRes2.status).toBe(200);
    expect(TaskCancelDtoSchema.parse(cancelRes2.body)).toMatchObject({
      task_id: task2.taskId,
      status: 'completed',
      cancel_requested: false,
      cancel_requested_at: null,
      terminal: true,
    });
    const events2 = await listEventSnapshots(db.pool, tenantA.tenantId, task2.taskId);
    expect(events2.map((e) => e.phase)).toEqual(['accepted', 'leased', 'started', 'completed']);
  });

  it('10. Cancel vs Checkpoint Commit (`commitStep`) race: rejects commit with zero writes when cancel wins lock first', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA, 'race-cancel-vs-checkpoint');
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());
    const grant = grantFromLease(lease!, agentA, WORKER_ID);

    const staged = await infra.blobs.stage(
      tenantA.tenantId,
      Buffer.from('checkpoint-race-payload', 'utf8'),
      'text/plain',
    );

    // Hold the Task row lock, queue `cancel` behind it, then release and race `commitStep`.
    const lock = await holdTaskRowLock(db.pool, tenantA.tenantId, created.taskId);
    const cancelPromise = postCancel(created.taskId);
    await waitForTaskLockWaiter(db.pool, lock.blocker);
    await lock.release();

    const cancelRes = await cancelPromise;
    expect(cancelRes.status).toBe(202);

    await expect(
      infra.committer.commitStep(grant, {
        operationId: `step:produce:race:${lease!.leaseEpoch}`,
        mode: 'progress',
        artifacts: [{ artifactId: staged.stagedId, staged }],
        checkpoint: {
          stepId: 'produce',
          inputDigest: 'a'.repeat(64),
          executorVersion: 'deterministic-executor@1',
          artifacts: [
            {
              artifactId: staged.stagedId,
              sha256: staged.sha256,
              size: staged.size,
              mediaType: staged.mediaType,
              path: 'chat/race.txt',
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    // Zero artifacts or checkpoints were committed.
    const checkpointCount = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [tenantA.tenantId, created.taskId],
    );
    expect(checkpointCount.rows[0]?.count).toBe('0');

    await syncClock();
    await expect(queue.finish(lease!, 'cancelled')).resolves.toBe(true);
  });

  it('11. Cancel vs Reaper race: expired Run with cancel_requested converges Run=lease_expired and Task=cancelled without retry', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA, 'race-cancel-vs-reaper');
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease?.taskId).toBe(created.taskId);

    // Advance manual clock past lease expiry and race `postCancel` with `reapExpired` under row lock.
    clock.advance((QUEUE_OPTIONS.leaseDurationMs ?? 10_000) + 1_000);
    const lock = await holdTaskRowLock(db.pool, tenantA.tenantId, created.taskId);

    const cancelPromise = postCancel(created.taskId);
    await waitForTaskLockWaiter(db.pool, lock.blocker);
    await lock.release();

    const cancelRes = await cancelPromise;
    expect(cancelRes.status).toBe(202);

    const reaped = await queue.reapExpired(clock.now());
    expect(reaped).toBeGreaterThanOrEqual(1);

    const taskAfter = await readTask(db.pool, tenantA.tenantId, created.taskId);
    const runAfter = await readRun(db.pool, tenantA.tenantId, created.taskId, lease!.runId);
    expect(taskAfter.status).toBe('cancelled');
    expect(runAfter?.status).toBe('lease_expired');

    const events = await listEventSnapshots(db.pool, tenantA.tenantId, created.taskId);
    expect(events.map((e) => e.phase)).toEqual(['accepted', 'leased', 'started', 'cancelled']);
    expect(events[3]?.payload).toMatchObject({
      fromStatus: 'running',
      toStatus: 'cancelled',
      runStatus: 'lease_expired',
      cancelRequested: true,
    });
  });

  it('13. Fencing: late result commit or finish from a stale epoch cannot overwrite the authoritative cancelled terminal state', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA, 'fencing-stale-epoch-after-cancel');
    await syncClock();
    const staleLease = await queue.claimNext(WORKER_ID, clock.now());
    expect(staleLease?.taskId).toBe(created.taskId);
    const staleGrant = grantFromLease(staleLease!, agentA, WORKER_ID);

    // Cancel and converge the Task to terminal `cancelled`.
    const cancelRes = await postCancel(created.taskId);
    expect(cancelRes.status).toBe(202);
    await syncClock();
    await expect(queue.finish(staleLease!, 'cancelled')).resolves.toBe(true);
    expect((await readTask(db.pool, tenantA.tenantId, created.taskId)).status).toBe('cancelled');

    // A late worker from that epoch tries to `finish('succeeded')`, `heartbeat()`, and `commitStep('result')`.
    await expect(queue.heartbeat(staleLease!, clock.now())).resolves.toBe(false);
    await expect(queue.finish(staleLease!, 'succeeded')).resolves.toBe(false);
    await expect(
      infra.committer.commitStep(staleGrant, {
        operationId: `step:publish:stale:${staleLease!.leaseEpoch}`,
        mode: 'result',
        checkpoint: {
          stepId: 'publish',
          inputDigest: 'b'.repeat(64),
          executorVersion: 'deterministic-executor@1',
          artifacts: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    // Authoritative terminal state and event log remain untouched.
    const taskAfter = await readTask(db.pool, tenantA.tenantId, created.taskId);
    expect(taskAfter.status).toBe('cancelled');
    const events = await listEventSnapshots(db.pool, tenantA.tenantId, created.taskId);
    expect(events.map((e) => e.phase)).toEqual(['accepted', 'leased', 'started', 'cancelled']);
  });
});

describe('P0B-08c 14: SSE Disconnect Recovery & Cancelled Terminal Event Delivery', () => {
  it('14. streams initial events, recovers via Last-Event-ID after disconnect, and delivers the final cancelled event', async () => {
    const receipt = await tasks.create(
      ctxA,
      chatCommand(agentA, `sse-cancel-${randomUUID()}`, 'stream cooperative cancel'),
    );
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease?.taskId).toBe(receipt.taskId);

    // 1. Connect to SSE while Task is `running` and read the first 3 events (`accepted`, `leased`, `started`), then disconnect.
    const firstAbort = new AbortController();
    const firstStreamRes = await app.request(`/v1/tasks/${receipt.taskId}/stream`, {
      headers: { authorization: `Bearer ${tokenA}` },
      signal: firstAbort.signal,
    });
    expect(firstStreamRes.status).toBe(200);

    const reader1 = firstStreamRes.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    let buffer1 = '';
    while (parseSseFrames(buffer1).length < 3) {
      const chunk = await reader1.read();
      if (chunk.done) {
        break;
      }
      buffer1 += decoder.decode(chunk.value, { stream: true });
    }
    firstAbort.abort();
    await reader1.cancel().catch(() => undefined);

    const initialFrames = parseSseFrames(buffer1);
    expect(initialFrames.map((f) => f.data.phase)).toEqual(['accepted', 'leased', 'started']);
    const lastSeenId = initialFrames[2]!.id;
    expect(lastSeenId).toBe('3');

    // 2. Cancel the running Task via HTTP API and converge it via Worker finish.
    const cancelRes = await postCancel(receipt.taskId);
    expect(cancelRes.status).toBe(202);
    await syncClock();
    await expect(queue.finish(lease!, 'cancelled')).resolves.toBe(true);

    // 3. Reconnect with `Last-Event-ID: 3`: stream replays only sequence > 3 (`cancelled`) and closes cleanly.
    const reconnectRes = await app.request(`/v1/tasks/${receipt.taskId}/stream`, {
      headers: {
        authorization: `Bearer ${tokenA}`,
        'Last-Event-ID': lastSeenId,
      },
    });
    expect(reconnectRes.status).toBe(200);
    const reconnectText = await reconnectRes.text();
    const reconnectedFrames = parseSseFrames(reconnectText);

    expect(reconnectedFrames).toHaveLength(1);
    expect(reconnectedFrames[0]).toMatchObject({
      id: '4',
      event: 'task',
      data: {
        task_id: receipt.taskId,
        sequence: 4,
        phase: 'cancelled',
        payload: {
          runId: lease!.runId,
          attempt: 1,
          fromStatus: 'running' satisfies TaskStatus,
          toStatus: 'cancelled' satisfies TaskStatus,
          cancelRequested: true,
        },
      },
    });
  });
});

describe('P0B-08c / P0B-08d: Cancellation of waiting_approval Tasks & Approval Concurrency', () => {
  it('16a. cancels a waiting_approval Task immediately (200 OK, terminal=true), synchronously expires pending Approvals, sweeps reserved budget, and rejects late approval with 409', async () => {
    // 1. Establish a real test reservation operation in `reserved` state on this task before cancellation
    const ledger = new PostgresBudgetLedger(db.pool, { policy: PERMISSIVE_BUDGET_POLICY });
    const testOpId = `step:approval_pending_reserve:${randomUUID()}`;
    const testCost: BudgetReservationAmount = {
      steps: 1,
      units: 25,
      elapsedMs: 5_000,
      concurrencySlots: 1,
    };

    const { taskId, lease1, approval } = await createAndPauseForApproval(
      'cancel-waiting-approval',
      async (claimedLease) => {
        const grant = grantFromLease(claimedLease, agentA, WORKER_ID);
        await ledger.reserve(grant, { operationId: testOpId, cost: testCost });
      },
    );

    // Pre-condition: Task is waiting_approval, Approval is pending
    expect((await readTask(db.pool, tenantA.tenantId, taskId)).status).toBe('waiting_approval');
    expect((await approvals.get(ctxA, approval.approvalId))?.status).toBe('pending');

    // Explicitly verify the reservation exists prior to cancel: state = 'reserved', reserved_units > 0
    const opsBefore = await db.pool.query<{
      operation_id: string;
      state: string;
      reserved_units: string;
      consumed_units: string;
    }>(
      `SELECT operation_id, state, reserved_units::text, consumed_units::text
         FROM budget_operations
        WHERE tenant_id = $1 AND task_id = $2 AND operation_id = $3`,
      [tenantA.tenantId, taskId, testOpId],
    );
    expect(opsBefore.rows).toHaveLength(1);
    expect(opsBefore.rows[0]).toMatchObject({
      operation_id: testOpId,
      state: 'reserved',
      reserved_units: '25',
      consumed_units: '0',
    });

    // Cancel via public HTTP API
    const cancelRes = await postCancel(taskId);
    expect(cancelRes.status).toBe(200);
    expect(TaskCancelDtoSchema.parse(cancelRes.body)).toMatchObject({
      task_id: taskId,
      status: 'cancelled',
      cancel_requested: true,
      terminal: true,
    });

    // Authoritative DB state: Task is cancelled, preserving pre-approval run ID
    const taskAfter = await readTask(db.pool, tenantA.tenantId, taskId);
    expect(taskAfter.status).toBe('cancelled');
    expect(taskAfter.current_run_id).toBe(lease1.runId);

    // Synchronously in the same transaction, pending Approval is expired with decided_at recorded
    const approvalAfter = await approvals.get(ctxA, approval.approvalId);
    expect(approvalAfter?.status).toBe('expired');
    expect(approvalAfter?.decidedAt).not.toBeNull();

    // The reserved budget is swept to expired with full cost charged: consumed = reserved (no erroneous refund)
    const opsAfter = await db.pool.query<{
      operation_id: string;
      state: string;
      reserved_units: string;
      consumed_units: string;
    }>(
      `SELECT operation_id, state, reserved_units::text, consumed_units::text
         FROM budget_operations
        WHERE tenant_id = $1 AND task_id = $2 AND operation_id = $3`,
      [tenantA.tenantId, taskId, testOpId],
    );
    expect(opsAfter.rows).toHaveLength(1);
    expect(opsAfter.rows[0]).toMatchObject({
      operation_id: testOpId,
      state: 'expired',
      reserved_units: '25',
      consumed_units: '25',
    });

    // Also assert across all operations for this task: none remain in 'reserved' state
    const allOps = await db.pool.query<{ state: string }>(
      'SELECT state FROM budget_operations WHERE tenant_id = $1 AND task_id = $2',
      [tenantA.tenantId, taskId],
    );
    for (const op of allOps.rows) {
      expect(op.state).not.toBe('reserved');
    }

    // Duplicate cancellation: idempotent, does not double-charge or create duplicate operations
    const repeatCancel = await postCancel(taskId);
    expect(repeatCancel.status).toBe(200);
    const opsAfterRepeat = await db.pool.query<{
      operation_id: string;
      state: string;
      reserved_units: string;
      consumed_units: string;
    }>(
      `SELECT operation_id, state, reserved_units::text, consumed_units::text
         FROM budget_operations
        WHERE tenant_id = $1 AND task_id = $2 AND operation_id = $3`,
      [tenantA.tenantId, taskId, testOpId],
    );
    expect(opsAfterRepeat.rows[0]).toMatchObject({
      operation_id: testOpId,
      state: 'expired',
      reserved_units: '25',
      consumed_units: '25',
    });

    // Late approve decision returns 409 Conflict (INVALID_STATE_TRANSITION)
    const lateApprove = await postDecision(approval.approvalId, 'approve');
    expect(lateApprove.status).toBe(409);
    expect(lateApprove.body).toMatchObject({
      error: { code: 'INVALID_STATE_TRANSITION' },
    });

    // Task cannot resume or be claimed by Worker
    await syncClock();
    expect(await queue.claimNext(WORKER_ID, clock.now())).toBeNull();
    expect((await readTask(db.pool, tenantA.tenantId, taskId)).status).toBe('cancelled');

    // Event sequence contains terminal cancelled event
    const events = await listEventSnapshots(db.pool, tenantA.tenantId, taskId);
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.phase).toBe('cancelled');
    expect(lastEvent?.payload).toMatchObject({
      fromStatus: 'waiting_approval',
      toStatus: 'cancelled',
      cancelRequested: true,
    });
  });

  it('16b. Cancel vs Approve decision concurrency race: serializes cleanly under Task row lock without state drift', async () => {
    // Subcase 1: Cancel wins Task row lock first -> Cancel commits, Task becomes cancelled, Approval expires.
    // Concurrent Approve waits on lock, wakes up, sees Task is cancelled, and is rejected with 409.
    const { taskId: task1, approval: approval1 } = await createAndPauseForApproval(
      'race-cancel-before-approve',
    );

    const lock1 = await holdTaskRowLock(db.pool, tenantA.tenantId, task1);
    const cancelPromise1 = postCancel(task1);
    let approvePromise1: ReturnType<typeof postDecision> | undefined;
    try {
      await waitForTaskLockWaiter(db.pool, lock1.blocker);
      // Queue Approve behind Cancel and verify BOTH requests are blocked before release.
      approvePromise1 = postDecision(approval1.approvalId, 'approve');
      await waitForTwoTaskLockWaiters(db.pool, lock1.blocker);
    } finally {
      await lock1.release();
    }

    expect(approvePromise1).toBeDefined();
    const [cancelRes1, approveRes1] = await Promise.all([cancelPromise1, approvePromise1]);
    expect(cancelRes1.status).toBe(200);
    expect(cancelRes1.body.status).toBe('cancelled');
    expect(approveRes1.status).toBe(409);
    expect(approveRes1.body).toMatchObject({
      error: { code: 'INVALID_STATE_TRANSITION' },
    });

    expect((await readTask(db.pool, tenantA.tenantId, task1)).status).toBe('cancelled');
    expect((await approvals.get(ctxA, approval1.approvalId))?.status).toBe('expired');

    // Subcase 2: Approve wins Task row lock first -> Approve commits, Task transitions to queued, Approval is approved.
    // Subsequent Cancel observes Task in queued state and cancels it to cancelled (200 OK, terminal=true).
    const { taskId: task2, approval: approval2 } = await createAndPauseForApproval(
      'race-approve-before-cancel',
    );

    const lock2 = await holdTaskRowLock(db.pool, tenantA.tenantId, task2);
    const approvePromise2 = postDecision(approval2.approvalId, 'approve');
    let cancelPromise2: ReturnType<typeof postCancel> | undefined;
    try {
      // Approve joins the lock queue first.
      await waitForTaskLockWaiter(db.pool, lock2.blocker);
      // Cancel must also be queued BEFORE the row lock is released: a true race.
      cancelPromise2 = postCancel(task2);
      await waitForTwoTaskLockWaiters(db.pool, lock2.blocker);
    } finally {
      await lock2.release();
    }

    expect(cancelPromise2).toBeDefined();
    const [approveRes2, cancelRes2] = await Promise.all([approvePromise2, cancelPromise2]);
    expect(approveRes2.status).toBe(200);
    expect(approveRes2.body).toMatchObject({
      approval_id: approval2.approvalId,
      status: 'approved',
      task_status: 'queued',
    });
    expect((await approvals.get(ctxA, approval2.approvalId))?.status).toBe('approved');

    // Already in flight before lock release, Cancel observes the queued state and cancels it.
    expect(cancelRes2.status).toBe(200);
    expect(cancelRes2.body.status).toBe('cancelled');
    expect(cancelRes2.body.terminal).toBe(true);

    const task2After = await readTask(db.pool, tenantA.tenantId, task2);
    expect(task2After.status).toBe('cancelled');

    // Worker can NEVER claim the cancelled task
    await syncClock();
    expect(await queue.claimNext(WORKER_ID, clock.now())).toBeNull();
  });

  it('16c. requestCancel() and cancel() share identical transactional semantics, expiring Approvals and sweeping budget', async () => {
    const { taskId, approval } = await createAndPauseForApproval('request-cancel-parity');

    // Invoke requestCancel() directly (satisfies @ember/contracts contract)
    await tasks.requestCancel(ctxA, taskId);

    const taskRow = await readTask(db.pool, tenantA.tenantId, taskId);
    expect(taskRow.status).toBe('cancelled');
    expect(taskRow.cancel_requested_at).not.toBeNull();

    const approvalRow = await approvals.get(ctxA, approval.approvalId);
    expect(approvalRow?.status).toBe('expired');
    expect(approvalRow?.decidedAt).not.toBeNull();

    // Repeated call to cancel() HTTP API returns 200 OK with no-op idempotency
    const repeatCancel = await postCancel(taskId);
    expect(repeatCancel.status).toBe(200);
    expect(repeatCancel.body.status).toBe('cancelled');
    expect(repeatCancel.body.terminal).toBe(true);
  });
});
