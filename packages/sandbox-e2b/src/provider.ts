import { randomUUID } from 'node:crypto';
import { IdSchema, toInvalidArgumentError } from '@ember/contracts';
import type {
  SandboxCapabilities,
  SandboxExecResult,
  SandboxProvider,
  SandboxProviderFactory,
  SandboxSpec,
  SandboxUsageRecord,
} from '@ember/contracts';
import { DomainError, InvalidArgumentError, type Id } from '@ember/domain';
import { z } from 'zod';
import { renderCommand, validateArgv } from './command.js';
import {
  E2B_DEFAULT_ALLOWED_PROGRAMS,
  E2B_NETWORK_POLICIES,
  E2B_SANDBOX_LIMITS,
  type E2bNetworkPolicy,
} from './limits.js';
import { resolveConfinedPath, truncateUtf8, utf8ByteLength } from './paths.js';
import type {
  E2bCommandResult,
  E2bMetricsSample,
  E2bSandboxClient,
  E2bSandboxInfo,
} from './port.js';

/** Default in-sandbox directory that confined file transfers are rooted at. */
export const E2B_WORKSPACE_ROOT = '/tmp/ember';

/** Metadata key used to find orphaned sandboxes from this adapter generation. */
export const E2B_OWNER_METADATA_KEY = 'ember_owner';
export const E2B_OWNER_METADATA_VALUE = 'e2b-sandbox-poc';

/**
 * Declared capabilities of this adapter.
 *
 * `shell` is true because `commands.run` exists. `networkPolicy` is true because E2B applies
 * `allowOut`/`denyOut` at the network boundary. Everything else is false: this adapter does
 * not implement snapshot/resume, has no persistent volume, and a sandbox disk does not
 * survive `kill()`.
 */
export const E2B_CAPABILITIES: SandboxCapabilities = Object.freeze({
  shell: true,
  browser: false,
  filesystemSnapshot: false,
  memoryResume: false,
  diskSurvivesStop: false,
  forkFromSnapshot: false,
  persistentVolume: false,
  networkPolicy: true,
});

export type E2bSandboxState = 'created' | 'ready' | 'stopped' | 'destroyed';

export type E2bUsageBasis = 'VENDOR_METRICS' | 'NOMINAL_TEMPLATE';

export interface E2BSandboxProviderOptions {
  /** Trusted tenant scope of this provider instance. Every operation is confined to it. */
  readonly tenantId: Id;
  readonly client: E2bSandboxClient;
  /** E2B template name or id. This is the sandbox image identity. */
  readonly template: string;
  /**
   * Digest/tag that `SandboxSpec.imageDigest` must match.
   *
   * The Ember contract speaks in image digests; E2B speaks in template names. Binding the two
   * keeps the contract meaningful: a run cannot silently execute a different image than the
   * one policy approved.
   */
  readonly templateDigest: string;
  readonly workspaceRoot?: string;
  readonly allowedPrograms?: readonly string[];
  readonly networkPolicies?: Readonly<Record<string, E2bNetworkPolicy>>;
  readonly maxConcurrent?: number;
  readonly maxSandboxLifetimeSec?: number;
  readonly clock?: () => number;
  readonly signal?: AbortSignal;
}

const SANDBOX_SPEC_SCHEMA = z.strictObject({
  tenantId: IdSchema,
  runId: IdSchema,
  imageDigest: z.string().min(1).max(200),
  cpuMilli: z.number().int().min(50).max(4_000),
  memoryMiB: z.number().int().min(32).max(8_192),
  maxLifetimeSec: z.number().int().min(1).max(86_400),
  networkPolicyId: z.string().min(1).max(128),
  restoreRef: z.string().min(1).max(200).optional(),
});

interface OutputEntry {
  readonly ref: Id;
  readonly text: string;
  readonly truncated: boolean;
}

