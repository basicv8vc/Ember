import { createHash, randomUUID } from 'node:crypto';
import { AuthContextSchema, IdSchema, WORKSPACE_MANIFEST_MAX_BYTES } from '@ember/contracts';
import type {
  WorkspaceConflictView,
  WorkspaceSnapshot,
  WorkspaceStore,
  WorkspaceVersionInfo,
} from '@ember/contracts';
import {
  DomainError,
  InvalidArgumentError,
  canonicalWorkspaceManifest,
  mergeWorkspaceManifests,
  normalizeWorkspaceManifest,
  type AuthContext,
  type Id,
  type WorkspaceManifestValue,
} from '@ember/domain';
import { toInvalidArgumentError } from '@ember/contracts';
import type pg from 'pg';
import { asDomainError, toIsoTimestamp, withTransaction } from '../repositories/support.js';
import {
  assertArtifactReferences,
  lockArtifactReferences,
  lockArtifactRows,
  lockConflictCandidateArtifacts,
} from './artifact-references.js';

export { assertArtifactReferences };

/**
 * PostgreSQL Workspace store: immutable version history plus real CAS (B06-D2).
 *
 * `workspaces.version` is the single source of truth for the current version and is only
 * advanced by a conditional update performed while the workspace row is locked. Every
 * committed version also writes an immutable `workspace_versions` row with its parent, so a
 * later writer can prove which base it branched from.
 *
 * Auto-merge is deliberately narrow (see `mergeWorkspaceManifests`): same base, disjoint
 * changed paths, additive/content-only changes. Everything else records a pending conflict
 * candidate in its own bounded transaction and fails with `WORKSPACE_VERSION_CONFLICT`.
 */

interface WorkspaceRow {
  workspace_id: string;
  version: number;
}

interface VersionRow {
  version: number;
  parent_version: number;
  manifest: unknown;
  manifest_digest: string;
  created_by_run_id: string | null;
  created_at: Date | string;
}

interface ConflictRow {
  id: string;
  base_version: number;
  current_version: number;
  candidate_manifest: unknown;
  conflict_paths: unknown;
  status: string;
  created_at: Date | string;
}

const LOCK_WORKSPACE_SQL = `
SELECT id AS workspace_id, version
  FROM workspaces
 WHERE tenant_id = $1 AND agent_id = $2
 FOR UPDATE
`;

const SELECT_WORKSPACE_SQL = `
SELECT id AS workspace_id, version
  FROM workspaces
 WHERE tenant_id = $1 AND agent_id = $2
`;

const SELECT_VERSION_SQL = `
SELECT version, parent_version, manifest, manifest_digest, created_by_run_id, created_at
  FROM workspace_versions
 WHERE tenant_id = $1 AND workspace_id = $2 AND version = $3
`;

const SELECT_HISTORY_SQL = `
SELECT version, parent_version, manifest, manifest_digest, created_by_run_id, created_at
  FROM workspace_versions
 WHERE tenant_id = $1 AND workspace_id = $2
 ORDER BY version DESC
 LIMIT $3
`;

const INSERT_VERSION_SQL = `
INSERT INTO workspace_versions (
  tenant_id, workspace_id, version, parent_version, manifest, manifest_digest,
  created_by_run_id, lease_epoch
)
VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
`;

const ADVANCE_VERSION_SQL = `
UPDATE workspaces
   SET version = $3, updated_at = clock_timestamp()
 WHERE tenant_id = $1 AND agent_id = $2 AND version = $4
`;

const LOCK_CONFLICT_WORKSPACE_SQL = `
SELECT 1
  FROM workspaces
 WHERE tenant_id = $1 AND id = $2
   FOR SHARE
`;

const INSERT_CONFLICT_SQL = `
INSERT INTO workspace_conflicts (
  id, tenant_id, workspace_id, base_version, current_version, candidate_manifest,
  candidate_digest, conflict_paths, dedupe_key, task_id, run_id, lease_epoch
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12)
ON CONFLICT (tenant_id, workspace_id, dedupe_key) DO NOTHING
`;

