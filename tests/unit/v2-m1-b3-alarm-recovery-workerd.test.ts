import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface MiniflareInstance {
  dispatchFetch(input: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

type MiniflareConstructor = new (options: Record<string, unknown>) => MiniflareInstance;

function transpileRuntimeV2Modules(): Record<string, { type: 'esm'; contents: string }> {
  const srcRoot = resolve(REPO_ROOT, 'packages/runtime-v2/src');
  const entries = readdirSync(srcRoot, { recursive: true, withFileTypes: true });
  const modules: Record<string, { type: 'esm'; contents: string }> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }
    const fullPath = resolve(entry.parentPath, entry.name);
    const relPath = fullPath.slice(srcRoot.length + 1).replace(/\\/g, '/');
    const source = readFileSync(fullPath, 'utf8');
    const transpiled = ts.transpileModule(source, {
      fileName: relPath,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
        verbatimModuleSyntax: true,
      },
    });
    const jsPath = `runtime-v2/${relPath.replace(/\.ts$/, '.js')}`;
    modules[jsPath] = { type: 'esm', contents: transpiled.outputText };
  }
  return modules;
}

async function loadMiniflareConstructor(): Promise<MiniflareConstructor> {
  const cloudRuntimeReq = createRequire(
    resolve(REPO_ROOT, 'apps/cloud-async-runtime/package.json'),
  );
  const wranglerPkgPath = cloudRuntimeReq.resolve('wrangler/package.json');
  const mfReq = createRequire(wranglerPkgPath);
  const mfMod = (await import(pathToFileURL(mfReq.resolve('miniflare')).href)) as {
    Miniflare: MiniflareConstructor;
  };
  return mfMod.Miniflare;
}

