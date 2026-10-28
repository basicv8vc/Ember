import { randomUUID } from 'node:crypto';
import type { LeaseQueue } from '@ember/contracts';
import {
  DomainError,
  InvalidArgumentError,
  transitionRun,
  transitionTask,
  type LeasedRun,
  type RunStatus,
  type RunTerminalStatus,
  type TaskEventPayload,
  type TaskEventPhase,
  type TaskKind,
  type TaskStatus,
} from '@ember/domain';
import type pg from 'pg';
import { appendTaskEvent } from '../repositories/event-store.js';
import { asDomainError, withTransaction } from '../repositories/support.js';
import { systemClock, parseNow, type Clock } from './clock.js';
import {
  resolveLeaseQueueConfig,
  type LeaseQueueConfig,
  type LeaseQueueConfigOverrides,
} from './config.js';
import { planRetry } from './retry-policy.js';
import {
  nextLeaseEpoch,
  parseClaimableKinds,
  parseLeaseEpoch,
  parseLeasedRun,
  parsePersistedTimestamp,
  parseRunTerminalStatus,
  parseWorkerId,
} from './validation.js';

interface TaskRow {
  id: string;
  tenant_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  lease_epoch: string;
  current_run_id: string | null;
  next_run_at: Date | string;
  lease_expires_at: Date | string | null;
  deadline_at: Date | string | null;
  cancel_requested_at: Date | string | null;
}

