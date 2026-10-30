import { DomainError, type DomainErrorCode, type ExecutionPath, type Id } from '@ember/domain';
import { createTenantHash } from './privacy.js';
import { RunTraceRecordSchema } from './schemas.js';
import type {
  RunStageDurations,
  RunStageTimestamps,
  RunTraceRecord,
  StageTimestampKey,
} from './types.js';

export function durationBetweenMs(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) {
    return null;
  }
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  return Math.max(0, end - start);
}

/**
 * Computes the 4 required stage durations from recorded timestamps:
 * 1. queue_wait_ms: from runnable to lease_acquired (strictly null if either timestamp is missing)
 * 2. gateway_persist_ms: from request_received to durable_ack
 * 3. fake_sandbox_ready_ms: from sandbox_create to sandbox_ready
 * 4. task_wall_ms: from request_received to task_terminal
 */
export function computeStageDurations(timestamps: RunStageTimestamps): RunStageDurations {
  // P0-B Section 10 DoD: queue_wait_ms = lease_acquired - runnable.
  // Missing either timestamp explicitly returns null (unmeasured state).
  const queue_wait_ms = durationBetweenMs(timestamps.runnable, timestamps.lease_acquired);

  const gateway_persist_ms = durationBetweenMs(timestamps.request_received, timestamps.durable_ack);

  const fake_sandbox_ready_ms = durationBetweenMs(
    timestamps.sandbox_create,
    timestamps.sandbox_ready,
  );

  const task_wall_ms = durationBetweenMs(timestamps.request_received, timestamps.task_terminal);

  return {
    queue_wait_ms,
    gateway_persist_ms,
    fake_sandbox_ready_ms,
    task_wall_ms,
  };
}

export interface RunTraceCollectorOptions {
  readonly traceId: string;
  readonly tenantId?: string;
  readonly tenantHash?: string;
  readonly taskId?: Id;
  readonly runId?: Id;
  readonly path: ExecutionPath;
  readonly routeReason: string;
  readonly attempt?: number;
  readonly retries?: number;
  readonly leaseEpoch?: number;
  readonly scenarioId?: string;
}

/**
 * Collects stage timestamps and compiles a validated RunTraceRecord.
 */
export class RunTraceCollector {
  readonly traceId: string;
  readonly tenantHash: string;
  private taskId: Id | null;
  private runId: Id | null;
  readonly path: ExecutionPath;
  readonly routeReason: string;
  private attempt: number;
  private retries: number;
  private leaseEpoch: number;
  private errorCode: DomainErrorCode | null = null;
  private cancellationRequested = false;
  private simulatedCpuMs = 0;
  private simulatedUsageUnits = 0;
  private readonly scenarioId?: string;

  private readonly timestamps: Record<StageTimestampKey, string | null> = {
    request_received: null,
    durable_ack: null,
    first_real_event: null,
    runnable: null,
    lease_acquired: null,
    sandbox_create: null,
    sandbox_ready: null,
    checkpoint_committed: null,
    task_terminal: null,
  };

  constructor(options: RunTraceCollectorOptions) {
    this.traceId = options.traceId.replace(/-/g, '').toLowerCase();
    this.tenantHash =
      options.tenantHash ?? (options.tenantId ? createTenantHash(options.tenantId) : undefined)!;

    if (!this.tenantHash) {
      throw new DomainError('INVALID_ARGUMENT', 'tenantId or tenantHash is required');
    }

    this.taskId = options.taskId ?? null;
    this.runId = options.runId ?? null;
    this.path = options.path;
    this.routeReason = options.routeReason;
    this.attempt = options.attempt ?? 1;
    this.retries = options.retries ?? 0;
    this.leaseEpoch = options.leaseEpoch ?? 1;
    this.scenarioId = options.scenarioId;
  }

  setRunContext(taskId: Id, runId: Id): this {
    this.taskId = taskId;
    this.runId = runId;
    return this;
  }

  recordStage(stage: StageTimestampKey, at?: Date | string): this {
    const iso = at instanceof Date ? at.toISOString() : (at ?? new Date().toISOString());
    this.timestamps[stage] = iso;
    return this;
  }

