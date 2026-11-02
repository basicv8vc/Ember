import type {
  AppendOutcomeCommand,
  BudgetLedger,
  CommitmentExecutionStore,
  OutcomeResultStatus,
  RunGrant,
  SourceSnapshot,
  TrustedSourceAccessContext,
  WorkerLeaseGrant,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import {
  evaluateSentinelPolicy,
  toSentinelDeniedError,
  type SentinelPolicy,
} from './sentinel-lite.js';
import { systemExecutionClock, type ExecutionClock } from './clock.js';
import { FakeSummaryEngine } from './commitment-summary-engine.js';

/**
 * Re-exported canonical contracts.
 *
 * `@ember/execution` used to declare private copies of these types; they are now the single
 * definitions from `@ember/contracts`, so the Worker port and the PostgreSQL repository cannot
 * drift apart.
 */
export type {
  AppendOutcomeCommand,
  OutcomeResultStatus,
  SourceSnapshot,
  TrustedSourceAccessContext,
  WorkerLeaseGrant,
};

export interface CommitmentOrchestrationContext {
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly commitmentId: Id;
  readonly occurrenceId: Id;
  /**
   * Trusted Source Profile of the Occurrence. It is resolved by the Worker from the persisted
   * commitment row; there is no default and no Task-payload fallback.
   */
  readonly sourceProfileId: string;
  readonly scheduleKind: 'once' | 'interval';
  /**
   * Sentinel policy version.
   *
   * Optional in the type only so that legacy/unversioned callers are rejected **fail-closed** at
   * runtime (`DENY_INVALID_INTENT` -> `POLICY_DENIED`) instead of silently defaulting to `1`.
   */
  readonly policyVersion?: number;
}

export interface OrchestrationResult {
  readonly outcomeCommitted: boolean;
  readonly replayed: boolean;
  readonly resultStatus: OutcomeResultStatus;
  readonly summary: string;
}

export type CommitmentStorePort = CommitmentExecutionStore;

export interface SourceReaderPort {
  /**
   * Reads a bounded source snapshot under a trusted, server-derived access context.
   *
   * Aligned with Lane C `@ember/connectors`: `signal` is **mandatory** so cooperative
   * cancellation always reaches the reader. The orchestrator refuses to call this without a
   * live `AbortSignal`.
   */
  readSnapshot(
    profileId: string,
    trustedContext: TrustedSourceAccessContext,
    signal: AbortSignal,
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
 * 1. Sentinel Admission: evaluated before any budget reservation or source read.
 *    If denied, 0 budget reservation and 0 source callback occur.
 * 2. Budget Guard: transactional reservation before computation/snapshot read.
 * 3. Lease Fencing + consent: the outcome append is authenticated against the active Worker
 *    lease, and the PostgreSQL repository requires a transaction-scoped consent guard. Until
 *    Lane C supplies durable consent persistence, that repository guard defaults to deny-all.
 * 4. Idempotency: duplicate executions cannot create duplicate visible outcomes.
 * 5. Cancellation: an aborted signal stops execution at every boundary, and cancelled
 *    commitments reject outcome publication in the database.
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
    signal: AbortSignal,
  ): Promise<OrchestrationResult> {
    // Fail-closed on a missing/invalid AbortSignal: never reach a source read, budget
    // reservation or outcome write without cooperative cancellation wired end-to-end.
    if (!isAbortSignal(signal)) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Occurrence execution requires a live AbortSignal before any side effect',
      );
    }

    this.throwIfAborted(signal, 'before admission');

    // 1. Sentinel Admission Gate: evaluated first, before any source read, budget reservation
    //    or replay lookup.
    this.enforceSentinelAdmission(grant, context);

    // 2. Authoritative replay check: validates tenant, task lineage, lease and consent, and
    //    returns any already-published outcome without re-executing.
    this.throwIfAborted(signal, 'before the replay check');
    const existing = await this.store.findAuthoritativeOutcome(grant, {
      commitmentId: context.commitmentId,
      occurrenceId: context.occurrenceId,
    });

    if (existing) {
      return {
        outcomeCommitted: false,
        replayed: true,
        resultStatus: existing.resultStatus,
        summary: existing.summary,
      };
    }

    // 3. Budget reservation (if configured)
    const runGrant: RunGrant = {
      tenantId: grant.tenantId,
      taskId: grant.taskId,
      runId: grant.runId,
      agentId: context.agentId,
      attempt: grant.attempt,
      leaseEpoch: grant.leaseEpoch,
      workerId: grant.workerId,
    };

    const operationId = `commitment:occ:${context.occurrenceId}:${grant.leaseEpoch}`;
    const cost = { steps: 1, units: 1, elapsedMs: 20, concurrencySlots: 0 };

    this.throwIfAborted(signal, 'before the budget reservation');

    if (this.budget) {
      await this.budget.reserve(runGrant, { operationId, cost });
    }

    try {
      this.throwIfAborted(signal, 'after the budget reservation');

      // 4. Source snapshot read
      this.throwIfAborted(signal, 'before the source read');
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

      // A cancellation that arrived while the reader was in flight discards the snapshot: a
      // successful read is never by itself a reason to publish anything.
      this.throwIfAborted(signal, 'after the source read');

      // 5. Deterministic summary generation
      this.throwIfAborted(signal, 'before the summary generation');
      const summaryResult = this.summaryEngine.generate(snapshot);

      // 6. Durably append the Outcome with lease + consent fencing
      this.throwIfAborted(signal, 'before the outcome publication');
      const appended = await this.store.appendOutcomeIfAbsent(grant, {
        occurrenceId: context.occurrenceId,
        commitmentId: context.commitmentId,
        taskId: grant.taskId,
        summary: summaryResult.summary,
        resultStatus: summaryResult.resultStatus,
      });

      // 7. Settle budget
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
      if (this.budget) {
        if (signal.aborted) {
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

  /**
   * Cooperative-cancellation checkpoint.
   *
   * The message is a fixed stage label, never data, so a cancelled execution cannot leak source
   * content into an error path.
   */
  private throwIfAborted(signal: AbortSignal, stage: string): void {
    if (signal.aborted) {
      throw new DomainError('CANCELLED', `Occurrence execution was cancelled ${stage}`);
    }
  }

  private enforceSentinelAdmission(
    grant: WorkerLeaseGrant,
    context: CommitmentOrchestrationContext,
  ): void {
    // A missing or malformed policy version is itself a denial: defaulting to 1 could
    // accidentally match a version-1 policy and let an unversioned request through.
    const policyVersion = resolvePolicyVersion(context.policyVersion);
    if (policyVersion === null) {
      throw toSentinelDeniedError({
        verdict: 'deny',
        reasonCode: 'DENY_INVALID_INTENT',
        actionCategory: 'mock.compute',
        policyVersion: 0,
      });
    }

    if (!this.sentinelPolicyResolver) {
      throw toSentinelDeniedError({
        verdict: 'deny',
        reasonCode: 'DENY_INVALID_POLICY',
        actionCategory: 'mock.compute',
        policyVersion,
      });
    }

    const policy =
      typeof this.sentinelPolicyResolver === 'function'
        ? this.sentinelPolicyResolver(context)
        : this.sentinelPolicyResolver;

    if (!policy) {
      throw toSentinelDeniedError({
        verdict: 'deny',
        reasonCode: 'DENY_INVALID_POLICY',
        actionCategory: 'mock.compute',
        policyVersion,
      });
    }

    const intent = {
      tenantId: grant.tenantId,
      runId: grant.runId,
      taskId: grant.taskId,
      actionCategory: 'mock.compute' as const,
      policyVersion,
    };

    const decision = evaluateSentinelPolicy(policy, intent);
    if (decision.verdict !== 'allow') {
      throw toSentinelDeniedError(decision);
    }
  }
}

/**
 * Normalizes an untrusted policy version. Missing, non-integer, or out-of-range values are
 * rejected (`null`) so they cannot silently match a default policy version.
 */
function resolvePolicyVersion(value: unknown): number | null {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= Number.MAX_SAFE_INTEGER
  ) {
    return value;
  }
  return null;
}

/**
 * Runtime shape check for the mandatory cooperative-cancellation signal.
 */
function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { aborted?: unknown; addEventListener?: unknown };
  return typeof candidate.aborted === 'boolean' && typeof candidate.addEventListener === 'function';
}
