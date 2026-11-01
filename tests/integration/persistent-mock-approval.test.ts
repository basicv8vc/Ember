import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  CommitReceipt,
  CommitStepRequest,
  RunGrant,
  RunResultCommitter,
} from '@ember/contracts';
import type { AuthContext } from '@ember/domain';
import {
  createDefaultSentinelPolicy,
  DeterministicExecutionRouter,
  DeterministicExecutor,
  computeApprovalActionDigest,
  type BudgetPolicy,
  type FakeSandboxProvider,
} from '@ember/execution';
import {
  PostgresAgentRepository,
  PostgresApprovalRepository,
  PostgresBudgetLedger,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
} from '@ember/postgres';
import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import {
  createDurableRunHandler,
  DURABLE_TASK_KINDS,
  type DurableRunHandlerDependencies,
} from '../../apps/worker/src/durable-run-handler.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { approvalCommand, createTenantFixture, type TenantFixture } from './support/fixtures.js';
import {
  ManualClock,
  databaseNow,
  listEventSnapshots,
  readRun,
  readTask,
} from './support/leases.js';
import { createP06Infra, type P06Infra } from './support/p0b06.js';

/**
 * P0B-08d Persistent Mock Approval integration suite (real PostgreSQL).
 *
 * Covers the full closed loop:
 *   queued → running (produce in FakeSandbox → stop/destroy → commit Artifact + Checkpoint +
 *   pending Approval) → waiting_approval → (approve → queued → running → completed |
 *   deny → failed | expire → failed | cancel → cancelled).
 */

const WORKER_ID = 'worker-p0b08d-approval';
const LEASE_MS = 5_000;
const APPROVAL_TTL_MS = 60_000;

const TOKEN_A = `dev-token-a-${randomUUID()}`;
const TOKEN_B = `dev-token-b-${randomUUID()}`;

const PERMISSIVE_BUDGET: BudgetPolicy = Object.freeze({
  policyId: 'p0b08d-approval-permissive',
  policyVersion: 1,
  maxRunSteps: 1_000,
  maxRunUnits: 1_000_000,
  maxRunElapsedMs: 10_000_000,
  maxTenantDailyUnits: 1_000_000,
  maxConcurrentSlots: 64,
});

const logger = createWorkerLogger({ level: 'error', sink: () => undefined });

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let approvals: PostgresApprovalRepository;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let ctxA: AuthContext;
let ctxB: AuthContext;
let agentIdA: string;
let clock: ManualClock;
let queue: PostgresLeaseQueue;
let reader: PostgresRunExecutionContextReader;
let infra: P06Infra;
let app: ReturnType<typeof createApp>;

async function syncClock(): Promise<void> {
  clock.set(new Date((await databaseNow(db.pool)).getTime() + 1));
}

function buildHandler(
  overrides: Partial<DurableRunHandlerDependencies> & {
    readonly onSandboxProvider?: (provider: FakeSandboxProvider) => void;
    readonly onProduceExecute?: () => void;
  } = {},
) {
  const innerExecutor = new DeterministicExecutor({
    sandboxExecDurationMs: 1,
    ...(overrides.onSandboxProvider === undefined
      ? {}
      : { onSandboxProvider: overrides.onSandboxProvider }),
  });

  const executor = {
    execute: (
      execCtx: Parameters<typeof innerExecutor.execute>[0],
      route: Parameters<typeof innerExecutor.execute>[1],
      signal: Parameters<typeof innerExecutor.execute>[2],
    ) => innerExecutor.execute(execCtx, route, signal),
    executeApproval: (
      execCtx: Parameters<typeof innerExecutor.executeApproval>[0],
      route: Parameters<typeof innerExecutor.executeApproval>[1],
      signal: Parameters<typeof innerExecutor.executeApproval>[2],
    ) => {
      overrides.onProduceExecute?.();
      return innerExecutor.executeApproval(execCtx, route, signal);
    },
  };

  const handler = createDurableRunHandler({
    contextReader: reader,
    router: new DeterministicExecutionRouter(),
    executor,
    blobs: infra.blobs,
    checkpoints: infra.checkpoints,
    committer: infra.committer,
    workspaces: infra.workspaces,
    budget: new PostgresBudgetLedger(db.pool, { policy: PERMISSIVE_BUDGET }),
    approvals,
    approvalTtlMs: APPROVAL_TTL_MS,
    clock,
    logger,
    sentinelPolicy: (context) =>
      createDefaultSentinelPolicy({
        tenantId: context.tenantId,
        policyVersion: context.policyVersion,
        allowMockWrite: true,
      }),
    ...overrides,
  });

  return (
    leasedRun: Parameters<typeof handler.handle>[0],
    signal: Parameters<typeof handler.handle>[1],
  ) => handler.handle(leasedRun, signal);
}

