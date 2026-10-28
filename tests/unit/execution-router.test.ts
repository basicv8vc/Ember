import { describe, expect, it } from 'vitest';
import { isDomainError } from '@ember/domain';
import type { MockTaskInput, TaskKind } from '@ember/domain';
import {
  DeterministicExecutionRouter,
  ROUTER_POLICY_VERSION,
  ROUTER_THRESHOLDS,
  ROUTE_REASONS,
} from '@ember/execution';

const POLICY_VERSION = 7;

function decide(kind: unknown, input: unknown): Promise<unknown> {
  return new DeterministicExecutionRouter().decideForExecution({
    policyVersion: POLICY_VERSION,
    kind: kind as TaskKind,
    input: input as MockTaskInput,
  });
}

function expectCode(error: unknown, code: string): void {
  expect(isDomainError(error)).toBe(true);
  expect(isDomainError(error) ? error.code : 'NOT_A_DOMAIN_ERROR').toBe(code);
}

describe('deterministic execution router', () => {
  it('routes a short chat prompt to fast', async () => {
    const decision = await decide('mock.chat', { prompt: 'hello ember' });

    expect(decision).toEqual({
      path: 'fast',
      reason: 'chat_short_prompt_fast',
      policyVersion: POLICY_VERSION,
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it('keeps chat on fast exactly at the prompt threshold and moves at threshold + 1', async () => {
    const atLimit = 'a'.repeat(ROUTER_THRESHOLDS.chatFastPromptChars);
    const overLimit = 'a'.repeat(ROUTER_THRESHOLDS.chatFastPromptChars + 1);

    await expect(decide('mock.chat', { prompt: atLimit })).resolves.toMatchObject({
      path: 'fast',
      reason: 'chat_short_prompt_fast',
    });
    await expect(decide('mock.chat', { prompt: overLimit })).resolves.toMatchObject({
      path: 'standard',
      reason: 'chat_long_prompt_standard',
    });
  });

  it('moves chat to standard when only the requested output cap is large', async () => {
    await expect(
      decide('mock.chat', {
        prompt: 'hi',
        maxOutputTokens: ROUTER_THRESHOLDS.chatFastMaxOutputTokens,
      }),
    ).resolves.toMatchObject({ path: 'fast' });

    await expect(
      decide('mock.chat', {
        prompt: 'hi',
        maxOutputTokens: ROUTER_THRESHOLDS.chatFastMaxOutputTokens + 1,
      }),
    ).resolves.toMatchObject({ path: 'standard', reason: 'chat_large_output_cap_standard' });
  });

  it('routes compute by payload size only', async () => {
    await expect(
      decide('mock.compute', {
        operation: 'sha256',
        text: 'x'.repeat(ROUTER_THRESHOLDS.computeFastTextChars),
      }),
    ).resolves.toMatchObject({ path: 'fast', reason: 'compute_small_input_fast' });

    await expect(
      decide('mock.compute', {
        operation: 'sha256',
        text: 'x'.repeat(ROUTER_THRESHOLDS.computeFastTextChars + 1),
      }),
    ).resolves.toMatchObject({ path: 'standard', reason: 'compute_large_input_standard' });
  });

  it('routes file content deterministically without allocating anything', async () => {
    const base = { fileKey: 'notes/report.txt', mediaType: 'text/plain' };

    await expect(
      decide('mock.file', {
        ...base,
        content: 'x'.repeat(ROUTER_THRESHOLDS.fileStandardContentChars),
      }),
    ).resolves.toMatchObject({ path: 'standard', reason: 'file_small_content_standard' });

    await expect(
      decide('mock.file', {
        ...base,
        content: 'x'.repeat(ROUTER_THRESHOLDS.fileStandardContentChars + 1),
      }),
    ).resolves.toMatchObject({ path: 'heavy', reason: 'file_large_content_heavy' });
  });

  it('routes approvals by policy only', async () => {
    await expect(
      decide('mock.approval', { action: 'deploy', reason: 'release' }),
    ).resolves.toMatchObject({ path: 'standard', reason: 'approval_policy_standard' });
  });

  it('is a pure function: repeated calls return equal decisions', async () => {
    const first = await decide('mock.chat', { prompt: 'repeatable' });
    const second = await decide('mock.chat', { prompt: 'repeatable' });

    expect(first).toEqual(second);
    expect(ROUTE_REASONS).toContain((first as { reason: string }).reason);
  });

  it('never echoes prompt content into the decision', async () => {
    const sentinel = 'SENTINEL-PROMPT-CONTENT-42';
    const decision = (await decide('mock.chat', {
      prompt: `${sentinel} ${'y'.repeat(400)}`,
    })) as { path: string; reason: string };

    expect(JSON.stringify(decision)).not.toContain(sentinel);
    expect(ROUTE_REASONS).toContain(decision.reason);
    expect(decision.path).toBe('standard');
  });

  it('rejects an unknown task kind instead of defaulting to a path', async () => {
    const error = await decide('mock.shell', { command: 'rm -rf /' }).catch(
      (thrown: unknown) => thrown,
    );

    expectCode(error, 'INVALID_ARGUMENT');
  });

  it('rejects a payload that does not match its kind schema', async () => {
    const forged = await decide('mock.chat', { prompt: 'hi', path: 'fast' }).catch(
      (thrown: unknown) => thrown,
    );
    const wrongField = await decide('mock.compute', { prompt: 'hi' }).catch(
      (thrown: unknown) => thrown,
    );

    expectCode(forged, 'INVALID_ARGUMENT');
    expectCode(wrongField, 'INVALID_ARGUMENT');
  });

  it('rejects an untrusted policy version', async () => {
    for (const policyVersion of [-1, 1.5, Number.NaN]) {
      const error = await new DeterministicExecutionRouter()
        .decideForExecution({ policyVersion, kind: 'mock.chat', input: { prompt: 'hi' } })
        .catch((thrown: unknown) => thrown);

      expectCode(error, 'INVALID_ARGUMENT');
    }
  });

  it('reports the trusted policy version, not the router revision', async () => {
    const decision = (await decide('mock.compute', {
      operation: 'sha256',
      text: 'abc',
    })) as { policyVersion: number };

    expect(decision.policyVersion).toBe(POLICY_VERSION);
    expect(ROUTER_POLICY_VERSION).toBe(1);
    expect(new DeterministicExecutionRouter().policyVersion).toBe(ROUTER_POLICY_VERSION);
  });

  it('shares one policy between the request path and the worker path', async () => {
    const router = new DeterministicExecutionRouter();
    const command = {
      agentId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'idem-key-shared-policy',
      kind: 'mock.chat' as const,
      input: { prompt: 'z'.repeat(1_000) },
    };

    const viaRequest = await router.decide(
      {
        tenantId: '22222222-2222-4222-8222-222222222222',
        principalId: '33333333-3333-4333-8333-333333333333',
        policyVersion: POLICY_VERSION,
      },
      command,
    );
    const viaWorker = await router.decideForExecution({
      policyVersion: POLICY_VERSION,
      kind: command.kind,
      input: command.input,
    });

    expect(viaRequest).toEqual(viaWorker);
  });
});
