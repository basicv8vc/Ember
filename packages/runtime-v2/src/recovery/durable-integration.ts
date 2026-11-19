import type { DurableObjectStorageLike, QueueLike } from '../storage.js';
import { relayDueBudgetSyncBatch, type GlobalBudgetSettlePort } from './budget-sync.js';
import type { V2DispatchEnvelope } from './envelope.js';
import {
  OutboxCoordinator,
  verifyAndClaimDispatchEnvelope,
  type DurableAgentIdentity,
  type VerifyAndClaimDispatchResult,
} from './outbox.js';
import type {
  AgentHeadRecoveryPort,
  AuthoritativeBusinessPort,
  RecoveryRegistryPort,
} from './ports.js';
import {
  AlarmMultiplexer,
  RecoveryCoverageCoordinator,
  type AgentRecoveryTargetPort,
  type AlarmCycleResult,
} from './registry.js';
import type { V2DispatchOutboxRow, V2QueueName, V2RecoveryCoverageRow } from './schema.js';
import { ScheduleRepository } from './schedules.js';

export interface DurableExecutionClaimContext {
  readonly operationId: string;
  readonly entityKind: 'turn' | 'task';
  readonly entityId: string;
  readonly attemptId?: string;
  readonly sendStartedAtMs: number | null;
  readonly providerJobHandle: string | null;
  readonly interactiveHandoff?: boolean;
  readonly inputJson?: string;
}

export interface FakeOrProviderJobOutcome {
  readonly status: 'succeeded' | 'failed' | 'retryable_failed' | 'unknown_billed';
  readonly operationId: string;
  readonly providerJobHandle: string | null;
  readonly outputJson: string | null;
  readonly errorCode: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicroUsd: number;
  } | null;
}

/**
 * Provider execution port supporting idempotent job handle polling vs initial dispatch
 * (M1-B4: never blind-replay uncertain or already-sent operations).
 */
export interface DurableProviderExecutorPort {
  pollProviderJob(cmd: {
    readonly providerJobHandle: string;
    readonly operationId: string;
    readonly signal?: AbortSignal;
  }): Promise<FakeOrProviderJobOutcome>;

  startProviderJob(cmd: {
    readonly operationId: string;
    readonly entityKind: 'turn' | 'task';
    readonly entityId: string;
    readonly inputJson?: string;
    readonly signal?: AbortSignal;
  }): Promise<FakeOrProviderJobOutcome>;
}

export type HandoffAdmissionValidation =
  | {
      readonly ok: true;
      readonly preservedDeadlineAtMs: number;
      readonly preservedOperationId: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'LEASE_OWNER_MISMATCH'
        | 'LEASE_EXPIRED'
        | 'DEADLINE_EXPIRED'
        | 'CANCEL_REQUESTED'
        | 'NOT_ACTIVE_FAST_PATH';
    };

/**
 * Validates Fast Path -> Durable Path handoff invariants (V2-M0-B §7 & J4):
 * - Requires active non-expired lease held by caller (`nowMs < leaseExpiresAtMs`)
 * - Rejects cancelled, wrong-owner, non-running, or deadline-expired entities
 * - Preserves original `deadlineAtMs` and `operationId` (never extends deadline)
 */
export function validateHandoffTransition(cmd: {
  readonly status: string;
  readonly leaseOwner: string | null;
  readonly callerLeaseOwner: string;
  readonly leaseExpiresAtMs: number | null;
  readonly deadlineAtMs: number;
  readonly cancelRequestedAtMs: number | null;
  readonly operationId: string;
  readonly nowMs: number;
}): HandoffAdmissionValidation {
  if (cmd.status !== 'running') {
    return { ok: false, code: 'NOT_ACTIVE_FAST_PATH' };
  }
  if (cmd.cancelRequestedAtMs !== null) {
    return { ok: false, code: 'CANCEL_REQUESTED' };
  }
  if (cmd.leaseOwner === null || cmd.leaseOwner !== cmd.callerLeaseOwner) {
    return { ok: false, code: 'LEASE_OWNER_MISMATCH' };
  }
  if (cmd.leaseExpiresAtMs === null || cmd.nowMs >= cmd.leaseExpiresAtMs) {
    return { ok: false, code: 'LEASE_EXPIRED' };
  }
  if (cmd.nowMs >= cmd.deadlineAtMs) {
    return { ok: false, code: 'DEADLINE_EXPIRED' };
  }
  return {
    ok: true,
    preservedDeadlineAtMs: cmd.deadlineAtMs,
    preservedOperationId: cmd.operationId,
  };
}

