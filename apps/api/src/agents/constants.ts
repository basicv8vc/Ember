/**
 * Limits and wire names for the `/v1/agents` HTTP surface (P0B-07d).
 */

/** Base path mounted in `app.ts`. */
export const AGENTS_PATH = '/v1/agents';

/** Minimum character length for an agent display name. */
export const AGENT_NAME_MIN_CHARS = 1;

/** Maximum character length for an agent display name (`agents.name` CHECK constraint). */
export const AGENT_NAME_MAX_CHARS = 128;

/**
 * Maximum raw UTF-8 byte length of a `POST /v1/agents` request body (4 KiB).
 *
 * A legal request body contains only `{ "name": "<1..128 chars>" }`, which is at most ~600
 * UTF-8 bytes even with 4-byte code points and JSON whitespace. Bounding the raw stream at
 * 4 KiB rejects oversized bodies before JSON parsing or schema evaluation runs.
 */
export const MAX_AGENT_BODY_BYTES = 4 * 1024;
