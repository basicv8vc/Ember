import {
  realSleeper,
  systemExecutionClock,
  type ExecutionClock,
  type Sleeper,
} from '@ember/execution';
import {
  buildCommitmentTaskInput,
  deriveTaskCreationIdempotencyKey,
  hasRecoverableOccurrenceIdentity,
  type DueCommitmentStore,
  type ExistingTaskDispatcher,
} from './commitment-ports.js';
import type { WorkerLogger } from './logger.js';

export interface CommitmentSchedulerOptions {
  /** Master switch. Must default to false (disabled) in production until CTO sign-off. */
  readonly enabled?: boolean;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly stalledTimeoutSeconds?: number;
  readonly errorBackoffMs?: number;
  readonly clock?: ExecutionClock;
  readonly sleeper?: Sleeper;
  readonly logger?: WorkerLogger;
}

export interface SchedulerTickSummary {
  readonly dueDiscovered: number;
  readonly occurrencesReserved: number;
  readonly tasksDispatched: number;
  readonly skippedOrFailed: number;
}

export const DEFAULT_SCHEDULER_INTERVAL_MS = 5_000;
export const DEFAULT_SCHEDULER_BATCH_SIZE = 10;
export const DEFAULT_SCHEDULER_CONCURRENCY = 4;
export const DEFAULT_STALLED_TIMEOUT_SECONDS = 120;
export const DEFAULT_ERROR_BACKOFF_MS = 1_000;

/**
 * Cloud-side Durable Commitment Scheduler.
 *
 * Responsibilities:
 * 1. Periodically finds due active commitments using the database authoritative clock.
 * 2. Creates a unique Occurrence slot via atomic reservation, advancing commitment next_due_at.
 * 3. Dispatches one durable Task with a deterministic idempotency key tied to occurrenceId.
 * 4. Binds task_id to the occurrence.
 * 5. Periodically reconciles orphan/stalled pending occurrences after worker crashes.
 * 6. Supports concurrent scheduler instances without duplicate occurrences or visible outcomes.
 */
export class CommitmentScheduler {
  private readonly store: DueCommitmentStore;
  private readonly dispatcher: ExistingTaskDispatcher;
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly stalledTimeoutSeconds: number;
  private readonly errorBackoffMs: number;
  private readonly clock: ExecutionClock;
  private readonly sleeper: Sleeper;
  private readonly logger?: WorkerLogger;

