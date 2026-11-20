import {
  buildBoundedContext,
  FAKE_MODEL_LABEL,
  isModelGatewayFailure,
  MODEL_LIMITS,
  type ContextRow,
  type LoopbackFakeModelGateway,
} from '@ember/model-gateway';
import {
  executeRecoveredOrFreshDurableWork,
  parseClaimExecutionContext,
  toAgentHeadDurableCommitOutcome,
  type DurableExecutorPort,
  type FakeOrProviderJobOutcome,
} from '@ember/runtime-v2';
import { getHead, type LocalRuntimeEnv } from './runtime-head.js';

export function createDurableExecutor(
  env: LocalRuntimeEnv,
  gateway: LoopbackFakeModelGateway,
): DurableExecutorPort {
  return {
    async executeDurableWork(claim) {
      const context = parseClaimExecutionContext(claim);
      // Task drivers that have no model attempt use the task result contract directly.
      // This local chat runtime has no external sandbox or task driver.
      if (claim.targetKind === 'task' && context.attemptId === undefined) {
        return { status: 'failed', reasonCode: 'local_task_driver_unavailable' };
      }
      if (context.attemptId === undefined) throw new Error('Missing authoritative model attempt');

      const deadlineAtMs = context.deadlineAtMs ?? claim.leaseExpiresAtMs;
      const stopAtMs = Math.min(claim.leaseExpiresAtMs, deadlineAtMs);
      const signal = AbortSignal.timeout(Math.max(0, stopAtMs - Date.now()));
      const head = getHead(env, claim.tenantId, claim.agentId);
      const { operationId } = context;
      function unknownOutcome(handle: string | null, errorCode: string): FakeOrProviderJobOutcome {
        return {
          status: 'unknown_billed',
          operationId,
          providerJobHandle: handle,
          outputJson: null,
          errorCode,
          usage: null,
        };
      }

      async function poll(handle: string): Promise<FakeOrProviderJobOutcome> {
        try {
          while (!signal.aborted && Date.now() < stopAtMs) {
            const job = await gateway.queryConversationJob(operationId, handle, signal);
            if (job.state === 'unavailable') return unknownOutcome(handle, 'JOB_UNAVAILABLE');
            if (job.state === 'completed') {
              return {
                status: 'succeeded',
                operationId,
                providerJobHandle: handle,
                outputJson: JSON.stringify({ text: job.result.output.text }),
                errorCode: null,
                usage: job.result.usage,
              };
            }
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(250, Math.max(0, stopAtMs - Date.now()))),
            );
          }
        } catch (error) {
          if (!signal.aborted) throw error;
        }
        return unknownOutcome(handle, 'TIMEOUT');
      }

      const outcome = await executeRecoveredOrFreshDurableWork({
        context,
        signal,
        sendGate: {
          markAttemptSent: (req) => head.markAttemptSent(req),
          scope: { tenantId: claim.tenantId, agentId: claim.agentId },
          leaseEpoch: claim.leaseEpoch,
          leaseOwner: claim.workerId,
          leaseExpiresAtMs: claim.leaseExpiresAtMs,
        },
        provider: {
          pollProviderJob: ({ providerJobHandle }) => poll(providerJobHandle),
          async startProviderJob() {
            let handle: string | null = null;
            try {
              // Both executors use Agent Head's bounded transcript and the same D gateway job store.
              const input: unknown = JSON.parse(context.inputJson ?? 'null');
              const task = input as { prompt?: string; notes?: string } | null;
              const messages =
                claim.targetKind === 'turn'
                  ? buildBoundedContext(input as readonly ContextRow[]).messages
                  : [{ role: 'user' as const, text: task?.prompt ?? task?.notes ?? '' }];
              for await (const event of gateway.streamConversationTurn(
                {
                  operationId,
                  deadlineAtMs,
                  input: {
                    conversationId: context.conversationId ?? claim.targetId,
                    turnId: claim.targetId,
                    context: messages,
                    ...(claim.targetKind === 'turn' &&
                    context.personalMemories !== undefined &&
                    context.personalMemories.length > 0
                      ? { personalMemories: context.personalMemories }
                      : {}),
                    maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
                  },
                },
                signal,
              )) {
                if (event.kind === 'job') handle = event.handle;
                if (event.kind === 'result')
                  return {
                    status: 'succeeded',
                    operationId,
                    providerJobHandle: handle,
                    outputJson: JSON.stringify({ text: event.result.output.text }),
                    errorCode: null,
                    usage: event.result.usage,
                  };
              }
            } catch (error) {
              if (handle === null)
                return unknownOutcome(
                  null,
                  signal.aborted
                    ? 'TIMEOUT'
                    : isModelGatewayFailure(error)
                      ? error.code
                      : 'PROVIDER_UNAVAILABLE',
                );
            }
            return handle === null ? unknownOutcome(null, 'MISSING_RESULT') : poll(handle);
          },
        },
      });
      return toAgentHeadDurableCommitOutcome({
        targetKind: claim.targetKind,
        context,
        outcome,
        modelLabel: FAKE_MODEL_LABEL,
        simulated: true,
      });
    },
  };
}
