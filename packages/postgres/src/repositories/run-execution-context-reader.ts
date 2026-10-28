import { TASK_INPUT_SCHEMAS, TaskKindSchema } from '@ember/contracts';
import type { RunExecutionContext, RunExecutionContextReader } from '@ember/contracts';
import { DomainError, type LeasedRun, type MockTaskInput, type TaskKind } from '@ember/domain';
import type pg from 'pg';
import { parseNow } from '../lease-queue/clock.js';
import { parseLeasedRun, parsePersistedTimestamp } from '../lease-queue/validation.js';
import { asDomainError, toIsoTimestamp } from './support.js';

interface ExecutionContextRow {
  tenant_id: string;
  task_id: string;
  agent_id: string;
  kind: string;
  input: unknown;
  task_status: string;
  attempt_count: number;
  task_lease_epoch: string;
  current_run_id: string | null;
  task_lease_expires_at: Date | string | null;
  deadline_at: Date | string | null;
  cancel_requested_at: Date | string | null;
  run_id: string;
  run_attempt: number;
  run_lease_epoch: string;
  run_status: string;
  worker_id: string | null;
  leased_until: Date | string | null;
  policy_version: number;
}

/**
 * One statement: PostgreSQL evaluates it under a single snapshot, so the Task, Run and Agent
 * columns are mutually consistent without an explicit transaction. Nothing is locked and no
 * transaction is held while the (possibly slow) mock execution runs.
 */
const SELECT_RUN_EXECUTION_CONTEXT_SQL = `
SELECT t.tenant_id,
       t.id                        AS task_id,
       t.agent_id,
       t.kind,
       t.input,
       t.status                    AS task_status,
       t.attempt_count,
       t.lease_epoch::text         AS task_lease_epoch,
       t.current_run_id,
       t.lease_expires_at          AS task_lease_expires_at,
       t.deadline_at,
       t.cancel_requested_at,
       r.id                        AS run_id,
       r.attempt                   AS run_attempt,
       r.lease_epoch::text         AS run_lease_epoch,
       r.status                    AS run_status,
       r.worker_id,
       r.leased_until,
       a.policy_version
  FROM tasks t
  JOIN runs r
    ON r.tenant_id = t.tenant_id
   AND r.task_id = t.id
   AND r.id = $3
  JOIN agents a
    ON a.tenant_id = t.tenant_id
   AND a.id = t.agent_id
 WHERE t.tenant_id = $1
   AND t.id = $2
`;

function toTaskKind(value: string): TaskKind {
  const parsed = TaskKindSchema.safeParse(value);

  if (!parsed.success) {
    // A persisted kind outside the vocabulary means corrupted data, not client input.
    throw new DomainError('DB_UNAVAILABLE', 'persisted task kind is not supported by this build');
  }

  return parsed.data;
}

function toTaskInput(kind: TaskKind, value: unknown): MockTaskInput {
  const parsed = TASK_INPUT_SCHEMAS[kind].safeParse(value);

  if (!parsed.success) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted task input failed its contract');
  }

  return parsed.data;
}

function parseEpoch(value: string): number {
  const epoch = Number(value);

  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted lease epoch is not a safe integer');
  }

  return epoch;
}

function parsePolicyVersion(value: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted agent policy version is not a safe integer');
  }

  return value;
}

/**
 * PostgreSQL-backed trusted execution-context reader (P0B-05).
 *
 * The reference is a `LeasedRun` — the fenced claim the worker already owns — and the row is
 * located by *tenant + task + run*, never by a bare task or run id. Every fencing field the
 * claim returned is re-checked against the database, so a worker whose lease was replaced,
 * expired or cancelled cannot obtain an execution context and therefore cannot execute.
 *
 * Cancellation wins over every other rejection (ADR-0001): a committed cancellation intent is
 * reported as `CANCELLED` even when the lease has also expired.
 */
export class PostgresRunExecutionContextReader implements RunExecutionContextReader {
  constructor(private readonly pool: pg.Pool) {}

  async read(lease: LeasedRun, now: Date): Promise<RunExecutionContext> {
    const leased = parseLeasedRun(lease);
    const sampledAt = parseNow(now, 'now');

    try {
      const result = await this.pool.query<ExecutionContextRow>(SELECT_RUN_EXECUTION_CONTEXT_SQL, [
        leased.tenantId,
        leased.taskId,
        leased.runId,
      ]);
      const row = result.rows[0];

      if (row === undefined) {
        // Missing, foreign-tenant and wrong-task references are indistinguishable.
        throw new DomainError('NOT_FOUND', 'leased run is not visible in this tenant');
      }

      if (row.cancel_requested_at !== null) {
        throw new DomainError('CANCELLED', 'task has a committed cancellation intent');
      }

      if (row.task_status !== 'running') {
        throw new DomainError('STALE_LEASE', 'task is not running for this lease');
      }

      if (row.current_run_id !== leased.runId) {
        throw new DomainError('STALE_LEASE', 'task current run no longer matches the lease');
      }

      if (row.run_status !== 'running') {
        throw new DomainError('STALE_LEASE', 'run is no longer running');
      }

      if (parseEpoch(row.task_lease_epoch) !== leased.leaseEpoch) {
        throw new DomainError('STALE_LEASE', 'task lease epoch no longer matches the lease');
      }

      if (
        parseEpoch(row.run_lease_epoch) !== leased.leaseEpoch ||
        row.run_attempt !== leased.attempt ||
        row.attempt_count !== leased.attempt
      ) {
        throw new DomainError('STALE_LEASE', 'run attempt or epoch no longer matches the lease');
      }

      const taskExpiry = parsePersistedTimestamp(row.task_lease_expires_at);
      const runExpiry = parsePersistedTimestamp(row.leased_until);

      if (taskExpiry === null || runExpiry === null) {
        throw new DomainError('STALE_LEASE', 'lease has no persisted expiry');
      }

      if (
        taskExpiry.getTime() <= sampledAt.getTime() ||
        runExpiry.getTime() <= sampledAt.getTime()
      ) {
        throw new DomainError('STALE_LEASE', 'lease has expired');
      }

      const deadlineAt = parsePersistedTimestamp(row.deadline_at);

      if (deadlineAt !== null && deadlineAt.getTime() <= sampledAt.getTime()) {
        throw new DomainError('DEADLINE_EXCEEDED', 'task deadline elapsed before execution');
      }

      const kind = toTaskKind(row.kind);

      return Object.freeze({
        tenantId: row.tenant_id,
        taskId: row.task_id,
        runId: row.run_id,
        agentId: row.agent_id,
        attempt: row.run_attempt,
        leaseEpoch: leased.leaseEpoch,
        leaseExpiresAt: toIsoTimestamp(runExpiry),
        deadlineAt: row.deadline_at === null ? null : toIsoTimestamp(row.deadline_at),
        policyVersion: parsePolicyVersion(row.policy_version),
        kind,
        input: toTaskInput(kind, row.input),
        workerId: row.worker_id,
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }
}
