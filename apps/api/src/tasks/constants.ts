/**
 * Fixed HTTP limits for the task API (P0B-07a).
 *
 * These are compile-time constants on purpose: P0-B has no configuration service, and a
 * limit that a request can influence is not a limit.
 */

/** Base path of the task API. `Location` headers are built from it. */
export const TASKS_PATH = '/v1/tasks';

/**
 * Maximum accepted `POST /v1/tasks` body: 64 KiB.
 *
 * Enforced on the request stream (see `http/bounded-body.ts`), not only on
 * `Content-Length`. The cap is far above every schema limit in `@ember/contracts`
 * (largest: 64 000 characters of `mock.compute` text), so a rejected body is a client bug or
 * an attack, never a legitimate request.
 */
export const MAX_TASK_BODY_BYTES = 64 * 1024;

/**
 * Maximum events returned by one `GET /v1/tasks/:taskId/events` page.
 *
 * Bounded so one request cannot turn into an unbounded scan/allocation; a client that wants
 * the whole log polls with the returned `sequence` values. P0-B tasks emit a handful of
 * events, so a page is normally the complete log.
 */
export const MAX_EVENTS_PER_PAGE = 100;

/** Header carrying the client-supplied idempotency key. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
