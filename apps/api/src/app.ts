import type {
  B1AssistantTurnRepository,
  B1ConversationRepository,
  B1TaskReadRepository,
  B1TaskResultRepository,
  B3StagedUploadRepository,
} from '@ember/contracts';
import { isDomainError } from '@ember/domain';
import { Hono, type MiddlewareHandler } from 'hono';
import { unconfiguredAgentStore, type AgentStore } from './agents/agent-store.js';
import { AGENTS_PATH } from './agents/constants.js';
import { createAgentRoutes } from './agents/routes.js';
import type { ApprovalHttpStore } from './approvals/approval-store.js';
import { unconfiguredApprovalHttpStore } from './approvals/approval-store.js';
import { APPROVALS_PATH, createApprovalRoutes } from './approvals/routes.js';
import type { B1SessionRuntime } from './auth/b1-auth-runtime.js';
import { requireTenantAuth } from './auth/auth-middleware.js';
import { createDevTokenAuthenticator, type DevAuthenticator } from './auth/bearer-authenticator.js';
import { createB1SessionRoutes, UNKNOWN_ROUTE_DIAGNOSTIC } from './auth/session-routes.js';
import { createConversationMessageReadRoutes } from './conversation/message-read-routes.js';
import { createConversationMessageWriteRoutes } from './conversation/message-write-routes.js';
import type { ArtifactHttpStore } from './artifacts/artifact-store.js';
import { unconfiguredArtifactHttpStore } from './artifacts/artifact-store.js';
import { createArtifactRoutes } from './artifacts/routes.js';
import { COMMITMENTS_PATH } from './commitments/constants.js';
import { createCommitmentRoutes } from './commitments/routes.js';
import {
  unconfiguredCommitmentStore,
  type CommitmentStore,
} from './commitments/commitment-store.js';
import { unconfiguredConsentStore, type ConsentHttpStore } from './consents/consent-store.js';
import { CONSENTS_PATH } from './consents/constants.js';
import { createConsentRoutes } from './consents/routes.js';
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
import { createB1TaskRoutes } from './tasks/b1-task-routes.js';
import { createTaskRoutes } from './tasks/routes.js';
import { unconfiguredTaskStore, type TaskStore } from './tasks/task-store.js';
import { createB1TurnRoutes } from './turns/turn-routes.js';
import { createB3UploadArtifactRoutes } from './uploads/b3-upload-artifact-routes.js';

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
  /** Agent persistence. Defaults to a store that reports `DB_UNAVAILABLE` (503). */
  readonly agentStore?: AgentStore;
  /** Task persistence. Defaults to a store that reports `DB_UNAVAILABLE` (503). */
  readonly taskStore?: TaskStore;
  /** Artifact persistence. Defaults to a store that reports `DB_UNAVAILABLE` (503). */
  readonly artifactStore?: ArtifactHttpStore;
  /** Approval persistence. Defaults to a store that reports `DB_UNAVAILABLE` (503). */
  readonly approvalStore?: ApprovalHttpStore;
  /** Commitment persistence. Defaults to a store that reports `DB_UNAVAILABLE` (503). */
  readonly commitmentStore?: CommitmentStore;
  /**
   * Consent persistence (P0-C3D). Defaults to a store that reports `DB_UNAVAILABLE` (503), so a
   * process without a database refuses to grant consent instead of falling back to "allow".
   */
  readonly consentStore?: ConsentHttpStore;
  /**
   * B1-2B authentication/session runtime. Optional by design: without explicitly injected
   * B1 ports the four new endpoints are not registered at all, so a process that has not
   * been wired to real repositories fails closed with 404 instead of minting sessions.
   * Legacy Task/Agent/Artifact authentication is deliberately left untouched.
   */
  readonly b1Session?: B1SessionRuntime;
  /** Conversation write runtime for the session-authenticated B1 message send route. */
  readonly b1ConversationWriteRepository?: Pick<B1ConversationRepository, 'submitUserMessage'>;
  /** Conversation read runtime for B1 transcript and Unknown ACK routes. */
  readonly b1ConversationReadRepository?: Pick<
    B1ConversationRepository,
    'readMessages' | 'findSubmissionReceipt'
  >;
  /** Turn read/cancel runtime for the session-authenticated B1 Turn routes. */
  readonly b1AssistantTurnRepository?: Pick<B1AssistantTurnRepository, 'getTurn' | 'cancelTurn'>;
  /** B1 session-authenticated Task result reader (`GET /v1/tasks/:taskId/result`). */
  readonly b1TaskResultRepository?: B1TaskResultRepository;
  /** B1 session-authenticated Task list/detail reader (`GET /v1/me/tasks*`). */
  readonly b1TaskReadRepository?: B1TaskReadRepository;
  /** B3 session-authenticated upload staging and Task artifact download repository. */
  readonly b3UploadRepository?: B3StagedUploadRepository;
}

/**
 * Build the Hono application without binding a socket.
 * The HTTP listener lives in `server.ts` / `index.ts`.
 *
 * Cross-cutting order matters and is fixed here:
 * 1. request id (every response, including errors, carries it);
 * 2. tenant authentication for every `/v1` surface (`agents`, `tasks`, `artifacts`,
 *    `approvals`, `commitments`, `consents`) — `/healthz` and `/readyz` stay unauthenticated
 *    because an orchestrator has no tenant credential;
 * 3. agent, task, Artifact, approval, commitment and consent routes;
 * 4. one error mapper for the whole app.
 */
