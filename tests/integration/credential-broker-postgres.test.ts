/**
 * Integration Test: PostgreSQL-backed Credential Broker & Egress Policy Wiring (Lane P0-C2C).
 *
 * Validates:
 * - Interface-driven composition of PostgresRunExecutionContextReader with CredentialBroker.
 * - Authoritative context verification against real PostgreSQL tables (tasks, runs, agents).
 * - Fail-closed server-bound operational worker identity consistency (trustedWorkerId === context.workerId).
 * - Impossibility of untrusted callers forging authority via callerWorkerId or caller-supplied policy documents.
 * - Preservation of Postgres reader domain error semantics (STALE_LEASE, CANCELLED, NOT_FOUND).
 * - Absolute cross-tenant isolation and uniform agnosticism (NOT_FOUND).
 * - Server-side scope and allowedOperations enforcement.
 * - Credential rotation revocation invalidation.
 * - Duplicate ruleId defense in EgressPolicy.
 * - Zero external network sockets or HTTP calls.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunExecutionContextReader } from '@ember/contracts';
import { DomainError, isDomainError, type AuthContext, type LeasedRun } from '@ember/domain';
import {
  PostgresAgentRepository,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
  type LeaseQueueConfigOverrides,
} from '@ember/postgres';
import {
  CredentialBroker,
  CredentialProxy,
  InMemoryAuditSink,
  InMemoryCredentialRegistry,
  SYNTHETIC_EGRESS_POLICY,
  SYNTHETIC_ORIGIN,
  SYNTHETIC_PROVIDER,
  SYNTHETIC_READ_RULE,
  SYNTHETIC_SCOPE_READ,
  type EgressPolicy,
  type EgressRequest,
  type EgressRule,
} from '../../packages/credentials/src/index.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createTenantFixture, type TenantFixture } from './support/fixtures.js';
import {
  ManualClock,
  createQueuedTask,
  databaseNow,
  parkOtherOpenTasks,
  readTask,
} from './support/leases.js';

const LEASE_DURATION_MS = 10_000;

const QUEUE_OPTIONS: LeaseQueueConfigOverrides = {
  baseDelayMs: 100,
  capDelayMs: 400,
  leaseDurationMs: LEASE_DURATION_MS,
  heartbeatIntervalMs: 100,
  reaperBatchSize: 10,
};

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let ctxA: AuthContext;
let ctxB: AuthContext;
let agentA: Awaited<ReturnType<PostgresAgentRepository['create']>>;
let agentB: Awaited<ReturnType<PostgresAgentRepository['create']>>;
let clock: ManualClock;
let queue: PostgresLeaseQueue;
let contextReader: RunExecutionContextReader;

async function syncClock(): Promise<void> {
  clock.set(new Date((await databaseNow(db.pool)).getTime() + 10));
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 24 });
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  tenantA = await createTenantFixture(db.pool, 'cred tenant A');
  tenantB = await createTenantFixture(db.pool, 'cred tenant B');
  ctxA = { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 };
  ctxB = { tenantId: tenantB.tenantId, principalId: tenantB.principalId, policyVersion: 1 };
  agentA = await agents.create(ctxA, { name: 'cred agent A' });
  agentB = await agents.create(ctxB, { name: 'cred agent B' });

  clock = new ManualClock(await databaseNow(db.pool));
  queue = new PostgresLeaseQueue(db.pool, { ...QUEUE_OPTIONS, clock });
  contextReader = new PostgresRunExecutionContextReader(db.pool, clock);
});

afterAll(async () => {
  await db?.close();
});

describe('CredentialBroker with PostgreSQL context reader (Integration)', () => {
  it('executes a valid simulated request against a live PostgreSQL lease and owner', async () => {
    const workerId = 'worker-it-valid-1';
    const auditSink = new InMemoryAuditSink();
    const registry = new InMemoryCredentialRegistry();

    const broker = new CredentialBroker({
      registry,
      policy: SYNTHETIC_EGRESS_POLICY,
      auditSink,
      trustedWorkerId: workerId,
    });

    const cred = await broker.registerCredential(
      ctxA,
      {
        provider: SYNTHETIC_PROVIDER,
        scopes: [SYNTHETIC_SCOPE_READ],
        description: 'Postgres integration test credential',
      },
      clock.now(),
    );

    const task = await createQueuedTask(tasks, ctxA, agentA.agentId, 'it-exec-success');
    await syncClock();
    await parkOtherOpenTasks(db.pool, task.taskId);

    const lease = await queue.claimNext(workerId, clock.now());
    expect(lease).not.toBeNull();
    const activeLease = lease as LeasedRun;
    expect(activeLease.taskId).toBe(task.taskId);

    const request: EgressRequest = {
      url: `${SYNTHETIC_ORIGIN}/v1/status`,
      method: 'GET',
      provider: SYNTHETIC_PROVIDER,
      operation: 'status_check',
      requestedScopes: [SYNTHETIC_SCOPE_READ],
    };

    const result = await broker.executeWithCredential(
      activeLease,
      cred.credentialRef,
      request,
      contextReader,
      clock.now(),
    );

    expect(result.status).toBe('SIMULATED');
    expect(result.allowed).toBe(true);
    expect(result.executionContext.tenantId).toBe(ctxA.tenantId);
    expect(result.executionContext.taskId).toBe(task.taskId);
    expect(result.executionContext.runId).toBe(activeLease.runId);
    expect(result.egress.matchedRuleId).toBe(SYNTHETIC_READ_RULE.ruleId);

    const records = auditSink.getRecords();
    expect(records.length).toBe(1);
    expect(records[0]?.decision).toBe('ALLOWED');
    expect(records[0]?.networkCallsMade).toBe(0);
  });

  it('fails closed when trusted operational workerId is missing on broker', async () => {
    const workerId = 'worker-it-unconfigured';
    const registry = new InMemoryCredentialRegistry();

    // Composition root forgot or omitted trustedWorkerId
    const brokerWithoutWorker = new CredentialBroker({
      registry,
      policy: SYNTHETIC_EGRESS_POLICY,
    });

    const cred = await brokerWithoutWorker.registerCredential(
      ctxA,
      { provider: SYNTHETIC_PROVIDER, scopes: [SYNTHETIC_SCOPE_READ] },
      clock.now(),
    );

    const task = await createQueuedTask(tasks, ctxA, agentA.agentId, 'it-missing-worker');
    await syncClock();
    await parkOtherOpenTasks(db.pool, task.taskId);

    const lease = await queue.claimNext(workerId, clock.now());
    expect(lease).not.toBeNull();

    const request: EgressRequest = {
      url: `${SYNTHETIC_ORIGIN}/v1/status`,
      method: 'GET',
      provider: SYNTHETIC_PROVIDER,
      operation: 'status_check',
    };

    try {
      await brokerWithoutWorker.executeWithCredential(
        lease as LeasedRun,
        cred.credentialRef,
        request,
        contextReader,
        clock.now(),
      );
      expect.unreachable('Should have failed closed without trustedWorkerId');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        expect(err.code).toBe('UNAUTHENTICATED');
        expect(err.diagnostic).toContain('Trusted worker identity is required');
      }
    }
  });

  it('fails closed when trusted operational workerId mismatches PostgreSQL persisted worker_id', async () => {
    const actualDbWorker = 'worker-it-actual-owner';
    const imposterWorker = 'worker-it-imposter';
    const registry = new InMemoryCredentialRegistry();

    // Broker process configured as 'worker-it-imposter'
    const brokerImposter = new CredentialBroker({
      registry,
      policy: SYNTHETIC_EGRESS_POLICY,
      trustedWorkerId: imposterWorker,
    });

    const cred = await brokerImposter.registerCredential(
      ctxA,
      { provider: SYNTHETIC_PROVIDER, scopes: [SYNTHETIC_SCOPE_READ] },
      clock.now(),
    );

    // Actual run in PostgreSQL is claimed by 'worker-it-actual-owner'
    const task = await createQueuedTask(tasks, ctxA, agentA.agentId, 'it-mismatched-worker');
    await syncClock();
    await parkOtherOpenTasks(db.pool, task.taskId);

    const lease = await queue.claimNext(actualDbWorker, clock.now());
    expect(lease).not.toBeNull();

    const request: EgressRequest = {
      url: `${SYNTHETIC_ORIGIN}/v1/status`,
      method: 'GET',
      provider: SYNTHETIC_PROVIDER,
      operation: 'status_check',
    };

    try {
      await brokerImposter.executeWithCredential(
        lease as LeasedRun,
        cred.credentialRef,
        request,
        contextReader,
        clock.now(),
      );
      expect.unreachable('Should have failed closed on worker identity mismatch');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        expect(err.code).toBe('UNAUTHENTICATED');
        expect(err.diagnostic).toContain('Operational worker identity mismatch');
      }
    }
  });

  it('proves that untrusted caller-supplied callerWorkerId has zero authority and cannot match/override Postgres worker_id', async () => {
    const actualDbWorker = 'worker-it-db-legit';
    const imposterWorker = 'worker-it-spoof-client';
    const registry = new InMemoryCredentialRegistry();

    const broker = new CredentialBroker({
      registry,
      policy: SYNTHETIC_EGRESS_POLICY,
      trustedWorkerId: imposterWorker,
    });

    const cred = await broker.registerCredential(
      ctxA,
      { provider: SYNTHETIC_PROVIDER, scopes: [SYNTHETIC_SCOPE_READ] },
      clock.now(),
    );

    const task = await createQueuedTask(tasks, ctxA, agentA.agentId, 'it-spoofed-payload');
    await syncClock();
    await parkOtherOpenTasks(db.pool, task.taskId);

    const lease = await queue.claimNext(actualDbWorker, clock.now());
    expect(lease).not.toBeNull();

    // Adversarial caller attempts to assert the legitimate workerId in the request body
    const spoofedRequest: EgressRequest & { callerWorkerId?: string; policy?: unknown } = {
      url: `${SYNTHETIC_ORIGIN}/v1/status`,
      method: 'GET',
      provider: SYNTHETIC_PROVIDER,
      operation: 'status_check',
      callerWorkerId: actualDbWorker,
      policy: { defaultAction: 'allow' },
    };

    try {
      await broker.executeWithCredential(
        lease as LeasedRun,
        cred.credentialRef,
        spoofedRequest,
        contextReader,
        clock.now(),
      );
      expect.unreachable('Caller assertion of callerWorkerId must have zero authority');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        expect(err.code).toBe('UNAUTHENTICATED');
      }
    }
  });

  it('rejects execution when the PostgreSQL lease is expired with observable STALE_LEASE semantics', async () => {
    const workerId = 'worker-it-expired-lease';
    const registry = new InMemoryCredentialRegistry();
    const broker = new CredentialBroker({
      registry,
      policy: SYNTHETIC_EGRESS_POLICY,
      trustedWorkerId: workerId,
    });

    const cred = await broker.registerCredential(
      ctxA,
      { provider: SYNTHETIC_PROVIDER, scopes: [SYNTHETIC_SCOPE_READ] },
      clock.now(),
    );

    const task = await createQueuedTask(tasks, ctxA, agentA.agentId, 'it-expired-lease');
    await syncClock();
    await parkOtherOpenTasks(db.pool, task.taskId);

    const lease = await queue.claimNext(workerId, clock.now());
    expect(lease).not.toBeNull();

    // Advance clock past lease expiry
    clock.advance(LEASE_DURATION_MS + 2_000);

    const request: EgressRequest = {
      url: `${SYNTHETIC_ORIGIN}/v1/status`,
      method: 'GET',
      provider: SYNTHETIC_PROVIDER,
      operation: 'status_check',
    };

    try {
      await broker.executeWithCredential(
        lease as LeasedRun,
        cred.credentialRef,
        request,
        contextReader,
        clock.now(),
      );
      expect.unreachable('Expired lease must be rejected');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        // Must preserve STALE_LEASE from the authoritative PostgreSQL reader
        expect(err.code).toBe('STALE_LEASE');
        expect(err.diagnostic).toContain('lease has expired');
      }
    }
  });

  it('rejects execution when task has a committed cancellation intent with observable CANCELLED semantics', async () => {
    const workerId = 'worker-it-cancel';
    const registry = new InMemoryCredentialRegistry();
    const broker = new CredentialBroker({
      registry,
      policy: SYNTHETIC_EGRESS_POLICY,
      trustedWorkerId: workerId,
    });

    const cred = await broker.registerCredential(
      ctxA,
      { provider: SYNTHETIC_PROVIDER, scopes: [SYNTHETIC_SCOPE_READ] },
      clock.now(),
    );

    const task = await createQueuedTask(tasks, ctxA, agentA.agentId, 'it-cancelled-task');
    await syncClock();
    await parkOtherOpenTasks(db.pool, task.taskId);

    const lease = await queue.claimNext(workerId, clock.now());
    expect(lease).not.toBeNull();

    // Request cancellation of the running task in PostgreSQL
    await tasks.requestCancel(ctxA, task.taskId);
    const dbTask = await readTask(db.observerPool, ctxA.tenantId, task.taskId);
    expect(dbTask.cancel_requested_at).not.toBeNull();

    const request: EgressRequest = {
      url: `${SYNTHETIC_ORIGIN}/v1/status`,
      method: 'GET',
      provider: SYNTHETIC_PROVIDER,
      operation: 'status_check',
    };

    try {
      await broker.executeWithCredential(
        lease as LeasedRun,
        cred.credentialRef,
        request,
        contextReader,
        clock.now(),
      );
      expect.unreachable('Cancelled task must be rejected');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        // Must preserve CANCELLED from the authoritative PostgreSQL reader
        expect(err.code).toBe('CANCELLED');
        expect(err.diagnostic).toContain('cancellation intent');
      }
    }
  });

  it('rejects execution when the lease epoch is stale/fenced by a subsequent attempt', async () => {
    const worker1 = 'worker-it-fenced-1';
    const worker2 = 'worker-it-fenced-2';
    const registry = new InMemoryCredentialRegistry();

    const broker1 = new CredentialBroker({
      registry,
      policy: SYNTHETIC_EGRESS_POLICY,
      trustedWorkerId: worker1,
    });

    const cred = await broker1.registerCredential(
      ctxA,
      { provider: SYNTHETIC_PROVIDER, scopes: [SYNTHETIC_SCOPE_READ] },
      clock.now(),
    );

    const task = await createQueuedTask(tasks, ctxA, agentA.agentId, 'it-fenced-lease');
    await syncClock();
    await parkOtherOpenTasks(db.pool, task.taskId);

    const firstLease = await queue.claimNext(worker1, clock.now());
    expect(firstLease).not.toBeNull();
    expect(firstLease?.attempt).toBe(1);

    // Expire attempt 1 and reap it
    clock.advance(LEASE_DURATION_MS);
    await queue.reapExpired(clock.now());

    // Advance to next retry time and claim attempt 2 with worker 2
    const afterReap = await readTask(db.observerPool, ctxA.tenantId, task.taskId);
    clock.set(afterReap.next_run_at);
    await parkOtherOpenTasks(db.pool, task.taskId);

    const secondLease = await queue.claimNext(worker2, clock.now());
    expect(secondLease).not.toBeNull();
    expect(secondLease?.attempt).toBe(2);

    // Worker 1 now attempts to execute with stale attempt 1 lease
    const request: EgressRequest = {
      url: `${SYNTHETIC_ORIGIN}/v1/status`,
      method: 'GET',
      provider: SYNTHETIC_PROVIDER,
      operation: 'status_check',
    };

    try {
      await broker1.executeWithCredential(
        firstLease as LeasedRun,
        cred.credentialRef,
        request,
        contextReader,
        clock.now(),
      );
      expect.unreachable('Fenced lease epoch must be rejected');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        expect(err.code).toBe('STALE_LEASE');
        expect(err.diagnostic).toContain('matches the lease');
      }
    }
  });

  it('enforces uniform agnosticism and cross-tenant isolation (NOT_FOUND)', async () => {
    const workerB = 'worker-it-tenant-b';
    const registry = new InMemoryCredentialRegistry();

    const brokerB = new CredentialBroker({
      registry,
      policy: SYNTHETIC_EGRESS_POLICY,
      trustedWorkerId: workerB,
    });

    // Credential is created in Tenant A
    const credA = await brokerB.registerCredential(
      ctxA,
      { provider: SYNTHETIC_PROVIDER, scopes: [SYNTHETIC_SCOPE_READ] },
      clock.now(),
    );

    // Tenant B creates and claims a task in Tenant B
    const taskB = await createQueuedTask(tasks, ctxB, agentB.agentId, 'it-cross-tenant-b');
    await syncClock();
    await parkOtherOpenTasks(db.pool, taskB.taskId);

    const leaseB = await queue.claimNext(workerB, clock.now());
    expect(leaseB).not.toBeNull();

    const request: EgressRequest = {
      url: `${SYNTHETIC_ORIGIN}/v1/status`,
      method: 'GET',
      provider: SYNTHETIC_PROVIDER,
      operation: 'status_check',
    };

    // Tenant B attempts to use Tenant A's credential reference
    try {
      await brokerB.executeWithCredential(
        leaseB as LeasedRun,
        credA.credentialRef,
        request,
        contextReader,
        clock.now(),
      );
      expect.unreachable('Cross-tenant credential lookup must return NOT_FOUND');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        expect(err.code).toBe('NOT_FOUND');
        expect(err.diagnostic).toContain('Credential not found in this tenant');
      }
    }

    // Tenant B attempts to read Tenant A's lease directly
    const spoofedLeaseFromA: LeasedRun = {
      tenantId: ctxA.tenantId,
      taskId: taskB.taskId,
      runId: (leaseB as LeasedRun).runId,
      attempt: 1,
      leaseEpoch: 1,
      leaseExpiresAt: (leaseB as LeasedRun).leaseExpiresAt,
    };

    try {
      await brokerB.executeWithCredential(
        spoofedLeaseFromA,
        credA.credentialRef,
        request,
        contextReader,
        clock.now(),
      );
      expect.unreachable('Cross-tenant lease reading must return NOT_FOUND');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        expect(err.code).toBe('NOT_FOUND');
      }
    }
  });

  it('enforces server-side requiredScopes and operation whitelist, rejecting unpermitted actions', async () => {
    const workerId = 'worker-it-scope-guard';
    const auditSink = new InMemoryAuditSink();
    const registry = new InMemoryCredentialRegistry();

    const broker = new CredentialBroker({
      registry,
      policy: SYNTHETIC_EGRESS_POLICY,
      auditSink,
      trustedWorkerId: workerId,
    });

    const task = await createQueuedTask(tasks, ctxA, agentA.agentId, 'it-scopes');
    await syncClock();
    await parkOtherOpenTasks(db.pool, task.taskId);

    const lease = await queue.claimNext(workerId, clock.now());
    expect(lease).not.toBeNull();

    // 1. Rejection on unlisted operation
    const credValid = await broker.registerCredential(
      ctxA,
      { provider: SYNTHETIC_PROVIDER, scopes: [SYNTHETIC_SCOPE_READ] },
      clock.now(),
    );

    const illegalOpRequest: EgressRequest = {
      url: `${SYNTHETIC_ORIGIN}/v1/status`,
      method: 'GET',
      provider: SYNTHETIC_PROVIDER,
      operation: 'destroy_database',
    };

    await expect(
      broker.executeWithCredential(
        lease as LeasedRun,
        credValid.credentialRef,
        illegalOpRequest,
        contextReader,
        clock.now(),
      ),
    ).rejects.toThrow(DomainError);

    // 2. Rejection on missing server-side requiredScopes
    const credInsufficient = await broker.registerCredential(
      ctxA,
      { provider: SYNTHETIC_PROVIDER, scopes: ['connector:unrelated_scope'] },
      clock.now(),
    );

    const scopeRequest: EgressRequest = {
      url: `${SYNTHETIC_ORIGIN}/v1/status`,
      method: 'GET',
      provider: SYNTHETIC_PROVIDER,
      operation: 'status_check',
    };

    try {
      await broker.executeWithCredential(
        lease as LeasedRun,
        credInsufficient.credentialRef,
        scopeRequest,
        contextReader,
        clock.now(),
      );
      expect.unreachable('Insufficient credential scopes must be rejected');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        expect(err.code).toBe('POLICY_DENIED');
        expect(err.diagnostic).toContain('SCOPE_MISMATCH');
      }
    }
  });

  it('invalidates old credential references upon rotation and enforces revocation', async () => {
    const workerId = 'worker-it-rotation';
    const registry = new InMemoryCredentialRegistry();
    const broker = new CredentialBroker({
      registry,
      policy: SYNTHETIC_EGRESS_POLICY,
      trustedWorkerId: workerId,
    });

    const credOriginal = await broker.registerCredential(
      ctxA,
      { provider: SYNTHETIC_PROVIDER, scopes: [SYNTHETIC_SCOPE_READ] },
      clock.now(),
    );

    const task = await createQueuedTask(tasks, ctxA, agentA.agentId, 'it-rotate');
    await syncClock();
    await parkOtherOpenTasks(db.pool, task.taskId);

    const lease = await queue.claimNext(workerId, clock.now());
    expect(lease).not.toBeNull();

    // Rotate credential: old reference is revoked, new reference is generated
    const credRotated = await broker.rotateCredential(
      ctxA,
      credOriginal.credentialRef,
      {},
      clock.now(),
    );
    expect(credRotated.version).toBe(2);
    expect(credRotated.credentialRef).not.toBe(credOriginal.credentialRef);

    const request: EgressRequest = {
      url: `${SYNTHETIC_ORIGIN}/v1/status`,
      method: 'GET',
      provider: SYNTHETIC_PROVIDER,
      operation: 'status_check',
    };

    // Old reference must be rejected with POLICY_DENIED (revoked)
    try {
      await broker.executeWithCredential(
        lease as LeasedRun,
        credOriginal.credentialRef,
        request,
        contextReader,
        clock.now(),
      );
      expect.unreachable('Revoked old credential must fail');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        expect(err.code).toBe('POLICY_DENIED');
        expect(err.diagnostic).toContain('revoked');
      }
    }

    // New reference succeeds
    const allowed = await broker.executeWithCredential(
      lease as LeasedRun,
      credRotated.credentialRef,
      request,
      contextReader,
      clock.now(),
    );
    expect(allowed.status).toBe('SIMULATED');
    expect(allowed.allowed).toBe(true);
  });

  it('rejects duplicate ruleId in EgressPolicy constructor to prevent shadowing', () => {
    const registry = new InMemoryCredentialRegistry();
    const duplicateRule: EgressRule = {
      ruleId: 'duplicate-rule-id',
      provider: SYNTHETIC_PROVIDER,
      allowedOrigins: [SYNTHETIC_ORIGIN],
      allowedMethods: ['GET'],
      allowedPathPatterns: ['/v1/items'],
      requiredScopes: [SYNTHETIC_SCOPE_READ],
      allowedOperations: ['get_item'],
      operationKind: 'read',
    };

    const duplicatePolicy: EgressPolicy = {
      version: 1,
      rules: [duplicateRule, duplicateRule],
      defaultAction: 'deny',
    };

    expect(
      () =>
        new CredentialBroker({
          registry,
          policy: duplicatePolicy,
          trustedWorkerId: 'worker-duplicate-rule-test',
        }),
    ).toThrow(DomainError);
  });

  it('strictly guarantees 0 outbound network/socket/DNS calls across all operations', async () => {
    const httpSpy = vi.spyOn(http, 'request');
    const httpsSpy = vi.spyOn(https, 'request');
    const netConnectSpy = vi.spyOn(net, 'connect');
    const socketConnectSpy = vi.spyOn(net.Socket.prototype, 'connect');
    const dnsLookupSpy = vi.spyOn(dns, 'lookup');
    const dnsResolveSpy = vi.spyOn(dns, 'resolve');
    const fetchSpy = typeof globalThis.fetch === 'function' ? vi.spyOn(globalThis, 'fetch') : null;

    try {
      const workerId = 'worker-it-zero-network';
      const registry = new InMemoryCredentialRegistry();
      const broker = new CredentialBroker({
        registry,
        policy: SYNTHETIC_EGRESS_POLICY,
        trustedWorkerId: workerId,
      });
      const proxy = new CredentialProxy({ broker });

      expect(proxy.activeSocketsCount()).toBe(0);
      expect(proxy.networkCallsAttempted()).toBe(0);

      const cred = await broker.registerCredential(
        ctxA,
        { provider: SYNTHETIC_PROVIDER, scopes: [SYNTHETIC_SCOPE_READ] },
        clock.now(),
      );

      const task = await createQueuedTask(tasks, ctxA, agentA.agentId, 'it-zero-net');
      await syncClock();
      await parkOtherOpenTasks(db.pool, task.taskId);

      const lease = await queue.claimNext(workerId, clock.now());
      expect(lease).not.toBeNull();

      // Allowed simulated request
      const allowedResult = await proxy.proxyRequest(
        lease as LeasedRun,
        cred.credentialRef,
        {
          url: `${SYNTHETIC_ORIGIN}/v1/status`,
          method: 'GET',
          provider: SYNTHETIC_PROVIDER,
          operation: 'status_check',
        },
        contextReader,
        clock.now(),
      );
      expect(allowedResult.status).toBe('SIMULATED');

      // Denied simulated request
      await expect(
        proxy.proxyRequest(
          lease as LeasedRun,
          cred.credentialRef,
          {
            url: 'https://evil.example.com/exfiltrate',
            method: 'GET',
            provider: SYNTHETIC_PROVIDER,
            operation: 'status_check',
          },
          contextReader,
          clock.now(),
        ),
      ).rejects.toThrow();

      // Assert zero socket or network calls
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
      expect(netConnectSpy).not.toHaveBeenCalled();
      expect(socketConnectSpy).not.toHaveBeenCalled();
      expect(dnsLookupSpy).not.toHaveBeenCalled();
      expect(dnsResolveSpy).not.toHaveBeenCalled();
      if (fetchSpy) {
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    } finally {
      httpSpy.mockRestore();
      httpsSpy.mockRestore();
      netConnectSpy.mockRestore();
      socketConnectSpy.mockRestore();
      dnsLookupSpy.mockRestore();
      dnsResolveSpy.mockRestore();
      fetchSpy?.mockRestore();
    }
  });
});
