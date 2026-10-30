import { createHash } from 'node:crypto';
import type {
  BlobStore,
  BudgetLedger,
  BudgetReservationAmount,
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
import {
  computeApprovalActionDigest,
  type ExecutionClock,
  type ExecutionRouterForRun,
  type SimulatedExecutor,
} from '@ember/execution';
import type { PostgresApprovalRepository, PostgresWorkspaceStore } from '@ember/postgres';
import { stepCost, stepOperationId } from './budget-plan.js';
import type { WorkerLogger } from './logger.js';
import type { RunHandler, RunHandlerCompletion } from './run-handler.js';

/**
 * P0B-06 / P0B-08d durable execution handler.
 *
 * This is the vertical closure P0B-05 could not provide: one simulated step publishes an
 * Artifact plus a Step checkpoint, a second fenced commit adds it to the Workspace and
 * terminalizes the Run atomically. A crash between the two leaves a committed checkpoint, so
 * the next Run (new lease epoch) resumes without re-executing the completed step.
 *
 * P0B-08b adds transactional budget enforcement to that path: every step takes a durable
 * reservation **before** it can produce a side effect, and records its consumption after.
 *
 * P0B-08c adds cooperative cancellation checks at every step boundary (before reservation,
 * after reservation before execution starts, between steps, and on abort): a committed
 * `cancel_requested_at` stops subsequent steps without erasing already-committed side effects
 * or refunding already-started work.
 *
 * P0B-08d adds the persistent mock approval gate (`mock.approval`): the `produce` step runs
 * in a transient FakeSandbox (stopped and destroyed before returning), commits the pre-approval
 * Artifact, Checkpoint and `pending` Approval row, releases the Run lease and parks the Task
 * in `waiting_approval`. Once approved via HTTP, a new Run resumes from the committed
 * checkpoint and publishes the result without re-running or re-charging `produce`.
 *
 * Deliberately absent: real shell, real LLM, network sandbox, device distribution.
 */

/** Kinds this handler can durably execute. */
export const DURABLE_TASK_KINDS = [
  'mock.chat',
  'mock.compute',
  'mock.file',
  'mock.approval',
] as const;

export type DurableTaskKind = (typeof DURABLE_TASK_KINDS)[number];

/** Default approval TTL when not overridden on the handler (5 minutes). */
export const DEFAULT_APPROVAL_TTL_MS = 300_000;

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
  /**
   * Mandatory when kind is `mock.approval`. If absent at runtime when executing or resuming
   * `mock.approval`, the run handler immediately fails closed with `POLICY_DENIED`.
   */
  readonly approvals?: Pick<PostgresApprovalRepository, 'listForGrant'>;
  readonly approvalTtlMs?: number;
  /**
   * Durable budget authority (B08b-D1). It is required, not optional: a Worker that could
   * silently skip the reservation would make the whole limit advisory.
   */
  readonly budget: BudgetLedger;
  readonly clock: ExecutionClock;
  readonly logger: WorkerLogger;
}

interface ProducedBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly workspacePath: string;
  readonly actionDigest?: string;
  readonly sandboxId?: string | null;
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
    // Worker ownership comes from the persisted Run, not from a caller-chosen label.
    workerId: context.workerId,
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
    case 'mock.approval': {
      const input = context.input as {
        readonly action: string;
        readonly reason: string;
      };
      const actionDigest = produced.text ?? computeApprovalActionDigest(input);

      return {
        bytes: Buffer.from(`${actionDigest}\n`, 'utf8'),
        mediaType: 'text/plain',
        workspacePath: `approval/${context.taskId}.sha256`,
        actionDigest,
      };
    }
    default:
      throw new DomainError('POLICY_DENIED', 'task kind has no durable executor branch');
  }
}

