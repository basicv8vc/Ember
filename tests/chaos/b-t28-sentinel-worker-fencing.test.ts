import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext, TaskCommand } from '@ember/domain';
import {
  PostgresAgentRepository,
  PostgresApprovalRepository,
  PostgresTaskRepository,
  PostgresWorkspaceStore,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from '../integration/support/database.js';
import { createTenantFixture, type TenantFixture } from '../integration/support/fixtures.js';
import { listRuns, readTask } from '../integration/support/leases.js';
import {
  cleanupAllWorkerSubprocesses,
  createChaosPrng,
  dumpFailureDiagnostics,
  globalFaultRecorder,
  spawnWorkerSubprocess,
  withTimeout,
} from './harness/index.js';

/**
 * B-T28 / P0-C2B: Sentinel Runtime Admission & Lease Fencing Chaos Verification
 *
 * Core verification scenarios:
 * 1. SIGKILL recovery under Sentinel Admission Denial on Resume:
 *    - Worker 1 runs Step 1 (produce) under trusted policy (allowMockWrite: true), commits checkpoint & artifact;
 *    - Before Step 2 (publish), Worker 1 is intercepted via PostgreSQL advisory lock barrier and SIGKILLed;
 *    - Lease naturally expires;
 *    - Worker 2 is spawned with strict default policy (allowMockWrite: false);
 *    - Worker 2 claims Task on Epoch 2, resumes from checkpoint, but Sentinel admission gate rejects publish
 *      phase ('mock.write');
 *    - Task converges to failed_terminal / failed;
 *    - Invariant: Step 1 checkpoint is NOT deleted; 0 budget consumed by Worker 2 for publish;
 * 2. SIGKILL recovery under Sentinel Admission Allowance on Resume:
 *    - Worker 1 runs Step 1 (produce) and is SIGKILLed before Step 2 (publish);
 *    - Worker 2 is spawned with allowMockWrite: true;
 *    - Worker 2 claims Task, Sentinel admits publish, completes successfully;
 *    - Invariant: Step 1 is NOT re-executed; exactly 2 checkpoints; workspace updated;
 * 3. Durable mock.approval Produce & Resume under Sentinel Gate:
 *    - Worker 1 executes produce phase (classified as mock.compute, allowed without mock.write);
 *    - Task enters waiting_approval; Worker 1 stops;
 *    - Human decision: approve;
 *    - Resumed Worker 2 with allowMockWrite: false attempts publish;
 *    - Sentinel admission gate rejects publish despite human approval;
 *    - Task transitions to failed; Step 1 checkpoint preserved; 0 publish budget charged.
 */

describe('B-T28: Sentinel Runtime Admission & Worker Fencing Chaos Verification', () => {
  let db: TestDatabase;
  let agents: PostgresAgentRepository;
  let tasks: PostgresTaskRepository;
  let approvals: PostgresApprovalRepository;
  let workspaces: PostgresWorkspaceStore;
  let tenant: TenantFixture;
  let ctx: AuthContext;
  let prng: ReturnType<typeof createChaosPrng>;

  let blobRootDir: string;

  beforeAll(async () => {
    prng = createChaosPrng();
    db = await createTestDatabase({ maxConnections: 24 });
    agents = new PostgresAgentRepository(db.pool);
    tasks = new PostgresTaskRepository(db.pool);
    approvals = new PostgresApprovalRepository(db.pool);
    workspaces = new PostgresWorkspaceStore(db.pool);

    tenant = await createTenantFixture(db.pool, 'b-t28-sentinel-chaos');
    ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 };

    blobRootDir = await mkdtemp(path.join(tmpdir(), 'ember-chaos-sentinel-'));
  }, 30_000);

  afterAll(async () => {
    await cleanupAllWorkerSubprocesses();
    if (blobRootDir.startsWith(tmpdir()) && blobRootDir.includes('ember-chaos-sentinel-')) {
      await rm(blobRootDir, { recursive: true, force: true });
    }
    await db?.close();
  });

  afterEach(async (context) => {
    await cleanupAllWorkerSubprocesses();
    if (context.task.result?.state === 'fail') {
      dumpFailureDiagnostics(context.task.name, prng.seed, context.task.result.errors?.[0]);
    }
    globalFaultRecorder.clear();
  });

  async function countCheckpoints(taskId: string): Promise<number> {
    const res = await db.observerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  async function listTaskCheckpoints(taskId: string) {
    const res = await db.observerPool.query<{
      id: string;
      step_id: string;
      step_sequence: number;
      attempt: number;
      run_id: string;
      artifacts: unknown;
    }>(
      `SELECT id, step_id, step_sequence, attempt, run_id, artifacts
         FROM step_checkpoints
        WHERE tenant_id = $1 AND task_id = $2
        ORDER BY step_sequence ASC`,
      [tenant.tenantId, taskId],
    );
    return res.rows;
  }

  async function countBudgetRows(taskId: string): Promise<number> {
    const res = await db.observerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM budget_operations WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  // ---------------------------------------------------------------------------
  // Scenario 1: SIGKILL Worker 1 after produce; Worker 2 resumes with policy
  // that denies publish (mock.write not allowed) -> fail-closed, checkpoint preserved
  // ---------------------------------------------------------------------------
  it('SIGKILLs Worker 1 after Step 1 checkpoint; Worker 2 resumes without mock.write and fails closed with checkpoint preserved', async () => {
    const agent = await agents.create(ctx, { name: `sentinel-deny-agent-${randomUUID()}` });
    const key = `sentinel-deny-resume-${randomUUID()}`;
    const command: TaskCommand = {
      agentId: agent.agentId,
      kind: 'mock.file',
      input: {
        fileKey: 'reports/financial-summary.txt',
        content: 'Confidential Financial Report 2026',
      },
      idempotencyKey: key,
    };

    const createdReceipt = await tasks.create(ctx, command);
    const taskId = createdReceipt.taskId;

    // Set up advisory lock barrier on publish step checkpoint insertion
    const barrierClassId = prng.nextInt(500_000, 599_999);
    const barrierObjId = prng.nextInt(500_000, 599_999);
    const funcName = `pause_sentinel_pub_${barrierClassId}`;
    const triggerName = `${funcName}_trg`;

    const barrierClient = await db.pool.connect();
    await barrierClient.query('SELECT pg_advisory_lock($1, $2)', [barrierClassId, barrierObjId]);

    try {
      await db.pool.query(`
        CREATE OR REPLACE FUNCTION ${funcName}()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.step_id = 'publish' THEN
            PERFORM pg_advisory_lock(${barrierClassId}, ${barrierObjId});
          END IF;
          RETURN NEW;
        END;
        $$;

        CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON step_checkpoints
          FOR EACH ROW EXECUTE FUNCTION ${funcName}();
      `);

      // Spawn Worker 1 with mock.write explicitly enabled
      const worker1 = await spawnWorkerSubprocess({
        schema: db.schema,
        blobRootDir,
        workerId: 'worker-sentinel-producer',
        leaseDurationMs: 2_000,
        heartbeatIntervalMs: 300,
        intervalMs: 200,
        errorBackoffMs: 200,
        retryBaseMs: 200,
        extraEnv: {
          EMBER_WORKER_SENTINEL_ALLOW_MOCK_WRITE: 'true',
        },
      });

      expect(worker1.pid).toBeGreaterThan(0);
      expect(worker1.isAlive()).toBe(true);

      // Wait for Worker 1 to reach publish step barrier
      await withTimeout(
        (async () => {
          while (true) {
            const res = await db.adminPool.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM pg_locks
                WHERE locktype = 'advisory'
                  AND classid = $1
                  AND objid = $2
                  AND NOT granted`,
              [barrierClassId, barrierObjId],
            );
            if (res.rows[0]?.count !== '0') break;
            await new Promise((r) => setTimeout(r, 50));
          }
        })(),
        10_000,
        'waiting for Worker 1 to reach publish checkpoint barrier',
      );

      // Verify Worker 1 committed Step 1 (produce) checkpoint
      expect(await countCheckpoints(taskId)).toBe(1);
      const preKillCheckpoints = await listTaskCheckpoints(taskId);
      expect(preKillCheckpoints[0]?.step_id).toBe('produce');
      expect(preKillCheckpoints[0]?.attempt).toBe(1);

      // Record budget entries before kill (Worker 1 produce reservation & settlement)
      const preKillBudgetRows = await countBudgetRows(taskId);
      expect(preKillBudgetRows).toBeGreaterThan(0);

      // Fault injection: SIGKILL Worker 1
      const exitResult = await worker1.sigkill();
      expect(exitResult.signal).toBe('SIGKILL');
      expect(worker1.isAlive()).toBe(false);
    } finally {
      await barrierClient
        .query('SELECT pg_advisory_unlock($1, $2)', [barrierClassId, barrierObjId])
        .catch(() => {});
      barrierClient.release();
      await db.pool
        .query(
          `
        DROP TRIGGER IF EXISTS ${triggerName} ON step_checkpoints;
        DROP FUNCTION IF EXISTS ${funcName}();
      `,
        )
        .catch(() => {});
    }

    // Step 1 checkpoint must still exist after SIGKILL
    expect(await countCheckpoints(taskId)).toBe(1);
    const postKillTask = await readTask(db.observerPool, tenant.tenantId, taskId);
    expect(postKillTask.status).toBe('running');

    // Wait for lease to expire
    const leaseRemainingMs = postKillTask.lease_expires_at
      ? postKillTask.lease_expires_at.getTime() - Date.now()
      : 0;
    if (leaseRemainingMs > 0) {
      await new Promise((r) => setTimeout(r, leaseRemainingMs + 200));
    }

    const budgetCountBeforeWorker2 = await countBudgetRows(taskId);

    // Spawn Worker 2 WITHOUT mock.write (default policy denies mock.write)
    const worker2 = await spawnWorkerSubprocess({
      schema: db.schema,
      blobRootDir,
      workerId: 'worker-sentinel-strict-resumer',
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 300,
      intervalMs: 200,
      errorBackoffMs: 200,
      retryBaseMs: 200,
      extraEnv: {
        EMBER_WORKER_SENTINEL_ALLOW_MOCK_WRITE: 'false',
      },
    });

    // Wait for Task to converge to failed terminal state
    const failedTask = await withTimeout(
      (async () => {
        while (true) {
          const t = await readTask(db.observerPool, tenant.tenantId, taskId);
          if (t.status === 'failed') {
            return t;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })(),
      12_000,
      'waiting for Worker 2 to fail-closed the denied task',
    );

    await worker2.sigterm();

    // Verify Invariants:
    // 1. Task converged to failed (existing domain state machine)
    expect(failedTask.status).toBe('failed');
    expect(failedTask.lease_expires_at).toBeNull();

    // 2. Step 1 checkpoint was NOT deleted!
    expect(await countCheckpoints(taskId)).toBe(1);
    const checkpoints = await listTaskCheckpoints(taskId);
    expect(checkpoints[0]?.step_id).toBe('produce');
    expect(checkpoints[0]?.attempt).toBe(1);

    // 3. Zero new budget rows reserved by Worker 2 for the denied publish step
    const budgetCountAfterWorker2 = await countBudgetRows(taskId);
    expect(budgetCountAfterWorker2).toBe(budgetCountBeforeWorker2);

    // 4. Verify Run outcome
    const runs = await listRuns(db.observerPool, tenant.tenantId, taskId);
    const run2 = runs.find((r) => r.attempt === 2);
    expect(run2).toBeDefined();
    expect(run2?.status).toBe('failed_terminal');

    // 5. Worker 2 logs record Sentinel admission denial
    const logs = worker2.getLogs();
    expect(logs).toContain(
      'sentinel gate denied: verdict=deny reason=DENY_MOCK_ACTION_DISALLOWED action=mock.write',
    );
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: SIGKILL Worker 1 after produce; Worker 2 resumes with policy
  // that allows publish -> resumes from Step 1, completes cleanly, 2 checkpoints
  // ---------------------------------------------------------------------------
  it('SIGKILLs Worker 1 after Step 1 checkpoint; Worker 2 resumes with mock.write and completes without re-executing Step 1', async () => {
    const agent = await agents.create(ctx, { name: `sentinel-allow-agent-${randomUUID()}` });
    const key = `sentinel-allow-resume-${randomUUID()}`;
    const command: TaskCommand = {
      agentId: agent.agentId,
      kind: 'mock.file',
      input: {
        fileKey: 'docs/architecture.md',
        content: '# Architecture Overview\nVerified Sentinel Admission.',
      },
      idempotencyKey: key,
    };

    const createdReceipt = await tasks.create(ctx, command);
    const taskId = createdReceipt.taskId;

    const barrierClassId = prng.nextInt(600_000, 699_999);
    const barrierObjId = prng.nextInt(600_000, 699_999);
    const funcName = `pause_sentinel_allow_${barrierClassId}`;
    const triggerName = `${funcName}_trg`;

    const barrierClient = await db.pool.connect();
    await barrierClient.query('SELECT pg_advisory_lock($1, $2)', [barrierClassId, barrierObjId]);

    try {
      await db.pool.query(`
        CREATE OR REPLACE FUNCTION ${funcName}()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.step_id = 'publish' THEN
            PERFORM pg_advisory_lock(${barrierClassId}, ${barrierObjId});
          END IF;
          RETURN NEW;
        END;
        $$;

        CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON step_checkpoints
          FOR EACH ROW EXECUTE FUNCTION ${funcName}();
      `);

      const worker1 = await spawnWorkerSubprocess({
        schema: db.schema,
        blobRootDir,
        workerId: 'worker-sentinel-producer-2',
        leaseDurationMs: 2_000,
        heartbeatIntervalMs: 300,
        intervalMs: 200,
        errorBackoffMs: 200,
        retryBaseMs: 200,
        extraEnv: {
          EMBER_WORKER_SENTINEL_ALLOW_MOCK_WRITE: 'true',
        },
      });

      await withTimeout(
        (async () => {
          while (true) {
            const res = await db.adminPool.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM pg_locks
                WHERE locktype = 'advisory'
                  AND classid = $1
                  AND objid = $2
                  AND NOT granted`,
              [barrierClassId, barrierObjId],
            );
            if (res.rows[0]?.count !== '0') break;
            await new Promise((r) => setTimeout(r, 50));
          }
        })(),
        10_000,
        'waiting for Worker 1 to reach publish barrier',
      );

      expect(await countCheckpoints(taskId)).toBe(1);

      await worker1.sigkill();
    } finally {
      await barrierClient
        .query('SELECT pg_advisory_unlock($1, $2)', [barrierClassId, barrierObjId])
        .catch(() => {});
      barrierClient.release();
      await db.pool
        .query(
          `
        DROP TRIGGER IF EXISTS ${triggerName} ON step_checkpoints;
        DROP FUNCTION IF EXISTS ${funcName}();
      `,
        )
        .catch(() => {});
    }

    const postKillTask = await readTask(db.observerPool, tenant.tenantId, taskId);
    const leaseRemainingMs = postKillTask.lease_expires_at
      ? postKillTask.lease_expires_at.getTime() - Date.now()
      : 0;
    if (leaseRemainingMs > 0) {
      await new Promise((r) => setTimeout(r, leaseRemainingMs + 200));
    }

    // Spawn Worker 2 WITH mock.write enabled
    const worker2 = await spawnWorkerSubprocess({
      schema: db.schema,
      blobRootDir,
      workerId: 'worker-sentinel-permissive-resumer',
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 300,
      intervalMs: 200,
      errorBackoffMs: 200,
      retryBaseMs: 200,
      extraEnv: {
        EMBER_WORKER_SENTINEL_ALLOW_MOCK_WRITE: 'true',
      },
    });

    const completedTask = await withTimeout(
      (async () => {
        while (true) {
          const t = await readTask(db.observerPool, tenant.tenantId, taskId);
          if (t.status === 'completed') {
            return t;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })(),
      12_000,
      'waiting for Worker 2 to complete the task',
    );

    await worker2.sigterm();

    // Verify Invariants:
    expect(completedTask.status).toBe('completed');
    expect(completedTask.attempt_count).toBe(2);

    // Exactly 2 checkpoints
    const finalCheckpoints = await listTaskCheckpoints(taskId);
    expect(finalCheckpoints).toHaveLength(2);

    const produceCp = finalCheckpoints[0]!;
    expect(produceCp.step_id).toBe('produce');
    expect(produceCp.attempt).toBe(1); // Not re-executed!

    const publishCp = finalCheckpoints[1]!;
    expect(publishCp.step_id).toBe('publish');
    expect(publishCp.attempt).toBe(2);

    // Workspace committed
    const ws = await workspaces.loadForRun(tenant.tenantId, agent.agentId);
    expect(ws.version).toBeGreaterThanOrEqual(1);
    expect(ws.manifest.files.some((f) => f.path === 'docs/architecture.md')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: mock.approval produces pending approval, user approves,
  // but resumed Worker with allowMockWrite: false fails closed at publish
  // ---------------------------------------------------------------------------
  it('durable mock.approval produces pending approval; approval decision cannot bypass Sentinel admission denial on publish', async () => {
    const agent = await agents.create(ctx, { name: `sentinel-approval-agent-${randomUUID()}` });
    const key = `sentinel-approval-resume-${randomUUID()}`;
    const command: TaskCommand = {
      agentId: agent.agentId,
      kind: 'mock.approval',
      input: {
        action: 'system:deploy_production',
        reason: 'Chaos Sentinel admission test',
      },
      idempotencyKey: key,
    };

    const createdReceipt = await tasks.create(ctx, command);
    const taskId = createdReceipt.taskId;

    // Worker 1 runs with default policy (allowMockWrite: false)
    // mock.approval produce is classified as mock.compute, so produce succeeds!
    const worker1 = await spawnWorkerSubprocess({
      schema: db.schema,
      blobRootDir,
      workerId: 'worker-approval-producer',
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 300,
      intervalMs: 200,
      errorBackoffMs: 200,
      retryBaseMs: 200,
      extraEnv: {
        EMBER_WORKER_SENTINEL_ALLOW_MOCK_WRITE: 'false',
      },
    });

    // Wait for Task to park in waiting_approval
    const parkedTask = await withTimeout(
      (async () => {
        while (true) {
          const t = await readTask(db.observerPool, tenant.tenantId, taskId);
          if (t.status === 'waiting_approval') {
            return t;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })(),
      10_000,
      'waiting for mock.approval task to park in waiting_approval',
    );

    expect(parkedTask.status).toBe('waiting_approval');
    expect(await countCheckpoints(taskId)).toBe(1);

    // Stop Worker 1
    await worker1.sigterm();

    // Find the pending approval record
    const approvalsList = await approvals.listForGrant({
      tenantId: tenant.tenantId,
      taskId,
    });
    expect(approvalsList.length).toBeGreaterThan(0);
    const approvalRecord = approvalsList[0]!;
    expect(approvalRecord.status).toBe('pending');

    // Human approves the action
    await approvals.decide(ctx, approvalRecord.approvalId, 'approve');

    // Count budget rows before Worker 2
    const budgetRowsBeforeResume = await countBudgetRows(taskId);

    // Spawn Worker 2 WITHOUT mock.write (publish requires mock.write!)
    const worker2 = await spawnWorkerSubprocess({
      schema: db.schema,
      blobRootDir,
      workerId: 'worker-approval-resumer-strict',
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 300,
      intervalMs: 200,
      errorBackoffMs: 200,
      retryBaseMs: 200,
      extraEnv: {
        EMBER_WORKER_SENTINEL_ALLOW_MOCK_WRITE: 'false',
      },
    });

    // Worker 2 should claim the approved task, but Sentinel admission gate must reject publish
    const finalTask = await withTimeout(
      (async () => {
        while (true) {
          const t = await readTask(db.observerPool, tenant.tenantId, taskId);
          if (t.status === 'failed') {
            return t;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })(),
      12_000,
      'waiting for Worker 2 to reject publish and fail the task',
    );

    await worker2.sigterm();

    // Verify Invariants:
    // 1. Task converged to failed
    expect(finalTask.status).toBe('failed');

    // 2. Step 1 checkpoint preserved
    expect(await countCheckpoints(taskId)).toBe(1);

    // 3. Zero new budget rows for the publish step
    const budgetRowsAfterResume = await countBudgetRows(taskId);
    expect(budgetRowsAfterResume).toBe(budgetRowsBeforeResume);

    // 4. Run outcome is failed_terminal
    const runs = await listRuns(db.observerPool, tenant.tenantId, taskId);
    const resumeRun = runs.find((r) => r.attempt === 2);
    expect(resumeRun).toBeDefined();
    expect(resumeRun?.status).toBe('failed_terminal');
  });
});
