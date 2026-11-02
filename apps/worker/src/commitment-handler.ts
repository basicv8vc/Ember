import type { RunExecutionContextReader } from '@ember/contracts';
import { isDomainError, type LeasedRun } from '@ember/domain';
import type { CommitmentOrchestrator, ExecutionClock, WorkerLeaseGrant } from '@ember/execution';
import type { WorkerLogger } from './logger.js';
import type { RunHandler, RunHandlerCompletion } from './run-handler.js';

export interface CommitmentRunHandlerDependencies {
  readonly contextReader: RunExecutionContextReader;
  readonly orchestrator: CommitmentOrchestrator;
  readonly clock: ExecutionClock;
  readonly logger: WorkerLogger;
}

/**
 * Worker RunHandler specifically for executing commitment occurrences dispatched to the
 * durable Task Queue.
 */
export function createCommitmentRunHandler(deps: CommitmentRunHandlerDependencies): RunHandler {
  const { contextReader, orchestrator, clock, logger } = deps;

  return {
    async handle(run: LeasedRun, signal: AbortSignal): Promise<RunHandlerCompletion> {
      const baseLog = {
        taskId: run.taskId,
        runId: run.runId,
        attempt: run.attempt,
        leaseEpoch: run.leaseEpoch,
      };

      let context;
      try {
        context = await contextReader.read(run, clock.now());
      } catch (error) {
        if (isDomainError(error) && (error.code === 'STALE_LEASE' || error.code === 'NOT_FOUND')) {
          throw error;
        }
        logger.warn('Failed to read commitment execution context', {
          ...baseLog,
          error: error instanceof Error ? error.message : String(error),
        });
        return { type: 'finish', outcome: 'failed_retryable' };
      }

      const input = (context.input ?? {}) as unknown as Record<string, unknown>;
      let commitmentId: string | null =
        typeof input.commitmentId === 'string' ? input.commitmentId : null;
      let occurrenceId: string | null =
        typeof input.occurrenceId === 'string' ? input.occurrenceId : null;
      let sourceProfileId =
        typeof input.sourceProfileId === 'string' ? input.sourceProfileId : 'default';
      let scheduleKind: 'once' | 'interval' =
        input.scheduleKind === 'once' || input.scheduleKind === 'interval'
          ? input.scheduleKind
          : 'once';

      if ((!commitmentId || !occurrenceId) && typeof input.text === 'string') {
        try {
          const parsed: unknown = JSON.parse(input.text);
          if (parsed && typeof parsed === 'object') {
            const record = parsed as Record<string, unknown>;
            if (typeof record.commitmentId === 'string') commitmentId = record.commitmentId;
            if (typeof record.occurrenceId === 'string') occurrenceId = record.occurrenceId;
            if (typeof record.sourceProfileId === 'string') {
              sourceProfileId = record.sourceProfileId;
            }
            if (record.scheduleKind === 'once' || record.scheduleKind === 'interval') {
              scheduleKind = record.scheduleKind;
            }
          }
        } catch {
          // not json text
        }
      }

      if (!commitmentId || !occurrenceId) {
        logger.warn('Task is missing required commitment metadata in input', {
          ...baseLog,
          input,
        });
        return { type: 'finish', outcome: 'failed_terminal' };
      }

      const grant: WorkerLeaseGrant = {
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        attempt: run.attempt,
        leaseEpoch: context.leaseEpoch,
        workerId: context.workerId ?? 'worker-unknown',
      };

      try {
        const result = await orchestrator.execute(
          grant,
          {
            tenantId: context.tenantId,
            agentId: context.agentId,
            commitmentId,
            occurrenceId,
            sourceProfileId,
            scheduleKind,
            policyVersion: context.policyVersion,
          },
          signal,
        );

        logger.info('Commitment occurrence execution completed', {
          ...baseLog,
          commitmentId,
          occurrenceId,
          resultStatus: result.resultStatus,
          replayed: result.replayed,
        });

        return { type: 'finish', outcome: 'succeeded' };
      } catch (error) {
        if (signal.aborted) {
          logger.info('Commitment occurrence execution cancelled by signal', baseLog);
          return { type: 'finish', outcome: 'cancelled' };
        }

        if (isDomainError(error)) {
          if (error.code === 'STALE_LEASE' || error.code === 'NOT_FOUND') {
            throw error;
          }
          if (error.code === 'CANCELLED') {
            return { type: 'finish', outcome: 'cancelled' };
          }
          if (error.code === 'POLICY_DENIED' || error.code === 'BUDGET_EXCEEDED') {
            return { type: 'finish', outcome: 'failed_terminal' };
          }
        }

        logger.warn('Commitment occurrence execution failed with retryable error', {
          ...baseLog,
          error: error instanceof Error ? error.message : String(error),
        });
        return { type: 'finish', outcome: 'failed_retryable' };
      }
    },
  };
}
