import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  B1AssistantTurnDtoSchema,
  B1ConversationPageSchema,
  B1MeResponseSchema,
  B1SendMessageReceiptSchema,
  B1SessionResponseSchema,
  type B1SendMessageRequest,
} from '@ember/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V2LocalRuntimeHarness } from '../../apps/benchmark/src/v2-m1/index.js';
import { GLOBAL_BUDGET_OBJECT_NAME } from '../../packages/runtime-v2/src/global-budget/platform.js';

const configPath = fileURLToPath(
  new URL('../../apps/api/wrangler.local-v2.jsonc', import.meta.url),
);
const poll = { timeout: 15_000, interval: 100 };

async function json(response: Response, expectedStatus: number): Promise<unknown> {
  const body = await response.text();
  expect(response.status, body).toBe(expectedStatus);
  return JSON.parse(body) as unknown;
}

function streamReceipt(text: string) {
  const match = /^event: turn\.accepted\ndata: (.+)\n\n/m.exec(text);
  expect(match?.[1], text).toBeDefined();
  return B1SendMessageReceiptSchema.parse(JSON.parse(match![1]!));
}

async function readThroughDelta(response: Response) {
  expect(response.status).toBe(201);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!/event: turn\.delta\ndata: .+\n\n/.test(text)) {
      const frame = await reader.read();
      if (frame.done) throw new Error(`SSE ended before a provider delta: ${text}`);
      text += decoder.decode(frame.value, { stream: true });
    }
    return { receipt: streamReceipt(text), reader, text, decoder };
  } catch (error) {
    await reader.cancel();
    throw error;
  }
}

