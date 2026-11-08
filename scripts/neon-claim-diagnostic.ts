import { execFileSync } from 'node:child_process';
import { isDomainError } from '@ember/domain';
import {
  createPool,
  loadDatabaseConfig,
  PostgresAgentRepository,
  PostgresLeaseQueue,
  PostgresTaskRepository,
} from '@ember/postgres';
import { createTestDatabase, type TestPool } from '../tests/integration/support/database.js';
import { createTenantFixture } from '../tests/integration/support/fixtures.js';
import {
  createQueuedTask,
  databaseNow,
  listEventSnapshots,
  listRuns,
  ManualClock,
  readTask,
} from '../tests/integration/support/leases.js';

const POOL_SIZES = [2, 8, 16, 32] as const;
const CONCURRENCY_LEVELS = [16, 32] as const;
const CONNECTION_TIMEOUT_MS = 5_000;
const PRIOR_STATEMENT_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
const ORIGINAL_CONCURRENCY_PER_QUEUE = 16;
const SAMPLE_INTERVAL_MS = 100;
const APPLICATION_NAME = 'ember_l4d_diagnostic';
const CLAIM_OPTIONS = {
  baseDelayMs: 100,
  capDelayMs: 400,
  leaseDurationMs: 1_000,
  heartbeatIntervalMs: 100,
  reaperBatchSize: 10,
} as const;

type PoolMetrics = {
  readonly acquireWaitMs: number[];
  readonly queuedAcquireWaitMs: number[];
  readonly newConnectionWaitMs: number[];
  readonly idleReuseWaitMs: number[];
  readonly sqlRoundTripMs: number[];
  readonly sqlRoundTripByKind: Map<string, number[]>;
  maxTotalCount: number;
  maxIdleCount: number;
  minIdleCount: number;
  maxWaitingCount: number;
};

type ActivityKey = `${string}|${string}|${string}`;

type ActivityMetric = {
  samples: number;
  maxBackends: number;
};

type ClaimOutcome = {
  readonly index: number;
  readonly elapsedMs: number;
  readonly result: 'lease' | 'no_work' | 'error';
  readonly failureClass?: string;
  readonly sqlState?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function emptyPoolMetrics(): PoolMetrics {
  return {
    acquireWaitMs: [],
    queuedAcquireWaitMs: [],
    newConnectionWaitMs: [],
    idleReuseWaitMs: [],
    sqlRoundTripMs: [],
    sqlRoundTripByKind: new Map(),
    maxTotalCount: 0,
    maxIdleCount: 0,
    minIdleCount: Number.POSITIVE_INFINITY,
    maxWaitingCount: 0,
  };
}

function sqlKind(sql: unknown): string {
  const text =
    typeof sql === 'string'
      ? sql
      : typeof sql === 'object' && sql !== null && 'text' in sql
        ? String(sql.text)
        : '';
  const firstWord = text.trimStart().match(/^[A-Za-z]+/)?.[0];
  return firstWord?.toUpperCase() ?? 'UNKNOWN';
}

function instrumentPool(pool: TestPool, poolLimit: number, metrics: PoolMetrics): TestPool {
  const connect = pool.connect.bind(pool) as () => Promise<{
    query: (...args: unknown[]) => Promise<unknown>;
    release: () => void;
  }>;

  return new Proxy(pool, {
    get(target, property) {
      if (property !== 'connect') {
        const value: unknown = Reflect.get(target, property, target);
        return value;
      }

      return async () => {
        const acquiredAt = performance.now();
        const acquireMode =
          pool.idleCount > 0 ? 'idle' : pool.totalCount < poolLimit ? 'new' : 'queued';
        try {
          const pendingClient = connect();
          observePool(pool, metrics);
          const client = await pendingClient;
          observePool(pool, metrics);
          const elapsedMs = performance.now() - acquiredAt;
          metrics.acquireWaitMs.push(elapsedMs);
          const modeValues =
            acquireMode === 'queued'
              ? metrics.queuedAcquireWaitMs
              : acquireMode === 'new'
                ? metrics.newConnectionWaitMs
                : metrics.idleReuseWaitMs;
          modeValues.push(elapsedMs);

          const queryClient = client;
          const query = queryClient.query.bind(client);
          queryClient.query = (...args: unknown[]) => {
            const kind = sqlKind(args[0]);
            const startedAt = performance.now();
            return query(...args).then(
              (result) => {
                const elapsedMs = performance.now() - startedAt;
                metrics.sqlRoundTripMs.push(elapsedMs);
                const values = metrics.sqlRoundTripByKind.get(kind) ?? [];
                values.push(elapsedMs);
                metrics.sqlRoundTripByKind.set(kind, values);
                return result;
              },
              (error: unknown) => {
                const elapsedMs = performance.now() - startedAt;
                metrics.sqlRoundTripMs.push(elapsedMs);
                const values = metrics.sqlRoundTripByKind.get(kind) ?? [];
                values.push(elapsedMs);
                metrics.sqlRoundTripByKind.set(kind, values);
                throw error;
              },
            );
          };
          return client;
        } catch (error) {
          observePool(pool, metrics);
          const elapsedMs = performance.now() - acquiredAt;
          metrics.acquireWaitMs.push(elapsedMs);
          const modeValues =
            acquireMode === 'queued'
              ? metrics.queuedAcquireWaitMs
              : acquireMode === 'new'
                ? metrics.newConnectionWaitMs
                : metrics.idleReuseWaitMs;
          modeValues.push(elapsedMs);
          throw error;
        }
      };
    },
  });
}

function observePool(pool: TestPool, metrics: PoolMetrics): void {
  metrics.maxTotalCount = Math.max(metrics.maxTotalCount, pool.totalCount);
  metrics.maxIdleCount = Math.max(metrics.maxIdleCount, pool.idleCount);
  metrics.minIdleCount = Math.min(metrics.minIdleCount, pool.idleCount);
  metrics.maxWaitingCount = Math.max(metrics.maxWaitingCount, pool.waitingCount);
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]?.toFixed(2));
}

