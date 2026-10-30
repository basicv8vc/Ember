import { isDomainError } from '@ember/domain';
import { Hono } from 'hono';
import type { ApprovalHttpStore } from './approvals/approval-store.js';
import { unconfiguredApprovalHttpStore } from './approvals/approval-store.js';
import { APPROVALS_PATH, createApprovalRoutes } from './approvals/routes.js';
import { requireTenantAuth } from './auth/auth-middleware.js';
import { createDevTokenAuthenticator, type DevAuthenticator } from './auth/bearer-authenticator.js';
import type { ArtifactHttpStore } from './artifacts/artifact-store.js';
import { unconfiguredArtifactHttpStore } from './artifacts/artifact-store.js';
import { createArtifactRoutes } from './artifacts/routes.js';
import {
  requestIdMiddleware,
  requestIdOf,
  type AppBindings,
  type RequestIdGenerator,
} from './http/app-context.js';
import {
  INTERNAL_ERROR_CODE,
  respondNotFound,
  respondWithDomainError,
  toInternalErrorResponse,
  UnexpectedNonErrorFault,
  unexpectedErrorCategory,
} from './http/error-mapping.js';
import type { Logger } from './logger.js';
import { notConfiguredReadiness, type ReadinessCheck } from './readiness.js';
import { TASKS_PATH } from './tasks/constants.js';
import { createTaskRoutes } from './tasks/routes.js';
import { unconfiguredTaskStore, type TaskStore } from './tasks/task-store.js';

export const SERVICE_NAME = 'ember-api';

export interface AppDependencies {
  /** Optional so the app can be constructed without a database (unit tests). */
  readonly readiness?: ReadinessCheck;
  readonly serviceVersion?: string;
  readonly now?: () => Date;
  /** Structured logger. Rejections and failures are logged; bodies and tokens never are. */
  readonly logger?: Logger;
  /** Test seam for deterministic request ids. */
  readonly requestIdGenerator?: RequestIdGenerator;
  /**
   * Tenant authenticator. Defaults to an empty credential set, so a misconfigured process
   * denies every `/v1` request instead of accepting anonymous traffic.
   */
  readonly authenticator?: DevAuthenticator;
  /** Task persistence. Defaults to a store that reports `DB_UNAVAILABLE` (503). */
  readonly taskStore?: TaskStore;
  /** Artifact persistence. Defaults to a store that reports `DB_UNAVAILABLE` (503). */
  readonly artifactStore?: ArtifactHttpStore;
  /** Approval persistence. Defaults to a store that reports `DB_UNAVAILABLE` (503). */
  readonly approvalStore?: ApprovalHttpStore;
}

/**
 * Build the Hono application without binding a socket.
 * The HTTP listener lives in `server.ts` / `index.ts`.
 *
 * Cross-cutting order matters and is fixed here:
 * 1. request id (every response, including errors, carries it);
 * 2. tenant authentication for `/v1/tasks` and `/v1/artifacts` — `/healthz` and `/readyz`
 *    stay unauthenticated because an orchestrator has no tenant credential;
 * 3. task and Artifact routes;
 * 4. one error mapper for the whole app.
 */
export function createApp(deps: AppDependencies = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const now = deps.now ?? (() => new Date());
  const readiness = deps.readiness ?? notConfiguredReadiness;
  const serviceVersion = deps.serviceVersion ?? '0.0.0';
  const logger = deps.logger;
  const authenticator = deps.authenticator ?? createDevTokenAuthenticator([]);
  const taskStore = deps.taskStore ?? unconfiguredTaskStore();
  const artifactStore = deps.artifactStore ?? unconfiguredArtifactHttpStore();
  const approvalStore = deps.approvalStore ?? unconfiguredApprovalHttpStore();
  const tenantAuth = requireTenantAuth({ authenticator, logger });

  /**
   * Error boundary, registered first so it encloses every other middleware and handler
   * (Review Round 1, P2). Hono's composer only routes `Error` instances to `onError`; a thrown
   * non-`Error` would otherwise escape this app entirely and be answered by the Node adapter
   * with an empty 500 and no log line. Normalising it here keeps every unknown fault on the
   * sanitised 500 body and the redacted log path below.
   */
  app.use('*', async (_c, next) => {
    try {
      await next();
    } catch (error) {
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  });

  app.use('*', requestIdMiddleware(deps.requestIdGenerator));

  /**
   * Liveness: the process can serve HTTP. Deliberately independent of PostgreSQL,
   * so a database outage never makes an orchestrator kill a healthy process.
   */
  app.get('/healthz', (c) =>
    c.json(
      {
        status: 'ok',
        service: SERVICE_NAME,
        version: serviceVersion,
        checkedAt: now().toISOString(),
      },
      200,
    ),
  );

  /** Readiness: required dependencies are usable. Distinct from liveness. */
  app.get('/readyz', async (c) => {
    const result = await readiness();
    return c.json(
      {
        status: result.status,
        checks: result.checks,
        checkedAt: now().toISOString(),
      },
      result.status === 'ready' ? 200 : 503,
    );
  });

  // Both registrations are needed for each base path: `use(path)` matches the collection
  // endpoint exactly, while `use(path + '/*')` matches parameterised routes below it.
  // Registering only the wildcard would leave `POST /v1/tasks` unauthenticated.
  app.use(TASKS_PATH, tenantAuth);
  app.use(`${TASKS_PATH}/*`, tenantAuth);
  app.use('/v1/artifacts', tenantAuth);
  app.use('/v1/artifacts/*', tenantAuth);
  app.use(APPROVALS_PATH, tenantAuth);
  app.use(`${APPROVALS_PATH}/*`, tenantAuth);
  app.route(TASKS_PATH, createTaskRoutes({ store: taskStore }));
  app.route('/v1', createArtifactRoutes({ artifacts: artifactStore, tasks: taskStore }));
  app.route(APPROVALS_PATH, createApprovalRoutes({ approvals: approvalStore }));

  // Unknown routes use the same `ErrorResponse` vocabulary as every other failure, so a
  // client never has to understand a second error format.
  app.notFound((c) => respondNotFound(c, 'no route matches this method and path'));

  app.onError((error, c) => {
    const requestId = requestIdOf(c);
    const route = { requestId, method: c.req.method, path: c.req.path };

    if (isDomainError(error)) {
      // Only the stable code is logged: `diagnostic` may contain SQL or row data.
      logger?.warn('request failed', { ...route, code: error.code });
      return respondWithDomainError(c, error);
    }

    // An unexpected fault is reported as a generic 500 and logged with a *closed* set of
    // fields only: the correlation id, the route, the fixed internal code and a category
    // derived from `instanceof`. `error.message`, `error.name`, `error.stack` and
    // `String(error)` are deliberately never read: a driver error can carry a connection
    // string or SQL text, and a thrown non-`Error` can carry a request body or a token.
    // `c.req.path` is the URL pathname only (Hono parses the query string off), so a
    // credential smuggled into `?…` never reaches this line.
    logger?.error('unhandled error', {
      ...route,
      code: INTERNAL_ERROR_CODE,
      category: unexpectedErrorCategory(error),
    });
    return c.json(toInternalErrorResponse(requestId), 500);
  });

  return app;
}
