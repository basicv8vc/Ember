import { randomUUID } from 'node:crypto';
import { TaskEventSchema } from '@ember/contracts';
import { DomainError, type Id, type TaskEventPayload, type TaskEventPhase } from '@ember/domain';
import type pg from 'pg';

interface NextSequenceRow {
  next_sequence: number;
}

const NEXT_SEQUENCE_SQL = `
SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
  FROM task_events
 WHERE tenant_id = $1 AND task_id = $2
`;

const INSERT_EVENT_SQL = `
INSERT INTO task_events (id, tenant_id, task_id, sequence, phase, payload, trace_id, occurred_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
`;

export interface AppendTaskEventInput {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly phase: TaskEventPhase;
  readonly payload: TaskEventPayload;
  readonly occurredAt: Date;
}

/**
 * Append one allowlisted Task event using the persistent sequence.
 *
 * `MAX(sequence) + 1` is safe here only because every P0B-04 writer (claim, finish,
 * reaper, retry and cancellation) holds the same Task row lock (`SELECT … FOR UPDATE`)
 * for the whole transaction. There is no in-memory counter. `accepted` remains sequence 1
 * and is never written by this helper.
 */
export async function appendTaskEvent(
  client: pg.PoolClient,
  input: AppendTaskEventInput,
): Promise<number> {
  const next = await client.query<NextSequenceRow>(NEXT_SEQUENCE_SQL, [
    input.tenantId,
    input.taskId,
  ]);
  const sequence = next.rows[0]?.next_sequence;

  if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new DomainError('DB_UNAVAILABLE', 'could not allocate a safe task event sequence');
  }

  const candidate = {
    taskId: input.taskId,
    sequence,
    phase: input.phase,
    occurredAt: input.occurredAt.toISOString(),
    traceId: randomUUID(),
    payload: input.payload,
  };
  const parsed = TaskEventSchema.safeParse(candidate);

  if (!parsed.success) {
    // This is an internal programming error, not client input: fail closed with a fixed
    // public message so no payload content leaks into an error DTO.
    throw new DomainError('DB_UNAVAILABLE', 'task event failed the safe event contract');
  }

  await client.query(INSERT_EVENT_SQL, [
    randomUUID(),
    input.tenantId,
    parsed.data.taskId,
    parsed.data.sequence,
    parsed.data.phase,
    JSON.stringify(parsed.data.payload),
    parsed.data.traceId,
    input.occurredAt,
  ]);

  return parsed.data.sequence;
}
