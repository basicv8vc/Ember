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
  OpenAiModelGateway,
  buildBoundedContext,
  createModelGateway,
  estimateCostMicroUsd,
  estimateTokensConservative,
  isModelGatewayFailure,
  isRetryableModelFailure,
  preflightConversationTurn,
  resolveModelExecution,
  statusToFailureCode,
  type FetchLike,
  type FetchRequestInitLike,
  type ModelRateRow,
} from '@ember/model-gateway';

const VALID_KEY = 'sk-test-abcdefghijklmnopqrstuvwxyz012345';

const VERIFIED_RATE: ModelRateRow = Object.freeze({
  providerId: 'openai' as const,
  modelId: 'gpt-5-mini-2026-11-01',
  inputMicroUsdPerMillion: 250_000,
  outputMicroUsdPerMillion: 2_000_000,
  rateVersion: 'test-rate-v1',
  provenance: 'invoice_verified' as const,
  source: 'test fixture',
});

const APPROVED_REGISTRY = Object.freeze({
  models: Object.freeze([{ providerId: 'openai' as const, modelId: 'gpt-5-mini-2026-11-01' }]),
  rates: Object.freeze([VERIFIED_RATE]),
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
    // 3130 input + 512 output tokens at $0.25/$2.00 per million ≈ $0.00181.
    expect(estimateCostMicroUsd(VERIFIED_RATE, 3_130, 512)).toBe(1_807);
    expect(Number.isInteger(estimateCostMicroUsd(VERIFIED_RATE, 1, 1))).toBe(true);
  });

  it('ships no approved real model, which is what keeps real mode closed by default', () => {
    expect(APPROVED_REAL_MODELS).toHaveLength(0);
    expect(DEFAULT_MODEL_APPROVAL_REGISTRY.models).toHaveLength(0);
    // The shipped rate table is unverified by construction.
    expect(MODEL_RATE_ROWS.every((row) => row.provenance === 'unverified')).toBe(true);
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
      modelId: 'gpt-5-mini-2026-11-01',
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
      modelId: 'gpt-5-mini-2026-11-01',
      apiKey: VALID_KEY,
    });
    expect(provider.ok).toBe(false);
    expect(provider).toMatchObject({ ok: false, reason: 'provider_not_approved' });
  });

  it('requires an invoice-verified rate row for the exact pinned model', () => {
    const resolution = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: 'gpt-5-mini-2026-11-01', apiKey: VALID_KEY },
      { models: APPROVED_REGISTRY.models, rates: MODEL_RATE_ROWS },
    );

    expect(resolution.ok).toBe(false);
    expect(resolution).toMatchObject({ ok: false, reason: 'rate_not_verified' });
  });

  it('requires a usable credential even when everything else is approved', () => {
    const missing = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: 'gpt-5-mini-2026-11-01', apiKey: undefined },
      APPROVED_REGISTRY,
    );
    expect(missing.ok).toBe(false);
    expect(missing).toMatchObject({ ok: false, reason: 'credential_missing' });

    const placeholder = resolveModelExecution(
      {
        mode: 'real',
        providerId: 'openai',
        modelId: 'gpt-5-mini-2026-11-01',
        apiKey: 'sk-REPLACE-WITH-REAL-KEY-000000',
      },
      APPROVED_REGISTRY,
    );
    expect(placeholder.ok).toBe(false);
    expect(placeholder).toMatchObject({ ok: false, reason: 'credential_placeholder' });

    const malformed = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: 'gpt-5-mini-2026-11-01', apiKey: 'short' },
      APPROVED_REGISTRY,
    );
    expect(malformed.ok).toBe(false);
    expect(malformed).toMatchObject({ ok: false, reason: 'credential_malformed' });
  });

  it('opens real mode only when all four gates pass, and then carries the rate and credential', () => {
    const resolution = resolveModelExecution(
      { mode: 'real', providerId: 'openai', modelId: 'gpt-5-mini-2026-11-01', apiKey: VALID_KEY },
      APPROVED_REGISTRY,
    );

    expect(resolution.ok).toBe(true);

    if (!resolution.ok || resolution.mode !== 'real') {
      throw new Error('expected an approved real resolution');
    }

    expect(resolution.rate.rateVersion).toBe('test-rate-v1');
    expect(resolution.settings.modelId).toBe('gpt-5-mini-2026-11-01');
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
      modelId: 'gpt-5-mini-2026-11-01',
      rate: VERIFIED_RATE,
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
    expect(result.modelLabel).toBe('gpt-5-mini-2026-11-01');
    expect(result.modelLabel).not.toMatch(/-(fake|echo)-/);
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
      modelId: 'gpt-5-mini-2026-11-01',
      rate: VERIFIED_RATE,
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
      modelId: 'gpt-5-mini-2026-11-01',
      rate: VERIFIED_RATE,
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
          modelId: 'gpt-5-mini-2026-11-01',
          rate: VERIFIED_RATE,
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
        modelId: 'gpt-5-mini-2026-11-01',
        rate: VERIFIED_RATE,
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
        modelId: 'gpt-5-mini-2026-11-01',
        rate: VERIFIED_RATE,
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
      modelId: 'gpt-5-mini-2026-11-01',
      rate: VERIFIED_RATE,
      fetchImpl: stub.fetchImpl,
    }).generateConversationTurn(input(), new AbortController().signal);

    expect(result.usage).not.toBeNull();
    expect(result.usage!.inputTokens).toBe(3_130);
    expect(result.usage!.outputTokens).toBe(512);
    expect(result.usage!.costMicroUsd).toBe(1_807);
    expect(result.usage!.rateVersion).toBe('test-rate-v1');
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
        modelId: 'gpt-5-mini-2026-11-01',
        rate: VERIFIED_RATE,
        fetchImpl: stub.fetchImpl,
      }).generateConversationTurn(input(), new AbortController().signal);

      // The reply is valid and usable, but the charge is unknown — not zero.
      expect(result.output.text).toBe('ok');
      expect(result.usage).toBeNull();
      expect(result.simulated).toBe(false);
    }
  });
});

describe('status mapping', () => {
  it('has no unmapped status class', () => {
    for (const status of [400, 401, 403, 404, 408, 429, 500, 502, 599]) {
      expect(typeof statusToFailureCode(status)).toBe('string');
    }
  });
});
