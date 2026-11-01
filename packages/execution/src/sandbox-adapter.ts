import type {
  SandboxAdapterOptions,
  SandboxCapabilities,
  SandboxExecResult,
  SandboxProvider,
  SandboxSpec,
  SandboxUsageRecord,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import { parseBoundedTimeoutMs, throwIfAborted } from './clock.js';

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

function toThrowError(err: unknown, fallbackMessage: string): Error {
  if (err instanceof Error) {
    return err;
  }
  return new DomainError('SANDBOX_NOT_READY', fallbackMessage);
}

const VALID_ADAPTER_PHASES = new Set([
  'capabilities',
  'create',
  'factory_create',
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
 * 2. An untrusted provider exception CANNOT spoof authoritative domain error codes
 *    (e.g., CANCELLED, STALE_LEASE, EXECUTION_TIMEOUT, POLICY_DENIED). Any error directly
 *    thrown by an untrusted provider is unconditionally mapped to SANDBOX_NOT_READY.
 * 3. Genuine timeouts and aborts are established exclusively by the adapter's internal
 *    race guards and branded tokens.
 * 4. The returned DomainError is ALWAYS a newly instantiated instance whose message,
 *    diagnostic, and stack trace originate strictly within the trusted boundary.
 */
export function sanitizeProviderError(_err: unknown, phase: string): DomainError {
  const safePhase = resolveSafePhase(phase);
  return new DomainError(
    'SANDBOX_NOT_READY',
    `sandbox provider operation failed during ${safePhase}`,
  );
}

/**
 * Internal race guard that bounds asynchronous operations by a wall-clock timeout and abort signal.
 *
 * Security Invariants:
 * 1. Rejection Boundary Normalization: Any error rejected by `action()` is caught immediately
 *    at the action promise boundary and unconditionally normalized via `sanitizeProviderError()`.
 *    An untrusted provider cannot forge timeout, cancellation, or authoritative codes, nor leak secrets.
 * 2. Authentic Timeouts: EXECUTION_TIMEOUT can ONLY originate from this function's wall-clock timer callback.
 * 3. Authentic Aborts: CANCELLED can ONLY originate from the caller's AbortSignal event listener.
 */
export async function withBoundedTimeout<T>(
  action: () => Promise<T>,
  timeoutMs: number,
  phase: string,
  signal?: AbortSignal,
): Promise<T> {
  const safePhase = resolveSafePhase(phase);
  if (signal?.aborted) {
    throw new DomainError('CANCELLED', 'simulated execution was aborted by its caller');
  }

  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;

  // 1. Untrusted Provider Action Rejection Boundary
  const guardedActionPromise = Promise.resolve()
    .then(action)
    .catch((err: unknown) => {
      throw sanitizeProviderError(err, safePhase);
    });

  // 2. Adapter Internal Wall-Clock Timeout Branch
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new DomainError(
          'EXECUTION_TIMEOUT',
          `sandbox ${safePhase} exceeded timeout of ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });

  // 3. Adapter Internal Caller-Abort Branch
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal) {
      abortHandler = () => {
        reject(new DomainError('CANCELLED', 'simulated execution was aborted by its caller'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });

  try {
    return await Promise.race([guardedActionPromise, timeoutPromise, abortPromise]);
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
  readonly liveSandboxCount?: () => number;

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

    // Only expose liveSandboxCount if the underlying provider natively implements it.
    // Never fake an independent count from adapter-internal lifecycle state!
    const maybeProvider = provider as unknown as { liveSandboxCount?: unknown };
    if (typeof maybeProvider.liveSandboxCount === 'function') {
      this.liveSandboxCount = () => {
        return (provider as unknown as { liveSandboxCount: () => number }).liveSandboxCount();
      };
    }
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

    await this.invokeGuarded(() => this.provider.stop(sandboxId), timeout, 'stop', signal);
    const current = this.states.get(sandboxId);
    if (current !== 'destroyed') {
      this.states.set(sandboxId, 'stopped');
    }
  }

  async destroy(sandboxId: Id, timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const timeout = parseBoundedTimeoutMs(
      timeoutMs ?? this.cleanupTimeoutMs,
      'cleanupTimeoutMs',
      60_000,
    );

    await this.invokeGuarded(() => this.provider.destroy(sandboxId), timeout, 'destroy', signal);
    this.states.set(sandboxId, 'destroyed');
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
    let primaryResult: SandboxRunResult | null = null;
    let primaryError: unknown = null;
    let stopError: unknown = null;
    let destroyError: unknown = null;

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

      primaryResult = Object.freeze({
        sandboxId,
        exitCode: execRes.exitCode,
        stdout,
        stderr,
        digest: stdout,
        usage,
      });
    } catch (err: unknown) {
      primaryError = err;
    } finally {
      if (sandboxId !== null) {
        try {
          await this.stop(sandboxId);
        } catch (err: unknown) {
          stopError = err;
        }

        try {
          await this.destroy(sandboxId);
        } catch (err: unknown) {
          destroyError = err;
        }
      }
    }

    if (primaryError !== null) {
      throw toThrowError(primaryError, 'primary sandbox execution failed');
    }

    if (destroyError !== null) {
      throw toThrowError(destroyError, 'sandbox destroy cleanup failed');
    }
    if (stopError !== null) {
      throw toThrowError(stopError, 'sandbox stop cleanup failed');
    }

    if (!primaryResult) {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox run terminated without result');
    }

    return primaryResult;
  }

  private async invokeGuarded<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    phase: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return withBoundedTimeout(fn, timeoutMs, phase, signal);
  }
}
