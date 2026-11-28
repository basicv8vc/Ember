import {
  B1SendMessageReceiptSchema,
  B1SendMessageRequestSchema,
  IdSchema,
  type B1ConversationRepository,
} from '@ember/contracts';
import { isDomainError } from '@ember/domain';
import { Hono } from 'hono';
import { requireSessionAuth } from '../auth/session-authenticator.js';
import type { SessionService } from '../auth/session-service.js';
import { requestIdOf, type AppBindings, type AppContext } from '../http/app-context.js';
import { readJsonBody, type BodyRejectionReason } from '../http/bounded-body.js';
import {
  INTERNAL_ERROR_CODE,
  UnexpectedNonErrorFault,
  respondInvalidArgument,
  respondWithDomainError,
  toInternalErrorResponse,
  unexpectedErrorCategory,
} from '../http/error-mapping.js';
import type { Logger } from '../logger.js';
import { IDEMPOTENCY_KEY_HEADER } from '../tasks/constants.js';

/**
 * B1-3B: `POST /v1/conversations/{conversation_id}/messages` (ADR-0004, annex §6.4, §10.1–§10.3).
 *
 * ## Composition
 *
 * This factory is deliberately self-contained and unmounted. The CTO attaches it once B1-2C lands:
 *
 * ```ts
 * app.route(MESSAGE_WRITE_MOUNT_PATH, createConversationMessageWriteRoutes({ session, conversations }));
 * ```
 *
 * Nothing here reads a module singleton, and no shared file changes: the Session boundary and the
 * Conversation write repository are injected, so mounting moves the same semantics that the
 * integration tests exercise.
 *
 * ## Rules, in the order they are enforced
 *
 * 1. `requireSessionAuth` (I-9) resolves the presented `ems_` token and writes the unchanged
 *    `AuthContext`. No request reaches a handler without it, so 401 precedes every other rejection.
 * 2. A caller-supplied `tenant_id` / `principal_id` / `policy_version` — in the query string, in a
 *    header, or in the body — is REJECTED, never ignored (I-1). The body case is the strict schema.
 * 3. `Idempotency-Key` is rejected (§6.4): `client_submission_id` is the one recoverable dedupe key,
 *    and a second mechanism would create a mismatch no constraint can resolve. Legacy Task routes
 *    keep their own `Idempotency-Key` semantics untouched; this rule is scoped to this one route.
 * 4. `conversation_id` must be a UUID before it becomes a SQL parameter (§6.1 C-5).
 * 5. `Content-Type: application/json` and the frozen 16 KiB cap are enforced by the streaming body
 *    reader, so an oversized body is refused without buffering it.
 * 6. `B1SendMessageRequestSchema` decides what a valid send is; the repository re-validates the same
 *    frozen schema, so route and persistence cannot drift into two input rules (M-6).
 * 7. The tenant is read from the verified `AuthContext` only. The path supplies a Conversation id
 *    and nothing else, so an unknown and a foreign Conversation both become the same 404 (ISO-3).
 * 8. The response is written after `await submitUserMessage(...)` resolves, and that promise
 *    resolves only once the repository's transaction has committed (S-4). 201 is a new write, 200 a
 *    replay of the identical submission (S-2), and both carry the same canonical receipt (N-2).
 * 9. `transcript_epoch` is mandatory and never refreshed on the server's behalf: a stale or invented
 *    generation is the repository's 409 fence (TE-3, S-7), and this route resends nothing.
 *
 * ## Error boundary
 *
 * Failures map through the existing closed vocabulary — 400 `INVALID_ARGUMENT`, 401
 * `UNAUTHENTICATED`, 404 `NOT_FOUND`, 409 `IDEMPOTENCY_CONFLICT`, 429 `BUDGET_EXCEEDED`, 503
 * `DB_UNAVAILABLE` — via the shared `respondWithDomainError` mapper, so there is still exactly one
 * code→status table and one error-body builder in the repository. The boundary is registered on this
 * sub-app rather than assumed from the host: Hono wraps a mounted sub-app's handlers with its own
 * error handler, so the statuses above are the same whether this factory is tested alone or mounted
 * into `createApp`. A host-level `onError` then simply never fires for this route.
 *
 * Only the stable `error.code` is logged (G-1); `DomainError.diagnostic` can carry driver text and is
 * never serialised or written. Request bodies, message text and session tokens are not read by any
 * log statement here (G-2).
 */

/** Where the CTO mounts this sub-app. Matches the B1-2B session routes. */
export const MESSAGE_WRITE_MOUNT_PATH = '/v1';

