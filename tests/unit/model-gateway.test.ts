import { describe, expect, it } from 'vitest';
import {
  APPROVED_REAL_MODELS,
  CONVERSATION_SYSTEM_PROMPT,
  DEFAULT_MODEL_APPROVAL_REGISTRY,
  FAKE_MODEL_LABEL,
  FAKE_REPLY_PREFIX,
  FakeModelGateway,
  MODEL_ID_PLACEHOLDER,
  MODEL_LIMITS,
  MODEL_RATE_ROWS,
  ModelCredential,
  ModelGatewayFailure,
  ModelInputRefused,
  OPENAI_CHAT_COMPLETIONS_URL,
  OPENAI_ORIGIN,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  OPENROUTER_ORIGIN,
  OpenAiModelGateway,
  OpenRouterModelGateway,
  buildBoundedContext,
  createModelGateway,
  estimateCostMicroUsd,
  estimateTokensConservative,
  evaluateApproval,
  isModelAuthorizationRefused,
  isModelExecutionAuthorized,
  isModelGatewayFailure,
  isPastShutdown,
  isRetryableModelFailure,
  preflightConversationTurn,
  resolveModelExecution,
  statusToFailureCode,
  type FetchLike,
  type FetchRequestInitLike,
  type ModelRateRow,
  type OpenRouterRoutingPolicy,
} from '@ember/model-gateway';

const VALID_KEY = 'sk-test-abcdefghijklmnopqrstuvwxyz012345';

/**
 * A well-formed approval for the fixture model, deliberately dated far from the test's own clock so
 * an "expired approval" case has to pass its own `now` instead of depending on the day CI runs.
 */
const TEST_APPROVAL = Object.freeze({
  approvalId: 'TEST-A1',
  approvedBy: 'test fixture',
  approvedAt: '2026-01-01',
  expiresAt: '2099-12-31',
});

const VERIFIED_RATE: ModelRateRow = Object.freeze({
  providerId: 'openai' as const,
  modelId: 'gpt-5.6-luna',
  inputMicroUsdPerMillion: 200_000,
  outputMicroUsdPerMillion: 1_200_000,
  rateVersion: 'test-official-price-rate-v1',
  provenance: 'official_price_verified' as const,
  source: 'official OpenAI model page, test fixture',
});

const APPROVED_REGISTRY = Object.freeze({
  models: Object.freeze([
    {
      providerId: 'openai' as const,
      modelId: 'gpt-5.6-luna',
      approval: TEST_APPROVAL,
    },
  ]),
  rates: Object.freeze([VERIFIED_RATE]),
});

const OPENROUTER_RATE = MODEL_RATE_ROWS.find(
  (row) => row.providerId === 'openrouter' && row.modelId === 'openai/gpt-5.6-luna',
)!;

const OPENROUTER_ROUTING: OpenRouterRoutingPolicy = Object.freeze({
  only: Object.freeze(['openai']),
  allowFallbacks: false,
  dataCollection: 'deny',
  zdr: true,
  requireParameters: true,
});

function input(overrides: { readonly text?: string } = {}) {
  return {
    conversationId: '11111111-1111-4111-8111-111111111111',
    turnId: '22222222-2222-4222-8222-222222222222',
    context: [{ role: 'user' as const, text: overrides.text ?? 'hello' }],
    maxOutputTokens: 256,
  };
}

function response(
  status: number,
  body: unknown,
): { status: number; ok: boolean; json(): Promise<unknown> } {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  };
}

function stubFetch(
  handler: (
    init: FetchRequestInitLike,
  ) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>,
): { fetchImpl: FetchLike; calls: Array<{ url: string; init: FetchRequestInitLike }> } {
  const calls: Array<{ url: string; init: FetchRequestInitLike }> = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return handler(init);
  };

  return { fetchImpl, calls };
}

describe('model gateway limits and pricing', () => {
  it('freezes the operation limits that bound one call', () => {
    expect(Object.isFrozen(MODEL_LIMITS)).toBe(true);
    expect(MODEL_LIMITS.maxContextMessages).toBe(8);
    expect(MODEL_LIMITS.maxContextChars).toBe(12_000);
    expect(MODEL_LIMITS.maxOutputTokens).toBe(512);
    expect(MODEL_LIMITS.maxAttemptsPerTurn).toBe(2);
  });

  it('computes a micro-USD cost from a pinned rate row without floats', () => {
    // 3130 input + 512 output tokens at $0.20/$1.20 per million ≈ $0.001241.
    expect(estimateCostMicroUsd(VERIFIED_RATE, 3_130, 512)).toBe(1_241);
    expect(Number.isInteger(estimateCostMicroUsd(VERIFIED_RATE, 1, 1))).toBe(true);
  });

  it('keeps the GPT-5.6 Luna maximum reservation under the existing per-attempt ceiling', () => {
    const rate = MODEL_RATE_ROWS.find((row) => row.modelId === 'gpt-5.6-luna');

    expect(rate).toBeDefined();
    const worstCasePerAttempt = estimateCostMicroUsd(
      rate!,
      MODEL_LIMITS.maxInputTokens,
      MODEL_LIMITS.maxOutputTokens,
    );

    expect(worstCasePerAttempt).toBe(2_215);
    expect(worstCasePerAttempt).toBeLessThanOrEqual(MODEL_LIMITS.maxReservedMicroUsdPerAttempt);
    expect(worstCasePerAttempt * MODEL_LIMITS.maxAttemptsPerTurn).toBe(4_430);
    expect(worstCasePerAttempt * MODEL_LIMITS.maxAttemptsPerTurn).toBeLessThanOrEqual(
      MODEL_LIMITS.maxReservedMicroUsdPerAttempt,
    );
  });

  it('ships no approved real model, which is what keeps real mode closed by default', () => {
    expect(APPROVED_REAL_MODELS).toHaveLength(0);
    expect(DEFAULT_MODEL_APPROVAL_REGISTRY.models).toHaveLength(0);
    // A reviewed catalog price never authorizes egress: that still needs an approval record.
    expect(OPENROUTER_RATE.provenance).toBe('official_price_verified');
  });
});

