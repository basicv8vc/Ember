import { TaskEventSchema } from '@ember/contracts';
import { DomainError, type Id, type TaskEvent } from '@ember/domain';
import type pg from 'pg';
import { toIsoTimestamp } from './support.js';

interface TaskEventRow {
  readonly task_id: string;
  readonly sequence: number;
  readonly phase: string;
  readonly occurred_at: Date | string;
  readonly trace_id: string;
  readonly payload: unknown;
}

/** Hard ceiling for one event read; HTTP endpoints bound pages further. */
export const TASK_EVENT_MAX_PAGE_SIZE = 1_000;

/** Default page size when a caller requests a page without a limit. */
export const TASK_EVENT_DEFAULT_PAGE_SIZE = 100;

/**
 * Optional paging for persisted task event reads.
 *
 * `after` is exclusive (`sequence > after`) so repeated polling never skips or duplicates events.
 */
export interface ListEventOptions {
  readonly after?: number;
  readonly limit?: number;
}

const LIST_EVENTS_SQL = `
SELECT task_id, sequence, phase, occurred_at, trace_id, payload
  FROM task_events
 WHERE tenant_id = $1 AND task_id = $2
 ORDER BY sequence ASC
`;

const LIST_EVENT_PAGE_SQL = `
SELECT task_id, sequence, phase, occurred_at, trace_id, payload
  FROM task_events
 WHERE tenant_id = $1 AND task_id = $2 AND sequence > $3
 ORDER BY sequence ASC
 LIMIT $4
`;

export function parseListEventOptions(options: ListEventOptions): {
  readonly after: number;
  readonly limit: number;
} {
  const after = options.after ?? 0;
  const limit = options.limit ?? TASK_EVENT_DEFAULT_PAGE_SIZE;

  if (!Number.isSafeInteger(after) || after < 0) {
    throw new DomainError('INVALID_ARGUMENT', 'event cursor must be a non-negative integer');
  }

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TASK_EVENT_MAX_PAGE_SIZE) {
    throw new DomainError('INVALID_ARGUMENT', 'event page limit is out of range');
  }

  return { after, limit };
}

/**
 * Query durable `task_events` rows in ascending sequence order and validate each row against
 * `TaskEventSchema`. Keeps zero `node:*` imports so Cloudflare Workers can reuse it.
 */
export async function queryTaskEvents(
  executor: pg.Pool | pg.PoolClient,
  tenantId: Id,
  taskId: Id,
  options?: ListEventOptions,
): Promise<readonly TaskEvent[]> {
  const page = options === undefined ? undefined : parseListEventOptions(options);
  const result =
    page === undefined
      ? await executor.query<TaskEventRow>(LIST_EVENTS_SQL, [tenantId, taskId])
      : await executor.query<TaskEventRow>(LIST_EVENT_PAGE_SQL, [
          tenantId,
          taskId,
          page.after,
          page.limit,
        ]);

  return result.rows.map((row) => {
    const parsed = TaskEventSchema.safeParse({
      taskId: row.task_id,
      sequence: row.sequence,
      phase: row.phase,
      occurredAt: toIsoTimestamp(row.occurred_at),
      traceId: row.trace_id,
      payload: row.payload,
    });

    if (!parsed.success) {
      throw new DomainError('DB_UNAVAILABLE', 'persisted task event failed its contract');
    }

    return parsed.data;
  });
}
