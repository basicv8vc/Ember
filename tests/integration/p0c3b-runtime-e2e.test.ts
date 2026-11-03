import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveTaskCreationIdempotencyKey, type SourceSnapshot } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import {
  CommitmentOrchestrator,
  createDefaultSentinelPolicy,
  type BudgetPolicy,
  type SentinelPolicy,
  type SourceReaderPort,
} from '@ember/execution';
import {
  PostgresBudgetLedger,
  PostgresRunExecutionContextReader,
  systemClock,
} from '@ember/postgres';
import { createCommitmentRunHandler } from '../../apps/worker/src/commitment-handler.js';
import { CommitmentScheduler } from '../../apps/worker/src/commitment-scheduler.js';
import { CommitmentSourceReader } from '../../apps/worker/src/commitment-source-reader.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  FIXTURE_SOURCE_PROFILE,
  claimNextRun,
  createCommitment,
  createCommitmentHarness,
  grantConsent,
  grantForRun,
  readCommitment,
  readOccurrence,
  readOutcomeCount,
  reserveAndDispatch,
  revokeConsent,
  type CommitmentHarness,
} from './support/commitment-runtime.js';

/**
 * P0-C3B Task 5 - end-to-end runtime against real PostgreSQL.
 *
 * The chain exercised here uses the production persistence components:
 *   Commitment -> CommitmentScheduler -> Occurrence -> PostgresTaskRepository -> PostgresLeaseQueue
 *   -> CommitmentRunHandler -> CommitmentSourceReader -> CommitmentOrchestrator
 *   -> PostgresCommitmentRepository.appendOutcomeIfAbsent -> Occurrence completion
 *
 * Commitment, Task, Run, Outcome, Occurrence AND Consent assertions read PostgreSQL rows: consent is
 * the durable `PostgresConsentRepository`, adapted once by `fromResolvedGenerationConsent`, and the
 * repository publishes through `PostgresConsentPublicationGuard`. No in-memory consent double is
 * involved, so grants, revocations and generation changes are separate committed transactions
 * exactly as they are in production.
 */
const WORKER_ID = 'worker-e2e';
const logger = createWorkerLogger({ level: 'error' });

const GENEROUS_BUDGET: BudgetPolicy = {
  policyId: 'p0c3b-e2e-budget',
  policyVersion: 1,
  maxRunSteps: 10,
  maxRunUnits: 100,
  maxRunElapsedMs: 60_000,
  maxTenantDailyUnits: 1_000,
  maxConcurrentSlots: 4,
};

interface Runtime {
  readonly harness: CommitmentHarness;
  readonly handler: ReturnType<typeof createCommitmentRunHandler>;
  readonly scheduler: CommitmentScheduler;
}

interface RuntimeOptions {
  readonly sentinelActions?: readonly string[];
  readonly budget?: BudgetPolicy;
  readonly sourceReader?: SourceReaderPort;
}

function createRuntime(harness: CommitmentHarness, options: RuntimeOptions = {}): Runtime {
  const sentinelPolicy: SentinelPolicy = createDefaultSentinelPolicy({
    policyId: 'p0c3b-e2e-sentinel',
    policyVersion: 1,
    tenantId: harness.ctx.tenantId,
    allowedActions: [...(options.sentinelActions ?? ['mock.read', 'mock.compute'])],
  });

  const orchestrator = new CommitmentOrchestrator({
    store: {
      findAuthoritativeOutcome: (grant, query) =>
        harness.commitments.findAuthoritativeOutcome(grant, query),
      appendOutcomeIfAbsent: (grant, cmd) => harness.commitments.appendOutcomeIfAbsent(grant, cmd),
    },
    sourceReader:
      options.sourceReader ??
      new CommitmentSourceReader({
        consent: harness.consentAuthority,
        grants: harness.consentGrants,
      }),
    // The Worker orchestrator re-verifies the versioned fence before publication, so it uses the
    // SAME adapted authority as the reader and the PostgreSQL publication guard. Nothing in this
    // suite hands the raw store to the Worker.
    consent: harness.consentAuthority,
    budget: new PostgresBudgetLedger(harness.db.pool, {
      policy: options.budget ?? GENEROUS_BUDGET,
    }),
    sentinelPolicy,
    clock: systemClock,
    logger,
  });

  const handler = createCommitmentRunHandler({
    contextReader: new PostgresRunExecutionContextReader(harness.db.pool, systemClock),
    store: harness.commitments,
    orchestrator,
    clock: systemClock,
    workerId: WORKER_ID,
    logger,
  });

  const scheduler = new CommitmentScheduler(harness.commitments, harness.dispatcher, {
    enabled: true,
    logger,
    stalledTimeoutSeconds: 0,
    batchSize: 10,
  });

  return { harness, handler, scheduler };
}

