import { randomUUID } from 'node:crypto';
import type { AppendOutcomeCommand, WorkerLeaseGrant } from '@ember/contracts';
import { type AuthContext, type DomainError, type Id } from '@ember/domain';
import {
  PostgresAgentRepository,
  PostgresCommitmentRepository,
  PostgresConsentRepository,
  PostgresTaskRepository,
} from '@ember/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createTenantFixture, type TenantFixture } from './support/fixtures.js';

const PROFILE = 'fixture.github-release';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * P0-C3D: authoritative consent persistence against a real PostgreSQL instance.
 *
 * The suite is deliberately about the facts only PostgreSQL can decide: row versions, the
 * database clock, row-lock ordering, and the dispatch/publication fences. Host-clock
 * behaviour and the pure decision matrix are unit-tested elsewhere.
 */
describe('P0-C3D PostgreSQL Consent Persistence', () => {
  let db: TestDatabase;
  let consentRepo: PostgresConsentRepository;
  let commitmentRepo: PostgresCommitmentRepository;
  let agentRepo: PostgresAgentRepository;
  let taskRepo: PostgresTaskRepository;

  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let ctxA: AuthContext;
  let ctxB: AuthContext;
  let agentAId: Id;

  beforeAll(async () => {
    db = await createTestDatabase();
    consentRepo = new PostgresConsentRepository(db.pool);
    commitmentRepo = new PostgresCommitmentRepository(db.pool);
    agentRepo = new PostgresAgentRepository(db.pool);
    taskRepo = new PostgresTaskRepository(db.pool);

    tenantA = await createTenantFixture(db.pool, 'Consent Tenant A');
    tenantB = await createTenantFixture(db.pool, 'Consent Tenant B');

    ctxA = { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 };
    ctxB = { tenantId: tenantB.tenantId, principalId: tenantB.principalId, policyVersion: 1 };

    const agent = await agentRepo.create(ctxA, { name: 'Consent Agent', policyVersion: 1 });
    agentAId = agent.agentId;
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  /** Read the raw row so the test asserts what PostgreSQL stored, not what the mapper returned. */
  async function readRawRow(
    tenantId: string,
    sourceProfileId = PROFILE,
  ): Promise<
    | {
        status: string;
        version: number;
        revoked_at: Date | null;
        expires_at: Date | null;
        allowed_operations: string[];
      }
    | undefined
  > {
    const result = await db.pool.query<{
      status: string;
      version: number;
      revoked_at: Date | null;
      expires_at: Date | null;
      allowed_operations: string[];
    }>(
      `SELECT status, version, revoked_at, expires_at, allowed_operations
         FROM consent_grants
        WHERE tenant_id = $1 AND source_profile_id = $2`,
      [tenantId, sourceProfileId],
    );

    return result.rows[0];
  }

  async function countGrants(tenantId: string): Promise<number> {
    const result = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM consent_grants WHERE tenant_id = $1',
      [tenantId],
    );

    return Number(result.rows[0]?.count ?? '0');
  }

  const WORKER_ID = 'worker-p0c3d-consent';

  /** Create a commitment that is already due and reserve one pending occurrence for it. */
  async function createDueOccurrence(
    title: string,
  ): Promise<{ readonly occurrenceId: Id; readonly commitmentId: Id }> {
    const { commitment } = await commitmentRepo.create(ctxA, {
      idempotencyKey: `key-${randomUUID()}`,
      agentId: agentAId,
      title,
      scheduleKind: 'once',
      dueAt: new Date(Date.now() - 5_000),
      sourceProfileId: PROFILE,
    });

    const slot = await commitmentRepo.reserveOccurrence(
      commitment.commitment_id,
      commitment.version,
    );

    if (slot === null) {
      throw new Error('expected a reserved occurrence slot');
    }

    return { occurrenceId: slot.occurrenceId, commitmentId: commitment.commitment_id };
  }

  async function createTask(prompt: string): Promise<Id> {
    const receipt = await taskRepo.create(ctxA, {
      agentId: agentAId,
      idempotencyKey: `task-${randomUUID()}`,
      kind: 'mock.chat',
      input: { prompt },
    });

    return receipt.taskId;
  }

  /** A Task in `running` with a live Run lease, i.e. a worker that may publish an outcome. */
  async function createRunningTask(
    prompt: string,
  ): Promise<{ readonly taskId: Id; readonly grant: WorkerLeaseGrant }> {
    const taskId = await createTask(prompt);
    const runId = randomUUID();

    await db.pool.query(
      `UPDATE tasks SET status = 'running', updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA.tenantId, taskId],
    );
    await db.pool.query(
      `INSERT INTO runs (
         id, tenant_id, task_id, attempt, lease_epoch, status, worker_id, leased_until, started_at
       ) VALUES ($1, $2, $3, 1, 1, 'running', $4, $5, clock_timestamp())`,
      [runId, tenantA.tenantId, taskId, WORKER_ID, new Date(Date.now() + 60_000)],
    );

    return {
      taskId,
      grant: { tenantId: tenantA.tenantId, taskId, runId, leaseEpoch: 1, workerId: WORKER_ID },
    };
  }

  async function readOccurrence(
    occurrenceId: Id,
  ): Promise<{ status: string; task_id: string | null; consent_version: number | null }> {
    const result = await db.pool.query<{
      status: string;
      task_id: string | null;
      consent_version: number | null;
    }>(
      `SELECT status, task_id, consent_version
         FROM commitment_occurrences
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA.tenantId, occurrenceId],
    );

    const row = result.rows[0];

    if (row === undefined) {
      throw new Error('occurrence disappeared');
    }

    return row;
  }

  async function countOutcomes(commitmentId: Id): Promise<number> {
    const result = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM commitment_outcomes WHERE tenant_id = $1 AND commitment_id = $2',
      [tenantA.tenantId, commitmentId],
    );

    return Number(result.rows[0]?.count ?? '0');
  }

  /**
   * Assert that a publication was refused by the consent fence, and that the internal
   * diagnostic names the reason. The client-facing message stays the fixed `POLICY_DENIED`
   * text, so the reason is only ever observable here.
   */
  async function expectPolicyDenied(action: () => Promise<unknown>, reason: string): Promise<void> {
    const caught = await action().then(
      () => null,
      (error: DomainError) => error,
    );

    expect(caught?.code).toBe('POLICY_DENIED');
    expect(caught?.diagnostic).toContain(reason);
  }

  describe('1. Grant lifecycle', () => {
    it('creates an active, version-1 grant with the default operation set', async () => {
      const { consent, replayed } = await consentRepo.grant(ctxA, { sourceProfileId: PROFILE });

      expect(replayed).toBe(false);
      expect(consent.tenantId).toBe(tenantA.tenantId);
      expect(consent.sourceProfileId).toBe(PROFILE);
      expect(consent.status).toBe('active');
      expect(consent.version).toBe(1);
      expect(consent.revokedAt).toBeNull();
      expect(consent.expiresAt).toBeNull();
      expect([...consent.allowedOperations].sort()).toStrictEqual([
        'publish_outcome',
        'read_snapshot',
      ]);

      const raw = await readRawRow(tenantA.tenantId);
      expect(raw?.status).toBe('active');
      expect(raw?.version).toBe(1);
    });

    it('replays an identical re-grant without advancing the version', async () => {
      const cmd = { sourceProfileId: PROFILE, allowedOperations: ['read_snapshot'] as const };
      const first = await consentRepo.grant(ctxA, cmd);
      const second = await consentRepo.grant(ctxA, cmd);

      expect(second.replayed).toBe(true);
      expect(second.consent.version).toBe(first.consent.version);
      expect(second.consent.consentId).toBe(first.consent.consentId);
    });

    it('advances the version when the grant changes', async () => {
      const before = await consentRepo.grant(ctxA, {
        sourceProfileId: PROFILE,
        allowedOperations: ['read_snapshot'],
      });

      const widened = await consentRepo.grant(ctxA, {
        sourceProfileId: PROFILE,
        allowedOperations: ['read_snapshot', 'publish_outcome'],
      });

      expect(widened.replayed).toBe(false);
      expect(widened.consent.version).toBe(before.consent.version + 1);
    });

    it('normalises operations and scopes so order and duplicates cannot bump the version', async () => {
      const first = await consentRepo.grant(ctxA, {
        sourceProfileId: 'fixture.linear-issues',
        allowedOperations: ['read_snapshot', 'publish_outcome'],
        scopes: ['b', 'a', 'a'],
      });
      const second = await consentRepo.grant(ctxA, {
        sourceProfileId: 'fixture.linear-issues',
        allowedOperations: ['publish_outcome', 'read_snapshot', 'publish_outcome'],
        scopes: ['a', 'b'],
      });

      expect(second.replayed).toBe(true);
      expect(second.consent.version).toBe(first.consent.version);
      expect(first.consent.scopes).toStrictEqual(['a', 'b']);
    });

    it('rejects an expiry the database clock already considers past', async () => {
      await expect(
        consentRepo.grant(ctxA, {
          sourceProfileId: PROFILE,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });

    it('rejects a grant whose principal is not provisioned in the tenant', async () => {
      const forged: AuthContext = {
        tenantId: tenantA.tenantId,
        principalId: randomUUID(),
        policyVersion: 1,
      };
      const before = await countGrants(tenantA.tenantId);

      await expect(
        consentRepo.grant(forged, { sourceProfileId: 'fixture.support-inbox' }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      expect(await countGrants(tenantA.tenantId)).toBe(before);
    });

    it('rejects a source profile outside the closed vocabulary', async () => {
      await expect(
        consentRepo.grant(ctxA, { sourceProfileId: 'Fixture Unknown' }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });
  });

  describe('2. Database-clock expiry', () => {
    const profile = 'fixture.support-inbox';

    it('reports an expired grant as expired even though the stored status stays active', async () => {
      const granted = await consentRepo.grant(ctxA, {
        sourceProfileId: profile,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      expect(granted.consent.status).toBe('active');
      expect(granted.consent.expiresAt).not.toBeNull();

      // Move the expiry into the past: the stored status is untouched, so only the derived
      // status proves that expiry is decided by PostgreSQL, not by the row's `status`.
      // `granted_at` moves with it because the table enforces `expires_at > granted_at`.
      await db.pool.query(
        `UPDATE consent_grants
            SET granted_at = clock_timestamp() - interval '2 hours',
                expires_at = clock_timestamp() - interval '1 second'
          WHERE tenant_id = $1 AND source_profile_id = $2`,
        [tenantA.tenantId, profile],
      );

      const raw = await readRawRow(tenantA.tenantId, profile);
      expect(raw?.status).toBe('active');

      const expired = await consentRepo.get(ctxA, profile);
      expect(expired?.status).toBe('expired');

      const decision = await consentRepo.evaluateConsent(
        tenantA.tenantId,
        profile,
        'read_snapshot',
      );
      expect(decision).toStrictEqual({
        allowed: false,
        denialCode: 'CONSENT_EXPIRED',
        consentVersion: null,
      });
    });

    it('treats a re-grant with a fresh expiry as a new authorization', async () => {
      const stale = await consentRepo.get(ctxA, profile);
      const refreshed = await consentRepo.grant(ctxA, {
        sourceProfileId: profile,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

      expect(refreshed.replayed).toBe(false);
      expect(refreshed.consent.status).toBe('active');
      expect(refreshed.consent.version).toBe((stale?.version ?? 0) + 1);
    });
  });

  describe('3. Revocation', () => {
    const profile = 'fixture.calendar-events';

    it('revokes an active grant and records the revocation metadata', async () => {
      const granted = await consentRepo.grant(ctxA, { sourceProfileId: profile });

      const revoked = await consentRepo.revoke(ctxA, profile);

      expect(revoked.status).toBe('revoked');
      expect(revoked.revokedAt).not.toBeNull();
      expect(revoked.version).toBe(granted.consent.version + 1);

      const raw = await readRawRow(tenantA.tenantId, profile);
      expect(raw?.status).toBe('revoked');
      expect(raw?.revoked_at).toBeInstanceOf(Date);
    });

    it('is idempotent: a retried revocation does not advance the version again', async () => {
      const before = await consentRepo.get(ctxA, profile);
      const again = await consentRepo.revoke(ctxA, profile);

      expect(again.status).toBe('revoked');
      expect(again.version).toBe(before?.version);
    });

    it('rejects a stale expected_version and leaves the row untouched', async () => {
      const current = await consentRepo.get(ctxA, profile);

      await expect(
        consentRepo.revoke(ctxA, profile, { expectedVersion: (current?.version ?? 0) - 1 }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

      const after = await consentRepo.get(ctxA, profile);
      expect(after?.version).toBe(current?.version);
      expect(after?.revokedAt).toBe(current?.revokedAt);
    });

    it('honours a matching expected_version', async () => {
      const restored = await consentRepo.grant(ctxA, { sourceProfileId: profile });
      expect(restored.consent.status).toBe('active');

      const revoked = await consentRepo.revoke(ctxA, profile, {
        expectedVersion: restored.consent.version,
      });

      expect(revoked.status).toBe('revoked');
      expect(revoked.version).toBe(restored.consent.version + 1);
    });

    it('reports a missing grant as NOT_FOUND', async () => {
      await expect(consentRepo.revoke(ctxA, 'fixture.never-granted')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('clears the revocation when the grant is restored', async () => {
      const restored = await consentRepo.grant(ctxA, { sourceProfileId: profile });

      expect(restored.consent.status).toBe('active');
      expect(restored.consent.revokedAt).toBeNull();
      expect(restored.replayed).toBe(false);

      const raw = await readRawRow(tenantA.tenantId, profile);
      expect(raw?.status).toBe('active');
      expect(raw?.revoked_at).toBeNull();
    });
  });

  describe('4. Tenant isolation', () => {
    it('keeps two tenants’ grants for the same profile independent', async () => {
      const grantedA = await consentRepo.grant(ctxA, { sourceProfileId: PROFILE });
      const grantedB = await consentRepo.grant(ctxB, { sourceProfileId: PROFILE });

      expect(grantedA.consent.tenantId).toBe(tenantA.tenantId);
      expect(grantedB.consent.tenantId).toBe(tenantB.tenantId);
      expect(grantedA.consent.consentId).not.toBe(grantedB.consent.consentId);

      const readA = await consentRepo.get(ctxA, PROFILE);
      const readB = await consentRepo.get(ctxB, PROFILE);

      expect(readA?.tenantId).toBe(tenantA.tenantId);
      expect(readA?.version).toBe(grantedA.consent.version);
      expect(readB?.tenantId).toBe(tenantB.tenantId);
      expect(readB?.version).toBe(grantedB.consent.version);
    });

    it('reports another tenant’s grant exactly like a missing one', async () => {
      await consentRepo.grant(ctxB, { sourceProfileId: 'fixture.audit-log' });

      const crossTenant = await consentRepo.get(ctxA, 'fixture.audit-log');
      const missing = await consentRepo.get(ctxA, 'fixture.never-granted-anywhere');

      expect(crossTenant).toBeNull();
      expect(missing).toBeNull();
    });

    it('lists only the authenticated tenant’s grants, newest first', async () => {
      const listA = await consentRepo.list(ctxA);

      expect(listA.length).toBe(await countGrants(tenantA.tenantId));
      expect(listA.every((grant) => grant.tenantId === tenantA.tenantId)).toBe(true);
      expect(listA.map((grant) => grant.sourceProfileId)).not.toContain('fixture.audit-log');

      const timestamps = listA.map((grant) => Date.parse(grant.createdAt));
      expect([...timestamps].sort((left, right) => right - left)).toStrictEqual(timestamps);
    });

    it('cannot revoke another tenant’s grant', async () => {
      await expect(consentRepo.revoke(ctxA, 'fixture.audit-log')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      const stillActive = await consentRepo.get(ctxB, 'fixture.audit-log');
      expect(stillActive?.status).toBe('active');
    });
  });

  describe('5. Consent evaluation and version fence', () => {
    const profile = 'fixture.incident-feed';

    beforeAll(async () => {
      await consentRepo.grant(ctxA, {
        sourceProfileId: profile,
        allowedOperations: ['read_snapshot'],
      });
    });

    it('allows the granted operation at the recorded version', async () => {
      const current = await consentRepo.get(ctxA, profile);

      const decision = await consentRepo.evaluateConsent(
        tenantA.tenantId,
        profile,
        'read_snapshot',
        current?.version,
      );

      expect(decision).toStrictEqual({
        allowed: true,
        denialCode: null,
        consentVersion: current?.version,
      });
    });

    it('denies an operation the grant does not list', async () => {
      const decision = await consentRepo.evaluateConsent(
        tenantA.tenantId,
        profile,
        'publish_outcome',
      );

      expect(decision.allowed).toBe(false);
      expect(decision.denialCode).toBe('OPERATION_NOT_ALLOWED');
      expect(decision.consentVersion).toBeNull();
    });

    it('denies a stale fence and reports the current version', async () => {
      const current = await consentRepo.get(ctxA, profile);
      const staleVersion = (current?.version ?? 1) - 1;

      const decision = await consentRepo.evaluateConsent(
        tenantA.tenantId,
        profile,
        'read_snapshot',
        staleVersion,
      );

      expect(decision).toStrictEqual({
        allowed: false,
        denialCode: 'CONSENT_VERSION_STALE',
        consentVersion: current?.version,
      });
    });

    it('treats a missing grant as not found rather than allowed', async () => {
      const decision = await consentRepo.evaluateConsent(
        tenantA.tenantId,
        'fixture.never-granted-anywhere',
        'read_snapshot',
      );

      expect(decision).toStrictEqual({
        allowed: false,
        denialCode: 'CONSENT_NOT_FOUND',
        consentVersion: null,
      });
    });
  });

  describe('6. Dispatch and publication fences', () => {
    it('refuses to dispatch when the grant has been revoked', async () => {
      await consentRepo.grant(ctxA, { sourceProfileId: PROFILE });
      await consentRepo.revoke(ctxA, PROFILE);

      const { occurrenceId } = await createDueOccurrence('Dispatch without consent');
      const taskId = await createTask('consent gate');

      await expect(commitmentRepo.markDispatched(occurrenceId, taskId)).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      });

      // Fail-closed: nothing was bound and no fence was recorded.
      expect(await readOccurrence(occurrenceId)).toStrictEqual({
        status: 'pending',
        task_id: null,
        consent_version: null,
      });
    });

    it('records the authorising consent version when it dispatches', async () => {
      const granted = await consentRepo.grant(ctxA, { sourceProfileId: PROFILE });
      const { occurrenceId } = await createDueOccurrence('Dispatch with consent');
      const taskId = await createTask('consent gate');

      await commitmentRepo.markDispatched(occurrenceId, taskId);

      expect(await readOccurrence(occurrenceId)).toStrictEqual({
        status: 'dispatched',
        task_id: taskId,
        consent_version: granted.consent.version,
      });
    });
  });

  describe('7. Publication fence', () => {
    async function publishUnder(profile: 'granted' | 'revoked' | 'version-moved'): Promise<{
      readonly taskId: Id;
      readonly commitmentId: Id;
      readonly occurrenceId: Id;
      readonly publish: () => Promise<boolean>;
    }> {
      const granted = await consentRepo.grant(ctxA, { sourceProfileId: PROFILE });
      const { taskId, grant } = await createRunningTask('consent fence publisher');
      const { occurrenceId, commitmentId } = await createDueOccurrence(`Publish ${profile}`);

      await commitmentRepo.markDispatched(occurrenceId, taskId);

      if (profile === 'revoked') {
        await consentRepo.revoke(ctxA, PROFILE);
      }

      if (profile === 'version-moved') {
        // Still active and still allowing `publish_outcome`, but no longer the version that
        // authorised the dispatch: the fence alone must reject the publication.
        const moved = await consentRepo.grant(ctxA, {
          sourceProfileId: PROFILE,
          scopes: [`dispatch-${grant.runId}`],
        });
        expect(moved.consent.status).toBe('active');
        expect(moved.consent.version).toBe(granted.consent.version + 1);
      }

      const cmd: AppendOutcomeCommand = {
        occurrenceId,
        commitmentId,
        taskId,
        summary: `Outcome published under ${profile} consent.`,
        resultStatus: 'meaningful_change',
      };

      return {
        taskId,
        commitmentId,
        occurrenceId,
        publish: () => commitmentRepo.appendOutcomeIfAbsent(grant, cmd),
      };
    }

    it('publishes while the authorising consent is still current', async () => {
      const { commitmentId, occurrenceId, publish } = await publishUnder('granted');

      await expect(publish()).resolves.toBe(true);

      expect(await countOutcomes(commitmentId)).toBe(1);
      expect((await readOccurrence(occurrenceId)).status).toBe('completed');
    });

    it('refuses to publish after the grant was revoked', async () => {
      const { commitmentId, publish } = await publishUnder('revoked');

      await expectPolicyDenied(publish, 'CONSENT_REVOKED');

      expect(await countOutcomes(commitmentId)).toBe(0);
    });

    it('refuses to publish when the consent version moved after dispatch', async () => {
      const { commitmentId, publish } = await publishUnder('version-moved');

      await expectPolicyDenied(publish, 'CONSENT_VERSION_STALE');

      expect(await countOutcomes(commitmentId)).toBe(0);
    });

    it('publishes a legacy occurrence without a recorded fence only while consent is effective', async () => {
      const { commitmentId, occurrenceId, publish } = await publishUnder('granted');

      // Simulate an occurrence dispatched before the fence column existed.
      await db.pool.query(
        `UPDATE commitment_occurrences SET consent_version = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [tenantA.tenantId, occurrenceId],
      );

      expect((await readOccurrence(occurrenceId)).consent_version).toBeNull();
      await expect(publish()).resolves.toBe(true);
      expect(await countOutcomes(commitmentId)).toBe(1);

      // The same legacy shape is still refused once consent is gone.
      const second = await publishUnder('granted');
      await db.pool.query(
        `UPDATE commitment_occurrences SET consent_version = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [tenantA.tenantId, second.occurrenceId],
      );
      await consentRepo.revoke(ctxA, PROFILE);

      await expectPolicyDenied(second.publish, 'CONSENT_REVOKED');
      expect(await countOutcomes(second.commitmentId)).toBe(0);
    });
  });

  describe('8. Locking and races', () => {
    it('lets a revocation that holds the consent lock force an in-flight publication to fail closed', async () => {
      await consentRepo.grant(ctxA, { sourceProfileId: PROFILE });
      const { taskId, grant } = await createRunningTask('racing publisher');
      const { occurrenceId, commitmentId } = await createDueOccurrence('Race with revocation');
      await commitmentRepo.markDispatched(occurrenceId, taskId);

      const cmd: AppendOutcomeCommand = {
        occurrenceId,
        commitmentId,
        taskId,
        summary: 'Racing publication outcome.',
        resultStatus: 'meaningful_change',
      };

      // Hold the consent row so the publication blocks exactly where the fence is evaluated.
      const holder = await db.pool.connect();
      let settled = false;

      try {
        await holder.query('BEGIN');
        await holder.query(
          `SELECT version FROM consent_grants
            WHERE tenant_id = $1 AND source_profile_id = $2
            FOR UPDATE`,
          [tenantA.tenantId, PROFILE],
        );

        const publication = commitmentRepo.appendOutcomeIfAbsent(grant, cmd).then(
          () => {
            settled = true;
            return { ok: true, code: undefined, diagnostic: '' };
          },
          (error: { code?: string; diagnostic?: string }) => {
            settled = true;
            return { ok: false, code: error.code, diagnostic: error.diagnostic ?? '' };
          },
        );

        await delay(250);
        // The publisher reached the fence and is waiting for the lock we hold, so it cannot
        // have observed pre-revocation consent.
        expect(settled).toBe(false);

        await holder.query(
          `UPDATE consent_grants
              SET status = 'revoked',
                  revoked_at = clock_timestamp(),
                  version = version + 1,
                  updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND source_profile_id = $2`,
          [tenantA.tenantId, PROFILE],
        );
        await holder.query('COMMIT');

        const result = await publication;

        expect(result.ok).toBe(false);
        expect(result.code).toBe('POLICY_DENIED');
        expect(result.diagnostic).toContain('CONSENT_REVOKED');
        expect(await countOutcomes(commitmentId)).toBe(0);
      } finally {
        holder.release();
      }
    });

    it('does not undo a publication that committed before the revocation', async () => {
      await consentRepo.grant(ctxA, { sourceProfileId: PROFILE });
      const { taskId, grant } = await createRunningTask('early publisher');
      const { occurrenceId, commitmentId } = await createDueOccurrence('Publish before revoke');
      await commitmentRepo.markDispatched(occurrenceId, taskId);

      const published = await commitmentRepo.appendOutcomeIfAbsent(grant, {
        occurrenceId,
        commitmentId,
        taskId,
        summary: 'Committed before the revocation.',
        resultStatus: 'meaningful_change',
      });
      expect(published).toBe(true);

      await consentRepo.revoke(ctxA, PROFILE);

      // Revocation is forward-looking: the already-committed outcome stays readable.
      expect(await countOutcomes(commitmentId)).toBe(1);
      const outcomes = await commitmentRepo.listOutcomes(ctxA, commitmentId);
      expect(outcomes?.outcomes).toHaveLength(1);
    });

    it('serialises concurrent publications of the same occurrence into exactly one outcome', async () => {
      await consentRepo.grant(ctxA, { sourceProfileId: PROFILE });
      const { taskId, grant } = await createRunningTask('duplicate publisher');
      const { occurrenceId, commitmentId } = await createDueOccurrence('Concurrent publication');
      await commitmentRepo.markDispatched(occurrenceId, taskId);

      const cmd: AppendOutcomeCommand = {
        occurrenceId,
        commitmentId,
        taskId,
        summary: 'Concurrent publication outcome.',
        resultStatus: 'meaningful_change',
      };

      const [first, second] = await Promise.all([
        commitmentRepo.appendOutcomeIfAbsent(grant, cmd),
        commitmentRepo.appendOutcomeIfAbsent(grant, cmd),
      ]);

      // One publisher inserts the outcome; the other observes it and reports the idempotent
      // no-op, so a retried publication can never duplicate the fact.
      expect([first, second].filter((appended) => appended)).toHaveLength(1);
      expect(await countOutcomes(commitmentId)).toBe(1);
    });
  });
});
