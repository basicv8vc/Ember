import { randomUUID } from 'node:crypto';

import type {
  SandboxCapabilities,
  SandboxExecResult,
  SandboxProvider,
  SandboxSpec,
  SandboxUsageRecord,
} from '@ember/contracts';
import { DomainError, InvalidArgumentError, type Id } from '@ember/domain';

import { renderCommand, sessionIdFor, validateArgv } from './command.js';
import { resolveConfinedPath, truncateUtf8, utf8ByteLength } from './paths.js';
import {
  DAYTONA_DEFAULT_ALLOWED_PROGRAMS,
  DAYTONA_DEFAULT_NETWORK_POLICY_ID,
  DAYTONA_LABEL_CREATED_BY,
  DAYTONA_LABEL_MANAGED,
  DAYTONA_LABEL_OWNER,
  DAYTONA_LABEL_PROVIDER,
  DAYTONA_LABEL_RUN,
  DAYTONA_LABEL_TENANT,
  DAYTONA_NETWORK_POLICIES,
  DAYTONA_PROVIDER_LABEL_VALUE,
  DAYTONA_SANDBOX_LIMITS,
  type DaytonaNetworkPolicy,
  type DaytonaSandboxClass,
} from './limits.js';
import {
  DAYTONA_LIVE_STATES,
  DaytonaExecCancelledError,
  type DaytonaDirectoryEntry,
  type DaytonaExecResult,
  type DaytonaMetricsSample,
  type DaytonaSandboxClient,
  type DaytonaSandboxInfo,
} from './port.js';

export type DaytonaRecordState = 'creating' | 'ready' | 'stopped' | 'destroyed' | 'failed';

export interface DaytonaProviderOptions {
  /** Trusted server-side tenant identity. One provider instance serves exactly one tenant. */
  readonly tenantId: Id;
  readonly runId?: Id;
  readonly client: DaytonaSandboxClient;
  /**
   * Snapshot the adapter is configured to use. Doubles as the accepted `SandboxSpec.imageDigest`:
   * Daytona addresses images by snapshot name, and a mismatch means the caller asked for a
   * runtime this provider was not approved to allocate.
   */
  readonly snapshot: string;
  /** Class the snapshot is expected to produce. Verified against the control plane. */
  readonly sandboxClass: DaytonaSandboxClass;
  readonly workspaceRoot?: string;
  /** Disk reservation of the configured snapshot, in GiB. Used only for cost estimation. */
  readonly diskGiB?: number;
  readonly networkPolicies?: Readonly<Record<string, DaytonaNetworkPolicy>>;
  readonly defaultNetworkPolicyId?: string;
  readonly allowedPrograms?: readonly string[];
  /**
   * Stable identifier of the owning deployment (for example `<env>:<service>`).
   *
   * This is the only key a crashed worker leaves behind, so the orphan reconciler filters by
   * it. Defaults to a per-process value, which is deliberately *not* reconcilable — passing an
   * explicit owner is what makes crash cleanup possible.
   */
  readonly owner?: string;
  /** Trusted Run cancellation / lease-loss signal. */
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
}

interface DaytonaSandboxRecord {
  readonly sandboxId: Id;
  readonly tenantId: Id;
  readonly runId: Id;
  readonly snapshot: string;
  state: DaytonaRecordState;
  readonly requestedCpu: number;
  readonly requestedMemoryGiB: number;
  diskGiB: number;
  readonly createdAtMs: number;
  readyAtMs: number | null;
  readonly deadlineAtMs: number;
  sequence: number;
  /** Retained stream text, addressed by the opaque ref handed back to the caller. */
  readonly outputs: Map<string, string>;
  readonly outputOrder: string[];
  lastMetrics: DaytonaMetricsSample | null;
  stoppedAtMs: number | null;
  destroyedAtMs: number | null;
}