describe('bounded conversation context', () => {
  const conversation = (sizes: readonly number[]) => {
    let sequence = 0;

    return sizes.map((size) => {
      sequence += 1;
      const kind: 'user' | 'ember' =
        sequence === sizes.length ? 'user' : sequence % 2 === 0 ? 'ember' : 'user';

      return { sequence, kind, text: 'x'.repeat(size) };
    });
  };

  it('keeps the message being answered and drops the oldest first', () => {
    const context = buildBoundedContext(conversation([4_000, 4_000, 4_000, 4_000]));

    // Three rows fit inside 12 000 characters; the oldest is dropped rather than truncated.
    expect(context.messages).toHaveLength(3);
    expect(context.droppedMessages).toBe(1);
    expect(context.characters).toBe(12_000);
    expect(context.messages.at(-1)?.role).toBe('user');
  });

  it('maps ember to the assistant role and user to user', () => {
    const context = buildBoundedContext([
      { sequence: 1, kind: 'user', text: 'first' },
      { sequence: 2, kind: 'ember', text: 'reply' },
      { sequence: 3, kind: 'user', text: 'second' },
    ]);

    expect(context.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('refuses a context whose last row is not the user message being answered', () => {
    expect(() =>
      buildBoundedContext([
        { sequence: 1, kind: 'user', text: 'first' },
        { sequence: 2, kind: 'ember', text: 'reply' },
      ]),
    ).toThrow(ModelInputRefused);
  });

  it('refuses an empty, out-of-order or oversized row set', () => {
    expect(() => buildBoundedContext([])).toThrow(ModelInputRefused);
    expect(() =>
      buildBoundedContext([
        { sequence: 2, kind: 'user', text: 'a' },
        { sequence: 1, kind: 'user', text: 'b' },
      ]),
    ).toThrow(ModelInputRefused);
    expect(() => buildBoundedContext(conversation(new Array<number>(9).fill(1)))).toThrow(
      ModelInputRefused,
    );
  });
});

describe('token preflight', () => {
  it('adds the fixed prompt and envelope overhead to the character bound', () => {
    const preflight = preflightConversationTurn({
      messages: [{ text: 'a'.repeat(1_000) }],
      maxOutputTokens: 512,
    });

    expect(preflight.inputChars).toBe(
      1_000 + MODEL_LIMITS.systemPromptChars + MODEL_LIMITS.serializationOverheadChars,
    );
    expect(preflight.inputTokens).toBeGreaterThan(250);
  });

  it('prices ASCII at roughly four characters per token', () => {
    expect(estimateTokensConservative('abcd')).toBe(1);
    expect(estimateTokensConservative('a'.repeat(1_000))).toBe(250);
    // Code points, not UTF-16 units: a surrogate pair is one character.
    expect(estimateTokensConservative('🚀')).toBe(MODEL_LIMITS.nonAsciiTokensPerChar);
  });

  it('prices non-ASCII text far above the old 4-chars-per-token guess', () => {
    const chinese = '中'.repeat(1_000);
    const preflight = preflightConversationTurn({
      messages: [{ text: chinese }],
      maxOutputTokens: 512,
    });

    // The character loop counts 1 000, but the reservation must be sized for ~2 000 tokens: a Han
    // character is a token or more, not a quarter of one.
    expect(estimateTokensConservative(chinese)).toBe(2_000);
    expect(preflight.inputTokens).toBeGreaterThanOrEqual(2_000);

    const fourCharsPerToken = Math.ceil(preflight.inputChars / 4);

    expect(fourCharsPerToken * 3).toBeLessThan(preflight.inputTokens);
  });

  it('refuses Chinese context that is legal in characters but not in tokens', () => {
    // 4 500 Han characters is well inside the 12 000-character bound and well outside the token cap.
    // The previous estimator priced it at ~1 600 tokens and let it through.
    expect(() =>
      preflightConversationTurn({ messages: [{ text: '中'.repeat(4_500) }], maxOutputTokens: 512 }),
    ).toThrow(ModelInputRefused);
  });

  it('fails closed instead of trusting an estimate over the cap', () => {
    expect(() =>
      preflightConversationTurn({ messages: [{ text: 'a'.repeat(12_001) }], maxOutputTokens: 512 }),
    ).toThrow(ModelInputRefused);
    expect(() =>
      preflightConversationTurn({ messages: [{ text: 'hi' }], maxOutputTokens: 0 }),
    ).toThrow(ModelInputRefused);
    expect(() =>
      preflightConversationTurn({ messages: [{ text: 'hi' }], maxOutputTokens: 513 }),
    ).toThrow(ModelInputRefused);
    expect(() => preflightConversationTurn({ messages: [], maxOutputTokens: 512 })).toThrow(
      ModelInputRefused,
    );
  });
});

describe('mode resolution and boot gates', () => {
  it('defaults to disabled and treats an absent value as disabled', () => {
    for (const mode of [undefined, '', 'disabled']) {
      const resolution = resolveModelExecution({
        mode,
        providerId: undefined,
        modelId: undefined,
        apiKey: undefined,
      });

      expect(resolution.ok).toBe(true);
      expect(resolution.settings.mode).toBe('disabled');
    }
  });

  it('refuses an unknown mode instead of guessing', () => {
    const resolution = resolveModelExecution({
      mode: 'live',
      providerId: undefined,
      modelId: undefined,
      apiKey: undefined,
    });

    expect(resolution.ok).toBe(false);
    expect(resolution).toMatchObject({ ok: false, reason: 'mode_invalid' });
  });

  it('allows fake mode with no model, rate or credential', () => {
    const resolution = resolveModelExecution({
      mode: 'fake',
      providerId: undefined,
      modelId: undefined,
      apiKey: undefined,
    });

    expect(resolution.ok).toBe(true);
    expect(resolution.settings.mode).toBe('fake');
    expect(resolution.settings.modelId).toBeNull();
  });

  it('refuses real mode against the shipped empty allowlist', () => {
    const resolution = resolveModelExecution({
      mode: 'real',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      apiKey: VALID_KEY,
    });

    expect(resolution.ok).toBe(false);
    expect(resolution).toMatchObject({ ok: false, reason: 'model_not_approved' });
  });

  it('refuses a placeholder model id and an unapproved provider', () => {
    const placeholder = resolveModelExecution({
      mode: 'real',
      providerId: 'openai',
      modelId: MODEL_ID_PLACEHOLDER,
      apiKey: VALID_KEY,
    });
    expect(placeholder.ok).toBe(false);
    expect(placeholder).toMatchObject({ ok: false, reason: 'model_not_approved' });

    const provider = resolveModelExecution({
      mode: 'real',
      providerId: 'anthropic',
      modelId: 'gpt-5.6-luna',
      apiKey: VALID_KEY,
    });
    expect(provider.ok).toBe(false);
    expect(provider).toMatchObject({ ok: false, reason: 'provider_not_approved' });
  });

  it('requires an officially reviewed or invoice-verified rate row for the exact pinned model', () => {
    const resolution = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: 'gpt-5.6-luna', apiKey: VALID_KEY },
      { models: APPROVED_REGISTRY.models, rates: MODEL_RATE_ROWS },
    );

    expect(resolution.ok).toBe(false);
    expect(resolution).toMatchObject({ ok: false, reason: 'rate_not_verified' });
  });

  it('requires a usable credential even when everything else is approved', () => {
    const missing = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: 'gpt-5.6-luna', apiKey: undefined },
      APPROVED_REGISTRY,
    );
    expect(missing.ok).toBe(false);
    expect(missing).toMatchObject({ ok: false, reason: 'credential_missing' });

    const placeholder = resolveModelExecution(
      {
        mode: 'real',
        providerId: 'openai',
        modelId: 'gpt-5.6-luna',
        apiKey: 'sk-REPLACE-WITH-REAL-KEY-000000',
      },
      APPROVED_REGISTRY,
    );
    expect(placeholder.ok).toBe(false);
    expect(placeholder).toMatchObject({ ok: false, reason: 'credential_placeholder' });

    const malformed = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: 'gpt-5.6-luna', apiKey: 'short' },
      APPROVED_REGISTRY,
    );
    expect(malformed.ok).toBe(false);
    expect(malformed).toMatchObject({ ok: false, reason: 'credential_malformed' });
  });

  it('opens real mode only when all four gates pass, and then carries the rate and credential', () => {
    const resolution = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: 'gpt-5.6-luna', apiKey: VALID_KEY },
      APPROVED_REGISTRY,
    );

    expect(resolution.ok).toBe(true);

    if (!resolution.ok || resolution.mode !== 'real') {
      throw new Error('expected an approved real resolution');
    }

    expect(resolution.rate.rateVersion).toBe('test-official-price-rate-v1');
    expect(resolution.settings.modelId).toBe('gpt-5.6-luna');
  });

  it('rejects budgets that exceed the database ceilings or invert the hierarchy', () => {
    const overGlobal = resolveModelExecution({
      mode: 'fake',
      providerId: undefined,
      modelId: undefined,
      apiKey: undefined,
      ceilings: { globalDailyMicroUsd: 5_000_001 },
    });
    expect(overGlobal.ok).toBe(false);
    expect(overGlobal).toMatchObject({ ok: false, reason: 'budget_config_invalid' });

    const principalAboveTenant = resolveModelExecution({
      mode: 'fake',
      providerId: undefined,
      modelId: undefined,
      apiKey: undefined,
      ceilings: { principalDailyMicroUsd: 2_000_000 },
    });
    expect(principalAboveTenant.ok).toBe(false);
  });

  it('never lets a gateway exist in disabled mode', () => {
    const resolution = resolveModelExecution({
      mode: 'disabled',
      providerId: undefined,
      modelId: undefined,
      apiKey: undefined,
    });

    expect(() => createModelGateway(resolution)).toThrow(/disabled/);
  });
});

