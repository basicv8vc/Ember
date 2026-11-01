import type {
  SandboxAdapterOptions,
  SandboxCapabilities,
  SandboxExecResult,
  SandboxProvider,
  SandboxSpec,
  SandboxUsageRecord,
} from '@ember/contracts';
import { DomainError, type Id, isDomainError } from '@ember/domain';
import { parseBoundedTimeoutMs, throwIfAborted } from './clock.js';

const ADAPTER_TIMEOUT_BRAND = Symbol('AdapterTimeoutBrand');
const ADAPTER_ABORT_BRAND = Symbol('AdapterAbortBrand');

export type SandboxAdapterState = 'created' | 'ready' | 'executed' | 'stopped' | 'destroyed';

/**
 * Options for executing a full sandbox lifecycle run.
 */
export interface SandboxRunOptions {
  readonly spec: SandboxSpec;
  readonly argv: readonly string[];
  readonly signal?: AbortSignal;
  readonly readyDeadlineMs?: number;
  readonly execTimeoutMs?: number;
  readonly beforeExec?: (sandboxId: Id) => Promise<void> | void;
}

/**
 * Result of a full sandbox lifecycle run.
 */
export interface SandboxRunResult {
  readonly sandboxId: Id;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly digest: string;
  readonly usage: SandboxUsageRecord;
}

const VALID_ADAPTER_PHASES = new Set([
  'capabilities',
  'create',
  'waitReady',
  'exec',
  'readOutput',
  'usage',
  'stop',
  'destroy',
]);

function resolveSafePhase(phase: string): string {
  const trimmed = typeof phase === 'string' ? phase.trim() : '';
  return VALID_ADAPTER_PHASES.has(trimmed) ? trimmed : 'unknown_phase';
}

/**
 * Sanitizes untrusted errors originating from a concrete SandboxProvider.
 *
 * Security Invariants:
 * 1. An untrusted provider exception is NEVER allowed to reflect raw error messages,
 *    stack traces, or injected secrets/tokens into public error messages, diagnostic,
 *    or serialized JSON representations.
 * 2. An untrusted provider exception cannot spoof an internal adapter timeout
 *    (e.g., by throwing EXECUTION_TIMEOUT or ERR_PHASE_TIMEOUT).
 * 3. Legitimate DomainErrors (e.g. POLICY_DENIED, EXECUTION_TIMEOUT) preserve their error code,
 *    but their diagnostic is replaced with safe static text, completely discarding provider internals.
 * 4. The returned DomainError is ALWAYS a newly instantiated instance whose message,
 *    diagnostic, and stack trace originate within the trusted boundary.
 */
export function sanitizeProviderError(err: unknown, phase: string): DomainError {
  const safePhase = resolveSafePhase(phase);

  if (isDomainError(err)) {
    if (err.code === 'CANCELLED') {
      return new DomainError('CANCELLED', `simulated execution was cancelled during ${safePhase}`);
    }
    // For valid DomainErrors (e.g. EXECUTION_TIMEOUT, POLICY_DENIED, INVALID_ARGUMENT),
    // preserve the code, but sanitize the diagnostic to prevent reflecting arbitrary strings from provider.
    return new DomainError(err.code, `sandbox provider rejected operation during ${safePhase}`);
  }

  return new DomainError(
    'SANDBOX_NOT_READY',
    `sandbox provider operation failed during ${safePhase}`,
  );
}

/**
 * Internal race guard that bounds asynchronous operations by a wall-clock timeout and abort signal.
 */
async function withBoundedTimeout<T>(
  action: () => Promise<T>,
  timeoutMs: number,
  phase: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    const abortErr = new DomainError('CANCELLED', 'simulated execution was aborted by its caller');
    (abortErr as unknown as Record<symbol, boolean>)[ADAPTER_ABORT_BRAND] = true;
    throw abortErr;
  }

  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeoutErr = new DomainError(
        'EXECUTION_TIMEOUT',
        `sandbox ${phase} exceeded timeout of ${timeoutMs}ms`,
      );
      (timeoutErr as unknown as Record<symbol, boolean>)[ADAPTER_TIMEOUT_BRAND] = true;
      reject(timeoutErr);
    }, timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (signal) {
      abortHandler = () => {
        const abortErr = new DomainError(
          'CANCELLED',
          'simulated execution was aborted by its caller',
        );
        (abortErr as unknown as Record<symbol, boolean>)[ADAPTER_ABORT_BRAND] = true;
        reject(abortErr);
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });

  try {
    return await Promise.race([action(), timeoutPromise, abortPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal !== undefined && abortHandler !== undefined) {
      signal.removeEventListener('abort', abortHandler);
    }
  }
}

/**
 * Provider-neutral Sandbox Runtime Adapter.
 *
 * Enforces:
 * 1. Lifecycle state transitions: create ➔ waitReady ➔ exec ➔ readOutput ➔ usage ➔ stop ➔ destroy.
 * 2. Bounded timeouts across all operations with AbortSignal cancellation propagation.
 * 3. Fail-closed error sanitization maintaining the trust boundary against untrusted provider outputs.
 * 4. Independent resource verification hooks.
 */
