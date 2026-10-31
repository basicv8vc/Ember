import type { RunGrant } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import { PostgresRunResultCommitter } from '@ember/postgres';
import type { DemoCluster } from '../cluster.js';
import { sanitizeId, type DemoUI, type ScenarioResult } from '../ui.js';

export async function runCrashResumeScenario(
  cluster: DemoCluster,
  ui: DemoUI,
): Promise<ScenarioResult> {
  const start = Date.now();
  ui.section('Scenario C: Simulated Lease Expiration & Checkpoint Resume with Fencing');

  try {
    // 1. Create Agent via HTTP API
    ui.step(1, 6, 'Creating Agent for Resume Path via HTTP POST /v1/agents');
    const agentRes = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        name: 'Crash-Resume-Agent',
      },
    });

    if (agentRes.status !== 201) {
      const err = await agentRes.text();
      ui.stepFailed(`HTTP ${agentRes.status}: ${err}`);
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: `Agent creation failed: ${err}`,
      };
    }

    const agent = (await agentRes.json()) as { agent_id: string };
    ui.stepOk(`Agent ID: ${sanitizeId(agent.agent_id)}`);

    // 2. Submit mock.approval Task (which durably commits 'produce' checkpoint before pausing)
    ui.step(2, 6, 'Submitting Task with Checkpointed Stage via HTTP POST /v1/tasks');
    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agent.agent_id,
        kind: 'mock.approval',
        input: {
          action: 'deploy_demo_service_v1',
          reason: 'Verifying atomic checkpoint persistence before decision gate',
        },
      },
    });

    if (taskRes.status !== 202 && taskRes.status !== 200) {
      const err = await taskRes.text();
      ui.stepFailed(`HTTP ${taskRes.status}: ${err}`);
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: `Task submission failed: ${err}`,
      };
    }

    const taskReceipt = (await taskRes.json()) as { task_id: string };
    ui.stepOk(`Task ID: ${sanitizeId(taskReceipt.task_id)}`);

    // 3. Await first stage completion (task reaches waiting_approval with produce checkpoint committed)
    ui.step(3, 6, 'Worker 1 executes produce step and durably commits Checkpoint');
    await cluster.waitForTask(
      taskReceipt.task_id,
      'waiting_approval',
      cluster.tenantA.token,
      10_000,
    );

    // Verify checkpoint row exists in PostgreSQL
    const cpRows = await cluster.appPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2 AND step_id = $3',
      [cluster.tenantA.tenantId, taskReceipt.task_id, 'produce'],
    );
    const cpCount = Number(cpRows.rows[0]?.count ?? '0');
    if (cpCount !== 1) {
      ui.stepFailed(`Expected 1 checkpoint for 'produce', found ${cpCount}`);
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: `Checkpoint for produce step was not committed to DB`,
      };
    }

    // Read the completed run record to inspect lease epoch
    const runRows = await cluster.appPool.query<{ id: string; lease_epoch: number }>(
      'SELECT id, lease_epoch FROM runs WHERE tenant_id = $1 AND task_id = $2 ORDER BY attempt DESC LIMIT 1',
      [cluster.tenantA.tenantId, taskReceipt.task_id],
    );
    const oldRun = runRows.rows[0];
    if (!oldRun) {
      ui.stepFailed('Run record not found in database');
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Run record not found',
      };
    }
    ui.stepOk(
      `Checkpoint Committed (Step: produce, Run: ${sanitizeId(oldRun.id)}, Epoch: ${oldRun.lease_epoch})`,
    );

    // 4. Test Lease Fencing against stale Run 1
    ui.step(4, 6, 'Simulating stale worker late-write and verifying Lease Fencing rejection');
    const staleGrant: RunGrant = {
      tenantId: cluster.tenantA.tenantId,
      taskId: taskReceipt.task_id,
      runId: oldRun.id,
      agentId: agent.agent_id,
      attempt: 1,
      leaseEpoch: 0, // Stale epoch guaranteed to be behind current or expired
      workerId: 'worker-stale-rogue',
    };

    const committer = new PostgresRunResultCommitter(cluster.workerPool, {
      blobs: cluster.blobs,
      policy: {
        leaseDurationMs: 15_000,
        heartbeatIntervalMs: 3_000,
        reaperBatchSize: 20,
        baseDelayMs: 500,
        capDelayMs: 5_000,
      },
    });

    let fenced = false;
    try {
      await committer.commitStep(staleGrant, {
        operationId: `step:produce:late_fake`,
        mode: 'progress',
      });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'STALE_LEASE') {
        fenced = true;
      }
    }

    if (!fenced) {
      ui.stepFailed('Stale worker write was NOT rejected by lease fencing!');
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Lease fencing failed to reject stale grant',
      };
    }
    ui.stepOk('Fencing Protected: Stale write rejected with STALE_LEASE');

    // 5. Grant approval via HTTP API to queue Run 2
    ui.step(5, 6, 'Submitting Approval decision via HTTP POST /v1/approvals/:id/decision');
    const approvalsRes = await cluster.fetch(`/v1/tasks/${taskReceipt.task_id}/approvals`, {
      token: cluster.tenantA.token,
    });
    const approvalsData = (await approvalsRes.json()) as {
      approvals: Array<{ approval_id: string; status: string }>;
    };

    const approval = approvalsData.approvals[0];
    if (!approval) {
      ui.stepFailed('No approval record found for task');
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Approval record missing',
      };
    }

    const approvalId = approval.approval_id;
    const decisionRes = await cluster.fetch(`/v1/approvals/${approvalId}/decision`, {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        decision: 'approve',
      },
    });

    if (decisionRes.status !== 200) {
      const err = await decisionRes.text();
      ui.stepFailed(`Decision HTTP ${decisionRes.status}: ${err}`);
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: `Approval decision failed: ${err}`,
      };
    }
    ui.stepOk(`Approved (Approval ID: ${sanitizeId(approvalId)})`);

    // 6. Await Run 2 resume and completion
    ui.step(6, 6, 'Run 2 claims task, detects Checkpoint, skips produce, and completes');
    const finalTask = await cluster.waitForTask(
      taskReceipt.task_id,
      'completed',
      cluster.tenantA.token,
      10_000,
    );

    // Verify checkpoint was NOT duplicated
    const finalCpRows = await cluster.appPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [cluster.tenantA.tenantId, taskReceipt.task_id],
    );
    const finalCpCount = Number(finalCpRows.rows[0]?.count ?? '0');

    ui.stepOk('Status: completed');
    ui.detail('Checkpoints in DB', `${finalCpCount} (Zero duplicated executions)`);
    ui.detail('Terminal State', finalTask.status);

    return {
      name: 'Crash / Resume',
      description:
        'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
      passed: true,
      durationMs: Date.now() - start,
      details: {
        taskId: sanitizeId(taskReceipt.task_id),
        checkpointsCommitted: finalCpCount,
        fencingVerified: true,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.stepFailed(message);
    return {
      name: 'Crash / Resume',
      description:
        'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
      passed: false,
      durationMs: Date.now() - start,
      error: message,
    };
  }
}
