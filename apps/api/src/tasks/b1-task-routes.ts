import {
  B1TaskCancelDtoSchema,
  B1TaskDetailDtoSchema,
  B1TaskEventPageDtoSchema,
  B1TaskListDtoSchema,
  B1TaskResultDtoSchema,
  IdSchema,
  TaskStatusSchema,
  type B1TaskListQuery,
  type B1TaskReadRepository,
  type B1TaskResultRepository,
} from '@ember/contracts';
import { isDomainError, type Id, type TaskStatus } from '@ember/domain';
import { Hono } from 'hono';
import { requireSessionAuth } from '../auth/session-authenticator.js';
import type { SessionService } from '../auth/session-service.js';
import { requestIdOf, type AppBindings, type AppContext } from '../http/app-context.js';
import {
  INTERNAL_ERROR_CODE,
  UnexpectedNonErrorFault,
  respondInvalidArgument,
  respondNotFound,
  respondWithDomainError,
  toInternalErrorResponse,
  unexpectedErrorCategory,
} from '../http/error-mapping.js';
import type { Logger } from '../logger.js';

const CURSOR_PATTERN = /^\d{1,15}$/;

type CursorResult = { readonly ok: true; readonly after: number } | { readonly ok: false };

function parseAfterCursor(raw: string | undefined): CursorResult {
  if (raw === undefined) {
    return { ok: true, after: 0 };
  }

  if (!CURSOR_PATTERN.test(raw)) {
    return { ok: false };
  }

  const after = Number(raw);

  if (!Number.isSafeInteger(after)) {
    return { ok: false };
  }

  return { ok: true, after };
}

export const B1_TASK_LIST_MIN_LIMIT = 1;
export const B1_TASK_LIST_MAX_LIMIT = 50;

const STRICT_POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const MAX_TASK_LIST_CURSOR_LENGTH = 256;
const FORBIDDEN_SCOPE_QUERY_KEYS = [
  'tenant_id',
  'principal_id',
  'policy_version',
  'tenantId',
  'principalId',
  'policyVersion',
] as const;
const FORBIDDEN_SCOPE_HEADERS = ['x-tenant-id', 'x-principal-id', 'x-policy-version'] as const;

export interface B1TaskRouteDependencies {
  readonly session: SessionService;
  readonly taskResults: B1TaskResultRepository;
  readonly taskReads: B1TaskReadRepository;
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
}

type ParsedTaskListQuery =
  | { readonly ok: true; readonly query: B1TaskListQuery }
  | { readonly ok: false; readonly diagnostic: string };

function hasAnyQueryParam(searchParams: URLSearchParams): boolean {
  for (const _key of searchParams.keys()) {
    return true;
  }
  return false;
}

function rejectClientScope(c: AppContext): Response | undefined {
  const query = c.req.query();
  const hasQueryScope = FORBIDDEN_SCOPE_QUERY_KEYS.some((key) => query[key] !== undefined);
  const hasHeaderScope = FORBIDDEN_SCOPE_HEADERS.some(
    (header) => c.req.header(header) !== undefined,
  );

  if (hasQueryScope || hasHeaderScope) {
    return respondInvalidArgument(c, 'client-supplied identity scope fields are not allowed');
  }

  return undefined;
}

function parseTaskIdParam(c: AppContext): Id | Response {
  const parsed = IdSchema.safeParse(c.req.param('taskId'));
  if (!parsed.success) {
    return respondInvalidArgument(c, 'task_id must be a UUID');
  }
  return parsed.data;
}

function readValidatedTaskId(c: AppContext, queryDiagnostic: string): Id | Response {
  const rejected = rejectClientScope(c);
  if (rejected !== undefined) {
    return rejected;
  }

  if (hasAnyQueryParam(new URL(c.req.url).searchParams)) {
    return respondInvalidArgument(c, queryDiagnostic);
  }

  return parseTaskIdParam(c);
}

