import { describe, expect, it } from 'vitest';
import type { RouteDecision, RunExecutionContext } from '@ember/contracts';
import { isDomainError } from '@ember/domain';
import {
  DeterministicExecutor,
  FakeLlm,
  computeSha256,
  EXECUTABLE_TASK_KINDS,
  isExecutableTaskKind,
} from '@ember/execution';
import type { DeterministicExecutorOptions } from '@ember/execution';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';

const NOW = new Date('2026-10-28T00:00:00.000Z');

const FAST: RouteDecision = Object.freeze({
  path: 'fast',
  reason: 'chat_short_prompt_fast',
  policyVersion: 1,
});

function clock(): { now: () => Date } {
  return { now: () => new Date(NOW.getTime()) };
}

function recorder(): { readonly calls: number[]; readonly sleep: (ms: number) => Promise<void> } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number): Promise<void> => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

function context(overrides: Partial<RunExecutionContext> = {}): RunExecutionContext {
  return {
    tenantId: TENANT,
    taskId: TASK,
    runId: RUN,
    agentId: AGENT,
    attempt: 1,
    leaseEpoch: 2,
    leaseExpiresAt: '2026-10-28T00:05:00.000Z',
    deadlineAt: null,
    policyVersion: 1,
    kind: 'mock.chat',
    input: { prompt: 'hello ember' },
    workerId: 'worker-test',
    ...overrides,
  };
}

function executor(options: DeterministicExecutorOptions = {}): {
  readonly executor: DeterministicExecutor;
  readonly calls: number[];
} {
  const { sleep, calls } = recorder();
  return { executor: new DeterministicExecutor({ clock: clock(), sleep, ...options }), calls };
}

function expectCode(error: unknown, code: string): void {
  expect(isDomainError(error)).toBe(true);
  expect(isDomainError(error) ? error.code : 'NOT_A_DOMAIN_ERROR').toBe(code);
}

async function attempt(fn: () => unknown): Promise<unknown> {
  try {
    return await fn();
  } catch (error) {
    return error;
  }
}

describe('DeterministicExecutor: mock.chat', () => {
  it('produces a bounded, in-memory text result', async () => {
    const { executor: run } = executor();
    const result = (await run.execute(context(), FAST, new AbortController().signal)) as {
      simulated: boolean;
      durable: boolean;
      sandboxId: string | null;
      route: string;
      taskId: string;
      runId: string;
      output: { type: string; text: string; usage: { completionTokens: number } };
    };

    expect(result.simulated).toBe(true);
    // No ArtifactStore exists in P0B-05, so a result must never claim to be durable.
    expect(result.durable).toBe(false);
    expect(result.sandboxId).toBeNull();
    expect(result.route).toBe('fast');
    expect(result.taskId).toBe(TASK);
    expect(result.runId).toBe(RUN);
    expect(result.output.type).toBe('text');
    expect(result.output.text.length).toBeGreaterThan(0);
    expect(result.output.usage.completionTokens).toBe(32);
  });

  it('is deterministic across executions of the same context', async () => {
    const { executor: run } = executor();

    const first = (await run.execute(context(), FAST, new AbortController().signal)) as {
      output: { text: string };
    };
    const second = (await run.execute(context(), FAST, new AbortController().signal)) as {
      output: { text: string };
    };

    expect(first.output.text).toBe(second.output.text);
  });

  it('honours the requested output budget from the persisted input', async () => {
    const { executor: run } = executor();
    const result = (await run.execute(
      context({ input: { prompt: 'budgeted', maxOutputTokens: 4 } }),
      FAST,
      new AbortController().signal,
    )) as { output: { text: string; usage: { completionTokens: number } } };

    expect(result.output.usage.completionTokens).toBe(4);
    expect(result.output.text.split(' ')).toHaveLength(4);
  });

  it('maps injected generator faults to retryable/terminal codes', async () => {
    const { sleep } = recorder();
    const denied = new DeterministicExecutor({
      clock: clock(),
      sleep,
      llm: new FakeLlm({ sleep, fault: 'denied' }),
    });
    const toolFailure = new DeterministicExecutor({
      clock: clock(),
      sleep,
      llm: new FakeLlm({ sleep, fault: 'tool_failed' }),
    });

    expectCode(
      await attempt(() => denied.execute(context(), FAST, new AbortController().signal)),
      'POLICY_DENIED',
    );
    expectCode(
      await attempt(() => toolFailure.execute(context(), FAST, new AbortController().signal)),
      'MOCK_TOOL_FAILED',
    );
  });
});