/**
 * Executes a claimed durable work item while upholding single-execution & handle-recovery rules:
 * - Existing `providerJobHandle !== null`: ONLY polls/resumes original job handle (never blind replays)
 * - Missing handle when `sendStartedAtMs !== null`: request already went outbound -> settles honestly as
 *   `unknown_billed` with original `operationId` (zero blind duplicate call)
 * - Clean un-sent claim (`sendStartedAtMs === null && providerJobHandle === null`): starts provider job
 */
export async function executeRecoveredOrFreshDurableWork(cmd: {
  readonly context: DurableExecutionClaimContext;
  readonly provider: DurableProviderExecutorPort;
  readonly signal?: AbortSignal;
}): Promise<FakeOrProviderJobOutcome> {
  if (cmd.context.providerJobHandle !== null) {
    return cmd.provider.pollProviderJob({
      providerJobHandle: cmd.context.providerJobHandle,
      operationId: cmd.context.operationId,
      signal: cmd.signal,
    });
  }

  if (cmd.context.sendStartedAtMs !== null) {
    return {
      status: 'unknown_billed',
      operationId: cmd.context.operationId,
      providerJobHandle: null,
      outputJson: null,
      errorCode: 'UNCERTAIN_OUTCOME_NO_BLIND_REPLAY',
      usage: null,
    };
  }

  return cmd.provider.startProviderJob({
    operationId: cmd.context.operationId,
    entityKind: cmd.context.entityKind,
    entityId: cmd.context.entityId,
    inputJson: cmd.context.inputJson,
    signal: cmd.signal,
  });
}

/**
 * Parses `claimDurableWork.contextJson` returned by Agent A's `AgentHeadRecoveryService`
 * (or direct `DurableExecutionClaimContext`) into a normalized worker claim context.
 */
export function parseClaimExecutionContext(cmd: {
  readonly targetKind: 'turn' | 'task';
  readonly targetId: string;
  readonly leaseEpoch: number;
  readonly contextJson: string;
}): DurableExecutionClaimContext {
  const parsed = JSON.parse(cmd.contextJson) as Record<string, unknown>;
  if (
    typeof parsed['operationId'] === 'string' &&
    (parsed['entityKind'] === 'turn' || parsed['entityKind'] === 'task')
  ) {
    return {
      operationId: parsed['operationId'],
      entityKind: parsed['entityKind'],
      entityId: typeof parsed['entityId'] === 'string' ? parsed['entityId'] : cmd.targetId,
      attemptId: typeof parsed['attemptId'] === 'string' ? parsed['attemptId'] : undefined,
      sendStartedAtMs:
        typeof parsed['sendStartedAtMs'] === 'number' ? parsed['sendStartedAtMs'] : null,
      providerJobHandle:
        typeof parsed['providerJobHandle'] === 'string' ? parsed['providerJobHandle'] : null,
      interactiveHandoff:
        typeof parsed['interactiveHandoff'] === 'boolean'
          ? parsed['interactiveHandoff']
          : undefined,
      inputJson: typeof parsed['inputJson'] === 'string' ? parsed['inputJson'] : undefined,
    };
  }

  return {
    operationId: `${cmd.targetKind}:${cmd.targetId}:epoch:${cmd.leaseEpoch}`,
    entityKind: cmd.targetKind,
    entityId: cmd.targetId,
    attemptId: typeof parsed['runId'] === 'string' ? parsed['runId'] : undefined,
    sendStartedAtMs:
      typeof parsed['sendStartedAtMs'] === 'number' ? parsed['sendStartedAtMs'] : null,
    providerJobHandle:
      typeof parsed['providerJobHandle'] === 'string' ? parsed['providerJobHandle'] : null,
    inputJson:
      typeof parsed['inputJson'] === 'string'
        ? parsed['inputJson']
        : parsed['context'] !== undefined
          ? JSON.stringify(parsed['context'])
          : undefined,
  };
}

