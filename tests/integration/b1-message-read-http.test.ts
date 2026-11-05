import { randomUUID } from 'node:crypto';
import {
  B1ConversationPageSchema,
  B1MessageSubmissionReconciliationDtoSchema,
  B1SendMessageReceiptSchema,
  ErrorResponseSchema,
  type B1ConversationPage,
  type B1SendMessageReceipt,
  type ErrorResponse,
} from '@ember/contracts';
import { createPool, loadDatabaseConfig } from '@ember/postgres';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSessionService,
  type B1SessionPorts,
} from '../../apps/api/src/auth/session-service.js';
import {
  CONVERSATION_MESSAGES_ROUTE_PATH,
  MESSAGE_PAGE_DEFAULT_LIMIT,
  MESSAGE_PAGE_MAX_LIMIT,
  MESSAGE_READ_MOUNT_PATH,
  MESSAGE_SUBMISSION_ROUTE_PATH,
  createConversationMessageReadRoutes,
} from '../../apps/api/src/conversation/message-read-routes.js';
import { createConversationMessageWriteRoutes } from '../../apps/api/src/conversation/message-write-routes.js';
import { requestIdMiddleware, type AppBindings } from '../../apps/api/src/http/app-context.js';
import { createLogger } from '../../apps/api/src/logger.js';
import {
  B1_MESSAGE_PAGE_DEFAULT_LIMIT,
  B1_MESSAGE_PAGE_MAX_LIMIT,
  PostgresB1ConversationReadRepository,
} from '../../packages/postgres/src/repositories/b1-conversation-read.js';
import { PostgresB1ConversationWriteRepository } from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import { PostgresB1ConsumerProvisioningRepository } from '../../packages/postgres/src/repositories/b1-session-provisioning-repository.js';
import { PostgresB1ConsumerSessionRepository } from '../../packages/postgres/src/repositories/b1-session-repository.js';
import { createTestDatabase, type TestDatabase, type TestPool } from './support/database.js';

/**
 * B1-4B: the two Conversation READ endpoints over HTTP, against the real PostgreSQL 17 read
 * repository from PR #106 and the real `requireSessionAuth` middleware.
 *
 * There is no fake SQL reader here. Every page this file asserts on is a query executed against the
 * throwaway schema the migrations built, and every receipt it replays was written by the real PR #105
 * write repository — so "the ACK the server already sent" is literally the ACK that repository
 * produced, not a fixture that agrees with the code under test by construction.
 *
 * The app under test is assembled in this file instead of taken from `createApp`, because B1-4B is
 * deliberately not mounted in the shared app yet: the CTO mounts it after B1-2C. The assertions that
 * matter for that handoff are (a) both routes answer with the frozen §6.5 / §10.1 semantics standing
 * alone, and (b) composing them next to the B1-3B write route changes neither one.
 *
 * Sessions are deterministic fixtures inside this file only. They are minted through
 * `createSessionService` over the real consumer/session repositories, so the routes authenticate
 * through the same Ember Session boundary they will use in production, and no fixture ever injects a
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

interface ReadOptions {
  readonly token?: string | null;
  readonly conversationId?: string;
  readonly query?: string;
  readonly headers?: Record<string, string>;
  readonly app?: Hono<AppBindings>;
}

let db: TestDatabase;
let service: ReturnType<typeof createSessionService>;
let host: Host;
let writer: PostgresB1ConversationWriteRepository;

/** RFC 3339 UTC, as `IsoDateTimeSchema` requires. Server-owned, so checked as shape not value. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `host.app` plus a real logger at the widest level, so a leaked payload would be captured (G-6). */
function buildHost(readPool: TestPool): Host {
  const logLines: string[] = [];
  const app = new Hono<AppBindings>();

  app.use(
    '*',
    requestIdMiddleware(() => `it-read-request-${randomUUID()}`),
  );
  app.route(
    MESSAGE_READ_MOUNT_PATH,
    createConversationMessageReadRoutes({
      session: service,
      conversations: new PostgresB1ConversationReadRepository(readPool),
      logger: createLogger({ level: 'debug', sink: (_level, line) => logLines.push(line) }),
    }),
  );

  return { app, logLines };
}

function messagePagePath(conversationId: string, query = ''): string {
  return `/v1/conversations/${conversationId}/messages${query}`;
}

function submissionPath(clientSubmissionId: string, query = ''): string {
  return `/v1/message-submissions/${clientSubmissionId}${query}`;
}

/** The only way a test reaches a read route: through HTTP, never through the repository. */
async function getMessages(actor: Actor, options: ReadOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};

  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? actor.token}`;
  }

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name] = value;
  }

  // `app.request` is `Response | Promise<Response>` depending on the handler, so the helper awaits
  // rather than trying to narrow the union at every call site.
  return await (options.app ?? host.app).request(
    messagePagePath(options.conversationId ?? actor.conversationId, options.query ?? ''),
    { method: 'GET', headers },
  );
}

async function getSubmission(
  actor: Actor,
  clientSubmissionId: string,
  options: ReadOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {};

  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? actor.token}`;
  }

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name] = value;
  }

  return await (options.app ?? host.app).request(
    submissionPath(clientSubmissionId, options.query ?? ''),
    { method: 'GET', headers },
  );
}

