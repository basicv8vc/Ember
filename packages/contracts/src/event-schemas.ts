import { TASK_EVENT_PHASES } from '@ember/domain';
import type { Id, TaskEvent, TaskEventPayload } from '@ember/domain';
import { z } from 'zod';
import { DomainErrorCodeSchema } from './error-schemas.js';
import {
  ExecutionPathSchema,
  IdSchema,
  IsoDateTimeSchema,
  RunStatusSchema,
  TaskKindSchema,
  TaskStatusSchema,
} from './task-schemas.js';
import { toInvalidArgumentError } from './validation.js';

export const TaskEventPhaseSchema = z.enum(TASK_EVENT_PHASES);

const nonNegativeInteger = z.number().int().nonnegative();

/**
 * Closed payload allowlist. Every field is an enum, UUID, non-negative integer or boolean;
 * there is no free-text field, so a prompt, token, API key, SQL fragment, host path or tool
 * output cannot be represented directly. `z.strictObject` rejects every other key.
 *
 * Length limits are not used as a substitute for this redaction boundary: a secret under an
 * unknown key is rejected regardless of its length, and a secret inside an allowlisted field
 * must still satisfy that field's enum/UUID/number/boolean type.
 */
const TaskEventPayloadObject = z.strictObject({
  taskKind: TaskKindSchema.optional(),
  runId: IdSchema.optional(),
  attempt: nonNegativeInteger.optional(),
  route: ExecutionPathSchema.optional(),
  fromStatus: TaskStatusSchema.optional(),
  toStatus: TaskStatusSchema.optional(),
  runStatus: RunStatusSchema.optional(),
  errorCode: DomainErrorCodeSchema.optional(),
  artifactId: IdSchema.optional(),
  workspaceVersion: nonNegativeInteger.optional(),
  sandboxId: IdSchema.optional(),
  durationMs: nonNegativeInteger.optional(),
  replayed: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  policyVersion: nonNegativeInteger.optional(),
  simulated: z.boolean().optional(),
});

/** Persistent and public event payloads are restricted to the closed allowlist above. */
export const TaskEventPayloadSchema: z.ZodType<TaskEventPayload> = TaskEventPayloadObject;

export type TaskEventPayloadKey = keyof TaskEventPayload;

/** Runtime list of allowed payload keys, exported for contract tests and documentation. */
export const TASK_EVENT_PAYLOAD_KEYS: readonly TaskEventPayloadKey[] = Object.freeze(
  Object.keys(TaskEventPayloadObject.shape) as TaskEventPayloadKey[],
);

/** Internal event shape used by the event store. */
export const TaskEventSchema: z.ZodType<TaskEvent> = z.strictObject({
  taskId: IdSchema,
  sequence: z.number().int().nonnegative(),
  phase: TaskEventPhaseSchema,
  occurredAt: IsoDateTimeSchema,
  traceId: IdSchema,
  payload: TaskEventPayloadSchema,
});

/** HTTP/SSE event DTO (snake_case wire fields). */
export interface TaskEventDto {
  readonly task_id: Id;
  readonly sequence: number;
  readonly phase: TaskEvent['phase'];
  readonly occurred_at: string;
  readonly trace_id: Id;
  readonly payload: TaskEventPayload;
}

export const TaskEventDtoSchema: z.ZodType<TaskEventDto> = z.strictObject({
  task_id: IdSchema,
  sequence: z.number().int().nonnegative(),
  phase: TaskEventPhaseSchema,
  occurred_at: IsoDateTimeSchema,
  trace_id: IdSchema,
  payload: TaskEventPayloadSchema,
});

/**
 * Explicit internal → wire conversion.
 *
 * Re-validates the complete event before mapping so an object assembled with extra runtime
 * fields cannot smuggle a prompt/token/tool output into the public DTO. Invalid events fail
 * closed with a safe `INVALID_ARGUMENT` error.
 */
export function toTaskEventDto(event: TaskEvent): TaskEventDto {
  const parsed = TaskEventSchema.safeParse(event);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return {
    task_id: parsed.data.taskId,
    sequence: parsed.data.sequence,
    phase: parsed.data.phase,
    occurred_at: parsed.data.occurredAt,
    trace_id: parsed.data.traceId,
    payload: parsed.data.payload,
  };
}
