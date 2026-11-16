import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DELEGATION_ACK_TEXT,
  DELEGATE_NOTES_TOOL_NAME,
  DELEGATION_TOOLS,
  FakeModelGateway,
  MODEL_LIMITS,
  ModelInputRefused,
  OpenAiModelGateway,
  OpenRouterModelGateway,
  isModelGatewayFailure,
  preflightNotesActionItems,
  type ConversationTurnInput,
  type FetchLike,
  type FetchRequestInitLike,
  type FetchResponseLike,
  type ModelRateRow,
  type OpenRouterRoutingPolicy,
} from '@ember/model-gateway';

const VALID_KEY = 'sk-test-fixture-credential-for-unit-tests-only-12345';
const OPENROUTER_MODEL = 'nvidia/nemotron-3.5-lightning';

const OPENAI_RATE: ModelRateRow = {
  providerId: 'openai',
  modelId: 'gpt-5.6-luna',
  inputMicroUsdPerMillion: 250_000,
  outputMicroUsdPerMillion: 2_000_000,
  rateVersion: 'openai-test-rate',
  provenance: 'invoice_verified',
  source: 'unit test',
};

const OPENROUTER_RATE: ModelRateRow = {
  providerId: 'openrouter',
  modelId: OPENROUTER_MODEL,
  inputMicroUsdPerMillion: 60_000,
  outputMicroUsdPerMillion: 160_000,
  rateVersion: 'openrouter-test-rate',
  provenance: 'official_price_verified',
  source: 'unit test',
  reasoningEffort: 'none',
  promptCacheMode: 'explicit',
};

const OPENROUTER_ROUTING: OpenRouterRoutingPolicy = Object.freeze({
  only: ['deepinfra'],
  allowFallbacks: false,
  dataCollection: 'deny',
  zdr: true,
  requireParameters: true,
});

function turnInput(
  text = '帮我把这些会议笔记整理成 Action Items:\n- Alice: 完成 API 文档',
): ConversationTurnInput {
  return {
    conversationId: '11111111-1111-4111-8111-111111111111',
    turnId: '22222222-2222-4222-8222-222222222222',
    context: [{ role: 'user', text }],
    maxOutputTokens: 256,
  };
}

function response(status: number, body: unknown): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  };
}

