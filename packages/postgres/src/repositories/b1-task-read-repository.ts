import {
  B1TaskCancelDtoSchema,
  B1TaskDetailDtoSchema,
  B1TaskEventPageDtoSchema,
  B1TaskListDtoSchema,
  B1TaskResultDtoSchema,
  IdSchema,
  TaskStatusSchema,
  toInvalidArgumentError,
  toTaskEventDto,
  type B1TaskCancelDto,
  type B1TaskDetailDto,
  type B1TaskEventPageDto,
  type B1TaskListDto,
  type B1TaskResultDto,
  type TaskEventDto,
} from '@ember/contracts';
import { DomainError, isTerminalTaskStatus, type Id, type TaskStatus } from '@ember/domain';
import type pg from 'pg';
import { z } from 'zod';
import type {
  B1TaskListQuery,
  B1TaskReadRepository,
  B1TaskResultRepository,
} from './b1-interfaces.js';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';
import { cancelTaskInTransaction } from './task-cancellation.js';
import { parseListEventOptions, queryTaskEvents } from './task-event-queries.js';

export const B1_TASK_LIST_DEFAULT_LIMIT = 20;
export const B1_TASK_LIST_MAX_LIMIT = 50;
export const B1_TASK_EVENTS_PAGE_LIMIT = 100;

const TASK_LIST_CURSOR_DELIMITER = '|';
const TASK_LIST_CURSOR_REGEX = /^[A-Za-z0-9_-]{1,256}$/;
const CURSOR_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

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

interface TaskSummaryRow {
  readonly task_id: string;
  readonly agent_id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly status: string;
  readonly current_run_id: string | null;
  readonly attempt_count: number;
  readonly cancel_requested_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly deadline_at: Date | string | null;
  readonly cursor_ts: string;
}

const SELECT_TASK_SUMMARY_COLUMNS = `
       t.id AS task_id,
       t.agent_id,
       t.kind,
       t.title,
       t.status,
       t.current_run_id,
       t.attempt_count,
       t.cancel_requested_at,
       t.created_at,
       t.updated_at,
       t.deadline_at,
       to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
`;

const SELECT_TASK_SUMMARY_SQL = `
SELECT ${SELECT_TASK_SUMMARY_COLUMNS}
  FROM tasks t
 WHERE t.tenant_id = $1::uuid AND t.id = $2::uuid
`;

const SELECT_TASK_EXISTS_SQL = `
SELECT 1
  FROM tasks
 WHERE tenant_id = $1::uuid AND id = $2::uuid
`;

const LIST_TASKS_SQL = `
SELECT ${SELECT_TASK_SUMMARY_COLUMNS}
  FROM tasks t
 WHERE t.tenant_id = $1::uuid
   AND ($2::text IS NULL OR t.status = $2::text)
   AND (
     $3::timestamptz IS NULL
     OR (t.created_at, t.id) < ($3::timestamptz, $4::uuid)
   )
 ORDER BY t.created_at DESC, t.id DESC
 LIMIT $5
`;

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

const tenantTaskLookupSchema = z.strictObject({
  tenantId: IdSchema,
  taskId: IdSchema,
});

const listQuerySchema = z.strictObject({
  tenantId: IdSchema,
  status: TaskStatusSchema.optional(),
  limit: z.number().int().min(1).max(B1_TASK_LIST_MAX_LIMIT).default(B1_TASK_LIST_DEFAULT_LIMIT),
  after: z.string().min(1).max(256).optional(),
});

function invalidCursorError(): DomainError {
  return new DomainError('INVALID_ARGUMENT', 'after cursor is malformed');
}

function encodeTaskListCursor(cursorTs: string, taskId: Id): string {
  const base64 = btoa(`${cursorTs}${TASK_LIST_CURSOR_DELIMITER}${taskId}`);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function isValidIsoTimestampString(cursorTs: string): boolean {
  if (!CURSOR_TIMESTAMP_REGEX.test(cursorTs)) {
    return false;
  }
  const secondIso = `${cursorTs.slice(0, 19)}Z`;
  const parsed = Date.parse(secondIso);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return new Date(parsed).toISOString().slice(0, 19) === secondIso.slice(0, 19);
}

function decodeTaskListCursor(raw: string): { readonly createdAt: string; readonly taskId: Id } {
  if (!TASK_LIST_CURSOR_REGEX.test(raw) || raw.length % 4 === 1) {
    throw invalidCursorError();
  }

  const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (base64.length % 4)) % 4;
  let decoded: string;
  try {
    decoded = atob(`${base64}${'='.repeat(paddingLength)}`);
  } catch {
    throw invalidCursorError();
  }

  const parts = decoded.split(TASK_LIST_CURSOR_DELIMITER);
  if (parts.length !== 2) {
    throw invalidCursorError();
  }

  const [createdAt, taskId] = parts;
  if (createdAt === undefined || taskId === undefined || !isValidIsoTimestampString(createdAt)) {
    throw invalidCursorError();
  }

  const parsedTaskId = IdSchema.safeParse(taskId);
  if (!parsedTaskId.success) {
    throw invalidCursorError();
  }

  // Reject non-canonical base64url bit encodings (e.g. unused trailing pad bits).
  if (encodeTaskListCursor(createdAt, parsedTaskId.data) !== raw) {
    throw invalidCursorError();
  }

  return { createdAt, taskId: parsedTaskId.data };
}

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