describe('credential handling', () => {
  it('refuses to expose the secret through serialization or string conversion', () => {
    const parsed = ModelCredential.parse(VALID_KEY);
    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      throw new Error('expected a parsed credential');
    }

    expect(JSON.stringify({ credential: parsed.credential })).toBe('{"credential":"[redacted]"}');
    expect(String(parsed.credential)).toBe('[redacted]');
    expect(JSON.stringify(parsed.credential)).toBe('"[redacted]"');
  });

  it('hands the key to exactly one consumer', () => {
    const parsed = ModelCredential.parse(VALID_KEY);

    if (!parsed.ok) {
      throw new Error('expected a parsed credential');
    }

    expect(parsed.credential.use((key) => key.length)).toBe(VALID_KEY.length);
  });
});

describe('fake gateway', () => {
  it('is deterministic, explicitly simulated and carries a -fake- label', async () => {
    const gateway = new FakeModelGateway();
    const first = await gateway.generateConversationTurn(input(), new AbortController().signal);
    const second = await gateway.generateConversationTurn(input(), new AbortController().signal);

    expect(first.simulated).toBe(true);
    expect(first.modelLabel).toBe(FAKE_MODEL_LABEL);
    expect(first.modelLabel).toMatch(/-(fake|echo)-/);
    expect(first.output.text.startsWith(FAKE_REPLY_PREFIX)).toBe(true);
    expect(first.output.text).toBe(second.output.text);
    expect(first.usage!.costMicroUsd).toBe(0);
    // The fake path reports usage explicitly rather than relying on "unknown means free".
    expect(first.usage!.rateVersion).toBe('fake-zero-cost');
  });

  it('reports a cancellation through the closed taxonomy', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new FakeModelGateway().generateConversationTurn(input(), controller.signal),
    ).rejects.toSatisfy(
      (error: unknown) => isModelGatewayFailure(error) && error.code === 'client_cancelled',
    );
  });

  it('injects a deterministic provider failure without any network', async () => {
    await expect(
      new FakeModelGateway({ failure: 'model_unavailable' }).generateConversationTurn(
        input(),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ModelGatewayFailure);
  });
});

