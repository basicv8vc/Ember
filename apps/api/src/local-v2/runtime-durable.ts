import {
  buildBoundedContext,
  estimateCostMicroUsd,
  FAKE_MODEL_LABEL,
  FAKE_V2_RATE_VERSION,
  fitConversationTurnInputToCap,
  isModelGatewayFailure,
  MODEL_LIMITS,
  preflightConversationTurn,
  type ContextRow,
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
  toV2DelegationCommand,
  type V2ModelRuntime,
  type V2StreamingModelGateway,
} from './model-runtime.js';
import {
  buildProactiveBriefPrompt,
  loadRecentBriefMessages,
  type BriefContextMessage,
  type ProactiveBriefContext,
} from './proactive-brief-context.js';
import {
  executeV2PythonAgentTask,
  type V2PythonSandboxFactory,
  type V2PythonStepGateway,
} from './python-agent-runner.js';
import { resolveV2SandboxConfig } from './runtime-config.js';
import { createEdgeRpc, getHead, type AgentHeadDO, type LocalRuntimeEnv } from './runtime-head.js';

export type V2FakeDurableGateway = Pick<
  V2StreamingModelGateway,
  'streamConversationTurn' | 'queryConversationJob'
> &
  Partial<V2PythonStepGateway>;

export interface CreateDurableExecutorOptions {
  readonly modelRuntime?: V2ModelRuntime;
  /** Test-only sandbox factory seam; production always constructs DaytonaSandboxProvider from env. */
  readonly pythonSandboxFactory?: V2PythonSandboxFactory;
}

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
  options: CreateDurableExecutorOptions = {},
): DurableExecutorPort {
  const runtime = options.modelRuntime;
  const sandboxConfig = runtime?.sandboxConfig ?? resolveV2SandboxConfig(env);
  const modelLabel = runtime?.modelLabel ?? FAKE_MODEL_LABEL;
  const simulated = runtime?.simulated ?? true;
  const budgetMode = runtime?.budgetMode ?? 'simulated_full_protocol';
  const providerId = runtime?.providerId ?? 'fake';
  const rateVersion = runtime?.rateVersion ?? FAKE_V2_RATE_VERSION;
  const rate = runtime?.rate ?? null;

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

      if (claim.targetKind === 'task' && proactive === null) {
        const rawContext = JSON.parse(claim.contextJson) as {
          readonly kind?: string;
          readonly runId?: string;
        };
        if (rawContext.kind === 'python.agent' && rawContext.runId !== undefined) {
          if (sandboxConfig.kind === 'disabled') {
            return { status: 'failed', reasonCode: sandboxConfig.reason };
          }
          if (runtime !== undefined && !runtime.isTenantAuthorized(claim.tenantId)) {
            return { status: 'failed', reasonCode: 'model_unauthorized_tenant' };
          }
          const allowFakeFastPathOnly =
            sandboxConfig.kind === 'fake' && simulated && runtime?.mode !== 'real';
          if (
            !allowFakeFastPathOnly &&
            (gateway.stepPythonAgent === undefined ||
              gateway.providerId === undefined ||
              gateway.modelLabel === undefined ||
              gateway.simulated === undefined ||
              (runtime?.mode === 'real' && (gateway.simulated !== false || rate === null)))
          ) {
            return { status: 'failed', reasonCode: 'model_gateway_unavailable' };
          }
          return executeV2PythonAgentTask({
            env,
            claim,
            gateway:
              allowFakeFastPathOnly && gateway.stepPythonAgent === undefined
                ? {
                    providerId: 'fake',
                    modelLabel,
                    simulated: true,
                  }
                : {
                    providerId: gateway.providerId!,
                    modelLabel: gateway.modelLabel!,
                    simulated: gateway.simulated!,
                    stepPythonAgent: gateway.stepPythonAgent!.bind(gateway),
                  },
            modelRate: rate,
            budgetMode,
            ...(runtime === undefined
              ? {}
              : { perAttemptCeilingMicroUsd: runtime.perAttemptCeilingMicroUsd }),
            ...(options.pythonSandboxFactory === undefined
              ? {}
              : { sandboxFactory: options.pythonSandboxFactory }),
          });
        }
        return { status: 'failed', reasonCode: 'local_task_driver_unavailable' };
      }

      if (claim.targetKind === 'task' && context.attemptId === undefined) {
        if (proactive === null) {
          return { status: 'failed', reasonCode: 'local_task_driver_unavailable' };
        }
        if (runtime !== undefined && !runtime.isTenantAuthorized(claim.tenantId)) {
          return {
            status: 'failed',
            summaryText: proactive.title,
            detailText: null,
            modelLabel,
            simulated,
            reasonCode: 'model_unauthorized_tenant',
          };
        }
        if (
          runtime?.mode === 'real' &&
          !runtime.allowRecurringBriefs &&
          proactive.scheduleKind !== 'once'
        ) {
          return {
            status: 'failed',
            summaryText: proactive.title,
            detailText: null,
            modelLabel,
            simulated,
            reasonCode: 'recurring_real_model_unauthorized',
          };
        }
        const rawClaim = JSON.parse(claim.contextJson) as Record<string, unknown>;
        const runId = typeof rawClaim['runId'] === 'string' ? rawClaim['runId'] : null;
        if (runId === null) {
          return { status: 'failed', reasonCode: 'missing_run_id' };
        }
        const briefContext = await loadProactiveBriefContext(
          head,
          claim.tenantId,
          claim.agentId,
          context.conversationId,
          proactive,
        );
        const briefPrompt = buildProactiveBriefPrompt(proactive, briefContext);
        let estimatedMicroUsd = PROACTIVE_BRIEF_RESERVATION_MICRO_USD;
        if (runtime !== undefined) {
          try {
            estimatedMicroUsd = runtime.estimateBriefReservation(briefPrompt);
          } catch {
            return {
              status: 'failed',
              summaryText: proactive.title,
              detailText: null,
              modelLabel,
              simulated,
              reasonCode: 'budget_exceeded',
            };
          }
        }
        const reservation = await head.reserveTaskModelAttempt({
          tenantId: claim.tenantId,
          principalId: proactive.principalId,
          agentId: claim.agentId,
          taskId: claim.targetId,
          runId,
          leaseEpoch: claim.leaseEpoch,
          budgetMode,
          providerId,
          modelLabel,
          rateVersion,
          estimatedMicroUsd,
        });
        if (reservation.kind === 'refused') {
          return {
            status: 'failed',
            summaryText: proactive.title,
            detailText: null,
            modelLabel,
            simulated,
            reasonCode: reservation.reason,
          };
        }
        context = {
          ...context,
          operationId: reservation.operationId,
          attemptNo: reservation.attemptNo,
          attemptId: String(reservation.attemptNo),
          sendState: 'unsent',
          sendAuthorizingAtMs: null,
          sendStartedAtMs: null,
          inputJson: JSON.stringify({ prompt: briefPrompt }),
        };
      } else if (proactive !== null) {
        const briefContext = await loadProactiveBriefContext(
          head,
          claim.tenantId,
          claim.agentId,
          context.conversationId,
          proactive,
        );
        const briefPrompt = buildProactiveBriefPrompt(proactive, briefContext);
        if (context.sendState === 'unsent' && context.providerJobHandle === null) {
          const releaseBriefBeforeSend = (reasonCode: string): Record<string, unknown> => ({
            attemptNo: context.attemptNo,
            operationId: context.operationId,
            settlement: { state: 'released', outcomeCode: 'not_sent' },
            status: 'failed',
            summaryText: proactive.title,
            detailText: null,
            modelLabel,
            simulated,
            reasonCode,
          });
          if (runtime !== undefined && !runtime.isTenantAuthorized(claim.tenantId)) {
            return releaseBriefBeforeSend('model_unauthorized_tenant');
          }
          if (
            runtime?.mode === 'real' &&
            !runtime.allowRecurringBriefs &&
            proactive.scheduleKind !== 'once'
          ) {
            return releaseBriefBeforeSend('recurring_real_model_unauthorized');
          }
          if (rate !== null) {
            try {
              const preflight = preflightConversationTurn({
                messages: [{ role: 'user', text: briefPrompt }],
                allowDelegationTools: false,
                maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
              });
              const rawClaim = JSON.parse(claim.contextJson) as {
                readonly reservedMicroUsd?: unknown;
              };
              const reservedMicroUsd =
                typeof rawClaim.reservedMicroUsd === 'number' ? rawClaim.reservedMicroUsd : 0;
              if (
                estimateCostMicroUsd(rate, preflight.inputTokens, preflight.maxOutputTokens) >
                reservedMicroUsd
              ) {
                return releaseBriefBeforeSend('budget_exceeded');
              }
            } catch {
              return releaseBriefBeforeSend('budget_exceeded');
            }
          }
        }
        context = {
          ...context,
          inputJson: JSON.stringify({ prompt: briefPrompt }),
        };
      }

      if (context.attemptId === undefined) throw new Error('Missing authoritative model attempt');

      if (
        claim.targetKind === 'turn' &&
        context.sendState === 'unsent' &&
        context.providerJobHandle === null
      ) {
        if (runtime !== undefined && !runtime.isTenantAuthorized(claim.tenantId)) {
          return {
            attemptNo: context.attemptNo,
            operationId: context.operationId,
            settlement: { state: 'released', outcomeCode: 'not_sent' },
            status: 'failed',
            failureReason: 'internal_error',
          };
        }
        if (rate !== null) {
          try {
            const input: unknown = JSON.parse(context.inputJson ?? 'null');
            const messages = buildBoundedContext(input as readonly ContextRow[]).messages;
            const { preflight } = fitConversationTurnInputToCap({
              messages,
              ...(context.personalMemories !== undefined && context.personalMemories.length > 0
                ? { personalMemories: context.personalMemories }
                : {}),
              enablePersonalMemorySaveTool: true,
              enableProactiveScheduleTool: true,
              maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
            });
            const rawClaim = JSON.parse(claim.contextJson) as {
              readonly reservedMicroUsd?: unknown;
            };
            const reservedMicroUsd =
              typeof rawClaim.reservedMicroUsd === 'number' ? rawClaim.reservedMicroUsd : 0;
            if (
              estimateCostMicroUsd(rate, preflight.inputTokens, preflight.maxOutputTokens) >
              reservedMicroUsd
            ) {
              throw new Error('Model preflight estimate exceeds reservation');
            }
          } catch {
            return {
              attemptNo: context.attemptNo,
              operationId: context.operationId,
              settlement: { state: 'released', outcomeCode: 'not_sent' },
              status: 'failed',
              failureReason: 'internal_error',
            };
          }
        }
      }

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

      function toProviderSuccessOutcome(
        handle: string | null,
        callResult: {
          readonly output: Parameters<typeof toV2DelegationCommand>[0];
          readonly simulated: boolean;
          readonly usage: FakeOrProviderJobOutcome['usage'];
        },
      ): FakeOrProviderJobOutcome {
        const { output } = callResult;
        if (
          callResult.simulated !== simulated ||
          (claim.targetKind !== 'turn' && output.kind !== 'reply')
        ) {
          return unknownOutcome(handle, 'MODEL_INVALID_OUTPUT');
        }
        const delegation =
          claim.targetKind === 'turn' && output.kind === 'delegate'
            ? toV2DelegationCommand(output)
            : undefined;
        if (!callResult.simulated) {
          console.log(
            JSON.stringify({
              event: 'v2.model_attempt',
              path: 'durable',
              targetKind: claim.targetKind,
              operationId,
              modelLabel,
              simulated: callResult.simulated,
              outputKind: output.kind,
              observedCostMicroUsd: callResult.usage?.costMicroUsd ?? null,
              inputTokens: callResult.usage?.inputTokens ?? null,
              outputTokens: callResult.usage?.outputTokens ?? null,
            }),
          );
        }
        return {
          status: 'succeeded',
          operationId,
          providerJobHandle: handle,
          outputJson: JSON.stringify({
            text: output.text,
            ...(delegation !== undefined ? { delegation } : {}),
            ...(claim.targetKind === 'turn' && output.kind === 'save_memory'
              ? { personalMemorySave: output.memory.arguments }
              : {}),
            ...(claim.targetKind === 'turn' && output.kind === 'delete_memory'
              ? { personalMemoryDelete: output.memory.arguments }
              : {}),
            ...(claim.targetKind === 'turn' && output.kind === 'create_schedule'
              ? { proactiveScheduleCreate: output.schedule.arguments }
              : {}),
          }),
          errorCode: null,
          usage: callResult.usage,
        };
      }

      async function poll(handle: string): Promise<FakeOrProviderJobOutcome> {
        try {
          while (!signal.aborted && Date.now() < stopAtMs) {
            const job = await gateway.queryConversationJob(operationId, handle, signal);
            if (job.state === 'unavailable') return unknownOutcome(handle, 'JOB_UNAVAILABLE');
            if (job.state === 'completed') {
              return toProviderSuccessOutcome(handle, job.result);
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
              const fittedTurn =
                claim.targetKind === 'turn'
                  ? fitConversationTurnInputToCap({
                      messages: buildBoundedContext(input as readonly ContextRow[]).messages,
                      ...(context.personalMemories !== undefined &&
                      context.personalMemories.length > 0
                        ? { personalMemories: context.personalMemories }
                        : {}),
                      enablePersonalMemorySaveTool: true,
                      enableProactiveScheduleTool: true,
                      maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
                    }).input
                  : undefined;
              const messages =
                fittedTurn !== undefined
                  ? fittedTurn.messages
                  : [{ role: 'user' as const, text: task?.prompt ?? task?.notes ?? '' }];
              for await (const event of gateway.streamConversationTurn(
                {
                  operationId,
                  deadlineAtMs,
                  input: {
                    conversationId: context.conversationId ?? claim.targetId,
                    turnId: claim.targetId,
                    context: messages,
                    ...(fittedTurn?.personalMemories !== undefined &&
                    fittedTurn.personalMemories.length > 0
                      ? { personalMemories: fittedTurn.personalMemories }
                      : {}),
                    ...(claim.targetKind === 'turn'
                      ? {
                          enablePersonalMemorySaveTool: true,
                          enableProactiveScheduleTool: true,
                          currentTimeIso: new Date().toISOString(),
                        }
                      : { allowDelegationTools: false }),
                    maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
                  },
                },
                signal,
              )) {
                if (event.kind === 'job') handle = event.handle;
                if (event.kind === 'result') {
                  return toProviderSuccessOutcome(handle, event.result);
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
        modelLabel,
        simulated,
      });
      if (
        claim.targetKind === 'turn' &&
        commitOutcome['status'] === 'completed' &&
        outcome.outputJson !== null
      ) {
        try {
          const parsed = JSON.parse(outcome.outputJson) as Record<string, unknown>;
          if (parsed['delegation'] !== undefined) {
            commitOutcome['delegation'] = parsed['delegation'];
          }
        } catch {
          // Ignore non-JSON outputs.
        }
      }
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