interface E2bSandboxRecord {
  readonly sandboxId: string;
  readonly tenantId: Id;
  readonly runId: Id;
  readonly spec: SandboxSpec;
  readonly createdAtMs: number;
  readonly deadlineAtMs: number;
  readonly outputs: Map<Id, OutputEntry>;
  readonly outputOrder: Id[];
  state: E2bSandboxState;
  readyAtMs: number | null;
  execCount: number;
  timedOutExecCount: number;
  cpuSeconds: number;
  memoryGiBSeconds: number;
  measuredCpuCount: number | null;
  measuredMemoryMiB: number | null;
  measuredAllowInternetAccess: boolean | null;
  usageBasis: E2bUsageBasis | null;
  cleanupConfirmed: boolean | null;
  lastError: string | null;
}

function parseId(value: Id, path: string): Id {
  const parsed = IdSchema.safeParse(value);

  if (!parsed.success) {
    throw new InvalidArgumentError([{ path, code: 'invalid_uuid' }]);
  }

  return parsed.data;
}

/**
 * Maps an untrusted vendor/transport failure onto a domain code.
 *
 * The vendor message never reaches the caller: `DomainError.diagnostic` is internal-only and
 * `publicMessage` is a fixed string selected by code. This is the boundary that keeps E2B
 * error payloads (which can echo request headers, including the API key) out of Ember logs.
 */
