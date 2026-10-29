import { createHash } from 'node:crypto';
import type {
  BlobStore,
  CheckpointStore,
  RouteDecision,
  RunExecutionContext,
  RunExecutionContextReader,
  RunGrant,
  RunResultCommitter,
} from '@ember/contracts';
import {
  DomainError,
  isDomainError,
  normalizeWorkspacePath,
  type DomainErrorCode,
  type LeasedRun,
  type RunTerminalStatus,
  type TaskKind,
  type WorkspaceManifestValue,
} from '@ember/domain';
import type { ExecutionClock, ExecutionRouterForRun, SimulatedExecutor } from '@ember/execution';
import type { PostgresWorkspaceStore } from '@ember/postgres';
import type { WorkerLogger } from './logger.js';
import type { RunHandler, RunHandlerCompletion } from './run-handler.js';

/**
 * P0B-06 durable execution handler.
 *
 * This is the vertical closure P0B-05 could not provide: one simulated step publishes an
 * Artifact plus a Step checkpoint, a second fenced commit adds it to the Workspace and
 * terminalizes the Run atomically. A crash between the two leaves a committed checkpoint, so
 * the next Run (new lease epoch) resumes without re-executing the completed step.
 *
 * Deliberately absent: real shell, real LLM, network sandbox, device distribution.
 */

/** Kinds this handler can durably execute. `mock.approval` stays out (P0B-08). */
export const DURABLE_TASK_KINDS = ['mock.chat', 'mock.compute', 'mock.file'] as const;

export type DurableTaskKind = (typeof DURABLE_TASK_KINDS)[number];

/** Bumped when the checkpoint layout or step semantics change, so resume can refuse. */
export const CHECKPOINT_EXECUTOR_VERSION = 'deterministic-executor@1';
export const CHECKPOINT_SCHEMA_VERSION = 1;

const PRODUCE_STEP = 'produce';
const PUBLISH_STEP = 'publish';

export interface DurableRunHandlerDependencies {
  readonly contextReader: RunExecutionContextReader;
  readonly router: ExecutionRouterForRun;
  readonly executor: SimulatedExecutor;
  readonly blobs: BlobStore;
  readonly checkpoints: CheckpointStore;
  readonly committer: RunResultCommitter;
  readonly workspaces: Pick<PostgresWorkspaceStore, 'loadForRun'>;
  readonly clock: ExecutionClock;
  readonly logger: WorkerLogger;
}

interface ProducedBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly workspacePath: string;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value ?? null);
}

/** Deterministic input identity of a Task, used as the checkpoint step digest. */
export function executionInputDigest(context: RunExecutionContext): string {
  return sha256Hex(
    stableJson({
      kind: context.kind,
      input: context.input,
      policyVersion: context.policyVersion,
      executorVersion: CHECKPOINT_EXECUTOR_VERSION,
    }),
  );
}

function grantOf(context: RunExecutionContext): RunGrant {
  return Object.freeze({
    tenantId: context.tenantId,
    taskId: context.taskId,
    runId: context.runId,
    agentId: context.agentId,
    attempt: context.attempt,
    leaseEpoch: context.leaseEpoch,
  });
}

const RETRYABLE_CODES: ReadonlySet<DomainErrorCode> = new Set<DomainErrorCode>([
  'DB_UNAVAILABLE',
  'EXECUTION_TIMEOUT',
  'MOCK_TOOL_FAILED',
]);

function codeOf(error: unknown): DomainErrorCode | 'UNEXPECTED' {
  return isDomainError(error) ? error.code : 'UNEXPECTED';
}

function classifyFailure(error: unknown): RunTerminalStatus {
  if (!isDomainError(error)) {
    return 'failed_retryable';
  }

  if (error.code === 'CANCELLED') {
    return 'cancelled';
  }

  if (error.code === 'DEADLINE_EXCEEDED') {
    return 'failed_terminal';
  }

  return RETRYABLE_CODES.has(error.code) ? 'failed_retryable' : 'failed_terminal';
}

interface ProducedStep {
  readonly text?: string;
}

