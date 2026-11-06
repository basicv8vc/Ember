import { z } from 'zod';
import { CONVERSATION_SYSTEM_PROMPT } from '../context.js';
import { ModelGatewayFailure } from '../errors.js';
import { MODEL_LIMITS } from '../limits.js';
import { estimateCostMicroUsd, type ModelRateRow } from '../rates.js';
import type {
  ConversationTurnInput,
  ConversationTurnOutput,
  ModelCallResult,
  ModelGateway,
  ModelUsage,
} from '../types.js';

/**
 * The only origin this process may ever contact for inference.
 *
 * It is a module-level constant with no environment override, no base-URL parameter and no test
 * hook that changes it. Tests replace the `fetch` *function*, never the URL, so a stubbed run still
 * proves the real request target.
 */
export const OPENAI_ORIGIN = 'https://api.openai.com';
export const OPENAI_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
export const OPENAI_CHAT_COMPLETIONS_URL = `${OPENAI_ORIGIN}${OPENAI_CHAT_COMPLETIONS_PATH}`;

/** Minimal structural view of `fetch`, so this package needs no DOM lib. */
export interface FetchResponseLike {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export interface FetchRequestInitLike {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Redirect following is disabled: a redirect would leave the pinned origin. */
  readonly redirect: 'error';
  readonly credentials: 'omit';
  readonly signal: AbortSignal;
}

export type FetchLike = (url: string, init: FetchRequestInitLike) => Promise<FetchResponseLike>;

const defaultFetch: FetchLike = (url, init) =>
  (globalThis.fetch as unknown as FetchLike)(url, init);

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

export interface OpenAiGatewayOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly rate: ModelRateRow;
  /** Injected only by tests; CI must never resolve a provider hostname. */
  readonly fetchImpl?: FetchLike;
}

/**
 * One pinned model, one origin, one call, no retries, no streaming, no tools.
 *
 * The credential lives in this closure only: it is not a field, is never returned, and cannot be
 * reached through the `ModelGateway` interface a caller holds.
 */
export class OpenAiModelGateway implements ModelGateway {
  readonly providerId = 'openai' as const;
  readonly simulated = false;
  readonly operations = ['conversation.turn'] as const;
  readonly modelLabel: string;

  readonly #apiKey: string;
  readonly #modelId: string;
  readonly #rate: ModelRateRow;
  readonly #fetch: FetchLike;

  constructor(options: OpenAiGatewayOptions) {
    this.#apiKey = options.apiKey;
    this.#modelId = options.modelId;
    this.#rate = options.rate;
    this.#fetch = options.fetchImpl ?? defaultFetch;
    this.modelLabel = options.modelId;
  }

  async generateConversationTurn(
    input: ConversationTurnInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<ConversationTurnOutput>> {
    const body = JSON.stringify({
      model: this.#modelId,
      messages: [
        { role: 'system', content: CONVERSATION_SYSTEM_PROMPT },
        ...input.context.map((message) => ({ role: message.role, content: message.text })),
      ],
      max_completion_tokens: Math.min(input.maxOutputTokens, MODEL_LIMITS.maxOutputTokens),
      n: 1,
      stream: false,
      // Keeps the provider from storing the conversation when the account allows it.
      store: false,
    });

    let response: FetchResponseLike;

    try {
      response = await this.#fetch(OPENAI_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        redirect: 'error',
        credentials: 'omit',
        signal,
      });
    } catch (error) {
      if (error instanceof ModelGatewayFailure) {
        throw error;
      }

      // A request that was aborted may already have been billed: never report it as free.
      throw new ModelGatewayFailure(signal.aborted ? 'model_timeout' : 'model_unavailable');
    }

    if (!response.ok) {
      throw new ModelGatewayFailure(statusToFailureCode(response.status));
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const parsed = completionSchema.safeParse(payload);

    if (!parsed.success) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const choice = parsed.data.choices[0]!;
    const text = choice.message.content;

    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const inputTokens = parsed.data.usage?.prompt_tokens ?? 0;
    const outputTokens = parsed.data.usage?.completion_tokens ?? 0;

    const usage: ModelUsage = Object.freeze({
      inputTokens,
      outputTokens,
      costMicroUsd: estimateCostMicroUsd(this.#rate, inputTokens, outputTokens),
      rateVersion: this.#rate.rateVersion,
    });

    return Object.freeze({
      output: Object.freeze({
        text,
        finishReason: choice.finish_reason === 'length' ? ('length' as const) : ('stop' as const),
      }),
      modelLabel: this.#modelId,
      simulated: false as const,
      usage,
    });
  }
}

/**
 * Provider status → closed taxonomy. The body is never read on an error path, so provider text
 * cannot reach a log, an attempt row or a client.
 */
export function statusToFailureCode(
  status: number,
):
  | 'model_auth_failed'
  | 'model_rate_limited'
  | 'model_unavailable'
  | 'model_timeout'
  | 'model_invalid_output' {
  if (status === 401 || status === 403) {
    return 'model_auth_failed';
  }

  if (status === 429) {
    return 'model_rate_limited';
  }

  if (status === 408) {
    return 'model_timeout';
  }

  if (status >= 500) {
    return 'model_unavailable';
  }

  return 'model_invalid_output';
}
