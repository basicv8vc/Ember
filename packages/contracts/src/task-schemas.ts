import { EXECUTION_PATHS, RUN_STATUSES, TASK_KINDS, TASK_STATUSES } from '@ember/domain';
import type {
  AuthContext,
  ExecutionPath,
  Id,
  MockApprovalInput,
  MockChatInput,
  MockComputeInput,
  MockFileInput,
  MockTaskInput,
  RunStatus,
  TaskCommand,
  TaskInputByKind,
  TaskKind,
  TaskReceipt,
  TaskStatus,
} from '@ember/domain';
import { z } from 'zod';
import { toInvalidArgumentError } from './validation.js';

/**
 * Character bounds.
 *
 * The HTTP 64 KiB body cap is enforced on the request stream by `apps/api`
 * (`MAX_TASK_BODY_BYTES`). A byte cap and a character budget are not interchangeable: single-byte
 * text can reach the 64 000-character limits under the cap, while the same text in 3-byte UTF-8
 * is rejected as too large long before the schema runs. See that constant for the arithmetic, and
 * `apps/api/src/tasks/routes.ts` for the order of the checks. These schemas therefore keep
 * bounding every field individually before anything reaches persistence.
 */
export const TASK_INPUT_LIMITS = Object.freeze({
  chatPromptMaxChars: 8_000,
  chatMaxOutputTokensMax: 2_048,
  computeTextMaxChars: 64_000,
  fileKeyMaxChars: 256,
  fileContentMaxChars: 64_000,
  mediaTypeMaxChars: 128,
  approvalActionMaxChars: 128,
  approvalReasonMaxChars: 1_000,
  idempotencyKeyMinChars: 8,
  idempotencyKeyMaxChars: 128,
});

/**
 * Workspace-relative logical file key:
 * - no leading slash, no backslash, no empty segment, no `.`/`..` segment;
 * - segments are letters, digits, dot, underscore or hyphen.
 *
 * A future workspace/sandbox layer maps this key inside its isolated root. P0B-02 only
 * pins the semantics; path isolation itself belongs to P0B-06.
 */
export const LOGICAL_FILE_KEY_PATTERN =
  /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Type/subtype only; parameters such as `; charset=utf-8` are not accepted in P0-B. */
export const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

/**
 * Server-generated identifier. The HTTP/domain boundary rejects anything that is not a
 * syntactically valid UUID.
 */
export const IdSchema = z.uuid();

/** RFC 3339 / ISO 8601 timestamp with an explicit timezone (`Z` or offset). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Deadlines use the same wire format as other timestamps. No clock is consulted here. */
export const DeadlineSchema = IsoDateTimeSchema;

/**
 * Idempotency keys arrive in the `Idempotency-Key` header. This schema is applied by the
 * gateway, never to a body field. Pattern is intentionally conservative: visible ASCII
 * token characters only, bounded length.
 */
