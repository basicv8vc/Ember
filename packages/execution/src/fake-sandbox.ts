import { IdSchema, toInvalidArgumentError } from '@ember/contracts';
import type {
  SandboxCapabilities,
  SandboxExecResult,
  SandboxProvider,
  SandboxSpec,
  SandboxUsageRecord,
} from '@ember/contracts';
import { DomainError, InvalidArgumentError, type Id } from '@ember/domain';
import { z } from 'zod';
import {
  parseBoundedTimeoutMs,
  parseDelayMs,
  parseExecutionNow,
  realSleeper,
  systemExecutionClock,
  throwIfAborted,
  type ExecutionClock,
  type Sleeper,
} from './clock.js';
import { simulatedId } from './crypto.js';
import { computeSha256 } from './mock-compute.js';

/** Image digest of the in-memory simulation. No container or VM exists. */
export const FAKE_SANDBOX_IMAGE_DIGEST = 'sha256:ember-fake-sandbox-v1';

/** Deterministic operations the simulation is willing to perform. Nothing else is executed. */
export const FAKE_SANDBOX_OPERATIONS = ['sha256'] as const;

export type FakeSandboxOperation = (typeof FAKE_SANDBOX_OPERATIONS)[number];

export const FAKE_SANDBOX_LIMITS = Object.freeze({
  maxArgvLength: 8,
  maxArgChars: 64_000,
  maxLiveSandboxes: 32,
  maxTimeoutMs: 60_000,
  maxDelayMs: 5_000,
  /** Simulated CPU/memory accounting per exec; the value is a fixed, documented constant. */
  defaultExecDurationMs: 1,
});

/** Simulated lifecycle states. `destroyed` is terminal. */
export type FakeSandboxState = 'created' | 'ready' | 'stopped' | 'destroyed';

const SANDBOX_SPEC_SCHEMA = z.strictObject({
  tenantId: IdSchema,
  runId: IdSchema,
  /** Any provider image digest; the simulation never pulls or runs an image. */
  imageDigest: z.string().min(1).max(160),
  cpuMilli: z.number().int().min(50).max(4_000),
  memoryMiB: z.number().int().min(32).max(8_192),
  maxLifetimeSec: z.number().int().min(1).max(3_600),
  networkPolicyId: z.string().min(1).max(128),
  restoreRef: z.string().min(1).max(160).optional(),
});

const ARGV_SCHEMA = z
  .array(z.string().max(FAKE_SANDBOX_LIMITS.maxArgChars))
  .min(1)
  .max(FAKE_SANDBOX_LIMITS.maxArgvLength);

const LOGICAL_PATH_SCHEMA = z.string().min(1).max(512);

