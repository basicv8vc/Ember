import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CONSENT_OPERATIONS,
  DEFAULT_CONSENT_SCOPES,
  deriveTaskCreationIdempotencyKey,
  type ConsentOperation,
  type PersistedConsentGrant,
  type WorkerLeaseGrant,
} from '@ember/contracts';
import type { AuthContext, LeasedRun } from '@ember/domain';
import {
  fromResolvedGenerationConsent,
  type ConsentFenceAuthority,
  type ConsentGrantSource,
} from '@ember/execution';
import {
  PostgresAgentRepository,
  PostgresCommitmentRepository,
  PostgresCommitmentTaskDispatcher,
  PostgresConsentPublicationGuard,
  PostgresConsentRepository,
  PostgresLeaseQueue,
  PostgresTaskRepository,
  systemClock,
} from '@ember/postgres';
import type { TestDatabase } from './database.js';
import { createTenantFixture, type TenantFixture } from './fixtures.js';

/** Deterministic fixture Source Profile exposed by Lane C's fake source reader. */
export const FIXTURE_SOURCE_PROFILE = 'sp_ember_releases';

export interface CommitmentHarness {
  readonly db: TestDatabase;
  readonly tenant: TenantFixture;
  readonly ctx: AuthContext;
  readonly agentId: string;
  readonly commitments: PostgresCommitmentRepository;
  /**
   * Authoritative DURABLE Consent (P0-C3D, PostgreSQL).
   *
   * Tests grant and revoke through it. It is never handed to the Worker as an authority — only the
   * adapted fence gates below are — but it IS the grant record the read boundary evaluates policy
   * against, so a test cannot grant something one component sees and another does not.
   */
  readonly consent: PostgresConsentRepository;
  /** The exact object the Worker is wired with: canonical authority + fence gates. */
  readonly consentAuthority: ConsentFenceAuthority;
  /** The durable grant record the read boundary evaluates policy against — the same repository. */
  readonly consentGrants: ConsentGrantSource;
  readonly tasks: PostgresTaskRepository;
  readonly dispatcher: PostgresCommitmentTaskDispatcher;
  readonly queue: PostgresLeaseQueue;
}

export interface CommitmentHarnessOptions {
  readonly leaseDurationMs?: number;
}

/**
 * PostgreSQL composition used by the P0-C3B/P0-C3D integration suites: tenant + agent fixture,
 * actual commitment/Task repositories, the Scheduler's Task dispatcher, the real lease queue and
 * authoritative DURABLE consent.
 *
 * Consent is a `PostgresConsentRepository` over the same database, adapted once by the production
 * `fromResolvedGenerationConsent`. Two properties follow, and both are the point of P0-C3D:
 *
 * - the authority that mints/verifies fences, the grant record the read boundary evaluates policy
 *   against, and the transaction-scoped publication guard all read the SAME rows, so a generation
 *   can never be authorized in one place and evaluated from another;
 * - dispatch, revocation and publication are separate committed transactions, so the
 *   dispatch-to-execution gap is reproduced rather than assumed away.
 *
 * Nothing here fabricates a permission: a source read succeeds only when a real `consent_grants`
 * row authorizes it.
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
  // The same wiring the production composition root performs: one durable repository, adapted ONCE,
  // and every Worker gate plus the publication guard consumes that single object graph.
  const consent = new PostgresConsentRepository(db.pool);
  const consentGrants: ConsentGrantSource = {
    get: (tenantId, sourceProfileId, now) => consent.getForTenant(tenantId, sourceProfileId, now),
  };
  const consentAuthority = fromResolvedGenerationConsent(consent, { grants: consentGrants });
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
      consentPublicationGuard: new PostgresConsentPublicationGuard(),
    }),
    consent,
    consentAuthority,
    consentGrants,
    tasks,
    dispatcher: new PostgresCommitmentTaskDispatcher(db.pool, tasks),
    queue,
  };
}

export interface GrantConsentOptions {
  readonly sourceProfileId?: string;
  readonly allowedOperations?: readonly ConsentOperation[];
  readonly scopes?: readonly string[];
  /** ISO instant. Omit (or pass `null`) for a grant that never expires. */
  readonly expiresAt?: string | null;
}

/**
 * Grant — or explicitly re-grant — Consent through the DURABLE repository.
 *
 * The defaults are the connector contract's read requirements (`read_snapshot` +
 * `source.readonly`), exactly like the production caller, so a test that wants a narrower grant has
 * to ask for one. An identical re-grant of a still-effective grant replays and keeps the
 * generation; changed terms, or a grant after a revocation, mint a new `grantId` and bump
 * `version`.
 */
export async function grantConsent(
  harness: CommitmentHarness,
  options: GrantConsentOptions = {},
): Promise<PersistedConsentGrant> {
  const { consent } = await harness.consent.grant(harness.ctx, {
    sourceProfileId: options.sourceProfileId ?? FIXTURE_SOURCE_PROFILE,
    allowedOperations: [...(options.allowedOperations ?? DEFAULT_CONSENT_OPERATIONS)],
    scopes: [...(options.scopes ?? DEFAULT_CONSENT_SCOPES)],
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  });

  return consent;
}

/** Revoke Consent for one Source Profile through the DURABLE repository. */
export async function revokeConsent(
  harness: CommitmentHarness,
  options: { readonly sourceProfileId?: string } = {},
): Promise<PersistedConsentGrant> {
  return harness.consent.revokeForTenant(
    harness.ctx.tenantId,
    options.sourceProfileId ?? FIXTURE_SOURCE_PROFILE,
  );
}

/**
 * The Consent generation DISPATCH recorded on the occurrence.
 *
 * Read back from the row rather than remembered from the test, so an assertion about "this
 * occurrence was fenced under G1" is about persisted state.
 */
export async function readOccurrenceConsentGeneration(
  db: TestDatabase,
  occurrenceId: string,
): Promise<{ readonly grantId: string | null; readonly version: number | null }> {
  const result = await db.pool.query<{
    consent_grant_id: string | null;
    consent_version: number | null;
  }>('SELECT consent_grant_id, consent_version FROM commitment_occurrences WHERE id = $1', [
    occurrenceId,
  ]);
  const row = result.rows[0];

  return { grantId: row?.consent_grant_id ?? null, version: row?.consent_version ?? null };
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
