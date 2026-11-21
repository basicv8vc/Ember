import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  AgentEventRuntimeFacade,
  AgentHeadCore,
  PROACTIVE_SCHEDULER_MODEL_LABEL,
  applyAgentHeadMigrations,
  createDefaultAgentHeadMigrations,
  formatProactiveScheduleConfirmation,
  parseProactiveScheduleTaskInput,
  type DurableObjectStorageLike,
  type GlobalBudgetAuthority,
  type ProactiveScheduleDetail,
  type ProactiveScheduleList,
  type ProactiveScheduleSnapshot,
  type QueueLike,
  type RecoveryRegistryPort,
  type SqlStorageCursorLike,
  type SqlStorageRow,
  type V2DispatchEnvelope,
} from '@ember/runtime-v2';

function createInMemoryDoStorage() {
  const db = new DatabaseSync(':memory:');
  let inTransaction = false;
  let currentAlarm: number | null = null;

  const storage: DurableObjectStorageLike = {
    sql: {
      exec<T extends SqlStorageRow = SqlStorageRow>(
        query: string,
        ...bindings: unknown[]
      ): SqlStorageCursorLike<T> {
        const stmt = db.prepare(query);
        const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
        let rows: T[] = [];
        if (isReader) {
          rows = stmt.all(...(bindings as never[])) as T[];
        } else {
          stmt.run(...(bindings as never[]));
        }
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`Expected 1 row, got ${rows.length}`);
            return rows[0]!;
          },
          rowsRead: rows.length,
          rowsWritten: isReader ? 0 : 1,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync<T>(closure: () => T): T {
      if (inTransaction) return closure();
      inTransaction = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        const res = closure();
        db.exec('COMMIT');
        return res;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        inTransaction = false;
      }
    },
    getAlarm: () => Promise.resolve(currentAlarm),
    setAlarm: (time) => {
      currentAlarm = typeof time === 'number' ? time : time.getTime();
      return Promise.resolve();
    },
    deleteAlarm: () => {
      currentAlarm = null;
      return Promise.resolve();
    },
  };

  return {
    db,
    storage,
    getAlarm: () => currentAlarm,
  };
}

function createFakeRegistry(): RecoveryRegistryPort {
  const state = new Map<string, { generation: number; recoveryAtMs: number }>();
  return {
    upsertCoverage(cmd) {
      const key = `${cmd.tenantId}:${cmd.agentId}`;
      const existing = state.get(key);
      if (existing === undefined || cmd.generation > existing.generation) {
        state.set(key, { generation: cmd.generation, recoveryAtMs: cmd.recoveryAtMs });
      } else if (cmd.generation === existing.generation) {
        existing.recoveryAtMs = Math.min(existing.recoveryAtMs, cmd.recoveryAtMs);
      }
      const cur = state.get(key)!;
      return Promise.resolve({
        accepted: cur.generation === cmd.generation && cur.recoveryAtMs <= cmd.recoveryAtMs,
        currentGeneration: cur.generation,
        actualRecoveryAtMs: cur.recoveryAtMs,
      });
    },
    postponeCoverage(cmd) {
      const key = `${cmd.tenantId}:${cmd.agentId}`;
      const existing = state.get(key);
      if (existing === undefined || existing.generation !== cmd.expectedPrevGen) {
        return Promise.resolve({
          updated: false,
          currentGeneration: existing?.generation ?? 0,
          actualRecoveryAtMs: existing?.recoveryAtMs ?? null,
        });
      }
      state.set(key, { generation: cmd.newGeneration, recoveryAtMs: cmd.nextRecoveryAtMs });
      return Promise.resolve({
        updated: true,
        currentGeneration: cmd.newGeneration,
        actualRecoveryAtMs: cmd.nextRecoveryAtMs,
      });
    },
    retireCoverage(cmd) {
      const key = `${cmd.tenantId}:${cmd.agentId}`;
      const existing = state.get(key);
      if (existing !== undefined && existing.generation <= cmd.retireUpToGen) {
        state.delete(key);
        return Promise.resolve({ retired: true });
      }
      return Promise.resolve({ retired: false });
    },
    getCoverage(cmd) {
      const key = `${cmd.tenantId}:${cmd.agentId}`;
      const existing = state.get(key);
      if (existing === undefined) {
        return Promise.resolve({
          exists: false,
          currentGeneration: null,
          actualRecoveryAtMs: null,
          status: null,
          retryNotBeforeMs: null,
        });
      }
      return Promise.resolve({
        exists: true,
        currentGeneration: existing.generation,
        actualRecoveryAtMs: existing.recoveryAtMs,
        status: 'armed',
        retryNotBeforeMs: null,
      });
    },
  };
}

