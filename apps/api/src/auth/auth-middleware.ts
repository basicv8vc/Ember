import type { MiddlewareHandler } from 'hono';
import type { Logger } from '../logger.js';
import { requestIdOf, type AppBindings } from '../http/app-context.js';
import { respondUnauthenticated } from '../http/error-mapping.js';
import type { DevAuthenticator } from './bearer-authenticator.js';

/**
 * Tenant authentication middleware (P0B-07a).
 *
 * Placed on `/v1/*` before any route handler, so a request that fails authentication is
 * rejected before the handler can touch a repository, generate a task id or read a body.
 * The resulting `AuthContext` is written to the request context; route handlers read the
 * tenant from there and never from a path, query, header or body field.
 *
 * Rejections are logged with the reason and the request id only. The presented credential,
 * the `Authorization` header and the request body are never logged.
 */
export interface TenantAuthOptions {
  readonly authenticator: DevAuthenticator;
  readonly logger?: Pick<Logger, 'warn'>;
}

export function requireTenantAuth(options: TenantAuthOptions): MiddlewareHandler<AppBindings> {
  const logger = options.logger;

  return async (c, next) => {
    const result = options.authenticator.authenticate(c.req.header('authorization'));

    if (!result.ok) {
      logger?.warn('tenant authentication rejected', {
        requestId: requestIdOf(c),
        reason: result.reason,
        method: c.req.method,
        path: c.req.path,
      });

      return respondUnauthenticated(c);
    }

    c.set('auth', result.context);
    await next();
  };
}
