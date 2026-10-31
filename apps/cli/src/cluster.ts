import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import type { Id } from '@ember/domain';
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
import { createWorkerLogger } from '../../worker/src/logger.js';
import { runPollLoop } from '../../worker/src/poll-loop.js';
import { runReaperLoop } from '../../worker/src/reaper-loop.js';

const migrationsDir = fileURLToPath(new URL('../../../migrations', import.meta.url));
const schemaPattern = /^ember_demo_[a-f0-9]{12}$/;

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

  private server?: ServerType;
  private readonly workerAbort = new AbortController();
  private workerDone?: Promise<unknown>;
  private readonly baseConfig: DatabaseConfig;

  // Observable metrics for scenario assertions
  totalSandboxesCreated = 0;
  activeSandboxes = 0;
  totalSandboxesDestroyed = 0;

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
  }

  static async start(options: DemoClusterOptions = {}): Promise<DemoCluster> {
    const rawDbUrl =
      options.databaseUrl ??
      process.env.DATABASE_URL ??
      process.env.TEST_DATABASE_URL ??
      'postgres://ember:ember_local_dev_only@127.0.0.1:5432/ember_test';

    const baseConfig = loadDatabaseConfig({ DATABASE_URL: rawDbUrl });
    const adminPool = createPool({ ...baseConfig, maxConnections: 3 });

    const schema = `ember_demo_${randomBytes(6).toString('hex')}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);

    const appPool = createPool({
      ...baseConfig,
      maxConnections: 15,
      searchPath: schema,
    });

    const workerPool = createPool({
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

    const tempBlobDir = mkdtempSync(path.join(os.tmpdir(), 'ember-demo-blobs-'));
    const blobStore = new PostgresBlobStore(appPool, new LocalBlobStore({ rootDir: tempBlobDir }));
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
    const server = await new Promise<ServerType>((resolve, reject) => {
      try {
        const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
          serverPort = info.port;
          resolve(s);
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    const apiUrl = `http://127.0.0.1:${serverPort}`;
    const cluster = new DemoCluster(
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
    );
    cluster.server = server;

    // Start Worker
    const queue = new PostgresLeaseQueue(workerPool, {
      leaseDurationMs: 15_000,
      heartbeatIntervalMs: 3_000,
      clock: systemClock,
      claimableKinds: DURABLE_TASK_KINDS,
    });

    const contextReader = new PostgresRunExecutionContextReader(workerPool, systemClock);
    const router = new DeterministicExecutionRouter();

    const executor = new DeterministicExecutor({
      sandboxExecDurationMs: 2,
      onSandboxProvider: (provider: FakeSandboxProvider) => {
        const originalCreate = provider.create.bind(provider);
        const originalDestroy = provider.destroy.bind(provider);

        provider.create = async (...args) => {
          const res = await originalCreate(...args);
          cluster.totalSandboxesCreated += 1;
          cluster.activeSandboxes += 1;
          return res;
        };

        provider.destroy = async (...args) => {
          const res = await originalDestroy(...args);
          cluster.activeSandboxes = Math.max(0, cluster.activeSandboxes - 1);
          cluster.totalSandboxesDestroyed += 1;
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

    const reaper = runReaperLoop({
      queue,
      clock: systemClock,
      intervalMs: 500,
      errorBackoffMs: 200,
      logger,
      signal: cluster.workerAbort.signal,
    });

    const poller = runPollLoop({
      queue,
      handler,
      clock: systemClock,
      workerId: 'worker-demo-main',
      concurrency: options.workerConcurrency ?? 4,
      heartbeatIntervalMs: 3_000,
      idleIntervalMs: 25,
      errorBackoffMs: 100,
      logger,
      signal: cluster.workerAbort.signal,
    });

    cluster.workerDone = Promise.all([reaper, poller]);

    return cluster;
  }

  async stop(): Promise<void> {
    // 1. Abort worker and drain loops
    this.workerAbort.abort();
    if (this.workerDone) {
      await this.workerDone.catch(() => undefined);
    }

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
