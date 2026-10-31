import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTimeout } from './timeout.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const WORKER_DIR = path.resolve(REPO_ROOT, 'apps/worker');
const WORKER_SCRIPT = path.resolve(WORKER_DIR, 'src/index.ts');

export interface SpawnWorkerSubprocessOptions {
  readonly schema: string;
  readonly blobRootDir: string;
  readonly workerId: string;
  readonly databaseUrl?: string;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly intervalMs?: number;
  readonly errorBackoffMs?: number;
  readonly retryBaseMs?: number;
  readonly retryCapMs?: number;
  readonly reaperBatchSize?: number;
  readonly mode?: 'poll' | 'reaper-only';
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error';
  readonly concurrency?: number;
  readonly extraEnv?: Record<string, string>;
}

export interface WorkerSubprocessHandle {
  readonly pid: number;
  readonly child: ChildProcess;
  isAlive(): boolean;
  sigkill(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  sigterm(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitForLog(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  getLogs(): string;
  readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const activeWorkerSubprocesses = new Set<WorkerSubprocessHandle>();

/**
 * Kill all active worker subprocesses created during tests.
 * Safe to call in afterEach / afterAll to guarantee no process leak.
 */
export async function cleanupAllWorkerSubprocesses(): Promise<void> {
  const handles = Array.from(activeWorkerSubprocesses);
  activeWorkerSubprocesses.clear();

  await Promise.all(
    handles.map(async (handle) => {
      if (handle.isAlive()) {
        try {
          process.kill(handle.pid, 'SIGKILL');
        } catch {
          // ignore ESRCH if process already exited
        }
        await Promise.race([handle.exitPromise, new Promise((r) => setTimeout(r, 500))]);
      }
    }),
  );
}

/**
 * Spawn a real Worker OS subprocess pointing at an isolated PostgreSQL schema and controlled blob root.
 * Bounded timeout ensures child process readiness ('worker starting') before returning.
 */
export async function spawnWorkerSubprocess(
  options: SpawnWorkerSubprocessOptions,
  readyTimeoutMs = 10_000,
): Promise<WorkerSubprocessHandle> {
  const baseDbUrl =
    options.databaseUrl ??
    process.env.TEST_DATABASE_URL ??
    'postgres://ember:ember_local_dev_only@127.0.0.1:5432/ember_test';

  const connectionUrl = `${baseDbUrl}${baseDbUrl.includes('?') ? '&' : '?'}options=-csearch_path%3D${options.schema}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: connectionUrl,
    EMBER_ENV: 'local',
    EMBER_WORKER_MODE: options.mode ?? 'poll',
    EMBER_WORKER_SIMULATED_EXECUTION: 'local-only',
    EMBER_WORKER_BLOB_ROOT: options.blobRootDir,
    EMBER_WORKER_ID: options.workerId,
    EMBER_WORKER_CONCURRENCY: String(options.concurrency ?? 1),
    EMBER_WORKER_LEASE_MS: String(options.leaseDurationMs ?? 2_000),
    EMBER_WORKER_HEARTBEAT_MS: String(options.heartbeatIntervalMs ?? 300),
    EMBER_WORKER_INTERVAL_MS: String(options.intervalMs ?? 200),
    EMBER_WORKER_ERROR_BACKOFF_MS: String(options.errorBackoffMs ?? 200),
    EMBER_WORKER_RETRY_BASE_MS: String(options.retryBaseMs ?? 200),
    EMBER_WORKER_RETRY_CAP_MS: String(options.retryCapMs ?? 2_000),
    EMBER_WORKER_REAPER_BATCH: String(options.reaperBatchSize ?? 10),
    EMBER_LOG_LEVEL: options.logLevel ?? 'info',
    ...(options.extraEnv ?? {}),
  };

  const child = spawn(process.execPath, ['--import', 'tsx', WORKER_SCRIPT], {
    cwd: WORKER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (child.pid === undefined) {
    throw new Error('Failed to obtain worker child process PID');
  }

  const pid = child.pid;
  let logBuffer = '';
  let alive = true;

  const logWaiters: Array<{
    pattern: string | RegExp;
    resolve: (matched: string) => void;
  }> = [];

  const checkWaiters = () => {
    for (let i = logWaiters.length - 1; i >= 0; i--) {
      const waiter = logWaiters[i]!;
      const match =
        typeof waiter.pattern === 'string'
          ? logBuffer.includes(waiter.pattern)
          : waiter.pattern.test(logBuffer);
      if (match) {
        logWaiters.splice(i, 1);
        waiter.resolve(logBuffer);
      }
    }
  };

  const onChunk = (chunk: Buffer) => {
    logBuffer += chunk.toString('utf8');
    checkWaiters();
  };

  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);

  let exitResolve: (val: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      exitResolve = resolve;
    },
  );

  child.once('exit', (code, signal) => {
    alive = false;
    exitResolve({ code, signal });
  });

  const handle: WorkerSubprocessHandle = {
    pid,
    child,
    isAlive() {
      if (!alive) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        alive = false;
        return false;
      }
    },
    async sigkill() {
      if (!handle.isAlive()) {
        return exitPromise;
      }
      process.kill(pid, 'SIGKILL');
      return withTimeout(exitPromise, 5_000, `waiting for worker PID ${pid} to exit after SIGKILL`);
    },
    async sigterm() {
      if (!handle.isAlive()) {
        return exitPromise;
      }
      process.kill(pid, 'SIGTERM');
      return withTimeout(exitPromise, 5_000, `waiting for worker PID ${pid} to exit after SIGTERM`);
    },
    async waitForLog(pattern: string | RegExp, timeoutMs = 10_000) {
      const alreadyMatch =
        typeof pattern === 'string' ? logBuffer.includes(pattern) : pattern.test(logBuffer);
      if (alreadyMatch) {
        return logBuffer;
      }
      return withTimeout(
        new Promise<string>((resolve) => {
          logWaiters.push({ pattern, resolve });
        }),
        timeoutMs,
        `waiting for worker PID ${pid} log matching ${pattern}`,
      );
    },
    getLogs() {
      return logBuffer;
    },
    exitPromise,
  };

  activeWorkerSubprocesses.add(handle);

  // Await child process startup signal
  try {
    await handle.waitForLog('worker starting', readyTimeoutMs);
  } catch (error) {
    await handle.sigkill().catch(() => {});
    activeWorkerSubprocesses.delete(handle);
    throw new Error(
      `Worker subprocess ${pid} failed to report 'worker starting' within ${readyTimeoutMs}ms: ${error instanceof Error ? error.message : String(error)}\nOutput:\n${logBuffer}`,
    );
  }

  return handle;
}
