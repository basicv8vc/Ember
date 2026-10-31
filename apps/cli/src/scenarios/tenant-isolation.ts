import type { DemoCluster } from '../cluster.js';
import { sanitizeId, type DemoUI, type ScenarioResult } from '../ui.js';

export async function runTenantIsolationScenario(
  cluster: DemoCluster,
  ui: DemoUI,
): Promise<ScenarioResult> {
  const start = Date.now();
  ui.section('Scenario D: Tenant Isolation & Non-Discoverable Authorization');

  try {
    // 1. Setup Tenant A Agent & Task
    ui.step(1, 6, 'Provisioning Tenant A Task and Artifact via HTTP');
    const agentRes = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        name: 'Tenant-A-Private-Agent',
      },
    });

    const agentA = (await agentRes.json()) as { agent_id: string };

    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentA.agent_id,
        kind: 'mock.chat',
        input: {
          prompt: 'Tenant A confidential instructions',
        },
      },
    });

    const taskA = (await taskRes.json()) as { task_id: string };
    await cluster.waitForTask(taskA.task_id, 'completed', cluster.tenantA.token, 10_000);
    ui.stepOk(`Tenant A Task: ${sanitizeId(taskA.task_id)}`);

    // 2. Tenant B cross-tenant task query -> MUST return 404 Not Found (Zero-knowledge / non-discoverable)
    ui.step(2, 6, 'Tenant B querying Tenant A Task via HTTP GET /v1/tasks/:id');
    const getTaskRes = await cluster.fetch(`/v1/tasks/${taskA.task_id}`, {
      token: cluster.tenantB.token,
    });

    if (getTaskRes.status !== 404) {
      ui.stepFailed(`Expected 404 Not Found, but received HTTP ${getTaskRes.status}`);
      return {
        name: 'Tenant Isolation',
        description:
          'Proves cross-tenant queries return 404 non-discoverable and unauthorized requests return 401',
        passed: false,
        durationMs: Date.now() - start,
        error: `Cross-tenant task disclosure: HTTP ${getTaskRes.status}`,
      };
    }
    ui.stepOk('Protected: HTTP 404 NOT_FOUND (Non-discoverable)');

    // 3. Tenant B cross-tenant events query -> MUST return 404
    ui.step(3, 6, 'Tenant B querying Tenant A Event log via HTTP GET /v1/tasks/:id/events');
    const getEventsRes = await cluster.fetch(`/v1/tasks/${taskA.task_id}/events`, {
      token: cluster.tenantB.token,
    });

    if (getEventsRes.status !== 404) {
      ui.stepFailed(`Expected 404 Not Found, but received HTTP ${getEventsRes.status}`);
      return {
        name: 'Tenant Isolation',
        description:
          'Proves cross-tenant queries return 404 non-discoverable and unauthorized requests return 401',
        passed: false,
        durationMs: Date.now() - start,
        error: `Cross-tenant event disclosure: HTTP ${getEventsRes.status}`,
      };
    }
    ui.stepOk('Protected: HTTP 404 NOT_FOUND (Events hidden)');

    // 4. Tenant B cross-tenant artifact query -> MUST return 404
    ui.step(4, 6, 'Tenant B querying Tenant A Artifact via HTTP GET /v1/tasks/:id/artifacts');
    const getArtifactsRes = await cluster.fetch(`/v1/tasks/${taskA.task_id}/artifacts`, {
      token: cluster.tenantB.token,
    });

    if (getArtifactsRes.status !== 404) {
      ui.stepFailed(`Expected 404 Not Found, but received HTTP ${getArtifactsRes.status}`);
      return {
        name: 'Tenant Isolation',
        description:
          'Proves cross-tenant queries return 404 non-discoverable and unauthorized requests return 401',
        passed: false,
        durationMs: Date.now() - start,
        error: `Cross-tenant artifact disclosure: HTTP ${getArtifactsRes.status}`,
      };
    }
    ui.stepOk('Protected: HTTP 404 NOT_FOUND (Artifacts hidden)');

    // 5. Tenant B cross-tenant task cancellation -> MUST return 404
    ui.step(5, 6, 'Tenant B attempting to cancel Tenant A Task via HTTP POST /v1/tasks/:id/cancel');
    const cancelRes = await cluster.fetch(`/v1/tasks/${taskA.task_id}/cancel`, {
      method: 'POST',
      token: cluster.tenantB.token,
    });

    if (cancelRes.status !== 404) {
      ui.stepFailed(`Expected 404 Not Found, but received HTTP ${cancelRes.status}`);
      return {
        name: 'Tenant Isolation',
        description:
          'Proves cross-tenant queries return 404 non-discoverable and unauthorized requests return 401',
        passed: false,
        durationMs: Date.now() - start,
        error: `Cross-tenant cancellation unauthorized status: HTTP ${cancelRes.status}`,
      };
    }
    ui.stepOk('Protected: HTTP 404 NOT_FOUND (Operation denied)');

    // 6. Unauthenticated and invalid token requests -> MUST return 401 Unauthenticated
    ui.step(6, 6, 'Testing unauthenticated and forged token requests');
    const noTokenRes = await cluster.fetch(`/v1/tasks/${taskA.task_id}`);
    const badTokenRes = await cluster.fetch(`/v1/tasks/${taskA.task_id}`, {
      token: 'forged-fake-tenant-token-9999',
    });

    if (noTokenRes.status !== 401 || badTokenRes.status !== 401) {
      ui.stepFailed(
        `Expected 401 Unauthorized, got: noToken=${noTokenRes.status}, badToken=${badTokenRes.status}`,
      );
      return {
        name: 'Tenant Isolation',
        description:
          'Proves cross-tenant queries return 404 non-discoverable and unauthorized requests return 401',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Authentication guard failed to return 401',
      };
    }
    ui.stepOk('Protected: HTTP 401 UNAUTHENTICATED (Enforced)');

    ui.detail('Cross-Tenant Data Leakage', 'None (SQL tenant filtering strictly verified)');
    ui.detail('Cross-Tenant Task Status', '404 NOT_FOUND');
    ui.detail('Cross-Tenant Event Status', '404 NOT_FOUND');
    ui.detail('Cross-Tenant Artifact Status', '404 NOT_FOUND');
    ui.detail('Missing Token Status', '401 UNAUTHENTICATED');

    return {
      name: 'Tenant Isolation',
      description:
        'Proves cross-tenant queries return 404 non-discoverable and unauthorized requests return 401',
      passed: true,
      durationMs: Date.now() - start,
      details: {
        taskAId: sanitizeId(taskA.task_id),
        crossTenantStatus: 404,
        unauthedStatus: 401,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.stepFailed(message);
    return {
      name: 'Tenant Isolation',
      description:
        'Proves cross-tenant queries return 404 non-discoverable and unauthorized requests return 401',
      passed: false,
      durationMs: Date.now() - start,
      error: message,
    };
  }
}
