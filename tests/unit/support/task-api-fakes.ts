import {
  DomainError,
  isTerminalTaskStatus,
  transitionTask,
  type AuthContext,
  type Id,
  type TaskCommand,
  type TaskEvent,
  type TaskReceipt,
  type TaskView,
} from '@ember/domain';

import type {
  ListEventsOptions,
  TaskCancelResult,
  TaskStore,
} from '../../../apps/api/src/tasks/task-store.js';

/**
 * In-memory `TaskStore` for the P0B-07a / P0B-08c route tests.
 *
 * It records every call *with* the `AuthContext` it received, so a test can prove that the
 * tenant comes from the verified credential and that a rejected request never reached
 * persistence. Event reads apply the same contract as `PostgresTaskRepository`: ascending
 * `sequence`, exclusive `after`, bounded `limit`.
 */

export const FIXED_TIME = '2026-01-01T00:00:00.000Z';

export function buildTaskView(overrides: Partial<TaskView> = {}): TaskView {
  return {
    taskId: overrides.taskId ?? '00000000-0000-4000-8000-000000000001',
    agentId: overrides.agentId ?? '00000000-0000-4000-8000-000000000002',
    kind: overrides.kind ?? 'mock.chat',
    status: overrides.status ?? 'queued',
    currentRunId: overrides.currentRunId ?? null,
    attemptCount: overrides.attemptCount ?? 0,
    createdAt: overrides.createdAt ?? FIXED_TIME,
    updatedAt: overrides.updatedAt ?? FIXED_TIME,
    deadlineAt: overrides.deadlineAt ?? null,
  };
}

export function buildReceipt(overrides: Partial<TaskReceipt> = {}): TaskReceipt {
  return {
    taskId: overrides.taskId ?? '00000000-0000-4000-8000-000000000001',
    status: overrides.status ?? 'queued',
    acceptedAt: overrides.acceptedAt ?? FIXED_TIME,
    replayed: overrides.replayed ?? false,
  };
}

export function buildEvent(sequence: number, overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    taskId: overrides.taskId ?? '00000000-0000-4000-8000-000000000001',
    sequence,
    phase: overrides.phase ?? 'accepted',
    occurredAt: overrides.occurredAt ?? FIXED_TIME,
    traceId: overrides.traceId ?? '00000000-0000-4000-8000-000000000009',
    payload: overrides.payload ?? { taskKind: 'mock.chat', policyVersion: 1 },
  };
}

export interface RecordedEventRead {
  readonly context: AuthContext;
  readonly taskId: Id;
  readonly options: ListEventsOptions | undefined;
}

export interface FakeTaskApi {
  readonly store: TaskStore;
  readonly creates: TaskCommand[];
  readonly createContexts: AuthContext[];
  readonly gets: { readonly context: AuthContext; readonly taskId: Id }[];
  readonly cancels: { readonly context: AuthContext; readonly taskId: Id }[];
  readonly eventReads: RecordedEventRead[];
  /** Make `view` visible to `tenantId` and nobody else. */
  addTask(tenantId: string, view: TaskView): void;
  addEvents(tenantId: string, taskId: Id, events: readonly TaskEvent[]): void;
  setReceipt(receipt: TaskReceipt): void;
  setFailure(error: Error): void;
}

function scope(tenantId: string, taskId: Id): string {
  return `${tenantId}:${taskId}`;
}

export function createFakeTaskApi(): FakeTaskApi {
  const tasks = new Map<string, TaskView>();
  const cancelRequestedAtByScope = new Map<string, string>();
  const events = new Map<string, readonly TaskEvent[]>();
  const creates: TaskCommand[] = [];
  const createContexts: AuthContext[] = [];
  const gets: { context: AuthContext; taskId: Id }[] = [];
  const cancels: { context: AuthContext; taskId: Id }[] = [];
  const eventReads: RecordedEventRead[] = [];
  let receipt = buildReceipt();
  let failure: Error | undefined;

  const api: FakeTaskApi = {
    creates,
    createContexts,
    gets,
    cancels,
    eventReads,
    addTask: (tenantId, view) => {
      tasks.set(scope(tenantId, view.taskId), view);
    },
    addEvents: (tenantId, taskId, list) => {
      events.set(scope(tenantId, taskId), list);
    },
    setReceipt: (next) => {
      receipt = next;
    },
    setFailure: (error) => {
      failure = error;
    },
    store: {
      create: (context, command) => {
        createContexts.push(context);
        creates.push(command);

        return failure === undefined ? Promise.resolve(receipt) : Promise.reject(failure);
      },
      get: (context, taskId) => {
        gets.push({ context, taskId });

        if (failure !== undefined) {
          return Promise.reject(failure);
        }

        return Promise.resolve(tasks.get(scope(context.tenantId, taskId)) ?? null);
      },
      listEvents: (context, taskId, options) => {
        eventReads.push({ context, taskId, options });

        if (failure !== undefined) {
          return Promise.reject(failure);
        }

        const all = events.get(scope(context.tenantId, taskId)) ?? [];
        const after = options?.after ?? 0;
        const limit = options?.limit ?? all.length;

        return Promise.resolve(all.filter((event) => event.sequence > after).slice(0, limit));
      },
      cancel: (context, taskId): Promise<TaskCancelResult> => {
        cancels.push({ context, taskId });

        if (failure !== undefined) {
          return Promise.reject(failure);
        }

        const key = scope(context.tenantId, taskId);
        const existing = tasks.get(key);

        if (existing === undefined) {
          return Promise.reject(new DomainError('NOT_FOUND', 'task is not visible in this tenant'));
        }

        const priorCancelRequestedAt = cancelRequestedAtByScope.get(key) ?? null;

        if (isTerminalTaskStatus(existing.status)) {
          return Promise.resolve({
            taskId: existing.taskId,
            status: existing.status,
            cancelRequested: priorCancelRequestedAt !== null || existing.status === 'cancelled',
            cancelRequestedAt:
              priorCancelRequestedAt ??
              (existing.status === 'cancelled' ? existing.updatedAt : null),
            terminal: true,
            updatedAt: existing.updatedAt,
          });
        }

        const cancelRequestedAt = priorCancelRequestedAt ?? FIXED_TIME;
        cancelRequestedAtByScope.set(key, cancelRequestedAt);

        if (existing.status === 'running') {
          const updatedView: TaskView = { ...existing, updatedAt: cancelRequestedAt };
          tasks.set(key, updatedView);
          return Promise.resolve({
            taskId: existing.taskId,
            status: 'running',
            cancelRequested: true,
            cancelRequestedAt,
            terminal: false,
            updatedAt: updatedView.updatedAt,
          });
        }

        const nextStatus = transitionTask(existing.status, 'cancelled');
        const updatedView: TaskView = {
          ...existing,
          status: nextStatus,
          updatedAt: cancelRequestedAt,
        };
        tasks.set(key, updatedView);

        return Promise.resolve({
          taskId: existing.taskId,
          status: nextStatus,
          cancelRequested: true,
          cancelRequestedAt,
          terminal: true,
          updatedAt: updatedView.updatedAt,
        });
      },
    },
  };

  return api;
}
