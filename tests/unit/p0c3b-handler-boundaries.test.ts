import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  BudgetLedger,
  OccurrenceExecutionIdentity,
  RunExecutionContext,
  RunExecutionContextReader,
  WorkerLeaseGrant,
} from '@ember/contracts';
import { DomainError, type LeasedRun } from '@ember/domain';
import {
  CommitmentOrchestrator,
  FakeSummaryEngine,
  createDefaultSentinelPolicy,
  type CommitmentOrchestrationContext,
  type OrchestrationResult,
} from '@ember/execution';
import { createCommitmentRunHandler } from '../../apps/worker/src/commitment-handler.js';
import { buildCommitmentTaskInput } from '../../apps/worker/src/commitment-ports.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';

/**
 * P0-C3B Task 3 - fail-closed identity and cancellation boundaries.
 *
 * Unit coverage of the Worker handler and orchestrator. The authoritative database guarantees
 * are covered by the real-PostgreSQL suites.
 */
const logger = createWorkerLogger({ level: 'error' });
const liveSignal = new AbortController().signal;

interface Calls {
  reads: number;
  identityReads: number;
  execute: number;
  finalize: Array<{ status: string; reasonCode: string }>;
  orchestration: CommitmentOrchestrationContext[];
}

interface HarnessOptions {
  readonly persistedWorkerId?: string | null;
  readonly input?: unknown;
  readonly identity?: OccurrenceExecutionIdentity | null;
  readonly identityPatch?: Partial<OccurrenceExecutionIdentity>;
  readonly identityError?: Error;
  readonly executeError?: Error;
  readonly result?: OrchestrationResult;
}

interface Harness {
  readonly run: LeasedRun;
  readonly context: RunExecutionContext;
  readonly calls: Calls;
  readonly handler: ReturnType<typeof createCommitmentRunHandler>;
}