/** Sign in through the real session service, so the token is one the middleware can resolve. */
async function signIn(label: string): Promise<Actor> {
  const session = await service.createSession({
    provider: 'dev',
    providerSubject: `b1-4b-${label}-${randomUUID()}`,
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

/** Seed through the real PR #105 write path, so the receipt under test is the one a client got. */
async function send(
  actor: Actor,
  text: string,
  options: { readonly clientSubmissionId?: string; readonly conversationId?: string } = {},
): Promise<B1SendMessageReceipt> {
  const outcome = await writer.submitUserMessage({
    tenantId: actor.tenantId,
    conversationId: options.conversationId ?? actor.conversationId,
    request: {
      client_submission_id: options.clientSubmissionId ?? randomUUID(),
      text,
      transcript_epoch: 0,
    },
  });

  return outcome.receipt;
}

interface MessageRow {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly kind: string;
  readonly text?: string | null;
  readonly modelLabel?: string | null;
  readonly simulated?: boolean | null;
  readonly source?: string | null;
  readonly taskId?: string | null;
  readonly commitmentId?: string | null;
  readonly outcome?: unknown;
  readonly clientSubmissionId?: string | null;
}

/**
 * Direct SQL fixture for the variants the write path does not produce (B1 has no activity, reference
 * or outcome producer yet). The sequence is allocated the way a writer would: by incrementing the
 * Conversation's counter, never by reading the max of the table.
 */
async function insertMessage(row: MessageRow): Promise<{ id: string; sequence: number }> {
  const allocated = await db.pool.query<{ last_sequence: string }>(
    'UPDATE conversations SET last_sequence = last_sequence + 1 WHERE id = $1 RETURNING last_sequence',
    [row.conversationId],
  );
  const sequence = Number(allocated.rows[0]?.last_sequence);
  const id = randomUUID();

  await db.pool.query(
    `INSERT INTO conversation_messages
       (id, tenant_id, conversation_id, sequence, kind, text, model_label, simulated,
        source, task_id, commitment_id, outcome, client_submission_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      row.tenantId,
      row.conversationId,
      sequence,
      row.kind,
      row.text ?? null,
      row.modelLabel ?? null,
      row.simulated ?? null,
      row.source ?? null,
      row.taskId ?? null,
      row.commitmentId ?? null,
      row.outcome ?? null,
      row.clientSubmissionId ?? null,
    ],
  );

  return { id, sequence };
}

/** `n` user rows in one statement: exact counts matter more than per-row identity here. */
async function bulkUserMessages(
  actor: Actor,
  count: number,
  conversationId = actor.conversationId,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO conversation_messages
       (id, tenant_id, conversation_id, sequence, kind, text, client_submission_id)
     SELECT gen_random_uuid(), $1, $2, g, 'user', 'bulk ' || g, gen_random_uuid()
       FROM generate_series(1, $3) AS g`,
    [actor.tenantId, conversationId, count],
  );
  await db.pool.query('UPDATE conversations SET last_sequence = $2 WHERE id = $1', [
    conversationId,
    count,
  ]);
}

async function seedTask(actor: Actor): Promise<string> {
  const agent = await db.pool.query<{ agent_id: string }>(
    'SELECT agent_id FROM conversations WHERE id = $1',
    [actor.conversationId],
  );
  const agentId = agent.rows[0]?.agent_id;
  const id = randomUUID();

  await db.pool.query(
    `INSERT INTO tasks (id, tenant_id, agent_id, kind, input, digest, idempotency_key)
     VALUES ($1, $2, $3, 'mock.chat', '{}'::jsonb, $4, $5)`,
    [id, actor.tenantId, agentId, 'a'.repeat(64), `task-${id}`],
  );

  return id;
}

async function seedCommitment(actor: Actor): Promise<string> {
  const agent = await db.pool.query<{ agent_id: string }>(
    'SELECT agent_id FROM conversations WHERE id = $1',
    [actor.conversationId],
  );
  const agentId = agent.rows[0]?.agent_id;
  const id = randomUUID();

  await db.pool.query(
    `INSERT INTO commitments (id, tenant_id, agent_id, title, schedule_kind, source_profile_id)
     VALUES ($1, $2, $3, 'Read-side HTTP fixture', 'once', 'test.profile')`,
    [id, actor.tenantId, agentId],
  );

  return id;
}

/**
 * §10.4 deletion exactly as the clear-transcript route performs it: the rows go and the epoch
 * advances by one in the same transaction. B1-8 owns the route; this test owns the state it leaves.
 */
async function clearTranscript(actor: Actor): Promise<void> {
  await db.pool.query('BEGIN');
  try {
    await db.pool.query('DELETE FROM conversation_messages WHERE tenant_id = $1', [actor.tenantId]);
    await db.pool.query(
      'UPDATE conversations SET transcript_epoch = transcript_epoch + 1 WHERE tenant_id = $1',
      [actor.tenantId],
    );
    await db.pool.query('COMMIT');
  } catch (error) {
    await db.pool.query('ROLLBACK');
    throw error;
  }
}

async function pageOf(response: Response): Promise<B1ConversationPage> {
  return B1ConversationPageSchema.parse(await response.json());
}

/** Text of the `user` rows only: reference variants legitimately carry no `text` field at all. */
function userTexts(page: B1ConversationPage): readonly string[] {
  return page.messages.flatMap((message) => (message.kind === 'user' ? [message.text] : []));
}

async function errorOf(response: Response): Promise<ErrorResponse> {
  return ErrorResponseSchema.parse(await response.json());
}

/**
 * The error body without its per-request correlation id.
 *
 * `X-Request-Id` is generated per request, so two responses can never be byte-identical. Every
 * invariant that says "the same body" (ISO-3 for a foreign versus a missing Conversation or
 * submission) is therefore asserted on the part the contract actually freezes: the `code` and the
 * fixed `message` chosen by that code.
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

  const ports: B1SessionPorts = {
    provisioning: new PostgresB1ConsumerProvisioningRepository(db.pool),
    sessions: new PostgresB1ConsumerSessionRepository(db.pool),
    // `GET /v1/me` belongs to another slice; these routes never reach it.
    me: {
      getMeForTenant: () => Promise.reject(new Error('the me projection is not used by B1-4B')),
    },
  };
  service = createSessionService({ ports });
  host = buildHost(db.pool);
  writer = new PostgresB1ConversationWriteRepository(db.pool);
});

afterAll(async () => {
  await db?.close();
});

describe('B1-4B: Conversation message read and Unknown-ACK HTTP API on PostgreSQL 17', () => {
  it('1. rejects a missing, malformed, unknown or revoked session with 401 on both routes', async () => {
    const actor = await signIn('unauthenticated');
    const submissionId = randomUUID();

    const cases: readonly (readonly [string, ReadOptions])[] = [
      ['no Authorization header', { token: null }],
      ['a bearer that is not an Ember session', { token: 'dev-token-not-an-ems-session' }],
      ['a well-formed but unknown ems_ token', { token: `ems_${'a'.repeat(43)}` }],
      [
        'a wrong scheme',
        { token: actor.token, headers: { authorization: `token ${actor.token}` } },
      ],
    ];

    for (const [label, options] of cases) {
      const page = await getMessages(actor, options);
      expect([page.status, label]).toEqual([401, label]);
      expect((await errorOf(page)).error.code).toBe('UNAUTHENTICATED');

      const receipt = await getSubmission(actor, submissionId, options);
      expect([receipt.status, label]).toEqual([401, label]);

      const body = await errorOf(receipt);
      expect(body.error.code).toBe('UNAUTHENTICATED');
      expect(body.error.message).toBe('Authentication required');
      // The host's request id survives the route-local error boundary.
      expect(body.error.request_id).toMatch(/^it-read-request-/);
    }

    // The fourth path to 401: a real session whose row is revoked, so the token is still well-formed.
    const revoked = await signIn('revoked');
    await db.pool.query(
      `UPDATE consumer_sessions
          SET revoked_at = now(), revocation_reason = 'logout'
        WHERE tenant_id = $1`,
      [revoked.tenantId],
    );

    const revokedPage = await getMessages(revoked);
    expect(revokedPage.status).toBe(401);

    const revokedReceipt = await getSubmission(revoked, submissionId);
    expect(revokedReceipt.status).toBe(401);

    // Nothing was read: neither body carries a page or a receipt shape.
    for (const response of [revokedPage, revokedReceipt]) {
      const body = await errorOf(response);
      expect(body.error.code).toBe('UNAUTHENTICATED');
      expect(Object.keys(body)).toEqual(['error']);
    }
  });

  it('2. returns the canonical initial load for a verified Session', async () => {
    const actor = await signIn('initial-load');
    const first = await send(actor, 'Book me a table for two on Friday');
    const second = await send(actor, 'And a high chair');

    const response = await getMessages(actor);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-request-id')).toMatch(/^it-read-request-/);

    const page = await pageOf(response);
    expect(page).toEqual({
      conversation_id: actor.conversationId,
      transcript_epoch: 0,
      messages: [
        {
          message_id: first.message.message_id,
          sequence: 1,
          kind: 'user',
          text: 'Book me a table for two on Friday',
          client_submission_id: first.message.client_submission_id,
          created_at: first.message.created_at,
        },
        {
          message_id: second.message.message_id,
          sequence: 2,
          kind: 'user',
          text: 'And a high chair',
          client_submission_id: second.message.client_submission_id,
          created_at: second.message.created_at,
        },
      ],
      next_after: 2,
      has_more: false,
    });

    // The page body has exactly the frozen keys — no conversation state, no cursor internals (RD-5).
    expect(Object.keys(page).sort()).toEqual([
      'conversation_id',
      'has_more',
      'messages',
      'next_after',
      'transcript_epoch',
    ]);
  });

  it('3. renders every frozen message variant and leaks no internal column', async () => {
    const actor = await signIn('variants');
    const taskId = await seedTask(actor);
    const commitmentId = await seedCommitment(actor);
    const submissionId = randomUUID();

    const user = await insertMessage({
      tenantId: actor.tenantId,
      conversationId: actor.conversationId,
      kind: 'user',
      text: 'link it to a task',
      clientSubmissionId: submissionId,
    });
    const ember = await insertMessage({
      tenantId: actor.tenantId,
      conversationId: actor.conversationId,
      kind: 'ember',
      text: 'Done.',
      modelLabel: 'ember-fake-llm-1',
      simulated: true,
    });
    const activity = await insertMessage({
      tenantId: actor.tenantId,
      conversationId: actor.conversationId,
      kind: 'activity',
      text: 'Thinking',
      source: 'ember.turn',
    });
    const taskReference = await insertMessage({
      tenantId: actor.tenantId,
      conversationId: actor.conversationId,
      kind: 'task_reference',
      taskId,
    });
    const commitmentReference = await insertMessage({
      tenantId: actor.tenantId,
      conversationId: actor.conversationId,
      kind: 'commitment_reference',
      commitmentId,
    });
    const outcomeReference = await insertMessage({
      tenantId: actor.tenantId,
      conversationId: actor.conversationId,
      kind: 'outcome_reference',
      outcome: { outcome_kind: 'meaningful_change', task_id: taskId, commitment_id: null },
    });

    const page = await pageOf(await getMessages(actor, { query: '?limit=100' }));

    expect(page.messages.map((message) => message.kind)).toEqual([
      'user',
      'ember',
      'activity',
      'task_reference',
      'commitment_reference',
      'outcome_reference',
    ]);

    // Each variant carries exactly its own fields: no `tenant_id`, no `conversation_id` per row, and
    // no variant's field on another variant (M-1, M-2/M-3). `created_at` is server-owned, so it is
    // checked as shape rather than value.
    const expectations = [
      {
        message: page.messages[0],
        kind: 'user',
        fields: {
          message_id: user.id,
          sequence: user.sequence,
          text: 'link it to a task',
          client_submission_id: submissionId,
        },
        keys: ['client_submission_id', 'created_at', 'kind', 'message_id', 'sequence', 'text'],
      },
      {
        message: page.messages[1],
        kind: 'ember',
        fields: {
          message_id: ember.id,
          sequence: ember.sequence,
          text: 'Done.',
          model_label: 'ember-fake-llm-1',
          simulated: true,
        },
        keys: ['created_at', 'kind', 'message_id', 'model_label', 'sequence', 'simulated', 'text'],
      },
      {
        message: page.messages[2],
        kind: 'activity',
        fields: {
          message_id: activity.id,
          sequence: activity.sequence,
          text: 'Thinking',
          source: 'ember.turn',
        },
        keys: ['created_at', 'kind', 'message_id', 'sequence', 'source', 'text'],
      },
      {
        message: page.messages[3],
        kind: 'task_reference',
        fields: { message_id: taskReference.id, sequence: taskReference.sequence, task_id: taskId },
        keys: ['created_at', 'kind', 'message_id', 'sequence', 'task_id'],
      },
      {
        message: page.messages[4],
        kind: 'commitment_reference',
        fields: {
          message_id: commitmentReference.id,
          sequence: commitmentReference.sequence,
          commitment_id: commitmentId,
        },
        keys: ['commitment_id', 'created_at', 'kind', 'message_id', 'sequence'],
      },
      {
        message: page.messages[5],
        kind: 'outcome_reference',
        fields: {
          message_id: outcomeReference.id,
          sequence: outcomeReference.sequence,
          outcome: { outcome_kind: 'meaningful_change', task_id: taskId, commitment_id: null },
        },
        keys: ['created_at', 'kind', 'message_id', 'outcome', 'sequence'],
      },
    ] as const;

    for (const { message, kind, fields, keys } of expectations) {
      expect(message?.kind).toBe(kind);
      expect(message).toMatchObject(fields);
      // The exact key set proves no internal column and no other variant's field leaked (M-2/M-3).
      expect(Object.keys(message ?? {}).sort()).toEqual([...keys]);
      expect(message?.created_at ?? '').toMatch(ISO_TIMESTAMP);
    }
  });

  it('4. pages forward with after and the limit+1 probe, without overlap or gap', async () => {
    const actor = await signIn('pagination');
    await bulkUserMessages(actor, 5);

    const first = await pageOf(await getMessages(actor, { query: '?limit=2' }));
    expect(first.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(first.next_after).toBe(2);
    expect(first.has_more).toBe(true);

    const second = await pageOf(await getMessages(actor, { query: '?limit=2&after=2' }));
    expect(second.messages.map((message) => message.sequence)).toEqual([3, 4]);
    expect(second.next_after).toBe(4);
    expect(second.has_more).toBe(true);

    const third = await pageOf(await getMessages(actor, { query: '?limit=2&after=4' }));
    expect(third.messages.map((message) => message.sequence)).toEqual([5]);
    expect(third.next_after).toBe(5);
    // RD-3: the probe row (sequence 6) does not exist, so the last page says so.
    expect(third.has_more).toBe(false);

    // RD-1: re-issuing the last `next_after` is the same call path as the initial load.
    const exhausted = await pageOf(await getMessages(actor, { query: '?after=5' }));
    expect(exhausted).toEqual({
      conversation_id: actor.conversationId,
      transcript_epoch: 0,
      messages: [],
      next_after: 5,
      has_more: false,
    });

    // A cursor sweep equals one full page: no row is skipped and none is served twice.
    const swept = [first, second, third].flatMap((page) => page.messages);
    const whole = await pageOf(await getMessages(actor, { query: '?limit=100' }));
    expect(swept.map((message) => message.message_id)).toEqual(
      whole.messages.map((message) => message.message_id),
    );
    expect(new Set(swept.map((message) => message.sequence)).size).toBe(5);
  });

  it('5. applies the frozen default limit of 50 and the maximum of 100', async () => {
    // The HTTP bounds are duplicated locally because the package index does not export them; this is
    // the assertion that keeps the copies equal to the repository's.
    expect(MESSAGE_PAGE_DEFAULT_LIMIT).toBe(B1_MESSAGE_PAGE_DEFAULT_LIMIT);
    expect(MESSAGE_PAGE_MAX_LIMIT).toBe(B1_MESSAGE_PAGE_MAX_LIMIT);

    const actor = await signIn('limits');
    await bulkUserMessages(actor, 51);

    const byDefault = await pageOf(await getMessages(actor));
    expect(byDefault.messages).toHaveLength(MESSAGE_PAGE_DEFAULT_LIMIT);
    expect(byDefault.next_after).toBe(MESSAGE_PAGE_DEFAULT_LIMIT);
    expect(byDefault.has_more).toBe(true);

    const atMaximum = await pageOf(await getMessages(actor, { query: '?limit=100' }));
    expect(atMaximum.messages).toHaveLength(51);
    expect(atMaximum.has_more).toBe(false);

    const single = await pageOf(await getMessages(actor, { query: '?limit=1' }));
    expect(single.messages).toHaveLength(1);
    expect(single.has_more).toBe(true);

    // `after` is exclusive, so `after=1` starts at 2 rather than repeating sequence 1.
    const afterOne = await pageOf(await getMessages(actor, { query: '?after=1&limit=1' }));
    expect(afterOne.messages[0]?.sequence).toBe(2);
  });

  it('6. keeps ascending order across a deletion gap instead of renumbering', async () => {
    const actor = await signIn('gaps');
    const seeded = [];

    for (const text of ['one', 'two', 'three', 'four']) {
      seeded.push(
        await insertMessage({
          tenantId: actor.tenantId,
          conversationId: actor.conversationId,
          kind: 'user',
          text,
          clientSubmissionId: randomUUID(),
        }),
      );
    }

    await db.pool.query(
      'DELETE FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2 AND sequence = 2',
      [actor.tenantId, actor.conversationId],
    );

    const page = await pageOf(await getMessages(actor));
    expect(page.messages.map((message) => message.sequence)).toEqual([1, 3, 4]);
    expect(page.next_after).toBe(4);
    // RD-2: the gap is a deletion, not a missing page.
    expect(userTexts(page)).toEqual(['one', 'three', 'four']);
  });

  it('7. replays the original POST receipt byte-for-byte for a known submission', async () => {
    const actor = await signIn('unknown-ack');
    const clientSubmissionId = randomUUID();
    const receipt = await send(actor, 'The ACK I never received', { clientSubmissionId });

    const response = await getSubmission(actor, clientSubmissionId);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const replayed = B1MessageSubmissionReconciliationDtoSchema.parse(await response.json());

    // The contract says "the identical POST body" (N-2), so this compares the serialised form, not
    // merely a matching shape.
    expect(JSON.stringify(replayed)).toBe(
      JSON.stringify(B1SendMessageReceiptSchema.parse(receipt)),
    );
    expect(replayed.turn.status).toBe('running');
    expect(replayed.transcript_epoch).toBe(0);
  });

  it('8. returns the acknowledged receipt, never the Turn’s current state', async () => {
    const actor = await signIn('receipt-frozen');
    const clientSubmissionId = randomUUID();
    const receipt = await send(actor, 'Will you finish this turn?', { clientSubmissionId });

    // The responder finishes: an `ember` message plus the running -> completed transition (§7.1).
    const responseMessage = await insertMessage({
      tenantId: actor.tenantId,
      conversationId: actor.conversationId,
      kind: 'ember',
      text: 'Yes.',
      modelLabel: 'ember-fake-llm-1',
      simulated: true,
    });
    await db.pool.query(
      `UPDATE assistant_turns
          SET status = 'completed', response_message_id = $2, updated_at = now()
        WHERE tenant_id = $1 AND id = $3`,
      [actor.tenantId, responseMessage.id, receipt.turn.turn_id],
    );

    const replayed = B1MessageSubmissionReconciliationDtoSchema.parse(
      await (await getSubmission(actor, clientSubmissionId)).json(),
    );

    // §7.4: turn state is a different resource. The receipt stays the ACK that was sent at 201.
    expect(replayed.turn.status).toBe('running');
    expect(JSON.stringify(replayed)).toBe(
      JSON.stringify(B1SendMessageReceiptSchema.parse(receipt)),
    );
  });

  it('9. answers one identical 404 for unknown, foreign and deleted submissions', async () => {
    const owner = await signIn('submission-owner');
    const stranger = await signIn('submission-stranger');
    const submissionId = randomUUID();
    await send(owner, 'only the owner may reconcile this', { clientSubmissionId: submissionId });

    const owned = await getSubmission(owner, submissionId);
    expect(owned.status).toBe(200);

    const foreign = await getSubmission(stranger, submissionId);
    expect(foreign.status).toBe(404);
    const foreignBody = await errorOf(foreign);
    expect(foreignBody.error.code).toBe('NOT_FOUND');

    const unknown = await getSubmission(stranger, randomUUID());
    expect(unknown.status).toBe(404);
    // N-5 / ISO-3: a foreign submission and an absent one are the same answer, body included.
    expect(frozenErrorBody(await errorOf(unknown))).toEqual(frozenErrorBody(foreignBody));

    // TE-6: after a transcript deletion the row is gone, so the receipt is gone too — no tombstone.
    await clearTranscript(owner);
    const deleted = await getSubmission(owner, submissionId);
    expect(deleted.status).toBe(404);
    expect(frozenErrorBody(await errorOf(deleted))).toEqual(frozenErrorBody(foreignBody));

    // The page agrees: empty, and the epoch moved by exactly one (TE-2, RD-6).
    const page = await pageOf(await getMessages(owner));
    expect(page.messages).toEqual([]);
    expect(page.transcript_epoch).toBe(1);

    // A 404 carries no retry instruction and no receipt fields (N-12, G-4).
    const body = (await (await getSubmission(owner, submissionId)).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body)).toEqual(['error']);
  });

  it('10. isolates tenants in both directions for pages and receipts', async () => {
    const a = await signIn('isolation-a');
    const b = await signIn('isolation-b');
    const aSubmission = randomUUID();
    const bSubmission = randomUUID();
    const aReceipt = await send(a, 'A private message', { clientSubmissionId: aSubmission });
    await send(b, 'B private message', { clientSubmissionId: bSubmission });

    const bReadingA = await getMessages(b, { conversationId: a.conversationId });
    expect(bReadingA.status).toBe(404);
    const bReadingABody = await errorOf(bReadingA);
    expect(bReadingABody.error.code).toBe('NOT_FOUND');

    const aReadingB = await getMessages(a, { conversationId: b.conversationId });
    expect(aReadingB.status).toBe(404);

    // Both look exactly like a Conversation that never existed (ISO-3).
    const missing = await getMessages(b, { conversationId: randomUUID() });
    expect(missing.status).toBe(404);
    const missingBody = frozenErrorBody(await errorOf(missing));
    expect(frozenErrorBody(bReadingABody)).toEqual(missingBody);
    expect(frozenErrorBody(await errorOf(aReadingB))).toEqual(missingBody);

    // Each tenant still reads its own page, and it contains only its own rows (RD-4).
    const aPage = await pageOf(await getMessages(a));
    expect(aPage.messages).toHaveLength(1);
    expect(aPage.messages[0]?.message_id).toBe(aReceipt.message.message_id);

    const bPage = await pageOf(await getMessages(b));
    expect(bPage.messages).toHaveLength(1);
    expect(userTexts(bPage)).toEqual(['B private message']);

    // Receipts are tenant-scoped in both directions.
    expect((await getSubmission(b, aSubmission)).status).toBe(404);
    expect((await getSubmission(a, bSubmission)).status).toBe(404);
    expect((await getSubmission(a, aSubmission)).status).toBe(200);
    expect((await getSubmission(b, bSubmission)).status).toBe(200);
  });

  it('11. validates both path identifiers before they reach SQL', async () => {
    const actor = await signIn('path-ids');

    for (const path of [
      messagePagePath('not-a-uuid'),
      messagePagePath('123'),
      messagePagePath('550e8400-e29b-41d4-a716-44665544'),
    ]) {
      const response = await host.app.request(path, {
        method: 'GET',
        headers: { authorization: `Bearer ${actor.token}` },
      });
      expect([response.status, path]).toEqual([400, path]);
      const body = await errorOf(response);
      expect(body.error.code).toBe('INVALID_ARGUMENT');
      expect(body.error.message).toBe('Invalid request input');
    }

    // A syntactically valid UUID that names no Conversation is an absent resource, not a bad request.
    const absent = await getMessages(actor, { conversationId: randomUUID() });
    expect(absent.status).toBe(404);

    for (const id of [
      'not-a-uuid',
      '550e8400-e29b-11d4-a716-446655440000',
      '00000000-0000-0000-0000-000000000000',
    ]) {
      const response = await getSubmission(actor, id);
      expect([response.status, id]).toEqual([400, id]);
      expect((await errorOf(response)).error.code).toBe('INVALID_ARGUMENT');
    }

    // The unknown-but-well-formed v4 is the 404 path.
    expect((await getSubmission(actor, randomUUID())).status).toBe(404);
  });

  it('12. rejects every malformed or unknown page query with 400', async () => {
    const actor = await signIn('query-strict');

    const cases = [
      '?before=1',
      '?cursor=1',
      '?Limit=10',
      '?after=-1',
      '?after=',
      '?after=007',
      '?after=1.5',
      '?after=99999999999999999999',
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?limit=%2010',
      '?limit=1&limit=2',
      '?after=1&after=2',
    ] as const;

    for (const query of cases) {
      const response = await getMessages(actor, { query });
      expect([response.status, query]).toEqual([400, query]);

      const body = await errorOf(response);
      expect(body.error.code).toBe('INVALID_ARGUMENT');
      // G-4: the rejected value is never echoed. The public message is fixed by the code, so the
      // body cannot carry the offending cursor, its length or the parameter name.
      expect(body.error.message).toBe('Invalid request input');
      expect(Object.keys(body)).toEqual(['error']);
    }

    // The boundaries themselves are accepted, so the loop above is about malformed input only.
    expect(
      (await pageOf(await getMessages(actor, { query: '?after=0&limit=100' }))).messages,
    ).toEqual([]);
    expect((await pageOf(await getMessages(actor, { query: '?after=0&limit=1' }))).has_more).toBe(
      false,
    );
  });

  it('13. rejects caller-supplied identity fields on both routes', async () => {
    const actor = await signIn('identity-fields');

    const cases: readonly (readonly [string, ReadOptions])[] = [
      ['a tenant_id header', { headers: { 'x-tenant-id': actor.tenantId } }],
      ['a principal_id header', { headers: { 'x-principal-id': randomUUID() } }],
      ['a policy_version header', { headers: { 'x-policy-version': '7' } }],
      ['a tenant_id query parameter', { query: `?tenant_id=${actor.tenantId}` }],
      ['a principal_id query parameter', { query: `?principal_id=${randomUUID()}` }],
    ];

    for (const [label, options] of cases) {
      const page = await getMessages(actor, options);
      expect([page.status, label]).toEqual([400, label]);

      const body = await errorOf(page);
      expect(body.error.code).toBe('INVALID_ARGUMENT');
      expect(body.error.message).toBe('Invalid request input');
    }

    // The submission lookup refuses both channels too, with the identity reason rather than the
    // "no query parameters" one, because scope is the more serious rejection.
    const headerRejection = await getSubmission(actor, randomUUID(), {
      headers: { 'x-tenant-id': actor.tenantId },
    });
    expect(headerRejection.status).toBe(400);
    expect((await errorOf(headerRejection)).error.code).toBe('INVALID_ARGUMENT');

    const queryRejection = await getSubmission(actor, randomUUID(), {
      query: `?tenant_id=${actor.tenantId}`,
    });
    expect(queryRejection.status).toBe(400);

    // Any other query parameter is refused as well: the path id is the whole request (N-2).
    const extra = await getSubmission(actor, randomUUID(), {
      query: '?conversation_id=' + randomUUID(),
    });
    expect(extra.status).toBe(400);
  });

  it('14. answers 503 when PostgreSQL is unreachable, with no fabricated page or receipt', async () => {
    const actor = await signIn('db-failure');
    const submissionId = randomUUID();
    await send(actor, 'reachable before the outage', { clientSubmissionId: submissionId });

    const url = process.env.TEST_DATABASE_URL;

    if (url === undefined || url.length === 0) {
      throw new Error('TEST_DATABASE_URL is required');
    }

    // A real pool pointed at a closed port: the driver fails to connect, which is exactly the
    // "PostgreSQL unavailable" case §10.3 names. Nothing here is a stubbed repository.
    const unavailable = createPool({
      ...loadDatabaseConfig({ DATABASE_URL: url }),
      connectionString: 'postgres://127.0.0.1:1/ember_unreachable',
      connectionTimeoutMs: 1_000,
      maxConnections: 1,
    });
    const degraded = buildHost(unavailable);

    try {
      const page = await getMessages(actor, { app: degraded.app });
      expect(page.status).toBe(503);

      const pageBody = await errorOf(page);
      expect(pageBody.error.code).toBe('DB_UNAVAILABLE');
      expect(pageBody.error.message).toBe('Database is unavailable');
      expect(Object.keys(pageBody)).toEqual(['error']);
      expect(Object.keys(pageBody.error)).not.toContain('messages');

      const receipt = await getSubmission(actor, submissionId, { app: degraded.app });
      expect(receipt.status).toBe(503);
      expect((await errorOf(receipt)).error.code).toBe('DB_UNAVAILABLE');

      // No connection string, SQL text or driver detail is exposed (G-4).
      for (const forbidden of ['ember_unreachable', '127.0.0.1', 'SELECT', 'ECONNREFUSED']) {
        expect(JSON.stringify(pageBody)).not.toContain(forbidden);
      }
    } finally {
      await unavailable.end().catch(() => undefined);
    }

    // Recovery needs no restart: the healthy host still answers, so a failed read is not sticky.
    const recovered = await getMessages(actor);
    expect(recovered.status).toBe(200);
    expect((await pageOf(recovered)).messages).toHaveLength(1);
  });

  it('15. logs no message text, no submission body and no session token', async () => {
    const logged = buildHost(db.pool);
    const actor = await signIn('logging');
    const secretText = 'a lunch plan nobody may read';
    const secretSubmission = randomUUID();
    await send(actor, secretText, { clientSubmissionId: secretSubmission });

    // A successful read, an unauthenticated read and a 404 reconciliation: the three paths that
    // could plausibly log something on this surface.
    expect((await getMessages(actor, { app: logged.app })).status).toBe(200);
    expect((await getMessages(actor, { app: logged.app, token: null })).status).toBe(401);
    expect((await getSubmission(actor, secretSubmission, { app: logged.app })).status).toBe(200);
    expect((await getSubmission(actor, randomUUID(), { app: logged.app })).status).toBe(404);

    const joined = logged.logLines.join('\n');
    expect(joined.length).toBeGreaterThan(0);

    // G-2/G-3: no message text, no session token, no credential header, and no submission id.
    for (const forbidden of [
      secretText,
      actor.token,
      secretSubmission,
      'authorization',
      'Bearer',
    ]) {
      expect(joined).not.toContain(forbidden);
    }

    // G-1: what a rejection may log is the code, the method and the correlation id.
    expect(joined).toContain('UNAUTHENTICATED');
    expect(joined).toContain('NOT_FOUND');
    expect(joined).toMatch(/it-read-request-/);
  });

  it('16. composes with the B1-3B write route without changing either semantics', async () => {
    const composed = new Hono<AppBindings>();
    composed.use(
      '*',
      requestIdMiddleware(() => `it-read-request-${randomUUID()}`),
    );
    // Both factories mount on the same prefix, each with its own error boundary — the composition
    // the CTO performs after B1-2C.
    composed.route(
      MESSAGE_READ_MOUNT_PATH,
      createConversationMessageWriteRoutes({
        session: service,
        conversations: new PostgresB1ConversationWriteRepository(db.pool),
      }),
    );
    composed.route(
      MESSAGE_READ_MOUNT_PATH,
      createConversationMessageReadRoutes({
        session: service,
        conversations: new PostgresB1ConversationReadRepository(db.pool),
      }),
    );

    const actor = await signIn('composed');
    const clientSubmissionId = randomUUID();

    const posted = await composed.request(messagePagePath(actor.conversationId), {
      method: 'POST',
      headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        client_submission_id: clientSubmissionId,
        text: 'written by B1-3B, read by B1-4B',
        transcript_epoch: 0,
      }),
    });
    expect(posted.status).toBe(201);

    const receipt = await B1SendMessageReceiptSchema.parseAsync(await posted.json());

    // S-4 + RD-1: the 201 is only sent after commit, so the very next read must contain the row.
    const page = await pageOf(await getMessages(actor, { app: composed }));
    expect(page.messages.map((message) => message.message_id)).toEqual([
      receipt.message.message_id,
    ]);
    expect(page.next_after).toBe(receipt.message.sequence);

    // The read route's Unknown-ACK body is the write route's receipt body.
    const reconciled = await getSubmission(actor, clientSubmissionId, { app: composed });
    expect(reconciled.status).toBe(200);
    expect(JSON.stringify(await reconciled.json())).toBe(JSON.stringify(receipt));

    // Each sub-app kept its own boundary: a write rejection is still the write route's 400…
    const badWrite = await composed.request(messagePagePath(actor.conversationId), {
      method: 'POST',
      headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' },
      body: '{"text":',
    });
    expect(badWrite.status).toBe(400);

    // …and a read of an unknown Conversation is still the read route's 404.
    const badRead = await getMessages(actor, { app: composed, conversationId: randomUUID() });
    expect(badRead.status).toBe(404);
  });

  it('17. exposes exactly the two frozen paths and the GET method', async () => {
    const actor = await signIn('surface');
    expect(CONVERSATION_MESSAGES_ROUTE_PATH).toBe('/conversations/:conversationId/messages');
    expect(MESSAGE_SUBMISSION_ROUTE_PATH).toBe('/message-submissions/:clientSubmissionId');

    const unauthorized = { authorization: `Bearer ${actor.token}` };

    // The read factory registers no write method; in a read-only mount a POST is not a route at all.
    for (const [method, path] of [
      ['POST', messagePagePath(actor.conversationId)],
      ['DELETE', messagePagePath(actor.conversationId)],
      ['PUT', submissionPath(randomUUID())],
    ] as const) {
      const response = await host.app.request(path, { method, headers: unauthorized });
      expect([response.status, method]).toEqual([404, method]);
    }

    // A GET on any other path is not served either.
    const wrongPath = await host.app.request('/v1/conversations/messages', {
      headers: unauthorized,
    });
    expect(wrongPath.status).toBe(404);
  });
});
