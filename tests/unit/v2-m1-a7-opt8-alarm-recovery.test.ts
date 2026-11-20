import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  AlarmMultiplexer,
  applyAgentHeadMigrations,
  D1RecoveryRegistry,
  DEFAULT_COVERAGE_IDLE_GRACE_MS,
  EVENT_RECOVERY_DO_MIGRATION,
  OutboxCoordinator,
  RecoveryCoverageCoordinator,
  ScheduleRepository,
  V2_RECOVERY_REGISTRY_D1_STATEMENTS,
  type AuthoritativeBusinessPort,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
  type DurableObjectStorageLike,
  type SqlStorageCursorLike,
  type SqlStorageLike,
  type SqlStorageRow,
} from '@ember/runtime-v2';
import { syncAlarmAndRelayBudget } from '../../packages/runtime-v2/src/agent-head/turn-commit.js';

function createNodeDoHarness() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');

  const sql: SqlStorageLike = {
    exec<T extends SqlStorageRow = SqlStorageRow>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursorLike<T> {
      const trimmed = query.trim();
      const stmt = db.prepare(trimmed);
      const isSelect = /^(SELECT|PRAGMA|WITH)\b/i.test(trimmed);
      if (isSelect) {
        const rows = stmt.all(...(bindings as never[])) as T[];
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`Expected 1 row, got ${rows.length}`);
            return rows[0]!;
          },
          [Symbol.iterator]: () => rows[Symbol.iterator](),
          rowsRead: rows.length,
          rowsWritten: 0,
        };
      }
      const res = stmt.run(...(bindings as never[]));
      return {
        toArray: () => [] as T[],
        one: () => {
          throw new Error('No rows');
        },
        [Symbol.iterator]: () => ([] as T[])[Symbol.iterator](),
        rowsRead: 0,
        rowsWritten: Number(res.changes ?? 0),
      };
    },
  };

  let armedAlarm: number | null = null;
  let setAlarmCalls = 0;
  let deleteAlarmCalls = 0;
  let txDepth = 0;

  const storage: DurableObjectStorageLike = {
    sql,
    transactionSync<T>(closure: () => T): T {
      const outer = txDepth === 0;
      txDepth += 1;
      if (outer) db.exec('BEGIN IMMEDIATE');
      try {
        const result = closure();
        if (outer) db.exec('COMMIT');
        return result;
      } catch (err) {
        if (outer) db.exec('ROLLBACK');
        throw err;
      } finally {
        txDepth -= 1;
      }
    },
    getAlarm: () => Promise.resolve(armedAlarm),
    setAlarm: (ts: number | Date) => {
      armedAlarm = typeof ts === 'number' ? ts : ts.getTime();
      setAlarmCalls += 1;
      return Promise.resolve();
    },
    deleteAlarm: () => {
      armedAlarm = null;
      deleteAlarmCalls += 1;
      return Promise.resolve();
    },
  };

  applyAgentHeadMigrations(storage, [EVENT_RECOVERY_DO_MIGRATION], 1_000);

  return {
    db,
    storage,
    getMetrics: () => ({ armedAlarm, setAlarmCalls, deleteAlarmCalls }),
  };
}

function createNodeD1Harness() {
  const db = new DatabaseSync(':memory:');
  for (const stmt of V2_RECOVERY_REGISTRY_D1_STATEMENTS) {
    db.exec(stmt);
  }
  const d1: D1DatabaseLike = {
    prepare(query: string): D1PreparedStatementLike {
      let bound: unknown[] = [];
      const prepared: D1PreparedStatementLike = {
        bind(...values: unknown[]) {
          bound = values;
          return prepared;
        },
        first<T = Record<string, unknown>>() {
          const row = db.prepare(query).get(...(bound as never[])) as T | undefined;
          return Promise.resolve(row ?? null);
        },
        all<T = Record<string, unknown>>() {
          const results = db.prepare(query).all(...(bound as never[])) as T[];
          return Promise.resolve({ results, success: true } satisfies D1ResultLike<T>);
        },
        run<T = Record<string, unknown>>() {
          const res = db.prepare(query).run(...(bound as never[]));
          return Promise.resolve({
            results: [] as T[],
            success: true,
            meta: { changes: Number(res.changes ?? 0) },
          } satisfies D1ResultLike<T>);
        },
      };
      return prepared;
    },
    async batch<T = Record<string, unknown>>(
      statements: D1PreparedStatementLike[],
    ): Promise<Array<D1ResultLike<T>>> {
      const out: Array<D1ResultLike<T>> = [];
      for (const s of statements) {
        out.push(await s.run<T>());
      }
      return out;
    },
  };
  return { db, d1 };
}

