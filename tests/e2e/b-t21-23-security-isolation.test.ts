import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2eCluster } from './support/e2e-cluster.js';

describe('B-T21～23 E2E Tenant Isolation & Security Boundary', () => {
  let cluster: E2eCluster;
  let agentIdA: string;
  let taskIdA: string;
  let artifactIdA: string;

  beforeAll(async () => {
    cluster = await E2eCluster.start();

    // 1. Provision Agent A under Tenant A
    const agentRes = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { name: 'Tenant-A-Secret-Agent' },
    });
    expect(agentRes.status).toBe(201);
    const agentBody = (await agentRes.json()) as { agent_id: string };
    agentIdA = agentBody.agent_id;

    // 2. Submit compute Task A under Tenant A
    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentIdA,
        kind: 'mock.compute',
        input: {
          operation: 'sha256',
          text: 'Tenant A private text content for artifact isolation verification. '.repeat(10),
        },
      },
    });
    expect(taskRes.status).toBe(202);
    const taskBody = (await taskRes.json()) as { task_id: string };
    taskIdA = taskBody.task_id;

    // Wait for Task A to complete
    await cluster.waitForTask(taskIdA, 'completed', cluster.tenantA.token);

    // Get Artifact ID
    const artifactsRes = await cluster.fetch(`/v1/tasks/${taskIdA}/artifacts`, {
      token: cluster.tenantA.token,
    });
    expect(artifactsRes.status).toBe(200);
    const artifactsData = (await artifactsRes.json()) as {
      artifacts: Array<{ artifact_id: string }>;
    };
    expect(artifactsData.artifacts.length).toBeGreaterThanOrEqual(1);
    const firstArt = artifactsData.artifacts[0];
    expect(firstArt).toBeDefined();
    if (!firstArt) throw new Error('Artifact expected');
    artifactIdA = firstArt.artifact_id;
  });

  afterAll(async () => {
    await cluster?.stop();
  });

  it('B-T21: Tenant B receives 404 NOT_FOUND when querying Tenant A task', async () => {
    const res = await cluster.fetch(`/v1/tasks/${taskIdA}`, {
      token: cluster.tenantB.token,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('B-T22: Tenant B receives 404 NOT_FOUND when reading Tenant A artifacts or events', async () => {
    // 1. Artifact list
    const listRes = await cluster.fetch(`/v1/tasks/${taskIdA}/artifacts`, {
      token: cluster.tenantB.token,
    });
    expect(listRes.status).toBe(404);

    // 2. Raw artifact download
    const getArtifactRes = await cluster.fetch(`/v1/artifacts/${artifactIdA}`, {
      token: cluster.tenantB.token,
    });
    expect(getArtifactRes.status).toBe(404);

    // 3. Event log
    const eventsRes = await cluster.fetch(`/v1/tasks/${taskIdA}/events`, {
      token: cluster.tenantB.token,
    });
    expect(eventsRes.status).toBe(404);

    // 4. SSE event stream
    const streamRes = await cluster.fetch(`/v1/tasks/${taskIdA}/stream`, {
      token: cluster.tenantB.token,
    });
    expect(streamRes.status).toBe(404);
  });

  it('B-T23: rejects unauthenticated and forged token requests with HTTP 401', async () => {
    // 1. Missing Authorization header
    const noTokenRes = await cluster.fetch(`/v1/tasks/${taskIdA}`);
    expect(noTokenRes.status).toBe(401);
    const noTokenBody = (await noTokenRes.json()) as { error: { code: string } };
    expect(noTokenBody.error.code).toBe('UNAUTHENTICATED');

    // 2. Forged Bearer token
    const forgedTokenRes = await cluster.fetch(`/v1/tasks/${taskIdA}`, {
      token: 'forged-fake-dev-token-xyz',
    });
    expect(forgedTokenRes.status).toBe(401);
    const forgedBody = (await forgedTokenRes.json()) as { error: { code: string } };
    expect(forgedBody.error.code).toBe('UNAUTHENTICATED');

    // 3. Malformed Bearer header (e.g. empty token or invalid format)
    const malformedRes = await cluster.fetch(`/v1/tasks/${taskIdA}`, {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(malformedRes.status).toBe(401);
  });
});
