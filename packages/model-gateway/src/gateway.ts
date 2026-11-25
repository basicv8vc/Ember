import { isModelExecutionAuthorized, type ModelExecutionResolution } from './config.js';
import { FakeModelGateway, type FakeModelGatewayOptions } from './fake.js';
import { DeepSeekModelGateway } from './providers/deepseek.js';
import { OpenAiModelGateway, type FetchLike } from './providers/openai.js';
import {
  OpenRouterModelGateway,
  type OpenRouterCloudflareAiGateway,
} from './providers/openrouter.js';
import type { ModelGateway } from './types.js';
import type { WebSearchPort } from './web-search.js';

export interface CreateModelGatewayOptions {
  /** Test-only transport substitution. The URL is still the pinned constant. */
  readonly fetchImpl?: FetchLike;
  readonly fake?: FakeModelGatewayOptions;
  /** Optional bounded web search adapter (e.g. ExaWebSearchClient) for V2 conversation turns. */
  readonly webSearch?: WebSearchPort;
  /** Optional Cloudflare AI Gateway target for OpenRouter calls from Cloudflare Workers. */
  readonly openRouterCloudflareAiGateway?: OpenRouterCloudflareAiGateway;
}

/**
 * Build the one gateway for the resolved mode.
 *
 * `disabled` and a refused `real` resolution both throw instead of returning something: a caller
 * must decide explicitly, so there is no path where "no inference" turns into a canned reply.
 */
export function createModelGateway(
  resolution: ModelExecutionResolution,
  options: CreateModelGatewayOptions = {},
): ModelGateway {
  if (!resolution.ok) {
    throw new Error(`model execution refused: ${resolution.reason}`);
  }

  if (resolution.mode === 'disabled') {
    throw new Error('model execution is disabled: no gateway exists in this mode');
  }

  if (resolution.mode === 'fake') {
    return new FakeModelGateway(options.fake ?? {});
  }

  const { modelId } = resolution.settings;

  if (modelId === null) {
    throw new Error('real mode requires a pinned model id');
  }

  const isAuthorized = (): boolean => isModelExecutionAuthorized(resolution);

  return resolution.credential.use((apiKey) => {
    if (resolution.settings.providerId === 'openai') {
      return new OpenAiModelGateway({
        apiKey,
        modelId,
        rate: resolution.rate,
        isAuthorized,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
    }

    if (resolution.settings.providerId === 'deepseek') {
      return new DeepSeekModelGateway({
        apiKey,
        modelId,
        rate: resolution.rate,
        isAuthorized,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
      });
    }

    if (resolution.openRouterRouting === null) {
      throw new Error('OpenRouter requires a reviewed provider routing policy');
    }

    return new OpenRouterModelGateway({
      apiKey,
      modelId,
      rate: resolution.rate,
      routing: resolution.openRouterRouting,
      isAuthorized,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
      ...(options.openRouterCloudflareAiGateway === undefined
        ? {}
        : { cloudflareAiGateway: options.openRouterCloudflareAiGateway }),
    });
  });
}
