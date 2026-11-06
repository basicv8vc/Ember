/* eslint-disable @typescript-eslint/require-await -- the test double mirrors the SDK's async
   signatures exactly; returning a resolved value without awaiting keeps it synchronous. */
import type {
  E2bCommandResult,
  E2bCreateSandboxRequest,
  E2bListFilter,
  E2bMetricsSample,
  E2bRunCommandRequest,
  E2bSandboxClient,
  E2bSandboxHandle,
  E2bSandboxInfo,
} from '@ember/sandbox-e2b';

/**
 * In-memory E2B client used by contract tests.
 *
 * This is the "Mock SDK" the task asks for when no credential is available: it reproduces the
 * *shape* of the vendor surface (creating, listing, killing, metrics, files) so every adapter
 * branch and every harness assertion can be exercised deterministically. It is explicitly NOT
 * evidence of vendor behaviour — it is a test double, and no measurement from it may be
 * reported as a real E2B result.
 */
export interface FakeE2bSandboxRecord {
  id: string;
  state: 'running' | 'paused';
  templateId: string;
  startedAtMs: number;
  endAtMs: number;
  cpuCount: number;
  memoryMiB: number;
  allowInternetAccess: boolean;
  metadata: Record<string, string>;
  readonly files: Map<string, string>;
  metrics: E2bMetricsSample[];
}

export type FakeCommandHandler = (
  command: string,
  sandbox: FakeE2bSandboxRecord,
) => E2bCommandResult | Promise<E2bCommandResult>;

const OK: E2bCommandResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };

export class FakeE2bClient implements E2bSandboxClient {
  readonly sandboxes = new Map<string, FakeE2bSandboxRecord>();
  readonly createRequests: E2bCreateSandboxRequest[] = [];
  readonly commands: E2bRunCommandRequest[] = [];
  readonly killedIds: string[] = [];
  readonly writtenFiles: Array<{ sandboxId: string; path: string; content: string }> = [];

  /** Allocation shape returned after `createSandbox`. */
  nextCpuCount = 1;
  nextMemoryMiB = 512;
  /** When set, the vendor reports this instead of what the request asked for. */
  reportedAllowInternetAccess: boolean | null = null;
  /** When set, `createSandbox` rejects with this error. */
  createError: Error | null = null;
  /** When set, `getInfo` rejects with this error. */
  getInfoError: Error | null = null;
  /** When set, `killSandbox` rejects with this error. */
  killError: Error | null = null;
  /** When set, sandboxes stay in this state instead of `running`. */
  forceState: 'running' | 'paused' | 'unknown' | null = null;
  /** When false, `listSandboxes` throws (simulates a tier without the list API). */
  listSupported = true;
  /** Metrics served by `getMetrics`; empty by default. */
  metricsSamples: E2bMetricsSample[] = [];

  commandHandler: FakeCommandHandler = () => OK;

  private sequence = 0;

  async createSandbox(request: E2bCreateSandboxRequest): Promise<E2bSandboxHandle> {
    this.createRequests.push(request);

    if (this.createError !== null) {
      throw this.createError;
    }

    this.sequence += 1;
    const id = `e2b-test-${this.sequence}`;
    const now = Date.now();

    this.sandboxes.set(id, {
      id,
      state: 'running',
      templateId: request.template,
      startedAtMs: now,
      endAtMs: now + request.timeoutMs,
      cpuCount: this.nextCpuCount,
      memoryMiB: this.nextMemoryMiB,
      allowInternetAccess: this.reportedAllowInternetAccess ?? request.allowInternetAccess,
      metadata: { ...request.metadata },
      files: new Map<string, string>(),
      metrics: [],
    });

    return { sandboxId: id };
  }

  async getInfo(sandboxId: string): Promise<E2bSandboxInfo> {
    if (this.getInfoError !== null) {
      throw this.getInfoError;
    }

    return this.toInfo(this.require(sandboxId));
  }

