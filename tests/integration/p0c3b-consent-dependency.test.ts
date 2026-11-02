import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppendOutcomeCommand } from '@ember/contracts';
import { PostgresCommitmentRepository } from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  claimNextRun,
  createCommitment,
  createCommitmentHarness,
  grantForRun,
  readOutcomeCount,
  reserveAndDispatch,
} from './support/commitment-runtime.js';

/**
 * Lane C currently has no durable PostgreSQL consent implementation. These tests verify the
 * production repository's safe behavior while that dependency is absent; they are not consent
 * persistence or revocation-race acceptance tests.
 */
describe('P0-C3B: missing durable consent dependency fails closed', () => {
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
});
