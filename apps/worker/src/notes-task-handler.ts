import {
  NotesActionItemsInputSchema,
  type CommitReceipt,
  type RouteDecision,
  type RunExecutionContext,
  type RunExecutionContextReader,
} from '@ember/contracts';
import {
  DomainError,
  isDomainError,
  type DomainErrorCode,
  type LeasedRun,
  type NotesActionItemsInput,
  type RunTerminalStatus,
} from '@ember/domain';
import {
  evaluateSentinelPolicy,
  resolveSentinelCategory,
  toSentinelDeniedError,
  type ExecutionClock,
  type ExecutionRouterForRun,
  type SentinelPolicy,
} from '@ember/execution';
import {
  MODEL_LIMITS,
  ModelInputRefused,
  estimateCostMicroUsd,
  isModelGatewayFailure,
  isRetryableModelFailure,
  preflightNotesActionItems,
  type ModelFailureCode,
  type ModelGateway,
  type ModelGatewayFailureDiagnostic,
  type ModelRateRow,
  type ModelUsage,
  type NotesActionItemsOutput,
} from '@ember/model-gateway';
import type {
  NotesAttemptCharge,
  NotesCommitCompletionCommand,
  NotesCommitResult,
  NotesReserveAttemptCommand,
  NotesReserveOutcome,
  RetryPolicyConfig,
} from '@ember/postgres';
import type { WorkerLogger } from './logger.js';
import type { RunHandler, RunHandlerCompletion } from './run-handler.js';

/** Persistence port required to execute `notes.action_items` Tasks with fenced spend tracking. */
export interface NotesTaskExecutionRepositoryPort {
  reserveAttempt(command: NotesReserveAttemptCommand): Promise<NotesReserveOutcome>;
  markAttemptSent(command: {
    readonly lease: LeasedRun;
    readonly attemptNo: number;
  }): Promise<boolean>;
  settleAttempt(charge: NotesAttemptCharge): Promise<unknown>;
  commitCompletion(command: NotesCommitCompletionCommand): Promise<NotesCommitResult>;
}

export interface NotesTaskHandlerDependencies {
  readonly mode: 'fake' | 'real';
  readonly contextReader: RunExecutionContextReader;
  readonly router: ExecutionRouterForRun;
  readonly repository: NotesTaskExecutionRepositoryPort;
  readonly gateway: ModelGateway;
  readonly policy: RetryPolicyConfig;
  readonly ceilings: {
    readonly perAttemptMicroUsd: number;
    readonly principalDailyMicroUsd: number;
    readonly tenantDailyMicroUsd: number;
    readonly globalDailyMicroUsd: number;
  };
  readonly maxAttemptsPerTask: number;
  readonly maxTaskCostMicroUsd: number;
  readonly attemptTimeoutMs: number;
  readonly rate: ModelRateRow | null;
  readonly clock: ExecutionClock;
  readonly logger: WorkerLogger;
  readonly sentinelPolicy?:
    SentinelPolicy | ((context: RunExecutionContext) => SentinelPolicy | undefined);
}

type NotesGatewayResult =
  | {
      readonly kind: 'success';
      readonly output: NotesActionItemsOutput;
      readonly modelLabel: string;
      readonly simulated: boolean;
      readonly usage: ModelUsage | null;
    }
  | {
      readonly kind: 'failure';
      readonly code: ModelFailureCode;
      readonly diagnostic: ModelGatewayFailureDiagnostic | null;
    };

const RETRYABLE_EXECUTION_CODES: ReadonlySet<DomainErrorCode> = new Set<DomainErrorCode>([
  'DB_UNAVAILABLE',
  'EXECUTION_TIMEOUT',
]);

function codeOf(error: unknown): DomainErrorCode | 'UNEXPECTED' {
  return isDomainError(error) ? error.code : 'UNEXPECTED';
}

function classifyExecutionFailure(error: unknown): RunTerminalStatus {
  if (!isDomainError(error)) {
    return 'failed_terminal';
  }
  if (error.code === 'CANCELLED') {
    return 'cancelled';
  }
  return RETRYABLE_EXECUTION_CODES.has(error.code) ? 'failed_retryable' : 'failed_terminal';
}

function toCommittedReceipt(
  run: LeasedRun,
  attemptNo: number,
  committedAt: string,
): RunHandlerCompletion {
  const receipt: CommitReceipt = {
    operationId: `notes:${run.taskId}:${run.runId}:attempt:${attemptNo}`,
    mode: 'result',
    taskId: run.taskId,
    runId: run.runId,
    attempt: run.attempt,
    leaseEpoch: run.leaseEpoch,
    artifactIds: [],
    workspaceVersion: null,
    checkpointId: null,
    replayed: false,
    committedAt,
  };
  return { type: 'committed', receipt };
}