  constructor(
    store: DueCommitmentStore,
    dispatcher: ExistingTaskDispatcher,
    options: CommitmentSchedulerOptions = {},
  ) {
    this.store = store;
    this.dispatcher = dispatcher;
    this.enabled = options.enabled ?? false;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_SCHEDULER_BATCH_SIZE;
    this.concurrency = options.concurrency ?? DEFAULT_SCHEDULER_CONCURRENCY;
    this.stalledTimeoutSeconds = options.stalledTimeoutSeconds ?? DEFAULT_STALLED_TIMEOUT_SECONDS;
    this.errorBackoffMs = options.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS;
    this.clock = options.clock ?? systemExecutionClock;
    this.sleeper = options.sleeper ?? realSleeper;
    this.logger = options.logger;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Run a single discrete scheduler tick.
   * Useful for deterministic testing and cron-based execution.
   */
  public async tick(asOfOverride?: Date): Promise<SchedulerTickSummary> {
    const dueCommitments = await this.store.findDueCommitments(this.batchSize, asOfOverride);
    let occurrencesReserved = 0;
    let tasksDispatched = 0;
    let skippedOrFailed = 0;

    for (const commitment of dueCommitments) {
      try {
        // Step 1: Atomic slot reservation in database
        const slot = await this.store.reserveOccurrence(
          commitment.commitmentId,
          commitment.version,
        );

        if (!slot) {
          // Concurrent scheduler already won this slot or commitment changed state
          skippedOrFailed++;
          continue;
        }

        occurrencesReserved++;

        // Step 2: Dispatch durable Task with stable idempotency key
        const idempotencyKey = deriveTaskCreationIdempotencyKey(slot.occurrenceId);
        const receipt = await this.dispatcher.dispatchTask({
          tenantId: commitment.tenantId,
          agentId: commitment.agentId,
          commitmentId: commitment.commitmentId,
          occurrenceId: slot.occurrenceId,
          idempotencyKey,
          kind: 'mock.compute',
          input: buildCommitmentTaskInput({
            commitmentId: commitment.commitmentId,
            occurrenceId: slot.occurrenceId,
            sourceProfileId: commitment.sourceProfileId,
            scheduleKind: commitment.scheduleKind,
          }),
        });

        // Step 3: Bind task_id to occurrence
        await this.store.markDispatched(slot.occurrenceId, receipt.taskId);
        tasksDispatched++;

        this.logger?.info?.('Scheduled commitment occurrence', {
          commitmentId: commitment.commitmentId,
          occurrenceId: slot.occurrenceId,
          taskId: receipt.taskId,
          replayed: receipt.replayed,
        });
      } catch (error) {
        skippedOrFailed++;
        this.logger?.warn?.('Failed to schedule commitment occurrence', {
          commitmentId: commitment.commitmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      dueDiscovered: dueCommitments.length,
      occurrencesReserved,
      tasksDispatched,
      skippedOrFailed,
    };
  }

  /**
   * Reconcile occurrences stalled in 'pending' status due to crashes between slot reservation
   * and task dispatch.
   */
  public async reconcileStalled(): Promise<number> {
    const stalled = await this.store.findStalledPendingOccurrences(
      this.stalledTimeoutSeconds,
      this.batchSize,
    );
    let reconciledCount = 0;

    for (const occurrence of stalled) {
      // Fail-closed: recovery must never fabricate identity. All four business identity fields
      // must be present and valid at runtime; otherwise the occurrence stays pending (visible to
      // operators) and reconciliation continues with the remaining records.
      if (!hasRecoverableOccurrenceIdentity(occurrence)) {
        this.logger?.warn?.(
          'Skipping stalled occurrence without recoverable authoritative identity',
          {
            occurrenceId: occurrence.occurrenceId,
            commitmentId: occurrence.commitmentId,
            hasTenantId: typeof occurrence.tenantId === 'string' && occurrence.tenantId.length > 0,
            hasAgentId: typeof occurrence.agentId === 'string' && occurrence.agentId.length > 0,
            hasSourceProfileId:
              typeof occurrence.sourceProfileId === 'string' &&
              occurrence.sourceProfileId.length > 0,
            scheduleKind: occurrence.scheduleKind,
          },
        );
        continue;
      }

      try {
        const receipt = await this.dispatcher.dispatchTask({
          tenantId: occurrence.tenantId,
          agentId: occurrence.agentId,
          commitmentId: occurrence.commitmentId,
          occurrenceId: occurrence.occurrenceId,
          idempotencyKey: occurrence.taskCreationIdempotencyKey,
          kind: 'mock.compute',
          input: buildCommitmentTaskInput({
            commitmentId: occurrence.commitmentId,
            occurrenceId: occurrence.occurrenceId,
            sourceProfileId: occurrence.sourceProfileId,
            scheduleKind: occurrence.scheduleKind,
          }),
        });

        const reconciled = await this.store.reconcilePendingOccurrence(
          occurrence.occurrenceId,
          receipt.taskId,
        );

        if (reconciled) {
          reconciledCount++;
          this.logger?.info?.('Reconciled stalled occurrence', {
            occurrenceId: occurrence.occurrenceId,
            taskId: receipt.taskId,
          });
        }
      } catch (error) {
        this.logger?.warn?.('Failed to reconcile stalled occurrence', {
          occurrenceId: occurrence.occurrenceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return reconciledCount;
  }

  /**
   * Continuous scheduling loop controlled by AbortSignal.
   */
  public async runLoop(signal: AbortSignal): Promise<void> {
    if (!this.enabled) {
      this.logger?.info?.('Commitment scheduler is disabled by configuration; exiting loop');
      return;
    }

    this.logger?.info?.('Starting commitment scheduler loop', {
      intervalMs: this.pollIntervalMs,
      batchSize: this.batchSize,
      concurrency: this.concurrency,
    });

    let tickCount = 0;

    while (!signal.aborted) {
      try {
        await this.tick();

        tickCount++;
        if (tickCount % 10 === 0) {
          await this.reconcileStalled();
        }

        await this.sleeper(this.pollIntervalMs, signal);
      } catch (error) {
        if (signal.aborted) {
          break;
        }

        this.logger?.warn?.('Scheduler loop encountered error; backing off', {
          error: error instanceof Error ? error.message : String(error),
          backoffMs: this.errorBackoffMs,
        });

        await this.sleeper(this.errorBackoffMs, signal);
      }
    }

    this.logger?.info?.('Commitment scheduler loop stopped');
  }
}
