import type { ObservedTurnUsage } from '@ember/runtime-v2';
export type { ObservedTurnUsage } from '@ember/runtime-v2';
import { B1AssistantTurnDtoSchema, IdSchema } from '@ember/contracts';
import {
  buildBoundedContext,
  estimateCostMicroUsd,
  FAKE_STREAM_MAX_REPLY_CHARS,
  isModelAuthorizationRefused,
  isModelGatewayFailure,
  MODEL_LIMITS,
  ModelGatewayFailure,
  preflightConversationTurn,
  type ModelRateRow,
} from '@ember/model-gateway';
import {
  toV2DelegationCommand,
  type V2ConversationStreamEvent,
  type V2StreamingModelGateway,
} from './model-runtime.js';
import type { CommitTurnRequest, EdgeAgentHeadRpc, HeadScope, PreparedTurn } from './rpc.js';

export const INTERACTIVE_TIMING = {
  leaseMs: 45_000,
  renewEveryMs: 15_000,
  interactiveDeadlineMs: 120_000,
  turnDeadlineMs: 600_000,
  handoffAtMs: 110_000,
  handoffLatestMs: 115_000,
  providerIdleMs: 30_000,
} as const;

const USAGE_DRAIN_MS = 1_000;
const USAGE_REPORT_TIMEOUT_MS = 1_000;
const INTERRUPTED_RPC_TIMEOUT_MS = 2_500;

type StopReason = 'disconnect' | 'handoff_window' | 'provider_idle' | 'lease_lost' | 'phase_ended';
type SendState = 'unsent' | 'unknown' | 'authorized';
type StreamResult = Extract<V2ConversationStreamEvent, { kind: 'result' }>['result'];
type ExecutorRpc = Pick<
  EdgeAgentHeadRpc,
  'markAttemptSent' | 'renewTurnLease' | 'handoffTurnToDurable' | 'commitTurn'
>;

/**
 * The local runtime host submits evidence to the attempt authority. Repeated receipts for an
 * operation must be idempotent alongside commitTurn and Durable recovery. This port only records
 * usage, including after the Turn has been cleared, and has no publication or dispatch capability.
 */
export type ReportObservedTurnUsage = (receipt: ObservedTurnUsage) => Promise<void>;

export interface InteractiveExecution {
  readonly rpc: ExecutorRpc;
  readonly gateway: Pick<V2StreamingModelGateway, 'streamConversationTurn'>;
  readonly reportObservedUsage: ReportObservedTurnUsage;
  readonly prepared: PreparedTurn;
  readonly scope: HeadScope;
  readonly conversationId: string;
  readonly workerId: string;
  readonly signal: AbortSignal;
  readonly expectedSimulated?: boolean;
  readonly preflightRate?: ModelRateRow | null;
  emit(
    this: void,
    event: 'turn.delta' | 'turn.committed' | 'turn.handed_off',
    data: Readonly<Record<string, unknown>>,
  ): void;
}

