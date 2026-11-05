import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  B1AssistantTurnDtoSchema,
  B1ConversationPageSchema,
  B1MeResponseSchema,
  B1SendMessageReceiptSchema,
  B1SessionResponseSchema,
  type B1AssistantTurnDto,
  type B1ConversationPage,
  type B1MeResponse,
  type B1SendMessageReceipt,
  type B1SessionResponse,
} from '@ember/contracts';
import { createPool, loadDatabaseConfig, runMigrations } from '@ember/postgres';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DATABASE_NAME_PATTERN = /^ember_b1_e2e_[a-f0-9]{12}$/;
const PROCESS_START_TIMEOUT_MS = 15_000;
const PROCESS_STOP_TIMEOUT_MS = 10_000;

export interface B1Identity {
  readonly assertion: string;
  readonly nonce: string;
  readonly session: B1SessionResponse;
  readonly me: B1MeResponse;
}

export interface B1SendInput {
  readonly client_submission_id: string;
  readonly text: string;
  readonly transcript_epoch: number;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface B1ProcessOutputSnapshot {
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Owns a real temporary PostgreSQL database and the API/Worker child processes. */
export class B1ProcessCluster {
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly nodeVersion = process.version;
  readonly postgresVersion: string;
  readonly adminPool: ReturnType<typeof createPool>;
  readonly observerPool: ReturnType<typeof createPool>;
  readonly sensitiveValues = new Set<string>();

  private api?: ManagedProcess;
  private worker?: ManagedProcess;
  private apiUrlValue?: string;
  private readonly completedProcessLogs: string[] = [];

  private constructor(input: {
    databaseName: string;
    databaseUrl: string;
    postgresVersion: string;
    adminPool: ReturnType<typeof createPool>;
    observerPool: ReturnType<typeof createPool>;
  }) {
    this.databaseName = input.databaseName;
    this.databaseUrl = input.databaseUrl;
    this.postgresVersion = input.postgresVersion;
    this.adminPool = input.adminPool;
    this.observerPool = input.observerPool;
  }

  static async start(): Promise<B1ProcessCluster> {
    const adminUrl = process.env.TEST_DATABASE_URL;
    if (adminUrl === undefined || adminUrl.length === 0) {
      throw new Error('TEST_DATABASE_URL is required for the B1 process E2E suite');
    }
    assertSafeAdminUrl(adminUrl);

    const adminPool = createPool({
      ...loadDatabaseConfig({ DATABASE_URL: adminUrl }),
      maxConnections: 4,
    });
    let databaseName: string | undefined;
    let observerPool: ReturnType<typeof createPool> | undefined;
    let cluster: B1ProcessCluster | undefined;

    try {
      const versionResult = await adminPool.query<{ version: string }>(
        'SELECT version() AS version',
      );
      const postgresVersion = versionResult.rows[0]?.version;
      if (postgresVersion === undefined || !/^PostgreSQL 17\./.test(postgresVersion)) {
        throw new Error('B1 process E2E requires PostgreSQL 17');
      }

      databaseName = `ember_b1_e2e_${randomBytes(6).toString('hex')}`;
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);

      const target = new URL(adminUrl);
      target.pathname = `/${databaseName}`;
      const databaseUrl = target.toString();
      observerPool = createPool({
        ...loadDatabaseConfig({ DATABASE_URL: databaseUrl }),
        maxConnections: 4,
      });
      await runMigrations(
        observerPool,
        fileURLToPath(new URL('../../../migrations', import.meta.url)),
      );

      cluster = new B1ProcessCluster({
        databaseName,
        databaseUrl,
        postgresVersion,
        adminPool,
        observerPool,
      });
      await cluster.startApi();
      await cluster.startWorker();
      return cluster;
    } catch (error) {
      await cluster?.stopWorker().catch(() => undefined);
      await cluster?.stopApi().catch(() => undefined);
      await observerPool?.end().catch(() => undefined);
      if (databaseName !== undefined && DATABASE_NAME_PATTERN.test(databaseName)) {
        await adminPool
          .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
          .catch(() => undefined);
      }
      await adminPool.end().catch(() => undefined);
      throw error;
    }
  }

  get apiUrl(): string {
    if (this.apiUrlValue === undefined) {
      throw new Error('API process is not running');
    }
    return this.apiUrlValue;
  }

  get apiLogs(): string {
    return this.api?.output ?? '';
  }

  get workerLogs(): string {
    return this.worker?.output ?? '';
  }

  get workerExitDiagnostics(): string {
    const snapshot = this.workerProcessSnapshot;
    return snapshot === undefined ? 'Worker process is not registered' : JSON.stringify(snapshot);
  }

  get workerProcessSnapshot(): B1ProcessOutputSnapshot | undefined {
    const current = this.worker;
    return current === undefined ? undefined : this.redactSnapshot(current.snapshot());
  }

  get workerIsRunning(): boolean {
    return this.worker !== undefined && this.worker.exit === undefined;
  }

  async startApi(): Promise<void> {
    if (this.api !== undefined && this.api.exit === undefined) {
      return;
    }
    const port = await availablePort();
    this.api = this.launch('apps/api/src/index.ts', {
      EMBER_PORT: String(port),
    });
    this.apiUrlValue = `http://127.0.0.1:${port}`;
    await this.waitForApi();
  }

  async startWorker(): Promise<void> {
    if (this.worker !== undefined && this.worker.exit === undefined) {
      return;
    }
    this.worker = this.launch('apps/worker/src/index.ts', {
      EMBER_B1_FAKE_RESPONDER_ENABLED: 'true',
    });
    await this.worker.waitForOutput(
      'fake B1 assistant turn responder enabled',
      PROCESS_START_TIMEOUT_MS,
      'Worker Fake Responder',
    );
  }

  async stopApi(): Promise<void> {
    const current = this.api;
    if (current === undefined) {
      return;
    }
    await current.stop();
    this.completedProcessLogs.push(current.output);
    this.api = undefined;
    this.apiUrlValue = undefined;
  }

  async stopWorker(): Promise<B1ProcessOutputSnapshot | undefined> {
    const current = this.worker;
    if (current === undefined) {
      return undefined;
    }
    if (current.paused) {
      current.signal('SIGCONT');
      current.paused = false;
    }
    try {
      await current.stop();
    } catch (error) {
      this.completedProcessLogs.push(current.output);
      throw error;
    }
    const snapshot = this.redactSnapshot(current.snapshot());
    this.completedProcessLogs.push(current.output);
    this.worker = undefined;
    return snapshot;
  }

  pauseWorker(): void {
    if (process.platform === 'win32') {
      throw new Error('the process E2E pause control requires a POSIX host');
    }
    const current = this.worker;
    if (current === undefined || current.exit !== undefined) {
      throw new Error('Worker process is not running');
    }
    current.signal('SIGSTOP');
    current.paused = true;
  }

  resumeWorker(): void {
    const current = this.worker;
    if (current === undefined || current.exit !== undefined || !current.paused) {
      return;
    }
    current.signal('SIGCONT');
    current.paused = false;
  }

  async crashPausedWorker(): Promise<B1ProcessOutputSnapshot> {
    const current = this.worker;
    if (current === undefined || current.exit !== undefined || !current.paused) {
      throw new Error('Worker must be paused before the crash-recovery check');
    }
    current.signal('SIGKILL');
    const exit = await current.waitForExit(PROCESS_STOP_TIMEOUT_MS);
    if (exit.signal !== 'SIGKILL') {
      throw new Error('Worker did not exit from the controlled crash');
    }
    const snapshot = this.redactSnapshot(current.snapshot());
    this.completedProcessLogs.push(current.output);
    this.worker = undefined;
    return snapshot;
  }

  async signIn(label: string, retainedAssertion?: string): Promise<B1Identity> {
    const assertion = retainedAssertion ?? `b1-e2e-${label}-${randomBytes(18).toString('hex')}`;
    const nonce = `b1-e2e-nonce-${randomBytes(18).toString('hex')}`;
    this.sensitiveValues.add(assertion);
    this.sensitiveValues.add(nonce);

    const response = await this.request('/v1/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'dev', identity_token: assertion, nonce }),
    });
    if (response.status !== 201) {
      throw new Error(`Ember Session sign-in returned HTTP ${response.status}`);
    }
    const session = B1SessionResponseSchema.parse(await response.json());
    this.sensitiveValues.add(session.access_token);

    const meResponse = await this.get('/v1/me', session.access_token);
    if (meResponse.status !== 200) {
      throw new Error(`GET /v1/me returned HTTP ${meResponse.status}`);
    }
    return {
      assertion,
      nonce,
      session,
      me: B1MeResponseSchema.parse(await meResponse.json()),
    };
  }

