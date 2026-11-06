/* eslint-disable @typescript-eslint/require-await -- this double mirrors the SDK's async
   signatures exactly; returning a resolved value without awaiting keeps it deterministic. */
import type {
  DaytonaCreateRequest,
  DaytonaExecRequest,
  DaytonaExecResult,
  DaytonaListFilter,
  DaytonaMetricsSample,
  DaytonaSandboxClient,
  DaytonaSandboxInfo,
  DaytonaSandboxState,
} from '../../../packages/sandbox-daytona/src/index.js';
import { DaytonaExecCancelledError } from '../../../packages/sandbox-daytona/src/index.js';

export interface FakeDaytonaOptions {
  readonly sandboxClass?: 'container' | 'linux-vm' | 'windows';
  /** Overrides the class the control plane reports, to simulate a silent downgrade. */
  readonly reportClass?: string | null;
  readonly allocatedCpu?: number;
  readonly allocatedMemoryGiB?: number;
  readonly diskGiB?: number;
  /** Simulates a control plane that did not apply the egress policy. */
  readonly networkBlockAllReported?: boolean | null;
  readonly deleteConfirmed?: boolean;
  readonly createThrows?: string | null;
  /** Upper bound for a simulated `sleep`, so tests do not wait for real seconds. */
  readonly maxSimulatedSleepMs?: number;
  readonly egressOpen?: boolean;
  readonly metadataReachable?: boolean;
  readonly uid?: number;
}

interface FakeSandbox {
  sandboxId: string;
  state: DaytonaSandboxState;
  labels: Record<string, string>;
  snapshot: string;
  sandboxClass: 'container' | 'linux-vm' | 'windows';
  cpu: number;
  memoryGiB: number;
  diskGiB: number;
  createdAtMs: number;
  networkBlockAll: boolean;
  autoStopIntervalMinutes: number;
  autoDeleteIntervalMinutes: number;
  autoDestroyAtMs: number | null;
  files: Map<string, Buffer>;
  sessions: Set<string>;
}

function isSleepCommand(command: string): boolean {
  return /'sleep'\s+'(\d+)'/.test(command) || /^sleep\s+\d+/.test(command);
}

