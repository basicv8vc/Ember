import {
  CommitmentStatusSchema,
  IdSchema,
  OccurrenceStatusSchema,
  ScheduleKindSchema,
  SourceProfileIdSchema,
} from '@ember/contracts';
import type {
  DueCommitmentStore,
  OccurrenceExecutionIdentity,
  RunExecutionContext,
  RunExecutionContextReader,
} from '@ember/contracts';
import { DomainError, isDomainError, type DomainErrorCode, type LeasedRun } from '@ember/domain';
import type { CommitmentOrchestrator, ExecutionClock, WorkerLeaseGrant } from '@ember/execution';
import { WorkerIdSchema } from '@ember/postgres';
import { readCommitmentTaskMarker } from './commitment-ports.js';
import type { WorkerLogger } from './logger.js';
import type { RunHandler, RunHandlerCompletion, RunHandlerFinalizer } from './run-handler.js';

export interface CommitmentRunHandlerDependencies {
  readonly contextReader: RunExecutionContextReader;
  /**
   * Authoritative Commitment/Occurrence store. Identity and terminal transitions always come
   * from PostgreSQL, never from the Task payload.
   */
  readonly store: Pick<
    DueCommitmentStore,
    'findOccurrenceExecutionIdentity' | 'finalizeOccurrenceFromTask'
  >;
  readonly orchestrator: CommitmentOrchestrator;
  readonly clock: ExecutionClock;
  /**
   * Identity of *this* Worker process. The persisted `runs.worker_id` must match it; a
   * mismatch means the execution context does not belong to this Worker and is refused.
   */
  readonly workerId: string;
  readonly logger: WorkerLogger;
}

/** Domain codes that can never succeed on retry for identical deterministic work. */
const TERMINAL_CODES: ReadonlySet<DomainErrorCode> = new Set<DomainErrorCode>([
  'POLICY_DENIED',
  'BUDGET_EXCEEDED',
  'INVALID_ARGUMENT',
  'INVALID_STATE_TRANSITION',
  'IDEMPOTENCY_CONFLICT',
  'DEADLINE_EXCEEDED',
]);

function hasValidPersistedRunIdentity(context: RunExecutionContext): boolean {
  return (
    IdSchema.safeParse(context.tenantId).success &&
    IdSchema.safeParse(context.taskId).success &&
    IdSchema.safeParse(context.runId).success &&
    IdSchema.safeParse(context.agentId).success &&
    Number.isSafeInteger(context.attempt) &&
    context.attempt > 0 &&
    Number.isSafeInteger(context.leaseEpoch) &&
    context.leaseEpoch >= 0 &&
    WorkerIdSchema.safeParse(context.workerId).success &&
    Number.isSafeInteger(context.policyVersion) &&
    context.policyVersion >= 1 &&
    context.kind === 'mock.compute'
  );
}

function hasValidOccurrenceIdentity(identity: OccurrenceExecutionIdentity): boolean {
  return (
    IdSchema.safeParse(identity.tenantId).success &&
    IdSchema.safeParse(identity.commitmentId).success &&
    IdSchema.safeParse(identity.occurrenceId).success &&
    IdSchema.safeParse(identity.agentId).success &&
    IdSchema.safeParse(identity.taskId).success &&
    SourceProfileIdSchema.safeParse(identity.sourceProfileId).success &&
    ScheduleKindSchema.safeParse(identity.scheduleKind).success &&
    OccurrenceStatusSchema.safeParse(identity.occurrenceStatus).success &&
    CommitmentStatusSchema.safeParse(identity.commitmentStatus).success
  );
}

function reasonCodeFor(error: unknown): 'sentinel_denied' | 'budget_exceeded' | 'execution_failed' {
  if (isDomainError(error) && error.code === 'BUDGET_EXCEEDED') {
    return 'budget_exceeded';
  }
  if (isDomainError(error) && error.code === 'POLICY_DENIED') {
    return 'sentinel_denied';
  }
  return 'execution_failed';
}

