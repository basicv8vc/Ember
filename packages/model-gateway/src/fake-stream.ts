import { FakeModelGateway, type FakeModelGatewayOptions } from './fake.js';
import { ModelGatewayFailure } from './errors.js';
import type { ConversationTurnInput, ConversationTurnOutput, ModelCallResult } from './types.js';

type FakeReply = ModelCallResult<Extract<ConversationTurnOutput, { kind: 'reply' }>>;

export interface FakeConversationJob {
  readonly handle: string;
  readonly operationId: string;
  readonly readyAtMs: number;
  readonly deadlineAtMs: number;
  readonly result: FakeReply;
}

/** Provider-side simulation storage shared by the interactive and durable executors. */
export interface FakeConversationJobStore {
  /** Insert once per operation. Reject duplicates without replacing the original job. */
  create(job: FakeConversationJob): Promise<void>;
  get(handle: string): Promise<FakeConversationJob | null>;
}

export type FakeConversationJobStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'completed'; readonly result: FakeReply }
  | { readonly state: 'unavailable' };

export type FakeConversationStreamEvent =
  | { readonly kind: 'job'; readonly handle: string }
  | { readonly kind: 'progress' }
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'result'; readonly result: FakeReply };

export interface FakeConversationStreamRequest {
  readonly input: ConversationTurnInput;
  readonly operationId: string;
  readonly deadlineAtMs: number;
}

export const FAKE_STREAM_MAX_REPLY_CHARS = 8_192;
const PROGRESS_INTERVAL_MS = 10_000;
const CHUNK_CODE_POINTS = 128;

export class FakeStreamingModelGateway extends FakeModelGateway {
  constructor(
    private readonly jobs: FakeConversationJobStore,
    private readonly options: FakeModelGatewayOptions & { readonly reasoningMs?: number } = {},
  ) {
    super(options);
  }

  async *streamConversationTurn(
    request: FakeConversationStreamRequest,
    signal: AbortSignal,
  ): AsyncGenerator<FakeConversationStreamEvent, void> {
    signal.throwIfAborted();
    const generated = await this.generateConversationTurn(request.input, signal);
    const output = generated.output;
    if (
      output.kind !== 'reply' ||
      output.text.trim().length === 0 ||
      output.text.length > FAKE_STREAM_MAX_REPLY_CHARS
    ) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    signal.throwIfAborted();
    if (Date.now() >= request.deadlineAtMs) {
      throw new ModelGatewayFailure('model_timeout');
    }
    const job: FakeConversationJob = {
      handle: crypto.randomUUID(),
      operationId: request.operationId,
      readyAtMs: Date.now() + Math.max(0, this.options.reasoningMs ?? 0),
      deadlineAtMs: request.deadlineAtMs,
      result: { ...generated, output },
    };
    await this.jobs.create(job);
    yield { kind: 'job', handle: job.handle };

    for (;;) {
      signal.throwIfAborted();
      const now = Date.now();
      if (now >= job.deadlineAtMs) {
        throw new ModelGatewayFailure('model_timeout');
      }
      if (now >= job.readyAtMs) {
        break;
      }
      await sleep(
        Math.min(PROGRESS_INTERVAL_MS, job.readyAtMs - now, job.deadlineAtMs - now),
        signal,
      );
      yield { kind: 'progress' };
    }

    const characters = Array.from(output.text);
    for (let offset = 0; offset < characters.length; offset += CHUNK_CODE_POINTS) {
      signal.throwIfAborted();
      yield { kind: 'delta', text: characters.slice(offset, offset + CHUNK_CODE_POINTS).join('') };
    }
    yield { kind: 'result', result: job.result };
  }

  async queryConversationJob(
    operationId: string,
    handle: string,
    signal: AbortSignal,
  ): Promise<FakeConversationJobStatus> {
    signal.throwIfAborted();
    const job = await this.jobs.get(handle);
    signal.throwIfAborted();
    const now = Date.now();
    if (job === null || job.operationId !== operationId || now >= job.deadlineAtMs) {
      return { state: 'unavailable' };
    }
    return now < job.readyAtMs ? { state: 'pending' } : { state: 'completed', result: job.result };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new ModelGatewayFailure('client_cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