/**
 * Daytona-backed implementation of the provider-neutral `SandboxProvider` contract.
 *
 * Three invariants are enforced here rather than delegated to the vendor:
 *
 * 1. **Tenant scope.** A provider instance owns one tenant. A sandbox id belonging to another
 *    tenant is indistinguishable from an unknown id (`NOT_FOUND`), so the adapter cannot be
 *    used as an existence oracle across tenants.
 * 2. **Fail-closed allocation.** Resource, class and egress settings are re-read from the
 *    control plane after allocation. A sandbox that came back with more CPU than approved, a
 *    different class than configured, or egress open when the policy says blocked is destroyed
 *    and reported as `POLICY_DENIED` — never silently used.
 * 3. **Bounded blast radius.** argv, output, file size, lifetime and concurrency are all
 *    capped client-side before any vendor call.
 */
export class DaytonaSandboxProvider implements SandboxProvider {
  private readonly tenantId: Id;
  private readonly runId: Id;
  private readonly client: DaytonaSandboxClient;
  private readonly snapshotName: string;
  private readonly sandboxClass: DaytonaSandboxClass;
  private readonly workspaceRoot: string;
  private readonly diskGiB: number;
  private readonly networkPolicies: Readonly<Record<string, DaytonaNetworkPolicy>>;
  private readonly defaultNetworkPolicyId: string;
  private readonly allowedPrograms: readonly string[];
  private readonly owner: string;
  private readonly signal: AbortSignal | undefined;
  private readonly clock: () => number;
  private readonly records = new Map<Id, DaytonaSandboxRecord>();

  public constructor(options: DaytonaProviderOptions) {
    if (options.tenantId.trim().length === 0) {
      throw new InvalidArgumentError([{ path: 'tenantId', code: 'too_small' }]);
    }

    this.tenantId = options.tenantId;
    this.runId = options.runId ?? options.tenantId;
    this.client = options.client;
    this.snapshotName = options.snapshot;
    this.sandboxClass = options.sandboxClass;
    this.workspaceRoot = options.workspaceRoot ?? DAYTONA_SANDBOX_LIMITS.workspaceRoot;
    this.diskGiB = options.diskGiB ?? 3;
    this.networkPolicies = options.networkPolicies ?? DAYTONA_NETWORK_POLICIES;
    this.defaultNetworkPolicyId =
      options.defaultNetworkPolicyId ?? DAYTONA_DEFAULT_NETWORK_POLICY_ID;
    this.allowedPrograms = options.allowedPrograms ?? DAYTONA_DEFAULT_ALLOWED_PROGRAMS;
    this.owner = options.owner ?? `unreconcilable:${randomUUID()}`;
    this.signal = options.signal;
    this.clock = options.clock ?? Date.now;
  }

  // ---------------------------------------------------------------- capabilities

  /**
   * Reports only what this adapter actually wires, not what the vendor can do.
   *
   * Daytona can fork, pause/resume and snapshot VM sandboxes, but none of those paths are
   * exposed through the port yet. Claiming them here would let the execution router select a
   * strategy that fails at runtime.
   */
  public capabilities(): Promise<SandboxCapabilities> {
    return Promise.resolve({
      shell: true,
      browser: false,
      filesystemSnapshot: false,
      memoryResume: false,
      // A stopped container sandbox keeps its filesystem until archived; a stopped VM sandbox
      // has its state offloaded, which also preserves the disk.
      diskSurvivesStop: true,
      forkFromSnapshot: false,
      persistentVolume: false,
      networkPolicy: true,
    });
  }

  // ---------------------------------------------------------------- lifecycle

