import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '@ember/domain';
import { DomainError } from '@ember/domain';
import {
  PostgresAgentRepository,
  PostgresBudgetLedger,
  PostgresLeaseQueue,
  PostgresTaskRepository,
  systemClock,
} from '@ember/postgres';
import {
  CommitmentOrchestrator,
  createDefaultSentinelPolicy,
  type AppendOutcomeCommand,
  type OutcomeResultStatus,
  type SourceSnapshot,
  type WorkerLeaseGrant,
} from '@ember/execution';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createTenantFixture, type TenantFixture } from './support/fixtures.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';

describe('P0-C3B: Worker Commitment Integration Tests', () => {
  let db: TestDatabase;
  let tenant: TenantFixture;
  let ctx: AuthContext;
  let agents: PostgresAgentRepository;
  let tasks: PostgresTaskRepository;
  let queue: PostgresLeaseQueue;
  let budgetLedger: PostgresBudgetLedger;
  const logger = createWorkerLogger({ level: 'error' });
  const WORKER_ID = 'worker-int-1';

  beforeAll(async () => {
    db = await createTestDatabase();
    tenant = await createTenantFixture(db.pool, 'p0c3-worker-integration-tenant');
    ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 };
    agents = new PostgresAgentRepository(db.pool);
    tasks = new PostgresTaskRepository(db.pool);
    queue = new PostgresLeaseQueue(db.pool, {
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      baseDelayMs: 1_000,
      capDelayMs: 30_000,
      reaperBatchSize: 10,
      clock: systemClock,
    });
    budgetLedger = new PostgresBudgetLedger(db.pool, {
      policy: {
        policyId: 'budget-integration-policy',
        policyVersion: 1,
        maxRunSteps: 10,
        maxRunUnits: 100,
        maxRunElapsedMs: 60_000,
        maxTenantDailyUnits: 1_000,
        maxConcurrentSlots: 4,
      },
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  it('executes a commitment occurrence through guarded orchestrator with real postgres context', async () => {
    const agent = await agents.create(ctx, { name: 'p0c3 worker agent' });
    const commitmentId = randomUUID();
    const occurrenceId = randomUUID();

    // 1. Create durable task representing commitment occurrence
    const receipt = await tasks.create(ctx, {
      agentId: agent.agentId,
      kind: 'mock.compute',
      input: {
        operation: 'sha256',
        text: JSON.stringify({
          commitmentId,
          occurrenceId,
          sourceProfileId: 'profile-public-tech',
          scheduleKind: 'once',
        }),
      },
      idempotencyKey: `commitment-occ:${occurrenceId}`,
    });

    expect(receipt.taskId).toBeDefined();

    // 2. Set up local structural store & source reader ports
    const committedOutcomes = new Map<string, AppendOutcomeCommand>();

    const storePort = {
      findAuthoritativeOutcome(
        grant: WorkerLeaseGrant,
        query: { occurrenceId: string; commitmentId: string },
      ): Promise<{ readonly resultStatus: OutcomeResultStatus; readonly summary: string } | null> {
        if (grant.tenantId !== ctx.tenantId) {
          return Promise.reject(new DomainError('POLICY_DENIED', 'Cross-tenant access prohibited'));
        }
        const found = committedOutcomes.get(query.occurrenceId);
        return Promise.resolve(
          found ? { resultStatus: found.resultStatus, summary: found.summary } : null,
        );
      },
      appendOutcomeIfAbsent(_grant: WorkerLeaseGrant, cmd: AppendOutcomeCommand): Promise<boolean> {
        if (committedOutcomes.has(cmd.occurrenceId)) {
          return Promise.resolve(false);
        }
        committedOutcomes.set(cmd.occurrenceId, cmd);
        return Promise.resolve(true);
      },
    };

    const sourceReaderPort = {
      readSnapshot(profileId: string): Promise<SourceSnapshot> {
        return Promise.resolve({
          sourceProfileId: profileId,
          observedAt: new Date().toISOString(),
          digest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          boundedSafeItems: [
            {
              id: 'tech-1',
              title: 'TypeScript 5.9 Released',
              contentSnippet: 'Features faster incremental compilation and build tools.',
              observedAt: new Date().toISOString(),
            },
          ],
        });
      },
    };

    const sentinelPolicy = createDefaultSentinelPolicy({
      policyId: 'sentinel-integration-policy',
      policyVersion: 1,
      tenantId: tenant.tenantId,
      allowedActions: ['mock.read', 'mock.compute'],
    });

    const orchestrator = new CommitmentOrchestrator({
      store: storePort,
      sourceReader: sourceReaderPort,
      budget: budgetLedger,
      sentinelPolicy,
      logger,
    });

    // Claim the task to issue an authoritative leased run in PostgreSQL
    const leasedRun = await queue.claimNext(WORKER_ID, systemClock.now());
    expect(leasedRun).not.toBeNull();
    expect(leasedRun?.taskId).toBe(receipt.taskId);

    const grant: WorkerLeaseGrant = {
      tenantId: leasedRun!.tenantId,
      taskId: leasedRun!.taskId,
      runId: leasedRun!.runId,
      attempt: leasedRun!.attempt,
      leaseEpoch: leasedRun!.leaseEpoch,
      workerId: WORKER_ID,
    };

    const signal = new AbortController().signal;

    const executionResult = await orchestrator.execute(
      grant,
      {
        tenantId: tenant.tenantId,
        agentId: agent.agentId,
        commitmentId,
        occurrenceId,
        sourceProfileId: 'profile-public-tech',
        scheduleKind: 'once',
        policyVersion: 1,
      },
      signal,
    );

    expect(executionResult.outcomeCommitted).toBe(true);
    expect(executionResult.replayed).toBe(false);
    expect(executionResult.resultStatus).toBe('meaningful_change');
    expect(committedOutcomes.size).toBe(1);
    // One-shot completion is owned by the publication transaction, not by a second orchestrator
    // write; see PostgresCommitmentRepository.appendOutcomeIfAbsent.

    // Replay attempt returns replayed: true and doesn't duplicate outcome
    const replayResult = await orchestrator.execute(
      grant,
      {
        tenantId: tenant.tenantId,
        agentId: agent.agentId,
        commitmentId,
        occurrenceId,
        sourceProfileId: 'profile-public-tech',
        scheduleKind: 'once',
        policyVersion: 1,
      },
      signal,
    );

    expect(replayResult.outcomeCommitted).toBe(false);
    expect(replayResult.replayed).toBe(true);
    expect(committedOutcomes.size).toBe(1);
  });
});