function mapClientError(error: unknown, phase: string): DomainError {
  if (error instanceof DomainError) {
    return error;
  }

  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;

  if (statusCode === 401 || statusCode === 403) {
    return new DomainError('UNAUTHENTICATED', `e2b ${phase} rejected the credential`);
  }

  if (statusCode === 429) {
    return new DomainError('BUDGET_EXCEEDED', `e2b ${phase} was rate limited`);
  }

  return new DomainError('SANDBOX_NOT_READY', `e2b ${phase} failed`);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * `SandboxProvider` implementation backed by E2B Firecracker microVMs.
 *
 * Contract fidelity notes:
 * - `create()` does **not** imply ready; `waitReady()` performs an explicit control-plane
 *   readiness probe and a resource/policy verification of what the vendor actually allocated.
 * - `exec()` keeps argv semantics by POSIX-quoting every token into the shell string E2B
 *   requires. Unquoted interpolation would turn a sandbox exec into a shell injection surface.
 * - `putFile`/`getFile` fail closed: asset transfer needs the Ember ArtifactStore CAS contract,
 *   which is out of scope here. The PoC-only text extension below is *not* part of the contract.
 * - `usage()` reports a derived figure and states its basis; E2B exposes metrics samples, not
 *   an invoice, so the adapter never claims vendor-billed numbers.
 */
export class E2BSandboxProvider implements SandboxProvider {
  private readonly tenantId: Id;
  private readonly client: E2bSandboxClient;
  private readonly template: string;
  private readonly templateDigest: string;
  private readonly workspaceRoot: string;
  private readonly allowedPrograms: readonly string[];
  private readonly networkPolicies: Readonly<Record<string, E2bNetworkPolicy>>;
  private readonly maxConcurrent: number;
  private readonly maxSandboxLifetimeSec: number;
  private readonly clock: () => number;
  private readonly signal: AbortSignal | undefined;
  private readonly sandboxes = new Map<string, E2bSandboxRecord>();

  constructor(options: E2BSandboxProviderOptions) {
    const tenant = IdSchema.safeParse(options.tenantId);

    if (!tenant.success) {
      throw toInvalidArgumentError(tenant.error);
    }

    if (options.template.trim() === '') {
      throw new InvalidArgumentError([{ path: 'template', code: 'too_small' }]);
    }

    if (options.templateDigest.trim() === '') {
      throw new InvalidArgumentError([{ path: 'templateDigest', code: 'too_small' }]);
    }

    this.tenantId = tenant.data;
    this.client = options.client;
    this.template = options.template;
    this.templateDigest = options.templateDigest;
    this.workspaceRoot = options.workspaceRoot ?? E2B_WORKSPACE_ROOT;
    this.allowedPrograms = options.allowedPrograms ?? E2B_DEFAULT_ALLOWED_PROGRAMS;
    this.networkPolicies = options.networkPolicies ?? E2B_NETWORK_POLICIES;
    this.maxConcurrent = Math.min(
      options.maxConcurrent ?? E2B_SANDBOX_LIMITS.maxConcurrentSandboxes,
      E2B_SANDBOX_LIMITS.maxConcurrentSandboxes,
    );
    this.maxSandboxLifetimeSec = Math.min(
      options.maxSandboxLifetimeSec ?? E2B_SANDBOX_LIMITS.maxSandboxLifetimeSec,
      E2B_SANDBOX_LIMITS.maxSandboxLifetimeSec,
    );
    this.clock = options.clock ?? (() => Date.now());
    this.signal = options.signal;
  }

  get tenant(): Id {
    return this.tenantId;
  }

  capabilities(): Promise<SandboxCapabilities> {
    return Promise.resolve(E2B_CAPABILITIES);
  }

  async create(spec: SandboxSpec): Promise<{ sandboxId: Id }> {
    this.throwIfAborted('create');

    const parsed = SANDBOX_SPEC_SCHEMA.safeParse(spec);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const validated = parsed.data;

    if (validated.tenantId !== this.tenantId) {
      throw new DomainError('POLICY_DENIED', 'sandbox spec tenant does not match provider scope');
    }

    if (validated.restoreRef !== undefined) {
      throw new DomainError('POLICY_DENIED', 'e2b adapter does not implement snapshot restore');
    }

    if (validated.imageDigest !== this.templateDigest) {
      throw new DomainError('POLICY_DENIED', 'sandbox image digest is not the approved template');
    }

    if (validated.maxLifetimeSec > this.maxSandboxLifetimeSec) {
      throw new DomainError(
        'POLICY_DENIED',
        'requested sandbox lifetime exceeds the adapter ceiling',
      );
    }

    const policy = this.networkPolicies[validated.networkPolicyId];

    if (policy === undefined) {
      throw new DomainError('POLICY_DENIED', 'network policy id is not registered in the adapter');
    }

    if (this.liveCount() >= this.maxConcurrent) {
      throw new DomainError('POLICY_DENIED', 'sandbox concurrency ceiling reached');
    }

    if (this.sandboxes.size >= E2B_SANDBOX_LIMITS.maxTrackedSandboxes) {
      throw new DomainError('POLICY_DENIED', 'sandbox tracking table is full');
    }

    const timeoutMs = validated.maxLifetimeSec * 1_000;
    const metadata: Record<string, string> = {
      [E2B_OWNER_METADATA_KEY]: E2B_OWNER_METADATA_VALUE,
      ember_tenant_id: validated.tenantId,
      ember_run_id: validated.runId,
      ember_network_policy: policy.id,
    };

    let handle: { sandboxId: string };

    try {
      handle = await this.client.createSandbox({
        template: this.template,
        timeoutMs,
        metadata,
        allowInternetAccess: policy.allowInternetAccess,
        ...(policy.allowOut === undefined ? {} : { allowOut: policy.allowOut }),
        ...(policy.denyOut === undefined ? {} : { denyOut: policy.denyOut }),
        ...(policy.dnsServers === undefined ? {} : { dnsServers: policy.dnsServers }),
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
    } catch (error) {
      throw mapClientError(error, 'create');
    }

    if (typeof handle.sandboxId !== 'string' || handle.sandboxId.trim() === '') {
      throw new DomainError('SANDBOX_NOT_READY', 'e2b create returned no sandbox id');
    }

    const createdAtMs = this.clock();
    this.sandboxes.set(handle.sandboxId, {
      sandboxId: handle.sandboxId,
      tenantId: validated.tenantId,
      runId: validated.runId,
      spec: Object.freeze({ ...validated }),
      createdAtMs,
      deadlineAtMs: createdAtMs + timeoutMs,
      outputs: new Map<Id, OutputEntry>(),
      outputOrder: [],
      state: 'created',
      readyAtMs: null,
      execCount: 0,
      timedOutExecCount: 0,
      cpuSeconds: 0,
      memoryGiBSeconds: 0,
      measuredCpuCount: null,
      measuredMemoryMiB: null,
      measuredAllowInternetAccess: null,
      usageBasis: null,
      cleanupConfirmed: null,
      lastError: null,
    });

    return Object.freeze({ sandboxId: handle.sandboxId });
  }

  /**
   * Waits for the sandbox to be observable as `running`, then verifies that what the vendor
   * allocated does not exceed the approved spec and that the egress policy actually applied.
   *
   * Verification happens here rather than in `create()` because resource shape and egress
   * state are only knowable from the control plane after allocation. A violation throws
   * `POLICY_DENIED`; the caller's cleanup path owns destruction.
   */
  async waitReady(sandboxId: Id, deadlineMs: number): Promise<void> {
    const record = this.requireRecord(sandboxId);
    this.requireLive(record);
    this.throwIfAborted('waitReady');

    const deadline = this.parseDeadline(deadlineMs);
    const startedAt = this.clock();

    if (record.state === 'ready') {
      return;
    }

    if (record.state === 'stopped') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox was stopped before it became ready');
    }

    for (;;) {
      if (this.clock() - startedAt >= deadline) {
        throw new DomainError('EXECUTION_TIMEOUT', 'e2b readiness deadline exceeded');
      }

      let info: E2bSandboxInfo;

      try {
        info = await this.client.getInfo(record.sandboxId, this.signal);
      } catch (error) {
        throw mapClientError(error, 'getInfo');
      }

      if (info.state === 'running') {
        this.verifyAllocatedSpec(record, info);
        record.state = 'ready';
        record.readyAtMs = this.clock();
        return;
      }

      if (info.state === 'paused') {
        throw new DomainError('SANDBOX_NOT_READY', 'sandbox is paused instead of running');
      }

      await realSleep(Math.min(200, Math.max(0, deadline - (this.clock() - startedAt))));
    }
  }

  async exec(
    sandboxId: Id,
    argv: readonly string[],
    timeoutMs: number,
  ): Promise<SandboxExecResult> {
    const record = this.requireRecord(sandboxId);
    this.requireLive(record);
    this.throwIfAborted('exec');

    if (record.state !== 'ready') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox is not ready for exec');
    }

    const args = validateArgv(argv, { allowedPrograms: this.allowedPrograms });
    const timeout = this.parseExecTimeout(timeoutMs);
    const remainingMs = record.deadlineAtMs - this.clock();

    if (remainingMs <= 0) {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox lifetime expired before exec');
    }

    const effectiveTimeout = Math.min(timeout, remainingMs);
    let result: E2bCommandResult;

    try {
      result = await this.client.runCommand(record.sandboxId, {
        command: renderCommand(args),
        timeoutMs: effectiveTimeout,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
    } catch (error) {
      throw mapClientError(error, 'exec');
    }

    record.execCount += 1;
    if (result.timedOut) {
      record.timedOutExecCount += 1;
    }

    const stdout = this.retainOutput(record, result.stdout, E2B_SANDBOX_LIMITS.maxStdoutBytes);
    const stderr = this.retainOutput(record, result.stderr, E2B_SANDBOX_LIMITS.maxStderrBytes);

    if (result.timedOut) {
      throw new DomainError('EXECUTION_TIMEOUT', 'e2b command exceeded its timeout');
    }

    return Object.freeze({
      exitCode: result.exitCode,
      stdoutRef: stdout.ref,
      stderrRef: stderr.ref,
    });
  }

  readOutput(sandboxId: Id, ref: Id): Promise<string> {
    const record = this.requireRecord(sandboxId);
    this.requireLive(record);
    const validatedRef = parseId(ref, 'ref');
    const entry = record.outputs.get(validatedRef);

    if (entry === undefined) {
      throw new DomainError('NOT_FOUND', 'sandbox output reference is not retained');
    }

    return Promise.resolve(entry.text);
  }

  /** Fail closed: durable transfer requires the Ember ArtifactStore CAS contract. */
  putFile(sandboxId: Id, path: string, artifactRef: Id): Promise<void> {
    this.requireRecord(sandboxId);
    parseId(artifactRef, 'artifactRef');

    if (path.length === 0) {
      return Promise.reject(new InvalidArgumentError([{ path: 'path', code: 'too_small' }]));
    }

    return Promise.reject(
      new DomainError('POLICY_DENIED', 'sandbox file transfer requires the ArtifactStore'),
    );
  }

  /** Fail closed: see {@link putFile}. */
  getFile(sandboxId: Id, path: string): Promise<{ artifactRef: Id }> {
    this.requireRecord(sandboxId);

    if (path.length === 0) {
      return Promise.reject(new InvalidArgumentError([{ path: 'path', code: 'too_small' }]));
    }

    return Promise.reject(
      new DomainError('POLICY_DENIED', 'sandbox file transfer requires the ArtifactStore'),
    );
  }

  /** Explicitly unsupported: no checkpoint store is wired into this adapter. */
  snapshot(): Promise<{ restoreRef: string }> {
    return Promise.reject(
      new DomainError('POLICY_DENIED', 'e2b adapter does not implement snapshot'),
    );
  }

  /** Explicitly unsupported: see {@link snapshot}. */
  resume(): Promise<void> {
    return Promise.reject(
      new DomainError('POLICY_DENIED', 'e2b adapter does not implement resume'),
    );
  }

  /**
   * Graceful stop. E2B has no suspend-to-disk for this adapter's contract, so stop is a
   * `kill` of the microVM. Idempotent: a sandbox already gone is not an error.
   */
  async stop(sandboxId: Id): Promise<void> {
    const record = this.requireRecord(sandboxId);

    if (record.state === 'destroyed' || record.state === 'stopped') {
      return;
    }

    try {
      const killed = await this.client.killSandbox(record.sandboxId, this.signal);
      record.cleanupConfirmed = killed;
      record.state = 'stopped';
    } catch (error) {
      record.lastError = 'stop failed';
      throw mapClientError(error, 'stop');
    }
  }

  /**
   * Idempotent permanent cleanup.
   *
   * Retries the kill when `stop()` did not confirm it, drops all retained output, and marks
   * the record terminal. Local success is **not** evidence of vendor cleanup: use
   * {@link verifyNoLiveSandboxes} for the independent control-plane check.
   */
  async destroy(sandboxId: Id): Promise<void> {
    const record = this.requireRecord(sandboxId);

    if (record.state === 'destroyed') {
      record.outputs.clear();
      record.outputOrder.length = 0;
      return;
    }

    if (record.cleanupConfirmed !== true) {
      try {
        const killed = await this.client.killSandbox(record.sandboxId, this.signal);
        record.cleanupConfirmed = killed;
      } catch (error) {
        record.lastError = 'destroy failed';
        record.state = 'destroyed';
        record.outputs.clear();
        record.outputOrder.length = 0;
        throw mapClientError(error, 'destroy');
      }
    }

    record.state = 'destroyed';
    record.outputs.clear();
    record.outputOrder.length = 0;
  }

  /**
   * Derived usage telemetry.
   *
   * E2B exposes metrics samples, not an invoice, so the figures here are computed from
   * `cpuUsedPct`/`memUsed` integrated over the sample interval. When the vendor returns no
   * samples the adapter falls back to the nominal template shape and says so through
   * {@link usageBasis}. `egressBytes` is always 0: E2B does not expose per-sandbox egress.
   */
  async usage(sandboxId: Id): Promise<SandboxUsageRecord> {
    const record = this.requireRecord(sandboxId);

    if (record.state === 'destroyed') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox has been destroyed');
    }

    let samples: readonly E2bMetricsSample[] = [];

    try {
      samples = await this.client.getMetrics(record.sandboxId);
    } catch {
      samples = [];
    }

    const integrated = integrateUsage(samples);

    if (integrated !== null) {
      record.usageBasis = 'VENDOR_METRICS';
      record.cpuSeconds = integrated.cpuSeconds;
      record.memoryGiBSeconds = integrated.memoryGiBSeconds;
    } else {
      record.usageBasis = 'NOMINAL_TEMPLATE';
      const wallSeconds = Math.max(0, (this.clock() - record.createdAtMs) / 1_000);
      const cpuCount = record.measuredCpuCount ?? 1;
      const memoryMiB = record.measuredMemoryMiB ?? record.spec.memoryMiB;
      record.cpuSeconds = cpuCount * wallSeconds;
      record.memoryGiBSeconds = (memoryMiB / 1_024) * wallSeconds;
    }

    return Object.freeze({
      cpuSeconds: record.cpuSeconds,
      memoryGiBSeconds: record.memoryGiBSeconds,
      egressBytes: 0,
    });
  }

  /** Provenance of the most recent `usage()` figure. */
  usageBasis(sandboxId: Id): E2bUsageBasis | null {
    return this.requireRecord(sandboxId).usageBasis;
  }

  /** Lifecycle state of a tracked sandbox. */
  sandboxState(sandboxId: Id): E2bSandboxState | null {
    const record = this.sandboxes.get(sandboxId);
    return record === undefined ? null : record.state;
  }

  /** Locally tracked, non-destroyed sandboxes. */
  liveSandboxCount(): number {
    return this.liveCount();
  }

  /** Measured allocation of a sandbox, or `null` before readiness verification. */
  measuredResources(sandboxId: Id): {
    readonly cpuCount: number | null;
    readonly memoryMiB: number | null;
    readonly allowInternetAccess: boolean | null;
  } {
    const record = this.requireRecord(sandboxId);
    return {
      cpuCount: record.measuredCpuCount,
      memoryMiB: record.measuredMemoryMiB,
      allowInternetAccess: record.measuredAllowInternetAccess,
    };
  }

  /** Exec counters used by the smoke harness. */
  execStats(sandboxId: Id): { readonly execCount: number; readonly timedOut: number } {
    const record = this.requireRecord(sandboxId);
    return { execCount: record.execCount, timedOut: record.timedOutExecCount };
  }

  /**
   * Independent cleanup audit against the vendor control plane.
   *
   * This is the only method here that can support a `VERIFIED_CLEAN` claim: it asks E2B which
   * sandboxes still exist for this owner/run, rather than trusting local bookkeeping.
   */
  async verifyNoLiveSandboxes(extraMetadata: Readonly<Record<string, string>> = {}): Promise<{
    readonly liveSandboxIds: readonly string[];
    readonly checkedMetadata: Record<string, string>;
  }> {
    const metadata = {
      [E2B_OWNER_METADATA_KEY]: E2B_OWNER_METADATA_VALUE,
      ...extraMetadata,
    };

    const live = await this.client.listSandboxes({ metadata, states: ['running', 'paused'] });

    return {
      liveSandboxIds: Object.freeze(live.map((info) => info.sandboxId)),
      checkedMetadata: metadata,
    };
  }

  /** Kills every sandbox tagged as owned by this adapter generation. Returns killed ids. */
  async sweepOrphanedSandboxes(): Promise<readonly string[]> {
    const { liveSandboxIds } = await this.verifyNoLiveSandboxes();
    const killed: string[] = [];

    for (const sandboxId of liveSandboxIds) {
      try {
        if (await this.client.killSandbox(sandboxId, this.signal)) {
          killed.push(sandboxId);
        }
      } catch {
        // Best-effort: a single failure must not abort the sweep.
      }
    }

    return Object.freeze(killed);
  }

  /**
   * PoC-only text file transfer, confined to {@link workspaceRoot}.
   *
   * Deliberately NOT part of `SandboxProvider`: the contract's `putFile`/`getFile` are keyed by
   * ArtifactStore references, and this method bypasses that. It exists so the smoke harness can
   * prove the adapter's file path without inventing a fake artifact store.
   */
  async putTextFile(sandboxId: Id, relativePath: string, content: string): Promise<void> {
    const record = this.requireRecord(sandboxId);
    this.requireLive(record);

    if (record.state !== 'ready') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox is not ready for file transfer');
    }

    const resolved = resolveConfinedPath(this.workspaceRoot, relativePath);
    const bytes = utf8ByteLength(content);

    if (bytes > E2B_SANDBOX_LIMITS.maxFileBytes) {
      throw new InvalidArgumentError([{ path: 'content', code: 'too_big' }]);
    }

    try {
      await this.client.writeFile(record.sandboxId, resolved, content);
    } catch (error) {
      throw mapClientError(error, 'writeFile');
    }
  }

  /** PoC-only text file read, confined to {@link workspaceRoot}. */
  async getTextFile(sandboxId: Id, relativePath: string): Promise<string> {
    const record = this.requireRecord(sandboxId);
    this.requireLive(record);

    if (record.state !== 'ready') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox is not ready for file transfer');
    }

    const resolved = resolveConfinedPath(this.workspaceRoot, relativePath);

    try {
      const content = await this.client.readFile(record.sandboxId, resolved);

      if (utf8ByteLength(content) > E2B_SANDBOX_LIMITS.maxFileBytes) {
        throw new InvalidArgumentError([{ path: 'content', code: 'too_big' }]);
      }

      return content;
    } catch (error) {
      throw mapClientError(error, 'readFile');
    }
  }

  private verifyAllocatedSpec(record: E2bSandboxRecord, info: E2bSandboxInfo): void {
    record.measuredCpuCount = info.cpuCount;
    record.measuredMemoryMiB = info.memoryMiB;
    record.measuredAllowInternetAccess = info.allowInternetAccess;

    const allocatedCpuMilli = info.cpuCount * 1_000;

    if (allocatedCpuMilli > record.spec.cpuMilli) {
      throw new DomainError('POLICY_DENIED', 'allocated cpu exceeds the approved sandbox spec');
    }

    if (info.memoryMiB > record.spec.memoryMiB) {
      throw new DomainError('POLICY_DENIED', 'allocated memory exceeds the approved sandbox spec');
    }

    const policy = this.networkPolicies[record.spec.networkPolicyId];

    if (policy === undefined) {
      throw new DomainError('POLICY_DENIED', 'network policy disappeared during readiness');
    }

    // A sandbox created with egress denied must not report internet access as enabled. This is
    // the check that would catch a silently ignored `allowInternetAccess: false`.
    if (!policy.allowInternetAccess && info.allowInternetAccess === true) {
      throw new DomainError('POLICY_DENIED', 'sandbox egress policy was not applied as requested');
    }
  }

  private retainOutput(record: E2bSandboxRecord, value: string, maxBytes: number): OutputEntry {
    const truncated = truncateUtf8(value, maxBytes);
    const ref = randomUUID() as Id;
    const entry: OutputEntry = { ref, text: truncated.text, truncated: truncated.truncated };

    record.outputs.set(ref, entry);
    record.outputOrder.push(ref);

    while (record.outputOrder.length > E2B_SANDBOX_LIMITS.maxRetainedOutputsPerSandbox) {
      const evicted = record.outputOrder.shift();

      if (evicted !== undefined) {
        record.outputs.delete(evicted);
      }
    }

    return entry;
  }

  private parseDeadline(deadlineMs: number): number {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
      throw new InvalidArgumentError([{ path: 'deadlineMs', code: 'invalid_type' }]);
    }

    return Math.min(deadlineMs, E2B_SANDBOX_LIMITS.maxReadyDeadlineMs);
  }

  private parseExecTimeout(timeoutMs: number): number {
    if (!Number.isSafeInteger(timeoutMs)) {
      throw new InvalidArgumentError([{ path: 'timeoutMs', code: 'invalid_type' }]);
    }

    if (timeoutMs < E2B_SANDBOX_LIMITS.minExecTimeoutMs) {
      throw new InvalidArgumentError([{ path: 'timeoutMs', code: 'too_small' }]);
    }

    return Math.min(timeoutMs, E2B_SANDBOX_LIMITS.maxExecTimeoutMs);
  }

  private throwIfAborted(phase: string): void {
    if (this.signal?.aborted === true) {
      throw new DomainError('CANCELLED', `e2b ${phase} cancelled by caller signal`);
    }
  }

  private liveCount(): number {
    let count = 0;

    for (const record of this.sandboxes.values()) {
      if (record.state !== 'destroyed') {
        count += 1;
      }
    }

    return count;
  }

  private requireRecord(sandboxId: Id): E2bSandboxRecord {
    // E2B sandbox ids are opaque alphanumeric handles, not UUIDs, so the `Id` type is only
    // structurally satisfied. Validate the shape we can actually rely on instead of rejecting
    // every real id with a UUID rule.
    if (
      typeof sandboxId !== 'string' ||
      sandboxId.length === 0 ||
      sandboxId.length > 64 ||
      !/^[A-Za-z0-9_-]+$/.test(sandboxId)
    ) {
      throw new InvalidArgumentError([{ path: 'sandboxId', code: 'invalid_sandbox_id' }]);
    }

    const record = this.sandboxes.get(sandboxId);

    if (record === undefined) {
      throw new DomainError('NOT_FOUND', 'sandbox is not visible in this provider instance');
    }

    return record;
  }

  private requireLive(record: E2bSandboxRecord): void {
    if (record.state === 'destroyed') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox has been destroyed');
    }

    if (this.clock() >= record.deadlineAtMs) {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox lifetime has expired');
    }
  }
}

