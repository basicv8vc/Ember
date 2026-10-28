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
  return new DomainError('DB_UNAVAILABLE', `database operation failed: ${message}`);
}

export async function withTransaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient;

  try {
    client = await pool.connect();
  } catch (error) {
    throw asDomainError(error);
  }

  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw asDomainError(error);
  } finally {
    client.release();
  }
}

/** Normalise a PostgreSQL `timestamptz` value to the RFC 3339 form used by the domain. */
export function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