export const IdempotencyKeySchema = z
  .string()
  .min(TASK_INPUT_LIMITS.idempotencyKeyMinChars)
  .max(TASK_INPUT_LIMITS.idempotencyKeyMaxChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a header-safe idempotency key');

export const TaskKindSchema = z.enum(TASK_KINDS);
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const RunStatusSchema = z.enum(RUN_STATUSES);
export const ExecutionPathSchema = z.enum(EXECUTION_PATHS);

/** Auth context is derived server-side. It is never accepted from a task body. */
export const AuthContextSchema: z.ZodType<AuthContext> = z.strictObject({
  tenantId: IdSchema,
  principalId: IdSchema,
  policyVersion: z.number().int().nonnegative(),
});

export const MockChatInputSchema: z.ZodType<MockChatInput> = z.strictObject({
  prompt: z.string().min(1).max(TASK_INPUT_LIMITS.chatPromptMaxChars),
  maxOutputTokens: z.number().int().min(1).max(TASK_INPUT_LIMITS.chatMaxOutputTokensMax).optional(),
});

export const MockComputeInputSchema: z.ZodType<MockComputeInput> = z.strictObject({
  operation: z.literal('sha256'),
  text: z.string().max(TASK_INPUT_LIMITS.computeTextMaxChars),
});

export const MockFileInputSchema: z.ZodType<MockFileInput> = z.strictObject({
  fileKey: z
    .string()
    .min(1)
    .max(TASK_INPUT_LIMITS.fileKeyMaxChars)
    .regex(LOGICAL_FILE_KEY_PATTERN, 'must be a workspace-relative logical file key'),
  content: z.string().max(TASK_INPUT_LIMITS.fileContentMaxChars),
  mediaType: z
    .string()
    .min(1)
    .max(TASK_INPUT_LIMITS.mediaTypeMaxChars)
    .regex(MEDIA_TYPE_PATTERN, 'must be a type/subtype media type')
    .optional(),
});

export const MockApprovalInputSchema: z.ZodType<MockApprovalInput> = z.strictObject({
  action: z
    .string()
    .min(1)
    .max(TASK_INPUT_LIMITS.approvalActionMaxChars)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a logical action label'),
  reason: z.string().max(TASK_INPUT_LIMITS.approvalReasonMaxChars).optional(),
});

/** Input schemas keyed by kind. Unknown kinds are rejected before this map is consulted. */
export const TASK_INPUT_SCHEMAS = Object.freeze({
  'mock.chat': MockChatInputSchema,
  'mock.compute': MockComputeInputSchema,
  'mock.file': MockFileInputSchema,
  'mock.approval': MockApprovalInputSchema,
}) satisfies Readonly<Record<TaskKind, z.ZodType<MockTaskInput>>>;

/** Narrowing helper for callers that already know a validated `TaskKind`. */
export function taskInputSchemaForKind<K extends TaskKind>(
  kind: K,
): (typeof TASK_INPUT_SCHEMAS)[K] {
  return TASK_INPUT_SCHEMAS[kind];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Validated task body without the header-derived idempotency key. */
export type CreateTaskBody = DistributiveOmit<TaskCommand, 'idempotencyKey'>;

/**
 * HTTP request body (snake_case wire fields). No `tenant_id`, `principal_id`, lease or
 * status fields exist here on purpose; strict objects reject attempts to smuggle them in.
 */
export type CreateTaskRequest = {
  readonly [K in TaskKind]: {
    readonly agent_id: Id;
    readonly kind: K;
    readonly input: TaskInputByKind[K];
    readonly deadline_at?: string;
  };
}[TaskKind];

const createTaskBodyVariants = [
  z.strictObject({
    agentId: IdSchema,
    kind: z.literal('mock.chat'),
    input: MockChatInputSchema,
    deadlineAt: DeadlineSchema.optional(),
  }),
  z.strictObject({
    agentId: IdSchema,
    kind: z.literal('mock.compute'),
    input: MockComputeInputSchema,
    deadlineAt: DeadlineSchema.optional(),
  }),
  z.strictObject({
    agentId: IdSchema,
    kind: z.literal('mock.file'),
    input: MockFileInputSchema,
    deadlineAt: DeadlineSchema.optional(),
  }),
  z.strictObject({
    agentId: IdSchema,
    kind: z.literal('mock.approval'),
    input: MockApprovalInputSchema,
    deadlineAt: DeadlineSchema.optional(),
  }),
] as const;

/**
 * Internal canonical body shape (camelCase). The gateway validates this after mapping
 * the wire request, so the application never handles unvalidated JSON.
 */
export const CreateTaskBodySchema: z.ZodType<CreateTaskBody> = z.discriminatedUnion(
  'kind',
  createTaskBodyVariants,
);

const taskCommandVariants = [
  createTaskBodyVariants[0].extend({ idempotencyKey: IdempotencyKeySchema }),
  createTaskBodyVariants[1].extend({ idempotencyKey: IdempotencyKeySchema }),
  createTaskBodyVariants[2].extend({ idempotencyKey: IdempotencyKeySchema }),
  createTaskBodyVariants[3].extend({ idempotencyKey: IdempotencyKeySchema }),
] as const;

/**
 * Complete internal command: validated body + validated header key. Keeping this separate
 * from `CreateTaskBodySchema` is what prevents a client from forging an idempotency key in
 * the JSON body.
 */
export const TaskCommandSchema: z.ZodType<TaskCommand> = z.discriminatedUnion(
  'kind',
  taskCommandVariants,
);

const createTaskRequestVariants = [
  z.strictObject({
    agent_id: IdSchema,
    kind: z.literal('mock.chat'),
    input: MockChatInputSchema,
    deadline_at: DeadlineSchema.optional(),
  }),
  z.strictObject({
    agent_id: IdSchema,
    kind: z.literal('mock.compute'),
    input: MockComputeInputSchema,
    deadline_at: DeadlineSchema.optional(),
  }),
  z.strictObject({
    agent_id: IdSchema,
    kind: z.literal('mock.file'),
    input: MockFileInputSchema,
    deadline_at: DeadlineSchema.optional(),
  }),
  z.strictObject({
    agent_id: IdSchema,
    kind: z.literal('mock.approval'),
    input: MockApprovalInputSchema,
    deadline_at: DeadlineSchema.optional(),
  }),
] as const;

/** Wire-level `POST /v1/tasks` body. `/v1/tasks` itself is implemented in P0B-07. */
export const CreateTaskRequestSchema: z.ZodType<CreateTaskRequest> = z.discriminatedUnion(
  'kind',
  createTaskRequestVariants,
);

function withDeadline<T extends object>(
  value: T,
  deadlineAt: string | undefined,
): T | (T & { readonly deadlineAt: string }) {
  return deadlineAt === undefined ? value : { ...value, deadlineAt };
}

/** Explicit snake_case → camelCase conversion; there is only one canonical internal shape. */
export function toCreateTaskBody(request: CreateTaskRequest): CreateTaskBody {
  switch (request.kind) {
    case 'mock.chat':
      return withDeadline(
        {
          agentId: request.agent_id,
          kind: request.kind,
          input: request.input,
        },
        request.deadline_at,
      );
    case 'mock.compute':
      return withDeadline(
        {
          agentId: request.agent_id,
          kind: request.kind,
          input: request.input,
        },
        request.deadline_at,
      );
    case 'mock.file':
      return withDeadline(
        {
          agentId: request.agent_id,
          kind: request.kind,
          input: request.input,
        },
        request.deadline_at,
      );
    case 'mock.approval':
      return withDeadline(
        {
          agentId: request.agent_id,
          kind: request.kind,
          input: request.input,
        },
        request.deadline_at,
      );
  }
}

/**
 * Combine a validated body with the header-derived key and re-validate the whole command.
 *
 * @throws {InvalidArgumentError} when the idempotency key or combination is invalid.
 */
export function toTaskCommand(body: CreateTaskBody, idempotencyKey: string): TaskCommand {
  const parsed = TaskCommandSchema.safeParse({ ...body, idempotencyKey });

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

/** Internal receipt shape. HTTP uses the snake_case DTO below. */
export const TaskReceiptSchema: z.ZodType<TaskReceipt> = z.strictObject({
  taskId: IdSchema,
  status: TaskStatusSchema,
  acceptedAt: IsoDateTimeSchema,
  replayed: z.boolean(),
});

/** HTTP `POST /v1/tasks` receipt (202/200). Status-code mapping belongs to P0B-07. */
export interface TaskReceiptDto {
  readonly task_id: Id;
  readonly status: TaskStatus;
  readonly accepted_at: string;
  readonly replayed: boolean;
}

export const TaskReceiptDtoSchema: z.ZodType<TaskReceiptDto> = z.strictObject({
  task_id: IdSchema,
  status: TaskStatusSchema,
  accepted_at: IsoDateTimeSchema,
  replayed: z.boolean(),
});

/** Explicit internal → wire conversion. Never serialise the internal object directly. */
export function toTaskReceiptDto(receipt: TaskReceipt): TaskReceiptDto {
  return {
    task_id: receipt.taskId,
    status: receipt.status,
    accepted_at: receipt.acceptedAt,
    replayed: receipt.replayed,
  };
}

export type { ExecutionPath, RunStatus, TaskStatus };
