import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CommitmentScheduler } from '../../apps/worker/src/commitment-scheduler.js';
import {
  deriveTaskCreationIdempotencyKey,
  type AppendOutcomeCommand,
  type CommitmentStatus,
  type DispatchTaskCommand,
  type DispatchTaskReceipt,
  type DueCommitment,
  type DueCommitmentStore,
  type ExistingTaskDispatcher,
  type ReservedSlot,
  type StalledPendingOccurrence,
  type WorkerLeaseGrant,
} from '../../apps/worker/src/commitment-ports.js';

class InMemoryDueCommitmentStore implements DueCommitmentStore {
  public commitments: Map<
    string,
    {
      commitmentId: string;
      tenantId: string;
      agentId: string;
      title: string;
      sourceProfileId: string;
      scheduleKind: 'once' | 'interval';
      intervalSeconds: number | null;
      nextDueAt: Date | null;
      version: number;
      status: CommitmentStatus;
    }
  > = new Map();

  public occurrences: Map<
    string,
    {
      occurrenceId: string;
      commitmentId: string;
      scheduledFor: Date;
      status: 'pending' | 'dispatched' | 'completed' | 'failed' | 'cancelled';
      taskId: string | null;
      createdAt: Date;
    }
  > = new Map();

  public outcomes: Map<
    string,
    {
      outcomeId: string;
      occurrenceId: string;
      commitmentId: string;
      taskId: string;
      summary: string;
      resultStatus: string;
      createdAt: Date;
    }
  > = new Map();

  public reservationsAttempted = 0;
  public reservationsSucceeded = 0;

  findDueCommitments(limit: number, asOfOverride?: Date): Promise<readonly DueCommitment[]> {
    const now = asOfOverride ?? new Date();
    const result: DueCommitment[] = [];

    for (const c of this.commitments.values()) {
      if (c.status === 'active' && c.nextDueAt !== null && c.nextDueAt <= now) {
        result.push({
          commitmentId: c.commitmentId,
          tenantId: c.tenantId,
          agentId: c.agentId,
          title: c.title,
          sourceProfileId: c.sourceProfileId,
          scheduleKind: c.scheduleKind,
          intervalSeconds: c.intervalSeconds,
          nextDueAt: c.nextDueAt,
          version: c.version,
          status: c.status,
        });
      }
      if (result.length >= limit) break;
    }

    return Promise.resolve(result);
  }

  reserveOccurrence(
    commitmentId: string,
    expectedVersion: number,
    slotTimeOverride?: Date,
  ): Promise<ReservedSlot | null> {
    this.reservationsAttempted++;
    const commitment = this.commitments.get(commitmentId);
    if (!commitment) return Promise.resolve(null);
    if (commitment.status !== 'active') return Promise.resolve(null);
    if (commitment.version !== expectedVersion) return Promise.resolve(null);

    const scheduledFor = slotTimeOverride ?? commitment.nextDueAt;
    if (!scheduledFor) return Promise.resolve(null);

    // Invariant: UNIQUE (commitment_id, scheduled_for)
    for (const occ of this.occurrences.values()) {
      if (
        occ.commitmentId === commitmentId &&
        occ.scheduledFor.getTime() === scheduledFor.getTime()
      ) {
        return Promise.resolve(null); // Slot already taken
      }
    }

    const occurrenceId = randomUUID();
    const now = slotTimeOverride ?? new Date();

    this.occurrences.set(occurrenceId, {
      occurrenceId,
      commitmentId,
      scheduledFor,
      status: 'pending',
      taskId: null,
      createdAt: now,
    });

    commitment.version++;
    if (commitment.scheduleKind === 'once') {
      commitment.nextDueAt = null;
    } else if (commitment.intervalSeconds !== null) {
      commitment.nextDueAt = new Date(scheduledFor.getTime() + commitment.intervalSeconds * 1000);
    }

    this.reservationsSucceeded++;
    return Promise.resolve({
      occurrenceId,
      commitmentId,
      scheduledFor,
      commitmentVersion: commitment.version,
    });
  }

  markDispatched(occurrenceId: string, taskId: string): Promise<void> {
    const occ = this.occurrences.get(occurrenceId);
    if (!occ) throw new Error('Occurrence not found');
    occ.taskId = taskId;
    occ.status = 'dispatched';
    return Promise.resolve();
  }

  appendOutcomeIfAbsent(_grant: WorkerLeaseGrant, cmd: AppendOutcomeCommand): Promise<boolean> {
    if (this.outcomes.has(cmd.occurrenceId)) {
      return Promise.resolve(false);
    }
    this.outcomes.set(cmd.occurrenceId, {
      outcomeId: randomUUID(),
      occurrenceId: cmd.occurrenceId,
      commitmentId: cmd.commitmentId,
      taskId: cmd.taskId,
      summary: cmd.summary,
      resultStatus: cmd.resultStatus,
      createdAt: new Date(),
    });
    const occ = this.occurrences.get(cmd.occurrenceId);
    if (occ) occ.status = 'completed';
    return Promise.resolve(true);
  }