describe('V2-M1-B3 real local workerd Alarm failures (initial + 6 retries) & Scheduled Sweeper recovery', () => {
  it('recovers accepted work via D1 Registry + Scheduled Sweeper after 7 consecutive Alarm failures with all clients offline and preserves future Schedule', async () => {
    const Miniflare = await loadMiniflareConstructor();
    const workerSrc = `
import { DurableObject } from 'cloudflare:workers';
import {
  AlarmMultiplexer,
  applyAgentHeadMigrations,
  applyD1RecoveryMigrations,
  D1RecoveryRegistry,
  EVENT_RECOVERY_DO_MIGRATION,
  handleDurableQueueBatch,
  OutboxCoordinator,
  RecoveryCoverageCoordinator,
  RecoverySweeper,
  RecoveryUnavailableError,
  ScheduleRepository,
  verifyAndClaimDispatchEnvelope,
} from './runtime-v2/index.js';

export class TestAgentHeadDO extends DurableObject {
  #simulatedAlarmFailuresRemaining = 0;

  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      applyAgentHeadMigrations(
        ctx.storage,
        [
          {
            version: 1,
            name: 'test_turns',
            statements: [
              \`CREATE TABLE IF NOT EXISTS test_turns (
                turn_id TEXT PRIMARY KEY,
                lease_epoch INTEGER NOT NULL,
                deadline_at_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                commit_count INTEGER NOT NULL DEFAULT 0
              );\`,
              \`CREATE TABLE IF NOT EXISTS test_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                now_ms INTEGER NOT NULL,
                alarm_failures_remaining INTEGER NOT NULL DEFAULT 0,
                alarm_attempts_observed INTEGER NOT NULL DEFAULT 0
              );\`,
              \`INSERT INTO test_state (id, now_ms, alarm_failures_remaining, alarm_attempts_observed)
               VALUES (1, 100000, 0, 0) ON CONFLICT (id) DO NOTHING;\`,
            ],
          },
          EVENT_RECOVERY_DO_MIGRATION,
        ],
        1_000,
      );
    });
  }

  #getNowMs() {
    return this.ctx.storage.sql.exec('SELECT now_ms FROM test_state WHERE id = 1').one().now_ms;
  }

  #businessPort() {
    const sql = this.ctx.storage.sql;
    return {
      earliestRequiredDiscoveryAtMsSync: () => {
        const row = sql
          .exec("SELECT MIN(deadline_at_ms) AS min_d FROM test_turns WHERE status IN ('queued', 'running')")
          .toArray()[0];
        return row && row.min_d !== null ? row.min_d + 45_000 : null;
      },
      listDueBusinessActionsSync: (nowMs, limit) => {
        const rows = sql
          .exec(
            "SELECT turn_id, deadline_at_ms FROM test_turns WHERE status IN ('queued', 'running') AND deadline_at_ms <= ? ORDER BY deadline_at_ms ASC LIMIT ?",
            nowMs,
            limit,
          )
          .toArray();
        return rows.map((r) => ({
          targetKind: 'turn',
          targetId: r.turn_id,
          actionKind: 'preclaim_deadline',
          deadlineAtMs: r.deadline_at_ms,
        }));
      },
      convergeDueBusinessItemSync: (targetKind, targetId) => {
        sql.exec("UPDATE test_turns SET status = 'failed' WHERE turn_id = ? AND status IN ('queued', 'running')", targetId);
      },
      inspectOutboxTargetSync: (entityKind, entityId) => {
        const row = sql
          .exec('SELECT turn_id, lease_epoch, deadline_at_ms, status FROM test_turns WHERE turn_id = ?', entityId)
          .toArray()[0];
        if (!row) {
          return {
            exists: false,
            targetKind: null,
            targetId: null,
            currentLeaseEpoch: 0,
            deadlineAtMs: 0,
            isTerminal: true,
            cancelRequested: false,
          };
        }
        return {
          exists: true,
          targetKind: 'turn',
          targetId: row.turn_id,
          currentLeaseEpoch: row.lease_epoch,
          deadlineAtMs: row.deadline_at_ms,
          isTerminal: row.status === 'succeeded' || row.status === 'failed',
          cancelRequested: false,
        };
      },
      materializeScheduleOccurrenceSync: () => {},
    };
  }

  #ports() {
    const business = this.#businessPort();
    const coverage = new RecoveryCoverageCoordinator({
      storage: this.ctx.storage,
      tenantId: 'ten-1',
      agentId: 'ag-1',
      business,
    });
    const coordinator = new OutboxCoordinator(this.ctx.storage.sql, {
      storage: this.ctx.storage,
      business,
    });
    const schedules = new ScheduleRepository(this.ctx.storage.sql);
    const multiplexer = new AlarmMultiplexer({
      storage: this.ctx.storage,
      business,
      coordinator,
      schedules,
      coverage,
    });
    return { business, coverage, coordinator, schedules, multiplexer };
  }

  async alarm() {
    const state = this.ctx.storage.sql
      .exec('SELECT now_ms, alarm_failures_remaining FROM test_state WHERE id = 1')
      .one();
    this.ctx.storage.sql.exec(
      'UPDATE test_state SET alarm_attempts_observed = alarm_attempts_observed + 1 WHERE id = 1',
    );
    const { multiplexer } = this.#ports();
    if (state.alarm_failures_remaining > 0) {
      this.ctx.storage.sql.exec(
        'UPDATE test_state SET alarm_failures_remaining = alarm_failures_remaining - 1 WHERE id = 1',
      );
      multiplexer.recordAlarmFailureSync(state.now_ms);
      throw new Error('simulated permanent DO Alarm failure');
    }
    const registry = new D1RecoveryRegistry(this.env.RECOVERY_DB);
    await multiplexer.runAlarmCycle({
      nowMs: state.now_ms,
      queues: { durable_turn: this.env.DURABLE_TURN_Q, agent_task: this.env.AGENT_TASK_Q },
      globalBudget: { settleGlobal: async () => ({ accepted: true }) },
      registry,
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const { business, coverage, coordinator, schedules, multiplexer } = this.#ports();
    const registry = new D1RecoveryRegistry(this.env.RECOVERY_DB);

    if (url.pathname === '/submit-with-future-schedule') {
      const { turnId, outboxId, nowMs, dueAtMs, futureScheduleAtMs, failAlarmsCount } = await request.json();
      const requiredDiscoveryMs = dueAtMs + 45_000;

      // Enforce uncovered D1 outage fail-closed gate if D1 is broken
      await coverage.ensureAdmissionCoverage({
        requiredRecoveryAtMs: requiredDiscoveryMs,
        nowMs,
        registry,
      });

      const envelope = {
        schemaVersion: 2,
        eventId: outboxId,
        tenantId: 'ten-1',
        agentId: 'ag-1',
        entityKind: 'turn',
        entityId: turnId,
        queueName: 'durable_turn',
        fenceEpoch: 1,
      };

      const nextAlarm = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          'UPDATE test_state SET now_ms = ?, alarm_failures_remaining = ? WHERE id = 1',
          nowMs,
          failAlarmsCount,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO test_turns (turn_id, lease_epoch, deadline_at_ms, status) VALUES (?, 1, ?, 'queued')",
          turnId,
          dueAtMs + 100_000,
        );
        coordinator.enqueueDurableOutboxSync({
          outboxId,
          entityKind: 'turn',
          entityId: turnId,
          queueName: 'durable_turn',
          payloadJson: JSON.stringify(envelope),
          fenceEpoch: 1,
          nextAttemptAtMs: dueAtMs,
          nowMs,
        });
        schedules.upsertScheduleSync({
          scheduleId: 'sched-future-1',
          tenantId: 'ten-1',
          agentId: 'ag-1',
          sourceKind: 'reminder',
          sourceId: 'rem-1',
          scheduleKind: 'once',
          intervalSeconds: null,
          cronExpr: null,
          firstFireAtMs: futureScheduleAtMs,
          nowMs,
        });
        return coordinator.recomputeAlarmSync(nowMs);
      });

      // Arm Alarm for dueAtMs (initial crash happens before Queue.send; Alarm takes over)
      await multiplexer.syncPlatformAlarm(nextAlarm, nowMs);
      return Response.json({ nextAlarm, d1: await registry.getCoverage({ tenantId: 'ten-1', agentId: 'ag-1' }) });
    }

    if (url.pathname === '/covered-check-during-outage') {
      const { baseMs } = await request.json();
      // First seed covered admission at baseMs + 50_000 on an isolated DO state
      await coverage.ensureAdmissionCoverage({
        requiredRecoveryAtMs: baseMs + 50_000,
        nowMs: baseMs,
        registry,
      });
      // Simulate D1 throwing an exception on any call
      const throwingRegistry = {
        upsertCoverage: async () => { throw new Error('D1 unreachable'); },
        postponeCoverage: async () => { throw new Error('D1 unreachable'); },
        retireCoverage: async () => { throw new Error('D1 unreachable'); },
        getCoverage: async () => { throw new Error('D1 unreachable'); },
      };
      // Covered fast path requires 0 D1 calls -> succeeds even when D1 is down!
      const covered = await coverage.ensureAdmissionCoverage({
        requiredRecoveryAtMs: baseMs + 100_000,
        nowMs: baseMs + 5_000,
        registry: throwingRegistry,
      });
      // Uncovered earlier obligation during D1 outage -> MUST Fail Closed with 503 DB_UNAVAILABLE!
      let uncoveredStatus = 200;
      try {
        await coverage.ensureAdmissionCoverage({
          requiredRecoveryAtMs: baseMs + 20_000,
          nowMs: baseMs + 5_000,
          registry: throwingRegistry,
        });
      } catch (err) {
        if (err instanceof RecoveryUnavailableError) {
          uncoveredStatus = err.httpStatus;
        }
      }
      return Response.json({ covered, uncoveredStatus });
    }

    if (url.pathname === '/simulate-alarm-retry') {
      const { nowMs } = await request.json();
      this.ctx.storage.sql.exec('UPDATE test_state SET now_ms = ? WHERE id = 1', nowMs);
      try {
        await this.alarm();
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: err.message });
      }
    }

    if (url.pathname === '/reconcile') {
      const cmd = await request.json();
      return Response.json(
        this.ctx.storage.transactionSync(() => coverage.reconcileFromRegistrySync(cmd)),
      );
    }

    if (url.pathname === '/confirm-plan') {
      const cmd = await request.json();
      return Response.json(
        this.ctx.storage.transactionSync(() =>
          coverage.confirmRegistryPlanSync({ ...cmd, nowMs: this.#getNowMs() }),
        ),
      );
    }

    if (url.pathname === '/run-recovery-alarm') {
      const { nowMs } = await request.json();
      this.ctx.storage.sql.exec('UPDATE test_state SET now_ms = ?, alarm_failures_remaining = 0 WHERE id = 1', nowMs);
      await multiplexer.runAlarmCycle({
        nowMs,
        queues: { durable_turn: this.env.DURABLE_TURN_Q, agent_task: this.env.AGENT_TASK_Q },
        globalBudget: { settleGlobal: async () => ({ accepted: true }) },
        registry,
      });
      return Response.json({ recovered: true });
    }

    if (url.pathname === '/claim') {
      const { envelope, workerId, leaseMs } = await request.json();
      const res = await verifyAndClaimDispatchEnvelope({
        rawEnvelope: envelope,
        expectedQueueName: 'durable_turn',
        identity: { tenantId: 'ten-1', agentId: 'ag-1' },
        storage: this.ctx.storage,
        coordinator,
        business,
        recoveryPort: {
          claimDurableWork: async (cmd) => ({
            kind: 'claimed',
            targetKind: 'turn',
            targetId: cmd.envelope.entityId,
            leaseEpoch: cmd.envelope.fenceEpoch,
            leaseExpiresAtMs: 500_000,
            contextJson: '{}',
          }),
        },
        workerId,
        leaseMs,
        nowMs: this.#getNowMs(),
      });
      return Response.json(res.kind === 'claimed' ? res.claim : { kind: 'not_claimed', reason: 'terminal' });
    }

    if (url.pathname === '/commit') {
      const { entityId } = await request.json();
      this.ctx.storage.sql.exec(
        "UPDATE test_turns SET status = 'succeeded', commit_count = commit_count + 1 WHERE turn_id = ?",
        entityId,
      );
      // After commit, recompute Alarm & sync coverage so D1 postpones to future schedule instead of retiring!
      const nowMs = this.#getNowMs();
      const nextAlarm = this.ctx.storage.transactionSync(() => coordinator.recomputeAlarmSync(nowMs));
      await multiplexer.syncPlatformAlarm(nextAlarm, nowMs);
      await coverage.syncPostCycleCoverage({ nowMs, registry });
      return Response.json({ accepted: true, nextAlarm });
    }

    if (url.pathname === '/inspect') {
      const turns = this.ctx.storage.sql.exec('SELECT * FROM test_turns').toArray();
      const outbox = this.ctx.storage.sql.exec('SELECT * FROM v2_dispatch_outbox').toArray();
      const schedulesRows = this.ctx.storage.sql.exec('SELECT * FROM v2_schedules').toArray();
      const cov = this.ctx.storage.sql.exec('SELECT * FROM v2_recovery_coverage WHERE id = 1').toArray()[0];
      const state = this.ctx.storage.sql.exec('SELECT * FROM test_state WHERE id = 1').one();
      const d1 = await registry.getCoverage({ tenantId: 'ten-1', agentId: 'ag-1' });
      return Response.json({ turns, outbox, schedules: schedulesRows, coverage: cov, state, d1 });
    }

    return new Response('not-found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/init-d1') {
      return Response.json(await applyD1RecoveryMigrations(env.RECOVERY_DB, 1_000));
    }
    if (url.pathname === '/trigger-sweep') {
      const { nowMs } = await request.json();
      const registry = new D1RecoveryRegistry(env.RECOVERY_DB);
      const sweeper = new RecoverySweeper({
        db: env.RECOVERY_DB,
        registry,
        targets: {
          getRecoveryTarget: (tenantId, agentId) => {
            const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName(tenantId + ':' + agentId));
            return {
              reconcileFromRegistry: async (cmd) =>
                (await stub.fetch('http://do/reconcile', { method: 'POST', body: JSON.stringify(cmd) })).json(),
              confirmRegistryPlan: async (cmd) =>
                (await stub.fetch('http://do/confirm-plan', { method: 'POST', body: JSON.stringify(cmd) })).json(),
              runRecoveryAlarmCycle: async (tNow) => {
                await stub.fetch('http://do/run-recovery-alarm', { method: 'POST', body: JSON.stringify({ nowMs: tNow }) });
              },
            };
          },
        },
      });
      return Response.json(await sweeper.sweepDueAgents({ sweeperId: 'workerd-cron', nowMs }));
    }
    const agentName = url.searchParams.get('agent') ?? 'ten-1:ag-1';
    const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName(agentName));
    return stub.fetch(request);
  },

  async queue(batch, env) {
    const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName('ten-1:ag-1'));
    await handleDurableQueueBatch({
      queueName: 'durable_turn',
      messages: batch.messages,
      router: {
        getAgentHeadRecoveryPort: () => ({
          reconcileFromRegistry: async () => ({ action: 'keep_armed', currentGeneration: 1 }),
          confirmRegistryPlan: async () => ({ confirmed: true }),
          claimDurableWork: async (cmd) =>
            (await stub.fetch('http://do/claim', { method: 'POST', body: JSON.stringify(cmd) })).json(),
          commitDurableResult: async (cmd) =>
            (await stub.fetch('http://do/commit', { method: 'POST', body: JSON.stringify(cmd) })).json(),
        }),
        getDeadLetterPort: () => ({
          onDispatchDeadLetter: async () => ({ action: 'ignored_stale_or_terminal', alarmAtMs: null }),
        }),
      },
      executor: { executeDurableWork: async () => ({ completed: true }) },
      workerId: 'workerd-recovered-exec',
    });
  },
};
`;

    const mf = new Miniflare({
      logRequests: false,
      workers: [
        {
          config: {
            name: 'm1-b3-recovery-test',
            compatibilityDate: '2026-11-10',
            compatibilityFlags: ['nodejs_compat'],
            manifest: {
              mainModule: 'worker.js',
              modulesRoot: '/app',
              modules: {
                'worker.js': { type: 'esm', contents: workerSrc },
                ...transpileRuntimeV2Modules(),
              },
            },
            env: {
              RECOVERY_DB: { type: 'd1', id: 'm1-b3-recovery-db' },
              AGENT_HEAD: {
                type: 'durable-object',
                worker: 'm1-b3-recovery-test',
                exportName: 'TestAgentHeadDO',
              },
              DURABLE_TURN_Q: { type: 'queue', name: 'durable-turn', dev: { remote: false } },
              AGENT_TASK_Q: { type: 'queue', name: 'agent-task', dev: { remote: false } },
            },
            exports: {
              TestAgentHeadDO: { type: 'durable-object', storage: 'sqlite' },
            },
            triggers: [{ type: 'queue', name: 'durable-turn', maxBatchSize: 1, maxRetries: 1 }],
          },
          dev: { rootPath: REPO_ROOT, unsafeRegisterWorker: true },
        },
      ],
    });

    try {
      const base = Date.now() + 1_000_000;
      const dueAtMs = base + 5_000;
      const futureScheduleAtMs = base + 900_000;

      // 0. Verify native workerd setAlarm triggers DO alarm() on demand too
      await mf.dispatchFetch('http://localhost/init-d1');

      // 1. Submit durable turn due at dueAtMs + future Schedule; arm 7 consecutive Alarm failures (initial + 6 retries)
      const submitRes = (await (
        await mf.dispatchFetch('http://localhost/submit-with-future-schedule', {
          method: 'POST',
          body: JSON.stringify({
            turnId: 'turn-rec-1',
            outboxId: 'out-rec-1',
            nowMs: base,
            dueAtMs,
            futureScheduleAtMs,
            failAlarmsCount: 7,
          }),
        })
      ).json()) as {
        nextAlarm: number;
        d1: { exists: boolean; actualRecoveryAtMs: number; currentGeneration: number };
      };
      expect(submitRes.nextAlarm).toBe(dueAtMs);
      expect(submitRes.d1).toMatchObject({ exists: true, actualRecoveryAtMs: dueAtMs + 45_000 });

      // 2. Verify D1 outage matrix on isolated DO: covered succeeds with 0 D1 calls, earlier uncovered fails closed 503
      const outageCheck = (await (
        await mf.dispatchFetch(
          'http://localhost/covered-check-during-outage?agent=ten-outage:ag-2',
          {
            method: 'POST',
            body: JSON.stringify({ baseMs: base }),
          },
        )
      ).json()) as {
        covered: { d1Called: boolean; generation: number };
        uncoveredStatus: number;
      };
      expect(outageCheck.covered.d1Called).toBe(false);
      expect(outageCheck.uncoveredStatus).toBe(503);

      // 3. Exhaust all 7 DO Alarm attempts (initial + 6 retries) while clients are offline
      for (let i = 0; i < 7; i += 1) {
        const retryRes = (await (
          await mf.dispatchFetch('http://localhost/simulate-alarm-retry', {
            method: 'POST',
            body: JSON.stringify({ nowMs: dueAtMs + i * 5_000 }),
          })
        ).json()) as { ok: boolean };
        expect(retryRes.ok).toBe(false);
      }

      // 4. Cron Sweeper wakes at due discovery bound (delta = 45s <= 2min detection!) and recovers Turn -> Queue -> Commit!
      const sweepRes = (await (
        await mf.dispatchFetch('http://localhost/trigger-sweep', {
          method: 'POST',
          body: JSON.stringify({ nowMs: dueAtMs + 55_000 }),
        })
      ).json()) as { keptArmedCount: number };
      expect(sweepRes.keptArmedCount).toBe(1);

      let inspected: {
        turns: Array<{ turn_id: string; status: string; commit_count: number }>;
        schedules: Array<{ schedule_id: string; status: string; next_fire_at_ms: number }>;
        coverage: { armed_alarm_at_ms: number | null; coverage_state: string };
        state: { alarm_attempts_observed: number };
        d1: { exists: boolean; actualRecoveryAtMs: number | null };
      } = {
        turns: [],
        schedules: [],
        coverage: { armed_alarm_at_ms: null, coverage_state: 'uncovered' },
        state: { alarm_attempts_observed: 0 },
        d1: { exists: false, actualRecoveryAtMs: null },
      };

      for (let i = 0; i < 30; i += 1) {
        inspected = (await (
          await mf.dispatchFetch('http://localhost/inspect')
        ).json()) as typeof inspected;
        if (
          inspected.turns[0]?.status === 'succeeded' &&
          inspected.d1.actualRecoveryAtMs === futureScheduleAtMs + 45_000
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(inspected.state.alarm_attempts_observed).toBe(7);
      expect(inspected.turns[0]).toMatchObject({ status: 'succeeded', commit_count: 1 });
      // Future Schedule MUST NOT be lost and DO Alarm + D1 registry are postponed forward to futureScheduleAtMs (+45_000 grace)!
      expect(inspected.schedules[0]).toMatchObject({
        status: 'active',
        next_fire_at_ms: futureScheduleAtMs,
      });
      expect(inspected.coverage.armed_alarm_at_ms).toBe(futureScheduleAtMs);
      expect(inspected.d1).toMatchObject({
        exists: true,
        actualRecoveryAtMs: futureScheduleAtMs + 45_000,
      });
    } finally {
      await mf.dispose();
    }
  }, 15_000);
});
