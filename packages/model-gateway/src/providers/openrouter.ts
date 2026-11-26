import { z } from 'zod';
import { ModelGatewayFailure, ModelInputRefused } from '../errors.js';
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
  WEB_SEARCH_TOOL_NAME,
  assertAuthorizedBeforeFetch,
  buildConversationTurnMessages,
  buildNotesExtractionMessages,
  buildPythonAgentMessages,
  completionMessageSchema,
  estimateProviderMessagesInputTokens,
  extractLatestUserMessageText,
  formatWebSearchPrivacyRefusal,
  getConversationTools,
  maxInputTokensForRemainingCost,
  parseConversationTurnChoice,
  parseNotesActionItemsChoice,
  parsePythonAgentStepChoice,
  parseWebSearchToolArguments,
  rateRequestModifiers,
  truncateToolOutputToTokenBudget,
  type ProviderChatMessage,
} from './shared.js';
import {
  WEB_SEARCH_LIMITS,
  formatWebSearchToolOutput,
  validateWebSearchQueryPrivacy,
  type WebSearchPort,
} from '../web-search.js';

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export const OPENROUTER_CHAT_COMPLETIONS_PATH = '/api/v1/chat/completions';
export const OPENROUTER_CHAT_COMPLETIONS_URL = `${OPENROUTER_ORIGIN}${OPENROUTER_CHAT_COMPLETIONS_PATH}`;
export const CLOUDFLARE_AI_GATEWAY_ORIGIN = 'https://gateway.ai.cloudflare.com';

const CF_ACCOUNT_ID_REGEX = /^[a-f0-9]{32}$/i;
const CF_GATEWAY_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface OpenRouterCloudflareAiGateway {
  readonly accountId: string;
  readonly gatewayId: string;
  /** Optional `cf-aig-authorization` bearer token for Authenticated Cloudflare AI Gateways. */
  readonly token?: string;
}

