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

/**
 * P0B-08b persistent budget port (B08b-D1).
 *
 * P0B-08a decided *whether* an operation may run, using an immutable in-process ledger. This
 * port is the durable authority that decision has to be taken against: a single PostgreSQL
 * transaction serializes "read usage → decide → reserve", so two Workers sharing a Tenant can
 * no longer both see spare quota.
 *
 * The adapter is the source of truth for three things the pure rules layer cannot provide:
 *
 * 1. **Idempotency across days and attempts.** `(tenantId, runId, operationId)` is the
 *    charge identity, not `(tenantId, runId, utcDay, operationId)`, so replaying yesterday's
 *    operation today is a replay rather than a second charge (P0B-08a §6.1 rule 1).
 * 2. **Trusted carry-over.** Run-scoped usage is aggregated from the committed operation
 *    rows, so a caller can never declare its own `runCarryOver` and reset the Run budget
 *    (P0B-08a §6.1 rule 2). The port therefore has no carry-over input at all.
 * 3. **Crash safety.** A reservation whose lease died is charged in full (`expired`), never
 *    refunded, so killing a Worker is not a way to escape accounting.
 *
 * Every method takes a `RunGrant`: budget writes are Worker-side, tenant-owned and fenced by
 * the same lease/epoch/cancellation re-validation as a result commit. No method accepts a
 * `principalId` or a Tenant from a request body.
 */

/**
 * One reservation's or settlement's amount, per dimension.
 *
 * `units` counts against both the per-Run cap and the Tenant-day cap; `concurrencySlots` is
 * the number of Workers the operation holds while it runs. All values are non-negative safe
 * integers — a fraction, a `NaN`, a negative number or a value above
 * `Number.MAX_SAFE_INTEGER` is rejected with `INVALID_ARGUMENT`, never rounded.
 */
export interface BudgetReservationAmount {
  readonly steps: number;
  readonly units: number;
  readonly elapsedMs: number;
  readonly concurrencySlots: number;
}

export const BUDGET_OPERATION_STATES = ['reserved', 'settled', 'released', 'expired'] as const;

/**
 * Terminal and live states of one budget operation.
 *
 * - `reserved`: quota is held and counts against every limit until it is settled or swept;
 * - `settled`: charged at the consumed amount, which is never larger than the reservation;
 * - `released`: the operation provably never ran, so no quota was charged at all;
 * - `expired`: the lease that held the reservation died, so the reservation is charged at the
 *   full reserved amount instead of being refunded.
 */
export type BudgetOperationState = (typeof BUDGET_OPERATION_STATES)[number];

/** Durable view of one budget operation: its reservation and its terminal settlement. */
export interface BudgetOperation {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly operationId: string;
  readonly leaseEpoch: number;
  readonly state: BudgetOperationState;
  readonly reserved: BudgetReservationAmount;
  readonly consumed: BudgetReservationAmount;
  /** UTC day the quota was taken from (`YYYY-MM-DD`); a later settlement never re-dates it. */
  readonly utcDay: string;
  readonly expiresAt: string;
  readonly settledAt: string | null;
  /** `true` only for a read-only replay of an operation this port already recorded. */
  readonly replayed: boolean;
}

/**
 * Usage the next decision is taken against.
 *
 * `runSteps` / `runUnits` / `runElapsedMs` cover **every** UTC day of the Run plus its live
 * reservations, which is the trusted replacement for `runCarryOver`.
 * `tenantDailyUnits` covers the current UTC day of *all* Runs of the Tenant, including this
 * Run's own live reservations exactly once. `concurrentSlots` is a gauge: live reservations
 * of other Runs plus this Run's live reservations.
 */
export interface BudgetLedgerSnapshot {
  readonly tenantId: Id;
  readonly runId: Id;
  readonly utcDay: string;
  readonly policyVersion: number;
  readonly runSteps: number;
  readonly runUnits: number;
  readonly runElapsedMs: number;
  readonly tenantDailyUnits: number;
  readonly concurrentSlots: number;
}

export interface BudgetReserveRequest {
  /**
   * Stable operation identity, unique inside the Run and **independent of the UTC day** — for
   * example `produce:3` or `publish:3`. Reusing an id is a replay, never a second charge.
   */
  readonly operationId: string;
  /** Amount held until the operation settles. Also the cap a settlement may charge. */
  readonly cost: BudgetReservationAmount;
}

export interface BudgetSettleRequest {
  readonly operationId: string;
  /**
   * Amount actually consumed. It may be smaller than the reservation and may never be
   * larger; the difference is returned to every limit. A settlement never re-dates the
   * charge to the current UTC day.
   */
  readonly consumed: BudgetReservationAmount;
}

export interface BudgetReleaseRequest {
  readonly operationId: string;
}

/**
 * Transactional budget authority for the durable Worker path.
 *
 * `reserve` is the only method that may deny: it holds a Tenant-scoped serialization point
 * for the whole "aggregate usage → evaluate the policy → insert the reservation" sequence and
 * throws `BUDGET_EXCEEDED` **before** any operation has run, leaving no row behind. It also
 * re-validates the grant inside that transaction, so a stale epoch, a cancelled Task, an
 * expired lease or an elapsed deadline throws `STALE_LEASE` / `CANCELLED` /
 * `DEADLINE_EXCEEDED` instead of charging quota to an attempt that may not act.
 *
 * `settle` and `release` are idempotent per `(tenantId, runId, operationId)`: repeating the
 * same call returns the recorded state with `replayed: true`, a different settlement amount is
 * refused with `INVALID_ARGUMENT` (`budget_settlement_conflict`), and a settlement can never
 * be turned into a release or vice versa. Neither takes the Tenant serialization point, so
 * bookkeeping after an operation can never be blocked behind another Run's decision.
 */
export interface BudgetLedger {
  /** Current usage of the Run and Tenant day, including live reservations. */
  snapshot(grant: RunGrant): Promise<BudgetLedgerSnapshot>;
  reserve(grant: RunGrant, request: BudgetReserveRequest): Promise<BudgetOperation>;
  settle(grant: RunGrant, request: BudgetSettleRequest): Promise<BudgetOperation>;
  release(grant: RunGrant, request: BudgetReleaseRequest): Promise<BudgetOperation>;
}
