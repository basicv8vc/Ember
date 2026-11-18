import { DomainError, isDomainError } from '@ember/domain';
import type pg from 'pg';

/**
 * Repository-level error mapping.
 *
 * Public callers only ever see the fixed `DomainError.publicMessage`. Driver text, SQL,
 * constraint details and connection information stay in `diagnostic`, which is never
 * serialised into an error DTO or written to an access log.
 */
export function asDomainError(error: unknown): DomainError {
  if (isDomainError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  // Driver diagnostics stay internal: never serialised, but they make an operator-visible
  // log line actionable (code/constraint/table without any row content).
  const details = error as { code?: unknown; constraint?: unknown; table?: unknown };
  const suffix = [
    typeof details.code === 'string' ? `code=${details.code}` : null,
    typeof details.constraint === 'string' ? `constraint=${details.constraint}` : null,
    typeof details.table === 'string' ? `table=${details.table}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');

  return new DomainError(
    'DB_UNAVAILABLE',
    `database operation failed: ${message}${suffix === '' ? '' : ` (${suffix})`}`,
  );
}

export interface WithTransactionOptions {
  readonly onCommitAttempt?: () => void;
}

export async function withTransaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
  options: WithTransactionOptions = {},
): Promise<T> {
  let client: pg.PoolClient;

  try {
    client = await pool.connect();
  } catch (error) {
    throw asDomainError(error);
  }

  let commitAttempted = false;

  try {
    await client.query('BEGIN');
    const result = await operation(client);
    commitAttempted = true;
    options.onCommitAttempt?.();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (!commitAttempted) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw asDomainError(error);
  } finally {
    client.release();
  }
}

/** Normalise a PostgreSQL `timestamptz` value to the RFC 3339 form used by the domain. */
export function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