/**
 * Converts a worker `FakeOrProviderJobOutcome` into the canonical payload expected by
 * Agent A's `AgentHeadRecoveryService.commitDurableResult`.
 */
export function toAgentHeadDurableCommitOutcome(cmd: {
  readonly targetKind: 'turn' | 'task';
  readonly outcome: FakeOrProviderJobOutcome;
  readonly modelLabel?: string;
  readonly simulated?: boolean;
}): Record<string, unknown> {
  const fallbackText =
    cmd.outcome.outputJson ?? `Completed ${cmd.targetKind} (${cmd.outcome.operationId})`;
  if (cmd.targetKind === 'turn') {
    if (cmd.outcome.status === 'succeeded') {
      let text = fallbackText;
      if (cmd.outcome.outputJson !== null) {
        try {
          const parsed = JSON.parse(cmd.outcome.outputJson) as Record<string, unknown>;
          if (typeof parsed['text'] === 'string' && parsed['text'].length > 0) {
            text = parsed['text'];
          }
        } catch {
          // Retain raw outputJson string when non-JSON text is supplied
        }
      }
      return {
        status: 'completed',
        text,
        ...(cmd.modelLabel !== undefined ? { modelLabel: cmd.modelLabel } : {}),
        ...(cmd.simulated !== undefined ? { simulated: cmd.simulated } : {}),
      };
    }
    return {
      status: 'failed',
      failureReason: cmd.outcome.errorCode === 'TIMEOUT' ? 'timeout' : 'internal_error',
    };
  }

  const isCompleted = cmd.outcome.status === 'succeeded';
  return {
    status: isCompleted ? 'completed' : 'failed',
    summaryText: isCompleted ? fallbackText : null,
    detailText: cmd.outcome.outputJson,
    ...(cmd.modelLabel !== undefined ? { modelLabel: cmd.modelLabel } : {}),
    ...(cmd.simulated !== undefined ? { simulated: cmd.simulated } : {}),
    reasonCode: cmd.outcome.errorCode ?? (isCompleted ? 'ok' : 'internal_error'),
  };
}

/**
 * Single cohesive Agent B runtime facade for `AgentHeadDO`, composing ScheduleRepository,
 * OutboxCoordinator, RecoveryCoverageCoordinator, and AlarmMultiplexer without duplicating
 * Agent A's business state machine.
 */
export class AgentEventRuntimeFacade {
  readonly storage: DurableObjectStorageLike;
  readonly identity: DurableAgentIdentity;
  readonly business: AuthoritativeBusinessPort;
  readonly schedules: ScheduleRepository;
  readonly outbox: OutboxCoordinator;
  readonly coverage: RecoveryCoverageCoordinator;
  readonly alarm: AlarmMultiplexer;

  constructor(cmd: {
    readonly storage: DurableObjectStorageLike;
    readonly tenantId: string;
    readonly agentId: string;
    readonly business: AuthoritativeBusinessPort;
    readonly recoveryGraceMs?: number;
  }) {
    this.storage = cmd.storage;
    this.identity = { tenantId: cmd.tenantId, agentId: cmd.agentId };
    this.business = cmd.business;
    this.schedules = new ScheduleRepository(cmd.storage.sql);
    this.outbox = new OutboxCoordinator(cmd.storage.sql, {
      storage: cmd.storage,
      business: cmd.business,
    });
    this.coverage = new RecoveryCoverageCoordinator({
      storage: cmd.storage,
      tenantId: cmd.tenantId,
      agentId: cmd.agentId,
      business: cmd.business,
      graceMs: cmd.recoveryGraceMs,
    });
    this.alarm = new AlarmMultiplexer({
      storage: cmd.storage,
      business: cmd.business,
      coordinator: this.outbox,
      schedules: this.schedules,
      coverage: this.coverage,
    });
  }

