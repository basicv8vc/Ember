import { DomainError, type Id } from '@ember/domain';
import type { BudgetLedger, RunGrant } from '@ember/contracts';
import {
  evaluateSentinelPolicy,
  toSentinelDeniedError,
  type SentinelPolicy,
} from './sentinel-lite.js';
import { systemExecutionClock, type ExecutionClock } from './clock.js';
import {
  FakeSummaryEngine,
  type OutcomeResultStatus,
  type SourceSnapshot,
} from './commitment-summary-engine.js';

export interface WorkerLeaseGrant {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly leaseEpoch: number;
  readonly workerId: string;
}

export interface TrustedSourceAccessContext {
  readonly tenantId: Id;
  readonly commitmentId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly leaseEpoch: number;
  readonly authorizedAt: string;
}

export interface CommitmentOrchestrationContext {
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly commitmentId: Id;
  readonly occurrenceId: Id;
  readonly sourceProfileId: string;
  readonly scheduleKind: 'once' | 'interval';
  readonly policyVersion?: number;
}

export interface OrchestrationResult {
  readonly outcomeCommitted: boolean;
  readonly replayed: boolean;
  readonly resultStatus: OutcomeResultStatus;
  readonly summary: string;
}

export interface AppendOutcomeCommand {
  readonly occurrenceId: Id;
  readonly commitmentId: Id;
  readonly taskId: Id;
  readonly summary: string;
  readonly resultStatus: OutcomeResultStatus;
}

export interface CommitmentStorePort {
  findOutcome?(
    occurrenceId: Id,
  ): Promise<{ readonly resultStatus: OutcomeResultStatus; readonly summary: string } | null>;

  appendOutcomeIfAbsent(grant: WorkerLeaseGrant, cmd: AppendOutcomeCommand): Promise<boolean>;

  markCommitmentCompleted(commitmentId: Id): Promise<boolean>;
}

export interface SourceReaderPort {
  readSnapshot(
    profileId: string,
    trustedContext: TrustedSourceAccessContext,
    signal?: AbortSignal,
  ): Promise<SourceSnapshot>;
}

export interface CommitmentOrchestratorDependencies {
  readonly store: CommitmentStorePort;
  readonly sourceReader: SourceReaderPort;
  readonly summaryEngine?: FakeSummaryEngine;
  readonly budget?: BudgetLedger;
  readonly sentinelPolicy?:
    SentinelPolicy | ((context: CommitmentOrchestrationContext) => SentinelPolicy | undefined);
  readonly clock?: ExecutionClock;
  readonly logger?: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
}

/**
 * Guarded Commitment Occurrence Execution Orchestrator.
 *
 * Enforces the core invariants:
 * 1. Sentinel Admission: Evaluated before any budget reservation or source read.
 *    If denied, 0 budget reservation and 0 source callback occur.
 * 2. Budget Guard: Transactional reservation before computation/snapshot read.
 * 3. Lease Fencing: The outcome append is authenticated against the active Worker lease.
 * 4. Idempotency: Duplicate executions cannot create duplicate visible outcomes.
 * 5. Cancellation: Cancelled commitments reject future outcome publications.
 */
export class CommitmentOrchestrator {
  private readonly store: CommitmentStorePort;
  private readonly sourceReader: SourceReaderPort;
  private readonly summaryEngine: FakeSummaryEngine;
  private readonly budget?: BudgetLedger;
  private readonly sentinelPolicyResolver?:
    SentinelPolicy | ((context: CommitmentOrchestrationContext) => SentinelPolicy | undefined);
  private readonly clock: ExecutionClock;
  private readonly logger?: CommitmentOrchestratorDependencies['logger'];

  constructor(deps: CommitmentOrchestratorDependencies) {
    this.store = deps.store;
    this.sourceReader = deps.sourceReader;
    this.summaryEngine = deps.summaryEngine ?? new FakeSummaryEngine();
    this.budget = deps.budget;
    this.sentinelPolicyResolver = deps.sentinelPolicy;
    this.clock = deps.clock ?? systemExecutionClock;
    this.logger = deps.logger;
  }