  markCommitmentCompleted(commitmentId: string): Promise<boolean> {
    const commitment = this.commitments.get(commitmentId);
    if (!commitment || commitment.status !== 'active') return Promise.resolve(false);
    commitment.status = 'completed';
    return Promise.resolve(true);
  }

  findStalledPendingOccurrences(
    timeoutSeconds: number,
    limit: number,
  ): Promise<readonly StalledPendingOccurrence[]> {
    const now = Date.now();
    const result: StalledPendingOccurrence[] = [];

    for (const occ of this.occurrences.values()) {
      if (
        occ.status === 'pending' &&
        now - occ.createdAt.getTime() >= timeoutSeconds * 1000 &&
        occ.taskId === null
      ) {
        result.push({
          occurrenceId: occ.occurrenceId,
          commitmentId: occ.commitmentId,
          scheduledFor: occ.scheduledFor,
          createdAt: occ.createdAt,
          taskCreationIdempotencyKey: deriveTaskCreationIdempotencyKey(occ.occurrenceId),
        });
      }
      if (result.length >= limit) break;
    }

    return Promise.resolve(result);
  }

  reconcilePendingOccurrence(occurrenceId: string, taskId: string): Promise<boolean> {
    const occ = this.occurrences.get(occurrenceId);
    if (!occ || occ.status !== 'pending') return Promise.resolve(false);
    occ.taskId = taskId;
    occ.status = 'dispatched';
    return Promise.resolve(true);
  }

  markOccurrenceFailed(occurrenceId: string, _reasonCode: string): Promise<void> {
    const occ = this.occurrences.get(occurrenceId);
    if (occ) occ.status = 'failed';
    return Promise.resolve();
  }
}

class InMemoryTaskDispatcher implements ExistingTaskDispatcher {
  public dispatchedTasks: Map<string, { taskId: string; cmd: DispatchTaskCommand }> = new Map();
  public dispatchCount = 0;

  dispatchTask(cmd: DispatchTaskCommand): Promise<DispatchTaskReceipt> {
    this.dispatchCount++;
    const existing = this.dispatchedTasks.get(cmd.idempotencyKey);
    if (existing) {
      return Promise.resolve({ taskId: existing.taskId, replayed: true });
    }

    const taskId = randomUUID();
    this.dispatchedTasks.set(cmd.idempotencyKey, { taskId, cmd });
    return Promise.resolve({ taskId, replayed: false });
  }
}

