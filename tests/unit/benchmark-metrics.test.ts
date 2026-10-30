import { describe, expect, it } from 'vitest';
import {
  calculateDistribution,
  DeterministicPrng,
  parseTaskMix,
} from '../../apps/benchmark/src/metrics.js';
import { generateMarkdownReport } from '../../apps/benchmark/src/report.js';
import { runBenchmark } from '../../apps/benchmark/src/runner.js';
import type { BenchmarkResult } from '../../apps/benchmark/src/types.js';

describe('Benchmark Metrics & Math (Unit)', () => {
  it('DeterministicPrng produces reproducible uniform pseudo-random sequences', () => {
    const prng1 = new DeterministicPrng(42);
    const prng2 = new DeterministicPrng(42);

    const seq1 = Array.from({ length: 10 }, () => prng1.next());
    const seq2 = Array.from({ length: 10 }, () => prng2.next());

    expect(seq1).toEqual(seq2);
    expect(seq1.every((v) => v >= 0 && v < 1)).toBe(true);

    const ints = Array.from({ length: 20 }, () => prng1.nextInt(5, 15));
    expect(ints.every((v) => v >= 5 && v <= 15)).toBe(true);
  });

  it('calculateDistribution correctly computes percentiles and statistics', () => {
    const empty = calculateDistribution([]);
    expect(empty.count).toBe(0);
    expect(empty.p50Ms).toBe(0);

    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const dist = calculateDistribution(values);

    expect(dist.count).toBe(10);
    expect(dist.minMs).toBe(10);
    expect(dist.maxMs).toBe(100);
    expect(dist.meanMs).toBe(55);
    expect(dist.p50Ms).toBe(55);
    expect(dist.p90Ms).toBe(91);
    expect(dist.p95Ms).toBe(95.5);
    expect(dist.p99Ms).toBe(99.1);
  });

  it('parseTaskMix handles various string and object specifications', () => {
    expect(parseTaskMix('fast:70,standard:30')).toEqual({ fast: 0.7, standard: 0.3 });
    expect(parseTaskMix('50/50')).toEqual({ fast: 0.5, standard: 0.5 });
    expect(parseTaskMix('fast:100')).toEqual({ fast: 1, standard: 0 });
    expect(parseTaskMix('standard:100')).toEqual({ fast: 0, standard: 1 });
    expect(parseTaskMix({ fast: 80, standard: 20 })).toEqual({ fast: 0.8, standard: 0.2 });
    expect(parseTaskMix(undefined)).toEqual({ fast: 0.7, standard: 0.3 });

    expect(() => parseTaskMix('unknown:50')).toThrow(/unknown task kind/);
    expect(() => parseTaskMix('fast:-1')).toThrow(/invalid number/);
    expect(() => parseTaskMix('fast:Infinity')).toThrow(/invalid number/);
    expect(() => parseTaskMix({ fast: -1, standard: 2 })).toThrow(/invalid task mix/);
    expect(() => parseTaskMix({ fast: Infinity, standard: 1 })).toThrow(/invalid task mix/);
  });

  it('generateMarkdownReport produces valid markdown with DoD checks', () => {
    const mockResult: BenchmarkResult = {
      scenarioId: 'ember-p0b-09c-local-load',
      gitSha: 'test-sha-1234',
      timestamp: '2026-10-30T00:00:00.000Z',
      durationTotalMs: 12345,
      config: {
        agents: 1000,
        concurrency: 100,
        taskMix: { fast: 0.7, standard: 0.3 },
        warmup: 50,
        totalRequests: 1000,
        durationMs: null,
        seed: 42,
        outDir: 'benchmarks/results',
        databaseUrl: 'postgres://localhost/test',
        isolatedSchema: true,
        keepDb: false,
        enableLocalLoad: true,
        workerConcurrency: 100,
      },
      machine: {
        osPlatform: 'darwin',
        osRelease: '24.0.0',
        osType: 'Darwin',
        osVersion: 'Darwin Kernel',
        cpuModel: 'Apple M3',
        cpuCores: 8,
        totalMemoryBytes: 16 * 1024 * 1024 * 1024,
        totalMemoryGb: 16,
        nodeVersion: 'v24.11.0',
        postgresVersion: 'PostgreSQL 17.0',
      },
      agentProvisioning: {
        requestedCount: 1000,
        createdCount: 1000,
        durationMs: 2500,
        throughputPerSec: 400,
        p50CreationLatencyMs: 2.1,
        p95CreationLatencyMs: 4.5,
        p99CreationLatencyMs: 8.2,
        verifiedDbAgentCount: 1000,
        verifiedDbWorkspaceCount: 1000,
        residentProcessesCount: 0,
        residentSandboxesCount: 0,
      },
      reconciliation: {
        totalSubmitted: 1000,
        totalAcked: 1000,
        succeededCount: 1000,
        failedCount: 0,
        timedOutCount: 0,
        lostCount: 0,
        persistedTaskCount: 1000,
        missingPersistedTaskCount: 0,
        duplicateAckCount: 0,
        successRatePercent: 100,
        hasUnexplainedTaskLoss: false,
      },
      latencyMetrics: {
        durableAck: {
          count: 1000,
          minMs: 5,
          meanMs: 25,
          p50Ms: 22,
          p90Ms: 45,
          p95Ms: 58,
          p99Ms: 85,
          maxMs: 120,
          stdDevMs: 12,
        },
        firstRealEvent: {
          count: 1000,
          minMs: 8,
          meanMs: 30,
          p50Ms: 28,
          p90Ms: 55,
          p95Ms: 70,
          p99Ms: 95,
          maxMs: 140,
          stdDevMs: 15,
        },
        queueWait: {
          count: 1000,
          minMs: 2,
          meanMs: 8,
          p50Ms: 7,
          p90Ms: 15,
          p95Ms: 20,
          p99Ms: 35,
          maxMs: 50,
          stdDevMs: 5,
        },
        taskCompletion: {
          count: 1000,
          minMs: 12,
          meanMs: 45,
          p50Ms: 40,
          p90Ms: 75,
          p95Ms: 90,
          p99Ms: 125,
          maxMs: 180,
          stdDevMs: 20,
        },
      },
      telemetry: {
        cpuUserMs: 1500,
        cpuSystemMs: 800,
        cpuPercent: 35.5,
        peakRssBytes: 150 * 1024 * 1024,
        peakRssMb: 150,
        peakHeapUsedMb: 65,
        peakHeapTotalMb: 95,
        peakPostgresActiveConnections: 18,
        peakPostgresTotalConnections: 45,
        targetWorkerConcurrency: 100,
        peakInFlightRuns: 28,
        peakLiveSandboxes: 8,
        idleLiveSandboxes: 0,
        costAccounting: {
          costSource: 'simulated',
          totalSimulatedCpuMs: 1000,
          totalSimulatedUnits: 8000,
          actualVendorCostUsd: null,
        },
      },
      targetAssessment: {
        durableAckP95TargetMs: 1000,
        durableAckP95ObservedMs: 58,
        durableAckTargetMet: true,
        zeroResidentSandboxesMet: true,
        zeroTaskLossMet: true,
      },
    };

    const md = generateMarkdownReport(mockResult);
    expect(md).toContain('# Ember P0B-09C: Local Load Benchmark Report');
    expect(md).toContain('B-T28: 1,000 Logical Agents');
    expect(md).toContain('B-T29: 100 Concurrency (Local)');
    expect(md).toContain('cost_source: simulated');
    expect(md).toContain('Durable Ack Performance Target Met');
  });

  it('runner rejects invalid benchmark counts before allocating resources', async () => {
    await expect(runBenchmark({ agents: -1, enableLocalLoad: true })).rejects.toThrow(
      /invalid agents/,
    );
    await expect(runBenchmark({ concurrency: 101, enableLocalLoad: true })).rejects.toThrow(
      /invalid concurrency/,
    );
    await expect(runBenchmark({ warmup: -1, enableLocalLoad: true })).rejects.toThrow(
      /invalid warmup/,
    );
  });

  it('runner enforces safety guard when heavy load is requested without explicit enablement', async () => {
    await expect(
      runBenchmark({
        agents: 100,
        concurrency: 50,
        enableLocalLoad: false,
      }),
    ).rejects.toThrow(/Safety guard/);
  });
});
