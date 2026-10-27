import { randomUUID } from 'node:crypto';
import {
  AuthContextSchema,
  IdSchema,
  TaskEventSchema,
  toInvalidArgumentError,
  type TaskRepository as TaskRepositoryContract,
} from '@ember/contracts';
import {
  DomainError,
  type AuthContext,
  type Id,
  type TaskCommand,
  type TaskEvent,
  type TaskReceipt,
  type TaskStatus,
  type TaskView,
} from '@ember/domain';
import type pg from 'pg';
import { prepareTaskCommand, type PreparedTaskCommand } from '../task-digest.js';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

interface TaskRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  kind: string;
  status: string;
  current_run_id: string | null;
  attempt_count: number;
  accepted_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  deadline_at: Date | string | null;
  digest: string;
}

interface TaskEventRow {
  task_id: string;
  sequence: number;
  phase: string;
  occurred_at: Date | string;
  trace_id: string;
  payload: unknown;
}

const TASK_COLUMNS = `
  id, tenant_id, agent_id, kind, status, current_run_id, attempt_count,
  accepted_at, created_at, updated_at, deadline_at, digest
`;

const INSERT_TASK_SQL = `
INSERT INTO tasks (
  id, tenant_id, agent_id, kind, input, digest, idempotency_key, deadline_at
)
VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
RETURNING ${TASK_COLUMNS}
`;

const SELECT_TASK_BY_IDEMPOTENCY_KEY_SQL = `
SELECT ${TASK_COLUMNS}
  FROM tasks
 WHERE tenant_id = $1 AND idempotency_key = $2
`;

const SELECT_TASK_BY_ID_SQL = `
SELECT ${TASK_COLUMNS}
  FROM tasks
 WHERE tenant_id = $1 AND id = $2
`;

const AGENT_EXISTS_SQL = `
SELECT 1
  FROM agents
 WHERE tenant_id = $1 AND id = $2
`;

const INSERT_ACCEPTED_EVENT_SQL = `
INSERT INTO task_events (id, tenant_id, task_id, sequence, phase, payload, trace_id, occurred_at)
VALUES ($1, $2, $3, 1, 'accepted', $4::jsonb, $5, now())
`;

const LIST_EVENTS_SQL = `
SELECT task_id, sequence, phase, occurred_at, trace_id, payload
  FROM task_events
 WHERE tenant_id = $1 AND task_id = $2
 ORDER BY sequence ASC
`;

const REQUEST_CANCEL_SQL = `
UPDATE tasks
   SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
       updated_at = CASE WHEN cancel_requested_at IS NULL THEN now() ELSE updated_at END
 WHERE tenant_id = $1 AND id = $2
RETURNING id
`;

const MAX_IDEMPOTENT_INSERT_ATTEMPTS = 3;