/** `mock.file` needs no simulated provider; chat/compute/approval run through the executor. */
async function executeStep(
  context: RunExecutionContext,
  route: RouteDecision,
  executor: SimulatedExecutor,
  signal: AbortSignal,
): Promise<ProducedBytes> {
  if (signal.aborted) {
    throw new DomainError('CANCELLED', 'step execution was aborted before start');
  }

  if (context.kind === 'mock.file') {
    return produceBytes(context, route, {});
  }

  if (context.kind === 'mock.approval') {
    if (executor.executeApproval === undefined) {
      throw new DomainError(
        'POLICY_DENIED',
        'mock.approval requires an executor with executeApproval',
      );
    }

    const result = await executor.executeApproval(context, route, signal);
    const output = result.output as { readonly actionDigest?: string };
    const bytes = produceBytes(
      context,
      route,
      typeof output.actionDigest === 'string' ? { text: output.actionDigest } : {},
    );
    return { ...bytes, sandboxId: result.sandboxId };
  }

  const result = await executor.execute(context, route, signal);
  const output = result.output as { readonly text?: string; readonly sha256?: string };

  if (context.kind === 'mock.compute' && typeof output.sha256 === 'string') {
    return {
      ...produceBytes(context, route, { text: output.sha256 }),
      sandboxId: result.sandboxId,
    };
  }

  return {
    ...produceBytes(context, route, typeof output.text === 'string' ? { text: output.text } : {}),
    sandboxId: result.sandboxId,
  };
}

/**
 * Run one durable step under a transactional budget reservation (B08b-D2 / B08c).
 *
 * The order is the whole point:
 *
 * ```text
 * reserve (may deny, writes nothing on denial)
 *   → pre-execute cancellation check (releases reservation with 0 consumed if cancelled)
 *   → execute
 *   → settle(replayed ? release)
 * ```
 *
 * so a refusal happens before the simulated model/sandbox call, before bytes are staged and
 * before anything is published. A cancellation detected after reservation but before `execute`
 * starts releases the reservation without charge; once `execute` has started, any abort or
 * failure settles the full reservation rather than refunding work that already ran.
 */
async function runBudgetedStep<T>(input: {
  readonly budget: BudgetLedger;
  readonly grant: RunGrant;
  readonly logger: WorkerLogger;
  readonly log: Readonly<Record<string, unknown>>;
  readonly operationId: string;
  readonly cost: BudgetReservationAmount;
  readonly signal?: AbortSignal;
  readonly assertLive?: () => Promise<void>;
  /** `true` when the step turned out to be a pure replay, so nothing was actually produced. */
  readonly wasReplay?: (value: T) => boolean;
  readonly execute: () => Promise<T>;
}): Promise<T> {
  const { budget, grant, operationId, cost } = input;

  const isAborted = (): boolean => input.signal?.aborted === true;

  if (isAborted()) {
    await input.assertLive?.();
    throw new DomainError('CANCELLED', 'task cancellation was requested before the step started');
  }

  // A denial throws `BUDGET_EXCEEDED` here, before any side effect exists to compensate.
  await budget.reserve(grant, { operationId, cost });

  try {
    if (isAborted()) {
      await input.assertLive?.();
      throw new DomainError('CANCELLED', 'task cancellation was requested before the step started');
    }
    await input.assertLive?.();
  } catch (preExecuteError) {
    // Nothing started, so nothing is charged: hand the held quota back and stop the Run.
    await closeReservation(input, 'release', () => budget.release(grant, { operationId }));
    throw preExecuteError;
  }

  let value: T;

  try {
    value = await input.execute();
  } catch (error) {
    // The step may already have had an effect, so the reservation is charged in full rather
    // than refunded: a failure or mid-step cancellation is not a way to get quota back.
    await closeReservation(input, 'settle', () =>
      budget.settle(grant, { operationId, consumed: cost }),
    );
    throw error;
  }

  if (input.wasReplay?.(value) === true) {
    // An already committed operation replayed, so nothing new happened: return the quota.
    await closeReservation(input, 'release', () => budget.release(grant, { operationId }));
    return value;
  }

  await closeReservation(input, 'settle', () =>
    budget.settle(grant, { operationId, consumed: cost }),
  );

  return value;
}

