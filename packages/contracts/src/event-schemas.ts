import { TASK_EVENT_PHASES } from '@ember/domain';
import type { Id, TaskEvent, TaskEventPayload } from '@ember/domain';
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from './task-schemas.js';

export const TaskEventPhaseSchema = z.enum(TASK_EVENT_PHASES);

/**
 * Event payloads are flat, scrubbed metadata only: no nested objects, no arrays, no raw
 * prompts or tokens. Keys and string values are bounded.
 */
export const TaskEventPayloadSchema: z.ZodType<TaskEventPayload> = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 'must be a safe metadata key'),
    z.union([z.string().max(2_048), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine(
    (payload) => Object.keys(payload).length <= 32,
    'payload must not contain more than 32 keys',
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

/** Explicit internal → wire conversion. */
export function toTaskEventDto(event: TaskEvent): TaskEventDto {
  return {
    task_id: event.taskId,
    sequence: event.sequence,
    phase: event.phase,
    occurred_at: event.occurredAt,
    trace_id: event.traceId,
    payload: event.payload,
  };
}
