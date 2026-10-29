import { createHash, randomUUID } from 'node:crypto';
import { IdSchema, toInvalidArgumentError } from '@ember/contracts';
import type {
  BlobStore,
  CheckpointArtifactRef,
  CommitReceipt,
  CommitStepRequest,
  CommitStepMode,
  ExternalEffectRecord,
  RunGrant,
  RunResultCommitter,
} from '@ember/contracts';
import {
  DomainError,
  InvalidArgumentError,
  normalizeWorkspaceManifest,
  type RunTerminalStatus,
  type TaskEventPayload,
  type WorkspaceManifestValue,
} from '@ember/domain';
import type pg from 'pg';
import { appendTaskEvent } from '../repositories/event-store.js';
import { asDomainError, toIsoTimestamp, withTransaction } from '../repositories/support.js';
import { parseLeaseEpoch, parsePersistedTimestamp } from '../lease-queue/validation.js';
import {
  applyFinishConvergence,
  planFinishConvergence,
  type RunRow,
  type TaskRow,
} from '../lease-queue/task-convergence.js';
import type { LeaseQueueConfig } from '../lease-queue/config.js';
import { lockBlobDigests } from './blob-store.js';
import { parseMediaType } from './local-blob-store.js';
import {
  commitWorkspaceInTransaction,
  recordWorkspaceConflict,
  WorkspaceConflictSignal,
} from './workspace-store.js';

/**
 * Fenced, atomic result commit (B06-D3).
 *
 * One `commitStep` call performs, in a single PostgreSQL transaction:
 *
 * ```text
 * Task row lock → Run row lock → clock_timestamp() → lease/cancel/deadline/epoch re-check
 *   → artifact reference publication → Workspace CAS → optional Step checkpoint
 *   → progress event OR (Task/Run convergence + one terminal event) → idempotency receipt
 * ```
 *
 * Nothing is written before every check passes, so a stale epoch, a cancelled Task, an
 * expired lease or a CAS conflict leaves zero rows behind. Physical blob staging is not part
 * of the ACID scope: bytes are verified and installed first and are never user-visible until
 * this transaction publishes their metadata.
 */

export type CommitFaultPoint =
  | 'before_artifact_insert'
  | 'before_workspace_cas'
  | 'before_checkpoint_insert'
  | 'before_event'
  | 'before_receipt'
  | 'before_commit'
  | 'after_commit';

/** TEST-ONLY injection seam for B-T26. Production passes no injector. */
export type CommitFaultInjector = (point: CommitFaultPoint) => void | Promise<void>;

export interface PostgresRunResultCommitterOptions {
  /** Retry/backoff policy used when a `result` commit terminalizes `failed_retryable`. */
  readonly policy: LeaseQueueConfig;
  readonly blobs: BlobStore;
  readonly faultInjector?: CommitFaultInjector;
}

interface GrantTaskRow extends TaskRow {
  agent_id: string;
}

interface ExistingCheckpointRow {
  id: string;
  step_sequence: number;
  executor_version: string;
  cursor: unknown;
  workspace_version: number | null;
  artifacts: unknown;
  external_effects: unknown;
}

interface ReceiptRow {
  id: string;
  run_id: string;
  attempt: number;
  lease_epoch: string;
  request_digest: string;
  receipt: unknown;
  created_at: Date | string;
}

const LOCK_TASK_SQL = `
SELECT id, tenant_id, agent_id, status, attempt_count, max_attempts,
       lease_epoch::text AS lease_epoch, current_run_id, next_run_at, lease_expires_at,
       deadline_at, cancel_requested_at
  FROM tasks
 WHERE tenant_id = $1 AND id = $2
 FOR UPDATE
`;

const LOCK_RUN_SQL = `
SELECT id, tenant_id, task_id, attempt, lease_epoch::text AS lease_epoch, status, worker_id,
       leased_until, started_at, finished_at
  FROM runs
 WHERE tenant_id = $1 AND task_id = $2 AND id = $3
 FOR UPDATE
`;

/** Authoritative post-lock instant. `now()` would be the transaction start time. */
const CLOCK_SQL = `SELECT clock_timestamp() AS now`;

const SELECT_RECEIPT_SQL = `
SELECT id, run_id, attempt, lease_epoch::text AS lease_epoch, request_digest, receipt, created_at
  FROM operation_receipts
 WHERE tenant_id = $1 AND task_id = $2 AND operation_id = $3
`;

const INSERT_RECEIPT_SQL = `
INSERT INTO operation_receipts (
  id, tenant_id, task_id, run_id, attempt, lease_epoch, operation_id, request_digest, receipt
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
`;

