import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_TENANT_A,
  TEST_TENANT_B,
  assertConsentConformance,
  type ConsentConformanceAdapter,
} from '@ember/connectors';
import {
  deriveTaskCreationIdempotencyKey,
  type AppendOutcomeCommand,
  type PersistedConsentGrant,
  type WorkerLeaseGrant,
} from '@ember/contracts';
import { DomainError, type AuthContext, type LeasedRun } from '@ember/domain';
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
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createTenantFixture, type TenantFixture } from './support/fixtures.js';

/**
 * P0-C3D acceptance: authoritative PostgreSQL consent persistence plus the versioned
 * authorization fence that dispatch and publication run on.
 *
 * Everything here talks to a real PostgreSQL: real migrations, real row locks, real concurrent
 * transactions. The only translation is at the conformance boundary, where the frozen P0-C3C
 * suite addresses synthetic lineage ids (`tenant_1111...`) that the durable table stores as real
 * `uuid` tenant keys with a foreign key. That translation is confined to `createConformanceAdapter`
 * and is fully reversible, so every semantic assertion still runs against the database.
 */

const FIXTURE_PROFILE = 'sp_ember_releases';

let db: TestDatabase;

interface Harness {
  readonly tenant: TenantFixture;
  readonly ctx: AuthContext;
  readonly agentId: string;
  readonly consent: PostgresConsentRepository;
  readonly commitments: PostgresCommitmentRepository;
  readonly dispatcher: PostgresCommitmentTaskDispatcher;
  readonly queue: PostgresLeaseQueue;
}

async function createHarness(db: TestDatabase, name: string): Promise<Harness> {
  const tenant = await createTenantFixture(db.pool, name);
  const ctx: AuthContext = {
    tenantId: tenant.tenantId,
    principalId: tenant.principalId,
    policyVersion: 1,
  };

  const agents = new PostgresAgentRepository(db.pool);
  const agent = await agents.create(ctx, { name: `${name} agent`, policyVersion: 1 });
  const tasks = new PostgresTaskRepository(db.pool);

  return {
    tenant,
    ctx,
    agentId: agent.agentId,
    consent: new PostgresConsentRepository(db.pool),
    // The REAL publication guard: it locks the consent row inside the publishing transaction.
    commitments: new PostgresCommitmentRepository(db.pool, {
      consentPublicationGuard: new PostgresConsentPublicationGuard(),
    }),
    dispatcher: new PostgresCommitmentTaskDispatcher(db.pool, tasks),
    queue: new PostgresLeaseQueue(db.pool, {
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      baseDelayMs: 1_000,
      capDelayMs: 30_000,
      reaperBatchSize: 10,
      clock: systemClock,
    }),
  };
}

async function createCommitment(
  harness: Harness,
  sourceProfileId = FIXTURE_PROFILE,
): Promise<{ commitmentId: string; version: number }> {
  const { commitment } = await harness.commitments.create(harness.ctx, {
    idempotencyKey: `p0c3d-${randomUUID()}`,
    agentId: harness.agentId,
    title: 'P0-C3D consent commitment',
    scheduleKind: 'once',
    dueAt: new Date(Date.now() - 60_000),
    sourceProfileId,
  });

  return { commitmentId: commitment.commitment_id, version: commitment.version };
}

async function reserveAndDispatch(
  harness: Harness,
  commitmentId: string,
  version: number,
): Promise<{ occurrenceId: string; taskId: string }> {
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

  await harness.commitments.markDispatched(slot.occurrenceId, receipt.taskId);

  return { occurrenceId: slot.occurrenceId, taskId: receipt.taskId };
}

/**
 * Claims the Run for THIS test's Task.
 *
 * The queue is shared by every case in this file, so `claimNext` may legitimately hand back work
 * belonging to an earlier case. Those Runs stay leased (their cases are already finished) and the
 * loop keeps claiming until the expected Task appears, which keeps each assertion scoped to the
 * occurrence it created.
 */
