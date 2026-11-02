import type { AuthContext, Id } from '@ember/domain';
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from './task-schemas.js';

/**
 * Closed vocabulary for durable commitment lifecycle.
 */
export const COMMITMENT_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];
export const CommitmentStatusSchema = z.enum(COMMITMENT_STATUSES);

export const SCHEDULE_KINDS = ['once', 'interval'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export const ScheduleKindSchema = z.enum(SCHEDULE_KINDS);

export const OCCURRENCE_STATUSES = [
  'pending',
  'dispatched',
  'completed',
  'failed',
  'cancelled',
] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];
export const OccurrenceStatusSchema = z.enum(OCCURRENCE_STATUSES);

export const OUTCOME_RESULT_STATUSES = [
  'meaningful_change',
  'no_change',
  'failed',
  'denied',
] as const;
export type OutcomeResultStatus = (typeof OUTCOME_RESULT_STATUSES)[number];
export const OutcomeResultStatusSchema = z.enum(OUTCOME_RESULT_STATUSES);

export const COMMITMENT_TITLE_LIMITS = Object.freeze({
  minChars: 1,
  maxChars: 140,
});

export const COMMITMENT_INTERVAL_LIMITS = Object.freeze({
  minSeconds: 900,
  maxSeconds: 2_592_000,
});

export const SOURCE_PROFILE_ID_REGEX = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export const SOURCE_SNAPSHOT_LIMITS = Object.freeze({
  profileIdMinChars: 3,
  profileIdMaxChars: 64,
  itemIdMaxChars: 128,
  itemTitleMaxChars: 256,
  itemContentSnippetMaxChars: 1_000,
  maxItems: 50,
  maxPayloadBytes: 32_768, // 32 KiB frozen ceiling
});

export const OUTCOME_SUMMARY_LIMITS = Object.freeze({
  minChars: 1,
  maxChars: 2_000,
});

export const SourceProfileIdSchema = z
  .string()
  .min(SOURCE_SNAPSHOT_LIMITS.profileIdMinChars)
  .max(SOURCE_SNAPSHOT_LIMITS.profileIdMaxChars)
  .regex(SOURCE_PROFILE_ID_REGEX, 'source_profile_id must match ^[a-z0-9][a-z0-9._-]{2,63}$');

export type SourceProfileId = z.infer<typeof SourceProfileIdSchema>;

export interface SourceSnapshotItem {
  readonly id: string;
  readonly title: string;
  readonly contentSnippet: string;
  readonly observedAt: string;
}

export const SourceSnapshotItemSchema: z.ZodType<SourceSnapshotItem> = z.strictObject({
  id: z.string().min(1).max(SOURCE_SNAPSHOT_LIMITS.itemIdMaxChars),
  title: z.string().min(1).max(SOURCE_SNAPSHOT_LIMITS.itemTitleMaxChars),
  contentSnippet: z.string().max(SOURCE_SNAPSHOT_LIMITS.itemContentSnippetMaxChars),
  observedAt: IsoDateTimeSchema,
});

export interface SourceSnapshot {
  readonly sourceProfileId: SourceProfileId;
  readonly observedAt: string;
  readonly digest: string;
  readonly boundedSafeItems: readonly SourceSnapshotItem[];
}

export const SourceSnapshotSchema: z.ZodType<SourceSnapshot> = z.strictObject({
  sourceProfileId: SourceProfileIdSchema,
  observedAt: IsoDateTimeSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/, 'digest must be a 64-char hex sha256'),
  boundedSafeItems: z.array(SourceSnapshotItemSchema).max(SOURCE_SNAPSHOT_LIMITS.maxItems),
});

/**
 * Public commitment representation (wire format in snake_case).
 */
