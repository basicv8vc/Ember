import { LoopbackFakeModelGateway } from '@ember/model-gateway';
import {
  D1RecoveryRegistry,
  RecoverySweeper,
  handleDurableDeadLetterBatch,
  handleDurableQueueBatch,
  type QueueMessageLike,
} from '@ember/runtime-v2';
import { createLocalV2EdgeWorker } from './edge-worker.js';
import { createD1RecoveryReadiness, resolveV2QueueTarget } from './runtime-config.js';
import { createDurableExecutor } from './runtime-durable.js';
import { createEdgeRpc, getHead, type LocalRuntimeEnv } from './runtime-head.js';
import { createLocalSessions } from './runtime-session.js';

export { GlobalBudgetDO } from '@ember/runtime-v2/global-budget-do';
export { AgentHeadDO } from './runtime-head.js';

function localGateway(env: LocalRuntimeEnv) {
  if (
    !['local', 'test', 'ci'].includes(env.EMBER_ENV) ||
    env.EMBER_MODEL_MODE !== 'fake' ||
    env.EMBER_V2_ISOLATED_HARNESS !== 'true'
  ) {
    throw new Error('Expected isolated V2 runtime with fake model gateway');
  }
  return new LoopbackFakeModelGateway(env.FAKE_MODEL_GATEWAY_URL);
}

export default {
  fetch(request: Request, env: LocalRuntimeEnv, ctx: { waitUntil(work: Promise<void>): void }) {
    const gateway = localGateway(env);
    const sessions = createLocalSessions(env);
    return createLocalV2EdgeWorker({
      sessions,
      readiness: createD1RecoveryReadiness(env.D1_RECOVERY),
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
      stream: {
        gateway,
        reportObservedUsage: (req) =>
          getHead(env, req.scope.tenantId, req.scope.agentId).recordTurnUsage(req),
      },
    }).fetch(request, env, ctx);
  },

  async queue(
    batch: { queue: string; messages: readonly QueueMessageLike[] },
    env: LocalRuntimeEnv,
  ) {
    const gateway = localGateway(env);
    const resolve = (tenantId: string, agentId: string) => getHead(env, tenantId, agentId);
    const router = { getAgentHeadRecoveryPort: resolve, getDeadLetterPort: resolve };
    const target = resolveV2QueueTarget(batch.queue, env);
    if (target === null) {
      throw new Error('Unexpected local V2 queue');
    }
    if (target.kind === 'primary') {
      await handleDurableQueueBatch({
        queueName: target.logicalQueue,
        messages: batch.messages,
        router,
        workerId: crypto.randomUUID(),
        executor: createDurableExecutor(env, gateway),
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
    localGateway(env);
    const db = env.D1_RECOVERY;
    await new RecoverySweeper({
      db,
      registry: new D1RecoveryRegistry(db),
      targets: { getRecoveryTarget: (tenantId, agentId) => getHead(env, tenantId, agentId) },
    }).sweepDueAgents({ sweeperId: crypto.randomUUID(), nowMs: Date.now() });
  },
};
