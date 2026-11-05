import { B1MeResponseSchema, B1SessionRequestSchema } from '@ember/contracts';
import { Hono } from 'hono';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { requestIdOf } from '../http/app-context.js';
import { readJsonBody, type BodyRejectionReason } from '../http/bounded-body.js';
import {
  respondInvalidArgument,
  respondNotFound,
  respondUnauthenticated,
} from '../http/error-mapping.js';
import type { Logger } from '../logger.js';
import type { B1SessionRuntime } from './b1-auth-runtime.js';
import { requireSessionAuth } from './session-authenticator.js';
import { MAX_SESSION_REQUEST_BYTES } from './session-service.js';
import { parseSessionBearer } from './session-token.js';

/**
 * The four frozen B1-2B endpoints (ADR-0004 §4.1 rows 1-4, annex §5).
 *
 * | method   | path                            | success | authentication          |
 * | -------- | ------------------------------- | ------- | ----------------------- |
 * | POST     | `/v1/auth/session`              | 201     | public (provider proof) |
 * | POST     | `/v1/auth/session/refresh`      | 200     | current Ember token     |
 * | DELETE   | `/v1/auth/session`              | 204     | current Ember token     |
 * | GET      | `/v1/me`                       | 200     | current Ember token     |
 *
 * No other consumer endpoint is registered. `refresh`/`logout` never re-read an Apple
 * assertion (I-7). All failures use the existing closed DomainError → ErrorResponse mapper.
 */

export const SESSION_PATH = '/v1/auth/session';
export const SESSION_REFRESH_PATH = '/v1/auth/session/refresh';
export const ME_PATH = '/v1/me';

/** Shared with `app.notFound`, so a refused dev path is byte-identical to an unknown route. */
export const UNKNOWN_ROUTE_DIAGNOSTIC = 'no route matches this method and path';

const BODY_REJECTION_MESSAGES: Readonly<Record<BodyRejectionReason, string>> = Object.freeze({
  missing_content_type: 'Content-Type must be application/json',
  unsupported_content_type: 'Content-Type must be application/json',
  empty_body: 'request body must be a JSON object',
  too_large: `request body must not exceed ${MAX_SESSION_REQUEST_BYTES} bytes`,
  invalid_encoding: 'request body must be UTF-8 encoded JSON',
  invalid_json: 'request body must be valid JSON',
});

const FORBIDDEN_SCOPE_QUERY_KEYS = [
  'tenant_id',
  'principal_id',
  'policy_version',
  'tenantId',
  'principalId',
  'policyVersion',
] as const;

const FORBIDDEN_SCOPE_HEADERS = ['x-tenant-id', 'x-principal-id', 'x-policy-version'] as const;

/**
 * I-1: a client-supplied identity scope field must be REJECTED, never ignored. The request
 * body uses a strict schema; query strings and headers are checked here. Protected routes
 * additionally have no request body at all, so a smuggled body is refused before any handler
 * can accidentally read it.
 */