function reserveCostMicroUsd(
  rate: ModelRateRow,
  ceilings: NotesTaskHandlerDependencies['ceilings'],
  inputTokens: number,
  maxOutputTokens: number,
): number {
  const capMicroUsd = Math.min(
    ceilings.perAttemptMicroUsd,
    MODEL_LIMITS.maxReservedMicroUsdPerAttempt,
  );
  const worstCase = estimateCostMicroUsd(rate, inputTokens, maxOutputTokens);
  const reservation = Math.max(worstCase, 1);

  if (reservation > capMicroUsd) {
    throw new ModelInputRefused('reservation_cap_exceeded');
  }

  return reservation;
}

async function resolveAbortAsCancellationOrThrow(
  run: LeasedRun,
  deps: Pick<NotesTaskHandlerDependencies, 'contextReader' | 'clock'>,
): Promise<RunHandlerCompletion> {
  try {
    await deps.contextReader.read(run, deps.clock.now());
  } catch (error) {
    if (isDomainError(error) && (error.code === 'STALE_LEASE' || error.code === 'NOT_FOUND')) {
      throw error;
    }
    if (isDomainError(error) && error.code === 'CANCELLED') {
      return { type: 'finish', outcome: 'cancelled' };
    }
    throw error;
  }

  throw new DomainError('EXECUTION_TIMEOUT', 'run execution aborted');
}

