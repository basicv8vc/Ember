import { z } from 'zod';
import { OUTCOME_RESULT_STATUSES } from './commitment-schemas.js';
import { IdSchema, IsoDateTimeSchema, TaskStatusSchema } from './task-schemas.js';

/**
 * B1-1 contract-only schemas. Approved wire authority:
 * ADR-0004 + docs/product/B1_PLATFORM_CONTRACT.md (merged via PR #92).
 *
 * These schemas introduce no HTTP routes, authentication, model execution or egress.
 * Fields are strict: client-supplied tenant/principal/policy identifiers are rejected.
 */
export const B1TranscriptEpochSchema = z.number().int().nonnegative();
export const B1MessageSequenceSchema = z.number().int().positive();
export const B1AssistantTurnStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
export const B1AssistantFailureReasonSchema = z.enum(['timeout', 'internal_error']);

export const B1SessionRequestSchema = z.strictObject({
  provider: z.enum(['apple', 'dev']),
  identity_token: z.string().min(1),
  nonce: z.string().min(1),
});

export const B1SessionResponseSchema = z.strictObject({
  session_id: IdSchema,
  consumer_id: IdSchema,
  access_token: z.string().regex(/^ems_[A-Za-z0-9_-]+$/),
  expires_at: IsoDateTimeSchema,
});

export const B1MeResponseSchema = z.strictObject({
  consumer_id: IdSchema,
  agent: z.strictObject({
    agent_id: IdSchema,
    display_name: z.string().min(1).max(128),
  }),
  conversation: z.strictObject({
    conversation_id: IdSchema,
    transcript_epoch: B1TranscriptEpochSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  }),
});

const b1MessageBase = {
  message_id: IdSchema,
  sequence: B1MessageSequenceSchema,
  created_at: IsoDateTimeSchema,
};

export const B1UserMessageSchema = z.strictObject({
  ...b1MessageBase,
  kind: z.literal('user'),
  text: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.trim().length > 0),
  client_submission_id: IdSchema,
});

export const B1EmberMessageSchema = z.strictObject({
  ...b1MessageBase,
  kind: z.literal('ember'),
  text: z.string().min(1).max(8192),
  model_label: z.string().min(1),
  simulated: z.boolean(),
});

export const B1ActivityMessageSchema = z.strictObject({
  ...b1MessageBase,
  kind: z.literal('activity'),
  text: z.string().min(1).max(280),
  source: z.string().min(1),
});

export const B1TaskReferenceMessageSchema = z.strictObject({
  ...b1MessageBase,
  kind: z.literal('task_reference'),
  task_id: IdSchema,
});

export const B1CommitmentReferenceMessageSchema = z.strictObject({
  ...b1MessageBase,
  kind: z.literal('commitment_reference'),
  commitment_id: IdSchema,
});

export const B1OutcomeReferenceMessageSchema = z.strictObject({
  ...b1MessageBase,
  kind: z.literal('outcome_reference'),
  outcome: z.strictObject({
    outcome_kind: z.enum(OUTCOME_RESULT_STATUSES),
    task_id: IdSchema,
    commitment_id: IdSchema.nullable(),
  }),
});

export const B1ConversationMessageSchema = z.discriminatedUnion('kind', [
  B1UserMessageSchema,
  B1EmberMessageSchema,
  B1ActivityMessageSchema,
  B1TaskReferenceMessageSchema,
  B1CommitmentReferenceMessageSchema,
  B1OutcomeReferenceMessageSchema,
]);

export const B1SendMessageRequestSchema = z.strictObject({
  client_submission_id: IdSchema,
  text: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.trim().length > 0),
  transcript_epoch: B1TranscriptEpochSchema,
  client_created_at: IsoDateTimeSchema.optional(),
});

export const B1SendMessageReceiptSchema = z.strictObject({
  message: B1UserMessageSchema.extend({
    conversation_id: IdSchema,
  }),
  turn: z.strictObject({
    turn_id: IdSchema,
    status: z.literal('running'),
    created_at: IsoDateTimeSchema,
  }),
  transcript_epoch: B1TranscriptEpochSchema,
});

export const B1ConversationPageSchema = z.strictObject({
  conversation_id: IdSchema,
  transcript_epoch: B1TranscriptEpochSchema,
  messages: z.array(B1ConversationMessageSchema).max(100),
  next_after: z.number().int().nonnegative(),
  has_more: z.boolean(),
});

export const B1AssistantTurnDtoSchema = z
  .strictObject({
    turn_id: IdSchema,
    conversation_id: IdSchema,
    source_message_id: IdSchema,
    status: B1AssistantTurnStatusSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
    response_message_id: IdSchema.nullable(),
    failure_reason: B1AssistantFailureReasonSchema.nullable(),
  })
  .superRefine((turn, context) => {
    if (turn.status === 'completed' && turn.response_message_id === null) {
      context.addIssue({
        code: 'custom',
        message: 'completed turn requires a response message',
        path: ['response_message_id'],
      });
    }
    if (
      (turn.status === 'running' || turn.status === 'cancelled') &&
      turn.failure_reason !== null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'non-failed turns must not contain a failure reason',
        path: ['failure_reason'],
      });
    }
    if (turn.status === 'failed' && turn.failure_reason === null) {
      context.addIssue({
        code: 'custom',
        message: 'failed turn requires a failure reason',
        path: ['failure_reason'],
      });
    }
  });

const b1TextResultSchema = z.strictObject({
  summary_text: z.string().max(2048),
  detail_text: z.string().max(16384).nullable(),
  model_label: z.string().min(1),
  simulated: z.boolean(),
  produced_at: IsoDateTimeSchema,
});

const b1ResultBase = {
  task_id: IdSchema,
  task_status: TaskStatusSchema,
};

export const B1TaskResultDtoSchema = z.discriminatedUnion('result_state', [
  z.strictObject({
    ...b1ResultBase,
    result_state: z.literal('pending'),
    result: z.null(),
  }),
  z.strictObject({
    ...b1ResultBase,
    result_state: z.literal('available'),
    result: b1TextResultSchema,
  }),
  z.strictObject({
    ...b1ResultBase,
    result_state: z.literal('unavailable'),
    result: z.null(),
  }),
]);

export type B1SessionRequest = z.infer<typeof B1SessionRequestSchema>;
export type B1SessionResponse = z.infer<typeof B1SessionResponseSchema>;
export type B1MeResponse = z.infer<typeof B1MeResponseSchema>;
export type B1ConversationMessage = z.infer<typeof B1ConversationMessageSchema>;
export type B1SendMessageRequest = z.infer<typeof B1SendMessageRequestSchema>;
export type B1SendMessageReceipt = z.infer<typeof B1SendMessageReceiptSchema>;
export type B1ConversationPage = z.infer<typeof B1ConversationPageSchema>;
export type B1AssistantTurnDto = z.infer<typeof B1AssistantTurnDtoSchema>;
export type B1TaskResultDto = z.infer<typeof B1TaskResultDtoSchema>;