/** Mirrors `runPollLoop`: handler -> fenced finish -> terminal finalizer. */
async function runOnce(
  runtime: Runtime,
  run: Awaited<ReturnType<typeof claimNextRun>>,
): Promise<{ readonly outcome: string; readonly accepted: boolean }> {
  const completion = await runtime.handler.handle(run, new AbortController().signal);

  if (completion.type !== 'finish') {
    throw new Error('commitment handler must produce a finish completion');
  }

  const accepted = await runtime.harness.queue.finish(run, completion.outcome);
  await completion.finalize?.(accepted);

  return { outcome: completion.outcome, accepted };
}

const abortedSignal = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

class FailingSourceReader implements SourceReaderPort {
  constructor(private readonly error: DomainError) {}

  readSnapshot(): Promise<SourceSnapshot> {
    return Promise.reject(this.error);
  }
}
describe('P0-C3B: end-to-end commitment runtime on real PostgreSQL', () => {
  let db: TestDatabase;
  let harness: CommitmentHarness;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    // One schema per file keeps migration cost bounded; every case starts from empty tables so a
    // retryable leftover can never be claimed by a later case.
    await truncateRuntimeTables(db);
    harness = await createCommitmentHarness(db);
    // Real, DURABLE consent: the Worker below runs against the same rows a production deployment
    // would read, so this suite exercises the real dispatch-to-execution path.
    await grantConsent(harness);
  });

  it('1. executes the full chain: scheduler -> task -> worker -> outcome -> occurrence completion', async () => {
    const runtime = createRuntime(harness);
    const { commitmentId } = await createCommitment(harness);

    const tick = await runtime.scheduler.tick();
    expect(tick.occurrencesReserved).toBe(1);
    expect(tick.tasksDispatched).toBe(1);

    const run = await claimNextRun(harness, WORKER_ID);
    const result = await runOnce(runtime, run);
    expect(result.outcome).toBe('succeeded');
    expect(result.accepted).toBe(true);

    const occurrenceId = await occurrenceForTask(db, run.taskId);
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('completed');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(1);
    expect((await readCommitment(db, commitmentId))?.status).toBe('completed');
  });

  it('2. two concurrent scheduler instances reserve exactly one occurrence and one task', async () => {
    const runtime = createRuntime(harness);
    await createCommitment(harness, { scheduleKind: 'interval' });

    const [first, second] = await Promise.all([runtime.scheduler.tick(), runtime.scheduler.tick()]);

    expect(first.occurrencesReserved + second.occurrencesReserved).toBe(1);
    expect(await countOccurrences(db)).toBe(1);
    expect(await countTasks(db)).toBe(1);
  });

  it('3. a crash between reservation and dispatch is reconciled without losing the occurrence', async () => {
    const runtime = createRuntime(harness);
    const { commitmentId, version } = await createCommitment(harness);

    // Crash simulation: the slot is reserved, but no Task is dispatched and nothing is bound.
    const slot = await harness.commitments.reserveOccurrence(commitmentId, version);
    expect(slot).not.toBeNull();
    expect((await readOccurrence(db, slot!.occurrenceId))?.status).toBe('pending');
    expect(await countTasks(db)).toBe(0);

    const reconciled = await runtime.scheduler.reconcileStalled();
    expect(reconciled).toBe(1);
    expect((await readOccurrence(db, slot!.occurrenceId))?.status).toBe('dispatched');
    expect(await countTasks(db)).toBe(1);
  });

  it('4. recovery is idempotent: no duplicate Task is ever created', async () => {
    const runtime = createRuntime(harness);
    const { commitmentId, version } = await createCommitment(harness);
    const slot = await harness.commitments.reserveOccurrence(commitmentId, version);

    expect(await runtime.scheduler.reconcileStalled()).toBe(1);
    expect(await runtime.scheduler.reconcileStalled()).toBe(0);
    expect(await countTasks(db)).toBe(1);

    const bound = await readOccurrence(db, slot!.occurrenceId);
    expect(bound?.status).toBe('dispatched');
    expect(bound?.task_id).not.toBeNull();
  });

  it('retries a Task claimed in the dispatch-to-bind window', async () => {
    const runtime = createRuntime(harness);
    const { commitmentId, version } = await createCommitment(harness);
    const slot = await harness.commitments.reserveOccurrence(commitmentId, version);
    expect(slot).not.toBeNull();

    const commitment = await harness.commitments.get(harness.ctx, commitmentId);
    expect(commitment).not.toBeNull();
    const receipt = await harness.dispatcher.dispatchTask({
      tenantId: harness.ctx.tenantId,
      agentId: harness.agentId,
      commitmentId,
      occurrenceId: slot!.occurrenceId,
      idempotencyKey: deriveTaskCreationIdempotencyKey(slot!.occurrenceId),
      kind: 'mock.compute',
      input: {
        operation: 'sha256',
        text: JSON.stringify({
          commitmentId,
          occurrenceId: slot!.occurrenceId,
          sourceProfileId: commitment!.source_profile_id,
          scheduleKind: commitment!.schedule_kind,
        }),
      },
    });

    // The newly created Task can become claimable before the Scheduler binds task_id.
    const run = await claimNextRun(harness, WORKER_ID);
    const completion = await runtime.handler.handle(run, new AbortController().signal);

    expect(completion).toMatchObject({ type: 'finish', outcome: 'failed_retryable' });
    expect(await readOccurrence(db, slot!.occurrenceId)).toMatchObject({
      status: 'pending',
      task_id: null,
    });

    // The next Scheduler step binds the same idempotent Task; no second Task was created.
    await harness.commitments.markDispatched(slot!.occurrenceId, receipt.taskId);
    expect(await countTasks(db)).toBe(1);
    expect(await readOccurrence(db, slot!.occurrenceId)).toMatchObject({
      status: 'dispatched',
      task_id: receipt.taskId,
    });
  });

  it('5. duplicate outcome publication is idempotent and never duplicated', async () => {
    const runtime = createRuntime(harness);
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);
    const grant = grantForRun(run, WORKER_ID);

    const cmd = {
      occurrenceId,
      commitmentId,
      taskId,
      summary: 'first publication',
      resultStatus: 'no_change' as const,
    };

    expect(await harness.commitments.appendOutcomeIfAbsent(grant, cmd)).toBe(true);
    expect(await harness.commitments.appendOutcomeIfAbsent(grant, cmd)).toBe(false);
    expect(await readOutcomeCount(db, occurrenceId)).toBe(1);

    // The orchestrator replay lookup returns the stored outcome instead of re-executing.
    await expect(runOnce(runtime, run)).resolves.toEqual({ outcome: 'succeeded', accepted: true });
  });

  it('6. an expired Worker lease is taken over by another Worker (new attempt)', async () => {
    const runtime = createRuntime(harness);
    const { commitmentId, version } = await createCommitment(harness);
    await reserveAndDispatch(harness, commitmentId, version);

    const oldRun = await claimNextRun(harness, 'worker-old');

    await expireLease(db, oldRun.taskId, oldRun.runId);
    const reaped = await harness.queue.reapExpired(systemClock.now());
    expect(reaped).toBeGreaterThanOrEqual(1);
    await db.pool.query(
      `UPDATE tasks
          SET next_run_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [oldRun.taskId],
    );

    const newRun = await claimNextRun(harness, WORKER_ID);
    expect(newRun.taskId).toBe(oldRun.taskId);
    expect(newRun.attempt).toBeGreaterThan(oldRun.attempt);
    expect(newRun.leaseEpoch).toBeGreaterThan(oldRun.leaseEpoch);

    // The takeover Worker executes successfully; the occurrence completes exactly once.
    const result = await runOnce(runtime, newRun);
    expect(result.outcome).toBe('succeeded');

    const occurrenceId = await occurrenceForTask(db, newRun.taskId);
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('completed');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(1);

    // The superseded Worker can no longer publish anything.
    await expect(
      harness.commitments.appendOutcomeIfAbsent(grantForRun(oldRun, 'worker-old'), {
        occurrenceId,
        commitmentId,
        taskId: oldRun.taskId,
        summary: 'stale publication',
        resultStatus: 'meaningful_change',
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }));
  });

  it('7. an old Worker cannot publish after the lease was taken over', async () => {
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const oldRun = await claimNextRun(harness, 'worker-old');

    await expireLease(db, oldRun.taskId, oldRun.runId);
    await harness.queue.reapExpired(systemClock.now());
    await db.pool.query(
      `UPDATE tasks
          SET next_run_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [oldRun.taskId],
    );
    await claimNextRun(harness, WORKER_ID);

    await expect(
      harness.commitments.appendOutcomeIfAbsent(grantForRun(oldRun, 'worker-old'), {
        occurrenceId,
        commitmentId,
        taskId: oldRun.taskId,
        summary: 'stale publication',
        resultStatus: 'meaningful_change',
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }));
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  });

  it('8. a commitment cancelled during execution never publishes an outcome', async () => {
    const runtime = createRuntime(harness);
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);

    await harness.commitments.cancel(harness.ctx, commitmentId);

    const result = await runOnce(runtime, run);
    expect(result.outcome).toBe('cancelled');
    expect(result.accepted).toBe(true);
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('cancelled');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  });

  it('classifies a cancellation that wins during the source read as cancelled', async () => {
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);
    const sourceReader: SourceReaderPort = {
      readSnapshot: async () => {
        // Simulate the DB cancellation winning after identity lookup but before publication.
        await harness.commitments.cancel(harness.ctx, commitmentId);
        return {
          sourceProfileId: FIXTURE_SOURCE_PROFILE,
          observedAt: new Date().toISOString(),
          digest: 'a'.repeat(64),
          boundedSafeItems: [],
        };
      },
    };
    const runtime = createRuntime(harness, { sourceReader });

    const result = await runOnce(runtime, run);

    expect(result).toEqual({ outcome: 'cancelled', accepted: true });
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('cancelled');
    expect((await readCommitment(db, commitmentId))?.status).toBe('cancelled');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  });

  it('rejects publication when the Task cancellation request wins after the source read', async () => {
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);
    const sourceReader: SourceReaderPort = {
      readSnapshot: async () => {
        // Models an API cancellation committing after a successful read but before Outcome SQL.
        await db.pool.query(
          `UPDATE tasks SET cancel_requested_at = clock_timestamp() WHERE id = $1`,
          [taskId],
        );
        return {
          sourceProfileId: FIXTURE_SOURCE_PROFILE,
          observedAt: new Date().toISOString(),
          digest: 'b'.repeat(64),
          boundedSafeItems: [],
        };
      },
    };
    const runtime = createRuntime(harness, { sourceReader });

    const result = await runOnce(runtime, run);

    expect(result).toEqual({ outcome: 'cancelled', accepted: true });
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('cancelled');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  });

  it('9. test consent revoked during execution fails the occurrence closed', async () => {
    const runtime = createRuntime(harness);
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);

    await revokeConsent(harness);

    const result = await runOnce(runtime, run);
    expect(result.outcome).toBe('failed_terminal');
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('failed');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  });

  it('9b. a grant that does not authorize read_snapshot cannot dispatch work, let alone read', async () => {
    // Narrower re-grant: the lineage is active, but only for metadata. Dispatch is consent-gated on
    // the DURABLE grant, so the occurrence is refused before a Task is bound — the Worker is never
    // handed work it could not legally read. (Before the durable gate, dispatch minted a fence from
    // a local default and the read then succeeded on a fabricated grant. The read-boundary denial
    // itself is covered by `tests/unit/p0c3b-consent-fence.test.ts`. The frozen typed `grant`
    // command cannot express a non-snapshot operation, so the row is seeded through the durable,
    // tenant-explicit API.)
    await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_SOURCE_PROFILE,
      allowedOperations: ['read_metadata'],
      scopes: ['source.metadata'],
    });

    const { commitmentId, version } = await createCommitment(harness);

    await expect(reserveAndDispatch(harness, commitmentId, version)).rejects.toThrow(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );

    // The refused dispatch left no BOUND occurrence: the occurrence stays pending with no Task
    // attached (the unbound Task is reconciled by the repository, never published against).
    const occurrences = await db.pool.query<{ status: string; task_id: string | null }>(
      'SELECT status, task_id FROM commitment_occurrences WHERE commitment_id = $1',
      [commitmentId],
    );

    expect(occurrences.rows).toEqual([{ status: 'pending', task_id: null }]);
  });

  it('9c. revocation before execution performs zero source reads and publishes nothing', async () => {
    let connectorReads = 0;
    const inner = new CommitmentSourceReader({
      consent: harness.consentAuthority,
      grants: harness.consentGrants,
    });
    const countingReader: SourceReaderPort = {
      readSnapshot: async (profileId, trustedContext, signal) => {
        connectorReads += 1;
        return inner.readSnapshot(profileId, trustedContext, signal);
      },
    };

    const runtime = createRuntime(harness, { sourceReader: countingReader });
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);

    // Revoke after the occurrence carries its fence but BEFORE the Worker starts: the refusal has to
    // happen at the authorization gate, not after a read. Counting the connector calls is the point
    // of this case. (Revoking earlier than dispatch is refused by the dispatch fence itself, which
    // is a different case — see `tests/integration/p0c3d-consent-postgres.test.ts`.)
    await revokeConsent(harness);

    const run = await claimNextRun(harness, WORKER_ID);

    const result = await runOnce(runtime, run);

    expect(result.outcome).toBe('failed_terminal');
    expect(connectorReads).toBe(0);
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('failed');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  });

  it('9d. a snapshot read under a revoked grant is discarded before publication', async () => {
    const inner = new CommitmentSourceReader({
      consent: harness.consentAuthority,
      grants: harness.consentGrants,
    });
    let reads = 0;
    const revokingReader: SourceReaderPort = {
      readSnapshot: async (profileId, trustedContext, signal) => {
        const snapshot = await inner.readSnapshot(profileId, trustedContext, signal);
        reads += 1;
        // The read succeeded under the fenced generation; the revocation lands immediately after
        // it, i.e. while the execution is still in flight.
        await revokeConsent(harness);
        return snapshot;
      },
    };

    const runtime = createRuntime(harness, { sourceReader: revokingReader });
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);

    const result = await runOnce(runtime, run);

    expect(reads).toBe(1);
    expect(result.outcome).toBe('failed_terminal');
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('failed');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  });

  it('9e. work fenced under generation G1 cannot publish after a revoke and re-grant to G2', async () => {
    const tenantId = harness.ctx.tenantId;
    const g1 = await harness.consentAuthority.authorizeFence(tenantId, FIXTURE_SOURCE_PROFILE);

    const inner = new CommitmentSourceReader({
      consent: harness.consentAuthority,
      grants: harness.consentGrants,
    });
    const regrantingReader: SourceReaderPort = {
      readSnapshot: async (profileId, trustedContext, signal) => {
        const snapshot = await inner.readSnapshot(profileId, trustedContext, signal);
        // Revoke + re-grant: the lineage is active again, but under a NEW generation.
        await revokeConsent(harness);
        await grantConsent(harness);
        return snapshot;
      },
    };

    const runtime = createRuntime(harness, { sourceReader: regrantingReader });
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);

    const result = await runOnce(runtime, run);

    // G2 is genuinely a different generation, and G1 stays dead after it.
    const g2 = await harness.consentAuthority.authorizeFence(tenantId, FIXTURE_SOURCE_PROFILE);
    expect(g2.grantId).not.toBe(g1.grantId);

    await expect(
      harness.consentAuthority.assertFenceCurrent(g1, {
        tenantId,
        sourceProfileId: FIXTURE_SOURCE_PROFILE,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));

    expect(result.outcome).toBe('failed_terminal');
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('failed');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  });

  it('14. a revocation committed on a second connection wins over publication', async () => {
    const runtime = createRuntime(harness);
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);

    // A genuinely different pool/connection performs the revocation...
    await revokeConsent(harness);

    const result = await runOnce(runtime, run);

    // ...and the independent observer connection sees a fully rolled-back attempt: no Outcome, no
    // half-written occurrence state.
    const observed = await db.observerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM commitment_outcomes WHERE occurrence_id = $1',
      [occurrenceId],
    );

    expect(result.outcome).toBe('failed_terminal');
    expect(Number(observed.rows[0]?.count ?? '0')).toBe(0);
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('failed');
  });

  it('10a. Sentinel denial is terminal and produces no outcome', async () => {
    const runtime = createRuntime(harness, { sentinelActions: ['mock.read'] });
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);

    const result = await runOnce(runtime, run);

    expect(result.outcome).toBe('failed_terminal');
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('failed');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
    expect((await readCommitment(db, commitmentId))?.status).toBe('completed');
  });

  it('10b. budget exhaustion is terminal and produces no outcome', async () => {
    const runtime = createRuntime(harness, {
      budget: { ...GENEROUS_BUDGET, policyId: 'p0c3b-e2e-no-budget', maxRunSteps: 0 },
    });
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);

    const result = await runOnce(runtime, run);

    expect(result.outcome).toBe('failed_terminal');
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('failed');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  });

  it('11. a retryable execution failure keeps the occurrence dispatched for the retry', async () => {
    const runtime = createRuntime(harness, {
      sourceReader: new FailingSourceReader(
        new DomainError('MOCK_TOOL_FAILED', 'deterministic execution failure'),
      ),
    });
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);

    const result = await runOnce(runtime, run);

    expect(result.outcome).toBe('failed_retryable');
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('dispatched');
    expect((await readCommitment(db, commitmentId))?.status).toBe('active');

    const task = await db.pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
      run.taskId,
    ]);
    expect(task.rows[0]?.status).toBe('retryable_failed');
  });

  it('12. a permanent execution failure terminalizes the occurrence', async () => {
    const runtime = createRuntime(harness, {
      sourceReader: new FailingSourceReader(
        new DomainError('INVALID_ARGUMENT', 'deterministic contract violation'),
      ),
    });
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);

    const result = await runOnce(runtime, run);

    expect(result.outcome).toBe('failed_terminal');
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('failed');
    expect((await readCommitment(db, commitmentId))?.status).toBe('completed');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  });

  it('13. an aborted signal before execution never reaches the source reader', async () => {
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, WORKER_ID);

    let reads = 0;
    const countingReader: SourceReaderPort = {
      readSnapshot: () => {
        reads += 1;
        return Promise.resolve({
          sourceProfileId: FIXTURE_SOURCE_PROFILE,
          observedAt: new Date().toISOString(),
          digest: '0'.repeat(64),
          boundedSafeItems: [],
        });
      },
    };

    const runtime = createRuntime(harness, { sourceReader: countingReader });
    const completion = await runtime.handler.handle(run, abortedSignal());

    expect(completion).toEqual({ type: 'finish', outcome: 'cancelled' });
    expect(reads).toBe(0);
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  });
});