function parseTaskListQuery(searchParams: URLSearchParams): ParsedTaskListQuery {
  for (const key of searchParams.keys()) {
    if (key !== 'status' && key !== 'limit' && key !== 'after') {
      return {
        ok: false,
        diagnostic: 'only status, limit and after query parameters are allowed',
      };
    }
  }

  const statuses = searchParams.getAll('status');
  if (statuses.length > 1) {
    return { ok: false, diagnostic: 'status must appear at most once' };
  }

  let status: TaskStatus | undefined;
  if (statuses.length === 1) {
    const parsedStatus = TaskStatusSchema.safeParse(statuses[0]);
    if (!parsedStatus.success) {
      return { ok: false, diagnostic: 'status must be a valid task status' };
    }
    status = parsedStatus.data;
  }

  const limits = searchParams.getAll('limit');
  if (limits.length > 1) {
    return { ok: false, diagnostic: 'limit must appear at most once' };
  }

  let limit: number | undefined;
  if (limits.length === 1) {
    const rawLimit = limits[0]!;
    if (!STRICT_POSITIVE_INTEGER.test(rawLimit)) {
      return {
        ok: false,
        diagnostic: `limit must be an integer from ${B1_TASK_LIST_MIN_LIMIT} to ${B1_TASK_LIST_MAX_LIMIT}`,
      };
    }
    const parsedLimit = Number(rawLimit);
    if (
      !Number.isSafeInteger(parsedLimit) ||
      parsedLimit < B1_TASK_LIST_MIN_LIMIT ||
      parsedLimit > B1_TASK_LIST_MAX_LIMIT
    ) {
      return {
        ok: false,
        diagnostic: `limit must be an integer from ${B1_TASK_LIST_MIN_LIMIT} to ${B1_TASK_LIST_MAX_LIMIT}`,
      };
    }
    limit = parsedLimit;
  }

  const afterValues = searchParams.getAll('after');
  if (afterValues.length > 1) {
    return { ok: false, diagnostic: 'after must appear at most once' };
  }

  let after: string | undefined;
  if (afterValues.length === 1) {
    const rawAfter = afterValues[0]!;
    if (rawAfter.length === 0 || rawAfter.length > MAX_TASK_LIST_CURSOR_LENGTH) {
      return { ok: false, diagnostic: 'after cursor is malformed' };
    }
    after = rawAfter;
  }

  return {
    ok: true,
    query: {
      ...(status === undefined ? {} : { status }),
      ...(limit === undefined ? {} : { limit }),
      ...(after === undefined ? {} : { after }),
    },
  };
}

function parseTaskEventAfterQuery(
  searchParams: URLSearchParams,
):
  | { readonly ok: true; readonly after: number }
  | { readonly ok: false; readonly diagnostic: string } {
  for (const key of searchParams.keys()) {
    if (key !== 'after') {
      return { ok: false, diagnostic: 'only after query parameter is allowed' };
    }
  }

  const afterValues = searchParams.getAll('after');
  if (afterValues.length > 1) {
    return { ok: false, diagnostic: 'after must appear at most once' };
  }

  const cursor = parseAfterCursor(afterValues[0]);
  if (!cursor.ok) {
    return { ok: false, diagnostic: 'after must be a non-negative integer cursor' };
  }

  return { ok: true, after: cursor.after };
}

/**
 * B1 Session-authenticated Task, Event, Cancellation & Task Result endpoints:
 * - `GET /v1/tasks/:taskId/result`
 * - `GET /v1/me/tasks`
 * - `GET /v1/me/tasks/:taskId`
 * - `GET /v1/me/tasks/:taskId/events`
 * - `GET /v1/me/tasks/:taskId/result`
 * - `POST /v1/me/tasks/:taskId/cancel`
 */