describe('openai adapter', () => {
  it('posts to the single hard-coded origin with redirects and credentials disabled', async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      ),
    );
    const gateway = new OpenAiModelGateway({
      apiKey: VALID_KEY,
      modelId: 'gpt-5.6-luna',
      rate: VERIFIED_RATE,
      isAuthorized: () => true,
      fetchImpl: stub.fetchImpl,
    });

    const result = await gateway.generateConversationTurn(input(), new AbortController().signal);
    const call = stub.calls[0]!;

    expect(stub.calls).toHaveLength(1);
    expect(call.url).toBe(OPENAI_CHAT_COMPLETIONS_URL);
    expect(call.url.startsWith(OPENAI_ORIGIN)).toBe(true);
    expect(call.init.redirect).toBe('error');
    expect(call.init.credentials).toBe('omit');
    expect(call.init.method).toBe('POST');
    expect(result.simulated).toBe(false);
    expect(result.modelLabel).toBe('gpt-5.6-luna');
    expect(result.modelLabel).not.toMatch(/-(fake|echo)-/);
  });

  it('re-checks live authorization before each outbound OpenAI request', async () => {
    const stub = stubFetch(() => Promise.resolve(response(200, {})));
    const gateway = new OpenAiModelGateway({
      apiKey: VALID_KEY,
      modelId: 'gpt-5.6-luna',
      rate: VERIFIED_RATE,
      isAuthorized: () => false,
      fetchImpl: stub.fetchImpl,
    });

    await expect(
      gateway.generateConversationTurn(input(), new AbortController().signal),
    ).rejects.toSatisfy(isModelAuthorizationRefused);
    expect(stub.calls).toHaveLength(0);
  });

  it('sends only the fields the contract needs, with the system prompt first', async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ),
    );

    await new OpenAiModelGateway({
      apiKey: VALID_KEY,
      modelId: 'gpt-5.6-luna',
      rate: VERIFIED_RATE,
      isAuthorized: () => true,
      fetchImpl: stub.fetchImpl,
    }).generateConversationTurn(input(), new AbortController().signal);

    const body = JSON.parse(stub.calls[0]!.init.body) as Record<string, unknown>;
    const messages = body['messages'] as Array<{ role: string; content: string }>;

    expect(Object.keys(body).sort()).toEqual([
      'max_completion_tokens',
      'messages',
      'model',
      'n',
      'store',
      'stream',
    ]);
    expect(messages[0]).toEqual({ role: 'system', content: CONVERSATION_SYSTEM_PROMPT });
    expect(body['store']).toBe(false);
    expect(body['stream']).toBe(false);
    expect(body['max_completion_tokens']).toBe(256);
    // No caller-controlled model, temperature, tools or stop sequence can appear.
    expect(body['temperature']).toBeUndefined();
    expect(body['tools']).toBeUndefined();
  });

  it.each([
    [401, 'model_auth_failed', false],
    [403, 'model_auth_failed', false],
    [429, 'model_rate_limited', true],
    [408, 'model_timeout', true],
    [500, 'model_unavailable', true],
    [503, 'model_unavailable', true],
    [400, 'model_invalid_output', false],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const stub = stubFetch(() => Promise.resolve(response(status, {})));

    const error = await new OpenAiModelGateway({
      apiKey: VALID_KEY,
      modelId: 'gpt-5.6-luna',
      rate: VERIFIED_RATE,
      isAuthorized: () => true,
      fetchImpl: stub.fetchImpl,
    })
      .generateConversationTurn(input(), new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(isModelGatewayFailure(error)).toBe(true);

    if (!isModelGatewayFailure(error)) {
      throw new Error('expected a gateway failure');
    }

    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(isRetryableModelFailure(error.code)).toBe(retryable);
    // The key and the provider body are never part of a failure.
    expect(error.message).not.toContain('sk-');
  });

  it('maps an unparseable or empty completion to model_invalid_output', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ message: { content: '' } }] }]) {
      const stub = stubFetch(() => Promise.resolve(response(200, body)));

      await expect(
        new OpenAiModelGateway({
          apiKey: VALID_KEY,
          modelId: 'gpt-5.6-luna',
          rate: VERIFIED_RATE,
          isAuthorized: () => true,
          fetchImpl: stub.fetchImpl,
        }).generateConversationTurn(input(), new AbortController().signal),
      ).rejects.toSatisfy(
        (error: unknown) => isModelGatewayFailure(error) && error.code === 'model_invalid_output',
      );
    }
  });

  it('maps a transport failure to unavailable and an abort to timeout', async () => {
    const reset = stubFetch(() => Promise.reject(new Error('socket hang up')));

    await expect(
      new OpenAiModelGateway({
        apiKey: VALID_KEY,
        modelId: 'gpt-5.6-luna',
        rate: VERIFIED_RATE,
        isAuthorized: () => true,
        fetchImpl: reset.fetchImpl,
      }).generateConversationTurn(input(), new AbortController().signal),
    ).rejects.toSatisfy(
      (error: unknown) => isModelGatewayFailure(error) && error.code === 'model_unavailable',
    );

    const aborted = stubFetch(() => Promise.reject(new Error('aborted')));
    const controller = new AbortController();
    controller.abort();

    await expect(
      new OpenAiModelGateway({
        apiKey: VALID_KEY,
        modelId: 'gpt-5.6-luna',
        rate: VERIFIED_RATE,
        isAuthorized: () => true,
        fetchImpl: aborted.fetchImpl,
      }).generateConversationTurn(input(), controller.signal),
    ).rejects.toSatisfy(
      (error: unknown) => isModelGatewayFailure(error) && error.code === 'model_timeout',
    );
  });

  it('books cost from the provider-reported usage', async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [{ message: { content: 'ok' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 3_130, completion_tokens: 512 },
        }),
      ),
    );

    const result = await new OpenAiModelGateway({
      apiKey: VALID_KEY,
      modelId: 'gpt-5.6-luna',
      rate: VERIFIED_RATE,
      isAuthorized: () => true,
      fetchImpl: stub.fetchImpl,
    }).generateConversationTurn(input(), new AbortController().signal);

    expect(result.usage).not.toBeNull();
    expect(result.usage!.inputTokens).toBe(3_130);
    expect(result.usage!.outputTokens).toBe(512);
    expect(result.usage!.costMicroUsd).toBe(1_241);
    expect(result.usage!.rateVersion).toBe('test-official-price-rate-v1');
    expect(result.output.finishReason).toBe('length');
  });

  it('never prices a 2xx as free when the provider omits usage', async () => {
    for (const body of [
      // No usage key at all.
      { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] },
      // Present but unusable: partial, negative or non-integer token counts.
      { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10 } },
      {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: -1, completion_tokens: 5 },
      },
      {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1.5, completion_tokens: 5 },
      },
      { choices: [{ message: { content: 'ok' } }], usage: {} },
    ]) {
      const stub = stubFetch(() => Promise.resolve(response(200, body)));

      const result = await new OpenAiModelGateway({
        apiKey: VALID_KEY,
        modelId: 'gpt-5.6-luna',
        rate: VERIFIED_RATE,
        isAuthorized: () => true,
        fetchImpl: stub.fetchImpl,
      }).generateConversationTurn(input(), new AbortController().signal);

      // The reply is valid and usable, but the charge is unknown — not zero.
      expect(result.output.text).toBe('ok');
      expect(result.usage).toBeNull();
      expect(result.simulated).toBe(false);
    }
  });
});

