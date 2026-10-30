import {
  AuthContextSchema,
  IdSchema,
  TaskStatusSchema,
  toInvalidArgumentError,
} from '@ember/contracts';
import type { ApprovalRepository, RunGrant } from '@ember/contracts';
import {
  DomainError,
  InvalidArgumentError,
  InvalidStateTransitionError,
  assertApprovalStatusTransition,
  isApprovalDecision,
  isApprovalStatus,
  targetStatusForDecision,
  transitionTask,
  type ApprovalDecision,
  type ApprovalDecisionReceipt,
  type ApprovalView,
  type AuthContext,
  type Id,
  type TaskStatus,
} from '@ember/domain';
import type pg from 'pg';
import type { Clock } from '../lease-queue/clock.js';
import { parseLeaseEpoch, parsePersistedTimestamp } from '../lease-queue/validation.js';
import { postLockInstant } from '../storage/result-committer.js';
import { appendTaskEvent } from './event-store.js';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

export interface PostgresApprovalRepositoryOptions {
  readonly clock?: Clock;
}

interface ApprovalRow {
  id: string;
  tenant_id: string;
  task_id: string;
  run_id: string;
  lease_epoch: string;
  action_digest: string;
  status: string;
  expires_at: Date | string;
  decided_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ApprovalTaskRow {
  id: string;
  tenant_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  deadline_at: Date | string | null;
  cancel_requested_at: Date | string | null;
}

const APPROVAL_COLUMNS = `
  id, tenant_id, task_id, run_id, lease_epoch::text AS lease_epoch,
  action_digest, status, expires_at, decided_at, created_at, updated_at
`;

const SELECT_APPROVAL_SQL = `
SELECT ${APPROVAL_COLUMNS}
  FROM approvals
 WHERE tenant_id = $1 AND id = $2
`;

const SELECT_APPROVAL_TASK_ID_SQL = `
SELECT task_id
  FROM approvals
 WHERE tenant_id = $1 AND id = $2
`;

const LIST_APPROVALS_BY_TASK_SQL = `
SELECT ${APPROVAL_COLUMNS}
  FROM approvals
 WHERE tenant_id = $1 AND task_id = $2
 ORDER BY created_at ASC, id ASC
`;

const LOCK_TASK_FOR_DECISION_SQL = `
SELECT id, tenant_id, status, attempt_count, max_attempts, deadline_at, cancel_requested_at
  FROM tasks
 WHERE tenant_id = $1 AND id = $2
 FOR UPDATE
`;

const LOCK_APPROVAL_SQL = `
SELECT ${APPROVAL_COLUMNS}
  FROM approvals
 WHERE tenant_id = $1 AND id = $2
 FOR UPDATE
`;

const UPDATE_APPROVAL_STATUS_SQL = `
UPDATE approvals
   SET status = $3,
       decided_at = $4,
       updated_at = $4
 WHERE tenant_id = $1 AND id = $2
`;

const UPDATE_TASK_APPROVED_SQL = `
UPDATE tasks
   SET status = 'queued',
       next_run_at = $3,
       lease_expires_at = NULL,
       max_attempts = max_attempts + 1,
       updated_at = $3
 WHERE tenant_id = $1 AND id = $2
`;

const UPDATE_TASK_TERMINAL_SQL = `
UPDATE tasks
   SET status = $3,
       lease_expires_at = NULL,
       updated_at = $4
 WHERE tenant_id = $1 AND id = $2
`;

const SWEEP_TASK_RESERVED_BUDGET_SQL = `
UPDATE budget_operations
   SET state = 'expired',
       consumed_steps = reserved_steps,
       consumed_units = reserved_units,
       consumed_elapsed_ms = reserved_elapsed_ms,
       consumed_slots = reserved_slots,
       settled_at = $3
 WHERE tenant_id = $1
   AND task_id = $2
   AND state = 'reserved'
`;

function toApprovalView(row: ApprovalRow): ApprovalView {
  if (!isApprovalStatus(row.status)) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted approval status is invalid');
  }

