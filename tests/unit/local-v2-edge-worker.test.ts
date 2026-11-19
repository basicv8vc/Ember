import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  B1AssistantTurnDtoSchema,
  B1ConversationPageSchema,
  B1SendMessageReceiptSchema,
  type B1AssistantTurnDto,
} from '@ember/contracts';
import { DomainError } from '@ember/domain';
import { FakeStreamingModelGateway, type FakeConversationJob } from '@ember/model-gateway';
import type { B1SessionRuntime } from '../../apps/api/src/auth/b1-auth-runtime.js';
import { generateSessionToken } from '../../apps/api/src/auth/session-token.js';
import {
  createLocalV2EdgeWorker,
  type LocalV2EdgeDependencies,
} from '../../apps/api/src/local-v2/edge-worker.js';
import type {
  EdgeAgentHeadRpc,
  PreparedTurn,
  PrepareTurnRequest,
} from '../../apps/api/src/local-v2/rpc.js';

const tenantId = crypto.randomUUID();
const principalId = crypto.randomUUID();
const agentId = crypto.randomUUID();
const conversationId = crypto.randomUUID();
const token = generateSessionToken();
const messagePath = `/v1/conversations/${conversationId}/messages`;
const streamPath = `/v2/conversations/${conversationId}/messages/stream`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const payload = {
  client_submission_id: crypto.randomUUID(),
  text: '你好 Ember',
  transcript_epoch: 0,
};
const submissionPath = `/v1/message-submissions/${payload.client_submission_id}`;

function mockRpc<T extends (...args: never[]) => Promise<unknown>>(
  handler: (...args: Parameters<T>) => Awaited<ReturnType<T>>,
) {
  return vi.fn((...args: Parameters<T>) => Promise.resolve().then(() => handler(...args)));
}

