import { createHash } from 'node:crypto';
import type { DemoCluster } from '../cluster.js';
import { sanitizeId, type DemoUI, type ScenarioResult } from '../ui.js';

export async function runStandardScenario(
  cluster: DemoCluster,
  ui: DemoUI,
): Promise<ScenarioResult> {
  const start = Date.now();
  ui.section('Scenario B: Standard Path (Fake Sandbox Lifecycle, CAS & Artifact Store)');

  try {
    const prevCreated = cluster.totalSandboxesCreated;
    const prevDestroyed = cluster.totalSandboxesDestroyed;

    // 1. Create Agent via real HTTP API
    ui.step(1, 5, 'Creating Agent for Standard Path via HTTP POST /v1/agents');
    const agentRes = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        name: 'Standard-Compute-Agent',
      },
    });

    if (agentRes.status !== 201) {
      const err = await agentRes.text();
      ui.stepFailed(`HTTP ${agentRes.status}: ${err}`);
      return {
        name: 'Standard Path',
        description: 'Standard computation runs inside transient FakeSandbox and commits Artifact',
        passed: false,
        durationMs: Date.now() - start,
        error: `Failed to create agent: ${err}`,
      };
    }

    const agent = (await agentRes.json()) as { agent_id: string };
    ui.stepOk(`Agent ID: ${sanitizeId(agent.agent_id)}`);

    // 2. Submit Standard Task (mock.compute with text > 512 chars to force standard path)
    const computePayload =
      'Ember standard execution scenario testing fake sandbox lifecycle and artifact store. '.repeat(
        10,
      );
    const expectedSha256 = createHash('sha256').update(computePayload).digest('hex');

    ui.step(2, 5, 'Submitting Standard Task (mock.compute) via HTTP POST /v1/tasks');
    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agent.agent_id,
        kind: 'mock.compute',
        input: {
          operation: 'sha256',
          text: computePayload,
        },
      },
    });

    if (taskRes.status !== 202 && taskRes.status !== 200) {
      const err = await taskRes.text();
      ui.stepFailed(`HTTP ${taskRes.status}: ${err}`);
      return {
        name: 'Standard Path',
        description: 'Standard computation runs inside transient FakeSandbox and commits Artifact',
        passed: false,
        durationMs: Date.now() - start,
        error: `Failed to create task: ${err}`,
      };
    }

    const taskReceipt = (await taskRes.json()) as { task_id: string; status: string };
    ui.stepOk(`Durable Ack: Task ID ${sanitizeId(taskReceipt.task_id)}`);

    // 3. Await completion and sandbox destruction
    ui.step(3, 5, 'Awaiting Worker execution, Checkpoint commit, and CAS version update');
    await cluster.waitForTask(taskReceipt.task_id, 'completed', cluster.tenantA.token, 10_000);
    ui.stepOk('Status: completed');

    // 4. Verify Sandbox Lifecycle (created, destroyed, no lingering instances)
    ui.step(4, 5, 'Verifying Fake Sandbox lifecycle and isolation');
    const newCreated = cluster.totalSandboxesCreated - prevCreated;
    const newDestroyed = cluster.totalSandboxesDestroyed - prevDestroyed;

    if (newCreated === 0) {
      ui.stepFailed('Expected at least 1 sandbox created for standard path, but got 0');
      return {
        name: 'Standard Path',
        description: 'Standard computation runs inside transient FakeSandbox and commits Artifact',
        passed: false,
        durationMs: Date.now() - start,
        error: 'No sandbox created for standard path',
      };
    }

    if (cluster.activeSandboxes !== 0) {
      ui.stepFailed(`Lingering sandboxes detected! Active count: ${cluster.activeSandboxes}`);
      return {
        name: 'Standard Path',
        description: 'Standard computation runs inside transient FakeSandbox and commits Artifact',
        passed: false,
        durationMs: Date.now() - start,
        error: `${cluster.activeSandboxes} lingering sandboxes remained active after execution`,
      };
    }

    ui.stepOk(`Created: ${newCreated}, Destroyed: ${newDestroyed}, Active Lingering: 0`);

    // 5. Query and Download Artifact via HTTP API to verify content & hash
    ui.step(5, 5, 'Verifying Artifact Store & Content-Addressed Storage via HTTP GET');
    const artifactsListRes = await cluster.fetch(`/v1/tasks/${taskReceipt.task_id}/artifacts`, {
      token: cluster.tenantA.token,
    });

    if (artifactsListRes.status !== 200) {
      const err = await artifactsListRes.text();
      ui.stepFailed(`Failed to list artifacts: HTTP ${artifactsListRes.status}: ${err}`);
      return {
        name: 'Standard Path',
        description: 'Standard computation runs inside transient FakeSandbox and commits Artifact',
        passed: false,
        durationMs: Date.now() - start,
        error: `Artifact listing failed: ${err}`,
      };
    }

    const artifactsData = (await artifactsListRes.json()) as {
      artifacts: Array<{ artifact_id: string; sha256: string; size: number }>;
    };

    if (artifactsData.artifacts.length === 0) {
      ui.stepFailed('No artifacts recorded for completed standard task');
      return {
        name: 'Standard Path',
        description: 'Standard computation runs inside transient FakeSandbox and commits Artifact',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Zero artifacts recorded',
      };
    }

    const targetArtifact = artifactsData.artifacts[0];
    if (!targetArtifact) {
      ui.stepFailed('Target artifact missing from list response');
      return {
        name: 'Standard Path',
        description: 'Standard computation runs inside transient FakeSandbox and commits Artifact',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Target artifact missing',
      };
    }

    const downloadRes = await cluster.fetch(`/v1/artifacts/${targetArtifact.artifact_id}`, {
      token: cluster.tenantA.token,
    });

    if (downloadRes.status !== 200) {
      const err = await downloadRes.text();
      ui.stepFailed(`Failed to download artifact: HTTP ${downloadRes.status}: ${err}`);
      return {
        name: 'Standard Path',
        description: 'Standard computation runs inside transient FakeSandbox and commits Artifact',
        passed: false,
        durationMs: Date.now() - start,
        error: `Artifact download failed: ${err}`,
      };
    }

    const downloadedText = (await downloadRes.text()).trim();
    if (downloadedText !== expectedSha256) {
      ui.stepFailed(`Artifact content mismatch: expected ${expectedSha256}, got ${downloadedText}`);
      return {
        name: 'Standard Path',
        description: 'Standard computation runs inside transient FakeSandbox and commits Artifact',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Artifact content mismatch',
      };
    }

    ui.stepOk('Artifact Verified (SHA-256 match)');
    ui.detail('Artifact ID', sanitizeId(targetArtifact.artifact_id));
    ui.detail('Content Hash (SHA-256)', expectedSha256);
    ui.detail('Active Sandboxes Remaining', `${cluster.activeSandboxes} (Cleaned Up)`);

    return {
      name: 'Standard Path',
      description: 'Standard computation runs inside transient FakeSandbox and commits Artifact',
      passed: true,
      durationMs: Date.now() - start,
      details: {
        taskId: sanitizeId(taskReceipt.task_id),
        artifactId: sanitizeId(targetArtifact.artifact_id),
        sha256: expectedSha256,
        sandboxesCreated: newCreated,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.stepFailed(message);
    return {
      name: 'Standard Path',
      description: 'Standard computation runs inside transient FakeSandbox and commits Artifact',
      passed: false,
      durationMs: Date.now() - start,
      error: message,
    };
  }
}