async function callNotesGateway(
  deps: Pick<NotesTaskHandlerDependencies, 'gateway' | 'attemptTimeoutMs' | 'clock'>,
  context: RunExecutionContext,
  input: NotesActionItemsInput,
  signal: AbortSignal,
): Promise<NotesGatewayResult> {
  const remainingDeadlineMs =
    context.deadlineAt === null
      ? MODEL_LIMITS.attemptTimeoutMs
      : Math.max(1, Date.parse(context.deadlineAt) - deps.clock.now().getTime());
  const timeoutMs = Math.min(
    deps.attemptTimeoutMs,
    MODEL_LIMITS.attemptTimeoutMs,
    remainingDeadlineMs,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();

  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const result = await deps.gateway.extractNotesActionItems(
      {
        taskId: context.taskId,
        notes: input.notes,
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      },
      controller.signal,
    );

    return {
      kind: 'success',
      output: result.output,
      modelLabel: result.modelLabel,
      simulated: result.simulated,
      usage: result.usage,
    };
  } catch (error) {
    if (isModelGatewayFailure(error)) {
      return { kind: 'failure', code: error.code, diagnostic: error.diagnostic };
    }
    return { kind: 'failure', code: 'model_invalid_output', diagnostic: null };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function commitNotesResult(
  deps: Pick<NotesTaskHandlerDependencies, 'repository' | 'policy' | 'clock' | 'logger'>,
  run: LeasedRun,
  route: RouteDecision,
  startedAtHr: number,
  attemptNo: number,
  gatewayResult: Extract<NotesGatewayResult, { readonly kind: 'success' }>,
): Promise<RunHandlerCompletion> {
  const durationMs = Math.max(0, Math.round(performance.now() - startedAtHr));
  const result = await deps.repository.commitCompletion({
    lease: run,
    policy: deps.policy,
    durationMs,
    summaryText: gatewayResult.output.summaryText,
    detailText: gatewayResult.output.detailText,
    truncated: gatewayResult.output.truncated,
    modelLabel: gatewayResult.modelLabel,
    simulated: gatewayResult.simulated,
  });

  deps.logger.info('notes task execution finished', {
    taskId: run.taskId,
    runId: run.runId,
    attempt: run.attempt,
    leaseEpoch: run.leaseEpoch,
    taskKind: 'notes.action_items',
    route: route.path,
    outcome: result.outcome,
    durationMs,
    simulated: gatewayResult.simulated,
  });

  return toCommittedReceipt(run, attemptNo, deps.clock.now().toISOString());
}

/**
 * Durable execution handler for `notes.action_items` Tasks.
 *
 * Keeps the worker's lease + context fencing intact while enforcing per-Task attempt/cost
 * ceilings and shared daily budget buckets in `PostgresNotesTaskExecutionRepository`.
 */
export function createNotesTaskHandler(deps: NotesTaskHandlerDependencies): RunHandler {
  if (!Number.isInteger(deps.attemptTimeoutMs) || deps.attemptTimeoutMs < 1) {
    throw new TypeError('attemptTimeoutMs must be a positive integer');
  }

  if (
    !Number.isInteger(deps.maxAttemptsPerTask) ||
    deps.maxAttemptsPerTask < 1 ||
    deps.maxAttemptsPerTask > MODEL_LIMITS.maxModelAttemptsPerTask
  ) {
    throw new TypeError(
      `maxAttemptsPerTask must be an integer between 1 and ${MODEL_LIMITS.maxModelAttemptsPerTask}`,
    );
  }

  if (
    !Number.isInteger(deps.maxTaskCostMicroUsd) ||
    deps.maxTaskCostMicroUsd < 1 ||
    deps.maxTaskCostMicroUsd > MODEL_LIMITS.maxModelCostPerTaskMicroUsd
  ) {
    throw new TypeError(
      `maxTaskCostMicroUsd must be an integer between 1 and ${MODEL_LIMITS.maxModelCostPerTaskMicroUsd}`,
    );
  }

  if (deps.mode === 'real' && deps.rate === null) {
    throw new TypeError('real mode requires a pinned rate row');
  }

  if (deps.mode === 'real' && deps.gateway.providerId === 'fake') {
    throw new TypeError('real mode requires a real provider gateway');
  }

  const providerId: 'openai' | 'openrouter' =
    deps.gateway.providerId === 'openrouter' ? 'openrouter' : 'openai';

  const settleSafe = async (
    run: LeasedRun,
    attemptNo: number,
    charge: Omit<NotesAttemptCharge, 'tenantId' | 'taskId' | 'attemptNo'>,
  ): Promise<void> => {
    await deps.repository.settleAttempt({
      tenantId: run.tenantId,
      taskId: run.taskId,
      attemptNo,
      ...charge,
    });
  };

  return {
    async handle(
      run: LeasedRun,
      signal: AbortSignal,
      preloadedContext?: RunExecutionContext,
    ): Promise<RunHandlerCompletion> {
      const startedAtHr = performance.now();
      const base = {
        taskId: run.taskId,
        runId: run.runId,
        attempt: run.attempt,
        leaseEpoch: run.leaseEpoch,
      } as const;

      let context: RunExecutionContext;

      try {
        context = preloadedContext ?? (await deps.contextReader.read(run, deps.clock.now()));
      } catch (error) {
        if (isDomainError(error) && (error.code === 'STALE_LEASE' || error.code === 'NOT_FOUND')) {
          throw error;
        }
        const outcome = classifyExecutionFailure(error);
        deps.logger.warn('notes execution context unavailable', {
          ...base,
          code: codeOf(error),
          outcome,
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        return { type: 'finish', outcome };
      }

      if (context.kind !== 'notes.action_items') {
        deps.logger.warn('notes handler invoked for unexpected task kind', {
          ...base,
          taskKind: context.kind,
        });
        return { type: 'finish', outcome: 'failed_terminal' };
      }

      const parsedInput = NotesActionItemsInputSchema.safeParse(context.input);
      if (!parsedInput.success) {
        deps.logger.warn('notes task input failed schema validation', {
          ...base,
          taskKind: context.kind,
        });
        return { type: 'finish', outcome: 'failed_terminal' };
      }

      let route: RouteDecision;

      try {
        route = await deps.router.decideForExecution({
          policyVersion: context.policyVersion,
          kind: context.kind,
          input: context.input,
        });

        const policy =
          typeof deps.sentinelPolicy === 'function'
            ? deps.sentinelPolicy(context)
            : deps.sentinelPolicy;

        const decision = evaluateSentinelPolicy(policy, {
          tenantId: context.tenantId,
          runId: context.runId,
          taskId: context.taskId,
          actionCategory: resolveSentinelCategory(context.kind, 'produce'),
          policyVersion: context.policyVersion,
        });

        if (decision.verdict !== 'allow') {
          throw toSentinelDeniedError(decision);
        }
      } catch (error) {
        const outcome = classifyExecutionFailure(error);
        deps.logger.warn('notes execution gate denied', {
          ...base,
          taskKind: context.kind,
          code: codeOf(error),
          outcome,
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        return { type: 'finish', outcome };
      }

      try {
        const preflight = preflightNotesActionItems({
          notes: parsedInput.data.notes,
          ...(parsedInput.data.instructions === undefined
            ? {}
            : { instructions: parsedInput.data.instructions }),
          maxOutputTokens: MODEL_LIMITS.notesMaxOutputTokens,
        });

        if (deps.mode === 'fake') {
          if (signal.aborted) {
            return await resolveAbortAsCancellationOrThrow(run, deps);
          }

          const gatewayResult = await callNotesGateway(deps, context, parsedInput.data, signal);

          if (signal.aborted) {
            return await resolveAbortAsCancellationOrThrow(run, deps);
          }

          if (gatewayResult.kind === 'failure') {
            deps.logger.warn('fake notes gateway failed', {
              ...base,
              taskKind: context.kind,
              failureCode: gatewayResult.code,
            });
            return {
              type: 'finish',
              outcome: isRetryableModelFailure(gatewayResult.code)
                ? 'failed_retryable'
                : 'failed_terminal',
            };
          }

          return await commitNotesResult(deps, run, route, startedAtHr, 0, gatewayResult);
        }

        const rate = deps.rate;
        if (rate === null) {
          throw new TypeError('real mode requires a pinned rate row');
        }

        const reservedMicroUsd = reserveCostMicroUsd(
          rate,
          deps.ceilings,
          preflight.inputTokens,
          preflight.maxOutputTokens,
        );

        for (let iteration = 0; iteration < deps.maxAttemptsPerTask; iteration += 1) {
          if (signal.aborted) {
            return await resolveAbortAsCancellationOrThrow(run, deps);
          }

          const reservation = await deps.repository.reserveAttempt({
            lease: run,
            ceilings: {
              perAttemptMicroUsd: deps.ceilings.perAttemptMicroUsd,
              principalDailyMicroUsd: deps.ceilings.principalDailyMicroUsd,
              tenantDailyMicroUsd: deps.ceilings.tenantDailyMicroUsd,
              globalDailyMicroUsd: deps.ceilings.globalDailyMicroUsd,
            },
            maxAttemptsPerTask: deps.maxAttemptsPerTask,
            maxTaskCostMicroUsd: deps.maxTaskCostMicroUsd,
            reservedMicroUsd,
            rateVersion: rate.rateVersion,
            providerId,
            modelLabel: deps.gateway.modelLabel,
          });

          if (reservation.kind === 'lease_lost') {
            throw new DomainError(
              'STALE_LEASE',
              'notes attempt reservation refused by lease fence',
            );
          }

          if (reservation.kind === 'cancelled') {
            return { type: 'finish', outcome: 'cancelled' };
          }

          if (reservation.kind === 'deadline_exceeded') {
            return { type: 'finish', outcome: 'failed_terminal' };
          }

          if (
            reservation.kind === 'task_budget_exhausted' ||
            reservation.kind === 'budget_exceeded' ||
            reservation.kind === 'budget_halted' ||
            reservation.kind === 'principal_unavailable'
          ) {
            deps.logger.warn('notes model execution stopped by budget/attempt cap', {
              ...base,
              taskKind: context.kind,
              kind: reservation.kind,
            });
            return { type: 'finish', outcome: 'failed_terminal' };
          }

          const attemptNo = reservation.attempt.attemptNo;
          const sent = await deps.repository.markAttemptSent({ lease: run, attemptNo });

          if (!sent) {
            await settleSafe(run, attemptNo, { state: 'released', outcomeCode: 'not_sent' });
            throw new DomainError('STALE_LEASE', 'notes attempt send CAS refused by lease fence');
          }

          const gatewayResult = await callNotesGateway(deps, context, parsedInput.data, signal);

          if (gatewayResult.kind === 'success') {
            if (gatewayResult.usage === null) {
              await settleSafe(run, attemptNo, {
                state: 'conservative_billed',
                outcomeCode: 'usage_missing',
              });
            } else {
              await settleSafe(run, attemptNo, {
                state: 'settled',
                outcomeCode: 'ok',
                observedCostMicroUsd: gatewayResult.usage.costMicroUsd,
                inputTokens: gatewayResult.usage.inputTokens,
                outputTokens: gatewayResult.usage.outputTokens,
              });
            }

            if (signal.aborted) {
              return await resolveAbortAsCancellationOrThrow(run, deps);
            }

            return await commitNotesResult(deps, run, route, startedAtHr, attemptNo, gatewayResult);
          }

          if (gatewayResult.code === 'not_sent') {
            await settleSafe(run, attemptNo, { state: 'released', outcomeCode: 'not_sent' });
            return { type: 'finish', outcome: 'failed_terminal' };
          }

          await settleSafe(run, attemptNo, {
            state: 'unknown_billed',
            outcomeCode: signal.aborted ? 'client_cancelled' : gatewayResult.code,
          });

          if (signal.aborted) {
            return await resolveAbortAsCancellationOrThrow(run, deps);
          }

          if (
            !isRetryableModelFailure(gatewayResult.code) ||
            attemptNo >= deps.maxAttemptsPerTask
          ) {
            return { type: 'finish', outcome: 'failed_terminal' };
          }
        }

        return { type: 'finish', outcome: 'failed_terminal' };
      } catch (error) {
        if (isDomainError(error) && (error.code === 'STALE_LEASE' || error.code === 'NOT_FOUND')) {
          throw error;
        }
        if (error instanceof ModelInputRefused) {
          deps.logger.warn('notes task input refused before egress', {
            ...base,
            taskKind: context.kind,
            reason: error.reason,
          });
          return { type: 'finish', outcome: 'failed_terminal' };
        }
        const outcome = classifyExecutionFailure(error);
        deps.logger.warn('notes task execution failed', {
          ...base,
          taskKind: context.kind,
          code: codeOf(error),
          outcome,
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        return { type: 'finish', outcome };
      }
    },
  };
}
