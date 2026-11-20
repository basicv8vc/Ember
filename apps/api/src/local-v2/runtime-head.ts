// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Share the minimal Workers ambient module without adding browser-conflicting globals.
/// <reference path="../../../../packages/runtime-v2/src/global-budget/cloudflare-workers.d.ts" />

import type { DurableObjectState } from '@cloudflare/workers-types/index.js';
import { DomainError, isDomainError, type DomainErrorCode } from '@ember/domain';
import {
  AgentEventRuntimeFacade,
  AgentHeadCore,
  D1RecoveryRegistry,
  createAgentHeadGlobalBudgetOptions,
  formatRecoveryAgentKey,
  getHeadMetaSync,
  getMainConversationSync,
  resolveDeadLetterRetrySchedule,
  type AgentHeadDeadLetterPort,
  type AgentHeadRpc,
  type AgentRecoveryTargetPort,
  type D1DatabaseLike,
  type DeviceExecutionRpc,
  type GlobalBudgetBindings,
  type ObservedTurnUsage,
  type QueueLike,
  type V2DispatchEnvelope,
} from '@ember/runtime-v2';
import { DurableObject } from 'cloudflare:workers';
import type { EdgeAgentHeadRpc, HeadScope } from './rpc.js';

export interface LocalRuntimeEnv extends GlobalBudgetBindings {
  readonly AGENT_HEAD: {
    getByName(name: string): AgentHeadDO;
    idFromName(name: string): DurableObjectState['id'];
  };
  readonly D1_RECOVERY: D1DatabaseLike;
  readonly DURABLE_TURN_QUEUE: QueueLike<V2DispatchEnvelope>;
  readonly AGENT_TASK_QUEUE: QueueLike<V2DispatchEnvelope>;
  readonly FAKE_MODEL_GATEWAY_URL: string;
  readonly EMBER_ENV: string;
  readonly EMBER_MODEL_MODE: string;
  readonly EMBER_V2_ISOLATED_HARNESS: string;
}

type LocalEdgeRpc = EdgeAgentHeadRpc & DeviceExecutionRpc;
type CoreEdgeRpc = AgentHeadRpc & DeviceExecutionRpc;
type EdgeMethod = keyof LocalEdgeRpc;
type EdgeRequest<K extends EdgeMethod> = Parameters<CoreEdgeRpc[K]>[0];
type EdgeResult<K extends EdgeMethod> = Awaited<ReturnType<CoreEdgeRpc[K]>>;
type RpcResult<T> = { readonly value: T } | { readonly code: DomainErrorCode };

export function getHead(env: LocalRuntimeEnv, tenantId: string, agentId: string) {
  return env.AGENT_HEAD.getByName(formatRecoveryAgentKey(tenantId, agentId));
}

export function createEdgeRpc(head: AgentHeadDO): LocalEdgeRpc {
  async function call<K extends EdgeMethod>(
    method: K,
    request: EdgeRequest<K>,
  ): Promise<EdgeResult<K>> {
    const result = await head.edgeRpc(method, request);
    if ('code' in result) throw new DomainError(result.code);
    return result.value;
  }

  return {
    prepareTurn: (req) => call('prepareTurn', req),
    markAttemptSent: (req) => call('markAttemptSent', req),
    renewTurnLease: (req) => call('renewTurnLease', req),
    commitTurn: (req) => call('commitTurn', req),
    handoffTurnToDurable: (req) => call('handoffTurnToDurable', req),
    readMessages: (req) => call('readMessages', req),
    findSubmissionReceipt: (req) => call('findSubmissionReceipt', req),
    getTurn: (req) => call('getTurn', req),
    cancelTurn: (req) => call('cancelTurn', req),
    clearTranscript: (req) => call('clearTranscript', req),
    deviceExecution: (req) => call('deviceExecution', req),
  };
}

