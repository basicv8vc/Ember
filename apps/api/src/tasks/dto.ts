import {
  IdSchema,
  IsoDateTimeSchema,
  TaskEventDtoSchema,
  TaskKindSchema,
  TaskStatusSchema,
  type TaskEventDto,
} from '@ember/contracts';

import type { Id, TaskKind, TaskStatus, TaskView } from '@ember/domain';
import { z } from 'zod';

/**
 * Wire DTOs for `GET /v1/tasks/:taskId` and `GET /v1/tasks/:taskId/events` (P0B-07a).
 *
 * P0B-02 froze the receipt, event and error DTOs in `@ember/contracts`. It did not define a
 * task-detail DTO, so this module adds one at the HTTP edge using the *same* field schemas,
 * rather than introducing a parallel vocabulary. Promotion into `@ember/contracts` is a
 * mechanical move once a second client consumes it; it is deliberately not done here,
 * because changing a frozen shared package is a contract change that needs review.
 *
 * Deliberate omissions (each one would leak either internals or another tenant's data):
 * `tenant_id`, `principal_id`, `idempotency_key`, `digest`, `input`, and columns the domain
 * does not expose. A caller already knows its own tenant from its credential.
 */

/** Task detail as returned by `GET /v1/tasks/:taskId`. */
export interface TaskDetailDto {
  readonly task_id: Id;
  readonly agent_id: Id;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly current_run_id: Id | null;
  readonly attempt_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deadline_at: string | null;
}

export const TaskDetailDtoSchema: z.ZodType<TaskDetailDto> = z.strictObject({
  task_id: IdSchema,
  agent_id: IdSchema,
  kind: TaskKindSchema,
  status: TaskStatusSchema,
  current_run_id: IdSchema.nullable(),
  attempt_count: z.number().int().nonnegative(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  deadline_at: IsoDateTimeSchema.nullable(),
});

/** Explicit internal → wire conversion; the internal `TaskView` is never serialised directly. */
export function toTaskDetailDto(view: TaskView): TaskDetailDto {
  return {
    task_id: view.taskId,
    agent_id: view.agentId,
    kind: view.kind,
    status: view.status,
    current_run_id: view.currentRunId,
    attempt_count: view.attemptCount,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
    deadline_at: view.deadlineAt,
  };
}

/**
 * Event page returned by `GET /v1/tasks/:taskId/events`.
 *
 * `task_id` is repeated outside the array so a client cannot mix up pages for two tasks.
 * There is no `next_after`: a client derives the next cursor from the last event's
 * `sequence`, and an empty `events` array means "nothing new since `after`".
 */
export interface TaskEventPageDto {
  readonly task_id: Id;
  readonly events: readonly TaskEventDto[];
}

export const TaskEventPageDtoSchema: z.ZodType<TaskEventPageDto> = z.strictObject({
  task_id: IdSchema,
  events: z.array(TaskEventDtoSchema),
});
