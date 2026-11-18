import {
  PYTHON_AGENT_LIMITS,
  isSafeArtifactFilename,
  type BlobStore,
  type LeaseQueue,
  type SandboxExecResult,
  type SandboxSpec,
} from '@ember/contracts';
import { isDomainError, type Id, type LeasedRun } from '@ember/domain';
import {
  MODEL_LIMITS,
  ModelInputRefused,
  estimateCostMicroUsd,
  isModelGatewayFailure,
  isRetryableModelFailure,
  preflightPythonAgentStep,
  type ModelFailureCode,
  type ModelGateway,
  type ModelGatewayFailureDiagnostic,
  type ModelRateRow,
  type ModelUsage,
  type PythonAgentInputFile,
  type PythonAgentStepMessage,
  type PythonAgentStepOutput,
} from '@ember/model-gateway';
import {
  type PostgresPythonAgentExecutionRepository,
  type PythonAgentLoadContextResult,
  type PythonStepStagedOutput,
  type RetryPolicyConfig,
} from '@ember/postgres/b3-worker';
import type { WorkerLogger } from '../logger.js';

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_READY_DEADLINE_MS = 90_000;
const DEFAULT_SANDBOX_LIFETIME_SEC = 120;
const TOOL_OUTPUT_MAX_CHARS = 2_048;

const PYTHON_RUNNER_BOOTSTRAP = [
  'import os, runpy',
  "os.makedirs('/home/daytona/ember/inputs', exist_ok=True)",
  "os.makedirs('/home/daytona/ember/outputs', exist_ok=True)",
  "os.chdir('/home/daytona/ember')",
  "runpy.run_path('/home/daytona/ember/main.py', run_name='__main__')",
].join('; ');

export interface PythonAgentDirectoryEntry {
  readonly name: string;
  readonly isDir: boolean;
  readonly isSymlink: boolean;
  readonly sizeBytes: number;
}

/** Narrow sandbox provider port satisfied by `DaytonaSandboxProvider` and fake test doubles. */
export interface PythonAgentSandboxPort {
  create(spec: SandboxSpec): Promise<{ readonly sandboxId: Id }>;
  waitReady(sandboxId: Id, deadlineMs: number): Promise<void>;
  exec(sandboxId: Id, argv: readonly string[], timeoutMs: number): Promise<SandboxExecResult>;
  readOutput(
    sandboxId: Id,
    ref: Id,
    stream: 'stdout' | 'stderr',
    maxBytes: number,
  ): Promise<string>;
  putBytesFile(sandboxId: Id, relativePath: string, bytes: Uint8Array): Promise<void>;
  getBytesFile(sandboxId: Id, relativePath: string): Promise<Uint8Array>;
  putTextFile(sandboxId: Id, relativePath: string, text: string): Promise<void>;
  listDirectory(sandboxId: Id, relativeDir: string): Promise<readonly PythonAgentDirectoryEntry[]>;
  destroy(sandboxId: Id): Promise<void>;
}

export interface PythonAgentSandboxHandle {
  readonly provider: PythonAgentSandboxPort;
  readonly close?: () => Promise<void>;
}

export type PythonAgentSandboxFactory = (options: {
  readonly tenantId: Id;
  readonly runId: Id;
  readonly owner: string;
  readonly signal: AbortSignal;
}) => PythonAgentSandboxHandle | Promise<PythonAgentSandboxHandle>;

export interface PythonAgentExecutorDependencies {
  readonly mode: 'fake' | 'real';
  readonly leaseQueue: Pick<LeaseQueue, 'heartbeat'>;
  readonly repository: PostgresPythonAgentExecutionRepository;
  readonly blobStore: BlobStore;
  readonly gateway: ModelGateway;
  readonly createSandbox: PythonAgentSandboxFactory;
  readonly sandboxOwner: string;
  readonly policy: RetryPolicyConfig;
  readonly ceilings: {
    readonly perAttemptMicroUsd: number;
    readonly principalDailyMicroUsd: number;
    readonly tenantDailyMicroUsd: number;
    readonly globalDailyMicroUsd: number;
  };
  readonly rate: ModelRateRow | null;
  readonly leaseDurationMs: number;
  readonly attemptTimeoutMs: number;
  readonly execTimeoutMs?: number;
  readonly sandboxLifetimeSec?: number;
  readonly readyDeadlineMs?: number;
  readonly sandboxSnapshot?: string;
  readonly logger: Pick<WorkerLogger, 'info' | 'warn'>;
  readonly now?: () => Date;
}

export type PythonAgentRunOutcome =
  | {
      readonly outcome: 'succeeded';
      readonly sandboxCreated: boolean;
      readonly pythonExecs: number;
      readonly llmCalls: number;
      readonly publishedArtifactIds: readonly Id[];
    }
  | { readonly outcome: 'failed_retryable'; readonly reason: string }
  | { readonly outcome: 'failed_terminal'; readonly reason: string }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'deadline_exceeded' }
  | { readonly outcome: 'lease_lost' };