describe('openrouter adapter', () => {
  const modelId = 'openai/gpt-5.6-luna';

  function openRouterGateway(
    fetchImpl: FetchLike,
    isAuthorized: () => boolean = () => true,
  ): OpenRouterModelGateway {
    return new OpenRouterModelGateway({
      apiKey: VALID_KEY,
      modelId,
      rate: OPENROUTER_RATE,
      routing: OPENROUTER_ROUTING,
      isAuthorized,
      fetchImpl,
    });
  }

  it('pins the origin, exact model and provider route, with no model fallback', async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          model: modelId,
          choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.000012 },
        }),
      ),
    );

    const result = await openRouterGateway(stub.fetchImpl).generateConversationTurn(
      input(),
      new AbortController().signal,
    );
    const { url, init } = stub.calls[0]!;
    const body = JSON.parse(init.body) as Record<string, unknown>;

    expect(stub.calls).toHaveLength(1);
    expect(url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
    expect(url.startsWith(OPENROUTER_ORIGIN)).toBe(true);
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(init.headers.authorization).toBe(`Bearer ${VALID_KEY}`);
    expect(init.body).not.toContain(VALID_KEY);
    expect(body['model']).toBe(modelId);
    expect(body['models']).toBeUndefined();
    expect(body['provider']).toStrictEqual({
      only: ['openai'],
      allow_fallbacks: false,
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
      max_price: { prompt: 0.2, completion: 1.2 },
    });
    expect(body['prompt_cache_options']).toStrictEqual({ mode: 'explicit' });
    expect(body['stream']).toBe(false);
    expect(body['store']).toBe(false);
    expect(result).toMatchObject({
      modelLabel: modelId,
      simulated: false,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        costMicroUsd: 12,
        rateVersion: OPENROUTER_RATE.rateVersion,
      },
    });
  });

  it('rounds a provider USD cost upward to whole micro-USD', async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          model: modelId,
          choices: [{ message: { content: 'hi' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0000001 },
        }),
      ),
    );
    const result = await openRouterGateway(stub.fetchImpl).generateConversationTurn(
      input(),
      new AbortController().signal,
    );

    expect(result.usage?.costMicroUsd).toBe(1);
  });

  it('uses the pinned token prices when provider usage omits its cost field', async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        response(200, {
          model: modelId,
          choices: [{ message: { content: 'hi' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      ),
    );
    const result = await openRouterGateway(stub.fetchImpl).generateConversationTurn(
      input(),
      new AbortController().signal,
    );

    expect(result.usage?.costMicroUsd).toBe(5);
  });

  it('marks missing or malformed usage unknown instead of zero', async () => {
    const badUsageCases: unknown[] = [
      undefined,
      {},
      { prompt_tokens: '10', completion_tokens: 2 },
      { prompt_tokens: 10, completion_tokens: 2, cost: 'not-a-number' },
    ];

    for (const usage of badUsageCases) {
      const stub = stubFetch(() =>
        Promise.resolve(
          response(200, {
            model: modelId,
            choices: [{ message: { content: 'hi' } }],
            usage,
          }),
        ),
      );
      const result = await openRouterGateway(stub.fetchImpl).generateConversationTurn(
        input(),
        new AbortController().signal,
      );

      expect(result.usage).toBeNull();
    }
  });

  it.each([
    [401, 'model_auth_failed', false],
    [403, 'model_auth_failed', false],
    [429, 'model_rate_limited', true],
    [408, 'model_timeout', true],
    [500, 'model_unavailable', true],
    [503, 'model_unavailable', true],
    [400, 'model_invalid_output', false],
  ] as const)(
    'maps HTTP %i to %s without leaking response data',
    async (status, code, retryable) => {
      const stub = stubFetch(() => Promise.resolve(response(status, { error: VALID_KEY })));
      const error = await openRouterGateway(stub.fetchImpl)
        .generateConversationTurn(input(), new AbortController().signal)
        .catch((caught: unknown) => caught);

      expect(isModelGatewayFailure(error)).toBe(true);
      if (!isModelGatewayFailure(error)) {
        throw new Error('expected a gateway failure');
      }
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.message).not.toContain(VALID_KEY);
    },
  );

  it('rejects malformed or misrouted model responses', async () => {
    for (const body of [
      {},
      { model: 'openai/gpt-other', choices: [{ message: { content: 'hi' } }] },
      { model: modelId, choices: [] },
      { model: modelId, choices: [{ message: { content: '   ' } }] },
    ]) {
      const stub = stubFetch(() => Promise.resolve(response(200, body)));

      await expect(
        openRouterGateway(stub.fetchImpl).generateConversationTurn(
          input(),
          new AbortController().signal,
        ),
      ).rejects.toSatisfy(
        (error: unknown) => isModelGatewayFailure(error) && error.code === 'model_invalid_output',
      );
    }
  });

  it('maps transport failures and aborts into the closed error taxonomy', async () => {
    const reset = stubFetch(() => Promise.reject(new Error(`socket reset ${VALID_KEY}`)));
    await expect(
      openRouterGateway(reset.fetchImpl).generateConversationTurn(
        input(),
        new AbortController().signal,
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isModelGatewayFailure(error) && error.code === 'model_unavailable',
    );

    const abort = new AbortController();
    abort.abort();
    const cancelled = stubFetch(() => Promise.reject(new Error('aborted')));
    await expect(
      openRouterGateway(cancelled.fetchImpl).generateConversationTurn(input(), abort.signal),
    ).rejects.toSatisfy(
      (error: unknown) => isModelGatewayFailure(error) && error.code === 'model_timeout',
    );
  });

  it('refuses before fetch after expiry and repeats the check for each request', async () => {
    let authorized = true;
    const stub = stubFetch(() => {
      authorized = false;
      return Promise.resolve(response(429, {}));
    });
    const gateway = openRouterGateway(stub.fetchImpl, () => authorized);

    await expect(
      gateway.generateConversationTurn(input(), new AbortController().signal),
    ).rejects.toSatisfy(
      (error: unknown) => isModelGatewayFailure(error) && error.code === 'model_rate_limited',
    );
    await expect(
      gateway.generateConversationTurn(input(), new AbortController().signal),
    ).rejects.toSatisfy(isModelAuthorizationRefused);

    expect(stub.calls).toHaveLength(1);
  });
});

