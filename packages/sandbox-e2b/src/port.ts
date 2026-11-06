/**
 * Narrow port over the E2B runtime.
 *
 * The adapter never imports `e2b` directly. Everything the provider needs is expressed here
 * as a small, synchronous-looking async surface, which buys three properties:
 *
 * 1. **Deterministic contract tests.** An in-memory implementation can exercise every
 *    adapter branch (including provider faults) without network access, an API key, or spend.
 * 2. **Blast-radius control.** The SDK surface exposed to Ember is exactly this interface;
 *    nothing else from `e2b` can reach product code.
 * 3. **Honest measurement.** The SDK-era timing is captured inside the concrete client, so
 *    latency reported by the smoke harness is the vendor round-trip, not adapter overhead.
 */

/** Lifecycle state as reported by the E2B control plane. */
export type E2bSandboxState = 'running' | 'paused' | 'unknown';

export interface E2bSandboxHandle {
  readonly sandboxId: string;
}

export interface E2bSandboxInfo {
  readonly sandboxId: string;
  readonly state: E2bSandboxState;
  readonly templateId: string;
  readonly startedAtMs: number;
  readonly endAtMs: number;
  readonly cpuCount: number;
  readonly memoryMiB: number;
  readonly allowInternetAccess: boolean | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface E2bCreateSandboxRequest {
  readonly template: string;
  /** Vendor-enforced sandbox lifetime. The vendor kills the sandbox when this elapses. */
  readonly timeoutMs: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly allowInternetAccess: boolean;
  readonly allowOut?: readonly string[];
  readonly denyOut?: readonly string[];
  readonly dnsServers?: readonly string[];
  /** Caller-side cancellation. Implementations must not leave a sandbox behind on abort. */
  readonly signal?: AbortSignal;
}

export interface E2bRunCommandRequest {
  /** Fully rendered command string. Callers are responsible for POSIX-quoting argv. */
  readonly command: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface E2bCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * `true` when the command was killed because it exceeded `timeoutMs`.
   *
   * E2B surfaces this as a `TimeoutError`; the concrete client normalises it here so the
   * adapter can map it onto `EXECUTION_TIMEOUT` without depending on SDK error classes.
   */
  readonly timedOut: boolean;
}

export interface E2bMetricsSample {
  readonly timestampMs: number;
  /** Percentage of one CPU core in use, 0..100 (may exceed 100 on multi-core sandboxes). */
  readonly cpuUsedPct: number;
  readonly memUsedBytes: number;
}

export interface E2bListFilter {
  readonly metadata?: Readonly<Record<string, string>>;
  readonly states?: readonly E2bSandboxState[];
}

/** The complete E2B surface Ember is allowed to touch. */
export interface E2bSandboxClient {
  createSandbox(request: E2bCreateSandboxRequest): Promise<E2bSandboxHandle>;
  getInfo(sandboxId: string, signal?: AbortSignal): Promise<E2bSandboxInfo>;
  runCommand(sandboxId: string, request: E2bRunCommandRequest): Promise<E2bCommandResult>;
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
  readFile(sandboxId: string, path: string): Promise<string>;
  /** Idempotent: returns `false` when the sandbox no longer exists. */
  killSandbox(sandboxId: string, signal?: AbortSignal): Promise<boolean>;
  listSandboxes(filter: E2bListFilter): Promise<readonly E2bSandboxInfo[]>;
  /** May be unsupported by the vendor tier; implementations return an empty list then. */
  getMetrics(sandboxId: string): Promise<readonly E2bMetricsSample[]>;
}