  request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.apiUrl}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
  }

  get(path: string, token?: string): Promise<Response> {
    return this.request(path, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  }

  async send(identity: B1Identity, conversationId: string, input: B1SendInput): Promise<Response> {
    this.sensitiveValues.add(input.text);
    this.sensitiveValues.add(input.client_submission_id);
    return this.request(`/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.session.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  }

  async sendReceipt(
    identity: B1Identity,
    conversationId: string,
    input: B1SendInput,
  ): Promise<B1SendMessageReceipt> {
    const response = await this.send(identity, conversationId, input);
    if (response.status !== 201) {
      throw new Error(`message submission returned HTTP ${response.status}`);
    }
    return B1SendMessageReceiptSchema.parse(await response.json());
  }

  async readPage(identity: B1Identity, conversationId: string): Promise<B1ConversationPage> {
    const response = await this.get(
      `/v1/conversations/${conversationId}/messages`,
      identity.session.access_token,
    );
    if (response.status !== 200) {
      throw new Error(`Conversation history returned HTTP ${response.status}`);
    }
    return B1ConversationPageSchema.parse(await response.json());
  }

  async readTurn(
    identity: B1Identity,
    conversationId: string,
    turnId: string,
  ): Promise<{ readonly response: Response; readonly turn?: B1AssistantTurnDto }> {
    const response = await this.get(
      `/v1/conversations/${conversationId}/turns/${turnId}`,
      identity.session.access_token,
    );
    if (response.status !== 200) {
      return { response };
    }
    return { response, turn: B1AssistantTurnDtoSchema.parse(await response.json()) };
  }

  async cancelTurn(
    identity: B1Identity,
    conversationId: string,
    turnId: string,
  ): Promise<Response> {
    return this.request(`/v1/conversations/${conversationId}/turns/${turnId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${identity.session.access_token}` },
    });
  }

  async tenantIdFor(identity: B1Identity): Promise<string> {
    const result = await this.observerPool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM consumers WHERE id = $1',
      [identity.session.consumer_id],
    );
    const tenantId = result.rows[0]?.tenant_id;
    if (tenantId === undefined) {
      throw new Error('provisioned Consumer is absent from PostgreSQL');
    }
    return tenantId;
  }

  logs(): string {
    return `${this.completedProcessLogs.join('\n')}\n${this.apiLogs}\n${this.workerLogs}`;
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    await this.stopWorker().catch((error: unknown) => errors.push(error));
    await this.stopApi().catch((error: unknown) => errors.push(error));
    await this.observerPool.end().catch((error: unknown) => errors.push(error));

    if (DATABASE_NAME_PATTERN.test(this.databaseName)) {
      await this.adminPool
        .query(`ALTER DATABASE "${this.databaseName}" ALLOW_CONNECTIONS true`)
        .catch(() => undefined);
      await this.adminPool
        .query(`DROP DATABASE IF EXISTS "${this.databaseName}" WITH (FORCE)`)
        .catch((error: unknown) => errors.push(error));
    }
    await this.adminPool.end().catch((error: unknown) => errors.push(error));
    if (errors.length > 0) {
      throw new AggregateError(errors, 'B1 process E2E cleanup did not finish cleanly');
    }
  }

  async blockDatabaseConnections(): Promise<void> {
    await this.adminPool.query(`ALTER DATABASE "${this.databaseName}" ALLOW_CONNECTIONS false`);
    await this.adminPool.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [this.databaseName],
    );
  }

  async allowDatabaseConnections(): Promise<void> {
    await this.adminPool.query(`ALTER DATABASE "${this.databaseName}" ALLOW_CONNECTIONS true`);
  }

  private redactSnapshot(snapshot: B1ProcessOutputSnapshot): B1ProcessOutputSnapshot {
    const databaseUrl = new URL(this.databaseUrl);
    const redactions = [
      this.databaseName,
      this.databaseUrl,
      databaseUrl.username,
      databaseUrl.password,
      decodeURIComponent(databaseUrl.username),
      decodeURIComponent(databaseUrl.password),
      ...this.sensitiveValues,
    ];
    const redact = (text: string): string => {
      let result = text;
      for (const value of redactions) {
        if (value.length > 0) {
          result = result.replaceAll(value, '[redacted]');
        }
      }
      return result.slice(-3_000);
    };

    return Object.freeze({
      ...snapshot,
      stdout: redact(snapshot.stdout),
      stderr: redact(snapshot.stderr),
    });
  }

  private launch(entry: string, overrides: Readonly<Record<string, string>>): ManagedProcess {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      EMBER_ENV: 'test',
      EMBER_HOST: '127.0.0.1',
      EMBER_ALLOW_NON_LOOPBACK_BIND: 'false',
      EMBER_DEV_PROVIDER_ENABLED: 'true',
      EMBER_DEV_PROVIDER_ISOLATED: 'true',
      EMBER_APPLE_BUNDLE_ID: 'com.ember.mobile',
      EMBER_LOG_LEVEL: 'debug',
      EMBER_DB_CONNECT_TIMEOUT_MS: '500',
      EMBER_DB_STATEMENT_TIMEOUT_MS: '5000',
      DATABASE_URL: this.databaseUrl,
      EMBER_WORKER_MODE: 'reaper-only',
      EMBER_WORKER_ID: 'b1-e2e-worker',
      EMBER_WORKER_INTERVAL_MS: '100',
      EMBER_WORKER_ERROR_BACKOFF_MS: '100',
      ...overrides,
    };
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: REPO_ROOT,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new ManagedProcess(child, entry);
  }

  private async waitForApi(): Promise<void> {
    const deadline = Date.now() + PROCESS_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.api?.exit !== undefined) {
        throw new Error(
          `API process exited before becoming ready (${this.api.exit.code ?? this.api.exit.signal})`,
        );
      }
      try {
        const response = await fetch(`${this.apiUrl}/healthz`, {
          signal: AbortSignal.timeout(750),
        });
        if (response.status === 200) {
          return;
        }
      } catch {
        // The listener has not bound yet; keep polling until the fixed deadline.
      }
      await delay(50);
    }
    throw new Error('API process did not become healthy within the startup deadline');
  }
}

class ManagedProcess {
  output = '';
  stdout = '';
  stderr = '';
  exit?: ProcessExit;
  paused = false;
  private readonly exitPromise: Promise<ProcessExit>;

  constructor(
    private readonly child: ChildProcess,
    readonly entry: string,
  ) {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.append('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => this.append('stderr', chunk));
    this.exitPromise = new Promise<ProcessExit>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        this.exit = { code, signal };
        resolve(this.exit);
      });
    });
  }

  signal(signal: NodeJS.Signals): void {
    if (this.exit !== undefined) {
      return;
    }
    if (!this.child.kill(signal)) {
      throw new Error(`${this.entry} process rejected ${signal}`);
    }
  }

  async waitForOutput(needle: string, timeoutMs: number, service: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.output.includes(needle)) {
        return;
      }
      if (this.exit !== undefined) {
        throw new Error(
          `${service} process exited during startup (${this.exit.code ?? this.exit.signal})`,
        );
      }
      await delay(20);
    }
    throw new Error(`${service} process did not report startup within the deadline`);
  }

  async waitForExit(timeoutMs: number): Promise<ProcessExit> {
    if (this.exit !== undefined) {
      return this.exit;
    }
    return withTimeout(this.exitPromise, timeoutMs, `${this.entry} process did not exit`);
  }

  snapshot(): B1ProcessOutputSnapshot {
    return Object.freeze({
      pid: this.child.pid ?? null,
      exitCode: this.exit?.code ?? null,
      exitSignal: this.exit?.signal ?? null,
      stdout: this.stdout,
      stderr: this.stderr,
    });
  }

  async stop(): Promise<void> {
    if (this.exit !== undefined) {
      if (this.exit.code !== 0) {
        throw new Error(
          `${this.entry} process exited unexpectedly (${this.exit.code ?? this.exit.signal})`,
        );
      }
      return;
    }
    this.signal('SIGTERM');
    const exit = await this.waitForExit(PROCESS_STOP_TIMEOUT_MS).catch(async (error: unknown) => {
      this.signal('SIGKILL');
      await this.waitForExit(PROCESS_STOP_TIMEOUT_MS).catch(() => undefined);
      throw error;
    });
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`${this.entry} process did not stop cleanly`);
    }
  }

  private append(stream: 'stdout' | 'stderr', chunk: string): void {
    this.output += chunk;
    if (stream === 'stdout') {
      this.stdout += chunk;
    } else {
      this.stderr += chunk;
    }
  }
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not reserve an API loopback port');
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

function assertSafeAdminUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('B1 process E2E requires a local non-production TEST_DATABASE_URL');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const database = parsed.pathname.replace(/^\//, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const forbidden = new Set(['host', 'hostaddr', 'port', 'database', 'dbname', 'user', 'username']);

  if (
    process.env.EMBER_ENV === 'production' ||
    !loopback ||
    database.length === 0 ||
    database.includes('prod') ||
    [...parsed.searchParams.keys()].some((key) => forbidden.has(key.toLowerCase())) ||
    [...parsed.searchParams.keys()].some((key) => key.toLowerCase() !== 'sslmode')
  ) {
    throw new Error('B1 process E2E requires a local non-production TEST_DATABASE_URL');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
