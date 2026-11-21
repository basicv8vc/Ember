import { z } from 'zod';
import { ModelGatewayFailure } from '../errors.js';
import { MODEL_LIMITS } from '../limits.js';
import { estimateCostMicroUsd, type ModelRateRow, type OpenRouterRoutingPolicy } from '../rates.js';
import type {
  ConversationTurnInput,
  ConversationTurnOutput,
  ModelCallResult,
  ModelGateway,
  ModelUsage,
  NotesActionItemsInput,
  NotesActionItemsOutput,
  PythonAgentStepInput,
  PythonAgentStepOutput,
} from '../types.js';
import { statusToFailureCode, type FetchLike, type FetchResponseLike } from './openai.js';
import {
  PYTHON_AGENT_TOOLS,
  assertAuthorizedBeforeFetch,
  buildConversationTurnMessages,
  buildNotesExtractionMessages,
  buildPythonAgentMessages,
  completionMessageSchema,
  getConversationTools,
  parseConversationTurnChoice,
  parseNotesActionItemsChoice,
  parsePythonAgentStepChoice,
  rateRequestModifiers,
  type ProviderChatMessage,
} from './shared.js';

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export const OPENROUTER_CHAT_COMPLETIONS_PATH = '/api/v1/chat/completions';
export const OPENROUTER_CHAT_COMPLETIONS_URL = `${OPENROUTER_ORIGIN}${OPENROUTER_CHAT_COMPLETIONS_PATH}`;

const completionSchema = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        message: completionMessageSchema,
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  // Missing or malformed usage means unknown spend. The responder conservatively books the hold.
  usage: z.unknown().optional(),
});

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  cost: z.number().finite().nonnegative().optional(),
});

/** Convert the provider's USD decimal to micro-USD, rounding upward to preserve the hard cap. */
function usdToMicroUsd(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.toString());

  if (match === null) {
    return null;
  }

  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  const coefficient = BigInt(`${match[1]}${fraction}`);
  const scale = fraction.length - exponent - 6;
  let microUsd: bigint;

  if (scale <= 0) {
    microUsd = coefficient * 10n ** BigInt(-scale);
  } else {
    const divisor = 10n ** BigInt(scale);
    microUsd = (coefficient + divisor - 1n) / divisor;
  }

  return microUsd <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(microUsd) : null;
}

function toUsage(usage: unknown, rate: ModelRateRow): Omit<ModelUsage, 'rateVersion'> | null {
  const parsed = usageSchema.safeParse(usage);

  if (!parsed.success) {
    return null;
  }

  const providerCost =
    parsed.data.cost === undefined
      ? estimateCostMicroUsd(rate, parsed.data.prompt_tokens, parsed.data.completion_tokens)
      : usdToMicroUsd(parsed.data.cost);

  if (providerCost === null) {
    return null;
  }

  return {
    inputTokens: parsed.data.prompt_tokens,
    outputTokens: parsed.data.completion_tokens,
    costMicroUsd: providerCost,
  };
}

export interface OpenRouterModelGatewayOptions {
  /** OpenRouter key; held only in this adapter's closure. */
  readonly apiKey: string;
  /** Exact OpenRouter catalog ID, for example `nvidia/nemotron-3.5-lightning`. */
  readonly modelId: string;
  readonly rate: ModelRateRow;
  readonly routing: OpenRouterRoutingPolicy;
  /** Re-evaluated immediately before each outbound request. */
  readonly isAuthorized: () => boolean;
  /** Test-only transport substitution. The destination remains the pinned OpenRouter URL. */
  readonly fetchImpl?: FetchLike;
}

const defaultFetch: FetchLike = (url, init) =>
  (globalThis.fetch as unknown as FetchLike)(url, init);

/**
 * One exact model ID, one reviewed provider policy, no model fallbacks, closed reviewed operations.
 */
export class OpenRouterModelGateway implements ModelGateway {
  readonly providerId = 'openrouter' as const;
  readonly simulated = false;
  readonly operations = [
    'conversation.turn',
    'task.notes_action_items',
    'task.python_agent',
  ] as const;
  readonly modelLabel: string;

  readonly #apiKey: string;
  readonly #modelId: string;
  readonly #rate: ModelRateRow;
  readonly #routing: OpenRouterRoutingPolicy;
  readonly #isAuthorized: () => boolean;
  readonly #fetch: FetchLike;

