import { randomUUID } from 'node:crypto';
import {
  B1SendMessageReceiptSchema,
  ErrorResponseSchema,
  type B1SendMessageReceipt,
  type ErrorResponse,
} from '@ember/contracts';
import {
  PostgresAgentRepository,
  PostgresTaskRepository,
  createPool,
  loadDatabaseConfig,
} from '@ember/postgres';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireTenantAuth } from '../../apps/api/src/auth/auth-middleware.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import {
  createSessionService,
  type B1SessionPorts,
} from '../../apps/api/src/auth/session-service.js';
import {
  MESSAGE_WRITE_MOUNT_PATH,
  MESSAGE_WRITE_ROUTE_PATH,
  MAX_MESSAGE_REQUEST_BYTES,
  createConversationMessageWriteRoutes,
} from '../../apps/api/src/conversation/message-write-routes.js';
import { requestIdMiddleware, type AppBindings } from '../../apps/api/src/http/app-context.js';
import { createLogger } from '../../apps/api/src/logger.js';
import { TASKS_PATH } from '../../apps/api/src/tasks/constants.js';
import { createTaskRoutes } from '../../apps/api/src/tasks/routes.js';
import {
  B1_MESSAGE_QUOTA_LIMIT,
  PostgresB1ConversationWriteRepository,
} from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import { PostgresB1ConsumerProvisioningRepository } from '../../packages/postgres/src/repositories/b1-session-provisioning-repository.js';
import { PostgresB1ConsumerSessionRepository } from '../../packages/postgres/src/repositories/b1-session-repository.js';
import { createTestDatabase, type TestDatabase, type TestPool } from './support/database.js';
import { createTenantFixture } from './support/fixtures.js';

/**
 * B1-3B: `POST /v1/conversations/{conversation_id}/messages` over HTTP, against the real PostgreSQL 17
 * write repository from PR #105 and the real `requireSessionAuth` middleware.
 *
 * There is no fake SQL writer here. Every accepted status is backed by a committed transaction that a
 * second connection can already read, and every rejection is checked against the rows it must NOT have
 * written. The app under test is assembled in this file instead of taken from `createApp`, because
 * B1-3B is deliberately not mounted in the shared app yet: the CTO mounts it after B1-2C, and the two
 * assertions that matter for that handoff are (a) the route answers with the frozen §6.4 semantics
 * standing alone, and (b) mounting it next to the legacy Task routes does not change either one.
 *
 * Sessions are deterministic fixtures inside this file only. They are minted through
 * `createSessionService` over the real consumer/session repositories, so the route authenticates
 * through the same Ember Session boundary it will use in production, and no fixture ever injects a
 * tenant, principal or policy version.
 *
 * Each `it` signs in its own Consumer, so its Conversation starts empty: exact `sequence` and row
 * counts stay true regardless of the order these tests run in.
 */

interface Actor {
  readonly token: string;
  readonly tenantId: string;
  readonly conversationId: string;
}

interface Host {
  readonly app: Hono<AppBindings>;
  readonly logLines: string[];
}

interface MessageInput {
  readonly clientSubmissionId: string;
  readonly text: string;
  /**
   * Defaults to `0`, the generation a freshly provisioned Conversation is at. `null` omits the
   * field entirely, which is the only way to exercise the mandatory-epoch rule (§6.4, TE-3).
   */
  readonly transcriptEpoch?: number | null;
  readonly clientCreatedAt?: string;
  readonly extra?: Record<string, unknown>;
}

interface PostOptions {
  readonly token?: string | null;
  readonly contentType?: string | null;
  readonly raw?: string;
  readonly headers?: Record<string, string>;
  readonly query?: string;
  readonly conversationId?: string;
}

let db: TestDatabase;
let poolA: TestPool;
let poolB: TestPool;
let service: ReturnType<typeof createSessionService>;
let host: Host;

/**
 * One host: request-id middleware plus the unmounted route, which is exactly how `createApp` composes
 * cross-cutting concerns. The factory contributes authentication, validation and the write itself.
 */
function buildHost(writerPool: TestPool): Host {
  const logLines: string[] = [];
  const app = new Hono<AppBindings>();

  app.use(
    '*',
    requestIdMiddleware(() => `it-request-${randomUUID()}`),
  );
  app.route(
    MESSAGE_WRITE_MOUNT_PATH,
    createConversationMessageWriteRoutes({
      session: service,
      conversations: new PostgresB1ConversationWriteRepository(writerPool),
      // `debug` is the widest level, so a leaked payload would be captured rather than filtered out (G-6).
      logger: createLogger({ level: 'debug', sink: (_level, line) => logLines.push(line) }),
    }),
  );

  return { app, logLines };
}

function messageBody(input: MessageInput): Record<string, unknown> {
  return {
    client_submission_id: input.clientSubmissionId,
    text: input.text,
    ...(input.transcriptEpoch === null ? {} : { transcript_epoch: input.transcriptEpoch ?? 0 }),
    ...(input.clientCreatedAt === undefined ? {} : { client_created_at: input.clientCreatedAt }),
    ...(input.extra ?? {}),
  };
}

function messagePath(conversationId: string): string {
  return `/v1/conversations/${conversationId}/messages`;
}

/** The only way a test reaches the route: through HTTP, never through the repository. */
function postMessage(
  actor: Actor,
  input: MessageInput,
  options: PostOptions = {},
  app: Hono<AppBindings> = host.app,
): Promise<Response> {
  return sendForm(
    actor,
    messageBody(input),
    { ...options, conversationId: options.conversationId ?? actor.conversationId },
    app,
  );
}

