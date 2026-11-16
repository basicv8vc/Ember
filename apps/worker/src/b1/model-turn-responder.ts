import type { B1AssistantTurnDto } from '@ember/contracts';
import { realSleeper, type Sleeper } from '@ember/execution';
import {
  MODEL_LIMITS,
  ModelInputRefused,
  buildBoundedContext,
  estimateCostMicroUsd,
  isModelGatewayFailure,
  isRetryableModelFailure,
  preflightConversationTurn,
  type ConversationTurnOutput,
  type ModelBudgetCeilings,
  type ModelFailureCode,
  type ModelGatewayFailureDiagnostic,
  type ModelGateway,
  type ModelMessage,
  type ModelRateRow,
  type ModelUsage,
} from '@ember/model-gateway';
import type {
  B2AttemptCharge,
  B2ClaimOutcome,
  B2PublicationResult,
  B2ReserveOutcome,
  B2SettlementOutcome,
  B2TaskDelegationCommand,
  B2TurnContextRow,
  B2TurnLease,
} from '@ember/postgres';
import { safeWorkerErrorCategory, type WorkerLogger } from '../logger.js';

export const MODEL_TURN_BATCH_SIZE = 5;
export const MODEL_TURN_POLL_INTERVAL_MS = 500;
export const MODEL_TURN_ERROR_BACKOFF_MS = 1_000;

export interface PendingModelTurn {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly turnId: string;
}

/**
 * The persistence seam the responder needs.
 *
 * Every method is a short transaction: the responder never holds a connection across the provider
 * call, which is the one rule that keeps a slow provider from becoming a database outage.
 */
