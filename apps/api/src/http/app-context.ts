import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@ember/domain';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Per-request context shared by middleware and route handlers (P0B-07a).
 *
 * `requestId` and `auth` are the only values the HTTP layer may trust: the first is
 * generated here, the second is produced by the authenticator. Neither is ever read from a
 * client-supplied field.
 */

/** Response header carrying the server-generated correlation id. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Upper bound accepted by `ErrorResponseSchema.request_id`. */
const MAX_REQUEST_ID_LENGTH = 128;

export interface AppVariables {
  /** Server-generated correlation id. Never derived from an inbound header. */
  requestId: string;
  /** Verified caller identity. Only set on routes guarded by the auth middleware. */
  auth: AuthContext;
}

export interface AppBindings {
  Variables: AppVariables;
}

export type AppContext = Context<AppBindings>;

export type RequestIdGenerator = () => string;

/** Default generator: a random UUID, so ids are unguessable and reveal nothing. */
export const generateRequestId: RequestIdGenerator = () => randomUUID();

function normalizeRequestId(generate: RequestIdGenerator): string {
  const candidate = generate();

  // A broken/injected generator must not produce an empty or oversized correlation id.
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate.length > MAX_REQUEST_ID_LENGTH
  ) {
    return randomUUID();
  }

  return candidate;
}

/**
 * Attach a request id to every request and echo it on every response.
 *
 * The value is stored in the context (for error bodies and logs) and set as a response
 * header before the downstream handler runs, so success *and* error responses carry it.
 * An inbound `X-Request-Id` is deliberately ignored: a client cannot choose the id that
 * appears in logs, and a spoofed value can never be confused with a server-issued one.
 */
export function requestIdMiddleware(
  generate: RequestIdGenerator = generateRequestId,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const requestId = normalizeRequestId(generate);
    c.set('requestId', requestId);
    c.header(REQUEST_ID_HEADER, requestId);
    await next();
  };
}

/**
 * Read the request id from the context.
 *
 * Returns `undefined` when the middleware has not run (for example a request rejected by
 * the runtime before dispatch), so callers never emit `request_id: ""`.
 */
export function requestIdOf(c: AppContext): string | undefined {
  const value: string | undefined = c.get('requestId');
  return value === undefined || value === '' ? undefined : value;
}
