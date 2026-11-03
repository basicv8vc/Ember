import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSourceReader, type TrustedSourceAccessContext } from '@ember/connectors';
import {
  CommitmentOrchestrator,
  createDefaultSentinelPolicy,
  type BudgetPolicy,
  type ExecutionClock,
} from '@ember/execution';
import {
  PostgresBudgetLedger,
  PostgresConsentRepository,
  PostgresRunExecutionContextReader,
  systemClock,
} from '@ember/postgres';
import { createCommitmentRunHandler } from '../../apps/worker/src/commitment-handler.js';
import { CommitmentSourceReader } from '../../apps/worker/src/commitment-source-reader.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  FIXTURE_SOURCE_PROFILE,
  claimNextRun,
  createCommitment,
  createCommitmentHarness,
  grantConsent,
  readOccurrence,
  readOccurrenceConsentGeneration,
  readOutcomeCount,
  reserveAndDispatch,
  revokeConsent,
  type CommitmentHarness,
} from './support/commitment-runtime.js';

/**
 * P0-C3D acceptance: the dispatch-to-execution consent gap, proved end to end on PostgreSQL.
 *
 * Every component below is the production one:
 *
 *   CommitmentOrchestrator -> CommitmentSourceReader -> GuardedSourceReader -> FakeSourceReader
 *   PostgresConsentRepository (authority + grant record)  |  PostgresConsentPublicationGuard
 *   PostgresCommitmentRepository  |  PostgresBudgetLedger  |  PostgresLeaseQueue  |  tasks/runs
 *
 * There is no in-memory consent store, no fabricated grant and no defaulting of operations or
 * scopes anywhere in the Worker path reviewed here.
 *
 * ## What "the gap" means
 *
 * `dispatch` records the generation it authorized on the occurrence. Between that commit and the
 * Worker picking the Task up, consent can be re-granted, narrowed, revoked or let expire. A Worker
 * that re-authorized against "whatever is active now" would execute work created under G1 under
 * G2's terms. Cases A-C are exactly that window; D adds clock skew; E revokes mid-read; F is the
 * control that proves the gate is not simply denying everything.
 *
 * ## How a read is counted
 *
 * `CommitmentSourceReader` owns a `FakeSourceReader` and calls it through the class prototype, so a
 * spy on `FakeSourceReader.prototype.readSnapshot` counts PROVIDER round trips — one frame below the
 * Worker's adapter. Every "zero reads" assertion here is about that call, not about the adapter
 * refusing on its own.
 */
const WORKER_ID = 'worker-c3d-acceptance';
const logger = createWorkerLogger({ level: 'error' });

/** Large enough that a legitimately active grant is never the reason a case fails. */
const GENEROUS_BUDGET: BudgetPolicy = {
  policyId: 'p0c3d-acceptance-budget',
  policyVersion: 1,
  maxRunSteps: 10,
  maxRunUnits: 100,
  maxRunElapsedMs: 60_000,
  maxTenantDailyUnits: 1_000,
  maxConcurrentSlots: 4,
};

/** How far behind PostgreSQL the simulated Worker clock runs in case D. */
const CLOCK_SKEW_MS = 6 * 60 * 60 * 1_000;

/**
 * The provider call itself, captured before any spy replaces the prototype method, so the pausing
 * implementation in case E can still delegate to the real read.
 *
 * It is bound to a throwaway instance rather than taken off the prototype unbound: `readSnapshot`
 * uses instance state (the fixture map), so the delegate has to own a `this`.
 */
const providerDelegate = new FakeSourceReader();
const providerRead = providerDelegate.readSnapshot.bind(providerDelegate);

interface WorkerRuntime {
  readonly handler: ReturnType<typeof createCommitmentRunHandler>;
  /** The same lease queue the Worker claims and finishes through. */
  readonly queue: CommitmentHarness['queue'];
}

interface WorkerRuntimeOptions {
  /**
   * Clock the WORKER stamps its own time with (orchestrator, handler, context reader).
   *
   * It is never handed to the Consent authority: the durable store evaluates expiry with
   * `clock_timestamp()`, which is the whole point of case D.
   */
  readonly clock?: ExecutionClock;
}

