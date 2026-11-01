import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunExecutionContext, RunGrant } from '@ember/contracts';
import type { AuthContext, LeasedRun, TaskKind } from '@ember/domain';
import {
  createDefaultSentinelPolicy,
  DeterministicExecutionRouter,
  DeterministicExecutor,
  type BudgetPolicy,
  type SentinelPolicy,
  type SimulatedExecutor,
} from '@ember/execution';
import {
  CredentialBroker,
  InMemoryCredentialRegistry,
  SYNTHETIC_EGRESS_POLICY,
} from '@ember/credentials';
import {
  PostgresAgentRepository,
  PostgresApprovalRepository,
  PostgresBudgetLedger,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
} from '@ember/postgres';
import { createDurableRunHandler } from '../../apps/worker/src/durable-run-handler.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  chatCommand,
  computeCommand,
  createTenantFixture,
  type TenantFixture,
} from './support/fixtures.js';
import { ManualClock, databaseNow, readTask } from './support/leases.js';
import { createP06Infra, grantOfContext, type P06Infra } from './support/p0b06.js';

const WORKER_ID = 'worker-sentinel-admission-test';

const PERMISSIVE_BUDGET: BudgetPolicy = Object.freeze({
  policyId: 'p0c2b-budget-permissive',
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
let approvals: PostgresApprovalRepository;
let tenant: TenantFixture;
let ctx: AuthContext;
let agentId: string;
let clock: ManualClock;
let queue: PostgresLeaseQueue;
let reader: PostgresRunExecutionContextReader;
let infra: P06Infra;

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
  readonly grant: RunGrant;
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
  return { taskId, lease, context, grant: grantOfContext(context) };
}

interface BudgetOperationRow {
  operation_id: string;
  state: string;
  lease_epoch: string;
  reserved_units: string;
  consumed_units: string;
}

async function getBudgetOperations(
  runId: string,
  tenantId = tenant.tenantId,
): Promise<BudgetOperationRow[]> {
  const result = await db.observerPool.query<BudgetOperationRow>(
    `SELECT operation_id, state, lease_epoch::text AS lease_epoch,
            reserved_units::text AS reserved_units, consumed_units::text AS consumed_units
       FROM budget_operations
      WHERE tenant_id = $1 AND run_id = $2
      ORDER BY operation_id`,
    [tenantId, runId],
  );
  return result.rows;
}

function makeHandler(options: {
  readonly sentinelPolicy?:
    SentinelPolicy | ((context: RunExecutionContext) => SentinelPolicy | undefined);
  readonly omitSentinelPolicy?: boolean;
  readonly executor?: SimulatedExecutor;
  readonly reader?:
    | PostgresRunExecutionContextReader
    | { read: (run: LeasedRun, now: Date) => Promise<RunExecutionContext> };
  readonly credentialBroker?: CredentialBroker;
}) {
  return createDurableRunHandler({
    contextReader: options.reader ?? reader,
    router: new DeterministicExecutionRouter(),
    executor: options.executor ?? new DeterministicExecutor({ sandboxExecDurationMs: 1 }),
    blobs: infra.blobs,
    checkpoints: infra.checkpoints,
    committer: infra.committer,
    workspaces: infra.workspaces,
    approvals,
    budget: new PostgresBudgetLedger(db.pool, { policy: PERMISSIVE_BUDGET }),
    clock,
    logger,
    sentinelPolicy: options.omitSentinelPolicy ? undefined : options.sentinelPolicy,
    credentialBroker: options.credentialBroker,
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  approvals = new PostgresApprovalRepository(db.pool, { clock: { now: () => new Date() } });
  tenant = await createTenantFixture(db.pool);
  ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 };
  agentId = (await agents.create(ctx, { name: 'sentinel admission agent' })).agentId;
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
  infra = await createP06Infra(db);
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

describe('Lane P0-C2B: Sentinel Worker Runtime Admission Gate', () => {
  describe('Pre-execution Denial & Invariant Assertions', () => {
    it('denied Sentinel policy results in 0 budget consumed, 0 executor calls, failed_terminal Run, and failed Task', async () => {
      let executorCallCount = 0;
      const spiedExecutor: SimulatedExecutor = {
        execute: async (c, r, s) => {
          executorCallCount++;
          return new DeterministicExecutor({ sandboxExecDurationMs: 1 }).execute(c, r, s);
        },
      };

      // Create a task whose kind is mock.compute
      const receipt = await tasks.create(
        ctx,
        computeCommand(agentId, `sentinel-deny-${randomUUID()}`),
      );
      const attempt = await claimNextFor(receipt.taskId);

      // Supply a policy that only allows mock.read (mock.compute is disallowed!)
      const policyOnlyRead = createDefaultSentinelPolicy({
        tenantId: tenant.tenantId,
        policyVersion: 1,
        allowedActions: ['mock.read'],
      });

      const handler = makeHandler({
        sentinelPolicy: policyOnlyRead,
        executor: spiedExecutor,
      });

      const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));

      // 1. Run completion is failed_terminal
      expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

      // 2. Queue finish converges Task to failed
      const finished = await queue.finish(attempt.lease, 'failed_terminal');
      expect(finished).toBe(true);

      const persistedTask = await readTask(db.pool, tenant.tenantId, attempt.taskId);
      expect(persistedTask.status).toBe('failed');

      // 3. Invariant: 0 executor calls
      expect(executorCallCount).toBe(0);

      // 4. Invariant: 0 budget reserved / consumed in Postgres
      const budgetOps = await getBudgetOperations(attempt.lease.runId);
      expect(budgetOps).toHaveLength(0);

      // 5. Invariant: 0 checkpoints and 0 artifacts committed
      const checkpoints = await infra.checkpoints.list(attempt.grant);
      expect(checkpoints).toHaveLength(0);
    });

    it('denies mock.file when policy does not explicitly opt in to mock.write, never misclassifying as read', async () => {
      let executorCallCount = 0;
      const spiedExecutor: SimulatedExecutor = {
        execute: async () => {
          await Promise.resolve();
          executorCallCount++;
          throw new Error('should not be called');
        },
      };

      const receipt = await tasks.create(ctx, {
        agentId,
        idempotencyKey: `mock-file-${randomUUID()}`,
        kind: 'mock.file',
        input: {
          fileKey: 'docs/test.txt',
          content: 'hello world from file task',
        },
      });
      const attempt = await claimNextFor(receipt.taskId);

      // Policy has mock.read and mock.compute, but NOT mock.write
      const policyWithoutWrite = createDefaultSentinelPolicy({
        tenantId: tenant.tenantId,
        policyVersion: 1,
        allowMockWrite: false,
      });

      const handler = makeHandler({
        sentinelPolicy: policyWithoutWrite,
        executor: spiedExecutor,
      });

      const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
      expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

      // Invariant: 0 budget operations, 0 executor calls
      expect(executorCallCount).toBe(0);
      const budgetOps = await getBudgetOperations(attempt.lease.runId);
      expect(budgetOps).toHaveLength(0);

      const checkpoints = await infra.checkpoints.list(attempt.grant);
      expect(checkpoints).toHaveLength(0);
    });

    it('allows mock.file when policy explicitly opts in to mock.write and writes to workspace', async () => {
      const receipt = await tasks.create(ctx, {
        agentId,
        idempotencyKey: `mock-file-allowed-${randomUUID()}`,
        kind: 'mock.file',
        input: {
          fileKey: 'docs/written.txt',
          content: 'trusted content',
        },
      });
      const attempt = await claimNextFor(receipt.taskId);

      // Explicit opt-in to mock.write
      const policyWithWrite = createDefaultSentinelPolicy({
        tenantId: tenant.tenantId,
        policyVersion: 1,
        allowMockWrite: true,
      });

      const handler = makeHandler({
        sentinelPolicy: policyWithWrite,
      });

      const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
      expect(completion.type).toBe('committed');

      // Checkpoints committed: produce and publish
      const checkpoints = await infra.checkpoints.list(attempt.grant);
      expect(checkpoints).toHaveLength(2);

      // Workspace updated
      const workspace = await infra.workspaces.loadForRun(tenant.tenantId, agentId);
      expect(workspace.manifest.files.some((f) => f.path === 'docs/written.txt')).toBe(true);

      // Budget operations committed for both produce and publish
      const budgetOps = await getBudgetOperations(attempt.lease.runId);
      expect(budgetOps).toHaveLength(2);
      expect(budgetOps.every((op) => op.state === 'settled')).toBe(true);
    });

    it('fails closed when policy tenantId mismatches context tenantId', async () => {
      const receipt = await tasks.create(
        ctx,
        chatCommand(agentId, `tenant-mismatch-${randomUUID()}`),
      );
      const attempt = await claimNextFor(receipt.taskId);

      const policyForeignTenant = createDefaultSentinelPolicy({
        tenantId: '99999999-9999-4999-8999-999999999999',
        policyVersion: 1,
        allowMockWrite: true,
      });

      const handler = makeHandler({
        sentinelPolicy: policyForeignTenant,
      });

      const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
      expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

      const budgetOps = await getBudgetOperations(attempt.lease.runId);
      expect(budgetOps).toHaveLength(0);
    });

    it('fails closed when policyVersion mismatches context policyVersion', async () => {
      const receipt = await tasks.create(
        ctx,
        chatCommand(agentId, `version-mismatch-${randomUUID()}`),
      );
      const attempt = await claimNextFor(receipt.taskId);

      const policyDifferentVersion = createDefaultSentinelPolicy({
        tenantId: tenant.tenantId,
        policyVersion: 99,
        allowMockWrite: true,
      });

      const handler = makeHandler({
        sentinelPolicy: policyDifferentVersion,
      });

      const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
      expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

      const budgetOps = await getBudgetOperations(attempt.lease.runId);
      expect(budgetOps).toHaveLength(0);
    });

    it('fails closed with 0 budget consumed when policy is omitted/undefined', async () => {
      const receipt = await tasks.create(
        ctx,
        chatCommand(agentId, `missing-policy-${randomUUID()}`),
      );
      const attempt = await claimNextFor(receipt.taskId);

      const handler = makeHandler({
        omitSentinelPolicy: true,
      });

      const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
      expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

      const budgetOps = await getBudgetOperations(attempt.lease.runId);
      expect(budgetOps).toHaveLength(0);
    });
  });

  describe('Durable mock.approval lifecycle with Sentinel Gate', () => {
    it('produce step evaluates as mock.compute, creates pending approval and parks in waiting_approval without deadlock', async () => {
      const receipt = await tasks.create(ctx, {
        agentId,
        idempotencyKey: `approval-produce-${randomUUID()}`,
        kind: 'mock.approval',
        input: { action: 'deploy-model', reason: 'scheduled release' },
      });
      const attempt = await claimNextFor(receipt.taskId);

      // Standard policy without mock.write: produce step is mock.compute, so it is ALLOWED!
      const standardPolicy = createDefaultSentinelPolicy({
        tenantId: tenant.tenantId,
        policyVersion: 1,
        allowMockWrite: false,
      });

      const handler = makeHandler({
        sentinelPolicy: standardPolicy,
      });

      const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
      expect(completion.type).toBe('committed');

      // Task transitioned to waiting_approval
      const persistedTask = await readTask(db.pool, tenant.tenantId, attempt.taskId);
      expect(persistedTask.status).toBe('waiting_approval');

      // Checkpoint created for produce step
      const checkpoints = await infra.checkpoints.list(attempt.grant);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.stepId).toBe('produce');

      // Pending approval row exists
      const approvalList = await approvals.listForGrant(attempt.grant);
      expect(approvalList).toHaveLength(1);
      expect(approvalList[0]?.status).toBe('pending');

      // Only produce budget was consumed
      const budgetOps = await getBudgetOperations(attempt.lease.runId);
      expect(budgetOps).toHaveLength(1);
      expect(budgetOps[0]?.operation_id).toContain('step:produce');
    });

    it('resumed run fails closed with POLICY_DENIED and preserves produce checkpoint when policy denies mock.write', async () => {
      // Step 1: Execute produce with standard policy
      const receipt = await tasks.create(ctx, {
        agentId,
        idempotencyKey: `approval-resume-deny-${randomUUID()}`,
        kind: 'mock.approval',
        input: { action: 'deploy-denied-resume', reason: 'testing denial on resume' },
      });
      const attempt1 = await claimNextFor(receipt.taskId);

      const standardPolicy = createDefaultSentinelPolicy({
        tenantId: tenant.tenantId,
        policyVersion: 1,
        allowMockWrite: false,
      });

      const handler1 = makeHandler({ sentinelPolicy: standardPolicy });
      await handler1.handle(attempt1.lease, AbortSignal.timeout(10_000));

      const approvalList = await approvals.listForGrant(attempt1.grant);
      expect(approvalList).toHaveLength(1);
      const approvalId = approvalList[0]!.approvalId;

      // Operator marks approval as approved
      await approvals.decide(ctx, approvalId, 'approve');

      // Claim a new Run for the approved task
      const attempt2 = await claimNextFor(receipt.taskId);

      // Worker on resume still has policy WITHOUT mock.write
      const handler2 = makeHandler({ sentinelPolicy: standardPolicy });
      const completion2 = await handler2.handle(attempt2.lease, AbortSignal.timeout(10_000));

      // Resume admission evaluates publish phase as mock.write -> DENIED!
      expect(completion2).toEqual({ type: 'finish', outcome: 'failed_terminal' });

      // CRITICAL INVARIANT: The produce checkpoint was NOT deleted!
      const checkpoints = await infra.checkpoints.list(attempt1.grant);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.stepId).toBe('produce');

      // CRITICAL INVARIANT: 0 new budget consumed on Run 2!
      const run2BudgetOps = await getBudgetOperations(attempt2.lease.runId);
      expect(run2BudgetOps).toHaveLength(0);
    });

    it('resumed run completes successfully when policy allows mock.write, without double charging produce', async () => {
      // Step 1: Execute produce
      const receipt = await tasks.create(ctx, {
        agentId,
        idempotencyKey: `approval-resume-allow-${randomUUID()}`,
        kind: 'mock.approval',
        input: { action: 'deploy-allowed-resume', reason: 'testing success on resume' },
      });
      const attempt1 = await claimNextFor(receipt.taskId);

      const policyWithWrite = createDefaultSentinelPolicy({
        tenantId: tenant.tenantId,
        policyVersion: 1,
        allowMockWrite: true,
      });

      const handler = makeHandler({ sentinelPolicy: policyWithWrite });
      await handler.handle(attempt1.lease, AbortSignal.timeout(10_000));

      const approvalList = await approvals.listForGrant(attempt1.grant);
      const approvalId = approvalList[0]!.approvalId;

      // Operator approves
      await approvals.decide(ctx, approvalId, 'approve');

      // Claim run 2
      const attempt2 = await claimNextFor(receipt.taskId);

      // Resume with policy that allows mock.write
      const completion2 = await handler.handle(attempt2.lease, AbortSignal.timeout(10_000));
      expect(completion2.type).toBe('committed');

      // Checkpoints: exactly 2 (produce was NOT duplicated)
      const checkpoints = await infra.checkpoints.list(attempt2.grant);
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints.map((c) => c.stepId).sort()).toEqual(['produce', 'publish']);

      // Run 2 only charged publish, NOT produce
      const run2BudgetOps = await getBudgetOperations(attempt2.lease.runId);
      expect(run2BudgetOps).toHaveLength(1);
      expect(run2BudgetOps[0]?.operation_id).toContain('step:publish');
    });
  });

  describe('Non-executable and High-Risk Categories', () => {
    it('unconditionally blocks external.mutate with 0 budget and 0 executor calls', async () => {
      let executorCallCount = 0;
      const spiedExecutor: SimulatedExecutor = {
        execute: async () => {
          await Promise.resolve();
          executorCallCount++;
          throw new Error('should not execute');
        },
      };

      const receipt = await tasks.create(ctx, computeCommand(agentId, `mutate-${randomUUID()}`));
      const attempt = await claimNextFor(receipt.taskId);

      const mutateReader = {
        read: async (run: LeasedRun, now: Date): Promise<RunExecutionContext> => {
          const realCtx = await reader.read(run, now);
          return { ...realCtx, kind: 'external.mutate' as unknown as TaskKind };
        },
      };

      // Even a permissive policy that allows mock.write cannot allow external.mutate
      const permissivePolicy = createDefaultSentinelPolicy({
        tenantId: tenant.tenantId,
        policyVersion: 1,
        allowMockWrite: true,
      });

      const handler = makeHandler({
        sentinelPolicy: permissivePolicy,
        executor: spiedExecutor,
        reader: mutateReader,
      });

      const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
      expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

      expect(executorCallCount).toBe(0);
      const budgetOps = await getBudgetOperations(attempt.lease.runId);
      expect(budgetOps).toHaveLength(0);
    });

    it('unconditionally blocks high-risk action network.egress', async () => {
      let executorCallCount = 0;
      const spiedExecutor: SimulatedExecutor = {
        execute: async () => {
          await Promise.resolve();
          executorCallCount++;
          throw new Error('should not execute');
        },
      };

      const receipt = await tasks.create(ctx, computeCommand(agentId, `egress-${randomUUID()}`));
      const attempt = await claimNextFor(receipt.taskId);

      const egressReader = {
        read: async (run: LeasedRun, now: Date): Promise<RunExecutionContext> => {
          const realCtx = await reader.read(run, now);
          return { ...realCtx, kind: 'network.egress' as unknown as TaskKind };
        },
      };

      const handler = makeHandler({
        sentinelPolicy: createDefaultSentinelPolicy({
          tenantId: tenant.tenantId,
          policyVersion: 1,
          allowMockWrite: true,
        }),
        executor: spiedExecutor,
        reader: egressReader,
      });

      const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
      expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

      expect(executorCallCount).toBe(0);
      const budgetOps = await getBudgetOperations(attempt.lease.runId);
      expect(budgetOps).toHaveLength(0);
    });

    it('unconditionally blocks high-risk action credential.use with 0 budget and 0 executor calls', async () => {
      let executorCallCount = 0;
      const spiedExecutor: SimulatedExecutor = {
        execute: async () => {
          await Promise.resolve();
          executorCallCount++;
          throw new Error('should not execute');
        },
      };

      const receipt = await tasks.create(ctx, computeCommand(agentId, `cred-use-${randomUUID()}`));
      const attempt = await claimNextFor(receipt.taskId);

      const credentialReader = {
        read: async (run: LeasedRun, now: Date): Promise<RunExecutionContext> => {
          const realCtx = await reader.read(run, now);
          return { ...realCtx, kind: 'credential.use' as unknown as TaskKind };
        },
      };

      const handler = makeHandler({
        sentinelPolicy: createDefaultSentinelPolicy({
          tenantId: tenant.tenantId,
          policyVersion: 1,
          allowMockWrite: true,
        }),
        executor: spiedExecutor,
        reader: credentialReader,
      });

      const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
      expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

      expect(executorCallCount).toBe(0);
      const budgetOps = await getBudgetOperations(attempt.lease.runId);
      expect(budgetOps).toHaveLength(0);
    });

    it('wires trusted CredentialBroker in handler dependencies and executes mock compute normally', async () => {
      const broker = new CredentialBroker({
        registry: new InMemoryCredentialRegistry(),
        policy: SYNTHETIC_EGRESS_POLICY,
        trustedWorkerId: 'worker-integration-test',
      });

      const receipt = await tasks.create(
        ctx,
        computeCommand(agentId, `broker-wired-${randomUUID()}`),
      );
      const attempt = await claimNextFor(receipt.taskId);

      const handler = makeHandler({
        sentinelPolicy: createDefaultSentinelPolicy({
          tenantId: tenant.tenantId,
          policyVersion: 1,
        }),
        credentialBroker: broker,
      });

      const completion = await handler.handle(attempt.lease, AbortSignal.timeout(10_000));
      expect(completion.type).toBe('committed');

      const finishedTask = await readTask(db.pool, tenant.tenantId, attempt.taskId);
      expect(finishedTask.status).toBe('completed');
    });
  });
});