const INSERT_BLOB_SQL = `
INSERT INTO blobs (tenant_id, sha256, size, media_type, storage_key)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (tenant_id, sha256) DO NOTHING
`;

const SELECT_ARTIFACT_IDENTITY_SQL = `
SELECT sha256, size
  FROM artifacts
 WHERE tenant_id = $1 AND id = $2
`;

const INSERT_ARTIFACT_SQL = `
INSERT INTO artifacts (
  id, tenant_id, task_id, run_id, created_by, sha256, size, media_type, retention
)
VALUES ($1, $2, $3, $4, 'run', $5, $6, $7, $8)
`;

const SELECT_CHECKPOINT_BY_STEP_SQL = `
SELECT id, step_sequence, executor_version, cursor, workspace_version, artifacts,
       external_effects
  FROM step_checkpoints
 WHERE tenant_id = $1 AND task_id = $2 AND step_id = $3 AND input_digest = $4
`;

const NEXT_SEQUENCE_SQL = `
SELECT COALESCE(MAX(step_sequence), 0) + 1 AS next_sequence
  FROM step_checkpoints
 WHERE tenant_id = $1 AND task_id = $2
`;

const INSERT_CHECKPOINT_SQL = `
INSERT INTO step_checkpoints (
  id, tenant_id, task_id, run_id, attempt, lease_epoch, schema_version, step_id, step_sequence,
  input_digest, executor_version, cursor, workspace_version, artifacts, external_effects
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb, $15::jsonb)
`;

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXECUTOR_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ARTIFACTS_PER_COMMIT = 16;

/** P0B-06 checkpoint schema version; a reader must match it to resume. */
export const CHECKPOINT_SCHEMA_VERSION = 1;

interface NormalizedArtifact {
  readonly artifactId: string;
  readonly staged: {
    readonly stagedId: string;
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly storageKey: string;
  };
  readonly retention: 'task' | 'user';
  readonly storageKey: string;
}

interface NormalizedRequest {
  readonly operationId: string;
  readonly mode: CommitStepMode;
  readonly artifacts: readonly NormalizedArtifact[];
  readonly workspace: {
    readonly expectedVersion: number;
    readonly manifest: WorkspaceManifestValue;
  } | null;
  readonly checkpoint: {
    readonly stepId: string;
    readonly stepSequence: number | null;
    readonly inputDigest: string;
    readonly executorVersion: string;
    readonly cursor: Readonly<Record<string, string | number | boolean>>;
    readonly workspaceVersion: number | null;
    readonly artifacts: readonly CheckpointArtifactRef[];
    readonly externalEffects: readonly ExternalEffectRecord[];
  } | null;
  readonly requestDigest: string;
}

function invalid(field: string, code: string): never {
  throw new InvalidArgumentError([{ path: field, code }]);
}

function parseGrant(grant: RunGrant): RunGrant {
  const tenant = IdSchema.safeParse(grant.tenantId);
  const task = IdSchema.safeParse(grant.taskId);
  const run = IdSchema.safeParse(grant.runId);
  const agent = IdSchema.safeParse(grant.agentId);

  if (!tenant.success) {
    throw toInvalidArgumentError(tenant.error);
  }
  if (!task.success) {
    throw toInvalidArgumentError(task.error);
  }
  if (!run.success) {
    throw toInvalidArgumentError(run.error);
  }
  if (!agent.success) {
    throw toInvalidArgumentError(agent.error);
  }

  if (!Number.isSafeInteger(grant.attempt) || grant.attempt < 1) {
    invalid('grant.attempt', 'invalid_attempt');
  }

  if (!Number.isSafeInteger(grant.leaseEpoch) || grant.leaseEpoch < 0) {
    invalid('grant.leaseEpoch', 'invalid_epoch');
  }

  if (
    grant.workerId !== null &&
    (typeof grant.workerId !== 'string' || !WORKER_ID_PATTERN.test(grant.workerId))
  ) {
    invalid('grant.workerId', 'invalid_worker');
  }

  return grant;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);

    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value ?? null);
}

