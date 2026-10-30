import type {
  CommitReceipt,
  RouteDecision,
  RunExecutionContext,
  RunExecutionContextReader,
} from '@ember/contracts';
import {
  isDomainError,
  type DomainErrorCode,
  type LeasedRun,
  type RunTerminalStatus,
} from '@ember/domain';
import type { ExecutionClock, ExecutionRouterForRun, SimulatedExecutor } from '@ember/execution';
import type { WorkerLogger } from './logger.js';

/**
 * What a handler did with a Run.
 *
 * - `finish` keeps the P0B-05 contract: the poll loop owns `LeaseQueue.finish()`.
 * - `committed` means a durable result already terminalized the Run inside the atomic
 *   `RunResultCommitter` transaction (P0B-06), so the loop must **not** call `finish()` again:
 *   doing so would attempt a second terminal transition and could only produce a rejected,
 *   misleading finish.
 */
export type RunHandlerCompletion =
  | { readonly type: 'finish'; readonly outcome: RunTerminalStatus }
  | { readonly type: 'committed'; readonly receipt: CommitReceipt };

export interface RunHandler {
  handle(run: LeasedRun, signal: AbortSignal): Promise<RunHandlerCompletion>;
}

export interface RunHandlerDependencies {
  /** Trusted, database-derived execution context for the leased Run. */
  readonly contextReader: RunExecutionContextReader;
  readonly router: ExecutionRouterForRun;
  readonly executor: SimulatedExecutor;
  readonly clock: ExecutionClock;
  readonly logger: WorkerLogger;
}

/**
 * Error codes a retry may legitimately resolve.
 *
 * Everything else (denied policy, invalid persisted input, illegal transition) is terminal
 * for the Task: retrying identical deterministic work cannot succeed.
 */
const RETRYABLE_CODES: ReadonlySet<DomainErrorCode> = new Set<DomainErrorCode>([
  'DB_UNAVAILABLE',
  'EXECUTION_TIMEOUT',
  'MOCK_TOOL_FAILED',
]);

function codeOf(error: unknown): DomainErrorCode | 'UNEXPECTED' {
  return isDomainError(error) ? error.code : 'UNEXPECTED';
}

/** Map an execution failure to a Run outcome. Never maps a failure to `succeeded`. */
function classifyFailure(error: unknown): RunTerminalStatus {
  if (!isDomainError(error)) {
    // An unexpected programming error is retried only within the bounded attempt budget.
    return 'failed_retryable';
  }

  if (error.code === 'CANCELLED') {
    return 'cancelled';
  }

  return RETRYABLE_CODES.has(error.code) ? 'failed_retryable' : 'failed_terminal';
}

/**
 * Deterministic Run handler.
 *
 * Flow: trusted context → router decision → simulated executor. Lease renewal, terminal
 * persistence and Fencing stay in the poll loop / `PostgresLeaseQueue`.
 *
 * Failure semantics:
 * - `STALE_LEASE`/`NOT_FOUND` from the reader are re-thrown so the loop skips `finish()`
 *   entirely: the current lease is no longer ours, so nothing may be submitted;
 * - `CANCELLED` (a committed cancellation intent) maps to `cancelled`, which the queue
 *   converges under ADR-0001;
 * - `DEADLINE_EXCEEDED` maps to `failed_terminal` (the queue re-checks the deadline itself);
 * - retryable infrastructure failures map to `failed_retryable`; policy/validation failures
 *   map to `failed_terminal`.
 *
 * The handler logs identifiers, route, stable codes and durations only. Prompts, file content
 * and generated text never reach a log line or an event payload.
 */
export function createRunHandler(deps: RunHandlerDependencies): RunHandler {
  const { contextReader, router, executor, clock, logger } = deps;

  return {
    async handle(run: LeasedRun, signal: AbortSignal): Promise<RunHandlerCompletion> {
      const startedAtHr = performance.now();
      const base = {
        taskId: run.taskId,
        runId: run.runId,
        attempt: run.attempt,
        leaseEpoch: run.leaseEpoch,
      } as const;

      let context: RunExecutionContext;

      try {
        context = await contextReader.read(run, clock.now());
      } catch (error) {
        if (isDomainError(error) && (error.code === 'STALE_LEASE' || error.code === 'NOT_FOUND')) {
          // The lease is gone or belongs to someone else. Never execute, never finish.
          throw error;
        }

        const outcome = classifyFailure(error);
        logger.warn('execution context unavailable', {
          ...base,
          code: codeOf(error),
          outcome,
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        return { type: 'finish', outcome } as const;
      }

      let route: RouteDecision;

      try {
        route = await router.decideForExecution({
          policyVersion: context.policyVersion,
          kind: context.kind,
          input: context.input,
        });
      } catch (error) {
        const outcome = classifyFailure(error);
        logger.warn('execution route rejected', {
          ...base,
          taskKind: context.kind,
          code: codeOf(error),
          outcome,
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        return { type: 'finish', outcome } as const;
      }

      try {
        const result = await executor.execute(context, route, signal);

        logger.info('simulated execution finished', {
          ...base,
          taskKind: context.kind,
          route: result.route,
          routeReason: route.reason,
          sandboxId: result.sandboxId,
          durationMs: result.durationMs,
          simulated: true,
          durable: false,
        });

        return { type: 'finish', outcome: 'succeeded' } as const;
      } catch (error) {
        let effectiveError: unknown = error;

        if (signal.aborted && isDomainError(error) && error.code === 'CANCELLED') {
          try {
            await contextReader.read(run, clock.now());
          } catch (readError) {
            effectiveError = readError;
          }
        }

        if (
          isDomainError(effectiveError) &&
          (effectiveError.code === 'STALE_LEASE' || effectiveError.code === 'NOT_FOUND')
        ) {
          throw effectiveError;
        }

        const outcome = classifyFailure(effectiveError);
        logger.warn('simulated execution failed', {
          ...base,
          taskKind: context.kind,
          route: route.path,
          code: codeOf(effectiveError),
          outcome,
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        return { type: 'finish', outcome } as const;
      }
    },
  };
}
