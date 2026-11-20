import {
  buildBoundedContext,
  FAKE_MODEL_LABEL,
  FAKE_V2_RATE_VERSION,
  isModelGatewayFailure,
  MODEL_LIMITS,
  type ContextRow,
  type FakeStreamingModelGateway,
} from '@ember/model-gateway';
import {
  PROACTIVE_SCHEDULER_MODEL_LABEL,
  executeRecoveredOrFreshDurableWork,
  parseClaimExecutionContext,
  parseProactiveScheduleTaskInput,
  toAgentHeadDurableCommitOutcome,
  type DurableExecutionClaimContext,
  type DurableExecutorPort,
  type FakeOrProviderJobOutcome,
  type PersonalMemoryContextItem,
  type ProactiveScheduleList,
  type ProactiveScheduleTaskPayload,
} from '@ember/runtime-v2';
import {
  buildProactiveBriefPrompt,
  loadRecentBriefMessages,
  type BriefContextMessage,
  type ProactiveBriefContext,
} from './proactive-brief-context.js';
import { createEdgeRpc, getHead, type AgentHeadDO, type LocalRuntimeEnv } from './runtime-head.js';

export type V2FakeDurableGateway = Pick<
  FakeStreamingModelGateway,
  'streamConversationTurn' | 'queryConversationJob'
>;

const PROACTIVE_BRIEF_RESERVATION_MICRO_USD = 250;

async function loadProactiveBriefContext(
  head: AgentHeadDO,
  tenantId: string,
  agentId: string,
  conversationId: string | undefined,
  proactive: ProactiveScheduleTaskPayload,
): Promise<ProactiveBriefContext> {
  const rpc = createEdgeRpc(head);
  let recentMessages: readonly BriefContextMessage[] = [];
  let activeSchedules: ProactiveScheduleList['schedules'] = [];
  let personalMemories: PersonalMemoryContextItem[] = [];

  if (conversationId !== undefined) {
    try {
      recentMessages = await loadRecentBriefMessages((after, limit) =>
        rpc.readMessages({
          tenantId,
          agentId,
          conversationId,
          after,
          limit,
        }),
      );
    } catch {
      // Best-effort context; proceed with base brief prompt if unavailable.
    }
  }

  try {
    const listed = await rpc.proactiveSchedule({
      kind: 'list',
      tenantId,
      principalId: proactive.principalId,
      agentId,
      requestId: crypto.randomUUID(),
    });
    if ('schedules' in listed) activeSchedules = listed.schedules;
  } catch {
    // Best-effort context; proceed with base brief prompt if unavailable.
  }

  try {
    const memories = await rpc.personalMemory({
      kind: 'list',
      tenantId,
      principalId: proactive.principalId,
      agentId,
      requestId: crypto.randomUUID(),
    });
    if ('items' in memories) {
      personalMemories = memories.items.map((item) => ({
        kind: item.kind,
        ...(item.key === null ? {} : { key: item.key }),
        content: item.content,
      }));
    }
  } catch {
    // Best-effort context; proceed with base brief prompt if unavailable.
  }

  return { recentMessages, activeSchedules, personalMemories };
}

function unwrapJsonText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed['text'] === 'string') return parsed['text'];
    } catch {
      // Return raw string below.
    }
  }
  return trimmed;
}

