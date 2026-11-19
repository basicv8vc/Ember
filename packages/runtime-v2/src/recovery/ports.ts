import type { V2DispatchEnvelope } from './envelope.js';
import type {
  OrdinaryOutboxEntityKind,
  OutboxEntityKind,
  RecoveryRegistryStatus,
  V2QueueName,
} from './schema.js';

export type TurnExecutionMode = 'fast_interactive' | 'durable_queue' | 'device';

/**
 * External D1 `v2_recovery_registry` CAS port provided by Agent B.
 * Implementations always return D1 authoritative stored values rather than echoing caller arguments.
 */
export interface RecoveryRegistryPort {
  upsertCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly generation: number;
    readonly recoveryAtMs: number;
    readonly nowMs: number;
  }): Promise<{
    readonly accepted: boolean;
    readonly currentGeneration: number;
    readonly actualRecoveryAtMs: number | null;
  }>;

  postponeCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly expectedPrevGen: number;
    readonly newGeneration: number;
    readonly nextRecoveryAtMs: number;
    readonly nowMs: number;
  }): Promise<{
    readonly updated: boolean;
    readonly currentGeneration: number;
    readonly actualRecoveryAtMs: number | null;
  }>;

  retireCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly retireUpToGen: number;
  }): Promise<{ readonly retired: boolean }>;

  /** Standardized single read endpoint returning null fields when the D1 row is absent. */
  getCoverage(cmd: { readonly tenantId: string; readonly agentId: string }): Promise<{
    readonly exists: boolean;
    readonly currentGeneration: number | null;
    readonly actualRecoveryAtMs: number | null;
    readonly status: RecoveryRegistryStatus | null;
    readonly retryNotBeforeMs: number | null;
  }>;
}

/**
 * Synchronous recovery admission & confirmation port invoked by Agent A inside DO `transactionSync()`.
 */
export interface RecoveryAdmissionPort {
  inspectCoverageSync(
    requiredRecoveryAtMs: number,
    nowMs: number,
  ):
    | {
        readonly kind: 'covered';
        readonly generation: number;
        readonly coveredRecoveryAtMs: number;
      }
    | {
        readonly kind: 'register';
        readonly generation: number;
        readonly targetAtMs: number;
      };

  /**
   * Confirms coverage only when the authoritative D1 response matches the active generation/pending
   * plan AND `actualRecoveryAtMs <= earliestRequiredRecoveryMs`. Otherwise returns `false` so caller
   * re-plans or fails closed (`503 DB_UNAVAILABLE`).
   */
  confirmCoverageSync(cmd: {
    readonly generation: number;
    readonly actualRecoveryAtMs: number | null;
    readonly applied: boolean;
    readonly earliestRequiredRecoveryMs: number;
    readonly nowMs: number;
  }): boolean;
}

/**
 * Synchronous Outbox & single DO Alarm coordination port invoked inside DO `transactionSync()`.
 */
export interface EventRuntimeCoordinatorPort {
  enqueueDurableOutboxSync(cmd: {
    readonly outboxId: string;
    readonly entityKind: OutboxEntityKind;
    readonly entityId: string;
    readonly queueName: V2QueueName | null;
    readonly payloadJson: string;
    readonly operationId?: string;
    readonly revision?: number;
    readonly fenceEpoch: number;
    readonly nextAttemptAtMs: number;
  }): void;

  /**
   * Cancels pending ordinary dispatch outbox items for an entity per ADR-0001.
   * Type-level and runtime guard: NEVER cancels `entity_kind = 'budget_sync'`.
   */
  cancelEntityOutboxSync(
    entityKind: OrdinaryOutboxEntityKind,
    entityId: string,
    nowMs: number,
  ): void;

  ackOutboxSync(outboxId: string, fenceEpoch: number, nowMs: number): void;

  applyOutboxDeadLetterSync(cmd: {
    readonly outboxId: string;
    readonly fenceEpoch: number;
    readonly errorCode: string;
    readonly nextAttemptAtMs: number;
    readonly nowMs: number;
  }): boolean;

  recomputeAlarmSync(nowMs: number): number | null;
}

/**
 * Synchronous authoritative business read/convergence port exposed by Agent A to Agent B
 * (called inside DO `transactionSync()` during `alarm()`, reconcile, or queue validation).
 */
export interface AuthoritativeBusinessPort {
  earliestRequiredDiscoveryAtMsSync(nowMs: number): number | null;

  listDueBusinessActionsSync(
    nowMs: number,
    limit: number,
  ): ReadonlyArray<{
    readonly targetKind: 'turn' | 'task';
    readonly targetId: string;
    readonly actionKind: 'preclaim_deadline' | 'lease_expired' | 'cancel_converge' | 'retry_due';
    readonly deadlineAtMs: number;
  }>;

  convergeDueBusinessItemSync(targetKind: 'turn' | 'task', targetId: string, nowMs: number): void;

  inspectOutboxTargetSync(
    entityKind: OrdinaryOutboxEntityKind,
    entityId: string,
  ): {
    readonly exists: boolean;
    readonly targetKind: 'turn' | 'task' | null;
    readonly targetId: string | null;
    readonly currentLeaseEpoch: number;
    readonly deadlineAtMs: number;
    readonly isTerminal: boolean;
    readonly cancelRequested: boolean;
  };

  materializeScheduleOccurrenceSync(scheduleId: string, occurrenceSeq: number, nowMs: number): void;
}

/**
 * AgentHeadDO RPC port exposed by Agent A to Agent B Sweeper and Durable Execution Worker.
 */
export interface AgentHeadRecoveryPort {
  reconcileFromRegistry(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly expectedGen: number;
    readonly nowMs: number;
  }): Promise<
    | {
        readonly action: 'repair_ensure';
        readonly generation: number;
        readonly recoveryAtMs: number;
      }
    | { readonly action: 'noop_stale'; readonly currentGeneration: number }
    | { readonly action: 'retire'; readonly retireUpToGen: number }
    | {
        readonly action: 'postpone';
        readonly expectedPrevGen: number;
        readonly newGeneration: number;
        readonly nextRecoveryAtMs: number;
      }
    | { readonly action: 'keep_armed'; readonly currentGeneration: number }
  >;

  confirmRegistryPlan(cmd: {
    readonly generation: number;
    readonly actualRecoveryAtMs: number | null;
    readonly applied: boolean;
  }): Promise<{ readonly confirmed: boolean }>;

  claimDurableWork(cmd: {
    readonly envelope: V2DispatchEnvelope;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<
    | {
        readonly kind: 'claimed';
        readonly targetKind: 'turn' | 'task';
        readonly targetId: string;
        readonly leaseEpoch: number;
        readonly leaseExpiresAtMs: number;
        readonly contextJson: string;
      }
    | {
        readonly kind: 'not_claimed';
        readonly reason:
          | 'terminal'
          | 'lease_active'
          | 'deadline_expired'
          | 'not_found'
          | 'stale_or_invalid_envelope';
      }
  >;

  commitDurableResult(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly entityType: 'turn' | 'task';
    readonly entityId: string;
    readonly leaseEpoch: number;
    readonly workerId: string;
    readonly outcome: unknown;
  }): Promise<{ readonly accepted: boolean }>;
}
