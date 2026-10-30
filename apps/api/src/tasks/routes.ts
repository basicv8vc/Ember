import {
  CreateTaskRequestSchema,
  IdempotencyKeySchema,
  IdSchema,
  toCreateTaskBody,
  toTaskCommand,
  toTaskReceiptDto,
  type TaskEventDto,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import { Hono } from 'hono';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { readJsonBody, type BodyRejectionReason } from '../http/bounded-body.js';
import { respondInvalidArgument, respondNotFound } from '../http/error-mapping.js';
import {
  IDEMPOTENCY_KEY_HEADER,
  MAX_EVENTS_PER_PAGE,
  MAX_TASK_BODY_BYTES,
  TASKS_PATH,
} from './constants.js';
import {
  encodeSseFrame,
  mapTaskEventPage,
  resolveTaskEventStreamOptions,
  streamTaskEvents,
  taskEventStreamRegistry,
  type TaskEventStreamOptions,
  type TaskEventStreamRegistry,
} from './event-stream.js';
import {
  toTaskCancelDto,
  toTaskDetailDto,
  type TaskCancelDto,
  type TaskDetailDto,
  type TaskEventPageDto,
} from './dto.js';
import type { TaskStore } from './task-store.js';

/**
 * `/v1/tasks` — the P0B-07 / P0B-08c HTTP task API.
 *
 * Endpoints (all tenant-scoped, all authenticated by the `/v1` middleware):
 *
 * | method | path                        | success                                     |
 * | ------ | --------------------------- | ------------------------------------------- |
 * | POST   | `/v1/tasks`                 | 202 created, 200 replayed                   |
 * | GET    | `/v1/tasks/:taskId`         | 200 task detail                             |
 * | GET    | `/v1/tasks/:taskId/events`  | 200 event page                              |
 * | GET    | `/v1/tasks/:taskId/stream`  | 200 text/event-stream                       |
 * | POST   | `/v1/tasks/:taskId/cancel`  | 200 terminal, 202 cancellation in progress  |
 *
 * Rules enforced here, in this order:
 * 1. authentication happens in middleware, before any handler code runs;
 * 2. the tenant/principal used for every read and write comes from the verified
 *    `AuthContext` only — a body field can never select a tenant, and a request that tries
 *    to smuggle `tenant_id`/`principal_id` is rejected by the strict schema;
 * 3. identifiers and the `Idempotency-Key` header are validated before they reach SQL;
 * 4. the body is size-bounded and schema-validated before a repository call;
 * 5. "missing" and "another tenant's" produce the same 404 body.
 *
 * Domain failures are not caught here: they propagate to the app-level error handler, so
 * there is exactly one place that maps a code to a status and one place that builds an
 * error body.
 */

const BODY_REJECTION_MESSAGES: Readonly<Record<BodyRejectionReason, string>> = Object.freeze({
  missing_content_type: 'Content-Type must be application/json',
  unsupported_content_type: 'Content-Type must be application/json',
  empty_body: 'request body must be a JSON object',
  too_large: `request body must not exceed ${MAX_TASK_BODY_BYTES} bytes`,
  invalid_encoding: 'request body must be UTF-8 encoded JSON',
  invalid_json: 'request body must be valid JSON',
});

/**
 * Cursor syntax: plain decimal digits, bounded so `Number()` stays exact.
 *
 * `sequence` is a persisted integer and pages are ordered ascending, so a cursor is a
 * non-negative integer. `?after=` (empty) and `?after=-1`/`?after=1.5` are rejected rather
 * than coerced: silently treating a malformed cursor as `0` would replay the whole log.
 */
const CURSOR_PATTERN = /^\d{1,15}$/;

export type CursorResult = { readonly ok: true; readonly after: number } | { readonly ok: false };

export function parseAfterCursor(raw: string | undefined): CursorResult {
  if (raw === undefined) {
    return { ok: true, after: 0 };
  }

  if (!CURSOR_PATTERN.test(raw)) {
    return { ok: false };
  }

  const after = Number(raw);

  if (!Number.isSafeInteger(after)) {
    return { ok: false };
  }

  return { ok: true, after };
}

function parseTaskId(c: AppContext): Id | Response {
  const parsed = IdSchema.safeParse(c.req.param('taskId'));

  if (!parsed.success) {
    return respondInvalidArgument(c, 'taskId must be a UUID');
  }

  return parsed.data;
}

export interface TaskRouteDependencies {
  readonly store: TaskStore;
  readonly streamOptions?: TaskEventStreamOptions;
  readonly streamRegistry?: TaskEventStreamRegistry;
}

/**
 * Build the task routes.
 *
 * Dependencies are injected (rather than imported as module singletons) so the same
 * handlers run against PostgreSQL in production and against a fake in unit tests.
 */
export function createTaskRoutes(deps: TaskRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();
  const streamOptions = resolveTaskEventStreamOptions(deps.streamOptions);
  const streamRegistry = deps.streamRegistry ?? taskEventStreamRegistry;

  routes.post('/', async (c) => {
    const auth = c.get('auth');
    const idempotencyHeader = c.req.header(IDEMPOTENCY_KEY_HEADER);

    if (idempotencyHeader === undefined) {
      return respondInvalidArgument(c, `${IDEMPOTENCY_KEY_HEADER} header is required`);
    }

    const idempotencyKey = IdempotencyKeySchema.safeParse(idempotencyHeader);

    if (!idempotencyKey.success) {
      // The rejected value is not echoed: it may be long or contain client secrets.
      return respondInvalidArgument(c, `${IDEMPOTENCY_KEY_HEADER} header is malformed`);
    }

    const body = await readJsonBody(c.req.raw, MAX_TASK_BODY_BYTES);

    if (!body.ok) {
      return respondInvalidArgument(c, BODY_REJECTION_MESSAGES[body.reason]);
    }

    const request = CreateTaskRequestSchema.safeParse(body.value);

    if (!request.success) {
      return respondInvalidArgument(c, 'request body does not match the task schema');
    }

    // `toTaskCommand` re-validates the full command (body + header key) and throws a
    // `DomainError` for a rejected combination; the app-level handler maps it to 400.
    const command = toTaskCommand(toCreateTaskBody(request.data), idempotencyKey.data);
    const receipt = await deps.store.create(auth, command);
    const dto = toTaskReceiptDto(receipt);

    c.header('Location', `${TASKS_PATH}/${dto.task_id}`);

    // 201 would imply the task is done; 202 reflects "acceptance persisted, execution
    // pending". A replay returns 200 because nothing new was accepted.
    return c.json(dto, receipt.replayed ? 200 : 202);
  });

  routes.get('/:taskId', async (c) => {
    const taskId = parseTaskId(c);

    if (taskId instanceof Response) {
      return taskId;
    }

    const view = await deps.store.get(c.get('auth'), taskId);

    if (view === null) {
      // Identical body for "does not exist" and "belongs to another tenant": a 403 or a
      // different message would disclose that the task id exists.
      return respondNotFound(c, 'task is not visible in this tenant');
    }

    const dto: TaskDetailDto = toTaskDetailDto(view);
    return c.json(dto, 200);
  });

  routes.post('/:taskId/cancel', async (c) => {
    const taskId = parseTaskId(c);

    if (taskId instanceof Response) {
      return taskId;
    }

    if (deps.store.cancel === undefined) {
      throw new DomainError(
        'DB_UNAVAILABLE',
        'task cancellation is not configured for this process',
      );
    }

    const result = await deps.store.cancel(c.get('auth'), taskId);
    const dto: TaskCancelDto = toTaskCancelDto(result);

    // 200 OK when the Task is already in a terminal state (`cancelled`, `completed`, `failed`);
    // 202 Accepted when the Task is still `running` and cooperative cancellation is pending.
    return c.json(dto, result.terminal ? 200 : 202);
  });

  routes.get('/:taskId/events', async (c) => {
    const taskId = parseTaskId(c);

    if (taskId instanceof Response) {
      return taskId;
    }

    const cursor = parseAfterCursor(c.req.query('after'));

    if (!cursor.ok) {
      return respondInvalidArgument(c, 'after must be a non-negative integer cursor');
    }

    const auth = c.get('auth');

    // Visibility is checked before the event read: the store returns an empty list for a
    // missing *or* foreign task, which must not look like a legitimately empty page.
    const view = await deps.store.get(auth, taskId);

    if (view === null) {
      return respondNotFound(c, 'task is not visible in this tenant');
    }

    const events = await deps.store.listEvents(auth, taskId, {
      after: cursor.after,
      limit: MAX_EVENTS_PER_PAGE,
    });

    const mapped: TaskEventDto[] = [...mapTaskEventPage(events, taskId, cursor.after)];

    const page: TaskEventPageDto = { task_id: taskId, events: mapped };
    return c.json(page, 200);
  });

  routes.get('/:taskId/stream', async (c) => {
    const taskId = parseTaskId(c);

    if (taskId instanceof Response) {
      return taskId;
    }

    const url = new URL(c.req.url);
    const cursor = parseStreamCursor(
      url.searchParams.getAll('after'),
      c.req.header('Last-Event-ID'),
    );

    if (!cursor.ok) {
      return respondInvalidArgument(c, 'stream cursor must be a matching non-negative integer');
    }

    const auth = c.get('auth');
    const view = await deps.store.get(auth, taskId);

    if (view === null) {
      return respondNotFound(c, 'task is not visible in this tenant');
    }

    // Prime one durable page before returning streaming headers. Authentication, tenant
    // authorization, and initial EventStore failures therefore remain ordinary HTTP errors.
    const initialEvents = await deps.store.listEvents(auth, taskId, {
      after: cursor.after,
      limit: MAX_EVENTS_PER_PAGE,
    });
    mapTaskEventPage(initialEvents, taskId, cursor.after);

    const controller = new AbortController();
    const unregister = streamRegistry.register(controller);

    if (unregister === null) {
      throw new DomainError('DB_UNAVAILABLE', 'task event streams are shutting down');
    }

    const requestSignal = c.req.raw.signal;
    const abortForRequest = (): void => controller.abort();

    if (requestSignal.aborted) {
      controller.abort();
    } else {
      requestSignal.addEventListener('abort', abortForRequest, { once: true });
    }

    let cleaned = false;
    let readableController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let readableClosed = false;
    const cleanup = (): void => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      requestSignal.removeEventListener('abort', abortForRequest);
      controller.signal.removeEventListener('abort', closeForAbort);
      unregister();
    };
    const closeForAbort = (): void => {
      controller.abort();
      if (readableController !== undefined && !readableClosed) {
        readableClosed = true;
        try {
          readableController.close();
        } catch {
          // A canceled transport may already have closed its ReadableStream controller.
        }
      }
      cleanup();
    };

    controller.signal.addEventListener('abort', closeForAbort, { once: true });

    const iterator = streamTaskEvents({
      store: deps.store,
      auth,
      taskId,
      after: cursor.after,
      initialStatus: view.status,
      initialEvents,
      signal: controller.signal,
      options: streamOptions,
    })[Symbol.asyncIterator]();

    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        readableController = streamController;
      },
      async pull(streamController) {
        try {
          const next = await iterator.next();

          if (readableClosed) {
            return;
          }

          if (next.done) {
            readableClosed = true;
            cleanup();
            streamController.close();
          } else {
            streamController.enqueue(encodeSseFrame(next.value));
          }
        } catch {
          // Once headers are sent, a storage fault is a transport close. Reconnect uses the
          // last persisted event ID; no driver error text is exposed as a stream chunk.
          cleanup();
          if (!readableClosed) {
            readableClosed = true;
            streamController.close();
          }
        }
      },
      cancel() {
        controller.abort();
        cleanup();
        // Do not hold up the transport's cancel() on a database query already in flight.
        void iterator.return?.(undefined).catch(() => undefined);
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  return routes;
}

export function parseStreamCursor(
  afterValues: readonly string[],
  lastEventId: string | undefined,
): CursorResult {
  if (afterValues.length > 1) {
    return { ok: false };
  }

  const queryCursor = parseAfterCursor(afterValues[0]);
  const headerCursor = lastEventId === undefined ? undefined : parseAfterCursor(lastEventId);

  if (!queryCursor.ok || (headerCursor !== undefined && !headerCursor.ok)) {
    return { ok: false };
  }

  if (headerCursor?.ok && afterValues.length === 1 && queryCursor.after !== headerCursor.after) {
    return { ok: false };
  }

  return { ok: true, after: headerCursor?.ok ? headerCursor.after : queryCursor.after };
}