interface RunRow {
  id: string;
  tenant_id: string;
  task_id: string;
  attempt: number;
  lease_epoch: string;
  status: string;
  worker_id: string | null;
  leased_until: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

interface IdRow {
  id: string;
}

const TASK_COLUMNS = `
  id, tenant_id, status, attempt_count, max_attempts, lease_epoch::text AS lease_epoch,
  current_run_id, next_run_at, lease_expires_at, deadline_at, cancel_requested_at
`;

const RUN_COLUMNS = `
  id, tenant_id, task_id, attempt, lease_epoch::text AS lease_epoch, status, worker_id,
  leased_until, started_at, finished_at
`;

const CLAIM_CANDIDATE_SQL = `
SELECT ${TASK_COLUMNS}
  FROM tasks
 WHERE status IN ('queued', 'retryable_failed')
   AND kind = ANY($2::text[])
   AND next_run_at <= $1
 ORDER BY next_run_at ASC, created_at ASC, id ASC
 LIMIT 1
 FOR UPDATE SKIP LOCKED
`;

const LOCK_TASK_SQL = `
SELECT ${TASK_COLUMNS}
  FROM tasks
 WHERE tenant_id = $1 AND id = $2
 FOR UPDATE
`;

const LOCK_RUN_SQL = `
SELECT ${RUN_COLUMNS}
  FROM runs
 WHERE tenant_id = $1 AND task_id = $2 AND id = $3
 FOR UPDATE
`;

const ACTIVE_RUN_SQL = `
SELECT id
  FROM runs
 WHERE tenant_id = $1 AND task_id = $2 AND status IN ('created', 'running')
 LIMIT 1
`;

const INSERT_RUN_SQL = `
INSERT INTO runs (
  id, tenant_id, task_id, attempt, lease_epoch, status, worker_id, leased_until,
  started_at, created_at, updated_at
)
VALUES ($1, $2, $3, $4, $5, 'created', $6, $7, $8, $8, $8)
`;

const UPDATE_RUN_STATUS_SQL = `
UPDATE runs
   SET status = $1, updated_at = $2
 WHERE tenant_id = $3 AND task_id = $4 AND id = $5
`;

const CLAIM_TASK_UPDATE_SQL = `
UPDATE tasks
   SET status = $1,
       attempt_count = $2,
       lease_epoch = $3,
       lease_expires_at = $4,
       current_run_id = $5,
       updated_at = $6
 WHERE tenant_id = $7 AND id = $8
`;

const PROMOTE_RETRY_SQL = `
UPDATE tasks
   SET status = $1, updated_at = $2
 WHERE tenant_id = $3 AND id = $4 AND status = $5
`;

const HEARTBEAT_RUN_SQL = `
UPDATE runs
   SET leased_until = $1, updated_at = $2
 WHERE tenant_id = $3 AND task_id = $4 AND id = $5 AND status = 'running'
`;

const HEARTBEAT_TASK_SQL = `
UPDATE tasks
   SET lease_expires_at = $1, updated_at = $2
 WHERE tenant_id = $3 AND id = $4
`;

const FINISH_RUN_SQL = `
UPDATE runs
   SET status = $1,
       finished_at = $2,
       leased_until = NULL,
       updated_at = $2
 WHERE tenant_id = $3 AND task_id = $4 AND id = $5
`;

const FINISH_TASK_SQL = `
UPDATE tasks
   SET status = $1,
       lease_expires_at = NULL,
       next_run_at = $2,
       updated_at = $3
 WHERE tenant_id = $4 AND id = $5
`;

const CONVERGE_OPEN_TASK_SQL = `
UPDATE tasks
   SET status = $1, lease_expires_at = NULL, updated_at = $2
 WHERE tenant_id = $3 AND id = $4
`;

const OPEN_DEADLINE_TASKS_SQL = `
SELECT ${TASK_COLUMNS}
  FROM tasks
 WHERE status IN ('queued', 'retryable_failed')
   AND deadline_at IS NOT NULL
   AND deadline_at <= $1
 ORDER BY deadline_at ASC, id ASC
 LIMIT $2
 FOR UPDATE SKIP LOCKED
`;

const EXPIRED_RUNNING_TASKS_SQL = `
SELECT ${TASK_COLUMNS}
  FROM tasks
 WHERE status = 'running'
   AND lease_expires_at IS NOT NULL
   AND (
     lease_expires_at <= $1
     OR (deadline_at IS NOT NULL AND deadline_at <= $1)
   )
 ORDER BY lease_expires_at ASC, id ASC
 LIMIT $2
 FOR UPDATE SKIP LOCKED
`;

/** Bound a single claim transaction's attempt to skip expired candidates. */
const MAX_CLAIM_SKIPS = 16;

export interface PostgresLeaseQueueOptions extends LeaseQueueConfigOverrides {
  /** Single clock seam. Defaults to the real UTC system clock. */
  readonly clock?: Clock;
  /**
   * Task kinds this queue instance may claim (P0B-05 claim eligibility).
   *
   * Defaults to every known kind, which is the exact P0B-04 behaviour. The predicate is part
   * of the claim transaction's `SELECT … FOR UPDATE SKIP LOCKED`, so an ineligible Task can
   * never receive a Run, an attempt increment, an epoch increment or a failure event, and it
   * cannot block an eligible Task that is due later in the queue.
   */
  readonly claimableKinds?: readonly TaskKind[];
}

interface FinishConvergence {
  readonly taskStatus: TaskStatus;
  readonly runStatus: RunTerminalStatus;
  readonly phase: TaskEventPhase;
  readonly errorCode?: TaskEventPayload['errorCode'];
  readonly nextRunAt?: Date;
  readonly cancelRequested?: boolean;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toRunStatus(value: string): RunStatus {
  // The database CHECK constraint and @ember/domain share the same vocabulary.
  return value as RunStatus;
}

function toTaskStatus(value: string): TaskStatus {
  return value as TaskStatus;
}

/**
 * PostgreSQL-backed durable LeaseQueue.
 *
 * Every state change is committed in one transaction after locking the Tenant-scoped Task
 * row. Fencing compares the tenant, Task, current Run, Run status and `lease_epoch`; a
 * stale or foreign lease can never renew or finish. No LLM, sandbox, filesystem or network
 * work runs inside these transactions.
 */
export class PostgresLeaseQueue implements LeaseQueue {
  private readonly pool: pg.Pool;
  private readonly clock: Clock;
  private readonly config: LeaseQueueConfig;
  private readonly claimableKinds: readonly TaskKind[];