function digestOf(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function normalizeRequest(request: CommitStepRequest): NormalizedRequest {
  if (typeof request !== 'object' || request === null) {
    invalid('request', 'not_an_object');
  }

  if (typeof request.operationId !== 'string' || !OPERATION_ID_PATTERN.test(request.operationId)) {
    invalid('operationId', 'invalid_operation_id');
  }

  if (request.mode !== 'progress' && request.mode !== 'result') {
    invalid('mode', 'invalid_mode');
  }

  const artifacts = (request.artifacts ?? []).map((entry, index): NormalizedArtifact => {
    const id = IdSchema.safeParse(entry.artifactId);

    if (!id.success) {
      invalid(`artifacts[${index}].artifactId`, 'invalid_id');
    }

    const staged = entry.staged;

    if (typeof staged !== 'object' || staged === null) {
      invalid(`artifacts[${index}].staged`, 'not_an_object');
    }

    if (typeof staged.sha256 !== 'string' || !SHA256_PATTERN.test(staged.sha256)) {
      invalid(`artifacts[${index}].sha256`, 'invalid_digest');
    }

    if (!Number.isSafeInteger(staged.size) || staged.size < 0) {
      invalid(`artifacts[${index}].size`, 'invalid_size');
    }

    parseMediaType(staged.mediaType);

    if (typeof staged.storageKey !== 'string' || !staged.storageKey.startsWith('staging/')) {
      invalid(`artifacts[${index}].storageKey`, 'invalid_storage_key');
    }

    if (typeof staged.stagedId !== 'string') {
      invalid(`artifacts[${index}].stagedId`, 'invalid_id');
    }

    return Object.freeze({
      artifactId: id.data,
      staged: Object.freeze({
        stagedId: staged.stagedId,
        sha256: staged.sha256,
        size: staged.size,
        mediaType: staged.mediaType,
        storageKey: staged.storageKey,
      }),
      retention: entry.retention === 'user' ? ('user' as const) : ('task' as const),
      storageKey: staged.storageKey,
    });
  });

  if (artifacts.length > MAX_ARTIFACTS_PER_COMMIT) {
    invalid('artifacts', 'too_many_entries');
  }

  if (new Set(artifacts.map((entry) => entry.artifactId)).size !== artifacts.length) {
    invalid('artifacts', 'duplicate_artifact_id');
  }

  const workspace =
    request.workspace === undefined
      ? null
      : Object.freeze({
          expectedVersion: parseVersion(request.workspace.expectedVersion),
          manifest: normalizeWorkspaceManifest(request.workspace.manifest),
        });

  const checkpoint =
    request.checkpoint === undefined ? null : normalizeCheckpoint(request.checkpoint);

  const digestSource = {
    operationId: request.operationId,
    mode: request.mode,
    artifacts: artifacts.map((entry) => ({
      artifactId: entry.artifactId,
      sha256: entry.staged.sha256,
      size: entry.staged.size,
      mediaType: entry.staged.mediaType,
      retention: entry.retention,
    })),
    workspace:
      workspace === null
        ? null
        : { expectedVersion: workspace.expectedVersion, manifest: workspace.manifest },
    checkpoint:
      checkpoint === null
        ? null
        : {
            stepId: checkpoint.stepId,
            stepSequence: checkpoint.stepSequence,
            inputDigest: checkpoint.inputDigest,
            executorVersion: checkpoint.executorVersion,
            cursor: checkpoint.cursor,
            workspaceVersion: checkpoint.workspaceVersion,
            artifacts: checkpoint.artifacts,
            externalEffects: checkpoint.externalEffects,
          },
  };

  return Object.freeze({
    operationId: request.operationId,
    mode: request.mode,
    artifacts: Object.freeze(artifacts),
    workspace,
    checkpoint,
    requestDigest: digestOf(digestSource),
  });
}

function parseVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid('expectedVersion', 'invalid_version');
  }

  return value;
}

function normalizeCheckpoint(
  checkpoint: NonNullable<CommitStepRequest['checkpoint']>,
): NormalizedRequest['checkpoint'] {
  if (typeof checkpoint.stepId !== 'string' || !STEP_ID_PATTERN.test(checkpoint.stepId)) {
    invalid('checkpoint.stepId', 'invalid_step_id');
  }

  if (typeof checkpoint.inputDigest !== 'string' || !SHA256_PATTERN.test(checkpoint.inputDigest)) {
    invalid('checkpoint.inputDigest', 'invalid_digest');
  }

  if (
    typeof checkpoint.executorVersion !== 'string' ||
    !EXECUTOR_VERSION_PATTERN.test(checkpoint.executorVersion)
  ) {
    invalid('checkpoint.executorVersion', 'invalid_version');
  }

  const stepSequence =
    checkpoint.stepSequence === undefined ? null : parseVersion(checkpoint.stepSequence);

  if (stepSequence !== null && stepSequence < 1) {
    invalid('checkpoint.stepSequence', 'invalid_sequence');
  }

  const cursor: Record<string, string | number | boolean> = {};

  for (const [key, entry] of Object.entries(checkpoint.cursor ?? {})) {
    if (typeof entry === 'string' || typeof entry === 'boolean') {
      cursor[key] = entry;
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      cursor[key] = entry;
    } else {
      invalid(`checkpoint.cursor.${key}`, 'unsupported_cursor_value');
    }
  }

  // A checkpoint may reference artifacts committed by this call *or* by an earlier step of
  // the same Task (resume). The transaction verifies tenant ownership and digest/size before
  // inserting, so a reference can never point at foreign or unverified bytes.
  const referenced = checkpoint.artifacts ?? [];
  const ids = new Set<string>();

  for (const entry of referenced) {
    if (ids.has(entry.artifactId)) {
      invalid('checkpoint.artifacts', 'duplicate_artifact_id');
    }

    ids.add(entry.artifactId);
  }

  return Object.freeze({
    stepId: checkpoint.stepId,
    stepSequence,
    inputDigest: checkpoint.inputDigest,
    executorVersion: checkpoint.executorVersion,
    cursor: Object.freeze(cursor),
    workspaceVersion: checkpoint.workspaceVersion ?? null,
    artifacts: Object.freeze([...referenced]),
    externalEffects: Object.freeze([...(checkpoint.externalEffects ?? [])]),
  });
}