export function createB1TaskRoutes(deps: B1TaskRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();
  const sessionAuth = requireSessionAuth({ service: deps.session, logger: deps.logger });

  async function handleTaskResult(c: AppContext): Promise<Response> {
    try {
      const taskId = readValidatedTaskId(c, 'task result lookup takes no query parameters');
      if (taskId instanceof Response) {
        return taskId;
      }

      const result = await deps.taskResults.getTaskResult(c.get('auth').tenantId, taskId);
      if (result === null) {
        return respondNotFound(c, 'task is not visible in this tenant');
      }

      return c.json(B1TaskResultDtoSchema.parse(result), 200);
    } catch (error) {
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  }

  routes.get('/tasks/:taskId/result', sessionAuth, handleTaskResult);
  routes.get('/me/tasks/:taskId/result', sessionAuth, handleTaskResult);

  routes.get('/me/tasks', sessionAuth, async (c) => {
    try {
      const rejected = rejectClientScope(c);
      if (rejected !== undefined) {
        return rejected;
      }

      const parsedQuery = parseTaskListQuery(new URL(c.req.url).searchParams);
      if (!parsedQuery.ok) {
        return respondInvalidArgument(c, parsedQuery.diagnostic);
      }

      const list = await deps.taskReads.listTasks(c.get('auth').tenantId, parsedQuery.query);
      return c.json(B1TaskListDtoSchema.parse(list), 200);
    } catch (error) {
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  });

  routes.get('/me/tasks/:taskId', sessionAuth, async (c) => {
    try {
      const taskId = readValidatedTaskId(c, 'task detail lookup takes no query parameters');
      if (taskId instanceof Response) {
        return taskId;
      }

      const detail = await deps.taskReads.getTaskDetail(c.get('auth').tenantId, taskId);
      if (detail === null) {
        return respondNotFound(c, 'task is not visible in this tenant');
      }

      return c.json(B1TaskDetailDtoSchema.parse(detail), 200);
    } catch (error) {
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  });

  routes.get('/me/tasks/:taskId/events', sessionAuth, async (c) => {
    try {
      const rejected = rejectClientScope(c);
      if (rejected !== undefined) {
        return rejected;
      }

      const parsedQuery = parseTaskEventAfterQuery(new URL(c.req.url).searchParams);
      if (!parsedQuery.ok) {
        return respondInvalidArgument(c, parsedQuery.diagnostic);
      }

      const taskId = parseTaskIdParam(c);
      if (taskId instanceof Response) {
        return taskId;
      }

      const page = await deps.taskReads.listTaskEvents(
        c.get('auth').tenantId,
        taskId,
        parsedQuery.after,
      );
      if (page === null) {
        return respondNotFound(c, 'task is not visible in this tenant');
      }

      return c.json(B1TaskEventPageDtoSchema.parse(page), 200);
    } catch (error) {
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  });

  routes.post('/me/tasks/:taskId/cancel', sessionAuth, async (c) => {
    try {
      const taskId = readValidatedTaskId(c, 'task cancellation takes no query parameters');
      if (taskId instanceof Response) {
        return taskId;
      }

      const outcome = await deps.taskReads.cancelTask(c.get('auth').tenantId, taskId);
      if (outcome === null) {
        return respondNotFound(c, 'task is not visible in this tenant');
      }

      return c.json(B1TaskCancelDtoSchema.parse(outcome), outcome.terminal ? 200 : 202);
    } catch (error) {
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  });

  routes.onError((error, c) => {
    const route = { requestId: requestIdOf(c), method: c.req.method, path: c.req.path };

    if (isDomainError(error)) {
      deps.logger?.warn('b1 task read rejected', { ...route, code: error.code });
      return respondWithDomainError(c, error);
    }

    deps.logger?.error('b1 task read fault', {
      ...route,
      code: INTERNAL_ERROR_CODE,
      category: unexpectedErrorCategory(error),
    });

    return c.json(toInternalErrorResponse(requestIdOf(c)), 500);
  });

  return routes;
}
