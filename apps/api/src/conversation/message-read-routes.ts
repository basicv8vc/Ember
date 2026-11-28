import {
  B1ConversationPageSchema,
  B1SendMessageReceiptSchema,
  IdSchema,
  type B1ConversationRepository,
} from '@ember/contracts';
import { isDomainError } from '@ember/domain';
import { Hono } from 'hono';
import { z } from 'zod';
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

/**
 * B1-4B: the two frozen Conversation READ endpoints (ADR-0004, annex §6.5 and §10.1–§10.3):
 *
 * - `GET /v1/conversations/{conversation_id}/messages` — ascending page by `after` cursor.
 * - `GET /v1/message-submissions/{client_submission_id}` — Unknown-ACK lookup, no body needed.
 *
 * ## Composition
 *
 * As with B1-3B, this factory is self-contained and unmounted. The CTO attaches it after B1-2C:
 *
 * ```ts
 * app.route(MESSAGE_READ_MOUNT_PATH, createConversationMessageReadRoutes({ session, conversations }));
 * ```
 *
 * `conversations` is `PostgresB1ConversationReadRepository` from PR #106 — or any object satisfying
 * the two read methods below. Nothing here is imported as a module singleton and no shared file is
 * touched, so mounting moves exactly the semantics these integration tests exercise.
 *
 * ## Rules, in the order they are enforced
 *
 * 1. `requireSessionAuth` (I-9) resolves the presented `ems_` token and writes the unchanged
 *    `AuthContext`, so 401 precedes every other rejection and no handler runs unauthenticated.
 * 2. A caller-supplied `tenant_id` / `principal_id` / `policy_version` — in the query string or in a
 *    header — is REJECTED, never ignored (I-1, ISO-2). The tenant is only ever `c.get('auth').tenantId`.
 * 3. `conversation_id` must be a UUID before it becomes a SQL parameter (§6.1 C-5); a malformed id
 *    never reaches the driver.
 * 4. The page query string is exactly `after` and `limit` (§6.5), each at most once, each a strict
 *    decimal integer inside its frozen bounds. An unknown or malformed parameter is a 400 rather
 *    than a silently different page.
 * 5. `GET .../messages` calls `readMessages` ONCE. That call is one SQL statement, so the page and
 *    its `transcript_epoch` come from one snapshot (RD-6); issuing a second query here would
 *    reintroduce the epoch/history mismatch the client fence cannot repair.
 * 6. The submission lookup is keyed by the path id and the verified tenant only, and any query
 *    parameter is refused: `UNIQUE (tenant_id, client_submission_id)` already makes the lookup
 *    unambiguous (CTO Decision 0002), and a `conversation_id` narrowing hint could disagree with the
 *    stored row, creating a state no receipt can answer (§10.1 N-2).
 * 7. `null` from `findSubmissionReceipt` — unknown, foreign, or deleted — is one 404 with the fixed
 *    public body. It never says "retry": after a transcript deletion the row is gone and a stale
 *    resend would be refused by the write fence (TE-6, N-12).
 *
 * ## What must not appear on the wire
 *
 * Rows leave the repository already rebuilt into the frozen discriminated union and parsed by
 * {@link B1ConversationPageSchema}; this route re-parses on the way out, so an unexpected column or
 * an unfrozen `kind` fails closed with a 500 instead of shipping a body the contract does not define
 * (M-1, RD-4). Both success bodies are the frozen DTOs and nothing else.
 *
 * ## Error boundary
 *
 * Failures map through the existing closed vocabulary — 400 `INVALID_ARGUMENT`, 401
 * `UNAUTHENTICATED`, 404 `NOT_FOUND`, 503 `DB_UNAVAILABLE` — via the shared `respondWithDomainError`
 * mapper, so there is still exactly one code→status table and one error-body builder in the
 * repository. The boundary is registered on this sub-app rather than assumed from the host, because
 * Hono wraps a mounted sub-app's handlers with its own error handler; the statuses are therefore the
 * same whether this factory is tested alone or mounted into `createApp`.
 *
 * Only the stable `error.code` is logged (G-1). `DomainError.diagnostic` can carry driver text and is
 * never serialised or written; message text, page bodies and session tokens are never read by any log
 * statement here (G-2), and a read route holds no request body to leak (G-4, G-6).
 */

/** Where the CTO mounts this sub-app. Matches the B1-2B session routes and B1-3B. */
export const MESSAGE_READ_MOUNT_PATH = '/v1';

/** Route templates inside the sub-app (§6.5, §10.1). */
export const CONVERSATION_MESSAGES_ROUTE_PATH = '/conversations/:conversationId/messages';
export const MESSAGE_SUBMISSION_ROUTE_PATH = '/message-submissions/:clientSubmissionId';

/**
 * §6.5 page bounds: `limit` is 1–100 and defaults to 50; `after` is an integer ≥ 0 and defaults to 0.
 *
 * They are duplicated here rather than imported because `packages/postgres/src/index.ts` is owned by
 * another slice and does not re-export the repository's constants. The HTTP test pins these equal to
 * `B1_MESSAGE_PAGE_DEFAULT_LIMIT` / `B1_MESSAGE_PAGE_MAX_LIMIT`, so the two copies cannot drift.
 */
