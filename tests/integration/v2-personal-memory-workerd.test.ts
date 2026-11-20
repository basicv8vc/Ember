import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  B1MeResponseSchema,
  B1SendMessageReceiptSchema,
  B1SessionResponseSchema,
} from '@ember/contracts';
import type {
  PersonalMemoryDeleteResultDto,
  PersonalMemoryListDto,
  PersonalMemorySaveResultDto,
  PersonalMemoryUpdateResultDto,
} from '@ember/runtime-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V2LocalRuntimeHarness } from '../../apps/benchmark/src/v2-m1/index.js';

const configPath = fileURLToPath(
  new URL('../../apps/api/wrangler.local-v2.jsonc', import.meta.url),
);

async function json<T>(response: Response, expected: number): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(expected);
  return JSON.parse(body) as T;
}

describe('Product Alpha Agent B — Personal Memory in local workerd', () => {
  let harness: V2LocalRuntimeHarness;

  beforeEach(async () => {
    harness = await V2LocalRuntimeHarness.start({ target: { kind: 'ab_runtime', configPath } });
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  async function signIn() {
    const sessionRes = await harness.fetchOverHttp('/v1/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'dev',
        identity_token: randomUUID(),
        nonce: randomUUID(),
      }),
    });
    const session = B1SessionResponseSchema.parse(await json(sessionRes, 201));
    const meRes = await harness.fetchOverHttp('/v1/me', {
      method: 'GET',
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    const me = B1MeResponseSchema.parse(await json(meRes, 200));
    return {
      token: session.access_token,
      conversationId: me.conversation.conversation_id,
      transcriptEpoch: me.conversation.transcript_epoch,
    };
  }

  it('persists an explicit preference across a new conversation (clearTranscript), injects it into fast & durable turns, supports inspection/deletion, and isolates accounts', async () => {
    const userA = await signIn();
    const userB = await signIn();

    // 1. Save an explicitly requested preference for User A
    const saved = await json<PersonalMemorySaveResultDto>(
      await harness.fetchOverHttp('/v2/memories', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userA.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'preference',
          key: 'response_style',
          content: 'Always reply in concise bullet points.',
          provenance: {
            source: 'explicit_user_request',
            conversation_id: userA.conversationId,
          },
        }),
      }),
      201,
    );
    expect(saved.created).toBe(true);
    expect(saved.item.key).toBe('response_style');
    expect(saved.item.content).toBe('Always reply in concise bullet points.');
    expect(saved.item.provenance).toEqual({
      source: 'explicit_user_request',
      conversation_id: userA.conversationId,
      message_id: null,
    });

    // 2. Inspect saved preference for User A
    const inspected = await json<PersonalMemoryListDto>(
      await harness.fetchOverHttp('/v2/memories', {
        method: 'GET',
        headers: { authorization: `Bearer ${userA.token}` },
      }),
      200,
    );
    expect(inspected.items).toHaveLength(1);
    expect(inspected.items[0]?.memory_id).toBe(saved.item.memory_id);

    // 3. Account isolation: User B cannot inspect or delete User A's preference
    const userBList = await json<PersonalMemoryListDto>(
      await harness.fetchOverHttp('/v2/memories', {
        method: 'GET',
        headers: { authorization: `Bearer ${userB.token}` },
      }),
      200,
    );
    expect(userBList.items).toEqual([]);

    const crossDelete = await harness.fetchOverHttp(`/v2/memories/${saved.item.memory_id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${userB.token}` },
    });
    expect(crossDelete.status).toBe(404);

    // 4. Start a new conversation by clearing the transcript — preference MUST survive
    const cleared = await json<{ transcript_epoch: number }>(
      await harness.fetchOverHttp('/v1/me/conversation/messages', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${userA.token}` },
      }),
      200,
    );
    expect(cleared.transcript_epoch).toBe(userA.transcriptEpoch + 1);

    // 5. Fast Path turn in the new conversation receives the saved preference
    const fastStreamRes = await harness.fetchOverHttp(
      `/v2/conversations/${userA.conversationId}/messages/stream`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userA.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: 'Summarize my priorities for today.',
          transcript_epoch: cleared.transcript_epoch,
        }),
      },
    );
    expect(fastStreamRes.status).toBe(201);
    const fastSseText = await fastStreamRes.text();
    expect(fastSseText).toContain('event: turn.committed');

    const callsAfterFast = harness.fakeGateway.getAuditSnapshot().calls;
    expect(callsAfterFast).toHaveLength(1);
    expect(callsAfterFast[0]?.personalMemories).toEqual([
      {
        kind: 'preference',
        key: 'response_style',
        content: 'Always reply in concise bullet points.',
      },
    ]);

    // 6. Durable Path turn in the new conversation also receives the saved preference
    const durableRes = await harness.fetchOverHttp(
      `/v1/conversations/${userA.conversationId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userA.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: 'Give me a quick evening check-in.',
          transcript_epoch: cleared.transcript_epoch,
        }),
      },
    );
    const durableReceipt = B1SendMessageReceiptSchema.parse(await json(durableRes, 201));

    await expect
      .poll(
        async () => {
          const turnRes = await harness.fetchOverHttp(
            `/v1/conversations/${userA.conversationId}/turns/${durableReceipt.turn.turn_id}`,
            {
              method: 'GET',
              headers: { authorization: `Bearer ${userA.token}` },
            },
          );
          const turn = await json<{ status: string }>(turnRes, 200);
          return turn.status;
        },
        { timeout: 10_000, interval: 100 },
      )
      .toBe('completed');

    const callsAfterDurable = harness.fakeGateway.getAuditSnapshot().calls;
    expect(callsAfterDurable).toHaveLength(2);
    expect(callsAfterDurable[1]?.personalMemories).toEqual([
      {
        kind: 'preference',
        key: 'response_style',
        content: 'Always reply in concise bullet points.',
      },
    ]);

    // 7. Delete the preference — subsequent turns must NOT receive it
    const deleted = await json<PersonalMemoryDeleteResultDto>(
      await harness.fetchOverHttp(`/v2/memories/${saved.item.memory_id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${userA.token}` },
      }),
      200,
    );
    expect(deleted).toEqual({ deleted: true, memory_id: saved.item.memory_id });

    const afterDeleteList = await json<PersonalMemoryListDto>(
      await harness.fetchOverHttp('/v2/memories', {
        method: 'GET',
        headers: { authorization: `Bearer ${userA.token}` },
      }),
      200,
    );
    expect(afterDeleteList.items).toEqual([]);

    const postDeleteStream = await harness.fetchOverHttp(
      `/v2/conversations/${userA.conversationId}/messages/stream`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userA.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: 'One more question.',
          transcript_epoch: cleared.transcript_epoch,
        }),
      },
    );
    expect(postDeleteStream.status).toBe(201);
    await postDeleteStream.text();

    const callsAfterDelete = harness.fakeGateway.getAuditSnapshot().calls;
    expect(callsAfterDelete).toHaveLength(3);
    expect(callsAfterDelete[2]?.personalMemories).toBeUndefined();

    // 8. Unknown ACK retry idempotency via Idempotency-Key & conflicting reuse 409
    const idempotencyKey = randomUUID();
    const unkeyedPayload = {
      kind: 'fact',
      content: 'Based in Tokyo.',
      provenance: { source: 'user_settings' },
    };
    const firstUnkeyed = await json<PersonalMemorySaveResultDto>(
      await harness.fetchOverHttp('/v2/memories', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userA.token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(unkeyedPayload),
      }),
      201,
    );
    expect(firstUnkeyed.created).toBe(true);

    const retriedUnkeyed = await json<PersonalMemorySaveResultDto>(
      await harness.fetchOverHttp('/v2/memories', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userA.token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(unkeyedPayload),
      }),
      200,
    );
    expect(retriedUnkeyed.created).toBe(false);
    expect(retriedUnkeyed.item).toEqual(firstUnkeyed.item);

    const conflictingReuse = await harness.fetchOverHttp('/v2/memories', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${userA.token}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        kind: 'fact',
        content: 'Conflicting content.',
        provenance: { source: 'user_settings' },
      }),
    });
    expect(conflictingReuse.status).toBe(409);

    // 9. PATCH /v2/memories/:memoryId updates in place, reflects in next turn, and enforces isolation
    const patchedUnkeyed = await json<PersonalMemoryUpdateResultDto>(
      await harness.fetchOverHttp(`/v2/memories/${firstUnkeyed.item.memory_id}`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${userA.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          content: 'Based in Kyoto.',
          key: 'home_city',
        }),
      }),
      200,
    );
    expect(patchedUnkeyed.item.memory_id).toBe(firstUnkeyed.item.memory_id);
    expect(patchedUnkeyed.item.content).toBe('Based in Kyoto.');
    expect(patchedUnkeyed.item.key).toBe('home_city');
    expect(patchedUnkeyed.item.created_at).toBe(firstUnkeyed.item.created_at);

    const crossPatch = await harness.fetchOverHttp(`/v2/memories/${firstUnkeyed.item.memory_id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${userB.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'Cross-account overwrite' }),
    });
    expect(crossPatch.status).toBe(404);

    const emptyPatch = await harness.fetchOverHttp(`/v2/memories/${firstUnkeyed.item.memory_id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${userA.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(emptyPatch.status).toBe(400);

    // 10. Negative gates: unauthenticated 401, foreign/unverified provenance 400, disallowed silent source 400, invalid UUID 400
    const unauthRes = await harness.fetchOverHttp('/v2/memories', { method: 'GET' });
    expect(unauthRes.status).toBe(401);

    const foreignConvRes = await harness.fetchOverHttp('/v2/memories', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${userA.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'fact',
        content: 'Cross-account conversation ref',
        provenance: {
          source: 'explicit_user_request',
          conversation_id: userB.conversationId,
        },
      }),
    });
    expect(foreignConvRes.status).toBe(400);

    const unverifiedMsgRes = await harness.fetchOverHttp('/v2/memories', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${userA.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'fact',
        content: 'Unverified message ref',
        provenance: {
          source: 'explicit_user_request',
          conversation_id: userA.conversationId,
          message_id: randomUUID(),
        },
      }),
    });
    expect(unverifiedMsgRes.status).toBe(400);

    const silentSourceRes = await harness.fetchOverHttp('/v2/memories', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${userA.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'fact',
        content: 'Inferred silently',
        provenance: { source: 'silent_inference' },
      }),
    });
    expect(silentSourceRes.status).toBe(400);

    const badIdRes = await harness.fetchOverHttp('/v2/memories/not-a-uuid', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(badIdRes.status).toBe(400);
  });

  it('persists save_personal_memory tool calls atomically on Fast Path SSE and Durable Queue turns with verified provenance', async () => {
    const userA = await signIn();
    const userB = await signIn();

    // 1. Fast Path SSE turn invoking save_personal_memory
    harness.fakeGateway.enqueueRules({
      mode: 'fast_ok',
      replyText: "Got it — I'll remember that you prefer JPY.",
      savePersonalMemory: {
        kind: 'preference',
        key: 'currency',
        content: 'Prefer Japanese yen (JPY) for prices.',
      },
    });
    const fastRes = await harness.fetchOverHttp(
      `/v2/conversations/${userA.conversationId}/messages/stream`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userA.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: 'Please remember I prefer Japanese yen for prices.',
          transcript_epoch: userA.transcriptEpoch,
        }),
      },
    );
    expect(fastRes.status).toBe(201);
    const fastSse = await fastRes.text();
    expect(fastSse).toContain('event: turn.committed');

    const afterFast = await json<PersonalMemoryListDto>(
      await harness.fetchOverHttp('/v2/memories', {
        method: 'GET',
        headers: { authorization: `Bearer ${userA.token}` },
      }),
      200,
    );
    expect(afterFast.items).toHaveLength(1);
    expect(afterFast.items[0]?.key).toBe('currency');
    expect(afterFast.items[0]?.content).toBe('Prefer Japanese yen (JPY) for prices.');
    expect(afterFast.items[0]?.provenance.source).toBe('explicit_user_request');
    expect(afterFast.items[0]?.provenance.conversation_id).toBe(userA.conversationId);
    expect(afterFast.items[0]?.provenance.message_id).toBeTruthy();

    // 2. Durable Queue turn invoking save_personal_memory
    harness.fakeGateway.enqueueRules({
      mode: 'fast_ok',
      replyText: "Got it — I'll remember your city.",
      savePersonalMemory: {
        kind: 'fact',
        content: 'Lives in Kyoto.',
      },
    });
    const durableRes = await harness.fetchOverHttp(
      `/v1/conversations/${userA.conversationId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userA.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: 'Remember that I live in Kyoto.',
          transcript_epoch: userA.transcriptEpoch,
        }),
      },
    );
    const durableReceipt = B1SendMessageReceiptSchema.parse(await json(durableRes, 201));

    await expect
      .poll(
        async () => {
          const turnRes = await harness.fetchOverHttp(
            `/v1/conversations/${userA.conversationId}/turns/${durableReceipt.turn.turn_id}`,
            {
              method: 'GET',
              headers: { authorization: `Bearer ${userA.token}` },
            },
          );
          const turn = await json<{ status: string }>(turnRes, 200);
          return turn.status;
        },
        { timeout: 10_000, interval: 100 },
      )
      .toBe('completed');

    const afterDurable = await json<PersonalMemoryListDto>(
      await harness.fetchOverHttp('/v2/memories', {
        method: 'GET',
        headers: { authorization: `Bearer ${userA.token}` },
      }),
      200,
    );
    expect(afterDurable.items).toHaveLength(2);
    const kyotoItem = afterDurable.items.find((item) => item.content === 'Lives in Kyoto.');
    expect(kyotoItem?.provenance).toEqual({
      source: 'explicit_user_request',
      conversation_id: userA.conversationId,
      message_id: durableReceipt.message.message_id,
    });

    // 3. Cross-account isolation: User B sees none of User A's chat-saved memories
    const userBList = await json<PersonalMemoryListDto>(
      await harness.fetchOverHttp('/v2/memories', {
        method: 'GET',
        headers: { authorization: `Bearer ${userB.token}` },
      }),
      200,
    );
    expect(userBList.items).toEqual([]);
  });
});
