import { APPROVAL_DECISIONS, APPROVAL_STATUSES } from '@ember/domain';
import type {
  ApprovalDecision,
  ApprovalDecisionReceipt,
  ApprovalStatus,
  ApprovalView,
  Id,
  TaskStatus,
} from '@ember/domain';
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, TaskStatusSchema } from './task-schemas.js';
import { toInvalidArgumentError } from './validation.js';

export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);

export const ApprovalDecisionSchema = z.enum(APPROVAL_DECISIONS);

export const ApprovalActionDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const ApprovalDecisionRequestDtoSchema = z
  .object({
    decision: ApprovalDecisionSchema,
  })
  .strict();

export type ApprovalDecisionRequestDto = z.infer<typeof ApprovalDecisionRequestDtoSchema>;

export const ApprovalViewDtoSchema = z
  .object({
    approval_id: IdSchema,
    task_id: IdSchema,
    run_id: IdSchema,
    lease_epoch: z.number().int().positive(),
    action_digest: ApprovalActionDigestSchema,
    status: ApprovalStatusSchema,
    expires_at: IsoDateTimeSchema,
    decided_at: IsoDateTimeSchema.nullable(),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export interface ApprovalViewDto {
  readonly approval_id: Id;
  readonly task_id: Id;
  readonly run_id: Id;
  readonly lease_epoch: number;
  readonly action_digest: string;
  readonly status: ApprovalStatus;
  readonly expires_at: string;
  readonly decided_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export const ApprovalDecisionReceiptDtoSchema = z
  .object({
    approval_id: IdSchema,
    task_id: IdSchema,
    status: z.enum(['approved', 'denied']),
    task_status: TaskStatusSchema,
    decided_at: IsoDateTimeSchema,
    replayed: z.boolean(),
  })
  .strict();

export interface ApprovalDecisionReceiptDto {
  readonly approval_id: Id;
  readonly task_id: Id;
  readonly status: 'approved' | 'denied';
  readonly task_status: TaskStatus;
  readonly decided_at: string;
  readonly replayed: boolean;
}

export function parseApprovalDecisionRequestDto(input: unknown): ApprovalDecision {
  const result = ApprovalDecisionRequestDtoSchema.safeParse(input);

  if (!result.success) {
    throw toInvalidArgumentError(result.error);
  }

  return result.data.decision;
}

export function toApprovalViewDto(view: ApprovalView): ApprovalViewDto {
  const candidate = {
    approval_id: view.approvalId,
    task_id: view.taskId,
    run_id: view.runId,
    lease_epoch: view.leaseEpoch,
    action_digest: view.actionDigest,
    status: view.status,
    expires_at: view.expiresAt,
    decided_at: view.decidedAt,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
  };

  const result = ApprovalViewDtoSchema.safeParse(candidate);

  if (!result.success) {
    throw toInvalidArgumentError(result.error);
  }

  return Object.freeze(result.data);
}

export function toApprovalDecisionReceiptDto(
  receipt: ApprovalDecisionReceipt,
): ApprovalDecisionReceiptDto {
  const candidate = {
    approval_id: receipt.approvalId,
    task_id: receipt.taskId,
    status: receipt.status,
    task_status: receipt.taskStatus,
    decided_at: receipt.decidedAt,
    replayed: receipt.replayed,
  };

  const result = ApprovalDecisionReceiptDtoSchema.safeParse(candidate);

  if (!result.success) {
    throw toInvalidArgumentError(result.error);
  }

  return Object.freeze(result.data);
}