  public async create(spec: SandboxSpec): Promise<{ sandboxId: Id }> {
    this.throwIfAborted('create');

    if (spec.tenantId !== this.tenantId) {
      throw new DomainError('POLICY_DENIED', 'sandbox spec tenant does not match provider tenant');
    }

    if (spec.imageDigest !== this.snapshotName) {
      throw new DomainError(
        'POLICY_DENIED',
        'requested image is not the snapshot this provider is bound to',
      );
    }

    if (this.liveRecordCount() >= DAYTONA_SANDBOX_LIMITS.maxConcurrentSandboxes) {
      throw new DomainError(
        'BUDGET_EXCEEDED',
        'concurrent sandbox ceiling reached for this provider',
      );
    }

    if (this.records.size >= DAYTONA_SANDBOX_LIMITS.maxTrackedSandboxes) {
      throw new DomainError('BUDGET_EXCEEDED', 'tracked sandbox ceiling reached for this provider');
    }

    const lifetimeSec = this.parseLifetime(spec.maxLifetimeSec);
    const requestedCpu = Math.max(1, Math.ceil(spec.cpuMilli / 1_000));
    const requestedMemoryGiB = Math.max(1, Math.ceil(spec.memoryMiB / 1_024));

    if (requestedCpu > DAYTONA_SANDBOX_LIMITS.maxCpuPerSandbox) {
      throw new DomainError(
        'POLICY_DENIED',
        'requested vCPU exceeds the approved per-sandbox ceiling',
      );
    }

    if (requestedMemoryGiB > DAYTONA_SANDBOX_LIMITS.maxMemoryGiBPerSandbox) {
      throw new DomainError(
        'POLICY_DENIED',
        'requested memory exceeds the approved per-sandbox ceiling',
      );
    }

    const policy = this.resolveNetworkPolicy(spec.networkPolicyId);
    const allocated = this.allocatedResources(requestedCpu, requestedMemoryGiB);

    const createdAtMs = this.clock();
    const labels: Record<string, string> = {
      [DAYTONA_LABEL_OWNER]: this.owner,
      [DAYTONA_LABEL_TENANT]: this.tenantId,
      [DAYTONA_LABEL_RUN]: spec.runId,
      [DAYTONA_LABEL_PROVIDER]: DAYTONA_PROVIDER_LABEL_VALUE,
      [DAYTONA_LABEL_MANAGED]: 'true',
      // The sandbox id is not known before the call, so the run id is the only correlatable
      // value available at creation time.
      [DAYTONA_LABEL_CREATED_BY]: 'ember-worker',
    };

    const created = await this.client.create({
      snapshot: this.snapshotName,
      labels,
      ttlMinutes: Math.min(
        Math.max(Math.ceil(lifetimeSec / 60), 1),
        DAYTONA_SANDBOX_LIMITS.maxTtlMinutes,
      ),
      // Orphan control. If this worker dies between create() and destroy(), the vendor stops
      // the sandbox after this idle window and then deletes it because auto-delete is 0.
      autoStopIntervalMinutes: DAYTONA_SANDBOX_LIMITS.idleStopMinutes,
      autoDeleteIntervalMinutes: DAYTONA_SANDBOX_LIMITS.autoDeleteMinutesAfterStop,
      ephemeral: true,
      networkBlockAll: policy.blockAll,
      ...(policy.networkAllowList === undefined
        ? {}
        : { networkAllowList: policy.networkAllowList }),
      ...(policy.domainAllowList === undefined ? {} : { domainAllowList: policy.domainAllowList }),
      fetchTimeoutSec: 90,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });

    this.records.set(created.sandboxId, {
      sandboxId: created.sandboxId,
      tenantId: this.tenantId,
      runId: spec.runId,
      snapshot: this.snapshotName,
      state: 'creating',
      requestedCpu: allocated.cpu,
      requestedMemoryGiB: allocated.memoryGiB,
      diskGiB: allocated.diskGiB,
      createdAtMs,
      readyAtMs: null,
      deadlineAtMs: createdAtMs + lifetimeSec * 1_000,
      sequence: 0,
      outputs: new Map(),
      outputOrder: [],
      lastMetrics: null,
      stoppedAtMs: null,
      destroyedAtMs: null,
    });

    return { sandboxId: created.sandboxId };
  }

