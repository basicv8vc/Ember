import { createHash } from 'node:crypto';
import { TaskCommandSchema, toInvalidArgumentError } from '@ember/contracts';
import { InvalidArgumentError, type TaskCommand } from '@ember/domain';

/**
 * Version prefix so a future digest change is explicit rather than silently reinterpreted.
 * It is not a request field and it is never exposed to clients.
 */
export const TASK_COMMAND_DIGEST_VERSION = 'ember.task-command.v1';

/** Maximum canonical command size accepted before persistence (UTF-8 bytes). */
export const TASK_COMMAND_MAX_BYTES = 64 * 1024;

export interface PreparedTaskCommand {
  /** Re-validated command. Body fields are already strict and kind/input correlated. */
  readonly command: TaskCommand;
  /** Deterministic JSON representation that was hashed (safe for tests/diagnostics). */
  readonly canonical: string;
  /** Lowercase hex SHA-256 over the versioned canonical command. */
  readonly digest: string;
  /** Deadline normalised to UTC; `null` when the command has no deadline. */
  readonly deadlineAt: string | null;
}

/**
 * Deterministic JSON serialisation:
 * - object keys are sorted recursively;
 * - array order is preserved because order is semantic;
 * - `undefined` object members are omitted (the same as JSON.stringify);
 * - no whitespace or locale-dependent formatting is used.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        sorted[key] = sortValue(item);
      }
    }

    return sorted;
  }

  return value;
}

/**
 * Validate and fingerprint a task command.
 *
 * The digest covers `agentId`, `kind`, the kind-specific `input` and `deadlineAt` in UTC.
 * It deliberately does not cover `idempotencyKey`: that key is the lookup address, not
 * request content, so the same command can be safely retried with the same key and a
 * replay with a different key is not forced to look identical.
 *
 * Validation happens before serialisation. Oversized commands are rejected by UTF-8 byte
 * length, not JavaScript character count.
 *
 * @throws {InvalidArgumentError} for an invalid command or a command above 64 KiB.
 */
export function prepareTaskCommand(command: unknown): PreparedTaskCommand {
  const parsed = TaskCommandSchema.safeParse(command);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  const validated = parsed.data;
  const deadlineAt =
    validated.deadlineAt === undefined ? null : new Date(validated.deadlineAt).toISOString();

  const canonical = canonicalJson({
    agentId: validated.agentId,
    kind: validated.kind,
    ...(validated.title === undefined ? {} : { title: validated.title }),
    input: validated.input,
    deadlineAt,
  });

  // `Buffer.byteLength` counts UTF-8 bytes. A 64,000-character CJK text can exceed 64 KiB.
  if (Buffer.byteLength(canonical, 'utf8') > TASK_COMMAND_MAX_BYTES) {
    throw new InvalidArgumentError([{ path: 'input', code: 'too_big' }]);
  }

  const digest = createHash('sha256')
    .update(`${TASK_COMMAND_DIGEST_VERSION}\n${canonical}`, 'utf8')
    .digest('hex');

  return { command: validated, canonical, digest, deadlineAt };
}