async function hasRequestBody(request: Request): Promise<boolean> {
  const declaredLength = request.headers.get('content-length');
  if (
    request.headers.get('transfer-encoding') !== null ||
    (declaredLength !== null && declaredLength.trim() !== '0')
  ) {
    return true;
  }

  if (request.body === null) {
    return false;
  }

  // Framework adapters may expose an empty ReadableStream for a body-capable method even
  // when the peer sent no bytes. Probe it so empty streams remain valid, while a body without
  // framing headers (as used by in-process Request fixtures) is still rejected.
  const reader = request.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return false;
      }
      if (chunk.value instanceof Uint8Array && chunk.value.byteLength > 0) {
        await reader.cancel();
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function rejectClientScope(c: AppContext, allowBody: boolean): Promise<Response | undefined> {
  const query = c.req.query();
  const hasScopeField =
    FORBIDDEN_SCOPE_QUERY_KEYS.some((key) => query[key] !== undefined) ||
    FORBIDDEN_SCOPE_HEADERS.some((header) => c.req.header(header) !== undefined);
  const hasUnexpectedBody = !allowBody && (await hasRequestBody(c.req.raw));

  return hasScopeField || (!allowBody && hasUnexpectedBody)
    ? respondInvalidArgument(c, 'client-supplied identity scope fields are not allowed')
    : undefined;
}

export interface B1SessionRouteDependencies {
  readonly runtime: B1SessionRuntime;
  readonly logger?: Pick<Logger, 'warn'>;
}

export function createB1SessionRoutes(deps: B1SessionRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();
  const runtime = deps.runtime;
  const logger = deps.logger;

  const logRejection = (message: string, c: AppContext, fields: Record<string, string>): void => {
    logger?.warn(message, {
      requestId: requestIdOf(c),
      method: c.req.method,
      path: c.req.path,
      ...fields,
    });
  };

  routes.post('/auth/session', async (c) => {
    const rejected = await rejectClientScope(c, true);

    if (rejected !== undefined) {
      return rejected;
    }

    const body = await readJsonBody(c.req.raw, MAX_SESSION_REQUEST_BYTES);

    if (!body.ok) {
      return respondInvalidArgument(c, BODY_REJECTION_MESSAGES[body.reason]);
    }

    const request = B1SessionRequestSchema.safeParse(body.value);

    if (!request.success) {
      // Strict schema: extra fields such as tenant_id, principal_id or policy_version are
      // rejected, not ignored (I-1).
      return respondInvalidArgument(c, 'request body does not match the session schema');
    }

    const { provider, identity_token, nonce } = request.data;

    // R-9: when any guard fails the dev path does not exist. 404 equals an unknown route,
    // so a misconfigured staging box does not advertise the capability.
    if (provider === 'dev' && !runtime.devProvider.evaluate().enabled) {
      return respondNotFound(c, UNKNOWN_ROUTE_DIAGNOSTIC);
    }

    const verifier = provider === 'apple' ? runtime.appleVerifier : runtime.devVerifier;
    const identity = await verifier.verify({ identityToken: identity_token, nonce });

    if (identity === null) {
      logRejection('identity verification rejected', c, { provider, code: 'UNAUTHENTICATED' });
      return respondUnauthenticated(c);
    }

    const dto = await runtime.service.createSession(identity);
    return c.json(dto, 201);
  });

  routes.post('/auth/session/refresh', async (c) => {
    const rejected = await rejectClientScope(c, false);

    if (rejected !== undefined) {
      return rejected;
    }

    const parsed = parseSessionBearer(c.req.header('authorization'));

    if (!parsed.ok) {
      logRejection('session authentication rejected', c, { code: 'UNAUTHENTICATED' });
      return respondUnauthenticated(c);
    }

    const dto = await runtime.service.refreshSession(parsed.token);

    if (dto === null) {
      logRejection('session rotation rejected', c, { code: 'UNAUTHENTICATED' });
      return respondUnauthenticated(c);
    }

    return c.json(dto, 200);
  });

  routes.delete('/auth/session', async (c) => {
    const rejected = await rejectClientScope(c, false);

    if (rejected !== undefined) {
      return rejected;
    }

    const parsed = parseSessionBearer(c.req.header('authorization'));

    if (!parsed.ok) {
      logRejection('session authentication rejected', c, { code: 'UNAUTHENTICATED' });
      return respondUnauthenticated(c);
    }

    await runtime.service.logout(parsed.token);
    return c.body(null, 204);
  });

  routes.get('/me', requireSessionAuth({ service: runtime.service, logger }), async (c) => {
    const rejected = await rejectClientScope(c, false);

    if (rejected !== undefined) {
      return rejected;
    }

    const auth = c.get('auth');
    const projection = await runtime.me.getMeForTenant(auth.tenantId);

    if (projection === null) {
      // Same 404 body as a genuinely absent resource (ISO-3). No "create" branch exists:
      // I-4 guarantees provisioning inside session creation.
      return respondNotFound(c, 'resource is not visible in this tenant');
    }

    return c.json(B1MeResponseSchema.parse(projection), 200);
  });

  return routes;
}
