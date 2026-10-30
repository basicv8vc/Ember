import type { Id, TaskKind } from '@ember/domain';

/**
 * Task mix proportions for the benchmark.
 * Proportions must be positive and will be normalized to sum to 1.0.
 */
export interface TaskMix {
  readonly fast: number;
  readonly standard: number;
}

/**
 * CLI and programmatic options for the local load benchmark.
 */
export interface BenchmarkOptions {
  /**
   * Number of persistent logical Agents to create in PostgreSQL (default: 1000).
   * Note: Agents are database records with version-0 workspaces, NOT OS processes or VMs.
   */
  readonly agents?: number;

  /**
   * Maximum concurrent HTTP requests in flight (default: 100).
   */
  readonly concurrency?: number;

  /**
   * Distribution of task kinds (default: { fast: 0.7, standard: 0.3 }).
   */
  readonly taskMix?: TaskMix;

  /**
   * Number of warmup requests to prime HTTP connections and JIT (default: 50).
   */
  readonly warmup?: number;

  /**
   * Total number of benchmark requests to execute (e.g. 1000).
   * Mutually exclusive with durationMs if durationMs is specified, or durationMs takes precedence.
   */
  readonly totalRequests?: number;

  /**
   * Maximum benchmark execution duration in milliseconds (e.g. 30_000 for 30s).
   */
  readonly durationMs?: number;

  /**
   * Deterministic PRNG seed for reproducible agent selection and task generation (default: 42).
   */
  readonly seed?: number;

  /**
   * Directory where JSON and Markdown benchmark reports will be written (default: 'benchmarks/results').
   */
  readonly outDir?: string;

  /**
   * Database URL for PostgreSQL. Defaults to TEST_DATABASE_URL or DATABASE_URL from environment.
   */
  readonly databaseUrl?: string;

  /**
   * Whether to run the benchmark inside a dedicated, uniquely-named isolated PostgreSQL schema.
   * Default: true.
   */
  readonly isolatedSchema?: boolean;

  /**
   * Whether to keep the isolated test schema after benchmark completion for diagnostics.
   * Default: false (dropped CASCADE on cleanup).
   */
  readonly keepDb?: boolean;

  /**
   * Explicit enablement flag required for heavy load tests (>50 agents or >20 concurrency).
   * Safety guard preventing unintended resource exhaustion on shared CI runners.
   */
  readonly enableLocalLoad?: boolean;

  /**
   * Number of concurrent execution slots in the local worker (default: 100).
   */
  readonly workerConcurrency?: number;

  /**
   * Optional external API URL to run against an already-running Ember API instance.
   * If omitted, the benchmark boots an ephemeral isolated in-process HTTP listener.
   */
  readonly apiUrl?: string;

  /**
   * Optional logger function. Default logs to stdout/stderr.
   */
  readonly log?: (message: string) => void;
}

/**
 * Resolved, validated benchmark configuration.
 */
export interface ResolvedBenchmarkConfig {
  readonly agents: number;
  readonly concurrency: number;
  readonly taskMix: TaskMix;
  readonly warmup: number;
  readonly totalRequests: number;
  readonly durationMs: number | null;
  readonly seed: number;
  readonly outDir: string;
  readonly databaseUrl: string;
  readonly isolatedSchema: boolean;
  readonly keepDb: boolean;
  readonly enableLocalLoad: boolean;
  readonly workerConcurrency: number;
  readonly apiUrl?: string;
}

/**
 * Detailed trace record for each executed benchmark task (matching Task Spec §10.1).
 */
export interface TaskSample {
  readonly sampleId: number;
  readonly taskId: Id;
  readonly agentId: Id;
  readonly kind: TaskKind;
  readonly routePath: 'fast' | 'standard';
  readonly requestSentAtHr: number;
  readonly durableAckAtHr: number;
  readonly durableAckLatencyMs: number;
  readonly firstRealEventAtHr: number | null;
  readonly firstRealEventLatencyMs: number | null;
  readonly queueWaitMs: number | null;
  readonly taskTerminalAtHr: number | null;
  readonly taskCompletionLatencyMs: number | null;
  readonly status: 'succeeded' | 'failed' | 'timed_out';
  readonly httpStatus: number;
  readonly errorMessage?: string;
  readonly simulatedCpuMs: number;
  readonly simulatedUsageUnits: number;
}