async function createAndPauseForApproval(
  keySuffix: string,
  options: {
    readonly action?: string;
    readonly reason?: string;
    readonly deadlineAt?: string;
    readonly handlerOverrides?: Parameters<typeof buildHandler>[0];
  } = {},
) {
  const receipt = await tasks.create(
    ctxA,
    approvalCommand(
      agentIdA,
      `p0b08d-${keySuffix}-${randomUUID()}`,
      options.action ?? `deploy:${keySuffix}`,
      options.reason ?? `reason for ${keySuffix}`,
      options.deadlineAt,
    ),
  );
  await syncClock();

  const lease1 = await queue.claimNext(WORKER_ID, clock.now());
  expect(lease1?.taskId).toBe(receipt.taskId);

  const handler = buildHandler(options.handlerOverrides);
  const outcome1 = await handler(lease1!, new AbortController().signal);
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

async function postDecision(
  approvalId: string,
  decision: string,
  token: string | null = TOKEN_A,
  extraBody: Record<string, unknown> = {},
): Promise<Response> {
  return await app.request(`/v1/approvals/${approvalId}/decision`, {
    method: 'POST',
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ decision, ...extraBody }),
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  clock = new ManualClock(new Date('2026-10-30T00:00:00.000Z'));
  approvals = new PostgresApprovalRepository(db.pool, { clock });
  tenantA = await createTenantFixture(db.pool, 'P0B-08d Tenant A');
  tenantB = await createTenantFixture(db.pool, 'P0B-08d Tenant B');
  ctxA = { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 };
  ctxB = { tenantId: tenantB.tenantId, principalId: tenantB.principalId, policyVersion: 1 };
  agentIdA = (await agents.create(ctxA, { name: 'p0b08d approval agent' })).agentId;

  queue = new PostgresLeaseQueue(db.pool, {
    leaseDurationMs: LEASE_MS,
    heartbeatIntervalMs: 500,
    baseDelayMs: 100,
    capDelayMs: 100,
    reaperBatchSize: 10,
    claimableKinds: DURABLE_TASK_KINDS,
    clock,
  });
  reader = new PostgresRunExecutionContextReader(db.pool, clock);
  infra = await createP06Infra(db);

  app = createApp({
    authenticator: createDevTokenAuthenticator([
      {
        token: TOKEN_A,
        tenantId: tenantA.tenantId,
        principalId: tenantA.principalId,
        policyVersion: 1,
      },
      {
        token: TOKEN_B,
        tenantId: tenantB.tenantId,
        principalId: tenantB.principalId,
        policyVersion: 1,
      },
    ]),
    taskStore: tasks,
    approvalStore: approvals,
  });
}, 30_000);

afterAll(async () => {
  await infra?.dispose();
  await db?.close();
});

beforeEach(async () => {
  await db.pool.query(
    `UPDATE tasks SET next_run_at = now() + interval '1 day'
      WHERE status IN ('queued', 'retryable_failed')`,
  );
});

