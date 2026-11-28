import {
  B1SendMessageRequestSchema,
  B3StagedUploadMediaTypeSchema,
  IdSchema,
  NotesActionItemsInputSchema,
  PYTHON_AGENT_LIMITS,
  TaskTitleSchema,
  WebEvidenceSchema,
  toInvalidArgumentError,
} from '@ember/contracts';
import { z } from 'zod';
import {
  BUDGET_SYNC_INCIDENT_REASONS,
  BUDGET_SYNC_PAYLOAD_SCHEMA_VERSION,
  BUDGET_SYNC_SETTLEMENT_STATES,
  ORDINARY_OUTBOX_ENTITY_KINDS,
  V2_DISPATCH_ENVELOPE_SCHEMA_VERSION,
  V2_QUEUE_NAMES,
} from '../recovery/envelope.js';
import { MAX_FENCE_EPOCH } from '../recovery/schema.js';
import type {
  CommitTurnRequest,
  HandoffTurnRequest,
  MarkAttemptSentRequest,
  ObservedTurnUsage,
  PrepareTurnRequest,
  RenewTurnLeaseRequest,
} from './agent-head-rpc.js';
import { V2_BUDGET_LIMITS } from './constants.js';
import {
  personalMemoryDeleteTurnCommandSchema,
  personalMemorySaveTurnCommandSchema,
} from './personal-memory.js';
import { proactiveScheduleTurnCommandSchema } from './proactive-schedules.js';
import type {
  GlobalBudgetAuthorizeSendRequest,
  GlobalBudgetRenewGrantRequest,
  GlobalBudgetReserveRequest,
  GlobalBudgetSettleRequest,
} from './global-budget.js';

const SafeNonNegIntSchema = z.number().int().min(0).max(MAX_FENCE_EPOCH);
const NonEmptyBoundedStringSchema = z.string().min(1).max(256);
const UtcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const PositiveSafeIntSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const TurnExecutionModeSchema = z.enum(['fast_interactive', 'durable_queue', 'device']);

export const BudgetSyncOutboxPayloadSchema = z.strictObject({
  schemaVersion: z.literal(BUDGET_SYNC_PAYLOAD_SCHEMA_VERSION),
  tenantId: NonEmptyBoundedStringSchema,
  principalId: NonEmptyBoundedStringSchema,
  agentId: NonEmptyBoundedStringSchema,
  utcDay: UtcDaySchema,
  globalGrantId: NonEmptyBoundedStringSchema,
  operationId: NonEmptyBoundedStringSchema,
  settlementRevision: SafeNonNegIntSchema,
  state: z.enum(BUDGET_SYNC_SETTLEMENT_STATES),
  reservedMicroUsd: z.number().int().min(0).max(V2_BUDGET_LIMITS.perAttemptMicroUsd),
  chargeMicroUsd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  observedCostMicroUsd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  overageMicroUsd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  openIncidentReason: z.enum(BUDGET_SYNC_INCIDENT_REASONS).nullable(),
});

export const V2DispatchEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(V2_DISPATCH_ENVELOPE_SCHEMA_VERSION),
  eventId: NonEmptyBoundedStringSchema,
  tenantId: NonEmptyBoundedStringSchema,
  agentId: NonEmptyBoundedStringSchema,
  entityKind: z.enum(ORDINARY_OUTBOX_ENTITY_KINDS),
  entityId: NonEmptyBoundedStringSchema,
  queueName: z.enum(V2_QUEUE_NAMES),
  fenceEpoch: SafeNonNegIntSchema,
});

export const GlobalBudgetReserveRequestSchema = z.strictObject({
  tenantId: IdSchema,
  principalId: IdSchema,
  agentId: IdSchema,
  operationId: IdSchema,
  leaseEpoch: SafeNonNegIntSchema,
  utcDay: UtcDaySchema,
  amountMicroUsd: z.number().int().min(1).max(V2_BUDGET_LIMITS.perAttemptMicroUsd),
  ceilingMicroUsd: z.number().int().min(0).max(V2_BUDGET_LIMITS.globalDailyMicroUsd),
  expiresAtMs: PositiveSafeIntSchema,
});

