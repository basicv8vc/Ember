import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type AuthContext, type Id } from '@ember/domain';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import type { ArtifactHttpStore } from '../../apps/api/src/artifacts/artifact-store.js';
import type { ArtifactLookup, ArtifactMetadata } from '../../packages/contracts/src/persistence.js';
import { buildTaskView, createFakeTaskApi, FIXED_TIME } from './support/task-api-fakes.js';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const PRINCIPAL_A = randomUUID();
const PRINCIPAL_B = randomUUID();
const TOKEN_A = `token-${randomUUID()}`;
const TOKEN_B = `token-${randomUUID()}`;
const TASK_ID = randomUUID();
const ARTIFACT_ID = randomUUID();
const REQUEST_ID = 'req-artifact-http';
const BYTES = Buffer.from([0, 1, 2, 10, 13, 127, 128, 255]);

type App = ReturnType<typeof createApp>;

interface Harness {
  readonly app: App;
  readonly tasks: ReturnType<typeof createFakeTaskApi>;
  readonly store: ArtifactHttpStore;
  readonly list: ReturnType<typeof vi.fn>;
  readonly find: ReturnType<typeof vi.fn>;
  readonly read: ReturnType<typeof vi.fn>;
}

function harness(options: { readonly corrupt?: boolean } = {}): Harness {
  const tasks = createFakeTaskApi();
  tasks.addTask(TENANT_A, buildTaskView({ taskId: TASK_ID }));
  const metadata: ArtifactMetadata = {
    artifactId: ARTIFACT_ID,
    sha256: createHash('sha256').update(BYTES).digest('hex'),
    size: BYTES.byteLength,
    mediaType: 'application/octet-stream',
    createdBy: 'run',
    retention: 'task',
    taskId: TASK_ID,
    runId: randomUUID(),
    createdAt: FIXED_TIME,
  };
  const lookup: ArtifactLookup = {
    metadata,
    storageKey: `blobs/${TENANT_A}/${metadata.sha256}`,
  };
  const list = vi.fn((_ctx: AuthContext, _taskId: Id) => Promise.resolve([metadata]));
  const find = vi.fn((ctx: AuthContext, id: Id) =>
    Promise.resolve(ctx.tenantId === TENANT_A && id === ARTIFACT_ID ? lookup : null),
  );
  const read = vi.fn(() => {
    if (options.corrupt) {
      return Promise.reject(
        new DomainError('DB_UNAVAILABLE', 'internal path /var/private/blob failed SHA check'),
      );
    }

    return Promise.resolve(BYTES);
  });
  const store: ArtifactHttpStore = { listForTask: list, find, get: read };
  const app = createApp({
    authenticator: createDevTokenAuthenticator([
      { token: TOKEN_A, tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 1 },
      { token: TOKEN_B, tenantId: TENANT_B, principalId: PRINCIPAL_B, policyVersion: 1 },
    ]),
    requestIdGenerator: () => REQUEST_ID,
    taskStore: tasks.store,
    artifactStore: store,
  });

  return { app, tasks, store, list, find, read };
}

async function get(app: App, path: string, token: string | null = TOKEN_A): Promise<Response> {
  return await app.request(path, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

describe('Artifact HTTP API', () => {
  it('lists only visible task metadata with a stable, public DTO', async () => {
    const { app, list, tasks } = harness();
    const first = await get(app, `/v1/tasks/${TASK_ID}/artifacts`);
    const second = await get(app, `/v1/tasks/${TASK_ID}/artifacts`);

    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toEqual({
      task_id: TASK_ID,
      artifacts: [
        {
          artifact_id: ARTIFACT_ID,
          sha256: createHash('sha256').update(BYTES).digest('hex'),
          size: BYTES.byteLength,
          media_type: 'application/octet-stream',
          created_by: 'run',
          created_at: FIXED_TIME,
        },
      ],
    });
    expect(await second.json()).toEqual(body);
    expect(JSON.stringify(body)).not.toContain('storage_key');
    expect(JSON.stringify(body)).not.toContain('/var/private');
    expect(list).toHaveBeenCalledWith(
      { tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 1 },
      TASK_ID,
    );
    expect(tasks.gets).toHaveLength(2);
  });

  it('returns a clear empty collection for a visible task without artifacts', async () => {
    const { app, list } = harness();
    list.mockResolvedValueOnce([]);

    const response = await get(app, `/v1/tasks/${TASK_ID}/artifacts`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task_id: TASK_ID, artifacts: [] });
  });

  it('returns 404 for a task owned by another tenant before listing artifacts', async () => {
    const { app, list, tasks } = harness();
    const foreignTask = randomUUID();
    tasks.addTask(TENANT_A, buildTaskView({ taskId: foreignTask }));

    // Tenant B has no visibility into the task, regardless of the shared artifact store.
    const response = await get(app, `/v1/tasks/${foreignTask}/artifacts`, TOKEN_B);

    expect(response.status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });

  it('downloads verified raw bytes with private, non-sniffable response headers', async () => {
    const { app } = harness();

    const response = await get(app, `/v1/artifacts/${ARTIFACT_ID}`);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Length')).toBe(String(BYTES.byteLength));
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('hides foreign and unknown Artifact ids behind the same 404 response', async () => {
    const { app, find, read } = harness();

    const foreign = await get(app, `/v1/artifacts/${ARTIFACT_ID}`, TOKEN_B);
    const unknown = await get(app, `/v1/artifacts/${randomUUID()}`);

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual(await foreign.json());
    expect(find).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects malformed UUIDs and missing or invalid credentials before storage access', async () => {
    const { app, find, list } = harness();

    expect((await get(app, '/v1/artifacts/not-a-uuid')).status).toBe(400);
    expect((await get(app, `/v1/tasks/not-a-uuid/artifacts`)).status).toBe(400);
    expect((await get(app, `/v1/artifacts/${ARTIFACT_ID}`, null)).status).toBe(401);
    expect((await get(app, `/v1/artifacts/${ARTIFACT_ID}`, 'invalid-token')).status).toBe(401);
    expect((await get(app, `/v1/tasks/${TASK_ID}/artifacts`, null)).status).toBe(401);
    expect((await get(app, `/v1/tasks/${TASK_ID}/artifacts`, 'invalid-token')).status).toBe(401);
    expect(find).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('fails closed when the Artifact store rejects bytes during integrity verification', async () => {
    const { app } = harness({ corrupt: true });

    const response = await get(app, `/v1/artifacts/${ARTIFACT_ID}`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain('/var/private');
    expect(body).not.toContain('storage_key');
    expect(body).not.toContain('blobs/');
    expect(body).not.toContain('SELECT');
  });
});