/**
 * Percentile distribution and summary statistics for a latency metric.
 */
export interface LatencyDistribution {
  readonly count: number;
  readonly minMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly stdDevMs: number;
}

/**
 * Latency metrics for all four core lifecycle intervals.
 */
export interface LatencyMetrics {
  /** Time from HTTP request dispatched until 202 Accepted response received (DB committed). */
  readonly durableAck: LatencyDistribution;
  /** Time from HTTP request dispatched until first real execution event after acceptance. */
  readonly firstRealEvent: LatencyDistribution;
  /** Time from task durable acceptance until worker lease acquired / execution started. */
  readonly queueWait: LatencyDistribution;
  /** Time from HTTP request dispatched until terminal status (completed/failed) reached. */
  readonly taskCompletion: LatencyDistribution;
}

/**
 * Machine and platform specifications for reproducibility.
 */
export interface MachineSpecs {
  readonly osPlatform: string;
  readonly osRelease: string;
  readonly osType: string;
  readonly osVersion: string;
  readonly cpuModel: string;
  readonly cpuCores: number;
  readonly totalMemoryBytes: number;
  readonly totalMemoryGb: number;
  readonly nodeVersion: string;
  readonly postgresVersion: string;
}

/**
 * Resource utilization and telemetry observed during the benchmark.
 */
export interface SystemTelemetry {
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly cpuPercent: number;
  readonly peakRssBytes: number;
  readonly peakRssMb: number;
  readonly peakHeapUsedMb: number;
  readonly peakHeapTotalMb: number;
  readonly peakPostgresActiveConnections: number;
  readonly peakPostgresTotalConnections: number;
  readonly targetWorkerConcurrency: number;
  readonly peakInFlightRuns: number;
  readonly peakLiveSandboxes: number;
  readonly idleLiveSandboxes: number;
  readonly costAccounting: {
    readonly costSource: 'simulated';
    readonly totalSimulatedCpuMs: number;
    readonly totalSimulatedUnits: number;
    readonly actualVendorCostUsd: null;
  };
}

/**
 * Agent provisioning metrics.
 */
export interface AgentProvisioningMetrics {
  readonly requestedCount: number;
  readonly createdCount: number;
  readonly durationMs: number;
  readonly throughputPerSec: number;
  readonly p50CreationLatencyMs: number;
  readonly p95CreationLatencyMs: number;
  readonly p99CreationLatencyMs: number;
  readonly verifiedDbAgentCount: number;
  readonly verifiedDbWorkspaceCount: number;
  readonly residentProcessesCount: 0;
  readonly residentSandboxesCount: 0;
}

/**
 * Task accounting and reconciliation report.
 */
export interface ReconciliationReport {
  readonly totalSubmitted: number;
  readonly totalAcked: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly timedOutCount: number;
  readonly lostCount: number;
  readonly successRatePercent: number;
  readonly hasUnexplainedTaskLoss: boolean;
}

/**
 * Target evaluation assessment.
 */
export interface TargetAssessment {
  readonly durableAckP95TargetMs: 1000;
  readonly durableAckP95ObservedMs: number;
  readonly durableAckTargetMet: boolean;
  readonly bottleneckAnalysis?: string;
  readonly zeroResidentSandboxesMet: boolean;
  readonly zeroTaskLossMet: boolean;
}

/**
 * Complete, serializable benchmark result report.
 */
export interface BenchmarkResult {
  readonly scenarioId: 'ember-p0b-09c-local-load';
  readonly gitSha: string;
  readonly timestamp: string;
  readonly config: ResolvedBenchmarkConfig;
  readonly machine: MachineSpecs;
  readonly agentProvisioning: AgentProvisioningMetrics;
  readonly reconciliation: ReconciliationReport;
  readonly latencyMetrics: LatencyMetrics;
  readonly telemetry: SystemTelemetry;
  readonly targetAssessment: TargetAssessment;
  readonly durationTotalMs: number;
}