export function createApp(deps: AppDependencies = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const now = deps.now ?? (() => new Date());
  const readiness = deps.readiness ?? notConfiguredReadiness;
  const serviceVersion = deps.serviceVersion ?? '0.0.0';
  const logger = deps.logger;
  const authenticator = deps.authenticator ?? createDevTokenAuthenticator([]);
  const agentStore = deps.agentStore ?? unconfiguredAgentStore();
  const taskStore = deps.taskStore ?? unconfiguredTaskStore();
  const artifactStore = deps.artifactStore ?? unconfiguredArtifactHttpStore();
  const approvalStore = deps.approvalStore ?? unconfiguredApprovalHttpStore();
  const commitmentStore = deps.commitmentStore ?? unconfiguredCommitmentStore();
  const consentStore = deps.consentStore ?? unconfiguredConsentStore();
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
  // Registering only the wildcard would leave `POST /v1/agents` and `POST /v1/tasks`
  // unauthenticated.
  const b1TaskDeps =
    deps.b1Session !== undefined &&
    deps.b1TaskResultRepository !== undefined &&
    deps.b1TaskReadRepository !== undefined
      ? {
          session: deps.b1Session.service,
          taskResults: deps.b1TaskResultRepository,
          taskReads: deps.b1TaskReadRepository,
          logger,
        }
      : null;

  app.use(AGENTS_PATH, tenantAuth);
  app.use(`${AGENTS_PATH}/*`, tenantAuth);
  app.use(TASKS_PATH, tenantAuth);
  const tasksWildcardAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
    if (
      b1TaskDeps !== null &&
      c.req.method === 'GET' &&
      /^\/v1\/tasks\/[^/]+\/result$/.test(c.req.path)
    ) {
      await next();
      return;
    }

    return tenantAuth(c, next);
  };
  app.use(`${TASKS_PATH}/*`, tasksWildcardAuth);
  app.use('/v1/artifacts', tenantAuth);
  app.use('/v1/artifacts/*', tenantAuth);
  app.use(APPROVALS_PATH, tenantAuth);
  app.use(`${APPROVALS_PATH}/*`, tenantAuth);
  app.use(COMMITMENTS_PATH, tenantAuth);
  app.use(`${COMMITMENTS_PATH}/*`, tenantAuth);
  app.use(CONSENTS_PATH, tenantAuth);
  app.use(`${CONSENTS_PATH}/*`, tenantAuth);
  app.route(AGENTS_PATH, createAgentRoutes({ store: agentStore }));
  app.route(TASKS_PATH, createTaskRoutes({ store: taskStore }));
  app.route(COMMITMENTS_PATH, createCommitmentRoutes({ store: commitmentStore }));
  app.route(CONSENTS_PATH, createConsentRoutes({ consents: consentStore }));
  app.route('/v1', createArtifactRoutes({ artifacts: artifactStore, tasks: taskStore }));
  app.route('/v1', createApprovalRoutes({ approvals: approvalStore, tasks: taskStore }));

  // B1-2B session routes are mounted only when a fully injected runtime exists. The paths do
  // not overlap any legacy `/v1` route, and legacy tenant authentication is not replaced:
  // a new Ember session token can never silently bypass the existing tenant checks.
  if (deps.b1Session !== undefined) {
    app.route('/v1', createB1SessionRoutes({ runtime: deps.b1Session, logger }));
  }

  // B1 Cloud Chat routes are mounted as one fail-closed group. The existing Session service is
  // their only authentication boundary; none of these routes join the legacy dev-token guard.
  // Requiring every port prevents a partial composition from exposing only some of the contract.
  if (
    deps.b1Session !== undefined &&
    deps.b1ConversationWriteRepository !== undefined &&
    deps.b1ConversationReadRepository !== undefined &&
    deps.b1AssistantTurnRepository !== undefined
  ) {
    app.route(
      '/v1',
      createConversationMessageWriteRoutes({
        session: deps.b1Session.service,
        conversations: deps.b1ConversationWriteRepository,
        logger,
      }),
    );
    app.route(
      '/v1',
      createConversationMessageReadRoutes({
        session: deps.b1Session.service,
        conversations: deps.b1ConversationReadRepository,
        logger,
      }),
    );
    app.route(
      '/v1',
      createB1TurnRoutes({
        repository: deps.b1AssistantTurnRepository,
        sessions: deps.b1Session.service,
        logger,
      }),
    );
  }

  if (b1TaskDeps !== null) {
    app.route('/v1', createB1TaskRoutes(b1TaskDeps));
  }

  if (deps.b1Session !== undefined && deps.b3UploadRepository !== undefined) {
    app.route(
      '/v1',
      createB3UploadArtifactRoutes({
        session: deps.b1Session.service,
        uploads: deps.b3UploadRepository,
        logger,
      }),
    );
  }

  // Unknown routes use the same `ErrorResponse` vocabulary as every other failure, so a
  // client never has to understand a second error format.
  app.notFound((c) => respondNotFound(c, UNKNOWN_ROUTE_DIAGNOSTIC));

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
