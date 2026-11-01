import type { Id } from '@ember/domain';
import type { OutcomeResultStatus, SourceSnapshot } from '@ember/execution';

export type ScheduleKind = 'once' | 'interval';
export type CommitmentStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type OccurrenceStatus = 'pending' | 'dispatched' | 'completed' | 'failed' | 'cancelled';

/**
 * Server-derived execution lease authority representing the active worker attempt.
 * Adheres to P0-C3-0 Section 4.
 */
export interface WorkerLeaseGrant {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly leaseEpoch: number;
  readonly workerId: string;
}

export interface DueCommitment {
  readonly commitmentId: Id;
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly title: string;
  readonly sourceProfileId: string;
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds: number | null;
  readonly nextDueAt: Date;
  readonly version: number;
  readonly status: CommitmentStatus;
}

export interface ReservedSlot {
  readonly occurrenceId: Id;
  readonly commitmentId: Id;
  readonly scheduledFor: Date;
  readonly commitmentVersion: number;
}

export interface AppendOutcomeCommand {
  readonly occurrenceId: Id;
  readonly commitmentId: Id;
  readonly taskId: Id;
  readonly summary: string;
  readonly resultStatus: OutcomeResultStatus;
}

export interface StalledPendingOccurrence {
  readonly occurrenceId: Id;
  readonly commitmentId: Id;
  readonly scheduledFor: Date;
  readonly createdAt: Date;
  readonly taskCreationIdempotencyKey: string;
}

/**
 * Stable derivation of Task creation idempotency key from occurrenceId.
 * Adheres to P0-C3-0 Section 4.
 */
export function deriveTaskCreationIdempotencyKey(occurrenceId: Id): string {
  return `commitment-occ:${occurrenceId}`;
}

/**
 * DueCommitmentStore port consumed by Lane B Scheduler and Worker runtime.
 */
export interface DueCommitmentStore {
  /**
   * Discovers active commitments whose next_due_at <= DB clock (or asOfOverride for virtual test clocks).
   */
  findDueCommitments(limit: number, asOfOverride?: Date): Promise<readonly DueCommitment[]>;

  /**
   * Atomically reserves an occurrence slot:
   * - Enforces status === 'active' and version === expectedVersion
   * - Inserts pending occurrence record
   * - Advances next_due_at (or null if 'once')
   * - Increments commitment version
   * Returns null if slot was already reserved or commitment changed state.
   */
  reserveOccurrence(
    commitmentId: Id,
    expectedVersion: number,
    slotTimeOverride?: Date,
  ): Promise<ReservedSlot | null>;

  /**
   * Binds the dispatched Task ID to the occurrence and advances status to 'dispatched'.
   */
  markDispatched(occurrenceId: Id, taskId: Id): Promise<void>;

  /**
   * Atomically appends the outcome with authoritative lease verification.
   * Throws STALE_LEASE if the worker lease is expired, fenced, or not owned.
   * Rejects write if commitment was cancelled.
   * Returns false if outcome was already committed (idempotent replay).
   */
  appendOutcomeIfAbsent(grant: WorkerLeaseGrant, cmd: AppendOutcomeCommand): Promise<boolean>;

  /**
   * Advances a one-shot commitment to 'completed' once the outcome is stored.
   */
  markCommitmentCompleted(commitmentId: Id, expectedVersion?: number): Promise<boolean>;

  /**
   * Finds occurrences stuck in 'pending' status longer than timeoutSeconds.
   */
  findStalledPendingOccurrences(
    timeoutSeconds: number,
    limit: number,
  ): Promise<readonly StalledPendingOccurrence[]>;

  /**
   * Binds Task ID to stalled occurrence and transitions status to 'dispatched'.
   */
  reconcilePendingOccurrence(occurrenceId: Id, taskId: Id): Promise<boolean>;

  /**
   * Marks a pending occurrence as permanently failed or cancelled.
   */
  markOccurrenceFailed(occurrenceId: Id, reasonCode: string): Promise<void>;
}

export interface DispatchTaskCommand {
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly commitmentId: Id;
  readonly occurrenceId: Id;
  readonly idempotencyKey: string;
  readonly kind: 'mock.compute' | 'mock.chat';
  readonly input: Readonly<Record<string, unknown>>;
  readonly deadlineAt?: string;
}

export interface DispatchTaskReceipt {
  readonly taskId: Id;
  readonly replayed: boolean;
}

/**
 * Dispatcher for creating durable tasks in Ember's Task Queue.
 */
export interface ExistingTaskDispatcher {
  dispatchTask(cmd: DispatchTaskCommand): Promise<DispatchTaskReceipt>;
}

export interface TrustedSourceAccessContext {
  readonly tenantId: Id;
  readonly commitmentId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly leaseEpoch: number;
  readonly authorizedAt: string;
}

/**
 * Read-only SourceReader port consumed by Lane B from Lane C.
 */
export interface SourceReader {
  readSnapshot(
    profileId: string,
    trustedContext: TrustedSourceAccessContext,
    signal?: AbortSignal,
  ): Promise<SourceSnapshot>;
}