export const MESSAGE_PAGE_DEFAULT_LIMIT = 50;
export const MESSAGE_PAGE_MIN_LIMIT = 1;
export const MESSAGE_PAGE_MAX_LIMIT = 100;

/** RD-1: `after=0` is the canonical initial load; the same call with `next_after` is forward recovery. */
const MESSAGE_PAGE_DEFAULT_AFTER = 0;

/**
 * A decimal integer and nothing else: no sign, fraction, exponent, whitespace, empty value, or
 * leading zero. `after=-1`, `limit=1.5`, `limit=%205`, `after=`, `after=007` are all rejected rather
 * than coerced, and an unbounded digit run is caught by the safe-integer check in `readIntegerParam`.
 */
const STRICT_NONNEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/;

/**
 * §6.4 writes accept only a v4 `client_submission_id` (`B1SendMessageRequestSchema`), so no other
 * UUID version can name a stored row. A non-v4 value is therefore a malformed identifier (400), not
 * an absent resource (404): answering 404 would imply a row could have existed.
 */
const ClientSubmissionIdSchema = z.uuidv4();

/** I-1: identity scope is server-derived. Both spellings are refused, not normalised. */
const FORBIDDEN_SCOPE_QUERY_KEYS = [
  'tenant_id',
  'principal_id',
  'policy_version',
  'tenantId',
  'principalId',
  'policyVersion',
] as const;

const FORBIDDEN_SCOPE_HEADERS = ['x-tenant-id', 'x-principal-id', 'x-policy-version'] as const;

export interface ConversationMessageReadRouteDependencies {
  /** The real Ember Session boundary; only `resolveActiveSession` is reachable through the middleware. */
  readonly session: SessionService;
  /** The B1-4A read repository, injected as the two methods these routes need. */
  readonly conversations: Pick<B1ConversationRepository, 'readMessages' | 'findSubmissionReceipt'>;
  /** Structured logger. Rejections are logged as codes; bodies and tokens never are. */
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
}

interface IntegerSpec {
  readonly key: 'after' | 'limit';
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
  readonly diagnostic: string;
}

type ParsedInteger =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly diagnostic: string };

/**
 * Read one optional, strict, bounded integer, rejecting a repeated key instead of picking a winner:
 * `?limit=5&limit=6` has no defined meaning, and guessing would silently answer a different page.
 */
function readIntegerParam(searchParams: URLSearchParams, spec: IntegerSpec): ParsedInteger {
  const values = searchParams.getAll(spec.key);

  if (values.length === 0) {
    return { ok: true, value: spec.fallback };
  }

  if (values.length > 1) {
    return { ok: false, diagnostic: `${spec.key} must appear at most once` };
  }

  const raw = values[0]!;

  if (!STRICT_NONNEGATIVE_INTEGER.test(raw)) {
    return { ok: false, diagnostic: spec.diagnostic };
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    return { ok: false, diagnostic: spec.diagnostic };
  }

  return { ok: true, value };
}

type ParsedPageQuery =
  | { readonly ok: true; readonly after: number; readonly limit: number }
  | { readonly ok: false; readonly diagnostic: string };

/**
 * §6.5: the query string is exactly `after` and `limit`, each at most once, or absent.
 *
 * An unknown key is refused rather than ignored. A misspelled `limit` would otherwise answer a full
 * default page (a silent behaviour change), and a smuggled `tenant_id` would look accepted even though
 * it is never read.
 */
export function parseMessagePageQuery(searchParams: URLSearchParams): ParsedPageQuery {
  for (const key of searchParams.keys()) {
    if (key !== 'after' && key !== 'limit') {
      return { ok: false, diagnostic: 'only after and limit query parameters are allowed' };
    }
  }

  const after = readIntegerParam(searchParams, {
    key: 'after',
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    fallback: MESSAGE_PAGE_DEFAULT_AFTER,
    diagnostic: 'after must be a non-negative integer cursor',
  });

  if (!after.ok) {
    return after;
  }

  const limit = readIntegerParam(searchParams, {
    key: 'limit',
    min: MESSAGE_PAGE_MIN_LIMIT,
    max: MESSAGE_PAGE_MAX_LIMIT,
    fallback: MESSAGE_PAGE_DEFAULT_LIMIT,
    diagnostic: `limit must be an integer from ${MESSAGE_PAGE_MIN_LIMIT} to ${MESSAGE_PAGE_MAX_LIMIT}`,
  });

  if (!limit.ok) {
    return limit;
  }

  return { ok: true, after: after.value, limit: limit.value };
}

/** Iteration rather than `size`, so `?`-only and repeated empty keys are still seen. */
function hasAnyQueryParam(searchParams: URLSearchParams): boolean {
  for (const _key of searchParams.keys()) {
    return true;
  }

  return false;
}

