import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import type { Id } from '@ember/domain';
import type { BudgetPolicy } from '@ember/execution';
import {
  DeterministicExecutionRouter,
  DeterministicExecutor,
  type FakeSandboxProvider,
} from '@ember/execution';
import {
  createPool,
  loadDatabaseConfig,
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
import type { TelemetryCollector } from './telemetry.js';

export interface BenchmarkHarnessOptions {
  readonly databaseUrl: string;
  readonly workerConcurrency: number;
  readonly isolatedSchema?: boolean;
  readonly keepDb?: boolean;
  readonly telemetry?: TelemetryCollector;
}

export interface BenchmarkHarness {
  readonly schema: string;
  readonly apiUrl: string;
  readonly token: string;
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly policyVersion: number;
  readonly pool: ReturnType<typeof createPool>;
  readonly adminPool: ReturnType<typeof createPool>;
  stop(): Promise<void>;
}

const migrationsDir = fileURLToPath(new URL('../../../migrations', import.meta.url));
const schemaPattern = /^ember_bench_[a-f0-9]{12}$/;

/**
 * Permissive budget policy for benchmark runs to avoid hitting artificial rate limits under 100 concurrency.
 */
const BENCHMARK_BUDGET: BudgetPolicy = Object.freeze({
  policyId: 'ember-benchmark-budget-v1',
  policyVersion: 1,
  maxRunSteps: 1_000,
  maxRunUnits: 10_000_000,
  maxRunElapsedMs: 600_000,
  maxTenantDailyUnits: 100_000_000,
  maxConcurrentSlots: 500,
});

/**
 * Boots a completely isolated Ember API and Worker cluster backed by an ephemeral PostgreSQL schema.
 */
export async function createBenchmarkHarness(
  options: BenchmarkHarnessOptions,
): Promise<BenchmarkHarness> {
  const baseConfig: DatabaseConfig = loadDatabaseConfig({ DATABASE_URL: options.databaseUrl });
  const adminPool = createPool({ ...baseConfig, maxConnections: 3 });

  const schema =
    options.isolatedSchema !== false ? `ember_bench_${randomBytes(6).toString('hex')}` : 'public';
  if (schema !== 'public') {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
  }

  // Allocate connection pools with searchPath pinned to the isolated schema
  // API and Worker each get bounded connection pool allocations
  const apiPool = createPool({
    ...baseConfig,
    maxConnections: 25,
    searchPath: schema,
  });

  const workerPool = createPool({
    ...baseConfig,
    maxConnections: 25,
    searchPath: schema,
  });

  await runMigrations(apiPool, migrationsDir);

  // Setup local dev auth credentials for the benchmark tenant
  const token = `bench-token-${randomBytes(16).toString('hex')}`;
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const policyVersion = 1;

  // Provision tenant and principal rows in the isolated database schema
  await apiPool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
    tenantId,
    'Ember Benchmark Tenant',
  ]);
  await apiPool.query('INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, $3)', [
    principalId,
    tenantId,
    'owner',
  ]);

  const authenticator = createDevTokenAuthenticator([
    { token, tenantId, principalId, policyVersion },
  ]);

  // Setup blob root
  const tempBlobDir = mkdtempSync(path.join(os.tmpdir(), 'ember-bench-blobs-'));
  const blobStore = new PostgresBlobStore(apiPool, new LocalBlobStore({ rootDir: tempBlobDir }));
  const artifactStore = new PostgresArtifactStore(apiPool, blobStore);

  // Build and start API server
  const apiLogger = createWorkerLogger({ level: 'error', sink: () => undefined });
  const app = createApp({
    readiness: createDatabaseReadiness(apiPool),
    serviceVersion: '0.0.0-bench',
    logger: apiLogger,
    authenticator,
    agentStore: new PostgresAgentRepository(apiPool),
    taskStore: new PostgresTaskRepository(apiPool),
    approvalStore: new PostgresApprovalRepository(apiPool),
    artifactStore,
  });

  let server: ServerType | undefined;
  let serverPort = 0;

  await new Promise<void>((resolve, reject) => {
    try {
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
        serverPort = info.port;
        resolve();
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  const apiUrl = `http://127.0.0.1:${serverPort}`;

  // Build and start Worker
  const workerAbort = new AbortController();
  const queue = new PostgresLeaseQueue(workerPool, {
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 5_000,
    clock: systemClock,
    claimableKinds: DURABLE_TASK_KINDS,
  });

  const contextReader = new PostgresRunExecutionContextReader(workerPool, systemClock);
  const router = new DeterministicExecutionRouter();

  // Track active fake sandboxes via hook
  let activeSandboxes = 0;
  const executor = new DeterministicExecutor({
    sandboxExecDurationMs: 1,
    onSandboxProvider: (provider: FakeSandboxProvider) => {
      // FakeSandboxProvider creates sandbox on create and destroys on destroy.
      // Wrap provider to observe live instances accurately for telemetry.
      const originalCreate = provider.create.bind(provider);
      const originalDestroy = provider.destroy.bind(provider);

      provider.create = async (...args) => {
        const res = await originalCreate(...args);
        activeSandboxes += 1;
        options.telemetry?.recordLiveSandboxes(activeSandboxes);
        return res;
      };

      provider.destroy = async (...args) => {
        const res = await originalDestroy(...args);
        activeSandboxes = Math.max(0, activeSandboxes - 1);
        options.telemetry?.recordLiveSandboxes(activeSandboxes);
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
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 5_000,
      reaperBatchSize: 50,
      baseDelayMs: 1_000,
      capDelayMs: 30_000,
    },
    blobs: workerBlobs,
  });

  const baseHandler = createDurableRunHandler({
    contextReader,
    router,
    executor,
    blobs: workerBlobs,
    checkpoints: new PostgresCheckpointStore(workerPool),
    committer,
    workspaces: new PostgresWorkspaceStore(workerPool),
    approvals: new PostgresApprovalRepository(workerPool, { clock: systemClock }),
    budget: new PostgresBudgetLedger(workerPool, { policy: BENCHMARK_BUDGET }),
    clock: systemClock,
    logger: apiLogger,
  });

  // Track worker in-flight concurrency
  let inFlightWorkerRuns = 0;
  const handler = {
    handle: async (run: Parameters<typeof baseHandler.handle>[0], signal: AbortSignal) => {
      inFlightWorkerRuns += 1;
      options.telemetry?.recordWorkerInFlight(inFlightWorkerRuns);
      try {
        return await baseHandler.handle(run, signal);
      } finally {
        inFlightWorkerRuns = Math.max(0, inFlightWorkerRuns - 1);
        options.telemetry?.recordWorkerInFlight(inFlightWorkerRuns);
      }
    },
  };

  const reaperPromise = runReaperLoop({
    queue,
    clock: systemClock,
    intervalMs: 1_000,
    errorBackoffMs: 500,
    logger: apiLogger,
    signal: workerAbort.signal,
  });

  const pollLoopPromise = runPollLoop({
    queue,
    handler,
    clock: systemClock,
    workerId: 'worker-bench-local',
    concurrency: options.workerConcurrency,
    heartbeatIntervalMs: 5_000,
    idleIntervalMs: 25,
    errorBackoffMs: 100,
    logger: apiLogger,
    signal: workerAbort.signal,
  });

  const workerStopping = Promise.all([reaperPromise, pollLoopPromise]);

  return {
    schema,
    apiUrl,
    token,
    tenantId,
    principalId,
    policyVersion,
    pool: apiPool,
    adminPool,
    stop: async () => {
      // 1. Abort and wait for Worker
      workerAbort.abort();
      await workerStopping.catch(() => undefined);

      // 2. Close HTTP Server
      shutdownTaskEventStreams();
      if (server) {
        const httpServer = server as HttpServer;
        await new Promise<void>((res) => {
          server?.close(() => res());
          httpServer.closeAllConnections?.();
        });
      }

      // 3. Close database pools
      await apiPool.end().catch(() => undefined);
      await workerPool.end().catch(() => undefined);

      // 4. Drop schema if isolated and not keepDb
      if (schema !== 'public' && !options.keepDb && schemaPattern.test(schema)) {
        const dropPool = createPool({ ...baseConfig, maxConnections: 1 });
        try {
          await dropPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await dropPool.end().catch(() => undefined);
        }
      }

      await adminPool.end().catch(() => undefined);

      // 5. Clean up temporary blob store directory
      try {
        rmSync(tempBlobDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}