  return Object.freeze({
    approvalId: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    leaseEpoch: parseLeaseEpoch(row.lease_epoch),
    actionDigest: row.action_digest,
    status: row.status,
    expiresAt: toIsoTimestamp(row.expires_at),
    decidedAt: row.decided_at === null ? null : toIsoTimestamp(row.decided_at),
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  });
}

function parseAuthContext(ctx: AuthContext): AuthContext {
  const parsed = AuthContextSchema.safeParse(ctx);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

function parseId(value: Id, field: string): Id {
  const parsed = IdSchema.safeParse(value);

  if (!parsed.success) {
    throw new InvalidArgumentError([{ path: field, code: 'invalid_uuid' }]);
  }

  return parsed.data;
}

function parseTaskStatus(status: string): TaskStatus {
  const parsed = TaskStatusSchema.safeParse(status);

  if (!parsed.success) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted task status is invalid');
  }

  return parsed.data;
}

type DecisionTransactionResult =
  | {
      readonly outcome: 'decided';
      readonly receipt: ApprovalDecisionReceipt;
    }
  | {
      readonly outcome: 'refused';
      readonly error: DomainError;
    };

export class PostgresApprovalRepository implements ApprovalRepository {
  private readonly clock: Clock | undefined;

  constructor(
    private readonly pool: pg.Pool,
    options: PostgresApprovalRepositoryOptions = {},
  ) {
    this.clock = options.clock;
  }