  public async waitReady(sandboxId: Id, deadlineMs: number): Promise<void> {
    const record = this.requireRecord(sandboxId);

    if (record.state === 'ready') {
      return;
    }

    if (record.state === 'destroyed' || record.state === 'failed') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox is not recoverable');
    }

    const budget = Math.min(Math.max(deadlineMs, 1_000), DAYTONA_SANDBOX_LIMITS.maxReadyDeadlineMs);
    const deadline = this.clock() + budget;
    let lastState = 'unknown';

    while (this.clock() < deadline) {
      this.throwIfAborted('waitReady');

      const info = await this.client.get(sandboxId);

      if (info === null) {
        record.state = 'failed';
        throw new DomainError('NOT_FOUND', 'sandbox disappeared before becoming ready');
      }

      lastState = info.state;

      if (info.state === 'started') {
        await this.verifyAllocation(record, info);
        record.state = 'ready';
        record.readyAtMs = this.clock();
        return;
      }

      if (info.state === 'error' || info.state === 'build_failed') {
        record.state = 'failed';
        throw new DomainError('SANDBOX_NOT_READY', 'sandbox entered a terminal error state');
      }

      if (info.state === 'destroyed' || info.state === 'destroying') {
        record.state = 'destroyed';
        throw new DomainError('NOT_FOUND', 'sandbox was destroyed before becoming ready');
      }

      await this.sleep(250);
    }

