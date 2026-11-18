import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PYTHON_AGENT_LIMITS } from '@ember/contracts';
import {
  PostgresB1ConversationWriteRepository,
  PostgresB3StagedUploadRepository,
  PostgresByteaBlobStore,
  PostgresLeaseQueue,
  PostgresModelTurnExecutionRepository,
  PostgresPythonAgentExecutionRepository,
  PostgresR2BlobStore,
  blobKeyFor,
  blobLockKey,
  resolveLeaseQueueConfig,
  stagingKeyFor,
  systemClock,
  type R2BucketPort,
  type R2ObjectBodyPort,
  type R2PutOptionsPort,
} from '@ember/postgres';
import { executePythonAgentRun } from '../../apps/worker/src/b3/python-agent-executor.js';
import type { WorkerLogger } from '../../apps/worker/src/logger.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  observeAdvisoryLock,
  resolveAdvisoryLockIdentity,
  waitForAdvisoryLockQueueEntry,
} from './support/advisory-locks.js';

class InstrumentedR2Bucket implements R2BucketPort {
  readonly objects = new Map<
    string,
    { readonly body: Uint8Array; readonly options: R2PutOptionsPort | undefined }
  >();
  getCount = 0;
  putHook: ((key: string) => Promise<void> | void) | null = null;
  deleteHook: ((keys: readonly string[]) => Promise<void> | void) | null = null;

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: R2PutOptionsPort,
  ): Promise<unknown> {
    await this.putHook?.(key);
    const view =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, {
      body: new Uint8Array(view),
      options,
    });
    return { key, size: view.byteLength };
  }

  get(key: string): Promise<R2ObjectBodyPort | null> {
    this.getCount += 1;
    const entry = this.objects.get(key);
    if (entry === undefined) {
      return Promise.resolve(null);
    }
    const copy = new Uint8Array(entry.body);
    return Promise.resolve({
      size: copy.byteLength,
      arrayBuffer: () => Promise.resolve(copy.buffer),
    });
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    await this.deleteHook?.(list);
    for (const key of list) {
      this.objects.delete(key);
    }
  }
}

const SILENT_LOGGER: WorkerLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let db: TestDatabase;
let writer: PostgresB1ConversationWriteRepository;

async function createTenantFixture() {
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();

  await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
    tenantId,
    'r2 concurrency test tenant',
  ]);
  await db.pool.query("INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')", [
    principalId,
    tenantId,
  ]);
  await db.pool.query('INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)', [
    randomUUID(),
    tenantId,
    principalId,
  ]);
  await db.pool.query(
    'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
    [agentId, tenantId, 'Ember'],
  );
  await db.pool.query(
    "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
    [conversationId, tenantId, agentId],
  );

  return { tenantId, principalId, agentId, conversationId };
}

async function createIsolatedConversation(tenantId: string): Promise<string> {
  const agentId = randomUUID();
  const conversationId = randomUUID();
  await db.pool.query(
    'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
    [agentId, tenantId, `Ember-${agentId.slice(0, 6)}`],
  );
  await db.pool.query(
    "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
    [conversationId, tenantId, agentId],
  );
  return conversationId;
}

/**
 * Wrap `pool` without ES Proxies so `client.query` and `client.release` retain exact `pg` `this` binding
 * while tests inject deterministic race hooks on real PG17 connections.
 */
function createInterceptedPool(
  pool: typeof db.pool,
  onClientQuery: (context: {
    readonly sql: string;
    readonly txIndex: number;
    readonly client: { query: (sql: string, params?: unknown[]) => Promise<unknown> };
  }) => Promise<void> | void,
): typeof db.pool {
  let txIndex = 0;
  return {
    query: (...args: unknown[]) => (pool.query as (...a: unknown[]) => unknown)(...args),
    connect: async () => {
      const client = await pool.connect();
      const rawQuery = client.query.bind(client) as (
        sql: string,
        params?: unknown[],
      ) => Promise<unknown>;
      const directClient = { query: rawQuery };
      const wrappedClient = {
        query: async (...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : '';
          if (sql === 'BEGIN') {
            txIndex += 1;
          }
          await onClientQuery({ sql, txIndex, client: directClient });
          return (rawQuery as (...a: unknown[]) => Promise<unknown>)(...args);
        },
        release: (err?: Error | boolean) => client.release(err),
      };
      return wrappedClient;
    },
  } as unknown as typeof db.pool;
}

