import { randomUUID } from 'node:crypto';
import { isDomainError } from '@ember/domain';
import { describe, expect, it } from 'vitest';
import {
  calculatePercentile,
  MetricsAggregator,
  PercentileReportSchema,
  validateLowCardinalityLabels,
  type RunTraceRecord,
} from '@ember/telemetry';

function mockTrace(overrides: Partial<RunTraceRecord> = {}): RunTraceRecord {
  return {
    trace_id: '0123456789abcdef0123456789abcdef',
    tenant_hash: '0123456789abcdef',
    task_id: randomUUID(),
    run_id: randomUUID(),
    path: 'standard',
    route_reason: 'mock.compute:sha256',
    provider: 'fake',
    attempt: 1,
    retries: 0,
    lease_epoch: 1,
    error_code: null,
    cancellation_requested: false,
    simulated_cpu_ms: 10,
    simulated_usage_units: 1,
    cost_source: 'simulated',
    actual_vendor_cost_usd: null,

    request_received: '2026-10-30T00:00:00.000Z',
    durable_ack: '2026-10-30T00:00:00.050Z',
    first_real_event: '2026-10-30T00:00:00.060Z',
    runnable: '2026-10-30T00:00:00.060Z',
    lease_acquired: '2026-10-30T00:00:00.150Z',
    sandbox_create: '2026-10-30T00:00:00.160Z',
    sandbox_ready: '2026-10-30T00:00:00.260Z',
    checkpoint_committed: '2026-10-30T00:00:00.350Z',
    task_terminal: '2026-10-30T00:00:00.400Z',

    queue_wait_ms: 100,
    gateway_persist_ms: 50,
    fake_sandbox_ready_ms: 100,
    task_wall_ms: 400,

    ...overrides,
  };
}

describe('telemetry metrics and quantile aggregation', () => {
  describe('calculatePercentile', () => {
    it('returns null for empty samples', () => {
      expect(calculatePercentile([], 50)).toBeNull();
      expect(calculatePercentile([], 95)).toBeNull();
      expect(calculatePercentile([], 99)).toBeNull();
    });

    it('returns single sample value regardless of percentile', () => {
      expect(calculatePercentile([42], 50)).toBe(42);
      expect(calculatePercentile([42], 95)).toBe(42);
      expect(calculatePercentile([42], 99)).toBe(42);
    });

    it('computes exact P50/P95/P99 for evenly distributed samples', () => {
      // 101 samples: 0, 1, 2, ..., 100
      const samples = Array.from({ length: 101 }, (_, i) => i);

      expect(calculatePercentile(samples, 50)).toBe(50);
      expect(calculatePercentile(samples, 95)).toBe(95);
      expect(calculatePercentile(samples, 99)).toBe(99);
    });

    it('interpolates intermediate percentiles accurately', () => {
      const samples = [10, 20, 30, 40, 50];
      expect(calculatePercentile(samples, 50)).toBe(30);
      expect(calculatePercentile(samples, 25)).toBe(20);
      expect(calculatePercentile(samples, 75)).toBe(40);
    });
  });

  describe('MetricsAggregator', () => {
    it('aggregates runs and calculates all stage duration percentiles with counts', () => {
      const aggregator = new MetricsAggregator();

      // Record 10 successful runs with varying latencies
      for (let i = 1; i <= 10; i++) {
        aggregator.recordRun(
          mockTrace({
            queue_wait_ms: i * 10,
            gateway_persist_ms: i * 5,
            fake_sandbox_ready_ms: i * 8,
            task_wall_ms: i * 50,
          }),
        );
      }

      // Record 1 failure, 1 timeout, 1 cancellation
      aggregator.recordRun(
        mockTrace({
          error_code: 'MOCK_TOOL_FAILED',
          queue_wait_ms: 150,
          gateway_persist_ms: 60,
          task_wall_ms: 600,
        }),
      );
      aggregator.recordRun(
        mockTrace({
          error_code: 'EXECUTION_TIMEOUT',
          queue_wait_ms: 200,
          gateway_persist_ms: 70,
          task_wall_ms: 1000,
        }),
      );
      aggregator.recordRun(
        mockTrace({
          error_code: 'CANCELLED',
          queue_wait_ms: 50,
          gateway_persist_ms: 30,
          task_wall_ms: 200,
        }),
      );

      const report = aggregator.getReport('queue_wait_ms');

      expect(report.metric_name).toBe('queue_wait_ms');
      expect(report.sample_count).toBe(13);
      expect(report.success_count).toBe(10);
      expect(report.failed_count).toBe(2); // MOCK_TOOL_FAILED + EXECUTION_TIMEOUT
      expect(report.timeout_count).toBe(1); // EXECUTION_TIMEOUT
      expect(report.cancelled_count).toBe(1); // CANCELLED

      expect(report.p50_ms).toBeGreaterThan(0);
      expect(report.p95_ms).toBeGreaterThan(report.p50_ms!);
      expect(report.p99_ms).toBeGreaterThanOrEqual(report.p95_ms!);
      expect(report.min_ms).toBe(10);
      expect(report.max_ms).toBe(200);

      expect(() => PercentileReportSchema.parse(report)).not.toThrow();
    });

    it('getAllReports provides summary for all four required stage durations', () => {
      const aggregator = new MetricsAggregator();
      aggregator.recordRun(mockTrace());

      const all = aggregator.getAllReports();
      expect(all).toHaveProperty('queue_wait_ms');
      expect(all).toHaveProperty('gateway_persist_ms');
      expect(all).toHaveProperty('fake_sandbox_ready_ms');
      expect(all).toHaveProperty('task_wall_ms');

      expect(all.queue_wait_ms.sample_count).toBe(1);
      expect(all.queue_wait_ms.p50_ms).toBe(100);
      expect(all.gateway_persist_ms.p50_ms).toBe(50);
      expect(all.fake_sandbox_ready_ms.p50_ms).toBe(100);
      expect(all.task_wall_ms.p50_ms).toBe(400);
    });
  });

  describe('validateLowCardinalityLabels', () => {
    it('accepts safe enumerated metric label sets', () => {
      const labels = {
        path: 'fast',
        provider: 'fake',
        task_kind: 'mock.chat',
        status: 'completed',
        error_code: 'NONE',
        cost_source: 'simulated',
      };

      const validated = validateLowCardinalityLabels(labels);
      expect(validated.path).toBe('fast');
      expect(validated.provider).toBe('fake');
    });

    it('refuses arbitrary high-cardinality label keys and values', () => {
      try {
        validateLowCardinalityLabels({
          taskId: randomUUID(), // Forbidden high-cardinality ID
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isDomainError(err)).toBe(true);
        if (isDomainError(err)) {
          expect(err.code).toBe('INVALID_ARGUMENT');
          expect(err.diagnostic).toMatch(/low-cardinality/);
        }
      }

      try {
        validateLowCardinalityLabels({
          path: 'invalid-path',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isDomainError(err)).toBe(true);
        if (isDomainError(err)) {
          expect(err.code).toBe('INVALID_ARGUMENT');
          expect(err.diagnostic).toMatch(/low-cardinality/);
        }
      }
    });
  });
});
