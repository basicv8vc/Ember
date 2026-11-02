import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '@ember/domain';
import { DomainError } from '@ember/domain';
import { PostgresAgentRepository, PostgresTaskRepository } from '@ember/postgres';
import {
  CommitmentOrchestrator,
  createDefaultSentinelPolicy,
  type AppendOutcomeCommand,
  type OutcomeResultStatus,
  type SourceSnapshot,
  type WorkerLeaseGrant,
} from '@ember/execution';
import { CommitmentScheduler } from '../../apps/worker/src/commitment-scheduler.js';
import {
  deriveTaskCreationIdempotencyKey,
  type DueCommitment,
  type DueCommitmentStore,
  type ExistingTaskDispatcher,
  type ReservedSlot,
  type StalledPendingOccurrence,
} from '../../apps/worker/src/commitment-ports.js';
import { createTestDatabase, type TestDatabase } from '../integration/support/database.js';
import { createTenantFixture, type TenantFixture } from '../integration/support/fixtures.js';
import { createChaosPrng, dumpFailureDiagnostics, globalFaultRecorder } from './harness/index.js';

/** Mandatory cooperative-cancellation signal (aligned with `@ember/connectors`). */
const chaosSignal = new AbortController().signal;

interface LocalOccurrence {
  occurrenceId: string;
  commitmentId: string;
  status: 'pending' | 'dispatched';
  taskId: string | null;
  scheduledFor?: Date;
  createdAt: Date;
}

