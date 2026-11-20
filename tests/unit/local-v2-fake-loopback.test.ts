import { describe, expect, it, vi } from 'vitest';
import {
  FAKE_MODEL_LABEL,
  LoopbackFakeModelGateway,
  type FakeConversationStreamEvent,
  type FakeConversationStreamRequest,
} from '@ember/model-gateway';

const operationId = crypto.randomUUID();
const turnId = crypto.randomUUID();
const handle = 'fake_job_1';
const origin = 'http://127.0.0.1:8787';
const usage = { inputTokens: 2, outputTokens: 3, costMicroUsd: 20, rateVersion: 'fake-v2-m1' };
const request: FakeConversationStreamRequest = {
  input: {
    conversationId: crypto.randomUUID(),
    turnId,
    context: [{ role: 'user', text: '你好' }],
    maxOutputTokens: 512,
  },
  operationId,
  deadlineAtMs: 600_000,
};

function frame(event: string, data: Record<string, unknown>) {
  return `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
}

function responseFor(text: string) {
  const data = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let start = 0; start < data.length; start += 7) {
          controller.enqueue(data.subarray(start, start + 7));
        }
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

async function readAll(gateway: LoopbackFakeModelGateway) {
  const events: FakeConversationStreamEvent[] = [];
  for await (const event of gateway.streamConversationTurn(request, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

describe('local V2 loopback provider', () => {
  it('keeps the operation binding and parses split UTF-8, progress and final metering', async () => {
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        responseFor(
          frame('job_handle', { providerJobHandle: handle, modelLabel: FAKE_MODEL_LABEL }) +
            frame('progress', {}) +
            frame('delta', { text: '你好' }) +
            frame('done', { operationId, text: '你好', usage }),
        ),
      );
    expect(await readAll(new LoopbackFakeModelGateway(origin, providerFetch))).toEqual([
      { kind: 'job', handle },
      { kind: 'progress' },
      { kind: 'delta', text: '你好' },
      {
        kind: 'result',
        result: {
          output: { kind: 'reply', finishReason: 'stop', text: '你好' },
          modelLabel: FAKE_MODEL_LABEL,
          simulated: true,
          usage,
        },
      },
    ]);
    const [url, init] = providerFetch.mock.calls[0]!;
    expect(url).toBe(`${origin}/v2/fake-model/stream`);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: { 'x-ember-operation-id': operationId, 'x-ember-turn-id': turnId },
      body: JSON.stringify({ prompt: '你好', deadlineAtMs: 600_000 }),
    });
  });

  it('preserves known usage for invalid text and keeps missing usage explicit', async () => {
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        responseFor(frame('done', { operationId, text: 'x'.repeat(9_000), usage })),
      )
      .mockResolvedValueOnce(
        responseFor(frame('done', { operationId, text: 'reply', usage: null })),
      );
    const gateway = new LoopbackFakeModelGateway(origin, providerFetch);
    expect((await readAll(gateway))[0]).toMatchObject({
      kind: 'result',
      result: { output: { text: '' }, usage },
    });
    expect((await readAll(gateway))[0]).toMatchObject({ kind: 'result', result: { usage: null } });
  });

  it('only queries the same operation and reports cumulative revision data', async () => {
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          handle,
          operationId: 'other',
          status: 'completed',
          text: 'other reply',
          usage,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ handle, operationId, status: 'completed', text: 'reply', usage }),
      )
      .mockResolvedValueOnce(Response.json({ operationId, status: 'completed', usage }))
      .mockResolvedValueOnce(
        Response.json({ operationId, settlementRevision: 1, cumulativeChargeMicroUsd: 30 }),
      );
    const durableGateway = new LoopbackFakeModelGateway(origin, providerFetch);
    const signal = new AbortController().signal;
    expect(await durableGateway.queryConversationJob(operationId, handle, signal)).toEqual({
      state: 'unavailable',
    });
    expect(await durableGateway.queryConversationJob(operationId, handle, signal)).toMatchObject({
      state: 'completed',
      result: { usage },
    });
    expect(await durableGateway.queryConversationUsage(operationId, signal)).toEqual({
      state: 'completed',
      usage,
    });
    expect(await durableGateway.queryUsageRevision(operationId, signal)).toEqual({
      operationId,
      settlementRevision: 1,
      cumulativeChargeMicroUsd: 30,
    });
    expect(providerFetch.mock.calls.map(([url, input]) => [url, input?.headers])).toEqual([
      [`${origin}/v2/fake-model/jobs/${handle}`, { 'x-ember-operation-id': operationId }],
      [`${origin}/v2/fake-model/jobs/${handle}`, { 'x-ember-operation-id': operationId }],
      [
        `${origin}/v2/fake-model/operations/${operationId}/usage`,
        { 'x-ember-operation-id': operationId },
      ],
      [`${origin}/v2/fake-model/revisions/${operationId}`, { 'x-ember-operation-id': operationId }],
    ]);
    expect(providerFetch.mock.calls.every(([, input]) => input?.method === undefined)).toBe(true);
  });

  it('rejects a remote origin and prevents aborted sends', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => new LoopbackFakeModelGateway('https://example.invalid', fetcher)).toThrow(
      TypeError,
    );
    expect(() => new LoopbackFakeModelGateway('http://localhost@remote.invalid', fetcher)).toThrow(
      TypeError,
    );
    const gateway = new LoopbackFakeModelGateway(origin, fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(
      gateway.streamConversationTurn(request, controller.signal).next(),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