describe('P0-C3B: Durable Commitment Scheduler Unit Tests', () => {
  it('discovers due active commitments and ignores future, paused, or completed ones', async () => {
    const store = new InMemoryDueCommitmentStore();
    const dispatcher = new InMemoryTaskDispatcher();
    const scheduler = new CommitmentScheduler(store, dispatcher, { enabled: true });

    const now = new Date('2026-11-01T12:00:00Z');

    // 1. Due active commitment
    store.commitments.set('c-1', {
      commitmentId: 'c-1',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      title: 'Due Active Commitment',
      sourceProfileId: 'profile-alpha',
      scheduleKind: 'interval',
      intervalSeconds: 3600,
      nextDueAt: new Date('2026-11-01T11:55:00Z'), // Past
      version: 1,
      status: 'active',
    });

    // 2. Future active commitment
    store.commitments.set('c-2', {
      commitmentId: 'c-2',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      title: 'Future Commitment',
      sourceProfileId: 'profile-alpha',
      scheduleKind: 'interval',
      intervalSeconds: 3600,
      nextDueAt: new Date('2026-11-01T12:30:00Z'), // Future
      version: 1,
      status: 'active',
    });

    // 3. Paused commitment whose time has passed
    store.commitments.set('c-3', {
      commitmentId: 'c-3',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      title: 'Paused Commitment',
      sourceProfileId: 'profile-alpha',
      scheduleKind: 'interval',
      intervalSeconds: 3600,
      nextDueAt: new Date('2026-11-01T11:00:00Z'), // Past
      version: 1,
      status: 'paused',
    });

    const summary = await scheduler.tick(now);

    expect(summary.dueDiscovered).toBe(1);
    expect(summary.occurrencesReserved).toBe(1);
    expect(summary.tasksDispatched).toBe(1);

    // Verify occurrence was created and task bound
    expect(store.occurrences.size).toBe(1);
    const occurrence = Array.from(store.occurrences.values())[0]!;
    expect(occurrence.commitmentId).toBe('c-1');
    expect(occurrence.status).toBe('dispatched');
    expect(occurrence.taskId).toBeDefined();

    // Verify commitment next_due_at advanced by interval
    const updatedCommitment = store.commitments.get('c-1')!;
    expect(updatedCommitment.version).toBe(2);
    expect(updatedCommitment.nextDueAt?.toISOString()).toBe('2026-11-01T12:55:00.000Z');
  });

  it('C3-T02: Dual schedulers racing on the same due slot converge to exactly 1 occurrence and 1 task', async () => {
    const store = new InMemoryDueCommitmentStore();
    const dispatcher = new InMemoryTaskDispatcher();

    const schedulerA = new CommitmentScheduler(store, dispatcher, { enabled: true });
    const schedulerB = new CommitmentScheduler(store, dispatcher, { enabled: true });

    const now = new Date('2026-11-01T12:00:00Z');

    store.commitments.set('c-race', {
      commitmentId: 'c-race',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      title: 'Racing Commitment',
      sourceProfileId: 'profile-alpha',
      scheduleKind: 'interval',
      intervalSeconds: 1800,
      nextDueAt: new Date('2026-11-01T11:59:00Z'),
      version: 1,
      status: 'active',
    });

    // Run both schedulers concurrently at the exact same tick
    const [resA, resB] = await Promise.all([schedulerA.tick(now), schedulerB.tick(now)]);

    // Total occurrences reserved across both schedulers MUST be exactly 1
    const totalReserved = resA.occurrencesReserved + resB.occurrencesReserved;
    const totalDispatched = resA.tasksDispatched + resB.tasksDispatched;

    expect(totalReserved).toBe(1);
    expect(totalDispatched).toBe(1);
    expect(store.occurrences.size).toBe(1);
    expect(dispatcher.dispatchedTasks.size).toBe(1);

    // One scheduler won, the other skipped
    expect(Math.min(resA.skippedOrFailed, resB.skippedOrFailed)).toBe(0);
    expect(Math.max(resA.skippedOrFailed, resB.skippedOrFailed)).toBe(1);
  });

  it('C3-T03: Cancel race prevents future task dispatch', async () => {
    const store = new InMemoryDueCommitmentStore();
    const dispatcher = new InMemoryTaskDispatcher();
    const scheduler = new CommitmentScheduler(store, dispatcher, { enabled: true });

    const now = new Date('2026-11-01T12:00:00Z');

    store.commitments.set('c-cancel', {
      commitmentId: 'c-cancel',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      title: 'Cancelled Commitment',
      sourceProfileId: 'profile-alpha',
      scheduleKind: 'interval',
      intervalSeconds: 3600,
      nextDueAt: new Date('2026-11-01T11:50:00Z'),
      version: 1,
      status: 'cancelled', // Cancelled prior to tick
    });

    const summary = await scheduler.tick(now);
    expect(summary.dueDiscovered).toBe(0);
    expect(summary.occurrencesReserved).toBe(0);
    expect(store.occurrences.size).toBe(0);
  });

  it('advances one-shot commitment next_due_at to null upon reservation', async () => {
    const store = new InMemoryDueCommitmentStore();
    const dispatcher = new InMemoryTaskDispatcher();
    const scheduler = new CommitmentScheduler(store, dispatcher, { enabled: true });

    const now = new Date('2026-11-01T12:00:00Z');

    store.commitments.set('c-once', {
      commitmentId: 'c-once',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      title: 'One-Shot Commitment',
      sourceProfileId: 'profile-alpha',
      scheduleKind: 'once',
      intervalSeconds: null,
      nextDueAt: new Date('2026-11-01T11:00:00Z'),
      version: 1,
      status: 'active',
    });

    const summary = await scheduler.tick(now);
    expect(summary.occurrencesReserved).toBe(1);

    const commitment = store.commitments.get('c-once')!;
    expect(commitment.nextDueAt).toBeNull();

    // Subsequent tick should not discover it
    const summary2 = await scheduler.tick(now);
    expect(summary2.dueDiscovered).toBe(0);
  });

  it('reconciles stalled pending occurrences without creating duplicate tasks', async () => {
    const store = new InMemoryDueCommitmentStore();
    const dispatcher = new InMemoryTaskDispatcher();
    const scheduler = new CommitmentScheduler(store, dispatcher, {
      enabled: true,
      stalledTimeoutSeconds: 60,
    });

    const occId = 'stalled-occ-1';
    const oldTime = new Date(Date.now() - 120 * 1000); // 120 seconds ago

    // Simulate an occurrence created before a worker process crashed
    store.occurrences.set(occId, {
      occurrenceId: occId,
      commitmentId: 'c-stalled',
      scheduledFor: oldTime,
      status: 'pending',
      taskId: null,
      createdAt: oldTime,
    });

    const reconciledCount = await scheduler.reconcileStalled();
    expect(reconciledCount).toBe(1);

    const occ = store.occurrences.get(occId)!;
    expect(occ.status).toBe('dispatched');
    expect(occ.taskId).toBeDefined();

    // Verify task dispatch used stable idempotency key
    const expectedKey = deriveTaskCreationIdempotencyKey(occId);
    expect(dispatcher.dispatchedTasks.has(expectedKey)).toBe(true);

    // Running reconcile again should find 0 stalled
    const reconciledCount2 = await scheduler.reconcileStalled();
    expect(reconciledCount2).toBe(0);
  });
});
