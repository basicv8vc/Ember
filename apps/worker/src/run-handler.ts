import type { LeasedRun, RunTerminalStatus } from '@ember/domain';

/**
 * P0B-05 execution seam.
 *
 * P0B-04 deliberately ships no implementation: a production worker must not claim Tasks
 * until the Execution Router, FakeLLM/FakeSandbox and Artifact/Checkpoint layers exist.
 * Tests may inject a deterministic handler into a future LeaseWorker loop, but the
 * production `worker` entry point only runs `reaper-only` mode.
 */
export interface RunHandler {
  handle(run: LeasedRun, signal: AbortSignal): Promise<RunTerminalStatus>;
}
