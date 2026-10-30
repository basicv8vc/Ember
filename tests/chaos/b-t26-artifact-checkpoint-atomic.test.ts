import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommitStepRequest, RunExecutionContext, RunGrant } from '@ember/contracts';
import type { AuthContext, LeasedRun } from '@ember/domain';
import {
  LocalBlobStore,
  PostgresAgentRepository,
  PostgresArtifactStore,
  PostgresBlobStore,
  PostgresCheckpointStore,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresRunResultCommitter,
  PostgresTaskRepository,
  PostgresWorkspaceStore,
  resolveLeaseQueueConfig,
  type CommitFaultInjector,
  type CommitFaultPoint,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from '../integration/support/database.js';
import { createTenantFixture, type TenantFixture } from '../integration/support/fixtures.js';
import {
  createQueuedTask,
  databaseNow,
  listEventSnapshots,
  parkOtherOpenTasks,
  readTask,
} from '../integration/support/leases.js';
import { grantOfContext } from '../integration/support/p0b06.js';
import { createChaosPrng, globalFaultRecorder, simulateWorkerCrash } from './harness/index.js';

/**
 * B-T26: Chaos Testing — Artifact/Checkpoint 关键边界崩溃注入与原子性恢复验证
 *
 * 核心验证：
 * 1. 物理 Staging 完成但 DB Commit 前 Crash：零行元数据写入，用户查询 Artifact 为空（杜绝孤儿可见）；
 * 2. Checkpoint / Event 提交关键边界 Crash：事务全量回滚，无半可见 Checkpoint/Workspace 版本；
 * 3. 故障注入后崩溃模拟与恢复（Crash Recovery）：
 *    - Lease 过期后 Reaper 收敛，新 Run (更高 Epoch) 接管；
 *    - 验证 Step 1 (progress) 已提交 Checkpoint 在 Crash 后被新 Run 识别并重用，不重跑已确认步骤；
 * 4. Commit 后丢 ACK (after_commit Crash)：数据库已安全持久化，重试返回幂等 Receipt，不重复推进版本与终态事件。
 */

const LEASE_MS = 2_000;
const EXECUTOR_VERSION = 'deterministic-executor@1';

describe('B-T26: Artifact & Checkpoint Atomicity Chaos Verification', () => {
  let db: TestDatabase;
  let agents: PostgresAgentRepository;
  let tasks: PostgresTaskRepository;
  let tenant: TenantFixture;
  let ctx: AuthContext;
  let agentId: string;
  let queue: PostgresLeaseQueue;
  let reader: PostgresRunExecutionContextReader;
  let prng: ReturnType<typeof createChaosPrng>;

  let blobRootDir: string;
  let localFiles: LocalBlobStore;
  let blobs: PostgresBlobStore;
  let artifacts: PostgresArtifactStore;
  let checkpoints: PostgresCheckpointStore;
  let workspaces: PostgresWorkspaceStore;

  beforeAll(async () => {
    prng = createChaosPrng();
    db = await createTestDatabase({ maxConnections: 16 });
    agents = new PostgresAgentRepository(db.pool);
    tasks = new PostgresTaskRepository(db.pool);

    tenant = await createTenantFixture(db.pool, 'b-t26 tenant');
    ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 };
    agentId = (await agents.create(ctx, { name: 'b-t26 agent' })).agentId;

    queue = new PostgresLeaseQueue(db.pool, {
      leaseDurationMs: LEASE_MS,
      heartbeatIntervalMs: 500,
      baseDelayMs: 100,
      capDelayMs: 200,
      reaperBatchSize: 10,
    });
    reader = new PostgresRunExecutionContextReader(db.pool);

    // 受限临时 Artifact 目录
    blobRootDir = await mkdtemp(path.join(tmpdir(), 'ember-chaos-blobs-'));
    localFiles = new LocalBlobStore({ rootDir: blobRootDir });
    blobs = new PostgresBlobStore(db.pool, localFiles);
    artifacts = new PostgresArtifactStore(db.pool, blobs);
    checkpoints = new PostgresCheckpointStore(db.pool);
    workspaces = new PostgresWorkspaceStore(db.pool);
  }, 30_000);

  afterAll(async () => {
    // 清理受限临时 Artifact 目录，严格限定只清理本测试创建的目录
    if (blobRootDir.startsWith(tmpdir()) && blobRootDir.includes('ember-chaos-blobs-')) {
      await rm(blobRootDir, { recursive: true, force: true });
    }
    await db?.close();
  });

  interface ClaimedTask {
    lease: LeasedRun;
    context: RunExecutionContext;
    grant: RunGrant;
  }

  async function claim(label: string): Promise<ClaimedTask> {
    const created = await createQueuedTask(tasks, ctx, agentId, label);
    await parkOtherOpenTasks(db.pool, created.taskId);
    const now = await databaseNow(db.pool);
    const lease = await queue.claimNext('worker-b-t26', now);
    if (lease === null) {
      throw new Error(`failed to claim task ${created.taskId}`);
    }
    const context = await reader.read(lease, now);
    return { lease, context, grant: grantOfContext(context) };
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

  async function countCheckpoints(taskId: string): Promise<number> {
    const res = await db.observerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  async function countReceipts(taskId: string): Promise<number> {
    const res = await db.observerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM operation_receipts WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  async function countArtifacts(taskId: string): Promise<number> {
    const res = await db.observerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM artifacts WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  // ---------------------------------------------------------------------------
  // 1. 物理 Staging 与元数据提交各关键边界崩溃注入
  // ---------------------------------------------------------------------------
  describe('Crash Injection at Commit Boundaries', () => {
    const boundaryPoints: readonly CommitFaultPoint[] = [
      'before_artifact_insert',
      'before_workspace_cas',
      'before_checkpoint_insert',
      'before_event',
      'before_receipt',
      'before_commit',
    ];

    for (const point of boundaryPoints) {
      it(`rolls back completely when crash is injected at ${point}`, async () => {
        const attempt = await claim(`crash-boundary-${point}`);
        const content = `boundary-test-${point}-${randomUUID()}`;

        // 1. 物理 Staging 成功，本地文件已落盘
        const staged = await blobs.stage(tenant.tenantId, Buffer.from(content), 'text/plain');

        const request: CommitStepRequest = {
          operationId: `op:progress:${point}:${randomUUID()}`,
          mode: 'progress',
          artifacts: [{ artifactId: staged.stagedId, staged }],
          checkpoint: {
            stepId: 'produce',
            inputDigest: 'a'.repeat(64),
            executorVersion: EXECUTOR_VERSION,
            cursor: { point },
            artifacts: [
              {
                artifactId: staged.stagedId,
                sha256: staged.sha256,
                size: staged.size,
                mediaType: staged.mediaType,
                path: 'output.txt',
              },
            ],
            externalEffects: [],
          },
        };

        const committer = createCommitter((hitPoint) => {
          if (hitPoint === point) {
            globalFaultRecorder.record({
              testName: 'B-T26',
              faultType: 'CRASH_AT_BOUNDARY',
              point: hitPoint,
              targetId: attempt.lease.taskId,
              seed: prng.seed,
            });
            throw new Error(`CHAOS_INJECTED_FAILURE_AT_${point.toUpperCase()}`);
          }
        });

        // 2. 执行 commitStep，必须抛出 DB_UNAVAILABLE
        await expect(committer.commitStep(attempt.grant, request)).rejects.toMatchObject({
          code: 'DB_UNAVAILABLE',
        });

        // 3. 验证原子性与零可见副作用不变量：
        // 数据库事务回滚：无 Checkpoint、无 Receipt、无 Artifact 元数据
        expect(await countCheckpoints(attempt.lease.taskId)).toBe(0);
        expect(await countReceipts(attempt.lease.taskId)).toBe(0);
        expect(await countArtifacts(attempt.lease.taskId)).toBe(0);

        // 验证用户/API 级别无法查询到该未提交 Artifact（杜绝孤儿可见）
        const userVisibleArtifacts = await artifacts.listForTask(ctx, attempt.lease.taskId);
        expect(userVisibleArtifacts).toHaveLength(0);

        // Task 状态依旧为 running
        const task = await readTask(db.observerPool, tenant.tenantId, attempt.lease.taskId);
        expect(task.status).toBe('running');
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 2. 崩溃恢复（Crash Recovery）与步骤续跑验证
  // ---------------------------------------------------------------------------
  describe('Crash Recovery & Checkpoint Resume', () => {
    it('survives worker crash after step 1; new run resumes from step 1 checkpoint without redoing it', async () => {
      const attempt1 = await claim('resume-after-crash');
      const committer = createCommitter();

      // Step 1: produce
      const staged1 = await blobs.stage(
        tenant.tenantId,
        Buffer.from('produced step 1 content'),
        'text/plain',
      );
      const produceRequest: CommitStepRequest = {
        operationId: `op:produce:${attempt1.lease.taskId}`,
        mode: 'progress',
        artifacts: [{ artifactId: staged1.stagedId, staged: staged1 }],
        checkpoint: {
          stepId: 'produce',
          inputDigest: '1'.repeat(64),
          executorVersion: EXECUTOR_VERSION,
          cursor: { step: 'produce_done' },
          artifacts: [
            {
              artifactId: staged1.stagedId,
              sha256: staged1.sha256,
              size: staged1.size,
              mediaType: staged1.mediaType,
              path: 'step1.txt',
            },
          ],
          externalEffects: [],
        },
      };

      const receipt1 = await committer.commitStep(attempt1.grant, produceRequest);
      expect(receipt1.checkpointId).not.toBeNull();
      expect(await countCheckpoints(attempt1.lease.taskId)).toBe(1);

      // 模拟 Worker 在完成 Step 1 后突发崩溃（进程强杀，租约过期）
      globalFaultRecorder.record({
        testName: 'B-T26',
        faultType: 'WORKER_CRASH_AFTER_STEP_1',
        point: 'between_step1_and_step2',
        targetId: attempt1.lease.taskId,
        seed: prng.seed,
      });

      await simulateWorkerCrash(db.pool, queue, tenant.tenantId, attempt1.lease);

      // 验证 Task 状态已被 Reaper 收敛为 retryable_failed 或 queued
      const reapedTask = await readTask(db.observerPool, tenant.tenantId, attempt1.lease.taskId);
      expect(['retryable_failed', 'queued']).toContain(reapedTask.status);

      // 重启 Worker 实例：领取重试任务，生成新的 Run 与更高的 Epoch
      await parkOtherOpenTasks(db.pool, attempt1.lease.taskId);
      // 将 next_run_at 调整为当前，确保立即领到
      await db.pool.query(
        "UPDATE tasks SET next_run_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [attempt1.lease.taskId],
      );

      const now = await databaseNow(db.pool);
      const attempt2Lease = await queue.claimNext('worker-b-t26-resumed', now);
      expect(attempt2Lease).not.toBeNull();
      expect(attempt2Lease?.runId).not.toBe(attempt1.lease.runId);
      expect(attempt2Lease?.leaseEpoch).toBeGreaterThan(attempt1.lease.leaseEpoch);

      const attempt2Context = await reader.read(attempt2Lease!, now);
      const attempt2Grant = grantOfContext(attempt2Context);

      // 验证崩溃重启后旧 Run 失去了所有提交权限 (STALE_LEASE)
      await expect(
        committer.commitStep(attempt1.grant, {
          operationId: `stale-attempt-${randomUUID()}`,
          mode: 'result',
          artifacts: [],
        }),
      ).rejects.toMatchObject({ code: 'STALE_LEASE' });

      // 新 Run 读取最新的 Checkpoint：必须能准确读到 Step 1 提交的检查点
      const latestCheckpoint = await checkpoints.loadLatest(attempt2Grant, {
        schemaVersion: 1,
        executorVersion: EXECUTOR_VERSION,
      });

      expect(latestCheckpoint).not.toBeNull();
      expect(latestCheckpoint?.checkpointId).toBe(receipt1.checkpointId);
      expect(latestCheckpoint?.stepId).toBe('produce');
      expect(latestCheckpoint?.cursor).toEqual({ step: 'produce_done' });

      // 校验该 Checkpoint 引用的 Artifact 完整性
      const artifactRef = latestCheckpoint!.artifacts[0]!;
      const isContentIntact = await blobs.verifyContent(
        tenant.tenantId,
        artifactRef.sha256,
        artifactRef.size,
      );
      expect(isContentIntact).toBe(true);

      // 新 Run 绝不重复执行 Step 1，而是直接执行 Step 2 (publish)，并终态完成任务
      const staged2 = await blobs.stage(
        tenant.tenantId,
        Buffer.from('final published content'),
        'text/plain',
      );
      const publishRequest: CommitStepRequest = {
        operationId: `op:publish:${attempt1.lease.taskId}`,
        mode: 'result',
        artifacts: [{ artifactId: staged2.stagedId, staged: staged2 }],
        workspace: {
          expectedVersion: 0,
          manifest: {
            files: [
              {
                path: 'step1.txt',
                artifactId: staged1.stagedId,
                sha256: staged1.sha256,
                size: staged1.size,
              },
              {
                path: 'final.txt',
                artifactId: staged2.stagedId,
                sha256: staged2.sha256,
                size: staged2.size,
              },
            ],
          },
        },
        checkpoint: {
          stepId: 'publish',
          inputDigest: '2'.repeat(64),
          executorVersion: EXECUTOR_VERSION,
          cursor: { step: 'all_completed' },
          artifacts: [
            {
              artifactId: staged2.stagedId,
              sha256: staged2.sha256,
              size: staged2.size,
              mediaType: staged2.mediaType,
              path: 'final.txt',
            },
          ],
          externalEffects: [],
        },
      };

      const finalReceipt = await committer.commitStep(attempt2Grant, publishRequest);
      expect(finalReceipt.replayed).toBe(false);

      // 验证终态不变量：
      // 1. Task 状态变为 completed
      const finalTask = await readTask(db.observerPool, tenant.tenantId, attempt1.lease.taskId);
      expect(finalTask.status).toBe('completed');

      // 2. Checkpoint 数量严格为 2（每个 Step 各一次，无重复）
      expect(await countCheckpoints(attempt1.lease.taskId)).toBe(2);

      // 3. Workspace 版本推进至 1，且包含两步的 Artifact
      const ws = await workspaces.loadForRun(tenant.tenantId, agentId);
      expect(ws.version).toBe(1);
      const paths = ws.manifest.files.map((f) => f.path);
      expect(paths).toEqual(expect.arrayContaining(['step1.txt', 'final.txt']));

      // 4. 事件流中 completed 终态事件严格只有 1 个
      const events = await listEventSnapshots(
        db.observerPool,
        tenant.tenantId,
        attempt1.lease.taskId,
      );
      const completedEvents = events.filter((e) => e.phase === 'completed');
      expect(completedEvents).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. DB Commit 成功但丢 ACK (after_commit Crash)
  // ---------------------------------------------------------------------------
  describe('Lost ACK after Commit (after_commit Crash)', () => {
    it('serves idempotency receipt on retry after ACK loss, with zero duplicate writes or events', async () => {
      const attempt = await claim('lost-ack-b-t26');
      const opId = `op:lost-ack:${randomUUID()}`;

      const staged = await blobs.stage(
        tenant.tenantId,
        Buffer.from('lost ack payload'),
        'text/plain',
      );

      const request: CommitStepRequest = {
        operationId: opId,
        mode: 'result',
        artifacts: [{ artifactId: staged.stagedId, staged }],
      };

      // 注入 after_commit 异常，模拟提交入库后进程崩溃或网络丢包
      const faultCommitter = createCommitter((point) => {
        if (point === 'after_commit') {
          globalFaultRecorder.record({
            testName: 'B-T26',
            faultType: 'LOST_ACK_AFTER_COMMIT',
            point: 'after_commit',
            targetId: attempt.lease.taskId,
            seed: prng.seed,
          });
          throw new Error('SIMULATED_NETWORK_DROP_AFTER_COMMIT');
        }
      });

      // 首次提交由于 after_commit 异常而报错
      await expect(faultCommitter.commitStep(attempt.grant, request)).rejects.toMatchObject({
        code: 'DB_UNAVAILABLE',
      });

      // 数据库中实际已提交成功
      const taskAfterDrop = await readTask(db.observerPool, tenant.tenantId, attempt.lease.taskId);
      expect(taskAfterDrop.status).toBe('completed');

      // 客户端发起幂等重试（正常 committer）
      const normalCommitter = createCommitter();
      const retryReceipt = await normalCommitter.commitStep(attempt.grant, request);

      // 验证重试成功且为重放
      expect(retryReceipt.replayed).toBe(true);
      expect(retryReceipt.artifactIds).toHaveLength(1);

      // 终态事件与 Receipt 严格唯一
      expect(await countReceipts(attempt.lease.taskId)).toBe(1);
      const events = await listEventSnapshots(
        db.observerPool,
        tenant.tenantId,
        attempt.lease.taskId,
      );
      const completedEvents = events.filter((e) => e.phase === 'completed');
      expect(completedEvents).toHaveLength(1);
    });
  });
});
