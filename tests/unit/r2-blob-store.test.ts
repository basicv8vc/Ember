import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PostgresB3StagedUploadRepository,
  PostgresModelTurnExecutionRepository,
  PostgresR2BlobStore,
  UPLOAD_KEY_PATTERN,
  blobKeyFor,
  uploadKeyFor,
  type R2BucketPort,
  type R2ObjectBodyPort,
  type R2PutOptionsPort,
} from '@ember/postgres';

type PoolArg = ConstructorParameters<typeof PostgresR2BlobStore>[0];

class MemoryR2Bucket implements R2BucketPort {
  readonly putKeys: string[] = [];
  readonly objects = new Map<
    string,
    {
      readonly body: Uint8Array;
      readonly options: R2PutOptionsPort | undefined;
    }
  >();

  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: R2PutOptionsPort,
  ): Promise<unknown> {
    this.putKeys.push(key);
    const view =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, {
      body: new Uint8Array(view),
      options,
    });
    return Promise.resolve({ key, size: view.byteLength });
  }

  get(key: string): Promise<R2ObjectBodyPort | null> {
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

  delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      this.objects.delete(key);
    }
    return Promise.resolve();
  }
}

describe('R2 blob storage keys and stageUpload lifecycle', () => {
  it('generates canonical tenant-scoped upload keys', () => {
    const tenantId = randomUUID();
    const uploadId = randomUUID();
    const key = uploadKeyFor(tenantId, uploadId);
    expect(key).toBe(`uploads/${tenantId.toLowerCase()}/${uploadId.toLowerCase()}`);
    expect(UPLOAD_KEY_PATTERN.test(key)).toBe(true);
  });

  it('writes uploaded bytes to R2, stores metadata in Postgres with NULL bytea, and cleans up R2 if TX fails', async () => {
    const bucket = new MemoryR2Bucket();
    const queries: Array<{ text: string; params: readonly unknown[] | undefined }> = [];
    const tenantId = randomUUID();
    const principalId = randomUUID();
    const bytes = new TextEncoder().encode('%PDF-1.4\nhello world\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const runQuery = (text: string, params?: readonly unknown[]) => {
      queries.push({ text, params });
      if (text.includes('clock_timestamp()')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ now: '2026-11-17T00:00:00.000Z' }],
        });
      }
      if (text.includes('COUNT(*)')) {
        return Promise.resolve({ rowCount: 1, rows: [{ active_count: 0 }] });
      }
      if (text.includes('INSERT INTO user_staged_uploads')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              id: params?.[0],
              filename: 'sample.pdf',
              media_type: 'application/pdf',
              size: bytes.byteLength,
              sha256,
              expires_at: '2026-11-18T00:00:00.000Z',
              created_at: '2026-11-17T00:00:00.000Z',
            },
          ],
        });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    };

    const fakePool = {
      query: runQuery,
      connect() {
        return Promise.resolve({
          query: runQuery,
          release() {},
        });
      },
    } as unknown as PoolArg;

    const repo = new PostgresB3StagedUploadRepository(fakePool, { r2Bucket: bucket });
    const receipt = await repo.stageUpload(
      { tenantId, principalId, policyVersion: 1 },
      { filename: 'sample.pdf', mediaType: 'application/pdf', bytes },
    );

    expect(receipt.filename).toBe('sample.pdf');
    expect(receipt.media_type).toBe('application/pdf');
    expect(bucket.objects.size).toBe(1);
    const storedKey = uploadKeyFor(tenantId, receipt.upload_id);
    expect(bucket.objects.get(storedKey)?.body).toEqual(bytes);

    const insertParams = queries.find((q) =>
      q.text.includes('INSERT INTO user_staged_uploads'),
    )?.params;
    expect(insertParams?.[7]).toBe('r2');
    expect(insertParams?.[8]).toBe(storedKey);
    expect(insertParams?.[9]).toBeNull();

    // If Postgres fails after R2 upload, the staged R2 object must be deleted.
    const failingPool = {
      query(text: string) {
        if (text === 'BEGIN' || text === 'ROLLBACK') {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        return Promise.reject(new Error('db write failed'));
      },
      connect() {
        return Promise.resolve({
          query(text: string) {
            if (text === 'BEGIN' || text === 'ROLLBACK') {
              return Promise.resolve({ rowCount: 0, rows: [] });
            }
            return Promise.reject(new Error('db write failed'));
          },
          release() {},
        });
      },
    } as unknown as PoolArg;
    const failingRepo = new PostgresB3StagedUploadRepository(failingPool, { r2Bucket: bucket });
    await expect(
      failingRepo.stageUpload(
        { tenantId, principalId, policyVersion: 1 },
        { filename: 'fail.pdf', mediaType: 'application/pdf', bytes },
      ),
    ).rejects.toBeDefined();
    expect(bucket.objects.size).toBe(1);
  });

  it('constructs PostgresR2BlobStore with 15 MiB default limit and sweeps expired R2 uploads', async () => {
    const bucket = new MemoryR2Bucket();
    const expiredKey = uploadKeyFor(randomUUID(), randomUUID());
    await bucket.put(expiredKey, new Uint8Array([1, 2, 3]));

    const pool = {
      query(text: string) {
        if (text.includes('DELETE FROM user_staged_uploads')) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ storage_backend: 'r2', storage_key: expiredKey }],
          });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
    } as unknown as PoolArg;

    const blobStore = new PostgresR2BlobStore(pool, bucket);
    expect(blobStore.limitBytes).toBe(15_728_640);
    expect(blobStore.r2Bucket).toBe(bucket);

    const repo = new PostgresB3StagedUploadRepository(pool, { r2Bucket: bucket });
    const swept = await repo.sweepExpiredUnboundUploads();
    expect(swept.removed).toBe(1);
    expect(bucket.objects.size).toBe(0);
  });

  it('cleans up newly written task R2 blobs on savepoint or transaction rollback without deleting pre-existing blobs', async () => {
    const bucket = new MemoryR2Bucket();
    const tenantId = randomUUID();
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const sourceMessageId = randomUUID();
    const agentId = randomUUID();
    const existingUploadId = randomUUID();
    const newUploadId = randomUUID();

    const existingBytes = new TextEncoder().encode('existing-shared-blob');
    const existingSha = createHash('sha256').update(existingBytes).digest('hex');
    const existingBlobKey = blobKeyFor(tenantId, existingSha);
    const existingSentinel = new TextEncoder().encode('existing-shared-blob');
    await bucket.put(existingBlobKey, existingSentinel);

    const newBytes = new TextEncoder().encode('new-delegation-blob');
    const newSha = createHash('sha256').update(newBytes).digest('hex');
    const newBlobKey = blobKeyFor(tenantId, newSha);
    const stagedUploadKey = uploadKeyFor(tenantId, newUploadId);
    await bucket.put(stagedUploadKey, newBytes);

    const makePool = (mode: 'savepoint_timeout' | 'outer_throw') => {
      const runQuery = (text: string, params?: readonly unknown[]) => {
        if (
          text === 'BEGIN' ||
          text === 'COMMIT' ||
          text === 'ROLLBACK' ||
          text.startsWith('SAVEPOINT') ||
          text.startsWith('ROLLBACK TO SAVEPOINT') ||
          text.startsWith('RELEASE SAVEPOINT') ||
          text.includes('pg_advisory_xact_lock')
        ) {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (text.includes('FROM conversations') && text.includes('FOR UPDATE')) {
          return Promise.resolve({ rowCount: 1, rows: [{ id: conversationId }] });
        }
        if (text.includes('FROM assistant_turns t') && text.includes('FOR UPDATE')) {
          return Promise.resolve({
            rowCount: 1,
            rows: [
              {
                id: turnId,
                conversation_id: conversationId,
                source_message_id: sourceMessageId,
                status: 'running',
                created_at: '2026-11-18T00:00:00.000Z',
                updated_at: '2026-11-18T00:00:00.000Z',
                response_message_id: null,
                failure_reason: null,
                deadline_at: '2026-11-18T00:05:00.000Z',
              },
            ],
          });
        }
        if (text.includes('AS within_deadline')) {
          return Promise.resolve({
            rowCount: 1,
            rows: [
              {
                status: 'running',
                lease_epoch: 1,
                lease_owner: 'worker-1',
                within_deadline: true,
                lease_live: true,
              },
            ],
          });
        }
        if (text.includes('AS expired')) {
          return Promise.resolve({ rowCount: 1, rows: [{ expired: false }] });
        }
        if (text.includes('FROM conversations c') && text.includes('JOIN agents a')) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ agent_id: agentId, policy_version: 1 }],
          });
        }
        if (text.includes('JOIN conversation_message_attachments cma')) {
          return Promise.resolve({
            rowCount: 2,
            rows: [{ upload_id: existingUploadId }, { upload_id: newUploadId }],
          });
        }
        if (text.includes('FROM tasks') && text.includes('idempotency_key')) {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (text.includes('FROM user_staged_uploads') && text.includes('FOR UPDATE')) {
          return Promise.resolve({
            rowCount: 2,
            rows: [
              {
                id: existingUploadId,
                filename: 'existing.txt',
                media_type: 'text/plain',
                sha256: existingSha,
                size: existingBytes.byteLength,
                storage_backend: 'postgres',
                storage_key: null,
                bytes: Buffer.from(existingBytes),
                status: 'unbound',
                not_expired: true,
              },
              {
                id: newUploadId,
                filename: 'new.txt',
                media_type: 'text/plain',
                sha256: newSha,
                size: newBytes.byteLength,
                storage_backend: 'r2',
                storage_key: stagedUploadKey,
                bytes: null,
                status: 'unbound',
                not_expired: true,
              },
            ],
          });
        }
        if (text.includes('INSERT INTO tasks')) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ id: params?.[0], accepted_at: '2026-11-18T00:00:01.000Z' }],
          });
        }
        if (
          text.includes('FROM bytea_blobs') &&
          text.includes('WHERE tenant_id = $1 AND storage_key = $2')
        ) {
          const requestedKey = params?.[1];
          return requestedKey === existingBlobKey
            ? Promise.resolve({ rowCount: 1, rows: [{ exists: 1 }] })
            : Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (text.includes('UPDATE conversations') && text.includes('RETURNING last_sequence')) {
          return Promise.resolve({ rowCount: 1, rows: [{ last_sequence: 2 }] });
        }
        if (text.includes('WITH decision AS') && text.includes('UPDATE assistant_turns t')) {
          if (mode === 'outer_throw') {
            return Promise.reject(new Error('db failed before commit'));
          }
          const isTimeoutFallback = text.includes("SET status = 'failed'");
          return Promise.resolve({
            rowCount: 1,
            rows: [
              {
                id: turnId,
                conversation_id: conversationId,
                source_message_id: sourceMessageId,
                status: 'failed',
                created_at: '2026-11-18T00:00:00.000Z',
                updated_at: '2026-11-18T00:05:00.000Z',
                response_message_id: params?.[isTimeoutFallback ? 4 : 3],
                failure_reason: 'timeout',
                deadline_at: '2026-11-18T00:05:00.000Z',
              },
            ],
          });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      };

      return {
        query: runQuery,
        connect() {
          return Promise.resolve({
            query: runQuery,
            release() {},
          });
        },
      } as unknown as PoolArg;
    };

    const command = {
      lease: {
        tenantId,
        conversationId,
        turnId,
        leaseEpoch: 1,
        leaseOwner: 'worker-1',
        deadlineAt: '2026-11-18T00:05:00.000Z',
        leaseExpiresAt: '2026-11-18T00:01:00.000Z',
      },
      result: {
        status: 'completed' as const,
        text: 'Running analysis',
        modelLabel: 'openrouter/deepseek-v4.1-flash-1017',
        simulated: false,
        delegation: {
          toolName: 'delegate_python_agent' as const,
          title: 'Analyze attachments',
          input: { prompt: 'Inspect files' },
        },
      },
    };

    const savepointRepo = new PostgresModelTurnExecutionRepository(makePool('savepoint_timeout'), {
      r2Bucket: bucket,
    });
    bucket.putKeys.length = 0;
    const savepointOutcome = await savepointRepo.publishCompletion(command);
    expect(savepointOutcome).toMatchObject({
      outcome: 'published',
      delegatedTaskId: null,
    });
    expect(bucket.putKeys).toEqual([newBlobKey]);
    expect(bucket.objects.has(newBlobKey)).toBe(false);
    expect(bucket.objects.has(existingBlobKey)).toBe(true);
    expect(bucket.objects.has(stagedUploadKey)).toBe(true);

    const throwRepo = new PostgresModelTurnExecutionRepository(makePool('outer_throw'), {
      r2Bucket: bucket,
    });
    bucket.putKeys.length = 0;
    await expect(throwRepo.publishCompletion(command)).rejects.toBeDefined();
    expect(bucket.putKeys).toEqual([newBlobKey]);
    expect(bucket.objects.has(newBlobKey)).toBe(false);
    expect(bucket.objects.has(existingBlobKey)).toBe(true);
    expect(bucket.objects.has(stagedUploadKey)).toBe(true);
  });

  it('acquires digest lock in stage() before R2 write and preserves R2 on rollback if another TX holds a DB reference', async () => {
    const bucket = new MemoryR2Bucket();
    const tenantId = randomUUID();
    const payload = new TextEncoder().encode('concurrent-stage-and-rollback-payload');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const stagedKey = `staging/${tenantId}/${sha256}`;
    const blobKey = blobKeyFor(tenantId, sha256);

    const events: string[] = [];
    const loggedQueries: string[] = [];
    let stagedMetadataFail = true;
    const stagePool = {
      connect() {
        return Promise.resolve({
          query(text: string) {
            loggedQueries.push(text);
            if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
              events.push(text);
              return Promise.resolve({ rowCount: 0, rows: [] });
            }
            if (text.includes('pg_advisory_xact_lock')) {
              events.push('LOCK');
              return Promise.resolve({ rowCount: 0, rows: [] });
            }
            if (text.includes('INSERT INTO staged_blobs') && stagedMetadataFail) {
              return Promise.reject(new Error('staged metadata failed'));
            }
            return Promise.resolve({ rowCount: 0, rows: [] });
          },
          release() {},
        });
      },
    } as unknown as PoolArg;

    const trackedBucket: R2BucketPort = {
      put(key, value, options) {
        events.push(`PUT:${key}`);
        return bucket.put(key, value as ArrayBuffer | ArrayBufferView, options);
      },
      get: (key) => bucket.get(key),
      delete(keys) {
        events.push(`DELETE:${Array.isArray(keys) ? keys.join(',') : keys}`);
        return bucket.delete(keys);
      },
    };

    const blobStore = new PostgresR2BlobStore(stagePool, trackedBucket);
    await expect(blobStore.stage(tenantId, payload, 'text/plain')).rejects.toBeDefined();

    // First TX acquired LOCK before PUT; rollback TX acquired LOCK before DELETE.
    expect(events).toEqual([
      'BEGIN',
      'LOCK',
      `PUT:${stagedKey}`,
      'ROLLBACK',
      'BEGIN',
      'LOCK',
      `DELETE:${stagedKey}`,
      'COMMIT',
    ]);
    expect(bucket.objects.has(stagedKey)).toBe(false);

    // Concurrent commit race: rollback happened, another worker committed a DB reference before cleanup locked.
    events.length = 0;
    stagedMetadataFail = false;
    await bucket.put(blobKey, payload);
    const racePool = {
      connect() {
        return Promise.resolve({
          query(text: string) {
            if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
              events.push(text);
              return Promise.resolve({ rowCount: 0, rows: [] });
            }
            if (text.includes('pg_advisory_xact_lock')) {
              events.push('LOCK');
              return Promise.resolve({ rowCount: 0, rows: [] });
            }
            if (text.includes('FROM blobs WHERE tenant_id = $1 AND sha256 = $2')) {
              return Promise.resolve({ rowCount: 1, rows: [{ '?column?': 1 }] });
            }
            return Promise.resolve({ rowCount: 0, rows: [] });
          },
          release() {},
        });
      },
    } as unknown as PoolArg;

    const { cleanupUnreferencedR2Keys } = await import('@ember/postgres');
    await cleanupUnreferencedR2Keys(racePool, trackedBucket, [blobKey]);
    expect(bucket.objects.has(blobKey)).toBe(true);
    expect(events).toEqual(['BEGIN', 'LOCK', 'COMMIT']);
    expect(loggedQueries.length).toBeGreaterThan(0);
  });

  it('retains R2 upload object when COMMIT succeeds on server but client loses the ACK, and cleans up only on confirmed absence or normal rollback', async () => {
    const tenantId = randomUUID();
    const principalId = randomUUID();
    const payload = new TextEncoder().encode('%PDF-1.4\nambiguous-commit\n');
    const sha256 = createHash('sha256').update(payload).digest('hex');

    const runScenario = async (
      mode: 'lost_ack_committed' | 'commit_failed_absent' | 'confirm_failed',
    ) => {
      const bucket = new MemoryR2Bucket();
      const events: string[] = [];
      let txCount = 0;
      let committedUploadId: string | null = null;
      const deletedKeys: string[] = [];

      const trackedBucket: R2BucketPort = {
        put: (key, value, options) =>
          bucket.put(key, value as ArrayBuffer | ArrayBufferView, options),
        get: (key) => bucket.get(key),
        delete(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          deletedKeys.push(...list);
          return bucket.delete(keys);
        },
      };

      const pool = {
        connect() {
          txCount += 1;
          const currentTx = txCount;
          if (currentTx === 2 && mode === 'confirm_failed') {
            return Promise.reject(new Error('confirm connection unavailable'));
          }
          return Promise.resolve({
            query(text: string, params?: readonly unknown[]) {
              if (text === 'BEGIN') {
                events.push(`TX${currentTx}:BEGIN`);
                return Promise.resolve({ rowCount: 0, rows: [] });
              }
              if (text === 'ROLLBACK') {
                events.push(`TX${currentTx}:ROLLBACK`);
                return Promise.resolve({ rowCount: 0, rows: [] });
              }
              if (text.includes('pg_advisory_xact_lock')) {
                events.push(`TX${currentTx}:LOCK:${String(params?.[0])}`);
                return Promise.resolve({ rowCount: 0, rows: [] });
              }
              if (text.includes('clock_timestamp()')) {
                return Promise.resolve({
                  rowCount: 1,
                  rows: [{ now: '2026-11-18T00:00:00.000Z' }],
                });
              }
              if (text.includes('FROM user_staged_uploads') && text.includes('count(*)')) {
                return Promise.resolve({ rowCount: 1, rows: [{ active_count: 0 }] });
              }
              if (text.includes('INSERT INTO user_staged_uploads')) {
                committedUploadId = String(params?.[0]);
                return Promise.resolve({
                  rowCount: 1,
                  rows: [
                    {
                      id: committedUploadId,
                      filename: 'doc.pdf',
                      media_type: 'application/pdf',
                      size: payload.byteLength,
                      sha256,
                      expires_at: '2026-11-19T00:00:00.000Z',
                      created_at: '2026-11-18T00:00:00.000Z',
                    },
                  ],
                });
              }
              if (text === 'COMMIT') {
                events.push(`TX${currentTx}:COMMIT`);
                if (currentTx === 1) {
                  if (mode === 'commit_failed_absent') {
                    committedUploadId = null;
                  }
                  return Promise.reject(new Error('socket reset after commit'));
                }
                return Promise.resolve({ rowCount: 0, rows: [] });
              }
              if (text.includes('FROM user_staged_uploads') && text.includes('LIMIT 1')) {
                events.push(`TX${currentTx}:CHECK_EXISTS`);
                const exists = committedUploadId !== null && params?.[1] === committedUploadId;
                return Promise.resolve({
                  rowCount: exists ? 1 : 0,
                  rows: exists ? [{ '?column?': 1 }] : [],
                });
              }
              return Promise.resolve({ rowCount: 0, rows: [] });
            },
            release() {},
          });
        },
      } as unknown as PoolArg;

      const repo = new PostgresB3StagedUploadRepository(pool, { r2Bucket: trackedBucket });
      await expect(
        repo.stageUpload(
          { tenantId, principalId, policyVersion: 1 },
          { filename: 'doc.pdf', mediaType: 'application/pdf', bytes: payload },
        ),
      ).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });

      return { bucket, events, deletedKeys };
    };

    const lostAck = await runScenario('lost_ack_committed');
    expect(lostAck.bucket.objects.size).toBe(1);
    expect(lostAck.deletedKeys).toEqual([]);
    expect(lostAck.events).toEqual([
      'TX1:BEGIN',
      `TX1:LOCK:ember.upload:${tenantId}:${principalId}`,
      'TX1:COMMIT',
      'TX2:BEGIN',
      `TX2:LOCK:ember.upload:${tenantId}:${principalId}`,
      'TX2:CHECK_EXISTS',
      'TX2:COMMIT',
    ]);

    const confirmedAbsent = await runScenario('commit_failed_absent');
    expect(confirmedAbsent.bucket.objects.size).toBe(0);
    expect(confirmedAbsent.deletedKeys).toHaveLength(1);
    expect(confirmedAbsent.events).toEqual([
      'TX1:BEGIN',
      `TX1:LOCK:ember.upload:${tenantId}:${principalId}`,
      'TX1:COMMIT',
      'TX2:BEGIN',
      `TX2:LOCK:ember.upload:${tenantId}:${principalId}`,
      'TX2:CHECK_EXISTS',
      'TX2:COMMIT',
    ]);

    const confirmFailed = await runScenario('confirm_failed');
    expect(confirmFailed.bucket.objects.size).toBe(1);
    expect(confirmFailed.deletedKeys).toEqual([]);
    expect(confirmFailed.events).toEqual([
      'TX1:BEGIN',
      `TX1:LOCK:ember.upload:${tenantId}:${principalId}`,
      'TX1:COMMIT',
    ]);
  });
});