async function claimRun(
  harness: Harness,
  workerId: string,
  expectedTaskId: string,
): Promise<WorkerLeaseGrant> {
  let run: LeasedRun | null = null;

  for (let attempt = 0; attempt < 25; attempt += 1) {
    run = await harness.queue.claimNext(workerId, systemClock.now());

    if (run === null) {
      throw new Error('expected a claimable run');
    }

    if (run.taskId === expectedTaskId) {
      break;
    }

    run = null;
  }

  if (run === null) {
    throw new Error('expected a claimable run for the dispatched Task');
  }

  return {
    tenantId: run.tenantId,
    taskId: run.taskId,
    runId: run.runId,
    attempt: run.attempt,
    leaseEpoch: run.leaseEpoch,
    workerId,
  };
}

function outcomeCommand(params: {
  occurrenceId: string;
  commitmentId: string;
  taskId: string;
  summary?: string;
}): AppendOutcomeCommand {
  return {
    occurrenceId: params.occurrenceId,
    commitmentId: params.commitmentId,
    taskId: params.taskId,
    summary: params.summary ?? 'published under a consent generation',
    resultStatus: 'meaningful_change',
  };
}

async function readOccurrenceFence(
  occurrenceId: string,
): Promise<{ grantId: string | null; version: number | null; status: string }> {
  const result = await db.pool.query<{
    consent_grant_id: string | null;
    consent_version: number | null;
    status: string;
  }>('SELECT consent_grant_id, consent_version, status FROM commitment_occurrences WHERE id = $1', [
    occurrenceId,
  ]);
  const row = result.rows[0];

  if (row === undefined) {
    throw new Error('occurrence disappeared');
  }

  return { grantId: row.consent_grant_id, version: row.consent_version, status: row.status };
}

async function countOutcomes(occurrenceId: string): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM commitment_outcomes WHERE occurrence_id = $1',
    [occurrenceId],
  );

  return Number(result.rows[0]?.count ?? '0');
}

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.close();
});

describe('P0-C3D: PostgreSQL consent conformance (C-01..C-13)', () => {
  it('certifies the durable store against the frozen P0-C3C contract', async () => {
    // The suite addresses two synthetic tenant lineages; the durable table keys tenants as real
    // uuid rows with a foreign key, so the adapter translates identity (and nothing else).
    const tenantA = await createTenantFixture(db.pool, 'P0-C3D conformance tenant A');
    const tenantB = await createTenantFixture(db.pool, 'P0-C3D conformance tenant B');
    const repo = new PostgresConsentRepository(db.pool);

    const toDb = new Map<string, string>([
      [TEST_TENANT_A, tenantA.tenantId],
      [TEST_TENANT_B, tenantB.tenantId],
    ]);
    const fromDb = new Map<string, string>([
      [tenantA.tenantId, TEST_TENANT_A],
      [tenantB.tenantId, TEST_TENANT_B],
    ]);

    const project = (grant: PersistedConsentGrant): PersistedConsentGrant => ({
      ...grant,
      tenantId: fromDb.get(grant.tenantId) ?? grant.tenantId,
    });

    const adapter: ConsentConformanceAdapter = {
      name: 'PostgresConsentRepository',
      reset: async () => {
        await db.pool.query('DELETE FROM consent_grants WHERE tenant_id = ANY($1::uuid[])', [
          [tenantA.tenantId, tenantB.tenantId],
        ]);
      },
      grant: async (params, now) => {
        const tenantId = toDb.get(params.tenantId);

        if (tenantId === undefined) {
          throw new Error('unsupported tenant in conformance grant');
        }

        return project(
          await repo.grantForTenant(
            {
              tenantId,
              sourceProfileId: params.sourceProfileId,
              ...(params.allowedOperations === undefined
                ? {}
                : { allowedOperations: params.allowedOperations }),
              ...(params.scopes === undefined ? {} : { scopes: params.scopes }),
              expiresAt: params.expiresAt ?? null,
            },
            now,
          ),
        );
      },
      get: async (tenantId, sourceProfileId, now) => {
        const mapped = toDb.get(tenantId);

        // An unknown/malformed tenant must fail closed with `null`, never reach the driver.
        if (mapped === undefined) {
          return null;
        }

        const grant = await repo.getForTenant(mapped, sourceProfileId, now);

        return grant === null ? null : project(grant);
      },
      revoke: async (tenantId, sourceProfileId, now) => {
        const mapped = toDb.get(tenantId);

        if (mapped === undefined) {
          throw new Error('consent grant not found');
        }

        return project(await repo.revokeForTenant(mapped, sourceProfileId, now));
      },
      list: async (tenantId, now) => {
        const mapped = toDb.get(tenantId);

        if (mapped === undefined) {
          return [];
        }

        return (await repo.listForTenant(mapped, now)).map(project);
      },
      resolveGeneration: async (tenantId, sourceProfileId, now) => {
        const mapped = toDb.get(tenantId);

        if (mapped === undefined) {
          return null;
        }

        const generation = await repo.resolveGeneration(mapped, sourceProfileId, now);

        return generation === null
          ? null
          : { ...generation, tenantId: fromDb.get(generation.tenantId) ?? generation.tenantId };
      },
    };

    const results = await assertConsentConformance(adapter);

    expect(results.map((result) => result.id)).toEqual([
      'C-01',
      'C-02',
      'C-03',
      'C-04',
      'C-05',
      'C-06',
      'C-07',
      'C-08',
      'C-09',
      'C-10',
      'C-11',
      'C-12',
      'C-13',
    ]);
    expect(results.every((result) => result.passed)).toBe(true);
  });
});