/** Turn the simulated step output into bytes plus their logical workspace path. */
function produceBytes(
  context: RunExecutionContext,
  route: RouteDecision,
  produced: ProducedStep,
): ProducedBytes {
  void route;

  switch (context.kind) {
    case 'mock.chat': {
      return {
        bytes: Buffer.from(produced.text ?? '', 'utf8'),
        mediaType: 'text/plain',
        workspacePath: `chat/${context.taskId}.txt`,
      };
    }
    case 'mock.compute': {
      return {
        bytes: Buffer.from(`${produced.text ?? ''}\n`, 'utf8'),
        mediaType: 'text/plain',
        workspacePath: `compute/${context.taskId}.sha256`,
      };
    }
    case 'mock.file': {
      const input = context.input as {
        readonly fileKey: string;
        readonly content: string;
        readonly mediaType?: string;
      };

      return {
        bytes: Buffer.from(input.content, 'utf8'),
        mediaType: input.mediaType ?? 'text/plain',
        // The Task-supplied key is re-validated here; an absolute or traversing key is refused
        // rather than rewritten into a plausible path.
        workspacePath: normalizeWorkspacePath(input.fileKey),
      };
    }
    default:
      throw new DomainError('POLICY_DENIED', 'task kind has no durable executor branch');
  }
}

/** `mock.file` needs no simulated provider; chat/compute reuse the P0B-05 executor. */
async function executeStep(
  context: RunExecutionContext,
  route: RouteDecision,
  executor: SimulatedExecutor,
  signal: AbortSignal,
): Promise<ProducedBytes> {
  if (context.kind === 'mock.file') {
    return produceBytes(context, route, {});
  }

  const result = await executor.execute(context, route, signal);
  const output = result.output as { readonly text?: string; readonly sha256?: string };

  if (context.kind === 'mock.compute' && typeof output.sha256 === 'string') {
    return produceBytes(context, route, { text: output.sha256 });
  }

  return produceBytes(context, route, typeof output.text === 'string' ? { text: output.text } : {});
}