function createNoopBudget(): GlobalBudgetAuthority {
  return {
    reserveGlobal: () =>
      Promise.resolve({ kind: 'reserved', globalGrantId: randomUUID(), replayed: false }),
    authorizeGlobalSend: () =>
      Promise.resolve({ authorized: true, startBeforeMs: Date.now() + 60_000 }),
    renewGlobalGrant: () => Promise.resolve({ renewed: true, state: 'reserved' }),
    settleGlobal: () =>
      Promise.resolve({
        applied: true,
        alreadySettled: false,
        conflict: false,
        effectiveState: 'settled',
        incidentOpened: false,
      }),
  };
}

function createMemoryQueue(): { queue: QueueLike<V2DispatchEnvelope>; sent: V2DispatchEnvelope[] } {
  const sent: V2DispatchEnvelope[] = [];
  return {
    sent,
    queue: {
      send: (body) => {
        sent.push(body);
        return Promise.resolve();
      },
    },
  };
}

function createHarness(initialNowMs = Date.parse('2026-11-20T08:00:00.000Z')) {
  let now = initialNowMs;
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const principalId = randomUUID();
  const conversationId = randomUUID();
  const { db, storage, getAlarm } = createInMemoryDoStorage();
  const registry = createFakeRegistry();
  const globalBudget = createNoopBudget();
  const durableTurnQueue = createMemoryQueue();
  const agentTaskQueue = createMemoryQueue();

  let events!: AgentEventRuntimeFacade;
  const core: AgentHeadCore = new AgentHeadCore({
    storage,
    tenantId,
    agentId,
    recoveryRegistry: registry,
    globalBudget,
    nowMs: () => now,
    eventRuntimeFactory(business) {
      events = new AgentEventRuntimeFacade({
        storage,
        tenantId,
        agentId,
        business,
      });
      return {
        recoveryAdmission: events.coverage,
        eventCoordinator: events.outbox,
        recoveryHooks: events.asTurnRecoveryHooks({
          globalBudget: {
            settleGlobal: (req) => core.createGlobalBudgetSettlePort().settleGlobal(req),
          },
        }),
      };
    },
  });

  core.bootstrapHead({ conversationId });

  return {
    db,
    storage,
    core,
    events,
    registry,
    tenantId,
    agentId,
    principalId,
    conversationId,
    durableTurnQueue,
    agentTaskQueue,
    getAlarm,
    now: () => now,
    setNow: (ms: number) => {
      now = ms;
    },
    runAlarm: () =>
      events.handleAlarm({
        nowMs: now,
        queues: {
          durable_turn: durableTurnQueue.queue,
          agent_task: agentTaskQueue.queue,
        },
        globalBudget: core.createGlobalBudgetSettlePort(),
        registry,
      }),
  };
}