export function createDurableExecutor(
  env: LocalRuntimeEnv,
  gateway: V2FakeDurableGateway,
): DurableExecutorPort {
  return {
    async executeDurableWork(claim) {
      let context: DurableExecutionClaimContext = parseClaimExecutionContext(claim);
      const head = getHead(env, claim.tenantId, claim.agentId);
      const proactive =
        claim.targetKind === 'task' ? parseProactiveScheduleTaskInput(context.inputJson) : null;

      if (proactive !== null && proactive.deliveryMode === 'direct_reminder') {
        return {
          status: 'completed',
          summaryText: proactive.title,
          detailText: proactive.prompt,
          modelLabel: PROACTIVE_SCHEDULER_MODEL_LABEL,
          simulated: false,
          reasonCode: 'ok',
        };
      }

      if (claim.targetKind === 'task' && context.attemptId === undefined) {
        if (proactive === null) {
          return { status: 'failed', reasonCode: 'local_task_driver_unavailable' };
        }
        const rawClaim = JSON.parse(claim.contextJson) as Record<string, unknown>;
        const runId = typeof rawClaim['runId'] === 'string' ? rawClaim['runId'] : null;
        if (runId === null) {
          return { status: 'failed', reasonCode: 'missing_run_id' };
        }
        const reservation = await head.reserveTaskModelAttempt({
          tenantId: claim.tenantId,
          principalId: proactive.principalId,
          agentId: claim.agentId,
          taskId: claim.targetId,
          runId,
          leaseEpoch: claim.leaseEpoch,
          budgetMode: 'simulated_full_protocol',
          providerId: 'fake',
          modelLabel: FAKE_MODEL_LABEL,
          rateVersion: FAKE_V2_RATE_VERSION,
          estimatedMicroUsd: PROACTIVE_BRIEF_RESERVATION_MICRO_USD,
        });
        if (reservation.kind === 'refused') {
          return {
            status: 'failed',
            summaryText: proactive.title,
            detailText: null,
            modelLabel: FAKE_MODEL_LABEL,
            simulated: true,
            reasonCode: reservation.reason,
          };
        }
        const briefContext = await loadProactiveBriefContext(
          head,
          claim.tenantId,
          claim.agentId,
          context.conversationId,
          proactive,
        );
        context = {
          ...context,
          operationId: reservation.operationId,
          attemptNo: reservation.attemptNo,
          attemptId: String(reservation.attemptNo),
          sendState: 'unsent',
          sendAuthorizingAtMs: null,
          sendStartedAtMs: null,
          inputJson: JSON.stringify({ prompt: buildProactiveBriefPrompt(proactive, briefContext) }),
        };
      } else if (proactive !== null) {
        const briefContext = await loadProactiveBriefContext(
          head,
          claim.tenantId,
          claim.agentId,
          context.conversationId,
          proactive,
        );
        context = {
          ...context,
          inputJson: JSON.stringify({ prompt: buildProactiveBriefPrompt(proactive, briefContext) }),
        };
      }

      if (context.attemptId === undefined) throw new Error('Missing authoritative model attempt');

      const deadlineAtMs = context.deadlineAtMs ?? claim.leaseExpiresAtMs;
      const stopAtMs = Math.min(claim.leaseExpiresAtMs, deadlineAtMs);
      const signal = AbortSignal.timeout(Math.max(0, stopAtMs - Date.now()));
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
              if (claim.targetKind !== 'turn' && job.result.output.kind === 'save_memory') {
                return unknownOutcome(handle, 'MODEL_INVALID_OUTPUT');
              }
              return {
                status: 'succeeded',
                operationId,
                providerJobHandle: handle,
                outputJson: JSON.stringify({
                  text: job.result.output.text,
                  ...(claim.targetKind === 'turn' && job.result.output.kind === 'save_memory'
                    ? { personalMemorySave: job.result.output.memory.arguments }
                    : {}),
                }),
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
                    ...(claim.targetKind === 'turn' ? { enablePersonalMemorySaveTool: true } : {}),
                    maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
                  },
                },
                signal,
              )) {
                if (event.kind === 'job') handle = event.handle;
                if (event.kind === 'result') {
                  if (claim.targetKind !== 'turn' && event.result.output.kind === 'save_memory') {
                    return unknownOutcome(handle, 'MODEL_INVALID_OUTPUT');
                  }
                  return {
                    status: 'succeeded',
                    operationId,
                    providerJobHandle: handle,
                    outputJson: JSON.stringify({
                      text: event.result.output.text,
                      ...(claim.targetKind === 'turn' && event.result.output.kind === 'save_memory'
                        ? { personalMemorySave: event.result.output.memory.arguments }
                        : {}),
                    }),
                    errorCode: null,
                    usage: event.result.usage,
                  };
                }
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
      const commitOutcome = toAgentHeadDurableCommitOutcome({
        targetKind: claim.targetKind,
        context,
        outcome,
        modelLabel: FAKE_MODEL_LABEL,
        simulated: true,
      });
      if (proactive !== null && commitOutcome['status'] === 'completed') {
        const readable = unwrapJsonText(commitOutcome['detailText']);
        return {
          ...commitOutcome,
          summaryText: proactive.title,
          detailText: readable ?? proactive.prompt,
        };
      }
      return commitOutcome;
    },
  };
}