async function sendForm(
  actor: Actor,
  body: Record<string, unknown> | undefined,
  options: PostOptions,
  app: Hono<AppBindings> = host.app,
): Promise<Response> {
  const headers: Record<string, string> = {};

  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? actor.token}`;
  }

  if (options.contentType !== null) {
    headers['content-type'] = options.contentType ?? 'application/json';
  }

  // An explicit header in `options.headers` wins, so a test can present a wrong scheme.
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name] = value;
  }

  return await app.request(
    `${messagePath(options.conversationId ?? actor.conversationId)}${options.query ?? ''}`,
    {
      method: 'POST',
      headers,
      body: options.raw ?? (body === undefined ? '' : JSON.stringify(body)),
    },
  );
}

/** Sign in through the real session service, so the token is one the middleware can resolve. */
async function signIn(label: string): Promise<Actor> {
  const session = await service.createSession({
    provider: 'dev',
    providerSubject: `b1-3b-${label}-${randomUUID()}`,
  });
  const resolved = await service.resolveActiveSession(session.access_token);

  if (resolved === null) {
    throw new Error(`the ${label} session did not resolve`);
  }

  const conversations = await db.observerPool.query<{ id: string }>(
    "SELECT id FROM conversations WHERE tenant_id = $1 AND kind = 'main'",
    [resolved.auth.tenantId],
  );
  const conversationId = conversations.rows[0]?.id;

  if (conversationId === undefined) {
    throw new Error(`the ${label} session has no main conversation`);
  }

  return { token: session.access_token, tenantId: resolved.auth.tenantId, conversationId };
}

/** A second Conversation inside one tenant, for the tenant-wide submission conflict (CTO 0002). */
async function createSecondConversation(tenantId: string): Promise<string> {
  const agentId = randomUUID();
  const conversationId = randomUUID();

  await db.pool.query(
    'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
    [agentId, tenantId, `second agent ${tenantId}`],
  );
  await db.pool.query(
    "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
    [conversationId, tenantId, agentId],
  );

  return conversationId;
}

interface RowCounts {
  readonly messages: number;
  readonly turns: number;
  readonly lastSequence: number;
  readonly transcriptEpoch: number;
}

async function rows(conversationId: string): Promise<RowCounts> {
  const messages = await db.observerPool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM conversation_messages WHERE conversation_id = $1',
    [conversationId],
  );
  const turns = await db.observerPool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM assistant_turns WHERE conversation_id = $1',
    [conversationId],
  );
  const conversation = await db.observerPool.query<{
    last_sequence: string;
    transcript_epoch: string;
  }>('SELECT last_sequence, transcript_epoch FROM conversations WHERE id = $1', [conversationId]);

  return {
    messages: Number(messages.rows[0]?.count ?? '0'),
    turns: Number(turns.rows[0]?.count ?? '0'),
    lastSequence: Number(conversation.rows[0]?.last_sequence ?? '0'),
    transcriptEpoch: Number(conversation.rows[0]?.transcript_epoch ?? '0'),
  };
}

async function receiptOf(response: Response): Promise<B1SendMessageReceipt> {
  return B1SendMessageReceiptSchema.parse(await response.json());
}

async function errorOf(response: Response): Promise<ErrorResponse> {
  return ErrorResponseSchema.parse(await response.json());
}

/**
 * The error body without its per-request correlation id.
 *
 * `X-Request-Id` is generated per request, so two responses can never be byte-identical. Every
 * invariant that says "the same body" (ISO-3 for a foreign versus a missing Conversation, TE-3 for a
 * stale versus an invented epoch) is therefore asserted on the part the contract actually freezes:
 * the `code` and the fixed `message` chosen by that code.
 */
function frozenErrorBody(body: ErrorResponse): Record<string, unknown> {
  const { request_id: _requestId, ...frozen } = body.error;
  return frozen;
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 12 });

  const url = process.env.TEST_DATABASE_URL;

  if (url === undefined || url.length === 0) {
    throw new Error('TEST_DATABASE_URL is required');
  }

  // One connection each, so a "concurrent" pair of POSTs is genuinely two PostgreSQL backends.
  const config = loadDatabaseConfig({ DATABASE_URL: url });
  poolA = createPool({ ...config, maxConnections: 1, searchPath: db.schema });
  poolB = createPool({ ...config, maxConnections: 1, searchPath: db.schema });

  const ports: B1SessionPorts = {
    provisioning: new PostgresB1ConsumerProvisioningRepository(db.pool),
    sessions: new PostgresB1ConsumerSessionRepository(db.pool),
    // `GET /v1/me` belongs to another slice; this route never reaches it.
    me: {
      getMeForTenant: () => Promise.reject(new Error('the me projection is not used by B1-3B')),
    },
  };
  service = createSessionService({ ports });
  host = buildHost(db.pool);
});

afterAll(async () => {
  await poolA?.end().catch(() => undefined);
  await poolB?.end().catch(() => undefined);
  await db?.close();
});

describe('B1-3B: Conversation message write HTTP API on PostgreSQL 17', () => {
  it('1. rejects a missing, malformed, unknown or revoked session with 401 and writes nothing', async () => {
    const actor = await signIn('unauthenticated');

    const cases: readonly (readonly [string, PostOptions])[] = [
      ['no Authorization header', { token: null }],
      ['a bearer that is not an Ember session', { token: 'dev-token-not-an-ems-session' }],
      ['a well-formed but unknown ems_ token', { token: `ems_${'a'.repeat(43)}` }],
      [
        'a wrong scheme',
        { token: actor.token, headers: { authorization: `token ${actor.token}` } },
      ],
    ];

    for (const [label, options] of cases) {
      const response = await postMessage(
        actor,
        { clientSubmissionId: randomUUID(), text: `unauthenticated ${label}` },
        options,
      );
      expect([response.status, label]).toEqual([401, label]);

      const body = await errorOf(response);
      expect(body.error.code).toBe('UNAUTHENTICATED');
      expect(body.error.message).toBe('Authentication required');
      // The host's request id survives the route-local error boundary.
      expect(body.error.request_id).toMatch(/^it-request-/);
    }

    // The fourth path to 401: a real session whose row is revoked, so the token is still well-formed.
    const revoked = await signIn('revoked');
    await db.pool.query(
      `UPDATE consumer_sessions
          SET revoked_at = now(), revocation_reason = 'logout'
        WHERE tenant_id = $1`,
      [revoked.tenantId],
    );
    const revokedResponse = await postMessage(revoked, {
      clientSubmissionId: randomUUID(),
      text: 'revoked session',
    });
    expect(revokedResponse.status).toBe(401);
    expect((await errorOf(revokedResponse)).error.code).toBe('UNAUTHENTICATED');

    expect(await rows(actor.conversationId)).toMatchObject({ messages: 0, turns: 0 });
    expect(await rows(revoked.conversationId)).toMatchObject({ messages: 0, turns: 0 });
  });

  it('2. accepts a verified Session with 201 and the strict canonical receipt', async () => {
    const actor = await signIn('accepted');
    const clientSubmissionId = randomUUID();
    const response = await postMessage(
      actor,
      { clientSubmissionId, text: 'Book me a table for two on Friday' },
      { headers: { 'x-client-diagnostics': 'ignored' } },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toContain('application/json');

    const receipt = await receiptOf(response);
    expect(receipt.message.kind).toBe('user');
    expect(receipt.message.sequence).toBe(1);
    expect(receipt.message.conversation_id).toBe(actor.conversationId);
    expect(receipt.message.client_submission_id).toBe(clientSubmissionId);
    expect(receipt.message.text).toBe('Book me a table for two on Friday');
    expect(receipt.turn.status).toBe('running');
    expect(receipt.transcript_epoch).toBe(0);
    expect(Number.isInteger(receipt.message.sequence)).toBe(true);

    // The wire object has exactly the frozen keys: no internal field, no identity scope (I-1).
    expect(Object.keys(receipt).sort()).toEqual(['message', 'transcript_epoch', 'turn']);
    expect(Object.keys(receipt.message).sort()).toEqual([
      'client_submission_id',
      'conversation_id',
      'created_at',
      'kind',
      'message_id',
      'sequence',
      'text',
    ]);
    expect(Object.keys(receipt.turn).sort()).toEqual(['created_at', 'status', 'turn_id']);
    expect(JSON.stringify(receipt)).not.toContain(actor.tenantId);

    // `client_created_at` is echo-only diagnostics (O-4): accepted, and never echoed back.
    const withClientStamp = await postMessage(actor, {
      clientSubmissionId: randomUUID(),
      text: 'a message with a client timestamp',
      clientCreatedAt: '1970-01-01T00:00:00Z',
    });
    expect(withClientStamp.status).toBe(201);
    const stamped = await receiptOf(withClientStamp);
    expect(stamped.message).not.toHaveProperty('client_created_at');
    expect(stamped.message.sequence).toBe(2);
  });

  it('3. returns 201 only after the rows are committed and readable from another connection', async () => {
    const actor = await signIn('committed');
    const clientSubmissionId = randomUUID();
    const response = await postMessage(
      actor,
      { clientSubmissionId, text: 'a committed message' },
      undefined,
      buildHost(poolA).app,
    );

    expect(response.status).toBe(201);
    const receipt = await receiptOf(response);

    // The observer pool is a different PostgreSQL backend, so a 201 must already be visible (S-4).
    const message = await db.observerPool.query<{
      sequence: string;
      kind: string;
      text: string;
      client_submission_id: string;
      tenant_id: string;
    }>(
      `SELECT sequence, kind, text, client_submission_id, tenant_id
         FROM conversation_messages WHERE id = $1`,
      [receipt.message.message_id],
    );
    expect(message.rows).toHaveLength(1);
    expect(message.rows[0]).toMatchObject({
      sequence: '1',
      kind: 'user',
      text: 'a committed message',
      client_submission_id: clientSubmissionId,
      tenant_id: actor.tenantId,
    });

    const turn = await db.observerPool.query<{
      status: string;
      source_message_id: string;
      conversation_id: string;
    }>(
      `SELECT status, source_message_id, conversation_id
         FROM assistant_turns WHERE id = $1`,
      [receipt.turn.turn_id],
    );
    expect(turn.rows[0]).toMatchObject({
      status: 'running',
      source_message_id: receipt.message.message_id,
      conversation_id: actor.conversationId,
    });

    // S-1: one observable state, no message without its turn and no turn without its message.
    expect(await rows(actor.conversationId)).toMatchObject({
      messages: 1,
      turns: 1,
      lastSequence: 1,
    });
  });

  it('4. replays the same submission id and payload with 200 and the byte-identical receipt', async () => {
    const actor = await signIn('replay');
    const input: MessageInput = {
      clientSubmissionId: randomUUID(),
      text: 'retry after a lost ACK',
    };

    const first = await postMessage(actor, input);
    const second = await postMessage(actor, input);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);

    const firstText = await first.text();
    const secondText = await second.text();
    // N-2: the replay body is the original POST body, byte for byte.
    expect(secondText).toBe(firstText);

    const replay = B1SendMessageReceiptSchema.parse(JSON.parse(secondText));
    expect(replay.message.sequence).toBe(1);
    expect(replay.turn.status).toBe('running');

    expect(await rows(actor.conversationId)).toMatchObject({
      messages: 1,
      turns: 1,
      lastSequence: 1,
    });

    // A replay does not restart the Turn, so the deadline stays on the original row.
    const deadlines = await db.observerPool.query<{ total: string }>(
      `SELECT count(DISTINCT deadline_at)::text AS total FROM assistant_turns WHERE conversation_id = $1`,
      [actor.conversationId],
    );
    expect(deadlines.rows[0]?.total).toBe('1');
  });

  it('5. conflicts with 409 when a reused submission id changes the text or the conversation', async () => {
    const actor = await signIn('conflict');
    const clientSubmissionId = randomUUID();

    const committed = await postMessage(actor, {
      clientSubmissionId,
      text: 'the original wording',
    });
    expect(committed.status).toBe(201);

    const changedText = await postMessage(actor, {
      clientSubmissionId,
      text: 'different wording, same id',
    });
    expect(changedText.status).toBe(409);
    const conflict = await errorOf(changedText);
    expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // G-4: the rejected text is not echoed.
    expect(JSON.stringify(conflict)).not.toContain('different wording, same id');

    // CTO Decision 0002: one submission id may not name two Conversations of the same tenant.
    const otherConversation = await createSecondConversation(actor.tenantId);
    const changedConversation = await postMessage(
      actor,
      { clientSubmissionId, text: 'the original wording' },
      { conversationId: otherConversation },
    );
    expect(changedConversation.status).toBe(409);
    expect((await errorOf(changedConversation)).error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await rows(otherConversation)).toMatchObject({
      messages: 0,
      turns: 0,
      lastSequence: 0,
    });
    // The conflict wrote nothing anywhere: the original row is still the only one.
    expect(await rows(actor.conversationId)).toMatchObject({ messages: 1, turns: 1 });
  });

  it('6. keeps tenants isolated: a foreign Conversation is a 404, and the same id in another tenant is a 201', async () => {
    const owner = await signIn('isolation-owner');
    const stranger = await signIn('isolation-stranger');
    const submissionId = randomUUID();

    const foreign = await postMessage(
      stranger,
      { clientSubmissionId: submissionId, text: 'not your conversation' },
      { conversationId: owner.conversationId },
    );
    expect(foreign.status).toBe(404);
    const foreignBody = frozenErrorBody(await errorOf(foreign));
    expect(foreignBody).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Resource not found',
    });

    const unknown = await postMessage(
      stranger,
      {
        clientSubmissionId: randomUUID(),
        text: 'no such conversation',
      },
      { conversationId: randomUUID() },
    );
    expect(unknown.status).toBe(404);
    // ISO-3: cross-tenant access is indistinguishable from a missing resource, body included.
    expect(frozenErrorBody(await errorOf(unknown))).toEqual(foreignBody);

    // A tenant is never taken from the path (C-5), so the rejection wrote nothing for the owner.
    expect(await rows(owner.conversationId)).toMatchObject({ messages: 0, turns: 0 });

    // The legitimate owner still succeeds with that same submission id.
    const accepted = await postMessage(owner, {
      clientSubmissionId: submissionId,
      text: 'not your conversation',
    });
    expect(accepted.status).toBe(201);

    // …and the other tenant may use the same submission id for its own Conversation, because the
    // dedupe key is `(tenant_id, client_submission_id)`, not the id alone.
    const otherTenant = await postMessage(stranger, {
      clientSubmissionId: submissionId,
      text: 'not your conversation',
    });
    expect(otherTenant.status).toBe(201);
    expect((await receiptOf(otherTenant)).message.conversation_id).toBe(stranger.conversationId);

    expect(await rows(owner.conversationId)).toMatchObject({ messages: 1, turns: 1 });
    expect(await rows(stranger.conversationId)).toMatchObject({ messages: 1, turns: 1 });
  });

  it('7. fences a stale or an invented transcript epoch with one identical 409 body', async () => {
    const actor = await signIn('epoch');
    await db.pool.query('UPDATE conversations SET transcript_epoch = 1 WHERE id = $1', [
      actor.conversationId,
    ]);

    const stale = await postMessage(actor, {
      clientSubmissionId: randomUUID(),
      text: 'secret lunch plan',
      transcriptEpoch: 0,
    });
    const future = await postMessage(actor, {
      clientSubmissionId: randomUUID(),
      text: 'secret lunch plan',
      transcriptEpoch: 7,
    });

    expect(stale.status).toBe(409);
    expect(future.status).toBe(409);
    // TE-3: both causes share one wire body, and the route never refreshes the epoch and resends.
    const staleBody = frozenErrorBody(await errorOf(stale));
    expect(frozenErrorBody(await errorOf(future))).toEqual(staleBody);
    expect(staleBody).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Idempotency key conflicts with an existing command',
    });

    // `transcript_epoch` is mandatory: an omitted epoch cannot be fenced, so it is a 400 (T-4).
    const missing = await postMessage(actor, {
      clientSubmissionId: randomUUID(),
      text: 'no epoch at all',
      transcriptEpoch: null,
    });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).error.code).toBe('INVALID_ARGUMENT');

    const negative = await postMessage(actor, {
      clientSubmissionId: randomUUID(),
      text: 'a negative epoch',
      transcriptEpoch: -1,
    });
    expect(negative.status).toBe(400);

    // Nothing above wrote a row, and the deleted text was never re-inserted (§6.7).
    expect(await rows(actor.conversationId)).toMatchObject({
      messages: 0,
      turns: 0,
      lastSequence: 0,
      transcriptEpoch: 1,
    });

    // The client action a 409 requires: re-read the generation, then send deliberately with a new id.
    const deliberate = await postMessage(actor, {
      clientSubmissionId: randomUUID(),
      text: 'secret lunch plan',
      transcriptEpoch: 1,
    });
    expect(deliberate.status).toBe(201);
    expect((await receiptOf(deliberate)).transcript_epoch).toBe(1);
    expect(await rows(actor.conversationId)).toMatchObject({ messages: 1, turns: 1 });
  });

  it('8. requires application/json and enforces the frozen 16 KiB cap on the stream', async () => {
    const actor = await signIn('content-type');

    /**
     * A *schema-valid* body padded to an exact serialized byte count.
     *
     * `U+0001` is not whitespace, so `text.trim().length > 0` still holds, and JSON escaping spends
     * six bytes on each one (`\u0001`). That lets a body cross the 16 KiB cap while every field stays
     * inside the frozen schema — which is what makes the two boundary assertions below about the cap
     * alone: without the cap the same body would be accepted, and the only difference between the
     * accepted and the rejected body is a single byte.
     */
    const paddedValidBody = (targetBytes: number): string => {
      const clientSubmissionId = randomUUID();
      const envelope = JSON.stringify({
        client_submission_id: clientSubmissionId,
        text: '',
        transcript_epoch: 0,
      });
      const remaining = targetBytes - envelope.length;
      const escaped = Math.floor(remaining / 6);
      const plain = remaining - escaped * 6;
      const text = '\u0001'.repeat(escaped) + 'x'.repeat(plain);

      if (remaining < 0 || text.length > 4_096) {
        throw new Error(`cannot pad a schema-valid body up to ${targetBytes} bytes`);
      }

      const body = JSON.stringify({
        client_submission_id: clientSubmissionId,
        text,
        transcript_epoch: 0,
      });

      if (Buffer.byteLength(body, 'utf8') !== targetBytes) {
        throw new Error(`padded body is ${Buffer.byteLength(body, 'utf8')} bytes`);
      }

      return body;
    };

    // The cap is inclusive: exactly 16 KiB is a legal, schema-valid request (S-4 accepts it).
    const atCap = await sendForm(actor, undefined, {
      raw: paddedValidBody(MAX_MESSAGE_REQUEST_BYTES),
    });
    expect(atCap.status).toBe(201);
    expect((await receiptOf(atCap)).message.sequence).toBe(1);

    // One byte more is refused by the cap, not by the schema: same body, one byte longer.
    const oneOverCap = await sendForm(actor, undefined, {
      raw: paddedValidBody(MAX_MESSAGE_REQUEST_BYTES + 1),
    });
    expect(oneOverCap.status).toBe(400);
    expect((await errorOf(oneOverCap)).error.code).toBe('INVALID_ARGUMENT');

    // A declared Content-Length that is already too large is refused before any byte is read.
    const declaredTooLarge = await postMessage(actor, {
      clientSubmissionId: randomUUID(),
      text: 'declared too large',
      extra: { pad: 'y'.repeat(20_000) },
    });
    expect(declaredTooLarge.status).toBe(400);

    const plainText = await postMessage(
      actor,
      { clientSubmissionId: randomUUID(), text: 'wrong media type' },
      { contentType: 'text/plain' },
    );
    expect(plainText.status).toBe(400);
    expect((await errorOf(plainText)).error.code).toBe('INVALID_ARGUMENT');

    const noContentType = await postMessage(
      actor,
      { clientSubmissionId: randomUUID(), text: 'no media type' },
      { contentType: '' },
    );
    expect(noContentType.status).toBe(400);

    const emptyBody = await sendForm(actor, undefined, { raw: '' });
    expect(emptyBody.status).toBe(400);

    const malformed = await sendForm(actor, undefined, { raw: '{"text":' });
    expect(malformed.status).toBe(400);

    // A charset parameter is still `application/json`, and the limit that matters here is text: 4096
    // characters inside the 16 KiB envelope is accepted (M-6).
    const longest = await postMessage(
      actor,
      { clientSubmissionId: randomUUID(), text: 'x'.repeat(4_096) },
      { contentType: 'application/json; charset=utf-8' },
    );
    expect(longest.status).toBe(201);
    expect((await receiptOf(longest)).message.sequence).toBe(2);

    const tooLong = await postMessage(actor, {
      clientSubmissionId: randomUUID(),
      text: 'x'.repeat(4_097),
    });
    expect(tooLong.status).toBe(400);

    const blank = await postMessage(actor, {
      clientSubmissionId: randomUUID(),
      text: '   ',
    });
    expect(blank.status).toBe(400);

    // Only the two accepted sends wrote rows; every 400 above left the conversation untouched.
    expect(await rows(actor.conversationId)).toMatchObject({
      messages: 2,
      turns: 2,
      lastSequence: 2,
    });
  });

  it('9. rejects caller-supplied identity fields and a second idempotency mechanism', async () => {
    const actor = await signIn('smuggling');

    for (const [field, value] of [
      ['tenant_id', actor.tenantId],
      ['principal_id', randomUUID()],
      ['policy_version', 99],
    ] as const) {
      const response = await postMessage(actor, {
        clientSubmissionId: randomUUID(),
        text: `smuggled ${field}`,
        extra: { [field]: value },
      });
      expect([response.status, field]).toEqual([400, field]);
      expect((await errorOf(response)).error.code).toBe('INVALID_ARGUMENT');
    }

    const inQuery = await postMessage(
      actor,
      { clientSubmissionId: randomUUID(), text: 'scope in the query' },
      { query: `?tenant_id=${actor.tenantId}` },
    );
    expect(inQuery.status).toBe(400);
    expect((await errorOf(inQuery)).error.code).toBe('INVALID_ARGUMENT');

    const inHeader = await postMessage(
      actor,
      { clientSubmissionId: randomUUID(), text: 'scope in a header' },
      { headers: { 'x-principal-id': randomUUID() } },
    );
    expect(inHeader.status).toBe(400);
    expect((await errorOf(inHeader)).error.code).toBe('INVALID_ARGUMENT');

    // §6.4: the message route deliberately takes no `Idempotency-Key`. A route that ignored the
    // header would answer 201 here, so the 400 is what proves it is refused rather than accepted.
    const withLegacyKey = await postMessage(
      actor,
      { clientSubmissionId: randomUUID(), text: 'two keys for one write' },
      { headers: { 'Idempotency-Key': `idem-${randomUUID()}` } },
    );
    expect(withLegacyKey.status).toBe(400);
    expect((await errorOf(withLegacyKey)).error.code).toBe('INVALID_ARGUMENT');

    // A path id that is not a UUID never reaches SQL (§6.4 / C-5).
    const badId = await postMessage(
      actor,
      {
        clientSubmissionId: randomUUID(),
        text: 'bad conversation id',
      },
      { conversationId: 'not-a-uuid' },
    );
    expect(badId.status).toBe(400);
    expect((await errorOf(badId)).error.code).toBe('INVALID_ARGUMENT');

    // The dedupe key is a uuid v4, so a well-formed UUID of another version is refused too.
    const wrongVersion = await postMessage(actor, {
      clientSubmissionId: '00000000-0000-1000-8000-000000000000',
      text: 'not a uuid v4 submission id',
    });
    expect(wrongVersion.status).toBe(400);
    expect((await errorOf(wrongVersion)).error.code).toBe('INVALID_ARGUMENT');

    expect(await rows(actor.conversationId)).toMatchObject({ messages: 0, turns: 0 });
  });

  it('10. accepts two simultaneous identical POSTs as one message and one turn', async () => {
    const actor = await signIn('racers');
    const input: MessageInput = {
      clientSubmissionId: randomUUID(),
      text: 'the same message over two connections',
    };

    const hostA = buildHost(poolA);
    const hostB = buildHost(poolB);
    const [first, second] = await Promise.all([
      postMessage(actor, input, undefined, hostA.app),
      postMessage(actor, input, undefined, hostB.app),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 201]);

    const [firstReceipt, secondReceipt] = await Promise.all([receiptOf(first), receiptOf(second)]);
    expect(firstReceipt.message.message_id).toBe(secondReceipt.message.message_id);
    expect(firstReceipt.turn.turn_id).toBe(secondReceipt.turn.turn_id);
    expect(firstReceipt.message.sequence).toBe(1);

    expect(await rows(actor.conversationId)).toMatchObject({
      messages: 1,
      turns: 1,
      lastSequence: 1,
    });
  });

  it('11. enforces the 200-message rolling 24 h quota at its boundary with 429', async () => {
    const actor = await signIn('quota');
    const fill = B1_MESSAGE_QUOTA_LIMIT - 1;

    // Seed `fill` user messages, each with its own turn, so the HTTP boundary is the only variable.
    await db.pool.query(
      `WITH seeded AS (
         INSERT INTO conversation_messages
           (id, tenant_id, conversation_id, sequence, kind, text, client_submission_id)
         SELECT gen_random_uuid(), $1, $2, s, 'user', 'quota filler', gen_random_uuid()
           FROM generate_series(1, $3::int) AS s(s)
         RETURNING id, tenant_id, conversation_id
       )
       INSERT INTO assistant_turns (id, tenant_id, conversation_id, source_message_id, deadline_at)
       SELECT gen_random_uuid(), tenant_id, conversation_id, id, now() + interval '60 seconds'
         FROM seeded`,
      [actor.tenantId, actor.conversationId, fill],
    );
    await db.pool.query(
      'UPDATE conversations SET last_sequence = $2, updated_at = now() WHERE id = $1',
      [actor.conversationId, fill],
    );

    const boundary: MessageInput = {
      clientSubmissionId: randomUUID(),
      text: 'the boundary message',
    };

    const accepted = await postMessage(actor, boundary);
    expect(accepted.status).toBe(201);
    expect((await receiptOf(accepted)).message.sequence).toBe(B1_MESSAGE_QUOTA_LIMIT);

    const rejected = await postMessage(actor, {
      clientSubmissionId: randomUUID(),
      text: 'one message too many',
    });
    expect(rejected.status).toBe(429);
    const quota = await errorOf(rejected);
    expect(quota.error.code).toBe('BUDGET_EXCEEDED');
    expect(quota.error.message).toBe('Budget exceeded');
    expect(await rows(actor.conversationId)).toMatchObject({
      messages: B1_MESSAGE_QUOTA_LIMIT,
      lastSequence: B1_MESSAGE_QUOTA_LIMIT,
    });

    // A retry of the message that already committed is a replay, not a second quota unit (S-2/S-5).
    const replay = await postMessage(actor, boundary);
    expect(replay.status).toBe(200);
    expect(await rows(actor.conversationId)).toMatchObject({ messages: B1_MESSAGE_QUOTA_LIMIT });

    // The window rolls: ageing the fillers out of it makes room again.
    await db.pool.query(
      `UPDATE conversation_messages
          SET created_at = now() - interval '25 hours'
        WHERE conversation_id = $1 AND text = 'quota filler'`,
      [actor.conversationId],
    );
    const afterWindow = await postMessage(actor, {
      clientSubmissionId: randomUUID(),
      text: 'after the window rolled',
    });
    expect(afterWindow.status).toBe(201);
    expect((await receiptOf(afterWindow)).message.sequence).toBe(B1_MESSAGE_QUOTA_LIMIT + 1);
  });

  it('12. answers 503 when the write fails, with no receipt and no rows', async () => {
    const actor = await signIn('db-failure');
    const secretText = 'text that must not survive a failed write';
    const failedSubmissionId = randomUUID();

    await db.pool.query(`