/**
 * Route template inside the sub-app, so the wire path is
 * `${MESSAGE_WRITE_MOUNT_PATH}${MESSAGE_WRITE_ROUTE_PATH}` —
 * `POST /v1/conversations/{conversation_id}/messages` (§6.4).
 *
 * Authentication is attached to this path rather than to a `/*` middleware on purpose: a wildcard
 * middleware registered by a sub-app is copied onto the host's mount prefix when mounted, which would
 * let this route decide the fate of unrelated `/v1` routes.
 */
export const MESSAGE_WRITE_ROUTE_PATH = '/conversations/:conversationId/messages';

/** Annex §6.4: "Cap: 16 KiB". Enforced on the stream, not only on `Content-Length`. */
export const MAX_MESSAGE_REQUEST_BYTES = 16 * 1_024;

/** Fixed reason per body rejection; the rejected bytes themselves are never echoed (G-4). */
const BODY_REJECTION_MESSAGES: Readonly<Record<BodyRejectionReason, string>> = Object.freeze({
  missing_content_type: 'Content-Type must be application/json',
  unsupported_content_type: 'Content-Type must be application/json',
  empty_body: 'request body must be a JSON object',
  too_large: `request body must not exceed ${MAX_MESSAGE_REQUEST_BYTES} bytes`,
  invalid_encoding: 'request body must be UTF-8 encoded JSON',
  invalid_json: 'request body must be valid JSON',
});

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

export interface ConversationMessageWriteRouteDependencies {
  /** The real Ember Session boundary; only `resolveActiveSession` is reachable through the middleware. */
  readonly session: SessionService;
  /** The B1-3A write repository, injected as the one method this route needs. */
  readonly conversations: Pick<B1ConversationRepository, 'submitUserMessage'>;
  /** Structured logger. Rejections are logged as codes; bodies and tokens never are. */
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
}

function rejectForbiddenScope(c: AppContext): Response | undefined {
  const query = c.req.query();
  const hasScopeField =
    FORBIDDEN_SCOPE_QUERY_KEYS.some((key) => query[key] !== undefined) ||
    FORBIDDEN_SCOPE_HEADERS.some((header) => c.req.header(header) !== undefined);

  if (hasScopeField) {
    return respondInvalidArgument(c, 'client-supplied identity scope fields are not allowed');
  }

  if (c.req.header(IDEMPOTENCY_KEY_HEADER) !== undefined) {
    return respondInvalidArgument(
      c,
      `${IDEMPOTENCY_KEY_HEADER} is not accepted here; client_submission_id is the message dedupe key`,
    );
  }

  return undefined;
}

export function createConversationMessageWriteRoutes(
  deps: ConversationMessageWriteRouteDependencies,
): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();
  const logger = deps.logger;

  routes.post(
    MESSAGE_WRITE_ROUTE_PATH,
    requireSessionAuth({ service: deps.session, logger }),
    async (c) => {
      try {
        const rejected = rejectForbiddenScope(c);

        if (rejected !== undefined) {
          return rejected;
        }

        const parsedConversationId = IdSchema.safeParse(c.req.param('conversationId'));

        if (!parsedConversationId.success) {
          // The rejected value is not echoed: it is caller-controlled text.
          return respondInvalidArgument(c, 'conversation_id must be a UUID');
        }

        const body = await readJsonBody(c.req.raw, MAX_MESSAGE_REQUEST_BYTES);

        if (!body.ok) {
          return respondInvalidArgument(c, BODY_REJECTION_MESSAGES[body.reason]);
        }

        const request = B1SendMessageRequestSchema.safeParse(body.value);

        if (!request.success) {
          return respondInvalidArgument(c, 'request body does not match the message schema');
        }

        const auth = c.get('auth');
        const outcome = await deps.conversations.submitUserMessage({
          tenantId: auth.tenantId,
          principalId: auth.principalId,
          conversationId: parsedConversationId.data,
          request: request.data,
        });

        // The frozen schema is re-applied on the way out so the wire can only ever be the canonical
        // receipt DTO — the same body a replay and an Unknown-ACK lookup return (N-2).
        return c.json(
          B1SendMessageReceiptSchema.parse(outcome.receipt),
          outcome.replayed ? 200 : 201,
        );
      } catch (error) {
        // Hono only routes `Error` instances to an error handler, so a thrown non-`Error` would
        // otherwise escape this route and be answered by the transport with an unsanitised 500.
        throw error instanceof Error ? error : new UnexpectedNonErrorFault();
      }
    },
  );

  routes.onError((error, c) => {
    const route = { requestId: requestIdOf(c), method: c.req.method, path: c.req.path };

    if (isDomainError(error)) {
      logger?.warn('conversation message write rejected', { ...route, code: error.code });

      return respondWithDomainError(c, error);
    }

    logger?.error('conversation message write fault', {
      ...route,
      code: INTERNAL_ERROR_CODE,
      category: unexpectedErrorCategory(error),
    });

    return c.json(toInternalErrorResponse(requestIdOf(c)), 500);
  });

  return routes;
}
