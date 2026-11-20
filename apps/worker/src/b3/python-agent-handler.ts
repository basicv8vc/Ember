import type { CommitReceipt } from '@ember/contracts';
import { DomainError, type LeasedRun } from '@ember/domain';
import type { RunHandler, RunHandlerCompletion } from '../run-handler.js';
import {
  executePythonAgentRun,
  type PythonAgentExecutorDependencies,
} from './python-agent-executor.js';

/**
 * Adapt `executePythonAgentRun` to the poll-loop `RunHandler` contract.
 *
 * `executePythonAgentRun` atomically terminalizes the Run inside PostgreSQL for every
 * non-`lease_lost` outcome (`commitCompletion` / `commitFailure`). Returning `committed`
 * prevents `runPollLoop` from issuing a duplicate `LeaseQueue.finish()` call, while
 * `lease_lost` throws `STALE_LEASE` so the loop abandons the Run cleanly.
 */
export function createPythonAgentTaskHandler(
  deps: PythonAgentExecutorDependencies,
): RunHandler {
  const nowFn = deps.now ?? (() => new Date());

  return {
    async handle(run: LeasedRun, signal: AbortSignal): Promise<RunHandlerCompletion> {
      const outcome = await executePythonAgentRun(run, deps, signal);

      if (outcome.outcome === 'lease_lost') {
        throw new DomainError('STALE_LEASE', 'python.agent run lost its lease');
      }

      const receipt: CommitReceipt = {
        operationId: `python-agent:${run.taskId}:${run.runId}:attempt:${run.attempt}`,
        mode: 'result',
        taskId: run.taskId,
        runId: run.runId,
        attempt: run.attempt,
        leaseEpoch: run.leaseEpoch,
        artifactIds: outcome.outcome === 'succeeded' ? [...outcome.publishedArtifactIds] : [],
        workspaceVersion: null,
        checkpointId: null,
        replayed: false,
        committedAt: nowFn().toISOString(),
      };

      return { type: 'committed', receipt };
    },
  };
}
