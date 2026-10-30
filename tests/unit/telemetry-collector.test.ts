import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeStageDurations, RunTraceCollector, RunTraceRecordSchema } from '@ember/telemetry';

describe('telemetry collector and stage duration computation', () => {
  it('computes exact stage durations when all timestamps are present', () => {
    const timestamps = {
      request_received: '2026-10-30T10:00:00.000Z',
      durable_ack: '2026-10-30T10:00:00.040Z', // +40ms
      first_real_event: '2026-10-30T10:00:00.050Z',
      runnable: '2026-10-30T10:00:00.050Z',
      lease_acquired: '2026-10-30T10:00:00.120Z', // +80ms from ack
      sandbox_create: '2026-10-30T10:00:00.130Z',
      sandbox_ready: '2026-10-30T10:00:00.200Z', // +70ms
      checkpoint_committed: '2026-10-30T10:00:00.300Z',
      task_terminal: '2026-10-30T10:00:00.350Z', // +350ms from request_received
    };

    const durations = computeStageDurations(timestamps);

    expect(durations.gateway_persist_ms).toBe(40);
    expect(durations.queue_wait_ms).toBe(70); // lease_acquired (120) - runnable (50) = 70ms
    expect(durations.fake_sandbox_ready_ms).toBe(70);
    expect(durations.task_wall_ms).toBe(350);
  });

  it('handles fast path where sandbox_create is null', () => {
    const timestamps = {
      request_received: '2026-10-30T10:00:00.000Z',
      durable_ack: '2026-10-30T10:00:00.030Z',
      first_real_event: '2026-10-30T10:00:00.040Z',
      runnable: '2026-10-30T10:00:00.040Z',
      lease_acquired: '2026-10-30T10:00:00.090Z',
      sandbox_create: null,
      sandbox_ready: null,
      checkpoint_committed: '2026-10-30T10:00:00.150Z',
      task_terminal: '2026-10-30T10:00:00.180Z',
    };

    const durations = computeStageDurations(timestamps);

    expect(durations.gateway_persist_ms).toBe(30);
    expect(durations.queue_wait_ms).toBe(50); // lease_acquired (90) - runnable (40) = 50ms
    expect(durations.fake_sandbox_ready_ms).toBeNull();
    expect(durations.task_wall_ms).toBe(180);
  });

  it('strictly returns null for queue_wait_ms when runnable or lease_acquired is missing', () => {
    // Missing runnable
    const withoutRunnable = computeStageDurations({
      request_received: '2026-10-30T10:00:00.000Z',
      durable_ack: '2026-10-30T10:00:00.050Z',
      first_real_event: '2026-10-30T10:00:00.060Z',
      runnable: null,
      lease_acquired: '2026-10-30T10:00:00.150Z',
      sandbox_create: null,
      sandbox_ready: null,
      checkpoint_committed: null,
      task_terminal: null,
    });
    expect(withoutRunnable.queue_wait_ms).toBeNull();

    // Missing lease_acquired
    const withoutLeaseAcquired = computeStageDurations({
      request_received: '2026-10-30T10:00:00.000Z',
      durable_ack: '2026-10-30T10:00:00.050Z',
      first_real_event: '2026-10-30T10:00:00.060Z',
      runnable: '2026-10-30T10:00:00.060Z',
      lease_acquired: null,
      sandbox_create: null,
      sandbox_ready: null,
      checkpoint_committed: null,
      task_terminal: null,
    });
    expect(withoutLeaseAcquired.queue_wait_ms).toBeNull();
  });

  it('measures queue_wait_ms accurately across retries or approval resumption using runnable', () => {
    // Initial task arrival: 10:00:00
    // After approval/retry backoff: runnable at 10:05:00
    // Worker claims task at: 10:05:00.035
    const retryTimestamps = {
      request_received: '2026-10-30T10:00:00.000Z',
      durable_ack: '2026-10-30T10:00:00.050Z',
      first_real_event: '2026-10-30T10:00:00.060Z',
      runnable: '2026-10-30T10:05:00.000Z', // 5 minutes later
      lease_acquired: '2026-10-30T10:05:00.035Z', // claimed in 35ms
      sandbox_create: null,
      sandbox_ready: null,
      checkpoint_committed: '2026-10-30T10:05:00.100Z',
      task_terminal: '2026-10-30T10:05:00.150Z',
    };

    const durations = computeStageDurations(retryTimestamps);
    // MUST measure from runnable (35ms), NOT from durable_ack (300,035ms)
    expect(durations.queue_wait_ms).toBe(35);
  });

  it('RunTraceCollector records milestones and compiles valid RunTraceRecord', () => {
    const collector = new RunTraceCollector({
      traceId: '0123456789abcdef0123456789abcdef',
      tenantId: randomUUID(),
      taskId: randomUUID(),
      runId: randomUUID(),
      path: 'standard',
      routeReason: 'mock.compute:sha256',
      attempt: 1,
      leaseEpoch: 1,
    });

    collector
      .recordStage('request_received', '2026-10-30T10:00:00.000Z')
      .recordStage('durable_ack', '2026-10-30T10:00:00.050Z')
      .recordStage('runnable', '2026-10-30T10:00:00.050Z')
      .recordStage('lease_acquired', '2026-10-30T10:00:00.150Z')
      .recordStage('sandbox_create', '2026-10-30T10:00:00.160Z')
      .recordStage('sandbox_ready', '2026-10-30T10:00:00.250Z')
      .recordStage('checkpoint_committed', '2026-10-30T10:00:00.300Z')
      .recordStage('task_terminal', '2026-10-30T10:00:00.350Z')
      .setOutcome({
        simulatedCpuMs: 15,
        simulatedUsageUnits: 1,
      });

    const record = collector.toRecord();

    expect(record.provider).toBe('fake');
    expect(record.cost_source).toBe('simulated');
    expect(record.actual_vendor_cost_usd).toBeNull();
    expect(record.gateway_persist_ms).toBe(50);
    expect(record.queue_wait_ms).toBe(100);
    expect(record.fake_sandbox_ready_ms).toBe(90);
    expect(record.task_wall_ms).toBe(350);
    expect(record.simulated_cpu_ms).toBe(15);
    expect(record.simulated_usage_units).toBe(1);

    expect(() => RunTraceRecordSchema.parse(record)).not.toThrow();
  });

  it('reconstructs RunTraceRecord across process boundaries from persisted timestamps', () => {
    const taskId = randomUUID();
    const runId = randomUUID();
    const traceId = '0123456789abcdef0123456789abcdef';
    const tenantId = randomUUID();

    const reconstructed = RunTraceCollector.reconstruct({
      traceId,
      tenantId,
      taskId,
      runId,
      path: 'fast',
      routeReason: 'mock.chat:fast',
      timestamps: {
        request_received: '2026-10-30T10:00:00.000Z',
        durable_ack: '2026-10-30T10:00:00.025Z',
        runnable: '2026-10-30T10:00:00.025Z',
        lease_acquired: '2026-10-30T10:00:00.060Z',
        task_terminal: '2026-10-30T10:00:00.120Z',
      },
      attempt: 1,
      retries: 0,
      leaseEpoch: 1,
    });

    expect(reconstructed.queue_wait_ms).toBe(35);
    expect(reconstructed.gateway_persist_ms).toBe(25);
    expect(reconstructed.fake_sandbox_ready_ms).toBeNull();
    expect(reconstructed.task_wall_ms).toBe(120);
    expect(() => RunTraceRecordSchema.parse(reconstructed)).not.toThrow();
  });
});