export class SandboxAdapter implements SandboxProvider {
  private readonly provider: SandboxProvider;
  private readonly readyDeadlineMs: number;
  private readonly execTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly states = new Map<Id, SandboxAdapterState>();

  constructor(provider: SandboxProvider, options: SandboxAdapterOptions = {}) {
    this.provider = provider;
    this.readyDeadlineMs = parseBoundedTimeoutMs(
      options.readyDeadlineMs ?? 5_000,
      'readyDeadlineMs',
      60_000,
    );
    this.execTimeoutMs = parseBoundedTimeoutMs(
      options.execTimeoutMs ?? 10_000,
      'execTimeoutMs',
      60_000,
    );
    this.cleanupTimeoutMs = parseBoundedTimeoutMs(
      options.cleanupTimeoutMs ?? 5_000,
      'cleanupTimeoutMs',
      60_000,
    );
  }

  /**
   * Reference to the underlying SandboxProvider.
   */
  get underlyingProvider(): SandboxProvider {
    return this.provider;
  }

  async capabilities(signal?: AbortSignal): Promise<SandboxCapabilities> {
    throwIfAborted(signal);
    return this.invokeGuarded(
      () => this.provider.capabilities(),
      Math.min(this.execTimeoutMs, 5_000),
      'capabilities',
      signal,
    );
  }

  async create(spec: SandboxSpec, signal?: AbortSignal): Promise<{ sandboxId: Id }> {
    throwIfAborted(signal);

    const result = await this.invokeGuarded(
      () => this.provider.create(spec),
      Math.min(this.execTimeoutMs, 5_000),
      'create',
      signal,
    );

    if (
      result === null ||
      result === undefined ||
      typeof result.sandboxId !== 'string' ||
      result.sandboxId.length === 0
    ) {
      throw new DomainError('SANDBOX_NOT_READY', 'provider failed to return a valid sandboxId');
    }

    this.states.set(result.sandboxId, 'created');
    return Object.freeze({ sandboxId: result.sandboxId });
  }

  async waitReady(sandboxId: Id, deadlineMs?: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const currentState = this.states.get(sandboxId);

    if (currentState === undefined || (currentState !== 'created' && currentState !== 'ready')) {
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        'sandbox must be in created state before waitReady',
      );
    }

    if (currentState === 'ready') {
      return; // Idempotent
    }

    const timeout = parseBoundedTimeoutMs(deadlineMs ?? this.readyDeadlineMs, 'deadlineMs', 60_000);

    await this.invokeGuarded(
      () => this.provider.waitReady(sandboxId, timeout),
      timeout,
      'waitReady',
      signal,
    );