const SELECT_CONFLICTS_SQL = `
SELECT id, base_version, current_version, candidate_manifest, conflict_paths, status, created_at
  FROM workspace_conflicts
 WHERE tenant_id = $1 AND workspace_id = $2 AND status = 'pending'
 ORDER BY created_at DESC, id
 LIMIT $3
`;

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

function digestOf(manifest: WorkspaceManifestValue): string {
  return createHash('sha256').update(canonicalWorkspaceManifest(manifest), 'utf8').digest('hex');
}

function parseContext(ctx: AuthContext): AuthContext {
  const parsed = AuthContextSchema.safeParse(ctx);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

function parseAgentId(agentId: Id): Id {
  const parsed = IdSchema.safeParse(agentId);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

function parseTenantId(value: Id): Id {
  const parsed = IdSchema.safeParse(value);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

function parseExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidArgumentError([{ path: 'expectedVersion', code: 'invalid_version' }]);
  }

  return value;
}

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_HISTORY_LIMIT;
  }

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidArgumentError([{ path: 'limit', code: 'invalid_limit' }]);
  }

  return Math.min(value, MAX_HISTORY_LIMIT);
}

function toManifest(value: unknown): WorkspaceManifestValue {
  return normalizeWorkspaceManifest(value);
}

function toSnapshot(
  agentId: Id,
  workspaceId: Id,
  version: number,
  row?: VersionRow,
): WorkspaceSnapshot {
  return Object.freeze({
    agentId,
    workspaceId,
    version,
    manifest:
      row === undefined ? Object.freeze({ files: Object.freeze([]) }) : toManifest(row.manifest),
  });
}

/**
 * Workspace store.
 *
 * Every method derives the tenant from the verified `AuthContext`; an agent that belongs to
 * another tenant is indistinguishable from a missing one.
 */
export class PostgresWorkspaceStore implements WorkspaceStore {
  constructor(private readonly pool: pg.Pool) {}

