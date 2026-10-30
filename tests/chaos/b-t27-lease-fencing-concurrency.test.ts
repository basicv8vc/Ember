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
    const now = await databaseNow(db.pool);
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
});