  setOutcome(outcome: {
    errorCode?: DomainErrorCode | null;
    cancellationRequested?: boolean;
    attempt?: number;
    retries?: number;
    leaseEpoch?: number;
    simulatedCpuMs?: number;
    simulatedUsageUnits?: number;
  }): this {
    if (outcome.errorCode !== undefined) {
      this.errorCode = outcome.errorCode;
    }
    if (outcome.cancellationRequested !== undefined) {
      this.cancellationRequested = outcome.cancellationRequested;
    }
    if (outcome.attempt !== undefined) {
      this.attempt = outcome.attempt;
    }
    if (outcome.retries !== undefined) {
      this.retries = outcome.retries;
    }
    if (outcome.leaseEpoch !== undefined) {
      this.leaseEpoch = outcome.leaseEpoch;
    }
    if (outcome.simulatedCpuMs !== undefined) {
      this.simulatedCpuMs = Math.max(0, Math.floor(outcome.simulatedCpuMs));
    }
    if (outcome.simulatedUsageUnits !== undefined) {
      this.simulatedUsageUnits = Math.max(0, Math.floor(outcome.simulatedUsageUnits));
    }
    return this;
  }

  toRecord(): RunTraceRecord {
    if (!this.taskId || !this.runId) {
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        'taskId and runId must be set before generating a trace record',
      );
    }

    const durations = computeStageDurations(this.timestamps);

    const candidate: RunTraceRecord = {
      trace_id: this.traceId,
      tenant_hash: this.tenantHash,
      task_id: this.taskId,
      run_id: this.runId,
      path: this.path,
      route_reason: this.routeReason,
      provider: 'fake',
      attempt: this.attempt,
      retries: this.retries,
      lease_epoch: this.leaseEpoch,
      error_code: this.errorCode,
      cancellation_requested: this.cancellationRequested,
      simulated_cpu_ms: this.simulatedCpuMs,
      simulated_usage_units: this.simulatedUsageUnits,
      cost_source: 'simulated',
      actual_vendor_cost_usd: null,
      scenario_id: this.scenarioId,

      request_received: this.timestamps.request_received,
      durable_ack: this.timestamps.durable_ack,
      first_real_event: this.timestamps.first_real_event,
      runnable: this.timestamps.runnable,
      lease_acquired: this.timestamps.lease_acquired,
      sandbox_create: this.timestamps.sandbox_create,
      sandbox_ready: this.timestamps.sandbox_ready,
      checkpoint_committed: this.timestamps.checkpoint_committed,
      task_terminal: this.timestamps.task_terminal,

      queue_wait_ms: durations.queue_wait_ms,
      gateway_persist_ms: durations.gateway_persist_ms,
      fake_sandbox_ready_ms: durations.fake_sandbox_ready_ms,
      task_wall_ms: durations.task_wall_ms,
    };

    return RunTraceRecordSchema.parse(candidate);
  }

  /**
   * Reconstructs a full RunTraceRecord from persisted task, run, and event timestamps.
   * Useful for independent worker processes or recovery loops operating across process boundaries.
   */
  static reconstruct(params: {
    traceId: string;
    tenantHash?: string;
    tenantId?: string;
    taskId: Id;
    runId: Id;
    path: ExecutionPath;
    routeReason: string;
    timestamps: Partial<Record<StageTimestampKey, string | Date | null>>;
    attempt?: number;
    retries?: number;
    leaseEpoch?: number;
    errorCode?: DomainErrorCode | null;
    cancellationRequested?: boolean;
    simulatedCpuMs?: number;
    simulatedUsageUnits?: number;
    scenarioId?: string;
  }): RunTraceRecord {
    const collector = new RunTraceCollector({
      traceId: params.traceId,
      tenantHash: params.tenantHash,
      tenantId: params.tenantId,
      taskId: params.taskId,
      runId: params.runId,
      path: params.path,
      routeReason: params.routeReason,
      attempt: params.attempt,
      retries: params.retries,
      leaseEpoch: params.leaseEpoch,
      scenarioId: params.scenarioId,
    });

    for (const [stage, at] of Object.entries(params.timestamps)) {
      if (at !== null && at !== undefined) {
        collector.recordStage(stage as StageTimestampKey, at);
      }
    }

    collector.setOutcome({
      errorCode: params.errorCode,
      cancellationRequested: params.cancellationRequested,
      attempt: params.attempt,
      retries: params.retries,
      leaseEpoch: params.leaseEpoch,
      simulatedCpuMs: params.simulatedCpuMs,
      simulatedUsageUnits: params.simulatedUsageUnits,
    });

    return collector.toRecord();
  }
}
