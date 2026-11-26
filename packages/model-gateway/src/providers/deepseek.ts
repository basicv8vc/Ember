import { z } from 'zod';
import { ModelGatewayFailure, ModelInputRefused } from '../errors.js';
import { MODEL_LIMITS } from '../limits.js';
import { estimateCostMicroUsd, type ModelRateRow } from '../rates.js';
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
  truncateToolOutputToTokenBudget,
  type ProviderChatMessage,
} from './shared.js';
import {
  WEB_SEARCH_LIMITS,
  formatWebSearchToolOutput,
  validateWebSearchQueryPrivacy,
  type WebSearchPort,
} from '../web-search.js';

export const DEEPSEEK_ORIGIN = 'https://api.deepseek.com';
export const DEEPSEEK_CHAT_COMPLETIONS_PATH = '/chat/completions';
export const DEEPSEEK_CHAT_COMPLETIONS_URL = `${DEEPSEEK_ORIGIN}${DEEPSEEK_CHAT_COMPLETIONS_PATH}`;

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
  usage: z.unknown().optional(),
});

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
});

function toUsage(usage: unknown, rate: ModelRateRow): Omit<ModelUsage, 'rateVersion'> | null {
  const parsed = usageSchema.safeParse(usage);
  if (!parsed.success) {
    return null;
  }
  return {
    inputTokens: parsed.data.prompt_tokens,
    outputTokens: parsed.data.completion_tokens,
    costMicroUsd: estimateCostMicroUsd(
      rate,
      parsed.data.prompt_tokens,
      parsed.data.completion_tokens,
    ),
  };
}

export interface DeepSeekModelGatewayOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly rate: ModelRateRow;
  readonly isAuthorized: () => boolean;
  readonly fetchImpl?: FetchLike;
  readonly webSearch?: WebSearchPort;
}

const defaultFetch: FetchLike = (url, init) =>
  (globalThis.fetch as unknown as FetchLike)(url, init);

function isNetworkFetchFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    error.name === 'TypeError' ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('socket') ||
    message.includes('econn') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('tls')
  );
}

/**
 * Direct DeepSeek Chat Completions gateway (`https://api.deepseek.com/chat/completions`),
 * supporting Ember's closed conversation tools, bounded Exa `web_search`, notes extraction,
 * and Python sandbox agent steps.
 */
export class DeepSeekModelGateway implements ModelGateway {
  readonly providerId = 'deepseek' as const;
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
  readonly #isAuthorized: () => boolean;
  readonly #fetch: FetchLike;
  readonly #webSearch: WebSearchPort | undefined;

  constructor(options: DeepSeekModelGatewayOptions) {
    this.#apiKey = options.apiKey;
    this.#modelId = options.modelId;
    this.#rate = options.rate;
    this.#isAuthorized = options.isAuthorized;
    this.#fetch = options.fetchImpl ?? defaultFetch;
    this.#webSearch = options.webSearch;
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
    const maxTokens = Math.min(input.maxOutputTokens, MODEL_LIMITS.maxOutputTokens);
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
        maxTokens,
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
          maxTokens,
        );
        const minFollowUpInputTokens =
          estimateProviderMessagesInputTokens(messages, finalTools) + 64;
        const minFollowUpCost = estimateCostMicroUsd(this.#rate, minFollowUpInputTokens, maxTokens);
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
      const roundWorstCaseCost = estimateCostMicroUsd(this.#rate, roundInputTokens, maxTokens);

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
        maxTokens,
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
            typeof step.choice.message.content === 'string' ? step.choice.message.content : '',
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
          maxTokens,
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

        const toolResults = await Promise.all(
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
              const searchResponse = await this.#webSearch!.search(args, signal);
              return {
                id: call.id,
                content: truncateToolOutputToTokenBudget(
                  formatWebSearchToolOutput(searchResponse),
                  perCallTokenBudget,
                ),
              };
            } catch (error) {
              if (signal.aborted) {
                throw new ModelGatewayFailure('model_timeout');
              }
              const reason = error instanceof Error ? error.message.slice(0, 120) : 'search_failed';
              return {
                id: call.id,
                content: truncateToolOutputToTokenBudget(
                  `Web search unavailable: ${reason}`,
                  perCallTokenBudget,
                ),
              };
            }
          }),
        );

        for (const result of toolResults) {
          messages.push({
            role: 'tool',
            tool_call_id: result.id,
            content: result.content,
          });
        }

        continue;
      }

      const parsedOutput = parseConversationTurnChoice(step.choice, {
        allowDelegation,
        allowSavePersonalMemory,
        allowCreateProactiveSchedule,
      });
      return Object.freeze({
        output: parsedOutput,
        usage: sawMissingUsage ? null : accumulatedUsage,
        modelLabel: this.modelLabel,
        simulated: false as const,
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
      maxTokens: MODEL_LIMITS.notesMaxOutputTokens,
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
      maxTokens,
      tools: input.remainingPythonCalls > 0 ? PYTHON_AGENT_TOOLS : undefined,
    });

    return await this.#sendChatCompletion(body, signal, (choice) =>
      parsePythonAgentStepChoice(choice, input.remainingPythonCalls),
    );
  }

  #serializePayload(params: {
    readonly messages: readonly ProviderChatMessage[];
    readonly maxTokens: number;
    readonly tools?: readonly unknown[];
  }): string {
    return JSON.stringify({
      model: this.#modelId,
      messages: params.messages,
      max_tokens: params.maxTokens,
      stream: false,
      ...(params.tools !== undefined ? { tools: params.tools, tool_choice: 'auto' } : {}),
    });
  }

  async #requestRawCompletion(
    body: string,
    signal: AbortSignal,
  ): Promise<{
    readonly choice: z.infer<typeof completionSchema>['choices'][number];
    readonly usage: ModelUsage | null;
  }> {
    assertAuthorizedBeforeFetch(this.#isAuthorized);

    let response: FetchResponseLike;

    try {
      response = await this.#fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
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
      let errorSnippet: string | null = null;
      try {
        const errBody = (await response.json()) as {
          error?: { message?: unknown };
        };
        if (typeof errBody?.error?.message === 'string') {
          errorSnippet = errBody.error.message.slice(0, 200);
        }
      } catch {
        // Ignore non-JSON error body.
      }
      console.log(
        JSON.stringify({
          event: 'v2.deepseek.http_error',
          status: response.status,
          code,
          errorMessage: errorSnippet,
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

    if (!parsed.success) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const choice = parsed.data.choices[0];
    if (choice === undefined) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const rawUsage = toUsage(parsed.data.usage, this.#rate);
    const usage: ModelUsage | null =
      rawUsage === null
        ? null
        : Object.freeze({
            ...rawUsage,
            rateVersion: this.#rate.rateVersion,
          });

    return { choice, usage };
  }

  async #sendChatCompletion<T>(
    body: string,
    signal: AbortSignal,
    parseChoice: (choice: z.infer<typeof completionSchema>['choices'][number]) => T,
  ): Promise<ModelCallResult<T>> {
    const step = await this.#requestRawCompletion(body, signal);

    return Object.freeze({
      output: parseChoice(step.choice),
      usage: step.usage,
      modelLabel: this.modelLabel,
      simulated: false as const,
    });
  }
}
