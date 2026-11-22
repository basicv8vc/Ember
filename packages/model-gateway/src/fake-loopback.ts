import { ModelGatewayFailure } from './errors.js';
import {
  FAKE_STREAM_MAX_REPLY_CHARS,
  FAKE_V2_RATE_VERSION,
  type FakeConversationJobStatus,
  type FakeConversationStreamEvent,
  type FakeConversationStreamRequest,
  type FakeConversationUsageStatus,
} from './fake-stream.js';
import { FAKE_MODEL_LABEL } from './fake.js';
import type {
  ConversationDelegationCall,
  ConversationTurnOutput,
  ModelCallResult,
  ModelUsage,
} from './types.js';

const MAX_FRAME_CHARS = 32 * 1024;
const JOB_HANDLE = /^[a-z0-9_-]{1,128}$/i;

/** Transport for D's local fake-provider server. The server owns the shared provider job store. */
export class LoopbackFakeModelGateway {
  readonly providerId = 'fake' as const;
  readonly modelLabel = FAKE_MODEL_LABEL;
  readonly simulated = true;
  private readonly origin: string;

  constructor(
    url: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new TypeError('fake provider requires a loopback HTTP origin');
    }
    this.origin = parsed.origin;
  }

  async *streamConversationTurn(
    request: FakeConversationStreamRequest,
    signal: AbortSignal,
  ): AsyncGenerator<FakeConversationStreamEvent, void> {
    const response = await this.request('/v2/fake-model/stream', signal, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ember-operation-id': request.operationId,
        'x-ember-turn-id': request.input.turnId,
      },
      body: JSON.stringify({
        prompt: request.input.context.at(-1)?.text ?? '',
        ...(request.input.context.at(-1)?.attachments !== undefined &&
        request.input.context.at(-1)!.attachments!.length > 0
          ? { attachments: request.input.context.at(-1)!.attachments }
          : {}),
        ...(request.input.personalMemories !== undefined &&
        request.input.personalMemories.length > 0
          ? { personalMemories: request.input.personalMemories }
          : {}),
        ...(request.input.allowDelegationTools === false ? { allowDelegationTools: false } : {}),
        ...(request.input.enablePersonalMemorySaveTool === true
          ? { enablePersonalMemorySaveTool: true }
          : {}),
        ...(request.input.enableProactiveScheduleTool === true
          ? { enableProactiveScheduleTool: true }
          : {}),
        ...(request.input.currentTimeIso !== undefined
          ? { currentTimeIso: request.input.currentTimeIso }
          : {}),
        deadlineAtMs: request.deadlineAtMs,
      }),
    });
    if (
      !response.ok ||
      response.body === null ||
      !response.headers.get('content-type')?.startsWith('text/event-stream')
    ) {
      void response.body?.cancel().catch(() => undefined);
      const code =
        response.status === 429
          ? 'model_rate_limited'
          : response.status === 504
            ? 'model_timeout'
            : 'model_unavailable';
      throw new ModelGatewayFailure(code);
    }

    for await (const frame of readFakeFrames(response.body)) {
      switch (frame.event) {
        case 'job_handle': {
          const handle = frame.data.providerJobHandle;
          if (
            typeof handle !== 'string' ||
            !JOB_HANDLE.test(handle) ||
            frame.data.modelLabel !== FAKE_MODEL_LABEL
          ) {
            throw new ModelGatewayFailure('model_invalid_output');
          }
          yield { kind: 'job', handle };
          break;
        }
        case 'progress':
          yield { kind: 'progress' };
          break;
        case 'delta':
          if (typeof frame.data.text !== 'string')
            throw new ModelGatewayFailure('model_invalid_output');
          yield { kind: 'delta', text: frame.data.text };
          break;
        case 'done':
          if (
            frame.data.operationId !== undefined &&
            frame.data.operationId !== request.operationId
          ) {
            throw new ModelGatewayFailure('model_invalid_output');
          }
          yield { kind: 'result', result: toFakeReply(frame.data) };
          return;
      }
    }
  }

  async queryConversationJob(
    operationId: string,
    handle: string,
    signal: AbortSignal,
  ): Promise<FakeConversationJobStatus> {
    if (!JOB_HANDLE.test(handle)) return { state: 'unavailable' };
    const data = await this.readJson(
      `/v2/fake-model/jobs/${encodeURIComponent(handle)}`,
      operationId,
      signal,
    );
    if (data?.handle !== handle) return { state: 'unavailable' };
    if (data.status === 'running') return { state: 'pending' };
    return data.status === 'completed'
      ? { state: 'completed', result: toFakeReply(data) }
      : { state: 'unavailable' };
  }

  async queryConversationUsage(
    operationId: string,
    signal: AbortSignal,
  ): Promise<FakeConversationUsageStatus> {
    const data = await this.readJson(
      `/v2/fake-model/operations/${encodeURIComponent(operationId)}/usage`,
      operationId,
      signal,
    );
    if (data?.status === 'running') return { state: 'pending' };
    return data?.status === 'completed'
      ? { state: 'completed', usage: parseUsage(data.usage) }
      : { state: 'unavailable' };
  }

  async queryUsageRevision(operationId: string, signal: AbortSignal) {
    const data = await this.readJson(
      `/v2/fake-model/revisions/${encodeURIComponent(operationId)}`,
      operationId,
      signal,
    );
    if (data === null) return null;
    const { settlementRevision, cumulativeChargeMicroUsd } = data;
    if (
      !isCounter(settlementRevision) ||
      settlementRevision === 0 ||
      !isCounter(cumulativeChargeMicroUsd)
    ) {
      throw new ModelGatewayFailure('model_invalid_output');
    }
    return { operationId, settlementRevision, cumulativeChargeMicroUsd };
  }

  private request(path: string, signal: AbortSignal, init?: RequestInit): Promise<Response> {
    signal.throwIfAborted();
    return this.fetcher(this.origin + path, { ...init, signal, redirect: 'manual' });
  }

  private async readJson(path: string, operationId: string, signal: AbortSignal) {
    const response = await this.request(path, signal, {
      headers: { 'x-ember-operation-id': operationId },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 404) return null;
      throw new ModelGatewayFailure('model_unavailable');
    }
    const body = await readBoundedFakeJson(response);
    return body.operationId === operationId ? body : null;
  }
}

