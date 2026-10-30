import { DomainError } from '@ember/domain';
import { LowCardinalityMetricLabelsSchema, PercentileReportSchema } from './schemas.js';
import type {
  LowCardinalityMetricLabels,
  PercentileReport,
  RunTraceRecord,
  StageDurationKey,
} from './types.js';

/**
 * Calculates a specific percentile from a collection of numeric samples.
 * Uses linear interpolation (R7 method) and rounds to nearest millisecond integer.
 */
export function calculatePercentile(values: readonly number[], percentile: number): number | null {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
    throw new DomainError('INVALID_ARGUMENT', 'percentile must be a finite number in [0, 100]');
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new DomainError('INVALID_ARGUMENT', 'latency samples must be finite and non-negative');
  }
  if (values.length === 0) {
    return null;
  }
  if (values.length === 1) {
    return values[0]!;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) {
    return sorted[lower]!;
  }

  return Math.round(sorted[lower]! * (1 - weight) + sorted[upper]! * weight);
}

/**
 * Aggregates samples into a PercentileReport conforming to Section 10 DoD.
 * Retains sample count, success, failure, timeout, and cancellation counts.
 */
export function buildPercentileReport(
  metricName: string,
  samples: readonly number[],
  counts: {
    sampleCount: number;
    successCount: number;
    failedCount: number;
    timeoutCount: number;
    cancelledCount: number;
  },
): PercentileReport {
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted.length > 0 ? sorted[0]! : null;
  const max = sorted.length > 0 ? sorted[sorted.length - 1]! : null;
  const avg =
    sorted.length > 0
      ? Math.round(sorted.reduce((acc, curr) => acc + curr, 0) / sorted.length)
      : null;

  const report: PercentileReport = {
    metric_name: metricName,
    sample_count: counts.sampleCount,
    observed_count: sorted.length,
    missing_count: Math.max(0, counts.sampleCount - sorted.length),
    success_count: counts.successCount,
    failed_count: counts.failedCount,
    timeout_count: counts.timeoutCount,
    cancelled_count: counts.cancelledCount,
    p50_ms: calculatePercentile(sorted, 50),
    p95_ms: calculatePercentile(sorted, 95),
    p99_ms: calculatePercentile(sorted, 99),
    min_ms: min,
    max_ms: max,
    avg_ms: avg,
  };

  return PercentileReportSchema.parse(report);
}

/**
 * In-memory accumulator for Run trace stage metrics.
 */
export class MetricsAggregator {
  private readonly records: RunTraceRecord[] = [];

  recordRun(trace: RunTraceRecord): void {
    this.records.push(trace);
  }

  getReport(metricKey: StageDurationKey): PercentileReport {
    const samples: number[] = [];
    let successCount = 0;
    let failedCount = 0;
    let timeoutCount = 0;
    let cancelledCount = 0;

    for (const record of this.records) {
      const value = record[metricKey];
      if (value !== null && value !== undefined) {
        samples.push(value);
      }

      const err = record.error_code;
      if (err === null) {
        successCount++;
      } else if (err === 'CANCELLED') {
        cancelledCount++;
      } else if (err === 'EXECUTION_TIMEOUT' || err === 'DEADLINE_EXCEEDED') {
        timeoutCount++;
        failedCount++;
      } else {
        failedCount++;
      }
    }

    return buildPercentileReport(metricKey, samples, {
      sampleCount: this.records.length,
      successCount,
      failedCount,
      timeoutCount,
      cancelledCount,
    });
  }

  getAllReports(): Record<StageDurationKey, PercentileReport> {
    return {
      queue_wait_ms: this.getReport('queue_wait_ms'),
      gateway_persist_ms: this.getReport('gateway_persist_ms'),
      fake_sandbox_ready_ms: this.getReport('fake_sandbox_ready_ms'),
      task_wall_ms: this.getReport('task_wall_ms'),
    };
  }

  clear(): void {
    this.records.length = 0;
  }
}

/**
 * Validates metric labels against closed, low-cardinality schemas.
 * Refuses high-cardinality IDs (UUID, Task ID, Token, Prompt) from polluting metric indexes.
 */
export function validateLowCardinalityLabels(
  labels: Record<string, unknown>,
): LowCardinalityMetricLabels {
  const parsed = LowCardinalityMetricLabelsSchema.safeParse(labels);
  if (!parsed.success) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `Metric labels violated low-cardinality policy: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