function sleepSeconds(command: string): number {
  const match = /sleep'?\s+'?(\d+)/.exec(command);

  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

function hasFlag(command: string, needle: string): boolean {
  return command.includes(needle);
}

/** In-memory Daytona control plane for deterministic adapter tests. */
export class FakeDaytonaClient implements DaytonaSandboxClient {
  public readonly sandboxes = new Map<string, FakeSandbox>();
  public readonly createRequests: DaytonaCreateRequest[] = [];
  public readonly deleted: string[] = [];
  public readonly execCommands: string[] = [];

  private readonly options: FakeDaytonaOptions;
  private sequence = 0;

  public constructor(options: FakeDaytonaOptions = {}) {
    this.options = options;
  }

  public async create(request: DaytonaCreateRequest): Promise<{ sandboxId: string }> {
    if (this.options.createThrows !== null && this.options.createThrows !== undefined) {
      throw new Error(this.options.createThrows);
    }

    this.createRequests.push(request);
    this.sequence += 1;

    const sandboxId = `sbx-${String(this.sequence).padStart(4, '0')}`;
    const now = Date.now();

    this.sandboxes.set(sandboxId, {
      sandboxId,
      state: this.options.reportClass === 'error' ? 'error' : 'started',
      labels: { ...request.labels },
      snapshot: request.snapshot,
      sandboxClass: this.options.sandboxClass ?? 'container',
      cpu: this.options.allocatedCpu ?? 1,
      memoryGiB: this.options.allocatedMemoryGiB ?? 1,
      diskGiB: this.options.diskGiB ?? 3,
      createdAtMs: now,
      networkBlockAll:
        this.options.networkBlockAllReported === undefined
          ? request.networkBlockAll
          : this.options.networkBlockAllReported === true,
      autoStopIntervalMinutes: request.autoStopIntervalMinutes,
      autoDeleteIntervalMinutes: request.autoDeleteIntervalMinutes,
      autoDestroyAtMs: now + request.ttlMinutes * 60_000,
      files: new Map(),
      sessions: new Set(),
    });

    return { sandboxId };
  }

  public async get(sandboxId: string): Promise<DaytonaSandboxInfo | null> {
    const sandbox = this.sandboxes.get(sandboxId);

    return sandbox === undefined ? null : this.toInfo(sandbox);
  }

  public async list(filter: DaytonaListFilter): Promise<readonly DaytonaSandboxInfo[]> {
    return [...this.sandboxes.values()]
      .filter((sandbox) => {
        if (sandbox.state === 'destroyed') {
          return false;
        }

        const labels = filter.labels ?? {};

        for (const [key, value] of Object.entries(labels)) {
          if (sandbox.labels[key] !== value) {
            return false;
          }
        }

        if (filter.states !== undefined && !filter.states.includes(sandbox.state)) {
          return false;
        }

        return true;
      })
      .map((sandbox) => this.toInfo(sandbox));
  }

  public async start(sandboxId: string): Promise<void> {
    const sandbox = this.require(sandboxId);
    sandbox.state = 'started';
  }

  public async stop(sandboxId: string): Promise<void> {
    const sandbox = this.require(sandboxId);
    sandbox.state = 'stopped';
  }

  public async delete(sandboxId: string, _waitMs?: number): Promise<boolean> {
    const sandbox = this.sandboxes.get(sandboxId);

    if (sandbox === undefined || sandbox.state === 'destroyed') {
      return true;
    }

    this.deleted.push(sandboxId);

    if (this.options.deleteConfirmed === false) {
      return false;
    }

    sandbox.state = 'destroyed';
    sandbox.files.clear();

    return true;
  }

  public async exec(sandboxId: string, request: DaytonaExecRequest): Promise<DaytonaExecResult> {
    const sandbox = this.require(sandboxId);
    this.execCommands.push(request.command);

    if (sandbox.state !== 'started') {
      throw new Error('sandbox is not started');
    }

    sandbox.sessions.add(request.sessionId);

    try {
      return await this.runCommand(sandbox, request);
    } finally {
      sandbox.sessions.delete(request.sessionId);
    }
  }

  public async upload(sandboxId: string, absolutePath: string, data: Buffer): Promise<void> {
    this.require(sandboxId).files.set(absolutePath, Buffer.from(data));
  }

  public async download(sandboxId: string, absolutePath: string): Promise<Buffer> {
    const file = this.require(sandboxId).files.get(absolutePath);

    if (file === undefined) {
      throw new Error(`no such file: ${absolutePath}`);
    }

    return Buffer.from(file);
  }

  public async exists(sandboxId: string, absolutePath: string): Promise<boolean> {
    return this.require(sandboxId).files.has(absolutePath);
  }

  public async latestMetrics(sandboxId: string): Promise<DaytonaMetricsSample | null> {
    if (!this.sandboxes.has(sandboxId)) {
      return null;
    }

    return {
      timestampMs: Date.now(),
      cpuUsedPct: 3,
      memUsedBytes: 64 * 1024 * 1024,
      memTotalBytes: 1024 * 1024 * 1024,
      diskUsedBytes: 128 * 1024 * 1024,
      diskTotalBytes: 3 * 1024 * 1024 * 1024,
    };
  }

  /** Directly seeds a sandbox, used to model a pre-existing orphan. */
  public seedOrphan(owner: string, tenantId: string, ageMs = 600_000): string {
    this.sequence += 1;

    const sandboxId = `sbx-orphan-${this.sequence}`;

    this.sandboxes.set(sandboxId, {
      sandboxId,
      state: 'started',
      labels: { 'ember.owner': owner, 'ember.tenant_id': tenantId, 'ember.managed': 'true' },
      snapshot: 'daytona-small',
      sandboxClass: 'container',
      cpu: 1,
      memoryGiB: 1,
      diskGiB: 3,
      createdAtMs: Date.now() - ageMs,
      networkBlockAll: true,
      autoStopIntervalMinutes: 2,
      autoDeleteIntervalMinutes: 0,
      autoDestroyAtMs: null,
      files: new Map(),
      sessions: new Set(),
    });

    return sandboxId;
  }

  private async runCommand(
    sandbox: FakeSandbox,
    request: DaytonaExecRequest,
  ): Promise<DaytonaExecResult> {
    const command = request.command;

    if (isSleepCommand(command)) {
      const seconds = sleepSeconds(command);
      const simulated = Math.min(seconds * 1_000, this.options.maxSimulatedSleepMs ?? 2_500);
      const timedOut = request.timeoutMs < seconds * 1_000;

      if (timedOut) {
        // Mirrors the vendor: the command is killed when the server-side timeout elapses.
        await this.delay(Math.min(request.timeoutMs, 2_500), request.signal);
        return { exitCode: 124, stdout: '', stderr: 'timed out', timedOut: true };
      }

      await this.delay(simulated, request.signal);

      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    }

    if (hasFlag(command, 'print(os.getuid())')) {
      return this.result(`${this.options.uid ?? 0}\n`);
    }

    if (hasFlag(command, 'hello ember')) {
      return this.result('hello ember\n');
    }

    if (hasFlag(command, '169.254.169.254')) {
      return this.options.metadataReachable === true
        ? this.result('connected\n')
        : { exitCode: 1, stdout: '', stderr: 'OSError: timed out', timedOut: false };
    }

    if (hasFlag(command, 'example.com')) {
      return this.options.egressOpen === true
        ? this.result('<html>')
        : { exitCode: 1, stdout: '', stderr: 'URLError: blocked', timedOut: false };
    }

    if (hasFlag(command, "'uname'")) {
      return this.result(`${sandbox.sandboxClass === 'linux-vm' ? '6.8.0-vm' : '6.8.0-host'}\n`);
    }

    if (hasFlag(command, '/proc/1/cgroup')) {
      const body =
        sandbox.sandboxClass === 'linux-vm'
          ? '0::/init.scope\n'
          : '0::/kubepods/besteffort/pod123/abc\n';

      return this.result(body);
    }

    if (hasFlag(command, 'cpu.max')) {
      return sandbox.sandboxClass === 'linux-vm'
        ? { exitCode: 1, stdout: '', stderr: 'No such file', timedOut: false }
        : this.result('100000 100000\n');
    }

    if (hasFlag(command, "'cat'")) {
      const path = /'cat'\s+'([^']+)'/.exec(command)?.[1];

      if (path === undefined) {
        return { exitCode: 1, stdout: '', stderr: 'bad invocation', timedOut: false };
      }

      const file = sandbox.files.get(path);

      return file === undefined
        ? {
            exitCode: 1,
            stdout: '',
            stderr: `cat: ${path}: No such file or directory`,
            timedOut: false,
          }
        : this.result(file.toString('utf8'));
    }

    return this.result('');
  }

  private result(stdout: string): DaytonaExecResult {
    return { exitCode: 0, stdout, stderr: '', timedOut: false };
  }

  private async delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) {
      throw new DaytonaExecCancelledError();
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      const onAbort = (): void => {
        cleanup();
        reject(new DaytonaExecCancelledError());
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private require(sandboxId: string): FakeSandbox {
    const sandbox = this.sandboxes.get(sandboxId);

    if (sandbox === undefined || sandbox.state === 'destroyed') {
      throw new Error(`sandbox ${sandboxId} does not exist`);
    }

    return sandbox;
  }

  private toInfo(sandbox: FakeSandbox): DaytonaSandboxInfo {
    return {
      sandboxId: sandbox.sandboxId,
      state: sandbox.state,
      snapshot: sandbox.snapshot,
      sandboxClass: sandbox.sandboxClass,
      cpu: sandbox.cpu,
      memoryGiB: sandbox.memoryGiB,
      diskGiB: sandbox.diskGiB,
      createdAtMs: sandbox.createdAtMs,
      networkBlockAll: sandbox.networkBlockAll,
      autoStopIntervalMinutes: sandbox.autoStopIntervalMinutes,
      autoDeleteIntervalMinutes: sandbox.autoDeleteIntervalMinutes,
      autoDestroyAtMs: sandbox.autoDestroyAtMs,
      labels: Object.freeze({ ...sandbox.labels }),
      errorReason: null,
    };
  }
}
