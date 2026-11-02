import { randomUUID } from 'node:crypto';
import { deriveTaskCreationIdempotencyKey, type WorkerLeaseGrant } from '@ember/contracts';
import type { AuthContext, LeasedRun } from '@ember/domain';
import {
  PostgresAgentRepository,
  PostgresCommitmentRepository,
  PostgresCommitmentTaskDispatcher,
  PostgresLeaseQueue,
  PostgresTaskRepository,
  systemClock,
} from '@ember/postgres';
import type { TestDatabase } from './database.js';
import { createTenantFixture, type TenantFixture } from './fixtures.js';
import {
  createTestConsentPublicationGuard,
  InMemoryTestConsentAuthority,
} from './consent-test-double.js';

/** Deterministic fixture Source Profile exposed by Lane C's fake source reader. */
export const FIXTURE_SOURCE_PROFILE = 'sp_ember_releases';

export interface CommitmentHarness {
  readonly db: TestDatabase;
  readonly tenant: TenantFixture;
  readonly ctx: AuthContext;
  readonly agentId: string;
  readonly commitments: PostgresCommitmentRepository;
  readonly consent: InMemoryTestConsentAuthority;
  readonly tasks: PostgresTaskRepository;
  readonly dispatcher: PostgresCommitmentTaskDispatcher;
  readonly queue: PostgresLeaseQueue;
}

export interface CommitmentHarnessOptions {
  readonly leaseDurationMs?: number;
}

/**
 * PostgreSQL composition used by the P0-C3B integration suites: tenant + agent fixture, actual
 * commitment/Task repositories, the Scheduler's Task dispatcher and the real lease queue.
 * Consent is an explicit in-memory test fixture because Lane C has no durable implementation;
 * it cannot satisfy the consent transaction acceptance requirement.
 */
export async function createCommitmentHarness(
  db: TestDatabase,
  options: CommitmentHarnessOptions = {},
): Promise<CommitmentHarness> {
  const tenant = await createTenantFixture(db.pool, 'P0-C3B runtime tenant');
  const ctx: AuthContext = {
    tenantId: tenant.tenantId,
    principalId: tenant.principalId,
    policyVersion: 1,
  };

  const agents = new PostgresAgentRepository(db.pool);
  const agent = await agents.create(ctx, { name: 'P0-C3B runtime agent', policyVersion: 1 });

  const tasks = new PostgresTaskRepository(db.pool);
  const consent = new InMemoryTestConsentAuthority();
  const queue = new PostgresLeaseQueue(db.pool, {
    leaseDurationMs: options.leaseDurationMs ?? 30_000,
    heartbeatIntervalMs: Math.max(1_000, Math.floor((options.leaseDurationMs ?? 30_000) / 3)),
    baseDelayMs: 1_000,
    capDelayMs: 30_000,
    reaperBatchSize: 10,
    clock: systemClock,
  });

  return {
    db,
    tenant,
    ctx,
    agentId: agent.agentId,
    commitments: new PostgresCommitmentRepository(db.pool, {
      consentPublicationGuard: createTestConsentPublicationGuard(consent),
    }),
    consent,
    tasks,
    dispatcher: new PostgresCommitmentTaskDispatcher(db.pool, tasks),
    queue,
  };
}

export interface CreateCommitmentOptions {
  readonly scheduleKind?: 'once' | 'interval';
  readonly intervalSeconds?: number;
  readonly sourceProfileId?: string;
  readonly dueAt?: Date;
}

export async function createCommitment(
  harness: CommitmentHarness,
  options: CreateCommitmentOptions = {},
): Promise<{ readonly commitmentId: string; readonly version: number }> {
  const scheduleKind = options.scheduleKind ?? 'once';
  const { commitment } = await harness.commitments.create(harness.ctx, {
    idempotencyKey: `commitment-${randomUUID()}`,
    agentId: harness.agentId,
    title: 'P0-C3B runtime commitment',
    scheduleKind,
    ...(scheduleKind === 'interval' ? { intervalSeconds: options.intervalSeconds ?? 900 } : {}),
    // Overdue by one minute so the Scheduler's due discovery (DB clock) picks it up.
    dueAt: options.dueAt ?? new Date(Date.now() - 60_000),
    sourceProfileId: options.sourceProfileId ?? FIXTURE_SOURCE_PROFILE,
  });

  return { commitmentId: commitment.commitment_id, version: commitment.version };
}

/**
 * Reserve an occurrence slot and dispatch its durable Task through the Scheduler's dispatcher,
 * exactly as `CommitmentScheduler.tick()` does.
 */
export async function reserveAndDispatch(
  harness: CommitmentHarness,
  commitmentId: string,
  version: number,
): Promise<{ readonly occurrenceId: string; readonly taskId: string }> {
  const slot = await harness.commitments.reserveOccurrence(commitmentId, version);

  if (slot === null) {
    throw new Error('occurrence slot was not reserved');
  }

  const commitment = await harness.commitments.get(harness.ctx, commitmentId);

  if (commitment === null) {
    throw new Error('commitment disappeared after reservation');
  }

  const receipt = await harness.dispatcher.dispatchTask({
    tenantId: harness.ctx.tenantId,
    agentId: harness.agentId,
    commitmentId,
    occurrenceId: slot.occurrenceId,
    idempotencyKey: deriveTaskCreationIdempotencyKey(slot.occurrenceId),
    kind: 'mock.compute',
    input: {
      operation: 'sha256',
      text: JSON.stringify({
        commitmentId,
        occurrenceId: slot.occurrenceId,
        sourceProfileId: commitment.source_profile_id,
        scheduleKind: commitment.schedule_kind,
      }),
    },
  });

  await harness.commitments.markDispatched(slot.occurrenceId, receipt.taskId);

  return { occurrenceId: slot.occurrenceId, taskId: receipt.taskId };
}

export async function claimNextRun(
  harness: CommitmentHarness,
  workerId: string,
): Promise<LeasedRun> {
  const run = await harness.queue.claimNext(workerId, systemClock.now());

  if (run === null) {
    throw new Error('expected a claimable run');
  }

  return run;
}

export function grantForRun(run: LeasedRun, workerId: string): WorkerLeaseGrant {
  return {
    tenantId: run.tenantId,
    taskId: run.taskId,
    runId: run.runId,
    attempt: run.attempt,
    leaseEpoch: run.leaseEpoch,
    workerId,
  };
}

export async function readOccurrence(
  db: TestDatabase,
  occurrenceId: string,
): Promise<{ readonly status: string; readonly task_id: string | null } | null> {
  const result = await db.pool.query<{ status: string; task_id: string | null }>(
    'SELECT status, task_id FROM commitment_occurrences WHERE id = $1',
    [occurrenceId],
  );

  return result.rows[0] ?? null;
}

export async function readCommitment(
  db: TestDatabase,
  commitmentId: string,
): Promise<{
  readonly status: string;
  readonly next_due_at: Date | null;
  readonly version: number;
} | null> {
  const result = await db.pool.query<{
    status: string;
    next_due_at: Date | null;
    version: number;
  }>('SELECT status, next_due_at, version FROM commitments WHERE id = $1', [commitmentId]);

  return result.rows[0] ?? null;
}

export async function readOutcomeCount(db: TestDatabase, occurrenceId: string): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM commitment_outcomes WHERE occurrence_id = $1',
    [occurrenceId],
  );

  return Number(result.rows[0]?.count ?? '0');
}