function parseContext(ctx: AuthContext): AuthContext {
  const parsed = AuthContextSchema.safeParse(ctx);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

function parseTaskId(taskId: Id): Id {
  const parsed = IdSchema.safeParse(taskId);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

function toTaskReceipt(row: TaskRow, replayed: boolean): TaskReceipt {
  return {
    taskId: row.id,
    status: row.status as TaskStatus,
    acceptedAt: toIsoTimestamp(row.accepted_at),
    replayed,
  };
}

function toTaskView(row: TaskRow): TaskView {
  return {
    taskId: row.id,
    agentId: row.agent_id,
    kind: row.kind as TaskView['kind'],
    status: row.status as TaskStatus,
    currentRunId: row.current_run_id,
    attemptCount: row.attempt_count,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
    deadlineAt: row.deadline_at === null ? null : toIsoTimestamp(row.deadline_at),
  };
}

/**
 * PostgreSQL-backed, tenant-scoped durable task inbox.
 *
 * `create()` returns only after the transaction has committed. A failed validation,
 * database write, event append or commit never produces a receipt. Idempotency is enforced
 * by `UNIQUE (tenant_id, idempotency_key)`, not by an in-process Map or a
 * SELECT-then-INSERT check.
 */
export class PostgresTaskRepository implements TaskRepositoryContract {
  constructor(private readonly pool: pg.Pool) {}

  async create(ctx: AuthContext, command: TaskCommand): Promise<TaskReceipt> {
    const validatedContext = parseContext(ctx);
    // Validation + canonical digest happen before a connection is acquired, so no database
    // transaction is held while hashing or validating input.
    const prepared = prepareTaskCommand(command);

    try {
      return await withTransaction(this.pool, async (client) => {
        const agent = await client.query(AGENT_EXISTS_SQL, [
          validatedContext.tenantId,
          prepared.command.agentId,
        ]);

        if (agent.rowCount === 0) {
          // Same result for "does not exist" and "belongs to another tenant".
          throw new DomainError('NOT_FOUND', 'agent is not visible in this tenant');
        }

        return await this.insertOrReplay(client, validatedContext, prepared);
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async get(ctx: AuthContext, taskId: Id): Promise<TaskView | null> {
    const validatedContext = parseContext(ctx);
    const validatedTaskId = parseTaskId(taskId);

    try {
      const result = await this.pool.query<TaskRow>(SELECT_TASK_BY_ID_SQL, [
        validatedContext.tenantId,
        validatedTaskId,
      ]);
      const row = result.rows[0];

      return row === undefined ? null : toTaskView(row);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Read durable events for one visible task in sequence order.
   *
   * This is a repository read used to prove B-T06; it is not the future SSE/polling API.
   * A missing or foreign task yields an empty list.
   */
  async listEvents(ctx: AuthContext, taskId: Id): Promise<readonly TaskEvent[]> {
    const validatedContext = parseContext(ctx);
    const validatedTaskId = parseTaskId(taskId);

    try {
      const result = await this.pool.query<TaskEventRow>(LIST_EVENTS_SQL, [
        validatedContext.tenantId,
        validatedTaskId,
      ]);

      return result.rows.map((row) => {
        const parsed = TaskEventSchema.safeParse({
          taskId: row.task_id,
          sequence: row.sequence,
          phase: row.phase,
          occurredAt: toIsoTimestamp(row.occurred_at),
          traceId: row.trace_id,
          payload: row.payload,
        });

        if (!parsed.success) {
          throw new DomainError('DB_UNAVAILABLE', 'persisted task event failed its contract');
        }

        return parsed.data;
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Persist cancellation *intent* only.
   *
   * P0B-03 does not transition the task, stop a run, or claim cooperative cancellation.
   * Those semantics (and OQ-1: cancelling `retryable_failed`) belong to P0B-08.
   */
  async requestCancel(ctx: AuthContext, taskId: Id): Promise<void> {
    const validatedContext = parseContext(ctx);
    const validatedTaskId = parseTaskId(taskId);

    try {
      const result = await this.pool.query(REQUEST_CANCEL_SQL, [
        validatedContext.tenantId,
        validatedTaskId,
      ]);

      if (result.rowCount === 0) {
        throw new DomainError('NOT_FOUND', 'task is not visible in this tenant');
      }
    } catch (error) {
      throw asDomainError(error);
    }
  }

  private async insertOrReplay(
    client: pg.PoolClient,
    ctx: AuthContext,
    prepared: PreparedTaskCommand,
  ): Promise<TaskReceipt> {
    for (let attempt = 0; attempt < MAX_IDEMPOTENT_INSERT_ATTEMPTS; attempt += 1) {
      const taskId = randomUUID();
      const inserted = await client.query<TaskRow>(INSERT_TASK_SQL, [
        taskId,
        ctx.tenantId,
        prepared.command.agentId,
        prepared.command.kind,
        JSON.stringify(prepared.command.input),
        prepared.digest,
        prepared.command.idempotencyKey,
        prepared.deadlineAt,
      ]);
      const insertedRow = inserted.rows[0];

      if (insertedRow !== undefined) {
        await this.appendAcceptedEvent(client, ctx, prepared, insertedRow);
        return toTaskReceipt(insertedRow, false);
      }

      // A different transaction already owns this (tenant_id, idempotency_key).
      // Under READ COMMITTED this SELECT takes a fresh snapshot after the conflicting
      // INSERT waited for that transaction to commit or roll back.
      const existing = await client.query<TaskRow>(SELECT_TASK_BY_IDEMPOTENCY_KEY_SQL, [
        ctx.tenantId,
        prepared.command.idempotencyKey,
      ]);
      const existingRow = existing.rows[0];

      if (existingRow !== undefined) {
        if (existingRow.digest !== prepared.digest) {
          // Stable public code/message; neither request payload nor digest is disclosed.
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'idempotency key already belongs to a different canonical command',
          );
        }

        return toTaskReceipt(existingRow, true);
      }

      // The conflicting transaction rolled back after our insert observed the conflict.
      // Retry the atomic insert rather than inventing an in-memory lock.
    }

    throw new DomainError(
      'DB_UNAVAILABLE',
      'idempotent task insert did not observe a committed row after bounded retries',
    );
  }

  private async appendAcceptedEvent(
    client: pg.PoolClient,
    ctx: AuthContext,
    prepared: PreparedTaskCommand,
    taskRow: TaskRow,
  ): Promise<void> {
    const event = {
      taskId: taskRow.id,
      sequence: 1,
      phase: 'accepted' as const,
      occurredAt: toIsoTimestamp(taskRow.accepted_at),
      traceId: randomUUID(),
      payload: {
        taskKind: prepared.command.kind,
        policyVersion: ctx.policyVersion,
        replayed: false,
      },
    };

    // Re-validate with the same closed allowlist used at the API boundary before writing.
    const parsed = TaskEventSchema.safeParse(event);

    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'accepted event failed its redaction contract');
    }

    await client.query(INSERT_ACCEPTED_EVENT_SQL, [
      randomUUID(),
      ctx.tenantId,
      parsed.data.taskId,
      JSON.stringify(parsed.data.payload),
      parsed.data.traceId,
    ]);
  }
}