describe('P0-C3D: scope enforcement (P0-C3C R5)', () => {
  it('denies a read whose grant omits the source.readonly scope', async () => {
    const harness = await createHarness(db, 'P0-C3D scope tenant');

    await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
      allowedOperations: ['read_snapshot'],
      scopes: ['source.readwrite'],
    });

    const decision = await harness.consent.evaluateConsent(
      harness.ctx.tenantId,
      FIXTURE_PROFILE,
      'read_snapshot',
    );

    expect(decision).toMatchObject({ allowed: false, denialCode: 'SCOPE_NOT_GRANTED' });
  });

  it('denies a read when the grant only authorizes an unrelated operation', async () => {
    const harness = await createHarness(db, 'P0-C3D operation tenant');

    await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
      allowedOperations: ['read_metadata'],
      scopes: ['source.readonly'],
    });

    const decision = await harness.consent.evaluateConsent(
      harness.ctx.tenantId,
      FIXTURE_PROFILE,
      'read_snapshot',
    );

    expect(decision).toMatchObject({ allowed: false, denialCode: 'OPERATION_NOT_ALLOWED' });
  });

  it('defaults a grant to the connector contract scopes and authorizes the read', async () => {
    const harness = await createHarness(db, 'P0-C3D default grant tenant');

    const grant = await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });

    expect(grant.scopes).toEqual(['source.readonly']);
    expect(grant.allowedOperations).toEqual(['read_snapshot']);

    const decision = await harness.consent.evaluateConsent(
      harness.ctx.tenantId,
      FIXTURE_PROFILE,
      'read_snapshot',
    );

    expect(decision).toMatchObject({ allowed: true, grantId: grant.grantId });
  });

  it('refuses to dispatch an occurrence when the grant lacks the read scope', async () => {
    const harness = await createHarness(db, 'P0-C3D scoped dispatch tenant');

    await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
      allowedOperations: ['read_snapshot'],
      scopes: [],
    });

    const { commitmentId, version } = await createCommitment(harness);

    await expect(reserveAndDispatch(harness, commitmentId, version)).rejects.toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
  });
});

describe('P0-C3D: generation identity (P0-C3C R6)', () => {
  it('records the generation on the occurrence at dispatch', async () => {
    const harness = await createHarness(db, 'P0-C3D fence record tenant');
    const grant = await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });

    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId } = await reserveAndDispatch(harness, commitmentId, version);

    await expect(readOccurrenceFence(occurrenceId)).resolves.toEqual({
      grantId: grant.grantId,
      version: grant.version,
      status: 'dispatched',
    });
  });

  it('mints a new grantId and a greater version on an explicit re-grant', async () => {
    const harness = await createHarness(db, 'P0-C3D regrant tenant');

    const first = await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });
    await harness.consent.revokeForTenant(harness.ctx.tenantId, FIXTURE_PROFILE);
    const second = await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });

    expect(second.grantId).not.toBe(first.grantId);
    expect(second.version).toBeGreaterThan(first.version);

    const generation = await harness.consent.resolveGeneration(
      harness.ctx.tenantId,
      FIXTURE_PROFILE,
    );

    expect(generation).toMatchObject({ grantId: second.grantId, status: 'active' });
  });

  it('replays an identical reaffirmation without minting a generation', async () => {
    const harness = await createHarness(db, 'P0-C3D reaffirmation tenant');

    const first = await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });
    const second = await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });

    expect(second.grantId).toBe(first.grantId);
    expect(second.version).toBe(first.version);
    expect(second.grantedAt).toBe(first.grantedAt);
  });
});

