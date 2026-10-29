import type { CheckpointArtifactRef } from '@ember/contracts';
import {
  DomainError,
  InvalidArgumentError,
  type Id,
  type WorkspaceManifestValue,
} from '@ember/domain';
import type pg from 'pg';

/**
 * Row-lock protocol between durable Artifact references and `ArtifactStore.delete`.
 *
 * `artifacts` is the only row both sides can rendezvous on: a reference lives inside a JSONB
 * manifest, so no foreign key (and therefore no automatic lock) connects
 * `workspace_versions`, `step_checkpoints` or `workspace_conflicts` back to the Artifact.
 * Without an explicit protocol a concurrent writer can commit a reference *after* `delete()`
 * decided the Artifact was unreferenced, producing a dangling Artifact id.
 *
 * The protocol has exactly two rules:
 * 1. every writer that persists a reference takes `FOR SHARE` on each referenced Artifact row
 *    inside the writing transaction (this module);
 * 2. `delete()` takes `FOR UPDATE` on the Artifact row *before* it evaluates references.
 *
 * `FOR SHARE` conflicts with `FOR UPDATE`, so only two outcomes exist: either the writer
 * commits first and the deleter then observes the reference (and refuses), or the deleter
 * commits first and the writer's locked read finds no row (and refuses).
 *
 * Lock order (deadlock argument): `Task` → `Run` → blob-digest advisory lock → workspace row
 * → artifact rows (ascending id) → reference row. Every multi-row acquisition goes through
 * `lockArtifactRows`, which sorts its ids, so no two transactions can take the same Artifact
 * rows in opposite order.
 */

export interface ArtifactIdentity {
  readonly sha256: string;
  readonly size: number;
}

const SELECT_ARTIFACT_IDENTITIES_SQL = `
SELECT id, sha256, size
  FROM artifacts
 WHERE tenant_id = $1 AND id = ANY($2::uuid[])
`;

/** `FOR SHARE`: held until COMMIT, and it conflicts with the deleter's `FOR UPDATE`. */
const LOCK_ARTIFACT_IDENTITY_SQL = `
SELECT sha256, size
  FROM artifacts
 WHERE tenant_id = $1 AND id = $2
   FOR SHARE
`;

function toIdentity(row: { sha256: string; size: string | number }): ArtifactIdentity {
  return Object.freeze({ sha256: row.sha256, size: Number(row.size) });
}

/**
 * Take a shared row lock on every listed Artifact inside the caller's transaction.
 *
 * Ids are de-duplicated and sorted so concurrent writers always acquire the same rows in the
 * same order. A missing id is absent from the returned map; the caller decides whether that
 * is a rejection (a durable reference must not point at a deleted Artifact).
 */
export async function lockArtifactRows(
  client: pg.PoolClient,
  tenantId: Id,
  artifactIds: readonly string[],
): Promise<Map<string, ArtifactIdentity>> {
  const locked = new Map<string, ArtifactIdentity>();

  for (const id of [...new Set(artifactIds)].sort()) {
    const result = await client.query<{ sha256: string; size: string | number }>(
      LOCK_ARTIFACT_IDENTITY_SQL,
      [tenantId, id],
    );
    const row = result.rows[0];

    if (row !== undefined) {
      locked.set(id, toIdentity(row));
    }
  }

  return locked;
}

/**
 * Optimistic, unlocked existence/digest read.
 *
 * Used only as a cheap pre-check before a transaction starts; the authoritative decision is
 * taken by the locking variants below. Outside a transaction a `FOR SHARE` would be released
 * with the statement, so this path deliberately does not pretend to lock anything.
 */
export async function assertArtifactReferences(
  runner: pg.Pool | pg.PoolClient,
  tenantId: Id,
  manifest: WorkspaceManifestValue,
): Promise<void> {
  if (manifest.files.length === 0) {
    return;
  }

  const ids = [...new Set(manifest.files.map((entry) => entry.artifactId))];
  const result = await runner.query<{ id: string; sha256: string; size: string | number }>(
    SELECT_ARTIFACT_IDENTITIES_SQL,
    [tenantId, ids],
  );
  const known = new Map(result.rows.map((row) => [row.id, toIdentity(row)]));

  verifyManifestReferences(known, manifest);
}

/**
 * Lock and verify every Artifact a Workspace manifest references.
 *
 * Runs inside the writing transaction, so the rows stay locked until the version row commits.
 */
export async function lockArtifactReferences(
  client: pg.PoolClient,
  tenantId: Id,
  manifest: WorkspaceManifestValue,
): Promise<void> {
  if (manifest.files.length === 0) {
    return;
  }

  const locked = await lockArtifactRows(
    client,
    tenantId,
    manifest.files.map((entry) => entry.artifactId),
  );

  verifyManifestReferences(locked, manifest);
}

/** Lock and verify the Artifacts a Step checkpoint persists as its recoverable output. */
export async function lockCheckpointArtifacts(
  client: pg.PoolClient,
  tenantId: Id,
  artifacts: readonly CheckpointArtifactRef[],
): Promise<void> {
  if (artifacts.length === 0) {
    return;
  }

  const locked = await lockArtifactRows(
    client,
    tenantId,
    artifacts.map((entry) => entry.artifactId),
  );

  for (const referenced of artifacts) {
    const row = locked.get(referenced.artifactId);

    if (row === undefined) {
      throw new DomainError(
        'POLICY_DENIED',
        'checkpoint references an artifact outside this tenant',
      );
    }

    if (row.sha256 !== referenced.sha256 || row.size !== referenced.size) {
      throw new InvalidArgumentError([
        { path: `checkpoint.artifacts[${referenced.artifactId}]`, code: 'artifact_mismatch' },
      ]);
    }
  }
}

/**
 * Lock the Artifacts of a losing Workspace candidate while its conflict row is written.
 *
 * Existence is deliberately *not* required: a losing fenced commit references artifacts that
 * its own rolled-back transaction never published, and a candidate that references nothing
 * cannot dangle. What this buys is the rendezvous — every Artifact of the candidate that
 * *does* exist is locked `FOR SHARE`, so `delete()` either observes the conflict row or the
 * candidate's reference is already gone and cannot be resurrected.
 */
export async function lockConflictCandidateArtifacts(
  client: pg.PoolClient,
  tenantId: Id,
  manifest: WorkspaceManifestValue,
): Promise<void> {
  if (manifest.files.length === 0) {
    return;
  }

  await lockArtifactRows(
    client,
    tenantId,
    manifest.files.map((entry) => entry.artifactId),
  );
}

function verifyManifestReferences(
  known: Map<string, ArtifactIdentity>,
  manifest: WorkspaceManifestValue,
): void {
  for (const entry of manifest.files) {
    const row = known.get(entry.artifactId);

    if (row === undefined) {
      throw new DomainError(
        'POLICY_DENIED',
        'workspace manifest references an artifact outside this tenant',
      );
    }

    if (row.sha256 !== entry.sha256 || row.size !== entry.size) {
      throw new InvalidArgumentError([
        { path: `manifest.files[${entry.path}].sha256`, code: 'artifact_mismatch' },
      ]);
    }
  }
}