export function buildOpenRouterCloudflareAiGatewayUrl(
  gateway: OpenRouterCloudflareAiGateway,
): string {
  const accountId = gateway.accountId.trim();
  const gatewayId = gateway.gatewayId.trim();
  if (!CF_ACCOUNT_ID_REGEX.test(accountId) || !CF_GATEWAY_ID_REGEX.test(gatewayId)) {
    throw new Error('Invalid Cloudflare AI Gateway accountId or gatewayId for OpenRouter');
  }
  return `${CLOUDFLARE_AI_GATEWAY_ORIGIN}/v1/${accountId}/${gatewayId}/openrouter/chat/completions`;
}

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
  /** Optional bounded web search adapter (e.g. ExaWebSearchClient). */
  readonly webSearch?: WebSearchPort;
  /** Optional Cloudflare AI Gateway target for OpenRouter calls from Cloudflare Workers. */
  readonly cloudflareAiGateway?: OpenRouterCloudflareAiGateway;
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
  readonly #webSearch: WebSearchPort | undefined;
  readonly #chatCompletionsUrl: string;
  readonly #cfAiGatewayToken: string | undefined;

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
    this.#webSearch = options.webSearch;
    this.#chatCompletionsUrl =
      options.cloudflareAiGateway === undefined
        ? OPENROUTER_CHAT_COMPLETIONS_URL
        : buildOpenRouterCloudflareAiGatewayUrl(options.cloudflareAiGateway);
    const trimmedGatewayToken = options.cloudflareAiGateway?.token?.trim() ?? '';
    this.#cfAiGatewayToken = trimmedGatewayToken.length > 0 ? trimmedGatewayToken : undefined;
    this.modelLabel = options.modelId;
  }

  async generateConversationTurn(
    input: ConversationTurnInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<ConversationTurnOutput>> {
    const allowDelegation = input.allowDelegationTools !== false;
    const allowSavePersonalMemory = input.enablePersonalMemorySaveTool === true;
    const allowCreateProactiveSchedule = input.enableProactiveScheduleTool === true;
    const allowWebSearch = this.#webSearch !== undefined && input.enableWebSearchTool === true;
    const maxCompletionTokens = Math.min(input.maxOutputTokens, MODEL_LIMITS.maxOutputTokens);
    const messages = buildConversationTurnMessages(
      allowWebSearch ? input : { ...input, enableWebSearchTool: false },
    );

    if (!allowWebSearch) {
      const tools = getConversationTools({
        allowDelegation,
        allowSavePersonalMemory,
        allowCreateProactiveSchedule,
      });
      const body = this.#serializePayload({
        messages,
        maxCompletionTokens,
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

    const budgetCapMicroUsd = Math.min(
      input.maxCostMicroUsd ?? MODEL_LIMITS.maxReservedMicroUsdPerAttempt,
      MODEL_LIMITS.maxReservedMicroUsdPerAttempt,
    );
    const latestUserMessageText = extractLatestUserMessageText(input.context);
    const privacyContext = {
      ...(input.personalMemories !== undefined ? { personalMemories: input.personalMemories } : {}),
      latestUserMessageText,
    };

    let accumulatedUsage: ModelUsage | null = null;
    let sawMissingUsage = false;
    let spentMicroUsd = 0;
    let totalSearchCalls = 0;

    for (let round = 0; round <= WEB_SEARCH_LIMITS.maxRoundsPerTurn; round += 1) {
      const searchTools = getConversationTools({
        allowDelegation,
        allowSavePersonalMemory,
        allowCreateProactiveSchedule,
        allowWebSearch: true,
      });
      const finalTools = getConversationTools({
        allowDelegation,
        allowSavePersonalMemory,
        allowCreateProactiveSchedule,
        allowWebSearch: false,
      });

      const remainingSearchCalls = WEB_SEARCH_LIMITS.maxCallsPerTurn - totalSearchCalls;
      let canSearchThisRound =
        round < WEB_SEARCH_LIMITS.maxRoundsPerTurn && remainingSearchCalls > 0;
      if (canSearchThisRound) {
        const searchRoundInputTokens = estimateProviderMessagesInputTokens(messages, searchTools);
        const searchRoundWorstCaseCost = estimateCostMicroUsd(
          this.#rate,
          searchRoundInputTokens,
          maxCompletionTokens,
        );
        const minFollowUpInputTokens =
          estimateProviderMessagesInputTokens(messages, finalTools) + 64;
        const minFollowUpCost = estimateCostMicroUsd(
          this.#rate,
          minFollowUpInputTokens,
          maxCompletionTokens,
        );
        if (
          searchRoundInputTokens > MODEL_LIMITS.maxInputTokens ||
          minFollowUpInputTokens > MODEL_LIMITS.maxInputTokens ||
          spentMicroUsd + searchRoundWorstCaseCost + minFollowUpCost > budgetCapMicroUsd
        ) {
          canSearchThisRound = false;
        }
      }

      const tools = canSearchThisRound ? searchTools : finalTools;
      const roundInputTokens = estimateProviderMessagesInputTokens(messages, tools);
      const roundWorstCaseCost = estimateCostMicroUsd(
        this.#rate,
        roundInputTokens,
        maxCompletionTokens,
      );

      if (roundInputTokens > MODEL_LIMITS.maxInputTokens) {
        if (round === 0) {
          throw new ModelInputRefused('input_tokens_over_cap');
        }
        throw new ModelGatewayFailure('model_invalid_output');
      }
      if (spentMicroUsd + roundWorstCaseCost > budgetCapMicroUsd) {
        if (round === 0) {
          throw new ModelInputRefused('reservation_cap_exceeded');
        }
        console.log(
          JSON.stringify({
            event: 'v2.web_search.budget_exhausted',
            round,
            spentMicroUsd,
            roundWorstCaseCost,
            budgetCapMicroUsd,
          }),
        );
        throw new ModelGatewayFailure('model_invalid_output');
      }

      const body = this.#serializePayload({
        messages,
        maxCompletionTokens,
        ...(tools.length > 0 ? { tools } : {}),
      });

      const step = await this.#requestRawCompletion(body, signal);
      if (step.usage === null) {
        sawMissingUsage = true;
        spentMicroUsd += roundWorstCaseCost;
      } else {
        spentMicroUsd += step.usage.costMicroUsd;
        if (!sawMissingUsage) {
          accumulatedUsage =
            accumulatedUsage === null
              ? step.usage
              : Object.freeze({
                  inputTokens: accumulatedUsage.inputTokens + step.usage.inputTokens,
                  outputTokens: accumulatedUsage.outputTokens + step.usage.outputTokens,
                  costMicroUsd: accumulatedUsage.costMicroUsd + step.usage.costMicroUsd,
                  rateVersion: step.usage.rateVersion,
                });
        }
      }

      const toolCalls = step.choice.message.tool_calls;
      const isWebSearchBatch =
        canSearchThisRound &&
        toolCalls !== undefined &&
        toolCalls.length > 0 &&
        toolCalls.every(
          (call) => call.type === 'function' && call.function.name === WEB_SEARCH_TOOL_NAME,
        );

      if (isWebSearchBatch && toolCalls !== undefined) {
        const allowedCallsThisRound = Math.min(
          WEB_SEARCH_LIMITS.maxCallsPerRound,
          WEB_SEARCH_LIMITS.maxCallsPerTurn - totalSearchCalls,
        );
        const cappedCalls = toolCalls.slice(0, allowedCallsThisRound).map((call, idx) => ({
          id: call.id ?? `web_search_${round}_${idx}`,
          name: call.function.name,
          arguments: call.function.arguments,
        }));
        messages.push({
          role: 'assistant',
          content:
            typeof step.choice.message.content === 'string' &&
            step.choice.message.content.trim().length > 0
              ? step.choice.message.content
              : null,
          tool_calls: cappedCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        });

        const nextRoundBaseTokens = estimateProviderMessagesInputTokens(messages, finalTools);
        const maxAllowedNextInputTokens = maxInputTokensForRemainingCost(
          this.#rate,
          budgetCapMicroUsd - spentMicroUsd,
          maxCompletionTokens,
        );
        const availableToolTokens = maxAllowedNextInputTokens - nextRoundBaseTokens;
        if (availableToolTokens < 32) {
          console.log(
            JSON.stringify({
              event: 'v2.web_search.budget_exhausted',
              stage: 'pre_exa',
              round,
              spentMicroUsd,
              budgetCapMicroUsd,
            }),
          );
          throw new ModelGatewayFailure('model_invalid_output');
        }

        console.log(
          JSON.stringify({
            event: 'v2.web_search.round',
            round,
            callCount: cappedCalls.length,
          }),
        );

        const perCallTokenBudget = Math.max(
          32,
          Math.floor((availableToolTokens - 16) / cappedCalls.length),
        );

        const toolOutputs = await Promise.all(
          cappedCalls.map(async (call) => {
            const args = parseWebSearchToolArguments(call.arguments);
            const privacy = validateWebSearchQueryPrivacy(args.query, privacyContext);
            if (!privacy.ok) {
              console.log(
                JSON.stringify({
                  event: 'v2.web_search.privacy_refused',
                  round,
                  reason: privacy.reason,
                }),
              );
              return {
                id: call.id,
                content: truncateToolOutputToTokenBudget(
                  formatWebSearchPrivacyRefusal(privacy.reason),
                  perCallTokenBudget,
                ),
              };
            }
            totalSearchCalls += 1;
            try {
              const result = await this.#webSearch!.search(args, signal);
              return {
                id: call.id,
                content: truncateToolOutputToTokenBudget(
                  formatWebSearchToolOutput(result),
                  perCallTokenBudget,
                ),
              };
            } catch (error) {
              if (signal.aborted) {
                throw new ModelGatewayFailure('model_timeout');
              }
              const message = error instanceof Error ? error.message : 'search_failed';
              return {
                id: call.id,
                content: truncateToolOutputToTokenBudget(
                  `Web search unavailable: ${message}`,
                  perCallTokenBudget,
                ),
              };
            }
          }),
        );

        for (const toolOutput of toolOutputs) {
          messages.push({
            role: 'tool',
            tool_call_id: toolOutput.id,
            content: toolOutput.content,
          });
        }
        continue;
      }

      let output: ConversationTurnOutput;
      try {
        output = parseConversationTurnChoice(step.choice, {
          allowDelegation,
          allowSavePersonalMemory,
          allowCreateProactiveSchedule,
        });
      } catch (error) {
        console.log(
          JSON.stringify({
            event: 'v2.openrouter.invalid_output',
            stage: 'parse_choice',
            round,
            finishReason: step.choice.finish_reason ?? null,
            hasContent:
              typeof step.choice.message.content === 'string' &&
              step.choice.message.content.trim().length > 0,
            toolNames: (step.choice.message.tool_calls ?? []).map((c) => c.function.name),
          }),
        );
        throw error;
      }
      return Object.freeze({
        output,
        modelLabel: this.#modelId,
        simulated: false as const,
        usage: sawMissingUsage ? null : accumulatedUsage,
      });
    }

    throw new ModelGatewayFailure('model_invalid_output');
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

  async #requestRawCompletion(
    body: string,
    signal: AbortSignal,
  ): Promise<{
    readonly choice: z.infer<typeof completionSchema>['choices'][number];
    readonly usage: ModelUsage | null;
  }> {
    // No await occurs between the live authorization check and the provider request.
    assertAuthorizedBeforeFetch(this.#isAuthorized);

    let response: FetchResponseLike;

    try {
      response = await this.#fetch(this.#chatCompletionsUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.#cfAiGatewayToken === undefined
            ? {}
            : { 'cf-aig-authorization': `Bearer ${this.#cfAiGatewayToken}` }),
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
      let errorSnippet: string | null = null;
      try {
        const errBody = (await response.json()) as {
          error?: { message?: unknown; code?: unknown };
        };
        if (typeof errBody?.error?.message === 'string') {
          errorSnippet = errBody.error.message.slice(0, 200);
        }
      } catch {
        // Ignore non-JSON error body.
      }
      console.log(
        JSON.stringify({
          event: 'v2.openrouter.http_error',
          status: response.status,
          code,
          errorMessage: errorSnippet,
          cfRay: response.headers?.get('cf-ray') ?? null,
          errorOrigin: response.headers?.get('x-openrouter-error-origin') ?? null,
          providerName: response.headers?.get('x-provider-name') ?? null,
          modelId: this.#modelId,
        }),
      );
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
      console.log(
        JSON.stringify({
          event: 'v2.openrouter.invalid_output',
          stage: 'response_schema',
          parsedOk: parsed.success,
          matchesModel,
          expectedModel: this.#modelId,
          returnedModel: parsed.success
            ? parsed.data.model
            : typeof (payload as { model?: unknown } | null)?.model === 'string'
              ? (payload as { model: string }).model
              : null,
          zodIssues: parsed.success
            ? null
            : parsed.error.issues.slice(0, 3).map((i) => ({ path: i.path, code: i.code })),
        }),
      );
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const priced = toUsage(parsed.data.usage, this.#rate);
    const usage: ModelUsage | null =
      priced === null
        ? null
        : Object.freeze({
            ...priced,
            rateVersion: this.#rate.rateVersion,
          });

    return {
      choice: parsed.data.choices[0]!,
      usage,
    };
  }

  async #sendChatCompletion<T>(
    body: string,
    signal: AbortSignal,
    parseChoice: (choice: z.infer<typeof completionSchema>['choices'][number]) => T,
  ): Promise<ModelCallResult<T>> {
    const step = await this.#requestRawCompletion(body, signal);
    const output = parseChoice(step.choice);

    return Object.freeze({
      output,
      modelLabel: this.#modelId,
      simulated: false as const,
      usage: step.usage,
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
