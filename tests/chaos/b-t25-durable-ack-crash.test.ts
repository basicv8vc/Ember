import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDomainError, type AuthContext, type DomainError, type TaskCommand } from '@ember/domain';
import {
  PostgresAgentRepository,
  PostgresLeaseQueue,
  PostgresTaskRepository,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from '../integration/support/database.js';
import { createTenantFixture, type TenantFixture } from '../integration/support/fixtures.js';
import { parkOtherOpenTasks, readTask } from '../integration/support/leases.js';
import {
  createBarrier,
  createChaosPrng,
  globalFaultRecorder,
  terminateBackendPid,
  withTimeout,
} from './harness/index.js';

/**
 * B-T25: Chaos Testing — DB Ack 前/后 Crash 与恢复验证
 *
 * 核心验证：
 * 1. DB Ack 前进程/连接崩溃：事务完全回滚，不丢 Task，不遗留半提交行，重试后正常创建且幂等不变量成立；
 * 2. DB Ack 后进程崩溃（Ack 丢失）：任务已安全落库，客户端重放获得原 Task ID (replayed: true)，
 *    不重复创建逻辑 Task，不重复发射 accepted 事件；
 * 3. 冲突防御：Ack 成功后同 Key 不同 Payload 的重试坚决返回 IDEMPOTENCY_CONFLICT，原 Task 不受影响；
 * 4. 状态推进下的幂等性：Task 已被 Worker 领取推进至 running 或 completed 时，创建重试依然安全返回且不回退状态。
 */

describe('B-T25: Durable Ack Crash & Idempotency Chaos Verification', () => {
  let db: TestDatabase;
  let agents: PostgresAgentRepository;
  let tasks: PostgresTaskRepository;
  let tenant: TenantFixture;
  let ctx: AuthContext;
  let agentId: string;
  let prng: ReturnType<typeof createChaosPrng>;

  beforeAll(async () => {
    prng = createChaosPrng();
    db = await createTestDatabase({ maxConnections: 16 });
    // Ignore unexpected client terminations caused by intentional pg_terminate_backend fault injection
    const swallow = () => {};
    db.pool.on('error', swallow);
    db.pool.on('connect', (client) => client.on('error', swallow));
    db.observerPool.on('error', swallow);
    db.observerPool.on('connect', (client) => client.on('error', swallow));
    db.adminPool.on('error', swallow);
    db.adminPool.on('connect', (client) => client.on('error', swallow));
    agents = new PostgresAgentRepository(db.pool);
    tasks = new PostgresTaskRepository(db.pool);

    tenant = await createTenantFixture(db.pool, 'b-t25 tenant');
    ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 };
    agentId = (await agents.create(ctx, { name: 'b-t25 agent' })).agentId;
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  function makeCommand(idempotencyKey: string, prompt = 'chaos-task'): TaskCommand {
    return {
      agentId,
      kind: 'mock.chat',
      input: { prompt },
      idempotencyKey,
    };
  }

  async function countTasksByKey(key: string): Promise<number> {
    const res = await db.observerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tasks WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenant.tenantId, key],
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  async function countEvents(taskId: string): Promise<number> {
    const res = await db.observerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM task_events WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  // ---------------------------------------------------------------------------
  // Part 1: DB Ack 前 Crash 场景
  // ---------------------------------------------------------------------------
  describe('Crash BEFORE DB Ack', () => {
    it('rolls back completely when crash occurs before commit; retry creates task idempotently', async () => {
      const key = `b-t25-pre-ack-${randomUUID()}`;
      const command = makeCommand(key, 'pre-ack crash test');

      // 1. 在数据库中安装约束触发器，模拟在事务提交前的崩溃（异常回滚）
      await db.pool.query(`
        CREATE OR REPLACE FUNCTION b_t25_abort_before_ack()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'CHAOS_SIMULATED_PRE_ACK_CRASH';
        END;
        $$;
        CREATE TRIGGER b_t25_abort_before_ack_trg
          BEFORE INSERT ON task_events
          FOR EACH ROW EXECUTE FUNCTION b_t25_abort_before_ack();
      `);

      globalFaultRecorder.record({
        testName: 'B-T25',
        faultType: 'CRASH_BEFORE_DB_ACK',
        point: 'before_event_insert_commit',
        targetId: key,
        seed: prng.seed,
      });

      // 2. 发起 Task 创建，验证由于注入的故障而失败抛出 DB_UNAVAILABLE
      let caughtError: unknown;
      try {
        await tasks.create(ctx, command);
      } catch (err) {
        caughtError = err;
      }

      expect(isDomainError(caughtError)).toBe(true);
      expect((caughtError as DomainError).code).toBe('DB_UNAVAILABLE');

      // 3. 验证不变量：通过独立 observerPool 检查，数据库中无任何残余 Task 或 Event
      expect(await countTasksByKey(key)).toBe(0);

      // 4. 移除故障注入触发器（模拟进程重启/环境恢复）
      await db.pool.query(`
        DROP TRIGGER IF EXISTS b_t25_abort_before_ack_trg ON task_events;
        DROP FUNCTION IF EXISTS b_t25_abort_before_ack();
      `);

      // 5. 客户端重试（相同 idempotencyKey 与 payload）
      const receipt = await tasks.create(ctx, command);

      expect(receipt.replayed).toBe(false);
      expect(receipt.status).toBe('queued');
      expect(await countTasksByKey(key)).toBe(1);
      expect(await countEvents(receipt.taskId)).toBe(1);

      // 验证 Task 可被正常观察与读取
      const persisted = await readTask(db.observerPool, tenant.tenantId, receipt.taskId);
      expect(persisted.status).toBe('queued');
      const keyRow = await db.observerPool.query<{ idempotency_key: string }>(
        'SELECT idempotency_key FROM tasks WHERE tenant_id = $1 AND id = $2',
        [tenant.tenantId, receipt.taskId],
      );
      expect(keyRow.rows[0]?.idempotency_key).toBe(key);
    });

    it('recovers cleanly when backend connection is forcefully killed during transaction', async () => {
      const key = `b-t25-conn-kill-${randomUUID()}`;
      const command = makeCommand(key, 'conn-kill test');

      // 通过带有同步屏障的触发器，在插入 tasks 之后但提交之前挂起连接，随后后台强杀连接

      await db.pool.query(`
        CREATE OR REPLACE FUNCTION b_t25_hold_in_tx()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(987654321);
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER b_t25_hold_in_tx_trg
          AFTER INSERT ON tasks
          FOR EACH ROW EXECUTE FUNCTION b_t25_hold_in_tx();
      `);

      // 获取排他咨询锁以阻塞触发器
      const lockClient = await db.pool.connect();
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT pg_advisory_xact_lock(987654321)');

      // 发起创建（将在获取咨询锁处阻塞）
      const createPromise = tasks.create(ctx, command);

      // 从 adminPool 查找被阻塞的 backend pid
      let blockedPid: number | undefined;
      await withTimeout(
        (async () => {
          while (blockedPid === undefined) {
            const res = await db.adminPool.query<{ pid: number }>(`
              SELECT pid FROM pg_stat_activity
               WHERE wait_event = 'advisory'
                 AND state = 'active'
                 AND query LIKE '%INSERT INTO tasks%'
                 AND pid <> pg_backend_pid()
            `);
            if (res.rows.length > 0 && res.rows[0]?.pid !== undefined) {
              blockedPid = res.rows[0].pid;
            }
          }
        })(),
        5_000,
        'waiting for task insert to block on advisory lock',
      );

      expect(blockedPid).toBeDefined();

      globalFaultRecorder.record({
        testName: 'B-T25',
        faultType: 'CONNECTION_KILL_BEFORE_ACK',
        point: 'in_tx_before_commit',
        targetId: key,
        details: { blockedPid },
        seed: prng.seed,
      });

      // 强杀被阻塞的 backend
      const killed = await terminateBackendPid(db.adminPool, blockedPid!);
      expect(killed).toBe(true);

      // 释放排他锁并归还连接
      await lockClient.query('ROLLBACK');
      lockClient.release();

      // 创建调用必须由于连接被杀而失败
      await expect(createPromise).rejects.toMatchObject({
        code: 'DB_UNAVAILABLE',
      });

      // 清理触发器
      await db.pool.query(`
        DROP TRIGGER IF EXISTS b_t25_hold_in_tx_trg ON tasks;
        DROP FUNCTION IF EXISTS b_t25_hold_in_tx();
      `);

      // 验证未产生任何脏数据
      expect(await countTasksByKey(key)).toBe(0);

      // 重试必须成功完成
      const receipt = await tasks.create(ctx, command);
      expect(receipt.replayed).toBe(false);
      expect(await countTasksByKey(key)).toBe(1);
      expect(await countEvents(receipt.taskId)).toBe(1);
    });

    it('ensures only one task is created when two racing clients crash and retry concurrently', async () => {
      const key = `b-t25-race-${randomUUID()}`;
      const command = makeCommand(key, 'race test');

      const barrier = createBarrier(2, 'b-t25-race-barrier');

      // 两并发调用
      const [resA, resB] = await Promise.all([
        (async () => {
          await barrier.wait();
          return tasks.create(ctx, command);
        })(),
        (async () => {
          await barrier.wait();
          return tasks.create(ctx, command);
        })(),
      ]);

      // 两个调用均返回相同的 Task ID
      expect(resA.taskId).toBe(resB.taskId);
      // 其中一个为首次创建，另一个为重放
      const replayedFlags = [resA.replayed, resB.replayed].sort();
      expect(replayedFlags).toEqual([false, true]);

      // 逻辑 Task 严格唯一
      expect(await countTasksByKey(key)).toBe(1);
      expect(await countEvents(resA.taskId)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Part 2: DB Ack 后 Crash 场景（事务已 Commit，返回给客户端前 Crash/丢包）
  // ---------------------------------------------------------------------------
  describe('Crash AFTER DB Ack (Lost Ack / Post-Commit Crash)', () => {
    it('returns the existing task on retry without duplicate task rows or accepted events', async () => {
      const key = `b-t25-post-ack-${randomUUID()}`;
      const command = makeCommand(key, 'post-ack test');

      // 1. 模拟首次提交：DB 成功提交，但调用方模拟遇到 Crash/网络丢包未收到响应
      const firstReceipt = await tasks.create(ctx, command);
      expect(firstReceipt.replayed).toBe(false);

      globalFaultRecorder.record({
        testName: 'B-T25',
        faultType: 'CRASH_AFTER_DB_ACK',
        point: 'post_commit_client_timeout',
        targetId: firstReceipt.taskId,
        seed: prng.seed,
      });

      // 2. 模拟客户端重试（相同 Key 与 Payload）
      const retryReceipt = await tasks.create(ctx, command);

      // 3. 不变量验证：
      // - 返回同一个 Task ID
      expect(retryReceipt.taskId).toBe(firstReceipt.taskId);
      // - 标识为重放
      expect(retryReceipt.replayed).toBe(true);
      // - 任务行数量依旧为 1
      expect(await countTasksByKey(key)).toBe(1);
      // - accepted 事件未重复追加（始终只有 sequence 1）
      expect(await countEvents(firstReceipt.taskId)).toBe(1);

      // 验证 Task 处于待领取状态
      const task = await readTask(db.observerPool, tenant.tenantId, firstReceipt.taskId);
      expect(task.status).toBe('queued');
      expect(task.attempt_count).toBe(0);
    });

    it('rejects retries with different payload using IDEMPOTENCY_CONFLICT, keeping original task safe', async () => {
      const key = `b-t25-conflict-${randomUUID()}`;
      const originalCommand = makeCommand(key, 'original prompt');
      const alteredCommand = makeCommand(key, 'tampered prompt');

      // 1. 原始任务提交成功
      const originalReceipt = await tasks.create(ctx, originalCommand);
      expect(originalReceipt.replayed).toBe(false);

      globalFaultRecorder.record({
        testName: 'B-T25',
        faultType: 'POST_ACK_TAMPERED_RETRY',
        point: 'idempotency_digest_check',
        targetId: originalReceipt.taskId,
        seed: prng.seed,
      });

      // 2. 客户端尝试用相同 IdempotencyKey 但不同的 Payload 发起重试
      let conflictError: unknown;
      try {
        await tasks.create(ctx, alteredCommand);
      } catch (err) {
        conflictError = err;
      }

      // 3. 必须坚决拒绝并返回 IDEMPOTENCY_CONFLICT
      expect(isDomainError(conflictError)).toBe(true);
      expect((conflictError as DomainError).code).toBe('IDEMPOTENCY_CONFLICT');

      // 4. 验证原 Task 状态未受任何污染
      const task = await readTask(db.observerPool, tenant.tenantId, originalReceipt.taskId);
      expect(task.status).toBe('queued');
      expect(await countTasksByKey(key)).toBe(1);
      expect(await countEvents(originalReceipt.taskId)).toBe(1);
    });

    it('preserves task state and idempotency even after task has advanced to running and completed', async () => {
      const key = `b-t25-advanced-${randomUUID()}`;
      const command = makeCommand(key, 'advanced task execution');

      // 1. 提交任务
      const initialReceipt = await tasks.create(ctx, command);

      // 2. Worker 领取任务并将状态推进至 running
      await parkOtherOpenTasks(db.pool, initialReceipt.taskId);
      const queue = new PostgresLeaseQueue(db.pool, {
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 5_000,
      });
      const lease = await queue.claimNext('worker-b-t25', new Date());
      expect(lease).not.toBeNull();
      expect(lease?.taskId).toBe(initialReceipt.taskId);

      // 3. 延迟的客户端此时重试调用 tasks.create
      const retryWhileRunning = await tasks.create(ctx, command);
      expect(retryWhileRunning.taskId).toBe(initialReceipt.taskId);
      expect(retryWhileRunning.replayed).toBe(true);
      expect(retryWhileRunning.status).toBe('running');

      // 4. Worker 完成任务，状态推进至 completed (Run 终态为 succeeded)
      const finishOk = await queue.finish(lease!, 'succeeded');
      expect(finishOk).toBe(true);

      // 5. 再次重试调用 tasks.create
      const retryWhileCompleted = await tasks.create(ctx, command);
      expect(retryWhileCompleted.taskId).toBe(initialReceipt.taskId);
      expect(retryWhileCompleted.replayed).toBe(true);
      expect(retryWhileCompleted.status).toBe('completed');

      // 6. 验证数据库不变量：没有额外的 Task 行，没有额外的 accepted 事件
      expect(await countTasksByKey(key)).toBe(1);
      const events = await db.observerPool.query<{ phase: string; sequence: number }>(
        'SELECT phase, sequence FROM task_events WHERE tenant_id = $1 AND task_id = $2 ORDER BY sequence',
        [tenant.tenantId, initialReceipt.taskId],
      );
      const acceptedEvents = events.rows.filter((r) => r.phase === 'accepted');
      expect(acceptedEvents).toHaveLength(1);
      expect(acceptedEvents[0]?.sequence).toBe(1);
    });
  });
});