export interface CommitmentDto {
  readonly commitment_id: Id;
  readonly tenant_id: Id;
  readonly agent_id: Id;
  readonly title: string;
  readonly status: CommitmentStatus;
  readonly schedule_kind: ScheduleKind;
  readonly interval_seconds: number | null;
  readonly next_due_at: string | null;
  readonly source_profile_id: SourceProfileId;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export const CommitmentDtoSchema: z.ZodType<CommitmentDto> = z.strictObject({
  commitment_id: IdSchema,
  tenant_id: IdSchema,
  agent_id: IdSchema,
  title: z.string().min(COMMITMENT_TITLE_LIMITS.minChars).max(COMMITMENT_TITLE_LIMITS.maxChars),
  status: CommitmentStatusSchema,
  schedule_kind: ScheduleKindSchema,
  interval_seconds: z
    .number()
    .int()
    .min(COMMITMENT_INTERVAL_LIMITS.minSeconds)
    .max(COMMITMENT_INTERVAL_LIMITS.maxSeconds)
    .nullable(),
  next_due_at: IsoDateTimeSchema.nullable(),
  source_profile_id: SourceProfileIdSchema,
  version: z.number().int().positive(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});

/**
 * Acknowledged receipt on creation or replay.
 */
export interface CommitmentReceiptDto {
  readonly commitment_id: Id;
  readonly status: CommitmentStatus;
  readonly created_at: string;
  readonly replayed: boolean;
}

export const CommitmentReceiptDtoSchema: z.ZodType<CommitmentReceiptDto> = z.strictObject({
  commitment_id: IdSchema,
  status: CommitmentStatusSchema,
  created_at: IsoDateTimeSchema,
  replayed: z.boolean(),
});

/**
 * User-provided creation body (snake_case wire format).
 * Strictly forbids tenant_id, principal_id, version, status, or server-generated fields.
 */
export interface CreateCommitmentRequest {
  readonly agent_id: Id;
  readonly title: string;
  readonly schedule_kind: ScheduleKind;
  readonly interval_seconds?: number;
  readonly due_at?: string;
  readonly source_profile_id: SourceProfileId;
}

export const CreateCommitmentRequestSchema = z
  .strictObject({
    agent_id: IdSchema,
    title: z
      .string()
      .min(COMMITMENT_TITLE_LIMITS.minChars)
      .max(COMMITMENT_TITLE_LIMITS.maxChars)
      .refine((val) => val.trim().length > 0, 'title cannot be blank or only whitespace'),
    schedule_kind: ScheduleKindSchema,
    interval_seconds: z
      .number()
      .int()
      .min(COMMITMENT_INTERVAL_LIMITS.minSeconds)
      .max(COMMITMENT_INTERVAL_LIMITS.maxSeconds)
      .optional(),
    due_at: IsoDateTimeSchema.optional(),
    source_profile_id: SourceProfileIdSchema,
  })
  .superRefine((data, ctx) => {
    if (data.schedule_kind === 'interval') {
      if (data.interval_seconds === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interval_seconds is required when schedule_kind is "interval"',
          path: ['interval_seconds'],
        });
      }
    } else if (data.schedule_kind === 'once') {
      if (data.interval_seconds !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interval_seconds must not be provided when schedule_kind is "once"',
          path: ['interval_seconds'],
        });
      }
    }
  });

/**
 * State transition request payload with optional optimistic concurrency version.
 */
export interface StateTransitionRequest {
  readonly expected_version?: number;
}

export const StateTransitionRequestSchema: z.ZodType<StateTransitionRequest> = z.strictObject({
  expected_version: z.number().int().positive().optional(),
});

/**
 * Scheduled occurrence representation.
 */
export interface CommitmentOccurrenceDto {
  readonly occurrence_id: Id;
  readonly commitment_id: Id;
  readonly scheduled_for: string;
  readonly task_id: Id | null;
  readonly status: OccurrenceStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

export const CommitmentOccurrenceDtoSchema: z.ZodType<CommitmentOccurrenceDto> = z.strictObject({
  occurrence_id: IdSchema,
  commitment_id: IdSchema,
  scheduled_for: IsoDateTimeSchema,
  task_id: IdSchema.nullable(),
  status: OccurrenceStatusSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});

/**
 * Non-sensitive outcome summary visible in user inbox.
 */
export interface CommitmentOutcomeDto {
  readonly outcome_id: Id;
  readonly commitment_id: Id;
  readonly occurrence_id: Id;
  readonly task_id: Id;
  readonly summary: string;
  readonly result_status: OutcomeResultStatus;
  readonly created_at: string;
}

export const CommitmentOutcomeDtoSchema: z.ZodType<CommitmentOutcomeDto> = z.strictObject({
  outcome_id: IdSchema,
  commitment_id: IdSchema,
  occurrence_id: IdSchema,
  task_id: IdSchema,
  summary: z.string().min(OUTCOME_SUMMARY_LIMITS.minChars).max(OUTCOME_SUMMARY_LIMITS.maxChars),
  result_status: OutcomeResultStatusSchema,
  created_at: IsoDateTimeSchema,
});

/**
 * Paginated outcome listing.
 */
export interface CommitmentOutcomePageDto {
  readonly commitment_id: Id;
  readonly outcomes: readonly CommitmentOutcomeDto[];
  readonly next_cursor?: string;
}

export const CommitmentOutcomePageDtoSchema: z.ZodType<CommitmentOutcomePageDto> = z.strictObject({
  commitment_id: IdSchema,
  outcomes: z.array(CommitmentOutcomeDtoSchema),
  next_cursor: z.string().optional(),
});

/**
 * Paginated commitment listing.
 */
export interface CommitmentListPageDto {
  readonly commitments: readonly CommitmentDto[];
  readonly next_cursor?: string;
}

export const CommitmentListPageDtoSchema: z.ZodType<CommitmentListPageDto> = z.strictObject({
  commitments: z.array(CommitmentDtoSchema),
  next_cursor: z.string().optional(),
});

/**
 * Deterministic derivation of Task creation idempotency key from occurrenceId.
 * Format: `commitment-occ:${occurrenceId}`
 */
export function deriveTaskCreationIdempotencyKey(occurrenceId: Id): string {
  return `commitment-occ:${occurrenceId}`;
}

// ---------------------------------------------------------------------------
// Repository & Store Interfaces
// ---------------------------------------------------------------------------

export interface CreateCommitmentCommand {
  readonly idempotencyKey: string;
  readonly agentId: Id;
  readonly title: string;
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds?: number;
  readonly dueAt?: Date;
  readonly sourceProfileId: string;
}

export interface StateTransitionOptions {
  readonly expectedVersion?: number;
}

export interface ListCommitmentsOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: CommitmentStatus;
}

