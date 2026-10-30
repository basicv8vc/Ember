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

/**
 * The narrow slice of task persistence the HTTP API needs (P0B-07a / P0B-08c).
 *
 * This is a port, not a second repository: `PostgresTaskRepository` already implements
 * these methods with tenant-scoped SQL. Declaring the interface locally keeps the HTTP layer
 * free of driver details and makes the API unit-testable with an in-memory fake.
 *
 * Contract that every implementation must honour:
 * - every method takes a verified `AuthContext` and scopes all SQL by `ctx.tenantId`;
 * - `get()` returns `null` both for "no such task" and "belongs to another tenant", so the
 *   API can answer 404 without disclosing existence;
 * - `cancel()` applies the ADR-0001 cancellation policy in one Task-locked transaction and
 *   returns the authoritative post-transaction Task state, throwing `NOT_FOUND` for both
 *   missing and foreign-tenant tasks;
 * - `listEvents()` is ordered by ascending `sequence` and applies `after` **exclusively**
 *   (`sequence > after`), so a client can poll without duplicate events;
 * - failures surface as `DomainError`s; the API maps them, never reinterprets them.
 */

/** Page options for the event log. Both bounds are optional for existing callers. */
export interface ListEventsOptions {
  /** Exclusive lower bound: only events with `sequence > after` are returned. */
  readonly after?: number;
  /** Maximum number of events in the page. */
  readonly limit?: number;
}

/**
 * Authoritative post-transaction Task state returned by `TaskStore.cancel()`.
 *
 * - `terminal: true` means the Task is already in a terminal state (`cancelled`, `completed`,
 *   or `failed`), which the HTTP layer maps to `200 OK`.
 * - `terminal: false` means the Task is still `running` with `cancel_requested_at` durably
 *   recorded, which the HTTP layer maps to `202 Accepted`.
 */
export interface TaskCancelResult {
  readonly taskId: Id;
  readonly status: TaskStatus;
  readonly cancelRequested: boolean;
  readonly cancelRequestedAt: string | null;
  readonly terminal: boolean;
  readonly updatedAt: string;
}

export interface TaskStore {
  create(ctx: AuthContext, command: TaskCommand): Promise<TaskReceipt>;
  get(ctx: AuthContext, taskId: Id): Promise<TaskView | null>;
  listEvents(
    ctx: AuthContext,
    taskId: Id,
    options?: ListEventsOptions,
  ): Promise<readonly TaskEvent[]>;
  cancel?(ctx: AuthContext, taskId: Id): Promise<TaskCancelResult>;
}

/**
 * Fail-closed default used when the API is built without a database (unit tests, or a
 * diagnostic run of `createApp()`).
 *
 * The `/v1` routes stay registered and authenticated, then report `DB_UNAVAILABLE` (503)
 * instead of pretending the task store is empty. Reporting "no tasks" would be a lie that
 * clients cannot distinguish from real data.
 */
export function unconfiguredTaskStore(): TaskStore {
  const unavailable = (): Promise<never> =>
    Promise.reject(
      new DomainError('DB_UNAVAILABLE', 'task store is not configured for this process'),
    );

  return {
    create: () => unavailable(),
    get: () => unavailable(),
    listEvents: () => unavailable(),
    cancel: () => unavailable(),
  };
}
