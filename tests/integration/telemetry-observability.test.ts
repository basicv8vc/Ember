import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@ember/domain';
import {
  PostgresAgentRepository,
  PostgresLeaseQueue,
  PostgresTaskRepository,
} from '@ember/postgres';
import {
  assertSimulatedCost,
  createSimulatedUsageRecord,
  createTelemetryLogger,
  createTenantHash,
  MetricsAggregator,
  RunTraceCollector,
  RunTraceRecordSchema,
} from '@ember/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { chatCommand, createTenantFixture, type TenantFixture } from './support/fixtures.js';

describe('B-T30 Telemetry & Observability (PostgreSQL Integration)', () => {
  let db: TestDatabase;
  let agents: PostgresAgentRepository;
  let tasks: PostgresTaskRepository;
  let queue: PostgresLeaseQueue;
  let tenantA: TenantFixture;
  let agentA: Awaited<ReturnType<PostgresAgentRepository['create']>>;
  let ctxA: AuthContext;

  beforeAll(async () => {
    db = await createTestDatabase();
    agents = new PostgresAgentRepository(db.pool);
    tasks = new PostgresTaskRepository(db.pool);
    tenantA = await createTenantFixture(db.pool, 'tenant-telemetry-a');
    ctxA = { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 };
    agentA = await agents.create(ctxA, { name: 'agent-telemetry-a' });

    queue = new PostgresLeaseQueue(db.pool, {
      baseDelayMs: 100,
      capDelayMs: 400,
      leaseDurationMs: 5_000,
      heartbeatIntervalMs: 100,
      reaperBatchSize: 10,
    });
  });

  afterAll(async () => {
    await db.close();
  });

  it('B-T30: strictly annotates simulated cost and enforces actual_vendor_cost_usd=null', async () => {
    const rawPrompt = 'Sensitive user prompt requesting internal information';
    const devToken = 'dev_token_super_secret_local_auth_99999999';

    // 1. Create a task in PostgreSQL
    const requestReceived = new Date();
    const created = await tasks.create(
      ctxA,
      chatCommand(agentA.agentId, `key-${randomUUID()}`, rawPrompt),
    );
    const durableAck = new Date();

    expect(created.taskId).toBeDefined();

    // 2. Worker claims task lease
    const claimTime = new Date();
    const leased = await queue.claimNext('telemetry-worker', claimTime);
    expect(leased).not.toBeNull();
    expect(leased?.taskId).toBe(created.taskId);

    // 3. Collect trace with stages
    const collector = new RunTraceCollector({
      traceId: randomUUID().replace(/-/g, ''),
      tenantId: ctxA.tenantId,
      taskId: created.taskId,
      runId: leased!.runId,
      path: 'fast',
      routeReason: 'mock.chat:fast',
      attempt: leased!.attempt,
      leaseEpoch: leased!.leaseEpoch,
    });

    collector
      .recordStage('request_received', requestReceived)
      .recordStage('durable_ack', durableAck)
      .recordStage('runnable', durableAck)
      .recordStage('lease_acquired', claimTime)
      .recordStage('task_terminal', new Date())
      .setOutcome({
        simulatedCpuMs: 25,
        simulatedUsageUnits: 1,
      });

    const trace = collector.toRecord();

    // Verify DoD invariants: provider=fake, cost_source=simulated, actual_vendor_cost_usd=null
    expect(trace.provider).toBe('fake');
    expect(trace.cost_source).toBe('simulated');
    expect(trace.actual_vendor_cost_usd).toBeNull();
    expect(trace.simulated_cpu_ms).toBe(25);
    expect(trace.simulated_usage_units).toBe(1);

    // Verify tenant privacy: tenant_hash is populated, raw tenant ID is not present in trace
    expect(trace.tenant_hash).toBe(createTenantHash(ctxA.tenantId));
    expect(trace).not.toHaveProperty('tenant_id');
    expect(trace).not.toHaveProperty('tenantId');

    // Verify duration calculation
    expect(trace.gateway_persist_ms).toBeGreaterThanOrEqual(0);
    expect(trace.queue_wait_ms).toBeGreaterThanOrEqual(0);
    expect(trace.fake_sandbox_ready_ms).toBeNull(); // Fast path has no sandbox
    expect(trace.task_wall_ms).toBeGreaterThanOrEqual(0);

    expect(() => RunTraceRecordSchema.parse(trace)).not.toThrow();

    // 4. Create and assert SimulatedUsageRecord
    const usage = createSimulatedUsageRecord({
      traceId: trace.trace_id,
      tenantId: ctxA.tenantId,
      taskId: trace.task_id,
      runId: trace.run_id,
      simulatedCpuMs: trace.simulated_cpu_ms,
      simulatedUsageUnits: trace.simulated_usage_units,
    });

    expect(usage.cost_source).toBe('simulated');
    expect(usage.actual_vendor_cost_usd).toBeNull();
    assertSimulatedCost(usage);

    // 5. Verify Logger redacts Dev Token and Prompt
    const loggedLines: string[] = [];
    const logger = createTelemetryLogger({
      level: 'info',
      sink: (_level, line) => loggedLines.push(line),
    });

    logger.info('Processing task run with bearer token and prompt', {
      tenantId: ctxA.tenantId,
      taskId: created.taskId,
      runId: leased!.runId,
      traceId: trace.trace_id,
      authorization: `Bearer ${devToken}`,
      prompt: rawPrompt,
    });

    expect(loggedLines).toHaveLength(1);
    const line = loggedLines[0]!;

    expect(line).not.toContain(devToken);
    expect(line).not.toContain(rawPrompt);
    expect(line).not.toContain(ctxA.tenantId);
    expect(line).toContain(createTenantHash(ctxA.tenantId));
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('[REDACTED_PROMPT]');

    // Clean finish
    await queue.finish(leased!, 'succeeded');
  });

  it('aggregates multi-run quantile statistics with sample and failure tracking', () => {
    const aggregator = new MetricsAggregator();

    // Record 5 simulated successful runs
    for (let i = 1; i <= 5; i++) {
      const collector = new RunTraceCollector({
        traceId: randomUUID().replace(/-/g, ''),
        tenantId: ctxA.tenantId,
        taskId: randomUUID(),
        runId: randomUUID(),
        path: 'standard',
        routeReason: 'mock.compute:standard',
      });

      collector
        .recordStage('request_received', '2026-10-30T10:00:00.000Z')
        .recordStage('durable_ack', new Date(Date.parse('2026-10-30T10:00:00.000Z') + i * 10))
        .recordStage('runnable', new Date(Date.parse('2026-10-30T10:00:00.000Z') + i * 15))
        .recordStage('lease_acquired', new Date(Date.parse('2026-10-30T10:00:00.000Z') + i * 50))
        .recordStage('sandbox_create', new Date(Date.parse('2026-10-30T10:00:00.000Z') + i * 55))
        .recordStage('sandbox_ready', new Date(Date.parse('2026-10-30T10:00:00.000Z') + i * 75))
        .recordStage('task_terminal', new Date(Date.parse('2026-10-30T10:00:00.000Z') + i * 100))
        .setOutcome({
          simulatedCpuMs: 50,
          simulatedUsageUnits: 2,
        });

      aggregator.recordRun(collector.toRecord());
    }

    // Record 1 timeout failure
    const timeoutCollector = new RunTraceCollector({
      traceId: randomUUID().replace(/-/g, ''),
      tenantId: ctxA.tenantId,
      taskId: randomUUID(),
      runId: randomUUID(),
      path: 'standard',
      routeReason: 'mock.compute:timeout',
    });
    timeoutCollector
      .recordStage('request_received', '2026-10-30T10:00:00.000Z')
      .recordStage('durable_ack', '2026-10-30T10:00:00.050Z')
      .recordStage('runnable', '2026-10-30T10:00:00.060Z')
      .recordStage('lease_acquired', '2026-10-30T10:00:00.200Z')
      .recordStage('task_terminal', '2026-10-30T10:00:01.000Z')
      .setOutcome({
        errorCode: 'EXECUTION_TIMEOUT',
      });
    aggregator.recordRun(timeoutCollector.toRecord());

    const reports = aggregator.getAllReports();

    expect(reports.queue_wait_ms.sample_count).toBe(6);
    expect(reports.queue_wait_ms.observed_count).toBe(6);
    expect(reports.queue_wait_ms.missing_count).toBe(0);
    expect(reports.queue_wait_ms.success_count).toBe(5);
    expect(reports.queue_wait_ms.failed_count).toBe(1);
    expect(reports.queue_wait_ms.timeout_count).toBe(1);
    expect(reports.queue_wait_ms.cancelled_count).toBe(0);

    expect(reports.queue_wait_ms.p50_ms).toBeGreaterThan(0);
    expect(reports.queue_wait_ms.p95_ms).toBeGreaterThanOrEqual(reports.queue_wait_ms.p50_ms!);
    expect(reports.queue_wait_ms.p99_ms).toBeGreaterThanOrEqual(reports.queue_wait_ms.p95_ms!);
    expect(reports.task_wall_ms.sample_count).toBe(6);
    expect(reports.task_wall_ms.max_ms).toBe(1000);
  });
});