export interface ModelTurnExecutionPort {
  listRunningTurns(
    limit?: number,
    onlyTurn?: PendingModelTurn,
  ): Promise<readonly PendingModelTurn[]>;
  claimTurn(command: {
    readonly turn: PendingModelTurn;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<B2ClaimOutcome>;
  loadTurnContext(command: {
    readonly turn: PendingModelTurn;
    readonly maxMessages: number;
  }): Promise<readonly B2TurnContextRow[]>;
  reserveAttempt(command: {
    readonly lease: B2TurnLease;
    readonly ceilings: ModelBudgetCeilings;
    readonly maxAttempts: number;
    readonly reservedMicroUsd: number;
    readonly rateVersion: string;
    readonly providerId: 'openai' | 'openrouter';
    readonly modelLabel: string;
  }): Promise<B2ReserveOutcome>;
  markAttemptSent(command: {
    readonly lease: B2TurnLease;
    readonly attemptNo: number;
  }): Promise<boolean>;
  settleAttempt(charge: B2AttemptCharge): Promise<B2SettlementOutcome>;
  publishCompletion(command: {
    readonly lease: B2TurnLease;
    readonly result:
      | {
          readonly status: 'completed';
          readonly text: string;
          readonly modelLabel: string;
          readonly simulated: boolean;
          readonly delegation?: B2TaskDelegationCommand;
        }
      | {
          readonly status: 'failed';
          readonly failureReason: 'timeout' | 'internal_error';
        };
  }): Promise<B2PublicationResult>;
  expireTurnIfDue(command: PendingModelTurn): Promise<B1AssistantTurnDto | null>;
}

/**
 * The three fields every persistence method accepts.
 *
 * A lease carries more than an identity and the repository schemas are strict, so an identity is
 * projected explicitly rather than passed by structural assumption.
 */
function identityOf(turn: PendingModelTurn): PendingModelTurn {
  return {
    tenantId: turn.tenantId,
    conversationId: turn.conversationId,
    turnId: turn.turnId,
  };
}

/** How one turn finished, for the loop's summary counters. Field names are the counters. */
export type ModelTurnOutcome =
  | 'completed'
  | 'failed'
  | 'timedOut'
  | 'budgetDenied'
  | 'halted'
  | 'fenced'
  | 'skipped'
  | 'expired';

export interface ModelTurnResponderSummary {
  readonly examined: number;
  readonly completed: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly budgetDenied: number;
  /** Refused because an unresolved budget incident already applies to the caller. */
  readonly halted: number;
  readonly fenced: number;
  readonly expired: number;
  readonly skipped: number;
  /**
   * The pass did nothing because another pass was already running in this process.
   *
   * It exists so a concurrent entry is visible in the loop's own output instead of looking like an
   * empty poll — an empty poll would be indistinguishable from "no work", which is how a
   * concurrency bug hides.
   */
  readonly busy: boolean;
}

export interface ModelTurnResponderOptions {
  /** `fake` never touches the money ledger; `real` always does. */
  readonly mode: 'fake' | 'real';
  readonly repository: ModelTurnExecutionPort;
  readonly gateway: ModelGateway;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly ceilings: ModelBudgetCeilings;
  readonly maxAttempts: number;
  readonly attemptTimeoutMs: number;
  /** Required in `real` mode; absent in `fake` mode, which has no priced call. */
  readonly rate: ModelRateRow | null;
  /** Optional exact scope for one-shot operator tools such as `pnpm model:smoke`. */
  readonly onlyTurn?: PendingModelTurn;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly errorBackoffMs?: number;
  readonly sleep?: Sleeper;
  readonly logger?: Pick<WorkerLogger, 'warn'>;
  /** Invoked when a completed Turn atomically delegates to a persistent Task. */
  readonly onTaskDelegated?: (event: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly turnId: string;
    readonly taskId: string;
    readonly toolName?: 'delegate_notes_action_items' | 'delegate_python_agent';
  }) => void;
}

export interface ModelTurnResponderRunner {
  stop(): void;
  readonly done: Promise<void>;
}

interface GatewaySuccess {
  readonly kind: 'success';
  readonly output: ConversationTurnOutput;
  readonly modelLabel: string;
  readonly simulated: boolean;
  /** `null` when the provider answered without reporting usage: an unknown charge, never a free one. */
  readonly usage: ModelUsage | null;
}

interface GatewayFailure {
  readonly kind: 'failure';
  readonly code: ModelFailureCode;
  readonly diagnostic: ModelGatewayFailureDiagnostic | null;
}

/**
 * B2 Assistant Turn responder.
 *
 * It replaces only the responder behind B1-5's seam: the Turn table, its statuses, the 60 s
 * deadline, the single reply rule and the transcript are B1's and are not duplicated here.
 *
 * Order of operations per turn, each step a separate short transaction:
 *
 * ```text
 * claim (lease_epoch += 1)      -> loser makes zero provider calls
 * deadline sweep (DB clock)     -> an expired turn never reaches a provider
 * reserve money + open attempt  -> any bucket over its ceiling: zero calls
 * one-send CAS                  -> at most one outbound start per attempt number
 * provider call, no transaction held
 * settle attempt                -> pessimistic on anything ambiguous
 * fenced publish                -> cancellation/timeout/lease loss discards the text
 * ```
 */
export function createModelTurnResponder(options: ModelTurnResponderOptions): {
  processOnce(signal?: AbortSignal): Promise<ModelTurnResponderSummary>;
  start(signal?: AbortSignal): ModelTurnResponderRunner;
} {
  const batchSize = options.batchSize ?? MODEL_TURN_BATCH_SIZE;
  const intervalMs = options.intervalMs ?? MODEL_TURN_POLL_INTERVAL_MS;
  const errorBackoffMs = options.errorBackoffMs ?? MODEL_TURN_ERROR_BACKOFF_MS;
  const wait = options.sleep ?? realSleeper;

  for (const [name, value] of [
    ['batchSize', batchSize],
    ['intervalMs', intervalMs],
    ['errorBackoffMs', errorBackoffMs],
    ['leaseMs', options.leaseMs],
    ['maxAttempts', options.maxAttempts],
    ['attemptTimeoutMs', options.attemptTimeoutMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive integer`);
    }
  }

  if (options.mode === 'real' && options.rate === null) {
    throw new TypeError('real mode requires a pinned rate row');
  }

  if (options.mode === 'real' && options.gateway.providerId === 'fake') {
    throw new TypeError('real mode requires a real provider gateway');
  }

  const reservationProviderId: 'openai' | 'openrouter' =
    options.gateway.providerId === 'openrouter' ? 'openrouter' : 'openai';

  const counters = (): Record<ModelTurnOutcome, number> & {
    examined: number;
    busy: boolean;
  } => ({
    examined: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
    budgetDenied: 0,
    halted: 0,
    fenced: 0,
    expired: 0,
    skipped: 0,
    busy: false,
  });

  /**
   * Per-process concurrency gate for paid work.
   *
   * One responder instance runs at most one Turn at a time. `processOnce` is written sequentially, so
   * today this can only trip when the same instance is entered twice — a second `start()`, or a
   * caller racing the loop. That is exactly the case that would otherwise put two paid requests in
   * flight from one process and double the spend the ledger reserved for one.
   *
   * It is deliberately *not* a distributed semaphore. Across replicas, concurrency is bounded by the
   * money ledger (a reservation that does not fit is refused) and by claim leasing (one owner per
   * Turn), not by a counter here. A cross-process cap would need a row of its own and is out of scope
   * for L4-B; the review document states this rather than implying a guarantee.
   */
  let passInFlight = false;

  /**
   * Worst-case reservation for one attempt, or a refusal.
   *
   * The reservation is priced from the conservative token estimate at the pinned rate for
   * `maxOutputTokens`, i.e. for the largest bill this request can plausibly produce. If that exceeds
   * the per-attempt cap the call is **refused before any attempt row exists**, rather than clamped to
   * the cap and sent anyway: clamping reserved $0.005 for a request that can cost $0.02, which is a
   * spend ceiling that silently does not hold. The cap is a limit, not a target.
   *
   * `Math.max(..., 1)` is a floor, not a truncation: the ledger's smallest hold is one micro-USD.
   */
  const reserveMicroUsd = (inputTokens: number): number => {
    const capMicroUsd = Math.min(
      options.ceilings.perAttemptMicroUsd,
      MODEL_LIMITS.maxReservedMicroUsdPerAttempt,
    );

    if (options.mode === 'fake' || options.rate === null) {
      return capMicroUsd;
    }

    const worstCaseMicroUsd = estimateCostMicroUsd(
      options.rate,
      inputTokens,
      MODEL_LIMITS.maxOutputTokens,
    );
    const reservation = Math.max(worstCaseMicroUsd, 1);

    if (reservation > capMicroUsd) {
      throw new ModelInputRefused('reservation_cap_exceeded');
    }

    return reservation;
  };

  /**
   * One bounded provider call.
   *
   * The attempt timeout and the worker shutdown signal share one `AbortController`, so a slow
   * provider and a stopping worker take the identical code path.
   */
  const callGateway = async (
    lease: B2TurnLease,
    context: readonly ModelMessage[],
    signal: AbortSignal | undefined,
  ): Promise<GatewaySuccess | GatewayFailure> => {
    const remainingMs = Math.max(1, Date.parse(lease.deadlineAt) - Date.now());
    const timeoutMs = Math.min(
      options.attemptTimeoutMs,
      remainingMs,
      MODEL_LIMITS.attemptTimeoutMs,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();

    if (signal?.aborted === true) {
      controller.abort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const result = await options.gateway.generateConversationTurn(
        {
          conversationId: lease.conversationId,
          turnId: lease.turnId,
          context,
          maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
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

      // Anything else is our own defect, not a provider signal: it must not be retried with money.
      return { kind: 'failure', code: 'model_invalid_output', diagnostic: null };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  const toDelegationCommand = (
    output: ConversationTurnOutput,
  ): B2TaskDelegationCommand | undefined => {
    if (output.kind !== 'delegate') {
      return undefined;
    }

    if (output.delegation.toolName === 'delegate_python_agent') {
      const args = output.delegation.arguments;
      return {
        toolName: 'delegate_python_agent',
        ...(args.title === undefined ? {} : { title: args.title }),
        input: {
          prompt: args.prompt,
          ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
          ...(args.attachmentIds === undefined || args.attachmentIds.length === 0
            ? {}
            : { attachmentIds: args.attachmentIds }),
        },
      };
    }

    const args = output.delegation.arguments;
    return {
      toolName: output.delegation.toolName,
      ...(args.title === undefined ? {} : { title: args.title }),
      input: {
        notes: args.notes,
        ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
      },
    };
  };

  const publishGatewaySuccess = async (
    lease: B2TurnLease,
    result: GatewaySuccess,
  ): Promise<ModelTurnOutcome> => {
    const delegation = toDelegationCommand(result.output);
    const published = await options.repository.publishCompletion({
      lease,
      result: {
        status: 'completed',
        text: result.output.text,
        modelLabel: result.modelLabel,
        simulated: result.simulated,
        ...(delegation === undefined ? {} : { delegation }),
      },
    });

    if (published.outcome === 'fenced') {
      return 'fenced';
    }

    if (published.delegatedTaskId !== null && published.delegatedTaskId !== undefined) {
      options.onTaskDelegated?.({
        tenantId: lease.tenantId,
        conversationId: lease.conversationId,
        turnId: lease.turnId,
        taskId: published.delegatedTaskId,
        ...(delegation === undefined ? {} : { toolName: delegation.toolName }),
      });
    }

    return 'completed';
  };

  const settle = async (
    lease: B2TurnLease,
    attemptNo: number,
    charge: Omit<B2AttemptCharge, 'tenantId' | 'turnId' | 'attemptNo'>,
  ): Promise<void> => {
    await options.repository.settleAttempt({
      tenantId: lease.tenantId,
      turnId: lease.turnId,
      attemptNo,
      ...charge,
    });
  };

  const terminalFailure = async (
    lease: B2TurnLease,
    failureReason: 'timeout' | 'internal_error',
  ): Promise<ModelTurnOutcome> => {
    const published = await options.repository.publishCompletion({
      lease,
      result: { status: 'failed', failureReason },
    });

    if (published.outcome === 'fenced') {
      return 'fenced';
    }

    return failureReason === 'timeout' ? 'timedOut' : 'failed';
  };

  const runTurn = async (
    lease: B2TurnLease,
    signal: AbortSignal | undefined,
  ): Promise<ModelTurnOutcome> => {
    const context = await options.repository.loadTurnContext({
      // Only the identity: the persistence boundary accepts exactly these three fields, so a lease
      // can never be mistaken for a row snapshot.
      turn: identityOf(lease),
      maxMessages: MODEL_LIMITS.maxContextMessages,
    });

    const bounded = buildBoundedContext(context);
    const preflight = preflightConversationTurn({
      messages: bounded.messages,
      maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
    });

    // `fake` mode is a labelled, zero-cost path: no attempt row, no reservation, no provider.
    if (options.mode === 'fake') {
      const result = await callGateway(lease, bounded.messages, signal);

      if (result.kind === 'failure' || signal?.aborted === true) {
        return terminalFailure(lease, 'internal_error');
      }

      return await publishGatewaySuccess(lease, result);
    }

    const rate = options.rate;

    if (rate === null) {
      throw new TypeError('real mode requires a pinned rate row');
    }

    // Priced once, before the first attempt row exists. A refusal here means zero rows, zero bytes
    // and zero spend — the only acceptable outcome when the worst case does not fit the cap.
    const reservedMicroUsd = reserveMicroUsd(preflight.inputTokens);

    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      const reservation = await options.repository.reserveAttempt({
        lease,
        ceilings: options.ceilings,
        maxAttempts: options.maxAttempts,
        reservedMicroUsd,
        rateVersion: rate.rateVersion,
        providerId: reservationProviderId,
        modelLabel: options.gateway.modelLabel,
      });

      if (reservation.kind === 'lease_lost') {
        return 'fenced';
      }

      if (reservation.kind === 'attempts_exhausted') {
        return await terminalFailure(lease, 'internal_error');
      }

      if (reservation.kind === 'principal_unavailable') {
        // No server-derived principal means no per-user metering: fail closed before any egress.
        return await terminalFailure(lease, 'internal_error');
      }

      if (reservation.kind === 'budget_exceeded') {
        // A hard refusal is a user-visible failure, not a silent downgrade to fake output.
        return await terminalFailure(lease, 'internal_error');
      }

      if (reservation.kind === 'budget_halted') {
        // Spend already exceeded a reservation or a hard ceiling. Nothing may be sent until the
        // incident is reconciled, so this is a refusal rather than a retry. The Turn is closed now
        // instead of being left for the deadline sweeper: a 60 s wait would look like a slow model,
        // and the answer is already known.
        options.logger?.warn('model paid call halted by budget incident', {
          scope: reservation.scope,
          reason: reservation.reason,
        });
        const halted = await options.repository.publishCompletion({
          lease,
          result: { status: 'failed', failureReason: 'internal_error' },
        });

        return halted.outcome === 'published' ? 'halted' : 'fenced';
      }

      const attemptNo = reservation.attempt.attemptNo;
      const sent = await options.repository.markAttemptSent({ lease, attemptNo });

      if (!sent) {
        // The CAS proves nothing left the process, so the reservation is returned in full.
        await settle(lease, attemptNo, { state: 'released', outcomeCode: 'not_sent' });
        return 'fenced';
      }

      const result = await callGateway(lease, bounded.messages, signal);

      if (result.kind === 'success') {
        if (result.usage === null) {
          // The provider answered but did not say what it charged. Booking zero would be a lie and
          // would understate the day's spend, so the full reservation is recognized instead. The
          // reply is still valid and is published below: the user paid for it either way.
          await settle(lease, attemptNo, {
            state: 'conservative_billed',
            outcomeCode: 'usage_missing',
          });
        } else {
          await settle(lease, attemptNo, {
            state: 'settled',
            outcomeCode: 'ok',
            observedCostMicroUsd: result.usage.costMicroUsd,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          });
        }

        return await publishGatewaySuccess(lease, result);
      }

      const shutdown = signal?.aborted === true;

      if (result.code === 'not_sent') {
        // The provider adapter's final authorization fence refused before fetch. No bytes left the
        // process, so return the reservation in full and never retry an expired approval.
        await settle(lease, attemptNo, { state: 'released', outcomeCode: 'not_sent' });
        options.logger?.warn('model provider request refused before egress', {
          turnId: lease.turnId,
          reason: 'not_sent',
        });
        return await terminalFailure(lease, 'internal_error');
      }

      // A request that may have been sent keeps its reservation: an unknown charge is not a free one.
      await settle(lease, attemptNo, {
        state: 'unknown_billed',
        outcomeCode: shutdown ? 'client_cancelled' : result.code,
      });

      if (result.code === 'model_unavailable' && result.diagnostic !== null) {
        options.logger?.warn('model provider request unavailable', {
          turnId: lease.turnId,
          failureCode: result.code,
          ...result.diagnostic,
        });
      }

      if (shutdown) {
        return 'skipped';
      }

      const retryable = isRetryableModelFailure(result.code);
      const lastAttempt = attemptNo >= options.maxAttempts;

      if (!retryable || lastAttempt) {
        return await terminalFailure(
          lease,
          result.code === 'model_timeout' ? 'timeout' : 'internal_error',
        );
      }

      // Between attempts the Turn must stay `running`: a retryable provider failure is an attempt
      // outcome, never a terminal Turn. The next loop iteration re-checks the deadline through the
      // database before reserving more money.
      if ((await options.repository.expireTurnIfDue(identityOf(lease))) !== null) {
        return 'expired';
      }
    }

    return await terminalFailure(lease, 'internal_error');
  };

  const runPass = async (signal?: AbortSignal): Promise<ModelTurnResponderSummary> => {
    const summary = counters();
    const candidates = await options.repository.listRunningTurns(batchSize, options.onlyTurn);

    for (const candidate of candidates) {
      if (signal?.aborted === true) {
        summary.skipped += candidates.length - summary.examined;
        break;
      }

      summary.examined += 1;

      // The deadline is authoritative and uses the database clock: an expired turn is swept before
      // any money is reserved, so a slow queue cannot bill for a reply nobody will read.
      if ((await options.repository.expireTurnIfDue(candidate)) !== null) {
        summary.expired += 1;
        continue;
      }

      const claim = await options.repository.claimTurn({
        turn: candidate,
        workerId: options.workerId,
        leaseMs: options.leaseMs,
      });

      if (claim.kind === 'not_claimed') {
        if (claim.reason === 'deadline_expired') {
          summary.expired += 1;
        } else {
          summary.skipped += 1;
        }
        continue;
      }

      let outcome: ModelTurnOutcome;

      try {
        outcome = await runTurn(claim.lease, signal);
      } catch (error) {
        // Bounded input, a database error or a bug: the attempt (if any) keeps its pessimistic
        // charge and the Turn is left `running` for the deadline sweeper to close.
        if (error instanceof ModelInputRefused) {
          outcome = await terminalFailure(claim.lease, 'internal_error');
        } else {
          options.logger?.warn('model turn iteration failed', {
            category: safeWorkerErrorCategory(error),
          });
          summary.skipped += 1;
          continue;
        }
      }

      summary[outcome] += 1;
    }

    return Object.freeze(summary);
  };

  /**
   * One pass over the batch, or an explicit `busy` no-op.
   *
   * The gate is taken *before* the candidate list is read, so a concurrent entry cannot even observe
   * a Turn, let alone claim, reserve or send one. That ordering is the point: a gate taken after the
   * claim would still let two passes contend for the same money.
   */
  const processOnce = async (signal?: AbortSignal): Promise<ModelTurnResponderSummary> => {
    if (passInFlight) {
      return Object.freeze({ ...counters(), busy: true });
    }

    passInFlight = true;

    try {
      return await runPass(signal);
    } finally {
      passInFlight = false;
    }
  };

  const start = (parentSignal?: AbortSignal): ModelTurnResponderRunner => {
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    const stopFromParent = (): void => stop();

    if (parentSignal?.aborted === true) {
      stop();
    } else {
      parentSignal?.addEventListener('abort', stopFromParent, { once: true });
    }

    const done = (async (): Promise<void> => {
      try {
        while (!controller.signal.aborted) {
          try {
            await processOnce(controller.signal);
          } catch (error) {
            options.logger?.warn('model turn iteration failed', {
              category: safeWorkerErrorCategory(error),
            });

            try {
              await wait(errorBackoffMs, controller.signal);
            } catch {
              if (!controller.signal.aborted) {
                options.logger?.warn('model turn backoff failed');
              }
            }
            continue;
          }

          if (controller.signal.aborted) {
            break;
          }

          try {
            await wait(intervalMs, controller.signal);
          } catch {
            if (!controller.signal.aborted) {
              options.logger?.warn('model turn wait failed');
            }
          }
        }
      } finally {
        parentSignal?.removeEventListener('abort', stopFromParent);
      }
    })();

    return Object.freeze({ stop, done });
  };

  return Object.freeze({ processOnce, start });
}
