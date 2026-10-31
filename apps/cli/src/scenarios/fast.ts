import type { DemoCluster } from '../cluster.js';
import { sanitizeId, type DemoUI, type ScenarioResult } from '../ui.js';

export async function runFastScenario(cluster: DemoCluster, ui: DemoUI): Promise<ScenarioResult> {
  const start = Date.now();
  ui.section('Scenario A: Fast Path (No Sandbox Execution)');

  try {
    const prevSandboxes = cluster.totalSandboxesCreated;

    // 1. Create Agent via real HTTP API
    ui.step(1, 4, 'Creating Agent A via HTTP POST /v1/agents');
    const agentRes = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        name: 'Fast-Path-Agent',
      },
    });

    if (agentRes.status !== 201) {
      const err = await agentRes.text();
      ui.stepFailed(`HTTP ${agentRes.status}: ${err}`);
      return {
        name: 'Fast Path',
        description: 'Lightweight text task executes via FakeLLM without allocating a sandbox',
        passed: false,
        durationMs: Date.now() - start,
        error: `Failed to create agent: ${err}`,
      };
    }

    const agent = (await agentRes.json()) as { agent_id: string; name: string };
    ui.stepOk(`Agent ID: ${sanitizeId(agent.agent_id)}`);

    // 2. Submit Fast Task (mock.chat with short prompt <= 256 chars)
    ui.step(2, 4, 'Submitting Fast Task (mock.chat) via HTTP POST /v1/tasks');
    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agent.agent_id,
        kind: 'mock.chat',
        input: {
          prompt: 'Hello Ember! Verify 2+2=4 in fast path mode.',
          maxOutputTokens: 64,
        },
      },
    });

    if (taskRes.status !== 202 && taskRes.status !== 200) {
      const err = await taskRes.text();
      ui.stepFailed(`HTTP ${taskRes.status}: ${err}`);
      return {
        name: 'Fast Path',
        description: 'Lightweight text task executes via FakeLLM without allocating a sandbox',
        passed: false,
        durationMs: Date.now() - start,
        error: `Failed to create task: ${err}`,
      };
    }

    const taskReceipt = (await taskRes.json()) as { task_id: string; status: string };
    ui.stepOk(`Durable Ack: Task ID ${sanitizeId(taskReceipt.task_id)}`);
    ui.detail('Initial Status', taskReceipt.status);

    // 3. Await Worker claim and completion
    ui.step(3, 4, 'Awaiting Worker execution and terminal completion');
    await cluster.waitForTask(taskReceipt.task_id, 'completed', cluster.tenantA.token, 10_000);
    ui.stepOk('Status: completed');

    // 4. Verify Fast Path Invariants (Deterministic Router chose fast, SandboxAdapter calls === 0)
    ui.step(4, 4, 'Verifying Fast Path architectural invariants');
    const sandboxesCreated = cluster.totalSandboxesCreated - prevSandboxes;

    // Check events from HTTP API
    const eventsRes = await cluster.fetch(`/v1/tasks/${taskReceipt.task_id}/events`, {
      token: cluster.tenantA.token,
    });
    const eventsData = (await eventsRes.json()) as {
      events: Array<{ phase: string; payload?: Record<string, unknown> }>;
    };
    const eventPhases = eventsData.events.map((e) => e.phase);

    if (sandboxesCreated !== 0) {
      ui.stepFailed(`Expected 0 sandboxes created, but found ${sandboxesCreated}`);
      return {
        name: 'Fast Path',
        description: 'Lightweight text task executes via FakeLLM without allocating a sandbox',
        passed: false,
        durationMs: Date.now() - start,
        error: `Architecture violation: ${sandboxesCreated} sandboxes created during fast path`,
      };
    }

    ui.stepOk('Invariants Verified');
    ui.detail('Fake Sandbox Count', `${sandboxesCreated} (Zero Sandboxes Allocated)`);
    ui.detail('Observed Event Phases', eventPhases.join(' ➔ '));

    return {
      name: 'Fast Path',
      description: 'Lightweight text task executes via FakeLLM without allocating a sandbox',
      passed: true,
      durationMs: Date.now() - start,
      details: {
        taskId: sanitizeId(taskReceipt.task_id),
        sandboxesCreated,
        phases: eventPhases,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.stepFailed(message);
    return {
      name: 'Fast Path',
      description: 'Lightweight text task executes via FakeLLM without allocating a sandbox',
      passed: false,
      durationMs: Date.now() - start,
      error: message,
    };
  }
}
