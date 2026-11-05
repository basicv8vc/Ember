import { B1AssistantTurnDtoSchema, IdSchema } from '@ember/contracts';
import { Hono } from 'hono';
import type { B1AssistantTurnRepository } from '@ember/postgres';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { respondInvalidArgument, respondNotFound } from '../http/error-mapping.js';
import type { Logger } from '../logger.js';
import { requireSessionAuth } from '../auth/session-authenticator.js';
import type { SessionService } from '../auth/session-service.js';

const FORBIDDEN_SCOPE_HEADERS = ['x-tenant-id', 'x-principal-id', 'x-policy-version'] as const;
const FORBIDDEN_SCOPE_QUERY_KEYS = [
  'tenant_id',
  'principal_id',
  'policy_version',
  'tenantId',
  'principalId',
  'policyVersion',
] as const;

export interface B1TurnRouteDependencies {
  readonly repository: Pick<B1AssistantTurnRepository, 'getTurn' | 'cancelTurn'>;
  readonly sessions: SessionService;
  readonly logger?: Pick<Logger, 'warn'>;
}

/**
 * Injectable B1 polling/cancellation routes. Mount at `/v1` from the reviewed composition root;
 * B1 intentionally adds no Turn SSE or WebSocket endpoint.
 */
export function createB1TurnRoutes(deps: B1TurnRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();
  routes.use('*', requireSessionAuth({ service: deps.sessions, logger: deps.logger }));

  routes.get('/conversations/:conversation_id/turns/:turn_id', async (c) => {
    const rejected = rejectUnexpectedTurnInput(c);

    if (rejected !== undefined) {
      return rejected;
    }

    const identity = parseTurnIdentity(c);

    if (identity instanceof Response) {
      return identity;
    }

    const turn = await deps.repository.getTurn({
      tenantId: c.get('auth').tenantId,
      conversationId: identity.conversationId,
      turnId: identity.turnId,
    });

    if (turn === null) {
      return respondNotFound(c, 'turn is not visible in this tenant');
    }

    return c.json(B1AssistantTurnDtoSchema.parse(turn), 200);
  });

  routes.post('/conversations/:conversation_id/turns/:turn_id/cancel', async (c) => {
    const rejected = rejectUnexpectedTurnInput(c);

    if (rejected !== undefined) {
      return rejected;
    }

    const identity = parseTurnIdentity(c);

    if (identity instanceof Response) {
      return identity;
    }

    const turn = await deps.repository.cancelTurn({
      tenantId: c.get('auth').tenantId,
      conversationId: identity.conversationId,
      turnId: identity.turnId,
    });

    // The repository returns the same terminal row on repeat cancellation, so this stays 200.
    return c.json(B1AssistantTurnDtoSchema.parse(turn), 200);
  });

  return routes;
}

function parseTurnIdentity(
  c: AppContext,
): { readonly conversationId: string; readonly turnId: string } | Response {
  const conversationId = IdSchema.safeParse(c.req.param('conversation_id'));

  if (!conversationId.success) {
    return respondInvalidArgument(c, 'conversation_id must be a UUID');
  }

  const turnId = IdSchema.safeParse(c.req.param('turn_id'));

  if (!turnId.success) {
    return respondInvalidArgument(c, 'turn_id must be a UUID');
  }

  return { conversationId: conversationId.data, turnId: turnId.data };
}

/** No caller-selected scope, query options, or body is part of either frozen Turn operation. */
function rejectUnexpectedTurnInput(c: AppContext): Response | undefined {
  const url = new URL(c.req.url);
  const hasForbiddenScope =
    FORBIDDEN_SCOPE_QUERY_KEYS.some((key) => url.searchParams.has(key)) ||
    FORBIDDEN_SCOPE_HEADERS.some((header) => c.req.header(header) !== undefined);
  const hasQuery = url.searchParams.size > 0;
  const declaredLength = Number(c.req.header('content-length') ?? 0);
  const hasBody =
    c.req.raw.body !== null ||
    (Number.isFinite(declaredLength) && declaredLength > 0) ||
    c.req.header('transfer-encoding') !== undefined;

  if (hasForbiddenScope) {
    return respondInvalidArgument(c, 'client-supplied identity scope fields are not allowed');
  }

  if (hasQuery || hasBody) {
    return respondInvalidArgument(c, 'Turn routes do not accept a query string or request body');
  }

  return undefined;
}
