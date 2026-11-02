import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppendOutcomeCommand } from '@ember/contracts';
import { deriveTaskCreationIdempotencyKey } from '@ember/contracts';
import { PostgresCommitmentRepository } from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  FIXTURE_SOURCE_PROFILE,
  claimNextRun,
  createCommitment,
  createCommitmentHarness,
  grantForRun,
  readOccurrence,
  readOutcomeCount,
  reserveAndDispatch,
} from './support/commitment-runtime.js';

/**
 * P0-C3D closes the "no durable consent" hole in both directions.
 *
 * A repository constructed without a consent guard holds the deny-all default, and the default is
 * now armed at DISPATCH as well as at publication: an occurrence cannot be bound to a Task without
 * an authoritative generation, and an Outcome cannot be published without presenting that same
 * generation. These cases are about the FAIL-CLOSED default; the durable behaviour (grants,
 * revocation races, generation reuse) is covered by `p0c3d-consent-postgres.test.ts`.
 */
describe('P0-C3B/P0-C3D: missing durable consent dependency fails closed', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  it('does not publish an Outcome when no transaction-level consent authority is configured', async () => {
    const harness = await createCommitmentHarness(db);
    const repositoryWithoutConsent = new PostgresCommitmentRepository(db.pool);

    // The in-memory fixture store is synchronous, like `ConsentRegistry.grant`; the authority
    // adapter is what adds asynchrony. Awaiting it would imply a durable write that does not happen.
    harness.consent.grant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_SOURCE_PROFILE,
    });

    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);
    const run = await claimNextRun(harness, 'worker-no-consent-authority');
    const grant = grantForRun(run, 'worker-no-consent-authority');
    const command: AppendOutcomeCommand = {
      occurrenceId,
      commitmentId,
      taskId,
      summary: 'must not publish',
      resultStatus: 'meaningful_change',
    };

    await expect(repositoryWithoutConsent.appendOutcomeIfAbsent(grant, command)).rejects.toThrow(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
    expect(await readOutcomeCount(db, occurrenceId)).toBe(0);

    await expect(
      repositoryWithoutConsent.findAuthoritativeOutcome(grant, { commitmentId, occurrenceId }),
    ).rejects.toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });

  it('refuses to dispatch an occurrence when no consent authority is configured', async () => {
    const harness = await createCommitmentHarness(db);
    const repositoryWithoutConsent = new PostgresCommitmentRepository(db.pool);
    const { commitmentId, version } = await createCommitment(harness);

    const slot = await harness.commitments.reserveOccurrence(commitmentId, version);

    if (slot === null) {
      throw new Error('occurrence slot was not reserved');
    }

    const receipt = await harness.dispatcher.dispatchTask({
      tenantId: harness.ctx.tenantId,
      agentId: harness.agentId,
      commitmentId,
      occurrenceId: slot.occurrenceId,
      idempotencyKey: deriveTaskCreationIdempotencyKey(slot.occurrenceId),
      kind: 'mock.compute',
      input: { operation: 'sha256', text: JSON.stringify({ commitmentId }) },
    });

    await expect(
      repositoryWithoutConsent.markDispatched(slot.occurrenceId, receipt.taskId),
    ).rejects.toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));

    // The occurrence is untouched: a refused dispatch must not leave a half-bound row behind.
    await expect(readOccurrence(db, slot.occurrenceId)).resolves.toMatchObject({
      status: 'pending',
      task_id: null,
    });
  });
});