function toReceipt(input: {
  readonly operationId: string;
  readonly mode: CommitStepMode;
  readonly taskId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly artifactIds: readonly string[];
  readonly workspaceVersion: number | null;
  readonly checkpointId: string | null;
  readonly committedAt: string;
  readonly replayed: boolean;
}): CommitReceipt {
  return Object.freeze({ ...input, artifactIds: Object.freeze([...input.artifactIds]) });
}

function replayFromRow(row: ReceiptRow, grant: RunGrant): CommitReceipt | null {
  if (row.run_id !== grant.runId || Number(row.lease_epoch) !== grant.leaseEpoch) {
    // A different Run/epoch may not read this result: it is not this attempt's outcome.
    return null;
  }

  const receipt = row.receipt as Record<string, unknown> | null;

  if (receipt === null || typeof receipt !== 'object') {
    throw new DomainError('DB_UNAVAILABLE', 'persisted receipt is not readable');
  }

  return toReceipt({
    operationId: typeof receipt['operationId'] === 'string' ? receipt['operationId'] : '',
    mode: receipt['mode'] === 'result' ? 'result' : 'progress',
    taskId: typeof receipt['taskId'] === 'string' ? receipt['taskId'] : grant.taskId,
    runId: row.run_id,
    attempt: row.attempt,
    leaseEpoch: Number(row.lease_epoch),
    artifactIds: Array.isArray(receipt['artifactIds'])
      ? (receipt['artifactIds'] as unknown[]).filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
    workspaceVersion:
      typeof receipt['workspaceVersion'] === 'number' ? receipt['workspaceVersion'] : null,
    checkpointId: typeof receipt['checkpointId'] === 'string' ? receipt['checkpointId'] : null,
    committedAt:
      typeof receipt['committedAt'] === 'string'
        ? receipt['committedAt']
        : toIsoTimestamp(row.created_at),
    replayed: true,
  });
}

/**
 * PostgreSQL implementation of the atomic result commit.
 *
 * The injected `BlobStore` is used only for physical byte verification/installation; every
 * durable fact is written by the transaction below.
 */