describe('status mapping', () => {
  it('has no unmapped status class', () => {
    for (const status of [400, 401, 403, 404, 408, 429, 500, 502, 599]) {
      expect(typeof statusToFailureCode(status)).toBe('string');
    }
  });
});

describe('approval record as a gate (L4-B)', () => {
  const RATE_WITH_SHUTDOWN: ModelRateRow = Object.freeze({
    ...VERIFIED_RATE,
    shutdownDate: '2027-01-14',
  });

  function registryWith(
    approval: { approvalId: string; approvedBy: string; approvedAt: string; expiresAt: string },
    rate: ModelRateRow = VERIFIED_RATE,
  ) {
    return {
      models: [{ providerId: 'openai' as const, modelId: rate.modelId, approval }],
      rates: [rate],
    };
  }

  it('reports the four validity states without consulting the system clock', () => {
    const approval = { ...TEST_APPROVAL, approvedAt: '2026-01-01', expiresAt: '2026-12-31' };

    expect(evaluateApproval(approval, new Date('2025-12-31T23:59:59Z'))).toBe('not_yet_valid');
    expect(evaluateApproval(approval, new Date('2026-01-01T00:00:00Z'))).toBe('effective');
    // `expiresAt` is inclusive: the last day the reviewer signed is still covered.
    expect(evaluateApproval(approval, new Date('2026-12-31T23:59:59Z'))).toBe('effective');
    expect(evaluateApproval(approval, new Date('2027-01-01T00:00:00Z'))).toBe('expired');
  });

  it('treats a template id or an inverted window as malformed rather than valid', () => {
    expect(
      evaluateApproval({ ...TEST_APPROVAL, approvalId: 'PENDING-CTO' }, new Date('2026-11-07Z')),
    ).toBe('malformed');
    expect(evaluateApproval({ ...TEST_APPROVAL, approvedBy: '  ' }, new Date('2026-11-07Z'))).toBe(
      'malformed',
    );
    expect(
      evaluateApproval(
        { ...TEST_APPROVAL, approvedAt: '2026-12-01', expiresAt: '2026-11-01' },
        new Date('2026-11-07Z'),
      ),
    ).toBe('malformed');
  });

  it('refuses to boot real mode once the approval has expired', () => {
    const resolution = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: VERIFIED_RATE.modelId, apiKey: VALID_KEY },
      registryWith({ ...TEST_APPROVAL, approvedAt: '2026-01-01', expiresAt: '2026-06-30' }),
      new Date('2026-11-07T00:00:00Z'),
    );

    expect(resolution.ok).toBe(false);
    expect(resolution).toMatchObject({ ok: false, reason: 'approval_not_effective' });
  });

  it('refuses a model whose approval has not started yet', () => {
    const resolution = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: VERIFIED_RATE.modelId, apiKey: VALID_KEY },
      registryWith({ ...TEST_APPROVAL, approvedAt: '2027-01-01', expiresAt: '2027-06-30' }),
      new Date('2026-11-07T00:00:00Z'),
    );

    expect(resolution).toMatchObject({ ok: false, reason: 'approval_not_effective' });
  });

  it('refuses a snapshot the provider has already retired', () => {
    expect(isPastShutdown(RATE_WITH_SHUTDOWN, new Date('2027-01-13T23:59:59Z'))).toBe(false);
    expect(isPastShutdown(RATE_WITH_SHUTDOWN, new Date('2027-01-14T00:00:00Z'))).toBe(true);

    const resolution = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: VERIFIED_RATE.modelId, apiKey: VALID_KEY },
      registryWith(TEST_APPROVAL, RATE_WITH_SHUTDOWN),
      new Date('2027-01-14T00:00:00Z'),
    );

    expect(resolution).toMatchObject({ ok: false, reason: 'model_shutdown' });
  });

  it('still opens real mode when the approval is effective and the snapshot is servable', () => {
    const resolution = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: VERIFIED_RATE.modelId, apiKey: VALID_KEY },
      registryWith(TEST_APPROVAL, RATE_WITH_SHUTDOWN),
      new Date('2026-11-07T00:00:00Z'),
    );

    expect(resolution.ok).toBe(true);
  });
});