export const GlobalBudgetAuthorizeSendRequestSchema = z.strictObject({
  tenantId: IdSchema,
  operationId: IdSchema,
  globalGrantId: NonEmptyBoundedStringSchema,
});

export const GlobalBudgetRenewGrantRequestSchema = z.strictObject({
  tenantId: IdSchema,
  operationId: IdSchema,
  globalGrantId: NonEmptyBoundedStringSchema,
  newExpiresAtMs: PositiveSafeIntSchema,
});

export const GlobalBudgetSettleRequestSchema = z
  .strictObject({
    tenantId: IdSchema,
    operationId: IdSchema,
    settlementRevision: SafeNonNegIntSchema,
    globalGrantId: NonEmptyBoundedStringSchema,
    state: z.enum(BUDGET_SYNC_SETTLEMENT_STATES),
    observedCostMicroUsd: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
    chargeMicroUsd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    reservedMicroUsd: z.number().int().min(0).max(V2_BUDGET_LIMITS.perAttemptMicroUsd),
    openIncidentReason: z.enum(BUDGET_SYNC_INCIDENT_REASONS).optional(),
  })
  .refine((v) => v.state !== 'released' || v.chargeMicroUsd === 0, {
    message: 'released settlement must carry chargeMicroUsd=0',
    path: ['chargeMicroUsd'],
  })
  .refine(
    (v) =>
      v.state !== 'settled' ||
      (v.observedCostMicroUsd !== null && v.observedCostMicroUsd !== undefined),
    { message: 'settled state requires observedCostMicroUsd', path: ['observedCostMicroUsd'] },
  );

export const AgentHeadCallerScopeSchema = z.strictObject({
  tenantId: IdSchema,
  principalId: IdSchema,
  agentId: IdSchema,
  policyVersion: z.number().int().nonnegative(),
  requestId: IdSchema,
});

export const AgentHeadTenantScopeSchema = z.strictObject({
  tenantId: IdSchema,
  agentId: IdSchema,
});