    this.states.set(sandboxId, 'ready');
  }

  async exec(
    sandboxId: Id,
    argv: readonly string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    throwIfAborted(signal);
    const currentState = this.states.get(sandboxId);

    if (currentState !== 'ready' && currentState !== 'executed') {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox is not ready for exec');
    }

    const timeout = parseBoundedTimeoutMs(timeoutMs ?? this.execTimeoutMs, 'timeoutMs', 60_000);

    const result = await this.invokeGuarded(
      () => this.provider.exec(sandboxId, argv, timeout),
      timeout,
      'exec',
      signal,
    );

    this.states.set(sandboxId, 'executed');
    return Object.freeze({
      exitCode: result.exitCode,
      stdoutRef: result.stdoutRef,
      stderrRef: result.stderrRef,
    });
  }

  async readOutput(sandboxId: Id, ref: Id, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const currentState = this.states.get(sandboxId);

    if (currentState !== 'executed') {
      throw new DomainError('SANDBOX_NOT_READY', 'cannot read output before exec has completed');
    }

    return this.invokeGuarded(
      () => this.provider.readOutput(sandboxId, ref),
      Math.min(this.execTimeoutMs, 5_000),
      'readOutput',
      signal,
    );
  }

  async usage(sandboxId: Id, signal?: AbortSignal): Promise<SandboxUsageRecord> {
    throwIfAborted(signal);
    const currentState = this.states.get(sandboxId);

    if (currentState === 'destroyed') {
      throw new DomainError('SANDBOX_NOT_READY', 'cannot read usage after destroy');
    }

    const record = await this.invokeGuarded(
      () => this.provider.usage(sandboxId),
      Math.min(this.execTimeoutMs, 5_000),
      'usage',
      signal,
    );

    if (
      !Number.isFinite(record.cpuSeconds) ||
      record.cpuSeconds < 0 ||
      !Number.isFinite(record.memoryGiBSeconds) ||
      record.memoryGiBSeconds < 0 ||
      !Number.isFinite(record.egressBytes) ||
      record.egressBytes < 0
    ) {
      throw new DomainError(
        'SANDBOX_NOT_READY',
        'sandbox usage returned non-finite or negative metrics',
      );
    }

    return Object.freeze({
      cpuSeconds: record.cpuSeconds,
      memoryGiBSeconds: record.memoryGiBSeconds,
      egressBytes: record.egressBytes,
    });
  }

  async stop(sandboxId: Id, timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const timeout = parseBoundedTimeoutMs(
      timeoutMs ?? this.cleanupTimeoutMs,
      'cleanupTimeoutMs',
      60_000,
    );

    try {
      await this.invokeGuarded(() => this.provider.stop(sandboxId), timeout, 'stop', signal);
    } finally {
      const current = this.states.get(sandboxId);
      if (current !== 'destroyed') {
        this.states.set(sandboxId, 'stopped');
      }
    }
  }

  async destroy(sandboxId: Id, timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const timeout = parseBoundedTimeoutMs(
      timeoutMs ?? this.cleanupTimeoutMs,
      'cleanupTimeoutMs',
      60_000,
    );

    try {
      await this.invokeGuarded(() => this.provider.destroy(sandboxId), timeout, 'destroy', signal);
    } finally {
      this.states.set(sandboxId, 'destroyed');
    }
  }

  putFile(sandboxId: Id, path: string, artifactRef: Id): Promise<void> {
    return this.invokeGuarded(
      () => this.provider.putFile(sandboxId, path, artifactRef),
      Math.min(this.execTimeoutMs, 5_000),
      'putFile',
    );
  }

  getFile(sandboxId: Id, path: string): Promise<{ artifactRef: Id }> {
    return this.invokeGuarded(
      () => this.provider.getFile(sandboxId, path),
      Math.min(this.execTimeoutMs, 5_000),
      'getFile',
    );
  }

  snapshot(sandboxId: Id): Promise<{ restoreRef: string }> {
    if (typeof this.provider.snapshot !== 'function') {
      return Promise.reject(new DomainError('POLICY_DENIED', 'snapshot is unsupported'));
    }
    return this.invokeGuarded(
      () => this.provider.snapshot!(sandboxId),
      Math.min(this.execTimeoutMs, 5_000),
      'snapshot',
    );
  }

  resume(sandboxId: Id): Promise<void> {
    if (typeof this.provider.resume !== 'function') {
      return Promise.reject(new DomainError('POLICY_DENIED', 'resume is unsupported'));
    }
    return this.invokeGuarded(
      () => this.provider.resume!(sandboxId),
      Math.min(this.execTimeoutMs, 5_000),
      'resume',
    );
  }

  /**
   * Reports the live sandbox count. Delegates to the underlying provider if supported,
   * or falls back to adapter-tracked live state.
   */
  liveSandboxCount(): number {
    const maybeLive = this.provider as unknown as { liveSandboxCount?: () => number };
    if (typeof maybeLive.liveSandboxCount === 'function') {
      return maybeLive.liveSandboxCount();
    }

    let count = 0;
    for (const state of this.states.values()) {
      if (state !== 'destroyed') {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Returns current adapter lifecycle state of a sandbox.
   */
  sandboxState(sandboxId: Id): SandboxAdapterState | null {
    return this.states.get(sandboxId) ?? null;
  }

  /**
   * Executes a complete fail-closed sandbox lifecycle:
   * create ➔ waitReady ➔ exec ➔ readOutput ➔ usage with guaranteed stop ➔ destroy in finally.
   */
  async run(options: SandboxRunOptions): Promise<SandboxRunResult> {
    throwIfAborted(options.signal);
    let sandboxId: Id | null = null;

    try {
      const created = await this.create(options.spec, options.signal);
      sandboxId = created.sandboxId;

      await this.waitReady(sandboxId, options.readyDeadlineMs, options.signal);

      if (options.beforeExec) {
        await options.beforeExec(sandboxId);
      }

      const execRes = await this.exec(
        sandboxId,
        options.argv,
        options.execTimeoutMs,
        options.signal,
      );
      if (execRes.exitCode !== 0) {
        throw new DomainError(
          'MOCK_TOOL_FAILED',
          `simulated sandbox command exited with code ${execRes.exitCode}`,
        );
      }

      const stdout = await this.readOutput(sandboxId, execRes.stdoutRef, options.signal);
      const stderr = await this.readOutput(sandboxId, execRes.stderrRef, options.signal);
      const usage = await this.usage(sandboxId, options.signal);

      return Object.freeze({
        sandboxId,
        exitCode: execRes.exitCode,
        stdout,
        stderr,
        digest: stdout,
        usage,
      });
    } finally {
      if (sandboxId !== null) {
        await this.stop(sandboxId).catch(() => undefined);
        await this.destroy(sandboxId).catch(() => undefined);
      }
    }
  }

  private async invokeGuarded<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    phase: string,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await withBoundedTimeout(fn, timeoutMs, phase, signal);
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        ((err as Record<symbol, boolean>)[ADAPTER_TIMEOUT_BRAND] ||
          (err as Record<symbol, boolean>)[ADAPTER_ABORT_BRAND])
      ) {
        // Genuine adapter-level timeout or abort
        throw err;
      }

      if (signal?.aborted) {
        throwIfAborted(signal);
      }

      throw sanitizeProviderError(err, phase);
    }
  }
}