export function createDurableRunHandler(deps: DurableRunHandlerDependencies): RunHandler {
  const { contextReader, router, executor, blobs, checkpoints, committer, clock, logger } = deps;

  const finish = (outcome: RunTerminalStatus): RunHandlerCompletion => ({
    type: 'finish',
    outcome,
  });

  return {
    async handle(run: LeasedRun, signal: AbortSignal): Promise<RunHandlerCompletion> {
      const startedAtHr = performance.now();
      const base = {
        taskId: run.taskId,
        runId: run.runId,
        attempt: run.attempt,
        leaseEpoch: run.leaseEpoch,
      } as const;

      let context: RunExecutionContext;

      try {
        context = await contextReader.read(run, clock.now());
      } catch (error) {
        if (isDomainError(error) && (error.code === 'STALE_LEASE' || error.code === 'NOT_FOUND')) {
          // The lease is gone or belongs to someone else: never execute, never submit.
          throw error;
        }

        const outcome = classifyFailure(error);
        logger.warn('durable execution context unavailable', {
          ...base,
          code: codeOf(error),
          outcome,
        });
        return finish(outcome);
      }

      const grant = grantOf(context);
      const inputDigest = executionInputDigest(context);

      let route: RouteDecision;

      try {
        route = await router.decideForExecution({
          policyVersion: context.policyVersion,
          kind: context.kind,
          input: context.input,
        });
      } catch (error) {
        const outcome = classifyFailure(error);
        logger.warn('durable execution route rejected', {
          ...base,
          taskKind: context.kind,
          code: codeOf(error),
          outcome,
        });
        return finish(outcome);
      }

      try {
        // Recovery input is read-only and filtered by schema/executor compatibility. An
        // incompatible checkpoint stops here instead of being guessed at.
        const committed = await checkpoints.list(grant, {
          schemaVersion: CHECKPOINT_SCHEMA_VERSION,
          executorVersion: CHECKPOINT_EXECUTOR_VERSION,
        });
        const produced = committed.find((entry) => entry.stepId === PRODUCE_STEP);
        const resumeArtifact = produced?.artifacts[0];

        const reuse =
          produced !== undefined &&
          resumeArtifact !== undefined &&
          produced.inputDigest === inputDigest;

        if (reuse && resumeArtifact !== undefined && produced !== undefined) {
          const intact = await blobs.verifyContent(
            context.tenantId,
            resumeArtifact.sha256,
            resumeArtifact.size,
          );

          if (!intact) {
            throw new DomainError(
              'DB_UNAVAILABLE',
              'checkpointed artifact failed integrity verification',
            );
          }

          logger.info('durable step already committed; resuming', {
            ...base,
            stepId: PRODUCE_STEP,
            stepSequence: produced.stepSequence,
          });

          return await publishResult(
            deps,
            context,
            grant,
            inputDigest,
            {
              artifactId: resumeArtifact.artifactId,
              sha256: resumeArtifact.sha256,
              size: resumeArtifact.size,
              mediaType: resumeArtifact.mediaType,
            },
            resumeArtifact.path ?? `chat/${context.taskId}.txt`,
            route,
            startedAtHr,
          );
        }

        const producedBytes = await executeStep(context, route, executor, signal);
        const staged = await blobs.stage(
          context.tenantId,
          producedBytes.bytes,
          producedBytes.mediaType,
        );

        const producedReceipt = await committer.commitStep(grant, {
          operationId: `step:${PRODUCE_STEP}:${inputDigest.slice(0, 16)}`,
          mode: 'progress',
          artifacts: [{ artifactId: staged.stagedId, staged }],
          checkpoint: {
            stepId: PRODUCE_STEP,
            inputDigest,
            executorVersion: CHECKPOINT_EXECUTOR_VERSION,
            artifacts: [
              {
                artifactId: staged.stagedId,
                sha256: staged.sha256,
                size: staged.size,
                mediaType: staged.mediaType,
                path: producedBytes.workspacePath,
              },
            ],
          },
        });

        return await publishResult(
          deps,
          context,
          grant,
          inputDigest,
          {
            artifactId: producedReceipt.artifactIds[0] ?? staged.stagedId,
            sha256: staged.sha256,
            size: staged.size,
            mediaType: staged.mediaType,
          },
          producedBytes.workspacePath,
          route,
          startedAtHr,
        );
      } catch (error) {
        if (isDomainError(error) && error.code === 'STALE_LEASE') {
          // Ownership moved on: the loop must not call finish() either.
          throw error;
        }

        const outcome = classifyFailure(error);
        logger.warn('durable execution failed', {
          ...base,
          taskKind: context.kind,
          code: codeOf(error),
          outcome,
          diagnostic: isDomainError(error) ? error.diagnostic : 'unexpected',
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        return finish(outcome);
      }
    },
  };
}

/**
 * Publish the produced artifact into the Workspace and terminalize the Run atomically.
 *
 * The workspace version is read before the CAS and the CAS itself is conditional, so a
 * concurrent writer either merges deterministically or produces a preserved conflict — never
 * a silent overwrite.
 */
async function publishResult(
  deps: DurableRunHandlerDependencies,
  context: RunExecutionContext,
  grant: RunGrant,
  inputDigest: string,
  artifact: { artifactId: string; sha256: string; size: number; mediaType: string },
  workspacePath: string,
  route: RouteDecision,
  startedAtHr: number,
): Promise<RunHandlerCompletion> {
  const { workspaces, committer, logger } = deps;
  const workspace = await workspaces.loadForRun(context.tenantId, context.agentId);
  const entry = {
    path: workspacePath,
    artifactId: artifact.artifactId,
    sha256: artifact.sha256,
    size: artifact.size,
  };
  const manifest: WorkspaceManifestValue = {
    files: [...workspace.manifest.files.filter((file) => file.path !== workspacePath), entry],
  };

  const receipt = await committer.commitStep(grant, {
    operationId: `step:${PUBLISH_STEP}:${inputDigest.slice(0, 16)}`,
    mode: 'result',
    workspace: { expectedVersion: workspace.version, manifest },
    checkpoint: {
      stepId: PUBLISH_STEP,
      inputDigest,
      executorVersion: CHECKPOINT_EXECUTOR_VERSION,
      artifacts: [
        {
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          size: artifact.size,
          mediaType: artifact.mediaType,
          path: workspacePath,
        },
      ],
    },
  });

  logger.info('durable execution committed', {
    taskId: grant.taskId,
    runId: grant.runId,
    attempt: grant.attempt,
    leaseEpoch: grant.leaseEpoch,
    taskKind: context.kind,
    route: route.path,
    workspaceVersion: receipt.workspaceVersion,
    durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
    simulated: true,
    durable: true,
  });

  return { type: 'committed', receipt };
}

/** Guard used by the worker composition root to keep claim eligibility truthful. */
export function isDurableTaskKind(kind: TaskKind): kind is DurableTaskKind {
  return (DURABLE_TASK_KINDS as readonly TaskKind[]).includes(kind);
}
