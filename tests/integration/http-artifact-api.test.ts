import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import {
  PostgresAgentRepository,
  PostgresTaskRepository,
} from '../../packages/postgres/src/index.js';
import { createP06Infra, type P06Infra } from './support/p0b06.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { chatCommand, createTenantFixture, type TenantFixture } from './support/fixtures.js';

let db: TestDatabase;
let infra: P06Infra;
let tasks: PostgresTaskRepository;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let taskA: string;
let taskB: string;
let tokenA: string;
let tokenB: string;
let app: ReturnType<typeof createApp>;

async function createTask(tenant: TenantFixture, agentId: string): Promise<string> {
  const created = await tasks.create(
    { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 },
    chatCommand(agentId, `artifact-${randomUUID()}`),
  );
  return created.taskId;
}

interface PublishedArtifact {
  readonly artifactId: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly mediaType: string;
  readonly storageKey: string;
}

async function installBytes(
  tenant: TenantFixture,
  content: string,
  mediaType = 'application/octet-stream',
): Promise<PublishedArtifact> {
  const bytes = Buffer.from(content, 'utf8');
  const staged = await infra.blobs.stage(tenant.tenantId, bytes, mediaType);
  const installed = await infra.blobs.install(tenant.tenantId, staged);

  return {
    artifactId: randomUUID(),
    bytes,
    sha256: installed.sha256,
    mediaType,
    storageKey: installed.storageKey,
  };
}

