import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  B1ConversationPageSchema,
  B1MeResponseSchema,
  B1SessionResponseSchema,
  B1TaskDetailDtoSchema,
  B1TaskListDtoSchema,
  B3StagedUploadReceiptDtoSchema,
  B3TaskArtifactsListDtoSchema,
} from '@ember/contracts';
import type { PersonalMemoryListDto, PersonalMemorySaveResultDto } from '@ember/runtime-v2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V2LocalRuntimeHarness } from '../../apps/benchmark/src/v2-m1/index.js';
import {
  DEVICE_TEXT_CAPABILITY,
  type DeviceClaim,
  type DeviceTaskSnapshot,
} from '../../packages/runtime-v2/src/contracts/device-execution.js';
import type { ProactiveScheduleSnapshot } from '../../packages/runtime-v2/src/contracts/proactive-schedules.js';

const configPath = fileURLToPath(
  new URL('../../apps/api/wrangler.local-v2.jsonc', import.meta.url),
);

const ALLOWED_IOS_RECEIPT_MESSAGE_KEYS = new Set([
  'message_id',
  'conversation_id',
  'sequence',
  'created_at',
  'kind',
  'text',
  'client_submission_id',
]);

async function json<T>(response: Response, expectedStatus: number): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(expectedStatus);
  return JSON.parse(body) as T;
}

function buildIosMultipartUpload(
  filename: string,
  mediaType: string,
  content: string,
): {
  readonly contentType: string;
  readonly body: Buffer;
} {
  const boundary = `EmberBoundary-${randomUUID().replaceAll('-', '')}`;
  const chunks = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="filename"\r\n\r\n`,
    `${filename}\r\n`,
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="media_type"\r\n\r\n`,
    `${mediaType}\r\n`,
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
    `Content-Type: ${mediaType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--\r\n`,
  ];
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.from(chunks.join(''), 'utf-8'),
  };
}