  constructor(options: OpenRouterModelGatewayOptions) {
    this.#apiKey = options.apiKey;
    this.#modelId = options.modelId;
    this.#rate = options.rate;
    this.#routing = Object.freeze({
      ...options.routing,
      only: Object.freeze([...options.routing.only]),
    });
    this.#isAuthorized = options.isAuthorized;
    this.#fetch = options.fetchImpl ?? defaultFetch;
    this.modelLabel = options.modelId;
  }

  async generateConversationTurn(
    input: ConversationTurnInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<ConversationTurnOutput>> {
    const allowDelegation = input.allowDelegationTools !== false;
    const allowSavePersonalMemory = input.enablePersonalMemorySaveTool === true;
    const allowCreateProactiveSchedule = input.enableProactiveScheduleTool === true;
    const tools = getConversationTools({
      allowDelegation,
      allowSavePersonalMemory,
      allowCreateProactiveSchedule,
    });
    const body = this.#serializePayload({
      messages: buildConversationTurnMessages(input),
      maxCompletionTokens: Math.min(input.maxOutputTokens, MODEL_LIMITS.maxOutputTokens),
      ...(tools.length > 0 ? { tools } : {}),
    });

    return await this.#sendChatCompletion(body, signal, (choice) =>
      parseConversationTurnChoice(choice, {
        allowDelegation,
        allowSavePersonalMemory,
        allowCreateProactiveSchedule,
      }),
    );
  }

  async extractNotesActionItems(
    input: NotesActionItemsInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<NotesActionItemsOutput>> {
    const body = this.#serializePayload({
      messages: buildNotesExtractionMessages(input),
      maxCompletionTokens: MODEL_LIMITS.notesMaxOutputTokens,
    });

    return await this.#sendChatCompletion(body, signal, parseNotesActionItemsChoice);
  }

  async stepPythonAgent(
    input: PythonAgentStepInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<PythonAgentStepOutput>> {
    const maxTokens = Math.min(
      input.maxOutputTokens ?? MODEL_LIMITS.pythonAgentMaxOutputTokens,
      MODEL_LIMITS.pythonAgentMaxOutputTokens,
    );
    const body = this.#serializePayload({
      messages: buildPythonAgentMessages(input),
      maxCompletionTokens: maxTokens,
      tools: input.remainingPythonCalls > 0 ? PYTHON_AGENT_TOOLS : undefined,
    });

    return await this.#sendChatCompletion(body, signal, (choice) =>
      parsePythonAgentStepChoice(choice, input.remainingPythonCalls),
    );
  }

  #serializePayload(params: {
    readonly messages: readonly ProviderChatMessage[];
    readonly maxCompletionTokens: number;
    readonly tools?: readonly unknown[];
  }): string {
    return JSON.stringify({
      model: this.#modelId,
      messages: params.messages,
      max_completion_tokens: params.maxCompletionTokens,
      n: 1,
      stream: false,
      store: false,
      ...(params.tools !== undefined ? { tools: params.tools, tool_choice: 'auto' } : {}),
      ...rateRequestModifiers(this.#rate, 'openrouter'),
      provider: {
        only: [...this.#routing.only],
        allow_fallbacks: this.#routing.allowFallbacks,
        data_collection: this.#routing.dataCollection,
        zdr: this.#routing.zdr,
        require_parameters: this.#routing.requireParameters,
        max_price: {
          prompt: this.#rate.inputMicroUsdPerMillion / 1_000_000,
          completion: this.#rate.outputMicroUsdPerMillion / 1_000_000,
        },
      },
    });
  }

  async #sendChatCompletion<T>(
    body: string,
    signal: AbortSignal,
    parseChoice: (choice: z.infer<typeof completionSchema>['choices'][number]) => T,
  ): Promise<ModelCallResult<T>> {
    // No await occurs between the live authorization check and the provider request.
    assertAuthorizedBeforeFetch(this.#isAuthorized);

    let response: FetchResponseLike;

    try {
      response = await this.#fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        redirect: 'manual',
        credentials: 'omit',
        signal,
      });
    } catch (error) {
      if (error instanceof ModelGatewayFailure) {
        throw error;
      }

      if (signal.aborted) {
        throw new ModelGatewayFailure('model_timeout');
      }

      throw new ModelGatewayFailure(
        'model_unavailable',
        isNetworkFetchFailure(error) ? { kind: 'network_error' } : { kind: 'transport_exception' },
      );
    }

    if (!response.ok) {
      const code = statusToFailureCode(response.status);
      throw new ModelGatewayFailure(
        code,
        code === 'model_unavailable' ? { kind: 'http_5xx', status: response.status } : null,
      );
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const parsed = completionSchema.safeParse(payload);
    const matchesModel =
      parsed.success &&
      (parsed.data.model === this.#modelId ||
        (this.#rate.canonicalModelId !== undefined &&
          parsed.data.model === this.#rate.canonicalModelId));

    if (!parsed.success || !matchesModel) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const output = parseChoice(parsed.data.choices[0]!);
    const priced = toUsage(parsed.data.usage, this.#rate);
    const usage: ModelUsage | null =
      priced === null
        ? null
        : Object.freeze({
            ...priced,
            rateVersion: this.#rate.rateVersion,
          });

    return Object.freeze({
      output,
      modelLabel: this.#modelId,
      simulated: false as const,
      usage,
    });
  }
}

/** Fetch network failures are TypeErrors in Workers and web-compatible Fetch implementations. */
function isNetworkFetchFailure(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }

  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'NetworkError'
  );
}