describe('OpenRouter approval and live expiry fence', () => {
  const approval = { ...TEST_APPROVAL, expiresAt: '2026-11-10' };

  function registry(routing: OpenRouterRoutingPolicy = OPENROUTER_ROUTING) {
    return {
      models: [
        {
          providerId: 'openrouter' as const,
          modelId: OPENROUTER_RATE.modelId,
          approval,
          openRouterRouting: routing,
        },
      ],
      rates: [OPENROUTER_RATE],
    };
  }

  it('resolves the exact OpenRouter ID only with the pinned provider-routing policy', () => {
    const resolution = resolveModelExecution(
      {
        mode: 'real',
        providerId: 'openrouter',
        modelId: OPENROUTER_RATE.modelId,
        apiKey: VALID_KEY,
      },
      registry(),
      new Date('2026-11-10T12:00:00Z'),
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok || resolution.mode !== 'real') {
      throw new Error('expected an approved OpenRouter fixture resolution');
    }
    expect(resolution.settings.modelId).toBe('openai/gpt-5.6-luna');
    expect(resolution.openRouterRouting?.allowFallbacks).toBe(false);
  });

  it('refuses an OpenRouter approval with provider failover enabled or malformed routes', () => {
    const unsafe = {
      ...OPENROUTER_ROUTING,
      allowFallbacks: true,
    } as unknown as OpenRouterRoutingPolicy;
    const malformed = {
      ...OPENROUTER_ROUTING,
      only: undefined,
    } as unknown as OpenRouterRoutingPolicy;

    for (const route of [unsafe, malformed]) {
      const resolution = resolveModelExecution(
        {
          mode: 'real',
          providerId: 'openrouter',
          modelId: OPENROUTER_RATE.modelId,
          apiKey: VALID_KEY,
        },
        registry(route),
        new Date('2026-11-10T12:00:00Z'),
      );

      expect(resolution).toMatchObject({ ok: false, reason: 'provider_routing_not_approved' });
    }
  });

  it('permits the inclusive expiry day, then denies new execution on the next UTC day', () => {
    const resolution = resolveModelExecution(
      {
        mode: 'real',
        providerId: 'openrouter',
        modelId: OPENROUTER_RATE.modelId,
        apiKey: VALID_KEY,
      },
      registry(),
      new Date('2026-11-10T12:00:00Z'),
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok || resolution.mode !== 'real') {
      throw new Error('expected a currently approved OpenRouter resolution');
    }
    expect(isModelExecutionAuthorized(resolution, new Date('2026-11-10T23:59:59.999Z'))).toBe(true);
    expect(isModelExecutionAuthorized(resolution, new Date('2026-11-11T00:00:00Z'))).toBe(false);
  });
});