describe('V2-M1 assembled runtime in local workerd', () => {
  let harness: V2LocalRuntimeHarness;
  let token: string;
  let conversationId: string;
  let messagePath: string;
  let streamPath: string;
  let headId: string;

  beforeEach(async () => {
    harness = await V2LocalRuntimeHarness.start({ target: { kind: 'ab_runtime', configPath } });
    const response = await harness.fetch('/v1/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'dev', identity_token: randomUUID(), nonce: randomUUID() }),
    });
    const session = B1SessionResponseSchema.parse(await json(response, 201));
    token = session.access_token;
    const me = B1MeResponseSchema.parse(await json(await request('/v1/me'), 200));
    expect(me.consumer_id).toBe(session.consumer_id);
    expect(me.conversation.transcript_epoch).toBe(0);
    conversationId = me.conversation.conversation_id;
    messagePath = `/v1/conversations/${conversationId}/messages`;
    streamPath = `/v2/conversations/${conversationId}/messages/stream`;
    const ids = await harness.listDurableObjectIds('AGENT_HEAD');
    expect(ids).toHaveLength(1);
    headId = ids[0]!;
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  function request(path: string, method = 'GET', body?: B1SendMessageRequest) {
    return harness.fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function message(text: string): B1SendMessageRequest {
    return { client_submission_id: randomUUID(), text, transcript_epoch: 0 };
  }

  function turnPath(turnId: string) {
    return `/v1/conversations/${conversationId}/turns/${turnId}`;
  }

  async function submission(body: B1SendMessageRequest) {
    return B1SendMessageReceiptSchema.parse(
      await json(await request(`/v1/message-submissions/${body.client_submission_id}`), 200),
    );
  }

  async function turn(turnId: string) {
    return B1AssistantTurnDtoSchema.parse(await json(await request(turnPath(turnId)), 200));
  }

  async function transcript(after = 0) {
    return B1ConversationPageSchema.parse(
      await json(await request(`${messagePath}?after=${after}&limit=10`), 200),
    );
  }

  function headRows(query: `SELECT ${string}`, turnId: string) {
    return harness.readDurableObjectRows('AGENT_HEAD', { id: headId }, query, turnId);
  }

  async function providerCall(turnId: string) {
    const calls = () => harness.fakeGateway.getAuditSnapshot().calls;
    await expect.poll(calls, poll).toHaveLength(1);
    const call = calls()[0]!;
    expect(call.turnId).toBe(turnId);
    expect(call.operationId).toEqual(expect.any(String));
    return { ...call, operationId: call.operationId! };
  }

  async function assertSettlement(operationId: string, revisions: readonly number[]) {
    await expect
      .poll(
        () =>
          harness.readDurableObjectRows(
            'GLOBAL_BUDGET',
            { name: GLOBAL_BUDGET_OBJECT_NAME },
            'SELECT settlement_revision, cumulative_charge_micro_usd, delta_micro_usd FROM global_budget_settlements WHERE operation_id = ? ORDER BY settlement_revision',
            operationId,
          ),
        poll,
      )
      .toEqual(
        revisions.map((amount, index) => ({
          settlement_revision: index,
          cumulative_charge_micro_usd: amount,
          delta_micro_usd: amount - (revisions[index - 1] ?? 0),
        })),
      );
  }

  it('settles a B1 submission through Durable Queue and recovers its receipt after a lost response', async () => {
    const body = message('First durable conversation');
    harness.fakeGateway.setDefaultRule({
      mode: 'fast_ok',
      replyText: 'Durable reply',
      costMicroUsd: 137,
    });
    const response = await request(messagePath, 'POST', body);
    expect(response.status, response.ok ? undefined : await response.text()).toBe(201);
    await response.body!.cancel(); // Forget the POST receipt, as a client with an unknown ACK would.
    const receipt = await submission(body);
    expect(receipt.message.text).toBe(body.text);
    const turnId = receipt.turn.turn_id;
    expect(await json(await request(messagePath, 'POST', body), 200)).toEqual(receipt);
    await expect.poll(() => turn(turnId), poll).toMatchObject({ status: 'completed' });
    const completed = await turn(turnId);
    const call = await providerCall(turnId);
    expect(call.pathname).toBe('/v2/fake-model/stream');
    await assertSettlement(call.operationId, [137]);
    expect(
      await headRows(
        'SELECT execution_mode, claim_count, deadline_at_ms - created_at_ms AS ttl FROM assistant_turns WHERE id = ?',
        turnId,
      ),
    ).toEqual([{ execution_mode: 'durable_queue', claim_count: 1, ttl: 60_000 }]);
    expect(
      await headRows(
        "SELECT state FROM v2_dispatch_outbox WHERE entity_id = ? AND entity_kind = 'turn'",
        turnId,
      ),
    ).toEqual([{ state: 'acked' }]);
    await harness.evictDurableObject('AGENT_HEAD', { id: headId });
    expect((await transcript()).messages).toMatchObject([
      { kind: 'user', client_submission_id: body.client_submission_id },
      {
        kind: 'ember',
        message_id: completed.response_message_id,
        text: 'Durable reply',
        simulated: true,
      },
    ]);
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(1);
  });

  it('publishes exactly the committed SSE response and settles the interactive attempt', async () => {
    harness.fakeGateway.setDefaultRule({
      mode: 'stream_sse',
      replyText: 'Interactive reply',
      costMicroUsd: 111,
    });
    const body = message('First interactive conversation');
    const response = await request(streamPath, 'POST', body);
    const text = await response.text();
    expect(response.status, text).toBe(201);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const receipt = streamReceipt(text);
    expect(text).toContain('event: turn.delta');
    expect(text).toContain('event: turn.committed');
    const turnId = receipt.turn.turn_id;
    const completed = await turn(turnId);
    expect(completed.status).toBe('completed');
    const call = await providerCall(turnId);
    expect(call.pathname).toBe('/v2/fake-model/stream');
    await assertSettlement(call.operationId, [111]);
    const page = await transcript(receipt.message.sequence);
    expect(page.messages).toMatchObject([
      {
        kind: 'ember',
        message_id: completed.response_message_id,
        text: 'Interactive reply',
        simulated: true,
      },
    ]);
    const replay = await request(streamPath, 'POST', body);
    const replayText = await replay.text();
    expect(replay.status, replayText).toBe(200);
    expect(replayText.match(/^event: .+$/gm)).toEqual(['event: turn.accepted']);
    expect(streamReceipt(replayText)).toEqual(receipt);
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(1);
  });

  it(
    'hands a disconnected stream to Durable and only queries the original provider job',
    { timeout: 145_000 },
    async () => {
      const handle = 'smoke_original_handoff';
      harness.fakeGateway.setDefaultRule({
        mode: 'slow_handoff',
        // The Wrangler proxy may retain its upstream connection. Keep the job alive
        // through the fast-path deadline so either trigger must transfer it to Durable.
        delayMs: 118_000,
        replyText: 'Handoff reply',
        costMicroUsd: 149,
        providerJobHandle: handle,
      });
      const body = message('Keep working after disconnect');
      const connection = new AbortController();
      const response = await harness.fetchOverHttp(streamPath, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: connection.signal,
      });
      const { receipt, reader } = await readThroughDelta(response);
      connection.abort();
      await reader.cancel().catch(() => undefined);
      const turnId = receipt.turn.turn_id;
      expect(await submission(body)).toEqual(receipt);
      await expect
        .poll(() => turn(turnId), { timeout: 130_000, interval: 250 })
        .toMatchObject({ status: 'completed' });
      const completed = await turn(turnId);
      const call = await providerCall(turnId);
      expect(call).toMatchObject({
        pathname: '/v2/fake-model/stream',
        providerJobHandle: handle,
      });
      expect(harness.fakeGateway.getAuditSnapshot().jobPollCount).toBeGreaterThan(0);
      await assertSettlement(call.operationId, [149]);
      expect(
        await headRows(
          `SELECT execution_mode, provider_job_handle,
                  handoff_reason IN ('client_disconnect_handoff', 'interactive_deadline_120s') AS handed_off,
                  claim_count > 0 AS claimed, deadline_at_ms - created_at_ms AS ttl
             FROM assistant_turns WHERE id = ?`,
          turnId,
        ),
      ).toEqual([
        {
          execution_mode: 'durable_queue',
          provider_job_handle: handle,
          handed_off: 1,
          claimed: 1,
          ttl: 600_000,
        },
      ]);
      expect(
        await headRows(
          'SELECT operation_id, attempt_no FROM model_attempts WHERE subject_id = ?',
          turnId,
        ),
      ).toEqual([{ operation_id: call.operationId, attempt_no: 1 }]);
      expect((await transcript(receipt.message.sequence)).messages).toMatchObject([
        { kind: 'ember', text: 'Handoff reply', message_id: completed.response_message_id },
      ]);
      expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(1);
    },
  );

  it.each(['cancel', 'clear'] as const)(
    'records late usage after %s without resurrecting the original reply',
    async (action) => {
      harness.fakeGateway.setDefaultRule({
        mode: 'slow_handoff',
        delayMs: 1_800,
        replyText: 'Fenced reply',
        costMicroUsd: 311,
      });
      const body = message(`Revoke publication with ${action}`);
      const initial = await readThroughDelta(await request(streamPath, 'POST', body));
      const { receipt, reader, decoder } = initial;
      const turnId = receipt.turn.turn_id;
      let frames = initial.text;
      try {
        if (action === 'cancel') {
          const cancelled = await json(await request(`${turnPath(turnId)}/cancel`, 'POST'), 200);
          expect(cancelled).toMatchObject({ status: 'cancelled', response_message_id: null });
        } else {
          const cleared = await json(await request('/v1/me/conversation/messages', 'DELETE'), 200);
          expect(cleared).toEqual({ deleted_messages: 1, deleted_turns: 1, transcript_epoch: 1 });
        }
        for (;;) {
          const frame = await reader.read();
          if (frame.done) break;
          frames += decoder.decode(frame.value, { stream: true });
        }
      } finally {
        await reader.cancel();
      }
      expect(frames.includes('event: turn.committed')).toBe(false);
      const call = await providerCall(turnId);
      await assertSettlement(call.operationId, [250, 311]);
      expect(
        await headRows(
          'SELECT operation_id, attempt_no, observed_cost_micro_usd FROM model_attempts WHERE subject_id = ?',
          turnId,
        ),
      ).toEqual([{ operation_id: call.operationId, attempt_no: 1, observed_cost_micro_usd: 311 }]);
      if (action === 'cancel') {
        expect(await turn(turnId)).toMatchObject({
          status: 'cancelled',
          response_message_id: null,
        });
        expect(await json(await request(messagePath, 'POST', body), 200)).toEqual(receipt);
        expect((await transcript()).messages).toMatchObject([{ kind: 'user', text: body.text }]);
      } else {
        expect((await request(turnPath(turnId))).status).toBe(404);
        expect((await request(`/v1/message-submissions/${body.client_submission_id}`)).status).toBe(
          404,
        );
        expect((await request(messagePath, 'POST', body)).status).toBe(409);
        expect((await transcript()).messages).toEqual([]);
      }
      expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(1);
      expect(harness.fakeGateway.getAuditSnapshot().jobPollCount).toBe(0);
    },
  );
});
