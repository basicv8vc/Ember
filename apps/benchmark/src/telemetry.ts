import os from 'node:os';
import type { MachineSpecs, SystemTelemetry } from './types.js';

export interface QueryablePool {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly R[] }>;
}

export interface TelemetryCollectorOptions {
  readonly pool?: QueryablePool;
  readonly sampleIntervalMs?: number;
  readonly targetWorkerConcurrency?: number;
}

/**
 * Periodically samples process resources and PostgreSQL connection counts,
 * and tracks worker concurrency and FakeSandbox live instances.
 */
export class TelemetryCollector {
  private pool?: QueryablePool;
  private postgresSampleCount = 0;
  private readonly sampleIntervalMs: number;
  private readonly targetWorkerConcurrency: number;

  private timer?: NodeJS.Timeout;
  private startTimeHr: number = 0;
  private startCpuUsage?: NodeJS.CpuUsage;

  private peakRssBytes: number = 0;
  private peakHeapUsedBytes: number = 0;
  private peakHeapTotalBytes: number = 0;

  private peakPostgresActive: number = 0;
  private peakPostgresTotal: number = 0;

  private currentInFlightRuns: number = 0;
  private peakInFlightRuns: number = 0;

  private currentLiveSandboxes: number = 0;
  private peakLiveSandboxes: number = 0;

  private totalSimulatedCpuMs: number = 0;
  private totalSimulatedUnits: number = 0;

  constructor(options: TelemetryCollectorOptions = {}) {
    this.pool = options.pool;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 100;
    this.targetWorkerConcurrency = options.targetWorkerConcurrency ?? 100;
  }

  /** Attach the local PostgreSQL admin pool after the harness starts. */
  attachPool(pool: QueryablePool): void {
    this.pool = pool;
  }

  /**
   * Start the periodic telemetry sampler.
   */
  start(): void {
    this.startTimeHr = performance.now();
    this.startCpuUsage = process.cpuUsage();
    this.sampleProcessMemory();
    void this.sample();

    this.timer = setInterval(() => {
      void this.sample();
    }, this.sampleIntervalMs);
    this.timer.unref();
  }

  /**
   * Stop the periodic telemetry sampler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.sampleProcessMemory();
  }

  /**
   * Record task worker in-flight concurrency changes.
   */
  recordWorkerInFlight(current: number): void {
    this.currentInFlightRuns = current;
    if (current > this.peakInFlightRuns) {
      this.peakInFlightRuns = current;
    }
  }

  /**
   * Record FakeSandbox live count changes.
   */
  recordLiveSandboxes(current: number): void {
    this.currentLiveSandboxes = current;
    if (current > this.peakLiveSandboxes) {
      this.peakLiveSandboxes = current;
    }
  }

  /**
   * Accumulate simulated cost units.
   */
  addSimulatedUsage(cpuMs: number, units: number): void {
    this.totalSimulatedCpuMs += cpuMs;
    this.totalSimulatedUnits += units;
  }

  private sampleProcessMemory(): void {
    const mem = process.memoryUsage();
    if (mem.rss > this.peakRssBytes) {
      this.peakRssBytes = mem.rss;
    }
    if (mem.heapUsed > this.peakHeapUsedBytes) {
      this.peakHeapUsedBytes = mem.heapUsed;
    }
    if (mem.heapTotal > this.peakHeapTotalBytes) {
      this.peakHeapTotalBytes = mem.heapTotal;
    }
  }

  private async sample(): Promise<void> {
    this.sampleProcessMemory();

    if (this.pool) {
      try {
        const res = await this.pool.query<{ active: string; total: string }>(`
          SELECT
            count(*) FILTER (WHERE state = 'active')::text AS active,
            count(*)::text AS total
          FROM pg_stat_activity
          WHERE datname = current_database()
        `);
        const row = res.rows[0];
        if (row) {
          this.postgresSampleCount++;
          const active = parseInt(row.active, 10) || 0;
          const total = parseInt(row.total, 10) || 0;
          if (active > this.peakPostgresActive) {
            this.peakPostgresActive = active;
          }
          if (total > this.peakPostgresTotal) {
            this.peakPostgresTotal = total;
          }
        }
      } catch {
        // Ignore sampling query failures during shutdown or race
      }
    }
  }

  /**
   * Generate final system telemetry snapshot.
   */
  getSummary(): SystemTelemetry {
    const elapsedMs = Math.max(1, performance.now() - this.startTimeHr);
    const endCpuUsage = process.cpuUsage(this.startCpuUsage);
    const userMs = endCpuUsage.user / 1000;
    const systemMs = endCpuUsage.system / 1000;
    const totalCpuMs = userMs + systemMs;
    const numCores = os.cpus().length || 1;
    const cpuPercent = Number(((totalCpuMs / elapsedMs / numCores) * 100).toFixed(1));

    return {
      cpuUserMs: Math.round(userMs),
      cpuSystemMs: Math.round(systemMs),
      cpuPercent,
      peakRssBytes: this.peakRssBytes,
      peakRssMb: Number((this.peakRssBytes / (1024 * 1024)).toFixed(1)),
      peakHeapUsedMb: Number((this.peakHeapUsedBytes / (1024 * 1024)).toFixed(1)),
      peakHeapTotalMb: Number((this.peakHeapTotalBytes / (1024 * 1024)).toFixed(1)),
      peakPostgresActiveConnections: this.peakPostgresActive,
      peakPostgresTotalConnections: this.peakPostgresTotal,
      postgresSampleCount: this.postgresSampleCount,
      targetWorkerConcurrency: this.targetWorkerConcurrency,
      peakInFlightRuns: this.peakInFlightRuns,
      peakLiveSandboxes: this.peakLiveSandboxes,
      idleLiveSandboxes: this.currentLiveSandboxes,
      costAccounting: {
        costSource: 'simulated',
        totalSimulatedCpuMs: this.totalSimulatedCpuMs,
        totalSimulatedUnits: this.totalSimulatedUnits,
        actualVendorCostUsd: null,
      },
    };
  }
}

/**
 * Collect machine and runtime platform specifications.
 */
export async function collectMachineSpecs(pool?: QueryablePool): Promise<MachineSpecs> {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? 'unknown';
  const cpuCores = cpus.length;
  const totalMemoryBytes = os.totalmem();
  const totalMemoryGb = Number((totalMemoryBytes / (1024 * 1024 * 1024)).toFixed(2));

  let postgresVersion = 'unknown';
  if (pool) {
    try {
      const res = await pool.query<{ version: string }>('SELECT version() AS version');
      postgresVersion = res.rows[0]?.version ?? 'unknown';
    } catch {
      postgresVersion = 'unavailable';
    }
  }

  return {
    osPlatform: os.platform(),
    osRelease: os.release(),
    osType: os.type(),
    osVersion: os.version(),
    cpuModel,
    cpuCores,
    totalMemoryBytes,
    totalMemoryGb,
    nodeVersion: process.version,
    postgresVersion,
  };
}
