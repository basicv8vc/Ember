import type { B1MeResponse } from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import type { createPool } from '@ember/postgres';
import type { B1MeProjectionReader } from './session-service.js';

type B1ProjectionPool = ReturnType<typeof createPool>;

const SELECT_ME_FOR_TENANT_SQL = `
SELECT c.id AS consumer_id,
       a.id AS agent_id,
       a.name AS display_name,
       conv.id AS conversation_id,
       conv.transcript_epoch,
       conv.created_at AS conversation_created_at,
       conv.updated_at AS conversation_updated_at
  FROM consumers c
  JOIN conversations conv
    ON conv.tenant_id = c.tenant_id AND conv.kind = 'main'
  JOIN agents a
    ON a.tenant_id = conv.tenant_id AND a.id = conv.agent_id
 WHERE c.tenant_id = $1
 ORDER BY conv.created_at, conv.id
 LIMIT 1
`;

interface MeProjectionRow {
  consumer_id: string;
  agent_id: string;
  display_name: string;
  conversation_id: string;
  transcript_epoch: number | string;
  conversation_created_at: Date | string;
  conversation_updated_at: Date | string;
}

function isoTimestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DomainError('DB_UNAVAILABLE', 'b1 me projection contains an invalid timestamp');
  }
  return parsed.toISOString();
}

/** Tenant-qualified, read-only projection of the identity graph created at sign-in. */
export class PostgresB1MeProjectionReader implements B1MeProjectionReader {
  constructor(private readonly pool: B1ProjectionPool) {}

  async getMeForTenant(tenantId: Id): Promise<B1MeResponse | null> {
    let rows: readonly MeProjectionRow[];
    try {
      const result = await this.pool.query<MeProjectionRow>(SELECT_ME_FOR_TENANT_SQL, [tenantId]);
      rows = result.rows;
    } catch {
      // Driver errors can contain SQL, connection details or parameter values. Keep the
      // diagnostic fixed; the HTTP error mapper logs only the closed DomainError code.
      throw new DomainError('DB_UNAVAILABLE', 'b1 me projection query failed');
    }

    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    const transcriptEpoch = Number(row.transcript_epoch);
    if (!Number.isSafeInteger(transcriptEpoch) || transcriptEpoch < 0) {
      throw new DomainError(
        'DB_UNAVAILABLE',
        'b1 me projection contains an invalid transcript epoch',
      );
    }

    return {
      consumer_id: row.consumer_id,
      agent: {
        agent_id: row.agent_id,
        display_name: row.display_name,
      },
      conversation: {
        conversation_id: row.conversation_id,
        transcript_epoch: transcriptEpoch,
        created_at: isoTimestamp(row.conversation_created_at),
        updated_at: isoTimestamp(row.conversation_updated_at),
      },
    };
  }
}