export class PostgresRunResultCommitter implements RunResultCommitter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PostgresRunResultCommitterOptions,
  ) {}

  async commitStep(grant: RunGrant, request: CommitStepRequest): Promise<CommitReceipt> {
    const scoped = parseGrant(grant);
    const normalized = normalizeRequest(request);

    // Read-only replay path: an already committed operation is answered from its receipt and
    // never re-enters the write path, even if the original lease has since expired.
    const existing = await this.readReceipt(this.pool, scoped, normalized.operationId);

    if (existing !== null) {
      return this.replay(existing, scoped, normalized);
    }

    // Physical bytes first. They stay invisible (no artifact row) until the transaction
    // commits, and an install failure aborts before any database work.
    const installed = await this.installArtifacts(scoped, normalized);

    try {
      const receipt = await withTransaction(this.pool, async (client) => {
        const task = await this.lockTask(client, scoped);
        const run = await this.lockRun(client, scoped);

        // Re-check under the Task row lock: this is what makes N concurrent commits of the
        // same operation id resolve to exactly one write plus N-1 read-only replays.
        const raced = await this.readReceipt(client, scoped, normalized.operationId);

        if (raced !== null) {
          return this.replay(raced, scoped, normalized);
        }

        const now = await this.postLockInstant(client);

        assertLive({ grant: scoped, task, run, now });

        // Coordinate with blob GC: the collector takes the same tenant-digest advisory lock
        // before deleting bytes, so a publish can never lose a file it has just installed.
        await lockBlobDigests(
          client,
          scoped.tenantId,
          installed.map((entry) => entry.staged.sha256),
        );

        // The SQL lock orders this publish against the collector's delete, but `install` runs
        // before this transaction and shortcuts when the digest file already exists, so an old
        // orphan could have been swept in between. Re-establishing presence under the lock
        // makes the two outcomes exclusive: either the bytes are still here and this publish
        // commits, or they are gone and nothing is written.
        await this.assertInstalledBytes(scoped, installed);

        await this.fault('before_artifact_insert');
        await this.writeArtifacts(client, scoped, installed);

        await this.fault('before_workspace_cas');
        const workspace =
          normalized.workspace === null
            ? null
            : await commitWorkspaceInTransaction(client, {
                tenantId: scoped.tenantId,
                agentId: scoped.agentId,
                expectedVersion: normalized.workspace.expectedVersion,
                manifest: normalized.workspace.manifest,
                createdByRunId: scoped.runId,
                leaseEpoch: scoped.leaseEpoch,
              });

        await this.fault('before_checkpoint_insert');
        const checkpointId =
          normalized.checkpoint === null
            ? null
            : await this.writeCheckpoint(client, scoped, normalized, workspace?.version ?? null);

        await this.fault('before_event');
        const artifactIds = installed.map((entry) => entry.artifactId);
        const payloadExtra: TaskEventPayload = {
          ...(artifactIds[0] === undefined ? {} : { artifactId: artifactIds[0] }),
          ...(workspace === null ? {} : { workspaceVersion: workspace.version }),
        };

        if (normalized.mode === 'progress') {
          // A progress step is not terminal: no Task/Run convergence and no terminal event.
          await appendTaskEvent(client, {
            tenantId: scoped.tenantId,
            taskId: scoped.taskId,
            phase: 'progress',
            occurredAt: now,
            payload: { runId: scoped.runId, attempt: task.attempt_count, ...payloadExtra },
          });
        } else {
          const convergence = planFinishConvergence({
            outcome: 'succeeded',
            task,
            runRow: run,
            finishedAt: now,
            deadlineAt: parsePersistedTimestamp(task.deadline_at),
            cancelRequested: false,
            policy: this.options.policy,
          });

          await applyFinishConvergence(client, {
            task,
            runRow: run,
            convergence,
            finishedAt: now,
            payloadExtra,
          });
        }

        await this.fault('before_receipt');

        const receipt = toReceipt({
          operationId: normalized.operationId,
          mode: normalized.mode,
          taskId: scoped.taskId,
          runId: scoped.runId,
          attempt: scoped.attempt,
          leaseEpoch: scoped.leaseEpoch,
          artifactIds,
          workspaceVersion: workspace?.version ?? null,
          checkpointId,
          committedAt: now.toISOString(),
          replayed: false,
        });

        await client.query(INSERT_RECEIPT_SQL, [
          randomUUID(),
          scoped.tenantId,
          scoped.taskId,
          scoped.runId,
          scoped.attempt,
          scoped.leaseEpoch,
          normalized.operationId,
          normalized.requestDigest,
          JSON.stringify(receipt),
        ]);

        await this.fault('before_commit');

        return receipt;
      });

      // A lost ACK is simulated by throwing *after* the database commit succeeded. The next
      // call must find the receipt and answer read-only instead of writing again.
      await this.fault('after_commit');

      return receipt;
    } catch (error) {
      if (error instanceof WorkspaceConflictSignal) {
        // Conflict candidates are preserved by a separate idempotent transaction; the result
        // commit itself is rolled back in full and no Task state is reported as completed.
        // If the candidate cannot be preserved, the caller must not be told "conflict" as if
        // the decision were safely recorded: the storage failure is the honest answer.
        await recordWorkspaceConflict(this.pool, scoped.tenantId, error, {
          taskId: scoped.taskId,
          runId: scoped.runId,
          leaseEpoch: scoped.leaseEpoch,
        });
      }

      throw asDomainError(error);
    }
  }

  async findReceipt(grant: RunGrant, operationId: string): Promise<CommitReceipt | null> {
    const scoped = parseGrant(grant);
    const row = await this.readReceipt(this.pool, scoped, operationId);

    return row === null ? null : replayFromRow(row, scoped);
  }

  // ---------------------------------------------------------------- internals

  private async fault(point: CommitFaultPoint): Promise<void> {
    await this.options.faultInjector?.(point);
  }

  private replay(row: ReceiptRow, grant: RunGrant, request: NormalizedRequest): CommitReceipt {
    if (row.request_digest !== request.requestDigest) {
      // Same operation id, different normalised content: never silently accept either side.
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'operation id was already used with different content',
      );
    }

    const receipt = replayFromRow(row, grant);

    if (receipt === null) {
      throw new DomainError('STALE_LEASE', 'receipt belongs to a different Run or lease epoch');
    }

    return receipt;
  }

  private async readReceipt(
    runner: pg.Pool | pg.PoolClient,
    grant: RunGrant,
    operationId: string,
  ): Promise<ReceiptRow | null> {
    const result = await runner.query<ReceiptRow>(SELECT_RECEIPT_SQL, [
      grant.tenantId,
      grant.taskId,
      operationId,
    ]);

    return result.rows[0] ?? null;
  }

  private async installArtifacts(
    grant: RunGrant,
    request: NormalizedRequest,
  ): Promise<readonly NormalizedArtifact[]> {
    const installed: NormalizedArtifact[] = [];

    for (const artifact of request.artifacts) {
      const blob = await this.options.blobs.install(grant.tenantId, artifact.staged);

      if (blob.sha256 !== artifact.staged.sha256 || blob.size !== artifact.staged.size) {
        throw new DomainError('DB_UNAVAILABLE', 'installed blob differs from the staged digest');
      }

      installed.push(
        Object.freeze({
          artifactId: artifact.artifactId,
          staged: artifact.staged,
          retention: artifact.retention,
          storageKey: blob.storageKey,
        }),
      );
    }

    return Object.freeze(installed);
  }

  private async lockTask(client: pg.PoolClient, grant: RunGrant): Promise<GrantTaskRow> {
    const result = await client.query<GrantTaskRow>(LOCK_TASK_SQL, [grant.tenantId, grant.taskId]);
    const task = result.rows[0];

    if (task === undefined) {
      throw new DomainError('STALE_LEASE', 'task is not owned by this run');
    }

    return task;
  }

  private async lockRun(client: pg.PoolClient, grant: RunGrant): Promise<RunRow> {
    const result = await client.query<RunRow>(LOCK_RUN_SQL, [
      grant.tenantId,
      grant.taskId,
      grant.runId,
    ]);
    const run = result.rows[0];

    if (run === undefined) {
      throw new DomainError('STALE_LEASE', 'run is not owned by this lease');
    }

    return run;
  }

  private async postLockInstant(client: pg.PoolClient): Promise<Date> {
    const result = await client.query<{ now: Date | string }>(CLOCK_SQL);
    const now = parsePersistedTimestamp(result.rows[0]?.now ?? null);

    if (now === null) {
      throw new DomainError('DB_UNAVAILABLE', 'database did not report a post-lock clock');
    }

    return now;
  }
  /**
   * Prove, under the tenant-digest lock, that the bytes this commit is about to reference are
   * still installed.
   *
   * A missing file aborts with zero writes, so no artifact/checkpoint row can ever point at
   * bytes the collector removed. `install` verified content, so presence plus size is enough
   * here and no second full hash is paid while holding row locks.
   */
  private async assertInstalledBytes(
    grant: RunGrant,
    artifacts: readonly NormalizedArtifact[],
  ): Promise<void> {
    for (const artifact of artifacts) {
      const present = await this.options.blobs.assertInstalled(
        grant.tenantId,
        artifact.staged.sha256,
        artifact.staged.size,
      );

      if (!present) {
        throw new DomainError('DB_UNAVAILABLE', 'installed bytes disappeared before publication');
      }
    }
  }

  private async writeArtifacts(
    client: pg.PoolClient,
    grant: RunGrant,
    artifacts: readonly NormalizedArtifact[],
  ): Promise<void> {
    for (const artifact of artifacts) {
      await client.query(INSERT_BLOB_SQL, [
        grant.tenantId,
        artifact.staged.sha256,
        artifact.staged.size,
        artifact.staged.mediaType,
        artifact.storageKey,
      ]);

      const existing = await client.query<{ sha256: string; size: string | number }>(
        SELECT_ARTIFACT_IDENTITY_SQL,
        [grant.tenantId, artifact.artifactId],
      );
      const row = existing.rows[0];

      if (row !== undefined) {
        // Re-publishing the same artifact id with identical content is idempotent; different
        // bytes under the same id is a conflicting command.
        if (row.sha256 === artifact.staged.sha256 && Number(row.size) === artifact.staged.size) {
          continue;
        }

        throw new DomainError('IDEMPOTENCY_CONFLICT', 'artifact id is already published');
      }

      // A unique violation aborts the surrounding transaction, so the insert is guarded by a
      // savepoint: a concurrent identical publish can then be reconciled instead of forcing
      // the entire result commit to fail.
      await client.query('SAVEPOINT ember_artifact_insert');

      try {
        await client.query(INSERT_ARTIFACT_SQL, [
          artifact.artifactId,
          grant.tenantId,
          grant.taskId,
          grant.runId,
          artifact.staged.sha256,
          artifact.staged.size,
          artifact.staged.mediaType,
          artifact.retention,
        ]);
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT ember_artifact_insert').catch(() => undefined);

        if ((error as { code?: string }).code === '23505') {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'artifact id is already published');
        }

        throw error;
      } finally {
        await client.query('RELEASE SAVEPOINT ember_artifact_insert').catch(() => undefined);
      }
    }
  }

  private async writeCheckpoint(
    client: pg.PoolClient,
    grant: RunGrant,
    request: NormalizedRequest,
    committedWorkspaceVersion: number | null,
  ): Promise<string> {
    const checkpoint = request.checkpoint;

    if (checkpoint === null) {
      throw new DomainError('DB_UNAVAILABLE', 'checkpoint request was not normalised');
    }

    // A step is identified by (stepId, inputDigest): replaying the same deterministic step
    // returns the already committed id instead of writing a second checkpoint.
    const existing = await client.query<ExistingCheckpointRow>(SELECT_CHECKPOINT_BY_STEP_SQL, [
      grant.tenantId,
      grant.taskId,
      checkpoint.stepId,
      checkpoint.inputDigest,
    ]);
    const existingRow = existing.rows[0];

    if (existingRow !== undefined) {
      // A stable step identity is only reusable when the *whole* committed result matches.
      // Same id + same input digest but different artifacts, cursor, workspace dependency or
      // side-effect record means the caller is trying to rewrite history under one name.
      if (!sameCheckpointSemantics(existingRow, checkpoint, committedWorkspaceVersion)) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'step identity was already committed with a different result',
        );
      }

      return existingRow.id;
    }

    let sequence = checkpoint.stepSequence;

    if (sequence === null) {
      const next = await client.query<{ next_sequence: number }>(NEXT_SEQUENCE_SQL, [
        grant.tenantId,
        grant.taskId,
      ]);
      const candidate = next.rows[0]?.next_sequence;

      if (candidate === undefined || !Number.isSafeInteger(candidate) || candidate < 1) {
        throw new DomainError('DB_UNAVAILABLE', 'could not allocate a checkpoint sequence');
      }

      sequence = candidate;
    }

    for (const referenced of checkpoint.artifacts) {
      const known = await client.query<{ sha256: string; size: string | number }>(
        SELECT_ARTIFACT_IDENTITY_SQL,
        [grant.tenantId, referenced.artifactId],
      );
      const row = known.rows[0];

      if (row === undefined) {
        throw new DomainError(
          'POLICY_DENIED',
          'checkpoint references an artifact outside this tenant',
        );
      }

      if (row.sha256 !== referenced.sha256 || Number(row.size) !== referenced.size) {
        throw new InvalidArgumentError([
          { path: `checkpoint.artifacts[${referenced.artifactId}]`, code: 'artifact_mismatch' },
        ]);
      }
    }

    const checkpointId = randomUUID();

    await client.query(INSERT_CHECKPOINT_SQL, [
      checkpointId,
      grant.tenantId,
      grant.taskId,
      grant.runId,
      grant.attempt,
      grant.leaseEpoch,
      CHECKPOINT_SCHEMA_VERSION,
      checkpoint.stepId,
      sequence,
      checkpoint.inputDigest,
      checkpoint.executorVersion,
      JSON.stringify(checkpoint.cursor),
      checkpoint.workspaceVersion ?? committedWorkspaceVersion,
      JSON.stringify(checkpoint.artifacts),
      JSON.stringify(checkpoint.externalEffects),
    ]);

    return checkpointId;
  }
}

