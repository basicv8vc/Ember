import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  B1AssistantTurnDtoSchema,
  B1MeResponseSchema,
  B1SendMessageReceiptSchema,
  type B1AssistantTurnDto,
  type B1SendMessageReceipt,
} from '@ember/contracts';
import {
  B1ProcessCluster,
  type B1Identity,
  type B1SendInput,
} from './support/b1-process-cluster.js';

const TURN_WAIT_MS = 20_000;
const SHORT_POLL_MS = 100;
const EXPECTED_TIMEOUT_REPLY = 'This simulated reply could not be completed. Please try again.';

interface StoredTurn {
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly failure_reason: 'timeout' | 'internal_error' | null;
  readonly response_message_id: string | null;
  readonly deadline_at: Date | string;
}

let cluster: B1ProcessCluster;

describe('B1 independent cloud lifecycle: real API + Worker + PostgreSQL 17', () => {
  beforeAll(async () => {
    cluster = await B1ProcessCluster.start();
  }, 60_000);

  afterAll(async () => {
    await cluster?.close();
  }, 30_000);

  it('E2E-01 authenticates and reuses the durable Consumer, Agent, and main Conversation', async () => {
    const assertion = `b1-e2e-reuse-${randomUUID()}`;
    const first = await cluster.signIn('provision-first', assertion);
    const second = await cluster.signIn('provision-again', assertion);

    expect(second.session.consumer_id).toBe(first.session.consumer_id);
    expect(second.session.session_id).not.toBe(first.session.session_id);
    expect(second.me).toEqual(first.me);
    expect(B1MeResponseSchema.parse(first.me)).toMatchObject({
      consumer_id: first.session.consumer_id,
      agent: { display_name: 'Ember' },
      conversation: { transcript_epoch: 0 },
    });

    const tenantId = await cluster.tenantIdFor(first);
    const graph = await cluster.observerPool.query<{
      principals: string;
      consumers: string;
      agents: string;
      conversations: string;
      sessions: string;
      me_agent: string;
      me_conversation: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM principals WHERE tenant_id = $1) AS principals,
         (SELECT count(*)::text FROM consumers WHERE tenant_id = $1) AS consumers,
         (SELECT count(*)::text FROM agents WHERE tenant_id = $1) AS agents,
         (SELECT count(*)::text FROM conversations WHERE tenant_id = $1) AS conversations,
         (SELECT count(*)::text FROM consumer_sessions WHERE tenant_id = $1) AS sessions,
         (SELECT count(*)::text FROM agents WHERE tenant_id = $1 AND id = $2) AS me_agent,
         (SELECT count(*)::text FROM conversations WHERE tenant_id = $1 AND id = $3) AS me_conversation`,
      [tenantId, first.me.agent.agent_id, first.me.conversation.conversation_id],
    );
    expect(graph.rows[0]).toEqual({
      principals: '1',
      consumers: '1',
      agents: '1',
      conversations: '1',
      sessions: '2',
      me_agent: '1',
      me_conversation: '1',
    });
  }, 60_000);

  it('E2E-02 commits the HTTP receipt, user Message, running Turn, and readable history', async () => {
    const identity = await cluster.signIn('message-persistence');
    const input = messageInput(identity, 'message-persistence');
    const response = await cluster.send(identity, identity.me.conversation.conversation_id, input);

    expect(response.status).toBe(201);
    const receipt = B1SendMessageReceiptSchema.parse(await response.json());
    expect(receipt).toMatchObject({
      transcript_epoch: identity.me.conversation.transcript_epoch,
      message: {
        kind: 'user',
        text: input.text,
        client_submission_id: input.client_submission_id,
        conversation_id: identity.me.conversation.conversation_id,
      },
      turn: { status: 'running' },
    });

    const tenantId = await cluster.tenantIdFor(identity);
    const persisted = await cluster.observerPool.query<{
      message_count: string;
      turn_count: string;
      kind: string;
      text: string;
      turn_status: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM conversation_messages
           WHERE tenant_id = $1 AND id = $2 AND client_submission_id = $3) AS message_count,
         (SELECT count(*)::text FROM assistant_turns
           WHERE tenant_id = $1 AND id = $4 AND source_message_id = $2) AS turn_count,
         m.kind, m.text, t.status AS turn_status
       FROM conversation_messages m
       JOIN assistant_turns t
         ON t.tenant_id = m.tenant_id
        AND t.conversation_id = m.conversation_id
        AND t.source_message_id = m.id
       WHERE m.tenant_id = $1 AND m.id = $2 AND t.id = $4`,
      [tenantId, receipt.message.message_id, input.client_submission_id, receipt.turn.turn_id],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      message_count: '1',
      turn_count: '1',
      kind: 'user',
      text: input.text,
    });
    expect(['running', 'completed']).toContain(persisted.rows[0]?.turn_status);

    const page = await cluster.readPage(identity, identity.me.conversation.conversation_id);
    expect(page.messages).toContainEqual(
      expect.objectContaining({
        message_id: receipt.message.message_id,
        kind: 'user',
        text: input.text,
        client_submission_id: input.client_submission_id,
      }),
    );
  }, 60_000);

  it('E2E-03 completes one durable Turn and persists exactly one visibly simulated reply', async () => {
    const identity = await cluster.signIn('turn-completion');
    const input = messageInput(identity, 'turn-completion');
    const receipt = await cluster.sendReceipt(
      identity,
      identity.me.conversation.conversation_id,
      input,
    );
    const completed = await waitForTurn(
      identity,
      identity.me.conversation.conversation_id,
      receipt.turn.turn_id,
      'completed',
    );
    expect(completed.response_message_id).not.toBeNull();

    const page = await cluster.readPage(identity, identity.me.conversation.conversation_id);
    const assistantMessages = page.messages.filter((message) => message.kind === 'ember');
    expect(assistantMessages).toHaveLength(1);
    const assistant = assistantMessages[0];
    expect(assistant?.kind).toBe('ember');
    if (assistant?.kind !== 'ember') {
      throw new Error('completed Turn response is absent from the Conversation page');
    }
    expect(assistant.simulated).toBe(true);
    expect(assistant.message_id).toBe(completed.response_message_id);
    expect(assistant.text).toMatch(/^\[Simulated reply/i);
    expect(assistant.model_label).toMatch(/fake|echo|simulat/i);

    const tenantId = await cluster.tenantIdFor(identity);
    const duplicates = await cluster.observerPool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM conversation_messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'`,
      [tenantId, identity.me.conversation.conversation_id],
    );
    expect(duplicates.rows[0]?.total).toBe('1');
  }, 60_000);

  it('E2E-04 survives clean API/Worker restart and recovers an unfinished Turn after Worker loss', async () => {
    const identity = await cluster.signIn('restart-history');
    const conversationId = identity.me.conversation.conversation_id;
    const firstInput = messageInput(identity, 'restart-complete');
    const firstReceipt = await cluster.sendReceipt(identity, conversationId, firstInput);
    await waitForTurn(identity, conversationId, firstReceipt.turn.turn_id, 'completed');
    const beforeRestart = await cluster.readPage(identity, conversationId);

    await cluster.stopWorker();
    await cluster.stopApi();
    await cluster.startApi();
    await cluster.startWorker();

    const afterRestartResponse = await cluster.get('/v1/me', identity.session.access_token);
    expect(afterRestartResponse.status).toBe(200);
    expect(B1MeResponseSchema.parse(await afterRestartResponse.json())).toMatchObject({
      consumer_id: identity.me.consumer_id,
      agent: identity.me.agent,
      conversation: {
        conversation_id: identity.me.conversation.conversation_id,
        transcript_epoch: identity.me.conversation.transcript_epoch,
      },
    });
    const afterRestart = await cluster.readPage(identity, conversationId);
    expect(afterRestart).toEqual(beforeRestart);
    expect(
      afterRestart.messages.map((message) => (message.kind === 'user' ? message.text : null)),
    ).toContain(firstInput.text);
    expect(afterRestart.messages.some((message) => message.kind === 'ember')).toBe(true);

    // Pause the real process while the HTTP write commits. The Turn is durably running when the
    // process is killed, so a fresh Worker must discover it from PostgreSQL after restart.
    cluster.pauseWorker();
    const pendingInput = messageInput(identity, 'restart-recovery');
    const pendingReceipt = await cluster.sendReceipt(identity, conversationId, pendingInput);
    expect((await storedTurn(identity, conversationId, pendingReceipt.turn.turn_id))?.status).toBe(
      'running',
    );
    await cluster.crashPausedWorker();
    await cluster.startWorker();
    const recovered = await waitForTurn(
      identity,
      conversationId,
      pendingReceipt.turn.turn_id,
      'completed',
    );
    expect(recovered.response_message_id).not.toBeNull();
  }, 90_000);

  it('E2E-05 replays the canonical receipt, finds Unknown ACK, and rejects conflicting reuse', async () => {
    const identity = await cluster.signIn('idempotency');
    const conversationId = identity.me.conversation.conversation_id;
    const input = messageInput(identity, 'idempotency');
    const firstResponse = await cluster.send(identity, conversationId, input);
    expect(firstResponse.status).toBe(201);
    const original = B1SendMessageReceiptSchema.parse(await firstResponse.json());

    const replayResponse = await cluster.send(identity, conversationId, input);
    expect(replayResponse.status).toBe(200);
    expect(B1SendMessageReceiptSchema.parse(await replayResponse.json())).toEqual(original);

    const lookup = await cluster.get(
      `/v1/message-submissions/${input.client_submission_id}`,
      identity.session.access_token,
    );
    expect(lookup.status).toBe(200);
    expect(B1SendMessageReceiptSchema.parse(await lookup.json())).toEqual(original);

    const conflictResponse = await cluster.send(identity, conversationId, {
      ...input,
      text: `${input.text} changed`,
    });
    expect(conflictResponse.status).toBe(409);
    expect(await errorCode(conflictResponse)).toBe('IDEMPOTENCY_CONFLICT');

    const tenantId = await cluster.tenantIdFor(identity);
    const counts = await cluster.observerPool.query<{ messages: string; turns: string }>(
      `SELECT
         (SELECT count(*)::text FROM conversation_messages
           WHERE tenant_id = $1 AND client_submission_id = $2) AS messages,
         (SELECT count(*)::text FROM assistant_turns
           WHERE tenant_id = $1 AND source_message_id = $3) AS turns`,
      [tenantId, input.client_submission_id, original.message.message_id],
    );
    expect(counts.rows[0]).toEqual({ messages: '1', turns: '1' });
  }, 60_000);

  it('E2E-06 hides foreign messages, receipts, and Turns behind the same public 404', async () => {
    const tenantA = await cluster.signIn('isolation-a');
    const tenantB = await cluster.signIn('isolation-b');
    expect(tenantA.session.consumer_id).not.toBe(tenantB.session.consumer_id);
    expect(await cluster.tenantIdFor(tenantA)).not.toBe(await cluster.tenantIdFor(tenantB));
    const conversationA = tenantA.me.conversation.conversation_id;
    const conversationB = tenantB.me.conversation.conversation_id;
    const inputA = messageInput(tenantA, 'tenant-a-private-message');
    const inputB = messageInput(tenantB, 'tenant-b-private-message');
    const receiptA = await cluster.sendReceipt(tenantA, conversationA, inputA);
    const receiptB = await cluster.sendReceipt(tenantB, conversationB, inputB);
    await waitForTurn(tenantA, conversationA, receiptA.turn.turn_id, 'completed');
    await waitForTurn(tenantB, conversationB, receiptB.turn.turn_id, 'completed');

    const noConversationA = randomUUID();
    const noConversationB = randomUUID();
    const noSubmissionA = randomUUID();
    const noSubmissionB = randomUUID();
    const noTurnA = randomUUID();
    const noTurnB = randomUUID();

    const foreignHistoryForA = await cluster.get(
      `/v1/conversations/${conversationB}/messages`,
      tenantA.session.access_token,
    );
    const missingHistoryForA = await cluster.get(
      `/v1/conversations/${noConversationA}/messages`,
      tenantA.session.access_token,
    );
    await expectSameNotFound(foreignHistoryForA, missingHistoryForA, [inputB.text]);

    const foreignHistoryForB = await cluster.get(
      `/v1/conversations/${conversationA}/messages`,
      tenantB.session.access_token,
    );
    const missingHistoryForB = await cluster.get(
      `/v1/conversations/${noConversationB}/messages`,
      tenantB.session.access_token,
    );
    await expectSameNotFound(foreignHistoryForB, missingHistoryForB, [inputA.text]);

    const foreignReceiptForA = await cluster.get(
      `/v1/message-submissions/${inputB.client_submission_id}`,
      tenantA.session.access_token,
    );
    const missingReceiptForA = await cluster.get(
      `/v1/message-submissions/${noSubmissionA}`,
      tenantA.session.access_token,
    );
    await expectSameNotFound(foreignReceiptForA, missingReceiptForA, [inputB.text]);

    const foreignReceiptForB = await cluster.get(
      `/v1/message-submissions/${inputA.client_submission_id}`,
      tenantB.session.access_token,
    );
    const missingReceiptForB = await cluster.get(
      `/v1/message-submissions/${noSubmissionB}`,
      tenantB.session.access_token,
    );
    await expectSameNotFound(foreignReceiptForB, missingReceiptForB, [inputA.text]);

    const foreignTurnForA = await cluster.readTurn(tenantA, conversationB, receiptB.turn.turn_id);
    const missingTurnForA = await cluster.readTurn(tenantA, noConversationA, noTurnA);
    await expectSameNotFound(foreignTurnForA.response, missingTurnForA.response, [inputB.text]);

    const foreignCancelForA = await cluster.cancelTurn(
      tenantA,
      conversationB,
      receiptB.turn.turn_id,
    );
    const missingCancelForA = await cluster.cancelTurn(tenantA, noConversationA, noTurnA);
    await expectSameNotFound(foreignCancelForA, missingCancelForA, [inputB.text]);

    const foreignTurnForB = await cluster.readTurn(tenantB, conversationA, receiptA.turn.turn_id);
    const missingTurnForB = await cluster.readTurn(tenantB, noConversationB, noTurnB);
    await expectSameNotFound(foreignTurnForB.response, missingTurnForB.response, [inputA.text]);

    const foreignCancelForB = await cluster.cancelTurn(
      tenantB,
      conversationA,
      receiptA.turn.turn_id,
    );
    const missingCancelForB = await cluster.cancelTurn(tenantB, noConversationB, noTurnB);
    await expectSameNotFound(foreignCancelForB, missingCancelForB, [inputA.text]);

    expect(cluster.logs()).not.toContain(inputA.text);
    expect(cluster.logs()).not.toContain(inputB.text);
  }, 90_000);

  it('E2E-07 cancels a running Turn idempotently and prevents a late assistant Message', async () => {
    const identity = await cluster.signIn('cancellation');
    const conversationId = identity.me.conversation.conversation_id;
    const input = messageInput(identity, 'cancellation');
    cluster.pauseWorker();
    try {
      const receipt = await cluster.sendReceipt(identity, conversationId, input);
      expect((await storedTurn(identity, conversationId, receipt.turn.turn_id))?.status).toBe(
        'running',
      );

      const firstResponse = await cluster.cancelTurn(
        identity,
        conversationId,
        receipt.turn.turn_id,
      );
      expect(firstResponse.status).toBe(200);
      const first = B1AssistantTurnDtoSchema.parse(await firstResponse.json());
      expect(first).toMatchObject({
        status: 'cancelled',
        response_message_id: null,
        failure_reason: null,
      });

      const repeatedResponse = await cluster.cancelTurn(
        identity,
        conversationId,
        receipt.turn.turn_id,
      );
      expect(repeatedResponse.status).toBe(200);
      expect(B1AssistantTurnDtoSchema.parse(await repeatedResponse.json())).toEqual(first);
    } finally {
      cluster.resumeWorker();
    }

    const tenantId = await cluster.tenantIdFor(identity);
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const rows = await cluster.observerPool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM conversation_messages
          WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'`,
        [tenantId, conversationId],
      );
      expect(rows.rows[0]?.total).toBe('0');
      await delay(SHORT_POLL_MS);
    }
  }, 60_000);

  it('E2E-08 times out through the Worker and publishes one frozen safe failure', async () => {
    const identity = await cluster.signIn('timeout');
    const conversationId = identity.me.conversation.conversation_id;
    const input = messageInput(identity, 'timeout');
    cluster.pauseWorker();
    let receipt: B1SendMessageReceipt;
    try {
      receipt = await cluster.sendReceipt(identity, conversationId, input);
      const tenantId = await cluster.tenantIdFor(identity);
      const timeoutUpdate = await cluster.observerPool.query(
        `UPDATE assistant_turns
            SET deadline_at = clock_timestamp() - interval '1 second'
          WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3 AND status = 'running'`,
        [tenantId, conversationId, receipt.turn.turn_id],
      );
      expect(timeoutUpdate.rowCount).toBe(1);
    } finally {
      cluster.resumeWorker();
    }

    const storedFailure = await waitForStoredTurn(
      identity,
      conversationId,
      receipt!.turn.turn_id,
      'failed',
    );
    expect(storedFailure.failure_reason).toBe('timeout');
    const polledFailure = await cluster.readTurn(identity, conversationId, receipt!.turn.turn_id);
    expect(polledFailure.response.status).toBe(200);
    const failed = polledFailure.turn;
    expect(failed?.status).toBe('failed');
    expect(failed?.failure_reason).toBe('timeout');
    expect(failed?.response_message_id).not.toBeNull();

    const page = await cluster.readPage(identity, conversationId);
    const failures = page.messages.filter(
      (message) => message.kind === 'ember' && message.message_id === failed?.response_message_id,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: 'ember',
      text: EXPECTED_TIMEOUT_REPLY,
      simulated: true,
    });
    expect(failures[0]?.message_id).toBe(failed?.response_message_id);
    expect(failures[0]?.kind === 'ember' && failures[0].text).not.toContain(input.text);

    const tenantId = await cluster.tenantIdFor(identity);
    const responseCount = await cluster.observerPool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM conversation_messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'`,
      [tenantId, conversationId],
    );
    expect(responseCount.rows[0]?.total).toBe('1');
  }, 60_000);

  it('E2E-09 rejects bad Sessions and stale epochs, returns safe 503, and recovers after database restoration', async () => {
    const invalid = await cluster.get('/v1/me', `ems_invalid-${randomUUID()}`);
    expect(invalid.status).toBe(401);
    expect(await errorCode(invalid)).toBe('UNAUTHENTICATED');

    const expired = await cluster.signIn('expired-session');
    await cluster.observerPool.query(
      `UPDATE consumer_sessions
          SET expires_at = clock_timestamp() - interval '1 second',
              idle_expires_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2`,
      [await cluster.tenantIdFor(expired), expired.session.session_id],
    );
    const expiredRead = await cluster.get('/v1/me', expired.session.access_token);
    expect(expiredRead.status).toBe(401);
    expect(await errorCode(expiredRead)).toBe('UNAUTHENTICATED');

    const revoked = await cluster.signIn('revoked-session');
    const logout = await cluster.request('/v1/auth/session', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${revoked.session.access_token}` },
    });
    expect(logout.status).toBe(204);
    const revokedRead = await cluster.get('/v1/me', revoked.session.access_token);
    expect(revokedRead.status).toBe(401);
    expect(await errorCode(revokedRead)).toBe('UNAUTHENTICATED');

    const stale = await cluster.signIn('stale-transcript-epoch');
    const staleInput = {
      ...messageInput(stale, 'stale-epoch'),
      transcript_epoch: stale.me.conversation.transcript_epoch + 1,
    };
    const staleResponse = await cluster.send(
      stale,
      stale.me.conversation.conversation_id,
      staleInput,
    );
    expect(staleResponse.status).toBe(409);
    expect(await errorCode(staleResponse)).toBe('IDEMPOTENCY_CONFLICT');
    const staleCount = await cluster.observerPool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM conversation_messages
        WHERE tenant_id = $1 AND client_submission_id = $2`,
      [await cluster.tenantIdFor(stale), staleInput.client_submission_id],
    );
    expect(staleCount.rows[0]?.total).toBe('0');

    const identity = await cluster.signIn('transient-database-failure');
    const conversationId = identity.me.conversation.conversation_id;
    const retryInput = messageInput(identity, 'database-recovery');
    let readiness: Response | undefined;
    let failedWrite: Response | undefined;
    try {
      await cluster.blockDatabaseConnections();
      readiness = await cluster.get('/readyz');
      failedWrite = await cluster.send(identity, conversationId, retryInput);
      expect(failedWrite.status).toBe(503);
      const failureBody = (await failedWrite.json()) as {
        error?: { code?: string; message?: string };
      };
      expect(failureBody.error?.code).toBe('DB_UNAVAILABLE');
      expect(readiness.status).toBe(503);
      const errorText = JSON.stringify(failureBody);
      expect(errorText).not.toContain(cluster.databaseName);
      expect(errorText).not.toContain(new URL(cluster.databaseUrl).password);
      expect(errorText).not.toMatch(/ECONN|postgres:\/\//i);
    } finally {
      await cluster.allowDatabaseConnections();
    }

    expect(cluster.workerIsRunning).toBe(true);
    const preRetryRows = await cluster.observerPool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM conversation_messages
        WHERE tenant_id = $1 AND client_submission_id = $2`,
      [await cluster.tenantIdFor(identity), retryInput.client_submission_id],
    );
    expect(preRetryRows.rows[0]?.total).toBe('0');
    const recoveredReceipt = await waitForRecoveredSend(identity, conversationId, retryInput);
    expect(recoveredReceipt.message.client_submission_id).toBe(retryInput.client_submission_id);
    const recoveredTurn = await waitForTurn(
      identity,
      conversationId,
      recoveredReceipt.turn.turn_id,
      'completed',
    );
    expect(recoveredTurn.status).toBe('completed');

    const tenantId = await cluster.tenantIdFor(identity);
    const finalCount = await cluster.observerPool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM conversation_messages
        WHERE tenant_id = $1 AND client_submission_id = $2`,
      [tenantId, retryInput.client_submission_id],
    );
    expect(finalCount.rows[0]?.total).toBe('1');
  }, 90_000);

  it('keeps all session tokens, provider assertions, and private prompts out of process logs', () => {
    const logs = cluster.logs();
    for (const value of cluster.sensitiveValues) {
      expect(logs).not.toContain(value);
    }
    const databasePassword = new URL(cluster.databaseUrl).password;
    if (databasePassword.length > 0) {
      expect(logs).not.toContain(decodeURIComponent(databasePassword));
    }
  }, 30_000);
});

