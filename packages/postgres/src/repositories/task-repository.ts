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
import { insertB3TaskDispatchOutbox } from './b3-task-dispatch-outbox.js';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';
import { cancelTaskInTransaction, type TaskCancelOutcome } from './task-cancellation.js';
import {
  parseListEventOptions,
  queryTaskEvents,
  type ListEventOptions,
} from './task-event-queries.js';

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
  cancel_requested_at: Date | string | null;
  digest: string;
}

const TASK_COLUMNS = `
  id, tenant_id, agent_id, kind, status, current_run_id, attempt_count,
  accepted_at, created_at, updated_at, deadline_at, cancel_requested_at, digest
`;

const INSERT_TASK_SQL = `
INSERT INTO tasks (
  id, tenant_id, agent_id, kind, title, input, digest, idempotency_key, deadline_at
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
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

export type { ListEventOptions } from './task-event-queries.js';
export type { TaskCancelOutcome } from './task-cancellation.js';

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
export interface PostgresTaskRepositoryOptions {
  readonly onTaskCreated?: (event: {
    readonly tenantId: Id;
    readonly taskId: Id;
    readonly kind: TaskCommand['kind'];
  }) => void;
}

export class PostgresTaskRepository implements TaskRepositoryContract {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PostgresTaskRepositoryOptions = {},
  ) {}

  async create(ctx: AuthContext, command: TaskCommand): Promise<TaskReceipt> {
    const validatedContext = parseContext(ctx);
    // Validation + canonical digest happen before a connection is acquired, so no database
    // transaction is held while hashing or validating input.
    const prepared = prepareTaskCommand(command);

    try {
      const receipt = await withTransaction(this.pool, async (client) => {
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

      if (!receipt.replayed && this.options.onTaskCreated !== undefined) {
        try {
          this.options.onTaskCreated({
            tenantId: validatedContext.tenantId,
            taskId: receipt.taskId,
            kind: prepared.command.kind,
          });
        } catch {
          // The committed outbox row guarantees recovery if Queue dispatch fails.
        }
      }

      return receipt;
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
   * Read durable events for one visible task in ascending sequence order.
   *
   * This is a repository read used to prove B-T06 and to serve
   * `GET /v1/tasks/:taskId/events` (P0B-07a). A missing or foreign task yields an empty
   * list, so callers that must distinguish 404 from an empty page check visibility first.
   *
   * @param options optional page bounds. `after` is **exclusive** (`sequence > after`), which
   * makes repeated polling idempotent; `limit` is bounded to keep one read finite.
   */
  async listEvents(
    ctx: AuthContext,
    taskId: Id,
    options?: ListEventOptions,
  ): Promise<readonly TaskEvent[]> {
    const validatedContext = parseContext(ctx);
    const validatedTaskId = parseTaskId(taskId);
    const page = options === undefined ? undefined : parseListEventOptions(options);

    try {
      return await queryTaskEvents(this.pool, validatedContext.tenantId, validatedTaskId, page);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Apply the ADR-0001 cancellation policy in one Task-locked transaction and return the
   * authoritative post-transaction Task state.
   *
   * - `queued`, `retryable_failed` and `waiting_approval` become `cancelled` immediately,
   *   with one terminal event and no new Run (`terminal: true`).
   * - `running` only records the first cancellation intent; the current valid Run or the
   *   Reaper converges the Task later (`terminal: false`).
   * - terminal Tasks are an idempotent no-op: status, timestamps and events are untouched
   *   (`terminal: true`).
   * - repeated cancellation preserves the first `cancel_requested_at`.
   */
  async cancel(ctx: AuthContext, taskId: Id): Promise<TaskCancelOutcome> {
    const validatedContext = parseContext(ctx);
    const validatedTaskId = parseTaskId(taskId);

    try {
      return await withTransaction(this.pool, async (client) => {
        const outcome = await cancelTaskInTransaction(
          client,
          validatedContext.tenantId,
          validatedTaskId,
        );

        if (outcome === null) {
          throw new DomainError('NOT_FOUND', 'task is not visible in this tenant');
        }

        return outcome;
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /** Record a cancellation request; satisfies the frozen `@ember/contracts` `TaskRepository`. */
  async requestCancel(ctx: AuthContext, taskId: Id): Promise<void> {
    await this.cancel(ctx, taskId);
  }

  private async insertOrReplay(
    client: pg.PoolClient,
    ctx: AuthContext,
    prepared: PreparedTaskCommand,
  ): Promise<TaskReceipt> {
    for (let attempt = 0; attempt < MAX_IDEMPOTENT_INSERT_ATTEMPTS; attempt += 1) {
      const taskId = globalThis.crypto.randomUUID();
      const inserted = await client.query<TaskRow>(INSERT_TASK_SQL, [
        taskId,
        ctx.tenantId,
        prepared.command.agentId,
        prepared.command.kind,
        prepared.command.title ?? null,
        JSON.stringify(prepared.command.input),
        prepared.digest,
        prepared.command.idempotencyKey,
        prepared.deadlineAt,
      ]);
      const insertedRow = inserted.rows[0];

      if (insertedRow !== undefined) {
        if (prepared.command.kind === 'python.agent') {
          await insertB3TaskDispatchOutbox(client, {
            tenantId: ctx.tenantId,
            taskId: insertedRow.id,
          });
        }
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
      traceId: globalThis.crypto.randomUUID(),
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
      globalThis.crypto.randomUUID(),
      ctx.tenantId,
      parsed.data.taskId,
      JSON.stringify(parsed.data.payload),
      parsed.data.traceId,
    ]);
  }
}
