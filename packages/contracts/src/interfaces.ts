import type {
  AuthContext,
  ExecutionPath,
  Id,
  LeasedRun,
  MockTaskInput,
  RunTerminalStatus,
  TaskCommand,
  TaskKind,
  TaskReceipt,
  TaskView,
} from '@ember/domain';

/**
 * Tenant-scoped task persistence boundary.
 *
 * Every method takes a verified `AuthContext`; implementations must scope reads/writes to
 * `ctx.tenantId` and must never trust a tenant identifier from `TaskCommand`.
 */
export interface TaskRepository {
  /** Idempotently persist a validated command. Real database work belongs to P0B-03. */
  create(ctx: AuthContext, cmd: TaskCommand): Promise<TaskReceipt>;
  /** Return `null` when the task does not exist *or* belongs to another tenant. */
  get(ctx: AuthContext, taskId: Id): Promise<TaskView | null>;
  /** Record a cancellation request; cooperative cancellation completes later. */
  requestCancel(ctx: AuthContext, taskId: Id): Promise<void>;
}

/**
 * Durable lease queue boundary.
 *
 * The database implementation (P0B-04) must enforce fencing atomically. These signatures
 * only fix the provider-neutral contract; they are not an implementation.
 */
export interface LeaseQueue {
  claimNext(workerId: string, now: Date): Promise<LeasedRun | null>;
  /**
   * Renew a valid lease. `false` means the lease was **not** renewed: it may be stale,
   * expired, fenced, or the Task may have a committed cancellation intent. It never means
   * the Task failed by itself.
   */
  heartbeat(run: LeasedRun, now: Date): Promise<boolean>;
  reapExpired(now: Date): Promise<number>;
  /**
   * Finish a leased run. Returns `false` when the caller no longer owns a valid current
   * lease (stale epoch, expired lease, wrong Run/Task/Tenant) **and nothing was written**.
   * Database failures are raised as fixed `DomainError`s, never reported as `false`.
   */
  finish(run: LeasedRun, outcome: RunTerminalStatus): Promise<boolean>;
}

export interface RouteDecision {
  readonly path: ExecutionPath;
  readonly reason: string;
  readonly policyVersion: number;
}

/** Deterministic execution-path policy. Actual Fast/Standard decisions land in P0B-05. */
export interface ExecutionRouter {
  decide(ctx: AuthContext, cmd: TaskCommand): Promise<RouteDecision>;
}

/**
 * Trusted execution context for one already-leased Run (P0B-05).
 *
 * A worker does not have the end-user `AuthContext`: it read a durable Task row, not a
 * request. This type therefore keeps the four identities separate instead of inventing a
 * principal:
 * - `tenantId` — persisted owner of the Task/Run, never a client-supplied value;
 * - `agentId` + `policyVersion` — trusted agent configuration read from the agent row;
 * - `workerId` — the operational execution identity recorded on the Run;
 * - end-user principal — deliberately absent, because P0B-05 has no verified request
 *   identity at execution time.
 *
 * `kind`/`input` are the persisted Task values, re-validated by the reader before use.
 */
export interface RunExecutionContext {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly agentId: Id;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly leaseExpiresAt: string;
  readonly deadlineAt: string | null;
  /** Agent policy version from the trusted agent row. Never taken from Task input. */
  readonly policyVersion: number;
  readonly kind: TaskKind;
  readonly input: MockTaskInput;
  /** Worker that currently owns the Run lease; `null` only for an unclaimed historical row. */
  readonly workerId: string | null;
}

/**
 * Reads the trusted execution context of a claimed Run.
 *
 * Implementations must locate the row by tenant + task + run, verify the current run
 * pointer, lease epoch and attempt, re-validate the persisted payload, and must not hold a
 * transaction or row lock for the duration of the execution.
 */
export interface RunExecutionContextReader {
  read(lease: LeasedRun, now: Date): Promise<RunExecutionContext>;
}

export interface ArtifactRef {
  readonly artifactId: Id;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}