function wrapPoolBeforeNthTransaction(
  pool: typeof db.pool,
  targetTxIndex: number,
  beforeBegin: () => Promise<void>,
): typeof db.pool {
  return createInterceptedPool(pool, async ({ sql, txIndex }) => {
    if (sql === 'BEGIN' && txIndex === targetTxIndex) {
      await beforeBegin();
    }
  });
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 16 });
  writer = new PostgresB1ConversationWriteRepository(db.pool);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('PG17 R2 lock-held write/delete concurrency, migration 0023, and aggregate file budget', () => {
  it('preserves R2 blob when another worker commits the same digest after delegation rollback and before cleanup acquires the lock', async () => {
    const tenant = await createTenantFixture();
    const convA = tenant.conversationId;
    const convB = await createIsolatedConversation(tenant.tenantId);
    const bucket = new InstrumentedR2Bucket();
    const uploadRepo = new PostgresB3StagedUploadRepository(db.pool, { r2Bucket: bucket });
    const bytes = new TextEncoder().encode('shared-content-addressed-payload-for-rollback-race');
    const sha256 = sha256Of(bytes);
    const blobKey = blobKeyFor(tenant.tenantId, sha256);

    const auth = {
      tenantId: tenant.tenantId,
      principalId: tenant.principalId,
      policyVersion: 1,
    };
    const upA = await uploadRepo.stageUpload(auth, {
      filename: 'a.txt',
      mediaType: 'text/plain',
      bytes,
    });
    const upB = await uploadRepo.stageUpload(auth, {
      filename: 'b.txt',
      mediaType: 'text/plain',
      bytes,
    });

    const msgA = await writer.submitUserMessage({
      tenantId: tenant.tenantId,
      principalId: tenant.principalId,
      conversationId: convA,
      request: {
        client_submission_id: randomUUID(),
        text: 'Analyze A',
        transcript_epoch: 0,
        attachment_ids: [upA.upload_id],
      },
    });
    const msgB = await writer.submitUserMessage({
      tenantId: tenant.tenantId,
      principalId: tenant.principalId,
      conversationId: convB,
      request: {
        client_submission_id: randomUUID(),
        text: 'Analyze B',
        transcript_epoch: 0,
        attachment_ids: [upB.upload_id],
      },
    });

    const turnRepoB = new PostgresModelTurnExecutionRepository(db.pool, { r2Bucket: bucket });
    const claimA = await turnRepoB.claimTurn({
      turn: {
        tenantId: tenant.tenantId,
        conversationId: convA,
        turnId: msgA.receipt.turn.turn_id,
      },
      workerId: 'worker-a',
      leaseMs: 30_000,
    });
    const claimB = await turnRepoB.claimTurn({
      turn: {
        tenantId: tenant.tenantId,
        conversationId: convB,
        turnId: msgB.receipt.turn.turn_id,
      },
      workerId: 'worker-b',
      leaseMs: 30_000,
    });
    expect(claimA.kind).toBe('claimed');
    expect(claimB.kind).toBe('claimed');
    if (claimA.kind !== 'claimed' || claimB.kind !== 'claimed') return;

    // Make turn A cross its deadline right before markTurnCompleted so SAVEPOINT b3_delegation_attempt rolls back.
    await db.pool.query(
      `UPDATE assistant_turns
          SET deadline_at = clock_timestamp() - interval '1 millisecond'
        WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [claimA.lease.turnId, tenant.tenantId],
    );

    // Wait: isExpired(client, locked) checks deadline BEFORE SAVEPOINT, so make markTurnCompleted observe deadline:
    // Use an intercepted pool for worker A that updates deadline_at right before INSERT INTO tasks and stalls cleanup TX (tx #2)
    // until Worker B finishes committing the exact same blob digest on a separate PG17 connection.
    await db.pool.query(
      `UPDATE assistant_turns
          SET deadline_at = clock_timestamp() + interval '5 seconds'
        WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [claimA.lease.turnId, tenant.tenantId],
    );

    let workerBPushed = false;
    let expiredTurnA = false;
    const poolAExpireAndRace = createInterceptedPool(db.pool, async ({ sql, txIndex, client }) => {
      if (
        !expiredTurnA &&
        sql.includes('UPDATE assistant_turns t') &&
        sql.includes('WITH decision AS')
      ) {
        expiredTurnA = true;
        await client.query(
          `UPDATE assistant_turns
              SET deadline_at = clock_timestamp() - interval '10 milliseconds'
            WHERE id = $1::uuid`,
          [claimA.lease.turnId],
        );
      }
      if (sql === 'BEGIN' && txIndex === 2) {
        // TX #1 (savepoint rollback + turn timeout) already committed and released advisory lock.
        // Before TX #2 (cleanupUnreferencedR2Keys) begins, Worker B acquires lock, writes R2 & commits same digest.
        workerBPushed = true;
        const pubB = await turnRepoB.publishCompletion({
          lease: claimB.lease,
          result: {
            status: 'completed',
            text: 'Delegated B',
            modelLabel: 'openrouter/deepseek-v4.1-flash-1017',
            simulated: false,
            delegation: {
              toolName: 'delegate_python_agent',
              title: 'Task B',
              input: { prompt: 'Run B', attachmentIds: [upB.upload_id] },
            },
          },
        });
        expect(pubB).toMatchObject({ outcome: 'published' });
        if (pubB.outcome === 'published') {
          expect(pubB.delegatedTaskId).not.toBeNull();
        }
      }
    });

    const turnRepoA = new PostgresModelTurnExecutionRepository(poolAExpireAndRace, {
      r2Bucket: bucket,
    });
    const pubA = await turnRepoA.publishCompletion({
      lease: claimA.lease,
      result: {
        status: 'completed',
        text: 'Delegated A',
        modelLabel: 'openrouter/deepseek-v4.1-flash-1017',
        simulated: false,
        delegation: {
          toolName: 'delegate_python_agent',
          title: 'Task A',
          input: { prompt: 'Run A', attachmentIds: [upA.upload_id] },
        },
      },
    });

    expect(pubA).toMatchObject({ outcome: 'published', delegatedTaskId: null });
    expect(workerBPushed).toBe(true);
    // Worker A's cleanup re-acquired lock, saw Worker B's committed DB rows, and kept R2 intact.
    expect(bucket.objects.has(blobKey)).toBe(true);

    const bArtifacts = await db.pool.query<{ id: string }>(
      `SELECT id FROM artifacts WHERE tenant_id = $1::uuid AND sha256 = $2`,
      [tenant.tenantId, sha256],
    );
    expect(bArtifacts.rows).toHaveLength(1);
    const downloaded = await uploadRepo.getTaskArtifactDownload(auth, bArtifacts.rows[0]!.id);
    expect(downloaded?.bytes).toEqual(bytes);
  });

  it('holds digest advisory lock during R2 deletion so concurrent commit queues behind delete on PG17 pg_locks', async () => {
    const tenant = await createTenantFixture();
    const convA = tenant.conversationId;
    const convB = await createIsolatedConversation(tenant.tenantId);
    const bucket = new InstrumentedR2Bucket();
    const uploadRepo = new PostgresB3StagedUploadRepository(db.pool, { r2Bucket: bucket });
    const turnRepo = new PostgresModelTurnExecutionRepository(db.pool, { r2Bucket: bucket });

    const bytes = new TextEncoder().encode('lock-held-r2-delete-order-test');
    const sha256 = sha256Of(bytes);
    const blobKey = blobKeyFor(tenant.tenantId, sha256);
    const lockKey = blobLockKey(tenant.tenantId, sha256);

    const auth = {
      tenantId: tenant.tenantId,
      principalId: tenant.principalId,
      policyVersion: 1,
    };
    const upA = await uploadRepo.stageUpload(auth, {
      filename: 'a.txt',
      mediaType: 'text/plain',
      bytes,
    });
    const upB = await uploadRepo.stageUpload(auth, {
      filename: 'b.txt',
      mediaType: 'text/plain',
      bytes,
    });

    const msgA = await writer.submitUserMessage({
      tenantId: tenant.tenantId,
      principalId: tenant.principalId,
      conversationId: convA,
      request: {
        client_submission_id: randomUUID(),
        text: 'Turn A',
        transcript_epoch: 0,
        attachment_ids: [upA.upload_id],
      },
    });
    const msgB = await writer.submitUserMessage({
      tenantId: tenant.tenantId,
      principalId: tenant.principalId,
      conversationId: convB,
      request: {
        client_submission_id: randomUUID(),
        text: 'Turn B',
        transcript_epoch: 0,
        attachment_ids: [upB.upload_id],
      },
    });

    const claimA = await turnRepo.claimTurn({
      turn: { tenantId: tenant.tenantId, conversationId: convA, turnId: msgA.receipt.turn.turn_id },
      workerId: 'worker-del-a',
      leaseMs: 30_000,
    });
    const claimB = await turnRepo.claimTurn({
      turn: { tenantId: tenant.tenantId, conversationId: convB, turnId: msgB.receipt.turn.turn_id },
      workerId: 'worker-del-b',
      leaseMs: 30_000,
    });
    if (claimA.kind !== 'claimed' || claimB.kind !== 'claimed') throw new Error('claim failed');

    // Make Turn A throw right before commit so it enters cleanupUnreferencedR2Keys.
    const poolA = createInterceptedPool(db.pool, ({ sql }) => {
      if (sql.includes('UPDATE assistant_turns t') && sql.includes('WITH decision AS')) {
        throw new Error('simulated failure after R2 put');
      }
    });
    const repoA = new PostgresModelTurnExecutionRepository(poolA, { r2Bucket: bucket });

    let deleteEntered!: () => void;
    const deleteEnteredPromise = new Promise<void>((resolve) => {
      deleteEntered = resolve;
    });
    let releaseDelete!: () => void;
    const releaseDeletePromise = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    bucket.deleteHook = async (keys) => {
      if (keys.includes(blobKey)) {
        deleteEntered();
        await releaseDeletePromise;
      }
    };

    const pubAPromise = repoA
      .publishCompletion({
        lease: claimA.lease,
        result: {
          status: 'completed',
          text: 'Delegated A',
          modelLabel: 'openrouter/deepseek-v4.1-flash-1017',
          simulated: false,
          delegation: {
            toolName: 'delegate_python_agent',
            title: 'Task A',
            input: { prompt: 'Run A', attachmentIds: [upA.upload_id] },
          },
        },
      })
      .catch((err: unknown) => err);

    await deleteEnteredPromise;

    // Prove on real PG17 pg_locks that the cleanup TX currently holds `blobLockKey` during delete!
    const identity = await resolveAdvisoryLockIdentity(db.pool, lockKey);
    const locksDuringDelete = await observeAdvisoryLock(db.pool, identity);
    const holder = locksDuringDelete.find((row) => row.granted);
    expect(holder).toBeDefined();

    // Launch concurrent Worker B on separate PG17 connection and verify it queues behind holder.pid!
    const pubBPromise = turnRepo.publishCompletion({
      lease: claimB.lease,
      result: {
        status: 'completed',
        text: 'Delegated B',
        modelLabel: 'openrouter/deepseek-v4.1-flash-1017',
        simulated: false,
        delegation: {
          toolName: 'delegate_python_agent',
          title: 'Task B',
          input: { prompt: 'Run B', attachmentIds: [upB.upload_id] },
        },
      },
    });

    const queued = await waitForAdvisoryLockQueueEntry(db.pool, {
      lockKey,
      blockerPid: holder!.pid,
    });
    expect(queued.blockedBy).toContain(holder!.pid);

    // Let R2 delete finish and commit; Worker B then runs, writes R2 & commits DB!
    releaseDelete();
    const errA = await pubAPromise;
    expect(errA).toBeDefined();
    const pubB = await pubBPromise;
    expect(pubB).toMatchObject({ outcome: 'published' });
    if (pubB.outcome === 'published') {
      expect(pubB.delegatedTaskId).not.toBeNull();
    }
    expect(bucket.objects.has(blobKey)).toBe(true);
  });

  it('enforces lock-held stage/install/discard/sweepOrphans R2 protocol on PG17 under concurrency', async () => {
    const tenant = await createTenantFixture();
    const bucket = new InstrumentedR2Bucket();
    const bytes = new TextEncoder().encode('stage-install-discard-sweep-race-payload');
    const sha256 = sha256Of(bytes);
    const stagedKey = stagingKeyFor(tenant.tenantId, sha256);
    const blobKey = blobKeyFor(tenant.tenantId, sha256);
    const lockKey = blobLockKey(tenant.tenantId, sha256);
    const identity = await resolveAdvisoryLockIdentity(db.pool, lockKey);

    // 1. Verify stage() holds the digest lock while executing R2 put!
    let sawLockGrantedDuringStagePut = false;
    bucket.putHook = async (key) => {
      if (key === stagedKey) {
        const rows = await observeAdvisoryLock(db.pool, identity);
        sawLockGrantedDuringStagePut = rows.some((row) => row.granted);
      }
    };
    const store1 = new PostgresR2BlobStore(db.pool, bucket);
    const staged1 = await store1.stage(tenant.tenantId, bytes, 'text/plain');
    expect(sawLockGrantedDuringStagePut).toBe(true);
    expect(bucket.objects.has(stagedKey)).toBe(true);

    // 2. stage() TX failure cleans up R2 under lock when unreferenced; preserves if concurrently staged.
    bucket.putHook = null;
    const failingStageBytes = new TextEncoder().encode('orphan-stage-only');
    const failingStageKey = stagingKeyFor(tenant.tenantId, sha256Of(failingStageBytes));
    const failingStagePool = createInterceptedPool(db.pool, ({ sql }) => {
      if (sql.includes('INSERT INTO staged_blobs')) {
        throw new Error('simulated staged metadata insert failure');
      }
    });
    const invalidTaskStore = new PostgresR2BlobStore(failingStagePool, bucket);
    await expect(
      invalidTaskStore.stage(tenant.tenantId, failingStageBytes, 'text/plain'),
    ).rejects.toBeDefined();
    expect(bucket.objects.has(failingStageKey)).toBe(false);

    // 3. install() post-commit race: concurrent stage() commits same digest before cleanup locks -> staged R2 kept!
    const racingInstallPool = wrapPoolBeforeNthTransaction(db.pool, 2, async () => {
      await store1.stage(tenant.tenantId, bytes, 'text/plain');
    });
    const racingInstallStore = new PostgresR2BlobStore(racingInstallPool, bucket);
    await racingInstallStore.install(tenant.tenantId, staged1);
    expect(bucket.objects.has(blobKey)).toBe(true);
    expect(bucket.objects.has(stagedKey)).toBe(true);
    await db.pool.query(
      `INSERT INTO blobs (tenant_id, sha256, size, media_type, storage_key)
       VALUES ($1::uuid, $2, $3, 'text/plain', $4)
       ON CONFLICT DO NOTHING`,
      [tenant.tenantId, sha256, bytes.byteLength, blobKey],
    );

    // 4. discard() post-commit race: mark remaining staged row discarded while concurrently re-staging -> kept!
    const staged2Rows = await db.pool.query<{ id: string }>(
      `SELECT id FROM staged_blobs WHERE tenant_id = $1::uuid AND storage_key = $2 AND state = 'pending'`,
      [tenant.tenantId, stagedKey],
    );
    expect(staged2Rows.rows).toHaveLength(1);
    const racingDiscardPool = wrapPoolBeforeNthTransaction(db.pool, 2, async () => {
      await store1.stage(tenant.tenantId, bytes, 'text/plain');
    });
    const racingDiscardStore = new PostgresR2BlobStore(racingDiscardPool, bucket);
    await racingDiscardStore.discard(tenant.tenantId, {
      ...staged1,
      stagedId: staged2Rows.rows[0]!.id,
    });
    expect(bucket.objects.has(stagedKey)).toBe(true);

    // 5. sweepOrphans() race on unreferenced blob: TX deletes bytea_blobs; cleanup TX sees newly committed blobs row -> kept!
    const orphanBytes = new TextEncoder().encode('swept-then-resurrected-blob');
    const orphanSha = sha256Of(orphanBytes);
    const orphanKey = blobKeyFor(tenant.tenantId, orphanSha);
    await bucket.put(orphanKey, orphanBytes);
    await db.pool.query(
      `INSERT INTO bytea_blobs (tenant_id, storage_key, sha256, size, media_type, storage_backend, bytes, created_at)
       VALUES ($1::uuid, $2, $3, $4, 'text/plain', 'r2', NULL, clock_timestamp() - interval '2 hours')`,
      [tenant.tenantId, orphanKey, orphanSha, orphanBytes.byteLength],
    );

    let sawDeleteByteaBlob = false;
    let sawCleanupRaceTriggered = false;
    const racingSweepPool = createInterceptedPool(db.pool, async ({ sql }) => {
      if (sql.includes('DELETE FROM bytea_blobs')) {
        sawDeleteByteaBlob = true;
      } else if (sql === 'BEGIN' && sawDeleteByteaBlob && !sawCleanupRaceTriggered) {
        sawCleanupRaceTriggered = true;
        // Concurrently re-commit the blob before cleanupUnreferencedR2Keys acquires the digest lock!
        await db.pool.query(
          `INSERT INTO bytea_blobs (tenant_id, storage_key, sha256, size, media_type, storage_backend, bytes)
           VALUES ($1::uuid, $2, $3, $4, 'text/plain', 'r2', NULL)
           ON CONFLICT DO NOTHING`,
          [tenant.tenantId, orphanKey, orphanSha, orphanBytes.byteLength],
        );
        await db.pool.query(
          `INSERT INTO blobs (tenant_id, sha256, size, media_type, storage_key)
           VALUES ($1::uuid, $2, $3, 'text/plain', $4)
           ON CONFLICT DO NOTHING`,
          [tenant.tenantId, orphanSha, orphanBytes.byteLength, orphanKey],
        );
      }
    });
    const racingSweepStore = new PostgresR2BlobStore(racingSweepPool, bucket);
    await racingSweepStore.sweepOrphans(new Date(Date.now() + 60 * 60 * 1000), {
      retentionMs: 1_000,
    });
    expect(sawCleanupRaceTriggered).toBe(true);
    expect(bucket.objects.has(orphanKey)).toBe(true);
  });

  it('verifies Migration 0023 constraints, legacy bytea coexistence, and cross-tenant isolation on PG17', async () => {
    const tenantA = await createTenantFixture();
    const tenantB = await createTenantFixture();
    const bucket = new InstrumentedR2Bucket();
    const uploadRepoR2 = new PostgresB3StagedUploadRepository(db.pool, { r2Bucket: bucket });
    const authA = {
      tenantId: tenantA.tenantId,
      principalId: tenantA.principalId,
      policyVersion: 1,
    };
    const authB = {
      tenantId: tenantB.tenantId,
      principalId: tenantB.principalId,
      policyVersion: 1,
    };

    // Blocked dangerous MIME and > 15 MiB rejected cleanly by contracts + DB CHECK constraints.
    await expect(
      uploadRepoR2.stageUpload(authA, {
        filename: 'xss.html',
        mediaType: 'text/html',
        bytes: new TextEncoder().encode('<script>1</script>'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    await expect(
      db.pool.query(
        `INSERT INTO bytea_blobs (tenant_id, storage_key, sha256, size, media_type, storage_backend, bytes)
         VALUES ($1::uuid, $2, $3, 15728641, 'application/pdf', 'r2', NULL)`,
        [tenantA.tenantId, blobKeyFor(tenantA.tenantId, 'a'.repeat(64)), 'a'.repeat(64)],
      ),
    ).rejects.toThrow();

    // Coexistence: legacy 'postgres' bytea artifact + new 'r2' artifact in Tenant A, plus same SHA in Tenant B.
    const sharedBytes = new TextEncoder().encode('%PDF-1.4\nshared-multi-tenant-bytes\n');
    const sharedSha = sha256Of(sharedBytes);
    const legacyPgBytes = new TextEncoder().encode('legacy-pg-bytea-csv,123\n');
    const legacySha = sha256Of(legacyPgBytes);

    const r2Staged = await uploadRepoR2.stageUpload(authA, {
      filename: 'report.pdf',
      mediaType: 'application/pdf',
      bytes: sharedBytes,
    });
    const r2StagedB = await uploadRepoR2.stageUpload(authB, {
      filename: 'tenant-b.pdf',
      mediaType: 'application/pdf',
      bytes: sharedBytes,
    });
    expect(r2Staged.sha256).toBe(sharedSha);
    expect(r2StagedB.sha256).toBe(sharedSha);

    const legacyStoreA = new PostgresByteaBlobStore(db.pool);
    const legacyStaged = await legacyStoreA.stage(tenantA.tenantId, legacyPgBytes, 'text/csv');
    const legacyInstalled = await legacyStoreA.install(tenantA.tenantId, legacyStaged);

    // Seed a python.agent task in Tenant A with both legacy PG bytea input and R2 input, plus run output in Tenant B.
    const taskAId = randomUUID();
    const runAId = randomUUID();
    const legacyArtifactId = randomUUID();
    const r2ArtifactId = randomUUID();
    const r2BlobKeyA = blobKeyFor(tenantA.tenantId, sharedSha);
    await bucket.put(r2BlobKeyA, sharedBytes);

    await db.pool.query(
      `INSERT INTO tasks (id, tenant_id, agent_id, kind, title, input, digest, idempotency_key, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'python.agent', 'Mixed', $4::jsonb, $5, $6, 'queued')`,
      [
        taskAId,
        tenantA.tenantId,
        tenantA.agentId,
        JSON.stringify({
          prompt: 'Inspect both',
          inputArtifactIds: [legacyArtifactId, r2ArtifactId],
        }),
        sha256Of(new TextEncoder().encode(taskAId)),
        `k-${taskAId}`,
      ],
    );
    await db.pool.query(
      `INSERT INTO runs (id, tenant_id, task_id, attempt, lease_epoch, status, worker_id, leased_until)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 1, 'running', 'w-mix', clock_timestamp() + interval '30 seconds')`,
      [runAId, tenantA.tenantId, taskAId],
    );
    await db.pool.query(
      `UPDATE tasks
          SET status = 'running', current_run_id = $3::uuid, lease_epoch = 1
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantA.tenantId, taskAId, runAId],
    );
    await db.pool.query(
      `INSERT INTO bytea_blobs (tenant_id, storage_key, sha256, size, media_type, storage_backend, bytes)
       VALUES ($1::uuid, $2, $3, $4, 'application/pdf', 'r2', NULL)
       ON CONFLICT DO NOTHING`,
      [tenantA.tenantId, r2BlobKeyA, sharedSha, sharedBytes.byteLength],
    );
    await db.pool.query(
      `INSERT INTO blobs (tenant_id, sha256, size, media_type, storage_key)
       VALUES ($1::uuid, $2, $3, 'text/csv', $4), ($1::uuid, $5, $6, 'application/pdf', $7)
       ON CONFLICT DO NOTHING`,
      [
        tenantA.tenantId,
        legacySha,
        legacyPgBytes.byteLength,
        legacyInstalled.storageKey,
        sharedSha,
        sharedBytes.byteLength,
        r2BlobKeyA,
      ],
    );
    await db.pool.query(
      `INSERT INTO artifacts (id, tenant_id, task_id, run_id, created_by, sha256, size, media_type, retention, filename)
       VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, 'user', $4, $5, 'text/csv', 'task', 'legacy.csv'),
              ($6::uuid, $2::uuid, $3::uuid, NULL, 'user', $7, $8, 'application/pdf', 'task', 'report.pdf')`,
      [
        legacyArtifactId,
        tenantA.tenantId,
        taskAId,
        legacySha,
        legacyPgBytes.byteLength,
        r2ArtifactId,
        sharedSha,
        sharedBytes.byteLength,
      ],
    );

    const pythonRepo = new PostgresPythonAgentExecutionRepository(db.pool, { r2Bucket: bucket });
    const loaded = await pythonRepo.loadAgentContext({
      tenantId: tenantA.tenantId,
      taskId: taskAId,
      runId: runAId,
      attempt: 1,
      leaseEpoch: 1,
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(loaded.kind).toBe('ready');
    if (loaded.kind === 'ready') {
      expect(loaded.context.inputFiles.map((f) => f.filename)).toEqual([
        'legacy.csv',
        'report.pdf',
      ]);
      expect(loaded.context.inputFiles[0]!.bytes).toEqual(legacyPgBytes);
      expect(loaded.context.inputFiles[1]!.bytes).toEqual(sharedBytes);
    }

    // Cross-tenant isolation: Tenant B cannot download Tenant A's artifact and Tenant B's R2 delete leaves Tenant A untouched.
    await expect(uploadRepoR2.getTaskArtifactDownload(authB, r2ArtifactId)).resolves.toBeNull();
    const r2KeyB = blobKeyFor(tenantB.tenantId, sharedSha);
    await bucket.put(r2KeyB, sharedBytes);
    const storeB = new PostgresR2BlobStore(db.pool, bucket);
    await storeB.cleanupR2Keys([r2KeyB]);
    expect(bucket.objects.has(r2KeyB)).toBe(false);
    expect(bucket.objects.has(r2BlobKeyA)).toBe(true);
    expect((await uploadRepoR2.getTaskArtifactDownload(authA, r2ArtifactId))?.bytes).toEqual(
      sharedBytes,
    );
  });

  it('enforces P1-2 aggregate 32 MiB budget in PG17 loadAgentContext and preserves single-file 15 MiB support', async () => {
    const tenant = await createTenantFixture();
    const bucket = new InstrumentedR2Bucket();
    const pythonRepo = new PostgresPythonAgentExecutionRepository(db.pool, { r2Bucket: bucket });
    const leaseQueue = new PostgresLeaseQueue(db.pool, { clock: systemClock });

    // 1. Two 15 MiB inputs (30 MiB <= 32 MiB) succeed cleanly.
    const fifteenMiB = PYTHON_AGENT_LIMITS.maxFileBytes;
    const buf15A = new Uint8Array(fifteenMiB);
    buf15A.fill(0x41);
    const buf15B = new Uint8Array(fifteenMiB);
    buf15B.fill(0x42);
    const sha15A = sha256Of(buf15A);
    const sha15B = sha256Of(buf15B);
    const key15A = blobKeyFor(tenant.tenantId, sha15A);
    const key15B = blobKeyFor(tenant.tenantId, sha15B);
    await bucket.put(key15A, buf15A);
    await bucket.put(key15B, buf15B);

    const taskOkId = randomUUID();
    const runOkId = randomUUID();
    const artOkA = randomUUID();
    const artOkB = randomUUID();
    await db.pool.query(
      `INSERT INTO tasks (id, tenant_id, agent_id, kind, title, input, digest, idempotency_key, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'python.agent', 'Two 15 MiB', $4::jsonb, $5, $6, 'queued')`,
      [
        taskOkId,
        tenant.tenantId,
        tenant.agentId,
        JSON.stringify({ prompt: 'Run 30 MiB', inputArtifactIds: [artOkA, artOkB] }),
        sha256Of(new TextEncoder().encode(taskOkId)),
        `ok-${taskOkId}`,
      ],
    );
    await db.pool.query(
      `INSERT INTO runs (id, tenant_id, task_id, attempt, lease_epoch, status, worker_id, leased_until)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 1, 'running', 'w-30m', clock_timestamp() + interval '30 seconds')`,
      [runOkId, tenant.tenantId, taskOkId],
    );
    await db.pool.query(
      `UPDATE tasks
          SET status = 'running', current_run_id = $3::uuid, lease_epoch = 1
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenant.tenantId, taskOkId, runOkId],
    );
    await db.pool.query(
      `INSERT INTO bytea_blobs (tenant_id, storage_key, sha256, size, media_type, storage_backend, bytes)
       VALUES ($1::uuid, $2, $3, $4, 'application/octet-stream', 'r2', NULL),
              ($1::uuid, $5, $6, $4, 'application/octet-stream', 'r2', NULL)`,
      [tenant.tenantId, key15A, sha15A, fifteenMiB, key15B, sha15B],
    );
    await db.pool.query(
      `INSERT INTO blobs (tenant_id, sha256, size, media_type, storage_key)
       VALUES ($1::uuid, $2, $4, 'application/octet-stream', $3),
              ($1::uuid, $5, $4, 'application/octet-stream', $6)`,
      [tenant.tenantId, sha15A, key15A, fifteenMiB, sha15B, key15B],
    );
    await db.pool.query(
      `INSERT INTO artifacts (id, tenant_id, task_id, run_id, created_by, sha256, size, media_type, retention, filename)
       VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, 'user', $4, $5, 'application/octet-stream', 'task', 'a.bin'),
              ($6::uuid, $2::uuid, $3::uuid, NULL, 'user', $7, $5, 'application/octet-stream', 'task', 'b.bin')`,
      [artOkA, tenant.tenantId, taskOkId, sha15A, fifteenMiB, artOkB, sha15B],
    );

    const okLoaded = await pythonRepo.loadAgentContext({
      tenantId: tenant.tenantId,
      taskId: taskOkId,
      runId: runOkId,
      attempt: 1,
      leaseEpoch: 1,
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(okLoaded.kind).toBe('ready');
    if (okLoaded.kind === 'ready') {
      expect(okLoaded.context.inputFiles).toHaveLength(2);
      expect(okLoaded.context.inputFiles[0]!.bytes.byteLength).toBe(fifteenMiB);
      expect(okLoaded.context.inputFiles[1]!.bytes.byteLength).toBe(fifteenMiB);
    }

    // 2. Two 12 MiB inputs + one 10 MiB checkpointed staged output (34 MiB > 32 MiB):
    //    loadAgentContext returns file_budget_exceeded with ZERO bucket.get() reads, and
    //    executePythonAgentRun fails terminal cleanly without OOM or retry crash-loop.
    const twelveMiB = 12 * 1024 * 1024;
    const tenMiB = 10 * 1024 * 1024;
    const buf12 = new Uint8Array(twelveMiB);
    buf12.fill(0x43);
    const buf10 = new Uint8Array(tenMiB);
    buf10.fill(0x44);
    const sha12 = sha256Of(buf12);
    const sha10 = sha256Of(buf10);
    const key12 = blobKeyFor(tenant.tenantId, sha12);
    const stagedKey10 = stagingKeyFor(tenant.tenantId, sha10);
    await bucket.put(key12, buf12);
    await bucket.put(stagedKey10, buf10);

    const taskOverId = randomUUID();
    const runOverId = randomUUID();
    const artOver1 = randomUUID();
    const artOver2 = randomUUID();
    const stagedId10 = randomUUID();
    await db.pool.query(
      `INSERT INTO tasks (id, tenant_id, agent_id, kind, title, input, digest, idempotency_key, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'python.agent', '34 MiB Over Budget', $4::jsonb, $5, $6, 'queued')`,
      [
        taskOverId,
        tenant.tenantId,
        tenant.agentId,
        JSON.stringify({ prompt: 'Recover 34 MiB', inputArtifactIds: [artOver1, artOver2] }),
        sha256Of(new TextEncoder().encode(taskOverId)),
        `over-${taskOverId}`,
      ],
    );
    await db.pool.query(
      `INSERT INTO task_events (id, tenant_id, task_id, sequence, phase, payload, trace_id, occurred_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'accepted', '{"taskKind":"python.agent","policyVersion":1,"replayed":false}'::jsonb, $4::uuid, clock_timestamp())`,
      [randomUUID(), tenant.tenantId, taskOverId, randomUUID()],
    );
    await db.pool.query(
      `INSERT INTO runs (id, tenant_id, task_id, attempt, lease_epoch, status, worker_id, leased_until, started_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 1, 'running', 'w-over', clock_timestamp() + interval '30 seconds', clock_timestamp())`,
      [runOverId, tenant.tenantId, taskOverId],
    );
    await db.pool.query(
      `UPDATE tasks
          SET status = 'running',
              current_run_id = $3::uuid,
              attempt_count = 1,
              lease_epoch = 1,
              lease_expires_at = clock_timestamp() + interval '30 seconds'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenant.tenantId, taskOverId, runOverId],
    );
    await db.pool.query(
      `INSERT INTO bytea_blobs (tenant_id, storage_key, sha256, size, media_type, storage_backend, bytes)
       VALUES ($1::uuid, $2, $3, $4, 'application/octet-stream', 'r2', NULL)
       ON CONFLICT DO NOTHING`,
      [tenant.tenantId, key12, sha12, twelveMiB],
    );
    await db.pool.query(
      `INSERT INTO blobs (tenant_id, sha256, size, media_type, storage_key)
       VALUES ($1::uuid, $2, $3, 'application/octet-stream', $4)
       ON CONFLICT DO NOTHING`,
      [tenant.tenantId, sha12, twelveMiB, key12],
    );
    await db.pool.query(
      `INSERT INTO artifacts (id, tenant_id, task_id, run_id, created_by, sha256, size, media_type, retention, filename)
       VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, 'user', $4, $5, 'application/octet-stream', 'task', 'in1.bin'),
              ($6::uuid, $2::uuid, $3::uuid, NULL, 'user', $4, $5, 'application/octet-stream', 'task', 'in2.bin')`,
      [artOver1, tenant.tenantId, taskOverId, sha12, twelveMiB, artOver2],
    );
    await db.pool.query(
      `INSERT INTO bytea_staged_blobs (tenant_id, storage_key, sha256, size, media_type, storage_backend, bytes)
       VALUES ($1::uuid, $2, $3, $4, 'application/octet-stream', 'r2', NULL)
       ON CONFLICT DO NOTHING`,
      [tenant.tenantId, stagedKey10, sha10, tenMiB],
    );
    await db.pool.query(
      `INSERT INTO staged_blobs (id, tenant_id, task_id, run_id, lease_epoch, sha256, size, media_type, storage_key, state)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, $6, 'application/octet-stream', $7, 'pending')`,
      [stagedId10, tenant.tenantId, taskOverId, runOverId, sha10, tenMiB, stagedKey10],
    );
    await db.pool.query(
      `INSERT INTO step_checkpoints (
         id, tenant_id, task_id, run_id, attempt, lease_epoch, schema_version,
         step_id, step_sequence, input_digest, executor_version, cursor, artifacts, external_effects
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, 1, 'step-1', 1, $5, 'python-agent.v1', $6::jsonb, '[]'::jsonb, '[]'::jsonb)`,
      [
        randomUUID(),
        tenant.tenantId,
        taskOverId,
        runOverId,
        sha256Of(new TextEncoder().encode('step-1')),
        JSON.stringify({
          stepSequence: 1,
          runId: runOverId,
          attempt: 1,
          toolCallId: 'step_1',
          code: 'pass',
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          stdoutPreview: '',
          stderrPreview: '',
          toolResultJson: '{}',
          stagedOutputs: [
            {
              stagedId: stagedId10,
              storageKey: stagedKey10,
              sha256: sha10,
              size: tenMiB,
              mediaType: 'application/octet-stream',
              filename: 'ckpt.bin',
            },
          ],
        }),
      ],
    );

    bucket.getCount = 0;
    let sandboxLaunched = false;
    const outcome = await executePythonAgentRun(
      {
        tenantId: tenant.tenantId,
        taskId: taskOverId,
        runId: runOverId,
        attempt: 1,
        leaseEpoch: 1,
        leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
      {
        mode: 'real',
        leaseQueue,
        repository: pythonRepo,
        blobStore: new PostgresR2BlobStore(db.pool, bucket),
        gateway: {
          providerId: 'openrouter',
          modelLabel: 'nvidia/nemotron-3.5-lightning',
          simulated: false,
          operations: ['conversation.turn', 'task.notes_action_items', 'task.python_agent'],
          generateConversationTurn: () => Promise.reject(new Error('unused')),
          extractNotesActionItems: () => Promise.reject(new Error('unused')),
          stepPythonAgent: () => Promise.reject(new Error('unused')),
        },
        createSandbox: () => {
          sandboxLaunched = true;
          throw new Error('must not create sandbox');
        },
        sandboxOwner: 'b3-over-budget',
        policy: resolveLeaseQueueConfig(),
        ceilings: {
          perAttemptMicroUsd: 5_000,
          principalDailyMicroUsd: 250_000,
          tenantDailyMicroUsd: 1_000_000,
          globalDailyMicroUsd: 5_000_000,
        },
        rate: {
          providerId: 'openrouter',
          modelId: 'nvidia/nemotron-3.5-lightning',
          inputMicroUsdPerMillion: 60_000,
          outputMicroUsdPerMillion: 160_000,
          rateVersion: 'test-rate',
          provenance: 'official_price_verified',
          source: 'test',
          reasoningEffort: 'none',
          promptCacheMode: 'explicit',
        },
        leaseDurationMs: 30_000,
        attemptTimeoutMs: 5_000,
        logger: SILENT_LOGGER,
      },
    );

    expect(outcome).toEqual({
      outcome: 'failed_terminal',
      reason: 'task_file_budget_exceeded',
    });
    expect(bucket.getCount).toBe(0);
    expect(sandboxLaunched).toBe(false);
    const taskRow = await db.pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenant.tenantId, taskOverId],
    );
    expect(taskRow.rows[0]?.status).toBe('failed');
  });
});