function messageInput(identity: B1Identity, label: string): B1SendInput {
  return {
    client_submission_id: randomUUID(),
    text: `private ${label} prompt ${randomUUID()}`,
    transcript_epoch: identity.me.conversation.transcript_epoch,
  };
}

async function waitForTurn(
  identity: B1Identity,
  conversationId: string,
  turnId: string,
  expected: B1AssistantTurnDto['status'],
): Promise<B1AssistantTurnDto> {
  const deadline = Date.now() + TURN_WAIT_MS;
  while (Date.now() < deadline) {
    const { response, turn } = await cluster.readTurn(identity, conversationId, turnId);
    if (response.status === 200 && turn?.status === expected) {
      return turn;
    }
    if (response.status !== 200 && response.status !== 503) {
      throw new Error(`Turn polling returned HTTP ${response.status}`);
    }
    await delay(SHORT_POLL_MS);
  }
  throw new Error(`Turn did not reach ${expected} within the bounded polling window`);
}

async function storedTurn(
  identity: B1Identity,
  conversationId: string,
  turnId: string,
): Promise<StoredTurn | undefined> {
  const result = await cluster.observerPool.query<StoredTurn>(
    `SELECT status, failure_reason, response_message_id, deadline_at
       FROM assistant_turns
      WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3`,
    [await cluster.tenantIdFor(identity), conversationId, turnId],
  );
  return result.rows[0];
}

