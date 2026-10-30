import type {
  DomainErrorCode,
  ExecutionPath,
  Id,
  TaskKind,
  TaskStatus,
  RunStatus,
} from '@ember/domain';

export type StageTimestampKey =
  | 'request_received'
  | 'durable_ack'
  | 'first_real_event'
  | 'runnable'
  | 'lease_acquired'
  | 'sandbox_create'
  | 'sandbox_ready'
  | 'checkpoint_committed'
  | 'task_terminal';

export const STAGE_TIMESTAMP_KEYS = [
  'request_received',
  'durable_ack',
  'first_real_event',
  'runnable',
  'lease_acquired',
  'sandbox_create',
  'sandbox_ready',
  'checkpoint_committed',
  'task_terminal',
] as const satisfies readonly StageTimestampKey[];

export type StageDurationKey =
  'queue_wait_ms' | 'gateway_persist_ms' | 'fake_sandbox_ready_ms' | 'task_wall_ms';

export const STAGE_DURATION_KEYS = [
  'queue_wait_ms',
  'gateway_persist_ms',
  'fake_sandbox_ready_ms',
  'task_wall_ms',
] as const satisfies readonly StageDurationKey[];

/**
 * Stage timestamps recorded during the lifecycle of a task and run.
 * All timestamps are RFC 3339 / ISO 8601 UTC strings, or null if the stage was not applicable
 * (for example `sandbox_create` on Fast Path).
 */
export interface RunStageTimestamps {
  readonly request_received: string | null;
  readonly durable_ack: string | null;
  readonly first_real_event: string | null;
  readonly runnable: string | null;
  readonly lease_acquired: string | null;
  readonly sandbox_create: string | null;
  readonly sandbox_ready: string | null;
  readonly checkpoint_committed: string | null;
  readonly task_terminal: string | null;
}

/**
 * Calculated latencies for stages.
 * Values are non-negative safe integers in milliseconds, or null if unreached or not applicable.
 */
export interface RunStageDurations {
  readonly queue_wait_ms: number | null;
  readonly gateway_persist_ms: number | null;
  readonly fake_sandbox_ready_ms: number | null;
  readonly task_wall_ms: number | null;
}

/**
 * Canonical Run Trace Record conforming to RFC v0.2 and P0-B Task Spec Section 10.1.
 */
export interface RunTraceRecord extends RunStageTimestamps, RunStageDurations {
  readonly trace_id: string;
  readonly tenant_hash: string;
  readonly task_id: Id;
  readonly run_id: Id;
  readonly path: ExecutionPath;
  readonly route_reason: string;
  readonly provider: 'fake';
  readonly attempt: number;
  readonly retries: number;
  readonly lease_epoch: number;
  readonly error_code: DomainErrorCode | null;
  readonly cancellation_requested: boolean;
  readonly simulated_cpu_ms: number;
  readonly simulated_usage_units: number;
  readonly cost_source: 'simulated';
  readonly actual_vendor_cost_usd: null;
  readonly scenario_id?: string;
}

/**
 * Simulated usage record for a Run or Step.
 * Strictly annotated with cost_source="simulated" and actual_vendor_cost_usd=null.
 */
export interface SimulatedUsageRecord {
  readonly usage_id: string;
  readonly trace_id: string;
  readonly tenant_hash: string;
  readonly task_id: Id;
  readonly run_id: Id;
  readonly simulated_cpu_ms: number;
  readonly simulated_usage_units: number;
  readonly cost_source: 'simulated';
  readonly actual_vendor_cost_usd: null;
  readonly recorded_at: string;
}

/**
 * OpenTelemetry-style Span Kind.
 */
export type SpanKind = 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';

/**
 * OpenTelemetry-style Status Code.
 */
export type SpanStatusCode = 'UNSET' | 'OK' | 'ERROR';

export interface SpanStatus {
  readonly code: SpanStatusCode;
  readonly description?: string;
}

export type SpanAttributeValue =
  string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

export interface SpanEvent {
  readonly name: string;
  readonly time: string;
  readonly attributes?: SpanAttributes;
}

/**
 * Serialized representation of an OpenTelemetry-compatible Span.
 */
export interface SpanRecord {
  readonly name: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly kind: SpanKind;
  readonly start_time: string;
  readonly end_time: string;
  readonly duration_ms: number;
  readonly status: SpanStatus;
  readonly attributes: SpanAttributes;
  readonly events: readonly SpanEvent[];
}

/**
 * Summary distribution report including percentiles, counts, and failure tracking.
 * Strictly implements the DoD requirement: "保留样本量及失败/超时数".
 */
export interface PercentileReport {
  readonly metric_name: string;
  readonly sample_count: number;
  readonly success_count: number;
  readonly failed_count: number;
  readonly timeout_count: number;
  readonly cancelled_count: number;
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly p99_ms: number | null;
  readonly min_ms: number | null;
  readonly max_ms: number | null;
  readonly avg_ms: number | null;
}

/**
 * Allowlisted low-cardinality metric label dimensions.
 * Any other label key or high-cardinality values (e.g. UUIDs, raw prompts) are rejected.
 */
export interface LowCardinalityMetricLabels {
  readonly path?: ExecutionPath;
  readonly provider?: 'fake';
  readonly task_kind?: TaskKind;
  readonly status?: TaskStatus;
  readonly run_status?: RunStatus;
  readonly error_code?: DomainErrorCode | 'NONE' | 'UNEXPECTED';
  readonly cost_source?: 'simulated';
  readonly scenario_id?: string;
}

/**
 * Structured log level.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured JSON log line shape.
 */
export interface StructuredLogRecord {
  readonly level: LogLevel;
  readonly time: string;
  readonly service: string;
  readonly message: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly tenant_hash?: string;
  readonly [key: string]: unknown;
}