/** I-1: an identity scope field is rejected rather than overridden by the verified session. */
export function rejectClientScope(c: AppContext): Response | undefined {
  const query = c.req.query();
  const hasQueryScope = FORBIDDEN_SCOPE_QUERY_KEYS.some((key) => query[key] !== undefined);
  const hasHeaderScope = FORBIDDEN_SCOPE_HEADERS.some(
    (header) => c.req.header(header) !== undefined,
  );

  return hasQueryScope || hasHeaderScope
    ? respondInvalidArgument(c, 'client-supplied identity scope fields are not allowed')
    : undefined;
}

/**
 * Build the two read routes. Dependencies are injected, so the same handlers run against PostgreSQL
 * in the integration tests and against the same reviewed repository in production.
 */
export function createConversationMessageReadRoutes(
  deps: ConversationMessageReadRouteDependencies,
): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();
  const guard = { service: deps.session, logger: deps.logger };

  routes.get(CONVERSATION_MESSAGES_ROUTE_PATH, requireSessionAuth(guard), async (c) => {
    try {
      const rejected = rejectClientScope(c);

      if (rejected !== undefined) {
        return rejected;
      }

      const conversationId = IdSchema.safeParse(c.req.param('conversationId'));

      if (!conversationId.success) {
        // The rejected value is not echoed: it is caller-controlled text.
        return respondInvalidArgument(c, 'conversation_id must be a UUID');
      }

      const query = parseMessagePageQuery(new URL(c.req.url).searchParams);

      if (!query.ok) {
        return respondInvalidArgument(c, query.diagnostic);
      }

      // The tenant has no client-side counterpart anywhere in this command. An absent or foreign
      // Conversation never reaches the page: `readMessages` raises `NOT_FOUND`, which the boundary
      // below renders with the same body as any other 404 (ISO-3, RD-4).
      const page = await deps.conversations.readMessages({
        tenantId: c.get('auth').tenantId,
        conversationId: conversationId.data,
        after: query.after,
        limit: query.limit,
      });

      // Ascending `sequence`, `next_after` and `has_more` are the repository's, produced inside its
      // single snapshot. This re-parse is the last wire gate: a page that is not schema-valid answers
      // 500 instead of shipping a body the frozen contract does not define.
      return c.json(B1ConversationPageSchema.parse(page), 200);
    } catch (error) {
      // Hono only routes `Error` instances to an error handler, so a thrown non-`Error` would
      // otherwise escape this route and be answered by the transport with an unsanitised 500.
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  });

  routes.get(MESSAGE_SUBMISSION_ROUTE_PATH, requireSessionAuth(guard), async (c) => {
    try {
      const rejected = rejectClientScope(c);

      if (rejected !== undefined) {
        return rejected;
      }

      // §10.1 N-2: the path id is the whole request. There is no body to read and no idempotency
      // header to consult — a read cannot dedupe a write, so `Idempotency-Key` is inert here rather
      // than rejected (the Task routes own that discipline, N-6). A query parameter is refused,
      // because a narrowing hint that disagrees with the stored row would have no answer.
      if (hasAnyQueryParam(new URL(c.req.url).searchParams)) {
        return respondInvalidArgument(c, 'message submission lookup takes no query parameters');
      }

      const clientSubmissionId = ClientSubmissionIdSchema.safeParse(
        c.req.param('clientSubmissionId'),
      );

      if (!clientSubmissionId.success) {
        return respondInvalidArgument(c, 'client_submission_id must be a UUID v4');
      }

      const receipt = await deps.conversations.findSubmissionReceipt({
        tenantId: c.get('auth').tenantId,
        clientSubmissionId: clientSubmissionId.data,
      });

      if (receipt === null) {
        // Unknown, deleted and another tenant's submission produce this one response, and it carries
        // no field that instructs a retry (TE-6): the row is gone, so a stale-epoch resend would be
        // rejected by the write fence rather than recovering anything (N-12).
        //
        // G-1/G-5: the line carries the code and the correlation id only. The submission id is
        // caller-controlled and is not an allowlisted log field for this route, so it is not logged
        // even though the 404 itself is a normal reconciliation outcome rather than a fault.
        deps.logger?.warn('message submission not found', {
          requestId: requestIdOf(c),
          method: c.req.method,
          code: 'NOT_FOUND',
        });

        return respondNotFound(c, 'message submission is not visible in this tenant');
      }

      // The stored receipt, validated against the schema the POST used. `turn.status` stays the
      // acknowledged `running`; the Turn's current state is a different resource (§7.4, N-2).
      return c.json(B1SendMessageReceiptSchema.parse(receipt), 200);
    } catch (error) {
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  });

  routes.onError((error, c) => {
    const route = { requestId: requestIdOf(c), method: c.req.method, path: c.req.path };

    if (isDomainError(error)) {
      // `NOT_FOUND` (absent or foreign) and `DB_UNAVAILABLE` both arrive here; only the code is
      // logged, because the diagnostic can carry driver text (G-1, G-2).
      deps.logger?.warn('conversation read rejected', { ...route, code: error.code });

      return respondWithDomainError(c, error);
    }

    deps.logger?.error('conversation read fault', {
      ...route,
      code: INTERNAL_ERROR_CODE,
      category: unexpectedErrorCategory(error),
    });

    return c.json(toInternalErrorResponse(requestIdOf(c)), 500);
  });

  return routes;
}