/**
 * Integrates vendor metric samples into cpu/memory-second totals.
 *
 * Returns `null` when fewer than two samples exist: a single sample carries no interval, and
 * inventing one would produce a fabricated measurement.
 */
export function integrateUsage(
  samples: readonly E2bMetricsSample[],
): { readonly cpuSeconds: number; readonly memoryGiBSeconds: number } | null {
  if (samples.length < 2) {
    return null;
  }

  const ordered = [...samples].sort((a, b) => a.timestampMs - b.timestampMs);
  let cpuSeconds = 0;
  let memoryGiBSeconds = 0;

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];

    if (previous === undefined || current === undefined) {
      continue;
    }

    const deltaSec = Math.max(0, (current.timestampMs - previous.timestampMs) / 1_000);

    if (deltaSec === 0) {
      continue;
    }

    cpuSeconds += (current.cpuUsedPct / 100) * deltaSec;
    memoryGiBSeconds += (current.memUsedBytes / 1024 ** 3) * deltaSec;
  }

  return {
    cpuSeconds: Math.round(cpuSeconds * 1_000) / 1_000,
    memoryGiBSeconds: Math.round(memoryGiBSeconds * 1_000) / 1_000,
  };
}

export interface E2BSandboxFactoryOptions extends Omit<E2BSandboxProviderOptions, 'tenantId'> {
  readonly onProvider?: (provider: E2BSandboxProvider) => void;
}

/** Run-scoped factory. Each Run gets its own provider instance and therefore its own cap. */
export class E2BSandboxProviderFactory implements SandboxProviderFactory {
  private readonly options: E2BSandboxFactoryOptions;

  constructor(options: E2BSandboxFactoryOptions) {
    this.options = options;
  }

  createProvider(context: {
    tenantId: Id;
    runId: Id;
    signal: AbortSignal;
  }): Promise<SandboxProvider> {
    const provider = new E2BSandboxProvider({
      ...this.options,
      tenantId: context.tenantId,
      signal: context.signal,
    });
    this.options.onProvider?.(provider);
    return Promise.resolve(provider);
  }
}
