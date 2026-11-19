import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  AlarmMultiplexer,
  applyAgentHeadMigrations,
  applyD1RecoveryMigrations,
  D1RecoveryRegistry,
  EVENT_RECOVERY_DO_MIGRATION,
  OutboxCoordinator,
  RecoveryCoverageCoordinator,
  RecoverySweeper,
  RecoveryUnavailableError,
  ScheduleRepository,
  type AuthoritativeBusinessPort,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
  type DurableObjectStorageLike,
  type QuarantineAlertEvent,
  type RecoveryRegistryPort,
  type SqlStorageCursorLike,
  type SqlStorageRow,
  type V2DispatchEnvelope,
} from '@ember/runtime-v2';

function createNodeDoHarness() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');

  const exec = <T extends SqlStorageRow = SqlStorageRow>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T> => {
    const stmt = db.prepare(query);
    const params = bindings as Array<string | number | Uint8Array | null>;
    const isRead = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
    const rows = (isRead ? stmt.all(...params) : []) as T[];
    if (!isRead) {
      stmt.run(...params);
    }
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) {
          throw new Error(`Expected 1 row, got ${rows.length}`);
        }
        return rows[0]!;
      },
      rowsRead: rows.length,
      rowsWritten: isRead ? 0 : 1,
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
  };

  let armedAlarm: number | null = null;
  let setAlarmCalls = 0;
  let deleteAlarmCalls = 0;
  let inTx = false;

  const storage: DurableObjectStorageLike = {
    sql: { exec },
    transactionSync<T>(closure: () => T): T {
      if (inTx) {
        return closure();
      }
      inTx = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = closure();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        inTx = false;
      }
    },
    getAlarm: () => Promise.resolve(armedAlarm),
    setAlarm: (t) => {
      setAlarmCalls += 1;
      armedAlarm = typeof t === 'number' ? t : t.getTime();
      return Promise.resolve();
    },
    deleteAlarm: () => {
      deleteAlarmCalls += 1;
      armedAlarm = null;
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

async function createNodeD1Harness(): Promise<{ db: DatabaseSync; d1: D1DatabaseLike }> {
  const db = new DatabaseSync(':memory:');
  const makeStatement = (query: string, bound: unknown[] = []): D1PreparedStatementLike => ({
    bind: (...values: unknown[]) => makeStatement(query, values),
    first: <T = Record<string, unknown>>(colName?: string): Promise<T | null> => {
      const row = db
        .prepare(query)
        .get(...(bound as Array<string | number | Uint8Array | null>)) as
        Record<string, unknown> | undefined;
      if (!row) {
        return Promise.resolve(null);
      }
      if (colName !== undefined) {
        return Promise.resolve((row[colName] as T | undefined) ?? null);
      }
      return Promise.resolve(row as T);
    },
    run: <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> => {
      const info = db.prepare(query).run(...(bound as Array<string | number | Uint8Array | null>));
      return Promise.resolve({
        results: [],
        success: true,
        meta: { changes: Number(info.changes) },
      });
    },
    all: <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> => {
      const rows = db
        .prepare(query)
        .all(...(bound as Array<string | number | Uint8Array | null>)) as T[];
      return Promise.resolve({ results: rows, success: true });
    },
  });

  const d1: D1DatabaseLike = {
    prepare: (query: string) => makeStatement(query),
    batch: async <T = Record<string, unknown>>(statements: D1PreparedStatementLike[]) => {
      const out: Array<D1ResultLike<T>> = [];
      for (const s of statements) {
        out.push(await s.all<T>());
      }
      return out;
    },
  };

  await applyD1RecoveryMigrations(d1, 1_000);
  return { db, d1 };
}

class MockBusinessState implements AuthoritativeBusinessPort {
  businessDueMs: number | null = null;
  readonly converged: string[] = [];
  readonly dueItems: Array<{
    targetKind: 'turn' | 'task';
    targetId: string;
    actionKind: 'preclaim_deadline' | 'lease_expired' | 'cancel_converge' | 'retry_due';
    deadlineAtMs: number;
  }> = [];

  earliestRequiredDiscoveryAtMsSync(): number | null {
    return this.businessDueMs;
  }

  listDueBusinessActionsSync(nowMs: number, limit: number) {
    return this.dueItems.filter((item) => item.deadlineAtMs <= nowMs).slice(0, limit);
  }

  convergeDueBusinessItemSync(_targetKind: 'turn' | 'task', targetId: string): void {
    this.converged.push(targetId);
    const idx = this.dueItems.findIndex((i) => i.targetId === targetId);
    if (idx !== -1) {
      this.dueItems.splice(idx, 1);
    }
    this.businessDueMs =
      this.dueItems.length > 0
        ? Math.min(...this.dueItems.map((i) => i.deadlineAtMs)) + 45_000
        : null;
  }

  inspectOutboxTargetSync(
    entityKind: 'turn' | 'task' | 'schedule_occurrence' | 'handoff',
    entityId: string,
  ) {
    return {
      exists: true,
      targetKind: entityKind === 'turn' ? ('turn' as const) : ('task' as const),
      targetId: entityId,
      currentLeaseEpoch: 1,
      deadlineAtMs: 500_000,
      isTerminal: false,
      cancelRequested: false,
    };
  }

  materializeScheduleOccurrenceSync(): void {
    // noop for alarm multiplexer unit test
  }
}

describe('V2-M1-B3 DO Alarm Multiplexer, D1 Registry CAS, Pending Crash Self-Heal & Sweeper', () => {
  it('multiplexes single Alarm: advances, avoids duplicate setAlarm, postpones to future schedule, and clears when idle', async () => {
    const doHarness = createNodeDoHarness();
    const d1Harness = await createNodeD1Harness();
    const registry = new D1RecoveryRegistry(d1Harness.d1);
    const business = new MockBusinessState();
    const coverage = new RecoveryCoverageCoordinator({
      storage: doHarness.storage,
      tenantId: 't1',
      agentId: 'a1',
      business,
    });
    const coordinator = new OutboxCoordinator(doHarness.storage.sql, {
      storage: doHarness.storage,
      business,
    });
    const schedules = new ScheduleRepository(doHarness.storage.sql);
    const multiplexer = new AlarmMultiplexer({
      storage: doHarness.storage,
      business,
      coordinator,
      schedules,
      coverage,
    });

    await coverage.ensureAdmissionCoverage({
      requiredRecoveryAtMs: 55_000,
      nowMs: 1_000,
      registry,
    });

    // Future schedule at 300_000
    doHarness.storage.transactionSync(() => {
      schedules.upsertScheduleSync({
        scheduleId: 'sched-future',
        tenantId: 't1',
        agentId: 'a1',
        sourceKind: 'reminder',
        sourceId: 'rem-future',
        scheduleKind: 'once',
        intervalSeconds: null,
        cronExpr: null,
        firstFireAtMs: 300_000,
        nowMs: 1_000,
      });
    });

    // Arm to 300_000
    let target = doHarness.storage.transactionSync(() => coordinator.recomputeAlarmSync(1_000));
    expect(target).toBe(300_000);
    await multiplexer.syncPlatformAlarm(target, 1_000);
    expect(doHarness.getMetrics()).toMatchObject({ armedAlarm: 300_000, setAlarmCalls: 1 });

    // Re-sync with identical target -> 0 extra setAlarm calls
    expect(await multiplexer.syncPlatformAlarm(300_000, 1_500)).toBe(false);
    expect(doHarness.getMetrics().setAlarmCalls).toBe(1);

    // Earlier task due at 20_000 -> advances Alarm to 20_000
    business.dueItems.push({
      targetKind: 'turn',
      targetId: 'turn-early',
      actionKind: 'preclaim_deadline',
      deadlineAtMs: 20_000,
    });
    business.businessDueMs = 65_000;
    target = doHarness.storage.transactionSync(() => coordinator.recomputeAlarmSync(2_000));
    expect(target).toBe(20_000);
    await multiplexer.syncPlatformAlarm(target, 2_000);
    expect(doHarness.getMetrics()).toMatchObject({ armedAlarm: 20_000, setAlarmCalls: 2 });

    // Run Alarm at 20_000 -> converges early turn & postpones Alarm back forward to future schedule 300_000!
    const qStub = { send: async () => Promise.resolve() };
    const cycleRes = await multiplexer.runAlarmCycle({
      nowMs: 20_000,
      queues: { durable_turn: qStub, agent_task: qStub },
      globalBudget: { settleGlobal: async () => Promise.resolve({ accepted: true }) },
      registry,
    });
    expect(cycleRes.convergedBusinessCount).toBe(1);
    expect(cycleRes.nextAlarmAtMs).toBe(300_000);
    expect(doHarness.getMetrics()).toMatchObject({ armedAlarm: 300_000, setAlarmCalls: 3 });

    // D1 recovery marker was postponed forward to 300_000 + 45_000 = 345_000 (NOT retired!)
    const covAfter = await registry.getCoverage({ tenantId: 't1', agentId: 'a1' });
    expect(covAfter).toMatchObject({
      exists: true,
      actualRecoveryAtMs: 345_000,
      status: 'armed',
    });

    // Run Alarm at 300_000 -> executes final schedule, clears Alarm (`deleteAlarm`), and retires D1 row
    const finalCycle = await multiplexer.runAlarmCycle({
      nowMs: 300_000,
      queues: { durable_turn: qStub, agent_task: qStub },
      globalBudget: { settleGlobal: async () => Promise.resolve({ accepted: true }) },
      registry,
    });
    expect(finalCycle.materializedScheduleCount).toBe(1);
    expect(finalCycle.nextAlarmAtMs).toBeNull();
    expect(doHarness.getMetrics()).toMatchObject({ armedAlarm: null, deleteAlarmCalls: 1 });
    expect((await registry.getCoverage({ tenantId: 't1', agentId: 'a1' })).exists).toBe(false);

    doHarness.db.close();
    d1Harness.db.close();
  });

  it('guarantees zero sync D1 I/O on covered Fast Path and fails closed on uncovered D1 outage', async () => {
    const doHarness = createNodeDoHarness();
    const business = new MockBusinessState();
    const coverage = new RecoveryCoverageCoordinator({
      storage: doHarness.storage,
      tenantId: 't1',
      agentId: 'a1',
      business,
    });

    let d1Calls = 0;
    let d1Outage = true;
    const flakyRegistry: RecoveryRegistryPort = {
      upsertCoverage: async (cmd) => {
        d1Calls += 1;
        await Promise.resolve();
        if (d1Outage) {
          throw new Error('D1 connection timeout');
        }
        return {
          accepted: true,
          currentGeneration: cmd.generation,
          actualRecoveryAtMs: cmd.recoveryAtMs,
        };
      },
      postponeCoverage: async (cmd) => {
        await Promise.resolve();
        return {
          updated: true,
          currentGeneration: cmd.newGeneration,
          actualRecoveryAtMs: cmd.nextRecoveryAtMs,
        };
      },
      retireCoverage: async () => {
        await Promise.resolve();
        return { retired: true };
      },
      getCoverage: async () => {
        await Promise.resolve();
        return {
          exists: false,
          currentGeneration: null,
          actualRecoveryAtMs: null,
          status: null,
          retryNotBeforeMs: null,
        };
      },
    };

    // Uncovered during D1 outage -> MUST Fail Closed with 503 RecoveryUnavailableError
    await expect(
      coverage.ensureAdmissionCoverage({
        requiredRecoveryAtMs: 50_000,
        nowMs: 1_000,
        registry: flakyRegistry,
      }),
    ).rejects.toBeInstanceOf(RecoveryUnavailableError);
    expect(coverage.getCoverageRowSync()?.coverage_state).toBe('registering');

    // D1 recovers -> advances gen=2 and confirms coverage at 46_000 (1_000 + 45_000)
    d1Outage = false;
    const regRes = await coverage.ensureAdmissionCoverage({
      requiredRecoveryAtMs: 46_000,
      nowMs: 1_000,
      registry: flakyRegistry,
    });
    expect(regRes).toEqual({ generation: 2, coveredRecoveryAtMs: 46_000, d1Called: true });
    const callsAfterRegister = d1Calls;

    // Now simulate D1 outage again while covered for later turn D >= 46_000 -> ZERO D1 I/O, continues normally!
    d1Outage = true;
    const coveredRes = await coverage.ensureAdmissionCoverage({
      requiredRecoveryAtMs: 60_000,
      nowMs: 15_000,
      registry: flakyRegistry,
    });
    expect(coveredRes).toEqual({ generation: 2, coveredRecoveryAtMs: 46_000, d1Called: false });
    expect(d1Calls).toBe(callsAfterRegister);

    doHarness.db.close();
  });

  it('self-heals DO pending crash with all clients offline, preserves next_recovery_at_ms across backoff & quarantine, and costs 0 DO wakeups when idle', async () => {
    const doHarness = createNodeDoHarness();
    const d1Harness = await createNodeD1Harness();
    const registry = new D1RecoveryRegistry(d1Harness.d1);
    const business = new MockBusinessState();
    const coverage = new RecoveryCoverageCoordinator({
      storage: doHarness.storage,
      tenantId: 't1',
      agentId: 'a1',
      business,
    });
    const coordinator = new OutboxCoordinator(doHarness.storage.sql, {
      storage: doHarness.storage,
      business,
    });
    const schedules = new ScheduleRepository(doHarness.storage.sql);
    const multiplexer = new AlarmMultiplexer({
      storage: doHarness.storage,
      business,
      coordinator,
      schedules,
      coverage,
    });

    // Establish initial coverage gen=1 at 10_000 in both DO and D1
    await coverage.ensureAdmissionCoverage({
      requiredRecoveryAtMs: 10_000,
      nowMs: 1_000,
      registry,
    });

    // Simulate an accepted outbox item due at 12_000 + pending crash before D1 upsert completes
    const env: V2DispatchEnvelope = {
      schemaVersion: 2,
      eventId: 'out-offline',
      tenantId: 't1',
      agentId: 'a1',
      entityKind: 'turn',
      entityId: 'turn-offline',
      queueName: 'durable_turn',
      fenceEpoch: 1,
    };
    doHarness.storage.transactionSync(() => {
      coordinator.enqueueDurableOutboxSync({
        outboxId: 'out-offline',
        entityKind: 'turn',
        entityId: 'turn-offline',
        queueName: 'durable_turn',
        payloadJson: JSON.stringify(env),
        fenceEpoch: 1,
        nextAttemptAtMs: 12_000,
      });
      // Advance DO coverage locally to gen=2 registering pending 'ensure' at 8_000 then CRASH before D1 call!
      coverage.inspectCoverageSync(8_000, 2_000);
    });
    expect(coverage.getCoverageRowSync()).toMatchObject({
      generation: 2,
      coverage_state: 'registering',
      pending_kind: 'ensure',
      pending_target_at_ms: 8_000,
    });

    // Now test Sweep with DO offline/failing repeatedly -> backoff -> quarantined, WITHOUT altering next_recovery_at_ms = 10_000!
    let doReachable = false;
    let recoveredRuns = 0;
    const quarantineEvents: QuarantineAlertEvent[] = [];

    const sweeper = new RecoverySweeper({
      db: d1Harness.d1,
      registry,
      onQuarantine: (ev) => quarantineEvents.push(ev),
      targets: {
        getRecoveryTarget: () => ({
          reconcileFromRegistry: async (cmd) => {
            await Promise.resolve();
            if (!doReachable) {
              throw new Error('DO unreachable');
            }
            return doHarness.storage.transactionSync(() =>
              coverage.reconcileFromRegistrySync({
                expectedGen: cmd.expectedGen,
                nowMs: cmd.nowMs,
              }),
            );
          },
          confirmRegistryPlan: async (cmd) => {
            await Promise.resolve();
            return doHarness.storage.transactionSync(() =>
              coverage.confirmRegistryPlanSync({
                generation: cmd.generation,
                actualRecoveryAtMs: cmd.actualRecoveryAtMs,
                applied: cmd.applied,
                nowMs: 500_000,
              }),
            );
          },
          runRecoveryAlarmCycle: async (nowMs) => {
            recoveredRuns += 1;
            const sent: V2DispatchEnvelope[] = [];
            await multiplexer.runAlarmCycle({
              nowMs,
              queues: {
                durable_turn: {
                  send: async (m) => {
                    await Promise.resolve();
                    sent.push(m);
                  },
                },
                agent_task: { send: async () => Promise.resolve() },
              },
              globalBudget: { settleGlobal: async () => Promise.resolve({ accepted: true }) },
              registry,
            });
          },
        }),
      },
    });

    // Run 3 failing sweeps across advancing retry_not_before_ms with threshold=3
    let tickNow = 10_000;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const sRes = await sweeper.sweepDueAgents({
        sweeperId: `sweep-${attempt}`,
        nowMs: tickNow,
        quarantineThreshold: 3,
      });
      if (attempt < 3) {
        expect(sRes.backoffCount).toBe(1);
      } else {
        expect(sRes.quarantinedCount).toBe(1);
      }
      const d1Row = await registry.getCoverage({ tenantId: 't1', agentId: 'a1' });
      // Hard J3 invariant: next_recovery_at_ms MUST stay 10_000 while retry_not_before_ms backs off!
      expect(d1Row.actualRecoveryAtMs).toBe(10_000);
      tickNow = (d1Row.retryNotBeforeMs ?? tickNow) + 1;
    }
    expect(quarantineEvents).toHaveLength(1);
    expect(quarantineEvents[0]).toMatchObject({ nextRecoveryAtMs: 10_000, recoveryAttempts: 3 });

    // DO comes back online at `tickNow` -> Sweeper wakes EVEN though status='quarantined' and repairs pending gen=2->3!
    doReachable = true;
    const healRes = await sweeper.sweepDueAgents({
      sweeperId: 'sweep-heal',
      nowMs: tickNow,
      quarantineThreshold: 3,
    });
    expect(healRes.repairedEnsureCount).toBe(1);
    expect(recoveredRuns).toBe(1);
    expect(coordinator.getOutboxByIdSync('out-offline')?.state).toBe('enqueued');

    // Empty due index -> 0 DO wakeups
    const idleSweeper = await sweeper.sweepDueAgents({
      sweeperId: 'sweep-idle',
      nowMs: tickNow + 1_000,
    });
    expect(idleSweeper.scannedCount).toBe(0);
    expect(idleSweeper.leaseAcquiredCount).toBe(0);

    doHarness.db.close();
    d1Harness.db.close();
  });
});
