import {
  B1TaskDetailDtoSchema,
  B1TaskListDtoSchema,
  B1TaskResultDtoSchema,
  IdSchema,
  TaskStatusSchema,
} from '@ember/contracts';
import { isDomainError, type Id, type TaskStatus } from '@ember/domain';
import type {
  B1TaskListQuery,
  B1TaskReadRepository,
  B1TaskResultRepository,
} from '@ember/postgres';
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

export const B1_TASK_LIST_MIN_LIMIT = 1;
export const B1_TASK_LIST_MAX_LIMIT = 50;

const STRICT_POSITIVE_INTEGER = /^[1-9][0-9]*$/;
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
    if (key !== 'status' && key !== 'limit') {
      return { ok: false, diagnostic: 'only status and limit query parameters are allowed' };
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

  return {
    ok: true,
    query: {
      ...(status === undefined ? {} : { status }),
      ...(limit === undefined ? {} : { limit }),
    },
  };
}

/**
 * B1 Session-authenticated Task & Task Result read endpoints:
 * - `GET /v1/tasks/:taskId/result`
 * - `GET /v1/me/tasks`
 * - `GET /v1/me/tasks/:taskId`
 */
export function createB1TaskRoutes(deps: B1TaskRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();
  const sessionAuth = requireSessionAuth({ service: deps.session, logger: deps.logger });

  routes.get('/tasks/:taskId/result', sessionAuth, async (c) => {
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
  });

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