describe('Agent E — V2 proactive schedules runtime', () => {
  it('executes a one-time reminder through alarm, durable claim, and posts one visible conversation message', async () => {
    const h = createHarness(Date.parse('2026-11-20T08:00:00.000Z'));
    const fireAt = '2026-11-20T08:05:00.000Z';

    const created = (await h.core.proactiveSchedule({
      kind: 'create',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'follow-up-invoice-1',
        kind: 'reminder',
        title: 'Follow up with Alex on invoice',
        prompt: 'Check whether Alex confirmed receipt of the Q4 invoice.',
        trigger: { type: 'once', fireAt },
        timezone: 'America/Los_Angeles',
      },
    })) as ProactiveScheduleSnapshot;

    expect(created.replayed).toBe(false);
    expect(created.status).toBe('active');
    expect(created.scheduleKind).toBe('once');
    expect(created.deliveryMode).toBe('direct_reminder');
    expect(created.nextFireAt).toBe(fireAt);
    expect(h.getAlarm()).toBe(Date.parse(fireAt));

    // Idempotent replay returns same schedule without duplicating
    const replayed = (await h.core.proactiveSchedule({
      kind: 'create',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'follow-up-invoice-1',
        kind: 'reminder',
        title: 'Follow up with Alex on invoice',
        prompt: 'Check whether Alex confirmed receipt of the Q4 invoice.',
        trigger: { type: 'once', fireAt },
        timezone: 'America/Los_Angeles',
      },
    })) as ProactiveScheduleSnapshot;
    expect(replayed.replayed).toBe(true);
    expect(replayed.scheduleId).toBe(created.scheduleId);

    // Same idempotencyKey with different payload -> IDEMPOTENCY_CONFLICT
    await expect(
      h.core.proactiveSchedule({
        kind: 'create',
        tenantId: h.tenantId,
        principalId: h.principalId,
        agentId: h.agentId,
        requestId: randomUUID(),
        input: {
          idempotencyKey: 'follow-up-invoice-1',
          kind: 'reminder',
          title: 'Different title',
          prompt: 'Different prompt',
          trigger: { type: 'once', fireAt },
          timezone: 'America/Los_Angeles',
        },
      }),
    ).rejects.toThrow(/idempotency key/i);

    // Advance clock to fireAt and run DO alarm cycle
    h.setNow(Date.parse(fireAt));
    const alarmRes = await h.runAlarm();
    expect(alarmRes.materializedScheduleCount).toBe(1);
    expect(h.agentTaskQueue.sent).toHaveLength(1);

    // Claim and commit the materialized task
    const envelope = h.agentTaskQueue.sent[0]!;
    const workerId = randomUUID();
    const claim = await h.core.claimDurableWork({ envelope, workerId, leaseMs: 30_000 });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') throw new Error('expected claimed');
    expect(claim.targetKind).toBe('task');

    const rawCtx = JSON.parse(claim.contextJson) as { inputJson?: string; conversationId?: string };
    expect(rawCtx.conversationId).toBe(h.conversationId);
    const proactivePayload = parseProactiveScheduleTaskInput(rawCtx.inputJson);
    expect(proactivePayload?.scheduleId).toBe(created.scheduleId);
    expect(proactivePayload?.deliveryMode).toBe('direct_reminder');

    const commit = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'task',
      entityId: claim.targetId,
      leaseEpoch: claim.leaseEpoch,
      workerId,
      outcome: {
        status: 'completed',
        summaryText: created.title,
        detailText: created.prompt,
        modelLabel: PROACTIVE_SCHEDULER_MODEL_LABEL,
        simulated: false,
        reasonCode: 'ok',
      },
    });
    expect(commit.accepted).toBe(true);

    // Duplicate commit is rejected and does NOT post a second message
    const duplicateCommit = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'task',
      entityId: claim.targetId,
      leaseEpoch: claim.leaseEpoch,
      workerId,
      outcome: {
        status: 'completed',
        summaryText: created.title,
        detailText: created.prompt,
        modelLabel: PROACTIVE_SCHEDULER_MODEL_LABEL,
        simulated: false,
        reasonCode: 'ok',
      },
    });
    expect(duplicateCommit.accepted).toBe(false);

    // Schedule is now completed with observable run & linked visible message
    const detail = (await h.core.proactiveSchedule({
      kind: 'get',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      scheduleId: created.scheduleId,
    })) as ProactiveScheduleDetail;

    expect(detail.status).toBe('completed');
    expect(detail.nextFireAt).toBeNull();
    expect(detail.occurrenceCount).toBe(1);
    expect(detail.recentRuns).toHaveLength(1);
    expect(detail.latestRun?.status).toBe('completed');
    expect(detail.latestRun?.resultMessageId).toBeTruthy();

    // Main conversation contains exactly one visible Ember message
    const page = await h.core.readMessages({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      after: 0,
      limit: 20,
    });
    expect(page.messages).toHaveLength(1);
    const msg = page.messages[0]!;
    expect(msg.kind).toBe('ember');
    if (msg.kind === 'ember') {
      expect(msg.message_id).toBe(detail.latestRun?.resultMessageId);
      expect(msg.text).toContain('Reminder: Follow up with Alex on invoice');
      expect(msg.text).toContain('Check whether Alex confirmed receipt of the Q4 invoice.');
    }
  });

  it('supports recurring cron_tz morning brief, pause/resume, and cancels in-flight tasks on cancel', async () => {
    // 2026-11-20T15:00:00Z = 07:00 America/Los_Angeles (PST, UTC-8)
    const h = createHarness(Date.parse('2026-11-20T15:00:00.000Z'));

    const created = (await h.core.proactiveSchedule({
      kind: 'create',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'morning-brief-daily',
        kind: 'brief',
        title: 'Morning Brief',
        prompt: 'Summarize my priorities and open follow-ups for today.',
        trigger: {
          type: 'cron',
          cronExpr: '0 8 * * *',
          timezone: 'America/Los_Angeles',
        },
      },
    })) as ProactiveScheduleSnapshot;

    expect(created.scheduleKind).toBe('cron_tz');
    expect(created.deliveryMode).toBe('model_brief');
    expect(created.timezone).toBe('America/Los_Angeles');
    // 08:00 America/Los_Angeles on 2026-11-20 = 16:00:00Z
    expect(created.nextFireAt).toBe('2026-11-20T16:00:00.000Z');

    // Pause before first fire
    const paused = (await h.core.proactiveSchedule({
      kind: 'pause',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      scheduleId: created.scheduleId,
    })) as ProactiveScheduleSnapshot;
    expect(paused.status).toBe('paused');
    expect(paused.nextFireAt).toBeNull();

    // Advance past 08:00 PST while paused -> alarm must NOT fire
    h.setNow(Date.parse('2026-11-20T17:00:00.000Z'));
    const pausedAlarm = await h.runAlarm();
    expect(pausedAlarm.materializedScheduleCount).toBe(0);
    expect(h.agentTaskQueue.sent).toHaveLength(0);

    // Resume at 09:00 PST -> next fire skips missed 08:00 today and arms tomorrow 08:00 PST
    const resumed = (await h.core.proactiveSchedule({
      kind: 'resume',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      scheduleId: created.scheduleId,
    })) as ProactiveScheduleSnapshot;
    expect(resumed.status).toBe('active');
    expect(resumed.nextFireAt).toBe('2026-11-21T16:00:00.000Z');

    // Fire tomorrow 08:00 PST -> materializes task #1
    h.setNow(Date.parse('2026-11-21T16:00:00.000Z'));
    const fireAlarm = await h.runAlarm();
    expect(fireAlarm.materializedScheduleCount).toBe(1);
    expect(h.agentTaskQueue.sent).toHaveLength(1);

    // Worker claims task #1, then user cancels schedule while task is running
    const workerId = randomUUID();
    const claim = await h.core.claimDurableWork({
      envelope: h.agentTaskQueue.sent[0]!,
      workerId,
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') throw new Error('expected claimed');

    const cancelled = (await h.core.proactiveSchedule({
      kind: 'cancel',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      scheduleId: created.scheduleId,
    })) as ProactiveScheduleSnapshot;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.nextFireAt).toBeNull();

    // Late commit from the running worker is fenced by cancel_requested_at_ms
    const lateCommit = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'task',
      entityId: claim.targetId,
      leaseEpoch: claim.leaseEpoch,
      workerId,
      outcome: {
        status: 'completed',
        summaryText: 'Morning Brief',
        detailText: 'Should not be posted after cancel',
        reasonCode: 'ok',
      },
    });
    expect(lateCommit.accepted).toBe(false);

    // No message posted to conversation
    const page = await h.core.readMessages({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      after: 0,
      limit: 10,
    });
    expect(page.messages).toHaveLength(0);
  });

  it('enforces principal isolation, rejects invalid timezone/cron, and upgrades v1..v5 -> v6 cleanly', async () => {
    const h = createHarness();
    const otherPrincipalId = randomUUID();

    // Invalid timezone
    await expect(
      h.core.proactiveSchedule({
        kind: 'create',
        tenantId: h.tenantId,
        principalId: h.principalId,
        agentId: h.agentId,
        requestId: randomUUID(),
        input: {
          idempotencyKey: 'bad-tz',
          kind: 'brief',
          title: 'Bad TZ',
          prompt: 'test',
          trigger: { type: 'cron', cronExpr: '0 8 * * *', timezone: 'Mars/Olympus' },
        },
      }),
    ).rejects.toThrow();

    // Valid schedule for principalId
    const created = (await h.core.proactiveSchedule({
      kind: 'create',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'private-followup',
        kind: 'follow_up',
        title: 'Private follow-up',
        prompt: 'Check status',
        trigger: { type: 'interval', intervalSeconds: 3600 },
      },
    })) as ProactiveScheduleSnapshot;

    // Another principal cannot list, get, or cancel it
    const otherList = (await h.core.proactiveSchedule({
      kind: 'list',
      tenantId: h.tenantId,
      principalId: otherPrincipalId,
      agentId: h.agentId,
      requestId: randomUUID(),
    })) as ProactiveScheduleList;
    expect(otherList.schedules).toHaveLength(0);

    await expect(
      h.core.proactiveSchedule({
        kind: 'get',
        tenantId: h.tenantId,
        principalId: otherPrincipalId,
        agentId: h.agentId,
        requestId: randomUUID(),
        scheduleId: created.scheduleId,
      }),
    ).rejects.toThrow(/not found/i);

    await expect(
      h.core.proactiveSchedule({
        kind: 'cancel',
        tenantId: h.tenantId,
        principalId: otherPrincipalId,
        agentId: h.agentId,
        requestId: randomUUID(),
        scheduleId: created.scheduleId,
      }),
    ).rejects.toThrow(/not found/i);

    // Migration v6 -> v7 upgrade preserves existing v2_schedules and personal_memories rows
    const { storage, db } = createInMemoryDoStorage();
    const allSteps = createDefaultAgentHeadMigrations();
    const preV7 = allSteps.filter((s) => s.version < 7);
    applyAgentHeadMigrations(storage, preV7, 1_000);
    db.exec(`INSERT INTO v2_schedules (
      schedule_id, tenant_id, agent_id, source_kind, source_id, schedule_kind,
      timezone, next_fire_at_ms, misfire_policy, status, version, created_at_ms, updated_at_ms
    ) VALUES ('legacy-sched', 't1', 'a1', 'reminder', 'r1', 'once', 'UTC', 5000, 'coalesce_latest', 'active', 1, 1000, 1000)`);
    db.exec(`INSERT INTO personal_memories (
      id, tenant_id, principal_id, kind, content, provenance_source, created_at_ms, updated_at_ms
    ) VALUES ('mem-1', 't1', 'p1', 'preference', 'Keep briefs concise', 'explicit_user_request', 1000, 1000)`);
    const upToV7 = allSteps.filter((s) => s.version <= 7);
    const upgrade = applyAgentHeadMigrations(storage, upToV7, 2_000);
    expect(upgrade.appliedVersions).toEqual([7]);
    expect(
      db.prepare(`SELECT schedule_id FROM v2_schedules WHERE schedule_id = 'legacy-sched'`).get(),
    ).toEqual({ schedule_id: 'legacy-sched' });
    expect(
      db.prepare(`SELECT id, content FROM personal_memories WHERE id = 'mem-1'`).get(),
    ).toEqual({ id: 'mem-1', content: 'Keep briefs concise' });
  });

  it('allows cancelling a fired one-time schedule while its materialized task is still in-flight', async () => {
    const h = createHarness(Date.parse('2026-11-20T08:00:00.000Z'));
    const fireAt = '2026-11-20T08:10:00.000Z';

    const created = (await h.core.proactiveSchedule({
      kind: 'create',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'once-inflight-cancel',
        kind: 'follow_up',
        title: 'One-time follow-up',
        prompt: 'Draft follow-up email to Alex',
        deliveryMode: 'model_brief',
        trigger: { type: 'once', fireAt },
      },
    })) as ProactiveScheduleSnapshot;

    // Fire the one-time schedule -> v2_schedules transitions to 'completed', task is queued/running.
    h.setNow(Date.parse(fireAt));
    const alarmRes = await h.runAlarm();
    expect(alarmRes.materializedScheduleCount).toBe(1);
    expect(h.agentTaskQueue.sent).toHaveLength(1);

    // Worker claims the task (in-flight, not yet committed).
    const workerId = randomUUID();
    const claim = await h.core.claimDurableWork({
      envelope: h.agentTaskQueue.sent[0]!,
      workerId,
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') throw new Error('expected claimed');

    // User cancels the one-time schedule while the task is still executing.
    const cancelled = (await h.core.proactiveSchedule({
      kind: 'cancel',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      scheduleId: created.scheduleId,
    })) as ProactiveScheduleSnapshot;
    expect(cancelled.status).toBe('cancelled');

    // Late worker commit must be rejected and no visible message posted.
    const lateCommit = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'task',
      entityId: claim.targetId,
      leaseEpoch: claim.leaseEpoch,
      workerId,
      outcome: {
        status: 'completed',
        summaryText: 'One-time follow-up',
        detailText: 'Should never be delivered after cancel',
        reasonCode: 'ok',
      },
    });
    expect(lateCommit.accepted).toBe(false);

    const page = await h.core.readMessages({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      after: 0,
      limit: 10,
    });
    expect(page.messages).toHaveLength(0);
  });

  it('rejects past absolute once.fireAt and interval.firstFireAt on proactiveSchedule create', async () => {
    const h = createHarness(Date.parse('2026-11-20T08:00:00.000Z'));

    await expect(
      h.core.proactiveSchedule({
        kind: 'create',
        tenantId: h.tenantId,
        principalId: h.principalId,
        agentId: h.agentId,
        requestId: randomUUID(),
        input: {
          idempotencyKey: 'past-once-1',
          kind: 'reminder',
          title: 'Past reminder',
          prompt: 'Should be rejected',
          trigger: { type: 'once', fireAt: '2026-11-20T07:59:00.000Z' },
          timezone: 'UTC',
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      diagnostic: 'scheduled fire time must not be in the past',
    });

    await expect(
      h.core.proactiveSchedule({
        kind: 'create',
        tenantId: h.tenantId,
        principalId: h.principalId,
        agentId: h.agentId,
        requestId: randomUUID(),
        input: {
          idempotencyKey: 'past-interval-1',
          kind: 'follow_up',
          title: 'Past interval',
          prompt: 'Should be rejected',
          trigger: {
            type: 'interval',
            intervalSeconds: 3600,
            firstFireAt: '2026-11-20T07:50:00.000Z',
          },
          timezone: 'UTC',
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      diagnostic: 'scheduled fire time must not be in the past',
    });
  });

  it('formats schedule confirmations in local schedule timezone and delivers at-most-once failure notices on terminal failure or timeout', async () => {
    const confirmation = formatProactiveScheduleConfirmation({
      title: 'Shanghai Brief',
      kind: 'brief',
      status: 'active',
      nextFireAt: '2026-11-22T00:00:00.000Z',
      timezone: 'Asia/Shanghai',
    });
    expect(confirmation).toContain('Scheduled "Shanghai Brief" (brief)');
    expect(confirmation).toContain('08:00');
    expect(confirmation).toContain('(Asia/Shanghai)');
    expect(confirmation).not.toContain('2026-11-22T00:00:00.000Z');

    // 1. Worker terminal failure (budget_exceeded) posts one visible failure notice in Chat
    const h = createHarness(Date.parse('2026-11-20T08:00:00.000Z'));
    const fireAt1 = '2026-11-20T08:05:00.000Z';
    const sched1 = (await h.core.proactiveSchedule({
      kind: 'create',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'fail-budget-1',
        kind: 'follow_up',
        title: 'Q4 Finance Follow-up',
        prompt: 'Check finance approval status.',
        trigger: { type: 'once', fireAt: fireAt1 },
        timezone: 'Asia/Shanghai',
        deliveryMode: 'model_brief',
      },
    })) as ProactiveScheduleSnapshot;

    h.setNow(Date.parse(fireAt1));
    await h.runAlarm();
    const env1 = h.agentTaskQueue.sent[0]!;
    const worker1 = randomUUID();
    const claim1 = await h.core.claimDurableWork({ envelope: env1, workerId: worker1, leaseMs: 30_000 });
    if (claim1.kind !== 'claimed') throw new Error('expected claimed');

    const failCommit = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'task',
      entityId: claim1.targetId,
      leaseEpoch: claim1.leaseEpoch,
      workerId: worker1,
      outcome: {
        status: 'failed',
        summaryText: sched1.title,
        detailText: null,
        modelLabel: 'openrouter/deepseek',
        simulated: false,
        reasonCode: 'budget_exceeded',
      },
    });
    expect(failCommit.accepted).toBe(true);

    // Duplicate late commit must be rejected without posting a second message
    const dupFailCommit = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'task',
      entityId: claim1.targetId,
      leaseEpoch: claim1.leaseEpoch,
      workerId: worker1,
      outcome: {
        status: 'failed',
        summaryText: sched1.title,
        detailText: null,
        modelLabel: 'openrouter/deepseek',
        simulated: false,
        reasonCode: 'budget_exceeded',
      },
    });
    expect(dupFailCommit.accepted).toBe(false);

    const detail1 = (await h.core.proactiveSchedule({
      kind: 'get',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      scheduleId: sched1.scheduleId,
    })) as ProactiveScheduleDetail;
    expect(detail1.latestRun?.status).toBe('failed');
    expect(detail1.latestRun?.reasonCode).toBe('budget_exceeded');
    expect(detail1.latestRun?.resultMessageId).toBeTruthy();

    // 2. Deadline timeout convergence records task_results(model_timeout) and delivers one failure notice
    const fireAt2 = '2026-11-20T09:00:00.000Z';
    const sched2 = (await h.core.proactiveSchedule({
      kind: 'create',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'fail-timeout-2',
        kind: 'brief',
        title: 'Midday Brief',
        prompt: 'Summarize midday priorities.',
        trigger: { type: 'once', fireAt: fireAt2 },
        timezone: 'UTC',
        deliveryMode: 'model_brief',
      },
    })) as ProactiveScheduleSnapshot;

    h.setNow(Date.parse(fireAt2));
    await h.runAlarm();
    const env2 = h.agentTaskQueue.sent[1]!;
    const worker2 = randomUUID();
    const claim2 = await h.core.claimDurableWork({ envelope: env2, workerId: worker2, leaseMs: 30_000 });
    if (claim2.kind !== 'claimed') throw new Error('expected claimed');

    // Advance past PROACTIVE_TASK_DEADLINE_MS (300_000 ms) so DO alarm converges the timed-out task
    h.setNow(Date.parse(fireAt2) + 310_000);
    await h.runAlarm();

    const detail2 = (await h.core.proactiveSchedule({
      kind: 'get',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
      scheduleId: sched2.scheduleId,
    })) as ProactiveScheduleDetail;
    expect(detail2.latestRun?.status).toBe('failed');
    expect(detail2.latestRun?.reasonCode).toBe('model_timeout');
    expect(detail2.latestRun?.completedAt).toBeTruthy();
    expect(detail2.latestRun?.resultMessageId).toBeTruthy();

    const page = await h.core.readMessages({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      after: 0,
      limit: 20,
    });
    expect(page.messages).toHaveLength(2);
    const texts = page.messages.map((m) => (m.kind === 'ember' ? m.text : ''));
    expect(texts[0]).toContain('Q4 Finance Follow-up');
    expect(texts[0]).toContain('daily model budget limit');
    expect(texts[1]).toContain('Midday Brief');
    expect(texts[1]).toContain('timed out');
  });
});
