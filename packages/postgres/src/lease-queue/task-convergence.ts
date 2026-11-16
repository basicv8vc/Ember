import type pg from 'pg';
import {
  DomainError,
  InvalidArgumentError,
  isTerminalTaskStatus,
  transitionRun,
  transitionTask,
} from '@ember/domain';
import type {
  RunTerminalStatus,
  TaskEventPayload,
  TaskEventPhase,
  TaskStatus,
} from '@ember/domain';
import { appendTaskEvent } from '../repositories/event-store.js';
import { finalizeTaskTerminalEffects } from '../repositories/task-terminal-effects.js';
import type { RetryPolicyConfig } from './config.js';
import { planRetry } from './retry-policy.js';

/**
 * Shared terminal convergence for a leased Run.
 *
 * P0B-04 (`PostgresLeaseQueue.finish`), the Reaper and the P0B-06 `RunResultCommitter` all
 * converge Task/Run state the same way. Keeping one implementation is what guarantees:
 * - the approved Domain FSM is the only source of legal edges;
 * - exactly one terminal Task event is written per Run;
 * - a retry schedules `retryable_failed` with the same backoff rules everywhere;
 * - cancellation wins over a submitted result (ADR-0001).
 *
 * The caller owns the transaction and must already hold the Task row lock.
 */

export interface TaskRow {
  id: string;
  tenant_id: string;
  kind?: string;
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

export interface RunRow {
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

export interface FinishConvergence {
  readonly taskStatus: TaskStatus;
  readonly runStatus: RunTerminalStatus;
  readonly phase: TaskEventPhase;
  readonly nextRunAt?: Date;
  readonly errorCode?: TaskEventPayload['errorCode'];
  readonly cancelRequested?: boolean;
}

export const FINISH_RUN_SQL = `
UPDATE runs
   SET status = $1,
       -- Never write a finish instant earlier than the persisted start, which a skewed
       -- clock could otherwise turn into a constraint violation at the last step.
       finished_at = GREATEST($2, started_at),
       leased_until = NULL,
       updated_at = $2
 WHERE tenant_id = $3 AND task_id = $4 AND id = $5
`;

export const FINISH_TASK_SQL = `
UPDATE tasks
   SET status = $1, next_run_at = $2, lease_expires_at = NULL, updated_at = $3
 WHERE tenant_id = $4 AND id = $5
`;

/**
 * Decide the terminal Task/Run pair for one outcome.
 *
 * Every branch is later validated by the Domain FSM, so an edge that the approved graph does
 * not contain fails loudly instead of being persisted.
 */
export function planFinishConvergence(input: {
  readonly outcome: RunTerminalStatus;
  readonly task: TaskRow;
  readonly runRow: RunRow;
  readonly finishedAt: Date;
  readonly deadlineAt: Date | null;
  readonly cancelRequested: boolean;
  readonly policy: RetryPolicyConfig;
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
        policy: input.policy,
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
      // The Reaper is the only writer allowed to produce lease_expired.
      throw new InvalidArgumentError([{ path: 'outcome', code: 'lease_expired_is_reaper_only' }]);
  }
}

/**
 * Apply one convergence inside the caller's transaction and append exactly one terminal event.
 *
 * `payloadExtra` may only contain allowlisted `TaskEventPayload` fields; the event store
 * validates the whole payload against the Zod schema before inserting it.
 */
export async function applyFinishConvergence(
  client: pg.PoolClient,
  input: {
    readonly task: TaskRow;
    readonly runRow: RunRow;
    readonly convergence: FinishConvergence;
    readonly finishedAt: Date;
    readonly payloadExtra?: TaskEventPayload;
  },
): Promise<{ readonly taskStatus: TaskStatus; readonly runStatus: RunTerminalStatus }> {
  const currentTaskStatus = toTaskStatus(input.task.status);
  const nextTaskStatus = transitionTask(currentTaskStatus, input.convergence.taskStatus);

  transitionRun('running', input.convergence.runStatus);

  const runUpdate = await client.query(FINISH_RUN_SQL, [
    input.convergence.runStatus,
    input.finishedAt,
    input.task.tenant_id,
    input.task.id,
    input.runRow.id,
  ]);

  if (runUpdate.rowCount !== 1) {
    throw new DomainError('DB_UNAVAILABLE', 'finish could not update the current run');
  }

  const taskUpdate = await client.query(FINISH_TASK_SQL, [
    nextTaskStatus,
    input.convergence.nextRunAt ?? toDate(input.task.next_run_at),
    input.finishedAt,
    input.task.tenant_id,
    input.task.id,
  ]);

  if (taskUpdate.rowCount !== 1) {
    throw new DomainError('DB_UNAVAILABLE', 'finish could not update the task');
  }

  await appendTaskEvent(client, {
    tenantId: input.task.tenant_id,
    taskId: input.task.id,
    phase: input.convergence.phase,
    occurredAt: input.finishedAt,
    payload: {
      runId: input.runRow.id,
      attempt: input.runRow.attempt,
      fromStatus: currentTaskStatus,
      toStatus: nextTaskStatus,
      runStatus: input.convergence.runStatus,
      ...(input.convergence.errorCode === undefined
        ? {}
        : { errorCode: input.convergence.errorCode }),
      ...(input.convergence.cancelRequested === undefined
        ? {}
        : { cancelRequested: input.convergence.cancelRequested }),
      ...(input.payloadExtra ?? {}),
    },
  });

  if (isTerminalTaskStatus(nextTaskStatus)) {
    await finalizeTaskTerminalEffects(client, {
      tenantId: input.task.tenant_id,
      taskId: input.task.id,
      status: nextTaskStatus,
      occurredAt: input.finishedAt,
    });
  }

  return Object.freeze({ taskStatus: nextTaskStatus, runStatus: input.convergence.runStatus });
}

function toTaskStatus(value: string): TaskStatus {
  // A persisted status outside the vocabulary is corrupted data, not client input.
  const allowed: readonly string[] = [
    'queued',
    'running',
    'waiting_approval',
    'retryable_failed',
    'completed',
    'failed',
    'cancelled',
  ];

  if (!allowed.includes(value)) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted task status is not supported by this build');
  }

  return value as TaskStatus;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