const ObservedTurnUsageSchema = z.strictObject({
  scope: AgentHeadTenantScopeSchema,
  turnId: IdSchema,
  attemptNo: z.number().int().min(1).max(V2_BUDGET_LIMITS.maxAttemptsPerTurn),
  operationId: IdSchema,
  observedCostMicroUsd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

export const ModelReservationInputSchema = z.strictObject({
  budgetMode: z.enum(['disabled_echo_only', 'simulated_full_protocol', 'real']),
  providerId: z.enum(['fake', 'openai', 'openrouter']),
  modelLabel: z.string().min(1).max(120),
  rateVersion: z.string().min(1).max(128),
  maxAttempts: z.number().int().min(1).max(V2_BUDGET_LIMITS.maxAttemptsPerTurn),
  estimatedMicroUsd: z.number().int().min(0).max(V2_BUDGET_LIMITS.perAttemptMicroUsd),
});

export const ResolvedMessageAttachmentSchema = z.strictObject({
  uploadId: IdSchema,
  filename: z.string().min(1).max(PYTHON_AGENT_LIMITS.maxFilenameChars),
  mediaType: B3StagedUploadMediaTypeSchema,
  sizeBytes: z.number().int().min(0).max(PYTHON_AGENT_LIMITS.maxFileBytes),
  r2Key: z.string().min(1).max(512),
  sha256: Sha256HexSchema,
});

export const PrepareTurnRequestSchema = z.strictObject({
  scope: AgentHeadCallerScopeSchema,
  conversationId: IdSchema,
  request: B1SendMessageRequestSchema,
  workerId: z.string().min(1).max(128),
  leaseMs: PositiveSafeIntSchema,
  interactiveDeadlineMs: PositiveSafeIntSchema,
  turnDeadlineMs: PositiveSafeIntSchema,
  executionMode: TurnExecutionModeSchema,
  modelReservation: ModelReservationInputSchema.optional(),
  resolvedAttachments: z
    .array(ResolvedMessageAttachmentSchema)
    .max(PYTHON_AGENT_LIMITS.maxAttachmentsPerMessage)
    .optional(),
});

export const MarkAttemptSentRequestSchema = z.strictObject({
  scope: AgentHeadTenantScopeSchema,
  subjectType: z.enum(['turn', 'task']),
  subjectId: IdSchema,
  attemptNo: z.number().int().min(1).max(6),
  operationId: IdSchema,
  leaseEpoch: SafeNonNegIntSchema,
  leaseOwner: z.string().min(1).max(128),
});

export const RenewTurnLeaseRequestSchema = z.strictObject({
  scope: AgentHeadTenantScopeSchema,
  conversationId: IdSchema,
  turnId: IdSchema,
  leaseEpoch: SafeNonNegIntSchema,
  leaseOwner: z.string().min(1).max(128),
  extendMs: PositiveSafeIntSchema,
});

export const HandoffTurnRequestSchema = z.strictObject({
  scope: AgentHeadTenantScopeSchema,
  conversationId: IdSchema,
  turnId: IdSchema,
  leaseEpoch: SafeNonNegIntSchema,
  leaseOwner: z.string().min(1).max(128),
  reason: z.enum([
    'interactive_deadline_120s',
    'client_disconnect_handoff',
    'tool_delegation',
    'waituntil_window_handoff',
  ]),
  providerJobHandle: z.string().min(1).max(256).optional(),
  checkpointRef: z.string().min(1).max(512).optional(),
});

const DelegationCommandSchema = z.discriminatedUnion('toolName', [
  z.strictObject({
    toolName: z.literal('delegate_notes_action_items'),
    title: TaskTitleSchema.optional(),
    input: NotesActionItemsInputSchema,
  }),
  z.strictObject({
    toolName: z.literal('delegate_python_agent'),
    title: TaskTitleSchema.optional(),
    input: z.strictObject({
      prompt: z.string().trim().min(1).max(PYTHON_AGENT_LIMITS.promptMaxChars),
      instructions: z
        .string()
        .trim()
        .min(1)
        .max(PYTHON_AGENT_LIMITS.instructionsMaxChars)
        .optional(),
      attachmentIds: z.array(IdSchema).max(PYTHON_AGENT_LIMITS.maxAttachmentsPerMessage).optional(),
    }),
  }),
]);

const TurnSettlementSchema = z
  .strictObject({
    state: z.enum(BUDGET_SYNC_SETTLEMENT_STATES),
    outcomeCode: z.enum([
      'ok',
      'model_timeout',
      'model_unavailable',
      'model_rate_limited',
      'model_auth_failed',
      'model_invalid_output',
      'client_cancelled',
      'not_sent',
      'usage_missing',
    ]),
    observedCostMicroUsd: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
    inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  })
  .refine(
    (v) =>
      v.state !== 'settled' ||
      (v.observedCostMicroUsd !== null && v.observedCostMicroUsd !== undefined),
    { message: 'settled requires observedCostMicroUsd', path: ['observedCostMicroUsd'] },
  )
  .refine(
    (v) =>
      v.state !== 'conservative_billed' ||
      v.observedCostMicroUsd === null ||
      v.observedCostMicroUsd === undefined,
    { message: 'conservative_billed must not carry observedCostMicroUsd', path: ['state'] },
  );

const TurnCommitResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'),
    text: z.string().min(1).max(8_192),
    modelLabel: z.string().min(1).max(120),
    simulated: z.boolean(),
    delegation: DelegationCommandSchema.optional(),
    personalMemorySave: personalMemorySaveTurnCommandSchema.optional(),
    personalMemoryDelete: personalMemoryDeleteTurnCommandSchema.optional(),
    proactiveScheduleCreate: proactiveScheduleTurnCommandSchema.optional(),
    webEvidence: WebEvidenceSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('failed'),
    failureReason: z.enum(['timeout', 'internal_error']),
  }),
  z.strictObject({
    status: z.literal('aborted_for_retry_or_reconcile'),
  }),
]);

export const CommitTurnRequestSchema = z.strictObject({
  scope: AgentHeadTenantScopeSchema,
  conversationId: IdSchema,
  turnId: IdSchema,
  leaseEpoch: SafeNonNegIntSchema,
  leaseOwner: z.string().min(1).max(128),
  attemptNo: z.number().int().min(1).max(6),
  operationId: IdSchema,
  settlement: TurnSettlementSchema,
  result: TurnCommitResultSchema,
});

