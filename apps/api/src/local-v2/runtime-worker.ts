import { DomainError } from '@ember/domain';
import {
  D1RecoveryRegistry,
  RecoverySweeper,
  handleDurableDeadLetterBatch,
  handleDurableQueueBatch,
  type QueueMessageLike,
  type ResolvedMessageAttachment,
} from '@ember/runtime-v2';
import { createLocalV2EdgeWorker } from './edge-worker.js';
import { resolveV2ModelRuntime } from './model-runtime.js';
import {
  createD1RecoveryReadiness,
  resolveV2AllowedHosts,
  resolveV2QueueTarget,
} from './runtime-config.js';
import { createDurableExecutor } from './runtime-durable.js';
import { createEdgeRpc, getHead, type LocalRuntimeEnv } from './runtime-head.js';
import { createLocalSessions, createStagingV2Sessions } from './runtime-session.js';

export { GlobalBudgetDO } from '@ember/runtime-v2/global-budget-do';
export { AgentHeadDO } from './runtime-head.js';

export default {
  fetch(request: Request, env: LocalRuntimeEnv, ctx: { waitUntil(work: Promise<void>): void }) {
    const modelRuntime = resolveV2ModelRuntime(env);
    const allowedHosts = resolveV2AllowedHosts(env);
    const sessions =
      env.EMBER_ENV === 'v2-staging' ? createStagingV2Sessions(env) : createLocalSessions(env);
    return createLocalV2EdgeWorker({
      sessions,
      allowedHosts,
      readiness: createD1RecoveryReadiness(env.D1_RECOVERY),
      ...(env.EMBER_BLOBS === undefined ? {} : { r2Bucket: env.EMBER_BLOBS }),
      async resolveAgentHead(auth) {
        const me = await sessions.me.getMeForTenant(auth.tenantId);
        if (me === null) return null;
        const agentId = me.agent.agent_id;
        return {
          agentId,
          conversationId: me.conversation.conversation_id,
          rpc: createEdgeRpc(getHead(env, auth.tenantId, agentId)),
        };
      },
      async resolveAttachments(auth, uploadIds, clientSubmissionId) {
        const me = await sessions.me.getMeForTenant(auth.tenantId);
        if (me === null) return [];
        const rpc = createEdgeRpc(getHead(env, auth.tenantId, me.agent.agent_id));
        return (await rpc.taskArtifacts({
          kind: 'resolve_staged_uploads',
          tenantId: auth.tenantId,
          principalId: auth.principalId,
          agentId: me.agent.agent_id,
          requestId: crypto.randomUUID(),
          uploadIds,
          ...(clientSubmissionId === undefined ? {} : { clientSubmissionId }),
        })) as readonly ResolvedMessageAttachment[];
      },
      stream: {
        gateway: modelRuntime.gateway,
        expectedSimulated: modelRuntime.simulated,
        preflightRate: modelRuntime.rate,
        authorizeModelTurn: (auth) => {
          if (!modelRuntime.isTenantAuthorized(auth.tenantId)) {
            throw new DomainError(
              'POLICY_DENIED',
              'real model execution is not enabled for this tenant',
            );
          }
        },
        resolveModelReservation: () => modelRuntime.getTurnReservation(),
        reportObservedUsage: (req) =>
          getHead(env, req.scope.tenantId, req.scope.agentId).recordTurnUsage(req),
      },
    }).fetch(request, env, ctx);
  },

  async queue(
    batch: { queue: string; messages: readonly QueueMessageLike[] },
    env: LocalRuntimeEnv,
  ) {
    const modelRuntime = resolveV2ModelRuntime(env);
    const resolve = (tenantId: string, agentId: string) => getHead(env, tenantId, agentId);
    const router = { getAgentHeadRecoveryPort: resolve, getDeadLetterPort: resolve };
    const target = resolveV2QueueTarget(batch.queue, env);
    if (target === null) {
      throw new Error('Unexpected V2 queue');
    }
    if (target.kind === 'primary') {
      await handleDurableQueueBatch({
        queueName: target.logicalQueue,
        messages: batch.messages,
        router,
        workerId: crypto.randomUUID(),
        executor: createDurableExecutor(env, modelRuntime.gateway, { modelRuntime }),
      });
      return;
    }
    await handleDurableDeadLetterBatch({
      expectedQueueName: target.expectedQueueName,
      messages: batch.messages,
      router,
      nowMs: Date.now,
    });
  },

  async scheduled(_event: unknown, env: LocalRuntimeEnv) {
    resolveV2ModelRuntime(env);
    const db = env.D1_RECOVERY;
    await new RecoverySweeper({
      db,
      registry: new D1RecoveryRegistry(db),
      targets: { getRecoveryTarget: (tenantId, agentId) => getHead(env, tenantId, agentId) },
    }).sweepDueAgents({ sweeperId: crypto.randomUUID(), nowMs: Date.now() });
  },
};