function createWorkerRuntime(
  harness: CommitmentHarness,
  options: WorkerRuntimeOptions = {},
): WorkerRuntime {
  const clock = options.clock ?? systemClock;

  const orchestrator = new CommitmentOrchestrator({
    store: {
      findAuthoritativeOutcome: (grant, query) =>
        harness.commitments.findAuthoritativeOutcome(grant, query),
      appendOutcomeIfAbsent: (grant, cmd) => harness.commitments.appendOutcomeIfAbsent(grant, cmd),
    },
    // The production reader: the authoritative generation plus the SAME durable grant record,
    // evaluated against the fence the orchestrator minted for this attempt.
    sourceReader: new CommitmentSourceReader({
      consent: harness.consentAuthority,
      grants: harness.consentGrants,
    }),
    // The orchestrator re-verifies that same fence immediately before publication.
    consent: harness.consentAuthority,
    budget: new PostgresBudgetLedger(harness.db.pool, { policy: GENEROUS_BUDGET }),
    sentinelPolicy: createDefaultSentinelPolicy({
      policyId: 'p0c3d-acceptance-sentinel',
      policyVersion: 1,
      tenantId: harness.ctx.tenantId,
      allowedActions: ['mock.read', 'mock.compute'],
    }),
    clock,
    logger,
  });

  return {
    queue: harness.queue,
    handler: createCommitmentRunHandler({
      contextReader: new PostgresRunExecutionContextReader(harness.db.pool, clock),
      store: harness.commitments,
      orchestrator,
      clock,
      workerId: WORKER_ID,
      logger,
    }),
  };
}

/** Mirrors `runPollLoop`: handler -> fenced finish -> terminal finalizer. */
async function runOnce(
  runtime: WorkerRuntime,
  run: Awaited<ReturnType<typeof claimNextRun>>,
): Promise<{ readonly outcome: string; readonly accepted: boolean }> {
  const completion = await runtime.handler.handle(run, new AbortController().signal);

  if (completion.type !== 'finish') {
    throw new Error('commitment handler must produce a finish completion');
  }

  const accepted = await runtime.queue.finish(run, completion.outcome);
  await completion.finalize?.(accepted);

  return { outcome: completion.outcome, accepted };
}

interface FailClosedExpectation {
  readonly occurrenceId: string;
  readonly taskId: string;
  readonly result: { readonly outcome: string };
  readonly innerReads: number;
}

/**
 * The facts every refusal has to establish, asserted in one place so no case can quietly skip one.
 *
 * `0 Outcomes` and exactly `1 Run` are the "no publication, no silent retry" pair: the refusal is
 * terminal, so a later attempt cannot find consent active again and publish the stale snapshot.
 */
async function expectFailClosed(expectation: FailClosedExpectation): Promise<void> {
  const { occurrenceId, taskId, result, innerReads } = expectation;

  expect(result.outcome).toBe('failed_terminal');
  expect(innerReads).toBe(0);
  expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
  expect((await readOccurrence(db, occurrenceId))?.status).toBe('failed');
  expect(await readRunCount(db, taskId)).toBe(1);
}

/** Counts the Task's execution attempts, so "no new attempt" is a persisted fact. */
async function readRunCount(database: TestDatabase, taskId: string): Promise<number> {
  const result = await database.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM runs WHERE task_id = $1',
    [taskId],
  );

  return Number(result.rows[0]?.count ?? '0');
}

/** A grant expiry PostgreSQL itself computed, so the seed never depends on the test host's clock. */
async function futureExpiry(database: TestDatabase): Promise<string> {
  const result = await database.pool.query<{ expires_at: Date }>(
    "SELECT (clock_timestamp() + interval '1 hour') AS expires_at",
  );
  const expiresAt = result.rows[0]?.expires_at;

  if (expiresAt === undefined) {
    throw new Error('could not read the database clock');
  }

  return expiresAt.toISOString();
}

/**
 * Ages the grant into the past with PostgreSQL's own clock, i.e. "it expired while the occurrence
 * waited for a Worker". Nothing sleeps: the only thing the Worker can observe is the row.
 *
 * `expires_at > granted_at` is kept true, as the schema's expiry-order constraint requires.
 */
