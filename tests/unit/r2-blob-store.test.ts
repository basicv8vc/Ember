import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PostgresB3StagedUploadRepository,
  PostgresR2BlobStore,
  UPLOAD_KEY_PATTERN,
  uploadKeyFor,
  type R2BucketPort,
  type R2ObjectBodyPort,
  type R2PutOptionsPort,
} from '@ember/postgres';

type PoolArg = ConstructorParameters<typeof PostgresR2BlobStore>[0];

class MemoryR2Bucket implements R2BucketPort {
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
});
