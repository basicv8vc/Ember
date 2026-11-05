import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  loadDatabaseConfig,
  runMigrations,
  type DatabaseConfig,
} from '@ember/postgres';
import { PostgresB1ConversationWriteRepository } from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import {
  cleanupAllWorkerSubprocesses,
  spawnWorkerSubprocess,
  type WorkerSubprocessHandle,
} from '../chaos/harness/worker-subprocess.js';
import { assertSafeTestDatabaseUrl } from './support/e2e-cluster.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const DATABASE_NAME_PATTERN = /^ember_worker_recovery_[a-f0-9]{12}$/;
const OUTAGE_MS = 300;
const TURN_WAIT_MS = 15_000;
const ACTIVE_QUERY_WAIT_MS = 10_000;
const PRIVATE_SOURCE = 'private worker recovery prompt 9f71c2';

interface TurnFixture {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly turnId: string;
}

let adminPool: ReturnType<typeof createPool> | undefined;
let observerPool: ReturnType<typeof createPool> | undefined;
let writer: PostgresB1ConversationWriteRepository | undefined;
let worker: WorkerSubprocessHandle | undefined;
let databaseName: string | undefined;
let databaseUrl: string | undefined;
let blobRoot: string | undefined;
let identity: Omit<TurnFixture, 'turnId'> | undefined;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTurn(sourceText: string): Promise<TurnFixture> {
  if (observerPool === undefined || writer === undefined || identity === undefined) {
    throw new Error('isolated Worker recovery fixture is not initialized');
  }

  const submission = await writer.submitUserMessage({
    tenantId: identity.tenantId,
    conversationId: identity.conversationId,
    request: {
      client_submission_id: randomUUID(),
      text: sourceText,
      transcript_epoch: 0,
    },
  });

  return {
    ...identity,
    turnId: submission.receipt.turn.turn_id,
  };
}