  async verifyAndClaim(cmd: {
    readonly rawEnvelope: unknown;
    readonly expectedQueueName: V2QueueName;
    readonly recoveryPort: Pick<AgentHeadRecoveryPort, 'claimDurableWork'>;
    readonly workerId: string;
    readonly leaseMs: number;
    readonly nowMs: number;
  }): Promise<VerifyAndClaimDispatchResult> {
    return verifyAndClaimDispatchEnvelope({
      rawEnvelope: cmd.rawEnvelope,
      expectedQueueName: cmd.expectedQueueName,
      identity: this.identity,
      storage: this.storage,
      coordinator: this.outbox,
      business: this.business,
      recoveryPort: cmd.recoveryPort,
      workerId: cmd.workerId,
      leaseMs: cmd.leaseMs,
      nowMs: cmd.nowMs,
    });
  }

  async handleAlarm(cmd: {
    readonly nowMs: number;
    readonly queues: Readonly<Record<V2QueueName, QueueLike<V2DispatchEnvelope>>>;
    readonly globalBudget: GlobalBudgetSettlePort;
    readonly registry?: RecoveryRegistryPort;
    readonly batchLimit?: number;
  }): Promise<AlarmCycleResult> {
    return this.alarm.runAlarmCycle(cmd);
  }

  asRecoveryTarget(cmd: {
    readonly onRecoveryAlarm: (nowMs: number) => Promise<void>;
    readonly nowMsProvider: () => number;
  }): AgentRecoveryTargetPort {
    return {
      reconcileFromRegistry: (req) =>
        Promise.resolve(
          this.storage.transactionSync(() =>
            this.coverage.reconcileFromRegistrySync({
              expectedGen: req.expectedGen,
              nowMs: req.nowMs,
            }),
          ),
        ),
      confirmRegistryPlan: (req) =>
        Promise.resolve(
          this.storage.transactionSync(() =>
            this.coverage.confirmRegistryPlanSync({
              generation: req.generation,
              actualRecoveryAtMs: req.actualRecoveryAtMs,
              applied: req.applied,
              nowMs: cmd.nowMsProvider(),
            }),
          ),
        ),
      runRecoveryAlarmCycle: cmd.onRecoveryAlarm,
    };
  }

  /**
   * Produces Agent A's `TurnRecoverySeamHooks` / `RecoveryCoordinatorHooks` structure,
   * connecting Agent A's `AgentHeadCore` to Agent B's coverage, outbox, alarm, and verbatim `budget_sync` relay.
   */
  asTurnRecoveryHooks(cmd: {
    readonly globalBudget: GlobalBudgetSettlePort;
    readonly batchLimit?: number;
  }): {
    readonly getCoverageRowSync: () => V2RecoveryCoverageRow | null;
    readonly reconcileCoverageSync: (req: {
      readonly expectedGen: number;
      readonly nowMs: number;
    }) => Awaited<ReturnType<AgentHeadRecoveryPort['reconcileFromRegistry']>>;
    readonly confirmCoveragePlanSync: (req: {
      readonly generation: number;
      readonly actualRecoveryAtMs: number | null;
      readonly applied: boolean;
      readonly nowMs: number;
    }) => { readonly confirmed: boolean };
    readonly getOutboxByIdSync: (outboxId: string) => V2DispatchOutboxRow | null;
    readonly syncPlatformAlarm: (targetAlarmAtMs: number | null, nowMs: number) => Promise<boolean>;
    readonly relayBudgetSync: (nowMs: number) => Promise<void>;
  } {
    return {
      getCoverageRowSync: () => this.coverage.getCoverageRowSync(),
      reconcileCoverageSync: (req) => this.coverage.reconcileFromRegistrySync(req),
      confirmCoveragePlanSync: (req) => this.coverage.confirmRegistryPlanSync(req),
      getOutboxByIdSync: (outboxId) => this.outbox.getOutboxByIdSync(outboxId),
      syncPlatformAlarm: (targetAlarmAtMs, nowMs) =>
        this.alarm.syncPlatformAlarm(targetAlarmAtMs, nowMs),
      relayBudgetSync: async (nowMs) => {
        await relayDueBudgetSyncBatch({
          sql: this.storage.sql,
          storage: this.storage,
          coordinator: this.outbox,
          globalBudget: cmd.globalBudget,
          nowMs,
          limit: cmd.batchLimit,
        });
      },
    };
  }
}
