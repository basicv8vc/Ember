import { FakeModelGateway, type FakeModelGatewayOptions } from './fake.js';
import { ModelGatewayFailure } from './errors.js';
import type {
  ConversationTurnInput,
  ConversationTurnOutput,
  ModelCallResult,
  ModelUsage,
} from './types.js';

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
  findByOperationId(operationId: string): Promise<FakeConversationJob | null>;
}

export type FakeConversationJobStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'completed'; readonly result: FakeReply }
  | { readonly state: 'unavailable' };

export type FakeConversationUsageStatus =
  | { readonly state: 'pending' | 'unavailable' }
  | { readonly state: 'completed'; readonly usage: ModelUsage | null };

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
export const FAKE_V2_RATE_VERSION = 'fake-v2-m1';
const PROGRESS_INTERVAL_MS = 10_000;
const CHUNK_CODE_POINTS = 128;

export class FakeStreamingModelGateway extends FakeModelGateway {
  constructor(
    private readonly jobs: FakeConversationJobStore,
    private readonly options: FakeModelGatewayOptions & {
      readonly reasoningMs?: number;
      readonly usageCostMicroUsd?: number | null;
    } = {},
  ) {
    super(options);
    const cost = options.usageCostMicroUsd;
    if (typeof cost === 'number' && (!Number.isSafeInteger(cost) || cost < 0)) {
      throw new RangeError('simulated usage cost must be a non-negative integer');
    }
  }

  async *streamConversationTurn(
    request: FakeConversationStreamRequest,
    signal: AbortSignal,
  ): AsyncGenerator<FakeConversationStreamEvent, void> {
    signal.throwIfAborted();
    const generated = await this.generateConversationTurn(request.input, signal);
    const output =
      generated.output.kind === 'reply' &&
      generated.output.text.length <= FAKE_STREAM_MAX_REPLY_CHARS &&
      generated.output.text.trim().length > 0
        ? generated.output
        : { kind: 'reply' as const, text: '', finishReason: 'stop' as const };

    signal.throwIfAborted();
    if (Date.now() >= request.deadlineAtMs) {
      throw new ModelGatewayFailure('model_timeout');
    }
    const cost = this.options.usageCostMicroUsd;
    const usage =
      cost === null || generated.usage === null
        ? null
        : {
            ...generated.usage,
            rateVersion: FAKE_V2_RATE_VERSION,
            costMicroUsd: cost ?? generated.usage.costMicroUsd,
          };
    const job: FakeConversationJob = {
      handle: crypto.randomUUID(),
      operationId: request.operationId,
      readyAtMs: Date.now() + Math.max(0, this.options.reasoningMs ?? 0),
      deadlineAtMs: request.deadlineAtMs,
      result: { ...generated, output, usage },
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

  /**
   * Reads billing evidence after the publish deadline or worker loss. The provider store owns
   * receipt retention. This read never returns assistant text or starts work.
   */
  async queryConversationUsage(
    operationId: string,
    signal: AbortSignal,
  ): Promise<FakeConversationUsageStatus> {
    signal.throwIfAborted();
    const job = await this.jobs.findByOperationId(operationId);
    signal.throwIfAborted();
    if (job === null || job.operationId !== operationId) return { state: 'unavailable' };
    return Date.now() < job.readyAtMs
      ? { state: 'pending' }
      : { state: 'completed', usage: job.result.usage };
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
