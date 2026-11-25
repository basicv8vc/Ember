import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  DeepSeekModelGateway,
  EXA_SEARCH_URL,
  ExaWebSearchClient,
  MODEL_RATE_ROWS,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  OpenRouterModelGateway,
  WEB_SEARCH_LIMITS,
  WEB_SEARCH_TOOL_NAME,
  createModelGateway,
  findRateRow,
  formatWebSearchToolOutput,
  getConversationTools,
  preflightConversationTurn,
  resolveModelExecution,
  type FetchLike,
  type FetchResponseLike,
  type WebSearchPort,
} from '@ember/model-gateway';

function jsonResponse(status: number, body: unknown): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

describe('ExaWebSearchClient & web_search tool', () => {
  it('posts bounded search request to pinned Exa URL and formats untrusted results', async () => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
      [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
      return Promise.resolve(
        jsonResponse(200, {
          results: [
            {
              title: 'Example News',
              url: 'https://example.com/news',
              publishedDate: '2026-11-25',
              highlights: ['Breaking update from today.'],
            },
            {
              title: 'Bad Scheme',
              url: 'javascript:alert(1)',
              highlights: ['Should be dropped'],
            },
          ],
        }),
      );
    };

    const client = new ExaWebSearchClient({ apiKey: 'exa-test-key', fetchImpl });
    const response = await client.search(
      { query: 'latest AI news', numResults: 99 },
      new AbortController().signal,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(EXA_SEARCH_URL);
    expect(calls[0]!.headers['x-api-key']).toBe('exa-test-key');
    expect(calls[0]!.body['numResults']).toBe(WEB_SEARCH_LIMITS.maxResults);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.url).toBe('https://example.com/news');

    const formatted = formatWebSearchToolOutput(response);
    expect(formatted).toContain('untrusted external content');
    expect(formatted).toContain('Example News');
    expect(formatted).toContain('https://example.com/news');
    expect(formatted.length).toBeLessThanOrEqual(WEB_SEARCH_LIMITS.maxFormattedChars);
  });

  it('runs bounded web_search tool loop in OpenRouterModelGateway and sums usage', async () => {
    const rate = findRateRow(MODEL_RATE_ROWS, 'openrouter', 'deepseek/deepseek-v4.1-flash-1017');
    expect(rate).not.toBeNull();

    const payloads: Record<string, unknown>[] = [];
    let callIndex = 0;
    const fetchImpl: FetchLike = (url, init) => {
      expect(url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
      payloads.push(JSON.parse(init.body) as Record<string, unknown>);
      callIndex += 1;
      if (callIndex === 1) {
        return Promise.resolve(
          jsonResponse(200, {
            model: 'deepseek/deepseek-v4.1-flash-1017',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_ws_1',
                      type: 'function',
                      function: {
                        name: WEB_SEARCH_TOOL_NAME,
                        arguments: JSON.stringify({ query: 'Tokyo weather today', num_results: 3 }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
          }),
        );
      }

      return Promise.resolve(
        jsonResponse(200, {
          model: 'deepseek/deepseek-v4.1-flash-1017',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Tokyo is sunny and 18°C today ([Weather](https://weather.example.com)).',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 300, completion_tokens: 40, cost: 0.0002 },
        }),
      );
    };

    const searchCalls: string[] = [];
    const webSearch: WebSearchPort = {
      search: (req) => {
        searchCalls.push(req.query);
        return Promise.resolve({
          query: req.query,
          results: [
            {
              title: 'Tokyo Weather',
              url: 'https://weather.example.com',
              snippets: ['Sunny, 18C in Tokyo today.'],
            },
          ],
        });
      },
    };

    const gateway = new OpenRouterModelGateway({
      apiKey: 'or-test-key',
      modelId: 'deepseek/deepseek-v4.1-flash-1017',
      rate: rate!,
      routing: {
        only: ['deepinfra/fp8'],
        allowFallbacks: false,
        dataCollection: 'deny',
        zdr: true,
        requireParameters: true,
      },
      isAuthorized: () => true,
      fetchImpl,
      webSearch,
    });

    const result = await gateway.generateConversationTurn(
      {
        conversationId: '00000000-0000-4000-8000-000000000001',
        turnId: '00000000-0000-4000-8000-000000000002',
        context: [{ role: 'user', text: 'What is the weather in Tokyo today?' }],
        enableWebSearchTool: true,
        maxOutputTokens: 256,
      },
      new AbortController().signal,
    );

    expect(searchCalls).toEqual(['Tokyo weather today']);
    expect(payloads).toHaveLength(2);
    expect(result.output.kind).toBe('reply');
    if (result.output.kind === 'reply') {
      expect(result.output.text).toContain('Tokyo is sunny');
    }
    expect(result.usage).not.toBeNull();
    expect(result.usage!.inputTokens).toBe(400);
    expect(result.usage!.outputTokens).toBe(60);
    expect(result.usage!.costMicroUsd).toBe(300);
  });

  it('caps search rounds and gracefully surfaces Exa errors to the model', async () => {
    const rate = findRateRow(MODEL_RATE_ROWS, 'openrouter', 'deepseek/deepseek-v4.1-flash-1017');
    expect(rate).not.toBeNull();

    const toolsPerCall: unknown[][] = [];
    let step = 0;
    const fetchImpl: FetchLike = (_url, init) => {
      const parsed = JSON.parse(init.body) as { tools?: unknown[] };
      toolsPerCall.push(parsed.tools ?? []);
      step += 1;
      if (step <= WEB_SEARCH_LIMITS.maxRoundsPerTurn) {
        return Promise.resolve(
          jsonResponse(200, {
            model: 'deepseek/deepseek-v4.1-flash-1017',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: `call_${step}`,
                      type: 'function',
                      function: {
                        name: WEB_SEARCH_TOOL_NAME,
                        arguments: JSON.stringify({ query: `query ${step}` }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.00005 },
          }),
        );
      }

      return Promise.resolve(
        jsonResponse(200, {
          model: 'deepseek/deepseek-v4.1-flash-1017',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Web search is currently unavailable, please try again.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 80, completion_tokens: 15, cost: 0.00005 },
        }),
      );
    };

    const failingSearch: WebSearchPort = {
      search: () => Promise.reject(new Error('Exa web search returned HTTP 429')),
    };

    const gateway = new OpenRouterModelGateway({
      apiKey: 'or-test-key',
      modelId: 'deepseek/deepseek-v4.1-flash-1017',
      rate: rate!,
      routing: {
        only: ['deepinfra/fp8'],
        allowFallbacks: false,
        dataCollection: 'deny',
        zdr: true,
        requireParameters: true,
      },
      isAuthorized: () => true,
      fetchImpl,
      webSearch: failingSearch,
    });

    const result = await gateway.generateConversationTurn(
      {
        conversationId: '00000000-0000-4000-8000-000000000001',
        turnId: '00000000-0000-4000-8000-000000000003',
        context: [{ role: 'user', text: 'Latest BTC price?' }],
        enableWebSearchTool: true,
        maxOutputTokens: 256,
      },
      new AbortController().signal,
    );

    expect(toolsPerCall).toHaveLength(WEB_SEARCH_LIMITS.maxRoundsPerTurn + 1);
    // Final round must NOT advertise web_search so the model cannot loop indefinitely.
    const finalToolNames = (
      toolsPerCall[WEB_SEARCH_LIMITS.maxRoundsPerTurn] as { function: { name: string } }[]
    ).map((t) => t.function.name);
    expect(finalToolNames).not.toContain(WEB_SEARCH_TOOL_NAME);
    expect(result.output.kind).toBe('reply');
  });

  it('keeps web_search disabled by default in toolsets and preflight', () => {
    const defaultTools = getConversationTools();
    expect(defaultTools.some((t) => t.function.name === WEB_SEARCH_TOOL_NAME)).toBe(false);

    const enabledTools = getConversationTools({ allowWebSearch: true });
    expect(enabledTools.some((t) => t.function.name === WEB_SEARCH_TOOL_NAME)).toBe(true);

    const basePreflight = preflightConversationTurn({
      messages: [{ role: 'user', text: 'hello' }],
      maxOutputTokens: 128,
    });
    const searchPreflight = preflightConversationTurn({
      messages: [{ role: 'user', text: 'hello' }],
      enableWebSearchTool: true,
      maxOutputTokens: 128,
    });
    expect(searchPreflight.inputTokens).toBeGreaterThan(basePreflight.inputTokens);
  });

  it('resolves direct deepseek-chat and runs bounded web_search tool loop in DeepSeekModelGateway', async () => {
    const resolution = resolveModelExecution(
      {
        mode: 'real',
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        apiKey: 'sk-deepseek-test-key-1234567890',
        executionPurpose: 'staging_alpha',
        maxAttempts: 1,
      },
      undefined,
      new Date('2026-11-25T08:00:00Z'),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok || resolution.mode !== 'real') {
      throw new Error('Expected real deepseek resolution');
    }

    let step = 0;
    const fetchImpl: FetchLike = (url) => {
      expect(url).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL);
      step += 1;
      if (step === 1) {
        return Promise.resolve(
          jsonResponse(200, {
            model: 'deepseek-chat',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_ds_ws_1',
                      type: 'function',
                      function: {
                        name: WEB_SEARCH_TOOL_NAME,
                        arguments: JSON.stringify({ query: 'Shanghai weather today' }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, {
          model: 'deepseek-chat',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Today in Shanghai is clear and 16C.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 250, completion_tokens: 30 },
        }),
      );
    };

    const webSearch: WebSearchPort = {
      search: (req) =>
        Promise.resolve({
          query: req.query,
          results: [
            {
              title: 'Shanghai Weather',
              url: 'https://weather.example.com/shanghai',
              publishedDate: '2026-11-25',
              snippets: ['Clear, 16C.'],
            },
          ],
        }),
    };

    const gateway = createModelGateway(resolution, { fetchImpl, webSearch });
    expect(gateway).toBeInstanceOf(DeepSeekModelGateway);
    const result = await gateway.generateConversationTurn(
      {
        conversationId: '00000000-0000-4000-8000-000000000001',
        turnId: '00000000-0000-4000-8000-000000000004',
        context: [{ role: 'user', text: 'What is the weather in Shanghai today?' }],
        enableWebSearchTool: true,
        maxOutputTokens: 256,
      },
      new AbortController().signal,
    );

    expect(step).toBe(2);
    expect(result.simulated).toBe(false);
    expect(result.modelLabel).toBe('deepseek-chat');
    expect(result.output).toEqual({
      kind: 'reply',
      text: 'Today in Shanghai is clear and 16C.',
      finishReason: 'stop',
    });
    expect(result.usage?.inputTokens).toBe(350);
    expect(result.usage?.outputTokens).toBe(50);
    expect(result.usage?.rateVersion).toBe('deepseek-chat-official-2026-11-25');
  });
});