function durationSummary(values: readonly number[]): {
  readonly count: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
} {
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length === 0 ? null : Number(Math.max(...values).toFixed(2)),
  };
}

function classifyFailure(error: unknown): { readonly kind: string; readonly sqlState?: string } {
  const diagnostic = isDomainError(error)
    ? error.diagnostic
    : error instanceof Error
      ? error.message
      : String(error);
  const codeMatch = diagnostic.match(/\bcode=([A-Z0-9_]+)\b/);
  const code = codeMatch?.[1];
  const sqlState = code !== undefined && /^[A-Z0-9]{5}$/.test(code) ? code : undefined;

  if (diagnostic.includes('timeout exceeded when trying to connect')) {
    return { kind: 'pool_acquire_timeout' };
  }
  if (sqlState === '57014' || /statement timeout/i.test(diagnostic)) {
    return { kind: 'statement_timeout', ...(sqlState === undefined ? {} : { sqlState }) };
  }
  if (sqlState === '53300') {
    return { kind: 'database_connection_limit', sqlState };
  }
  if (sqlState === '40P01' || /wait_event_type=lock/i.test(diagnostic)) {
    return { kind: 'database_lock_error', ...(sqlState === undefined ? {} : { sqlState }) };
  }
  if (
    ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(
      code ?? '',
    )
  ) {
    return { kind: 'network_error' };
  }
  return { kind: 'other_database_error', ...(sqlState === undefined ? {} : { sqlState }) };
}

function poolSummary(metrics: PoolMetrics): {
  readonly acquireWait: ReturnType<typeof durationSummary>;
  readonly queuedAcquireWait: ReturnType<typeof durationSummary>;
  readonly newConnectionWait: ReturnType<typeof durationSummary>;
  readonly idleReuseWait: ReturnType<typeof durationSummary>;
  readonly sqlRoundTrip: ReturnType<typeof durationSummary>;
  readonly sqlRoundTripByKind: Readonly<Record<string, ReturnType<typeof durationSummary>>>;
  readonly peak: {
    readonly totalCount: number;
    readonly idleCount: number;
    readonly minIdleCount: number | null;
    readonly waitingCount: number;
  };
} {
  return {
    acquireWait: durationSummary(metrics.acquireWaitMs),
    queuedAcquireWait: durationSummary(metrics.queuedAcquireWaitMs),
    newConnectionWait: durationSummary(metrics.newConnectionWaitMs),
    idleReuseWait: durationSummary(metrics.idleReuseWaitMs),
    sqlRoundTrip: durationSummary(metrics.sqlRoundTripMs),
    sqlRoundTripByKind: Object.fromEntries(
      [...metrics.sqlRoundTripByKind.entries()].map(([kind, values]) => [
        kind,
        durationSummary(values),
      ]),
    ),
    peak: {
      totalCount: metrics.maxTotalCount,
      idleCount: metrics.maxIdleCount,
      minIdleCount: Number.isFinite(metrics.minIdleCount) ? metrics.minIdleCount : null,
      waitingCount: metrics.maxWaitingCount,
    },
  };
}