export class AgentHeadDO
  extends DurableObject<LocalRuntimeEnv>
  implements AgentRecoveryTargetPort, AgentHeadDeadLetterPort
{
  #runtime: { core: AgentHeadCore; events: AgentEventRuntimeFacade } | undefined;

  constructor(
    private readonly state: DurableObjectState,
    private readonly bindings: LocalRuntimeEnv,
  ) {
    super(state, bindings);
  }

  #load(bootstrap?: HeadScope) {
    if (this.#runtime !== undefined) return this.#runtime;

    const storage = this.state.storage;
    const anchored =
      storage.sql.exec('SELECT name FROM sqlite_master WHERE name = ?', 'agent_head_meta').toArray()
        .length > 0;
    const meta = anchored ? getHeadMetaSync(storage.sql) : null;
    const scope = meta === null ? bootstrap : { tenantId: meta.tenant_id, agentId: meta.agent_id };
    if (
      scope === undefined ||
      !this.state.id.equals(
        this.bindings.AGENT_HEAD.idFromName(formatRecoveryAgentKey(scope.tenantId, scope.agentId)),
      )
    ) {
      throw new DomainError('NOT_FOUND', 'agent head identity is unavailable');
    }

    // Core offers the business port before it needs the facade's recovery hooks.
    let events!: AgentEventRuntimeFacade;
    const registry = new D1RecoveryRegistry(this.bindings.D1_RECOVERY);
    const core: AgentHeadCore = new AgentHeadCore({
      ...scope,
      storage,
      recoveryRegistry: registry,
      ...createAgentHeadGlobalBudgetOptions(this.bindings),
      eventRuntimeFactory(business) {
        events = new AgentEventRuntimeFacade({ ...scope, storage, business });
        return {
          recoveryAdmission: events.coverage,
          eventCoordinator: events.outbox,
          recoveryHooks: events.asTurnRecoveryHooks({
            globalBudget: { settleGlobal: (payload) => budget.settleGlobal(payload) },
          }),
        };
      },
    });
    const budget = core.createGlobalBudgetSettlePort();
    this.#runtime = { core, events };
    return this.#runtime;
  }

  bootstrap(scope: HeadScope, conversationId: string) {
    return Promise.resolve(this.#load(scope).core.bootstrapHead({ conversationId }));
  }

  async projectConversation(scope: HeadScope) {
    const identity = await this.#load().core.getMainConversation(scope);
    if (identity === null) return null;
    const row = getMainConversationSync(this.state.storage.sql)!;
    return {
      conversation_id: identity.conversationId,
      transcript_epoch: identity.transcriptEpoch,
      created_at: new Date(row.created_at_ms).toISOString(),
      updated_at: new Date(row.updated_at_ms).toISOString(),
    };
  }

  async edgeRpc<K extends EdgeMethod>(
    method: K,
    req: EdgeRequest<K>,
  ): Promise<RpcResult<EdgeResult<K>>> {
    try {
      const core = this.#load().core;
      // DO RPC serializes Error objects without domain fields. Preserve the safe code.
      const invoke = core[method] as (request: EdgeRequest<K>) => Promise<EdgeResult<K>>;
      return { value: await invoke.call(core, req) };
    } catch (error) {
      if (!isDomainError(error)) throw error;
      return { code: error.code };
    }
  }

  recordTurnUsage(req: ObservedTurnUsage) {
    return this.#load().core.turnService.recordTurnUsage(req);
  }

  markAttemptSent(req: Parameters<AgentHeadRpc['markAttemptSent']>[0]) {
    return this.#load().core.markAttemptSent(req);
  }

  claimDurableWork(req: Parameters<AgentHeadCore['claimDurableWork']>[0]) {
    return this.#load().core.claimDurableWork(req);
  }

  commitDurableResult(req: Parameters<AgentHeadCore['commitDurableResult']>[0]) {
    return this.#load().core.commitDurableResult(req);
  }

  reconcileFromRegistry(req: Parameters<AgentHeadCore['reconcileFromRegistry']>[0]) {
    return this.#load().core.reconcileFromRegistry(req);
  }

  confirmRegistryPlan(req: Parameters<AgentHeadCore['confirmRegistryPlan']>[0]) {
    return this.#load().core.confirmRegistryPlan(req);
  }

  async onDispatchDeadLetter(req: Parameters<AgentHeadDeadLetterPort['onDispatchDeadLetter']>[0]) {
    const { events } = this.#load();
    const { envelope, errorCode, nowMs, graceMs } = req;
    const result = this.state.storage.transactionSync(() => {
      const row = events.outbox.getOutboxByIdSync(envelope.eventId);
      const target = events.business.inspectOutboxTargetSync(
        envelope.entityKind,
        envelope.entityId,
      );
      if (
        row === null ||
        row.queue_name !== envelope.queueName ||
        row.entity_kind !== envelope.entityKind ||
        row.entity_id !== envelope.entityId ||
        row.fence_epoch !== envelope.fenceEpoch ||
        target.currentLeaseEpoch !== envelope.fenceEpoch ||
        !target.exists ||
        target.isTerminal ||
        target.cancelRequested
      )
        return { action: 'ignored_stale_or_terminal', alarmAtMs: null } as const;

      const retry = resolveDeadLetterRetrySchedule({
        nowMs,
        deadlineAtMs: target.deadlineAtMs,
        graceMs,
        isTerminalOrCancelled: false,
      });
      if (
        retry.alarmAtMs === null ||
        !events.outbox.applyOutboxDeadLetterSync({
          outboxId: envelope.eventId,
          fenceEpoch: envelope.fenceEpoch,
          errorCode,
          nowMs,
          nextAttemptAtMs: Math.max(nowMs, retry.alarmAtMs),
        })
      )
        return { action: 'ignored_stale_or_terminal', alarmAtMs: null } as const;

      return { action: retry.action, alarmAtMs: events.outbox.recomputeAlarmSync(nowMs) };
    });
    if (result.action !== 'ignored_stale_or_terminal') {
      await events.alarm.syncPlatformAlarm(result.alarmAtMs, nowMs);
    }
    return result;
  }

  async runRecoveryAlarmCycle(nowMs: number) {
    const { core, events } = this.#load();
    await events.handleAlarm({
      nowMs,
      queues: {
        durable_turn: this.bindings.DURABLE_TURN_QUEUE,
        agent_task: this.bindings.AGENT_TASK_QUEUE,
      },
      globalBudget: core.createGlobalBudgetSettlePort(),
      registry: new D1RecoveryRegistry(this.bindings.D1_RECOVERY),
    });
  }

  override alarm() {
    return this.runRecoveryAlarmCycle(Date.now());
  }
}
