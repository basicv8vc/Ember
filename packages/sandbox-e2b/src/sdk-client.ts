import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CommandExitError, Sandbox, TimeoutError } from 'e2b';
import type {
  E2bCommandResult,
  E2bCreateSandboxRequest,
  E2bListFilter,
  E2bMetricsSample,
  E2bRunCommandRequest,
  E2bSandboxClient,
  E2bSandboxHandle,
  E2bSandboxInfo,
  E2bSandboxState,
} from './port.js';

/**
 * Pinned SDK version this adapter was written and compiled against.
 *
 * The smoke CLI refuses to run when the installed version differs, because a silent transport
 * change would invalidate every measurement in the report.
 */
export const E2B_PINNED_SDK_VERSION = '2.63.0';

/**
 * Version of the `e2b` package actually resolved by this workspace.
 *
 * Read from the resolved package root rather than a `./package.json` export, because `e2b`
 * does not expose one. `UNKNOWN` means detection failed — which the smoke CLI treats as a
 * blocked run, never as a passing one.
 */
export const E2B_INSTALLED_SDK_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    let cursor = dirname(require.resolve('e2b'));

    for (let depth = 0; depth < 4; depth += 1) {
      const candidate = join(cursor, 'package.json');

      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };

        if (pkg.name === 'e2b' && typeof pkg.version === 'string') {
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

export interface E2bSdkClientOptions {
  /** E2B API key. Never logged, never serialised, never placed in a report. */
  readonly apiKey: string;
  /** Optional control-plane domain override (self-hosted E2B). */
  readonly domain?: string;
  /** Per-HTTP-request timeout. Distinct from sandbox lifetime and command timeout. */
  readonly requestTimeoutMs?: number;
  /** Called once per vendor round-trip with the operation name and elapsed ms. */
  readonly onTiming?: (operation: string, durationMs: number) => void;
}

function toState(state: string): E2bSandboxState {
  if (state === 'running' || state === 'paused') {
    return state;
  }

  return 'unknown';
}

/**
 * Concrete `E2bSandboxClient` over the official `e2b` SDK.
 *
 * Responsibilities are deliberately boring: translate vendor shapes into the adapter's port
 * types, normalise the two error classes that carry *data* (`CommandExitError` for non-zero
 * exit, `TimeoutError` for a killed command), and time each round-trip. Policy, limits and
 * contract semantics live in the provider, not here.
 */
export class E2bSdkSandboxClient implements E2bSandboxClient {
  private readonly apiKey: string;
  private readonly domain: string | undefined;
  private readonly requestTimeoutMs: number | undefined;
  private readonly onTiming: ((operation: string, durationMs: number) => void) | undefined;
  private readonly handles = new Map<string, Sandbox>();

  constructor(options: E2bSdkClientOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new Error('E2B API key is required');
    }

    this.apiKey = options.apiKey.trim();
    this.domain = options.domain;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.onTiming = options.onTiming;
  }

  /** Connection options shared by every call. Kept private so the key cannot leak upward. */
  private connectionOptions(): { apiKey: string; domain?: string; requestTimeoutMs?: number } {
    return {
      apiKey: this.apiKey,
      ...(this.domain === undefined ? {} : { domain: this.domain }),
      ...(this.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.requestTimeoutMs }),
    };
  }

  async createSandbox(request: E2bCreateSandboxRequest): Promise<E2bSandboxHandle> {
    const startedAt = performance.now();

    try {
      const sandbox = await Sandbox.create(request.template, {
        ...this.connectionOptions(),
        timeoutMs: request.timeoutMs,
        metadata: { ...request.metadata },
        allowInternetAccess: request.allowInternetAccess,
        network: {
          ...(request.allowOut === undefined ? {} : { allowOut: [...request.allowOut] }),
          ...(request.denyOut === undefined ? {} : { denyOut: [...request.denyOut] }),
          ...(request.dnsServers === undefined ? {} : { dnsServers: [...request.dnsServers] }),
        },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      this.handles.set(sandbox.sandboxId, sandbox);
      return { sandboxId: sandbox.sandboxId };
    } finally {
      this.reportTiming('create', startedAt);
    }
  }

  async getInfo(sandboxId: string, signal?: AbortSignal): Promise<E2bSandboxInfo> {
    const startedAt = performance.now();

    try {
      const info = await Sandbox.getInfo(sandboxId, {
        ...this.connectionOptions(),
        ...(signal === undefined ? {} : { signal }),
      });

      return {
        sandboxId: info.sandboxId,
        state: toState(String(info.state)),
        templateId: info.templateId,
        startedAtMs: info.startedAt.getTime(),
        endAtMs: info.endAt.getTime(),
        cpuCount: info.cpuCount,
        memoryMiB: info.memoryMB,
        allowInternetAccess:
          typeof info.allowInternetAccess === 'boolean' ? info.allowInternetAccess : null,
        metadata: Object.freeze({ ...info.metadata }),
      };
    } finally {
      this.reportTiming('getInfo', startedAt);
    }
  }

  async runCommand(sandboxId: string, request: E2bRunCommandRequest): Promise<E2bCommandResult> {
    const startedAt = performance.now();
    const sandbox = await this.requireHandle(sandboxId, request.signal);

    try {
      const result = await sandbox.commands.run(request.command, {
        timeoutMs: request.timeoutMs,
        ...(this.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.requestTimeoutMs }),
      });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: false,
      };
    } catch (error) {
      // A non-zero exit is data, not a transport failure. The adapter needs the exit code.
      if (error instanceof CommandExitError) {
        return {
          exitCode: error.exitCode,
          stdout: typeof error.stdout === 'string' ? error.stdout : '',
          stderr: typeof error.stderr === 'string' ? error.stderr : '',
          timedOut: false,
        };
      }

      if (error instanceof TimeoutError) {
        return { exitCode: 124, stdout: '', stderr: '', timedOut: true };
      }

      throw error;
    } finally {
      this.reportTiming('runCommand', startedAt);
    }
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    const startedAt = performance.now();

    try {
      const sandbox = await this.requireHandle(sandboxId);
      await sandbox.files.write(path, content);
    } finally {
      this.reportTiming('writeFile', startedAt);
    }
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    const startedAt = performance.now();

    try {
      const sandbox = await this.requireHandle(sandboxId);
      return await sandbox.files.read(path);
    } finally {
      this.reportTiming('readFile', startedAt);
    }
  }

  async killSandbox(sandboxId: string, signal?: AbortSignal): Promise<boolean> {
    const startedAt = performance.now();

    try {
      const killed = await Sandbox.kill(sandboxId, {
        ...this.connectionOptions(),
        ...(signal === undefined ? {} : { signal }),
      });

      if (killed) {
        this.handles.delete(sandboxId);
      }

      return killed;
    } finally {
      this.reportTiming('kill', startedAt);
    }
  }

  async listSandboxes(filter: E2bListFilter): Promise<readonly E2bSandboxInfo[]> {
    const startedAt = performance.now();

    try {
      const paginator = Sandbox.list({
        ...this.connectionOptions(),
        query: {
          ...(filter.metadata === undefined ? {} : { metadata: { ...filter.metadata } }),
          state:
            filter.states === undefined
              ? ['running', 'paused']
              : filter.states.filter((state): state is 'running' | 'paused' => state !== 'unknown'),
        },
      });

      const collected: E2bSandboxInfo[] = [];

      while (paginator.hasNext) {
        const page = await paginator.nextItems();

        for (const info of page) {
          collected.push({
            sandboxId: info.sandboxId,
            state: toState(String(info.state)),
            templateId: info.templateId,
            startedAtMs: info.startedAt.getTime(),
            endAtMs: info.endAt.getTime(),
            cpuCount: info.cpuCount,
            memoryMiB: info.memoryMB,
            allowInternetAccess:
              typeof info.allowInternetAccess === 'boolean' ? info.allowInternetAccess : null,
            metadata: Object.freeze({ ...info.metadata }),
          });
        }
      }

      return Object.freeze(collected);
    } finally {
      this.reportTiming('list', startedAt);
    }
  }

  async getMetrics(sandboxId: string): Promise<readonly E2bMetricsSample[]> {
    const startedAt = performance.now();

    try {
      const metrics = await Sandbox.getMetrics(sandboxId, this.connectionOptions());

      return Object.freeze(
        metrics.map((sample) => ({
          timestampMs: sample.timestamp.getTime(),
          cpuUsedPct: sample.cpuUsedPct,
          memUsedBytes: sample.memUsed,
        })),
      );
    } catch {
      // Metrics are a best-effort telemetry surface; absence must not fail a run.
      return Object.freeze([]);
    } finally {
      this.reportTiming('metrics', startedAt);
    }
  }

  private async requireHandle(sandboxId: string, signal?: AbortSignal): Promise<Sandbox> {
    const cached = this.handles.get(sandboxId);

    if (cached !== undefined) {
      return cached;
    }

    const connected = await Sandbox.connect(sandboxId, {
      ...this.connectionOptions(),
      ...(signal === undefined ? {} : { signal }),
    });

    this.handles.set(sandboxId, connected);
    return connected;
  }

  private reportTiming(operation: string, startedAt: number): void {
    this.onTiming?.(operation, Math.round((performance.now() - startedAt) * 100) / 100);
  }
}