function buildHarness(options: HarnessOptions = {}): Harness {
  const tenantId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const commitmentId = randomUUID();
  const occurrenceId = randomUUID();

  const run: LeasedRun = {
    tenantId,
    taskId,
    runId,
    attempt: 1,
    leaseEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  };

  const context: RunExecutionContext = {
    tenantId,
    taskId,
    runId,
    agentId: randomUUID(),
    attempt: 1,
    leaseEpoch: 1,
    leaseExpiresAt: run.leaseExpiresAt,
    deadlineAt: null,
    policyVersion: 1,
    kind: 'mock.compute',
    input: (options.input ??
      buildCommitmentTaskInput({
        commitmentId,
        occurrenceId,
        sourceProfileId: 'sp_from_input',
        scheduleKind: 'once',
      })) as RunExecutionContext['input'],
    workerId: options.persistedWorkerId === undefined ? 'worker-a' : options.persistedWorkerId,
  };

  const calls: Calls = {
    reads: 0,
    identityReads: 0,
    execute: 0,
    finalize: [],
    orchestration: [],
  };

  const contextReader: RunExecutionContextReader = {
    read: () => {
      calls.reads += 1;
      return Promise.resolve(context);
    },
  };

  const identity: OccurrenceExecutionIdentity | null =
    options.identity === undefined
      ? {
          tenantId,
          commitmentId,
          occurrenceId,
          agentId: context.agentId,
          taskId,
          sourceProfileId: 'sp_from_database',
          scheduleKind: 'interval',
          occurrenceStatus: 'dispatched',
          commitmentStatus: 'active',
          ...options.identityPatch,
        }
      : options.identity;

  const orchestrator = {
    execute: (
      _grant: WorkerLeaseGrant,
      orchestrationContext: CommitmentOrchestrationContext,
    ): Promise<OrchestrationResult> => {
      calls.execute += 1;
      calls.orchestration.push(orchestrationContext);

      if (options.executeError !== undefined) {
        return Promise.reject(options.executeError);
      }

      return Promise.resolve(
        options.result ?? {
          outcomeCommitted: true,
          replayed: false,
          resultStatus: 'meaningful_change',
          summary: 'summary',
        },
      );
    },
  } as unknown as CommitmentOrchestrator;

  const handler = createCommitmentRunHandler({
    contextReader,
    store: {
      findOccurrenceExecutionIdentity: () => {
        calls.identityReads += 1;

        if (options.identityError !== undefined) {
          return Promise.reject(options.identityError);
        }

        return Promise.resolve(identity);
      },
      finalizeOccurrenceFromTask: (_grant, cmd) => {
        calls.finalize.push({ status: cmd.terminalStatus, reasonCode: cmd.reasonCode });
        return Promise.resolve(true);
      },
    },
    orchestrator,
    clock: { now: () => new Date() },
    workerId: 'worker-a',
    logger,
  });

  return { run, context, calls, handler };
}
describe('P0-C3B: fail-closed Worker identity', () => {
  it('refuses to execute when the persisted Run has no worker id', async () => {
    const harness = buildHarness({ persistedWorkerId: null });

    await expect(harness.handler.handle(harness.run, liveSignal)).resolves.toEqual({
      type: 'finish',
      outcome: 'failed_terminal',
    });
    expect(harness.calls.identityReads).toBe(0);
    expect(harness.calls.execute).toBe(0);
  });

  it('refuses to execute when the Run belongs to another worker', async () => {
    const harness = buildHarness({ persistedWorkerId: 'worker-b' });

    await expect(harness.handler.handle(harness.run, liveSignal)).resolves.toEqual({
      type: 'finish',
      outcome: 'failed_terminal',
    });
    expect(harness.calls.execute).toBe(0);
  });

  it('refuses a Task without a valid commitment marker', async () => {
    const harness = buildHarness({ input: { operation: 'sha256', text: 'not-json' } });

    await expect(harness.handler.handle(harness.run, liveSignal)).resolves.toEqual({
      type: 'finish',
      outcome: 'failed_terminal',
    });
    expect(harness.calls.identityReads).toBe(0);
    expect(harness.calls.execute).toBe(0);
  });

  it('refuses to execute when the Task is not bound to any occurrence', async () => {
    const harness = buildHarness({ identity: null });

    await expect(harness.handler.handle(harness.run, liveSignal)).resolves.toEqual({
      type: 'finish',
      outcome: 'failed_terminal',
    });
    expect(harness.calls.execute).toBe(0);
  });

  it('fails closed when the identity lookup is denied', async () => {
    const harness = buildHarness({
      identityError: new DomainError('POLICY_DENIED', 'Occurrence is not bound to this Task'),
    });

    await expect(harness.handler.handle(harness.run, liveSignal)).resolves.toEqual({
      type: 'finish',
      outcome: 'failed_terminal',
    });
    expect(harness.calls.execute).toBe(0);
  });

  it('retries when the occurrence is not bound yet (dispatch/bind race)', async () => {
    const harness = buildHarness({
      identityError: new DomainError('INVALID_STATE_TRANSITION', 'Occurrence is not bound yet'),
    });

    await expect(harness.handler.handle(harness.run, liveSignal)).resolves.toEqual({
      type: 'finish',
      outcome: 'failed_retryable',
    });
    expect(harness.calls.execute).toBe(0);
  });

  it('uses the persisted source profile and schedule kind, never the Task payload', async () => {
    const harness = buildHarness();

    await expect(harness.handler.handle(harness.run, liveSignal)).resolves.toEqual({
      type: 'finish',
      outcome: 'succeeded',
    });

    const orchestration = harness.calls.orchestration[0];
    expect(orchestration?.sourceProfileId).toBe('sp_from_database');
    expect(orchestration?.scheduleKind).toBe('interval');
  });

  it('refuses malformed persisted source and schedule identity before orchestration', async () => {
    for (const identityPatch of [
      { sourceProfileId: '' },
      { scheduleKind: 'daily' as unknown as 'once' },
    ]) {
      const harness = buildHarness({ identityPatch });
      const completion = await harness.handler.handle(harness.run, liveSignal);

      expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });
      expect(harness.calls.execute).toBe(0);
    }
  });

  it('refuses to execute when the commitment is no longer active', async () => {
    const harness = buildHarness({ identityPatch: { commitmentStatus: 'cancelled' } });

    const completion = await harness.handler.handle(harness.run, liveSignal);

    expect(completion).toMatchObject({ type: 'finish', outcome: 'cancelled' });
    expect(harness.calls.execute).toBe(0);

    // The commitment cancellation is what terminalized the occurrence.
    if (completion.type === 'finish') {
      await completion.finalize?.(true);
    }
    expect(harness.calls.finalize).toEqual([
      { status: 'cancelled', reasonCode: 'commitment_cancelled' },
    ]);
  });

  it('preserves failed versus cancelled occurrence outcomes on duplicate execution', async () => {
    const failed = buildHarness({ identityPatch: { occurrenceStatus: 'failed' } });
    const cancelled = buildHarness({ identityPatch: { occurrenceStatus: 'cancelled' } });

    await expect(failed.handler.handle(failed.run, liveSignal)).resolves.toMatchObject({
      type: 'finish',
      outcome: 'failed_terminal',
    });
    await expect(cancelled.handler.handle(cancelled.run, liveSignal)).resolves.toMatchObject({
      type: 'finish',
      outcome: 'cancelled',
    });
    expect(failed.calls.execute).toBe(0);
    expect(cancelled.calls.execute).toBe(0);
  });
});
describe('P0-C3B: terminal occurrence transitions from the Worker', () => {
  it('terminalizes the occurrence only after the fenced finish accepted the Run', async () => {
    const harness = buildHarness({
      executeError: new DomainError('POLICY_DENIED', 'sentinel denied mock.compute'),
    });

    const completion = await harness.handler.handle(harness.run, liveSignal);

    expect(completion.type).toBe('finish');
    if (completion.type !== 'finish') return;
    expect(completion.outcome).toBe('failed_terminal');

    // Rejected finish (lease lost) must not write commitment state.
    await completion.finalize?.(false);
    expect(harness.calls.finalize).toHaveLength(0);

    // Accepted finish terminalizes exactly once, with the mapped reason code.
    await completion.finalize?.(true);
    expect(harness.calls.finalize).toEqual([{ status: 'failed', reasonCode: 'sentinel_denied' }]);
  });

  it('maps budget exhaustion to a failed terminal transition', async () => {
    const harness = buildHarness({
      executeError: new DomainError('BUDGET_EXCEEDED', 'budget exhausted'),
    });

    const completion = await harness.handler.handle(harness.run, liveSignal);
    expect(completion).toMatchObject({ type: 'finish', outcome: 'failed_terminal' });

    if (completion.type === 'finish') {
      await completion.finalize?.(true);
    }

    expect(harness.calls.finalize).toEqual([{ status: 'failed', reasonCode: 'budget_exceeded' }]);
  });

  it('cancels the occurrence when the orchestrator reports cancellation', async () => {
    const harness = buildHarness({
      executeError: new DomainError('CANCELLED', 'aborted before publication'),
    });

    const completion = await harness.handler.handle(harness.run, liveSignal);
    expect(completion).toMatchObject({ type: 'finish', outcome: 'cancelled' });

    if (completion.type === 'finish') {
      await completion.finalize?.(true);
    }

    expect(harness.calls.finalize).toEqual([
      { status: 'cancelled', reasonCode: 'execution_cancelled' },
    ]);
  });

  it('never terminalizes on a retryable failure', async () => {
    const harness = buildHarness({
      executeError: new DomainError('MOCK_TOOL_FAILED', 'transient tool failure'),
    });

    const completion = await harness.handler.handle(harness.run, liveSignal);

    expect(completion).toMatchObject({ type: 'finish', outcome: 'failed_retryable' });
    expect(completion.type === 'finish' ? completion.finalize : undefined).toBeUndefined();
    expect(harness.calls.finalize).toHaveLength(0);
  });

  it('rethrows a stale lease so the poll loop skips finish entirely', async () => {
    const harness = buildHarness({
      executeError: new DomainError('STALE_LEASE', 'lease lost mid-execution'),
    });

    await expect(harness.handler.handle(harness.run, liveSignal)).rejects.toThrowError(
      expect.objectContaining({ code: 'STALE_LEASE' }),
    );
    expect(harness.calls.finalize).toHaveLength(0);
  });

  it('does not execute anything when the signal is already aborted', async () => {
    const harness = buildHarness();
    const controller = new AbortController();
    controller.abort();

    await expect(harness.handler.handle(harness.run, controller.signal)).resolves.toEqual({
      type: 'finish',
      outcome: 'cancelled',
    });
    expect(harness.calls.reads).toBe(0);
    expect(harness.calls.execute).toBe(0);
  });
});
describe('P0-C3B: orchestrator cancellation boundaries', () => {
  const grant: WorkerLeaseGrant = {
    tenantId: randomUUID(),
    taskId: randomUUID(),
    runId: randomUUID(),
    attempt: 1,
    leaseEpoch: 1,
    workerId: 'worker-a',
  };

  const context: CommitmentOrchestrationContext = {
    tenantId: grant.tenantId,
    agentId: randomUUID(),
    commitmentId: randomUUID(),
    occurrenceId: randomUUID(),
    sourceProfileId: 'sp_ember_releases',
    scheduleKind: 'once',
    policyVersion: 1,
  };

  const snapshot = {
    sourceProfileId: 'sp_ember_releases',
    observedAt: '2026-11-01T12:00:00.000Z',
    digest: 'a'.repeat(64),
    boundedSafeItems: [],
  };

  function buildOrchestrator(steps: {
    onLookup?: (controller: AbortController) => void;
    onRead?: (controller: AbortController) => void;
    append: () => Promise<boolean>;
    reads: { count: number };
    budget?: {
      reserve: () => Promise<void>;
      settle: () => Promise<void>;
      release: () => Promise<void>;
    };
    summaryEngine?: FakeSummaryEngine;
  }): CommitmentOrchestrator {
    return new CommitmentOrchestrator({
      store: {
        findAuthoritativeOutcome: () => {
          steps.onLookup?.(controllerRef);
          return Promise.resolve(null);
        },
        appendOutcomeIfAbsent: () => steps.append(),
      },
      sourceReader: {
        readSnapshot: () => {
          steps.reads.count += 1;
          steps.onRead?.(controllerRef);
          return Promise.resolve(snapshot);
        },
      },
      ...(steps.budget === undefined ? {} : { budget: steps.budget as unknown as BudgetLedger }),
      ...(steps.summaryEngine === undefined ? {} : { summaryEngine: steps.summaryEngine }),
      sentinelPolicy: createDefaultSentinelPolicy({
        policyId: 'unit-sentinel',
        policyVersion: 1,
        tenantId: grant.tenantId,
        allowedActions: ['mock.read', 'mock.compute'],
      }),
    });
  }

  let controllerRef = new AbortController();

  it('does not read the source when cancelled during the replay lookup', async () => {
    controllerRef = new AbortController();
    const reads = { count: 0 };
    let appended = 0;
    const orchestrator = buildOrchestrator({
      onLookup: (controller) => controller.abort(),
      reads,
      append: () => {
        appended += 1;
        return Promise.resolve(true);
      },
    });

    await expect(orchestrator.execute(grant, context, controllerRef.signal)).rejects.toThrowError(
      expect.objectContaining({ code: 'CANCELLED' }),
    );
    expect(reads.count).toBe(0);
    expect(appended).toBe(0);
  });

  it('discards a snapshot whose read completed after cancellation', async () => {
    controllerRef = new AbortController();
    const reads = { count: 0 };
    let appended = 0;
    const orchestrator = buildOrchestrator({
      onRead: (controller) => controller.abort(),
      reads,
      append: () => {
        appended += 1;
        return Promise.resolve(true);
      },
    });

    await expect(orchestrator.execute(grant, context, controllerRef.signal)).rejects.toThrowError(
      expect.objectContaining({ code: 'CANCELLED' }),
    );
    expect(reads.count).toBe(1);
    expect(appended).toBe(0);
  });

  it('releases a reservation and skips the source read if cancellation follows the reserve', async () => {
    controllerRef = new AbortController();
    const reads = { count: 0 };
    const budgetCalls = { reserve: 0, release: 0, settle: 0 };
    let appended = 0;
    const orchestrator = buildOrchestrator({
      reads,
      append: () => {
        appended += 1;
        return Promise.resolve(true);
      },
      budget: {
        reserve: () => {
          budgetCalls.reserve += 1;
          controllerRef.abort();
          return Promise.resolve();
        },
        settle: () => {
          budgetCalls.settle += 1;
          return Promise.resolve();
        },
        release: () => {
          budgetCalls.release += 1;
          return Promise.resolve();
        },
      },
    });

    await expect(orchestrator.execute(grant, context, controllerRef.signal)).rejects.toThrowError(
      expect.objectContaining({ code: 'CANCELLED' }),
    );
    expect(budgetCalls).toEqual({ reserve: 1, release: 1, settle: 0 });
    expect(reads.count).toBe(0);
    expect(appended).toBe(0);
  });

  it('does not publish if cancellation arrives during summary generation', async () => {
    controllerRef = new AbortController();
    const reads = { count: 0 };
    let appended = 0;
    class AbortOnGenerateSummaryEngine extends FakeSummaryEngine {
      override generate(sourceSnapshot: typeof snapshot) {
        controllerRef.abort();
        return super.generate(sourceSnapshot);
      }
    }
    const orchestrator = buildOrchestrator({
      reads,
      append: () => {
        appended += 1;
        return Promise.resolve(true);
      },
      summaryEngine: new AbortOnGenerateSummaryEngine(),
    });

    await expect(orchestrator.execute(grant, context, controllerRef.signal)).rejects.toThrowError(
      expect.objectContaining({ code: 'CANCELLED' }),
    );
    expect(reads.count).toBe(1);
    expect(appended).toBe(0);
  });

  it('rejects a missing AbortSignal before any side effect', async () => {
    const reads = { count: 0 };
    const orchestrator = buildOrchestrator({
      reads,
      append: () => Promise.resolve(true),
    });

    await expect(
      orchestrator.execute(grant, context, undefined as unknown as AbortSignal),
    ).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(reads.count).toBe(0);
  });
});