async function expireGrantInThePast(database: TestDatabase, tenantId: string): Promise<Date> {
  const result = await database.pool.query<{ expires_at: Date }>(
    `UPDATE consent_grants
        SET granted_at = clock_timestamp() - interval '2 hours',
            expires_at = clock_timestamp() - interval '1 hour'
      WHERE tenant_id = $1 AND source_profile_id = $2
      RETURNING expires_at`,
    [tenantId, FIXTURE_SOURCE_PROFILE],
  );
  const expiresAt = result.rows[0]?.expires_at;

  if (expiresAt === undefined) {
    throw new Error('the grant row was not found');
  }

  return expiresAt;
}

let db: TestDatabase;
let harness: CommitmentHarness;

describe('P0-C3D: Worker consent acceptance on durable PostgreSQL', () => {
  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    // Every case starts from empty tables, so a claimable leftover can never be picked up here:
    // each assertion below is about THIS run.
    await truncateRuntimeTables(db);
    harness = await createCommitmentHarness(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('A. re-grant without read_snapshot between dispatch and execution: 0 inner reads, 0 Outcomes', async () => {
    const dispatched = await grantConsent(harness);
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);

    // DISPATCH recorded the generation it authorized...
    expect(await readOccurrenceConsentGeneration(db, occurrenceId)).toEqual({
      grantId: dispatched.grantId,
      version: dispatched.version,
    });

    // ...and by execution time the lineage authorizes only metadata reads. The frozen typed `grant`
    // command cannot express a non-snapshot operation, so this seeds the row through the durable,
    // tenant-explicit API — the same one the conformance suite drives.
    const narrowed = await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_SOURCE_PROFILE,
      allowedOperations: ['read_metadata'],
      scopes: ['source.metadata'],
    });
    expect(narrowed.grantId).not.toBe(dispatched.grantId);

    const reads = vi.spyOn(FakeSourceReader.prototype, 'readSnapshot');
    const runtime = createWorkerRuntime(harness);
    const run = await claimNextRun(harness, WORKER_ID);

    await expectFailClosed({
      occurrenceId,
      taskId,
      result: await runOnce(runtime, run),
      innerReads: reads.mock.calls.length,
    });
  });

  it('B. re-grant with different operations and scopes after dispatch: 0 inner reads, 0 Outcomes', async () => {
    const dispatched = await grantConsent(harness);
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);

    // The re-grant still authorizes `read_snapshot`, so nothing about the new terms would stop a
    // read on its own: only the fact that the OCCURRENCE was fenced under a different generation
    // can refuse this execution.
    const widened = await grantConsent(harness, {
      allowedOperations: ['read_snapshot'],
      scopes: ['source.readonly', 'source.readwrite'],
    });
    expect(widened.grantId).not.toBe(dispatched.grantId);
    expect(widened.allowedOperations).toContain('read_snapshot');

    const reads = vi.spyOn(FakeSourceReader.prototype, 'readSnapshot');
    const runtime = createWorkerRuntime(harness);
    const run = await claimNextRun(harness, WORKER_ID);

    await expectFailClosed({
      occurrenceId,
      taskId,
      result: await runOnce(runtime, run),
      innerReads: reads.mock.calls.length,
    });
  });

  it('C. re-grant with identical permissions but a new generation: 0 inner reads, 0 Outcomes', async () => {
    const dispatched = await grantConsent(harness);
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);

    // Revoke + re-grant: every term is back to what DISPATCH saw — same operations, same scopes,
    // `active` again. The terms therefore cannot tell G1 from G2; only the generation identity can.
    await revokeConsent(harness);
    const regranted = await grantConsent(harness);

    expect(regranted.allowedOperations).toEqual(dispatched.allowedOperations);
    expect(regranted.scopes).toEqual(dispatched.scopes);
    expect(regranted.version).toBeGreaterThan(dispatched.version);
    expect(regranted.grantId).not.toBe(dispatched.grantId);

    const reads = vi.spyOn(FakeSourceReader.prototype, 'readSnapshot');
    const runtime = createWorkerRuntime(harness);
    const run = await claimNextRun(harness, WORKER_ID);

    await expectFailClosed({
      occurrenceId,
      taskId,
      result: await runOnce(runtime, run),
      innerReads: reads.mock.calls.length,
    });
  });

  it('D. expired grant with the Worker clock behind PostgreSQL: 0 inner reads, 0 Outcomes', async () => {
    await grantConsent(harness, { expiresAt: await futureExpiry(db) });
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);

    // The grant expires while the occurrence waits for a Worker to pick it up.
    const expiredAt = await expireGrantInThePast(db, harness.ctx.tenantId);

    // The Worker's own JavaScript clock runs six hours behind PostgreSQL. If that clock were handed
    // to the authority, the grant would be reported as still active — which is exactly why the
    // production wiring passes no clock and the durable store decides expiry itself.
    const workerClock: ExecutionClock = { now: () => new Date(Date.now() - CLOCK_SKEW_MS) };
    expect(expiredAt.getTime()).toBeGreaterThan(workerClock.now().getTime());

    const naiveView = await harness.consent.getForTenant(
      harness.ctx.tenantId,
      FIXTURE_SOURCE_PROFILE,
      workerClock.now(),
    );
    expect(naiveView?.status).toBe('active');

    // The authoritative view, evaluated by PostgreSQL's clock, is `expired`.
    const authoritative = await harness.consent.resolveGeneration(
      harness.ctx.tenantId,
      FIXTURE_SOURCE_PROFILE,
    );
    expect(authoritative?.status).toBe('expired');

    const reads = vi.spyOn(FakeSourceReader.prototype, 'readSnapshot');
    const runtime = createWorkerRuntime(harness, { clock: workerClock });
    const run = await claimNextRun(harness, WORKER_ID);

    await expectFailClosed({
      occurrenceId,
      taskId,
      result: await runOnce(runtime, run),
      innerReads: reads.mock.calls.length,
    });
  });

  it('E. revocation committed mid-read discards the snapshot: 1 inner read, 0 Outcomes', async () => {
    await grantConsent(harness);
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);

    let readStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let releaseRead: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    const reads = vi.spyOn(FakeSourceReader.prototype, 'readSnapshot');
    reads.mockImplementationOnce(
      async (sourceProfileId: string, context: TrustedSourceAccessContext, signal: AbortSignal) => {
        readStarted();
        await gate;
        return providerRead(sourceProfileId, context, signal);
      },
    );

    const runtime = createWorkerRuntime(harness);
    const run = await claimNextRun(harness, WORKER_ID);
    const execution = runOnce(runtime, run);

    // The provider really is mid-read: authorization was valid when it started.
    await started;

    // A DIFFERENT PostgreSQL connection (the observer pool) commits the revocation while the read
    // is still blocked in flight.
    const revokingConnection = new PostgresConsentRepository(db.observerPool);
    const revoked = await revokingConnection.revokeForTenant(
      harness.ctx.tenantId,
      FIXTURE_SOURCE_PROFILE,
    );
    expect(revoked.status).toBe('revoked');

    releaseRead();

    const result = await execution;

    // The read DID happen — and its snapshot is discarded, not published.
    expect(reads).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('failed_terminal');
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);
    expect((await readOccurrence(db, occurrenceId))?.status).toBe('failed');
    expect(await readRunCount(db, taskId)).toBe(1);
  });

  it('F. an unrevoked, unexpired generation runs: 1 inner read, exactly 1 Outcome', async () => {
    const granted = await grantConsent(harness);
    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);

    const reads = vi.spyOn(FakeSourceReader.prototype, 'readSnapshot');
    const runtime = createWorkerRuntime(harness);
    const run = await claimNextRun(harness, WORKER_ID);
    const result = await runOnce(runtime, run);

    expect(result).toEqual({ outcome: 'succeeded', accepted: true });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await readOutcomeCount(db, occurrenceId)).toBe(1);
    expect(await readOccurrence(db, occurrenceId)).toMatchObject({
      status: 'completed',
      task_id: taskId,
    });

    // The generation the Outcome was published under is the one DISPATCH recorded.
    expect(await readOccurrenceConsentGeneration(db, occurrenceId)).toEqual({
      grantId: granted.grantId,
      version: granted.version,
    });
  });
});

async function truncateRuntimeTables(database: TestDatabase): Promise<void> {
  await database.pool.query(`
    TRUNCATE TABLE
      commitment_outcomes,
      commitment_occurrences,
      commitments,
      consent_grants,
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