    record.state = 'failed';
    throw new DomainError(
      'SANDBOX_NOT_READY',
      `sandbox did not start within the ready deadline (last state: ${lastState})`,
    );
  }

  public async stop(sandboxId: Id): Promise<void> {
    const record = this.requireRecord(sandboxId);

    if (record.state === 'destroyed' || record.state === 'stopped') {
      return;
    }

    await this.client.stop(sandboxId);

    record.state = 'stopped';
    record.stoppedAtMs = this.clock();
  }

  public async destroy(sandboxId: Id): Promise<void> {
    // Ownership check identical to exec()/stop()/readOutput(): an id this provider instance
    // does not track — unknown, or belonging to another tenant — must look exactly like
    // NOT_FOUND and must never reach the vendor API. The Daytona API key is shared across
    // tenants, so an unscoped delete would destroy another tenant's sandbox.
    const record = this.requireRecord(sandboxId);

    // Idempotent: destroying an already-destroyed sandbox is a no-op, not an error, so a
    // retried cleanup after a crash cannot fail the run.
    if (record.state === 'destroyed') {
      return;
    }

    const gone = await this.client.delete(sandboxId, 60_000);

    record.state = gone ? 'destroyed' : 'failed';
    record.destroyedAtMs = gone ? this.clock() : null;

    if (!gone) {
      throw new DomainError('DEADLINE_EXCEEDED', 'sandbox deletion was accepted but not confirmed');
    }
  }

  // ---------------------------------------------------------------- execution

  public async exec(
    sandboxId: Id,
    argv: readonly string[],
    timeoutMs: number,
  ): Promise<SandboxExecResult> {
    const record = this.requireRecord(sandboxId);
    this.requireReady(record);
    this.throwIfAborted('exec');

    const args = validateArgv(argv, { allowedPrograms: this.allowedPrograms });
    const timeout = this.parseExecTimeout(timeoutMs);
    const remainingMs = record.deadlineAtMs - this.clock();

    if (remainingMs <= 0) {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox lifetime expired before exec');
    }

    record.sequence += 1;

    let result: DaytonaExecResult;

    try {
      result = await this.client.exec(record.sandboxId, {
        command: renderCommand(args),
        timeoutMs: Math.min(timeout, remainingMs),
        sessionId: sessionIdFor(record.sandboxId, record.sequence),
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
    } catch (error) {
      // The port normalises vendor cancellation into a single error so the adapter does not
      // have to depend on SDK error classes; map it onto the domain vocabulary here.
      if (error instanceof DaytonaExecCancelledError) {
        throw new DomainError('CANCELLED', 'exec cancelled by the run signal');
      }

      throw error;
    }

    if (result.timedOut) {
      throw new DomainError('EXECUTION_TIMEOUT', 'command exceeded its execution timeout');
    }

    const stdoutRef = randomUUID();
    const stderrRef = randomUUID();

    this.retainOutput(record, stdoutRef, result.stdout, DAYTONA_SANDBOX_LIMITS.maxStdoutBytes);
    this.retainOutput(record, stderrRef, result.stderr, DAYTONA_SANDBOX_LIMITS.maxStderrBytes);

    record.lastMetrics = (await this.client.latestMetrics(record.sandboxId)) ?? record.lastMetrics;

    return { exitCode: result.exitCode, stdoutRef, stderrRef };
  }

  public readOutput(sandboxId: Id, ref: Id): Promise<string> {
    const record = this.requireRecord(sandboxId);
    const output = record.outputs.get(ref);

    if (output === undefined) {
      return Promise.reject(
        new DomainError('NOT_FOUND', 'output reference is not retained by this provider'),
      );
    }

    return Promise.resolve(output);
  }

  // ---------------------------------------------------------------- files

  /**
   * Artifact-backed file transfer is not wired: the contract's `putFile`/`getFile` take an
   * `artifactRef`, which requires an `ArtifactStore` this PoC does not have.
   *
   * Failing closed is deliberate. Silently interpreting `artifactRef` as a path would let any
   * caller address an arbitrary file inside the sandbox through a field that was never
   * validated as a path.
   */
  public putFile(_sandboxId: Id, _path: string, _artifactRef: Id): Promise<void> {
    return Promise.reject(
      new DomainError(
        'POLICY_DENIED',
        'putFile requires an ArtifactStore binding; use putTextFile in the PoC',
      ),
    );
  }

  public getFile(_sandboxId: Id, _path: string): Promise<{ artifactRef: Id }> {
    return Promise.reject(
      new DomainError(
        'POLICY_DENIED',
        'getFile requires an ArtifactStore binding; use getTextFile in the PoC',
      ),
    );
  }

  /** PoC-only extension: writes UTF-8 text to a path confined under the workspace root. */
  public async putTextFile(sandboxId: Id, relativePath: string, text: string): Promise<void> {
    const record = this.requireRecord(sandboxId);
    this.requireReady(record);
    this.throwIfAborted('putTextFile');

    const absolutePath = resolveConfinedPath(this.workspaceRoot, relativePath);
    const bytes = Buffer.from(text, 'utf8');

    if (bytes.byteLength > DAYTONA_SANDBOX_LIMITS.maxFileBytes) {
      throw new DomainError('POLICY_DENIED', 'file exceeds the per-transfer ceiling');
    }

    await this.raceSignal(this.client.upload(record.sandboxId, absolutePath, bytes), 'putTextFile');
  }

  /** Reads UTF-8 text from a path confined under the workspace root. */
  public async getTextFile(sandboxId: Id, relativePath: string): Promise<string> {
    const bytes = await this.getBytesFile(sandboxId, relativePath);
    return Buffer.from(bytes).toString('utf8');
  }

  /** Writes raw bytes (<= 256 KiB) to a path confined under the workspace root. */
  public async putBytesFile(sandboxId: Id, relativePath: string, bytes: Uint8Array): Promise<void> {
    const record = this.requireRecord(sandboxId);
    this.requireReady(record);
    this.throwIfAborted('putBytesFile');

    if (bytes.byteLength > DAYTONA_SANDBOX_LIMITS.maxFileBytes) {
      throw new DomainError('POLICY_DENIED', 'file exceeds the per-transfer ceiling');
    }

    const absolutePath = resolveConfinedPath(this.workspaceRoot, relativePath);
    await this.raceSignal(
      this.client.upload(record.sandboxId, absolutePath, Buffer.from(bytes)),
      'putBytesFile',
    );
  }

  /** Reads raw bytes (<= 256 KiB) from a path confined under the workspace root. */
  public async getBytesFile(sandboxId: Id, relativePath: string): Promise<Uint8Array> {
    const record = this.requireRecord(sandboxId);
    this.requireReady(record);
    this.throwIfAborted('getBytesFile');

    const absolutePath = resolveConfinedPath(this.workspaceRoot, relativePath);
    const bytes = await this.raceSignal(
      this.client.download(record.sandboxId, absolutePath),
      'getBytesFile',
    );

    if (bytes.byteLength > DAYTONA_SANDBOX_LIMITS.maxFileBytes) {
      throw new DomainError('POLICY_DENIED', 'file exceeds the per-transfer ceiling');
    }

    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Lists non-escaped files inside a confined subdirectory under the workspace root. */
  public async listDirectory(
    sandboxId: Id,
    relativeDir: string,
  ): Promise<readonly DaytonaDirectoryEntry[]> {
    const record = this.requireRecord(sandboxId);
    this.requireReady(record);
    this.throwIfAborted('listDirectory');

    const absoluteDir = resolveConfinedPath(this.workspaceRoot, relativeDir);
    if (this.client.listDirectory === undefined) {
      return [];
    }

    return this.raceSignal(
      this.client.listDirectory(record.sandboxId, absoluteDir),
      'listDirectory',
    );
  }

  /** PoC-only extension: existence check used to prove a path is *not* readable cross-tenant. */
  public async textFileExists(sandboxId: Id, relativePath: string): Promise<boolean> {
    const record = this.requireRecord(sandboxId);
    this.requireReady(record);

    return this.client.exists(
      record.sandboxId,
      resolveConfinedPath(this.workspaceRoot, relativePath),
    );
  }

  // ---------------------------------------------------------------- usage

  /**
   * Reservation-shaped usage, matching how Daytona bills: vCPU and GiB are metered for as long
   * as the sandbox holds them, regardless of what the workload actually used.
   *
   * `lastMetrics` is refreshed on exec so the report can show used-vs-reserved, but the
   * contract's `SandboxUsageRecord` is a billing record, not a utilisation record.
   */
  public async usage(sandboxId: Id): Promise<SandboxUsageRecord> {
    const record = this.requireRecord(sandboxId);
    const endMs = record.destroyedAtMs ?? record.stoppedAtMs ?? this.clock();
    const billableFrom = record.readyAtMs ?? record.createdAtMs;
    const seconds = Math.max((endMs - billableFrom) / 1_000, 0);

    record.lastMetrics = (await this.client.latestMetrics(sandboxId)) ?? record.lastMetrics;

    return {
      cpuSeconds: round3(seconds * record.requestedCpu),
      memoryGiBSeconds: round3(seconds * record.requestedMemoryGiB),
      // Daytona does not expose per-sandbox egress counters. Reporting 0 is honest only
      // because the smoke harness runs with egress blocked; it is a gap, not a measurement.
      egressBytes: 0,
    };
  }

  // ---------------------------------------------------------------- PoC extensions

  /** Reason used to label a usage record; lets a report distinguish measured from assumed. */
  public usageBasis(sandboxId: Id): 'RESERVATION_WALL_CLOCK' | 'NOT_MEASURED' {
    const record = this.records.get(sandboxId);

    if (record === undefined || record.readyAtMs === null) {
      return 'NOT_MEASURED';
    }

    return 'RESERVATION_WALL_CLOCK';
  }

  /** Latest vendor metric sample, if the analytics pipeline has produced one. */
  public lastMetrics(sandboxId: Id): DaytonaMetricsSample | null {
    return this.records.get(sandboxId)?.lastMetrics ?? null;
  }

  /**
   * Control-plane audit: every sandbox this tenant still owns, read from the vendor rather
   * than from local bookkeeping.
   *
   * A local `Map` cannot prove cleanup — a crashed worker's map is gone precisely when it
   * matters. This is the only cleanup claim the adapter is willing to make.
   */
  public async verifyNoLiveSandboxes(): Promise<{
    readonly liveSandboxIds: readonly string[];
    readonly liveStates: Readonly<Record<string, string>>;
    readonly labels: Readonly<Record<string, string>>;
  }> {
    const labels = {
      [DAYTONA_LABEL_OWNER]: this.owner,
      [DAYTONA_LABEL_TENANT]: this.tenantId,
      [DAYTONA_LABEL_MANAGED]: 'true',
    };

    const sandboxes = await this.client.list({ labels, states: DAYTONA_LIVE_STATES });
    const liveStates: Record<string, string> = {};

    for (const sandbox of sandboxes) {
      liveStates[sandbox.sandboxId] = sandbox.state;
    }

    return {
      liveSandboxIds: Object.keys(liveStates).sort(),
      liveStates,
      labels,
    };
  }

  /**
   * Simulates a worker dying: forgets every local record without touching the vendor.
   *
   * Used by the crash-recovery test. After this call the adapter has no handle on the
   * sandbox at all, which is exactly the state a restarted process is in.
   */
  public abandonAllRecords(): readonly Id[] {
    const ids = [...this.records.keys()];

    for (const record of this.records.values()) {
      record.state = 'failed';
    }

    this.records.clear();

    return ids;
  }

  /** Owner label this provider stamps on sandboxes; the reconciler's only stable key. */
  public get ownerLabel(): string {
    return this.owner;
  }

  public get tenantLabel(): string {
    return this.tenantId;
  }

  // ---------------------------------------------------------------- internals

  private allocatedResources(
    cpu: number,
    memoryGiB: number,
  ): { readonly cpu: number; readonly memoryGiB: number; readonly diskGiB: number } {
    return {
      cpu: Math.min(cpu, DAYTONA_SANDBOX_LIMITS.maxCpuPerSandbox),
      memoryGiB: Math.min(memoryGiB, DAYTONA_SANDBOX_LIMITS.maxMemoryGiBPerSandbox),
      diskGiB: this.diskGiB,
    };
  }

  private resolveNetworkPolicy(policyId: string): DaytonaNetworkPolicy {
    const policy = this.networkPolicies[policyId];

    if (policy === undefined) {
      throw new DomainError('POLICY_DENIED', 'unknown network policy id');
    }

    if (
      !policy.blockAll &&
      policy.domainAllowList === undefined &&
      policy.networkAllowList === undefined
    ) {
      throw new DomainError(
        'POLICY_DENIED',
        'an unblocked policy must declare at least one allow list',
      );
    }

    return policy;
  }

  private async verifyAllocation(
    record: DaytonaSandboxRecord,
    info: DaytonaSandboxInfo,
  ): Promise<void> {
    if (info.sandboxClass !== null && info.sandboxClass !== this.sandboxClass) {
      await this.destroyQuietly(record.sandboxId);
      record.state = 'failed';
      throw new DomainError(
        'POLICY_DENIED',
        'vendor allocated a different sandbox class than configured',
      );
    }

    if (info.cpu > record.requestedCpu || info.memoryGiB > record.requestedMemoryGiB) {
      await this.destroyQuietly(record.sandboxId);
      record.state = 'failed';
      throw new DomainError('POLICY_DENIED', 'vendor allocated more resources than approved');
    }

    const policy = this.defaultPolicyIsBlocking();

    if (policy && info.networkBlockAll !== true) {
      // Fail closed. An unverifiable egress policy is treated as an open one, because the
      // difference between "blocked" and "not reported" is exactly the difference between a
      // safe sandbox and a metadata-endpoint exfiltration path.
      await this.destroyQuietly(record.sandboxId);
      record.state = 'failed';
      throw new DomainError('POLICY_DENIED', 'egress policy could not be verified as blocking');
    }

    record.diskGiB = info.diskGiB;
  }

  private defaultPolicyIsBlocking(): boolean {
    return this.networkPolicies[this.defaultNetworkPolicyId]?.blockAll ?? true;
  }

  private async destroyQuietly(sandboxId: Id): Promise<void> {
    await this.client.delete(sandboxId, 30_000).catch(() => undefined);
  }

  private retainOutput(
    record: DaytonaSandboxRecord,
    ref: Id,
    text: string,
    maxBytes: number,
  ): void {
    if (record.outputOrder.length >= DAYTONA_SANDBOX_LIMITS.maxRetainedOutputsPerSandbox) {
      const oldest = record.outputOrder.shift();

      if (oldest !== undefined) {
        record.outputs.delete(oldest);
      }
    }

    record.outputs.set(ref, truncateUtf8(text, maxBytes).text);
    record.outputOrder.push(ref);
  }

  /** Byte length of a retained stream, used by the harness to prove the ceiling held. */
  public retainedBytes(sandboxId: Id): number {
    const record = this.records.get(sandboxId);
    let total = 0;

    for (const output of record?.outputs.values() ?? []) {
      total += utf8ByteLength(output);
    }

    return total;
  }

  private liveRecordCount(): number {
    let count = 0;

    for (const record of this.records.values()) {
      if (record.state === 'creating' || record.state === 'ready' || record.state === 'stopped') {
        count += 1;
      }
    }

    return count;
  }

  private parseLifetime(maxLifetimeSec: number): number {
    if (!Number.isFinite(maxLifetimeSec)) {
      throw new InvalidArgumentError([{ path: 'maxLifetimeSec', code: 'invalid_type' }]);
    }

    if (maxLifetimeSec < DAYTONA_SANDBOX_LIMITS.minSandboxLifetimeSec) {
      throw new DomainError('POLICY_DENIED', 'requested lifetime is below the minimum');
    }

    return Math.min(maxLifetimeSec, DAYTONA_SANDBOX_LIMITS.maxSandboxLifetimeSec);
  }

  private parseExecTimeout(timeoutMs: number): number {
    if (!Number.isFinite(timeoutMs)) {
      throw new InvalidArgumentError([{ path: 'timeoutMs', code: 'invalid_type' }]);
    }

    if (timeoutMs < DAYTONA_SANDBOX_LIMITS.minExecTimeoutMs) {
      throw new DomainError('POLICY_DENIED', 'requested exec timeout is below the minimum');
    }

    return Math.min(timeoutMs, DAYTONA_SANDBOX_LIMITS.maxExecTimeoutMs);
  }

  private requireRecord(sandboxId: Id): DaytonaSandboxRecord {
    if (typeof sandboxId !== 'string' || sandboxId.length === 0) {
      throw new InvalidArgumentError([{ path: 'sandboxId', code: 'too_small' }]);
    }

    const record = this.records.get(sandboxId);

    // A sandbox that belongs to another tenant is reported exactly like an unknown id: the
    // adapter must not become a cross-tenant existence oracle.
    if (record === undefined || record.tenantId !== this.tenantId) {
      throw new DomainError('NOT_FOUND', 'sandbox is not visible in this provider instance');
    }

    return record;
  }

  private requireReady(record: DaytonaSandboxRecord): void {
    if (record.state === 'destroyed') {
      throw new DomainError('NOT_FOUND', 'sandbox was destroyed');
    }

    if (record.state !== 'ready') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox is not ready');
    }
  }

  private throwIfAborted(operation: string): void {
    if (this.signal?.aborted === true) {
      throw new DomainError('CANCELLED', `sandbox ${operation} aborted by caller`);
    }
  }

  private async raceSignal<T>(operation: Promise<T>, label: string): Promise<T> {
    const signal = this.signal;
    if (signal === undefined) {
      return operation;
    }

    if (signal.aborted) {
      operation.catch(() => undefined);
      throw new DomainError('CANCELLED', `sandbox ${label} aborted by caller`);
    }

    operation.catch(() => undefined);

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(new DomainError('CANCELLED', `sandbox ${label} aborted by caller`));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
