import { B1SendMessageReceiptSchema, B1SendMessageRequestSchema, IdSchema } from '@ember/contracts';
import { DomainError, isDomainError, type AuthContext } from '@ember/domain';
import {
  FAKE_MODEL_LABEL,
  MODEL_LIMITS,
  type FakeStreamingModelGateway,
} from '@ember/model-gateway';
import { Hono, type MiddlewareHandler } from 'hono';
import type { B1SessionRuntime } from '../auth/b1-auth-runtime.js';
import { requireSessionAuth } from '../auth/session-authenticator.js';
import { createB1SessionRoutes } from '../auth/session-routes.js';
import { createConversationMessageReadRoutes } from '../conversation/message-read-routes.js';
import {
  createConversationMessageWriteRoutes,
  MAX_MESSAGE_REQUEST_BYTES,
} from '../conversation/message-write-routes.js';
import {
  generateRequestId,
  requestIdMiddleware,
  requestIdOf,
  type AppBindings,
} from '../http/app-context.js';
import { readBoundedBodyBytes, readJsonBody } from '../http/bounded-body.js';
import {
  respondInvalidArgument,
  respondNotFound,
  respondWithDomainError,
  toInternalErrorResponse,
} from '../http/error-mapping.js';
import { createB1TurnRoutes } from '../turns/turn-routes.js';
import {
  INTERACTIVE_TIMING,
  executeInteractive,
  type InteractiveExecution,
} from './interactive-executor.js';
import type { EdgeAgentHeadRpc, PrepareTurnRequest, ResolvedMessageAttachment } from './rpc.js';

const LOCAL_STREAM_PATH = '/v2/conversations/:conversationId/messages/stream';
const B1_DURABLE_TIMING = {
  // Agent Head assigns no interactive lease when executionMode is durable_queue.
  leaseMs: 25_000,
  interactiveDeadlineMs: 22_000,
  turnDeadlineMs: MODEL_LIMITS.turnDeadlineMs,
};
const SSE_MAX_BUFFERED_BYTES = 32 * 1024;
const SSE_ENCODER = new TextEncoder();

interface LocalWorkerContext {
  waitUntil(work: Promise<void>): void;
}

export interface ResolvedAgentHead {
  readonly agentId: string;
  readonly conversationId: string;
  readonly rpc: EdgeAgentHeadRpc;
}

export interface LocalV2EdgeDependencies {
  /** Host supplies V1 session ports and an agent-head-backed B1 /me projection. */
  readonly sessions: B1SessionRuntime;
  /** Resolve the canonical head from verified identity; request path IDs never select a head. */
  resolveAgentHead(auth: AuthContext): Promise<ResolvedAgentHead | null>;
  /** Read already-authorized local staged metadata, including attachments on accepted replays. */
  resolveAttachments?(
    auth: AuthContext,
    ids: readonly string[],
  ): Promise<readonly ResolvedMessageAttachment[]>;
  readonly stream?: { readonly gateway: Pick<FakeStreamingModelGateway, 'streamConversationTurn'> };
}

