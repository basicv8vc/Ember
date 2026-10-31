import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CommitStepRequest, RunExecutionContext, RunGrant } from '@ember/contracts';
import type { AuthContext, LeasedRun } from '@ember/domain';
import {
  LocalBlobStore,
  PostgresAgentRepository,
  PostgresBlobStore,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresRunResultCommitter,
  PostgresTaskRepository,
  PostgresWorkspaceStore,
  resolveLeaseQueueConfig,
  type CommitFaultInjector,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from '../integration/support/database.js';
import { createTenantFixture, type TenantFixture } from '../integration/support/fixtures.js';
import {
  createQueuedTask,
  databaseNow,
  listEventSnapshots,
  parkOtherOpenTasks,
  readRun,
  readTask,
  waitForTaskLockWaiter,
} from '../integration/support/leases.js';
import { grantOfContext } from '../integration/support/p0b06.js';
import {
  createBarrier,
  createChaosPrng,
  dumpFailureDiagnostics,
  globalFaultRecorder,
  simulateWorkerCrash,
  withTimeout,
} from './harness/index.js';

/**
 * B-T27: Chaos Testing — 旧 Run 与新 Run 并发交错与 Lease Fencing 验证
 *
 * 核心验证：
 * 1. 经典 Zombie Worker 场景：旧 Run (Epoch 1) 迟到提交，新 Run (Epoch 2) 已完成任务，
 *    Fencing 机制必须坚决拒绝旧 Run 提交 (STALE_LEASE / 心跳失败 / 终态保护)，绝不覆写终态与 Workspace；
 * 2. 确定性行锁同步屏障拦截：旧 Run 进入提交阶段时在行锁处等待，租约在等待期间失效，锁释放后 Worker
 *    必须重新断言代次与租约，坚决拒绝旧代次写入；
 * 3. Workspace CAS 深度防护：旧 Run 尝试依据旧版本推进 Workspace，版本必须严格单调递增，绝不倒退；
 * 4. 多代次并发乱序竞争：基于 PRNG 受控随机交织多 Worker 提交，验证有且仅有当前权威代次能够成功落库。
 */

const LEASE_MS = 2_000;

describe('B-T27: Old Run vs New Run Interleaving & Lease Fencing Chaos Verification', () => {
  let db: TestDatabase;
  let agents: PostgresAgentRepository;
  let tasks: PostgresTaskRepository;
  let tenant: TenantFixture;
  let ctx: AuthContext;
  let queue: PostgresLeaseQueue;
  let reader: PostgresRunExecutionContextReader;
  let prng: ReturnType<typeof createChaosPrng>;

  let blobRootDir: string;
  let localFiles: LocalBlobStore;
  let blobs: PostgresBlobStore;
  let workspaces: PostgresWorkspaceStore;

  beforeAll(async () => {
    prng = createChaosPrng();
    db = await createTestDatabase({ maxConnections: 24 });
    agents = new PostgresAgentRepository(db.pool);
    tasks = new PostgresTaskRepository(db.pool);

    tenant = await createTenantFixture(db.pool, 'b-t27 tenant');
    ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 };

    queue = new PostgresLeaseQueue(db.pool, {
      leaseDurationMs: LEASE_MS,
      heartbeatIntervalMs: 500,
      baseDelayMs: 100,
      capDelayMs: 200,
      reaperBatchSize: 10,
    });
    reader = new PostgresRunExecutionContextReader(db.pool);

    blobRootDir = await mkdtemp(path.join(tmpdir(), 'ember-chaos-fencing-'));
    localFiles = new LocalBlobStore({ rootDir: blobRootDir });
    blobs = new PostgresBlobStore(db.pool, localFiles);
    workspaces = new PostgresWorkspaceStore(db.pool);
  }, 30_000);

  afterAll(async () => {
    if (blobRootDir.startsWith(tmpdir()) && blobRootDir.includes('ember-chaos-fencing-')) {
      await rm(blobRootDir, { recursive: true, force: true });
    }
    await db?.close();
  });

  afterEach((context) => {
    if (context.task.result?.state === 'fail') {
      dumpFailureDiagnostics(context.task.name, prng.seed, context.task.result.errors?.[0]);
    }
    // Keep diagnostic traces scoped to the failing test only.
    globalFaultRecorder.clear();
  });

  interface ClaimedTask {
    lease: LeasedRun;
    context: RunExecutionContext;
    grant: RunGrant;
    agentId: string;
  }

  async function claimForAgent(label: string, workerName = 'worker-b-t27'): Promise<ClaimedTask> {
    const agent = await agents.create(ctx, { name: `agent-${label}-${randomUUID()}` });
    const created = await createQueuedTask(tasks, ctx, agent.agentId, label);
    await parkOtherOpenTasks(db.pool, created.taskId);
    const now = new Date((await databaseNow(db.pool)).getTime() + 10);
    const lease = await queue.claimNext(workerName, now);
    if (lease === null) {
      throw new Error(`failed to claim task ${created.taskId}`);
    }
    const context = await reader.read(lease, now);
    return { lease, context, grant: grantOfContext(context), agentId: agent.agentId };
  }

  function createCommitter(faultInjector?: CommitFaultInjector): PostgresRunResultCommitter {
    return new PostgresRunResultCommitter(db.pool, {
      policy: resolveLeaseQueueConfig({
        leaseDurationMs: LEASE_MS,
        heartbeatIntervalMs: 500,
      }),
      blobs,
      ...(faultInjector ? { faultInjector } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // 1. 经典 Zombie Worker 场景：旧 Run 迟到提交
  // ---------------------------------------------------------------------------
  describe('Zombie Worker Delayed Submission', () => {
    it('fences old run when new run has claimed and completed the task', async () => {
      const committer = createCommitter();
      const task1 = await claimForAgent('zombie-worker-test', 'worker-old');
      const taskId = task1.lease.taskId;
      const agentId = task1.agentId;

      globalFaultRecorder.record({
        testName: 'B-T27',
        faultType: 'ZOMBIE_WORKER_SIMULATION',
        point: 'old_worker_paused_lease_expired',
        targetId: taskId,
        details: { oldRunId: task1.lease.runId, oldEpoch: task1.lease.leaseEpoch },
        seed: prng.seed,
      });

      // 1. 模拟 Worker 1 停顿，其租约在数据库中过期，Reaper 介入清理
      await simulateWorkerCrash(db.pool, queue, tenant.tenantId, task1.lease);

      // 2. Worker 2 (新 Run) 接管该任务并成功领取
      await parkOtherOpenTasks(db.pool, taskId);
      await db.pool.query(
        "UPDATE tasks SET next_run_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [taskId],
      );

      const now = await databaseNow(db.pool);
      const lease2 = await queue.claimNext('worker-new', now);
      expect(lease2).not.toBeNull();
      expect(lease2?.taskId).toBe(taskId);
      expect(lease2?.runId).not.toBe(task1.lease.runId);
      expect(lease2?.leaseEpoch).toBeGreaterThan(task1.lease.leaseEpoch);

      const context2 = await reader.read(lease2!, now);
      const grant2 = grantOfContext(context2);

      // 3. Worker 2 正常完成任务并提交终态
      const stagedNew = await blobs.stage(
        tenant.tenantId,
        Buffer.from('worker 2 new content'),
        'text/plain',
      );
      const newResultRequest: CommitStepRequest = {
        operationId: `op:finish:new:${taskId}`,
        mode: 'result',
        artifacts: [{ artifactId: stagedNew.stagedId, staged: stagedNew }],
        workspace: {
          expectedVersion: 0,
          manifest: {
            files: [
              {
                path: 'result.txt',
                artifactId: stagedNew.stagedId,
                sha256: stagedNew.sha256,
                size: stagedNew.size,
              },
            ],
          },
        },
      };

      const receiptNew = await committer.commitStep(grant2, newResultRequest);
      expect(receiptNew.replayed).toBe(false);

      // 验证 Worker 2 提交后，任务已是 completed，Run 2 已是 succeeded
      const taskAfterNew = await readTask(db.observerPool, tenant.tenantId, taskId);
      expect(taskAfterNew.status).toBe('completed');
      const run2Row = await readRun(db.observerPool, tenant.tenantId, taskId, lease2!.runId);
      expect(run2Row?.status).toBe('succeeded');

      // 4. Worker 1 (Zombie) 此时苏醒，尝试执行操作：
      // 4a. 心跳检测必须返回 false (租约已失效/已被抢占)
      const heartbeatOld = await queue.heartbeat(task1.lease, now);
      expect(heartbeatOld).toBe(false);

      // 4b. 尝试直接通过 leaseQueue.finish 报告成功 -> 必须被拒绝
      const finishOld = await queue.finish(task1.lease, 'succeeded');
      expect(finishOld).toBe(false);

      // 4c. 尝试通过 ResultCommitter 提交其陈旧的输出
      const stagedOld = await blobs.stage(
        tenant.tenantId,
        Buffer.from('worker 1 zombie content'),
        'text/plain',
      );
      const oldResultRequest: CommitStepRequest = {
        operationId: `op:finish:old:${taskId}`,
        mode: 'result',
        artifacts: [{ artifactId: stagedOld.stagedId, staged: stagedOld }],
        workspace: {
          expectedVersion: 0,
          manifest: {
            files: [
              {
                path: 'result.txt',
                artifactId: stagedOld.stagedId,
                sha256: stagedOld.sha256,
                size: stagedOld.size,
              },
            ],
          },
        },
      };

      await expect(committer.commitStep(task1.grant, oldResultRequest)).rejects.toMatchObject({
        code: 'STALE_LEASE',
      });

      // 5. 关键不变量断言（终态绝对不可被覆盖）：
      // - Task 终态依然保持 completed
      const finalTask = await readTask(db.observerPool, tenant.tenantId, taskId);
      expect(finalTask.status).toBe('completed');

      // - Run 1 终态依然是 lease_expired，绝不能变为 succeeded
      const run1Row = await readRun(db.observerPool, tenant.tenantId, taskId, task1.lease.runId);
      expect(run1Row?.status).toBe('lease_expired');

      // - Workspace 版本为 1，且文件内容是 Worker 2 的 stagedNew，未被 Worker 1 污染
      const ws = await workspaces.loadForRun(tenant.tenantId, agentId);
      expect(ws.version).toBe(1);
      expect(ws.manifest.files).toHaveLength(1);
      expect(ws.manifest.files[0]?.artifactId).toBe(stagedNew.stagedId);

      // - 任务事件流中 completed 终态事件严格为 1 个
      const events = await listEventSnapshots(db.observerPool, tenant.tenantId, taskId);
      const completedEvents = events.filter((e) => e.phase === 'completed');
      expect(completedEvents).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. 确定性行锁同步屏障拦截：旧 Run 在提交行锁处等待期间租约失效
  // ---------------------------------------------------------------------------
  describe('Deterministic Sync Barrier Interleaving', () => {
    it('blocks old run waiting on row-lock while lease expires, ensuring stale epoch rejection on wake', async () => {
      const committer = createCommitter();
      const task = await claimForAgent('sync-lock-barrier', 'worker-lock-old');
      const taskId = task.lease.taskId;

      const staged = await blobs.stage(
        tenant.tenantId,
        Buffer.from('staged by worker lock'),
        'text/plain',
      );
      const req: CommitStepRequest = {
        operationId: `op:lock-barrier:${taskId}`,
        mode: 'result',
        artifacts: [{ artifactId: staged.stagedId, staged }],
      };

      // 1. 获取一个独立的连接作为屏障持有者，显式锁定 Task 行
      const blocker = await db.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
        tenant.tenantId,
        taskId,
      ]);

      // 2. 启动 Worker 提交（将在 SELECT ... FOR UPDATE 处被挂起）
      const commitPromise = committer.commitStep(task.grant, req);

      // 3. 确定性等待 Worker 到达行锁等待队列
      await waitForTaskLockWaiter(db.pool, blocker);

      globalFaultRecorder.record({
        testName: 'B-T27',
        faultType: 'ROW_LOCK_BARRIER_HELD',
        point: 'waiting_for_task_row_lock',
        targetId: taskId,
        seed: prng.seed,
      });

      // 4. 在 Worker 挂起期间，从外部使该 Run 租约过期并推进 lease_epoch
      await db.pool.query(
        `UPDATE runs
            SET leased_until = clock_timestamp() - interval '1 second'
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, task.lease.runId],
      );

      // 5. 释放行锁屏障，Worker 获取到行锁
      await blocker.query('ROLLBACK');
      blocker.release();

      // 6. Worker 拿到锁后，事务内的锁后时钟 re-check 必须识破租约已失效并坚决拒绝
      await expect(commitPromise).rejects.toMatchObject({
        code: 'STALE_LEASE',
      });

      // 验证未产生任何终态写入
      const taskAfter = await readTask(db.observerPool, tenant.tenantId, taskId);
      expect(taskAfter.status).toBe('running');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Workspace CAS 并发防护
  // ---------------------------------------------------------------------------
  describe('Workspace CAS Protection against Stale Epoch', () => {
    it('refuses workspace CAS from old run when workspace version was already bumped by another run', async () => {
      const committer = createCommitter();
      const task = await claimForAgent('cas-protection-test', 'worker-cas-1');
      const taskId = task.lease.taskId;
      const agentId = task.agentId;

      // 首先通过正常流程推进 Workspace 版本从 0 到 1
      const stagedFirst = await blobs.stage(
        tenant.tenantId,
        Buffer.from('version 1 content'),
        'text/plain',
      );
      const bumpRequest: CommitStepRequest = {
        operationId: `op:ws-bump:${taskId}`,
        mode: 'progress',
        artifacts: [{ artifactId: stagedFirst.stagedId, staged: stagedFirst }],
        workspace: {
          expectedVersion: 0,
          manifest: {
            files: [
              {
                path: 'data.txt',
                artifactId: stagedFirst.stagedId,
                sha256: stagedFirst.sha256,
                size: stagedFirst.size,
              },
            ],
          },
        },
      };

      await committer.commitStep(task.grant, bumpRequest);

      // 验证 Workspace 版本已成功为 1
      const wsV1 = await workspaces.loadForRun(tenant.tenantId, agentId);
      expect(wsV1.version).toBe(1);

      // 现在模拟使用旧的 expectedVersion: 0 尝试再次提交
      const stagedStale = await blobs.stage(
        tenant.tenantId,
        Buffer.from('stale version 0 overwrite attempt'),
        'text/plain',
      );
      const staleCasRequest: CommitStepRequest = {
        operationId: `op:ws-stale-overwrite:${taskId}`,
        mode: 'result',
        artifacts: [{ artifactId: stagedStale.stagedId, staged: stagedStale }],
        workspace: {
          expectedVersion: 0, // 陈旧的版本预期
          manifest: {
            files: [
              {
                path: 'data.txt',
                artifactId: stagedStale.stagedId,
                sha256: stagedStale.sha256,
                size: stagedStale.size,
              },
            ],
          },
        },
      };

      globalFaultRecorder.record({
        testName: 'B-T27',
        faultType: 'STALE_WORKSPACE_CAS_ATTEMPT',
        point: 'before_workspace_cas',
        targetId: taskId,
        details: { currentVersion: 1, attemptedExpectedVersion: 0 },
        seed: prng.seed,
      });

      // 执行提交：验证旧版本尝试由于版本冲突被坚决拒绝 (WORKSPACE_VERSION_CONFLICT)
      await expect(committer.commitStep(task.grant, staleCasRequest)).rejects.toMatchObject({
        code: 'WORKSPACE_VERSION_CONFLICT',
      });

      // 校验版本依然严格保持为 1，绝对未被旧版本覆写或污染
      const finalWs = await workspaces.loadForRun(tenant.tenantId, agentId);
      expect(finalWs.version).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. PRNG 受控交错并发抢占（3 个 Attempt 乱序竞争）
  // ---------------------------------------------------------------------------
  describe('Controlled Multi-Attempt Interleaved Competition', () => {
    it('ensures exactly one attempt wins terminal state under randomized concurrent attempts', async () => {
      const committer = createCommitter();
      const task = await claimForAgent('multi-attempt-competition', 'worker-initial');
      const taskId = task.lease.taskId;

      // 准备 3 个不同的结果请求
      const stagedList = await Promise.all([
        blobs.stage(tenant.tenantId, Buffer.from('attempt-1'), 'text/plain'),
        blobs.stage(tenant.tenantId, Buffer.from('attempt-2'), 'text/plain'),
        blobs.stage(tenant.tenantId, Buffer.from('attempt-3'), 'text/plain'),
      ]);

      const requests: CommitStepRequest[] = stagedList.map((staged, idx) => ({
        operationId: `op:multi:${taskId}:${idx + 1}`,
        mode: 'result',
        artifacts: [{ artifactId: staged.stagedId, staged }],
      }));

      // 使用受控 PRNG 打乱顺序
      const shuffledRequests = prng.shuffle(requests);
      const barrier = createBarrier(shuffledRequests.length, 'multi-attempt-barrier');

      // 并发尝试提交相同的 Grant（同一 Run 下仅允许一次 terminal 提交）
      const results = await Promise.allSettled(
        shuffledRequests.map(async (req) => {
          await barrier.wait();
          return committer.commitStep(task.grant, req);
        }),
      );

      // 统计成功数与被拒绝数
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // 必须有且仅有 1 个操作成功确立终态，其余必须被拒绝（由于 TASK_ALREADY_TERMINAL 或冲突）
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(2);

      // 终态保持 completed
      const taskFinal = await readTask(db.observerPool, tenant.tenantId, taskId);
      expect(taskFinal.status).toBe('completed');

      // 终态 completed 事件严格为 1
      const events = await listEventSnapshots(db.observerPool, tenant.tenantId, taskId);
      const completedEvents = events.filter((e) => e.phase === 'completed');
      expect(completedEvents).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. 并发 Cancellation 与 Terminal Result Commit 竞争（确定性分支验证）
  // ---------------------------------------------------------------------------
  describe('Concurrent Cancellation vs Terminal Result Commit Race', () => {
    // -------------------------------------------------------------------------
    // 5.1 Commit-first 路径：commitStep 率先获取行锁，并发 cancel 随后到达排队，
    // commit 完成后，cancel 无法颠覆终态，保持单一 completed 终态与单条 terminal event
    // -------------------------------------------------------------------------
    it('verifies Commit-first branch: commit wins task row lock, concurrent cancel queues and cannot overturn completed terminal state', async () => {
      const committer = createCommitter();
      const task = await claimForAgent('commit-first-race', 'worker-commit-first');
      const taskId = task.lease.taskId;

      const staged = await blobs.stage(
        tenant.tenantId,
        Buffer.from('commit-first race output'),
        'text/plain',
      );

      const commitRequest: CommitStepRequest = {
        operationId: `op:commit-first:${taskId}`,
        mode: 'result',
        artifacts: [{ artifactId: staged.stagedId, staged }],
      };

      const barrierClassId = prng.nextInt(10_000, 99_999);
      const barrierObjId = prng.nextInt(10_000, 99_999);
      const funcName = `pause_commit_${barrierClassId}`;
      const triggerName = `${funcName}_trg`;

      const barrierClient = await db.pool.connect();
      await barrierClient.query('SELECT pg_advisory_lock($1, $2)', [barrierClassId, barrierObjId]);

      try {
        await db.pool.query(`
          CREATE OR REPLACE FUNCTION ${funcName}()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            PERFORM pg_advisory_lock(${barrierClassId}, ${barrierObjId});
            RETURN NEW;
          END;
          $$;

          CREATE TRIGGER ${triggerName}
            BEFORE INSERT ON artifacts
            FOR EACH ROW EXECUTE FUNCTION ${funcName}();
        `);

        // 1. 启动 commitStep（持有 tasks 行锁后，在 INSERT INTO artifacts 处等待 advisory lock）
        const commitPromise = committer.commitStep(task.grant, commitRequest);

        // 2. 确定性等待 commitStep 持有 tasks 行锁并进入 advisory lock 阻塞
        await withTimeout(
          (async () => {
            while (true) {
              const res = await db.adminPool.query<{ pid: number }>(
                `SELECT pid FROM pg_locks
                  WHERE locktype = 'advisory'
                    AND classid = $1
                    AND objid = $2
                    AND NOT granted`,
                [barrierClassId, barrierObjId],
              );
              if (res.rows.length > 0) {
                break;
              }
              await new Promise((r) => setTimeout(r, 20));
            }
          })(),
          5_000,
          'waiting for commitStep to hold task lock and pause on advisory lock',
        );

        // 3. 此时 commitStep 已经持有 tasks 行的 FOR UPDATE 锁。
        // 并发发起 tasks.cancel，由于行锁已被占用，cancel 必将被排队等待在 tasks 行锁上
        const cancelPromise = tasks.cancel(ctx, taskId);

        // 4. 等待 cancel 请求排队在 row-lock 后
        await new Promise((r) => setTimeout(r, 50));

        // 5. 释放 advisory lock，允许 commitStep 继续完成事务提交
        await barrierClient.query('SELECT pg_advisory_unlock($1, $2)', [
          barrierClassId,
          barrierObjId,
        ]);

        // 6. 两者并发结束
        const [commitResult, cancelOutcome] = await Promise.all([commitPromise, cancelPromise]);

        // 7. 严格断言 Commit-first 路径不变量：
        // a. commitStep 成功落库
        expect(commitResult.replayed).toBe(false);

        // b. cancel 感知到任务已处于终态 (completed)，返回 terminal: true 且无多余取消
        expect(cancelOutcome.terminal).toBe(true);
        expect(cancelOutcome.status).toBe('completed');
        expect(cancelOutcome.cancelRequested).toBe(false);

        // c. 数据库中 Task 状态严格为 completed
        const taskInDb = await readTask(db.observerPool, tenant.tenantId, taskId);
        expect(taskInDb.status).toBe('completed');

        // d. 审计事件流中，terminal 事件有且仅有 1 个，且为 completed，绝无 cancelled 事件
        const events = await listEventSnapshots(db.observerPool, tenant.tenantId, taskId);
        const terminalEvents = events.filter((e) =>
          ['completed', 'cancelled', 'failed'].includes(e.phase),
        );
        expect(terminalEvents).toHaveLength(1);
        expect(terminalEvents[0]?.phase).toBe('completed');
      } finally {
        await barrierClient.query('SELECT pg_advisory_unlock_all()');
        barrierClient.release();
        await db.pool.query(`
          DROP TRIGGER IF EXISTS ${triggerName} ON artifacts;
          DROP FUNCTION IF EXISTS ${funcName}();
        `);
      }
    });

    // -------------------------------------------------------------------------
    // 5.2 Cancel-first 路径：tasks.cancel 率先获取行锁并落库 cancel_requested_at，
    // 并发 commitStep 随后到达排队，获取锁后识别取消意图，坚决返回 CANCELLED 错误，
    // 零非法写入，Worker 协同退出，最终单一 cancelled 终态
    // -------------------------------------------------------------------------
    it('verifies Cancel-first branch: cancel wins task row lock, commit receives CANCELLED, zero artifacts committed, and task converges to cancelled', async () => {
      const committer = createCommitter();
      const task = await claimForAgent('cancel-first-race', 'worker-cancel-first');
      const taskId = task.lease.taskId;

      const staged = await blobs.stage(
        tenant.tenantId,
        Buffer.from('cancel-first race output'),
        'text/plain',
      );

      const commitRequest: CommitStepRequest = {
        operationId: `op:cancel-first:${taskId}`,
        mode: 'result',
        artifacts: [{ artifactId: staged.stagedId, staged }],
      };

      const barrierClassId = prng.nextInt(10_000, 99_999);
      const barrierObjId = prng.nextInt(10_000, 99_999);
      const funcName = `pause_cancel_${barrierClassId}`;
      const triggerName = `${funcName}_trg`;

      const barrierClient = await db.pool.connect();
      await barrierClient.query('SELECT pg_advisory_lock($1, $2)', [barrierClassId, barrierObjId]);

      try {
        await db.pool.query(`
          CREATE OR REPLACE FUNCTION ${funcName}()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.cancel_requested_at IS NOT NULL AND OLD.cancel_requested_at IS NULL THEN
              PERFORM pg_advisory_lock(${barrierClassId}, ${barrierObjId});
            END IF;
            RETURN NEW;
          END;
          $$;

          CREATE TRIGGER ${triggerName}
            AFTER UPDATE ON tasks
            FOR EACH ROW EXECUTE FUNCTION ${funcName}();
        `);

        // 1. 启动 tasks.cancel（持有 tasks 行锁并写入 cancel_requested_at 后，在 trigger 处暂停）
        const cancelPromise = tasks.cancel(ctx, taskId);

        // 2. 确定性等待 cancel 进入 advisory lock 等待
        await withTimeout(
          (async () => {
            while (true) {
              const res = await db.adminPool.query<{ pid: number }>(
                `SELECT pid FROM pg_locks
                  WHERE locktype = 'advisory'
                    AND classid = $1
                    AND objid = $2
                    AND NOT granted`,
                [barrierClassId, barrierObjId],
              );
              if (res.rows.length > 0) {
                break;
              }
              await new Promise((r) => setTimeout(r, 20));
            }
          })(),
          5_000,
          'waiting for tasks.cancel to write cancel_requested_at and pause on advisory lock',
        );

        // 3. 此时 tasks.cancel 已经锁住 tasks 行并记录了 cancel_requested_at。
        // 并发发起 committer.commitStep，commitStep 将排队在 tasks 行锁上
        const commitPromise = committer.commitStep(task.grant, commitRequest);
        commitPromise.catch(() => {}); // 避免在 await cancelPromise 期间因提前 reject 产生 unhandled rejection

        // 4. 等待 commitStep 排队在 row-lock 后
        await new Promise((r) => setTimeout(r, 50));

        // 5. 释放 advisory lock，允许 tasks.cancel 提交事务
        await barrierClient.query('SELECT pg_advisory_unlock($1, $2)', [
          barrierClassId,
          barrierObjId,
        ]);

        // 6. 等待 cancel 事务成功提交并返回
        const cancelOutcome = await cancelPromise;
        expect(cancelOutcome.terminal).toBe(false);
        expect(cancelOutcome.cancelRequested).toBe(true);

        // 7. commitStep 获取到锁后，发现 cancel_requested_at 已落库，必须被拒绝并抛出 CANCELLED
        await expect(commitPromise).rejects.toMatchObject({
          code: 'CANCELLED',
        });

        // 8. 验证零非法提交：artifacts 关系表中绝无此 staged artifact
        const artifactsCheck = await db.observerPool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM artifacts WHERE tenant_id = $1 AND task_id = $2',
          [tenant.tenantId, taskId],
        );
        expect(Number(artifactsCheck.rows[0]?.count ?? '0')).toBe(0);

        // 9. Worker 感知到 CANCELLED 错误后，协同完成取消收敛
        const finishRes = await queue.finish(task.lease, 'cancelled');
        expect(finishRes).toBe(true);

        // 10. 验证最终数据库不变量：
        // a. Task 终态严格为 cancelled
        const finalTask = await readTask(db.observerPool, tenant.tenantId, taskId);
        expect(finalTask.status).toBe('cancelled');

        // b. 审计事件流中，terminal 事件有且仅有 1 个，且为 cancelled，绝无 completed 事件
        const events = await listEventSnapshots(db.observerPool, tenant.tenantId, taskId);
        const terminalEvents = events.filter((e) =>
          ['completed', 'cancelled', 'failed'].includes(e.phase),
        );
        expect(terminalEvents).toHaveLength(1);
        expect(terminalEvents[0]?.phase).toBe('cancelled');
      } finally {
        await barrierClient.query('SELECT pg_advisory_unlock_all()');
        barrierClient.release();
        await db.pool.query(`
          DROP TRIGGER IF EXISTS ${triggerName} ON tasks;
          DROP FUNCTION IF EXISTS ${funcName}();
        `);
      }
    });
  });
});