function safeConnectionCheck(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('NEON_DIAGNOSTIC_DATABASE_URL must be a valid PostgreSQL URL');
  }

  assert(
    url.protocol === 'postgres:' || url.protocol === 'postgresql:',
    'NEON_DIAGNOSTIC_DATABASE_URL must use PostgreSQL',
  );
  assert(
    url.hostname.endsWith('.neon.tech') && !url.hostname.includes('-pooler'),
    'use the direct, unpooled Neon endpoint only',
  );
  assert(decodeURIComponent(url.username) === 'ember_test_owner', 'use ember_test_owner');
  assert(url.pathname.replace(/^\//, '') === 'ember_test', 'use the synthetic ember_test database');
}

async function activitySnapshot(pool: TestPool): Promise<
  readonly {
    readonly state: string;
    readonly wait_event_type: string;
    readonly wait_event: string;
    readonly activeAgeMs: number | null;
  }[]
> {
  const result = await pool.query<{
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    active_age_ms: number | null;
  }>(`
    SELECT COALESCE(state, 'unknown') AS state,
           COALESCE(wait_event_type, 'none') AS wait_event_type,
           COALESCE(wait_event, 'none') AS wait_event,
           CASE WHEN state = 'active'
             THEN GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)::float8
             ELSE NULL
           END AS active_age_ms
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND usename = current_user
       AND application_name = '${APPLICATION_NAME}'
       AND pid <> pg_backend_pid()
  `);

  return result.rows.map((row) => ({
    state: row.state ?? 'unknown',
    wait_event_type: row.wait_event_type ?? 'none',
    wait_event: row.wait_event ?? 'none',
    activeAgeMs: row.active_age_ms,
  }));
}

async function runMeasuredClaims(input: {
  readonly db: Awaited<ReturnType<typeof createTestDatabase>>;
  readonly label: string;
  readonly pools: Readonly<Record<string, TestPool>>;
  readonly trackers: Readonly<Record<string, PoolMetrics>>;
  readonly claims: readonly (() => Promise<unknown>)[];
}): Promise<{
  readonly label: string;
  readonly concurrency: number;
  readonly totalMs: number;
  readonly requestLatency: ReturnType<typeof durationSummary>;
  readonly resultCounts: Readonly<Record<string, number>>;
  readonly failures: Readonly<Record<string, number>>;
  readonly outcomes: readonly ClaimOutcome[];
  readonly pools: Readonly<Record<string, ReturnType<typeof poolSummary>>>;
  readonly activitySampling: {
    readonly sampleCount: number;
    readonly errors: number;
    readonly activeQueryAge: ReturnType<typeof durationSummary>;
    readonly waitEvents: Readonly<Record<string, ActivityMetric>>;
  };
}> {
  const outcomes: ClaimOutcome[] = [];
  const requestLatencyMs: number[] = [];
  const activeQueryAgeMs: number[] = [];
  const waitEvents = new Map<ActivityKey, ActivityMetric>();
  let sampleCount = 0;
  let samplingErrors = 0;
  let sampling = false;

  const recordActivity = async (): Promise<void> => {
    if (sampling) return;
    sampling = true;
    try {
      const rows = await activitySnapshot(input.db.adminPool);
      sampleCount += 1;
      const backendsByWaitEvent = new Map<ActivityKey, number>();
      for (const row of rows) {
        const key: ActivityKey = `${row.state}|${row.wait_event_type}|${row.wait_event}`;
        backendsByWaitEvent.set(key, (backendsByWaitEvent.get(key) ?? 0) + 1);
        if (row.activeAgeMs !== null) activeQueryAgeMs.push(row.activeAgeMs);
      }
      for (const [key, backends] of backendsByWaitEvent) {
        const previous = waitEvents.get(key) ?? { samples: 0, maxBackends: 0 };
        previous.samples += 1;
        previous.maxBackends = Math.max(previous.maxBackends, backends);
        waitEvents.set(key, previous);
      }
    } catch {
      samplingErrors += 1;
    } finally {
      sampling = false;
    }
  };

  const samplePools = (): void => {
    for (const [name, pool] of Object.entries(input.pools)) {
      const metrics = input.trackers[name];
      if (metrics !== undefined) observePool(pool, metrics);
    }
  };

  samplePools();
  await recordActivity();
  const startedAt = performance.now();
  const poolTimer = setInterval(samplePools, 10);
  const activityTimer = setInterval(() => void recordActivity(), SAMPLE_INTERVAL_MS);

  try {
    await Promise.all(
      input.claims.map(async (claim, index) => {
        const requestStartedAt = performance.now();
        try {
          const result = await claim();
          const elapsedMs = performance.now() - requestStartedAt;
          requestLatencyMs.push(elapsedMs);
          outcomes.push({
            index,
            elapsedMs: Number(elapsedMs.toFixed(2)),
            result:
              typeof result === 'object' && result !== null && 'runId' in result
                ? 'lease'
                : 'no_work',
          });
        } catch (error) {
          const elapsedMs = performance.now() - requestStartedAt;
          requestLatencyMs.push(elapsedMs);
          const failure = classifyFailure(error);
          outcomes.push({
            index,
            elapsedMs: Number(elapsedMs.toFixed(2)),
            result: 'error',
            failureClass: failure.kind,
            ...(failure.sqlState === undefined ? {} : { sqlState: failure.sqlState }),
          });
        }
      }),
    );
  } finally {
    clearInterval(poolTimer);
    clearInterval(activityTimer);
    samplePools();
    if (sampling) {
      await new Promise<void>((resolve) => {
        const wait = (): void => {
          if (sampling) setTimeout(wait, 5);
          else resolve();
        };
        wait();
      });
    }
    await recordActivity();
  }

  const resultCounts = outcomes.reduce<Record<string, number>>((counts, outcome) => {
    counts[outcome.result] = (counts[outcome.result] ?? 0) + 1;
    return counts;
  }, {});
  const failures = outcomes.reduce<Record<string, number>>((counts, outcome) => {
    if (outcome.failureClass !== undefined) {
      const key =
        outcome.sqlState === undefined
          ? outcome.failureClass
          : `${outcome.failureClass}:${outcome.sqlState}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, {});

  return {
    label: input.label,
    concurrency: input.claims.length,
    totalMs: Number((performance.now() - startedAt).toFixed(2)),
    requestLatency: durationSummary(requestLatencyMs),
    resultCounts,
    failures,
    outcomes: outcomes.sort((left, right) => left.index - right.index),
    pools: Object.fromEntries(
      Object.entries(input.trackers).map(([name, metrics]) => [name, poolSummary(metrics)]),
    ),
    activitySampling: {
      sampleCount,
      errors: samplingErrors,
      activeQueryAge: durationSummary(activeQueryAgeMs),
      waitEvents: Object.fromEntries(waitEvents.entries()),
    },
  };
}

async function createRuntime(db: Awaited<ReturnType<typeof createTestDatabase>>, label: string) {
  const agents = new PostgresAgentRepository(db.pool);
  const tasks = new PostgresTaskRepository(db.pool);
  const tenant = await createTenantFixture(db.pool, `${label} tenant`);
  const context = {
    tenantId: tenant.tenantId,
    principalId: tenant.principalId,
    policyVersion: 1,
  };
  const agent = await agents.create(context, { name: `${label} agent` });
  const clock = new ManualClock(new Date((await databaseNow(db.pool)).getTime() + 5));
  return { tasks, tenant, context, agent, clock };
}

async function verifyLeases(input: {
  readonly db: Awaited<ReturnType<typeof createTestDatabase>>;
  readonly taskTenantById: ReadonlyMap<string, string>;
  readonly returned: readonly {
    readonly taskId: string;
    readonly tenantId: string;
    readonly runId: string;
  }[];
}): Promise<{
  readonly taskCount: number;
  readonly committedLeaseCount: number;
  readonly returnedLeaseCount: number;
  readonly committedWithoutResponse: number;
  readonly duplicateTaskIds: number;
  readonly duplicateRunIds: number;
  readonly invalidTenantReferences: number;
  readonly inconsistentTaskRunEvents: number;
  readonly passed: boolean;
}> {
  const returnedTaskIds = new Set(input.returned.map((lease) => lease.taskId));
  const returnedRunIds = new Set(input.returned.map((lease) => lease.runId));
  const duplicateTaskIds = input.returned.length - returnedTaskIds.size;
  const duplicateRunIds = input.returned.length - returnedRunIds.size;
  const committedTaskIds = new Set<string>();
  let invalidTenantReferences = 0;
  let inconsistentTaskRunEvents = 0;
  let committedLeaseCount = 0;

  for (const [taskId, tenantId] of input.taskTenantById) {
    const task = await readTask(input.db.pool, tenantId, taskId);
    const runs = await listRuns(input.db.pool, tenantId, taskId);
    const events = await listEventSnapshots(input.db.pool, tenantId, taskId);
    const activeRuns = runs.filter((run) => run.status === 'created' || run.status === 'running');

    if (task.status === 'running') {
      committedLeaseCount += 1;
      committedTaskIds.add(taskId);
      if (
        activeRuns.length !== 1 ||
        task.attempt_count !== 1 ||
        task.lease_epoch !== '1' ||
        task.current_run_id !== activeRuns[0]?.id ||
        activeRuns[0]?.status !== 'running' ||
        activeRuns[0]?.lease_epoch !== '1' ||
        events.map((event) => event.phase).join(',') !== 'accepted,leased,started'
      ) {
        inconsistentTaskRunEvents += 1;
      }
    } else if (task.status !== 'queued' || runs.length !== 0 || events.length !== 1) {
      inconsistentTaskRunEvents += 1;
    }
  }

  for (const lease of input.returned) {
    if (input.taskTenantById.get(lease.taskId) !== lease.tenantId) {
      invalidTenantReferences += 1;
    }
  }

  const committedWithoutResponse = [...committedTaskIds].filter(
    (taskId) => !returnedTaskIds.has(taskId),
  ).length;

  return {
    taskCount: input.taskTenantById.size,
    committedLeaseCount,
    returnedLeaseCount: returnedTaskIds.size,
    committedWithoutResponse,
    duplicateTaskIds,
    duplicateRunIds,
    invalidTenantReferences,
    inconsistentTaskRunEvents,
    passed:
      duplicateTaskIds === 0 &&
      duplicateRunIds === 0 &&
      invalidTenantReferences === 0 &&
      inconsistentTaskRunEvents === 0,
  };
}

async function serverFacts(db: Awaited<ReturnType<typeof createTestDatabase>>): Promise<{
  readonly version: string;
  readonly versionNum: number;
  readonly ssl: boolean;
  readonly maxConnections: string;
  readonly statementTimeout: string;
  readonly schemaMigrationCount: number;
}> {
  const result = await db.pool.query<{
    server_version: string;
    server_version_num: string;
    ssl: boolean | null;
    max_connections: string;
    statement_timeout: string;
    migration_count: string;
  }>(`
    SELECT current_setting('server_version') AS server_version,
           current_setting('server_version_num') AS server_version_num,
           (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl,
           current_setting('max_connections') AS max_connections,
           current_setting('statement_timeout') AS statement_timeout,
           (SELECT count(*)::text FROM schema_migrations) AS migration_count
  `);
  const row = result.rows[0];
  assert(row !== undefined, 'PostgreSQL facts query returned no row');
  const versionNum = Number(row.server_version_num);
  const versionMajor = Math.floor(versionNum / 10_000);
  assert(versionMajor === 17, 'Neon diagnostic database must be PostgreSQL 17');
  assert(
    row.server_version.startsWith('17.11'),
    'Neon diagnostic database must be PostgreSQL 17.11',
  );
  assert(row.ssl === true, 'Neon diagnostic connection must use TLS');

  return {
    version: row.server_version,
    versionNum,
    ssl: row.ssl,
    maxConnections: row.max_connections,
    statementTimeout: row.statement_timeout,
    schemaMigrationCount: Number(row.migration_count),
  };
}

async function runSinglePoolScenario(
  poolSize: (typeof POOL_SIZES)[number],
  concurrency: (typeof CONCURRENCY_LEVELS)[number],
) {
  const db = await createTestDatabase({
    maxConnections: poolSize,
    applicationName: APPLICATION_NAME,
  });
  try {
    const label = `single-pool-${poolSize}-concurrency-${concurrency}`;
    const runtime = await createRuntime(db, label);
    const tasks: { readonly taskId: string; readonly tenantId: string }[] = [];
    for (let index = 0; index < concurrency; index += 1) {
      tasks.push(
        await createQueuedTask(
          runtime.tasks,
          runtime.context,
          runtime.agent.agentId,
          `${label}-${index}`,
        ),
      );
    }
    const metrics = emptyPoolMetrics();
    const measuredPool = instrumentPool(db.pool, poolSize, metrics);
    const queue = new PostgresLeaseQueue(measuredPool, {
      ...CLAIM_OPTIONS,
      clock: runtime.clock,
    });
    const taskTenantById = new Map(tasks.map((task) => [task.taskId, task.tenantId] as const));
    const returned: { taskId: string; tenantId: string; runId: string }[] = [];
    const result = await runMeasuredClaims({
      db,
      label,
      pools: { queue: db.pool },
      trackers: { queue: metrics },
      claims: Array.from({ length: concurrency }, (_, index) => async () => {
        const lease = await queue.claimNext(`${label}-worker-${index}`, runtime.clock.now());
        if (lease !== null) {
          returned.push({ taskId: lease.taskId, tenantId: lease.tenantId, runId: lease.runId });
        }
        return lease;
      }),
    });
    const integrity = await verifyLeases({ db, taskTenantById, returned });
    return {
      ...result,
      poolLayout: { queue: poolSize },
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
      integrity,
    };
  } finally {
    await db.close();
  }
}

async function runOriginalSplitPoolScenario(repeat: number) {
  const db = await createTestDatabase({
    maxConnections: 32,
    connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    statementTimeoutMs: PRIOR_STATEMENT_TIMEOUT_MS,
    applicationName: APPLICATION_NAME,
  });
  try {
    const label = `original-split-pools-32-plus-2-repeat-${repeat}`;
    const postgres = await serverFacts(db);
    const agents = new PostgresAgentRepository(db.pool);
    const tasksRepo = new PostgresTaskRepository(db.pool);
    const tenantA = await createTenantFixture(db.pool, `${label} tenant A`);
    const tenantB = await createTenantFixture(db.pool, `${label} tenant B`);
    const contextA = {
      tenantId: tenantA.tenantId,
      principalId: tenantA.principalId,
      policyVersion: 1,
    };
    const contextB = {
      tenantId: tenantB.tenantId,
      principalId: tenantB.principalId,
      policyVersion: 1,
    };
    const agentA = await agents.create(contextA, { name: `${label} agent A` });
    const agentB = await agents.create(contextB, { name: `${label} agent B` });
    const tasksA = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createQueuedTask(tasksRepo, contextA, agentA.agentId, `${label}-a-${index}`),
      ),
    );
    const tasksB = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createQueuedTask(tasksRepo, contextB, agentB.agentId, `${label}-b-${index}`),
      ),
    );
    const clock = new ManualClock(new Date((await databaseNow(db.pool)).getTime() + 5));
    const queueAMetrics = emptyPoolMetrics();
    const queueBMetrics = emptyPoolMetrics();
    const queueA = new PostgresLeaseQueue(instrumentPool(db.pool, 32, queueAMetrics), {
      ...CLAIM_OPTIONS,
      clock,
    });
    const queueB = new PostgresLeaseQueue(instrumentPool(db.observerPool, 2, queueBMetrics), {
      ...CLAIM_OPTIONS,
      clock,
    });
    const taskTenantById = new Map(
      [...tasksA, ...tasksB].map((task) => [task.taskId, task.tenantId] as const),
    );
    const returned: { taskId: string; tenantId: string; runId: string }[] = [];
    const claims = [
      ...Array.from({ length: ORIGINAL_CONCURRENCY_PER_QUEUE }, (_, index) => async () => {
        const lease = await queueA.claimNext(`${label}-a-worker-${index}`, clock.now());
        if (lease !== null) {
          returned.push({ taskId: lease.taskId, tenantId: lease.tenantId, runId: lease.runId });
        }
        return lease;
      }),
      ...Array.from({ length: ORIGINAL_CONCURRENCY_PER_QUEUE }, (_, index) => async () => {
        const lease = await queueB.claimNext(`${label}-b-worker-${index}`, clock.now());
        if (lease !== null) {
          returned.push({ taskId: lease.taskId, tenantId: lease.tenantId, runId: lease.runId });
        }
        return lease;
      }),
    ];
    const result = await runMeasuredClaims({
      db,
      label,
      pools: { queueA: db.pool, queueB: db.observerPool },
      trackers: { queueA: queueAMetrics, queueB: queueBMetrics },
      claims,
    });
    const integrity = await verifyLeases({ db, taskTenantById, returned });
    return {
      ...result,
      postgres,
      poolLayout: { queueA: 32, queueB: 2 },
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: PRIOR_STATEMENT_TIMEOUT_MS,
      integrity,
    };
  } finally {
    await db.close();
  }
}

async function runDiagnostics(): Promise<void> {
  const url = process.env.NEON_DIAGNOSTIC_DATABASE_URL;
  assert(url !== undefined && url.length > 0, 'NEON_DIAGNOSTIC_DATABASE_URL is required');
  safeConnectionCheck(url);

  process.env.TEST_DATABASE_URL = url;
  const config = loadDatabaseConfig({ DATABASE_URL: url });
  assert(
    config.connectionTimeoutMs === CONNECTION_TIMEOUT_MS,
    'repository default connection timeout changed; update this diagnostic before running',
  );
  assert(
    config.statementTimeoutMs === DEFAULT_STATEMENT_TIMEOUT_MS,
    'repository default statement timeout changed; update this diagnostic before running',
  );
  const factsPool = createPool({ ...config, maxConnections: 1 });
  try {
    const initial = await factsPool.query<{
      server_version: string;
      server_version_num: string;
      ssl: boolean | null;
      max_connections: string;
    }>(`
      SELECT current_setting('server_version') AS server_version,
             current_setting('server_version_num') AS server_version_num,
             (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl,
             current_setting('max_connections') AS max_connections
    `);
    const row = initial.rows[0];
    assert(row !== undefined, 'initial PostgreSQL probe returned no row');
    assert(
      Math.floor(Number(row.server_version_num) / 10_000) === 17,
      'target is not PostgreSQL 17',
    );
    assert(row.server_version.startsWith('17.11'), 'target is not PostgreSQL 17.11');
    assert(row.ssl === true, 'target connection is not using TLS');
  } finally {
    await factsPool.end();
  }

  const original: Awaited<ReturnType<typeof runOriginalSplitPoolScenario>>[] = [];
  for (let repeat = 1; repeat <= 2; repeat += 1) {
    original.push(await runOriginalSplitPoolScenario(repeat));
  }
  const facts = original[0]?.postgres;
  assert(facts !== undefined, 'no PostgreSQL facts were captured');
  const matrix: Awaited<ReturnType<typeof runSinglePoolScenario>>[] = [];
  for (const concurrency of CONCURRENCY_LEVELS) {
    for (const poolSize of POOL_SIZES) {
      matrix.push(await runSinglePoolScenario(poolSize, concurrency));
    }
  }

  const report = {
    evidenceType: 'synthetic Neon direct/unpooled PostgreSQL claim diagnostic',
    exactHeadSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    postgres: facts,
    connection: {
      endpoint: 'direct/unpooled',
      tlsVerified: true,
      maxPoolConnectionWaitMs: CONNECTION_TIMEOUT_MS,
      matrixStatementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
      originalStatementTimeoutMs: PRIOR_STATEMENT_TIMEOUT_MS,
    },
    originalSplitPoolReproductions: original,
    matrix,
    capacityCaveat:
      'Short bounded claim bursts do not establish sustained capacity or a 10,000-user acceptance limit.',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  assert(
    original.every((scenario) => scenario.integrity.passed),
    'an original split-pool run violated lease invariants',
  );
  assert(
    matrix.every((scenario) => scenario.integrity.passed),
    'a matrix run violated lease invariants',
  );
}

runDiagnostics().catch((error: unknown) => {
  const failure = classifyFailure(error);
  const name = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(
    `Neon claim diagnostic stopped (${name}, ${failure.kind}${failure.sqlState === undefined ? '' : `, SQLSTATE ${failure.sqlState}`}); the connection string and raw server message were not printed.\n`,
  );
  process.exitCode = 1;
});
