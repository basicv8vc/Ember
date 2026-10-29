import { DomainError, type DomainErrorCode } from '@ember/domain';
import { toErrorResponse, type ErrorResponse } from '@ember/contracts';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { requestIdOf, type AppContext } from './app-context.js';

/**
 * HTTP mapping for stable domain error codes (P0B-07a).
 *
 * P0B-02 defined the `ErrorResponse` *shape* and deliberately left status mapping open
 * (`OQ-8`); this module is that mapping. It is a closed table with no heuristics:
 *
 * | code                      | status | meaning in the P0-B slice                          |
 * | ------------------------- | ------ | -------------------------------------------------- |
 * | INVALID_ARGUMENT          | 400    | schema/query/header values are not acceptable      |
 * | UNAUTHENTICATED           | 401    | missing, malformed or unknown bearer token         |
 * | POLICY_DENIED             | 403    | authenticated but not allowed (reserved, P0B-08)   |
 * | NOT_FOUND                 | 404    | not visible to this tenant, or no such route       |
 * | IDEMPOTENCY_CONFLICT      | 409    | same key, different command payload                |
 * | WORKSPACE_VERSION_CONFLICT| 409    | stale workspace version (reserved, P0B-06)         |
 * | STALE_LEASE               | 409    | fencing rejection (reserved, P0B-04)               |
 * | INVALID_STATE_TRANSITION  | 409    | state machine rejection (reserved)                 |
 * | CANCELLED                 | 409    | cancelled operation (reserved, P0B-08)             |
 * | BUDGET_EXCEEDED           | 429    | budget guard (reserved, P0B-08)                    |
 * | MOCK_TOOL_FAILED          | 502    | simulated tool failure (reserved, P0B-05)          |
 * | DB_UNAVAILABLE            | 503    | PostgreSQL unreachable/timed out                   |
 * | SANDBOX_NOT_READY         | 503    | sandbox preparation failed (reserved, P0B-05)      |
 * | EXECUTION_TIMEOUT         | 504    | execution exceeded its budget (reserved)           |
 * | DEADLINE_EXCEEDED         | 504    | task deadline passed (reserved, P0B-04)            |
 *
 * Cross-tenant reads are reported as `NOT_FOUND`, never `POLICY_DENIED` or `FORBIDDEN`: the
 * API must not confirm that an identifier exists in another tenant.
 *
 * Bodies are produced by `toErrorResponse`, so the public message is the fixed text chosen
 * by the code. Internal diagnostics, SQL text, driver messages and stack traces are dropped.
 */

/** Every code in the closed table. Used by tests to prove the table is total. */
export const HTTP_STATUS_BY_DOMAIN_ERROR: Readonly<Record<DomainErrorCode, ContentfulStatusCode>> =
  Object.freeze({
    INVALID_ARGUMENT: 400,
    UNAUTHENTICATED: 401,
    POLICY_DENIED: 403,
    NOT_FOUND: 404,
    IDEMPOTENCY_CONFLICT: 409,
    WORKSPACE_VERSION_CONFLICT: 409,
    STALE_LEASE: 409,
    INVALID_STATE_TRANSITION: 409,
    CANCELLED: 409,
    BUDGET_EXCEEDED: 429,
    MOCK_TOOL_FAILED: 502,
    DB_UNAVAILABLE: 503,
    SANDBOX_NOT_READY: 503,
    EXECUTION_TIMEOUT: 504,
    DEADLINE_EXCEEDED: 504,
  });

/**
 * The only error code outside the frozen `DomainErrorCode` vocabulary, used for the one case
 * the domain cannot describe: the API itself failed unexpectedly (> 500 bug). It is never
 * produced for a client-caused failure and its body never contains a message from the fault.
 */
export const INTERNAL_ERROR_CODE = 'internal_error';

export interface InternalErrorResponse {
  readonly error: {
    readonly code: typeof INTERNAL_ERROR_CODE;
    readonly message: string;
    readonly request_id?: string;
  };
}

/** Fixed, non-diagnostic 500 body. */
export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

export function toInternalErrorResponse(requestId: string | undefined): InternalErrorResponse {
  const error = { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE } as const;
  return requestId === undefined ? { error } : { error: { ...error, request_id: requestId } };
}

export function statusForDomainError(code: DomainErrorCode): ContentfulStatusCode {
  return HTTP_STATUS_BY_DOMAIN_ERROR[code];
}

/**
 * Render a `DomainError` as an HTTP response.
 *
 * The request id is read from the context, not from the error, so a correlation id cannot be
 * forged by whatever produced the failure.
 */
export function respondWithDomainError(c: AppContext, error: DomainError): Response {
  const body: ErrorResponse = toErrorResponse(error, requestIdOf(c));
  // The request-id middleware already set the response header, so it is present on this
  // response as well; the body carries the same value for clients that only log bodies.
  return c.json(body, statusForDomainError(error.code));
}

/** 401 for a rejected credential. Covers every auth failure reason with one body. */
export function respondUnauthenticated(c: AppContext): Response {
  return respondWithDomainError(
    c,
    new DomainError('UNAUTHENTICATED', 'Request has no valid tenant credential'),
  );
}

/** 404 that never reveals whether an identifier exists for a different tenant. */
export function respondNotFound(c: AppContext, diagnostic: string): Response {
  return respondWithDomainError(c, new DomainError('NOT_FOUND', diagnostic));
}

/** 400 with a caller-facing reason (already free of internal detail). */
export function respondInvalidArgument(c: AppContext, diagnostic: string): Response {
  return respondWithDomainError(c, new DomainError('INVALID_ARGUMENT', diagnostic));
}