/** Publish blob and artifact metadata in one PostgreSQL transaction for HTTP read tests. */
async function commitArtifact(
  tenant: TenantFixture,
  taskId: string,
  artifact: PublishedArtifact,
): Promise<void> {
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO blobs (tenant_id, sha256, size, media_type, storage_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenant.tenantId,
        artifact.sha256,
        artifact.bytes.byteLength,
        artifact.mediaType,
        artifact.storageKey,
      ],
    );
    await client.query(
      `INSERT INTO artifacts
         (id, tenant_id, task_id, run_id, created_by, sha256, size, media_type, retention)
       VALUES ($1, $2, $3, NULL, 'run', $4, $5, $6, 'task')`,
      [
        artifact.artifactId,
        tenant.tenantId,
        taskId,
        artifact.sha256,
        artifact.bytes.byteLength,
        artifact.mediaType,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function send(path: string, token = tokenA): Promise<Response> {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  db = await createTestDatabase();
  infra = await createP06Infra(db);
  tasks = new PostgresTaskRepository(db.pool);
  const agents = new PostgresAgentRepository(db.pool);
  tenantA = await createTenantFixture(db.pool, 'artifact HTTP tenant A');
  tenantB = await createTenantFixture(db.pool, 'artifact HTTP tenant B');
  const ctxA = { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 };
  const ctxB = { tenantId: tenantB.tenantId, principalId: tenantB.principalId, policyVersion: 1 };
  const agentA = await agents.create(ctxA, { name: 'artifact HTTP agent A' });
  const agentB = await agents.create(ctxB, { name: 'artifact HTTP agent B' });
  taskA = await createTask(tenantA, agentA.agentId);
  taskB = await createTask(tenantB, agentB.agentId);
  tokenA = `token-${randomUUID()}`;
  tokenB = `token-${randomUUID()}`;
  app = createApp({
    authenticator: createDevTokenAuthenticator([
      {
        token: tokenA,
        tenantId: tenantA.tenantId,
        principalId: tenantA.principalId,
        policyVersion: 1,
      },
      {
        token: tokenB,
        tenantId: tenantB.tenantId,
        principalId: tenantB.principalId,
        policyVersion: 1,
      },
    ]),
    taskStore: tasks,
    artifactStore: infra.artifacts,
  });
});

afterAll(async () => {
  await infra?.dispose();
  await db?.close();
});

describe('Artifact HTTP API with PostgreSQL and LocalBlobStore', () => {
  it('lists committed Task Artifacts and downloads the exact verified bytes', async () => {
    const artifact = await installBytes(tenantA, `committed-${randomUUID()}`, 'text/plain');
    await commitArtifact(tenantA, taskA, artifact);

    const first = await send(`/v1/tasks/${taskA}/artifacts`);
    const second = await send(`/v1/tasks/${taskA}/artifacts`);
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      task_id: string;
      artifacts: Array<{
        artifact_id: string;
        sha256: string;
        size: number;
        media_type: string;
        created_by: string;
        created_at: string;
      }>;
    };
    expect(await second.json()).toEqual(body);
    expect(body).toMatchObject({
      task_id: taskA,
      artifacts: [
        {
          artifact_id: artifact.artifactId,
          sha256: createHash('sha256').update(artifact.bytes).digest('hex'),
          size: artifact.bytes.byteLength,
          media_type: 'text/plain',
          created_by: 'run',
        },
      ],
    });
    expect(typeof body.artifacts[0]?.created_at).toBe('string');
    expect(JSON.stringify(body)).not.toContain(artifact.storageKey);

    const download = await send(`/v1/artifacts/${artifact.artifactId}`);
    expect(download.status).toBe(200);
    const received = Buffer.from(await download.arrayBuffer());
    expect(received).toEqual(artifact.bytes);
    expect(createHash('sha256').update(received).digest('hex')).toBe(artifact.sha256);
    expect(download.headers.get('Content-Type')).toBe('text/plain');
    expect(download.headers.get('Content-Length')).toBe(String(artifact.bytes.byteLength));
    expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(download.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('hides foreign Task and Artifact records and unknown ids with 404', async () => {
    const artifact = await installBytes(tenantA, `foreign-${randomUUID()}`);
    await commitArtifact(tenantA, taskA, artifact);

    const foreignTask = await send(`/v1/tasks/${taskA}/artifacts`, tokenB);
    const foreignArtifact = await send(`/v1/artifacts/${artifact.artifactId}`, tokenB);
    const missingArtifact = await send(`/v1/artifacts/${randomUUID()}`);

    expect(foreignTask.status).toBe(404);
    expect(foreignArtifact.status).toBe(404);
    expect(missingArtifact.status).toBe(404);
    await expect(missingArtifact.json()).resolves.toEqual(await foreignArtifact.json());
    expect((await send(`/v1/tasks/${taskB}/artifacts`, tokenB)).status).toBe(200);
  });

  it('does not expose staged, orphaned, or uncommitted blobs as Task Artifacts', async () => {
    const staged = await infra.blobs.stage(
      tenantA.tenantId,
      Buffer.from(`staged-${randomUUID()}`),
      'application/octet-stream',
    );
    const orphan = await installBytes(tenantA, `orphan-${randomUUID()}`);
    const pending = await installBytes(tenantA, `uncommitted-${randomUUID()}`);
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO blobs (tenant_id, sha256, size, media_type, storage_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenantA.tenantId,
          pending.sha256,
          pending.bytes.byteLength,
          pending.mediaType,
          pending.storageKey,
        ],
      );
      await client.query(
        `INSERT INTO artifacts
           (id, tenant_id, task_id, run_id, created_by, sha256, size, media_type, retention)
         VALUES ($1, $2, $3, NULL, 'run', $4, $5, $6, 'task')`,
        [
          pending.artifactId,
          tenantA.tenantId,
          taskA,
          pending.sha256,
          pending.bytes.byteLength,
          pending.mediaType,
        ],
      );

      const response = await send(`/v1/tasks/${taskA}/artifacts`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ task_id: taskA, artifacts: [] });
      expect((await send(`/v1/artifacts/${pending.artifactId}`)).status).toBe(404);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    expect((await send(`/v1/artifacts/${staged.stagedId}`)).status).toBe(404);
    expect((await send(`/v1/artifacts/${orphan.artifactId}`)).status).toBe(404);
    await expect(
      send(`/v1/tasks/${taskA}/artifacts`).then((response) => response.json()),
    ).resolves.toEqual({ task_id: taskA, artifacts: [] });
  });

  it('fails closed on corrupted stored bytes without returning them or internal details', async () => {
    const artifact = await installBytes(tenantA, `corrupt-${randomUUID()}`);
    await commitArtifact(tenantA, taskA, artifact);
    const absolutePath = await infra.files.resolveKey(artifact.storageKey, 'blobs');
    await writeFile(absolutePath, Buffer.from('corrupted bytes'));

    const response = await send(`/v1/artifacts/${artifact.artifactId}`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain('corrupted bytes');
    expect(body).not.toContain(absolutePath);
    expect(body).not.toContain(artifact.storageKey);
    expect(body).not.toContain('SELECT');
  });
});