describe('P0-C3D: publication requires a provable generation', () => {
  it('publishes an outcome that carries the current generation fence', async () => {
    const harness = await createHarness(db, 'P0-C3D publish tenant');
    await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });

    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);
    const grant = await claimRun(harness, `worker-${randomUUID()}`, taskId);

    await expect(
      harness.commitments.appendOutcomeIfAbsent(
        grant,
        outcomeCommand({ occurrenceId, commitmentId, taskId }),
      ),
    ).resolves.toBe(true);
    await expect(countOutcomes(occurrenceId)).resolves.toBe(1);
  });

  it('refuses and terminalizes an occurrence with no recorded generation', async () => {
    const harness = await createHarness(db, 'P0-C3D legacy occurrence tenant');
    await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });

    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);

    // Simulate work dispatched before the fence existed: no generation is recorded at all.
    await db.pool.query(
      `UPDATE commitment_occurrences
          SET consent_grant_id = NULL, consent_version = NULL
        WHERE id = $1`,
      [occurrenceId],
    );

    const grant = await claimRun(harness, `worker-${randomUUID()}`, taskId);

    await expect(
      harness.commitments.appendOutcomeIfAbsent(
        grant,
        outcomeCommand({ occurrenceId, commitmentId, taskId }),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
    await expect(countOutcomes(occurrenceId)).resolves.toBe(0);

    // Re-dispatching it would launder a read across generations, so it is refused too.
    await expect(harness.commitments.markDispatched(occurrenceId, taskId)).rejects.toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );

    // The safe recovery path terminalizes it instead of leaving it stuck forever.
    await expect(
      harness.commitments.failUnverifiableOccurrences(50),
    ).resolves.toBeGreaterThanOrEqual(1);
    await expect(readOccurrenceFence(occurrenceId)).resolves.toMatchObject({ status: 'failed' });

    // Terminal and idempotent: the sweep never touches it twice.
    await harness.commitments.failUnverifiableOccurrences(50);
    await expect(readOccurrenceFence(occurrenceId)).resolves.toMatchObject({ status: 'failed' });
  });

  it('refuses publication under a superseded generation after revoke + re-grant', async () => {
    const harness = await createHarness(db, 'P0-C3D superseded generation tenant');
    await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });

    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);
    const grant = await claimRun(harness, `worker-${randomUUID()}`, taskId);

    await harness.consent.revokeForTenant(harness.ctx.tenantId, FIXTURE_PROFILE);
    const regranted = await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });

    // Consent is ACTIVE again, but it is a different approval: the fence must not bind to it.
    await expect(
      harness.commitments.appendOutcomeIfAbsent(
        grant,
        outcomeCommand({ occurrenceId, commitmentId, taskId }),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
    await expect(countOutcomes(occurrenceId)).resolves.toBe(0);

    const current = await harness.consent.resolveGeneration(harness.ctx.tenantId, FIXTURE_PROFILE);
    expect(current?.grantId).toBe(regranted.grantId);
  });
});

interface PublishResult {
  readonly kind: 'published' | 'denied' | 'other';
  readonly code?: string;
  readonly detail?: unknown;
}

/**
 * Starts a publication and converts it into an inspectable result without ever leaving a dangling
 * rejected promise: the race assertions wait on `settled()`, not on a rejection handler.
 */
function settlePublish(promise: Promise<boolean>): {
  readonly outcome: Promise<PublishResult>;
  readonly settled: () => boolean;
} {
  let done = false;

  const outcome = promise.then(
    (): PublishResult => {
      done = true;
      return { kind: 'published' };
    },
    (error: unknown): PublishResult => {
      done = true;
      const code = error instanceof DomainError ? error.code : undefined;

      return code === 'POLICY_DENIED' ? { kind: 'denied', code } : { kind: 'other', detail: error };
    },
  );

  return { outcome, settled: () => done };
}

