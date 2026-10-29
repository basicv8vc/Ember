/**
 * Fixed HTTP limits for the task API (P0B-07a).
 *
 * These are compile-time constants on purpose: P0-B has no configuration service, and a
 * limit that a request can influence is not a limit.
 */

/** Base path of the task API. `Location` headers are built from it. */
export const TASKS_PATH = '/v1/tasks';

/**
 * Maximum accepted `POST /v1/tasks` body: 64 KiB (65 536 bytes).
 *
 * Enforced on the request stream (see `http/bounded-body.ts`), not only on
 * `Content-Length`: the first chunk that would exceed the cap aborts the read and the
 * remaining bytes are discarded.
 *
 * ## Bytes vs. characters (Review Round 1, P2)
 *
 * The byte cap and the `@ember/contracts` character limits measure different things, and the
 * byte cap is the outer, authoritative one. Measured over the *whole* JSON body, including the
 * envelope (`agent_id`, `kind`, `input`, the quotes and the `sha256` literal):
 *
 * | field (max chars)                          | single-byte text   | 3-byte UTF-8 text     |
 * | ------------------------------------------ | ------------------ | --------------------- |
 * | `mock.compute.text`, `mock.file.content` (64 000) | ~64 kB — accepted  | ~192 kB — 400          |
 * | `mock.chat.prompt` (8 000)                 | ~8 kB — accepted   | ~24 kB — accepted     |
 *
 * Consequences, all pinned by tests rather than left implicit:
 *
 * - a body whose text is ASCII can reach every schema limit and still fit under the cap;
 * - a 64 000-character field of 3-byte text is *not* representable: the byte cap confines the same
 *   field to about 21 800 characters (⌊65 536 / 3⌋ is an upper bound, before the JSON envelope), and
 *   even 4-byte text can contribute at most 16 384 characters;
 * - a body above 65 536 bytes is `400 INVALID_ARGUMENT` before parsing, validation or persistence.
 *
 * ## The second 64 KiB gate
 *
 * This is *not* the only byte limit a task command passes. `prepareTaskCommand` in
 * `@ember/postgres` applies `TASK_COMMAND_MAX_BYTES` (also 64 KiB) to the *canonical* command
 * immediately before the insert, which is a different serialisation: `agent_id` becomes `agentId`,
 * keys are sorted and `deadlineAt: null` is always present. That form is a few bytes larger than
 * the wire body for the same command, so the binding end-to-end limit for `mock.compute` sits just
 * below this cap. Both gates are deliberate resource bounds and both answer `400 INVALID_ARGUMENT`;
 * `tests/integration/http-task-api.test.ts` asserts the exact byte where acceptance flips.
 *
 * That asymmetry is intentional: a character budget must never become an unbounded byte budget,
 * so the cap is never raised to accommodate the widest encoding. Both limits stay enforced, which
 * means a body *under* the byte cap can still be a schema 400 (or a command too large for the
 * persistence gate).
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
