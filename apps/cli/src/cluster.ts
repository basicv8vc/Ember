import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { DomainError, type Id } from '@ember/domain';
import type { BudgetPolicy, FakeSandboxProvider } from '@ember/execution';
import { DeterministicExecutionRouter, DeterministicExecutor } from '@ember/execution';
import {
  LocalBlobStore,
  PostgresAgentRepository,
  PostgresApprovalRepository,
  PostgresArtifactStore,
  PostgresBlobStore,
  PostgresBudgetLedger,
  PostgresCheckpointStore,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresRunResultCommitter,
  PostgresTaskRepository,
  PostgresWorkspaceStore,
  createPool,
  loadDatabaseConfig,
  runMigrations,
  systemClock,
  type DatabaseConfig,
} from '@ember/postgres';

import { createApp } from '../../api/src/app.js';
import { createDevTokenAuthenticator } from '../../api/src/auth/bearer-authenticator.js';
import { createDatabaseReadiness } from '../../api/src/readiness.js';
import { shutdownTaskEventStreams } from '../../api/src/tasks/event-stream.js';
import {
  createDurableRunHandler,
  DURABLE_TASK_KINDS,
} from '../../worker/src/durable-run-handler.js';
import { createWorkerLogger, type WorkerLogger } from '../../worker/src/logger.js';
import { runPollLoop } from '../../worker/src/poll-loop.js';
import { runReaperLoop } from '../../worker/src/reaper-loop.js';
import type { RunHandler } from '../../worker/src/run-handler.js';

const migrationsDir = fileURLToPath(new URL('../../../migrations', import.meta.url));
const schemaPattern = /^ember_demo_[a-f0-9]{12}$/;

/** Ensure Demo only executes against safe local or test databases. */
export function assertSafeTestDatabaseUrl(databaseUrl: string): void {
  try {
    const parsed = new URL(databaseUrl);
    const hostname = parsed.hostname.toLowerCase();
    const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();

    const isLocalHost =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname === '';

    // Extract database name tokens delimited by underscore, hyphen, or dot
    const dbTokens = dbName.split(/[_\-.]+/);
    const isTestOrDevDb =
      !dbName.includes('prod') &&
      dbTokens.some((token) => token === 'test' || token === 'demo' || token === 'dev');

    if (process.env.EMBER_ENV === 'production') {
      throw new DomainError(
        'POLICY_DENIED',
        'Refused to start Demo cluster in production environment (EMBER_ENV=production)',
      );
    }

    if (!isLocalHost || !isTestOrDevDb) {
      throw new DomainError(
        'POLICY_DENIED',
        `Refused to run Demo cluster against non-local or non-test database: host='${hostname}', db='${dbName}'`,
      );
    }
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError('INVALID_ARGUMENT', `Invalid database URL: ${String(err)}`);
  }
}

export interface TenantContext {
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly token: string;
  readonly name: string;
}

export interface DemoClusterOptions {
  readonly databaseUrl?: string;
  readonly workerConcurrency?: number;
}

const DEMO_BUDGET: BudgetPolicy = Object.freeze({
  policyId: 'ember-demo-budget-v1',
  policyVersion: 1,
  maxRunSteps: 1_000,
  maxRunUnits: 1_000_000,
  maxRunElapsedMs: 600_000,
  maxTenantDailyUnits: 10_000_000,
  maxConcurrentSlots: 100,
});

export class DemoCluster {
  readonly schema: string;
  readonly apiUrl: string;
  readonly tenantA: TenantContext;
  readonly tenantB: TenantContext;
  readonly tempBlobDir: string;
  readonly blobs: PostgresBlobStore;
  readonly adminPool: ReturnType<typeof createPool>;
  readonly appPool: ReturnType<typeof createPool>;
  readonly workerPool: ReturnType<typeof createPool>;
  readonly queue: PostgresLeaseQueue;

  private server?: ServerType;
  private workerAbort?: AbortController;
  private workerDone?: Promise<unknown>;
  private workerHandler?: RunHandler;
  private workerLogger?: WorkerLogger;
  private workerConcurrency = 4;
  private readonly baseConfig: DatabaseConfig;

  // Observable metrics for scenario assertions
  totalSandboxesCreated = 0;
  activeSandboxes = 0;
  totalSandboxesDestroyed = 0;
  readonly createdSandboxIds: string[] = [];

  private constructor(
    schema: string,
    apiUrl: string,
    tenantA: TenantContext,
    tenantB: TenantContext,
    tempBlobDir: string,
    blobs: PostgresBlobStore,
    adminPool: ReturnType<typeof createPool>,
    appPool: ReturnType<typeof createPool>,
    workerPool: ReturnType<typeof createPool>,
    baseConfig: DatabaseConfig,
    queue: PostgresLeaseQueue,
  ) {
    this.schema = schema;
    this.apiUrl = apiUrl;
    this.tenantA = tenantA;
    this.tenantB = tenantB;
    this.tempBlobDir = tempBlobDir;
    this.blobs = blobs;
    this.adminPool = adminPool;
    this.appPool = appPool;
    this.workerPool = workerPool;
    this.baseConfig = baseConfig;
    this.queue = queue;
  }

