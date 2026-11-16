import type { DaytonaSandboxClass } from './limits.js';

/**
 * Narrow port over the Daytona runtime.
 *
 * The adapter never imports `@daytonaio/sdk` directly. Everything the provider needs is
 * expressed here as a small async surface, which buys three properties:
 *
 * 1. **Deterministic contract tests.** An in-memory implementation can exercise every adapter
 *    branch — including vendor faults, timeouts and a "worker died" case — with no network
 *    access, no API key and no spend.
 * 2. **Blast-radius control.** The SDK surface reachable from Ember product code is exactly
 *    this interface; nothing else from Daytona can leak into the execution path.
 * 3. **Honest measurement.** SDK round-trips are timed inside the concrete client, so latency
 *    reported by the smoke harness is vendor time, not adapter overhead.
 */

/** Lifecycle state as reported by the Daytona control plane. */
export type DaytonaSandboxState =
  | 'creating'
  | 'restoring'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'archiving'
  | 'archived'
  | 'destroying'
  | 'destroyed'
  | 'error'
  | 'build_failed'
  | 'unknown';

/** States in which the sandbox still consumes quota. */
export const DAYTONA_LIVE_STATES: readonly DaytonaSandboxState[] = Object.freeze([
  'creating',
  'restoring',
  'starting',
  'started',
  'stopping',
  'stopped',
  'pausing',
  'paused',
  'resuming',
  'archiving',
  'archived',
  'destroying',
]);

export interface DaytonaSandboxInfo {
  readonly sandboxId: string;
  readonly state: DaytonaSandboxState;
  readonly snapshot: string | null;
  readonly sandboxClass: DaytonaSandboxClass | null;
  readonly cpu: number;
  readonly memoryGiB: number;
  readonly diskGiB: number;
  readonly createdAtMs: number | null;
  /** `null` when the vendor did not report the setting (list results omit it). */
  readonly networkBlockAll: boolean | null;
  readonly autoStopIntervalMinutes: number | null;
  readonly autoDeleteIntervalMinutes: number | null;
  readonly autoDestroyAtMs: number | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly errorReason: string | null;
}

export interface DaytonaCreateRequest {
  readonly snapshot: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Vendor-enforced wall-clock TTL. The sandbox is destroyed when this elapses. */
  readonly ttlMinutes: number;
  readonly autoStopIntervalMinutes: number;
  readonly autoDeleteIntervalMinutes: number;
  readonly ephemeral: boolean;
  readonly networkBlockAll: boolean;
  readonly networkAllowList?: string;
  readonly domainAllowList?: string;
  /** Timeout for the create request itself, in seconds. */
  readonly fetchTimeoutSec: number;
  /** Caller-side cancellation. Implementations must not leave a sandbox behind on abort. */
  readonly signal?: AbortSignal;
}

export interface DaytonaExecRequest {
  /** Fully rendered command string. Callers are responsible for POSIX-quoting argv. */
  readonly command: string;
  readonly timeoutMs: number;
  /** Session id to use for this exec; unique per invocation. */
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

export interface DaytonaExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * `true` when the command was killed because it exceeded `timeoutMs`.
   *
   * The SDK surfaces this as `DaytonaProcessExecutionTimeoutError`; the concrete client
   * normalises it here so the adapter can map it onto `EXECUTION_TIMEOUT` without depending
   * on SDK error classes.
   */
  readonly timedOut: boolean;
}

export interface DaytonaMetricsSample {
  readonly timestampMs: number;
  /** Percentage of one CPU core in use, 0..100 (may exceed 100 on multi-core sandboxes). */
  readonly cpuUsedPct: number;
  readonly memUsedBytes: number;
  readonly memTotalBytes: number;
  readonly diskUsedBytes: number;
  readonly diskTotalBytes: number;
}

export interface DaytonaListFilter {
  readonly labels?: Readonly<Record<string, string>>;
  readonly states?: readonly DaytonaSandboxState[];
}

export interface DaytonaDirectoryEntry {
  readonly name: string;
  readonly isDir: boolean;
  readonly isSymlink: boolean;
  readonly sizeBytes: number;
}

/** Raised when the caller's trusted cancellation signal aborts an in-flight exec. */
export class DaytonaExecCancelledError extends Error {
  public constructor() {
    super('daytona exec cancelled by caller');
    this.name = 'DaytonaExecCancelledError';
  }
}

/** The complete Daytona surface Ember is allowed to touch. */
export interface DaytonaSandboxClient {
  create(request: DaytonaCreateRequest): Promise<{ readonly sandboxId: string }>;
  /** Returns `null` when the sandbox does not exist (already deleted, or never existed). */
  get(sandboxId: string): Promise<DaytonaSandboxInfo | null>;
  list(filter: DaytonaListFilter): Promise<readonly DaytonaSandboxInfo[]>;
  start(sandboxId: string, timeoutSec?: number): Promise<void>;
  stop(sandboxId: string): Promise<void>;
  /**
   * Deletes the sandbox and waits (bounded) for the control plane to report it destroyed.
   *
   * Returns `true` only when the sandbox is confirmed gone; `false` means the delete was
   * accepted but destruction is still in flight, which callers must not treat as cleanup.
   */
  delete(sandboxId: string, waitMs?: number): Promise<boolean>;
  exec(sandboxId: string, request: DaytonaExecRequest): Promise<DaytonaExecResult>;
  upload(sandboxId: string, absolutePath: string, data: Buffer): Promise<void>;
  download(sandboxId: string, absolutePath: string): Promise<Buffer>;
  exists(sandboxId: string, absolutePath: string): Promise<boolean>;
  listDirectory?(
    sandboxId: string,
    absolutePath: string,
  ): Promise<readonly DaytonaDirectoryEntry[]>;
  latestMetrics(sandboxId: string): Promise<DaytonaMetricsSample | null>;
  /** Releases SDK background connections and timers (e.g. Socket.IO EventDispatcher). */
  close?(): Promise<void>;
}