function parseSandboxId(value: Id): Id {
  const parsed = IdSchema.safeParse(value);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

function parseArgv(argv: readonly string[]): readonly string[] {
  const parsed = ARGV_SCHEMA.safeParse(argv);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  for (const argument of parsed.data) {
    if (argument.includes('\u0000')) {
      // A NUL byte cannot be represented in a real argv; reject it here as well.
      throw new InvalidArgumentError([{ path: 'argv', code: 'invalid_character' }]);
    }
  }

  return Object.freeze([...parsed.data]);
}

interface FakeSandboxRecord {
  readonly sandboxId: Id;
  readonly tenantId: Id;
  readonly runId: Id;
  readonly imageDigest: string;
  readonly cpuMilli: number;
  readonly memoryMiB: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  state: FakeSandboxState;
  readyAt: Date | null;
  execCount: number;
  cpuSeconds: number;
  memoryGiBSeconds: number;
  egressBytes: number;
  /** In-memory simulation output. Deliberately dropped on destroy and never durable. */
  readonly outputs: Map<Id, string>;
}

export interface FakeSandboxProviderOptions {
  /** Trusted tenant scope of this provider instance. Every operation is confined to it. */
  readonly tenantId: Id;
  readonly clock?: ExecutionClock;
  readonly sleep?: Sleeper;
  /** When aborted, in-flight simulated work stops with `CANCELLED` and new work is refused. */
  readonly signal?: AbortSignal;
  /** Simulated readiness latency. */
  readonly readyDelayMs?: number;
  /** Simulated exec duration; also the basis of the simulated usage counters. */
  readonly execDurationMs?: number;
}

const UNAVAILABLE_CAPABILITIES: SandboxCapabilities = Object.freeze({
  shell: false,
  browser: false,
  filesystemSnapshot: false,
  memoryResume: false,
  diskSurvivesStop: false,
  forkFromSnapshot: false,
  persistentVolume: false,
  networkPolicy: false,
});

/**
 * In-memory, deterministic `SandboxProvider`.
 *
 * It implements the lifecycle (create → waitReady → exec → stop → destroy) for one tenant
 * and performs **only** allowlisted simulations. There is no container, VM, shell, Python,
 * browser, network socket or filesystem access anywhere in this class; the only host
 * primitive used is in-process SHA-256 hashing.
 *
 * Isolation here is process-memory isolation between sandbox records. It is **not** evidence
 * of container, VM or cloud sandbox isolation.
 */
export class FakeSandboxProvider implements SandboxProvider {
  private readonly tenantId: Id;
  private readonly clock: ExecutionClock;
  private readonly sleep: Sleeper;
  private readonly signal: AbortSignal | undefined;
  private readonly readyDelayMs: number;
  private readonly execDurationMs: number;
  private readonly sandboxes = new Map<Id, FakeSandboxRecord>();

  constructor(options: FakeSandboxProviderOptions) {
    const tenant = IdSchema.safeParse(options.tenantId);

    if (!tenant.success) {
      throw toInvalidArgumentError(tenant.error);
    }

    this.tenantId = tenant.data;
    this.clock = options.clock ?? systemExecutionClock;
    this.sleep = options.sleep ?? realSleeper;
    this.signal = options.signal;
    this.readyDelayMs = parseDelayMs(
      options.readyDelayMs,
      'readyDelayMs',
      FAKE_SANDBOX_LIMITS.maxDelayMs,
    );
    this.execDurationMs = parseDelayMs(
      options.execDurationMs,
      'execDurationMs',
      FAKE_SANDBOX_LIMITS.maxDelayMs,
      FAKE_SANDBOX_LIMITS.defaultExecDurationMs,
    );
  }

  /** Tenant this provider instance is scoped to. */
  get tenant(): Id {
    return this.tenantId;
  }

  /**
   * Every optional capability is reported as unsupported.
   *
   * `false` is an explicit statement: the simulation has no shell, browser, snapshot,
   * resume, persistent volume or network policy enforcement, and its disk does not survive
   * `stop()`.
   */
  capabilities(): Promise<SandboxCapabilities> {
    return Promise.resolve(UNAVAILABLE_CAPABILITIES);
  }

  create(spec: SandboxSpec): Promise<{ sandboxId: Id }> {
    // Async on purpose: every validation failure is reported as a rejected promise, matching
    // the `SandboxProvider` contract, so callers can rely on one failure mode.
    return Promise.resolve().then(() => this.createNow(spec));
  }

  private createNow(spec: SandboxSpec): { sandboxId: Id } {
    throwIfAborted(this.signal);

    const parsed = SANDBOX_SPEC_SCHEMA.safeParse(spec);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const validated = parsed.data;

    // A provider instance is confined to the tenant it was created for. A caller that tries
    // to create a sandbox for another tenant is denied, never silently re-scoped.
    if (validated.tenantId !== this.tenantId) {
      throw new DomainError(
        'POLICY_DENIED',
        'sandbox spec tenant does not match the provider tenant scope',
      );
    }

    if (validated.restoreRef !== undefined) {
      throw new DomainError(
        'POLICY_DENIED',
        'FakeSandbox cannot restore from a snapshot; snapshot/resume are unsupported',
      );
    }

    if (this.liveCount() >= FAKE_SANDBOX_LIMITS.maxLiveSandboxes) {
      throw new DomainError('POLICY_DENIED', 'simulated sandbox limit reached for this tenant');
    }

    const createdAt = parseExecutionNow(this.clock.now(), 'clock.now()');
    const sandboxId = simulatedId(
      'fake-sandbox',
      this.tenantId,
      validated.runId,
      createdAt.toISOString(),
    );

    if (this.sandboxes.has(sandboxId)) {
      // The clock and run alone decide the id; a duplicate means the same run already owns a
      // sandbox. Reject instead of silently returning a second, unaccounted sandbox.
      throw new DomainError('POLICY_DENIED', 'a sandbox already exists for this run');
    }

    this.sandboxes.set(sandboxId, {
      sandboxId,
      tenantId: this.tenantId,
      runId: validated.runId,
      imageDigest: validated.imageDigest,
      cpuMilli: validated.cpuMilli,
      memoryMiB: validated.memoryMiB,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + validated.maxLifetimeSec * 1_000),
      state: 'created',
      readyAt: null,
      execCount: 0,
      cpuSeconds: 0,
      memoryGiBSeconds: 0,
      egressBytes: 0,
      outputs: new Map<Id, string>(),
    });

    return Object.freeze({ sandboxId });
  }

  async waitReady(sandboxId: Id, deadlineMs: number): Promise<void> {
    const record = this.requireRecord(sandboxId);
    this.requireLive(record);
    throwIfAborted(this.signal);

    const deadline = parseBoundedTimeoutMs(
      deadlineMs,
      'deadlineMs',
      FAKE_SANDBOX_LIMITS.maxTimeoutMs,
    );

    if (record.state === 'ready') {
      // Idempotent: repeated readiness checks do not restart or extend the sandbox.
      return;
    }

    if (record.state === 'stopped') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox was stopped and cannot become ready');
    }

    if (this.readyDelayMs >= deadline) {
      throw new DomainError(
        'EXECUTION_TIMEOUT',
        'simulated sandbox readiness exceeded its deadline',
      );
    }

    await this.sleep(this.readyDelayMs, this.signal);
    throwIfAborted(this.signal);

    const current = this.requireRecord(sandboxId);
    this.requireLive(current);

    if (current.state !== 'created') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox left its created state during startup');
    }

    current.state = 'ready';
    current.readyAt = parseExecutionNow(this.clock.now(), 'clock.now()');
  }

  /**
   * Execute one allowlisted simulation.
   *
   * The argv is validated *before* any state changes, so an unknown command leaves the
   * sandbox untouched: no host code runs, no file is read, no socket is opened and no usage
   * is recorded. Only `sha256 <text>` is supported; every other command is denied.
   */
  async exec(
    sandboxId: Id,
    argv: readonly string[],
    timeoutMs: number,
  ): Promise<SandboxExecResult> {
    const record = this.requireRecord(sandboxId);
    this.requireLive(record);
    throwIfAborted(this.signal);

    if (record.state !== 'ready') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox is not ready for exec');
    }

    const args = parseArgv(argv);
    const timeout = parseBoundedTimeoutMs(timeoutMs, 'timeoutMs', FAKE_SANDBOX_LIMITS.maxTimeoutMs);
    const [operation, ...operands] = args;

    if (operation === undefined) {
      throw new InvalidArgumentError([{ path: 'argv', code: 'too_small' }]);
    }

    if (!(FAKE_SANDBOX_OPERATIONS as readonly string[]).includes(operation)) {
      throw new DomainError('POLICY_DENIED', 'command is not on the sandbox simulation allowlist');
    }

    if (operands.length !== 1) {
      throw new InvalidArgumentError([{ path: 'argv', code: 'invalid_operand_count' }]);
    }

    if (this.execDurationMs >= timeout) {
      throw new DomainError('EXECUTION_TIMEOUT', 'simulated exec exceeded its timeout');
    }

    await this.sleep(this.execDurationMs, this.signal);
    throwIfAborted(this.signal);

    const text = operands[0] ?? '';
    const digest = computeSha256(text).value;
    const stdoutRef = simulatedId('sandbox-stdout', record.sandboxId, operation, digest);
    const stderrRef = simulatedId('sandbox-stderr', record.sandboxId, operation, digest);

    record.execCount += 1;
    const seconds = this.execDurationMs / 1_000;
    record.cpuSeconds += seconds;
    record.memoryGiBSeconds += (record.memoryMiB / 1_024) * seconds;
    // No network egress is possible, so the simulated counter never grows.
    record.outputs.set(stdoutRef, digest);
    record.outputs.set(stderrRef, '');

    return Object.freeze({ exitCode: 0, stdoutRef, stderrRef });
  }

  /**
   * Read a simulated stdout/stderr handle produced by {@link exec}.
   *
   * This is an in-memory lookup, not an ArtifactStore read. The reference is opaque, belongs
   * to one sandbox and is dropped on destroy.
   */
  readOutput(sandboxId: Id, ref: Id): Promise<string> {
    const record = this.requireRecord(sandboxId);
    this.requireLive(record);
    const validatedRef = parseSandboxId(ref);
    const value = record.outputs.get(validatedRef);

    if (value === undefined) {
      throw new DomainError('NOT_FOUND', 'simulated sandbox output is not available');
    }

    return Promise.resolve(value);
  }

  /**
   * Reject file transfer fail-closed.
   *
   * Durable file content requires the ArtifactStore/Workspace CAS contract that lands in
   * P0B-06. Returning success here without that contract would fake persistence.
   */
  putFile(sandboxId: Id, path: string, artifactRef: Id): Promise<void> {
    this.requireRecord(sandboxId);
    const validatedPath = LOGICAL_PATH_SCHEMA.safeParse(path);

    if (!validatedPath.success) {
      return Promise.reject(toInvalidArgumentError(validatedPath.error));
    }

    parseSandboxId(artifactRef);

    return Promise.reject(
      new DomainError('POLICY_DENIED', 'sandbox file transfer requires the P0B-06 ArtifactStore'),
    );
  }

  /** Reject file transfer fail-closed; see {@link putFile}. */
  getFile(sandboxId: Id, path: string): Promise<{ artifactRef: Id }> {
    this.requireRecord(sandboxId);
    const validatedPath = LOGICAL_PATH_SCHEMA.safeParse(path);

    if (!validatedPath.success) {
      return Promise.reject(toInvalidArgumentError(validatedPath.error));
    }

    return Promise.reject(
      new DomainError('POLICY_DENIED', 'sandbox file transfer requires the P0B-06 ArtifactStore'),
    );
  }

  /** Explicitly unsupported: no checkpoint store exists before P0B-06. */
  snapshot(sandboxId: Id): Promise<{ restoreRef: string }> {
    const record = this.requireRecord(sandboxId);
    this.requireLive(record);

    return Promise.reject(
      new DomainError('POLICY_DENIED', 'FakeSandbox does not implement snapshot'),
    );
  }

  /** Explicitly unsupported: no checkpoint store exists before P0B-06. */
  resume(sandboxId: Id): Promise<void> {
    const record = this.requireRecord(sandboxId);
    this.requireLive(record);

    return Promise.reject(
      new DomainError('POLICY_DENIED', 'FakeSandbox does not implement resume'),
    );
  }

  /** Stop the simulation. Repeating it is an idempotent no-op. */
  stop(sandboxId: Id): Promise<void> {
    const record = this.requireRecord(sandboxId);

    if (record.state === 'created' || record.state === 'ready') {
      record.state = 'stopped';
    }

    return Promise.resolve();
  }

  /** Destroy the simulation and drop its in-memory output. Repeating it is a no-op. */
  destroy(sandboxId: Id): Promise<void> {
    const record = this.requireRecord(sandboxId);

    if (record.state !== 'destroyed') {
      record.state = 'destroyed';
    }

    record.outputs.clear();

    return Promise.resolve();
  }

  /** Simulated resource accounting. Frozen copy; never durable telemetry. */
  usage(sandboxId: Id): Promise<SandboxUsageRecord> {
    const record = this.requireRecord(sandboxId);
    this.requireLive(record);

    return Promise.resolve(
      Object.freeze({
        cpuSeconds: record.cpuSeconds,
        memoryGiBSeconds: record.memoryGiBSeconds,
        egressBytes: record.egressBytes,
      }),
    );
  }

  /** Number of non-destroyed sandboxes currently tracked by this provider instance. */
  liveSandboxCount(): number {
    return this.liveCount();
  }

  /** Current lifecycle state of a sandbox in this provider, or `null` if unknown. */
  sandboxState(sandboxId: Id): FakeSandboxState | null {
    const record = this.sandboxes.get(sandboxId);
    return record === undefined ? null : record.state;
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

  private requireRecord(sandboxId: Id): FakeSandboxRecord {
    const validatedId = parseSandboxId(sandboxId);
    const record = this.sandboxes.get(validatedId);

    if (record === undefined) {
      // A sandbox from another tenant is indistinguishable from a missing one.
      throw new DomainError('NOT_FOUND', 'sandbox is not visible in this provider');
    }

    return record;
  }

  private requireLive(record: FakeSandboxRecord): void {
    if (record.state === 'destroyed') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox has been destroyed');
    }

    const now = parseExecutionNow(this.clock.now(), 'clock.now()');

    if (now.getTime() >= record.expiresAt.getTime()) {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox lifetime has expired');
    }
  }
}