function toTaskSummary(row: TaskSummaryRow) {
  const status = TaskStatusSchema.parse(row.status);
  return {
    task_id: row.task_id,
    agent_id: row.agent_id,
    kind: row.kind,
    title: row.title,
    status,
    current_run_id: row.current_run_id,
    attempt_count: row.attempt_count,
    cancel_requested: row.cancel_requested_at !== null || status === 'cancelled',
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    deadline_at: row.deadline_at === null ? null : toIsoTimestamp(row.deadline_at),
  };
}

/**
 * Tenant-scoped B1 Task, Event, Cancellation & Result repository.
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
      ...(query?.after === undefined ? {} : { after: query.after }),
    });

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const cursor =
      parsed.data.after === undefined ? undefined : decodeTaskListCursor(parsed.data.after);

    try {
      const result = await this.pool.query<TaskSummaryRow>(LIST_TASKS_SQL, [
        parsed.data.tenantId,
        parsed.data.status ?? null,
        cursor?.createdAt ?? null,
        cursor?.taskId ?? null,
        parsed.data.limit + 1,
      ]);

      const hasMore = result.rows.length > parsed.data.limit;
      const pageRows = hasMore ? result.rows.slice(0, parsed.data.limit) : result.rows;
      const lastRow = pageRows[pageRows.length - 1];

      return B1TaskListDtoSchema.parse({
        tasks: pageRows.map((row) => toTaskSummary(row)),
        next_after:
          hasMore && lastRow !== undefined
            ? encodeTaskListCursor(lastRow.cursor_ts, lastRow.task_id)
            : null,
        has_more: hasMore,
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
      const result = await this.pool.query<TaskSummaryRow>(SELECT_TASK_SUMMARY_SQL, [
        parsed.data.tenantId,
        parsed.data.taskId,
      ]);
      const row = result.rows[0];

      if (row === undefined) {
        return null;
      }

      return B1TaskDetailDtoSchema.parse(toTaskSummary(row));
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async listTaskEvents(tenantId: Id, taskId: Id, after = 0): Promise<B1TaskEventPageDto | null> {
    const parsed = tenantTaskLookupSchema.safeParse({ tenantId, taskId });

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const page = parseListEventOptions({ after, limit: B1_TASK_EVENTS_PAGE_LIMIT });

    try {
      const visible = await this.pool.query(SELECT_TASK_EXISTS_SQL, [
        parsed.data.tenantId,
        parsed.data.taskId,
      ]);
      if (visible.rowCount !== 1) {
        return null;
      }

      const events = await queryTaskEvents(
        this.pool,
        parsed.data.tenantId,
        parsed.data.taskId,
        page,
      );

      let previousSequence = page.after;
      const mapped: TaskEventDto[] = [];
      for (const event of events) {
        if (
          event.taskId !== parsed.data.taskId ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence <= previousSequence
        ) {
          throw new DomainError('DB_UNAVAILABLE', 'persisted task event failed its contract');
        }
        mapped.push(toTaskEventDto(event));
        previousSequence = event.sequence;
      }

      return B1TaskEventPageDtoSchema.parse({
        task_id: parsed.data.taskId,
        events: mapped,
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async cancelTask(tenantId: Id, taskId: Id): Promise<B1TaskCancelDto | null> {
    const parsed = tenantTaskLookupSchema.safeParse({ tenantId, taskId });

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    try {
      const outcome = await withTransaction(this.pool, (client) =>
        cancelTaskInTransaction(client, parsed.data.tenantId, parsed.data.taskId),
      );

      if (outcome === null) {
        return null;
      }

      return B1TaskCancelDtoSchema.parse({
        task_id: outcome.taskId,
        status: outcome.status,
        cancel_requested: outcome.cancelRequested,
        cancel_requested_at: outcome.cancelRequestedAt,
        terminal: outcome.terminal,
        updated_at: outcome.updatedAt,
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }
}
