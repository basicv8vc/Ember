import { B1AssistantTurnDtoSchema, IdSchema } from '@ember/contracts';
import {
  buildBoundedContext,
  FAKE_MODEL_LABEL,
  FAKE_STREAM_MAX_REPLY_CHARS,
  isModelGatewayFailure,
  MODEL_LIMITS,
  ModelGatewayFailure,
  type FakeConversationStreamEvent,
  type FakeStreamingModelGateway,
} from '@ember/model-gateway';
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

type StopReason = 'disconnect' | 'handoff_window' | 'provider_idle' | 'lease_lost' | 'phase_ended';
type SendState = 'unsent' | 'unknown' | 'authorized';
type StreamResult = Extract<FakeConversationStreamEvent, { kind: 'result' }>['result'];
type ExecutorRpc = Pick<
  EdgeAgentHeadRpc,
  'markAttemptSent' | 'renewTurnLease' | 'handoffTurnToDurable' | 'commitTurn'
>;

export interface InteractiveExecution {
  readonly rpc: ExecutorRpc;
  readonly gateway: Pick<FakeStreamingModelGateway, 'streamConversationTurn'>;
  readonly prepared: PreparedTurn;
  readonly scope: HeadScope;
  readonly conversationId: string;
  readonly workerId: string;
  readonly signal: AbortSignal;
  emit(
    this: void,
    event: 'turn.delta' | 'turn.committed' | 'turn.handed_off',
    data: Readonly<Record<string, unknown>>,
  ): void;
}

export async function executeInteractive(execution: InteractiveExecution): Promise<void> {
  const { rpc, gateway, prepared, scope, conversationId, workerId, signal, emit } = execution;
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
        input: {
          conversationId,
          turnId,
          context: context.messages,
          maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
        },
        operationId,
        deadlineAtMs,
      },
      stop.signal,
    );
    let streamedChars = 0;
    try {
      for (;;) {
        const frame = await untilAbort(provider.next(), stop.signal);
        stop.signal.throwIfAborted();
        if (frame.done) throw new ModelGatewayFailure('model_invalid_output');

        resetIdleTimer();
        const event = frame.value;
        if (event.kind === 'job') jobHandle = event.handle;
        if (event.kind === 'delta') {
          streamedChars += event.text.length;
          if (streamedChars > FAKE_STREAM_MAX_REPLY_CHARS) {
            throw new ModelGatewayFailure('model_invalid_output');
          }
          emit('turn.delta', { turn_id: turnId, text: event.text });
        }
        if (event.kind === 'result') {
          if (
            event.result.output.text.length > FAKE_STREAM_MAX_REPLY_CHARS ||
            event.result.output.text.trim().length === 0 ||
            !event.result.simulated
          ) {
            throw new ModelGatewayFailure('model_invalid_output');
          }
          return event.result;
        }
      }
    } finally {
      void provider.return().catch(() => undefined);
    }
  }

  async function publish(command: CommitTurnRequest): Promise<void> {
    const committed = await untilAbort(rpc.commitTurn(command), phase.signal);
    if (committed.outcome === 'published' && !signal.aborted) {
      emit('turn.committed', {
        turn: B1AssistantTurnDtoSchema.parse(committed.turn),
        response_message_id: IdSchema.parse(committed.responseMessageId),
        sequence: committed.sequence,
      });
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
      const handoff = await untilAbort(
        rpc.handoffTurnToDurable({
          ...fence,
          reason: disconnected ? 'client_disconnect_handoff' : 'interactive_deadline_120s',
          ...(jobHandle === undefined ? {} : { providerJobHandle: jobHandle }),
        }),
        phase.signal,
      );
      if (handoff.outcome === 'handed_off' && !signal.aborted) {
        emit('turn.handed_off', { turn_id: turnId, status: 'running' });
      }
      return;
    }

    if (sendState === 'unknown') return;
    const timedOut =
      reason === 'provider_idle' ||
      reason === 'handoff_window' ||
      (isModelGatewayFailure(error) && error.code === 'model_timeout');
    const outcomeCode = disconnected
      ? 'client_cancelled'
      : timedOut
        ? 'model_timeout'
        : isModelGatewayFailure(error)
          ? error.code
          : 'model_unavailable';

    await publish({
      ...attempt,
      settlement:
        sendState === 'unsent'
          ? { state: 'released', outcomeCode: 'not_sent' }
          : { state: 'unknown_billed', outcomeCode },
      result: disconnected
        ? { status: 'aborted_for_retry_or_reconcile' }
        : { status: 'failed', failureReason: timedOut ? 'timeout' : 'internal_error' },
    });
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
      await handleInterrupted(error);
      return;
    }

    stopExecutionTimers();
    if (reply === undefined || Date.now() >= Math.min(leaseExpiresAt, phaseEndsAt, deadlineAtMs)) {
      return;
    }

    const usage = reply.usage;
    await publish({
      ...attempt,
      settlement:
        usage === null
          ? { state: 'conservative_billed', outcomeCode: 'usage_missing' }
          : {
              state: 'settled',
              outcomeCode: 'ok',
              observedCostMicroUsd: usage.costMicroUsd,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            },
      result: {
        status: 'completed',
        text: reply.output.text,
        modelLabel: FAKE_MODEL_LABEL,
        simulated: true,
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