function createEmptyBusiness(
  dueItems: Array<{
    readonly targetKind: 'task' | 'turn';
    readonly targetId: string;
    readonly actionKind: 'lease_expired' | 'preclaim_deadline' | 'cancel_converge' | 'retry_due';
    readonly deadlineAtMs: number;
  }> = [],
): AuthoritativeBusinessPort {
  return {
    earliestRequiredDiscoveryAtMsSync: () =>
      dueItems.length === 0 ? null : Math.min(...dueItems.map((d) => d.deadlineAtMs)),
    listDueBusinessActionsSync: (nowMs) => dueItems.filter((d) => d.deadlineAtMs <= nowMs),
    inspectOutboxTargetSync: () => ({
      exists: true,
      targetKind: null,
      targetId: null,
      currentLeaseEpoch: 0,
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
      isTerminal: false,
      cancelRequested: false,
    }),
    convergeDueBusinessItemSync: () => undefined,
    materializeScheduleOccurrenceSync: () => ({ created: false, entityId: 'unused' }),
  };
}

function makeBudgetSyncPayload(agentId: string, operationId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    tenantId: 'ten-opt8',
    principalId: 'p-1',
    agentId,
    utcDay: '2026-11-20',
    globalGrantId: `grant-${operationId}`,
    operationId,
    settlementRevision: 0,
    state: 'settled',
    reservedMicroUsd: 250,
    chargeMicroUsd: 120,
    observedCostMicroUsd: 120,
    overageMicroUsd: 0,
    openIncidentReason: null,
  });
}