describe('P0-C3B: Worker & Scheduler Chaos Verification', () => {
  let db: TestDatabase;
  let tenant: TenantFixture;
  let ctx: AuthContext;
  let agents: PostgresAgentRepository;
  let tasks: PostgresTaskRepository;
  let prng: ReturnType<typeof createChaosPrng>;

  beforeAll(async () => {
    prng = createChaosPrng();
    db = await createTestDatabase();
    tenant = await createTenantFixture(db.pool, 'p0c3-chaos-tenant');
    ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 };
    agents = new PostgresAgentRepository(db.pool);
    tasks = new PostgresTaskRepository(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  afterEach((context) => {
    if (context.task.result?.state === 'fail') {
      dumpFailureDiagnostics(context.task.name, prng.seed, context.task.result.errors?.[0]);
    }
    globalFaultRecorder.clear();
  });

  it('Chaos 1: Crash after slot reservation recovers without duplicate slot or task', async () => {
    const agent = await agents.create(ctx, { name: 'chaos-agent-1' });
    const commitmentId = randomUUID();
    const occurrenceId = randomUUID();

    // In-memory simulation of persistent commitment storage with crash points
    const occurrences = new Map<string, LocalOccurrence>();
    const tasksMap = new Map<string, { taskId: string }>();

    const store: DueCommitmentStore = {
      findDueCommitments(): Promise<DueCommitment[]> {
        return Promise.resolve([]);
      },
      reserveOccurrence(): Promise<ReservedSlot | null> {
        occurrences.set(occurrenceId, {
          occurrenceId,
          commitmentId,
          status: 'pending',
          taskId: null,
          createdAt: new Date(Date.now() - 300_000), // 5 min ago
        });
        return Promise.resolve({
          occurrenceId,
          commitmentId,
          scheduledFor: new Date(),
          commitmentVersion: 2,
        });
      },
      markDispatched(occId: string, taskId: string): Promise<void> {
        const occ = occurrences.get(occId);
        if (occ) {
          occ.taskId = taskId;
          occ.status = 'dispatched';
        }
        return Promise.resolve();
      },
      appendOutcomeIfAbsent(): Promise<boolean> {
        return Promise.resolve(true);
      },
      markCommitmentCompleted(): Promise<boolean> {
        return Promise.resolve(true);
      },
      findStalledPendingOccurrences(_timeoutSeconds?: number): Promise<StalledPendingOccurrence[]> {
        const res: StalledPendingOccurrence[] = [];
        for (const occ of occurrences.values()) {
          if (occ.status === 'pending' && occ.taskId === null) {
            res.push({
              occurrenceId: occ.occurrenceId,
              commitmentId: occ.commitmentId,
              tenantId: ctx.tenantId,
              agentId: agent.agentId,
              sourceProfileId: 'chaos-profile',
              scheduleKind: 'once',
              intervalSeconds: null,
              scheduledFor: occ.scheduledFor ?? new Date(),
              createdAt: occ.createdAt,
              taskCreationIdempotencyKey: deriveTaskCreationIdempotencyKey(occ.occurrenceId),
            });
          }
        }
        return Promise.resolve(res);
      },
      reconcilePendingOccurrence(occId: string, taskId: string): Promise<boolean> {
        const occ = occurrences.get(occId);
        if (occ && occ.status === 'pending') {
          occ.taskId = taskId;
          occ.status = 'dispatched';
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      },
      findOccurrenceExecutionIdentity(): Promise<null> {
        return Promise.resolve(null);
      },
      finalizeOccurrenceFromTask(): Promise<boolean> {
        return Promise.resolve(false);
      },
      reconcileTerminalOccurrences(): Promise<number> {
        return Promise.resolve(0);
      },
    };

    const dispatcher: ExistingTaskDispatcher = {
      async dispatchTask(cmd) {
        const existing = tasksMap.get(cmd.idempotencyKey);
        if (existing) {
          return { taskId: existing.taskId, replayed: true };
        }
        const created = await tasks.create(ctx, {
          agentId: agent.agentId,
          kind: 'mock.compute',
          input: { operation: 'sha256', text: JSON.stringify(cmd.input) },
          idempotencyKey: cmd.idempotencyKey,
        });
        tasksMap.set(cmd.idempotencyKey, { taskId: created.taskId });
        return { taskId: created.taskId, replayed: false };
      },
    };

    // 1. Simulate process 1 reserving slot and crashing before task dispatch
    await store.reserveOccurrence(commitmentId, 1);
    expect(occurrences.get(occurrenceId)?.status).toBe('pending');
    expect(occurrences.get(occurrenceId)?.taskId).toBeNull();

    // Process 1 terminated abruptly before dispatching task
    globalFaultRecorder.record({
      testName: 'Chaos 1',
      faultType: 'process_crash',
      point: 'before_dispatch',
      details: { occurrenceId },
    });

    // 2. New scheduler starts and reconciles stalled occurrence
    const newScheduler = new CommitmentScheduler(store, dispatcher, {
      enabled: true,
      stalledTimeoutSeconds: 60,
    });

    const reconciled = await newScheduler.reconcileStalled();
    expect(reconciled).toBe(1);

    const healedOcc = occurrences.get(occurrenceId);
    expect(healedOcc?.status).toBe('dispatched');
    expect(healedOcc?.taskId).toBeDefined();

    // 3. Second reconciliation does not duplicate
    const secondReconcile = await newScheduler.reconcileStalled();
    expect(secondReconcile).toBe(0);
    expect(tasksMap.size).toBe(1);
  });

  it('Chaos 2: Lease Fencing blocks stale worker from committing outcome after lease takeover', async () => {
    const commitmentId = randomUUID();
    const occurrenceId = randomUUID();
    const taskId = randomUUID();

    // Database state tracking active lease epoch per task
    let authoritativeEpoch = 1;
    const committedOutcomes = new Map<string, AppendOutcomeCommand>();

    const store = {
      findAuthoritativeOutcome(
        grant: WorkerLeaseGrant,
        context: { occurrenceId: string },
      ): Promise<{ readonly resultStatus: OutcomeResultStatus; readonly summary: string } | null> {
        if (grant.leaseEpoch < authoritativeEpoch) {
          return Promise.reject(
            new DomainError(
              'STALE_LEASE',
              `Worker epoch ${grant.leaseEpoch} is fenced by ${authoritativeEpoch}`,
            ),
          );
        }
        const found = committedOutcomes.get(context.occurrenceId);
        return Promise.resolve(
          found ? { resultStatus: found.resultStatus, summary: found.summary } : null,
        );
      },
      appendOutcomeIfAbsent(grant: WorkerLeaseGrant, cmd: AppendOutcomeCommand): Promise<boolean> {
        if (grant.leaseEpoch < authoritativeEpoch) {
          return Promise.reject(
            new DomainError(
              'STALE_LEASE',
              `Worker epoch ${grant.leaseEpoch} is fenced by ${authoritativeEpoch}`,
            ),
          );
        }
        if (committedOutcomes.has(cmd.occurrenceId)) {
          return Promise.resolve(false);
        }
        committedOutcomes.set(cmd.occurrenceId, cmd);
        return Promise.resolve(true);
      },
      markCommitmentCompleted(): Promise<boolean> {
        return Promise.resolve(true);
      },
    };

    const sourceReader = {
      readSnapshot(profileId: string): Promise<SourceSnapshot> {
        return Promise.resolve({
          sourceProfileId: profileId,
          observedAt: new Date().toISOString(),
          digest: 'digest-fencing',
          boundedSafeItems: [],
        });
      },
    };

    const sentinelPolicy = createDefaultSentinelPolicy({
      policyId: 'chaos-fencing-policy',
      policyVersion: 1,
      tenantId: tenant.tenantId,
      allowedActions: ['mock.read', 'mock.compute'],
    });

    const orchestrator = new CommitmentOrchestrator({
      store,
      sourceReader,
      sentinelPolicy,
    });

    // Worker 1 starts with Epoch 1
    const worker1Grant: WorkerLeaseGrant = {
      tenantId: tenant.tenantId,
      taskId,
      runId: randomUUID(),
      attempt: 1,
      leaseEpoch: 1,
      workerId: 'worker-stale',
    };

    // Worker 2 takes over task (Epoch bumped to 2)
    authoritativeEpoch = 2;
    const worker2Grant: WorkerLeaseGrant = {
      tenantId: tenant.tenantId,
      taskId,
      runId: randomUUID(),
      attempt: 1,
      leaseEpoch: 2,
      workerId: 'worker-active',
    };

    // Worker 2 finishes first and commits
    const worker2Result = await orchestrator.execute(
      worker2Grant,
      {
        tenantId: tenant.tenantId,
        agentId: tenant.principalId,
        commitmentId,
        occurrenceId,
        sourceProfileId: 'profile-fencing',
        scheduleKind: 'interval',
        policyVersion: 1,
      },
      chaosSignal,
    );

    expect(worker2Result.outcomeCommitted).toBe(true);
    expect(committedOutcomes.size).toBe(1);

    // Stale Worker 1 wakes up and attempts to commit -> MUST THROW STALE_LEASE!
    await expect(
      orchestrator.execute(
        worker1Grant,
        {
          tenantId: tenant.tenantId,
          agentId: tenant.principalId,
          commitmentId,
          occurrenceId,
          sourceProfileId: 'profile-fencing',
          scheduleKind: 'interval',
          policyVersion: 1,
        },
        chaosSignal,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }));

    // Verify still exactly 1 visible outcome
    expect(committedOutcomes.size).toBe(1);
  });

  it('Chaos 3: Transient DB disconnect during scheduler tick triggers backoff without crash', async () => {
    let failAttempts = 2;

    const failingStore: DueCommitmentStore = {
      findDueCommitments(): Promise<DueCommitment[]> {
        if (failAttempts > 0) {
          failAttempts--;
          return Promise.reject(
            new DomainError('DB_UNAVAILABLE', 'Simulated transient database connection dropped'),
          );
        }
        return Promise.resolve([]);
      },
      reserveOccurrence(): Promise<ReservedSlot | null> {
        return Promise.resolve(null);
      },
      markDispatched(): Promise<void> {
        return Promise.resolve();
      },
      appendOutcomeIfAbsent(): Promise<boolean> {
        return Promise.resolve(true);
      },
      markCommitmentCompleted(): Promise<boolean> {
        return Promise.resolve(true);
      },
      findStalledPendingOccurrences(): Promise<StalledPendingOccurrence[]> {
        return Promise.resolve([]);
      },
      reconcilePendingOccurrence(): Promise<boolean> {
        return Promise.resolve(false);
      },
      findOccurrenceExecutionIdentity(): Promise<null> {
        return Promise.resolve(null);
      },
      finalizeOccurrenceFromTask(): Promise<boolean> {
        return Promise.resolve(false);
      },
      reconcileTerminalOccurrences(): Promise<number> {
        return Promise.resolve(0);
      },
    };

    const dispatcher: ExistingTaskDispatcher = {
      dispatchTask(): Promise<{ taskId: string; replayed: boolean }> {
        return Promise.resolve({ taskId: 'dummy', replayed: false });
      },
    };

    const controller = new AbortController();
    const sleeps: number[] = [];
    const mockSleeper = (ms: number): Promise<void> => {
      sleeps.push(ms);
      controller.abort(); // Stop loop cleanly on first backoff
      return Promise.resolve();
    };

    const scheduler = new CommitmentScheduler(failingStore, dispatcher, {
      enabled: true,
      pollIntervalMs: 5_000,
      errorBackoffMs: 1_000,
      sleeper: mockSleeper,
    });

    await scheduler.runLoop(controller.signal);

    // Verified error backoff was triggered when DB failed
    expect(sleeps).toContain(1_000);
  });
});