describe('P0-C3D: consent races against real row locks', () => {
  it('denies publication when the revocation commits first', async () => {
    const harness = await createHarness(db, 'P0-C3D revoke-first tenant');
    await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });

    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);
    const grant = await claimRun(harness, `worker-${randomUUID()}`, taskId);

    const lock = await db.pool.connect();
    let publish: ReturnType<typeof settlePublish>;

    try {
      await lock.query('BEGIN');
      // A concurrent revocation takes the consent row lock first and parks it.
      await lock.query(
        `UPDATE consent_grants
            SET status = 'revoked',
                revoked_at = clock_timestamp(),
                version = version + 1,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND source_profile_id = $2`,
        [harness.ctx.tenantId, FIXTURE_PROFILE],
      );

      publish = settlePublish(
        harness.commitments.appendOutcomeIfAbsent(
          grant,
          outcomeCommand({ occurrenceId, commitmentId, taskId }),
        ),
      );

      // The publisher must WAIT for the consent row rather than read a stale snapshot.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(publish.settled()).toBe(false);

      await lock.query('COMMIT');
    } finally {
      lock.release();
    }

    await expect(publish.outcome).resolves.toMatchObject({ kind: 'denied', code: 'POLICY_DENIED' });
    await expect(countOutcomes(occurrenceId)).resolves.toBe(0);
  });

  it('publishes when the authorization wins the row lock, and a later revoke does not undo it', async () => {
    const harness = await createHarness(db, 'P0-C3D publish-first tenant');
    await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });

    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);
    const grant = await claimRun(harness, `worker-${randomUUID()}`, taskId);

    const lock = await db.pool.connect();
    let publish: ReturnType<typeof settlePublish>;

    try {
      await lock.query('BEGIN');
      // Hold the consent row (a revoke that has not committed yet) and start the publication.
      await lock.query(
        `SELECT 1 FROM consent_grants
          WHERE tenant_id = $1 AND source_profile_id = $2
          FOR UPDATE`,
        [harness.ctx.tenantId, FIXTURE_PROFILE],
      );

      publish = settlePublish(
        harness.commitments.appendOutcomeIfAbsent(
          grant,
          outcomeCommand({ occurrenceId, commitmentId, taskId }),
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(publish.settled()).toBe(false);

      // The competing transaction gives up: the generation was unchanged, so publication proceeds.
      await lock.query('ROLLBACK');
    } finally {
      lock.release();
    }

    await expect(publish.outcome).resolves.toMatchObject({ kind: 'published' });
    await expect(countOutcomes(occurrenceId)).resolves.toBe(1);

    // A revocation that lands afterwards is real, but it cannot retract an already-authorized write.
    await harness.consent.revokeForTenant(harness.ctx.tenantId, FIXTURE_PROFILE);
    await expect(countOutcomes(occurrenceId)).resolves.toBe(1);
    await expect(
      harness.consent.resolveGeneration(harness.ctx.tenantId, FIXTURE_PROFILE),
    ).resolves.toMatchObject({ status: 'revoked' });
  });

  it('denies publication after a committed revocation (ordered case)', async () => {
    const harness = await createHarness(db, 'P0-C3D revoke-then-publish tenant');
    await harness.consent.grantForTenant({
      tenantId: harness.ctx.tenantId,
      sourceProfileId: FIXTURE_PROFILE,
    });

    const { commitmentId, version } = await createCommitment(harness);
    const { occurrenceId, taskId } = await reserveAndDispatch(harness, commitmentId, version);
    const grant = await claimRun(harness, `worker-${randomUUID()}`, taskId);

    await harness.consent.revokeForTenant(harness.ctx.tenantId, FIXTURE_PROFILE);

    await expect(
      harness.commitments.appendOutcomeIfAbsent(
        grant,
        outcomeCommand({ occurrenceId, commitmentId, taskId }),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
    await expect(countOutcomes(occurrenceId)).resolves.toBe(0);
  });
});