/**
 * Worker RunHandler for commitment occurrences dispatched to the durable Task Queue.
 *
 * Fail-closed rules:
 * 1. `workerId`, `sourceProfileId`, `scheduleKind`, `agentId` and the commitment linkage are
 *    resolved from persisted execution context. There is no `default`, no `once` fallback and
 *    no `worker-unknown`; a missing value is a refusal, not an assumption.
 * 2. Cancellation is checked before the identity read, before the orchestrator call, and at
 *    every orchestrator boundary; the database transaction remains the final authority.
 * 3. Permanent failures terminalize the Occurrence *after* the fenced `finish()` accepted the
 *    Run outcome, so an Occurrence can never disagree with its Task/Run.
 */
export function createCommitmentRunHandler(deps: CommitmentRunHandlerDependencies): RunHandler {
  const { contextReader, store, orchestrator, clock, workerId, logger } = deps;

  return {
    async handle(
      run: LeasedRun,
      signal: AbortSignal,
      preloadedContext?: RunExecutionContext,
    ): Promise<RunHandlerCompletion> {
      const baseLog = {
        taskId: run.taskId,
        runId: run.runId,
        attempt: run.attempt,
        leaseEpoch: run.leaseEpoch,
      };

      if (signal.aborted) {
        logger.info('Commitment execution cancelled before reading its context', baseLog);
        return { type: 'finish', outcome: 'cancelled' };
      }

      let context: RunExecutionContext;

      if (preloadedContext !== undefined) {
        context = preloadedContext;
      } else {
        try {
          context = await contextReader.read(run, clock.now());
        } catch (error) {
          if (
            isDomainError(error) &&
            (error.code === 'STALE_LEASE' || error.code === 'NOT_FOUND')
          ) {
            throw error;
          }
          logger.warn('Failed to read commitment execution context', {
            ...baseLog,
            error: error instanceof Error ? error.message : String(error),
          });
          return { type: 'finish', outcome: 'failed_retryable' };
        }
      }

      if (!hasValidPersistedRunIdentity(context)) {
        logger.error(
          'Persisted Run context is missing valid execution identity; refusing',
          baseLog,
        );
        return { type: 'finish', outcome: 'failed_terminal' };
      }

      if (
        context.tenantId !== run.tenantId ||
        context.taskId !== run.taskId ||
        context.runId !== run.runId ||
        context.attempt !== run.attempt ||
        context.leaseEpoch !== run.leaseEpoch
      ) {
        throw new DomainError(
          'STALE_LEASE',
          'Persisted Run identity does not match the claimed lease',
        );
      }

      // The lease owner recorded by PostgreSQL must be this process. It is never defaulted.
      const persistedWorkerId = context.workerId;

      if (
        typeof persistedWorkerId !== 'string' ||
        persistedWorkerId.trim().length === 0 ||
        persistedWorkerId !== workerId
      ) {
        logger.error('Commitment execution context is owned by another worker; refusing', {
          ...baseLog,
          hasPersistedWorkerId: typeof persistedWorkerId === 'string' && persistedWorkerId !== '',
          workerId,
        });
        return { type: 'finish', outcome: 'failed_terminal' };
      }

      const marker = readCommitmentTaskMarker(context.input);

      if (marker === null) {
        logger.error('Task is missing a valid commitment marker in its input', baseLog);
        return { type: 'finish', outcome: 'failed_terminal' };
      }

      const grant: WorkerLeaseGrant = {
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        attempt: run.attempt,
        leaseEpoch: context.leaseEpoch,
        workerId: persistedWorkerId,
      };

      let identity: OccurrenceExecutionIdentity | null;

      try {
        if (signal.aborted) {
          logger.info('Commitment execution cancelled before the identity read', baseLog);
          return { type: 'finish', outcome: 'cancelled' };
        }

        identity = await store.findOccurrenceExecutionIdentity(grant, marker.occurrenceId);
      } catch (error) {
        if (isDomainError(error) && (error.code === 'STALE_LEASE' || error.code === 'NOT_FOUND')) {
          throw error;
        }

        if (isDomainError(error) && error.code === 'INVALID_STATE_TRANSITION') {
          // The Occurrence is not bound to this Task yet (dispatch/bind race). The Scheduler's
          // reconcile step binds it; retrying is the correct, non-destructive response.
          logger.warn('Occurrence is not bound to this Task yet; retrying', baseLog);
          return { type: 'finish', outcome: 'failed_retryable' };
        }

        logger.error('Refusing to execute: occurrence identity could not be authenticated', {
          ...baseLog,
          code: isDomainError(error) ? error.code : 'UNEXPECTED',
        });
        return { type: 'finish', outcome: 'failed_terminal' };
      }

      if (identity === null) {
        logger.error('Refusing to execute: Task is not bound to an occurrence of this tenant', {
          ...baseLog,
          occurrenceId: marker.occurrenceId,
        });
        return { type: 'finish', outcome: 'failed_terminal' };
      }

      if (
        !hasValidOccurrenceIdentity(identity) ||
        identity.tenantId !== context.tenantId ||
        identity.taskId !== context.taskId ||
        identity.agentId !== context.agentId ||
        identity.occurrenceId !== marker.occurrenceId
      ) {
        logger.error('Persisted Occurrence identity is incomplete or inconsistent; refusing', {
          ...baseLog,
          occurrenceId: marker.occurrenceId,
        });
        return { type: 'finish', outcome: 'failed_terminal' };
      }

      const authenticated = identity;

      if (authenticated.commitmentId !== marker.commitmentId) {
        logger.error('Refusing to execute: occurrence does not belong to the marked commitment', {
          ...baseLog,
          occurrenceId: authenticated.occurrenceId,
        });
        return { type: 'finish', outcome: 'failed_terminal' };
      }

      const finalizeTerminal = (
        terminalStatus: 'failed' | 'cancelled',
        reasonCode:
          | 'sentinel_denied'
          | 'budget_exceeded'
          | 'execution_failed'
          | 'execution_cancelled'
          | 'commitment_cancelled',
      ): RunHandlerFinalizer => {
        return async (accepted: boolean): Promise<void> => {
          if (!accepted) {
            // `finish()` was rejected: this Worker no longer owns the Run, so it must not write
            // any commitment state either.
            logger.warn('Skipping occurrence finalization: the Run outcome was not accepted', {
              ...baseLog,
              occurrenceId: authenticated.occurrenceId,
            });
            return;
          }

          try {
            await store.finalizeOccurrenceFromTask(grant, {
              commitmentId: authenticated.commitmentId,
              occurrenceId: authenticated.occurrenceId,
              terminalStatus,
              reasonCode,
            });
          } catch (error) {
            // The Scheduler's terminal reconciliation is the backstop; never fail the Run twice.
            logger.warn('Failed to finalize terminal occurrence; reconciliation will retry', {
              ...baseLog,
              occurrenceId: authenticated.occurrenceId,
              code: isDomainError(error) ? error.code : 'UNEXPECTED',
            });
          }
        };
      };

      if (authenticated.occurrenceStatus === 'completed') {
        logger.info('Occurrence already completed; treating this Run as a successful replay', {
          ...baseLog,
          occurrenceId: authenticated.occurrenceId,
        });
        return { type: 'finish', outcome: 'succeeded' };
      }

      if (authenticated.occurrenceStatus === 'cancelled') {
        logger.info('Occurrence is already terminal; skipping execution', {
          ...baseLog,
          occurrenceStatus: authenticated.occurrenceStatus,
        });
        return { type: 'finish', outcome: 'cancelled' };
      }

      if (authenticated.occurrenceStatus === 'failed') {
        logger.info('Occurrence already failed; skipping duplicate execution', {
          ...baseLog,
          occurrenceId: authenticated.occurrenceId,
        });
        return { type: 'finish', outcome: 'failed_terminal' };
      }

      if (authenticated.commitmentStatus !== 'active') {
        logger.info('Commitment is no longer active; skipping execution', {
          ...baseLog,
          commitmentStatus: authenticated.commitmentStatus,
        });
        return {
          type: 'finish',
          outcome: 'cancelled',
          finalize: finalizeTerminal('cancelled', 'commitment_cancelled'),
        };
      }

      if (authenticated.occurrenceStatus !== 'dispatched') {
        logger.warn('Occurrence is not dispatched yet; retrying', {
          ...baseLog,
          occurrenceStatus: authenticated.occurrenceStatus,
        });
        return { type: 'finish', outcome: 'failed_retryable' };
      }

      if (signal.aborted) {
        logger.info('Commitment execution cancelled before orchestration', baseLog);
        return {
          type: 'finish',
          outcome: 'cancelled',
          finalize: finalizeTerminal('cancelled', 'execution_cancelled'),
        };
      }

      try {
        const result = await orchestrator.execute(
          grant,
          {
            tenantId: authenticated.tenantId,
            agentId: authenticated.agentId,
            commitmentId: authenticated.commitmentId,
            occurrenceId: authenticated.occurrenceId,
            sourceProfileId: authenticated.sourceProfileId,
            scheduleKind: authenticated.scheduleKind,
            policyVersion: context.policyVersion,
          },
          signal,
        );

        logger.info('Commitment occurrence execution completed', {
          ...baseLog,
          commitmentId: authenticated.commitmentId,
          occurrenceId: authenticated.occurrenceId,
          resultStatus: result.resultStatus,
          replayed: result.replayed,
        });

        return { type: 'finish', outcome: 'succeeded' };
      } catch (error) {
        if (signal.aborted) {
          logger.info('Commitment occurrence execution cancelled by signal', baseLog);
          return {
            type: 'finish',
            outcome: 'cancelled',
            finalize: finalizeTerminal('cancelled', 'execution_cancelled'),
          };
        }

        if (isDomainError(error) && error.code === 'POLICY_DENIED') {
          // Commitment cancellation does not necessarily abort the Task's Run signal. It races
          // against the final PostgreSQL publication fence instead, so re-read the persisted
          // state before classifying the denial as a permanent execution failure. When cancel()
          // won, converge the Task/Run to cancelled and leave the already-cancelled Occurrence
          // untouched; a consent/Sentinel denial on an active Commitment remains terminal-fail.
          try {
            const latest = await store.findOccurrenceExecutionIdentity(
              grant,
              authenticated.occurrenceId,
            );

            if (
              latest !== null &&
              (latest.commitmentStatus === 'cancelled' || latest.occurrenceStatus === 'cancelled')
            ) {
              const reasonCode =
                latest.commitmentStatus === 'cancelled'
                  ? 'commitment_cancelled'
                  : 'execution_cancelled';
              return {
                type: 'finish',
                outcome: 'cancelled',
                finalize: finalizeTerminal('cancelled', reasonCode),
              };
            }
          } catch (refreshError) {
            if (
              isDomainError(refreshError) &&
              (refreshError.code === 'STALE_LEASE' || refreshError.code === 'NOT_FOUND')
            ) {
              throw refreshError;
            }

            logger.warn('Could not refresh Commitment cancellation state after policy denial', {
              ...baseLog,
              code: isDomainError(refreshError) ? refreshError.code : 'UNEXPECTED',
            });
          }
        }

        if (isDomainError(error)) {
          if (error.code === 'STALE_LEASE' || error.code === 'NOT_FOUND') {
            // The lease is gone: never `finish()`, never write commitment state.
            throw error;
          }

          if (error.code === 'CANCELLED') {
            return {
              type: 'finish',
              outcome: 'cancelled',
              finalize: finalizeTerminal('cancelled', 'execution_cancelled'),
            };
          }

          if (TERMINAL_CODES.has(error.code)) {
            logger.warn('Commitment occurrence execution failed permanently', {
              ...baseLog,
              code: error.code,
            });
            return {
              type: 'finish',
              outcome: 'failed_terminal',
              finalize: finalizeTerminal('failed', reasonCodeFor(error)),
            };
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