async function waitForStoredTurn(
  identity: B1Identity,
  conversationId: string,
  turnId: string,
  expected: StoredTurn['status'],
): Promise<StoredTurn> {
  const deadline = Date.now() + TURN_WAIT_MS;
  while (Date.now() < deadline) {
    const turn = await storedTurn(identity, conversationId, turnId);
    if (turn?.status === expected) {
      return turn;
    }
    await delay(SHORT_POLL_MS);
  }
  throw new Error(`PostgreSQL Turn row did not reach ${expected} within the polling deadline`);
}

async function waitForRecoveredSend(
  identity: B1Identity,
  conversationId: string,
  input: B1SendInput,
): Promise<B1SendMessageReceipt> {
  const deadline = Date.now() + TURN_WAIT_MS;
  while (Date.now() < deadline) {
    const response = await cluster.send(identity, conversationId, input);
    if (response.status === 201 || response.status === 200) {
      return B1SendMessageReceiptSchema.parse(await response.json());
    }
    if (response.status !== 503) {
      throw new Error(`retry after database recovery returned HTTP ${response.status}`);
    }
    await delay(SHORT_POLL_MS);
  }
  throw new Error('API did not recover from the transient database outage');
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

async function expectSameNotFound(
  foreignResponse: Response,
  missingResponse: Response,
  forbiddenValues: readonly string[],
): Promise<void> {
  expect(foreignResponse.status).toBe(404);
  expect(missingResponse.status).toBe(404);
  const foreign = await foreignResponse.json();
  const missing = await missingResponse.json();
  expect(publicError(foreign)).toEqual(publicError(missing));
  const serialized = JSON.stringify(foreign);
  for (const value of forbiddenValues) {
    expect(serialized).not.toContain(value);
  }
}

function publicError(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return value;
  }
  const error = (value as { error?: { code?: string; message?: string } }).error;
  return { code: error?.code, message: error?.message };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