describe('M1-A7 OPT-8 — Recovery & Alarm Cost Optimization', () => {
  it('reorders syncAlarmAndRelayBudget: relays budget_sync first and eliminates post-commit Alarm #2 on happy path', async () => {
    const doHarness = createNodeDoHarness();
    const business = createEmptyBusiness();
    const coordinator = new OutboxCoordinator(doHarness.storage.sql, {
      storage: doHarness.storage,
      business,
    });
    const coverage = new RecoveryCoverageCoordinator({
      storage: doHarness.storage,
      tenantId: 'ten-opt8',
      agentId: 'ag-opt8',
      business,
    });
    const multiplexer = new AlarmMultiplexer({
      storage: doHarness.storage,
      business,
      coordinator,
      schedules: new ScheduleRepository(doHarness.storage.sql),
      coverage,
    });

    // Simulate pre-existing lease alarm from prepareTurn
    await multiplexer.syncPlatformAlarm(50_000, 1_000);
    expect(doHarness.getMetrics()).toMatchObject({ armedAlarm: 50_000, setAlarmCalls: 1 });

    // Simulate commitTurn enqueuing budget_sync outbox at nowMs = 2_000
    doHarness.storage.transactionSync(() => {
      coordinator.enqueueDurableOutboxSync({
        outboxId: 'out-bs-1',
        entityKind: 'budget_sync',
        entityId: 'op-1',
        operationId: 'op-1',
        revision: 0,
        queueName: null,
        payloadJson: makeBudgetSyncPayload('ag-opt8', 'op-1'),
        fenceEpoch: 0,
        nextAttemptAtMs: 2_000,
        nowMs: 2_000,
      });
    });

    const callOrder: string[] = [];
    await syncAlarmAndRelayBudget({
      recoveryHooks: {
        relayBudgetSync: async (nowMs) => {
          callOrder.push('relayBudgetSync');
          await Promise.resolve();
          doHarness.storage.transactionSync(() => {
            coordinator.ackOutboxSync('out-bs-1', 0, nowMs);
          });
        },
        syncPlatformAlarm: async (target, nowMs) => {
          callOrder.push(`syncPlatformAlarm:${String(target)}`);
          return multiplexer.syncPlatformAlarm(target, nowMs);
        },
      },
      alarmAtMs: 2_000,
      nowMs: 2_000,
      shouldRelayBudgetSync: true,
      recomputeAlarmSync: (ts) =>
        doHarness.storage.transactionSync(() => coordinator.recomputeAlarmSync(ts)),
    });

    // Inline relay ran BEFORE alarm sync, ACKed budget_sync, and deleted the old lease alarm -> 0 Alarm #2!
    expect(callOrder).toEqual(['relayBudgetSync', 'syncPlatformAlarm:null']);
    expect(doHarness.getMetrics()).toMatchObject({
      armedAlarm: null,
      setAlarmCalls: 1,
      deleteAlarmCalls: 1,
    });

    doHarness.db.close();
  });

  it('arms Alarm fallback in finally when inline relayBudgetSync fails or throws', async () => {
    const doHarness = createNodeDoHarness();
    const business = createEmptyBusiness();
    const coordinator = new OutboxCoordinator(doHarness.storage.sql, {
      storage: doHarness.storage,
      business,
    });
    const coverage = new RecoveryCoverageCoordinator({
      storage: doHarness.storage,
      tenantId: 'ten-opt8',
      agentId: 'ag-opt8-err',
      business,
    });
    const multiplexer = new AlarmMultiplexer({
      storage: doHarness.storage,
      business,
      coordinator,
      schedules: new ScheduleRepository(doHarness.storage.sql),
      coverage,
    });

    doHarness.storage.transactionSync(() => {
      coordinator.enqueueDurableOutboxSync({
        outboxId: 'out-bs-fail',
        entityKind: 'budget_sync',
        entityId: 'op-fail',
        operationId: 'op-fail',
        revision: 0,
        queueName: null,
        payloadJson: makeBudgetSyncPayload('ag-opt8-err', 'op-fail'),
        fenceEpoch: 0,
        nextAttemptAtMs: 3_000,
        nowMs: 3_000,
      });
    });

    await expect(
      syncAlarmAndRelayBudget({
        recoveryHooks: {
          relayBudgetSync: () => Promise.reject(new Error('GlobalBudgetDO transient 503')),
          syncPlatformAlarm: (target, nowMs) => multiplexer.syncPlatformAlarm(target, nowMs),
        },
        alarmAtMs: 3_000,
        nowMs: 3_000,
        shouldRelayBudgetSync: true,
        recomputeAlarmSync: (ts) =>
          doHarness.storage.transactionSync(() => coordinator.recomputeAlarmSync(ts)),
      }),
    ).rejects.toThrow('GlobalBudgetDO transient 503');

    // Fallback alarm MUST still be armed at 3_000 because budget_sync remains un-acked!
    expect(doHarness.getMetrics()).toMatchObject({
      armedAlarm: 3_000,
      setAlarmCalls: 1,
      deleteAlarmCalls: 0,
    });

    doHarness.db.close();
  });

  it('preserves concurrent active obligation alarm deadline after inline budget_sync relay', async () => {
    const doHarness = createNodeDoHarness();
    const business = createEmptyBusiness([
      {
        targetKind: 'turn',
        targetId: 'turn-active-holder',
        actionKind: 'lease_expired',
        deadlineAtMs: 45_000,
      },
    ]);
    const coordinator = new OutboxCoordinator(doHarness.storage.sql, {
      storage: doHarness.storage,
      business,
    });
    const coverage = new RecoveryCoverageCoordinator({
      storage: doHarness.storage,
      tenantId: 'ten-opt8',
      agentId: 'ag-opt8-active',
      business,
    });
    const multiplexer = new AlarmMultiplexer({
      storage: doHarness.storage,
      business,
      coordinator,
      schedules: new ScheduleRepository(doHarness.storage.sql),
      coverage,
    });

    await multiplexer.syncPlatformAlarm(45_000, 1_000);
    doHarness.storage.transactionSync(() => {
      coordinator.enqueueDurableOutboxSync({
        outboxId: 'out-bs-active',
        entityKind: 'budget_sync',
        entityId: 'op-active',
        operationId: 'op-active',
        revision: 0,
        queueName: null,
        payloadJson: makeBudgetSyncPayload('ag-opt8-active', 'op-active'),
        fenceEpoch: 0,
        nextAttemptAtMs: 2_000,
        nowMs: 2_000,
      });
    });

    await syncAlarmAndRelayBudget({
      recoveryHooks: {
        relayBudgetSync: (nowMs) => {
          doHarness.storage.transactionSync(() => {
            coordinator.ackOutboxSync('out-bs-active', 0, nowMs);
          });
          return Promise.resolve();
        },
        syncPlatformAlarm: (target, nowMs) => multiplexer.syncPlatformAlarm(target, nowMs),
      },
      alarmAtMs: 2_000,
      nowMs: 2_000,
      shouldRelayBudgetSync: true,
      recomputeAlarmSync: (ts) =>
        doHarness.storage.transactionSync(() => coordinator.recomputeAlarmSync(ts)),
    });

    // Holder alarm (45_000) is preserved with ZERO redundant setAlarm/deleteAlarm calls!
    expect(doHarness.getMetrics()).toMatchObject({
      armedAlarm: 45_000,
      setAlarmCalls: 1,
      deleteAlarmCalls: 0,
    });

    doHarness.db.close();
  });

  it('compares 5 / 10 / 15 min D1 Coverage Idle Grace Period and preserves Sweeper Generation CAS retirement', async () => {
    expect(DEFAULT_COVERAGE_IDLE_GRACE_MS).toBe(10 * 60_000);

    const probes = [
      { graceMin: 5, graceMs: 5 * 60_000, expectedDefersAtMin: [3], expectedRetiresAtMin: 7 },
      { graceMin: 10, graceMs: 10 * 60_000, expectedDefersAtMin: [3, 7], expectedRetiresAtMin: 12 },
      {
        graceMin: 15,
        graceMs: 15 * 60_000,
        expectedDefersAtMin: [3, 7, 12],
        expectedRetiresAtMin: 16,
      },
    ] as const;

    for (const probe of probes) {
      const doHarness = createNodeDoHarness();
      const d1Harness = createNodeD1Harness();
      const registry = new D1RecoveryRegistry(d1Harness.d1);
      const business = createEmptyBusiness();
      const coverage = new RecoveryCoverageCoordinator({
        storage: doHarness.storage,
        tenantId: 'ten-grace',
        agentId: `ag-grace-${probe.graceMin}m`,
        business,
        idleGraceMs: probe.graceMs,
      });

      const t0 = 1_000_000;
      await coverage.ensureAdmissionCoverage({
        requiredRecoveryAtMs: t0 + 45_000,
        nowMs: t0,
        registry,
      });

      // During grace window: syncPostCycleCoverage returns 'unchanged' (0 DO writes, 0 D1 writes)
      for (const m of probe.expectedDefersAtMin) {
        const res = await coverage.syncPostCycleCoverage({
          nowMs: t0 + m * 60_000,
          registry,
        });
        expect(res).toBe('unchanged');
        expect(coverage.getCoverageRowSync()?.coverage_state).toBe('covered');
      }

      // Past grace window: syncPostCycleCoverage retires cleanly via Generation CAS
      const retiredRes = await coverage.syncPostCycleCoverage({
        nowMs: t0 + probe.expectedRetiresAtMin * 60_000,
        registry,
      });
      expect(retiredRes).toBe('retired');
      expect(coverage.getCoverageRowSync()?.coverage_state).toBe('uncovered');
      expect(
        (
          await registry.getCoverage({
            tenantId: 'ten-grace',
            agentId: `ag-grace-${probe.graceMin}m`,
          })
        ).exists,
      ).toBe(false);

      // Independent Sweeper reconciliation still retires idle agents immediately on Sweeper tick
      const t2 = t0 + 20 * 60_000;
      await coverage.ensureAdmissionCoverage({
        requiredRecoveryAtMs: t2 + 45_000,
        nowMs: t2,
        registry,
      });
      const recPlan = doHarness.storage.transactionSync(() =>
        coverage.reconcileFromRegistrySync({ expectedGen: 3, nowMs: t2 + 60_000 }),
      );
      expect(recPlan.action).toBe('retire');

      doHarness.db.close();
      d1Harness.db.close();
    }
  });
});
