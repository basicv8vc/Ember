import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../http/app-context.js';
import { requestIdOf } from '../http/app-context.js';
import { respondUnauthenticated } from '../http/error-mapping.js';
import type { Logger } from '../logger.js';
import type { SessionService } from './session-service.js';
import { parseSessionBearer } from './session-token.js';

/**
 * Session authentication for the new B1 endpoints (I-9).
 *
 * It resolves the presented `ems_` token through the injected session port and writes the
 * unchanged `AuthContext` into the request context. Handlers therefore read the tenant from
 * the verified session, never from a path, query, header or body field. This middleware is
 * deliberately NOT installed on the legacy Task/Agent/Artifact routes: those keep their
 * existing dev-token authenticator until the CTO composes a reviewed union authenticator.
 */
export interface SessionAuthOptions {
  readonly service: SessionService;
  readonly logger?: Pick<Logger, 'warn'>;
}

export function requireSessionAuth(options: SessionAuthOptions): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const parsed = parseSessionBearer(c.req.header('authorization'));

    if (!parsed.ok) {
      options.logger?.warn('session authentication rejected', {
        requestId: requestIdOf(c),
        method: c.req.method,
        path: c.req.path,
        code: 'UNAUTHENTICATED',
      });
      return respondUnauthenticated(c);
    }

    const resolved = await options.service.resolveActiveSession(parsed.token);

    if (resolved === null) {
      options.logger?.warn('session authentication rejected', {
        requestId: requestIdOf(c),
        method: c.req.method,
        path: c.req.path,
        code: 'UNAUTHENTICATED',
      });
      return respondUnauthenticated(c);
    }

    c.set('auth', resolved.auth);
    await next();
  };
}