function stubFetch(
  handler: (url: string, init: FetchRequestInitLike) => Promise<FetchResponseLike>,
) {
  const calls: Array<{ url: string; init: FetchRequestInitLike }> = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

function openAi(fetchImpl: FetchLike): OpenAiModelGateway {
  return new OpenAiModelGateway({
    apiKey: VALID_KEY,
    modelId: 'gpt-5.6-luna',
    rate: OPENAI_RATE,
    isAuthorized: () => true,
    fetchImpl,
  });
}

function openRouter(fetchImpl: FetchLike): OpenRouterModelGateway {
  return new OpenRouterModelGateway({
    apiKey: VALID_KEY,
    modelId: OPENROUTER_MODEL,
    rate: OPENROUTER_RATE,
    routing: OPENROUTER_ROUTING,
    isAuthorized: () => true,
    fetchImpl,
  });
}

describe('B3-A1 controlled delegation & notes extraction gateway', () => {
  it('ships the closed delegate_notes_action_items tool schema and auto tool_choice on real adapters', async () => {
    const openAiStub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [{ message: { content: 'normal reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      ),
    );
    const openRouterStub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          model: OPENROUTER_MODEL,
          choices: [{ message: { content: 'normal reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      ),
    );

    const openAiResult = await openAi(openAiStub.fetchImpl).generateConversationTurn(
      turnInput('你好，今天天气怎样？'),
      new AbortController().signal,
    );
    const openRouterResult = await openRouter(openRouterStub.fetchImpl).generateConversationTurn(
      turnInput('你好，今天天气怎样？'),
      new AbortController().signal,
    );

    expect(openAiResult.output).toEqual({
      kind: 'reply',
      text: 'normal reply',
      finishReason: 'stop',
    });
    expect(openRouterResult.output).toEqual({
      kind: 'reply',
      text: 'normal reply',
      finishReason: 'stop',
    });

    for (const call of [openAiStub.calls[0]!, openRouterStub.calls[0]!]) {
      const body = JSON.parse(call.init.body) as Record<string, unknown>;
      expect(body['tool_choice']).toBe('auto');
      expect(body['tools']).toEqual(DELEGATION_TOOLS);
    }
  });

  it('parses a valid delegate_notes_action_items tool call and applies default ack text when content is empty', async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          model: OPENROUTER_MODEL,
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    type: 'function',
                    function: {
                      name: DELEGATE_NOTES_TOOL_NAME,
                      arguments: JSON.stringify({
                        title: '  Weekly Sync Action Items  ',
                        notes: '  Alice to publish docs by Friday.\nBob to run load tests.  ',
                        instructions: '  Keep owners and deadlines  ',
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 80, completion_tokens: 45 },
        }),
      ),
    );

    const result = await openRouter(stub.fetchImpl).generateConversationTurn(
      turnInput(),
      new AbortController().signal,
    );

    expect(result.output).toEqual({
      kind: 'delegate',
      toolName: DELEGATE_NOTES_TOOL_NAME,
      text: DEFAULT_DELEGATION_ACK_TEXT,
      finishReason: 'stop',
      delegation: {
        toolName: DELEGATE_NOTES_TOOL_NAME,
        arguments: {
          title: 'Weekly Sync Action Items',
          notes: 'Alice to publish docs by Friday.\nBob to run load tests.',
          instructions: 'Keep owners and deadlines',
        },
      },
    });
  });

  it('preserves concise assistant ack text when the model pairs content with the allowlisted tool call', async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [
            {
              message: {
                content: '好的，我已为你后台整理这份会议笔记的 Action Items。',
                tool_calls: [
                  {
                    type: 'function',
                    function: {
                      name: DELEGATE_NOTES_TOOL_NAME,
                      arguments: JSON.stringify({ notes: '- Finish Q4 plan' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 20 },
        }),
      ),
    );

    const result = await openAi(stub.fetchImpl).generateConversationTurn(
      turnInput(),
      new AbortController().signal,
    );

    expect(result.output).toEqual({
      kind: 'delegate',
      toolName: DELEGATE_NOTES_TOOL_NAME,
      text: '好的，我已为你后台整理这份会议笔记的 Action Items。',
      finishReason: 'stop',
      delegation: {
        toolName: DELEGATE_NOTES_TOOL_NAME,
        arguments: { notes: '- Finish Q4 plan' },
      },
    });
  });

  it.each([
    [
      'unknown tool name',
      [
        {
          type: 'function',
          function: { name: 'execute_shell', arguments: '{"cmd":"whoami"}' },
        },
      ],
    ],
    [
      'non-function tool type',
      [
        {
          type: 'code_interpreter',
          function: { name: DELEGATE_NOTES_TOOL_NAME, arguments: '{"notes":"x"}' },
        },
      ],
    ],
    [
      'multiple tool calls in one choice',
      [
        {
          type: 'function',
          function: { name: DELEGATE_NOTES_TOOL_NAME, arguments: '{"notes":"one"}' },
        },
        {
          type: 'function',
          function: { name: DELEGATE_NOTES_TOOL_NAME, arguments: '{"notes":"two"}' },
        },
      ],
    ],
    [
      'malformed JSON arguments',
      [
        {
          type: 'function',
          function: { name: DELEGATE_NOTES_TOOL_NAME, arguments: '{not-valid-json' },
        },
      ],
    ],
    [
      'arguments missing required notes field or adding extra fields',
      [
        {
          type: 'function',
          function: { name: DELEGATE_NOTES_TOOL_NAME, arguments: '{"notes":"ok","tenant_id":"x"}' },
        },
      ],
    ],
  ])('rejects disallowed tool output: %s', async (_label, toolCalls) => {
    const stub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [
            { message: { content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      ),
    );

    const caught = await openAi(stub.fetchImpl)
      .generateConversationTurn(turnInput(), new AbortController().signal)
      .catch((error: unknown) => error);

    expect(isModelGatewayFailure(caught)).toBe(true);
    if (isModelGatewayFailure(caught)) {
      expect(caught.code).toBe('model_invalid_output');
    }
  });

  it('extractNotesActionItems sends no tools, parses fenced JSON, and formats readable action items', async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          model: OPENROUTER_MODEL,
          choices: [
            {
              message: {
                content: [
                  '```json',
                  JSON.stringify({
                    summary: '2 action items identified from the weekly engineering sync.',
                    action_items: [
                      {
                        action: 'Publish OpenAPI draft',
                        owner: 'Alice',
                        due: 'Friday',
                        details: 'Share in #platform',
                      },
                      {
                        action: 'Run load test',
                        owner: 'Bob',
                        due: null,
                      },
                    ],
                  }),
                  '```',
                ].join('\n'),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 60 },
        }),
      ),
    );

    const result = await openRouter(stub.fetchImpl).extractNotesActionItems(
      {
        taskId: '33333333-3333-4333-8333-333333333333',
        title: 'Engineering Sync',
        notes: 'Alice will publish OpenAPI draft by Friday. Bob runs load test.',
        instructions: 'Highlight owners',
      },
      new AbortController().signal,
    );

    const body = JSON.parse(stub.calls[0]!.init.body) as Record<string, unknown>;
    expect(body['tools']).toBeUndefined();
    expect(body['tool_choice']).toBeUndefined();
    expect(body['max_completion_tokens']).toBe(MODEL_LIMITS.notesMaxOutputTokens);
    expect(result.output).toEqual({
      summaryText: '2 action items identified from the weekly engineering sync.',
      detailText: [
        '2 action items identified from the weekly engineering sync.',
        '',
        '- [ ] Publish OpenAPI draft (Owner: Alice | Due: Friday)',
        '  - Share in #platform',
        '- [ ] Run load test (Owner: Bob)',
      ].join('\n'),
      truncated: false,
      finishReason: 'stop',
    });
  });

  it('clamps oversized extraction text, marks truncated, and refuses tool calls during extraction', async () => {
    const longLine = 'A'.repeat(MODEL_LIMITS.resultDetailMaxChars + 250);
    const clampedStub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [{ message: { content: longLine }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 900 },
        }),
      ),
    );

    const clamped = await openAi(clampedStub.fetchImpl).extractNotesActionItems(
      { taskId: '33333333-3333-4333-8333-333333333333', notes: 'Long notes' },
      new AbortController().signal,
    );
    expect(clamped.output.truncated).toBe(true);
    expect(clamped.output.detailText.length).toBeLessThanOrEqual(MODEL_LIMITS.resultDetailMaxChars);
    expect(clamped.output.summaryText.length).toBeLessThanOrEqual(
      MODEL_LIMITS.resultSummaryMaxChars,
    );

    const toolDuringExtract = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [
            {
              message: {
                content: 'ignored',
                tool_calls: [
                  {
                    type: 'function',
                    function: { name: DELEGATE_NOTES_TOOL_NAME, arguments: '{"notes":"loop"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      ),
    );

    const caught = await openAi(toolDuringExtract.fetchImpl)
      .extractNotesActionItems(
        { taskId: '33333333-3333-4333-8333-333333333333', notes: 'Notes' },
        new AbortController().signal,
      )
      .catch((error: unknown) => error);
    expect(isModelGatewayFailure(caught)).toBe(true);
    if (isModelGatewayFailure(caught)) {
      expect(caught.code).toBe('model_invalid_output');
    }
  });

  it('enforces conservative token preflight bounds on notes extraction and exercises FakeModelGateway hooks', async () => {
    const okPreflight = preflightNotesActionItems({
      notes: 'Alice to finish onboarding checklist tomorrow.',
      instructions: 'Concise bullets',
      maxOutputTokens: MODEL_LIMITS.notesMaxOutputTokens,
    });
    expect(okPreflight.inputTokens).toBeGreaterThan(0);

    expect(() =>
      preflightNotesActionItems({
        notes: '中'.repeat(4_500),
        maxOutputTokens: MODEL_LIMITS.notesMaxOutputTokens,
      }),
    ).toThrow(ModelInputRefused);

    const fake = new FakeModelGateway();
    const extracted = await fake.extractNotesActionItems(
      {
        taskId: '33333333-3333-4333-8333-333333333333',
        notes: 'First item\nSecond item',
      },
      new AbortController().signal,
    );
    expect(extracted.simulated).toBe(true);
    expect(extracted.modelLabel).toContain('-fake-');
    expect(extracted.output.summaryText.length).toBeGreaterThan(0);
    expect(extracted.output.detailText).toContain('First item');
  });
});
