import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  Daytona,
  DaytonaFileNotFoundError,
  DaytonaNotFoundError,
  DaytonaProcessExecutionTimeoutError,
  SandboxState,
} from '@daytonaio/sdk';
import type { Sandbox } from '@daytonaio/sdk';

import type { DaytonaSandboxClass } from './limits.js';
import {
  DAYTONA_LIVE_STATES,
  DaytonaExecCancelledError,
  type DaytonaCreateRequest,
  type DaytonaExecRequest,
  type DaytonaExecResult,
  type DaytonaListFilter,
  type DaytonaMetricsSample,
  type DaytonaSandboxClient,
  type DaytonaSandboxInfo,
  type DaytonaSandboxState,
} from './port.js';

/**
 * Pinned SDK version this adapter was written and compiled against.
 *
 * A silent minor upgrade can change transport semantics (the SDK moved to WebSocket state
 * streaming in 0.198.0), which would invalidate every latency number in the report. The smoke
 * harness refuses to run when the installed version differs.
 */
export const DAYTONA_PINNED_SDK_VERSION = '0.230.0';

/**
 * Version of `@daytonaio/sdk` actually resolved by this workspace.
 *
 * Read from the resolved package root rather than a `./package.json` export (the SDK does not
 * expose one). `UNKNOWN` means detection failed, which the smoke CLI treats as a blocked run.
 */
export const DAYTONA_INSTALLED_SDK_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    let cursor = dirname(require.resolve('@daytonaio/sdk'));

    for (let depth = 0; depth < 4; depth += 1) {
      const candidate = join(cursor, 'package.json');

      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };

        if (pkg.name === '@daytonaio/sdk' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      }

      cursor = dirname(cursor);
    }

    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
})();

export interface DaytonaSdkClientOptions {
  /** Injected from a secret store. Never logged, never placed in an error message. */
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly target?: string;
  readonly requestTimeoutMs?: number;
}

function toState(value: unknown): DaytonaSandboxState {
  switch (value) {
    case SandboxState.CREATING:
    case SandboxState.RESTORING:
    case SandboxState.STARTING:
    case SandboxState.STARTED:
    case SandboxState.STOPPING:
    case SandboxState.STOPPED:
    case SandboxState.PAUSING:
    case SandboxState.PAUSED:
    case SandboxState.RESUMING:
    case SandboxState.ARCHIVING:
    case SandboxState.ARCHIVED:
    case SandboxState.DESTROYING:
    case SandboxState.DESTROYED:
    case SandboxState.ERROR:
    case SandboxState.BUILD_FAILED:
      return value;
    default:
      return 'unknown';
  }
}

function toClass(value: unknown): DaytonaSandboxClass | null {
  return value === 'container' || value === 'linux-vm' || value === 'windows' ? value : null;
}