CREATE FUNCTION ember_http_fail_turn_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'forced turn insert failure';
END
$fn$;
CREATE TRIGGER ember_http_fail_turn_insert
  BEFORE INSERT ON assistant_turns FOR EACH ROW
  EXECUTE FUNCTION ember_http_fail_turn_insert()
`);

    try {
      const response = await postMessage(actor, {
        clientSubmissionId: failedSubmissionId,
        text: secretText,
      });
      expect(response.status).toBe(503);

      const body = await errorOf(response);
      expect(body.error.code).toBe('DB_UNAVAILABLE');
      expect(body.error.message).toBe('Database is unavailable');

      for (const forbidden of [secretText, 'INSERT', 'assistant_turns', 'forced turn insert']) {
        expect(JSON.stringify(body)).not.toContain(forbidden);
      }

      // No fabricated ACK: an error body carries no receipt, and nothing became readable (S-4).
      expect(body).not.toHaveProperty('message');
      expect(body).not.toHaveProperty('turn');
      expect(await rows(actor.conversationId)).toMatchObject({
        messages: 0,
        turns: 0,
        lastSequence: 0,
      });
    } finally {
      await db.pool.query(
        `DROP TRIGGER ember_http_fail_turn_insert ON assistant_turns;
         DROP FUNCTION ember_http_fail_turn_insert()`,
      );
    }

    // The same submission id after the fault is still a new write, because nothing committed, and
    // the client keeps the same epoch — the retry rule from §10.3.
    const retry = await postMessage(actor, {
      clientSubmissionId: failedSubmissionId,
      text: secretText,
    });
    expect(retry.status).toBe(201);
    expect((await receiptOf(retry)).message.sequence).toBe(1);
  });

  it('13. logs no message text, no session token and no Authorization header (G-1/G-2/G-3)', async () => {
    const logged = buildHost(db.pool);
    const actor = await signIn('logging');
    const secretText = 'a lunch plan nobody may read';
    const headers = { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' };

    // A 201, a second write, a refused header, a 401, a 404, a 400 and a 409: every logging branch.
    await logged.app.request(messagePath(actor.conversationId), {
      method: 'POST',
      headers,
      body: JSON.stringify(messageBody({ clientSubmissionId: randomUUID(), text: secretText })),
    });
    await logged.app.request(messagePath(actor.conversationId), {
      method: 'POST',
      headers,
      body: JSON.stringify(messageBody({ clientSubmissionId: randomUUID(), text: secretText })),
    });
    await logged.app.request(messagePath(actor.conversationId), {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `idem-${randomUUID()}` },
      body: JSON.stringify(messageBody({ clientSubmissionId: randomUUID(), text: secretText })),
    });
    await logged.app.request(messagePath(actor.conversationId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messageBody({ clientSubmissionId: randomUUID(), text: secretText })),
    });
    await logged.app.request(messagePath(randomUUID()), {
      method: 'POST',
      headers,
      body: JSON.stringify(messageBody({ clientSubmissionId: randomUUID(), text: secretText })),
    });
    await logged.app.request('/v1/conversations/not-a-uuid/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(messageBody({ clientSubmissionId: randomUUID(), text: secretText })),
    });
    // A 409 from a reused id with different text, so the conflict path is captured too.
    const sharedId = randomUUID();
    await logged.app.request(messagePath(actor.conversationId), {
      method: 'POST',
      headers,
      body: JSON.stringify(messageBody({ clientSubmissionId: sharedId, text: 'first wording' })),
    });
    await logged.app.request(messagePath(actor.conversationId), {
      method: 'POST',
      headers,
      body: JSON.stringify(messageBody({ clientSubmissionId: sharedId, text: secretText })),
    });

    const captured = logged.logLines.join('\n');
    // The 401 and the 404/409 DomainError paths are logged, so a leak would be visible here.
    expect(captured.length).toBeGreaterThan(0);

    for (const forbidden of [secretText, actor.token, 'Bearer', 'authorization', 'lunch plan']) {
      expect(captured).not.toContain(forbidden);
    }

    for (const line of logged.logLines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      // G-5: an allowlisted field set, so an added field is a deliberate change.
      expect(Object.keys(parsed).sort()).toEqual(
        expect.arrayContaining(['level', 'time', 'message']),
      );
      for (const forbidden of [
        'body',
        'text',
        'token',
        'authorization',
        'tenantId',
        'principalId',
        'policyVersion',
      ]) {
        expect(parsed).not.toHaveProperty(forbidden);
      }
    }
  });

  it('14. leaves the legacy Task Idempotency-Key discipline untouched', async () => {
    const taskTenant = await createTenantFixture(db.pool, 'b1-3b legacy task tenant');
    const agents = new PostgresAgentRepository(db.pool);
    const created = await agents.create(
      { tenantId: taskTenant.tenantId, principalId: taskTenant.principalId, policyVersion: 1 },
      { name: 'b1-3b legacy agent' },
    );
    const devToken = `token-${randomUUID()}`;
    const tenantAuth = requireTenantAuth({
      authenticator: createDevTokenAuthenticator([
        {
          token: devToken,
          tenantId: taskTenant.tenantId,
          principalId: taskTenant.principalId,
          policyVersion: 1,
        },
      ]),
    });

    // The coexistence the CTO will mount: legacy Task auth on `/v1/tasks`, B1 session auth on
    // `/v1/conversations/...`, one host, neither reaching the other's credential.
    const app = new Hono<AppBindings>();
    app.use(
      '*',
      requestIdMiddleware(() => `it-request-${randomUUID()}`),
    );
    app.use(TASKS_PATH, tenantAuth);
    app.use(`${TASKS_PATH}/*`, tenantAuth);
    app.route(TASKS_PATH, createTaskRoutes({ store: new PostgresTaskRepository(db.pool) }));
    app.route(
      MESSAGE_WRITE_MOUNT_PATH,
      createConversationMessageWriteRoutes({
        session: service,
        conversations: new PostgresB1ConversationWriteRepository(db.pool),
      }),
    );

    const actor = await signIn('coexisting');
    const key = `idem-${randomUUID()}`;
    const taskHeaders = {
      authorization: `Bearer ${devToken}`,
      'content-type': 'application/json',
      'Idempotency-Key': key,
    };
    const taskBody = JSON.stringify({
      agent_id: created.agentId,
      kind: 'mock.chat',
      input: { prompt: 'the legacy header still works next to B1-3B' },
    });

    const first = await app.request(TASKS_PATH, {
      method: 'POST',
      headers: taskHeaders,
      body: taskBody,
    });
    expect(first.status).toBe(202);
    expect(((await first.json()) as Record<string, unknown>).replayed).toBe(false);

    const replay = await app.request(TASKS_PATH, {
      method: 'POST',
      headers: taskHeaders,
      body: taskBody,
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as Record<string, unknown>).replayed).toBe(true);

    // The two mechanisms do not overlap: required for Tasks, refused for messages (§6.4, N-6).
    const messageWithKey = await app.request(messagePath(actor.conversationId), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${actor.token}`,
        'content-type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(
        messageBody({ clientSubmissionId: randomUUID(), text: 'messages take no header' }),
      ),
    });
    expect(messageWithKey.status).toBe(400);

    const taskWithSession = await app.request(TASKS_PATH, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${actor.token}`,
        'content-type': 'application/json',
        'Idempotency-Key': `idem-${randomUUID()}`,
      },
      body: taskBody,
    });
    expect(taskWithSession.status).toBe(401);

    const messageWithDevToken = await app.request(messagePath(actor.conversationId), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${devToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        messageBody({ clientSubmissionId: randomUUID(), text: 'dev tokens are not sessions' }),
      ),
    });
    expect(messageWithDevToken.status).toBe(401);

    // The B1 route still works in the mounted shape, so the composition is not the reason it fails.
    const mounted = await app.request(messagePath(actor.conversationId), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${actor.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        messageBody({ clientSubmissionId: randomUUID(), text: 'mounted next to the legacy API' }),
      ),
    });
    expect(mounted.status).toBe(201);
    expect((await receiptOf(mounted)).message.sequence).toBe(1);

    const tasks = await db.observerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tasks WHERE tenant_id = $1',
      [taskTenant.tenantId],
    );
    expect(tasks.rows[0]?.count).toBe('1');
  });

  it('15. exposes exactly the frozen §6.4 path and no other method', async () => {
    const actor = await signIn('surface');

    // The constants a mounting host composes into `POST /v1/conversations/{conversation_id}/messages`.
    expect(MESSAGE_WRITE_MOUNT_PATH).toBe('/v1');
    expect(MESSAGE_WRITE_ROUTE_PATH).toBe('/conversations/:conversationId/messages');

    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await host.app.request(messagePath(actor.conversationId), {
        method,
        headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' },
        body:
          method === 'GET' || method === 'DELETE'
            ? undefined
            : JSON.stringify(
                messageBody({
                  clientSubmissionId: randomUUID(),
                  text: `${method} is not the contract`,
                }),
              ),
      });
      expect([response.status, method]).toEqual([404, method]);
    }

    expect(await rows(actor.conversationId)).toMatchObject({ messages: 0, turns: 0 });
  });
});