describe('P0B-08d Persistent Mock Approval — lifecycle, sandbox release & persistence (1-5, 18, 19)', () => {
  it('1-4, 18, 19: enters waiting_approval, persists pending Approval, destroys FakeSandbox, resumes on approve with new Run/epoch from checkpoint without double-charging budget or workspace', async () => {
    const observedProviders: FakeSandboxProvider[] = [];
    let produceExecutions = 0;

    const { taskId, lease1, approval } = await createAndPauseForApproval('happy-approve', {
      action: 'deploy:prod-eu',
      reason: 'canary green',
      handlerOverrides: {
        onSandboxProvider: (provider: FakeSandboxProvider) => observedProviders.push(provider),
        onProduceExecute: () => {
          produceExecutions += 1;
        },
      },
    });

    // (1) Task is in waiting_approval and Run #1 released its lease cleanly.
    const pausedTask = await readTask(db.pool, tenantA.tenantId, taskId);
    const run1 = await readRun(db.pool, tenantA.tenantId, taskId, lease1.runId);
    expect(pausedTask.status).toBe('waiting_approval');
    expect(pausedTask.lease_expires_at).toBeNull();
    expect(run1?.status).toBe('succeeded');
    expect(run1?.leased_until).toBeNull();

    // (2) Approval is durably persisted with pending status and action digest.
    expect(approval.status).toBe('pending');
    expect(approval.taskId).toBe(taskId);
    expect(approval.runId).toBe(lease1.runId);
    expect(approval.leaseEpoch).toBe(1);
    expect(approval.decidedAt).toBeNull();
    expect(approval.actionDigest).toBe(
      computeApprovalActionDigest({ action: 'deploy:prod-eu', reason: 'canary green' }),
    );

    const getRes = await app.request(`/v1/approvals/${approval.approvalId}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(getRes.status).toBe(200);
    await expect(getRes.json()).resolves.toMatchObject({
      approval_id: approval.approvalId,
      task_id: taskId,
      run_id: lease1.runId,
      lease_epoch: 1,
      action_digest: approval.actionDigest,
      status: 'pending',
      decided_at: null,
    });

    // (3) FakeSandbox was stopped and destroyed before entering waiting_approval.
    expect(observedProviders).toHaveLength(1);
    expect(observedProviders[0]!.liveSandboxCount()).toBe(0);

    // WaitingApproval task cannot be claimed while still waiting.
    await syncClock();
    expect(await queue.claimNext(WORKER_ID, clock.now())).toBeNull();

    // (4) Approve via HTTP API -> transitions Approval to approved and Task to queued.
    const approveRes = await postDecision(approval.approvalId, 'approve');
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as {
      approval_id: string;
      task_id: string;
      status: string;
      task_status: string;
      decided_at: string;
      replayed: boolean;
    };
    expect(approveBody).toMatchObject({
      approval_id: approval.approvalId,
      task_id: taskId,
      status: 'approved',
      task_status: 'queued',
      replayed: false,
    });

    // Worker claims via normal LeaseQueue with a new Run identity and incremented Lease Epoch.
    await syncClock();
    const lease2 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease2).not.toBeNull();
    expect(lease2!.taskId).toBe(taskId);
    expect(lease2!.runId).not.toBe(lease1.runId);
    expect(lease2!.attempt).toBe(2);
    expect(lease2!.leaseEpoch).toBe(2);

    const resumeHandler = buildHandler({
      onSandboxProvider: (provider: FakeSandboxProvider) => observedProviders.push(provider),
      onProduceExecute: () => {
        produceExecutions += 1;
      },
    });
    const outcome2 = await resumeHandler(lease2!, new AbortController().signal);
    expect(outcome2.type).toBe('committed');

    // Produce step was NOT re-executed and no second sandbox session was created.
    expect(produceExecutions).toBe(1);
    expect(observedProviders).toHaveLength(1);

    const finalTask = await readTask(db.pool, tenantA.tenantId, taskId);
    const run2 = await readRun(db.pool, tenantA.tenantId, taskId, lease2!.runId);
    expect(finalTask.status).toBe('completed');
    expect(run2?.status).toBe('succeeded');

    // (18) Checkpoints and Workspace committed once without duplication.
    const checkpoints = await db.pool.query<{ step_id: string; step_sequence: number }>(
      `SELECT step_id, step_sequence FROM step_checkpoints
        WHERE tenant_id = $1 AND task_id = $2 ORDER BY step_sequence ASC`,
      [tenantA.tenantId, taskId],
    );
    expect(checkpoints.rows).toEqual([
      { step_id: 'produce', step_sequence: 1 },
      { step_id: 'publish', step_sequence: 2 },
    ]);

    const workspace = await infra.workspaces.loadForRun(tenantA.tenantId, agentIdA);
    expect(workspace.version).toBe(1);
    expect(
      workspace.manifest.files.some((entry) => entry.path === `approval/${taskId}.sha256`),
    ).toBe(true);

    const artifacts = await db.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM artifacts WHERE tenant_id = $1 AND task_id = $2`,
      [tenantA.tenantId, taskId],
    );
    expect(Number(artifacts.rows[0]?.count)).toBe(1);

    // (19) Budget charged exactly once for produce (5 units) and once for publish (1 unit).
    const budgetOps = await db.pool.query<{
      operation_id: string;
      state: string;
      consumed_steps: number;
      consumed_units: string;
    }>(
      `SELECT operation_id, state, consumed_steps, consumed_units::text AS consumed_units
         FROM budget_operations
        WHERE tenant_id = $1 AND task_id = $2
        ORDER BY created_at ASC`,
      [tenantA.tenantId, taskId],
    );
    expect(budgetOps.rows).toHaveLength(2);
    expect(
      budgetOps.rows.map((row) => ({ state: row.state, units: Number(row.consumed_units) })),
    ).toEqual([
      { state: 'settled', units: 5 },
      { state: 'settled', units: 1 },
    ]);

    const taskBudget = await db.pool.query<{
      consumed_steps: string;
      consumed_units: string;
      reserved_slots: string;
    }>(
      `SELECT SUM(consumed_steps)::text AS consumed_steps,
              SUM(consumed_units)::text AS consumed_units,
              SUM(CASE WHEN state = 'reserved' THEN reserved_slots ELSE 0 END)::text AS reserved_slots
         FROM budget_operations
        WHERE tenant_id = $1 AND task_id = $2`,
      [tenantA.tenantId, taskId],
    );
    expect(taskBudget.rows[0]).toEqual({
      consumed_steps: '2',
      consumed_units: '6',
      reserved_slots: '0',
    });
  });

  it('2b: database trigger enforces one-way approval transitions and immutable identity columns', async () => {
    const { approval } = await createAndPauseForApproval('db-trigger-guard');
    await postDecision(approval.approvalId, 'approve');

    await expect(
      db.pool.query(`UPDATE approvals SET status = 'denied' WHERE id = $1`, [approval.approvalId]),
    ).rejects.toThrow(/terminal approval status approved cannot be overwritten by denied/);

    await expect(
      db.pool.query(`UPDATE approvals SET action_digest = $2 WHERE id = $1`, [
        approval.approvalId,
        'f'.repeat(64),
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('5: denies a pending Approval, converges Task to failed (POLICY_DENIED), and never executes publish', async () => {
    const { taskId, approval } = await createAndPauseForApproval('deny-flow');

    const denyRes = await postDecision(approval.approvalId, 'deny');
    expect(denyRes.status).toBe(200);
    await expect(denyRes.json()).resolves.toMatchObject({
      approval_id: approval.approvalId,
      task_id: taskId,
      status: 'denied',
      task_status: 'failed',
      replayed: false,
    });

    const finalTask = await readTask(db.pool, tenantA.tenantId, taskId);
    expect(finalTask.status).toBe('failed');

    const updatedApproval = await approvals.get(ctxA, approval.approvalId);
    expect(updatedApproval?.status).toBe('denied');
    expect(updatedApproval?.decidedAt).not.toBeNull();

    // Cannot be claimed by a worker after denial.
    await syncClock();
    expect(await queue.claimNext(WORKER_ID, clock.now())).toBeNull();

    // Only the pre-approval produce checkpoint exists; publish never ran.
    const checkpoints = await db.pool.query<{ step_id: string }>(
      `SELECT step_id FROM step_checkpoints
        WHERE tenant_id = $1 AND task_id = $2 ORDER BY step_sequence ASC`,
      [tenantA.tenantId, taskId],
    );
    expect(checkpoints.rows.map((cp) => cp.step_id)).toEqual(['produce']);

    const events = await listEventSnapshots(db.pool, tenantA.tenantId, taskId);
    expect(events.map((e) => e.phase)).toEqual([
      'accepted',
      'leased',
      'started',
      'waiting_approval',
      'approval_denied',
      'failed',
    ]);
    expect(events[events.length - 1]?.payload).toMatchObject({
      fromStatus: 'waiting_approval',
      toStatus: 'failed',
      errorCode: 'POLICY_DENIED',
    });
  });
});

describe('P0B-08d Persistent Mock Approval — expiry, idempotency, concurrency & auth (6-12)', () => {
  it('6a: expires pending Approval via background Reaper (reapExpired) without user click', async () => {
    const { taskId, approval } = await createAndPauseForApproval('reaper-expiry');

    // Advance clock past the approval TTL.
    clock.set(new Date(new Date(approval.expiresAt).getTime() + 1_000));

    const reaped = await queue.reapExpired(clock.now());
    expect(reaped).toBeGreaterThanOrEqual(1);

    const expiredApproval = await approvals.get(ctxA, approval.approvalId);
    expect(expiredApproval?.status).toBe('expired');
    expect(expiredApproval?.decidedAt).not.toBeNull();

    const failedTask = await readTask(db.pool, tenantA.tenantId, taskId);
    expect(failedTask.status).toBe('failed');

    const events = await listEventSnapshots(db.pool, tenantA.tenantId, taskId);
    expect(events[events.length - 1]).toMatchObject({
      phase: 'failed',
      payload: {
        fromStatus: 'waiting_approval',
        toStatus: 'failed',
        errorCode: 'EXECUTION_TIMEOUT',
      },
    });

    // Late approval after Reaper expiry is rejected with 409.
    const lateApprove = await postDecision(approval.approvalId, 'approve');
    expect(lateApprove.status).toBe(409);
    await expect(lateApprove.json()).resolves.toMatchObject({
      error: { code: 'INVALID_STATE_TRANSITION' },
    });
  });

  it('6b: expires pending Approval on-demand and persists convergence if decision arrives after expires_at before Reaper runs', async () => {
    const { taskId, approval } = await createAndPauseForApproval('ondemand-expiry');

    clock.set(new Date(new Date(approval.expiresAt).getTime() + 500));

    const lateRes = await postDecision(approval.approvalId, 'approve');
    expect(lateRes.status).toBe(409);
    await expect(lateRes.json()).resolves.toMatchObject({
      error: { code: 'INVALID_STATE_TRANSITION' },
    });

    // Even though HTTP returned 409, the transaction committed pending → expired and waiting_approval → failed.
    const persistedApproval = await approvals.get(ctxA, approval.approvalId);
    const persistedTask = await readTask(db.pool, tenantA.tenantId, taskId);
    expect(persistedApproval?.status).toBe('expired');
    expect(persistedTask.status).toBe('failed');
  });

  it('7, 8, 9: enforces idempotent repeat approve (even after Task completion) and 409 on conflicting decisions', async () => {
    const { taskId, approval } = await createAndPauseForApproval('idempotent-approve');

    const first = await postDecision(approval.approvalId, 'approve');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { decided_at: string; replayed: boolean };
    expect(firstBody.replayed).toBe(false);

    // (7) Repeat approve while queued -> 200 replayed: true
    const second = await postDecision(approval.approvalId, 'approve');
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      approval_id: approval.approvalId,
      task_id: taskId,
      status: 'approved',
      task_status: 'queued',
      decided_at: firstBody.decided_at,
      replayed: true,
    });

    // (8) Approve followed by deny -> 409 IDEMPOTENCY_CONFLICT
    const conflictDeny = await postDecision(approval.approvalId, 'deny');
    expect(conflictDeny.status).toBe(409);
    await expect(conflictDeny.json()).resolves.toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });

    // Complete the approved Task and verify a late repeat approve does NOT re-queue the completed Task!
    await syncClock();
    const lease2 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease2?.taskId).toBe(taskId);
    await buildHandler()(lease2!, new AbortController().signal);
    expect((await readTask(db.pool, tenantA.tenantId, taskId)).status).toBe('completed');

    const thirdAfterCompletion = await postDecision(approval.approvalId, 'approve');
    expect(thirdAfterCompletion.status).toBe(200);
    await expect(thirdAfterCompletion.json()).resolves.toMatchObject({
      approval_id: approval.approvalId,
      task_id: taskId,
      status: 'approved',
      task_status: 'completed',
      decided_at: firstBody.decided_at,
      replayed: true,
    });
    expect((await readTask(db.pool, tenantA.tenantId, taskId)).status).toBe('completed');

    // (9) Deny followed by approve -> 409 IDEMPOTENCY_CONFLICT
    const { taskId: deniedTaskId, approval: deniedApproval } =
      await createAndPauseForApproval('deny-then-approve');
    const denyFirst = await postDecision(deniedApproval.approvalId, 'deny');
    expect(denyFirst.status).toBe(200);

    const conflictApprove = await postDecision(deniedApproval.approvalId, 'approve');
    expect(conflictApprove.status).toBe(409);
    await expect(conflictApprove.json()).resolves.toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect((await readTask(db.pool, tenantA.tenantId, deniedTaskId)).status).toBe('failed');
  });

  it('10: serializes concurrent decisions on the same Approval (same decision & conflicting decisions)', async () => {
    // 10a: Two concurrent `approve` requests -> both 200, exactly one `replayed: false` and one `replayed: true`.
    const { taskId: taskSame, approval: approvalSame } =
      await createAndPauseForApproval('concurrent-same');

    const [res1, res2] = await Promise.all([
      postDecision(approvalSame.approvalId, 'approve'),
      postDecision(approvalSame.approvalId, 'approve'),
    ]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const body1 = (await res1.json()) as { replayed: boolean };
    const body2 = (await res2.json()) as { replayed: boolean };
    expect([body1.replayed, body2.replayed].sort()).toEqual([false, true]);

    const eventsSame = await listEventSnapshots(db.pool, tenantA.tenantId, taskSame);
    expect(eventsSame.filter((e) => e.phase === 'approval_granted')).toHaveLength(1);

    // Clear the queued task from the queue so it doesn't interfere with later claims.
    await tasks.requestCancel(ctxA, taskSame);

    // 10b: Concurrent `approve` vs `deny` -> one 200 and one 409 IDEMPOTENCY_CONFLICT.
    const { taskId: taskRace, approval: approvalRace } =
      await createAndPauseForApproval('concurrent-conflict');

    const [raceApprove, raceDeny] = await Promise.all([
      postDecision(approvalRace.approvalId, 'approve'),
      postDecision(approvalRace.approvalId, 'deny'),
    ]);
    expect([raceApprove.status, raceDeny.status].sort()).toEqual([200, 409]);

    const persistedApproval = await approvals.get(ctxA, approvalRace.approvalId);
    const persistedTask = await readTask(db.pool, tenantA.tenantId, taskRace);
    if (raceApprove.status === 200) {
      expect(persistedApproval?.status).toBe('approved');
      expect(persistedTask.status).toBe('queued');
      await tasks.requestCancel(ctxA, taskRace);
    } else {
      expect(persistedApproval?.status).toBe('denied');
      expect(persistedTask.status).toBe('failed');
    }
  });

  it('11, 12: enforces Tenant isolation (404 for Tenant B) and Dev Token Authentication (401 for invalid token)', async () => {
    const { approval } = await createAndPauseForApproval('tenant-auth-isolation');

    // (12) Invalid / missing token -> 401 UNAUTHENTICATED
    const noToken = await postDecision(approval.approvalId, 'approve', null);
    expect(noToken.status).toBe(401);
    const badToken = await postDecision(approval.approvalId, 'approve', 'forged-token');
    expect(badToken.status).toBe(401);

    // Forged tenant_id in body is rejected by strict schema with 400 INVALID_ARGUMENT
    const forgedTenantBody = await postDecision(approval.approvalId, 'approve', TOKEN_B, {
      tenant_id: tenantA.tenantId,
    });
    expect(forgedTenantBody.status).toBe(400);

    // (11) Tenant B gets the exact same 404 shape as a non-existent approval ID
    await expect(approvals.get(ctxB, approval.approvalId)).resolves.toBeNull();
    await expect(approvals.decide(ctxB, approval.approvalId, 'approve')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const foreignDecision = await postDecision(approval.approvalId, 'approve', TOKEN_B);
    const missingDecision = await postDecision(randomUUID(), 'approve', TOKEN_A);
    expect(foreignDecision.status).toBe(404);
    expect(missingDecision.status).toBe(404);
    const foreignErr = (await foreignDecision.json()) as {
      error: { code: string; message: string };
    };
    const missingErr = (await missingDecision.json()) as {
      error: { code: string; message: string };
    };
    expect(foreignErr.error.code).toBe('NOT_FOUND');
    expect(foreignErr.error.message).toBe(missingErr.error.message);

    // Tenant A's approval is still untouched and pending
    expect((await approvals.get(ctxA, approval.approvalId))?.status).toBe('pending');
    await postDecision(approval.approvalId, 'deny', TOKEN_A);
  });
});

describe('P0B-08d Persistent Mock Approval — worker crash/recovery, fencing & cancellation/deadline races (13-17, 20)', () => {
  it('13: recovers cleanly when Worker crashes after generating Approval without creating duplicate Approvals', async () => {
    // Fault-injecting committer that commits the produce+approval transaction in Postgres
    // and then throws (simulating a worker crash / lost ACK right after generating the Approval).
    let crashedAfterApproval = false;
    const crashAfterApprovalCommitter: RunResultCommitter = {
      commitStep: async (grant: RunGrant, request: CommitStepRequest): Promise<CommitReceipt> => {
        const receipt = await infra.committer.commitStep(grant, request);
        if (request.approval !== undefined && !crashedAfterApproval) {
          crashedAfterApproval = true;
          throw new Error('simulated worker crash immediately after approval commit');
        }
        return receipt;
      },
      findReceipt: (grant: RunGrant, operationId: string) =>
        infra.committer.findReceipt(grant, operationId),
    };

    const receipt = await tasks.create(
      ctxA,
      approvalCommand(agentIdA, `p0b08d-crash-gen-${randomUUID()}`, 'deploy:crash-gen', 'test 13'),
    );
    await syncClock();
    const lease1 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease1?.taskId).toBe(receipt.taskId);

    const crashingHandler = buildHandler({ committer: crashAfterApprovalCommitter });
    const crashOutcome = await crashingHandler(lease1!, new AbortController().signal);
    expect(crashOutcome).toEqual({ type: 'finish', outcome: 'failed_retryable' });
    // Even if a confused caller calls queue.finish after the atomic pause commit already
    // transitioned the Task to waiting_approval, queue.finish refuses to overwrite waiting_approval.
    await expect(queue.finish(lease1!, 'failed_retryable')).resolves.toBe(false);

    // Despite the crash, the atomic commit placed the Task into waiting_approval with 1 Approval.
    const taskAfterCrash = await readTask(db.pool, tenantA.tenantId, receipt.taskId);
    expect(taskAfterCrash.status).toBe('waiting_approval');

    const approvalsAfterCrash = await approvals.listByTask(ctxA, receipt.taskId);
    expect(approvalsAfterCrash).toHaveLength(1);
    const approval = approvalsAfterCrash[0]!;
    expect(approval.status).toBe('pending');

    // Approve -> Worker claims Run #2 -> sweeps the dangling produce reservation and completes cleanly!
    const approveRes = await postDecision(approval.approvalId, 'approve');
    expect(approveRes.status).toBe(200);

    await syncClock();
    const lease2 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease2?.taskId).toBe(receipt.taskId);
    expect(lease2?.attempt).toBe(2);

    const outcome2 = await buildHandler()(lease2!, new AbortController().signal);
    expect(outcome2.type).toBe('committed');

    expect((await readTask(db.pool, tenantA.tenantId, receipt.taskId)).status).toBe('completed');
    expect(await approvals.listByTask(ctxA, receipt.taskId)).toHaveLength(1);
  });

  it('13b: recovers when Worker crashes after produce checkpoint before approval pause (reuses produce checkpoint to enter waiting_approval)', async () => {
    const receipt = await tasks.create(
      ctxA,
      approvalCommand(
        agentIdA,
        `p0b08d-crash-pre-pause-${randomUUID()}`,
        'deploy:pre-pause',
        'test 13b',
      ),
    );
    await syncClock();
    const lease1 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease1?.taskId).toBe(receipt.taskId);

    // Commit ONLY the produce step (without approval) on Run #1, simulating an interrupted step split.
    let strippedOnce = false;
    const stripApprovalOnceCommitter: RunResultCommitter = {
      commitStep: async (grant: RunGrant, request: CommitStepRequest): Promise<CommitReceipt> => {
        if (request.approval !== undefined && !strippedOnce) {
          strippedOnce = true;
          const { approval: _omitted, ...withoutApproval } = request;
          await infra.committer.commitStep(grant, withoutApproval);
          throw new Error('simulated crash after produce checkpoint before approval row');
        }
        return infra.committer.commitStep(grant, request);
      },
      findReceipt: (grant: RunGrant, operationId: string) =>
        infra.committer.findReceipt(grant, operationId),
    };

    let produceCalls = 0;
    const outcome1 = await buildHandler({
      committer: stripApprovalOnceCommitter,
      onProduceExecute: () => {
        produceCalls += 1;
      },
    })(lease1!, new AbortController().signal);
    expect(outcome1).toEqual({ type: 'finish', outcome: 'failed_retryable' });
    expect(produceCalls).toBe(1);

    // Lease #1 expires -> Reaper schedules retry -> Run #2 claims -> sees produce checkpoint,
    // creates the missing pending Approval without re-running produce, and enters waiting_approval!
    clock.advance(LEASE_MS + 1_000);
    expect(await queue.reapExpired(clock.now())).toBe(1);
    clock.advance(1_000);
    const lease2 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease2?.taskId).toBe(receipt.taskId);

    const outcome2 = await buildHandler({
      onProduceExecute: () => {
        produceCalls += 1;
      },
    })(lease2!, new AbortController().signal);
    expect(outcome2.type).toBe('committed');
    expect(produceCalls).toBe(1);
    expect((await readTask(db.pool, tenantA.tenantId, receipt.taskId)).status).toBe(
      'waiting_approval',
    );

    const createdApprovals = await approvals.listByTask(ctxA, receipt.taskId);
    expect(createdApprovals).toHaveLength(1);
    await postDecision(createdApprovals[0]!.approvalId, 'deny');
  });

  it('14, 15: recovers when post-approval Worker crashes before publish, and fences late submissions from old Lease Epochs', async () => {
    const { taskId, lease1, approval } = await createAndPauseForApproval('post-approve-crash');

    // (15a) Run #1's lease is already finished; a late commitStep or finish from lease1 is fenced with STALE_LEASE.
    await expect(
      infra.committer.commitStep(
        {
          tenantId: tenantA.tenantId,
          taskId,
          runId: lease1.runId,
          agentId: agentIdA,
          attempt: lease1.attempt,
          leaseEpoch: lease1.leaseEpoch,
          workerId: WORKER_ID,
        },
        { operationId: 'late-epoch-1', mode: 'progress' },
      ),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });
    await expect(queue.finish(lease1, 'succeeded')).resolves.toBe(false);

    // Approve and claim Run #2 (leaseEpoch = 2).
    await postDecision(approval.approvalId, 'approve');
    await syncClock();
    const lease2 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease2?.taskId).toBe(taskId);
    expect(lease2?.leaseEpoch).toBe(2);

    // Simulate Worker #2 crashing during `step:publish`.
    const crashOnPublishCommitter: RunResultCommitter = {
      commitStep: (grant: RunGrant, request: CommitStepRequest): Promise<CommitReceipt> => {
        if (request.operationId.startsWith('step:publish')) {
          return Promise.reject(new Error('simulated crash in post-approval publish step'));
        }
        return infra.committer.commitStep(grant, request);
      },
      findReceipt: (grant: RunGrant, operationId: string) =>
        infra.committer.findReceipt(grant, operationId),
    };

    const outcome2 = await buildHandler({ committer: crashOnPublishCommitter })(
      lease2!,
      new AbortController().signal,
    );
    expect(outcome2).toEqual({ type: 'finish', outcome: 'failed_retryable' });

    // Lease #2 expires -> Reaper transitions Run #2 to lease_expired and Task to retryable_failed.
    clock.advance(LEASE_MS + 1_000);
    expect(await queue.reapExpired(clock.now())).toBe(1);
    expect((await readTask(db.pool, tenantA.tenantId, taskId)).status).toBe('retryable_failed');

    // Advance past retry backoff -> Worker #3 claims Run #3 (leaseEpoch = 3).
    clock.advance(1_000);
    const lease3 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease3?.taskId).toBe(taskId);
    expect(lease3?.leaseEpoch).toBe(3);

    // (15b) Late submission from stale lease2 (epoch 2) is rejected with STALE_LEASE.
    await expect(
      infra.committer.commitStep(
        {
          tenantId: tenantA.tenantId,
          taskId,
          runId: lease2!.runId,
          agentId: agentIdA,
          attempt: lease2!.attempt,
          leaseEpoch: lease2!.leaseEpoch,
          workerId: WORKER_ID,
        },
        { operationId: 'late-epoch-2', mode: 'result' },
      ),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    // Worker #3 resumes from the committed produce checkpoint and completes the Task.
    let produceCountOnResume = 0;
    const outcome3 = await buildHandler({
      onProduceExecute: () => {
        produceCountOnResume += 1;
      },
    })(lease3!, new AbortController().signal);
    expect(outcome3.type).toBe('committed');
    expect(produceCountOnResume).toBe(0);
    expect((await readTask(db.pool, tenantA.tenantId, taskId)).status).toBe('completed');
  });

  it('16: handles Cancellation while in waiting_approval and concurrent Approval vs Cancel race without resurrecting a cancelled Task', async () => {
    // 16a: Cancel while waiting_approval -> Task becomes cancelled, Approval becomes expired.
    const { taskId: cancelTaskId, approval: cancelApproval } =
      await createAndPauseForApproval('cancel-while-waiting');

    await tasks.requestCancel(ctxA, cancelTaskId);
    expect((await readTask(db.pool, tenantA.tenantId, cancelTaskId)).status).toBe('cancelled');

    const expiredApproval = await approvals.get(ctxA, cancelApproval.approvalId);
    expect(expiredApproval?.status).toBe('expired');

    // Late approve after cancel returns 409 INVALID_STATE_TRANSITION.
    const approveAfterCancel = await postDecision(cancelApproval.approvalId, 'approve');
    expect(approveAfterCancel.status).toBe(409);
    await expect(approveAfterCancel.json()).resolves.toMatchObject({
      error: { code: 'INVALID_STATE_TRANSITION' },
    });

    await syncClock();
    expect(await queue.claimNext(WORKER_ID, clock.now())).toBeNull();

    // 16b: Concurrent `approve` vs `requestCancel` race.
    const { taskId: raceTaskId, approval: raceApproval } =
      await createAndPauseForApproval('approve-vs-cancel-race');

    const [approveSettled, cancelSettled] = await Promise.allSettled([
      approvals.decide(ctxA, raceApproval.approvalId, 'approve'),
      tasks.requestCancel(ctxA, raceTaskId),
    ]);

    expect(cancelSettled.status).toBe('fulfilled');
    if (approveSettled.status === 'rejected') {
      expect(approveSettled.reason).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    }

    // Regardless of which transaction acquired the task row lock first, the Task ends `cancelled`
    // and can NEVER be claimed by a Worker!
    const finalRaceTask = await readTask(db.pool, tenantA.tenantId, raceTaskId);
    expect(finalRaceTask.status).toBe('cancelled');

    await syncClock();
    expect(await queue.claimNext(WORKER_ID, clock.now())).toBeNull();
  });

  it('17: handles Approval vs Task Deadline competition (DEADLINE_EXCEEDED wins when deadline elapsed)', async () => {
    const baseNow = await databaseNow(db.pool);
    const shortDeadline = new Date(baseNow.getTime() + 10_000).toISOString();

    const { taskId, approval } = await createAndPauseForApproval('deadline-race', {
      deadlineAt: shortDeadline,
    });

    // Advance clock past the Task's deadline (10s) while Approval TTL (60s) has not yet elapsed.
    clock.set(new Date(baseNow.getTime() + 15_000));

    const res = await postDecision(approval.approvalId, 'approve');
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'INVALID_STATE_TRANSITION' },
    });

    const failedTask = await readTask(db.pool, tenantA.tenantId, taskId);
    const expiredApproval = await approvals.get(ctxA, approval.approvalId);
    expect(failedTask.status).toBe('failed');
    expect(expiredApproval?.status).toBe('expired');

    const events = await listEventSnapshots(db.pool, tenantA.tenantId, taskId);
    expect(events[events.length - 1]).toMatchObject({
      phase: 'failed',
      payload: {
        fromStatus: 'waiting_approval',
        toStatus: 'failed',
        errorCode: 'DEADLINE_EXCEEDED',
      },
    });
  });

  it('20: replays approval lifecycle events (waiting_approval, approval_granted, completed) over SSE /v1/tasks/:taskId/stream', async () => {
    const { taskId, approval } = await createAndPauseForApproval('sse-replay');

    const approveRes = await postDecision(approval.approvalId, 'approve');
    expect(approveRes.status).toBe(200);

    await syncClock();
    const lease2 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease2?.taskId).toBe(taskId);
    await buildHandler()(lease2!, new AbortController().signal);

    const streamRes = await app.request(`/v1/tasks/${taskId}/stream`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream');

    const bodyText = await streamRes.text();
    const dataFrames = bodyText
      .split('\n\n')
      .map((block) =>
        block
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice('data: '.length),
      )
      .filter((line): line is string => line !== undefined)
      .map((json) => JSON.parse(json) as { sequence: number; phase: string });

    expect(dataFrames.map((frame) => frame.phase)).toEqual([
      'accepted',
      'leased',
      'started',
      'waiting_approval',
      'approval_granted',
      'leased',
      'started',
      'completed',
    ]);

    // Cursor replay starting from the `waiting_approval` sequence (sequence 4):
    const waitingSeq = dataFrames.find((f) => f.phase === 'waiting_approval')!.sequence;
    const resumedStream = await app.request(`/v1/tasks/${taskId}/stream?after=${waitingSeq}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(resumedStream.status).toBe(200);
    const resumedText = await resumedStream.text();
    const resumedPhases = resumedText
      .split('\n\n')
      .map((block) =>
        block
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice('data: '.length),
      )
      .filter((line): line is string => line !== undefined)
      .map((json) => (JSON.parse(json) as { phase: string }).phase);

    expect(resumedPhases).toEqual(['approval_granted', 'leased', 'started', 'completed']);
  });

  it('P1-Discovery: completes full Task creation, pause, discovery via GET /v1/tasks/:taskId/approvals, and approval purely via HTTP', async () => {
    // 1. Create task purely via HTTP
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'idempotency-key': `p0b08d-pure-http-${randomUUID()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: agentIdA,
        kind: 'mock.approval',
        input: {
          action: 'deploy:pure-http',
          reason: 'testing pure http discovery and decision loop',
        },
      }),
    });
    expect(createRes.status).toBe(202);
    const { task_id: taskId } = (await createRes.json()) as { task_id: string };

    // Initially, no approvals exist yet
    const initialApprovalsRes = await app.request(`/v1/tasks/${taskId}/approvals`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(initialApprovalsRes.status).toBe(200);
    await expect(initialApprovalsRes.json()).resolves.toEqual({
      task_id: taskId,
      approvals: [],
    });

    // 2. Worker executes produce step and enters waiting_approval
    await syncClock();
    const lease1 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease1?.taskId).toBe(taskId);
    const handler = buildHandler();
    const outcome1 = await handler(lease1!, new AbortController().signal);
    expect(outcome1.type).toBe('committed');

    // 3. Client checks task status via HTTP
    const getTaskRes = await app.request(`/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(getTaskRes.status).toBe(200);
    const taskBody = (await getTaskRes.json()) as { status: string };
    expect(taskBody.status).toBe('waiting_approval');

    // 4. Client discovers approval ID via GET /v1/tasks/:taskId/approvals
    const discoveryRes = await app.request(`/v1/tasks/${taskId}/approvals`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(discoveryRes.status).toBe(200);
    const discoveryBody = (await discoveryRes.json()) as {
      task_id: string;
      approvals: Array<{ approval_id: string; status: string; action_digest: string }>;
    };
    expect(discoveryBody.task_id).toBe(taskId);
    expect(discoveryBody.approvals).toHaveLength(1);
    const discovered = discoveryBody.approvals[0]!;
    expect(discovered.status).toBe('pending');
    expect(discovered.approval_id).toBeDefined();

    // Tenant B cannot discover approvals for Tenant A's task
    const crossTenantRes = await app.request(`/v1/tasks/${taskId}/approvals`, {
      headers: { authorization: `Bearer ${TOKEN_B}` },
    });
    expect(crossTenantRes.status).toBe(404);

    // 5. Client approves via HTTP POST /v1/approvals/:approvalId/decision
    const decisionRes = await app.request(`/v1/approvals/${discovered.approval_id}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(decisionRes.status).toBe(200);
    const decisionBody = (await decisionRes.json()) as {
      approval_id: string;
      status: string;
      task_status: string;
    };
    expect(decisionBody.approval_id).toBe(discovered.approval_id);
    expect(decisionBody.status).toBe('approved');
    expect(decisionBody.task_status).toBe('queued');

    // 6. Worker resumes execution from checkpoint and completes
    await syncClock();
    const lease2 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease2?.taskId).toBe(taskId);
    expect(lease2?.leaseEpoch).toBe(2);
    const outcome2 = await handler(lease2!, new AbortController().signal);
    expect(outcome2.type).toBe('committed');

    // 7. Verify task reached succeeded and approval status is approved via HTTP
    const finalTaskRes = await app.request(`/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(finalTaskRes.status).toBe(200);
    const finalTaskBody = (await finalTaskRes.json()) as { status: string };
    expect(finalTaskBody.status).toBe('completed');

    const finalApprovalsRes = await app.request(`/v1/tasks/${taskId}/approvals`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(finalApprovalsRes.status).toBe(200);
    const finalApprovalsBody = (await finalApprovalsRes.json()) as {
      approvals: Array<{ status: string; decided_at: string | null }>;
    };
    expect(finalApprovalsBody.approvals[0]?.status).toBe('approved');
    expect(finalApprovalsBody.approvals[0]?.decided_at).not.toBeNull();
  });

  it('P1-FailClosed: fails closed when approvals dependency is missing from worker on mock.approval', async () => {
    const receipt = await tasks.create(
      ctxA,
      approvalCommand(
        agentIdA,
        `p0b08d-no-deps-${randomUUID()}`,
        'deploy:no-deps',
        'missing approval dependency',
      ),
    );
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease?.taskId).toBe(receipt.taskId);

    // Build handler explicitly without approvals dependency
    const handlerNoApprovals = buildHandler({ approvals: undefined });
    const outcome = await handlerNoApprovals(lease!, new AbortController().signal);
    expect(outcome).toEqual({ type: 'finish', outcome: 'failed_terminal' });
    if (outcome.type === 'finish') {
      await queue.finish(lease!, outcome.outcome);
    }

    const taskRow = await readTask(db.pool, tenantA.tenantId, receipt.taskId);
    expect(taskRow.status).toBe('failed');

    // Verify task never created approval or published to workspace
    const taskApprovals = await approvals.listByTask(ctxA, receipt.taskId);
    expect(taskApprovals).toHaveLength(0);
  });

  it('P1-FailClosed: fails closed when executor lacks executeApproval for mock.approval', async () => {
    const receipt = await tasks.create(
      ctxA,
      approvalCommand(
        agentIdA,
        `p0b08d-no-exec-${randomUUID()}`,
        'deploy:no-exec',
        'missing executeApproval method',
      ),
    );
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease?.taskId).toBe(receipt.taskId);

    // Build executor without executeApproval
    const baseExecutor = new DeterministicExecutor();
    const handlerNoExecuteApproval = buildHandler({
      executor: {
        execute: (c, r, s) => baseExecutor.execute(c, r, s),
      },
    });
    const outcome = await handlerNoExecuteApproval(lease!, new AbortController().signal);
    expect(outcome).toEqual({ type: 'finish', outcome: 'failed_terminal' });
    if (outcome.type === 'finish') {
      await queue.finish(lease!, outcome.outcome);
    }

    const taskRow = await readTask(db.pool, tenantA.tenantId, receipt.taskId);
    expect(taskRow.status).toBe('failed');
  });

  it('P1-FailClosed: fails closed on resume when checkpoint action digest does not match any approval record', async () => {
    const { taskId, approval } = await createAndPauseForApproval('mismatched-digest');

    // Delete the original approval record and insert one with a mismatched action_digest
    await db.pool.query('DELETE FROM approvals WHERE id = $1', [approval.approvalId]);
    const fakeDigest = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    await db.pool.query(
      `INSERT INTO approvals (
        id, tenant_id, task_id, run_id, lease_epoch, action_digest, status, expires_at, decided_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'approved', now() + interval '5 minutes', now(), now(), now())`,
      [
        approval.approvalId,
        tenantA.tenantId,
        taskId,
        approval.runId,
        approval.leaseEpoch,
        fakeDigest,
      ],
    );

    // Put task back into queued for resume
    await db.pool.query(`UPDATE tasks SET status = 'queued', next_run_at = now() WHERE id = $1`, [
      taskId,
    ]);

    await syncClock();
    const lease2 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease2?.taskId).toBe(taskId);

    const handler = buildHandler();
    const outcome = await handler(lease2!, new AbortController().signal);
    expect(outcome).toEqual({ type: 'finish', outcome: 'failed_terminal' });
    if (outcome.type === 'finish') {
      await queue.finish(lease2!, outcome.outcome);
    }

    const taskRow = await readTask(db.pool, tenantA.tenantId, taskId);
    expect(taskRow.status).toBe('failed');
  });

  it('P1-FailClosed: fails closed on resume when approval is not in approved status (e.g. pending or denied)', async () => {
    const { taskId } = await createAndPauseForApproval('non-approved-resume');

    // Force task status to queued while approval is still pending
    await db.pool.query(`UPDATE tasks SET status = 'queued', next_run_at = now() WHERE id = $1`, [
      taskId,
    ]);

    await syncClock();
    const lease2 = await queue.claimNext(WORKER_ID, clock.now());
    expect(lease2?.taskId).toBe(taskId);

    const handler = buildHandler();
    const outcome = await handler(lease2!, new AbortController().signal);
    expect(outcome).toEqual({ type: 'finish', outcome: 'failed_terminal' });
    if (outcome.type === 'finish') {
      await queue.finish(lease2!, outcome.outcome);
    }

    const taskRow = await readTask(db.pool, tenantA.tenantId, taskId);
    expect(taskRow.status).toBe('failed');
  });
});