  async runCommand(sandboxId: string, request: E2bRunCommandRequest): Promise<E2bCommandResult> {
    const sandbox = this.require(sandboxId);
    this.commands.push(request);
    return this.commandHandler(request.command, sandbox);
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    this.require(sandboxId).files.set(path, content);
    this.writtenFiles.push({ sandboxId, path, content });
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    const value = this.require(sandboxId).files.get(path);

    if (value === undefined) {
      throw new Error('file not found');
    }

    return value;
  }

  async killSandbox(sandboxId: string): Promise<boolean> {
    if (this.killError !== null) {
      throw this.killError;
    }

    this.killedIds.push(sandboxId);
    return this.sandboxes.delete(sandboxId);
  }

  async listSandboxes(filter: E2bListFilter): Promise<readonly E2bSandboxInfo[]> {
    if (!this.listSupported) {
      throw new Error('list unsupported');
    }

    const metadata = filter.metadata ?? {};

    return [...this.sandboxes.values()]
      .filter((sandbox) =>
        Object.entries(metadata).every(([key, value]) => sandbox.metadata[key] === value),
      )
      .map((sandbox) => this.toInfo(sandbox));
  }

  async getMetrics(): Promise<readonly E2bMetricsSample[]> {
    return this.metricsSamples;
  }

  /** Seeds a sandbox without going through `createSandbox` (orphan/leak scenarios). */
  seedSandbox(overrides: Partial<FakeE2bSandboxRecord> & { id: string }): FakeE2bSandboxRecord {
    const record: FakeE2bSandboxRecord = {
      state: 'running',
      templateId: 'base',
      startedAtMs: Date.now(),
      endAtMs: Date.now() + 60_000,
      cpuCount: 1,
      memoryMiB: 512,
      allowInternetAccess: false,
      metadata: {},
      files: new Map<string, string>(),
      metrics: [],
      ...overrides,
    };

    this.sandboxes.set(record.id, record);
    return record;
  }

  private toInfo(sandbox: FakeE2bSandboxRecord): E2bSandboxInfo {
    return {
      sandboxId: sandbox.id,
      state: this.forceState === 'unknown' ? 'unknown' : (this.forceState ?? sandbox.state),
      templateId: sandbox.templateId,
      startedAtMs: sandbox.startedAtMs,
      endAtMs: sandbox.endAtMs,
      cpuCount: sandbox.cpuCount,
      memoryMiB: sandbox.memoryMiB,
      allowInternetAccess: sandbox.allowInternetAccess,
      metadata: { ...sandbox.metadata },
    };
  }

  private require(sandboxId: string): FakeE2bSandboxRecord {
    const sandbox = this.sandboxes.get(sandboxId);

    if (sandbox === undefined) {
      throw new Error('sandbox not found');
    }

    return sandbox;
  }
}

/**
 * Minimal simulated guest runtime for the smoke harness tests.
 *
 * Matches on command substrings rather than parsing, which is sufficient because the adapter
 * renders a fixed, quoted command shape (asserted separately in the adapter tests).
 */
export function installSimulatedRuntime(client: FakeE2bClient): void {
  client.commandHandler = (command, sandbox) => {
    if (command.includes('time.sleep(30)')) {
      return { exitCode: 124, stdout: '', stderr: '', timedOut: true };
    }

    if (command.includes('create_connection')) {
      // deny-all: the guest cannot open a socket.
      return { exitCode: 3, stdout: 'BLOCKED:OSError\n', stderr: '', timedOut: false };
    }

    if (command.includes("'cat'")) {
      const path = command.split("'cat' '")[1]?.replace(/'$/u, '') ?? '';
      const content = sandbox.files.get(path);

      return content === undefined
        ? { exitCode: 1, stdout: '', stderr: 'No such file\n', timedOut: false }
        : { exitCode: 0, stdout: content, stderr: '', timedOut: false };
    }

    if (command.includes('hello ember')) {
      return { exitCode: 0, stdout: 'hello ember\n', stderr: '', timedOut: false };
    }

    if (command.includes("print('warm')") || command.includes('"warm"')) {
      return { exitCode: 0, stdout: 'warm\n', stderr: '', timedOut: false };
    }

    return OK;
  };
}
