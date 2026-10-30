import {
  DomainErrorCodeSchema,
  ExecutionPathSchema,
  IdSchema,
  IsoDateTimeSchema,
  RunStatusSchema,
  TaskKindSchema,
  TaskStatusSchema,
} from '@ember/contracts';
import { z } from 'zod';
import type {
  LowCardinalityMetricLabels,
  PercentileReport,
  RunStageDurations,
  RunStageTimestamps,
  RunTraceRecord,
  SimulatedUsageRecord,
  SpanKind,
  SpanRecord,
  SpanStatusCode,
} from './types.js';

const nonNegativeInteger = z.number().int().nonnegative();
const nonNegativeIntegerOrNull = nonNegativeInteger.nullable();
const isoDateTimeOrNull = IsoDateTimeSchema.nullable();

export const TelemetryTraceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'Trace ID must be a 32-character lowercase hexadecimal string');

export const TelemetrySpanIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, 'Span ID must be a 16-character lowercase hexadecimal string');

export const RunStageTimestampsSchema: z.ZodType<RunStageTimestamps> = z.strictObject({
  request_received: isoDateTimeOrNull,
  durable_ack: isoDateTimeOrNull,
  first_real_event: isoDateTimeOrNull,
  runnable: isoDateTimeOrNull,
  lease_acquired: isoDateTimeOrNull,
  sandbox_create: isoDateTimeOrNull,
  sandbox_ready: isoDateTimeOrNull,
  checkpoint_committed: isoDateTimeOrNull,
  task_terminal: isoDateTimeOrNull,
});

export const RunStageDurationsSchema: z.ZodType<RunStageDurations> = z.strictObject({
  queue_wait_ms: nonNegativeIntegerOrNull,
  gateway_persist_ms: nonNegativeIntegerOrNull,
  fake_sandbox_ready_ms: nonNegativeIntegerOrNull,
  task_wall_ms: nonNegativeIntegerOrNull,
});

/**
 * Strict schema for Section 10.1 Run Trace Record.
 * Guarantees provider=fake, cost_source=simulated, actual_vendor_cost_usd=null.
 */
export const RunTraceRecordSchema: z.ZodType<RunTraceRecord> = z.strictObject({
  trace_id: TelemetryTraceIdSchema,
  tenant_hash: z.string().length(16),
  task_id: IdSchema,
  run_id: IdSchema,
  path: ExecutionPathSchema,
  route_reason: z.string().min(1).max(256),
  provider: z.literal('fake'),
  attempt: z.number().int().positive(),
  retries: nonNegativeInteger,
  lease_epoch: z.number().int().positive(),
  error_code: DomainErrorCodeSchema.nullable(),
  cancellation_requested: z.boolean(),
  simulated_cpu_ms: nonNegativeInteger,
  simulated_usage_units: nonNegativeInteger,
  cost_source: z.literal('simulated'),
  actual_vendor_cost_usd: z.null(),
  scenario_id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .optional(),

  // Stage timestamps
  request_received: isoDateTimeOrNull,
  durable_ack: isoDateTimeOrNull,
  first_real_event: isoDateTimeOrNull,
  runnable: isoDateTimeOrNull,
  lease_acquired: isoDateTimeOrNull,
  sandbox_create: isoDateTimeOrNull,
  sandbox_ready: isoDateTimeOrNull,
  checkpoint_committed: isoDateTimeOrNull,
  task_terminal: isoDateTimeOrNull,

  // Stage durations
  queue_wait_ms: nonNegativeIntegerOrNull,
  gateway_persist_ms: nonNegativeIntegerOrNull,
  fake_sandbox_ready_ms: nonNegativeIntegerOrNull,
  task_wall_ms: nonNegativeIntegerOrNull,
});

/**
 * Strict schema for simulated usage records.
 */
export const SimulatedUsageRecordSchema: z.ZodType<SimulatedUsageRecord> = z.strictObject({
  usage_id: IdSchema,
  trace_id: TelemetryTraceIdSchema,
  tenant_hash: z.string().length(16),
  task_id: IdSchema,
  run_id: IdSchema,
  simulated_cpu_ms: nonNegativeInteger,
  simulated_usage_units: nonNegativeInteger,
  cost_source: z.literal('simulated'),
  actual_vendor_cost_usd: z.null(),
  recorded_at: IsoDateTimeSchema,
});

export const SpanKindSchema: z.ZodType<SpanKind> = z.enum([
  'INTERNAL',
  'SERVER',
  'CLIENT',
  'PRODUCER',
  'CONSUMER',
]);

export const SpanStatusCodeSchema: z.ZodType<SpanStatusCode> = z.enum(['UNSET', 'OK', 'ERROR']);

export const SpanStatusSchema = z.strictObject({
  code: SpanStatusCodeSchema,
  description: z.string().max(512).optional(),
});

const SpanAttributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
  z.array(z.boolean()),
]);

export const SpanAttributesSchema = z
  .record(z.string(), SpanAttributeValueSchema)
  .refine(
    (attrs) => !('tenantId' in attrs) && !('tenant_id' in attrs),
    'Raw tenantId / tenant_id must never appear in Span attributes; use tenant_hash instead',
  );

export const SpanEventSchema = z.strictObject({
  name: z.string().min(1).max(128),
  time: IsoDateTimeSchema,
  attributes: SpanAttributesSchema.optional(),
});

export const SpanRecordSchema: z.ZodType<SpanRecord> = z.strictObject({
  name: z.string().min(1).max(128),
  trace_id: TelemetryTraceIdSchema,
  span_id: TelemetrySpanIdSchema,
  parent_span_id: TelemetrySpanIdSchema.nullable(),
  kind: SpanKindSchema,
  start_time: IsoDateTimeSchema,
  end_time: IsoDateTimeSchema,
  duration_ms: nonNegativeInteger,
  status: SpanStatusSchema,
  attributes: SpanAttributesSchema,
  events: z.array(SpanEventSchema),
});

export const PercentileReportSchema: z.ZodType<PercentileReport> = z.strictObject({
  metric_name: z.string().min(1).max(64),
  sample_count: nonNegativeInteger,
  observed_count: nonNegativeInteger,
  missing_count: nonNegativeInteger,
  success_count: nonNegativeInteger,
  failed_count: nonNegativeInteger,
  timeout_count: nonNegativeInteger,
  cancelled_count: nonNegativeInteger,
  p50_ms: nonNegativeIntegerOrNull,
  p95_ms: nonNegativeIntegerOrNull,
  p99_ms: nonNegativeIntegerOrNull,
  min_ms: nonNegativeIntegerOrNull,
  max_ms: nonNegativeIntegerOrNull,
  avg_ms: nonNegativeIntegerOrNull,
});

export const LowCardinalityMetricLabelsSchema: z.ZodType<LowCardinalityMetricLabels> =
  z.strictObject({
    path: ExecutionPathSchema.optional(),
    provider: z.literal('fake').optional(),
    task_kind: TaskKindSchema.optional(),
    status: TaskStatusSchema.optional(),
    run_status: RunStatusSchema.optional(),
    error_code: z
      .union([DomainErrorCodeSchema, z.literal('NONE'), z.literal('UNEXPECTED')])
      .optional(),
    cost_source: z.literal('simulated').optional(),
    scenario_id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .optional(),
  });