export interface ListOutcomesOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CommitmentRepository {
  create(
    ctx: AuthContext,
    cmd: CreateCommitmentCommand,
  ): Promise<{
    readonly commitment: CommitmentDto;
    readonly replayed: boolean;
  }>;

  get(ctx: AuthContext, commitmentId: Id): Promise<CommitmentDto | null>;

  list(
    ctx: AuthContext,
    options?: ListCommitmentsOptions,
  ): Promise<{
    readonly commitments: readonly CommitmentDto[];
    readonly nextCursor?: string;
  }>;

  pause(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto>;

  resume(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto>;

  cancel(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto>;

  listOutcomes(
    ctx: AuthContext,
    commitmentId: Id,
    options?: ListOutcomesOptions,
  ): Promise<{
    readonly outcomes: readonly CommitmentOutcomeDto[];
    readonly nextCursor?: string;
  } | null>;
}

export interface WorkerLeaseGrant {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly leaseEpoch: number;
  readonly workerId: string;
}

export interface DueCommitment {
  readonly commitmentId: Id;
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly title: string;
  readonly sourceProfileId: string;
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds: number | null;
  readonly nextDueAt: Date;
  readonly version: number;
}

export interface ReservedSlot {
  readonly occurrenceId: Id;
  readonly commitmentId: Id;
  readonly scheduledFor: Date;
  readonly commitmentVersion: number;
}

export interface AppendOutcomeCommand {
  readonly occurrenceId: Id;
  readonly commitmentId: Id;
  readonly taskId: Id;
  readonly summary: string;
  readonly resultStatus: OutcomeResultStatus;
}

export interface StalledPendingOccurrence {
  readonly occurrenceId: Id;
  readonly tenantId: Id;
  readonly commitmentId: Id;
  readonly agentId: Id;
  readonly sourceProfileId: SourceProfileId;
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds: number | null;
  readonly scheduledFor: Date;
  readonly createdAt: Date;
  readonly taskCreationIdempotencyKey: string;
}

export interface DueCommitmentStore {
  findDueCommitments(limit: number, asOfOverride?: Date): Promise<readonly DueCommitment[]>;

  reserveOccurrence(
    commitmentId: Id,
    expectedVersion: number,
    slotTimeOverride?: Date,
  ): Promise<ReservedSlot | null>;

  markDispatched(occurrenceId: Id, taskId: Id): Promise<void>;

  appendOutcomeIfAbsent(grant: WorkerLeaseGrant, cmd: AppendOutcomeCommand): Promise<boolean>;

  markCommitmentCompleted(commitmentId: Id, expectedVersion?: number): Promise<boolean>;

  findStalledPendingOccurrences(
    timeoutSeconds: number,
    limit: number,
  ): Promise<readonly StalledPendingOccurrence[]>;

  reconcilePendingOccurrence(occurrenceId: Id, taskId: Id): Promise<boolean>;

  markOccurrenceFailed(occurrenceId: Id, reasonCode: string): Promise<void>;
}

export interface TrustedSourceAccessContext {
  readonly tenantId: Id;
  readonly commitmentId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly leaseEpoch: number;
  readonly authorizedAt: string;
}

export interface SourceReader {
  readSnapshot(
    profileId: SourceProfileId,
    trustedContext: TrustedSourceAccessContext,
    signal: AbortSignal,
  ): Promise<SourceSnapshot>;
}
