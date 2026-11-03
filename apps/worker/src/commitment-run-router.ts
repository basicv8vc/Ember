import type { RunExecutionContext, RunExecutionContextReader } from '@ember/contracts';
import { isDomainError, type LeasedRun } from '@ember/domain';
import type { ExecutionClock } from '@ember/execution';
import { readCommitmentTaskMarker } from './commitment-ports.js';
import type { WorkerLogger } from './logger.js';
import type { RunHandler, RunHandlerCompletion } from './run-handler.js';

export interface CommitmentRouteAwareRunHandlerDependencies {
  readonly contextReader: RunExecutionContextReader;
  readonly clock: ExecutionClock;
  /** Handler for Tasks dispatched by the Commitment Scheduler. */
  readonly commitmentHandler: RunHandler;
  /** Handler for every other Task kind (P0B-05 simulation / P0B-06 durable path). */
  readonly defaultHandler: RunHandler;
  readonly logger: WorkerLogger;
}

/**
 * Composition-root router that selects the handler for a claimed Run.
 *
 * The context is read exactly once and handed to the chosen handler, so routing costs no extra
 * database round trip. The discriminator is the commitment marker in the persisted Task input;
 * because every business value is re-resolved from PostgreSQL inside the commitment handler, a
 * forged marker can only cause a fail-closed terminal failure - never a fabricated execution.
 */
export function createCommitmentRouteAwareRunHandler(
  deps: CommitmentRouteAwareRunHandlerDependencies,
): RunHandler {
  return {
    async handle(run: LeasedRun, signal: AbortSignal): Promise<RunHandlerCompletion> {
      let context: RunExecutionContext;

      try {
        context = await deps.contextReader.read(run, deps.clock.now());
      } catch (error) {
        if (isDomainError(error) && (error.code === 'STALE_LEASE' || error.code === 'NOT_FOUND')) {
          throw error;
        }

        // The default handler performs its own read and classifies the failure consistently.
        return deps.defaultHandler.handle(run, signal);
      }

      if (readCommitmentTaskMarker(context.input) !== null) {
        return deps.commitmentHandler.handle(run, signal, context);
      }

      return deps.defaultHandler.handle(run, signal, context);
    },
  };
}
