import type { DurableObjectStorageLike, QueueLike } from '../storage.js';
import type { GlobalBudgetSettlePort } from './budget-sync.js';
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
import type { V2QueueName } from './schema.js';
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
}