describe('DeterministicExecutor: mock.compute', () => {
  const COMPUTE = context({
    kind: 'mock.compute',
    input: { operation: 'sha256', text: 'ember deterministic compute' },
  });

  it('runs the full simulated sandbox lifecycle and reports its usage', async () => {
    const { executor: run } = executor();
    const result = (await run.execute(COMPUTE, FAST, new AbortController().signal)) as {
      sandboxId: string | null;
      durable: boolean;
      output: {
        type: string;
        sha256: string;
        usage: { cpuSeconds: number; memoryGiBSeconds: number; egressBytes: number };
      };
    };

    expect(result.durable).toBe(false);
    expect(result.output.type).toBe('sha256');
    expect(result.output.sha256).toBe(computeSha256('ember deterministic compute').value);
    // The sandbox id is reported for observability only; the sandbox itself is destroyed.
    expect(result.sandboxId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.output.usage.cpuSeconds).toBeGreaterThan(0);
    expect(result.output.usage.memoryGiBSeconds).toBeGreaterThan(0);
    expect(result.output.usage.egressBytes).toBe(0);
  });

  it('is deterministic for the same input and stays run-scoped', async () => {
    const { executor: run } = executor();
    const signal = new AbortController().signal;

    const first = (await run.execute(COMPUTE, FAST, signal)) as {
      sandboxId: string;
      output: { sha256: string };
    };
    const second = (await run.execute(COMPUTE, FAST, signal)) as {
      sandboxId: string;
      output: { sha256: string };
    };
    const otherRun = (await run.execute(
      { ...COMPUTE, runId: '55555555-5555-4555-8555-555555555555' },
      FAST,
      signal,
    )) as { sandboxId: string; output: { sha256: string } };

    expect(first.output.sha256).toBe(second.output.sha256);
    expect(first.sandboxId).toBe(second.sandboxId);
    expect(otherRun.sandboxId).not.toBe(first.sandboxId);
    expect(otherRun.output.sha256).toBe(first.output.sha256);
  });

  it('reports a bounded timeout when the simulated command cannot finish', async () => {
    const { executor: run } = executor({ sandboxExecDurationMs: 500, sandboxExecTimeoutMs: 100 });

    expectCode(
      await attempt(() => run.execute(COMPUTE, FAST, new AbortController().signal)),
      'EXECUTION_TIMEOUT',
    );
  });

  it('uses simulated latency instead of wall-clock sleeping', async () => {
    const { executor: run, calls } = executor({ sandboxExecDurationMs: 7 });

    await run.execute(COMPUTE, FAST, new AbortController().signal);

    // Readiness is immediate (0 ms) and the simulated command accounts for 7 ms.
    expect(calls).toContain(7);
    expect(calls.every((ms) => ms >= 0 && ms <= 7)).toBe(true);
  });
});

describe('DeterministicExecutor: unsupported kinds and failure paths', () => {
  it('only advertises the kinds it can execute', () => {
    expect([...EXECUTABLE_TASK_KINDS]).toEqual(['mock.chat', 'mock.compute']);
    expect(isExecutableTaskKind('mock.chat')).toBe(true);
    expect(isExecutableTaskKind('mock.compute')).toBe(true);
    expect(isExecutableTaskKind('mock.file')).toBe(false);
    expect(isExecutableTaskKind('mock.approval')).toBe(false);
  });

  it('fails closed for a kind it cannot execute', async () => {
    const { executor: run } = executor();

    for (const kind of ['mock.file', 'mock.approval'] as const) {
      const error = await attempt(() =>
        run.execute(
          context({ kind, input: { fileKey: 'a.txt', content: 'x' } as never }),
          FAST,
          new AbortController().signal,
        ),
      );

      expectCode(error, 'POLICY_DENIED');
    }
  });

  it('re-validates persisted input at the execution boundary', async () => {
    const { executor: run } = executor();

    const error = await attempt(() =>
      run.execute(
        context({ kind: 'mock.compute', input: { operation: 'sha256' } as never }),
        FAST,
        new AbortController().signal,
      ),
    );

    expectCode(error, 'INVALID_ARGUMENT');
  });

  it('refuses a Task whose deadline already elapsed', async () => {
    const { executor: run } = executor();
    const error = await attempt(() =>
      run.execute(
        context({ deadlineAt: '2026-10-27T23:59:00.000Z' }),
        FAST,
        new AbortController().signal,
      ),
    );

    expectCode(error, 'DEADLINE_EXCEEDED');
  });

  it('executes while the deadline is still in the future', async () => {
    const { executor: run } = executor();
    const result = (await run.execute(
      context({ deadlineAt: '2026-10-28T00:01:00.000Z' }),
      FAST,
      new AbortController().signal,
    )) as { output: { type: string } };

    expect(result.output.type).toBe('text');
  });

  it('stops immediately when the lease/cancellation signal is already aborted', async () => {
    const { executor: run } = executor();
    const controller = new AbortController();

    controller.abort();

    expectCode(await attempt(() => run.execute(context(), FAST, controller.signal)), 'CANCELLED');
  });

  it('stops a chat run that is aborted while the generator is working', async () => {
    const controller = new AbortController();
    const llm = new FakeLlm({
      delayMs: 10,
      sleep: (): Promise<void> => {
        controller.abort();
        return Promise.resolve();
      },
    });
    const run = new DeterministicExecutor({ clock: clock(), llm });

    expectCode(await attempt(() => run.execute(context(), FAST, controller.signal)), 'CANCELLED');
  });
});