describe('Product Alpha G2 — Combined 5-Scenario Cross-Feature Verification in workerd (620aec2)', () => {
  let harness: V2LocalRuntimeHarness;

  beforeAll(async () => {
    harness = await V2LocalRuntimeHarness.start({ target: { kind: 'ab_runtime', configPath } });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  async function signIn() {
    const sessionRes = await harness.fetchOverHttp('/v1/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'dev',
        identity_token: `g2-${randomUUID()}`,
        nonce: `nonce-${randomUUID()}`,
      }),
    });
    const session = B1SessionResponseSchema.parse(await json(sessionRes, 201));
    const me = B1MeResponseSchema.parse(
      await json(
        await harness.fetchOverHttp('/v1/me', {
          headers: { authorization: `Bearer ${session.access_token}` },
        }),
        200,
      ),
    );
    return {
      token: session.access_token,
      conversationId: me.conversation.conversation_id,
      transcriptEpoch: me.conversation.transcript_epoch,
    };
  }

  it('runs Scenarios 1-5 sequentially in one AgentHeadDO session with iOS multipart + strict receipt parity', async () => {
    const founder = await signIn();
    const otherUser = await signIn();
    const authHeaders = { authorization: `Bearer ${founder.token}` };
    const otherHeaders = { authorization: `Bearer ${otherUser.token}` };

    // Scenario 1: Save Personal Memory, verify clearTranscript survival & Fast Path SSE injection
    const savedMemory = await json<PersonalMemorySaveResultDto>(
      await harness.fetchOverHttp('/v2/memories', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'preference',
          key: 'coffee_city',
          content: 'Always send Kyoto coffee briefings in concise bullets.',
          provenance: { source: 'user_settings' },
          client_request_id: randomUUID(),
        }),
      }),
      201,
    );
    expect(savedMemory.item.content).toContain('Kyoto');

    const cleared = await json<{ transcript_epoch: number }>(
      await harness.fetchOverHttp('/v1/me/conversation/messages', {
        method: 'DELETE',
        headers: authHeaders,
      }),
      200,
    );
    const epoch = cleared.transcript_epoch;

    const listedMemories = await json<PersonalMemoryListDto>(
      await harness.fetchOverHttp('/v2/memories', { headers: authHeaders }),
      200,
    );
    expect(listedMemories.items.some((m) => m.memory_id === savedMemory.item.memory_id)).toBe(true);

    // Verify NL fast SSE stream injects the saved memory
    harness.fakeGateway.enqueueRules({
      mode: 'fast_ok',
      replyText: 'Got it — Kyoto bullets noted.',
    });
    const sseRes = await harness.fetchOverHttp(
      `/v2/conversations/${founder.conversationId}/messages/stream`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: 'Confirm my briefing format.',
          transcript_epoch: epoch,
        }),
      },
    );
    expect(sseRes.status).toBe(201);
    await sseRes.text();
    const sseCall = harness.fakeGateway.getAuditSnapshot().calls.at(-1);
    expect(sseCall?.personalMemories).toEqual([
      {
        kind: 'preference',
        key: 'coffee_city',
        content: 'Always send Kyoto coffee briefings in concise bullets.',
      },
    ]);

    // Scenario 3A: iOS-exact multipart/form-data upload + NL attachment_ids -> delegate_python_agent
    const csvData = 'city,cups\nKyoto,4\nTokyo,2\n';
    const mpChat = buildIosMultipartUpload('g2-nl.csv', 'text/csv', csvData);
    const chatUpload = B3StagedUploadReceiptDtoSchema.parse(
      await json(
        await harness.fetchOverHttp('/v1/me/uploads', {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': mpChat.contentType },
          body: mpChat.body,
        }),
        201,
      ),
    );
    expect(chatUpload.size).toBe(Buffer.byteLength(csvData, 'utf-8'));

    harness.fakeGateway.enqueueRules({
      mode: 'fast_ok',
      replyText: 'Running Python analysis on your uploaded CSV.',
      delegation: {
        toolName: 'delegate_python_agent',
        arguments: {
          title: 'G2 Combined NL CSV',
          prompt: 'Analyze g2-nl.csv\n# output: g2-nl-report.csv',
        },
      },
    });
    const chatSubmitRes = await harness.fetchOverHttp(
      `/v1/conversations/${founder.conversationId}/messages`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: 'Analyze attached CSV.',
          transcript_epoch: epoch,
          attachment_ids: [chatUpload.upload_id],
        }),
      },
    );
    const chatReceipt = await json<{
      readonly message: Record<string, unknown>;
      readonly turn: Record<string, unknown>;
      readonly transcript_epoch: number;
    }>(chatSubmitRes, 201);
    // Strict iOS LiveB1Receipt.init wire key check
    for (const key of Object.keys(chatReceipt.message)) {
      expect(ALLOWED_IOS_RECEIPT_MESSAGE_KEYS.has(key)).toBe(true);
    }

    let nlTaskId: string | undefined;
    const nlDeadline = Date.now() + 10_000;
    while (Date.now() < nlDeadline) {
      const list = B1TaskListDtoSchema.parse(
        await json(await harness.fetchOverHttp('/v1/me/tasks', { headers: authHeaders }), 200),
      );
      const task = list.tasks.find((t) => t.title === 'G2 Combined NL CSV');
      if (task?.status === 'completed') {
        nlTaskId = task.task_id;
        break;
      }
      await setTimeout(100);
    }
    expect(nlTaskId).toBeDefined();
    const nlArtifacts = B3TaskArtifactsListDtoSchema.parse(
      await json(
        await harness.fetchOverHttp(`/v1/me/tasks/${nlTaskId}/artifacts`, {
          headers: authHeaders,
        }),
        200,
      ),
    );
    const nlOut = nlArtifacts.artifacts.find((a) => a.created_by === 'run');
    expect(nlOut).toBeDefined();
    const nlDownload = await harness.fetchOverHttp(`/v1/me/artifacts/${nlOut!.artifact_id}`, {
      headers: authHeaders,
    });
    expect(nlDownload.status).toBe(200);
    const nlCsv = await nlDownload.text();
    expect(createHash('sha256').update(Buffer.from(nlCsv, 'utf-8')).digest('hex')).toBe(
      nlOut!.sha256,
    );

    // Scenario 3B: Direct POST /v2/tasks/python from multipart upload
    const mpDirect = buildIosMultipartUpload('g2-direct.csv', 'text/csv', csvData);
    const directUpload = B3StagedUploadReceiptDtoSchema.parse(
      await json(
        await harness.fetchOverHttp('/v1/me/uploads', {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': mpDirect.contentType },
          body: mpDirect.body,
        }),
        201,
      ),
    );
    const directSubmit = await json<{
      readonly task: ReturnType<typeof B1TaskDetailDtoSchema.parse>;
      readonly created: boolean;
    }>(
      await harness.fetchOverHttp('/v2/tasks/python', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({
          title: 'G2 Direct Python',
          prompt: 'Summarize g2-direct.csv\n# output: g2-direct-out.csv',
          attachment_ids: [directUpload.upload_id],
        }),
      }),
      201,
    );
    expect(directSubmit.created).toBe(true);
    expect(B1TaskDetailDtoSchema.parse(directSubmit.task).kind).toBe('python.agent');

    // Scenario 2 & 4: Morning brief (model_brief injects memory, no tools) + Cancel follow-up
    const briefSchedule = await json<ProactiveScheduleSnapshot>(
      await harness.fetchOverHttp('/v2/schedules', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: `g2-brief-${randomUUID()}`,
          kind: 'brief',
          title: 'Morning Kyoto Brief',
          prompt: 'Prepare brief using my saved preferences.',
          trigger: { type: 'once', fireAt: new Date(Date.now() + 250).toISOString() },
          timezone: 'Asia/Shanghai',
          deliveryMode: 'model_brief',
        }),
      }),
      201,
    );
    const cancelledSchedule = await json<ProactiveScheduleSnapshot>(
      await harness.fetchOverHttp('/v2/schedules', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: `g2-cancel-${randomUUID()}`,
          kind: 'follow_up',
          title: 'Cancelled Follow-up',
          prompt: 'Should never fire',
          trigger: { type: 'once', fireAt: new Date(Date.now() + 2_000).toISOString() },
          timezone: 'Asia/Shanghai',
        }),
      }),
      201,
    );
    await json<ProactiveScheduleSnapshot>(
      await harness.fetchOverHttp(`/v2/schedules/${cancelledSchedule.scheduleId}/cancel`, {
        method: 'POST',
        headers: authHeaders,
      }),
      200,
    );

    harness.fakeGateway.enqueueRules({
      mode: 'fast_ok',
      replyText: 'Kyoto morning brief ready.',
    });
    let briefDelivered = false;
    const schedDeadline = Date.now() + 10_000;
    while (Date.now() < schedDeadline) {
      const page = B1ConversationPageSchema.parse(
        await json(
          await harness.fetchOverHttp(
            `/v1/conversations/${founder.conversationId}/messages?after=0&limit=50`,
            { headers: authHeaders },
          ),
          200,
        ),
      );
      if (page.messages.some((m) => m.kind === 'ember' && m.text.includes('Morning Kyoto Brief'))) {
        briefDelivered = true;
        break;
      }
      await setTimeout(100);
    }
    expect(briefDelivered).toBe(true);
    const briefCall = harness.fakeGateway
      .getAuditSnapshot()
      .calls.find((c) => c.prompt?.includes('Prepare brief using my saved preferences.') === true);
    expect(briefCall?.allowDelegationTools).toBe(false);
    expect(briefCall?.prompt).toContain('Kyoto');

    // Scenario 5: Register device -> dispatch /v2/device-tasks -> claim -> commit result
    const deviceId = randomUUID();
    const deviceSecret = randomBytes(32).toString('hex');
    const deviceHeaders = { ...authHeaders, 'x-device-token': deviceSecret };
    await json(
      await harness.fetchOverHttp(`/v2/devices/${deviceId}/register`, {
        method: 'POST',
        headers: { ...deviceHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ capability: DEVICE_TEXT_CAPABILITY, version: 1 }),
      }),
      200,
    );
    const dispatched = await json<DeviceTaskSnapshot>(
      await harness.fetchOverHttp('/v2/device-tasks', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          operationId: randomUUID(),
          deadlineMs: 60_000,
          capability: DEVICE_TEXT_CAPABILITY,
          version: 1,
          input: { operation: 'stats', text: 'Kyoto\n' },
        }),
      }),
      201,
    );
    const claimed = await json<Extract<DeviceClaim, { kind: 'claimed' }>>(
      await harness.fetchOverHttp(`/v2/devices/${deviceId}/claim`, {
        method: 'POST',
        headers: { ...deviceHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      200,
    );
    expect(claimed.kind).toBe('claimed');
    await json(
      await harness.fetchOverHttp(`/v2/devices/${deviceId}/tasks/${dispatched.taskId}/result`, {
        method: 'POST',
        headers: { ...deviceHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId: claimed.operationId,
          runId: claimed.runId,
          leaseEpoch: claimed.leaseEpoch,
          status: 'completed',
          output: { utf8Bytes: 6, unicodeScalars: 6, lines: 1 },
        }),
      }),
      200,
    );
    const finalDeviceTask = await json<DeviceTaskSnapshot>(
      await harness.fetchOverHttp(`/v2/device-tasks/${dispatched.taskId}`, {
        headers: authHeaders,
      }),
      200,
    );
    expect(finalDeviceTask.status).toBe('completed');

    // Cross-account 404 isolation across all Scenario 1-5 resources
    for (const isolatedPath of [
      `/v2/memories`,
      `/v2/schedules/${briefSchedule.scheduleId}`,
      `/v1/me/artifacts/${nlOut!.artifact_id}`,
      `/v2/device-tasks/${dispatched.taskId}`,
    ]) {
      const res = await harness.fetchOverHttp(isolatedPath, { headers: otherHeaders });
      if (isolatedPath === '/v2/memories') {
        const otherMemories = await json<PersonalMemoryListDto>(res, 200);
        expect(otherMemories.items).toHaveLength(0);
      } else {
        expect(res.status).toBe(404);
      }
    }
  });
});