/**
 * Fencing and liveness re-validation, executed after both row locks and the post-lock clock.
 *
 * Order matters for diagnosis: Run/epoch ownership first, then cancellation (ADR-0001 wins
 * over a submitted result), then lease expiry, then the Task deadline.
 */
export function assertLive(input: {
  readonly grant: RunGrant;
  readonly task: GrantTaskRow;
  readonly run: RunRow;
  readonly now: Date;
}): void {
  const { grant, task, run, now } = input;

  if (task.status !== 'running' || task.current_run_id !== grant.runId) {
    throw new DomainError('STALE_LEASE', 'task is not owned by this run');
  }

  // The Agent decides which Workspace the result lands in, so a grant for another Agent in
  // the same tenant must never be able to write. This is a server-derived equality check, not
  // a client-supplied field.
  if (task.agent_id !== grant.agentId) {
    throw new DomainError('STALE_LEASE', 'grant agent does not own this task');
  }

  // Worker ownership: the grant must name the worker recorded on the Run itself.
  if (grant.workerId !== run.worker_id) {
    throw new DomainError('STALE_LEASE', 'grant worker does not own this run');
  }

  if (parseLeaseEpoch(task.lease_epoch) !== grant.leaseEpoch) {
    throw new DomainError('STALE_LEASE', 'task lease epoch no longer matches the grant');
  }

  if (run.status !== 'running') {
    throw new DomainError('STALE_LEASE', 'run is no longer running');
  }

  if (
    parseLeaseEpoch(run.lease_epoch) !== grant.leaseEpoch ||
    run.attempt !== grant.attempt ||
    task.attempt_count !== grant.attempt
  ) {
    throw new DomainError('STALE_LEASE', 'run attempt or epoch no longer matches the grant');
  }

  if (task.cancel_requested_at !== null) {
    // Cancellation wins; nothing is written and the Reaper converges the Task.
    throw new DomainError('CANCELLED', 'task cancellation was requested before the commit');
  }

  const taskExpiry = parsePersistedTimestamp(task.lease_expires_at);
  const runExpiry = parsePersistedTimestamp(run.leased_until);

  if (taskExpiry === null || runExpiry === null) {
    throw new DomainError('STALE_LEASE', 'lease has no persisted expiry');
  }

  if (taskExpiry.getTime() <= now.getTime() || runExpiry.getTime() <= now.getTime()) {
    throw new DomainError('STALE_LEASE', 'lease expired before the commit');
  }

  const deadlineAt = parsePersistedTimestamp(task.deadline_at);

  if (deadlineAt !== null && deadlineAt.getTime() <= now.getTime()) {
    throw new DomainError('DEADLINE_EXCEEDED', 'task deadline elapsed before the commit');
  }
}