  async load(ctx: AuthContext, agentId: Id): Promise<WorkspaceSnapshot> {
    const context = parseContext(ctx);
    const agent = parseAgentId(agentId);

    try {
      const workspace = await this.pool.query<WorkspaceRow>(SELECT_WORKSPACE_SQL, [
        context.tenantId,
        agent,
      ]);
      const row = workspace.rows[0];

      if (row === undefined) {
        throw new DomainError('NOT_FOUND', 'workspace is not available in this tenant');
      }

      const latest = await this.readVersion(context.tenantId, row.workspace_id, row.version);

      return toSnapshot(agent, row.workspace_id, row.version, latest ?? undefined);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async loadVersion(ctx: AuthContext, agentId: Id, version: number): Promise<WorkspaceSnapshot> {
    const context = parseContext(ctx);
    const agent = parseAgentId(agentId);
    const requested = parseExpectedVersion(version);

    try {
      const workspace = await this.pool.query<WorkspaceRow>(SELECT_WORKSPACE_SQL, [
        context.tenantId,
        agent,
      ]);
      const row = workspace.rows[0];

      if (row === undefined || requested > row.version) {
        throw new DomainError('NOT_FOUND', 'workspace version is not available in this tenant');
      }

      if (requested === 0) {
        return toSnapshot(agent, row.workspace_id, 0);
      }

      const historical = await this.readVersion(context.tenantId, row.workspace_id, requested);

      if (historical === null) {
        throw new DomainError('NOT_FOUND', 'workspace version is not available in this tenant');
      }

      return toSnapshot(agent, row.workspace_id, requested, historical);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Tenant-scoped read for the fenced Run path.
   *
   * A worker has no end-user `AuthContext`; it reads the workspace of the Agent recorded on
   * its own Run. Only the tenant/agent pair from the verified grant is used, and no manifest
   * is returned for an agent of another tenant.
   */
  async loadForRun(
    tenantId: Id,
    agentId: Id,
  ): Promise<{ readonly version: number; readonly manifest: WorkspaceManifestValue }> {
    const tenant = parseTenantId(tenantId);
    const agent = parseAgentId(agentId);

    try {
      const workspace = await this.pool.query<WorkspaceRow>(SELECT_WORKSPACE_SQL, [tenant, agent]);
      const row = workspace.rows[0];

      if (row === undefined) {
        throw new DomainError('NOT_FOUND', 'workspace is not available in this tenant');
      }

      const latest = await this.readVersion(tenant, row.workspace_id, row.version);

      return Object.freeze({
        version: row.version,
        manifest: latest === null ? EMPTY_MANIFEST : normalizeWorkspaceManifest(latest.manifest),
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async history(
    ctx: AuthContext,
    agentId: Id,
    limit?: number,
  ): Promise<readonly WorkspaceVersionInfo[]> {
    const context = parseContext(ctx);
    const agent = parseAgentId(agentId);
    const bounded = parseLimit(limit);

    try {
      const workspace = await this.pool.query<WorkspaceRow>(SELECT_WORKSPACE_SQL, [
        context.tenantId,
        agent,
      ]);
      const row = workspace.rows[0];

      if (row === undefined) {
        throw new DomainError('NOT_FOUND', 'workspace is not available in this tenant');
      }

      const versions = await this.pool.query<VersionRow>(SELECT_HISTORY_SQL, [
        context.tenantId,
        row.workspace_id,
        bounded,
      ]);

      return Object.freeze(
        versions.rows.map((version) =>
          Object.freeze({
            agentId: agent,
            version: version.version,
            parentVersion: version.parent_version,
            digest: version.manifest_digest,
            createdAt: toIsoTimestamp(version.created_at),
            createdByRunId: version.created_by_run_id,
          }),
        ),
      );
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async conflicts(ctx: AuthContext, agentId: Id): Promise<readonly WorkspaceConflictView[]> {
    const context = parseContext(ctx);
    const agent = parseAgentId(agentId);

    try {
      const workspace = await this.pool.query<WorkspaceRow>(SELECT_WORKSPACE_SQL, [
        context.tenantId,
        agent,
      ]);
      const row = workspace.rows[0];

      if (row === undefined) {
        throw new DomainError('NOT_FOUND', 'workspace is not available in this tenant');
      }

      const result = await this.pool.query<ConflictRow>(SELECT_CONFLICTS_SQL, [
        context.tenantId,
        row.workspace_id,
        DEFAULT_HISTORY_LIMIT,
      ]);

      return Object.freeze(
        result.rows.map((conflict) =>
          Object.freeze({
            conflictId: conflict.id,
            agentId: agent,
            baseVersion: conflict.base_version,
            currentVersion: conflict.current_version,
            candidate: toManifest(conflict.candidate_manifest),
            conflictPaths: Object.freeze(
              Array.isArray(conflict.conflict_paths)
                ? (conflict.conflict_paths as unknown[]).filter(
                    (path): path is string => typeof path === 'string',
                  )
                : [],
            ),
            status: conflict.status === 'resolved' ? ('resolved' as const) : ('pending' as const),
            createdAt: toIsoTimestamp(conflict.created_at),
          }),
        ),
      );
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Commit a full desired manifest with optimistic concurrency.
   *
   * A stale `expectedVersion` is not automatically fatal: if the workspace advanced with a
   * provably non-overlapping additive change, the candidate is merged deterministically and
   * committed on top of the *new* current version. Overlapping or destructive changes record
   * a pending conflict candidate (separate, idempotent, non-terminal transaction) and fail
   * with `WORKSPACE_VERSION_CONFLICT`.
   */
  async commit(
    ctx: AuthContext,
    agentId: Id,
    expectedVersion: number,
    nextManifest: WorkspaceManifestValue,
  ): Promise<{ version: number }> {
    const context = parseContext(ctx);
    const agent = parseAgentId(agentId);
    const expected = parseExpectedVersion(expectedVersion);
    const candidate = normalizeWorkspaceManifest(nextManifest);

    assertManifestSize(candidate);

    try {
      await assertArtifactReferences(this.pool, context.tenantId, candidate);

      const result = await withTransaction(this.pool, (client) =>
        commitWorkspaceInTransaction(client, {
          tenantId: context.tenantId,
          agentId: agent,
          expectedVersion: expected,
          manifest: candidate,
          allowMerge: true,
        }),
      );

      return Object.freeze({ version: result.version });
    } catch (error) {
      const conflict = error instanceof WorkspaceConflictSignal ? error : null;

      if (conflict !== null) {
        // The candidate is preserved outside the rolled-back transaction so a later review can
        // see both sides. This is not a Task state and never marks anything completed, and a
        // failure to persist it must surface instead of pretending the conflict was recorded.
        await recordWorkspaceConflict(this.pool, context.tenantId, conflict);
      }

      throw asDomainError(error);
    }
  }

  private async readVersion(
    tenantId: Id,
    workspaceId: Id,
    version: number,
  ): Promise<VersionRow | null> {
    if (version <= 0) {
      return null;
    }

    const result = await this.pool.query<VersionRow>(SELECT_VERSION_SQL, [
      tenantId,
      workspaceId,
      version,
    ]);

    return result.rows[0] ?? null;
  }
}

/**
 * Preserve a losing candidate in its own bounded, idempotent, non-terminal transaction.
 *
 * Two writers that collide on the same base/candidate pair produce one row because of the
 * `(tenant, workspace, dedupe_key)` unique constraint. Nothing here mutates a workspace
 * version, a Task status or an event stream.
 *
 * The candidate manifests stay reference-checked: the workspace row is locked first and every
 * referenced Artifact row that still exists is locked `FOR SHARE` before the conflict row is
 * written, so a concurrent `ArtifactStore.delete` either observes this conflict and refuses,
 * or wins first — in which case the candidate simply cannot reference a deleted row.
 *
 * Pass a client (see `recordWorkspaceConflictIn`) to record inside an existing transaction.
 */
export async function recordWorkspaceConflict(
  pool: pg.Pool,
  tenantId: Id,
  conflict: WorkspaceConflictSignal,
  provenance: {
    readonly taskId?: Id | null;
    readonly runId?: Id | null;
    readonly leaseEpoch?: number | null;
  } = {},
): Promise<void> {
  const digest = digestOf(conflict.candidate);
  const dedupeKey = `${conflict.baseVersion}:${conflict.currentVersion}:${digest.slice(0, 32)}`;

  await withTransaction(pool, (client) =>
    recordWorkspaceConflictIn(client, tenantId, conflict, provenance, { digest, dedupeKey }),
  );
}

/**
 * Record the conflict inside a transaction the caller owns.
 *
 * Exposed so a caller (and the concurrency regression tests) can compose the conflict with
 * other work and still get the reference locks; `recordWorkspaceConflict` is the ordinary
 * one-shot wrapper around this.
 */
export async function recordWorkspaceConflictIn(
  client: pg.PoolClient,
  tenantId: Id,
  conflict: WorkspaceConflictSignal,
  provenance: {
    readonly taskId?: Id | null;
    readonly runId?: Id | null;
    readonly leaseEpoch?: number | null;
  } = {},
  prepared?: { readonly digest?: string; readonly dedupeKey?: string },
): Promise<void> {
  const digest = prepared?.digest ?? digestOf(conflict.candidate);
  const dedupeKey =
    prepared?.dedupeKey ??
    `${conflict.baseVersion}:${conflict.currentVersion}:${digest.slice(0, 32)}`;

  // Lock order: workspace row first, then the Artifact rows. The insert itself takes a
  // `FOR KEY SHARE` on the parent workspace through its foreign key, so taking the workspace
  // lock first keeps this transaction in the same order as a Workspace version commit.
  const workspace = await client.query(LOCK_CONFLICT_WORKSPACE_SQL, [
    tenantId,
    conflict.workspaceId,
  ]);

  if ((workspace.rowCount ?? 0) === 0) {
    throw new DomainError('NOT_FOUND', 'workspace is not available in this tenant');
  }

  await lockConflictCandidateArtifacts(client, tenantId, conflict.candidate);

  await client.query(INSERT_CONFLICT_SQL, [
    randomUUID(),
    tenantId,
    conflict.workspaceId,
    conflict.baseVersion,
    conflict.currentVersion,
    JSON.stringify(conflict.candidate),
    digest,
    JSON.stringify(conflict.conflictPaths),
    dedupeKey,
    provenance.taskId ?? null,
    provenance.runId ?? null,
    provenance.leaseEpoch ?? null,
  ]);
}

/**
 * Internal signal used to move a conflict out of the failing transaction.
 *
 * It is a `DomainError` so callers of `commit()` observe the documented
 * `WORKSPACE_VERSION_CONFLICT` code, and it carries the candidate so the conflict can be
 * preserved separately without ever committing a partial workspace version.
 */
export class WorkspaceConflictSignal extends DomainError {
  override readonly name = 'WorkspaceConflictSignal';
  readonly workspaceId: Id;
  readonly baseVersion: number;
  readonly currentVersion: number;
  readonly candidate: WorkspaceManifestValue;
  readonly conflictPaths: readonly string[];

  constructor(input: {
    readonly workspaceId: Id;
    readonly baseVersion: number;
    readonly currentVersion: number;
    readonly candidate: WorkspaceManifestValue;
    readonly conflictPaths: readonly string[];
  }) {
    super(
      'WORKSPACE_VERSION_CONFLICT',
      `workspace ${input.workspaceId} advanced to ${input.currentVersion} from base ${input.baseVersion}`,
    );
    this.workspaceId = input.workspaceId;
    this.baseVersion = input.baseVersion;
    this.currentVersion = input.currentVersion;
    this.candidate = input.candidate;
    this.conflictPaths = input.conflictPaths;
  }
}

export interface WorkspaceCommitInput {
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly expectedVersion: number;
  readonly manifest: WorkspaceManifestValue;
  readonly createdByRunId?: Id | null;
  readonly leaseEpoch?: number | null;
  /** User path merges stale-but-safe candidates; the fenced Run path may opt out. */
  readonly allowMerge?: boolean;
  /**
   * Artifact ids the caller already locked inside this transaction, ascending, through
   * `lockWorkspaceArtifactScope`.
   *
   * Supplying it turns the declared lock order into a checked invariant: an auto-merged
   * manifest that references an Artifact outside this set would be locked *after* higher ids
   * and could invert the global order against another writer, so it is rejected instead. The
   * fenced committer always supplies it; the plain user path locks its single final set and
   * leaves it undefined.
   */
  readonly prelockedArtifactIds?: ReadonlySet<string>;
}

export interface WorkspaceCommitResult {
  readonly workspaceId: Id;
  readonly version: number;
  readonly baseVersion: number;
  readonly previousVersion: number;
  readonly merged: boolean;
}

const EMPTY_MANIFEST: WorkspaceManifestValue = Object.freeze({ files: Object.freeze([]) });

const LOCK_WORKSPACE_BY_ID_SQL = `
SELECT id AS workspace_id, version
  FROM workspaces
 WHERE tenant_id = $1 AND agent_id = $2
   FOR UPDATE
`;

/**
 * Lock the workspace row of one Agent before any Artifact row is locked.
 *
 * The fenced committer takes this lock up front so that its later Artifact `FOR SHARE` locks
 * are always acquired *after* the workspace row. That fixed order is shared with
 * `commitWorkspaceInTransaction` and `recordWorkspaceConflictIn`, which is what keeps a
 * three-way deadlock impossible between a version commit, a conflict record and a delete.
 */
export async function lockWorkspaceRow(
  client: pg.PoolClient,
  tenantId: Id,
  agentId: Id,
): Promise<number> {
  const workspace = await lockWorkspace(client, tenantId, agentId);

  return workspace.version;
}

async function lockWorkspace(
  client: pg.PoolClient,
  tenantId: Id,
  agentId: Id,
): Promise<WorkspaceRow> {
  const locked = await client.query<WorkspaceRow>(LOCK_WORKSPACE_BY_ID_SQL, [tenantId, agentId]);
  const row = locked.rows[0];

  if (row === undefined) {
    throw new DomainError('NOT_FOUND', 'workspace is not available in this tenant');
  }

  return row;
}

export interface WorkspaceArtifactLockScope {
  /** Workspace version at the moment the scope was taken; stable until COMMIT. */
  readonly version: number;
  /** Every Artifact id this commit can reference, de-duplicated and ascending. */
  readonly artifactIds: readonly string[];
}

/**
 * Lock every Artifact a Workspace commit *can* end up referencing, not just the ones the
 * request names.
 *
 * `commitWorkspaceInTransaction` auto-merges a non-conflicting candidate onto the current
 * version, and the merged manifest keeps the current version's entries. Those extra Artifacts
 * are locked *after* the request's Artifacts if the caller pre-locks only the request, which
 * inverts the global ascending order (the caller would hold a high id while waiting for a low
 * one). Reading the current manifest here — after the workspace row lock, so it cannot move —
 * and locking the union in one ascending pass keeps the rendezvous with `ArtifactStore.delete`
 * inside a single ordered batch.
 */
export async function lockWorkspaceArtifactScope(
  client: pg.PoolClient,
  input: {
    readonly tenantId: Id;
    readonly agentId: Id;
    /** Artifact ids the request names (workspace candidate, checkpoint, ...). */
    readonly extraArtifactIds: readonly string[];
  },
): Promise<WorkspaceArtifactLockScope> {
  const workspace = await lockWorkspace(client, input.tenantId, input.agentId);
  // `workspaces.version` is the current version and this row is locked, so the merge path in
  // `commitWorkspaceInTransaction` will read exactly this manifest as its `current`.
  const current = await readVersionIn(
    client,
    input.tenantId,
    workspace.workspace_id,
    workspace.version,
  );

  const artifactIds = [
    ...new Set([
      ...(current?.files ?? []).map((entry) => entry.artifactId),
      ...input.extraArtifactIds,
    ]),
  ].sort();

  if (artifactIds.length > 0) {
    await lockArtifactRows(client, input.tenantId, artifactIds);
  }

  return Object.freeze({ version: workspace.version, artifactIds: Object.freeze(artifactIds) });
}

/**
 * Commit a workspace version inside an existing transaction.
 *
 * Used by the user-facing store and by the fenced `RunResultCommitter`, so CAS, history and
 * merge rules are identical on both paths. The caller must already hold whatever Run locks
 * it needs; this function takes the workspace row lock itself, last.
 */
export async function commitWorkspaceInTransaction(
  client: pg.PoolClient,
  input: WorkspaceCommitInput,
): Promise<WorkspaceCommitResult> {
  const candidate = normalizeWorkspaceManifest(input.manifest);
  assertManifestSize(candidate);

  const locked = await client.query<WorkspaceRow>(LOCK_WORKSPACE_SQL, [
    input.tenantId,
    input.agentId,
  ]);
  const workspace = locked.rows[0];

  if (workspace === undefined) {
    throw new DomainError('NOT_FOUND', 'workspace is not available in this tenant');
  }

  const current = workspace.version;

  if (input.expectedVersion > current) {
    // The caller claims a version this workspace never reached; nothing can be merged.
    throw new WorkspaceConflictSignal({
      workspaceId: workspace.workspace_id,
      baseVersion: input.expectedVersion,
      currentVersion: current,
      candidate,
      conflictPaths: [],
    });
  }

  let manifest = candidate;
  let parentVersion = input.expectedVersion;
  let merged = false;

  if (current !== input.expectedVersion) {
    const base = await readVersionIn(
      client,
      input.tenantId,
      workspace.workspace_id,
      input.expectedVersion,
    );
    const currentManifest = await readVersionIn(
      client,
      input.tenantId,
      workspace.workspace_id,
      current,
    );

    if (base === null || currentManifest === null || input.allowMerge === false) {
      throw new WorkspaceConflictSignal({
        workspaceId: workspace.workspace_id,
        baseVersion: input.expectedVersion,
        currentVersion: current,
        candidate,
        conflictPaths: [],
      });
    }

    const outcome = mergeWorkspaceManifests(base, currentManifest, candidate);

    if (outcome.status === 'conflict') {
      throw new WorkspaceConflictSignal({
        workspaceId: workspace.workspace_id,
        baseVersion: input.expectedVersion,
        currentVersion: current,
        candidate,
        conflictPaths: outcome.conflictPaths,
      });
    }

    manifest = outcome.manifest;
    parentVersion = current;
    merged = true;
  }

  // A merged manifest keeps the current version's entries, so it can reference Artifacts the
  // request never mentioned. If the caller pre-locked a scope, those must already be inside it:
  // locking an id here, after higher ids are held, would invert the global ascending order
  // against another writer (the P2 lock-order review finding). Merging can only add entries
  // from `current ∪ candidate`, both of which `lockWorkspaceArtifactScope` covers, so this
  // check is a canary for a future merge change rather than a reachable rejection.
  assertInsideReferenceScope(manifest, input.prelockedArtifactIds);

  // Validate references on the final manifest under a shared row lock; a merged result may
  // reference artifacts the other writer introduced, and those must still be tenant-owned with
  // matching digests. Holding `FOR SHARE` until COMMIT is what makes a concurrent
  // `ArtifactStore.delete` see this version instead of deleting underneath it. Rows the caller
  // already locked are re-locked by the same transaction, which is a no-op and cannot reorder
  // anything.
  await lockArtifactReferences(client, input.tenantId, manifest);

  const nextVersion = current + 1;
  await client.query(INSERT_VERSION_SQL, [
    input.tenantId,
    workspace.workspace_id,
    nextVersion,
    parentVersion,
    JSON.stringify(manifest),
    digestOf(manifest),
    input.createdByRunId ?? null,
    input.leaseEpoch ?? null,
  ]);

  // Conditional update: the row lock already serialises writers, and the version predicate
  // fails closed if anything ever bypassed it.
  const advanced = await client.query(ADVANCE_VERSION_SQL, [
    input.tenantId,
    input.agentId,
    nextVersion,
    current,
  ]);

  if (advanced.rowCount !== 1) {
    throw new DomainError('DB_UNAVAILABLE', 'workspace version could not be advanced');
  }

  return Object.freeze({
    workspaceId: workspace.workspace_id,
    version: nextVersion,
    baseVersion: input.expectedVersion,
    previousVersion: current,
    merged,
  });
}

async function readVersionIn(
  client: pg.PoolClient,
  tenantId: Id,
  workspaceId: Id,
  version: number,
): Promise<WorkspaceManifestValue | null> {
  if (version === 0) {
    return EMPTY_MANIFEST;
  }

  const result = await client.query<VersionRow>(SELECT_VERSION_SQL, [
    tenantId,
    workspaceId,
    version,
  ]);
  const row = result.rows[0];

  return row === undefined ? null : normalizeWorkspaceManifest(row.manifest);
}

function assertManifestSize(manifest: WorkspaceManifestValue): void {
  const bytes = Buffer.byteLength(canonicalWorkspaceManifest(manifest), 'utf8');

  if (bytes > WORKSPACE_MANIFEST_MAX_BYTES) {
    throw new InvalidArgumentError([{ path: 'manifest', code: 'manifest_too_large' }]);
  }
}

/**
 * Fail closed when a final manifest falls outside the scope the caller already locked.
 *
 * This is the invariant behind the ascending Artifact lock order, not an input validation: the
 * caller either covered the merge inputs or the whole protocol assumption is void, and
 * reporting a database-level inconsistency is better than taking a lock in the wrong position.
 */
function assertInsideReferenceScope(
  manifest: WorkspaceManifestValue,
  prelocked: ReadonlySet<string> | undefined,
): void {
  if (prelocked === undefined) {
    return;
  }

  const outside = manifest.files.filter((entry) => !prelocked.has(entry.artifactId));

  if (outside.length > 0) {
    throw new DomainError(
      'DB_UNAVAILABLE',
      'workspace manifest references an artifact outside the locked scope',
    );
  }
}

/** Digest of a normalized manifest; shared with the database `manifest_digest` column. */
export function workspaceManifestDigest(manifest: WorkspaceManifestValue): string {
  return digestOf(normalizeWorkspaceManifest(manifest));
}
