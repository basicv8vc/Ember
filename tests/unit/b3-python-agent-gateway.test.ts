import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PYTHON_DELEGATION_ACK_TEXT,
  DELEGATE_NOTES_TOOL_NAME,
  DELEGATE_PYTHON_TOOL_NAME,
  DELEGATION_TOOLS,
  FakeModelGateway,
  MODEL_LIMITS,
  ModelInputRefused,
  OpenAiModelGateway,
  OpenRouterModelGateway,
  PYTHON_AGENT_TOOLS,
  RUN_PYTHON_TOOL_NAME,
  isModelGatewayFailure,
  preflightPythonAgentStep,
  type ConversationTurnInput,
  type FetchLike,
  type FetchRequestInitLike,
  type FetchResponseLike,
  type ModelRateRow,
  type OpenRouterRoutingPolicy,
  type PythonAgentStepInput,
} from '@ember/model-gateway';

const VALID_KEY = 'sk-test-fixture-credential-for-unit-tests-only-12345';
const OPENROUTER_MODEL = 'nvidia/nemotron-3.5-lightning';
const UPLOAD_ID_1 = '11111111-1111-4111-8111-111111111111';
const UPLOAD_ID_2 = '22222222-2222-4222-8222-222222222222';

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

function turnInput(
  text = 'Analyze the uploaded sales CSV and output regional totals',
): ConversationTurnInput {
  return {
    conversationId: '33333333-3333-4333-8333-333333333333',
    turnId: '44444444-4444-4444-8444-444444444444',
    context: [
      {
        role: 'user',
        text,
        attachments: [
          {
            uploadId: UPLOAD_ID_1,
            filename: 'sales.csv',
            mediaType: 'text/csv',
            sizeBytes: 128,
          },
        ],
      },
    ],
    maxOutputTokens: 256,
  };
}

function stepInput(overrides: Partial<PythonAgentStepInput> = {}): PythonAgentStepInput {
  return {
    taskId: '55555555-5555-4555-8555-555555555555',
    prompt: 'Compute sum of gross_amount_usd_v2 per txn_region_code and save ./outputs/summary.csv',
    title: 'Sales CSV Analysis',
    instructions: 'Handle header names carefully',
    inputFiles: [
      {
        artifactId: UPLOAD_ID_1,
        filename: 'sales.csv',
        mediaType: 'text/csv',
        sizeBytes: 128,
        previewText: 'txn_region_code,gross_amount_usd_v2\nNA,100\nEU,200\n',
      },
    ],
    messages: [],
    maxOutputTokens: MODEL_LIMITS.pythonAgentMaxOutputTokens,
    remainingPythonCalls: 6,
    ...overrides,
  };
}

