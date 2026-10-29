import { describe, expect, it } from 'vitest';
import type { RouteDecision, RunExecutionContext } from '@ember/contracts';
import type { SimulatedExecutionResult } from '@ember/execution';
import { DomainError, type Id, type LeasedRun } from '@ember/domain';
import { createRunHandler, type RunHandlerCompletion } from '../../apps/worker/src/run-handler.js';

/** Reduce a handler completion to the legacy terminal-status view used by these tests. */
async function outcomeOf(completion: Promise<RunHandlerCompletion>): Promise<string> {
  const value = await completion;

  return value.type === 'finish' ? value.outcome : 'committed';
}

import { createWorkerLogger } from '../../apps/worker/src/logger.js';

const TENANT = '11111111-1111-4111-8111-111111111111' as Id;
const TASK = '22222222-2222-4222-8222-222222222222' as Id;
const RUN = '33333333-3333-4333-8333-333333333333' as Id;
const AGENT = '44444444-4444-4444-8444-444444444444' as Id;

const LEASE: LeasedRun = {
  tenantId: TENANT,
  taskId: TASK,
  runId: RUN,
  attempt: 1,
  leaseEpoch: 4,
  leaseExpiresAt: '2026-10-28T00:00:30.000Z',
};

const ROUTE: RouteDecision = Object.freeze({
  path: 'fast',
  reason: 'chat_short_prompt_fast',
  policyVersion: 9,
});

function context(overrides: Partial<RunExecutionContext> = {}): RunExecutionContext {
  return {
    tenantId: TENANT,
    taskId: TASK,
    runId: RUN,
    agentId: AGENT,
    attempt: 1,
    leaseEpoch: 4,
    leaseExpiresAt: '2026-10-28T00:00:30.000Z',
    deadlineAt: null,
    policyVersion: 9,
    kind: 'mock.chat',
    input: { prompt: 'PROMPT-SENTINEL' },
    workerId: 'worker-test',
    ...overrides,
  };
}

function captureLogger(): { logger: ReturnType<typeof createWorkerLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createWorkerLogger({
    level: 'debug',
    sink: (_level, line) => lines.push(line),
    now: () => new Date('2026-10-28T00:00:00.000Z'),
  });
  return { logger, lines };
}

function simulatedResult(route: RouteDecision = ROUTE): SimulatedExecutionResult {
  return Object.freeze({
    tenantId: TENANT,
    taskId: TASK,
    runId: RUN,
    kind: 'mock.chat' as const,
    route: route.path,
    startedAt: '2026-10-28T00:00:00.000Z',
    durationMs: 3,
    simulated: true as const,
    durable: false as const,
    sandboxId: null,
    output: Object.freeze({
      type: 'text' as const,
      text: 'OUTPUT-SENTINEL',
      usage: Object.freeze({ promptTokens: 1, completionTokens: 1 }),
    }),
  });
}

function handler(options: {
  readonly read?: () => Promise<RunExecutionContext>;
  readonly decide?: () => Promise<RouteDecision>;
  readonly execute?: (signal: AbortSignal) => Promise<SimulatedExecutionResult>;
}): {
  readonly handle: (run: LeasedRun, signal: AbortSignal) => Promise<RunHandlerCompletion>;
  readonly lines: string[];
  readonly routerCalls: unknown[];
  readonly signals: AbortSignal[];
} {
  const { logger, lines } = captureLogger();
  const routerCalls: unknown[] = [];
  const signals: AbortSignal[] = [];

  const runHandler = createRunHandler({
    contextReader: {
      read: options.read ?? ((): Promise<RunExecutionContext> => Promise.resolve(context())),
    },
    router: {
      decideForExecution: (ctx: unknown): Promise<RouteDecision> => {
        routerCalls.push(ctx);
        return options.decide?.() ?? Promise.resolve(ROUTE);
      },
    },
    executor: {
      execute: (_ctx, _route, signal: AbortSignal): Promise<SimulatedExecutionResult> => {
        signals.push(signal);
        return options.execute?.(signal) ?? Promise.resolve(simulatedResult());
      },
    },
    clock: { now: () => new Date('2026-10-28T00:00:00.000Z') },
    logger,
  });

  return {
    handle: (run: LeasedRun, signal: AbortSignal): Promise<RunHandlerCompletion> =>
      runHandler.handle(run, signal),
    lines,
    routerCalls,
    signals,
  };
}