function toMs(value: string | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Concrete adapter over the official Daytona TypeScript SDK. */
export class DaytonaSdkSandboxClient implements DaytonaSandboxClient {
  private readonly daytona: Daytona;

  public constructor(options: DaytonaSdkClientOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error('daytona api key is empty');
    }

    this.daytona = new Daytona({
      apiKey: options.apiKey,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.target === undefined ? {} : { target: options.target }),
      requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
    });
  }

  public async create(request: DaytonaCreateRequest): Promise<{ sandboxId: string }> {
    request.signal?.throwIfAborted();

    const sandbox = await this.daytona.create(
      {
        snapshot: request.snapshot,
        labels: { ...request.labels },
        ttlMinutes: request.ttlMinutes,
        autoStopInterval: request.autoStopIntervalMinutes,
        autoDeleteInterval: request.autoDeleteIntervalMinutes,
        ephemeral: request.ephemeral,
        networkBlockAll: request.networkBlockAll,
        public: false,
        ...(request.networkAllowList === undefined
          ? {}
          : { networkAllowList: request.networkAllowList }),
        ...(request.domainAllowList === undefined
          ? {}
          : { domainAllowList: request.domainAllowList }),
      },
      { timeout: request.fetchTimeoutSec },
    );

    return { sandboxId: sandbox.id };
  }

  public async get(sandboxId: string): Promise<DaytonaSandboxInfo | null> {
    const sandbox = await this.tryGet(sandboxId);

    if (sandbox === null) {
      return null;
    }

    // `env`, `volumes`, `networkBlockAll` and the interval fields are omitted from list
    // results, and `get` is not guaranteed to be fresher. One explicit refresh keeps the
    // post-allocation verification in `waitReady` meaningful.
    await sandbox.refreshData().catch(() => undefined);

    return this.toInfo(sandbox);
  }

  public async list(filter: DaytonaListFilter): Promise<readonly DaytonaSandboxInfo[]> {
    const query: Parameters<Daytona['list']>[0] = {
      limit: 100,
      ...(filter.labels === undefined ? {} : { labels: { ...filter.labels } }),
      // The SDK's `SandboxState[]` is structurally the same string union; the cast documents
      // that this adapter only ever passes states it received from that same vocabulary.
      ...(filter.states === undefined ? {} : { states: [...filter.states] as SandboxState[] }),
    };

    const found: DaytonaSandboxInfo[] = [];

    for await (const sandbox of this.daytona.list(query)) {
      found.push(this.toInfo(sandbox));
    }

    return found;
  }

  public async start(sandboxId: string, timeoutSec = 60): Promise<void> {
    const sandbox = await this.requireSandbox(sandboxId);
    await sandbox.start(timeoutSec);
  }

  public async stop(sandboxId: string): Promise<void> {
    const sandbox = await this.requireSandbox(sandboxId);
    await sandbox.stop(60);
  }

  public async delete(sandboxId: string, waitMs = 60_000): Promise<boolean> {
    const sandbox = await this.tryGet(sandboxId);

    // Already gone is a success: destroy() is idempotent by contract.
    if (sandbox === null) {
      return true;
    }

    await sandbox.delete(Math.max(Math.ceil(waitMs / 1_000), 1), true);

    return this.confirmGone(sandboxId, waitMs);
  }

  public async exec(sandboxId: string, request: DaytonaExecRequest): Promise<DaytonaExecResult> {
    const sandbox = await this.requireSandbox(sandboxId);
    const timeoutSec = Math.max(1, Math.ceil(request.timeoutMs / 1_000));

    // Sessions are used instead of `process.executeCommand` because only the session API
    // returns stdout and stderr separately. `executeCommand` collapses both into `result`,
    // which would make the contract's `stdoutRef` / `stderrRef` indistinguishable.
    await sandbox.process.createSession(request.sessionId);

    try {
      const response = await this.raceAbort(
        sandbox.process.executeSessionCommand(
          request.sessionId,
          { command: request.command, runAsync: false },
          timeoutSec,
        ),
        request.signal,
        sandbox,
        request.sessionId,
      );

      return {
        exitCode: response.exitCode ?? 0,
        stdout: response.stdout ?? response.output ?? '',
        stderr: response.stderr ?? '',
        timedOut: false,
      };
    } catch (error) {
      if (error instanceof DaytonaExecCancelledError) {
        throw error;
      }

      if (isExecutionTimeout(error)) {
        return {
          exitCode: 124,
          stdout: '',
          stderr: 'command exceeded its timeout',
          timedOut: true,
        };
      }

      throw error;
    } finally {
      // Best effort: a deleted session is also the only portable way to guarantee that no
      // orphan process survives a timed-out or cancelled command.
      await sandbox.process.deleteSession(request.sessionId).catch(() => undefined);
    }
  }

  public async upload(sandboxId: string, absolutePath: string, data: Buffer): Promise<void> {
    const sandbox = await this.requireSandbox(sandboxId);
    await this.ensureParentDirectory(sandbox, absolutePath);
    await sandbox.fs.uploadFile(data, absolutePath);
  }

  public async download(sandboxId: string, absolutePath: string): Promise<Buffer> {
    const sandbox = await this.requireSandbox(sandboxId);
    return sandbox.fs.downloadFile(absolutePath);
  }

  public async exists(sandboxId: string, absolutePath: string): Promise<boolean> {
    const sandbox = await this.requireSandbox(sandboxId);

    try {
      await sandbox.fs.getFileDetails(absolutePath);
      return true;
    } catch (error) {
      if (error instanceof DaytonaFileNotFoundError) {
        return false;
      }

      throw error;
    }
  }

  public async latestMetrics(sandboxId: string): Promise<DaytonaMetricsSample | null> {
    const sandbox = await this.requireSandbox(sandboxId);

    try {
      const sample = await sandbox.getMetricsLatest();

      return {
        timestampMs: sample.timestamp.getTime(),
        cpuUsedPct: sample.cpuUsedPct,
        memUsedBytes: sample.memUsed,
        memTotalBytes: sample.memTotal,
        diskUsedBytes: sample.diskUsed,
        diskTotalBytes: sample.diskTotal,
      };
    } catch {
      // Metrics are analytics-only and can lag or be unavailable on a just-started sandbox.
      return null;
    }
  }

  private toInfo(sandbox: Sandbox): DaytonaSandboxInfo {
    return {
      sandboxId: sandbox.id,
      state: toState(sandbox.state),
      snapshot: sandbox.snapshot ?? null,
      sandboxClass: toClass(sandbox.sandboxClass),
      cpu: sandbox.cpu,
      memoryGiB: sandbox.memory,
      diskGiB: sandbox.disk,
      createdAtMs: toMs(sandbox.createdAt),
      networkBlockAll:
        typeof sandbox.networkBlockAll === 'boolean' ? sandbox.networkBlockAll : null,
      autoStopIntervalMinutes:
        typeof sandbox.autoStopInterval === 'number' ? sandbox.autoStopInterval : null,
      autoDeleteIntervalMinutes:
        typeof sandbox.autoDeleteInterval === 'number' ? sandbox.autoDeleteInterval : null,
      autoDestroyAtMs: toMs(sandbox.autoDestroyAt),
      labels: Object.freeze({ ...sandbox.labels }),
      errorReason: sandbox.errorReason ?? null,
    };
  }

  private async tryGet(sandboxId: string): Promise<Sandbox | null> {
    try {
      return await this.daytona.get(sandboxId);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) {
        return null;
      }

      throw error;
    }
  }

  private async requireSandbox(sandboxId: string): Promise<Sandbox> {
    const sandbox = await this.tryGet(sandboxId);

    if (sandbox === null) {
      throw new DaytonaNotFoundError(`sandbox ${sandboxId} no longer exists`);
    }

    return sandbox;
  }

  private async confirmGone(sandboxId: string, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;

    while (Date.now() < deadline) {
      const sandbox = await this.tryGet(sandboxId);

      if (sandbox === null) {
        return true;
      }

      if (toState(sandbox.state) === 'destroyed') {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return false;
  }

  private async ensureParentDirectory(sandbox: Sandbox, absolutePath: string): Promise<void> {
    const segments = absolutePath.split('/').filter((segment) => segment.length > 0);

    // Walk from the filesystem root so a nested path works on a fresh sandbox. `createFolder`
    // is not documented as recursive, and a silent ENOENT here would surface as a confusing
    // upload failure much later.
    let current = '';

    for (const segment of segments.slice(0, -1)) {
      current = `${current}/${segment}`;

      try {
        await sandbox.fs.createFolder(current, '755');
      } catch (error) {
        // Already present is fine; anything else must not be swallowed.
        const exists = await sandbox.fs.getFileDetails(current).catch(() => null);

        if (exists === null) {
          throw error;
        }
      }
    }
  }

  private async raceAbort<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
    sandbox: Sandbox,
    sessionId: string,
  ): Promise<T> {
    if (signal === undefined) {
      return operation;
    }

    if (signal.aborted) {
      await sandbox.process.deleteSession(sessionId).catch(() => undefined);
      throw new DaytonaExecCancelledError();
    }

    let onAbort: (() => void) | undefined;

    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        // Deleting the session is what actually kills the process tree; cancelling the HTTP
        // request alone would leave the command running and billing.
        void sandbox.process.deleteSession(sessionId).catch(() => undefined);
        reject(new DaytonaExecCancelledError());
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
}

function isExecutionTimeout(error: unknown): boolean {
  if (error instanceof DaytonaProcessExecutionTimeoutError) {
    return true;
  }

  // The SDK has changed error identity across minors; fall back to the stable name.
  return error instanceof Error && error.name.includes('Timeout');
}

/** True when the state still consumes the organisation's compute pool. */
export function isLiveState(state: DaytonaSandboxState): boolean {
  return DAYTONA_LIVE_STATES.includes(state);
}