function fixture(reasoningMs = 0) {
  let saved:
    { request: PrepareTurnRequest; prepared: PreparedTurn; turn: B1AssistantTurnDto } | undefined;
  let epoch = 0;
  let assistantText: string | undefined;
  let authorized = false;
  const jobs = new Map<string, FakeConversationJob>();
  const jobStore = {
    create: vi.fn((job: FakeConversationJob) => {
      if ([...jobs.values()].some((stored) => stored.operationId === job.operationId)) {
        return Promise.reject(new Error('operation exists'));
      }
      jobs.set(job.handle, job);
      return Promise.resolve();
    }),
    get: vi.fn((handle: string) => Promise.resolve(jobs.get(handle) ?? null)),
  };
  const provider = new FakeStreamingModelGateway(jobStore, { reasoningMs });
  const startProvider = vi.spyOn(provider, 'streamConversationTurn');

  const rpc = {
    prepareTurn: mockRpc<EdgeAgentHeadRpc['prepareTurn']>((request) => {
      if (request.request.transcript_epoch !== epoch) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'epoch changed');
      }
      if (saved !== undefined) {
        if (request.request.text !== saved.request.request.text) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'changed payload');
        }
        return {
          kind: 'replay',
          replayed: true,
          receipt: saved.prepared.receipt,
          currentTurnStatus: saved.turn.status,
        };
      }
      const createdAt = new Date().toISOString();
      const turnId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const receipt = B1SendMessageReceiptSchema.parse({
        message: {
          message_id: messageId,
          conversation_id: conversationId,
          sequence: 1,
          created_at: createdAt,
          kind: 'user',
          text: request.request.text,
          client_submission_id: request.request.client_submission_id,
        },
        turn: { turn_id: turnId, status: 'running', created_at: createdAt },
        transcript_epoch: epoch,
      });
      const prepared: PreparedTurn = {
        kind: 'prepared',
        replayed: false,
        receipt,
        turnId,
        attemptNo: 1,
        operationId: crypto.randomUUID(),
        leaseEpoch: 1,
        leaseExpiresAtMs:
          request.executionMode === 'fast_interactive' ? Date.now() + request.leaseMs : null,
        interactiveDeadlineMs:
          request.executionMode === 'fast_interactive'
            ? Date.now() + request.interactiveDeadlineMs
            : null,
        turnDeadlineMs: Date.now() + request.turnDeadlineMs,
        globalGrantId: crypto.randomUUID(),
        reservedMicroUsd: 1,
        context: [{ sequence: 1, kind: 'user', text: request.request.text }],
      };
      const turn = B1AssistantTurnDtoSchema.parse({
        ...receipt.turn,
        conversation_id: conversationId,
        source_message_id: messageId,
        updated_at: createdAt,
        response_message_id: null,
        failure_reason: null,
      });
      saved = { request, prepared, turn };
      return prepared;
    }),
    markAttemptSent: mockRpc<EdgeAgentHeadRpc['markAttemptSent']>(() => {
      if (authorized) return { authorized: false, reason: 'already_sent' };
      if (saved?.turn.status !== 'running') return { authorized: false, reason: 'cancelled' };
      authorized = true;
      return { authorized: true, sentAtMs: Date.now(), startBeforeMs: Date.now() + 5_000 };
    }),
    renewTurnLease: mockRpc<EdgeAgentHeadRpc['renewTurnLease']>((command) => {
      if (saved?.turn.status !== 'running') return { renewed: false, reason: 'cancelled' };
      return {
        renewed: true,
        leaseExpiresAtMs: Date.now() + command.extendMs,
        cancelRequested: false,
      };
    }),
    handoffTurnToDurable: mockRpc<EdgeAgentHeadRpc['handoffTurnToDurable']>((command) => ({
      outcome: 'handed_off',
      nextLeaseEpoch: command.leaseEpoch + 1,
      executionMode: 'durable_queue',
      turnId: command.turnId,
    })),
    commitTurn: mockRpc<EdgeAgentHeadRpc['commitTurn']>((command) => {
      if (saved?.turn.status !== 'running' || rpc.handoffTurnToDurable.mock.calls.length > 0) {
        return { outcome: 'fenced', turn: saved?.turn ?? null };
      }
      if (command.result.status === 'aborted_for_retry_or_reconcile') {
        return { outcome: 'reconciled_only', turn: saved.turn };
      }
      const responseMessageId = crypto.randomUUID();
      const failed = command.result.status === 'failed';
      assistantText = failed ? 'Timed out.' : command.result.text;
      saved.turn = {
        ...saved.turn,
        status: command.result.status,
        response_message_id: responseMessageId,
        failure_reason: failed ? command.result.failureReason : null,
      };
      return {
        outcome: 'published',
        turn: saved.turn,
        responseMessageId,
        sequence: 2,
        delegatedTaskId: null,
      };
    }),
    readMessages: mockRpc<EdgeAgentHeadRpc['readMessages']>(({ after, conversationId: id }) => {
      if (id !== conversationId) throw new DomainError('NOT_FOUND', 'conversation is not visible');
      const user = saved?.prepared.receipt.message;
      const messages = [];
      if (user && after < user.sequence) {
        const { conversation_id: _conversation, ...publicMessage } = user;
        messages.push(publicMessage);
      }
      if (saved?.turn.response_message_id && assistantText && after < 2) {
        messages.push({
          message_id: saved.turn.response_message_id,
          sequence: 2,
          created_at: saved.turn.created_at,
          kind: 'ember',
          text: assistantText,
          model_label: provider.modelLabel,
          simulated: true,
        });
      }
      return B1ConversationPageSchema.parse({
        conversation_id: id,
        transcript_epoch: epoch,
        messages,
        next_after: messages.at(-1)?.sequence ?? after,
        has_more: false,
      });
    }),
    findSubmissionReceipt: mockRpc<EdgeAgentHeadRpc['findSubmissionReceipt']>(
      ({ clientSubmissionId }) =>
        saved?.request.request.client_submission_id === clientSubmissionId
          ? saved.prepared.receipt
          : null,
    ),
    getTurn: mockRpc<EdgeAgentHeadRpc['getTurn']>(({ turnId, conversationId: id }) =>
      saved?.turn.turn_id === turnId && id === conversationId ? saved.turn : null,
    ),
    cancelTurn: mockRpc<EdgeAgentHeadRpc['cancelTurn']>(({ turnId, conversationId: id }) => {
      if (saved?.turn.turn_id !== turnId || id !== conversationId)
        throw new DomainError('NOT_FOUND', 'turn is not visible');
      if (saved.turn.status === 'running') saved.turn = { ...saved.turn, status: 'cancelled' };
      return saved.turn;
    }),
    clearTranscript: mockRpc<EdgeAgentHeadRpc['clearTranscript']>(() => {
      const counts = {
        deletedMessages: saved ? (assistantText ? 2 : 1) : 0,
        deletedTurns: saved ? 1 : 0,
      };
      saved = undefined;
      assistantText = undefined;
      return { ...counts, transcriptEpoch: ++epoch };
    }),
  } satisfies EdgeAgentHeadRpc;

  const sessions: B1SessionRuntime = {
    service: {
      resolveActiveSession(value) {
        if (value !== token) return Promise.resolve(null);
        return Promise.resolve({
          auth: { tenantId, principalId, policyVersion: 1 },
          session: {
            sessionId: crypto.randomUUID(),
            consumerId: crypto.randomUUID(),
            tenantId,
            expiresAt: '2026-12-01T00:00:00.000Z',
            idleExpiresAt: '2026-12-01T00:00:00.000Z',
            revokedAt: null,
          },
        });
      },
      createSession: vi.fn(),
      refreshSession: vi.fn(),
      logout: vi.fn(),
    },
    appleVerifier: { provider: 'apple', verify: vi.fn() },
    devVerifier: { provider: 'dev', verify: vi.fn() },
    devProvider: { evaluate: vi.fn() },
    me: { getMeForTenant: vi.fn() },
  };
  const resolveAgentHead = vi.fn(() => Promise.resolve({ agentId, conversationId, rpc }));
  const dependencies: LocalV2EdgeDependencies = {
    sessions,
    resolveAgentHead,
    stream: { gateway: provider },
  };
  const worker = createLocalV2EdgeWorker(dependencies);
  const background: Promise<void>[] = [];

  function fetch(path: string, init: RequestInit = {}) {
    return worker.fetch(
      new Request(new URL(path, 'http://127.0.0.1:8787'), { headers, ...init }),
      undefined,
      { waitUntil: (work) => background.push(work) },
    );
  }

  function post(path: string, value = payload, options: RequestInit = {}) {
    return fetch(path, { method: 'POST', body: JSON.stringify(value), ...options });
  }

  return {
    rpc,
    provider,
    startProvider,
    jobStore,
    resolveAgentHead,
    dependencies,
    fetch,
    post,
    background,
    saved: () => saved!,
  };
}