  constructor(pool: pg.Pool, options: PostgresLeaseQueueOptions = {}) {
    const { clock = systemClock, claimableKinds, ...overrides } = options;
    this.pool = pool;
    this.clock = clock;
    this.config = resolveLeaseQueueConfig(overrides);
    this.claimableKinds = parseClaimableKinds(claimableKinds);
  }

  /** Effective, validated configuration (useful for a worker loop's heartbeat cadence). */
  get configuration(): LeaseQueueConfig {
    return this.config;
  }

  /** Task kinds this queue instance is allowed to claim. */
  get claimableTaskKinds(): readonly TaskKind[] {
    return this.claimableKinds;
  }

  async claimNext(workerId: string, now: Date): Promise<LeasedRun | null> {
    const validatedWorkerId = parseWorkerId(workerId);
    const claimedAt = parseNow(now);

    try {
      return await withTransaction(this.pool, async (client) => {
        for (let skip = 0; skip < MAX_CLAIM_SKIPS; skip += 1) {
          const candidate = await client.query<TaskRow>(CLAIM_CANDIDATE_SQL, [
            claimedAt,
            this.claimableKinds.slice(),
          ]);
          const task = candidate.rows[0];

          if (task === undefined) {
            return null;
          }

          const status = toTaskStatus(task.status);
          const deadlineAt = parsePersistedTimestamp(task.deadline_at);
          const cancelRequested = task.cancel_requested_at !== null;
          const deadlineReached =
            deadlineAt !== null && deadlineAt.getTime() <= claimedAt.getTime();
          const attemptsExhausted = task.attempt_count >= task.max_attempts;

          if (cancelRequested || deadlineReached || attemptsExhausted) {
            await this.convergeBeforeClaim(client, task, status, claimedAt, {
              cancelRequested,
              deadlineReached,
            });
            continue;
          }

          if (toDate(task.next_run_at).getTime() > claimedAt.getTime()) {
            // Defensive: the locked row changed in a way the SQL predicate should prevent.
            return null;
          }

          const activeRun = await client.query<IdRow>(ACTIVE_RUN_SQL, [task.tenant_id, task.id]);

          if ((activeRun.rowCount ?? 0) > 0) {
            // Invariant violation: never create a second active Run.
            throw new DomainError(
              'DB_UNAVAILABLE',
              'task has an active run while it is not in running status',
            );
          }

          return await this.createLease(client, task, status, validatedWorkerId, claimedAt);
        }

        return null;
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async heartbeat(run: LeasedRun, now: Date): Promise<boolean> {
    const leased = parseLeasedRun(run);
    const requestedAt = parseNow(now);

    try {
      return await withTransaction(this.pool, async (client) => {
        const taskResult = await client.query<TaskRow>(LOCK_TASK_SQL, [
          leased.tenantId,
          leased.taskId,
        ]);
        const task = taskResult.rows[0];

        if (task === undefined) {
          return false;
        }

        if (
          task.status !== 'running' ||
          task.current_run_id !== leased.runId ||
          task.cancel_requested_at !== null
        ) {
          return false;
        }

        const taskEpoch = parseLeaseEpoch(task.lease_epoch);

        return await this.renewLease(client, task, leased, taskEpoch, requestedAt);
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async finish(run: LeasedRun, outcome: RunTerminalStatus): Promise<boolean> {
    const leased = parseLeasedRun(run);
    const validatedOutcome = parseRunTerminalStatus(outcome);

    // The Reaper is the only writer allowed to produce lease_expired. Letting a business
    // worker claim a timeout would bypass the actual lease clock and hide a crashed worker.
    if (validatedOutcome === 'lease_expired') {
      throw new InvalidArgumentError([{ path: 'outcome', code: 'lease_expired_is_reaper_only' }]);
    }

    try {
      return await withTransaction(this.pool, async (client) => {
        const taskResult = await client.query<TaskRow>(LOCK_TASK_SQL, [
          leased.tenantId,
          leased.taskId,
        ]);
        const task = taskResult.rows[0];

        if (task === undefined || task.status !== 'running') {
          return false;
        }

        if (task.current_run_id !== leased.runId) {
          return false;
        }

        const taskEpoch = parseLeaseEpoch(task.lease_epoch);

        if (taskEpoch !== leased.leaseEpoch) {
          return false;
        }

        const runResult = await client.query<RunRow>(LOCK_RUN_SQL, [
          leased.tenantId,
          leased.taskId,
          leased.runId,
        ]);
        const runRow = runResult.rows[0];

        if (runRow === undefined || runRow.status !== 'running') {
          return false;
        }

        const runEpoch = parseLeaseEpoch(runRow.lease_epoch);

        if (
          runEpoch !== leased.leaseEpoch ||
          runRow.attempt !== leased.attempt ||
          toRunStatus(runRow.status) !== 'running'
        ) {
          return false;
        }

        // Sample the clock only after both row locks are held. A Finish that waited behind
        // another transaction must never accept a Lease that expired during that wait.
        const finishedAt = this.sampleAfterLock();

        const taskLeaseExpiry = parsePersistedTimestamp(task.lease_expires_at);
        if (taskLeaseExpiry === null || taskLeaseExpiry.getTime() <= finishedAt.getTime()) {
          return false;
        }

        if (runRow.leased_until === null) {
          // Without a persisted Run lease expiry there is no authoritative evidence that
          // this Run still owns the lease. Fail closed with no write and no event.
          return false;
        }
        if (toDate(runRow.leased_until).getTime() <= finishedAt.getTime()) {
          return false;
        }

        const deadlineAt = parsePersistedTimestamp(task.deadline_at);
        const cancelRequested = task.cancel_requested_at !== null;

        const convergence = this.finishConvergence({
          outcome: validatedOutcome,
          task,
          runRow,
          finishedAt,
          deadlineAt,
          cancelRequested,
        });

        await this.applyFinish(client, task, runRow, convergence, finishedAt);

        return true;
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async reapExpired(now: Date): Promise<number> {
    const reapedAt = parseNow(now);

    try {
      return await withTransaction(this.pool, async (client) => {
        let reaped = 0;

        const openDeadline = await client.query<TaskRow>(OPEN_DEADLINE_TASKS_SQL, [
          reapedAt,
          this.config.reaperBatchSize,
        ]);

        for (const task of openDeadline.rows) {
          await this.convergeBeforeClaim(client, task, toTaskStatus(task.status), reapedAt, {
            cancelRequested: task.cancel_requested_at !== null,
            deadlineReached: true,
          });
          reaped += 1;
        }

        const remaining = this.config.reaperBatchSize - reaped;
        if (remaining <= 0) {
          return reaped;
        }

        const expiredRunning = await client.query<TaskRow>(EXPIRED_RUNNING_TASKS_SQL, [
          reapedAt,
          remaining,
        ]);

        for (const task of expiredRunning.rows) {
          await this.reapRunningTask(client, task, reapedAt);
          reaped += 1;
        }

        return reaped;
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Re-read the injected clock after the final row lock of a transaction has been acquired.
   *
   * A caller timestamp is only an observation from before the transaction started; it may
   * predate an arbitrary lock wait. Every liveness decision must therefore use the later of
   * the caller's sample and a fresh post-lock sample, otherwise a Lease that expired while
   * waiting behind another transaction could still be renewed or finished.
   */
  private sampleAfterLock(observedAt?: Date): Date {
    const lockedAt = parseNow(this.clock.now(), 'clock.now()');

    return observedAt === undefined || lockedAt.getTime() > observedAt.getTime()
      ? lockedAt
      : new Date(observedAt.getTime());
  }

  private async renewLease(
    client: pg.PoolClient,
    task: TaskRow,
    leased: LeasedRun,
    taskEpoch: number,
    requestedAt: Date,
  ): Promise<boolean> {
    if (taskEpoch !== leased.leaseEpoch) {
      return false;
    }

    const runResult = await client.query<RunRow>(LOCK_RUN_SQL, [
      leased.tenantId,
      leased.taskId,
      leased.runId,
    ]);
    const runRow = runResult.rows[0];

    if (runRow === undefined || runRow.status !== 'running') {
      return false;
    }

    const runEpoch = parseLeaseEpoch(runRow.lease_epoch);

    if (runEpoch !== leased.leaseEpoch || runRow.attempt !== leased.attempt) {
      return false;
    }

    // Both the Task and the Run row locks are now held. Only here is "now" authoritative:
    // a Heartbeat that waited for either lock may no longer rely on the caller timestamp.
    const heartbeatAt = this.sampleAfterLock(requestedAt);
    const taskLeaseExpiry = parsePersistedTimestamp(task.lease_expires_at);

    if (taskLeaseExpiry === null || taskLeaseExpiry.getTime() <= heartbeatAt.getTime()) {
      return false;
    }

    const deadlineAt = parsePersistedTimestamp(task.deadline_at);

    if (deadlineAt !== null && deadlineAt.getTime() <= heartbeatAt.getTime()) {
      // The worker must stop; the Reaper will converge the Task without retry.
      return false;
    }

    if (runRow.leased_until === null) {
      return false;
    }
    if (toDate(runRow.leased_until).getTime() <= heartbeatAt.getTime()) {
      return false;
    }

    const oldExpiry = toDate(taskLeaseExpiry);
    const proposedExpiry = new Date(heartbeatAt.getTime() + this.config.leaseDurationMs);
    // A clock must never shorten a lease. Forward-only extension also makes the
    // `lease_expires_at >= created_at` database check trivially safe.
    const newExpiry =
      proposedExpiry.getTime() > oldExpiry.getTime()
        ? proposedExpiry
        : new Date(oldExpiry.getTime() + 1);

    const runUpdate = await client.query(HEARTBEAT_RUN_SQL, [
      newExpiry,
      heartbeatAt,
      leased.tenantId,
      leased.taskId,
      leased.runId,
    ]);

    if (runUpdate.rowCount !== 1) {
      throw new DomainError('DB_UNAVAILABLE', 'heartbeat could not update the current run');
    }

    const taskUpdate = await client.query(HEARTBEAT_TASK_SQL, [
      newExpiry,
      heartbeatAt,
      leased.tenantId,
      leased.taskId,
    ]);

    if (taskUpdate.rowCount !== 1) {
      throw new DomainError('DB_UNAVAILABLE', 'heartbeat could not update the leased task');
    }

    return true;
  }

  private async createLease(
    client: pg.PoolClient,
    task: TaskRow,
    currentStatus: TaskStatus,
    workerId: string,
    claimedAt: Date,
  ): Promise<LeasedRun> {
    const runId = randomUUID();
    const attempt = task.attempt_count + 1;
    const epoch = nextLeaseEpoch(parseLeaseEpoch(task.lease_epoch));

    if (attempt > task.max_attempts) {
      throw new DomainError('DB_UNAVAILABLE', 'retry budget exhausted during claim');
    }

    // The approved retry path must pass through retryable_failed → queued → running,
    // never retryable_failed → running directly. Persist the intermediate state and append
    // its event in this same transaction so the durable event trail matches the database
    // transitions even though the intermediate `queued` state is not visible after COMMIT.
    let queuedStatus = currentStatus;
    if (currentStatus === 'retryable_failed') {
      queuedStatus = transitionTask(currentStatus, 'queued');
      const promoted = await client.query(PROMOTE_RETRY_SQL, [
        queuedStatus,
        claimedAt,
        task.tenant_id,
        task.id,
        currentStatus,
      ]);

      if (promoted.rowCount !== 1) {
        throw new DomainError('DB_UNAVAILABLE', 'could not persist retry promotion to queued');
      }

      await appendTaskEvent(client, {
        tenantId: task.tenant_id,
        taskId: task.id,
        phase: 'retry_scheduled',
        occurredAt: claimedAt,
        payload: {
          fromStatus: currentStatus,
          toStatus: queuedStatus,
        },
      });
    }

    const runningStatus = transitionTask(queuedStatus, 'running');
    transitionRun('created', 'running');

    const leaseExpiresAt = new Date(claimedAt.getTime() + this.config.leaseDurationMs);

    await client.query(INSERT_RUN_SQL, [
      runId,
      task.tenant_id,
      task.id,
      attempt,
      epoch,
      workerId,
      leaseExpiresAt,
      claimedAt,
    ]);

    const activated = await client.query(UPDATE_RUN_STATUS_SQL, [
      'running',
      claimedAt,
      task.tenant_id,
      task.id,
      runId,
    ]);

    if (activated.rowCount !== 1) {
      throw new DomainError('DB_UNAVAILABLE', 'claimed run could not be activated');
    }

    const taskUpdate = await client.query(CLAIM_TASK_UPDATE_SQL, [
      runningStatus,
      attempt,
      epoch,
      leaseExpiresAt,
      runId,
      claimedAt,
      task.tenant_id,
      task.id,
    ]);

    if (taskUpdate.rowCount !== 1) {
      throw new DomainError('DB_UNAVAILABLE', 'claimed task could not be updated');
    }

    await appendTaskEvent(client, {
      tenantId: task.tenant_id,
      taskId: task.id,
      phase: 'leased',
      occurredAt: claimedAt,
      payload: {
        runId,
        attempt,
        fromStatus: 'queued',
        toStatus: 'running',
      },
    });

    await appendTaskEvent(client, {
      tenantId: task.tenant_id,
      taskId: task.id,
      phase: 'started',
      occurredAt: claimedAt,
      payload: {
        runId,
        attempt,
        runStatus: 'running',
      },
    });

    return Object.freeze({
      tenantId: task.tenant_id,
      taskId: task.id,
      runId,
      attempt,
      leaseEpoch: epoch,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    });
  }

  private async convergeBeforeClaim(
    client: pg.PoolClient,
    task: TaskRow,
    status: TaskStatus,
    at: Date,
    reason: { readonly cancelRequested: boolean; readonly deadlineReached: boolean },
  ): Promise<void> {
    // ADR-0002 mandatory precondition: a pre-claim convergence is only legal when the
    // Task has no `created` or `running` Run. If such a Run exists the database is in an
    // anomalous state (a queued/retryable Task with an active execution); marking the Task
    // terminal here would strand an unrecoverable active Run. Fail closed: throw before any
    // write so the surrounding transaction rolls back Task, Run and Event untouched.
    const activeRun = await client.query<IdRow>(ACTIVE_RUN_SQL, [task.tenant_id, task.id]);

    if ((activeRun.rowCount ?? 0) > 0) {
      throw new DomainError(
        'DB_UNAVAILABLE',
        'task has an active run during pre-claim convergence',
      );
    }

    const target: TaskStatus = reason.cancelRequested ? 'cancelled' : 'failed';
    const nextStatus = transitionTask(status, target);

    const update = await client.query(CONVERGE_OPEN_TASK_SQL, [
      nextStatus,
      at,
      task.tenant_id,
      task.id,
    ]);

    if (update.rowCount !== 1) {
      throw new DomainError('DB_UNAVAILABLE', 'could not converge an unclaimable task');
    }

    await appendTaskEvent(client, {
      tenantId: task.tenant_id,
      taskId: task.id,
      phase: target === 'cancelled' ? 'cancelled' : 'failed',
      occurredAt: at,
      payload: {
        fromStatus: status,
        toStatus: nextStatus,
        ...(reason.cancelRequested ? { cancelRequested: true } : {}),
        ...(reason.deadlineReached && !reason.cancelRequested
          ? { errorCode: 'DEADLINE_EXCEEDED' as const }
          : {}),
      },
    });
  }

  private finishConvergence(input: {
    readonly outcome: RunTerminalStatus;
    readonly task: TaskRow;
    readonly runRow: RunRow;
    readonly finishedAt: Date;
    readonly deadlineAt: Date | null;
    readonly cancelRequested: boolean;
  }): FinishConvergence {
    if (input.cancelRequested || input.outcome === 'cancelled') {
      return {
        taskStatus: 'cancelled',
        runStatus: 'cancelled',
        phase: 'cancelled',
        cancelRequested: input.cancelRequested,
      };
    }

    if (input.deadlineAt !== null && input.deadlineAt.getTime() <= input.finishedAt.getTime()) {
      return {
        taskStatus: 'failed',
        runStatus: 'failed_terminal',
        phase: 'failed',
        errorCode: 'DEADLINE_EXCEEDED',
      };
    }

    switch (input.outcome) {
      case 'succeeded':
        return { taskStatus: 'completed', runStatus: 'succeeded', phase: 'completed' };
      case 'failed_terminal':
        return { taskStatus: 'failed', runStatus: 'failed_terminal', phase: 'failed' };
      case 'failed_retryable': {
        const plan = planRetry({
          policy: this.config,
          now: input.finishedAt,
          attempt: input.runRow.attempt,
          maxAttempts: input.task.max_attempts,
          deadlineAt: input.deadlineAt,
        });

        return plan.retry
          ? {
              taskStatus: 'retryable_failed',
              runStatus: 'failed_retryable',
              phase: 'retry_scheduled',
              nextRunAt: plan.nextRunAt,
            }
          : {
              taskStatus: 'failed',
              runStatus: 'failed_retryable',
              phase: 'failed',
              errorCode: plan.reason === 'deadline_reached' ? 'DEADLINE_EXCEEDED' : undefined,
            };
      }
      case 'lease_expired':
        // Rejected before the transaction starts.
        throw new InvalidArgumentError([{ path: 'outcome', code: 'lease_expired_is_reaper_only' }]);
    }
  }

  private async applyFinish(
    client: pg.PoolClient,
    task: TaskRow,
    runRow: RunRow,
    convergence: FinishConvergence,
    finishedAt: Date,
  ): Promise<void> {
    const currentTaskStatus = toTaskStatus(task.status);
    const currentRunStatus = toRunStatus(runRow.status);

    const nextTaskStatus = transitionTask(currentTaskStatus, convergence.taskStatus);
    transitionRun(currentRunStatus, convergence.runStatus);

    const runUpdate = await client.query(FINISH_RUN_SQL, [
      convergence.runStatus,
      finishedAt,
      task.tenant_id,
      task.id,
      runRow.id,
    ]);

    if (runUpdate.rowCount !== 1) {
      throw new DomainError('DB_UNAVAILABLE', 'finish could not update the current run');
    }

    const taskUpdate = await client.query(FINISH_TASK_SQL, [
      nextTaskStatus,
      convergence.nextRunAt ?? toDate(task.next_run_at),
      finishedAt,
      task.tenant_id,
      task.id,
    ]);

    if (taskUpdate.rowCount !== 1) {
      throw new DomainError('DB_UNAVAILABLE', 'finish could not update the task');
    }

    await appendTaskEvent(client, {
      tenantId: task.tenant_id,
      taskId: task.id,
      phase: convergence.phase,
      occurredAt: finishedAt,
      payload: {
        runId: runRow.id,
        attempt: runRow.attempt,
        fromStatus: currentTaskStatus,
        toStatus: nextTaskStatus,
        runStatus: convergence.runStatus,
        ...(convergence.errorCode === undefined ? {} : { errorCode: convergence.errorCode }),
        ...(convergence.cancelRequested === undefined
          ? {}
          : { cancelRequested: convergence.cancelRequested }),
      },
    });
  }

  private async reapRunningTask(
    client: pg.PoolClient,
    task: TaskRow,
    reapedAt: Date,
  ): Promise<void> {
    if (task.current_run_id === null) {
      throw new DomainError(
        'DB_UNAVAILABLE',
        'running task has no current run reference; refusing to repair it silently',
      );
    }

    const runResult = await client.query<RunRow>(LOCK_RUN_SQL, [
      task.tenant_id,
      task.id,
      task.current_run_id,
    ]);
    const runRow = runResult.rows[0];

    if (runRow === undefined || runRow.status !== 'running') {
      throw new DomainError(
        'DB_UNAVAILABLE',
        'running task has no matching running run; refusing to repair it silently',
      );
    }

    if (
      parseLeaseEpoch(task.lease_epoch) !== parseLeaseEpoch(runRow.lease_epoch) ||
      task.attempt_count !== runRow.attempt
    ) {
      throw new DomainError(
        'DB_UNAVAILABLE',
        'running task and run disagree on attempt or lease epoch; refusing to repair it silently',
      );
    }

    const leaseExpiry = parsePersistedTimestamp(task.lease_expires_at);
    const deadlineAt = parsePersistedTimestamp(task.deadline_at);
    const cancelRequested = task.cancel_requested_at !== null;
    const leaseExpired = leaseExpiry !== null && leaseExpiry.getTime() <= reapedAt.getTime();
    const deadlineReached = deadlineAt !== null && deadlineAt.getTime() <= reapedAt.getTime();

    let convergence: FinishConvergence;

    if (cancelRequested) {
      convergence = {
        taskStatus: 'cancelled',
        // A cancellation intent that was not observed by a live worker still leaves the
        // expired Run as `lease_expired`; the Task is terminal `cancelled` with no retry.
        runStatus: leaseExpired ? 'lease_expired' : 'cancelled',
        phase: 'cancelled',
        cancelRequested: true,
      };
    } else if (leaseExpired) {
      const plan = planRetry({
        policy: this.config,
        now: reapedAt,
        attempt: runRow.attempt,
        maxAttempts: task.max_attempts,
        deadlineAt,
      });

      convergence = plan.retry
        ? {
            taskStatus: 'retryable_failed',
            runStatus: 'lease_expired',
            phase: 'retry_scheduled',
            nextRunAt: plan.nextRunAt,
          }
        : {
            taskStatus: 'failed',
            runStatus: 'lease_expired',
            phase: 'failed',
            errorCode: deadlineReached ? 'DEADLINE_EXCEEDED' : undefined,
          };
    } else if (deadlineReached) {
      convergence = {
        taskStatus: 'failed',
        runStatus: 'failed_terminal',
        phase: 'failed',
        errorCode: 'DEADLINE_EXCEEDED',
      };
    } else {
      throw new DomainError(
        'DB_UNAVAILABLE',
        'reaper selected a running task that is neither lease-expired nor deadline-expired',
      );
    }

    // A running Run must be terminalized; `lease_expired` comes only from this path.
    const nextTaskStatus = transitionTask(toTaskStatus(task.status), convergence.taskStatus);
    transitionRun('running', convergence.runStatus);

    const runUpdate = await client.query(FINISH_RUN_SQL, [
      convergence.runStatus,
      reapedAt,
      task.tenant_id,
      task.id,
      runRow.id,
    ]);

    if (runUpdate.rowCount !== 1) {
      throw new DomainError('DB_UNAVAILABLE', 'reaper could not terminalize the expired run');
    }

    const taskUpdate = await client.query(FINISH_TASK_SQL, [
      nextTaskStatus,
      convergence.nextRunAt ?? toDate(task.next_run_at),
      reapedAt,
      task.tenant_id,
      task.id,
    ]);

    if (taskUpdate.rowCount !== 1) {
      throw new DomainError('DB_UNAVAILABLE', 'reaper could not update the expired task');
    }

    await appendTaskEvent(client, {
      tenantId: task.tenant_id,
      taskId: task.id,
      phase: convergence.phase,
      occurredAt: reapedAt,
      payload: {
        runId: runRow.id,
        attempt: runRow.attempt,
        fromStatus: 'running',
        toStatus: nextTaskStatus,
        runStatus: convergence.runStatus,
        ...(convergence.errorCode === undefined ? {} : { errorCode: convergence.errorCode }),
        ...(convergence.cancelRequested === undefined
          ? {}
          : { cancelRequested: convergence.cancelRequested }),
      },
    });
  }
}