  static async start(options: DemoClusterOptions = {}): Promise<DemoCluster> {
    const rawDbUrl =
      options.databaseUrl ??
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgres://ember:ember_local_dev_only@127.0.0.1:5432/ember_test';

    assertSafeTestDatabaseUrl(rawDbUrl);

    const baseConfig = loadDatabaseConfig({ DATABASE_URL: rawDbUrl });
    const adminPool = createPool({ ...baseConfig, maxConnections: 3 });

    let schemaCreated = false;
    let appPool: ReturnType<typeof createPool> | undefined;
    let workerPool: ReturnType<typeof createPool> | undefined;
    let tempBlobDir: string | undefined;
    let server: ServerType | undefined;
    let cluster: DemoCluster | undefined;

    const schema = `ember_demo_${randomBytes(6).toString('hex')}`;

    try {
      await adminPool.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;

      appPool = createPool({
        ...baseConfig,
        maxConnections: 15,
        searchPath: schema,
      });

      workerPool = createPool({
        ...baseConfig,
        maxConnections: 15,
        searchPath: schema,
      });

      await runMigrations(appPool, migrationsDir);

      // Setup Tenant A and Tenant B dev credentials
      const tenantA: TenantContext = {
        tenantId: randomUUID(),
        principalId: randomUUID(),
        token: `dev-token-a-${randomBytes(16).toString('hex')}`,
        name: 'Tenant Alpha (Primary Dev Tenant)',
      };

      const tenantB: TenantContext = {
        tenantId: randomUUID(),
        principalId: randomUUID(),
        token: `dev-token-b-${randomBytes(16).toString('hex')}`,
        name: 'Tenant Beta (Isolation Verification Tenant)',
      };

      await appPool.query('INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4)', [
        tenantA.tenantId,
        tenantA.name,
        tenantB.tenantId,
        tenantB.name,
      ]);

      await appPool.query(
        'INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, $3), ($4, $5, $6)',
        [
          tenantA.principalId,
          tenantA.tenantId,
          'owner',
          tenantB.principalId,
          tenantB.tenantId,
          'owner',
        ],
      );

      const authenticator = createDevTokenAuthenticator([
        {
          token: tenantA.token,
          tenantId: tenantA.tenantId,
          principalId: tenantA.principalId,
          policyVersion: 1,
        },
        {
          token: tenantB.token,
          tenantId: tenantB.tenantId,
          principalId: tenantB.principalId,
          policyVersion: 1,
        },
      ]);

      tempBlobDir = mkdtempSync(path.join(os.tmpdir(), 'ember-demo-blobs-'));
      const blobStore = new PostgresBlobStore(
        appPool,
        new LocalBlobStore({ rootDir: tempBlobDir }),
      );
      const artifactStore = new PostgresArtifactStore(appPool, blobStore);

      const logger = createWorkerLogger({ level: 'error', sink: () => undefined });
      const app = createApp({
        readiness: createDatabaseReadiness(appPool),
        serviceVersion: '0.0.0-demo',
        logger,
        authenticator,
        agentStore: new PostgresAgentRepository(appPool),
        taskStore: new PostgresTaskRepository(appPool),
        approvalStore: new PostgresApprovalRepository(appPool),
        artifactStore,
      });

      let serverPort = 0;
      server = await new Promise<ServerType>((resolve, reject) => {
        try {
          const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
            serverPort = info.port;
            resolve(s);
          });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      const queue = new PostgresLeaseQueue(workerPool, {
        leaseDurationMs: 15_000,
        heartbeatIntervalMs: 3_000,
        clock: systemClock,
        claimableKinds: DURABLE_TASK_KINDS,
      });

      const apiUrl = `http://127.0.0.1:${serverPort}`;
      cluster = new DemoCluster(
        schema,
        apiUrl,
        tenantA,
        tenantB,
        tempBlobDir,
        blobStore,
        adminPool,
        appPool,
        workerPool,
        baseConfig,
        queue,
      );
      cluster.server = server;

      // Start Worker
      const contextReader = new PostgresRunExecutionContextReader(workerPool, systemClock);
      const router = new DeterministicExecutionRouter();

      const executor = new DeterministicExecutor({
        sandboxExecDurationMs: 2,
        onSandboxProvider: (provider: FakeSandboxProvider) => {
          const originalCreate = provider.create.bind(provider);
          const originalDestroy = provider.destroy.bind(provider);

          provider.create = async (...args) => {
            const res = await originalCreate(...args);
            cluster!.totalSandboxesCreated += 1;
            cluster!.activeSandboxes += 1;
            cluster!.createdSandboxIds.push(res.sandboxId);
            return res;
          };

          provider.destroy = async (...args) => {
            const res = await originalDestroy(...args);
            cluster!.activeSandboxes = Math.max(0, cluster!.activeSandboxes - 1);
            cluster!.totalSandboxesDestroyed += 1;
            return res;
          };
        },
      });

      const workerBlobs = new PostgresBlobStore(
        workerPool,
        new LocalBlobStore({ rootDir: tempBlobDir }),
      );
      const committer = new PostgresRunResultCommitter(workerPool, {
        policy: {
          leaseDurationMs: 15_000,
          heartbeatIntervalMs: 3_000,
          reaperBatchSize: 20,
          baseDelayMs: 500,
          capDelayMs: 5_000,
        },
        blobs: workerBlobs,
      });

      const handler = createDurableRunHandler({
        contextReader,
        router,
        executor,
        blobs: workerBlobs,
        checkpoints: new PostgresCheckpointStore(workerPool),
        committer,
        workspaces: new PostgresWorkspaceStore(workerPool),
        approvals: new PostgresApprovalRepository(workerPool, { clock: systemClock }),
        budget: new PostgresBudgetLedger(workerPool, { policy: DEMO_BUDGET }),
        clock: systemClock,
        logger,
      });

      cluster.workerHandler = handler;
      cluster.workerLogger = logger;
      cluster.workerConcurrency = options.workerConcurrency ?? 4;
      cluster.startWorker();

      return cluster;
    } catch (error) {
      if (cluster) {
        await cluster.stop().catch(() => undefined);
      } else {
        if (server) {
          server.close();
          (server as HttpServer).closeAllConnections?.();
        }
        if (appPool) await appPool.end().catch(() => undefined);
        if (workerPool) await workerPool.end().catch(() => undefined);
        if (schemaCreated) {
          await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        }
        await adminPool.end().catch(() => undefined);
        if (tempBlobDir) {
          try {
            rmSync(tempBlobDir, { recursive: true, force: true });
          } catch {
            // Ignore
          }
        }
      }
      throw error;
    }
  }

  async stopWorker(): Promise<void> {
    if (this.workerAbort) {
      this.workerAbort.abort();
      this.workerAbort = undefined;
    }
    if (this.workerDone) {
      await this.workerDone.catch(() => undefined);
      this.workerDone = undefined;
    }
  }

  startWorker(): void {
    if (this.workerDone || !this.workerHandler || !this.workerLogger) {
      return;
    }
    if (!Number.isInteger(this.workerConcurrency) || this.workerConcurrency < 1) {
      throw new Error(`Invalid worker concurrency: ${this.workerConcurrency}`);
    }
    this.workerAbort = new AbortController();
    const reaper = runReaperLoop({
      queue: this.queue,
      clock: systemClock,
      intervalMs: 500,
      errorBackoffMs: 200,
      logger: this.workerLogger,
      signal: this.workerAbort.signal,
    });
    const poller = runPollLoop({
      queue: this.queue,
      handler: this.workerHandler,
      clock: systemClock,
      workerId: 'worker-demo-main',
      concurrency: this.workerConcurrency,
      heartbeatIntervalMs: 3_000,
      idleIntervalMs: 25,
      errorBackoffMs: 100,
      logger: this.workerLogger,
      signal: this.workerAbort.signal,
    });
    this.workerDone = Promise.all([reaper, poller]);
  }

  async stop(): Promise<void> {
    // 1. Abort worker and drain loops
    await this.stopWorker();

    // 2. Terminate active SSE event streams & close HTTP listener
    shutdownTaskEventStreams();
    if (this.server) {
      const httpServer = this.server as HttpServer;
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    }

    // 3. Close application and worker pools
    await this.appPool.end().catch(() => undefined);
    await this.workerPool.end().catch(() => undefined);

    // 4. Safe drop schema: only drops our specifically verified demo schema
    if (schemaPattern.test(this.schema)) {
      const dropPool = createPool({ ...this.baseConfig, maxConnections: 1 });
      try {
        await dropPool.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
      } finally {
        await dropPool.end().catch(() => undefined);
      }
    }

    await this.adminPool.end().catch(() => undefined);

    // 5. Clean up temporary blob storage
    try {
      rmSync(this.tempBlobDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }

  // --- HTTP Helper Methods ---

  async fetch(
    routePath: string,
    options: {
      method?: string;
      body?: unknown;
      token?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const url = `${this.apiUrl}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
    const headers: Record<string, string> = { ...options.headers };

    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    if (options.method === 'POST' && routePath.includes('/tasks') && !headers['Idempotency-Key']) {
      headers['Idempotency-Key'] = `idem-${randomUUID()}`;
    }

    let bodyStr: string | undefined;
    if (options.body !== undefined) {
      bodyStr = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    return await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: bodyStr,
    });
  }

  async waitForTask(
    taskId: string,
    expectedStatus: string | readonly string[],
    token: string,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const res = await this.fetch(`/v1/tasks/${taskId}`, { token });
      if (res.status === 200) {
        const body = (await res.json()) as Record<string, unknown>;
        if (typeof body.status === 'string' && statuses.includes(body.status)) {
          return body;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    throw new Error(
      `Task ${taskId} did not reach expected status [${statuses.join(', ')}] within ${timeoutMs}ms`,
    );
  }
}