export const DurableTurnOutcomeSchema = z.strictObject({
  attemptNo: z.number().int().min(1).max(6),
  operationId: IdSchema,
  settlement: TurnSettlementSchema,
  status: z.enum(['completed', 'failed', 'aborted_for_retry_or_reconcile']),
  text: z.string().min(1).max(8_192).optional(),
  modelLabel: z.string().min(1).max(120).optional(),
  simulated: z.boolean().optional(),
  delegation: DelegationCommandSchema.optional(),
  personalMemorySave: personalMemorySaveTurnCommandSchema.optional(),
  personalMemoryDelete: personalMemoryDeleteTurnCommandSchema.optional(),
  proactiveScheduleCreate: proactiveScheduleTurnCommandSchema.optional(),
  webEvidence: WebEvidenceSchema.optional(),
  failureReason: z.enum(['timeout', 'internal_error']).optional(),
});

export type DurableTurnOutcome = z.infer<typeof DurableTurnOutcomeSchema>;

export const DurableTaskOutcomeSchema = z
  .strictObject({
    status: z.enum(['completed', 'failed']).optional(),
    summaryText: z.string().max(4_096).nullable().optional(),
    detailText: z.string().max(32_768).nullable().optional(),
    modelLabel: z.string().min(1).max(120).optional(),
    simulated: z.boolean().optional(),
    truncated: z.boolean().optional(),
    reasonCode: z.string().min(1).max(128).optional(),
    attemptNo: z.number().int().min(1).max(6).optional(),
    operationId: IdSchema.optional(),
    settlement: TurnSettlementSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const count =
      (v.attemptNo !== undefined ? 1 : 0) +
      (v.operationId !== undefined ? 1 : 0) +
      (v.settlement !== undefined ? 1 : 0);
    if (count > 0 && count < 3) {
      ctx.addIssue({
        code: 'custom',
        message: 'attemptNo, operationId, and settlement must all be supplied together',
      });
    }
  });

export type DurableTaskOutcome = z.infer<typeof DurableTaskOutcomeSchema>;

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }
  return parsed.data;
}

export function parseDurableTurnOutcome(input: unknown): DurableTurnOutcome | null {
  const parsed = DurableTurnOutcomeSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }
  if (
    parsed.data.status === 'completed' &&
    (parsed.data.text === undefined || parsed.data.text.length === 0)
  ) {
    return null;
  }
  return parsed.data;
}

export function parseDurableTaskOutcome(input: unknown): DurableTaskOutcome | null {
  const parsed = DurableTaskOutcomeSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parsePrepareTurnRequest(input: unknown): PrepareTurnRequest {
  return parseOrThrow(PrepareTurnRequestSchema, input);
}

export function parseObservedTurnUsage(input: unknown): ObservedTurnUsage {
  return parseOrThrow(ObservedTurnUsageSchema, input);
}

export function parseMarkAttemptSentRequest(input: unknown): MarkAttemptSentRequest {
  return parseOrThrow(MarkAttemptSentRequestSchema, input);
}

export function parseRenewTurnLeaseRequest(input: unknown): RenewTurnLeaseRequest {
  return parseOrThrow(RenewTurnLeaseRequestSchema, input);
}

export function parseHandoffTurnRequest(input: unknown): HandoffTurnRequest {
  return parseOrThrow(HandoffTurnRequestSchema, input);
}

export function parseCommitTurnRequest(input: unknown): CommitTurnRequest {
  return parseOrThrow(CommitTurnRequestSchema, input);
}

export function parseGlobalBudgetReserveRequest(input: unknown): GlobalBudgetReserveRequest {
  return parseOrThrow(GlobalBudgetReserveRequestSchema, input);
}

export function parseGlobalBudgetAuthorizeSendRequest(
  input: unknown,
): GlobalBudgetAuthorizeSendRequest {
  return parseOrThrow(GlobalBudgetAuthorizeSendRequestSchema, input);
}

export function parseGlobalBudgetRenewGrantRequest(input: unknown): GlobalBudgetRenewGrantRequest {
  return parseOrThrow(GlobalBudgetRenewGrantRequestSchema, input);
}

export function parseGlobalBudgetSettleRequest(input: unknown): GlobalBudgetSettleRequest {
  return parseOrThrow(GlobalBudgetSettleRequestSchema, input);
}