async function firstFrame(response: Response) {
  expect(response.status).toBe(201);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  const accepted = new TextDecoder().decode(value);
  expect(accepted).toContain('event: turn.accepted');
  return reader;
}

describe('local V2 Edge HTTP contracts', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-19T12:00:00.000Z') }));
  afterEach(() => vi.useRealTimers());

  it('preserves B1 receipt, polling, paging, cancellation and deletion with a durable 60s deadline', async () => {
    const f = fixture();
    const first = await f.post(messagePath);
    expect(first.status).toBe(201);
    const receipt = B1SendMessageReceiptSchema.parse(await first.json());
    expect(f.rpc.prepareTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: 'durable_queue',
        turnDeadlineMs: 60_000,
        leaseMs: 25_000,
        interactiveDeadlineMs: 22_000,
      }),
    );
    const [prepare] = f.rpc.prepareTurn.mock.calls[0]!;
    expect(prepare.scope).toMatchObject({ tenantId, principalId, agentId, policyVersion: 1 });
    expect(prepare.modelReservation).toMatchObject({
      budgetMode: 'simulated_full_protocol',
      estimatedMicroUsd: 1,
    });
    expect(f.rpc.markAttemptSent).not.toHaveBeenCalled();
    expect(f.startProvider).not.toHaveBeenCalled();

    const replay = await f.post(messagePath);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    const turnPath = `/v1/conversations/${conversationId}/turns/${receipt.turn.turn_id}`;
    const cancelled = await f.fetch(`${turnPath}/cancel`, { method: 'POST' });
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled' });
    expect(await (await f.fetch(turnPath)).json()).toMatchObject({ status: 'cancelled' });
    expect(await (await f.fetch(submissionPath)).json()).toEqual(receipt);
    expect(await (await f.fetch(`${messagePath}?after=0&limit=1`)).json()).toMatchObject({
      messages: [{ text: payload.text }],
      next_after: 1,
      transcript_epoch: 0,
    });
    const clear = await f.fetch('/v1/me/conversation/messages', { method: 'DELETE' });
    expect(await clear.json()).toEqual({
      deleted_messages: 1,
      deleted_turns: 1,
      transcript_epoch: 1,
    });
    expect((await f.fetch(submissionPath)).status).toBe(404);
    expect((await f.post(messagePath)).status).toBe(409);
  });

  it('normalizes UUID input as V1 PostgreSQL does and resolves staged metadata within the session', async () => {
    const f = fixture();
    const uploadId = crypto.randomUUID();
    const attachment = {
      uploadId,
      filename: 'file.pdf',
      mediaType: 'application/pdf' as const,
      sizeBytes: 42,
      r2Key: 'local/file.pdf',
      sha256: 'a'.repeat(64),
    };
    const resolveAttachments = vi.fn(() => Promise.resolve([attachment]));
    const worker = createLocalV2EdgeWorker({ ...f.dependencies, resolveAttachments });
    const path = messagePath.replace(conversationId, conversationId.toUpperCase());
    const response = await worker.fetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...payload,
          client_submission_id: payload.client_submission_id.toUpperCase(),
          attachment_ids: [uploadId.toUpperCase()],
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(resolveAttachments).toHaveBeenCalledExactlyOnceWith(
      { tenantId, principalId, policyVersion: 1 },
      [uploadId],
    );
    expect(f.rpc.prepareTurn.mock.calls[0]![0]).toMatchObject({
      conversationId,
      request: { client_submission_id: payload.client_submission_id, attachment_ids: [uploadId] },
      resolvedAttachments: [attachment],
    });
    expect(
      (
        await f.fetch(
          submissionPath.replace(
            payload.client_submission_id,
            payload.client_submission_id.toUpperCase(),
          ),
        )
      ).status,
    ).toBe(200);
  });

  it('reconciles a committed write with a lost ACK and rejects payload changes', async () => {
    const f = fixture();
    const prepare = f.rpc.prepareTurn.getMockImplementation()!;
    f.rpc.prepareTurn.mockImplementationOnce(async (request) => {
      await prepare(request);
      throw new Error('private RPC transport details');
    });
    expect((await f.fetch(submissionPath)).status).toBe(404);
    const unknown = await f.post(messagePath);
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toMatchObject({ error: { code: 'DB_UNAVAILABLE' } });
    expect(await (await f.fetch(submissionPath)).json()).toEqual(f.saved().prepared.receipt);
    expect((await f.post(messagePath, { ...payload, text: 'different' })).status).toBe(409);
    expect((await f.post(messagePath)).status).toBe(200);
  });

  it('rejects caller-supplied routing, malformed cursors, unauthorized requests and nonlocal SSE', async () => {
    const f = fixture();
    expect((await f.post(messagePath, payload, { headers: {} })).status).toBe(401);
    expect(
      (
        await f.post(messagePath, payload, {
          headers: { ...headers, 'idempotency-key': 'duplicate' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.post(streamPath, { ...payload, tenant_id: tenantId } as typeof payload)).status,
    ).toBe(400);
    expect((await f.fetch(`${messagePath}?limit=1&limit=2`)).status).toBe(400);
    expect(f.resolveAgentHead).not.toHaveBeenCalled();
    expect((await f.post(messagePath.replace(conversationId, crypto.randomUUID()))).status).toBe(
      404,
    );
    expect(f.rpc.prepareTurn).not.toHaveBeenCalled();
    expect((await f.fetch(new URL(streamPath, 'https://external.invalid').href)).status).toBe(404);
    const worker = createLocalV2EdgeWorker({
      sessions: f.dependencies.sessions,
      resolveAgentHead: f.resolveAgentHead,
    });
    expect(
      (
        await worker.fetch(
          new Request(`http://localhost${streamPath}`, { method: 'POST', headers }),
        )
      ).status,
    ).toBe(404);
  });

  it('emits provisional deltas after authorization and publishes only the fenced commit', async () => {
    const f = fixture();
    const response = await f.post(streamPath);
    expect(response.status).toBe(201);
    const frames = await response.text();
    const events = frames.match(/event: [^\n]+/g)!;
    expect(events[0]).toBe('event: turn.accepted');
    expect(events.slice(1, -1).length).toBeGreaterThan(0);
    expect(new Set(events.slice(1, -1))).toEqual(new Set(['event: turn.delta']));
    expect(events.at(-1)).toBe('event: turn.committed');
    expect(frames).not.toContain(f.saved().prepared.operationId);
    expect(f.rpc.markAttemptSent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operationId: f.saved().prepared.operationId,
        leaseEpoch: 1,
      }),
    );
    expect(f.rpc.markAttemptSent.mock.invocationCallOrder[0]).toBeLessThan(
      f.startProvider.mock.invocationCallOrder[0]!,
    );
    expect(f.startProvider.mock.invocationCallOrder[0]).toBeLessThan(
      f.rpc.commitTurn.mock.invocationCallOrder[0]!,
    );
    expect(f.rpc.commitTurn.mock.calls[0]![0].settlement).toMatchObject({
      state: 'settled',
      observedCostMicroUsd: 0,
    });
    const replay = await f.post(streamPath);
    expect(replay.status).toBe(200);
    expect((await replay.text()).match(/event: [^\n]+/g)).toEqual(['event: turn.accepted']);
    expect(f.startProvider).toHaveBeenCalledTimes(1);
  });

  it.each(['already_sent', 'budget_halted', 'cancelled'] as const)(
    'keeps provider closed on %s',
    async (reason) => {
      const f = fixture();
      f.rpc.markAttemptSent.mockResolvedValueOnce({ authorized: false, reason });
      const frames = await (await f.post(streamPath)).text();
      expect(frames).toContain('turn.accepted');
      expect(frames).not.toContain('turn.delta');
      expect(f.startProvider).not.toHaveBeenCalled();
      expect(f.rpc.commitTurn).not.toHaveBeenCalled();
    },
  );

  it('requires a positive global grant before it even requests send authorization', async () => {
    const f = fixture();
    const prepare = f.rpc.prepareTurn.getMockImplementation()!;
    f.rpc.prepareTurn.mockImplementationOnce(async (request) => {
      const result = await prepare(request);
      if (result.kind !== 'prepared') throw new Error('expected a new turn');
      return { ...result, globalGrantId: null };
    });
    expect(await (await f.post(streamPath)).text()).not.toContain('turn.delta');
    expect(f.rpc.markAttemptSent).not.toHaveBeenCalled();
    expect(f.startProvider).not.toHaveBeenCalled();
  });

  it('rejects an authorization whose start window has elapsed', async () => {
    const f = fixture();
    f.rpc.markAttemptSent.mockResolvedValueOnce({
      authorized: true,
      sentAtMs: Date.now() - 1,
      startBeforeMs: Date.now(),
    });
    expect(await (await f.post(streamPath)).text()).not.toContain('turn.delta');
    expect(f.startProvider).not.toHaveBeenCalled();
    expect(f.rpc.commitTurn).not.toHaveBeenCalled();
  });

  it('stops provider activity after the authority refuses a renewal', async () => {
    const f = fixture(40_000);
    f.rpc.renewTurnLease.mockResolvedValueOnce({ renewed: false, reason: 'expired' });
    const response = await f.post(streamPath);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await response.text()).not.toContain('turn.delta');
    expect(f.rpc.renewTurnLease).toHaveBeenCalledTimes(1);
    expect(f.startProvider.mock.calls[0]![1].aborted).toBe(true);
    expect(f.rpc.commitTurn).not.toHaveBeenCalled();
    expect(f.rpc.handoffTurnToDurable).not.toHaveBeenCalled();
  });

  it('closes the stream on an ambiguous authorization ACK without sending or refunding', async () => {
    const f = fixture();
    f.rpc.markAttemptSent.mockRejectedValueOnce(new Error('ACK was lost'));
    const frames = await (await f.post(streamPath)).text();
    expect(frames).not.toContain('turn.delta');
    expect(f.startProvider).not.toHaveBeenCalled();
    expect(f.rpc.commitTurn).not.toHaveBeenCalled();
    expect(f.rpc.handoffTurnToDurable).not.toHaveBeenCalled();
  });

  it('fences a late result after HTTP cancellation without publishing a committed event', async () => {
    const f = fixture(5_000);
    const response = await f.post(streamPath);
    const { turnId } = f.saved().prepared;
    await f.fetch(`/v1/conversations/${conversationId}/turns/${turnId}/cancel`, { method: 'POST' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await response.text()).not.toContain('turn.committed');
    expect(f.rpc.commitTurn).toHaveBeenCalledTimes(1);
    expect(await (await f.fetch(messagePath)).json()).toMatchObject({
      messages: [{ kind: 'user' }],
    });
    expect(
      await (await f.fetch(`/v1/conversations/${conversationId}/turns/${turnId}`)).json(),
    ).toMatchObject({ status: 'cancelled' });
  });

  it.each(['reader', 'request'] as const)(
    'hands off on %s disconnect and does not restart on replay',
    async (source) => {
      const f = fixture(180_000);
      const connection = new AbortController();
      const response = await f.post(streamPath, payload, { signal: connection.signal });
      const reader = await firstFrame(response);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(f.rpc.renewTurnLease).toHaveBeenCalledTimes(1);
      const signal = f.startProvider.mock.calls[0]![1];
      if (source === 'reader') await reader.cancel();
      else connection.abort();
      await Promise.all(f.background);
      expect(signal.aborted).toBe(true);
      const [handoff] = f.rpc.handoffTurnToDurable.mock.calls[0]!;
      expect(handoff.reason).toBe('client_disconnect_handoff');
      expect(handoff.providerJobHandle).toBeDefined();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.rpc.renewTurnLease).toHaveBeenCalledTimes(1);
      expect((await f.post(messagePath)).status).toBe(200);
      expect(await (await f.fetch(messagePath)).json()).toMatchObject({
        messages: [{ kind: 'user' }],
        next_after: 1,
      });
      expect(f.startProvider).toHaveBeenCalledTimes(1);
      expect(f.rpc.commitTurn).not.toHaveBeenCalled();
    },
  );

  it('renews every 15s and hands off at 110s, then a fresh provider instance only queries the original job', async () => {
    const f = fixture(140_000);
    const response = await f.post(streamPath);
    const transferStartsAt = Date.now();
    const { operationId } = f.saved().prepared;
    const frames = response.text();
    await vi.advanceTimersByTimeAsync(109_999);
    expect(f.rpc.renewTurnLease).toHaveBeenCalledTimes(7);
    expect(f.rpc.handoffTurnToDurable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const { providerJobHandle } = f.rpc.handoffTurnToDurable.mock.calls[0]![0];
    expect(f.rpc.commitTurn).not.toHaveBeenCalled();
    expect(await frames).toContain('event: turn.handed_off');
    const job = await f.jobStore.get(providerJobHandle!);
    expect(job).toMatchObject({ operationId, deadlineAtMs: transferStartsAt + 600_000 });
    const durableGateway = new FakeStreamingModelGateway(f.jobStore);
    const durableStart = vi.spyOn(durableGateway, 'generateConversationTurn');
    const signal = new AbortController().signal;
    expect(
      await durableGateway.queryConversationJob(operationId, providerJobHandle!, signal),
    ).toEqual({ state: 'pending' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      await durableGateway.queryConversationJob(operationId, providerJobHandle!, signal),
    ).toMatchObject({ state: 'completed', result: { simulated: true } });
    expect(
      await durableGateway.queryConversationJob(crypto.randomUUID(), providerJobHandle!, signal),
    ).toEqual({ state: 'unavailable' });
    await vi.advanceTimersByTimeAsync(460_000);
    expect(
      await durableGateway.queryConversationJob(operationId, providerJobHandle!, signal),
    ).toEqual({ state: 'unavailable' });
    expect(durableStart).not.toHaveBeenCalled();
    expect(f.jobStore.create).toHaveBeenCalledTimes(1);
    expect(f.startProvider).toHaveBeenCalledTimes(1);
  });

  it('settles conservatively when the first provider frame times out without a handle', async () => {
    const f = fixture();
    const slow = new FakeStreamingModelGateway(f.jobStore, { delayMs: 31_000 });
    const worker = createLocalV2EdgeWorker({ ...f.dependencies, stream: { gateway: slow } });
    const response = await worker.fetch(
      new Request(`http://localhost${streamPath}`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers,
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.rpc.handoffTurnToDurable).not.toHaveBeenCalled();
    expect(f.rpc.commitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        settlement: { state: 'unknown_billed', outcomeCode: 'model_timeout' },
        result: { status: 'failed', failureReason: 'timeout' },
      }),
    );
    expect(await response.text()).not.toContain('turn.delta');
    expect(f.jobStore.create).not.toHaveBeenCalled();
  });
});

it('reconciles a real local HTTP disconnect by submission ID without starting a second stream', async () => {
  const f = fixture(180_000);
  const worker = createLocalV2EdgeWorker(f.dependencies);
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      worker.fetch(request, undefined, { waitUntil: (work) => f.background.push(work) }),
  });
  const connection = new AbortController();

  try {
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('missing loopback address');
    const origin = `http://127.0.0.1:${address.port}`;
    const streamed = await fetch(origin + streamPath, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers,
      signal: connection.signal,
    });
    await firstFrame(streamed);
    await vi.waitFor(() => expect(f.jobStore.create).toHaveBeenCalledTimes(1));
    connection.abort();
    await vi.waitFor(() => expect(f.rpc.handoffTurnToDurable).toHaveBeenCalledTimes(1));
    await Promise.all(f.background);

    const ack = await fetch(origin + submissionPath, { headers });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual(f.saved().prepared.receipt);
    const replay = await fetch(origin + messagePath, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(f.saved().prepared.receipt);
    expect(f.startProvider).toHaveBeenCalledTimes(1);
  } finally {
    connection.abort();
    server.close();
    if ('closeAllConnections' in server) server.closeAllConnections();
  }
});