export async function executeInteractive(execution: InteractiveExecution): Promise<void> {
  const {
    rpc,
    gateway,
    reportObservedUsage,
    prepared,
    scope,
    conversationId,
    workerId,
    signal,
    emit,
  } = execution;
  const { attemptNo, operationId, turnId, leaseEpoch } = prepared;
  const fence = { scope, conversationId, turnId, leaseEpoch, leaseOwner: workerId };
  const attempt = { ...fence, attemptNo, operationId };
  const acceptedAt = Date.parse(prepared.receipt.turn.created_at);
  const deadlineAtMs = Math.min(
    prepared.turnDeadlineMs,
    acceptedAt + INTERACTIVE_TIMING.turnDeadlineMs,
  );
  const phaseEndsAt = Math.min(
    prepared.interactiveDeadlineMs ?? acceptedAt,
    acceptedAt + INTERACTIVE_TIMING.interactiveDeadlineMs,
    deadlineAtMs,
  );
  const handoffAt = acceptedAt + INTERACTIVE_TIMING.handoffAtMs;
  if (!Number.isSafeInteger(deadlineAtMs) || !Number.isSafeInteger(phaseEndsAt)) return;
  let leaseExpiresAt = prepared.leaseExpiresAtMs ?? acceptedAt;
  let jobHandle: string | undefined;
  let sendState: SendState = 'unsent';
  let observedUsage: ObservedTurnUsage | undefined;
  let usageReportStarted = false;
  let pendingProviderRead: Promise<IteratorResult<V2ConversationStreamEvent, void>> | undefined;
  let invalidOutput = false;
  const expectedSimulated = execution.expectedSimulated ?? true;
  const preflightRate = execution.preflightRate ?? null;

  const stop = new AbortController();
  const phase = new AbortController();
  const abort = (reason: StopReason) => stop.abort(reason);
  const disconnect = () => abort('disconnect');
  const phaseTimer = setTimeout(() => {
    phase.abort();
    abort('phase_ended');
  }, phaseEndsAt - Date.now());
  const handoffTimer = setTimeout(() => abort('handoff_window'), handoffAt - Date.now());
  let leaseTimer = setTimeout(() => abort('lease_lost'), leaseExpiresAt - Date.now());
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleRenewal(): void {
    if (stop.signal.aborted) return;
    renewTimer = setTimeout(() => {
      void renew();
    }, INTERACTIVE_TIMING.renewEveryMs);
  }

  async function renew(): Promise<void> {
    if (stop.signal.aborted || Date.now() >= leaseExpiresAt) {
      abort('lease_lost');
      return;
    }
    try {
      const result = await rpc.renewTurnLease({ ...fence, extendMs: INTERACTIVE_TIMING.leaseMs });
      if (stop.signal.aborted) return;
      if (!result.renewed || result.cancelRequested || result.leaseExpiresAtMs <= Date.now()) {
        abort('lease_lost');
        return;
      }
      clearTimeout(leaseTimer);
      leaseExpiresAt = result.leaseExpiresAtMs;
      leaseTimer = setTimeout(() => abort('lease_lost'), leaseExpiresAt - Date.now());
      scheduleRenewal();
    } catch {
      abort('lease_lost');
    }
  }

  function resetIdleTimer(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort('provider_idle'), INTERACTIVE_TIMING.providerIdleMs);
  }

  function stopExecutionTimers(): void {
    clearTimeout(handoffTimer);
    clearTimeout(leaseTimer);
    clearTimeout(renewTimer);
    clearTimeout(idleTimer);
  }

  async function streamReply(): Promise<StreamResult | undefined> {
    stop.signal.throwIfAborted();
    if (
      prepared.globalGrantId === null ||
      prepared.globalGrantId === '' ||
      !Number.isSafeInteger(prepared.reservedMicroUsd) ||
      prepared.reservedMicroUsd <= 0
    ) {
      return;
    }
    const context = buildBoundedContext(prepared.context);
    const currentTimeIso = new Date().toISOString();
    const turnInput = {
      conversationId,
      turnId,
      context: context.messages,
      ...(prepared.personalMemories !== undefined && prepared.personalMemories.length > 0
        ? { personalMemories: prepared.personalMemories }
        : {}),
      enablePersonalMemorySaveTool: true,
      enableProactiveScheduleTool: true,
      currentTimeIso,
      maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
    };
    if (preflightRate !== null) {
      const preflight = preflightConversationTurn({
        messages: context.messages,
        ...(prepared.personalMemories !== undefined && prepared.personalMemories.length > 0
          ? { personalMemories: prepared.personalMemories }
          : {}),
        enablePersonalMemorySaveTool: true,
        enableProactiveScheduleTool: true,
        maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
      });
      const estimatedMicroUsd = estimateCostMicroUsd(
        preflightRate,
        preflight.inputTokens,
        preflight.maxOutputTokens,
      );
      if (estimatedMicroUsd > prepared.reservedMicroUsd) {
        throw new Error('Model preflight estimate exceeds reservation');
      }
    }
    sendState = 'unknown';
    const authorization = await untilAbort(
      rpc.markAttemptSent({
        scope,
        subjectType: 'turn',
        subjectId: turnId,
        attemptNo,
        operationId,
        leaseEpoch,
        leaseOwner: workerId,
      }),
      stop.signal,
    );
    if (!authorization.authorized) {
      // Agent Head owns expiry, cancellation and settlement after a denied authorization.
      return;
    }
    sendState = 'authorized';
    stop.signal.throwIfAborted();
    const now = Date.now();
    if (
      !Number.isSafeInteger(authorization.startBeforeMs) ||
      now >= Math.min(leaseExpiresAt, phaseEndsAt, deadlineAtMs, authorization.startBeforeMs)
    ) {
      return;
    }

    scheduleRenewal();
    resetIdleTimer();
    const provider = gateway.streamConversationTurn(
      {
        input: { ...turnInput, currentTimeIso: new Date(now).toISOString() },
        operationId,
        deadlineAtMs,
      },
      stop.signal,
    );
    let streamedChars = 0;
    try {
      for (;;) {
        stop.signal.throwIfAborted();
        // Keep observing the one already-issued read if abort wins. Its response may contain
        // billing even when the executor has lost permission to use the text.
        pendingProviderRead = provider.next().then((frame) => {
          if (!frame.done && frame.value.kind === 'result') {
            const result = frame.value.result;
            observedUsage = toObservedUsage({ scope, turnId, attemptNo, operationId }, result);
          }
          return frame;
        });
        const frame = await untilAbort(pendingProviderRead, stop.signal);
        stop.signal.throwIfAborted();
        if (frame.done) throw new ModelGatewayFailure('model_invalid_output');

        resetIdleTimer();
        const event = frame.value;
        if (event.kind === 'job') jobHandle = event.handle;
        if (event.kind === 'delta') {
          streamedChars += event.text.length;
          invalidOutput ||= streamedChars > FAKE_STREAM_MAX_REPLY_CHARS;
          if (!invalidOutput) emit('turn.delta', { turn_id: turnId, text: event.text });
        }
        if (event.kind === 'result') return event.result;
      }
    } finally {
      void provider.return().catch(() => undefined);
    }
  }

  async function reportUsage(): Promise<void> {
    const receipt = observedUsage;
    if (receipt === undefined || usageReportStarted) return;
    usageReportStarted = true;
    try {
      await withinTimeout(() => reportObservedUsage(receipt), USAGE_REPORT_TIMEOUT_MS);
    } catch {
      // A provider receipt remains queryable when the provider supports recovery. An unknown
      // accounting ACK must not trigger another provider call or a replacement settlement.
    }
  }

  async function publish(command: CommitTurnRequest, interrupted = false): Promise<void> {
    let recorded = false;
    try {
      const committed = interrupted
        ? await withinTimeout(
            () => untilAbort(rpc.commitTurn(command), phase.signal),
            INTERRUPTED_RPC_TIMEOUT_MS,
          )
        : await untilAbort(rpc.commitTurn(command), AbortSignal.any([phase.signal, signal]));
      recorded = committed.outcome === 'published';
      if (committed.outcome === 'published' && !signal.aborted && !phase.signal.aborted) {
        emit('turn.committed', {
          turn: B1AssistantTurnDtoSchema.parse(committed.turn),
          response_message_id: IdSchema.parse(committed.responseMessageId),
          sequence: committed.sequence,
        });
      }
    } finally {
      // A fenced commit or lost ACK can still leave accounting for the original operation due.
      if (!recorded) await reportUsage();
    }
  }

  async function handleInterrupted(error: unknown): Promise<void> {
    const reason: unknown = stop.signal.reason;
    if (
      reason === 'lease_lost' ||
      phase.signal.aborted ||
      Date.now() >= Math.min(phaseEndsAt, leaseExpiresAt, deadlineAtMs)
    ) {
      return;
    }

    const disconnected = reason === 'disconnect';
    const wantsHandoff =
      disconnected ||
      (reason === 'handoff_window' &&
        Date.now() <= acceptedAt + INTERACTIVE_TIMING.handoffLatestMs);
    if (wantsHandoff && (jobHandle !== undefined || sendState === 'unsent')) {
      const handoff = await withinTimeout(
        () =>
          untilAbort(
            rpc.handoffTurnToDurable({
              ...fence,
              reason: disconnected ? 'client_disconnect_handoff' : 'interactive_deadline_120s',
              ...(jobHandle === undefined ? {} : { providerJobHandle: jobHandle }),
            }),
            phase.signal,
          ),
        INTERRUPTED_RPC_TIMEOUT_MS,
      );
      if (handoff.outcome === 'handed_off' && !signal.aborted) {
        emit('turn.handed_off', { turn_id: turnId, status: 'running' });
      }
      return;
    }

    if (sendState === 'unknown' || observedUsage !== undefined) return;
    if (phase.signal.aborted || Date.now() >= Math.min(phaseEndsAt, leaseExpiresAt, deadlineAtMs)) {
      return;
    }
    const provablyNotSent =
      sendState === 'unsent' ||
      isModelAuthorizationRefused(error) ||
      (isModelGatewayFailure(error) && error.code === 'not_sent');
    const timedOut =
      !provablyNotSent &&
      (reason === 'provider_idle' ||
        reason === 'handoff_window' ||
        (isModelGatewayFailure(error) && error.code === 'model_timeout'));
    const outcomeCode = provablyNotSent
      ? 'not_sent'
      : disconnected
        ? 'client_cancelled'
        : timedOut
          ? 'model_timeout'
          : isModelGatewayFailure(error)
            ? error.code
            : 'model_unavailable';

    await publish(
      {
        ...attempt,
        settlement: provablyNotSent
          ? { state: 'released', outcomeCode: 'not_sent' }
          : { state: 'unknown_billed', outcomeCode },
        result:
          disconnected && !provablyNotSent
            ? { status: 'aborted_for_retry_or_reconcile' }
            : { status: 'failed', failureReason: timedOut ? 'timeout' : 'internal_error' },
      },
      true,
    );
  }

  signal.addEventListener('abort', disconnect, { once: true });
  if (signal.aborted) disconnect();
  if (Date.now() >= phaseEndsAt) {
    phase.abort();
    abort('phase_ended');
  }
  if (Date.now() >= handoffAt) abort('handoff_window');
  if (Date.now() >= leaseExpiresAt) abort('lease_lost');

  try {
    let reply: StreamResult | undefined;
    try {
      reply = await streamReply();
      stop.signal.throwIfAborted();
    } catch (error) {
      stopExecutionTimers();
      try {
        if (stop.signal.aborted && pendingProviderRead !== undefined) {
          const inFlight = pendingProviderRead;
          await withinTimeout(() => inFlight, USAGE_DRAIN_MS).catch(() => undefined);
        }
        await handleInterrupted(error);
      } finally {
        await reportUsage();
      }
      return;
    }

    stopExecutionTimers();
    if (reply === undefined) return;
    if (stop.signal.aborted || Date.now() >= Math.min(leaseExpiresAt, phaseEndsAt, deadlineAtMs)) {
      await reportUsage();
      return;
    }

    invalidOutput ||=
      reply.output.text.length > FAKE_STREAM_MAX_REPLY_CHARS ||
      reply.output.text.trim().length === 0 ||
      reply.simulated !== expectedSimulated;
    const delegation =
      reply.output.kind === 'delegate' ? toV2DelegationCommand(reply.output) : undefined;
    const { observedCostMicroUsd, inputTokens, outputTokens } = observedUsage ?? {};
    const settlement: CommitTurnRequest['settlement'] =
      observedCostMicroUsd === undefined
        ? { state: 'conservative_billed', outcomeCode: 'usage_missing' }
        : {
            state: 'settled',
            outcomeCode: invalidOutput ? 'model_invalid_output' : 'ok',
            observedCostMicroUsd,
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
          };
    await publish({
      ...attempt,
      settlement,
      result: invalidOutput
        ? { status: 'failed', failureReason: 'internal_error' }
        : {
            status: 'completed',
            text: reply.output.text,
            modelLabel: reply.modelLabel,
            simulated: reply.simulated,
            ...(delegation === undefined ? {} : { delegation }),
            ...(reply.output.kind === 'save_memory'
              ? { personalMemorySave: reply.output.memory.arguments }
              : {}),
            ...(reply.output.kind === 'create_schedule'
              ? { proactiveScheduleCreate: reply.output.schedule.arguments }
              : {}),
          },
    });
  } finally {
    abort('phase_ended');
    stopExecutionTimers();
    clearTimeout(phaseTimer);
    signal.removeEventListener('abort', disconnect);
  }
}

/** Detach from a hung stream read or RPC response at a local deadline. The RPC may have committed. */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Interactive execution interrupted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

function toObservedUsage(
  key: Pick<ObservedTurnUsage, 'scope' | 'turnId' | 'attemptNo' | 'operationId'>,
  reply: StreamResult,
): ObservedTurnUsage | undefined {
  const usage = reply.usage;
  if (usage === null || !isNonNegativeCounter(usage.costMicroUsd)) return undefined;
  return {
    ...key,
    observedCostMicroUsd: usage.costMicroUsd,
    ...(isNonNegativeCounter(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
    ...(isNonNegativeCounter(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
  };
}

function isNonNegativeCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

async function withinTimeout<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    return await untilAbort(work(), deadline.signal);
  } finally {
    clearTimeout(timer);
  }
}