/** Separate Worker fetch handler for local composition. The existing API does not mount it. */
export function createLocalV2EdgeWorker(deps: LocalV2EdgeDependencies) {
  return {
    async fetch(request: Request, _env?: unknown, ctx?: LocalWorkerContext): Promise<Response> {
      const requestId = generateRequestId();
      const app = new Hono<AppBindings>();
      const hostname = new URL(request.url).hostname;
      let auth: AuthContext | undefined;
      let resolution: Promise<ResolvedAgentHead & { readonly auth: AuthContext }> | undefined;

      const sessions: B1SessionRuntime['service'] = {
        createSession: (identity) => deps.sessions.service.createSession(identity),
        refreshSession: (token: string) => deps.sessions.service.refreshSession(token),
        logout: (token: string) => deps.sessions.service.logout(token),
        async resolveActiveSession(token: string) {
          const session = await callRuntime(() =>
            deps.sessions.service.resolveActiveSession(token),
          );
          auth = session?.auth;
          return session;
        },
      };

      function head(): Promise<ResolvedAgentHead & { readonly auth: AuthContext }> {
        const caller = auth;
        if (caller === undefined) throw new DomainError('UNAUTHENTICATED', 'session required');
        resolution ??= callRuntime(() => deps.resolveAgentHead(caller)).then((resolved) => {
          if (resolved === null) throw new DomainError('NOT_FOUND', 'no agent head for session');
          return { ...resolved, auth: caller };
        });
        return resolution;
      }

      async function prepare(
        conversationId: string,
        message: PrepareTurnRequest['request'],
        executionMode: PrepareTurnRequest['executionMode'],
      ) {
        const resolved = await head();
        if (resolved.conversationId.toLowerCase() !== conversationId.toLowerCase()) {
          throw new DomainError('NOT_FOUND', 'conversation is not visible');
        }
        const scope = { ...resolved.auth, agentId: resolved.agentId, requestId };
        const attachmentIds = message.attachment_ids?.map((id) => id.toLowerCase());
        const resolvedAttachments =
          attachmentIds === undefined
            ? undefined
            : await callRuntime(() => {
                if (deps.resolveAttachments === undefined) {
                  throw new DomainError(
                    'INVALID_ARGUMENT',
                    'staged attachments are unavailable in the local runtime',
                  );
                }
                return deps.resolveAttachments(resolved.auth, attachmentIds);
              });
        const workerId = crypto.randomUUID();
        const timing =
          executionMode === 'fast_interactive' ? INTERACTIVE_TIMING : B1_DURABLE_TIMING;
        const outcome = await callRuntime(() =>
          resolved.rpc.prepareTurn({
            scope,
            conversationId: resolved.conversationId,
            request: {
              ...message,
              client_submission_id: message.client_submission_id.toLowerCase(),
              ...(attachmentIds === undefined ? {} : { attachment_ids: attachmentIds }),
            },
            ...(resolvedAttachments === undefined ? {} : { resolvedAttachments }),
            executionMode,
            workerId,
            leaseMs: timing.leaseMs,
            interactiveDeadlineMs: timing.interactiveDeadlineMs,
            turnDeadlineMs: timing.turnDeadlineMs,
            modelReservation: {
              budgetMode: 'simulated_full_protocol',
              providerId: 'fake',
              modelLabel: FAKE_MODEL_LABEL,
              rateVersion: 'fake-zero-cost',
              maxAttempts: 1,
              estimatedMicroUsd: 1,
            },
          }),
        );
        return { outcome, resolved, scope, workerId };
      }

      app.use(
        '*',
        requestIdMiddleware(() => requestId),
      );
      const localOnly: MiddlewareHandler<AppBindings> = async (c, next) => {
        if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') {
          return respondNotFound(c, 'local V2 entry');
        }
        c.header('Cache-Control', 'no-store');
        await next();
      };
      app.use('*', localOnly);
      app.notFound((c) => respondNotFound(c, 'unknown route'));
      app.onError((error, c) =>
        isDomainError(error)
          ? respondWithDomainError(c, error)
          : c.json(toInternalErrorResponse(requestIdOf(c)), 500),
      );

      app.route('/v1', createB1SessionRoutes({ runtime: { ...deps.sessions, service: sessions } }));
      app.route(
        '/v1',
        createConversationMessageWriteRoutes({
          session: sessions,
          conversations: {
            async submitUserMessage(command) {
              return (await prepare(command.conversationId, command.request, 'durable_queue'))
                .outcome;
            },
          },
        }),
      );
      app.route(
        '/v1',
        createConversationMessageReadRoutes({
          session: sessions,
          conversations: {
            async readMessages(command) {
              const { rpc, agentId } = await head();
              return callRuntime(() =>
                rpc.readMessages({
                  ...command,
                  conversationId: command.conversationId.toLowerCase(),
                  agentId,
                }),
              );
            },
            async findSubmissionReceipt(command) {
              const { rpc, agentId } = await head();
              return callRuntime(() =>
                rpc.findSubmissionReceipt({
                  ...command,
                  clientSubmissionId: command.clientSubmissionId.toLowerCase(),
                  agentId,
                }),
              );
            },
          },
        }),
      );
      app.route(
        '/v1',
        createB1TurnRoutes({
          sessions,
          repository: {
            async getTurn(command) {
              const { rpc, agentId } = await head();
              return callRuntime(() =>
                rpc.getTurn({
                  ...command,
                  conversationId: command.conversationId.toLowerCase(),
                  turnId: command.turnId.toLowerCase(),
                  agentId,
                }),
              );
            },
            async cancelTurn(command) {
              const { rpc, agentId } = await head();
              return callRuntime(() =>
                rpc.cancelTurn({
                  ...command,
                  conversationId: command.conversationId.toLowerCase(),
                  turnId: command.turnId.toLowerCase(),
                  agentId,
                }),
              );
            },
          },
        }),
      );

      app.delete(
        '/v1/me/conversation/messages',
        requireSessionAuth({ service: sessions }),
        async (c) => {
          const body = await readBoundedBodyBytes(c.req.raw, 0);
          if (body.ok || body.reason !== 'empty_body' || hasExtraInput(c.req.raw)) {
            return respondInvalidArgument(c, 'transcript deletion takes no query or body');
          }
          const { rpc, agentId, conversationId } = await head();
          const result = await callRuntime(() =>
            rpc.clearTranscript({ tenantId: c.get('auth').tenantId, agentId, conversationId }),
          );
          return c.json({
            deleted_messages: result.deletedMessages,
            deleted_turns: result.deletedTurns,
            transcript_epoch: result.transcriptEpoch,
          });
        },
      );

      const stream = deps.stream;
      if (stream !== undefined) {
        app.post(LOCAL_STREAM_PATH, requireSessionAuth({ service: sessions }), async (c) => {
          const conversation = IdSchema.safeParse(c.req.param('conversationId'));
          if (
            !conversation.success ||
            hasExtraInput(c.req.raw) ||
            c.req.header('idempotency-key') !== undefined
          ) {
            return respondInvalidArgument(c, 'invalid stream request');
          }
          const body = await readJsonBody(c.req.raw, MAX_MESSAGE_REQUEST_BYTES);
          const message = body.ok ? B1SendMessageRequestSchema.safeParse(body.value) : undefined;
          if (!message?.success) return respondInvalidArgument(c, 'invalid message');

          const { outcome, resolved, scope, workerId } = await prepare(
            conversation.data,
            message.data,
            'fast_interactive',
          );
          const receipt = B1SendMessageReceiptSchema.parse(outcome.receipt);
          const disconnect = new AbortController();
          const detach = () => disconnect.abort();
          c.req.raw.signal.addEventListener('abort', detach, { once: true });
          if (c.req.raw.signal.aborted) detach();

          let readerCancelled = false;
          const bodyStream = new ReadableStream<Uint8Array>(
            {
              start(controller) {
                const emit: InteractiveExecution['emit'] = (event, data) => {
                  if (disconnect.signal.aborted) return;
                  const frame = encodeSse(event, data);
                  if ((controller.desiredSize ?? 0) < frame.byteLength) {
                    detach();
                    return;
                  }
                  controller.enqueue(frame);
                };

                if (!disconnect.signal.aborted)
                  controller.enqueue(encodeSse('turn.accepted', receipt));
                const work =
                  outcome.kind === 'replay'
                    ? Promise.resolve()
                    : executeInteractive({
                        rpc: resolved.rpc,
                        gateway: stream.gateway,
                        prepared: outcome,
                        scope: { tenantId: scope.tenantId, agentId: scope.agentId },
                        conversationId: resolved.conversationId,
                        workerId,
                        signal: disconnect.signal,
                        emit,
                      });
                const finished = work
                  .catch(() => {
                    // Post-ACK RPC failures leave authority with Agent Head. Reconcile via the B1 reads.
                  })
                  .finally(() => {
                    c.req.raw.signal.removeEventListener('abort', detach);
                    // cancel() already closes the readable side.
                    if (!readerCancelled) controller.close();
                  });
                ctx?.waitUntil(finished);
              },
              cancel() {
                readerCancelled = true;
                detach();
              },
            },
            { highWaterMark: SSE_MAX_BUFFERED_BYTES, size: (chunk) => chunk.byteLength },
          );
          return c.body(bodyStream, outcome.replayed ? 200 : 201, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
          });
        });
      }

      return app.fetch(request);
    },
  };
}

function encodeSse(event: string, data: unknown): Uint8Array {
  return SSE_ENCODER.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function hasExtraInput(request: Request): boolean {
  return (
    new URL(request.url).searchParams.size > 0 ||
    ['x-tenant-id', 'x-principal-id', 'x-policy-version'].some((header) =>
      request.headers.has(header),
    )
  );
}

async function callRuntime<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new DomainError('DB_UNAVAILABLE', 'local runtime response unavailable');
  }
}
