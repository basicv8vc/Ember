import { createHash } from 'node:crypto';
import type { RunGrant } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import { PostgresRunExecutionContextReader, PostgresRunResultCommitter } from '@ember/postgres';
import {
  CHECKPOINT_EXECUTOR_VERSION,
  executionInputDigest,
} from '../../../worker/src/durable-run-handler.js';
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

    // 2. Pause background worker and submit Task via HTTP POST /v1/tasks
    ui.step(2, 6, 'Submitting Task with Checkpointed Stage via HTTP POST /v1/tasks');
    await cluster.stopWorker();

    const taskInput = {
      operation: 'sha256',
      text: 'Crash-resume scenario payload testing controlled lease expiration and checkpoint skipping. '.repeat(
        10,
      ),
    };

    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agent.agent_id,
        kind: 'mock.compute',
        input: taskInput,
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

    // 3. Worker 1 claims Task, executes Step 1 (produce), and commits Checkpoint
    ui.step(3, 6, 'Worker 1 claims Task, executes produce step, and commits Checkpoint');
    const now = new Date();
    const claim1 = await cluster.queue.claimNext('worker-crash-1', now);
    if (!claim1 || claim1.taskId !== taskReceipt.task_id) {
      ui.stepFailed(`Worker 1 failed to claim submitted task ${sanitizeId(taskReceipt.task_id)}`);
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Worker 1 claim failed',
      };
    }

    const contextReader = new PostgresRunExecutionContextReader(cluster.workerPool, {
      now: () => new Date(),
    });
    const context = await contextReader.read(claim1, now);
    const grant1: RunGrant = {
      tenantId: cluster.tenantA.tenantId,
      taskId: claim1.taskId,
      runId: claim1.runId,
      agentId: context.agentId,
      attempt: claim1.attempt,
      leaseEpoch: claim1.leaseEpoch,
      workerId: 'worker-crash-1',
    };

    const inputDigest = executionInputDigest(context);
    const stagedBytes = Buffer.from(
      createHash('sha256').update(taskInput.text).digest('hex'),
      'utf8',
    );
    const staged = await cluster.blobs.stage(cluster.tenantA.tenantId, stagedBytes, 'text/plain');

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

    await committer.commitStep(grant1, {
      operationId: `step:produce:${inputDigest.slice(0, 16)}`,
      mode: 'progress',
      artifacts: [{ artifactId: staged.stagedId, staged }],
      checkpoint: {
        stepId: 'produce',
        inputDigest,
        executorVersion: CHECKPOINT_EXECUTOR_VERSION,
        cursor: { phase: 'produced' },
        artifacts: [
          {
            artifactId: staged.stagedId,
            sha256: staged.sha256,
            size: staged.size,
            mediaType: staged.mediaType,
            path: `compute/${claim1.taskId}.txt`,
          },
        ],
      },
    });

    // Verify exactly 1 checkpoint committed
    const cpRows = await cluster.appPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2 AND step_id = $3',
      [cluster.tenantA.tenantId, claim1.taskId, 'produce'],
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

    // Verify task and run status are both 'running'
    const taskStatusRes = await cluster.appPool.query<{ status: string }>(
      'SELECT status FROM tasks WHERE tenant_id = $1 AND id = $2',
      [cluster.tenantA.tenantId, claim1.taskId],
    );
    if (taskStatusRes.rows[0]?.status !== 'running') {
      ui.stepFailed(`Expected Task status 'running', found '${taskStatusRes.rows[0]?.status}'`);
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Task not in running state',
      };
    }

    ui.stepOk(
      `Checkpoint Committed (Step: produce, Run: ${sanitizeId(claim1.runId)}, Epoch: ${claim1.leaseEpoch}, Task: running)`,
    );

    // 4. Simulate Worker 1 Crash (rewind lease timestamps) & Reaper Recovery
    ui.step(4, 6, 'Simulating Worker 1 crash & lease expiration, triggering Reaper recovery');
    await cluster.appPool.query(
      `UPDATE runs
          SET leased_until = clock_timestamp() - interval '10 seconds'
        WHERE tenant_id = $1 AND id = $2`,
      [cluster.tenantA.tenantId, claim1.runId],
    );

    await cluster.appPool.query(
      `UPDATE tasks
          SET created_at = clock_timestamp() - interval '1 hour',
              lease_expires_at = clock_timestamp() - interval '50 minutes'
        WHERE tenant_id = $1 AND id = $2`,
      [cluster.tenantA.tenantId, claim1.taskId],
    );

    // Run reaper to converge Run 1 to lease_expired and Task to retryable_failed
    await cluster.queue.reapExpired(new Date());

    const reapedRun = await cluster.appPool.query<{ status: string }>(
      'SELECT status FROM runs WHERE tenant_id = $1 AND id = $2',
      [cluster.tenantA.tenantId, claim1.runId],
    );
    if (reapedRun.rows[0]?.status !== 'lease_expired') {
      ui.stepFailed(`Expected Run 1 status 'lease_expired', found '${reapedRun.rows[0]?.status}'`);
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Run 1 not expired by reaper',
      };
    }

    const reapedTask = await cluster.appPool.query<{ status: string }>(
      'SELECT status FROM tasks WHERE tenant_id = $1 AND id = $2',
      [cluster.tenantA.tenantId, claim1.taskId],
    );
    if (reapedTask.rows[0]?.status !== 'retryable_failed') {
      ui.stepFailed(
        `Expected Task status 'retryable_failed', found '${reapedTask.rows[0]?.status}'`,
      );
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Task not reaped to retryable_failed',
      };
    }
    ui.stepOk(`Reaper Converged (Run 1: lease_expired, Task: retryable_failed)`);

    // 5. Test Lease Fencing against stale Worker 1 (using real crashed grant1)
    ui.step(5, 6, 'Simulating stale Worker 1 late-write and verifying Lease Fencing rejection');
    let fenced = false;
    try {
      await committer.commitStep(grant1, {
        operationId: `step:publish:late_fake_${Date.now()}`,
        mode: 'result',
        artifacts: [],
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

    // 6. Schedule retry and let Worker 2 resume from Checkpoint
    ui.step(6, 6, 'Worker 2 claims task, detects Checkpoint, skips produce, and completes');
    // Set next_run_at to past for immediate pick up
    await cluster.appPool.query(
      `UPDATE tasks SET next_run_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2`,
      [cluster.tenantA.tenantId, claim1.taskId],
    );

    // Restart cluster background worker
    cluster.startWorker();

    const finalTask = await cluster.waitForTask(
      claim1.taskId,
      'completed',
      cluster.tenantA.token,
      10_000,
    );

    // Verify all runs: Run 1 lease_expired, Run 2 succeeded
    const runsRes = await cluster.appPool.query<{
      id: string;
      status: string;
      attempt: number;
      lease_epoch: number;
    }>(
      'SELECT id, status, attempt, lease_epoch FROM runs WHERE tenant_id = $1 AND task_id = $2 ORDER BY attempt ASC',
      [cluster.tenantA.tenantId, claim1.taskId],
    );
    const runList = runsRes.rows;
    if (runList.length < 2) {
      ui.stepFailed(`Expected at least 2 runs, found ${runList.length}`);
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: `Insufficient run records: ${runList.length}`,
      };
    }

    const run1 = runList[0]!;
    const run2 = runList[1]!;

    if (run1.status !== 'lease_expired') {
      ui.stepFailed(`Run 1 expected 'lease_expired', got '${run1.status}'`);
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Run 1 status incorrect',
      };
    }

    if (run2.status !== 'succeeded') {
      ui.stepFailed(`Run 2 expected 'succeeded', got '${run2.status}'`);
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Run 2 status incorrect',
      };
    }

    if (run2.lease_epoch <= run1.lease_epoch) {
      ui.stepFailed(
        `Run 2 lease_epoch (${run2.lease_epoch}) must be > Run 1 (${run1.lease_epoch})`,
      );
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Lease epoch did not advance',
      };
    }

    // Strict assertions on Checkpoint counts
    const finalProduceCp = await cluster.appPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2 AND step_id = 'produce'",
      [cluster.tenantA.tenantId, claim1.taskId],
    );
    const produceCpCount = Number(finalProduceCp.rows[0]?.count ?? '0');
    if (produceCpCount !== 1) {
      ui.stepFailed(`Expected strictly 1 'produce' checkpoint, found ${produceCpCount}`);
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: `Duplicate produce checkpoint detected: count=${produceCpCount}`,
      };
    }

    const finalTotalCp = await cluster.appPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [cluster.tenantA.tenantId, claim1.taskId],
    );
    const finalTotalCpCount = Number(finalTotalCp.rows[0]?.count ?? '0');
    if (finalTotalCpCount !== 2) {
      ui.stepFailed(
        `Expected strictly 2 checkpoints (produce + publish), found ${finalTotalCpCount}`,
      );
      return {
        name: 'Crash / Resume',
        description:
          'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
        passed: false,
        durationMs: Date.now() - start,
        error: `Unexpected checkpoint count: ${finalTotalCpCount}`,
      };
    }

    ui.stepOk('Status: completed');
    ui.detail('Run 1 Status', run1.status);
    ui.detail('Run 2 Status', run2.status);
    ui.detail(
      'Produce Checkpoints in DB',
      `${produceCpCount} (Strictly 1, zero duplicated executions)`,
    );
    ui.detail('Total Checkpoints in DB', `${finalTotalCpCount} (produce + publish)`);
    ui.detail('Terminal State', String(finalTask['status']));

    return {
      name: 'Crash / Resume',
      description:
        'Recovers from lease expiration, skips committed checkpoints, and fences stale workers',
      passed: true,
      durationMs: Date.now() - start,
      details: {
        taskId: sanitizeId(claim1.taskId),
        run1Id: sanitizeId(run1.id),
        run2Id: sanitizeId(run2.id),
        checkpointsCommitted: finalTotalCpCount,
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
