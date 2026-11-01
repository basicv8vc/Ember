import { randomUUID } from 'node:crypto';
import type { AppendOutcomeCommand, WorkerLeaseGrant } from '@ember/contracts';
import type { AuthContext, Id } from '@ember/domain';
import {
  PostgresAgentRepository,
  PostgresCommitmentRepository,
  PostgresTaskRepository,
} from '@ember/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createTenantFixture, type TenantFixture } from './support/fixtures.js';

describe('P0-C3A PostgreSQL Commitment Persistence & DueCommitmentStore', () => {
  let db: TestDatabase;
  let commitmentRepo: PostgresCommitmentRepository;
  let agentRepo: PostgresAgentRepository;
  let taskRepo: PostgresTaskRepository;

  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let agentAId: Id;
  let ctxA: AuthContext;
  let ctxB: AuthContext;

  beforeAll(async () => {
    db = await createTestDatabase();
    commitmentRepo = new PostgresCommitmentRepository(db.pool);
    agentRepo = new PostgresAgentRepository(db.pool);
    taskRepo = new PostgresTaskRepository(db.pool);

    tenantA = await createTenantFixture(db.pool, 'Tenant A');
    tenantB = await createTenantFixture(db.pool, 'Tenant B');

    ctxA = { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 };
    ctxB = { tenantId: tenantB.tenantId, principalId: tenantB.principalId, policyVersion: 1 };

    const agent = await agentRepo.create(ctxA, {
      name: 'Agent Alpha',
      policyVersion: 1,
    });
    agentAId = agent.agentId;
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  describe('1. Idempotent Creation & Replay Semantics', () => {
    it('creates a new commitment and acknowledges with replayed: false', async () => {
      const idempotencyKey = `key-${randomUUID()}`;
      const res = await commitmentRepo.create(ctxA, {
        idempotencyKey,
        agentId: agentAId,
        title: 'Initial Commitment',
        scheduleKind: 'interval',
        intervalSeconds: 900,
        sourceProfileId: 'fixture.github-release',
      });

      expect(res.replayed).toBe(false);
      expect(res.commitment.commitment_id).toBeDefined();
      expect(res.commitment.title).toBe('Initial Commitment');
      expect(res.commitment.status).toBe('active');
      expect(res.commitment.version).toBe(1);
    });

    it('returns existing commitment with replayed: true for identical replay', async () => {
      const idempotencyKey = `key-${randomUUID()}`;
      const cmd = {
        idempotencyKey,
        agentId: agentAId,
        title: 'Replayed Commitment',
        scheduleKind: 'interval' as const,
        intervalSeconds: 900,
        sourceProfileId: 'fixture.github-release',
      };

      const first = await commitmentRepo.create(ctxA, cmd);
      expect(first.replayed).toBe(false);

      const second = await commitmentRepo.create(ctxA, cmd);
      expect(second.replayed).toBe(true);
      expect(second.commitment.commitment_id).toBe(first.commitment.commitment_id);
    });

    it('throws IDEMPOTENCY_CONFLICT when key matches but payload differs', async () => {
      const idempotencyKey = `key-${randomUUID()}`;

      await commitmentRepo.create(ctxA, {
        idempotencyKey,
        agentId: agentAId,
        title: 'Original Title',
        scheduleKind: 'interval',
        intervalSeconds: 900,
        sourceProfileId: 'fixture.github-release',
      });

      await expect(
        commitmentRepo.create(ctxA, {
          idempotencyKey,
          agentId: agentAId,
          title: 'Altered Title',
          scheduleKind: 'interval',
          intervalSeconds: 900,
          sourceProfileId: 'fixture.github-release',
        }),
      ).rejects.toThrowError(/Idempotency key conflicts/);
    });
  });

  describe('2. Strict Tenant Isolation', () => {
    it('prevents cross-tenant access to commitments and outcomes', async () => {
      const { commitment } = await commitmentRepo.create(ctxA, {
        idempotencyKey: `key-${randomUUID()}`,
        agentId: agentAId,
        title: 'Tenant A Secret Watch',
        scheduleKind: 'once',
        sourceProfileId: 'fixture.github-release',
      });

      // Tenant B reads Tenant A's commitment -> null
      const readByB = await commitmentRepo.get(ctxB, commitment.commitment_id);
      expect(readByB).toBeNull();

      // Tenant B list -> does not include Tenant A's commitment
      const listB = await commitmentRepo.list(ctxB);
      expect(listB.commitments.some((c) => c.commitment_id === commitment.commitment_id)).toBe(
        false,
      );

      // Tenant B attempts to pause/resume/cancel -> throws NOT_FOUND
      await expect(commitmentRepo.pause(ctxB, commitment.commitment_id)).rejects.toThrowError(
        /not found/i,
      );
      await expect(commitmentRepo.resume(ctxB, commitment.commitment_id)).rejects.toThrowError(
        /not found/i,
      );
      await expect(commitmentRepo.cancel(ctxB, commitment.commitment_id)).rejects.toThrowError(
        /not found/i,
      );

      // Tenant B listOutcomes -> null
      const outcomesB = await commitmentRepo.listOutcomes(ctxB, commitment.commitment_id);
      expect(outcomesB).toBeNull();
    });
  });

  describe('3. State Transitions & CAS Optimistic Concurrency', () => {
    it('handles pause -> resume -> cancel lifecycle with version increments', async () => {
      const { commitment } = await commitmentRepo.create(ctxA, {
        idempotencyKey: `key-${randomUUID()}`,
        agentId: agentAId,
        title: 'Lifecycle Commitment',
        scheduleKind: 'interval',
        intervalSeconds: 900,
        sourceProfileId: 'fixture.github-release',
      });

      expect(commitment.version).toBe(1);

      // Pause with expected version 1
      const paused = await commitmentRepo.pause(ctxA, commitment.commitment_id, {
        expectedVersion: 1,
      });
      expect(paused.status).toBe('paused');
      expect(paused.version).toBe(2);

      // Resume with expected version 2
      const resumed = await commitmentRepo.resume(ctxA, commitment.commitment_id, {
        expectedVersion: 2,
      });
      expect(resumed.status).toBe('active');
      expect(resumed.version).toBe(3);

      // Stale CAS check fails
      await expect(
        commitmentRepo.cancel(ctxA, commitment.commitment_id, { expectedVersion: 1 }),
      ).rejects.toThrowError(/The requested state transition is not allowed/);

      // Cancel with correct version 3
      const cancelled = await commitmentRepo.cancel(ctxA, commitment.commitment_id, {
        expectedVersion: 3,
      });
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.next_due_at).toBeNull();
      expect(cancelled.version).toBe(4);

      // Further transitions are illegal
      await expect(commitmentRepo.pause(ctxA, commitment.commitment_id)).rejects.toThrowError(
        /The requested state transition is not allowed/,
      );
      await expect(commitmentRepo.resume(ctxA, commitment.commitment_id)).rejects.toThrowError(
        /The requested state transition is not allowed/,
      );
    });
  });

  describe('4. DueWork Discovery & Concurrent Slot Reservation Race', () => {
    it('discovers due commitments using PostgreSQL authoritative clock', async () => {
      const pastDue = new Date(Date.now() - 60_000); // 1 minute ago
      const { commitment } = await commitmentRepo.create(ctxA, {
        idempotencyKey: `key-${randomUUID()}`,
        agentId: agentAId,
        title: 'Overdue Task',
        scheduleKind: 'interval',
        intervalSeconds: 900,
        dueAt: pastDue,
        sourceProfileId: 'fixture.github-release',
      });

      const due = await commitmentRepo.findDueCommitments(50);
      const found = due.find((d) => d.commitmentId === commitment.commitment_id);
      expect(found).toBeDefined();
    });

    it('guarantees that 2 concurrent reserveOccurrence calls produce exactly 1 slot', async () => {
      const pastDue = new Date(Date.now() - 30_000);
      const { commitment } = await commitmentRepo.create(ctxA, {
        idempotencyKey: `key-${randomUUID()}`,
        agentId: agentAId,
        title: 'Race Condition Task',
        scheduleKind: 'interval',
        intervalSeconds: 900,
        dueAt: pastDue,
        sourceProfileId: 'fixture.github-release',
      });

      // 2 schedulers race on the same commitment
      const [res1, res2] = await Promise.all([
        commitmentRepo.reserveOccurrence(commitment.commitment_id, commitment.version),
        commitmentRepo.reserveOccurrence(commitment.commitment_id, commitment.version),
      ]);

      const successfulReservations = [res1, res2].filter((r) => r !== null);
      expect(successfulReservations).toHaveLength(1);

      const winner = successfulReservations[0]!;
      expect(winner.occurrenceId).toBeDefined();
      expect(winner.commitmentVersion).toBe(2);

      // The second scheduler got null and produced zero duplicate rows
      const loser = res1 === null ? res1 : res2;
      expect(loser).toBeNull();
    });

    it('compensates at most one historical interval when overdue to prevent task storms', async () => {
      // Commitment overdue by 2 hours (8 intervals of 900s)
      const twoHoursAgo = new Date(Date.now() - 7_200_000);
      const { commitment } = await commitmentRepo.create(ctxA, {
        idempotencyKey: `key-${randomUUID()}`,
        agentId: agentAId,
        title: 'Severely Overdue Task',
        scheduleKind: 'interval',
        intervalSeconds: 900,
        dueAt: twoHoursAgo,
        sourceProfileId: 'fixture.github-release',
      });

      const reserved = await commitmentRepo.reserveOccurrence(
        commitment.commitment_id,
        commitment.version,
      );
      expect(reserved).not.toBeNull();

      // Read updated commitment from DB
      const updated = await commitmentRepo.get(ctxA, commitment.commitment_id);
      expect(updated).not.toBeNull();

      // next_due_at must be in the FUTURE (now + 900s), NOT twoHoursAgo + 900s!
      const nextDueMs = new Date(updated!.next_due_at!).getTime();
      expect(nextDueMs).toBeGreaterThan(Date.now());
    });
  });

  describe('5. Authoritative Lease Verification on Outcome Append', () => {
    let runId: Id;
    let taskId: Id;
    let occurrenceId: Id;
    let commitmentId: Id;
    const workerId = 'worker-p0c3a-test';
    const validEpoch = 1;

    beforeAll(async () => {
      // 1. Create a task via taskRepo
      const receipt = await taskRepo.create(ctxA, {
        agentId: agentAId,
        idempotencyKey: `task-key-${randomUUID()}`,
        kind: 'mock.chat',
        input: { prompt: 'Test task' },
      });
      taskId = receipt.taskId;
      runId = randomUUID();

      // 2. Insert a running run with active lease in runs table
      const leaseUntil = new Date(Date.now() + 60_000); // 1 minute in future
      await db.pool.query(
        `INSERT INTO runs (
          id, tenant_id, task_id, attempt, lease_epoch, status, worker_id, leased_until, started_at
        ) VALUES ($1, $2, $3, 1, $4, 'running', $5, $6, clock_timestamp())`,
        [runId, tenantA.tenantId, taskId, validEpoch, workerId, leaseUntil],
      );

      // 3. Create commitment and reserve occurrence
      const pastDue = new Date(Date.now() - 10_000);
      const { commitment } = await commitmentRepo.create(ctxA, {
        idempotencyKey: `key-${randomUUID()}`,
        agentId: agentAId,
        title: 'Outcome Test Commitment',
        scheduleKind: 'once',
        dueAt: pastDue,
        sourceProfileId: 'fixture.github-release',
      });
      commitmentId = commitment.commitment_id;

      const slot = await commitmentRepo.reserveOccurrence(commitmentId, commitment.version);
      expect(slot).not.toBeNull();
      occurrenceId = slot!.occurrenceId;

      // Mark occurrence as dispatched with taskId
      await commitmentRepo.markDispatched(occurrenceId, taskId);
    });

    it('rejects outcome append when worker lease is stale or mismatched', async () => {
      const staleGrant: WorkerLeaseGrant = {
        tenantId: tenantA.tenantId,
        taskId,
        runId,
        leaseEpoch: 999, // Stale epoch
        workerId,
      };

      const cmd: AppendOutcomeCommand = {
        occurrenceId,
        commitmentId,
        taskId,
        summary: 'Stale attempt summary',
        resultStatus: 'meaningful_change',
      };

      await expect(commitmentRepo.appendOutcomeIfAbsent(staleGrant, cmd)).rejects.toThrowError(
        /Lease is stale or no longer owned by this worker/,
      );
    });

    it('appends outcome with valid lease grant and enforces idempotency', async () => {
      const validGrant: WorkerLeaseGrant = {
        tenantId: tenantA.tenantId,
        taskId,
        runId,
        leaseEpoch: validEpoch,
        workerId,
      };

      const cmd: AppendOutcomeCommand = {
        occurrenceId,
        commitmentId,
        taskId,
        summary: 'Observed release v2.0 without sensitive items.',
        resultStatus: 'meaningful_change',
      };

      // First append succeeds
      const first = await commitmentRepo.appendOutcomeIfAbsent(validGrant, cmd);
      expect(first).toBe(true);

      // Second append is idempotent and returns false (outcome already committed)
      const second = await commitmentRepo.appendOutcomeIfAbsent(validGrant, cmd);
      expect(second).toBe(false);

      // Query outcomes via listOutcomes
      const outcomes = await commitmentRepo.listOutcomes(ctxA, commitmentId);
      expect(outcomes?.outcomes).toHaveLength(1);
      expect(outcomes?.outcomes[0]?.summary).toBe('Observed release v2.0 without sensitive items.');
      expect(outcomes?.outcomes[0]?.result_status).toBe('meaningful_change');
    });

    it('rejects outcome append if commitment was cancelled before publish', async () => {
      // 1. Create a new task & run
      const receipt = await taskRepo.create(ctxA, {
        agentId: agentAId,
        idempotencyKey: `task-key-${randomUUID()}`,
        kind: 'mock.chat',
        input: { prompt: 'Cancelled commitment task' },
      });
      const tId = receipt.taskId;
      const rId = randomUUID();
      const leaseUntil = new Date(Date.now() + 60_000);
      await db.pool.query(
        `INSERT INTO runs (
          id, tenant_id, task_id, attempt, lease_epoch, status, worker_id, leased_until, started_at
        ) VALUES ($1, $2, $3, 1, 1, 'running', $4, $5, clock_timestamp())`,
        [rId, tenantA.tenantId, tId, workerId, leaseUntil],
      );

      // 2. Create commitment & occurrence
      const { commitment } = await commitmentRepo.create(ctxA, {
        idempotencyKey: `key-${randomUUID()}`,
        agentId: agentAId,
        title: 'Cancel Prior to Publish',
        scheduleKind: 'once',
        dueAt: new Date(Date.now() - 5000),
        sourceProfileId: 'fixture.github-release',
      });
      const slot = await commitmentRepo.reserveOccurrence(
        commitment.commitment_id,
        commitment.version,
      );
      await commitmentRepo.markDispatched(slot!.occurrenceId, tId);

      // 3. User cancels the commitment
      await commitmentRepo.cancel(ctxA, commitment.commitment_id);

      // 4. Worker tries to publish outcome -> must fail with POLICY_DENIED
      const grant: WorkerLeaseGrant = {
        tenantId: tenantA.tenantId,
        taskId: tId,
        runId: rId,
        leaseEpoch: 1,
        workerId,
      };

      const cmd: AppendOutcomeCommand = {
        occurrenceId: slot!.occurrenceId,
        commitmentId: commitment.commitment_id,
        taskId: tId,
        summary: 'Late outcome',
        resultStatus: 'meaningful_change',
      };

      await expect(commitmentRepo.appendOutcomeIfAbsent(grant, cmd)).rejects.toThrowError(
        /Operation denied by policy/,
      );
    });
  });

  describe('6. Interrupted Dispatch & Crash Recovery', () => {
    it('finds stalled occurrences and reconciles task dispatch', async () => {
      const pastDue = new Date(Date.now() - 60_000);
      const { commitment } = await commitmentRepo.create(ctxA, {
        idempotencyKey: `key-${randomUUID()}`,
        agentId: agentAId,
        title: 'Stalled Dispatch Task',
        scheduleKind: 'once',
        dueAt: pastDue,
        sourceProfileId: 'fixture.github-release',
      });

      const slot = await commitmentRepo.reserveOccurrence(
        commitment.commitment_id,
        commitment.version,
      );
      expect(slot).not.toBeNull();

      // Backdate occurrence created_at to simulate timeout
      await db.pool.query(
        `UPDATE commitment_occurrences SET created_at = clock_timestamp() - interval '120 seconds' WHERE id = $1`,
        [slot!.occurrenceId],
      );

      // Sweep for stalled occurrences with timeout threshold 60s
      const stalled = await commitmentRepo.findStalledPendingOccurrences(60, 10);
      const target = stalled.find((s) => s.occurrenceId === slot!.occurrenceId);
      expect(target).toBeDefined();
      expect(target!.taskCreationIdempotencyKey).toBe(`commitment-occ:${slot!.occurrenceId}`);

      // Create a real task in DB to satisfy foreign key constraint on reconcile
      const taskReceipt = await taskRepo.create(ctxA, {
        agentId: agentAId,
        idempotencyKey: `reconcile-task-${randomUUID()}`,
        kind: 'mock.chat',
        input: { prompt: 'Reconciled task' },
      });
      const newTaskId = taskReceipt.taskId;

      // Reconcile and bind taskId
      const reconciled = await commitmentRepo.reconcilePendingOccurrence(
        slot!.occurrenceId,
        newTaskId,
      );
      expect(reconciled).toBe(true);

      // Verify status is now dispatched
      const checkRes = await db.pool.query<{ status: string; task_id: string }>(
        `SELECT status, task_id FROM commitment_occurrences WHERE id = $1`,
        [slot!.occurrenceId],
      );
      expect(checkRes.rows[0]?.status).toBe('dispatched');
      expect(checkRes.rows[0]?.task_id).toBe(newTaskId);
    });
  });
});