async function waitForActiveCompletionQuery(): Promise<number> {
  if (adminPool === undefined || databaseName === undefined) {
    throw new Error('isolated Worker recovery fixture is not initialized');
  }

  const deadline = Date.now() + ACTIVE_QUERY_WAIT_MS;
  while (Date.now() < deadline) {
    const result = await adminPool.query<{ pid: number }>(
      `SELECT pid
         FROM pg_stat_activity
        WHERE datname = $1
          AND application_name = 'ember'
          AND state = 'active'
          AND wait_event = 'PgSleep'
          AND query LIKE '%UPDATE assistant_turns%'`,
      [databaseName],
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await delay(25);
  }

  throw new Error('Worker did not enter the injected active Turn completion query');
}

async function blockDatabaseConnections(activePid: number): Promise<void> {
  if (adminPool === undefined || databaseName === undefined) {
    throw new Error('isolated Worker recovery fixture is not initialized');
  }

  await adminPool.query(`ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS FALSE`);
  const terminated = await adminPool.query<{ pid: number; terminated: boolean }>(
    `SELECT pid, pg_terminate_backend(pid) AS terminated
       FROM pg_stat_activity
      WHERE datname = $1 AND application_name = 'ember' AND pid <> pg_backend_pid()`,
    [databaseName],
  );

  if (!terminated.rows.some((row) => row.pid === activePid && row.terminated)) {
    throw new Error('the active Worker PostgreSQL backend was not terminated');
  }
}

async function allowDatabaseConnections(): Promise<void> {
  if (adminPool === undefined || databaseName === undefined) return;
  await adminPool.query(`ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS TRUE`);
}

async function readTurn(fixture: TurnFixture): Promise<{
  status: string;
  response_message_id: string | null;
}> {
  if (observerPool === undefined) throw new Error('observer pool is not initialized');
  const result = await observerPool.query<{
    status: string;
    response_message_id: string | null;
  }>(
    `SELECT status, response_message_id
       FROM assistant_turns
      WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3`,
    [fixture.tenantId, fixture.conversationId, fixture.turnId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('durable assistant Turn was not found');
  return row;
}

async function readAssistantMessageCount(fixture: TurnFixture): Promise<number> {
  if (observerPool === undefined) throw new Error('observer pool is not initialized');
  const result = await observerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM conversation_messages
      WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'`,
    [fixture.tenantId, fixture.conversationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function waitForCompletedTurn(fixture: TurnFixture): Promise<void> {
  const deadline = Date.now() + TURN_WAIT_MS;
  while (Date.now() < deadline) {
    const turn = await readTurn(fixture);
    if (turn.status === 'completed' && turn.response_message_id !== null) return;
    await delay(50);
  }
  throw new Error('durable assistant Turn did not complete after database recovery');
}

describe('Worker recovery from isolated PostgreSQL connection loss', () => {
  beforeAll(async () => {
    const testUrl = process.env.TEST_DATABASE_URL;
    if (testUrl === undefined || testUrl.length === 0) {
      throw new Error('TEST_DATABASE_URL is required for Worker recovery E2E');
    }
    assertSafeTestDatabaseUrl(testUrl);

    const baseConfig: DatabaseConfig = loadDatabaseConfig({ DATABASE_URL: testUrl });
    adminPool = createPool({ ...baseConfig, maxConnections: 2 });
    const version = await adminPool.query<{ version: string }>('SELECT version() AS version');
    if (!/^PostgreSQL 17\./.test(version.rows[0]?.version ?? '')) {
      throw new Error('Worker recovery E2E requires PostgreSQL 17');
    }

    databaseName = `ember_worker_recovery_${randomBytes(6).toString('hex')}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);

    const target = new URL(testUrl);
    target.pathname = `/${databaseName}`;
    target.searchParams.delete('options');
    databaseUrl = target.toString();
    observerPool = createPool({
      ...loadDatabaseConfig({ DATABASE_URL: databaseUrl }),
      maxConnections: 3,
      applicationName: 'ember-worker-recovery-observer',
    });
    await runMigrations(observerPool, MIGRATIONS_DIR);
    writer = new PostgresB1ConversationWriteRepository(observerPool);

    identity = {
      tenantId: randomUUID(),
      conversationId: randomUUID(),
    };
    const agentId = randomUUID();
    await observerPool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
      identity.tenantId,
      'worker recovery test',
    ]);
    await observerPool.query(
      'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
      [agentId, identity.tenantId, 'worker recovery test agent'],
    );
    await observerPool.query(
      "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
      [identity.conversationId, identity.tenantId, agentId],
    );

    await observerPool.query(
      `CREATE TABLE public.worker_recovery_faults (turn_id uuid PRIMARY KEY);
       CREATE FUNCTION public.worker_recovery_pause_completion() RETURNS trigger
       LANGUAGE plpgsql AS $body$
       BEGIN
         IF OLD.status = 'running'
            AND EXISTS (SELECT 1 FROM public.worker_recovery_faults WHERE turn_id = OLD.id) THEN
           PERFORM pg_sleep(8);
         END IF;
         RETURN NEW;
       END;
       $body$;
       CREATE TRIGGER worker_recovery_pause_completion
       BEFORE UPDATE OF status ON public.assistant_turns
       FOR EACH ROW EXECUTE FUNCTION public.worker_recovery_pause_completion();`,
    );

    blobRoot = mkdtempSync(path.join(tmpdir(), 'ember-worker-recovery-'));
    worker = await spawnWorkerSubprocess({
      schema: 'public',
      blobRootDir: blobRoot,
      workerId: 'worker-pg-recovery-e2e',
      databaseUrl,
      mode: 'reaper-only',
      extraEnv: {
        EMBER_B1_FAKE_RESPONDER_ENABLED: 'true',
        EMBER_WORKER_INTERVAL_MS: '100',
        EMBER_WORKER_ERROR_BACKOFF_MS: '1000',
      },
    });
    await worker.waitForLog('fake B1 assistant turn responder enabled');
  }, 60_000);

  afterAll(async () => {
    if (worker?.isAlive()) {
      await worker.sigterm().catch(() => undefined);
    }
    await cleanupAllWorkerSubprocesses();
    await observerPool?.end().catch(() => undefined);
    if (
      adminPool !== undefined &&
      databaseName !== undefined &&
      DATABASE_NAME_PATTERN.test(databaseName)
    ) {
      await adminPool
        .query(`ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS TRUE`)
        .catch(() => undefined);
      await adminPool
        .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        .catch(() => undefined);
    }
    await adminPool?.end().catch(() => undefined);
    if (blobRoot !== undefined) rmSync(blobRoot, { recursive: true, force: true });
  }, 30_000);

  it('survives repeated active-query connection termination and resumes each durable Turn once', async () => {
    if (
      adminPool === undefined ||
      observerPool === undefined ||
      worker === undefined ||
      databaseName === undefined
    ) {
      throw new Error('isolated Worker recovery fixture is not initialized');
    }

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const fixture = await createTurn(`${PRIVATE_SOURCE} cycle ${cycle + 1}`);
      await observerPool.query('INSERT INTO public.worker_recovery_faults (turn_id) VALUES ($1)', [
        fixture.turnId,
      ]);

      const activePid = await waitForActiveCompletionQuery();
      let blocked = false;
      try {
        blocked = true;
        await blockDatabaseConnections(activePid);
        await delay(OUTAGE_MS);
        expect(
          worker.isAlive(),
          'Worker must remain alive while its database rejects connections',
        ).toBe(true);
      } finally {
        if (blocked) await allowDatabaseConnections();
      }

      // The killed completion transaction rolls back both the response Message and Turn update.
      await observerPool.query('DELETE FROM public.worker_recovery_faults WHERE turn_id = $1', [
        fixture.turnId,
      ]);
      expect(await readTurn(fixture)).toMatchObject({
        status: 'running',
        response_message_id: null,
      });
      await waitForCompletedTurn(fixture);
      await delay(600);
      expect(await readAssistantMessageCount(fixture)).toBe(cycle + 1);
      expect(worker.isAlive()).toBe(true);
    }

    const logs = worker.getLogs();
    const password =
      databaseUrl === undefined ? '' : decodeURIComponent(new URL(databaseUrl).password);
    expect(logs.includes(PRIVATE_SOURCE)).toBe(false);
    expect(databaseUrl === undefined || !logs.includes(databaseUrl)).toBe(true);
    expect(password.length === 0 || !logs.includes(password)).toBe(true);
  }, 90_000);

  it('gracefully drains on SIGTERM and SIGINT', async () => {
    if (worker === undefined || databaseUrl === undefined || blobRoot === undefined) {
      throw new Error('isolated Worker recovery fixture is not initialized');
    }

    const termResult = await worker.sigterm();
    expect(termResult).toMatchObject({ code: 0, signal: null });

    const interruptWorker = await spawnWorkerSubprocess({
      schema: 'public',
      blobRootDir: blobRoot,
      workerId: 'worker-pg-recovery-interrupt-e2e',
      databaseUrl,
      mode: 'reaper-only',
      extraEnv: { EMBER_B1_FAKE_RESPONDER_ENABLED: 'true' },
    });
    await interruptWorker.waitForLog('fake B1 assistant turn responder enabled');
    process.kill(interruptWorker.pid, 'SIGINT');
    const interruptResult = await interruptWorker.exitPromise;
    expect(interruptResult).toMatchObject({ code: 0, signal: null });
  }, 30_000);
});