  public async execute(
    grant: WorkerLeaseGrant,
    context: CommitmentOrchestrationContext,
    signal?: AbortSignal,
  ): Promise<OrchestrationResult> {
    if (signal?.aborted) {
      throw new DomainError('CANCELLED', 'Occurrence execution was aborted before start');
    }

    // 0. Pre-execution replay check: if outcome was already committed, do not re-run or re-charge
    if (typeof this.store.findOutcome === 'function') {
      const existing = await this.store.findOutcome(context.occurrenceId);
      if (existing) {
        return {
          outcomeCommitted: false,
          replayed: true,
          resultStatus: existing.resultStatus,
          summary: existing.summary,
        };
      }
    }

    // 1. Sentinel Admission Gate (Evaluated before any side effects)
    this.enforceSentinelAdmission(grant, context);

    // 2. Budget Reservation (If configured)
    const runGrant: RunGrant = {
      tenantId: grant.tenantId,
      taskId: grant.taskId,
      runId: grant.runId,
      agentId: context.agentId,
      attempt: 1,
      leaseEpoch: grant.leaseEpoch,
      workerId: grant.workerId,
    };

    const operationId = `commitment:occ:${context.occurrenceId}:${grant.leaseEpoch}`;
    const cost = { steps: 1, units: 1, elapsedMs: 20, concurrencySlots: 0 };

    if (this.budget) {
      if (signal?.aborted) {
        throw new DomainError('CANCELLED', 'Execution aborted before budget reservation');
      }
      await this.budget.reserve(runGrant, { operationId, cost });
    }

    try {
      if (signal?.aborted) {
        if (this.budget) {
          await this.budget.release(runGrant, { operationId }).catch(() => undefined);
        }
        throw new DomainError('CANCELLED', 'Execution aborted after budget reservation');
      }

      // 3. Source Snapshot Read
      const trustedContext: TrustedSourceAccessContext = {
        tenantId: grant.tenantId,
        commitmentId: context.commitmentId,
        taskId: grant.taskId,
        runId: grant.runId,
        leaseEpoch: grant.leaseEpoch,
        authorizedAt: this.clock.now().toISOString(),
      };

      const snapshot = await this.sourceReader.readSnapshot(
        context.sourceProfileId,
        trustedContext,
        signal,
      );

      // 4. Deterministic Summary Generation
      const summaryResult = this.summaryEngine.generate(snapshot);

      // 5. Durably Append Outcome with Lease Fencing
      const appended = await this.store.appendOutcomeIfAbsent(grant, {
        occurrenceId: context.occurrenceId,
        commitmentId: context.commitmentId,
        taskId: grant.taskId,
        summary: summaryResult.summary,
        resultStatus: summaryResult.resultStatus,
      });

      // 6. Complete One-Shot Commitment if Applicable
      if (context.scheduleKind === 'once' && appended) {
        await this.store.markCommitmentCompleted(context.commitmentId).catch((err) => {
          this.logger?.warn('Failed to mark one-shot commitment completed', {
            commitmentId: context.commitmentId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      // 7. Settle Budget
      if (this.budget) {
        if (!appended) {
          // Replayed operation: release reservation
          await this.budget.release(runGrant, { operationId }).catch(() => undefined);
        } else {
          await this.budget
            .settle(runGrant, { operationId, consumed: cost })
            .catch(() => undefined);
        }
      }

      return {
        outcomeCommitted: appended,
        replayed: !appended,
        resultStatus: summaryResult.resultStatus,
        summary: summaryResult.summary,
      };
    } catch (error) {
      // If error occurs after reservation, settle budget as expired/consumed unless cancelled pre-execution
      if (this.budget) {
        if (signal?.aborted) {
          await this.budget.release(runGrant, { operationId }).catch(() => undefined);
        } else {
          await this.budget
            .settle(runGrant, { operationId, consumed: cost })
            .catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private enforceSentinelAdmission(
    grant: WorkerLeaseGrant,
    context: CommitmentOrchestrationContext,
  ): void {
    if (!this.sentinelPolicyResolver) {
      return; // Permissive if no policy supplied (e.g. basic unit test)
    }

    const policy =
      typeof this.sentinelPolicyResolver === 'function'
        ? this.sentinelPolicyResolver(context)
        : this.sentinelPolicyResolver;

    const intent = {
      tenantId: grant.tenantId,
      runId: grant.runId,
      taskId: grant.taskId,
      actionCategory: 'mock.compute' as const,
      policyVersion: context.policyVersion ?? 1,
    };

    const decision = evaluateSentinelPolicy(policy, intent);
    if (decision.verdict !== 'allow') {
      throw toSentinelDeniedError(decision);
    }
  }
}
