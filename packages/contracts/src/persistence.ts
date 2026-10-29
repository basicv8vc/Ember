import type { AuthContext, Id, RunTerminalStatus, WorkspaceManifestValue } from '@ember/domain';

/**
 * P0B-06 persistence ports (B06-D1, D3, D4, D5).
 *
 * Domain and application code depends on these capability contracts. PostgreSQL plus a
 * controlled local filesystem is the only P0B-06 adapter; nothing here mentions `pg.Pool`, a
 * folder layout, an object-store vendor or a queue.
 *
 * Two trust domains stay separate, exactly as in P0B-03/05:
 * - a user-facing call carries the gateway-verified `AuthContext`;
 * - a worker call carries a `RunGrant` derived server-side from the persisted Run, never a
 *   `principalId` guessed by the Worker.
 */

export const MAX_BLOB_BYTES = 33_554_432;
export const WORKSPACE_MANIFEST_MAX_BYTES = 1_048_576;

/**
 * Server-derived, scoped execution authority for one Run attempt.
 *
 * It is not an `AuthContext`: it names no end-user principal and grants only the operations
 * this module exposes (artifact/checkpoint/workspace publication for one tenant/task/run and
 * one lease epoch).
 */
export interface RunGrant {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly agentId: Id;
  readonly attempt: number;
  readonly leaseEpoch: number;
  /**
   * Worker identity recorded on the Run when the lease was issued (`runs.worker_id`).
   *
   * It is derived server-side from the persisted Run, never supplied by a client, and the
   * committer rejects a grant whose worker does not own the Run. `null` is accepted only for
   * a historical Run that has no recorded worker.
   */
  readonly workerId: string | null;
}

/** Bytes can arrive as one buffer or as a bounded stream; neither is unbounded in memory. */
export type BlobSource = Uint8Array | AsyncIterable<Uint8Array>;

/** Verified bytes inside the private staging area. Not yet an Artifact. */
export interface StagedBlobRef {
  readonly stagedId: Id;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  /** Internal relative key (`staging/...`). Never a host path and never a public identity. */
  readonly storageKey: string;
}

/** Installed, immutable blob bytes addressed by digest. */
export interface InstalledBlobRef {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  /** Internal relative key (`blobs/...`). */
  readonly storageKey: string;
}

export interface BlobGcReport {
  readonly scanned: number;
  /** Staging rows/files older than the quarantine window without a live reference. */
  readonly removedStaged: number;
  /** Installed files with no database reference older than the quarantine window. */
  readonly removedBlobs: number;
  /** Anything uncertain is retained and counted here, never deleted. */
  readonly retained: number;
}

export interface BlobGcOptions {
  /** Quarantine window; must be non-zero so a concurrent publish can never be swept. */
  readonly retentionMs: number;
  /** Report what would be removed without deleting anything. */
  readonly dryRun?: boolean;
}

/**
 * Content-addressed, immutable byte storage.
 *
 * Lifecycle: `stage` (private, verified) → `install` (durable, still invisible) → a trusted
 * database transaction references the digest → the bytes become an Artifact. Staging bytes
 * are never readable through `ArtifactStore`.
 */