  async get(ctx: AuthContext, approvalId: Id): Promise<ApprovalView | null> {
    const scoped = parseAuthContext(ctx);
    const validId = parseId(approvalId, 'approvalId');

    try {
      const result = await this.pool.query<ApprovalRow>(SELECT_APPROVAL_SQL, [
        scoped.tenantId,
        validId,
      ]);
      const row = result.rows[0];

      return row === undefined ? null : toApprovalView(row);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async listByTask(ctx: AuthContext, taskId: Id): Promise<readonly ApprovalView[]> {
    const scoped = parseAuthContext(ctx);
    const validTaskId = parseId(taskId, 'taskId');

    try {
      const result = await this.pool.query<ApprovalRow>(LIST_APPROVALS_BY_TASK_SQL, [
        scoped.tenantId,
        validTaskId,
      ]);

      return Object.freeze(result.rows.map(toApprovalView));
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /** Worker-side lookup scoped by the trusted RunGrant. */
  async listForGrant(
    grant: Pick<RunGrant, 'tenantId' | 'taskId'>,
  ): Promise<readonly ApprovalView[]> {
    const tenant = IdSchema.safeParse(grant.tenantId);
    const task = IdSchema.safeParse(grant.taskId);

    if (!tenant.success) {
      throw toInvalidArgumentError(tenant.error);
    }
    if (!task.success) {
      throw toInvalidArgumentError(task.error);
    }

    try {
      const result = await this.pool.query<ApprovalRow>(LIST_APPROVALS_BY_TASK_SQL, [
        tenant.data,
        task.data,
      ]);

      return Object.freeze(result.rows.map(toApprovalView));
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async decide(
    ctx: AuthContext,
    approvalId: Id,
    decision: ApprovalDecision,
    nowOverride?: Date,
  ): Promise<ApprovalDecisionReceipt> {
    const scoped = parseAuthContext(ctx);
    const validApprovalId = parseId(approvalId, 'approvalId');

    if (!isApprovalDecision(decision)) {
      throw new InvalidArgumentError([{ path: 'decision', code: 'invalid_enum_value' }]);
    }

    if (nowOverride !== undefined && Number.isNaN(nowOverride.getTime())) {
      throw new InvalidArgumentError([{ path: 'now', code: 'invalid_date' }]);
    }

    const desiredStatus = targetStatusForDecision(decision);
    const desiredTaskStatus: TaskStatus = decision === 'approve' ? 'queued' : 'failed';

    const txResult = await withTransaction<DecisionTransactionResult>(this.pool, async (client) => {
      // Locate the parent task first so row locks are always acquired in `tasks -> approvals`
      // order, matching `requestCancel`, `reapExpired`, and `commitStep`.
      const lookup = await client.query<{ task_id: string }>(SELECT_APPROVAL_TASK_ID_SQL, [
        scoped.tenantId,
        validApprovalId,
      ]);
      const taskId = lookup.rows[0]?.task_id;

      if (taskId === undefined) {
        throw new DomainError('NOT_FOUND', 'approval not found');
      }

      const taskResult = await client.query<ApprovalTaskRow>(LOCK_TASK_FOR_DECISION_SQL, [
        scoped.tenantId,
        taskId,
      ]);
      const task = taskResult.rows[0];

      if (task === undefined) {
        throw new DomainError('NOT_FOUND', 'approval task not found');
      }

      const approvalResult = await client.query<ApprovalRow>(LOCK_APPROVAL_SQL, [
        scoped.tenantId,
        validApprovalId,
      ]);
      const approval = approvalResult.rows[0];

      if (approval === undefined) {
        throw new DomainError('NOT_FOUND', 'approval not found');
      }

      if (!isApprovalStatus(approval.status)) {
        throw new DomainError('DB_UNAVAILABLE', 'persisted approval status is invalid');
      }

      const taskStatus = parseTaskStatus(task.status);
      const now = nowOverride ?? this.clock?.now() ?? (await postLockInstant(client));

      // 1. Terminal approval: idempotent replay if same decision, conflict if opposite,
      //    invalid state transition if expired.
      if (approval.status === 'approved' || approval.status === 'denied') {
        if (approval.status === desiredStatus) {
          if (approval.decided_at === null) {
            throw new DomainError('DB_UNAVAILABLE', 'decided approval has no decided_at timestamp');
          }

          return {
            outcome: 'decided',
            receipt: Object.freeze({
              approvalId: approval.id,
              taskId: task.id,
              status: approval.status,
              taskStatus,
              decidedAt: toIsoTimestamp(approval.decided_at),
              replayed: true,
            }),
          };
        }

        return {
          outcome: 'refused',
          error: new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `approval ${approval.id} was already ${approval.status}`,
          ),
        };
      }

      if (approval.status === 'expired') {
        return {
          outcome: 'refused',
          error: new InvalidStateTransitionError('approval', 'expired', desiredStatus),
        };
      }

      // 2. Pending approval: check Task cancellation, Task state, Task deadline, and Approval expiry.
      //    Any convergence is committed by returning `{ outcome: 'refused', error }`.
      await client.query(SWEEP_TASK_RESERVED_BUDGET_SQL, [scoped.tenantId, task.id, now]);

      if (task.cancel_requested_at !== null || taskStatus === 'cancelled') {
        assertApprovalStatusTransition('pending', 'expired');
        await client.query(UPDATE_APPROVAL_STATUS_SQL, [
          scoped.tenantId,
          approval.id,
          'expired',
          now,
        ]);

        if (taskStatus === 'waiting_approval') {
          transitionTask('waiting_approval', 'cancelled');
          await client.query(UPDATE_TASK_TERMINAL_SQL, [
            scoped.tenantId,
            task.id,
            'cancelled',
            now,
          ]);
          await appendTaskEvent(client, {
            tenantId: scoped.tenantId,
            taskId: task.id,
            phase: 'cancelled',
            occurredAt: now,
            payload: {
              taskKind: 'mock.approval',
              fromStatus: 'waiting_approval',
              toStatus: 'cancelled',
              cancelRequested: true,
            },
          });
        }

        return {
          outcome: 'refused',
          error: new InvalidStateTransitionError('task', 'cancelled', desiredTaskStatus),
        };
      }

      if (taskStatus !== 'waiting_approval') {
        assertApprovalStatusTransition('pending', 'expired');
        await client.query(UPDATE_APPROVAL_STATUS_SQL, [
          scoped.tenantId,
          approval.id,
          'expired',
          now,
        ]);

        return {
          outcome: 'refused',
          error: new InvalidStateTransitionError('task', taskStatus, desiredTaskStatus),
        };
      }

      const deadlineAt = parsePersistedTimestamp(task.deadline_at);
      if (deadlineAt !== null && deadlineAt.getTime() <= now.getTime()) {
        assertApprovalStatusTransition('pending', 'expired');
        transitionTask('waiting_approval', 'failed');
        await client.query(UPDATE_APPROVAL_STATUS_SQL, [
          scoped.tenantId,
          approval.id,
          'expired',
          now,
        ]);
        await client.query(UPDATE_TASK_TERMINAL_SQL, [scoped.tenantId, task.id, 'failed', now]);
        await appendTaskEvent(client, {
          tenantId: scoped.tenantId,
          taskId: task.id,
          phase: 'failed',
          occurredAt: now,
          payload: {
            taskKind: 'mock.approval',
            fromStatus: 'waiting_approval',
            toStatus: 'failed',
            errorCode: 'DEADLINE_EXCEEDED',
          },
        });

        return {
          outcome: 'refused',
          error: new InvalidStateTransitionError('approval', 'expired', desiredStatus),
        };
      }

      const expiresAt = parsePersistedTimestamp(approval.expires_at);
      if (expiresAt === null) {
        throw new DomainError('DB_UNAVAILABLE', 'persisted approval expires_at is invalid');
      }

      if (expiresAt.getTime() <= now.getTime()) {
        assertApprovalStatusTransition('pending', 'expired');
        transitionTask('waiting_approval', 'failed');
        await client.query(UPDATE_APPROVAL_STATUS_SQL, [
          scoped.tenantId,
          approval.id,
          'expired',
          now,
        ]);
        await client.query(UPDATE_TASK_TERMINAL_SQL, [scoped.tenantId, task.id, 'failed', now]);
        await appendTaskEvent(client, {
          tenantId: scoped.tenantId,
          taskId: task.id,
          phase: 'failed',
          occurredAt: now,
          payload: {
            taskKind: 'mock.approval',
            fromStatus: 'waiting_approval',
            toStatus: 'failed',
            errorCode: 'EXECUTION_TIMEOUT',
          },
        });

        return {
          outcome: 'refused',
          error: new InvalidStateTransitionError('approval', 'expired', desiredStatus),
        };
      }

      // 3. Apply live decision (`approve` or `deny`).
      assertApprovalStatusTransition('pending', desiredStatus);
      transitionTask('waiting_approval', desiredTaskStatus);

      await client.query(UPDATE_APPROVAL_STATUS_SQL, [
        scoped.tenantId,
        approval.id,
        desiredStatus,
        now,
      ]);

      if (decision === 'approve') {
        await client.query(UPDATE_TASK_APPROVED_SQL, [scoped.tenantId, task.id, now]);
        await appendTaskEvent(client, {
          tenantId: scoped.tenantId,
          taskId: task.id,
          phase: 'approval_granted',
          occurredAt: now,
          payload: {
            taskKind: 'mock.approval',
            fromStatus: 'waiting_approval',
            toStatus: 'queued',
            replayed: false,
            policyVersion: scoped.policyVersion,
          },
        });
      } else {
        await client.query(UPDATE_TASK_TERMINAL_SQL, [scoped.tenantId, task.id, 'failed', now]);
        await appendTaskEvent(client, {
          tenantId: scoped.tenantId,
          taskId: task.id,
          phase: 'approval_denied',
          occurredAt: now,
          payload: {
            taskKind: 'mock.approval',
            fromStatus: 'waiting_approval',
            toStatus: 'failed',
            errorCode: 'POLICY_DENIED',
            replayed: false,
            policyVersion: scoped.policyVersion,
          },
        });
        await appendTaskEvent(client, {
          tenantId: scoped.tenantId,
          taskId: task.id,
          phase: 'failed',
          occurredAt: now,
          payload: {
            taskKind: 'mock.approval',
            fromStatus: 'waiting_approval',
            toStatus: 'failed',
            errorCode: 'POLICY_DENIED',
            policyVersion: scoped.policyVersion,
          },
        });
      }

      return {
        outcome: 'decided',
        receipt: Object.freeze({
          approvalId: approval.id,
          taskId: task.id,
          status: desiredStatus,
          taskStatus: desiredTaskStatus,
          decidedAt: now.toISOString(),
          replayed: false,
        }),
      };
    });

    if (txResult.outcome === 'refused') {
      throw txResult.error;
    }

    return txResult.receipt;
  }
}