/** Content-addressed blob store. Implementation and orphan handling belong to P0B-06. */
export interface ArtifactStore {
  put(ctx: AuthContext, data: Uint8Array, mediaType: string): Promise<ArtifactRef>;
  get(ctx: AuthContext, artifactId: Id): Promise<Uint8Array>;
  /**
   * Recompute the content digest/size and compare it with the expected values. Returns
   * `false` on mismatch; a missing or foreign artifact is reported as `NOT_FOUND`.
   */
  verify(
    ctx: AuthContext,
    artifactId: Id,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<boolean>;
  /** Remove a tenant-owned artifact. Orphan GC policy remains a P0B-06 concern. */
  delete(ctx: AuthContext, artifactId: Id): Promise<void>;
}

export interface WorkspaceFile {
  /** Workspace-relative logical path; never a host absolute path. */
  readonly path: string;
  readonly artifactId: Id;
  readonly sha256: string;
  readonly size: number;
}

export interface WorkspaceManifest {
  readonly files: readonly WorkspaceFile[];
}

export interface WorkspaceSnapshot {
  readonly agentId: Id;
  readonly workspaceId?: Id;
  readonly version: number;
  readonly manifest: WorkspaceManifest;
}

/**
 * Workspace metadata store with optimistic concurrency.
 *
 * `commit` keeps its original P0B-03 signature: a stale `expectedVersion` fails with
 * `WORKSPACE_VERSION_CONFLICT`, and a legal non-overlapping change may be merged
 * deterministically. The richer read/history/conflict methods below are P0B-06 additions and
 * never change that failure contract.
 */
export interface WorkspaceStore {
  load(ctx: AuthContext, agentId: Id): Promise<WorkspaceSnapshot>;
  commit(
    ctx: AuthContext,
    agentId: Id,
    expectedVersion: number,
    nextManifest: WorkspaceManifest,
  ): Promise<{ version: number }>;
  /** Read one immutable historical version. Version 0 is the empty workspace. */
  loadVersion(ctx: AuthContext, agentId: Id, version: number): Promise<WorkspaceSnapshot>;
  /** Newest-first immutable version history, bounded by `limit`. */
  history(ctx: AuthContext, agentId: Id, limit?: number): Promise<readonly WorkspaceVersionInfo[]>;
  /** Pending conflicts that still hold both candidate manifests. */
  conflicts(ctx: AuthContext, agentId: Id): Promise<readonly WorkspaceConflictView[]>;
}

export interface WorkspaceVersionInfo {
  readonly agentId: Id;
  readonly version: number;
  readonly parentVersion: number;
  readonly digest: string;
  readonly createdAt: string;
  readonly createdByRunId: Id | null;
}

export interface WorkspaceConflictView {
  readonly conflictId: Id;
  readonly agentId: Id;
  readonly baseVersion: number;
  /** Workspace version the losing candidate was based on; never mutated by the conflict. */
  readonly currentVersion: number;
  readonly candidate: WorkspaceManifest;
  readonly conflictPaths: readonly string[];
  readonly status: 'pending' | 'resolved';
  readonly createdAt: string;
}

/**
 * Explicit provider capabilities. Optional capabilities must be discovered, never inferred
 * from a provider name or from an optional method merely existing.
 */
export interface SandboxCapabilities {
  readonly shell: boolean;
  readonly browser: boolean;
  readonly filesystemSnapshot: boolean;
  readonly memoryResume: boolean;
  readonly diskSurvivesStop: boolean;
  readonly forkFromSnapshot: boolean;
  readonly persistentVolume: boolean;
  readonly networkPolicy: boolean;
}

export interface SandboxSpec {
  /** Trusted server-side tenant identity, never raw client input. */
  readonly tenantId: Id;
  readonly runId: Id;
  readonly imageDigest: string;
  readonly cpuMilli: number;
  readonly memoryMiB: number;
  readonly maxLifetimeSec: number;
  readonly networkPolicyId: string;
  readonly restoreRef?: string;
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdoutRef: Id;
  readonly stderrRef: Id;
}

/** P0-B adapters report simulated usage; units match the RFC telemetry contract. */
export interface SandboxUsageRecord {
  readonly cpuSeconds: number;
  readonly memoryGiBSeconds: number;
  readonly egressBytes: number;
}

/**
 * Provider-neutral sandbox lifecycle.
 *
 * `create()` returning does not mean Ready; callers must await `waitReady()`. Real
 * providers and the FakeSandbox implementation belong to P0B-05.
 */
export interface SandboxProvider {
  capabilities(): Promise<SandboxCapabilities>;
  create(spec: SandboxSpec): Promise<{ sandboxId: Id }>;
  waitReady(sandboxId: Id, deadlineMs: number): Promise<void>;
  exec(sandboxId: Id, argv: readonly string[], timeoutMs: number): Promise<SandboxExecResult>;
  putFile(sandboxId: Id, path: string, artifactRef: Id): Promise<void>;
  getFile(sandboxId: Id, path: string): Promise<{ artifactRef: Id }>;
  snapshot?(sandboxId: Id): Promise<{ restoreRef: string }>;
  resume?(sandboxId: Id): Promise<void>;
  stop(sandboxId: Id): Promise<void>;
  destroy(sandboxId: Id): Promise<void>;
  usage(sandboxId: Id): Promise<SandboxUsageRecord>;
}