describe('run handler', () => {
  it('executes a claimed Run and reports success without writing state itself', async () => {
    const harness = handler({});

    await expect(outcomeOf(harness.handle(LEASE, new AbortController().signal))).resolves.toBe(
      'succeeded',
    );
    expect(harness.signals).toHaveLength(1);
    expect(harness.routerCalls).toEqual([
      { policyVersion: 9, kind: 'mock.chat', input: { prompt: 'PROMPT-SENTINEL' } },
    ]);
  });

  it('routes with the trusted, database-derived context only', async () => {
    const harness = handler({});

    await harness.handle(LEASE, new AbortController().signal);

    const call = harness.routerCalls[0] as Record<string, unknown>;

    expect(Object.keys(call).sort()).toEqual(['input', 'kind', 'policyVersion']);
    expect(call.policyVersion).toBe(9);
  });

  it('re-throws STALE_LEASE so the loop never submits a result', async () => {
    const harness = handler({
      read: () => Promise.reject(new DomainError('STALE_LEASE', 'lease epoch moved')),
    });

    await expect(harness.handle(LEASE, new AbortController().signal)).rejects.toMatchObject({
      code: 'STALE_LEASE',
    });
  });

  it('re-throws NOT_FOUND for a Run that is no longer visible', async () => {
    const harness = handler({
      read: () => Promise.reject(new DomainError('NOT_FOUND', 'run not found')),
    });

    await expect(harness.handle(LEASE, new AbortController().signal)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('maps infrastructure failures on context read to a retryable Run', async () => {
    const harness = handler({
      read: () => Promise.reject(new DomainError('DB_UNAVAILABLE', 'pool exhausted')),
    });

    await expect(outcomeOf(harness.handle(LEASE, new AbortController().signal))).resolves.toBe(
      'failed_retryable',
    );
  });

  it('maps a persisted payload that fails validation to a terminal Run', async () => {
    const harness = handler({
      read: () => Promise.reject(new DomainError('INVALID_ARGUMENT', 'bad payload')),
    });

    await expect(outcomeOf(harness.handle(LEASE, new AbortController().signal))).resolves.toBe(
      'failed_terminal',
    );
  });

  it('maps a rejected route to a terminal Run and never executes', async () => {
    const harness = handler({
      decide: () => Promise.reject(new DomainError('POLICY_DENIED', 'route denied')),
    });

    await expect(outcomeOf(harness.handle(LEASE, new AbortController().signal))).resolves.toBe(
      'failed_terminal',
    );
    expect(harness.signals).toHaveLength(0);
  });

  it('maps a cancelled execution to cancelled', async () => {
    const harness = handler({
      execute: () => Promise.reject(new DomainError('CANCELLED', 'cancelled by caller')),
    });

    await expect(outcomeOf(harness.handle(LEASE, new AbortController().signal))).resolves.toBe(
      'cancelled',
    );
  });

  it('classifies execution failures by their stable domain code', async () => {
    const cases = [
      { code: 'EXECUTION_TIMEOUT', expected: 'failed_retryable' },
      { code: 'MOCK_TOOL_FAILED', expected: 'failed_retryable' },
      { code: 'DB_UNAVAILABLE', expected: 'failed_retryable' },
      { code: 'DEADLINE_EXCEEDED', expected: 'failed_terminal' },
      { code: 'POLICY_DENIED', expected: 'failed_terminal' },
      { code: 'INVALID_ARGUMENT', expected: 'failed_terminal' },
    ] as const;

    for (const testCase of cases) {
      const harness = handler({
        execute: () => Promise.reject(new DomainError(testCase.code, 'simulated failure')),
      });

      await expect(outcomeOf(harness.handle(LEASE, new AbortController().signal))).resolves.toBe(
        testCase.expected,
      );
    }
  });

  it('treats an unexpected programming error as a bounded retry, never success', async () => {
    const harness = handler({ execute: () => Promise.reject(new TypeError('boom')) });

    await expect(outcomeOf(harness.handle(LEASE, new AbortController().signal))).resolves.toBe(
      'failed_retryable',
    );
    expect(harness.lines.join('\n')).toContain('UNEXPECTED');
  });

  it('never logs prompt or result content', async () => {
    const harness = handler({
      execute: () => Promise.resolve(simulatedResult()),
    });

    await harness.handle(LEASE, new AbortController().signal);

    const logs = harness.lines.join('\n');

    expect(logs).toContain(RUN);
    expect(logs).toContain('fast');
    expect(logs).not.toContain('PROMPT-SENTINEL');
    expect(logs).not.toContain('OUTPUT-SENTINEL');
  });
});