describe('pinned reasoning effort', () => {
  it('is sent only when the rate row fixes it, and never as a caller input', async () => {
    const withoutEffort = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ),
    );

    await new OpenAiModelGateway({
      apiKey: VALID_KEY,
      modelId: 'gpt-5.6-luna',
      rate: VERIFIED_RATE,
      isAuthorized: () => true,
      fetchImpl: withoutEffort.fetchImpl,
    }).generateConversationTurn(input(), new AbortController().signal);

    expect(JSON.parse(withoutEffort.calls[0]!.init.body)).not.toHaveProperty('reasoning_effort');

    const withEffort = stubFetch(() =>
      Promise.resolve(
        response(200, {
          choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ),
    );

    const lunaRate = MODEL_RATE_ROWS.find((row) => row.modelId === 'gpt-5.6-luna');
    expect(lunaRate).toBeDefined();

    await new OpenAiModelGateway({
      apiKey: VALID_KEY,
      modelId: 'gpt-5.6-luna',
      rate: lunaRate!,
      isAuthorized: () => true,
      fetchImpl: withEffort.fetchImpl,
    }).generateConversationTurn(input(), new AbortController().signal);

    const body = JSON.parse(withEffort.calls[0]!.init.body) as Record<string, unknown>;

    expect(body['model']).toBe('gpt-5.6-luna');
    expect(body['reasoning_effort']).toBe('none');
    expect(body['max_completion_tokens']).toBe(256);
    // The value comes from the reviewed row, and the call adds nothing else: the request shape is
    // still the six fields the contract allows plus this one pinned property.
    expect(Object.keys(body).sort()).toEqual([
      'max_completion_tokens',
      'messages',
      'model',
      'n',
      'reasoning_effort',
      'store',
      'stream',
    ]);
  });
});