function parsePersonalMemorySave(value: unknown): {
  readonly kind: 'preference' | 'fact';
  readonly content: string;
  readonly key?: string;
  readonly replaceId?: string;
} | null {
  if (!isRecord(value)) return null;
  if ((value.kind !== 'preference' && value.kind !== 'fact') || typeof value.content !== 'string') {
    return null;
  }
  const content = value.content.trim();
  if (content.length === 0 || content.length > 500) return null;
  if (value.key !== undefined && typeof value.key !== 'string') return null;
  const key = typeof value.key === 'string' ? value.key.trim().toLowerCase() : undefined;
  if (value.replaceId !== undefined && typeof value.replaceId !== 'string') return null;
  const replaceId =
    typeof value.replaceId === 'string'
      ? value.replaceId.trim().replace(/^#+/, '').toLowerCase()
      : undefined;
  return {
    kind: value.kind,
    content,
    ...(key !== undefined && key.length > 0 ? { key } : {}),
    ...(replaceId !== undefined && /^[0-9a-f][0-9a-f-]{3,63}$/.test(replaceId)
      ? { replaceId }
      : {}),
  };
}

function parsePersonalMemoryDelete(value: unknown): {
  readonly targets: readonly {
    readonly memoryId?: string;
    readonly key?: string;
    readonly contentMatch?: string;
  }[];
} | null {
  if (!isRecord(value) || !Array.isArray(value.targets) || value.targets.length === 0) return null;
  if (value.targets.length > 10) return null;
  const targets: {
    readonly memoryId?: string;
    readonly key?: string;
    readonly contentMatch?: string;
  }[] = [];
  for (const entry of value.targets as unknown[]) {
    if (!isRecord(entry)) return null;
    const memoryId =
      typeof entry.memoryId === 'string'
        ? entry.memoryId.trim().replace(/^#+/, '').toLowerCase()
        : undefined;
    const key = typeof entry.key === 'string' ? entry.key.trim().toLowerCase() : undefined;
    const contentMatch =
      typeof entry.contentMatch === 'string' ? entry.contentMatch.trim() : undefined;
    if (
      (entry.memoryId !== undefined &&
        (memoryId === undefined || !/^[0-9a-f][0-9a-f-]{3,63}$/.test(memoryId))) ||
      (entry.key !== undefined && (key === undefined || key.length === 0 || key.length > 64)) ||
      (entry.contentMatch !== undefined &&
        (contentMatch === undefined || contentMatch.length === 0 || contentMatch.length > 200))
    ) {
      return null;
    }
    if (memoryId === undefined && key === undefined && contentMatch === undefined) {
      return null;
    }
    targets.push({
      ...(memoryId !== undefined ? { memoryId } : {}),
      ...(key !== undefined ? { key } : {}),
      ...(contentMatch !== undefined ? { contentMatch } : {}),
    });
  }
  return { targets };
}

function parseProactiveScheduleCreate(value: unknown): {
  readonly kind: 'reminder' | 'brief' | 'follow_up';
  readonly title: string;
  readonly prompt: string;
  readonly triggerType: 'once' | 'interval' | 'cron';
  readonly fireAt?: string;
  readonly intervalSeconds?: number;
  readonly cronExpr?: string;
  readonly timezone?: string;
  readonly deliveryMode?: 'direct_reminder' | 'model_brief';
} | null {
  if (!isRecord(value)) return null;
  if (
    (value.kind !== 'reminder' && value.kind !== 'brief' && value.kind !== 'follow_up') ||
    typeof value.title !== 'string' ||
    typeof value.prompt !== 'string' ||
    (value.triggerType !== 'once' &&
      value.triggerType !== 'interval' &&
      value.triggerType !== 'cron')
  ) {
    return null;
  }
  const title = value.title.trim();
  const prompt = value.prompt.trim();
  if (title.length === 0 || title.length > 140 || prompt.length === 0 || prompt.length > 2_000) {
    return null;
  }
  const fireAt = typeof value.fireAt === 'string' ? value.fireAt.trim() : undefined;
  const intervalSeconds =
    typeof value.intervalSeconds === 'number' && Number.isInteger(value.intervalSeconds)
      ? value.intervalSeconds
      : undefined;
  const cronExpr = typeof value.cronExpr === 'string' ? value.cronExpr.trim() : undefined;
  const timezone = typeof value.timezone === 'string' ? value.timezone.trim() : undefined;
  const deliveryMode =
    value.deliveryMode === 'direct_reminder' || value.deliveryMode === 'model_brief'
      ? value.deliveryMode
      : undefined;
  return {
    kind: value.kind,
    title,
    prompt,
    triggerType: value.triggerType,
    ...(fireAt !== undefined && fireAt.length > 0 ? { fireAt } : {}),
    ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
    ...(cronExpr !== undefined && cronExpr.length > 0 ? { cronExpr } : {}),
    ...(timezone !== undefined && timezone.length > 0 ? { timezone } : {}),
    ...(deliveryMode !== undefined ? { deliveryMode } : {}),
  };
}

function parseDelegation(value: unknown): ConversationDelegationCall | null {
  if (!isRecord(value)) return null;
  if (value.toolName === 'delegate_notes_action_items' && isRecord(value.arguments)) {
    const args = value.arguments;
    if (typeof args.notes !== 'string' || args.notes.trim().length === 0) return null;
    const title = typeof args.title === 'string' ? args.title.trim() : undefined;
    const instructions =
      typeof args.instructions === 'string' ? args.instructions.trim() : undefined;
    return {
      toolName: 'delegate_notes_action_items',
      arguments: {
        notes: args.notes.trim(),
        ...(title !== undefined && title.length > 0 ? { title } : {}),
        ...(instructions !== undefined && instructions.length > 0 ? { instructions } : {}),
      },
    };
  }
  if (value.toolName === 'delegate_python_agent' && isRecord(value.arguments)) {
    const args = value.arguments;
    if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) return null;
    const title = typeof args.title === 'string' ? args.title.trim() : undefined;
    const instructions =
      typeof args.instructions === 'string' ? args.instructions.trim() : undefined;
    let attachmentIds: string[] | undefined;
    if (args.attachmentIds !== undefined) {
      if (!Array.isArray(args.attachmentIds)) {
        return null;
      }
      const normalized: string[] = [];
      for (const rawId of args.attachmentIds as unknown[]) {
        if (typeof rawId !== 'string') return null;
        const trimmed = rawId.trim();
        if (trimmed.length > 0) normalized.push(trimmed);
      }
      attachmentIds = normalized;
    }
    return {
      toolName: 'delegate_python_agent',
      arguments: {
        prompt: args.prompt.trim(),
        ...(title !== undefined && title.length > 0 ? { title } : {}),
        ...(instructions !== undefined && instructions.length > 0 ? { instructions } : {}),
        ...(attachmentIds !== undefined && attachmentIds.length > 0 ? { attachmentIds } : {}),
      },
    };
  }
  return null;
}

function toFakeReply(data: Record<string, unknown>): ModelCallResult<ConversationTurnOutput> {
  const fake =
    (data.modelLabel === undefined || data.modelLabel === FAKE_MODEL_LABEL) &&
    data.simulated !== false;
  const text =
    fake && typeof data.text === 'string' && data.text.length <= FAKE_STREAM_MAX_REPLY_CHARS
      ? data.text
      : '';
  let delegation: ConversationDelegationCall | null = null;
  if (fake && data.delegation !== undefined) {
    delegation = parseDelegation(data.delegation);
    if (delegation === null) {
      throw new ModelGatewayFailure('model_invalid_output');
    }
  }
  let memorySave: ReturnType<typeof parsePersonalMemorySave> = null;
  if (fake && data.personalMemorySave !== undefined) {
    memorySave = parsePersonalMemorySave(data.personalMemorySave);
    if (memorySave === null) {
      throw new ModelGatewayFailure('model_invalid_output');
    }
  }
  let memoryDelete: ReturnType<typeof parsePersonalMemoryDelete> = null;
  if (fake && data.personalMemoryDelete !== undefined) {
    memoryDelete = parsePersonalMemoryDelete(data.personalMemoryDelete);
    if (memoryDelete === null) {
      throw new ModelGatewayFailure('model_invalid_output');
    }
  }
  let scheduleCreate: ReturnType<typeof parseProactiveScheduleCreate> = null;
  if (fake && data.proactiveScheduleCreate !== undefined) {
    scheduleCreate = parseProactiveScheduleCreate(data.proactiveScheduleCreate);
    if (scheduleCreate === null) {
      throw new ModelGatewayFailure('model_invalid_output');
    }
  }
  return {
    output:
      delegation !== null && text.trim().length > 0
        ? {
            kind: 'delegate' as const,
            toolName: delegation.toolName,
            finishReason: 'stop' as const,
            text,
            delegation,
          }
        : memorySave !== null && text.trim().length > 0
          ? {
              kind: 'save_memory' as const,
              toolName: 'save_personal_memory' as const,
              finishReason: 'stop' as const,
              text,
              memory: {
                toolName: 'save_personal_memory' as const,
                arguments: memorySave,
              },
            }
          : memoryDelete !== null && text.trim().length > 0
            ? {
                kind: 'delete_memory' as const,
                toolName: 'delete_personal_memory' as const,
                finishReason: 'stop' as const,
                text,
                memory: {
                  toolName: 'delete_personal_memory' as const,
                  arguments: memoryDelete,
                },
              }
            : scheduleCreate !== null && text.trim().length > 0
            ? {
                kind: 'create_schedule' as const,
                toolName: 'create_proactive_schedule' as const,
                finishReason: 'stop' as const,
                text,
                schedule: {
                  toolName: 'create_proactive_schedule' as const,
                  arguments: scheduleCreate,
                },
              }
            : {
                kind: 'reply' as const,
                finishReason: 'stop' as const,
                text,
              },
    modelLabel: FAKE_MODEL_LABEL,
    simulated: true,
    usage: fake ? parseUsage(data.usage) : null,
  };
}

function parseUsage(value: unknown): ModelUsage | null {
  if (!isRecord(value)) return null;
  const { inputTokens, outputTokens, costMicroUsd, rateVersion } = value;
  if (
    !isCounter(costMicroUsd) ||
    !isCounter(inputTokens) ||
    !isCounter(outputTokens) ||
    rateVersion !== FAKE_V2_RATE_VERSION
  )
    return null;
  return { inputTokens, outputTokens, costMicroUsd, rateVersion };
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(data: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ModelGatewayFailure('model_invalid_output');
  }
  if (!isRecord(value)) throw new ModelGatewayFailure('model_invalid_output');
  return value;
}

async function readBoundedFakeJson(response: Response): Promise<Record<string, unknown>> {
  if (response.body === null) throw new ModelGatewayFailure('model_invalid_output');
  let content = '';
  for await (const chunk of decodeChunks(response.body)) {
    content += chunk;
    if (content.length > MAX_FRAME_CHARS) throw new ModelGatewayFailure('model_invalid_output');
  }
  return parseJson(content);
}

async function* readFakeFrames(body: ReadableStream<Uint8Array>) {
  let buffer = '';
  for await (const chunk of decodeChunks(body)) {
    buffer = (buffer + chunk).replaceAll('\r\n', '\n');
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      if (end > MAX_FRAME_CHARS) throw new ModelGatewayFailure('model_invalid_output');
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const lines = frame.split('\n');
      const event = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (event !== undefined && data !== '') yield { event, data: parseJson(data) };
    }
    if (buffer.length > MAX_FRAME_CHARS) throw new ModelGatewayFailure('model_invalid_output');
  }
}

async function* decodeChunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      yield decoder.decode(chunk.value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