type StepGatewayResult =
  | {
      readonly kind: 'success';
      readonly output: PythonAgentStepOutput;
      readonly modelLabel: string;
      readonly simulated: boolean;
      readonly usage: ModelUsage | null;
    }
  | {
      readonly kind: 'failure';
      readonly code: ModelFailureCode;
      readonly diagnostic: ModelGatewayFailureDiagnostic | null;
    };

function clampText(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const suffix = '…';
  const keep = Math.max(1, maxChars - suffix.length);
  return {
    text: `${text.slice(0, keep).trimEnd()}${suffix}`,
    truncated: true,
  };
}

function detectOutputMediaType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) {
    return 'application/pdf';
  }
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.gif')) {
    return 'image/gif';
  }
  if (lower.endsWith('.csv')) {
    return 'text/csv';
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return 'text/markdown';
  }
  if (lower.endsWith('.json')) {
    return 'application/json';
  }
  if (lower.endsWith('.xml')) {
    return 'application/xml';
  }
  if (lower.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (lower.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (lower.endsWith('.pptx')) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  if (lower.endsWith('.zip')) {
    return 'application/zip';
  }
  if (lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.py')) {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

function computeReservationMicroUsd(
  deps: Pick<PythonAgentExecutorDependencies, 'mode' | 'rate' | 'ceilings'>,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  const capMicroUsd = Math.min(
    deps.ceilings.perAttemptMicroUsd,
    MODEL_LIMITS.maxReservedMicroUsdPerAttempt,
  );
  if (deps.mode === 'fake' || deps.rate === null) {
    return Math.min(1_000, capMicroUsd);
  }
  const worstCaseMicroUsd = estimateCostMicroUsd(deps.rate, inputTokens, maxOutputTokens);
  const reservation = Math.max(worstCaseMicroUsd, 1);
  if (reservation > capMicroUsd) {
    throw new ModelInputRefused('reservation_cap_exceeded');
  }
  return reservation;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function callStepGateway(
  deps: Pick<PythonAgentExecutorDependencies, 'gateway' | 'attemptTimeoutMs'>,
  input: Parameters<ModelGateway['stepPythonAgent']>[0],
  deadlineAtMs: number | null,
  nowMs: number,
  signal: AbortSignal,
): Promise<StepGatewayResult> {
  const remainingDeadlineMs =
    deadlineAtMs === null ? MODEL_LIMITS.attemptTimeoutMs : Math.max(1, deadlineAtMs - nowMs);
  const timeoutMs = Math.min(
    deps.attemptTimeoutMs,
    MODEL_LIMITS.attemptTimeoutMs,
    remainingDeadlineMs,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const result = await deps.gateway.stepPythonAgent(input, controller.signal);
    return {
      kind: 'success',
      output: result.output,
      modelLabel: result.modelLabel,
      simulated: result.simulated,
      usage: result.usage,
    };
  } catch (error) {
    if (isModelGatewayFailure(error)) {
      return { kind: 'failure', code: error.code, diagnostic: error.diagnostic };
    }
    return { kind: 'failure', code: 'model_invalid_output', diagnostic: null };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Execute one leased `python.agent` Run inside a bounded Daytona sandbox loop.
 *
 * Guarantees:
 * - Lazy sandbox creation: 0 sandboxes created if the LLM answers without calling `run_python_script`.
 * - Bounded Run and cumulative Task caps (LLM calls, Python execs, sandboxes, micro-USD).
 * - Continuous Lease Heartbeat (`leaseMs / 3`) during long LLM & Daytona waits.
 * - Checkpoint resume across worker crashes / retries (including staged output files).
 * - Guaranteed `provider.destroy()` + `sandboxHandle.close()` inside `finally`.
 */
export async function executePythonAgentRun(
  run: LeasedRun,
  deps: PythonAgentExecutorDependencies,
  parentSignal?: AbortSignal,
): Promise<PythonAgentRunOutcome> {
  if (deps.mode === 'real' && deps.rate === null) {
    throw new TypeError('real mode requires a pinned rate row');
  }
  if (deps.mode === 'real' && deps.gateway.providerId === 'fake') {
    throw new TypeError('real mode requires a real provider gateway');
  }

  const startedAtHr = performance.now();
  const nowFn = deps.now ?? (() => new Date());
  const execTimeoutMs = Math.min(
    deps.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    DEFAULT_EXEC_TIMEOUT_MS,
  );
  const sandboxLifetimeSec = Math.min(
    deps.sandboxLifetimeSec ?? DEFAULT_SANDBOX_LIFETIME_SEC,
    DEFAULT_SANDBOX_LIFETIME_SEC,
  );
  const readyDeadlineMs = deps.readyDeadlineMs ?? DEFAULT_READY_DEADLINE_MS;
  const sandboxSnapshot = deps.sandboxSnapshot ?? 'daytona-small';

  const runAbort = new AbortController();
  let abortReason: 'lease_lost' | 'deadline_exceeded' | 'parent_shutdown' | null = null;
  let heartbeatInFlight: Promise<void> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  const onParentAbort = (): void => {
    if (abortReason === null) {
      abortReason = 'parent_shutdown';
    }
    runAbort.abort();
  };
  if (parentSignal?.aborted === true) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }

  const heartbeatIntervalMs = Math.max(50, Math.floor(deps.leaseDurationMs / 3));
  const triggerHeartbeat = (): void => {
    if (runAbort.signal.aborted || heartbeatInFlight !== null) {
      return;
    }
    heartbeatInFlight = (async () => {
      try {
        const alive = await deps.leaseQueue.heartbeat(run, nowFn());
        if (!alive && !runAbort.signal.aborted) {
          abortReason = 'lease_lost';
          runAbort.abort();
        }
      } catch {
        // Keep trying on next heartbeat tick; DB pool/lease expiry remains authoritative.
      } finally {
        heartbeatInFlight = null;
      }
    })();
  };
  heartbeatTimer = setInterval(triggerHeartbeat, heartbeatIntervalMs);

  const stopTimers = async (): Promise<void> => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    parentSignal?.removeEventListener('abort', onParentAbort);
    if (heartbeatInFlight !== null) {
      await heartbeatInFlight.catch(() => undefined);
    }
  };

  let sandboxHandle: PythonAgentSandboxHandle | null = null;
  let sandboxId: Id | null = null;
  let sandboxCreated = false;
  let runPythonExecsInThisRun = 0;
  let runLlmCallsInThisRun = 0;

  const elapsedMs = (): number => Math.max(0, Math.round(performance.now() - startedAtHr));

  const failRun = async (
    outcome: 'failed_retryable' | 'failed_terminal' | 'cancelled',
    errorCode?: Parameters<PostgresPythonAgentExecutionRepository['commitFailure']>[0]['errorCode'],
    reason?: string,
  ): Promise<PythonAgentRunOutcome> => {
    const committed = await deps.repository.commitFailure({
      lease: run,
      policy: deps.policy,
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
      durationMs: elapsedMs(),
      simulated: deps.mode === 'fake',
    });
    if (committed.outcome === 'stale_lease') {
      return { outcome: 'lease_lost' };
    }
    if (outcome === 'cancelled' || committed.taskStatus === 'cancelled') {
      return { outcome: 'cancelled' };
    }
    if (committed.taskStatus === 'retryable_failed') {
      return { outcome: 'failed_retryable', reason: reason ?? 'retryable_failure' };
    }
    return { outcome: 'failed_terminal', reason: reason ?? errorCode ?? 'terminal_failure' };
  };

  try {
    let loaded: PythonAgentLoadContextResult | null = await deps.repository.loadAgentContext(run);
    if (loaded.kind === 'lease_lost') {
      return { outcome: 'lease_lost' };
    }
    if (loaded.kind === 'cancelled') {
      return await failRun('cancelled', 'CANCELLED', 'cancelled');
    }
    if (loaded.kind === 'deadline_exceeded') {
      return await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded');
    }
    if (loaded.kind === 'file_budget_exceeded') {
      return await failRun('failed_terminal', 'POLICY_DENIED', 'task_file_budget_exceeded');
    }

    let loadedContext:
      Extract<PythonAgentLoadContextResult, { readonly kind: 'ready' }>['context'] | null =
      loaded.context;
    loaded = null;
    const context = {
      tenantId: loadedContext.tenantId,
      taskId: loadedContext.taskId,
      runId: loadedContext.runId,
      deadlineAt: loadedContext.deadlineAt,
      input: loadedContext.input,
      checkpoints: loadedContext.checkpoints,
      usage: loadedContext.usage,
    };
    const inputTotalBytes = loadedContext.inputFiles.reduce((sum, file) => sum + file.size, 0);
    let pendingHydration: {
      readonly inputFiles: typeof loadedContext.inputFiles;
      readonly latestStagedOutputs: typeof loadedContext.latestStagedOutputs;
    } | null = {
      inputFiles: loadedContext.inputFiles,
      latestStagedOutputs: loadedContext.latestStagedOutputs,
    };
    const deadlineAtMs = context.deadlineAt === null ? null : Date.parse(context.deadlineAt);
    if (deadlineAtMs !== null) {
      const remaining = deadlineAtMs - nowFn().getTime();
      if (remaining <= 0) {
        return await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded');
      }
      deadlineTimer = setTimeout(() => {
        if (abortReason === null) {
          abortReason = 'deadline_exceeded';
        }
        runAbort.abort();
      }, remaining);
    }

    let taskLlmUsed = context.usage.taskLlmCallsUsed;
    let runLlmUsed = context.usage.runLlmCallsUsed;
    let taskCostMicroUsd = context.usage.taskCostMicroUsd;
    let taskPythonExecsUsed = context.usage.taskPythonExecsUsed;
    let runPythonExecsUsed = context.usage.runPythonExecsUsed;

    if (
      taskLlmUsed >= PYTHON_AGENT_LIMITS.maxLlmCallsPerTask ||
      taskCostMicroUsd >= PYTHON_AGENT_LIMITS.maxTaskCostMicroUsd
    ) {
      return await failRun('failed_terminal', 'BUDGET_EXCEEDED', 'task_budget_exhausted');
    }

    const inputFiles: PythonAgentInputFile[] = loadedContext.inputFiles.map((file) =>
      Object.freeze({
        artifactId: file.artifactId,
        filename: file.filename,
        mediaType: file.mediaType,
        sizeBytes: file.size,
      }),
    );

    const messages: PythonAgentStepMessage[] = [];
    const stagedOutputsByName = new Map<string, PythonStepStagedOutput>();
    const restoredOutputsBySha = new Map<string, PythonStepStagedOutput>();

    for (const restored of loadedContext.latestStagedOutputs) {
      const meta: PythonStepStagedOutput = {
        stagedId: restored.stagedId,
        storageKey: restored.storageKey,
        sha256: restored.sha256,
        size: restored.size,
        mediaType: restored.mediaType,
        filename: restored.filename,
      };
      stagedOutputsByName.set(restored.filename, meta);
      restoredOutputsBySha.set(`${restored.filename}:${restored.sha256}`, meta);
    }
    loadedContext = null;

    for (const checkpoint of context.checkpoints) {
      messages.push({
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            id: checkpoint.toolCallId,
            name: 'run_python_script',
            argumentsJson: JSON.stringify({ code: checkpoint.code }),
          },
        ],
      });
      messages.push({
        role: 'tool',
        toolCallId: checkpoint.toolCallId,
        text: checkpoint.toolResultJson,
      });
    }

    let nextStepSequence = (context.checkpoints.at(-1)?.stepSequence ?? 0) + 1;
    const providerId: 'openai' | 'openrouter' =
      deps.gateway.providerId === 'openrouter' ? 'openrouter' : 'openai';

    const ensureSandbox = async (): Promise<
      | { readonly kind: 'ready'; readonly provider: PythonAgentSandboxPort; readonly id: Id }
      | { readonly kind: 'exit'; readonly result: PythonAgentRunOutcome }
    > => {
      if (sandboxHandle !== null && sandboxId !== null) {
        return { kind: 'ready', provider: sandboxHandle.provider, id: sandboxId };
      }

      const opId = `sandbox:${run.runId}:${context.usage.runSandboxCreatesUsed + 1}`;
      const reservedOp = await deps.repository.reserveAgentOperation({
        lease: run,
        opKind: 'sandbox',
        operationId: opId,
        maxDurationMs: sandboxLifetimeSec * 1_000,
      });

      if (reservedOp.kind === 'lease_lost') {
        return { kind: 'exit', result: { outcome: 'lease_lost' } };
      }
      if (reservedOp.kind === 'cancelled') {
        return { kind: 'exit', result: await failRun('cancelled', 'CANCELLED', 'cancelled') };
      }
      if (reservedOp.kind === 'deadline_exceeded') {
        return {
          kind: 'exit',
          result: await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded'),
        };
      }
      if (reservedOp.kind === 'limit_exceeded') {
        if (reservedOp.scope === 'task') {
          return {
            kind: 'exit',
            result: await failRun('failed_terminal', 'BUDGET_EXCEEDED', 'sandbox_task_limit'),
          };
        }
        return {
          kind: 'exit',
          result: await failRun('failed_retryable', 'BUDGET_EXCEEDED', 'sandbox_run_limit'),
        };
      }

      const createStartedHr = performance.now();
      let allocated = false;

      try {
        sandboxHandle = await deps.createSandbox({
          tenantId: context.tenantId,
          runId: run.runId,
          owner: deps.sandboxOwner,
          signal: runAbort.signal,
        });

        const created = await sandboxHandle.provider.create({
          tenantId: context.tenantId,
          runId: run.runId,
          imageDigest: sandboxSnapshot,
          cpuMilli: 1_000,
          memoryMiB: 1_024,
          maxLifetimeSec: sandboxLifetimeSec,
          networkPolicyId: 'deny-all',
        });

        sandboxId = created.sandboxId;
        sandboxCreated = true;
        allocated = true;

        await sandboxHandle.provider.waitReady(sandboxId, readyDeadlineMs);

        await deps.repository.settleAgentOperation({
          tenantId: context.tenantId,
          runId: run.runId,
          operationId: opId,
          elapsedMs: Math.max(0, Math.round(performance.now() - createStartedHr)),
          state: 'settled',
        });

        if (pendingHydration !== null) {
          for (const inputFile of pendingHydration.inputFiles) {
            await sandboxHandle.provider.putBytesFile(
              sandboxId,
              `inputs/${inputFile.filename}`,
              inputFile.bytes,
            );
          }

          for (const restored of pendingHydration.latestStagedOutputs) {
            await sandboxHandle.provider.putBytesFile(
              sandboxId,
              `outputs/${restored.filename}`,
              restored.bytes,
            );
          }

          // Release in-memory payload buffers once copied into the sandbox.
          pendingHydration = null;
        }

        return { kind: 'ready', provider: sandboxHandle.provider, id: sandboxId };
      } catch (error) {
        await deps.repository
          .settleAgentOperation({
            tenantId: context.tenantId,
            runId: run.runId,
            operationId: opId,
            elapsedMs: Math.max(0, Math.round(performance.now() - createStartedHr)),
            state: allocated ? 'settled' : 'released',
          })
          .catch(() => undefined);

        if (abortReason === 'lease_lost') {
          return { kind: 'exit', result: { outcome: 'lease_lost' } };
        }
        if (abortReason === 'deadline_exceeded') {
          return {
            kind: 'exit',
            result: await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded'),
          };
        }
        if (isDomainError(error) && error.code === 'CANCELLED') {
          return { kind: 'exit', result: await failRun('cancelled', 'CANCELLED', 'cancelled') };
        }
        if (isDomainError(error) && error.code === 'POLICY_DENIED') {
          return {
            kind: 'exit',
            result: await failRun('failed_terminal', 'POLICY_DENIED', 'sandbox_policy_denied'),
          };
        }

        return {
          kind: 'exit',
          result: await failRun(
            'failed_retryable',
            isDomainError(error) ? error.code : 'SANDBOX_NOT_READY',
            'sandbox_init_failed',
          ),
        };
      }
    };

    while (!runAbort.signal.aborted) {
      if (deadlineAtMs !== null && nowFn().getTime() >= deadlineAtMs) {
        return await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded');
      }

      const remainingTaskLlm = PYTHON_AGENT_LIMITS.maxLlmCallsPerTask - taskLlmUsed;
      const remainingRunLlm = PYTHON_AGENT_LIMITS.maxLlmCallsPerRun - runLlmUsed;
      if (remainingTaskLlm <= 0 || taskCostMicroUsd >= PYTHON_AGENT_LIMITS.maxTaskCostMicroUsd) {
        return await failRun('failed_terminal', 'BUDGET_EXCEEDED', 'task_llm_budget_exhausted');
      }
      if (remainingRunLlm <= 0) {
        return await failRun('failed_retryable', 'BUDGET_EXCEEDED', 'run_llm_limit_reached');
      }

      const remainingPyAllowed = Math.min(
        PYTHON_AGENT_LIMITS.maxPythonExecsPerRun - runPythonExecsUsed,
        PYTHON_AGENT_LIMITS.maxPythonExecsPerTask - taskPythonExecsUsed,
      );
      // Reserve the final available LLM turn for synthesis rather than allowing another tool call
      // whose output would never be summarized.
      const remainingPythonCalls =
        remainingRunLlm <= 1 || remainingTaskLlm <= 1 ? 0 : Math.max(0, remainingPyAllowed);

      const stepInput = {
        taskId: context.taskId,
        prompt: context.input.prompt,
        ...(context.input.instructions === undefined
          ? {}
          : { instructions: context.input.instructions }),
        inputFiles,
        messages,
        maxOutputTokens: MODEL_LIMITS.pythonAgentMaxOutputTokens,
        remainingPythonCalls,
      };

      const preflight = preflightPythonAgentStep(stepInput);
      const reservedMicroUsd = computeReservationMicroUsd(
        deps,
        preflight.inputTokens,
        preflight.maxOutputTokens,
      );

      const reservation = await deps.repository.reserveLlmAttempt({
        lease: run,
        ceilings: {
          perAttemptMicroUsd: deps.ceilings.perAttemptMicroUsd,
          principalDailyMicroUsd: deps.ceilings.principalDailyMicroUsd,
          tenantDailyMicroUsd: deps.ceilings.tenantDailyMicroUsd,
          globalDailyMicroUsd: deps.ceilings.globalDailyMicroUsd,
        },
        maxAttemptsPerTask: PYTHON_AGENT_LIMITS.maxLlmCallsPerTask,
        maxAttemptsPerRun: PYTHON_AGENT_LIMITS.maxLlmCallsPerRun,
        maxTaskCostMicroUsd: PYTHON_AGENT_LIMITS.maxTaskCostMicroUsd,
        reservedMicroUsd,
        rateVersion:
          deps.mode === 'fake' || deps.rate === null ? 'fake-zero-cost' : deps.rate.rateVersion,
        providerId,
        modelLabel: deps.gateway.modelLabel,
      });

      if (reservation.kind === 'lease_lost') {
        return { outcome: 'lease_lost' };
      }
      if (reservation.kind === 'principal_unavailable') {
        return await failRun('failed_terminal', 'POLICY_DENIED', 'principal_unavailable');
      }
      if (reservation.kind === 'cancelled') {
        return await failRun('cancelled', 'CANCELLED', 'cancelled');
      }
      if (reservation.kind === 'deadline_exceeded') {
        return await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded');
      }
      if (reservation.kind === 'budget_halted') {
        return await failRun(
          'failed_terminal',
          'BUDGET_EXCEEDED',
          `budget_halted:${reservation.reason}`,
        );
      }
      if (reservation.kind === 'budget_exceeded') {
        return await failRun(
          'failed_terminal',
          'BUDGET_EXCEEDED',
          `budget_exceeded:${reservation.scope}`,
        );
      }
      if (reservation.kind === 'task_budget_exhausted') {
        return await failRun('failed_terminal', 'BUDGET_EXCEEDED', reservation.reason);
      }
      if (reservation.kind === 'run_budget_exhausted') {
        return await failRun('failed_retryable', 'BUDGET_EXCEEDED', reservation.reason);
      }

      const attemptNo = reservation.attempt.attemptNo;
      const markedSent = await deps.repository.markLlmAttemptSent({ lease: run, attemptNo });
      if (!markedSent) {
        await deps.repository
          .settleLlmAttempt({
            tenantId: context.tenantId,
            taskId: context.taskId,
            attemptNo,
            state: 'released',
            outcomeCode: 'not_sent',
          })
          .catch(() => undefined);
        return { outcome: 'lease_lost' };
      }

      const gatewayResult = await callStepGateway(
        deps,
        stepInput,
        deadlineAtMs,
        nowFn().getTime(),
        runAbort.signal,
      );

      if (gatewayResult.kind === 'failure') {
        if (gatewayResult.code === 'not_sent') {
          await deps.repository.settleLlmAttempt({
            tenantId: context.tenantId,
            taskId: context.taskId,
            attemptNo,
            state: 'released',
            outcomeCode: 'not_sent',
          });
          return await failRun('failed_terminal', 'POLICY_DENIED', 'model_not_sent');
        }

        await deps.repository.settleLlmAttempt({
          tenantId: context.tenantId,
          taskId: context.taskId,
          attemptNo,
          state: 'unknown_billed',
          outcomeCode: abortReason ?? gatewayResult.code,
        });
        taskLlmUsed += 1;
        runLlmUsed += 1;
        runLlmCallsInThisRun += 1;
        taskCostMicroUsd += reservedMicroUsd;

        if (abortReason === 'lease_lost') {
          return { outcome: 'lease_lost' };
        }
        if (abortReason === 'deadline_exceeded') {
          return await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded');
        }
        if (abortReason === 'parent_shutdown') {
          return await failRun('failed_retryable', 'CANCELLED', 'worker_shutdown');
        }
        if (
          isRetryableModelFailure(gatewayResult.code) &&
          taskLlmUsed < PYTHON_AGENT_LIMITS.maxLlmCallsPerTask &&
          taskCostMicroUsd < PYTHON_AGENT_LIMITS.maxTaskCostMicroUsd
        ) {
          return await failRun('failed_retryable', 'EXECUTION_TIMEOUT', gatewayResult.code);
        }
        return await failRun('failed_terminal', 'EXECUTION_TIMEOUT', gatewayResult.code);
      }

      if (gatewayResult.usage === null) {
        await deps.repository.settleLlmAttempt({
          tenantId: context.tenantId,
          taskId: context.taskId,
          attemptNo,
          state: 'conservative_billed',
          outcomeCode: 'usage_missing',
        });
        taskCostMicroUsd += reservedMicroUsd;
      } else {
        await deps.repository.settleLlmAttempt({
          tenantId: context.tenantId,
          taskId: context.taskId,
          attemptNo,
          state: 'settled',
          outcomeCode: 'ok',
          observedCostMicroUsd: gatewayResult.usage.costMicroUsd,
          inputTokens: gatewayResult.usage.inputTokens,
          outputTokens: gatewayResult.usage.outputTokens,
        });
        taskCostMicroUsd += gatewayResult.usage.costMicroUsd;
      }

      taskLlmUsed += 1;
      runLlmUsed += 1;
      runLlmCallsInThisRun += 1;

      if (abortReason === 'lease_lost') {
        return { outcome: 'lease_lost' };
      }
      if (abortReason === 'deadline_exceeded') {
        return await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded');
      }

      const stepOutput = gatewayResult.output;

      if (stepOutput.kind === 'final') {
        const commit = await deps.repository.commitCompletion({
          lease: run,
          policy: deps.policy,
          durationMs: elapsedMs(),
          summaryText: stepOutput.summaryText,
          detailText: stepOutput.detailText,
          truncated: stepOutput.truncated,
          modelLabel: gatewayResult.modelLabel,
          simulated: gatewayResult.simulated,
          finalStagedOutputs: [...stagedOutputsByName.values()],
        });

        if (commit.outcome === 'cancelled') {
          return { outcome: 'cancelled' };
        }
        if (commit.outcome === 'deadline_exceeded') {
          return { outcome: 'deadline_exceeded' };
        }

        deps.logger.info('python agent task completed', {
          taskId: run.taskId,
          runId: run.runId,
          attempt: run.attempt,
          sandboxCreated,
          pythonExecs: runPythonExecsInThisRun,
          llmCalls: runLlmCallsInThisRun,
          artifactCount: commit.publishedArtifactIds.length,
          durationMs: elapsedMs(),
        });

        return {
          outcome: 'succeeded',
          sandboxCreated,
          pythonExecs: runPythonExecsInThisRun,
          llmCalls: runLlmCallsInThisRun,
          publishedArtifactIds: commit.publishedArtifactIds,
        };
      }

      // LLM requested `run_python_script`: reserve Python budget & lazily create sandbox.
      const pyOpId = `py:${run.runId}:${nextStepSequence}`;
      const pyReserved = await deps.repository.reserveAgentOperation({
        lease: run,
        opKind: 'py',
        operationId: pyOpId,
        maxDurationMs: execTimeoutMs,
      });

      if (pyReserved.kind === 'lease_lost') {
        return { outcome: 'lease_lost' };
      }
      if (pyReserved.kind === 'cancelled') {
        return await failRun('cancelled', 'CANCELLED', 'cancelled');
      }
      if (pyReserved.kind === 'deadline_exceeded') {
        return await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded');
      }
      if (pyReserved.kind === 'limit_exceeded') {
        if (pyReserved.scope === 'task') {
          return await failRun('failed_terminal', 'BUDGET_EXCEEDED', 'python_task_limit');
        }
        return await failRun('failed_retryable', 'BUDGET_EXCEEDED', 'python_run_limit');
      }

      const sandboxReady = await ensureSandbox();
      if (sandboxReady.kind === 'exit') {
        await deps.repository
          .settleAgentOperation({
            tenantId: context.tenantId,
            runId: run.runId,
            operationId: pyOpId,
            elapsedMs: 0,
            state: 'released',
          })
          .catch(() => undefined);
        return sandboxReady.result;
      }

      const execStartHr = performance.now();
      let exitCode: number | null = null;
      let timedOut = false;
      let stdout = '';
      let stderr = '';
      let execDurationMs = 0;

      try {
        await sandboxReady.provider.putTextFile(sandboxReady.id, 'main.py', stepOutput.code);
        const execResult = await sandboxReady.provider.exec(
          sandboxReady.id,
          ['python3', '-c', PYTHON_RUNNER_BOOTSTRAP],
          execTimeoutMs,
        );
        exitCode = execResult.exitCode;
        timedOut = false;
        execDurationMs = Math.max(0, Math.round(performance.now() - execStartHr));
        stdout = await sandboxReady.provider.readOutput(
          sandboxReady.id,
          execResult.stdoutRef,
          'stdout',
          8_192,
        );
        stderr = await sandboxReady.provider.readOutput(
          sandboxReady.id,
          execResult.stderrRef,
          'stderr',
          8_192,
        );
      } catch (error) {
        execDurationMs = Math.max(0, Math.round(performance.now() - execStartHr));
        if (isDomainError(error) && error.code === 'EXECUTION_TIMEOUT') {
          timedOut = true;
          stderr = 'Python execution timed out.';
        } else {
          await deps.repository
            .settleAgentOperation({
              tenantId: context.tenantId,
              runId: run.runId,
              operationId: pyOpId,
              elapsedMs: execDurationMs,
              state: 'settled',
            })
            .catch(() => undefined);
          if (abortReason === 'lease_lost') {
            return { outcome: 'lease_lost' };
          }
          if (abortReason === 'deadline_exceeded') {
            return await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded');
          }
          if (isDomainError(error) && error.code === 'CANCELLED') {
            return await failRun('cancelled', 'CANCELLED', 'cancelled');
          }
          return await failRun(
            'failed_retryable',
            isDomainError(error) ? error.code : 'EXECUTION_TIMEOUT',
            'python_exec_transport_error',
          );
        }
      }

      await deps.repository.settleAgentOperation({
        tenantId: context.tenantId,
        runId: run.runId,
        operationId: pyOpId,
        elapsedMs: execDurationMs,
        state: 'settled',
      });
      taskPythonExecsUsed += 1;
      runPythonExecsUsed += 1;
      runPythonExecsInThisRun += 1;

      const stepStagedOutputs: PythonStepStagedOutput[] = [];
      if (exitCode === 0 && !timedOut) {
        const entries = await sandboxReady.provider.listDirectory(sandboxReady.id, 'outputs');
        if (entries.length > PYTHON_AGENT_LIMITS.maxOutputArtifactsPerTask) {
          return await failRun('failed_terminal', 'POLICY_DENIED', 'too_many_output_artifacts');
        }

        let plannedOutputBytes = 0;
        for (const entry of entries) {
          if (entry.isSymlink) {
            return await failRun('failed_terminal', 'POLICY_DENIED', 'symlink_output_forbidden');
          }
          if (entry.isDir) {
            return await failRun('failed_terminal', 'POLICY_DENIED', 'directory_output_forbidden');
          }
          if (!isSafeArtifactFilename(entry.name)) {
            return await failRun('failed_terminal', 'POLICY_DENIED', 'invalid_output_filename');
          }
          if (entry.sizeBytes > PYTHON_AGENT_LIMITS.maxFileBytes) {
            return await failRun('failed_terminal', 'POLICY_DENIED', 'output_artifact_too_large');
          }
          plannedOutputBytes += entry.sizeBytes;
        }
        if (inputTotalBytes + plannedOutputBytes > PYTHON_AGENT_LIMITS.maxTaskTotalFileBytes) {
          return await failRun('failed_terminal', 'POLICY_DENIED', 'task_file_budget_exceeded');
        }

        let actualOutputBytes = 0;
        for (const entry of entries) {
          const rawBytes = await sandboxReady.provider.getBytesFile(
            sandboxReady.id,
            `outputs/${entry.name}`,
          );
          if (rawBytes.byteLength > PYTHON_AGENT_LIMITS.maxFileBytes) {
            return await failRun('failed_terminal', 'POLICY_DENIED', 'output_artifact_too_large');
          }
          actualOutputBytes += rawBytes.byteLength;
          if (inputTotalBytes + actualOutputBytes > PYTHON_AGENT_LIMITS.maxTaskTotalFileBytes) {
            return await failRun('failed_terminal', 'POLICY_DENIED', 'task_file_budget_exceeded');
          }

          const sha256 = await sha256HexBytes(rawBytes);
          const restoredMatch = restoredOutputsBySha.get(`${entry.name}:${sha256}`);
          let stagedMeta: PythonStepStagedOutput;
          if (restoredMatch !== undefined && restoredMatch.size === rawBytes.byteLength) {
            stagedMeta = restoredMatch;
          } else {
            const mediaType = detectOutputMediaType(entry.name);
            const stagedRef = await deps.blobStore.stage(context.tenantId, rawBytes, mediaType, {
              maxBytes: PYTHON_AGENT_LIMITS.maxFileBytes,
            });
            stagedMeta = {
              stagedId: stagedRef.stagedId,
              storageKey: stagedRef.storageKey,
              sha256: stagedRef.sha256,
              size: stagedRef.size,
              mediaType: stagedRef.mediaType,
              filename: entry.name,
            };
          }

          stepStagedOutputs.push(stagedMeta);
          stagedOutputsByName.set(entry.name, stagedMeta);
        }
      }

      const stdoutPreview = clampText(stdout, PYTHON_AGENT_LIMITS.maxStepOutputPreviewChars).text;
      const stderrPreview = clampText(stderr, PYTHON_AGENT_LIMITS.maxStepOutputPreviewChars).text;
      const toolResultJson = JSON.stringify({
        exit_code: exitCode,
        timed_out: timedOut,
        duration_ms: execDurationMs,
        stdout: clampText(stdout, TOOL_OUTPUT_MAX_CHARS).text,
        stderr: clampText(stderr, TOOL_OUTPUT_MAX_CHARS).text,
        output_files: stepStagedOutputs.map((output) => ({
          filename: output.filename,
          size_bytes: output.size,
          media_type: output.mediaType,
        })),
      });

      const stepCommitted = await deps.repository.commitStepCheckpoint({
        lease: run,
        stepSequence: nextStepSequence,
        toolCallId: stepOutput.toolCallId,
        code: stepOutput.code,
        exitCode,
        timedOut,
        durationMs: execDurationMs,
        stdoutPreview,
        stderrPreview,
        toolResultJson,
        stagedOutputs: stepStagedOutputs,
      });

      if (stepCommitted.outcome === 'cancelled') {
        return await failRun('cancelled', 'CANCELLED', 'cancelled');
      }
      if (stepCommitted.outcome === 'deadline_exceeded') {
        return await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded');
      }

      messages.push({
        role: 'assistant',
        text: stepOutput.assistantText ?? '',
        toolCalls: [
          {
            id: stepOutput.toolCallId,
            name: 'run_python_script',
            argumentsJson: JSON.stringify({ code: stepOutput.code }),
          },
        ],
      });
      messages.push({
        role: 'tool',
        toolCallId: stepOutput.toolCallId,
        text: toolResultJson,
      });
      nextStepSequence += 1;
    }

    if (abortReason === 'lease_lost') {
      return { outcome: 'lease_lost' };
    }
    if (abortReason === 'deadline_exceeded') {
      return await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded');
    }
    return await failRun('failed_retryable', 'CANCELLED', abortReason ?? 'aborted');
  } catch (error) {
    if (abortReason === 'lease_lost' || (isDomainError(error) && error.code === 'STALE_LEASE')) {
      return { outcome: 'lease_lost' };
    }
    if (error instanceof ModelInputRefused) {
      return await failRun('failed_terminal', 'INVALID_ARGUMENT', error.message);
    }
    if (isDomainError(error) && error.code === 'CANCELLED') {
      return await failRun('cancelled', 'CANCELLED', 'cancelled');
    }
    if (isDomainError(error) && error.code === 'DEADLINE_EXCEEDED') {
      return await failRun('failed_terminal', 'DEADLINE_EXCEEDED', 'deadline_exceeded');
    }

    return await failRun(
      'failed_retryable',
      isDomainError(error) ? error.code : 'DB_UNAVAILABLE',
      isDomainError(error) ? error.code : 'unexpected_error',
    );
  } finally {
    await stopTimers();
    if (sandboxHandle !== null) {
      const handle: PythonAgentSandboxHandle = sandboxHandle;
      if (sandboxId !== null) {
        try {
          await handle.provider.destroy(sandboxId);
        } catch (err) {
          deps.logger.warn('python agent sandbox destroy failed', {
            taskId: run.taskId,
            runId: run.runId,
            sandboxId,
            code: isDomainError(err) ? err.code : 'UNEXPECTED',
          });
        }
      }
      if (handle.close !== undefined) {
        await handle.close().catch(() => undefined);
      }
    }
  }
}