describe('B3-B1 controlled Python delegation and agent step gateway', () => {
  it('ships both closed delegation tools on conversation turns', () => {
    const names = DELEGATION_TOOLS.map((tool) => tool.function.name);
    expect(names).toEqual([DELEGATE_NOTES_TOOL_NAME, DELEGATE_PYTHON_TOOL_NAME]);
  });

  it('parses delegate_python_agent tool calls with deduplicated attachmentIds and default ack text', async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          model: OPENROUTER_MODEL,
          choices: [
            {
              message: {
                content: '   ',
                tool_calls: [
                  {
                    id: 'call_py_delegate_1',
                    type: 'function',
                    function: {
                      name: DELEGATE_PYTHON_TOOL_NAME,
                      arguments: JSON.stringify({
                        title: 'Regional Sales Rollup',
                        prompt: 'Aggregate sales.csv by region and emit summary.csv',
                        instructions: 'Verify column names first',
                        attachment_ids: [UPLOAD_ID_1, UPLOAD_ID_1, UPLOAD_ID_2],
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 45 },
        }),
      ),
    );

    const result = await openRouter(stub.fetchImpl).generateConversationTurn(
      turnInput(),
      new AbortController().signal,
    );

    expect(result.output).toEqual({
      kind: 'delegate',
      toolName: DELEGATE_PYTHON_TOOL_NAME,
      text: DEFAULT_PYTHON_DELEGATION_ACK_TEXT,
      finishReason: 'stop',
      delegation: {
        toolName: DELEGATE_PYTHON_TOOL_NAME,
        arguments: {
          title: 'Regional Sales Rollup',
          prompt: 'Aggregate sales.csv by region and emit summary.csv',
          instructions: 'Verify column names first',
          attachmentIds: [UPLOAD_ID_1, UPLOAD_ID_2],
        },
      },
    });
  });

  it('rejects malformed delegate_python_agent attachment UUIDs or empty prompt', async () => {
    const badUuidStub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_bad',
                    type: 'function',
                    function: {
                      name: DELEGATE_PYTHON_TOOL_NAME,
                      arguments: JSON.stringify({
                        prompt: 'Run analysis',
                        attachment_ids: ['not-a-uuid'],
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      ),
    );

    await expect(
      openAi(badUuidStub.fetchImpl).generateConversationTurn(
        turnInput(),
        new AbortController().signal,
      ),
    ).rejects.toSatisfy(
      (err: unknown) => isModelGatewayFailure(err) && err.code === 'model_invalid_output',
    );
  });

  it('stepPythonAgent includes PYTHON_AGENT_TOOLS when remainingPythonCalls > 0 and omits tools when 0', async () => {
    const withToolsStub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          model: OPENROUTER_MODEL,
          choices: [
            {
              message: {
                content: 'Inspecting CSV headers first.',
                tool_calls: [
                  {
                    id: 'call_step_1',
                    type: 'function',
                    function: {
                      name: RUN_PYTHON_TOOL_NAME,
                      arguments: JSON.stringify({
                        code: "import pandas as pd\nprint(pd.read_csv('inputs/sales.csv').columns.tolist())",
                        purpose: 'Inspect CSV columns',
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 35 },
        }),
      ),
    );

    const step1 = await openRouter(withToolsStub.fetchImpl).stepPythonAgent(
      stepInput({ remainingPythonCalls: 2 }),
      new AbortController().signal,
    );

    expect(step1.output).toMatchObject({
      kind: 'tool_call',
      toolCallId: 'call_step_1',
      purpose: 'Inspect CSV columns',
      assistantText: 'Inspecting CSV headers first.',
    });
    const req1 = JSON.parse(withToolsStub.calls[0]!.init.body) as Record<string, unknown>;
    expect(req1['tools']).toEqual(PYTHON_AGENT_TOOLS);
    expect(req1['tool_choice']).toBe('auto');

    const finalOnlyStub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [
            {
              message: {
                content: 'Regional totals computed.\n\nNA: 100, EU: 200.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 40 },
        }),
      ),
    );

    const step2 = await openAi(finalOnlyStub.fetchImpl).stepPythonAgent(
      stepInput({
        remainingPythonCalls: 0,
        messages: [
          {
            role: 'assistant',
            text: '',
            toolCalls: [
              {
                id: 'call_step_1',
                name: RUN_PYTHON_TOOL_NAME,
                argumentsJson: JSON.stringify({ code: 'print(1)' }),
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call_step_1',
            text: '{"exit_code":0,"stdout":"1"}',
          },
        ],
      }),
      new AbortController().signal,
    );

    expect(step2.output).toEqual({
      kind: 'final',
      summaryText: 'Regional totals computed.',
      detailText: 'Regional totals computed.\n\nNA: 100, EU: 200.',
      truncated: false,
      finishReason: 'stop',
    });
    const req2 = JSON.parse(finalOnlyStub.calls[0]!.init.body) as Record<string, unknown>;
    expect(req2['tools']).toBeUndefined();
    expect(req2['tool_choice']).toBeUndefined();
  });

  it('rejects a tool call when remainingPythonCalls <= 0', async () => {
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
                    id: 'call_illegal',
                    type: 'function',
                    function: {
                      name: RUN_PYTHON_TOOL_NAME,
                      arguments: JSON.stringify({ code: 'print(1)' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 15 },
        }),
      ),
    );

    await expect(
      openRouter(stub.fetchImpl).stepPythonAgent(
        stepInput({ remainingPythonCalls: 0 }),
        new AbortController().signal,
      ),
    ).rejects.toSatisfy(
      (err: unknown) => isModelGatewayFailure(err) && err.code === 'model_invalid_output',
    );
  });

  it('preflightPythonAgentStep enforces pythonAgentMaxContextChars and FakeModelGateway simulates tool -> final', async () => {
    const huge = 'x'.repeat(MODEL_LIMITS.pythonAgentMaxContextChars + 500);
    expect(() => preflightPythonAgentStep(stepInput({ prompt: huge }))).toThrowError(
      ModelInputRefused,
    );

    const fake = new FakeModelGateway();
    const first = await fake.stepPythonAgent(stepInput(), new AbortController().signal);
    expect(first.output.kind).toBe('tool_call');
    expect(first.simulated).toBe(true);

    const second = await fake.stepPythonAgent(
      stepInput({
        messages: [
          {
            role: 'assistant',
            text: '',
            toolCalls: [
              {
                id: 'fake_call_1',
                name: 'run_python_script',
                argumentsJson: JSON.stringify({ code: 'print("ok")' }),
              },
            ],
          },
          { role: 'tool', toolCallId: 'fake_call_1', text: '{"exit_code":0}' },
        ],
      }),
      new AbortController().signal,
    );
    expect(second.output.kind).toBe('final');
    expect(second.simulated).toBe(true);
  });
});
