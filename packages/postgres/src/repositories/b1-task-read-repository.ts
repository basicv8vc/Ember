import {
  B1TaskDetailDtoSchema,
  B1TaskListDtoSchema,
  B1TaskResultDtoSchema,
  IdSchema,
  TaskStatusSchema,
  toInvalidArgumentError,
  type B1TaskDetailDto,
  type B1TaskListDto,
  type B1TaskResultDto,
} from '@ember/contracts';
import { isTerminalTaskStatus, type Id, type TaskStatus } from '@ember/domain';
import type pg from 'pg';
import { z } from 'zod';
import type {
  B1TaskListQuery,
  B1TaskReadRepository,
  B1TaskResultRepository,
} from './b1-interfaces.js';
import { asDomainError, toIsoTimestamp } from './support.js';

export const B1_TASK_LIST_DEFAULT_LIMIT = 20;
export const B1_TASK_LIST_MAX_LIMIT = 50;

interface JoinedTaskRow {
  readonly task_id: string;
  readonly agent_id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly status: string;
  readonly attempt_count: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly deadline_at: Date | string | null;
  readonly result_state: string | null;
  readonly summary_text: string | null;
  readonly detail_text: string | null;
  readonly model_label: string | null;
  readonly simulated: boolean | null;
  readonly produced_at: Date | string | null;
}

const SELECT_TASK_WITH_RESULT_SQL = `
SELECT t.id AS task_id,
       t.agent_id,
       t.kind,
       t.title,
       t.status,
       t.attempt_count,
       t.created_at,
       t.updated_at,
       t.deadline_at,
       r.result_state,
       r.summary_text,
       r.detail_text,
       r.model_label,
       r.simulated,
       r.produced_at
  FROM tasks t
  LEFT JOIN task_results r
    ON r.tenant_id = t.tenant_id AND r.task_id = t.id
 WHERE t.tenant_id = $1::uuid AND t.id = $2::uuid
`;

const LIST_TASKS_WITH_RESULT_SQL = `
SELECT t.id AS task_id,
       t.agent_id,
       t.kind,
       t.title,
       t.status,
       t.attempt_count,
       t.created_at,
       t.updated_at,
       t.deadline_at,
       r.result_state,
       r.summary_text,
       r.detail_text,
       r.model_label,
       r.simulated,
       r.produced_at
  FROM tasks t
  LEFT JOIN task_results r
    ON r.tenant_id = t.tenant_id AND r.task_id = t.id
 WHERE t.tenant_id = $1::uuid
   AND ($2::text IS NULL OR t.status = $2::text)
 ORDER BY t.created_at DESC, t.id DESC
 LIMIT $3
`;

const tenantTaskLookupSchema = z.strictObject({
  tenantId: IdSchema,
  taskId: IdSchema,
});

const listQuerySchema = z.strictObject({
  tenantId: IdSchema,
  status: TaskStatusSchema.optional(),
  limit: z.number().int().min(1).max(B1_TASK_LIST_MAX_LIMIT).default(B1_TASK_LIST_DEFAULT_LIMIT),
});

/**
 * Derive authoritative X-9 result state by joining the live Task status against stored `task_results`:
 * - Non-terminal Tasks always present `pending` (with `result: null`).
 * - Terminal Tasks NEVER present `pending`: if an `'available'` row exists, return its text
 *   metadata; otherwise fail closed to `'unavailable'` (with `result: null`).
 */
function resolveJoinedResult(row: JoinedTaskRow): {
  readonly status: TaskStatus;
  readonly resultState: 'pending' | 'available' | 'unavailable';
  readonly result: {
    readonly summary_text: string;
    readonly detail_text: string | null;
    readonly model_label: string;
    readonly simulated: boolean;
    readonly produced_at: string;
  } | null;
} {
  const status = TaskStatusSchema.parse(row.status);

  if (!isTerminalTaskStatus(status)) {
    return { status, resultState: 'pending', result: null };
  }

  if (
    row.result_state === 'available' &&
    row.summary_text !== null &&
    row.model_label !== null &&
    row.simulated !== null &&
    row.produced_at !== null
  ) {
    return {
      status,
      resultState: 'available',
      result: {
        summary_text: row.summary_text,
        detail_text: row.detail_text,
        model_label: row.model_label,
        simulated: row.simulated,
        produced_at: toIsoTimestamp(row.produced_at),
      },
    };
  }

  return { status, resultState: 'unavailable', result: null };
}

function toTaskSummary(row: JoinedTaskRow) {
  const joined = resolveJoinedResult(row);

  return {
    summary: {
      task_id: row.task_id,
      agent_id: row.agent_id,
      kind: row.kind,
      title: row.title,
      status: joined.status,
      attempt_count: row.attempt_count,
      created_at: toIsoTimestamp(row.created_at),
      updated_at: toIsoTimestamp(row.updated_at),
      deadline_at: row.deadline_at === null ? null : toIsoTimestamp(row.deadline_at),
      result_state: joined.resultState,
    },
    joined,
  };
}

/**
 * Tenant-scoped B1 Task & Result read repository.
 *
 * Keeps zero `node:*` imports so it can be shared cleanly between Node API processes and the
 * Cloudflare Worker entry point.
 */
export class PostgresB1TaskReadRepository implements B1TaskResultRepository, B1TaskReadRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getTaskResult(tenantId: Id, taskId: Id): Promise<B1TaskResultDto | null> {
    const parsed = tenantTaskLookupSchema.safeParse({ tenantId, taskId });

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    try {
      const result = await this.pool.query<JoinedTaskRow>(SELECT_TASK_WITH_RESULT_SQL, [
        parsed.data.tenantId,
        parsed.data.taskId,
      ]);
      const row = result.rows[0];

      if (row === undefined) {
        return null;
      }

      const joined = resolveJoinedResult(row);
      return B1TaskResultDtoSchema.parse({
        task_id: row.task_id,
        task_status: joined.status,
        result_state: joined.resultState,
        result: joined.result,
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async listTasks(tenantId: Id, query?: B1TaskListQuery): Promise<B1TaskListDto> {
    const parsed = listQuerySchema.safeParse({
      tenantId,
      ...(query?.status === undefined ? {} : { status: query.status }),
      ...(query?.limit === undefined ? {} : { limit: query.limit }),
    });

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    try {
      const result = await this.pool.query<JoinedTaskRow>(LIST_TASKS_WITH_RESULT_SQL, [
        parsed.data.tenantId,
        parsed.data.status ?? null,
        parsed.data.limit,
      ]);

      return B1TaskListDtoSchema.parse({
        tasks: result.rows.map((row) => toTaskSummary(row).summary),
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async getTaskDetail(tenantId: Id, taskId: Id): Promise<B1TaskDetailDto | null> {
    const parsed = tenantTaskLookupSchema.safeParse({ tenantId, taskId });

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    try {
      const result = await this.pool.query<JoinedTaskRow>(SELECT_TASK_WITH_RESULT_SQL, [
        parsed.data.tenantId,
        parsed.data.taskId,
      ]);
      const row = result.rows[0];

      if (row === undefined) {
        return null;
      }

      const { summary, joined } = toTaskSummary(row);
      return B1TaskDetailDtoSchema.parse({
        ...summary,
        result: joined.result,
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }
}
