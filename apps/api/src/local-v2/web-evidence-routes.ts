import {
  IdSchema,
  V2ConversationWebEvidencePageSchema,
  type V2ConversationWebEvidencePage,
} from '@ember/contracts';
import { isDomainError, type Id } from '@ember/domain';
import { Hono } from 'hono';
import { requireSessionAuth } from '../auth/session-authenticator.js';
import type { SessionService } from '../auth/session-service.js';
import { parseMessagePageQuery, rejectClientScope } from '../conversation/message-read-routes.js';
import { requestIdOf, type AppBindings } from '../http/app-context.js';
import {
  INTERNAL_ERROR_CODE,
  UnexpectedNonErrorFault,
  respondInvalidArgument,
  respondWithDomainError,
  toInternalErrorResponse,
  unexpectedErrorCategory,
} from '../http/error-mapping.js';
import type { Logger } from '../logger.js';

export const V2_WEB_EVIDENCE_MOUNT_PATH = '/v2';
export const CONVERSATION_WEB_EVIDENCE_ROUTE_PATH = '/conversations/:conversationId/web-evidence';

export interface ConversationWebEvidenceReadRequest {
  readonly tenantId: Id;
  readonly conversationId: Id;
  readonly after: number;
  readonly limit: number;
}

export interface WebEvidenceRouteDependencies {
  readonly session: SessionService;
  readonly readWebEvidence: (
    request: ConversationWebEvidenceReadRequest,
  ) => Promise<V2ConversationWebEvidencePage>;
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
}

/**
 * V2 additive read route for persisted turn web evidence (Issue #302 PR A).
 * Shares session auth, tenant scope enforcement, and `after`/`limit` sequence cursor
 * validation with the frozen B1 message read route without altering B1 payloads.
 */
export function createWebEvidenceRoutes(deps: WebEvidenceRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();
  const guard = { service: deps.session, logger: deps.logger };

  routes.get(CONVERSATION_WEB_EVIDENCE_ROUTE_PATH, requireSessionAuth(guard), async (c) => {
    try {
      const rejected = rejectClientScope(c);
      if (rejected !== undefined) {
        return rejected;
      }

      const conversationId = IdSchema.safeParse(c.req.param('conversationId'));
      if (!conversationId.success) {
        return respondInvalidArgument(c, 'conversation_id must be a UUID');
      }

      const query = parseMessagePageQuery(new URL(c.req.url).searchParams);
      if (!query.ok) {
        return respondInvalidArgument(c, query.diagnostic);
      }

      const page = await deps.readWebEvidence({
        tenantId: c.get('auth').tenantId,
        conversationId: conversationId.data,
        after: query.after,
        limit: query.limit,
      });

      return c.json(V2ConversationWebEvidencePageSchema.parse(page), 200);
    } catch (error) {
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  });

  routes.onError((error, c) => {
    const route = { requestId: requestIdOf(c), method: c.req.method, path: c.req.path };

    if (isDomainError(error)) {
      deps.logger?.warn('conversation web evidence read rejected', { ...route, code: error.code });
      return respondWithDomainError(c, error);
    }

    deps.logger?.error('conversation web evidence read fault', {
      ...route,
      code: INTERNAL_ERROR_CODE,
      category: unexpectedErrorCategory(error),
    });

    return c.json(toInternalErrorResponse(requestIdOf(c)), 500);
  });

  return routes;
}
