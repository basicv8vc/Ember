import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppendOutcomeCommand, WorkerLeaseGrant } from '@ember/contracts';
import { systemClock } from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  claimNextRun,
  createCommitment,
  createCommitmentHarness,
  grantConsent,
  grantForRun,
  readCommitment,
  readOccurrence,
  readOutcomeCount,
  reserveAndDispatch,
  type CommitmentHarness,
} from './support/commitment-runtime.js';

/**
 * P0-C3B Task 2 - terminal Occurrence lifecycle against real PostgreSQL.
 *
 * The invariant under test: an Occurrence is `pending` -> `dispatched` -> exactly one of
 * `completed` / `failed` / `cancelled`, the transition is authorized by persisted Task/Run state,
 * it is idempotent, and a stale Worker attempt can never perform it.
 */
describe('P0-C3B: terminal occurrence lifecycle', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  interface Prepared {
    readonly harness: CommitmentHarness;
    readonly commitmentId: string;
    readonly occurrenceId: string;
    readonly taskId: string;
    readonly grant: WorkerLeaseGrant;
    readonly cmd: AppendOutcomeCommand;
    readonly lease: {
      readonly tenantId: string;
      readonly taskId: string;
      readonly runId: string;
      readonly attempt: number;
      readonly leaseEpoch: number;
      readonly leaseExpiresAt: string;
    };
  }

  async function prepare(
    workerId = 'worker-lifecycle',
    scheduleKind: 'once' | 'interval' = 'once',
  ): Promise<Prepared> {
    const harness = await createCommitmentHarness(db);
    await grantConsent(harness);

    const { commitmentId, version } = await createCommitment(harness, { scheduleKind });
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, workerId);

    return {
      harness,
      commitmentId,
      occurrenceId,
      taskId,
      grant: grantForRun(run, workerId),
      cmd: {
        occurrenceId,
        commitmentId,
        taskId,
        summary: 'Lifecycle outcome',
        resultStatus: 'meaningful_change',
      },
      lease: {
        tenantId: run.tenantId,
        taskId: run.taskId,
        runId: run.runId,
        attempt: run.attempt,
        leaseEpoch: run.leaseEpoch,
        leaseExpiresAt: run.leaseExpiresAt,
      },
    };
  }

  it('marks the occurrence completed and terminalizes a one-shot commitment on success', async () => {
    const prepared = await prepare();

    expect(
      await prepared.harness.commitments.appendOutcomeIfAbsent(prepared.grant, prepared.cmd),
    ).toBe(true);

    const occurrence = await readOccurrence(db, prepared.occurrenceId);
    const commitment = await readCommitment(db, prepared.commitmentId);

    expect(occurrence?.status).toBe('completed');
    expect(commitment?.status).toBe('completed');
    expect(commitment?.next_due_at).toBeNull();
    expect(await readOutcomeCount(db, prepared.occurrenceId)).toBe(1);

    // The published outcome is never duplicated.
    expect(
      await prepared.harness.commitments.appendOutcomeIfAbsent(prepared.grant, prepared.cmd),
    ).toBe(false);
  });

  it('moves a permanently failed occurrence to failed and keeps Task/Run consistent', async () => {
    const prepared = await prepare();
    expect(await prepared.harness.queue.finish(prepared.lease, 'failed_terminal')).toBe(true);

    const finalized = await prepared.harness.commitments.finalizeOccurrenceFromTask(
      prepared.grant,
      {
        commitmentId: prepared.commitmentId,
        occurrenceId: prepared.occurrenceId,
        terminalStatus: 'failed',
        reasonCode: 'sentinel_denied',
      },
    );

    expect(finalized).toBe(true);
    expect((await readOccurrence(db, prepared.occurrenceId))?.status).toBe('failed');

    const task = await db.pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
      prepared.taskId,
    ]);
    expect(task.rows[0]?.status).toBe('failed');

    // A one-shot promise with a permanently failed execution reaches its terminal state.
    expect((await readCommitment(db, prepared.commitmentId))?.status).toBe('completed');
    expect(await readOutcomeCount(db, prepared.occurrenceId)).toBe(0);

    // Idempotent: a second terminal transition changes nothing.
    expect(
      await prepared.harness.commitments.finalizeOccurrenceFromTask(prepared.grant, {
        commitmentId: prepared.commitmentId,
        occurrenceId: prepared.occurrenceId,
        terminalStatus: 'failed',
        reasonCode: 'sentinel_denied',
      }),
    ).toBe(false);
  });

  it('leaves the occurrence dispatched while the Task is only retryable', async () => {
    const prepared = await prepare();
    expect(await prepared.harness.queue.finish(prepared.lease, 'failed_retryable')).toBe(true);

    const finalized = await prepared.harness.commitments.finalizeOccurrenceFromTask(
      prepared.grant,
      {
        commitmentId: prepared.commitmentId,
        occurrenceId: prepared.occurrenceId,
        terminalStatus: 'failed',
        reasonCode: 'execution_failed',
      },
    );

    expect(finalized).toBe(false);
    expect((await readOccurrence(db, prepared.occurrenceId))?.status).toBe('dispatched');
    // The retry owns the Occurrence; the commitment stays active with a future execution.
    expect((await readCommitment(db, prepared.commitmentId))?.status).toBe('active');
  });

  it('cancels a dispatched occurrence when the commitment is cancelled', async () => {
    const prepared = await prepare();

    const cancelled = await prepared.harness.commitments.cancel(
      prepared.harness.ctx,
      prepared.commitmentId,
    );

    expect(cancelled.status).toBe('cancelled');
    expect((await readOccurrence(db, prepared.occurrenceId))?.status).toBe('cancelled');

    await expect(
      prepared.harness.commitments.appendOutcomeIfAbsent(prepared.grant, prepared.cmd),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
    expect(await readOutcomeCount(db, prepared.occurrenceId)).toBe(0);
  });

  it('rejects a terminal transition from an attempt that does not own the Run', async () => {
    const prepared = await prepare();

    const command = {
      commitmentId: prepared.commitmentId,
      occurrenceId: prepared.occurrenceId,
      terminalStatus: 'failed' as const,
      reasonCode: 'execution_failed' as const,
    };

    for (const staleGrant of [
      { ...prepared.grant, attempt: prepared.grant.attempt + 1 },
      { ...prepared.grant, leaseEpoch: prepared.grant.leaseEpoch + 1 },
      { ...prepared.grant, workerId: 'worker-impostor' },
    ]) {
      await expect(
        prepared.harness.commitments.finalizeOccurrenceFromTask(staleGrant, command),
      ).rejects.toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }));
    }

    expect((await readOccurrence(db, prepared.occurrenceId))?.status).toBe('dispatched');
  });

  it('never lets a worker whose lease was reaped finalize the occurrence', async () => {
    const prepared = await prepare('worker-old');
    const { queue } = prepared.harness;

    // Expire the lease in the database, then let the Reaper move the Task to a retry and free it
    // for another Worker attempt.
    await db.pool.query(
      `UPDATE tasks
          SET lease_expires_at = created_at
        WHERE id = $1`,
      [prepared.taskId],
    );
    await db.pool.query(
      `UPDATE runs SET leased_until = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [prepared.grant.runId],
    );

    const reaped = await queue.reapExpired(systemClock.now());
    expect(reaped).toBeGreaterThanOrEqual(1);

    await db.pool.query(
      `UPDATE tasks SET next_run_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [prepared.taskId],
    );

    const takeover = await claimNextRun(prepared.harness, 'worker-new');
    expect(takeover.attempt).toBeGreaterThan(prepared.grant.attempt);

    // The old attempt can neither publish an outcome nor terminalize the occurrence.
    await expect(
      prepared.harness.commitments.appendOutcomeIfAbsent(prepared.grant, prepared.cmd),
    ).rejects.toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }));

    const finalized = await prepared.harness.commitments.finalizeOccurrenceFromTask(
      prepared.grant,
      {
        commitmentId: prepared.commitmentId,
        occurrenceId: prepared.occurrenceId,
        terminalStatus: 'failed',
        reasonCode: 'execution_failed',
      },
    );

    expect(finalized).toBe(false);
    expect((await readOccurrence(db, prepared.occurrenceId))?.status).toBe('dispatched');
  });

  it('sweeps a dispatched occurrence whose Task already failed', async () => {
    const prepared = await prepare('worker-sweep');
    expect(await prepared.harness.queue.finish(prepared.lease, 'failed_terminal')).toBe(true);

    // No worker finalizer ran (simulated crash after finish).
    expect((await readOccurrence(db, prepared.occurrenceId))?.status).toBe('dispatched');

    const reconciled = await prepared.harness.commitments.reconcileTerminalOccurrences(10);
    expect(reconciled).toBeGreaterThanOrEqual(1);
    expect((await readOccurrence(db, prepared.occurrenceId))?.status).toBe('failed');

    // Idempotent: nothing left to do.
    expect(await prepared.harness.commitments.reconcileTerminalOccurrences(10)).toBe(0);
  });
});