async function occurrenceForTask(db: TestDatabase, taskId: string): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    'SELECT id FROM commitment_occurrences WHERE task_id = $1',
    [taskId],
  );
  const id = result.rows[0]?.id;

  if (id === undefined) {
    throw new Error('no occurrence is bound to this task');
  }

  return id;
}

async function countOccurrences(db: TestDatabase): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM commitment_occurrences',
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function countTasks(db: TestDatabase): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM tasks',
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** Expire a lease in the database so the Reaper can move the Task to a retry. */
async function expireLease(db: TestDatabase, taskId: string, runId: string): Promise<void> {
  await db.pool.query('UPDATE tasks SET lease_expires_at = created_at WHERE id = $1', [taskId]);
  await db.pool.query(
    "UPDATE runs SET leased_until = clock_timestamp() - interval '1 second' WHERE id = $1",
    [runId],
  );
}

async function truncateRuntimeTables(db: TestDatabase): Promise<void> {
  await db.pool.query(`
    TRUNCATE TABLE
      commitment_outcomes,
      commitment_occurrences,
      commitments,
      budget_operations,
      approvals,
      operation_receipts,
      step_checkpoints,
      workspace_conflicts,
      workspace_versions,
      artifacts,
      staged_blobs,
      blobs,
      task_events,
      runs,
      tasks,
      workspaces,
      agents,
      principals,
      tenants
    RESTART IDENTITY CASCADE
  `);
}