/** Best-effort settlement/release that can never replace the step's own outcome. */
async function closeReservation(
  input: { readonly logger: WorkerLogger; readonly log: Readonly<Record<string, unknown>> },
  operation: 'settle' | 'release',
  close: () => Promise<unknown>,
): Promise<void> {
  try {
    await close();
  } catch (error) {
    input.logger.warn('budget bookkeeping failed', {
      ...input.log,
      operation,
      code: codeOf(error),
      diagnostic: isDomainError(error) ? error.diagnostic : 'unexpected',
    });
  }
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

      const assertStepLive = async (): Promise<void> => {
        if (signal.aborted) {
          await contextReader.read(run, clock.now());
          throw new DomainError('CANCELLED', 'task execution was aborted');
        }
        await contextReader.read(run, clock.now());
      };

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
        if (context.kind === 'mock.approval' && deps.approvals === undefined) {
          throw new DomainError('POLICY_DENIED', 'mock.approval requires an approval repository');
        }

        // Recovery input is read-only. "No checkpoint" and "a checkpoint this build cannot
        // read" are different states: the second must stop the Run, never silently re-execute
        // work that may already have had side effects.
        const committed = await checkpoints.list(grant);
        const readable = (entry: (typeof committed)[number]): boolean =>
          entry.schemaVersion === CHECKPOINT_SCHEMA_VERSION &&
          entry.executorVersion === CHECKPOINT_EXECUTOR_VERSION;
        const compatible = committed.filter(readable);

        // A step this build cannot read must stop the Run even when another committed step is
        // readable: the unreadable one may already have had side effects, and treating "not in
        // the compatible list" as "not done" would re-execute it.
        if (committed.some((entry) => entry.stepId === PRODUCE_STEP && !readable(entry))) {
          throw new DomainError(
            'POLICY_DENIED',
            'the committed step is incompatible with this executor build',
          );
        }

        if (committed.length > 0 && compatible.length === 0) {
          throw new DomainError(
            'POLICY_DENIED',
            'a committed checkpoint is incompatible with this executor build',
          );
        }

        const produced = compatible.find((entry) => entry.stepId === PRODUCE_STEP);
        const resumeArtifact = produced?.artifacts[0];

        if (produced !== undefined && produced.inputDigest !== inputDigest) {
          // The step was committed for different deterministic input: re-running it would
          // duplicate a side effect, so the safe answer is to stop.
          throw new DomainError(
            'POLICY_DENIED',
            'the committed step belongs to a different execution input',
          );
        }

        const reuse = produced !== undefined && resumeArtifact !== undefined;

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

          if (context.kind === 'mock.approval') {
            if (deps.approvals === undefined) {
              throw new DomainError(
                'POLICY_DENIED',
                'mock.approval requires an approval repository',
              );
            }

            const input = context.input as { readonly action: string; readonly reason: string };
            const actionDigest =
              typeof produced.cursor['actionDigest'] === 'string'
                ? produced.cursor['actionDigest']
                : computeApprovalActionDigest(input);

            const approvals = await deps.approvals.listForGrant(grant);
            const approval = approvals.find((entry) => entry.actionDigest === actionDigest);

            if (approval === undefined) {
              if (approvals.length > 0) {
                throw new DomainError(
                  'POLICY_DENIED',
                  'checkpoint action digest does not match any approval record',
                );
              }

              const approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
              const expiresAt = new Date(clock.now().getTime() + approvalTtlMs).toISOString();
              const pauseReceipt = await committer.commitStep(grant, {
                operationId: `step:await_approval:${inputDigest.slice(0, 16)}`,
                mode: 'progress',
                approval: {
                  actionDigest,
                  expiresAt,
                  eventPayload: {
                    taskKind: 'mock.approval',
                    route: route.path,
                    policyVersion: context.policyVersion,
                    simulated: true,
                  },
                },
              });
              logger.info('durable execution waiting for approval', {
                ...base,
                taskKind: context.kind,
                route: route.path,
              });
              return { type: 'committed', receipt: pauseReceipt };
            }

            if (approval.status !== 'approved') {
              throw new DomainError(
                'POLICY_DENIED',
                `mock.approval cannot resume while approval status is ${approval.status}`,
              );
            }
          }

          await assertStepLive();

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
            signal,
            assertStepLive,
          );
        }

        const approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;

        const budgetedProduce = await runBudgetedStep({
          budget: deps.budget,
          grant,
          logger,
          log: { ...base, stepId: PRODUCE_STEP },
          operationId: stepOperationId(PRODUCE_STEP, inputDigest, grant.leaseEpoch),
          cost: stepCost(PRODUCE_STEP),
          signal,
          assertLive: assertStepLive,
          // Execute, stage and commit inside the reservation: the charge covers the whole
          // step, so nothing is published unless the quota was taken first.
          execute: async () => {
            const producedBytes = await executeStep(context, route, executor, signal);
            if (signal.aborted) {
              throw new DomainError(
                'CANCELLED',
                'step execution was aborted before staging artifact bytes',
              );
            }
            const staged = await blobs.stage(
              context.tenantId,
              producedBytes.bytes,
              producedBytes.mediaType,
            );
            if (signal.aborted) {
              throw new DomainError(
                'CANCELLED',
                'step execution was aborted before committing step progress',
              );
            }

            const approvalRequest =
              context.kind === 'mock.approval'
                ? {
                    actionDigest:
                      producedBytes.actionDigest ??
                      computeApprovalActionDigest(
                        context.input as { readonly action: string; readonly reason: string },
                      ),
                    expiresAt: new Date(clock.now().getTime() + approvalTtlMs).toISOString(),
                    eventPayload: {
                      taskKind: 'mock.approval' as const,
                      route: route.path,
                      policyVersion: context.policyVersion,
                      ...(producedBytes.sandboxId === null || producedBytes.sandboxId === undefined
                        ? {}
                        : { sandboxId: producedBytes.sandboxId }),
                      simulated: true,
                    },
                  }
                : undefined;

            const producedReceipt = await committer.commitStep(grant, {
              operationId: `step:${PRODUCE_STEP}:${inputDigest.slice(0, 16)}`,
              mode: 'progress',
              artifacts: [{ artifactId: staged.stagedId, staged }],
              checkpoint: {
                stepId: PRODUCE_STEP,
                inputDigest,
                executorVersion: CHECKPOINT_EXECUTOR_VERSION,
                ...(approvalRequest === undefined
                  ? {}
                  : { cursor: { actionDigest: approvalRequest.actionDigest } }),
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
              ...(approvalRequest === undefined ? {} : { approval: approvalRequest }),
            });

            return { producedBytes, staged, producedReceipt };
          },
        });

        if (context.kind === 'mock.approval') {
          logger.info('durable execution waiting for approval', {
            ...base,
            taskKind: context.kind,
            route: route.path,
            durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
            simulated: true,
            durable: true,
          });
          return { type: 'committed', receipt: budgetedProduce.producedReceipt };
        }

        // Safe step boundary between `produce` and `publish`: if cancellation was requested
        // while `produce` was running or committing, stop here without starting `publish` and
        // without deleting the already-committed `produce` Artifact or Checkpoint.
        await assertStepLive();

        return await publishResult(
          deps,
          context,
          grant,
          inputDigest,
          {
            artifactId:
              budgetedProduce.producedReceipt.artifactIds[0] ?? budgetedProduce.staged.stagedId,
            sha256: budgetedProduce.staged.sha256,
            size: budgetedProduce.staged.size,
            mediaType: budgetedProduce.staged.mediaType,
          },
          budgetedProduce.producedBytes.workspacePath,
          route,
          startedAtHr,
          signal,
          assertStepLive,
        );
      } catch (error) {
        let effectiveError: unknown = error;

        if (signal.aborted && isDomainError(error) && error.code === 'CANCELLED') {
          try {
            await contextReader.read(run, clock.now());
          } catch (readError) {
            effectiveError = readError;
          }
        }

        if (
          isDomainError(effectiveError) &&
          (effectiveError.code === 'STALE_LEASE' || effectiveError.code === 'NOT_FOUND')
        ) {
          // Ownership moved on: the loop must not call finish() either.
          throw effectiveError;
        }

        const outcome = classifyFailure(effectiveError);
        logger.warn('durable execution failed', {
          ...base,
          taskKind: context.kind,
          code: codeOf(effectiveError),
          outcome,
          diagnostic: isDomainError(effectiveError) ? effectiveError.diagnostic : 'unexpected',
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
  signal: AbortSignal,
  assertStepLive: () => Promise<void>,
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

  const receipt = await runBudgetedStep({
    budget: deps.budget,
    grant,
    logger,
    log: { taskId: grant.taskId, runId: grant.runId, attempt: grant.attempt, stepId: PUBLISH_STEP },
    operationId: stepOperationId(PUBLISH_STEP, inputDigest, grant.leaseEpoch),
    cost: stepCost(PUBLISH_STEP),
    signal,
    assertLive: assertStepLive,
    // A replayed terminal commit wrote nothing, so it must not be charged: the earlier
    // attempt already produced (and paid for) that result.
    wasReplay: (value) => value.replayed,
    execute: () =>
      committer.commitStep(grant, {
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
      }),
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