export type { RunTerminalStatus };

/**
 * Canonical comparison of a stored checkpoint with the request that wants to reuse its id.
 *
 * Ordering is normalised so a caller that lists artifacts or effects in another order is not
 * rejected for a cosmetic difference, while any real divergence is.
 *
 * `stepSequence` is allocated by the transaction when the request omits it, so an omitted
 * value asserts nothing and always matches. A caller that names a sequence is asserting the
 * step's position in the committed history, and a different position must be refused instead
 * of silently returning a checkpoint from elsewhere in that history.
 */
function sameCheckpointSemantics(
  row: ExistingCheckpointRow,
  checkpoint: NonNullable<NormalizedRequest['checkpoint']>,
  committedWorkspaceVersion: number | null,
): boolean {
  const stored = {
    stepSequence: row.step_sequence,
    executorVersion: row.executor_version,
    cursor: stableJson(toCursorValue(row.cursor)),
    workspaceVersion: row.workspace_version ?? committedWorkspaceVersion,
    artifacts: canonicalArtifactsRow(row.artifacts),
    externalEffects: canonicalEffectsRow(row.external_effects),
  };
  const requested = {
    stepSequence: checkpoint.stepSequence ?? row.step_sequence,
    executorVersion: checkpoint.executorVersion,
    cursor: stableJson(checkpoint.cursor),
    workspaceVersion: checkpoint.workspaceVersion ?? committedWorkspaceVersion,
    artifacts: canonicalCheckpointArtifacts(checkpoint.artifacts),
    externalEffects: canonicalCheckpointEffects(checkpoint.externalEffects),
  };

  return stableJson(stored) === stableJson(requested);
}