export interface BlobStore {
  stage(
    tenantId: Id,
    source: BlobSource,
    mediaType: string,
    options?: { readonly maxBytes?: number },
  ): Promise<StagedBlobRef>;
  /** Re-hash the staged file, then atomically install it under its content key. */
  install(tenantId: Id, staged: StagedBlobRef): Promise<InstalledBlobRef>;
  read(tenantId: Id, storageKey: string): Promise<Uint8Array>;
  /** Re-hash installed bytes and compare with the expected digest/size. */
  verifyContent(tenantId: Id, sha256: string, size: number): Promise<boolean>;
  /**
   * Cheap re-establishment that installed bytes are still present: existence, a regular file
   * and the expected size, without re-hashing (`install` already verified content).
   *
   * This exists for the publishing transaction. It runs after the tenant-digest lock is taken,
   * so a publish that can still see its bytes under the lock can never be undone by a later
   * sweep: the collector deletes only unreferenced files and takes the same lock first.
   */
  assertInstalled(tenantId: Id, sha256: string, size: number): Promise<boolean>;
  verify(
    tenantId: Id,
    storageKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<boolean>;
  discard(tenantId: Id, staged: StagedBlobRef): Promise<void>;
  /**
   * Remove only bytes that are provably unreferenced: staging keys that were never published
   * and installed files whose digest no database row references. Artifacts, workspace
   * history, checkpoints and pending conflicts are never touched.
   */
  sweepOrphans(now: Date, options: BlobGcOptions): Promise<BlobGcReport>;
}

/** Tenant-scoped artifact metadata plus its content identity. */
export interface ArtifactMetadata {
  readonly artifactId: Id;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly createdBy: 'user' | 'run';
  readonly retention: 'task' | 'user';
  readonly taskId: Id | null;
  readonly runId: Id | null;
  readonly createdAt: string;
}

/** Read/write authorization facts for a tenant-owned artifact, used by the adapter. */
export interface ArtifactLookup {
  readonly metadata: ArtifactMetadata;
  /** Internal storage key; never returned through an API DTO. */
  readonly storageKey: string;
}

export interface ArtifactStoreReader {
  /** `null` for a missing artifact *and* for another tenant's artifact. */
  find(ctx: AuthContext, artifactId: Id): Promise<ArtifactLookup | null>;
  findInTenant(tenantId: Id, artifactId: Id): Promise<ArtifactLookup | null>;
}

export interface ExternalEffectRecord {
  readonly key: string;
  readonly status: 'verified' | 'unknown' | 'not_applicable';
  readonly receiptDigest?: string;
}

export interface CheckpointArtifactRef {
  readonly artifactId: Id;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  /** Logical workspace path, when the artifact was also placed in the workspace. */
  readonly path?: string;
}

/** One committed logical step, serialisable and portability-safe. */
export interface CommittedCheckpoint {
  readonly checkpointId: Id;
  readonly schemaVersion: number;
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly stepId: string;
  readonly stepSequence: number;
  readonly inputDigest: string;
  readonly executorVersion: string;
  readonly cursor: Readonly<Record<string, string | number | boolean>>;
  readonly workspaceVersion: number | null;
  readonly artifacts: readonly CheckpointArtifactRef[];
  readonly externalEffects: readonly ExternalEffectRecord[];
  readonly createdAt: string;
}

export interface CheckpointLookupOptions {
  /** Only return checkpoints of this schema version. */
  readonly schemaVersion?: number;
  /** Only return checkpoints written by this executor version. */
  readonly executorVersion?: string;
}

/**
 * Read-only recovery input. A checkpoint is returned only after its publishing transaction
 * committed, so a partially written step can never be resumed.
 */
export interface CheckpointStore {
  loadLatest(
    grant: RunGrant,
    options?: CheckpointLookupOptions,
  ): Promise<CommittedCheckpoint | null>;
  list(grant: RunGrant, options?: CheckpointLookupOptions): Promise<readonly CommittedCheckpoint[]>;
  /** Read one checkpoint by id inside the caller's task. */
  get(grant: RunGrant, checkpointId: Id): Promise<CommittedCheckpoint | null>;
}

/** Artifact bytes verified by the adapter, ready to be referenced by a commit. */
export interface CommitArtifactRequest {
  readonly artifactId: Id;
  readonly staged: StagedBlobRef;
  readonly retention?: 'task' | 'user';
}

export interface CommitWorkspaceRequest {
  readonly expectedVersion: number;
  readonly manifest: WorkspaceManifestValue;
}

export interface CommitCheckpointRequest {
  readonly stepId: string;
  readonly stepSequence?: number;
  readonly inputDigest: string;
  readonly executorVersion: string;
  readonly cursor?: Readonly<Record<string, string | number | boolean>>;
  readonly workspaceVersion?: number | null;
  readonly artifacts?: readonly CheckpointArtifactRef[];
  readonly externalEffects?: readonly ExternalEffectRecord[];
}

export const COMMIT_STEP_MODES = ['progress', 'result'] as const;

/**
 * `progress` publishes step references and (optionally) a Workspace version in one fenced
 * transaction without ending the Run. `result` additionally converges Task/Run, writes the
 * single terminal event and stores the receipt.
 */
export type CommitStepMode = (typeof COMMIT_STEP_MODES)[number];

export interface CommitStepRequest {
  /** Stable operation id chosen by the executor; the idempotency identity of this step. */
  readonly operationId: string;
  readonly mode: CommitStepMode;
  readonly artifacts?: readonly CommitArtifactRequest[];
  readonly workspace?: CommitWorkspaceRequest;
  readonly checkpoint?: CommitCheckpointRequest;
}

export interface CommitReceipt {
  readonly operationId: string;
  readonly mode: CommitStepMode;
  readonly taskId: Id;
  readonly runId: Id;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly artifactIds: readonly Id[];
  readonly workspaceVersion: number | null;
  readonly checkpointId: Id | null;
  /** `true` only for a read-only replay of an already committed operation. */
  readonly replayed: boolean;
  readonly committedAt: string;
}

/**
 * Atomic, fenced result commit (B06-D3).
 *
 * One call performs, inside a single database transaction that holds the necessary Task/Run/
 * Workspace row locks: lease/cancel/deadline/epoch re-validation using a post-lock database
 * clock, artifact reference publication, Workspace CAS, optional checkpoint, legal Task/Run
 * convergence, exactly one terminal event for `result` and the idempotency receipt.
 */
export interface RunResultCommitter {
  commitStep(grant: RunGrant, request: CommitStepRequest): Promise<CommitReceipt>;
  /**
   * Read-only receipt lookup for a lost ACK. It never grants another write, even after the
   * original lease expired.
   */
  findReceipt(grant: RunGrant, operationId: string): Promise<CommitReceipt | null>;
}

/** Convenience type for the terminal statuses a commit can produce. */
export interface CommitOutcome {
  readonly status: RunTerminalStatus;
  readonly receipt: CommitReceipt;
}
