import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2eCluster } from './support/e2e-cluster.js';

describe('B-T16 E2E Standard Task Closed Loop', () => {
  let cluster: E2eCluster;
  let agentId: string;

  beforeAll(async () => {
    cluster = await E2eCluster.start();

    const res = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { name: 'E2E-Standard-Agent' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string };
    agentId = body.agent_id;
  });

  afterAll(async () => {
    await cluster?.stop();
  });

  it('proves FakeSandbox lifecycle, Artifact commit/download, and Workspace CAS update', async () => {
    const prevCreated = cluster.totalSandboxesCreated;
    const prevDestroyed = cluster.totalSandboxesDestroyed;

    const computeText =
      'Standard task payload verifying sandbox isolation and artifact storage. '.repeat(12);
    const expectedHash = createHash('sha256').update(computeText).digest('hex');

    // 1. Submit Standard Task via real HTTP API
    const createRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.compute',
        input: {
          operation: 'sha256',
          text: computeText,
        },
      },
    });

    expect(createRes.status).toBe(202);
    const receipt = (await createRes.json()) as { task_id: string; status: string };

    // 2. Await completion by Worker
    const completed = await cluster.waitForTask(
      receipt.task_id,
      'completed',
      cluster.tenantA.token,
    );
    expect(completed.status).toBe('completed');

    // 3. Verify Sandbox lifecycle: created and destroyed, none left resident
    const createdCount = cluster.totalSandboxesCreated - prevCreated;
    const destroyedCount = cluster.totalSandboxesDestroyed - prevDestroyed;
    expect(createdCount).toBeGreaterThanOrEqual(1);
    expect(destroyedCount).toBe(createdCount);
    expect(cluster.activeSandboxes).toBe(0);

    // 4. Query artifacts list via HTTP GET /v1/tasks/:taskId/artifacts
    const artifactsListRes = await cluster.fetch(`/v1/tasks/${receipt.task_id}/artifacts`, {
      token: cluster.tenantA.token,
    });
    expect(artifactsListRes.status).toBe(200);
    const artifactsData = (await artifactsListRes.json()) as {
      artifacts: Array<{ artifact_id: string; sha256: string; size: number }>;
    };
    expect(artifactsData.artifacts.length).toBe(1);

    const artifact = artifactsData.artifacts[0];
    expect(artifact).toBeDefined();
    if (!artifact) throw new Error('Artifact expected');
    expect(typeof artifact.artifact_id).toBe('string');

    // 5. Download raw artifact bytes via HTTP GET /v1/artifacts/:artifactId
    const downloadRes = await cluster.fetch(`/v1/artifacts/${artifact.artifact_id}`, {
      token: cluster.tenantA.token,
    });
    expect(downloadRes.status).toBe(200);
    const downloadedContent = (await downloadRes.text()).trim();
    expect(downloadedContent).toBe(expectedHash);

    // 6. Verify Checkpoint was committed to PostgreSQL
    const cpRows = await cluster.appPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [cluster.tenantA.tenantId, receipt.task_id],
    );
    expect(Number(cpRows.rows[0]?.count)).toBeGreaterThanOrEqual(1);

    // 7. Verify Workspace version bumped via CAS in PostgreSQL
    const wsRows = await cluster.appPool.query<{ version: number }>(
      'SELECT version FROM workspaces WHERE tenant_id = $1 AND agent_id = $2',
      [cluster.tenantA.tenantId, agentId],
    );
    expect(wsRows.rows[0]?.version).toBeGreaterThanOrEqual(1);
  });
});
