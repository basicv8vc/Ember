import { IdSchema, toInvalidArgumentError } from '@ember/contracts';
import type {
  CheckpointArtifactRef,
  CheckpointLookupOptions,
  CheckpointStore,
  CommittedCheckpoint,
  ExternalEffectRecord,
  RunGrant,
} from '@ember/contracts';
import type { Id } from '@ember/domain';
import type pg from 'pg';
import { asDomainError, toIsoTimestamp } from '../repositories/support.js';

/**
 * Read-only checkpoint recovery input (B06-D4).
 *
 * Only committed rows are visible here: a step whose transaction rolled back has no row at
 * all, so it can never be mistaken for completed work. The store never performs a write; a
 * new Run publishes checkpoints through `RunResultCommitter` with its own fenced authority.
 */

interface CheckpointRow {
  id: string;
  tenant_id: string;
  task_id: string;
  run_id: string;
  attempt: number;
  lease_epoch: string;
  schema_version: number;
  step_id: string;
  step_sequence: number;
  input_digest: string;
  executor_version: string;
  cursor: unknown;
  workspace_version: number | null;
  artifacts: unknown;
  external_effects: unknown;
  created_at: Date | string;
}

const SELECT_COLUMNS = `
  id, tenant_id, task_id, run_id, attempt, lease_epoch::text AS lease_epoch, schema_version,
  step_id, step_sequence, input_digest, executor_version, cursor, workspace_version, artifacts,
  external_effects, created_at
`;

const SELECT_LATEST_SQL = `
SELECT ${SELECT_COLUMNS}
  FROM step_checkpoints
 WHERE tenant_id = $1 AND task_id = $2
   AND ($3::integer IS NULL OR schema_version = $3)
   AND ($4::text IS NULL OR executor_version = $4)
 ORDER BY step_sequence DESC, created_at DESC, id DESC
 LIMIT 1
`;

const SELECT_LIST_SQL = `
SELECT ${SELECT_COLUMNS}
  FROM step_checkpoints
 WHERE tenant_id = $1 AND task_id = $2
   AND ($3::integer IS NULL OR schema_version = $3)
   AND ($4::text IS NULL OR executor_version = $4)
 ORDER BY step_sequence DESC, created_at DESC, id DESC
 LIMIT $5
`;

const SELECT_ONE_SQL = `
SELECT ${SELECT_COLUMNS}
  FROM step_checkpoints
 WHERE tenant_id = $1 AND task_id = $2 AND id = $3
`;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function toCursor(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Object.freeze({});
  }

  const cursor: Record<string, string | number | boolean> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'boolean') {
      cursor[key] = entry;
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      cursor[key] = entry;
    }
  }

  return Object.freeze(cursor);
}

function toArtifacts(value: unknown): readonly CheckpointArtifactRef[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }

  const artifacts: CheckpointArtifactRef[] = [];

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;

    if (
      typeof record['artifactId'] !== 'string' ||
      typeof record['sha256'] !== 'string' ||
      typeof record['size'] !== 'number' ||
      typeof record['mediaType'] !== 'string'
    ) {
      continue;
    }

    artifacts.push(
      Object.freeze({
        artifactId: record['artifactId'],
        sha256: record['sha256'],
        size: record['size'],
        mediaType: record['mediaType'],
        ...(typeof record['path'] === 'string' ? { path: record['path'] } : {}),
      }),
    );
  }

  return Object.freeze(artifacts);
}

function toEffects(value: unknown): readonly ExternalEffectRecord[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }

  const effects: ExternalEffectRecord[] = [];

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const status = record['status'];

    if (
      typeof record['key'] !== 'string' ||
      (status !== 'verified' && status !== 'unknown' && status !== 'not_applicable')
    ) {
      continue;
    }

    effects.push(
      Object.freeze({
        key: record['key'],
        status,
        ...(typeof record['receiptDigest'] === 'string'
          ? { receiptDigest: record['receiptDigest'] }
          : {}),
      }),
    );
  }

  return Object.freeze(effects);
}

function toCheckpoint(row: CheckpointRow): CommittedCheckpoint {
  return Object.freeze({
    checkpointId: row.id,
    schemaVersion: row.schema_version,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    runId: row.run_id,
    attempt: row.attempt,
    leaseEpoch: Number(row.lease_epoch),
    stepId: row.step_id,
    stepSequence: row.step_sequence,
    inputDigest: row.input_digest,
    executorVersion: row.executor_version,
    cursor: toCursor(row.cursor),
    workspaceVersion: row.workspace_version,
    artifacts: toArtifacts(row.artifacts),
    externalEffects: toEffects(row.external_effects),
    createdAt: toIsoTimestamp(row.created_at),
  });
}

function parseGrant(grant: RunGrant): RunGrant {
  const tenant = IdSchema.safeParse(grant.tenantId);
  const task = IdSchema.safeParse(grant.taskId);

  if (!tenant.success) {
    throw toInvalidArgumentError(tenant.error);
  }

  if (!task.success) {
    throw toInvalidArgumentError(task.error);
  }

  return grant;
}

export class PostgresCheckpointStore implements CheckpointStore {
  constructor(private readonly pool: pg.Pool) {}

  async loadLatest(
    grant: RunGrant,
    options: CheckpointLookupOptions = {},
  ): Promise<CommittedCheckpoint | null> {
    const context = parseGrant(grant);

    try {
      const result = await this.pool.query<CheckpointRow>(SELECT_LATEST_SQL, [
        context.tenantId,
        context.taskId,
        options.schemaVersion ?? null,
        options.executorVersion ?? null,
      ]);
      const row = result.rows[0];

      return row === undefined ? null : toCheckpoint(row);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async list(
    grant: RunGrant,
    options: CheckpointLookupOptions = {},
  ): Promise<readonly CommittedCheckpoint[]> {
    const context = parseGrant(grant);

    try {
      const result = await this.pool.query<CheckpointRow>(SELECT_LIST_SQL, [
        context.tenantId,
        context.taskId,
        options.schemaVersion ?? null,
        options.executorVersion ?? null,
        DEFAULT_LIST_LIMIT,
      ]);

      return Object.freeze(result.rows.map(toCheckpoint));
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async get(grant: RunGrant, checkpointId: Id): Promise<CommittedCheckpoint | null> {
    const context = parseGrant(grant);
    const id = IdSchema.safeParse(checkpointId);

    if (!id.success) {
      throw toInvalidArgumentError(id.error);
    }

    try {
      const result = await this.pool.query<CheckpointRow>(SELECT_ONE_SQL, [
        context.tenantId,
        context.taskId,
        id.data,
      ]);
      const row = result.rows[0];

      return row === undefined ? null : toCheckpoint(row);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /** Bounded recovery cursor: the highest committed step sequence for the Task. */
  async latestSequence(grant: RunGrant): Promise<number> {
    const checkpoint = await this.loadLatest(grant);

    return checkpoint?.stepSequence ?? 0;
  }

  get maxListLimit(): number {
    return MAX_LIST_LIMIT;
  }
}
