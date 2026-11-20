import { z } from 'zod';
import { MAX_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS } from '../recovery/cron-tz.js';
import type { MisfirePolicy, ScheduleKind, ScheduleStatus } from '../recovery/schema.js';
import type { AgentHeadCallerScope } from './agent-head-rpc.js';

export const PROACTIVE_SCHEDULE_KINDS = ['reminder', 'brief', 'follow_up'] as const;
export type ProactiveScheduleKind = (typeof PROACTIVE_SCHEDULE_KINDS)[number];
export const proactiveScheduleKindSchema = z.enum(PROACTIVE_SCHEDULE_KINDS);

export const PROACTIVE_DELIVERY_MODES = ['direct_reminder', 'model_brief'] as const;
export type ProactiveDeliveryMode = (typeof PROACTIVE_DELIVERY_MODES)[number];
export const proactiveDeliveryModeSchema = z.enum(PROACTIVE_DELIVERY_MODES);

export const PROACTIVE_MISFIRE_POLICIES = ['coalesce_latest', 'fire_once', 'skip_missed'] as const;
export const proactiveMisfirePolicySchema = z.enum(PROACTIVE_MISFIRE_POLICIES);

export const PROACTIVE_TASK_DEADLINE_MS = 300_000;
export const PROACTIVE_SCHEDULER_MODEL_LABEL = 'ember-proactive-scheduler';
export const PROACTIVE_RECENT_RUNS_LIMIT = 10;

export const proactiveScheduleIdSchema = z.uuid().transform((id) => id.toLowerCase());

const isoDateTimeSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), 'must be a valid ISO-8601 timestamp');

export const proactiveScheduleTriggerSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('once'),
    fireAt: isoDateTimeSchema,
  }),
  z.strictObject({
    type: z.literal('interval'),
    intervalSeconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS),
    firstFireAt: isoDateTimeSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('cron'),
    cronExpr: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1).max(100),
  }),
]);
export type ProactiveScheduleTrigger = z.infer<typeof proactiveScheduleTriggerSchema>;

export const proactiveScheduleCreateSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(128),
  kind: proactiveScheduleKindSchema,
  title: z.string().trim().min(1).max(140),
  prompt: z.string().trim().min(1).max(2_000),
  trigger: proactiveScheduleTriggerSchema,
  timezone: z.string().trim().min(1).max(100).optional(),
  misfirePolicy: proactiveMisfirePolicySchema.optional(),
  deliveryMode: proactiveDeliveryModeSchema.optional(),
});
export type ProactiveScheduleCreateInput = z.infer<typeof proactiveScheduleCreateSchema>;

export type ProactiveScheduleCommand = Omit<AgentHeadCallerScope, 'policyVersion'> &
  (
    | { readonly kind: 'create'; readonly input: ProactiveScheduleCreateInput }
    | { readonly kind: 'list' }
    | { readonly kind: 'get'; readonly scheduleId: string }
    | { readonly kind: 'pause'; readonly scheduleId: string }
    | { readonly kind: 'resume'; readonly scheduleId: string }
    | { readonly kind: 'cancel'; readonly scheduleId: string }
  );

export interface ProactiveScheduleRunSnapshot {
  readonly occurrenceSeq: number;
  readonly taskId: string;
  readonly status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'retryable_failed'
    | 'waiting_approval';
  readonly summaryText: string | null;
  readonly detailText: string | null;
  readonly reasonCode: string | null;
  readonly resultMessageId: string | null;
  readonly scheduledFor: string;
  readonly completedAt: string | null;
}

export interface ProactiveScheduleSnapshot {
  readonly scheduleId: string;
  readonly kind: ProactiveScheduleKind;
  readonly title: string;
  readonly prompt: string;
  readonly deliveryMode: ProactiveDeliveryMode;
  readonly status: ScheduleStatus;
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds: number | null;
  readonly cronExpr: string | null;
  readonly timezone: string;
  readonly misfirePolicy: MisfirePolicy;
  readonly nextFireAt: string | null;
  readonly lastFiredAt: string | null;
  readonly occurrenceCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestRun: ProactiveScheduleRunSnapshot | null;
  readonly replayed?: boolean;
}

export interface ProactiveScheduleDetail extends ProactiveScheduleSnapshot {
  readonly recentRuns: readonly ProactiveScheduleRunSnapshot[];
}

export interface ProactiveScheduleList {
  readonly schedules: readonly ProactiveScheduleSnapshot[];
}

export type ProactiveScheduleResponse =
  ProactiveScheduleSnapshot | ProactiveScheduleDetail | ProactiveScheduleList;

export interface ProactiveScheduleRpc {
  proactiveSchedule(command: ProactiveScheduleCommand): Promise<ProactiveScheduleResponse>;
}

export interface ProactiveScheduleTaskPayload {
  readonly scheduleId: string;
  readonly occurrenceSeq: number;
  readonly principalId: string;
  readonly kind: ProactiveScheduleKind;
  readonly title: string;
  readonly prompt: string;
  readonly deliveryMode: ProactiveDeliveryMode;
  readonly timezone: string;
  readonly scheduledForMs: number;
}

const proactiveScheduleTaskPayloadSchema = z.strictObject({
  scheduleId: z.string().min(1),
  occurrenceSeq: z.number().int().positive(),
  principalId: z.string().min(1),
  kind: proactiveScheduleKindSchema,
  title: z.string().min(1),
  prompt: z.string().min(1),
  deliveryMode: proactiveDeliveryModeSchema,
  timezone: z.string().min(1),
  scheduledForMs: z.number().int().nonnegative(),
});

export function parseProactiveScheduleTaskInput(
  inputJson: string | undefined,
): ProactiveScheduleTaskPayload | null {
  if (inputJson === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || !('proactiveSchedule' in parsed)) {
    return null;
  }
  const result = proactiveScheduleTaskPayloadSchema.safeParse(
    (parsed as { readonly proactiveSchedule?: unknown }).proactiveSchedule,
  );
  return result.success ? result.data : null;
}
