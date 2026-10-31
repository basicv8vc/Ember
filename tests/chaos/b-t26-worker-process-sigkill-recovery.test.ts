import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext, TaskCommand } from '@ember/domain';
import {
  LocalBlobStore,
  PostgresAgentRepository,
  PostgresBlobStore,
  PostgresTaskRepository,
  PostgresWorkspaceStore,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from '../integration/support/database.js';
import { createTenantFixture, type TenantFixture } from '../integration/support/fixtures.js';
import { listEventSnapshots, listRuns, readTask } from '../integration/support/leases.js';
import {
  cleanupAllWorkerSubprocesses,
  createChaosPrng,
  dumpFailureDiagnostics,
  globalFaultRecorder,
  spawnWorkerSubprocess,
  withTimeout,
} from './harness/index.js';

/**
 * B-T26 / P0B-10B: Real Worker OS Process Crash (SIGKILL) & Autonomous Recovery Chaos Verification
 *
 * 核心验证：
 * 1. 真实 Worker OS 进程（基于 child_process.spawn 启动真实的 apps/worker/src/index.ts）执行任务；
 * 2. 确定性同步屏障：在 Step 1 (produce) Checkpoint 提交入库后、Step 2 (publish) 提交前，利用 PostgreSQL
 *    Advisory Lock 精准拦截 Worker 后端，保证无竞态、无盲等；
 * 3. 强杀真实 Worker OS 进程：向明确持有的子进程 PID 发送 SIGKILL，验证操作系统进程终止，socket 断开，
 *    PostgreSQL 事务安全回滚，但已提交的 Step 1 Checkpoint 与 Artifact 完整留存；
 * 4. 真实租约自然过期与真实 Reaper 收敛：不依赖 SQL 假时间回拨，依赖真实的 Wall Clock 租约过期；
 * 5. 重启新 Worker 真实 OS 进程：自主扫描并接管任务，自动检测已有 Checkpoint 并断点续传（Resume），
 *    绝对不重跑 Step 1 (produce)，直接完成 Step 2 (publish)，达成终态 completed；
 * 6. 全量多实体数据对账与不变量证明：Task, Run, Checkpoint, Event, Workspace, Blob 完整一致性。
 */

describe('B-T26 / P0B-10B: Real Worker OS Process SIGKILL & Autonomous Recovery', () => {
  let db: TestDatabase;
  let agents: PostgresAgentRepository;
  let tasks: PostgresTaskRepository;
  let workspaces: PostgresWorkspaceStore;
  let tenant: TenantFixture;
  let ctx: AuthContext;
  let prng: ReturnType<typeof createChaosPrng>;

  let blobRootDir: string;
  let localBlobs: LocalBlobStore;
  let postgresBlobs: PostgresBlobStore;

  beforeAll(async () => {
    prng = createChaosPrng();
    db = await createTestDatabase({ maxConnections: 24 });
    agents = new PostgresAgentRepository(db.pool);
    tasks = new PostgresTaskRepository(db.pool);
    workspaces = new PostgresWorkspaceStore(db.pool);

    tenant = await createTenantFixture(db.pool, 'b-t26-sigkill-tenant');
    ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 };

    blobRootDir = await mkdtemp(path.join(tmpdir(), 'ember-chaos-sigkill-'));
    localBlobs = new LocalBlobStore({ rootDir: blobRootDir });
    postgresBlobs = new PostgresBlobStore(db.pool, localBlobs);
  }, 30_000);

  afterAll(async () => {
    await cleanupAllWorkerSubprocesses();
    if (blobRootDir.startsWith(tmpdir()) && blobRootDir.includes('ember-chaos-sigkill-')) {
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

  // ---------------------------------------------------------------------------
  // Scenario 1: Step 1 落库后 SIGKILL 强杀真实 Worker 进程，新 Worker 自主恢复并跳过 Step 1
  // ---------------------------------------------------------------------------
  it('SIGKILLs real Worker OS process after Step 1 checkpoint; recovered Worker resumes from checkpoint without re-running Step 1', async () => {
    const agent = await agents.create(ctx, { name: `sigkill-agent-${randomUUID()}` });
    const key = `sigkill-resume-${randomUUID()}`;
    const command: TaskCommand = {
      agentId: agent.agentId,
      kind: 'mock.chat',
      input: { prompt: 'real-worker-process-sigkill-test' },
      idempotencyKey: key,
    };

    // 1. 创建待执行的 Task
    const createdReceipt = await tasks.create(ctx, command);
    const taskId = createdReceipt.taskId;

    // 2. 建立同步屏障：在 step_checkpoints 上安装拦截触发器，在 step_id = 'publish' 提交前阻塞
    const barrierClassId = prng.nextInt(10_000, 99_999);
    const barrierObjId = prng.nextInt(10_000, 99_999);
    const funcName = `pause_pub_${barrierClassId}`;
    const triggerName = `${funcName}_trg`;

    const barrierClient = await db.pool.connect();
    await barrierClient.query('SELECT pg_advisory_lock($1, $2)', [barrierClassId, barrierObjId]);

    let worker1Pid: number | undefined;

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

      // 3. 启动真实 Worker 1 子进程（短租约 2s，心跳 300ms，轮询 200ms）
      const worker1 = await spawnWorkerSubprocess({
        schema: db.schema,
        blobRootDir,
        workerId: 'worker-proc-sigkill-target',
        leaseDurationMs: 2_000,
        heartbeatIntervalMs: 300,
        intervalMs: 200,
        errorBackoffMs: 200,
        retryBaseMs: 200,
      });

      worker1Pid = worker1.pid;
      expect(worker1Pid).toBeGreaterThan(0);
      expect(worker1.isAlive()).toBe(true);

      // 4. 等待 Worker 1 执行完 Step 1 (produce) 并进入 Step 2 (publish) 的行锁/咨询锁等待
      // 在 pg_locks 中确定性检测等待者
      let blockedBackendPid: number | undefined;
      await withTimeout(
        (async () => {
          while (blockedBackendPid === undefined) {
            const res = await db.adminPool.query<{ pid: number }>(
              `SELECT pid FROM pg_locks
                WHERE locktype = 'advisory'
                  AND classid = $1
                  AND objid = $2
                  AND NOT granted`,
              [barrierClassId, barrierObjId],
            );
            if (res.rows.length > 0 && res.rows[0]?.pid !== undefined) {
              blockedBackendPid = res.rows[0].pid;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
        })(),
        10_000,
        'waiting for Worker 1 to reach publish step barrier',
      );

      expect(blockedBackendPid).toBeDefined();

      // 此时 Worker 1 已完成了 Step 1 (produce) 的持久化落库
      expect(await countCheckpoints(taskId)).toBe(1);
      const preKillCheckpoints = await listTaskCheckpoints(taskId);
      expect(preKillCheckpoints[0]?.step_id).toBe('produce');
      expect(preKillCheckpoints[0]?.attempt).toBe(1);

      const taskDuringRun = await readTask(db.observerPool, tenant.tenantId, taskId);
      expect(taskDuringRun.status).toBe('running');
      expect(taskDuringRun.attempt_count).toBe(1);

      globalFaultRecorder.record({
        testName: 'B-T26-PROCESS-SIGKILL',
        faultType: 'WORKER_SUBPROCESS_SIGKILL',
        point: 'after_produce_checkpoint_before_publish_commit',
        targetId: taskId,
        details: { worker1Pid, blockedBackendPid, barrierClassId, barrierObjId },
        seed: prng.seed,
      });

      // 5. 【核心故障注入】向专属 Worker 1 OS 子进程发送 SIGKILL
      const exitResult = await worker1.sigkill();
      expect(exitResult.signal).toBe('SIGKILL');
      expect(worker1.isAlive()).toBe(false);
    } finally {
      // 释放屏障锁并移除触发器，为 Worker 2 扫清障碍
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

    // 7. 强杀后的 DB 不变量校验：
    // - Step 1 Checkpoint 完好无损；
    // - Step 2 未提交（零 publish checkpoint）；
    // - 零 completed 事件；
    // - Task 依然处于 running，等待租约到期。
    expect(await countCheckpoints(taskId)).toBe(1);
    const postKillTask = await readTask(db.observerPool, tenant.tenantId, taskId);
    expect(postKillTask.status).toBe('running');

    // 8. 等待真实租约自然到期（配置为 2_000ms）
    const leaseRemainingMs = postKillTask.lease_expires_at
      ? postKillTask.lease_expires_at.getTime() - Date.now()
      : 0;
    if (leaseRemainingMs > 0) {
      await new Promise((r) => setTimeout(r, leaseRemainingMs + 200));
    }

    // 9. 启动恢复 Worker 2 子进程（新 PID，独立实例）
    const worker2 = await spawnWorkerSubprocess({
      schema: db.schema,
      blobRootDir,
      workerId: 'worker-proc-recovered-resumer',
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 300,
      intervalMs: 200,
      errorBackoffMs: 200,
      retryBaseMs: 200,
    });

    const worker2Pid = worker2.pid;
    expect(worker2Pid).toBeGreaterThan(0);
    expect(worker2Pid).not.toBe(worker1Pid);

    // 10. 等待 Task 在 Worker 2 治理下收敛并顺利推进至 completed 终态
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
      'waiting for recovered Worker 2 to complete the task',
    );

    // 优雅停机 Worker 2
    await worker2.sigterm();

    // 11. 【全量多实体不变量验证】
    // (a) Task 表断言：
    expect(completedTask.status).toBe('completed');
    expect(completedTask.attempt_count).toBe(2);
    expect(completedTask.lease_expires_at).toBeNull();

    // (b) Step Checkpoints 深度断言：
    // 严格只有 2 个 Checkpoint，分别对应 produce 与 publish
    expect(await countCheckpoints(taskId)).toBe(2);
    const finalCheckpoints = await listTaskCheckpoints(taskId);
    expect(finalCheckpoints).toHaveLength(2);

    const produceCp = finalCheckpoints[0]!;
    expect(produceCp.step_id).toBe('produce');
    expect(produceCp.step_sequence).toBe(1);
    // 证明核心不变量：produce 步骤的 Checkpoint 依然保留了 Attempt 1 的元数据，绝未被 Worker 2 重新生成！
    expect(produceCp.attempt).toBe(1);

    const publishCp = finalCheckpoints[1]!;
    expect(publishCp.step_id).toBe('publish');
    expect(publishCp.step_sequence).toBe(2);
    expect(publishCp.attempt).toBe(2);
    expect(publishCp.run_id).not.toBe(produceCp.run_id);

    // (c) Runs 状态流转断言：
    const runs = await listRuns(db.observerPool, tenant.tenantId, taskId);
    expect(runs).toHaveLength(2);

    // Run 1 (被 SIGKILL 的旧 Run) 必须被 Reaper 收敛为 lease_expired
    const run1 = runs.find((r) => r.attempt === 1);
    expect(run1).toBeDefined();
    expect(run1?.status).toBe('lease_expired');
    expect(run1?.worker_id).toBe('worker-proc-sigkill-target');
    expect(run1?.finished_at).not.toBeNull();

    // Run 2 (恢复接管的新 Run) 必须顺利达到 succeeded
    const run2 = runs.find((r) => r.attempt === 2);
    expect(run2).toBeDefined();
    expect(run2?.status).toBe('succeeded');
    expect(run2?.worker_id).toBe('worker-proc-recovered-resumer');
    expect(run2?.finished_at).not.toBeNull();

    // (d) 事件流顺序与单终态断言：
    const events = await listEventSnapshots(db.observerPool, tenant.tenantId, taskId);
    const phases = events.map((e) => e.phase);
    // 呈现完整的分布式生命周期：
    // accepted -> leased (attempt 1) -> started -> progress (Step 1 committed)
    // -> retry_scheduled (reaped) -> retry_scheduled (promoted) -> leased (attempt 2) -> started -> completed
    expect(phases).toEqual([
      'accepted',
      'leased',
      'started',
      'progress',
      'retry_scheduled',
      'retry_scheduled',
      'leased',
      'started',
      'completed',
    ]);

    // completed 终态事件严格为 1
    const completedEvents = events.filter((e) => e.phase === 'completed');
    expect(completedEvents).toHaveLength(1);

    // (e) Workspace CAS 与版本单调递增断言：
    const ws = await workspaces.loadForRun(tenant.tenantId, agent.agentId);
    expect(ws.version).toBe(1);
    expect(ws.manifest.files.length).toBeGreaterThanOrEqual(1);

    // (f) 产物内容完整性验证：
    const artifactMeta = (publishCp.artifacts as Array<{ sha256: string; size: number }>)[0]!;
    expect(artifactMeta).toBeDefined();
    const isBlobIntact = await postgresBlobs.verifyContent(
      tenant.tenantId,
      artifactMeta.sha256,
      artifactMeta.size,
    );
    expect(isBlobIntact).toBe(true);

    // 检查 Worker 2 的运行日志，确认记录了断点续传证据
    const worker2Logs = worker2.getLogs();
    expect(worker2Logs).toContain('durable step already committed; resuming');
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: 在 Step 1 (produce) 提交前强杀 Worker 进程，事务彻底回滚，重启后全新执行
  // ---------------------------------------------------------------------------
  it('SIGKILLs Worker OS process before any checkpoint is committed; rolls back completely and new Worker runs both steps cleanly', async () => {
    const agent = await agents.create(ctx, { name: `sigkill-early-agent-${randomUUID()}` });
    const key = `sigkill-early-${randomUUID()}`;
    const command: TaskCommand = {
      agentId: agent.agentId,
      kind: 'mock.chat',
      input: { prompt: 'early-sigkill-before-checkpoint' },
      idempotencyKey: key,
    };

    const createdReceipt = await tasks.create(ctx, command);
    const taskId = createdReceipt.taskId;

    // 拦截点：在 step_id = 'produce' Checkpoint 插入前挂起
    const barrierClassId = prng.nextInt(10_000, 99_999);
    const barrierObjId = prng.nextInt(10_000, 99_999);
    const funcName = `pause_produce_${barrierClassId}`;
    const triggerName = `${funcName}_trg`;

    const barrierClient = await db.pool.connect();
    await barrierClient.query('SELECT pg_advisory_lock($1, $2)', [barrierClassId, barrierObjId]);

    try {
      await db.pool.query(`
        CREATE OR REPLACE FUNCTION ${funcName}()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.step_id = 'produce' THEN
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
        workerId: 'worker-early-sigkill',
        leaseDurationMs: 2_000,
        heartbeatIntervalMs: 300,
        intervalMs: 200,
        errorBackoffMs: 200,
        retryBaseMs: 200,
      });

      // 等待到达 produce 屏障
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
        'waiting for Worker 1 to reach produce checkpoint barrier',
      );

      // 强杀 Worker 1
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

    // 验证崩溃前没有提交任何 Checkpoint
    expect(await countCheckpoints(taskId)).toBe(0);

    // 等待租约到期
    const task = await readTask(db.observerPool, tenant.tenantId, taskId);
    const leaseRemainingMs = task.lease_expires_at
      ? task.lease_expires_at.getTime() - Date.now()
      : 0;
    if (leaseRemainingMs > 0) {
      await new Promise((r) => setTimeout(r, leaseRemainingMs + 200));
    }

    // 启动 Worker 2 完成整个任务
    const worker2 = await spawnWorkerSubprocess({
      schema: db.schema,
      blobRootDir,
      workerId: 'worker-early-recovery',
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 300,
      intervalMs: 200,
      errorBackoffMs: 200,
      retryBaseMs: 200,
    });

    await withTimeout(
      (async () => {
        while (true) {
          const t = await readTask(db.observerPool, tenant.tenantId, taskId);
          if (t.status === 'completed') return t;
          await new Promise((r) => setTimeout(r, 100));
        }
      })(),
      12_000,
      'waiting for Worker 2 to complete task from scratch',
    );

    await worker2.sigterm();

    // 最终产物：Exactly 2 个 Checkpoint，两个都在 Attempt 2 下生成
    expect(await countCheckpoints(taskId)).toBe(2);
    const checkpoints = await listTaskCheckpoints(taskId);
    expect(checkpoints[0]?.step_id).toBe('produce');
    expect(checkpoints[0]?.attempt).toBe(2);
    expect(checkpoints[1]?.step_id).toBe('publish');
    expect(checkpoints[1]?.attempt).toBe(2);

    const finalTask = await readTask(db.observerPool, tenant.tenantId, taskId);
    expect(finalTask.status).toBe('completed');
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: 独立的 Reaper 进程与 Poll 进程协同：强杀 Poll Worker，Reaper 进程自主识别并收敛
  // ---------------------------------------------------------------------------
  it('demonstrates standalone Reaper process independently converging a task after Poll Worker is SIGKILLed', async () => {
    const agent = await agents.create(ctx, { name: `sigkill-reaper-agent-${randomUUID()}` });
    const key = `sigkill-reaper-${randomUUID()}`;
    const command: TaskCommand = {
      agentId: agent.agentId,
      kind: 'mock.chat',
      input: { prompt: 'reaper-standalone-recovery-test' },
      idempotencyKey: key,
    };

    const createdReceipt = await tasks.create(ctx, command);
    const taskId = createdReceipt.taskId;

    // 1. 启动一个纯 Reaper 子进程（mode: 'reaper-only'）
    const reaperProcess = await spawnWorkerSubprocess({
      schema: db.schema,
      blobRootDir,
      workerId: 'standalone-reaper-proc',
      mode: 'reaper-only',
      intervalMs: 200,
      errorBackoffMs: 200,
    });

    // 2. 建立同步屏障拦截 Poll Worker
    const barrierClassId = prng.nextInt(10_000, 99_999);
    const barrierObjId = prng.nextInt(10_000, 99_999);
    const funcName = `pause_reaper_test_${barrierClassId}`;
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

      // 3. 启动 Poll Worker
      const pollWorker = await spawnWorkerSubprocess({
        schema: db.schema,
        blobRootDir,
        workerId: 'target-poll-worker',
        leaseDurationMs: 2_000,
        heartbeatIntervalMs: 300,
        intervalMs: 200,
        errorBackoffMs: 200,
        retryBaseMs: 200,
      });

      // 等待到达屏障
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
        'waiting for Poll Worker to block',
      );

      // 4. 强杀 Poll Worker！
      await pollWorker.sigkill();
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

    // 5. 验证独立的 Reaper 进程自动检测到租约过期，并将任务收敛至 retryable_failed / queued
    const reapedTask = await withTimeout(
      (async () => {
        while (true) {
          const t = await readTask(db.observerPool, tenant.tenantId, taskId);
          if (t.status === 'retryable_failed' || t.status === 'queued') {
            return t;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })(),
      8_000,
      'waiting for standalone reaper process to reap the crashed task',
    );

    expect(['retryable_failed', 'queued']).toContain(reapedTask.status);

    // 停止 Reaper
    await reaperProcess.sigterm();
  });
});