function toCursorValue(value: unknown): Record<string, string | number | boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const cursor: Record<string, string | number | boolean> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'boolean') {
      cursor[key] = entry;
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      cursor[key] = entry;
    }
  }

  return cursor;
}

function canonicalCheckpointArtifacts(
  artifacts: readonly CheckpointArtifactRef[],
): readonly string[] {
  return [...artifacts]
    .map((entry) =>
      stableJson({
        artifactId: entry.artifactId,
        sha256: entry.sha256,
        size: entry.size,
        mediaType: entry.mediaType,
        path: entry.path ?? null,
      }),
    )
    .sort();
}

function canonicalCheckpointEffects(effects: readonly ExternalEffectRecord[]): readonly string[] {
  return [...effects]
    .map((entry) =>
      stableJson({
        key: entry.key,
        status: entry.status,
        receiptDigest: entry.receiptDigest ?? null,
      }),
    )
    .sort();
}

function canonicalArtifactsRow(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) =>
      stableJson({
        artifactId: entry['artifactId'] ?? null,
        sha256: entry['sha256'] ?? null,
        size: entry['size'] ?? null,
        mediaType: entry['mediaType'] ?? null,
        path: entry['path'] ?? null,
      }),
    )
    .sort();
}

function canonicalEffectsRow(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) =>
      stableJson({
        key: entry['key'] ?? null,
        status: entry['status'] ?? null,
        receiptDigest: entry['receiptDigest'] ?? null,
      }),
    )
    .sort();
}
