import {
  B3StagedUploadMediaTypeSchema,
  PYTHON_AGENT_LIMITS,
  isSafeArtifactFilename,
  type SandboxExecResult,
  type SandboxSpec,
  type R2BucketPort,
} from '@ember/contracts';
import { isDomainError, type Id } from '@ember/domain';
import {
  FAKE_MODEL_LABEL,
  FAKE_V2_RATE_VERSION,
  MODEL_LIMITS,
  ModelAuthorizationRefused,
  ModelGatewayFailure,
  ModelInputRefused,
  estimateCostMicroUsd,
  isModelGatewayFailure,
  preflightPythonAgentStep,
  type ModelGateway,
  type ModelRateRow,
  type PythonAgentInputFile,
  type PythonAgentStepMessage,
} from '@ember/model-gateway';
import {
  V2_MAX_INLINE_ARTIFACT_BYTES,
  formatRecoveryAgentKey,
  runV2FakePythonSandbox,
  type DurableExecutorPort,
  type V2PublishTaskOutputsResultDto,
  type V2TaskInputFileDto,
} from '@ember/runtime-v2';
import {
  DAYTONA_SANDBOX_LIMITS,
  DaytonaSandboxProvider,
  DaytonaSdkSandboxClient,
} from '@ember/sandbox-daytona';
import {
  deleteV2R2KeysBestEffort,
  resolveV2StoredFileBytes,
  stageV2OutputFilesForPublish,
} from './r2-artifacts.js';
import { resolveV2SandboxConfig, type V2SandboxConfig } from './runtime-config.js';
import type { AgentHeadDO, LocalRuntimeEnv } from './runtime-head.js';

const DEFAULT_EXEC_TIMEOUT_MS = DAYTONA_SANDBOX_LIMITS.maxExecTimeoutMs;
const DEFAULT_READY_DEADLINE_MS = DAYTONA_SANDBOX_LIMITS.maxReadyDeadlineMs;
const DEFAULT_SANDBOX_LIFETIME_SEC = DAYTONA_SANDBOX_LIMITS.maxSandboxLifetimeSec;
const TOOL_OUTPUT_MAX_CHARS = 2_048;
const TASK_LEASE_RENEW_MS = 45_000;
const MAX_HEARTBEAT_INTERVAL_MS = 15_000;

const PYTHON_RUNNER_BOOTSTRAP = [
  'import os, runpy',
  "os.makedirs('/home/daytona/ember/inputs', exist_ok=True)",
  "os.makedirs('/home/daytona/ember/outputs', exist_ok=True)",
  "os.chdir('/home/daytona/ember')",
  "runpy.run_path('/home/daytona/ember/main.py', run_name='__main__')",
].join('; ');

export interface V2SandboxDirectoryEntry {
  readonly name: string;
  readonly isDir: boolean;
  readonly isSymlink: boolean;
  readonly sizeBytes: number;
}

/** Narrow sandbox provider port satisfied by `DaytonaSandboxProvider` and test doubles. */
export interface V2PythonSandboxPort {
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
  listDirectory(sandboxId: Id, relativeDir: string): Promise<readonly V2SandboxDirectoryEntry[]>;
  destroy(sandboxId: Id): Promise<void>;
}

export interface V2PythonSandboxHandle {
  readonly provider: V2PythonSandboxPort;
  readonly close?: () => Promise<void>;
}

export type V2PythonSandboxFactory = (options: {
  readonly tenantId: Id;
  readonly runId: Id;
  readonly owner: string;
  readonly signal: AbortSignal;
}) => V2PythonSandboxHandle | Promise<V2PythonSandboxHandle>;

export type V2PythonStepGateway = Pick<
  ModelGateway,
  'providerId' | 'modelLabel' | 'simulated' | 'stepPythonAgent'
>;

export interface V2PythonFakeFastPathGateway {
  readonly providerId?: 'fake';
  readonly modelLabel?: string;
  readonly simulated: true;
  readonly stepPythonAgent?: undefined;
}

export interface V2SandboxCleanupIncident {
  readonly event: 'v2_python_sandbox_cleanup_failed';
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly owner: string;
  readonly sandboxId: string | null;
  readonly destroyFailed: boolean;
  readonly closeFailed: boolean;
  readonly destroyErrorCode?: string;
  readonly closeErrorCode?: string;
  readonly ttlMinutes: number;
}

export type V2PythonTaskClaim = Parameters<DurableExecutorPort['executeDurableWork']>[0];

export interface V2PythonExecutionInput {
  readonly env: LocalRuntimeEnv;
  readonly claim: V2PythonTaskClaim;
  readonly gateway: V2PythonStepGateway | V2PythonFakeFastPathGateway;
  readonly modelRate?: ModelRateRow | null;
  readonly budgetMode?: 'disabled_echo_only' | 'simulated_full_protocol' | 'real';
  readonly perAttemptCeilingMicroUsd?: number;
  readonly sandboxFactory?: V2PythonSandboxFactory;
  readonly onCleanupIncident?: (incident: V2SandboxCleanupIncident) => void;
  readonly now?: () => number;
}

export type V2PythonExecutionOutcome =
  | {
      readonly status: 'completed';
      readonly summaryText: string;
      readonly detailText: string;
      readonly modelLabel: string;
      readonly simulated: boolean;
      readonly truncated: boolean;
      readonly reasonCode: string;
    }
  | {
      readonly status: 'failed';
      readonly reasonCode: string;
    };

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function detectOutputMediaType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'text/plain';
}

function buildTextPreview(
  filename: string,
  mediaType: string,
  bytes: Uint8Array,
): string | undefined {
  const isTextLike =
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    filename.toLowerCase().endsWith('.csv') ||
    filename.toLowerCase().endsWith('.json') ||
    filename.toLowerCase().endsWith('.md');
  if (!isTextLike) return undefined;
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4_096));
  const trimmed = decoded.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 1_024 ? `${trimmed.slice(0, 1_024)}…` : trimmed;
}

function createDaytonaSandboxFactory(
  config: Extract<V2SandboxConfig, { kind: 'daytona' }>,
): V2PythonSandboxFactory {
  return ({ tenantId, runId, owner, signal }) => {
    const client = new DaytonaSdkSandboxClient({
      apiKey: config.apiKey,
      ...(config.apiUrl === undefined ? {} : { apiUrl: config.apiUrl }),
      ...(config.target === undefined ? {} : { target: config.target }),
      // Workers/Queue isolates use explicit HTTP polling instead of opening background socket.io WebSockets.
      useDeprecatedPolling: true,
    });
    const provider = new DaytonaSandboxProvider({
      tenantId,
      runId,
      client,
      snapshot: 'daytona-small',
      sandboxClass: 'container',
      owner,
      signal,
    });
    return {
      provider,
      close: () => client.close(),
    };
  };
}

function createV2InMemoryFakeSandboxFactory(): V2PythonSandboxFactory {
  return () => {
    const files = new Map<string, Uint8Array>();
    let inputList: Array<{ filename: string; mediaType: string; bytes: Uint8Array }> = [];
    let promptText = '';
    const outputs = new Map<string, string>();
    const id = crypto.randomUUID();
    return {
      provider: {
        create: () => Promise.resolve({ sandboxId: id }),
        waitReady: () => Promise.resolve(),
        putBytesFile: (_sandboxId, relativePath, bytes) => {
          files.set(relativePath, bytes);
          if (relativePath.startsWith('inputs/')) {
            const filename = relativePath.slice('inputs/'.length);
            inputList.push({ filename, mediaType: detectOutputMediaType(filename), bytes });
          }
          return Promise.resolve();
        },
        putTextFile: (_sandboxId, relativePath, text) => {
          if (relativePath === 'main.py') promptText = text;
          files.set(relativePath, new TextEncoder().encode(text));
          return Promise.resolve();
        },
        exec: () => {
          const result = runV2FakePythonSandbox({ prompt: promptText, inputFiles: inputList });
          for (const out of result.outputFiles) {
            files.set(`outputs/${out.filename}`, out.bytes);
          }
          const outRef = crypto.randomUUID();
          const errRef = crypto.randomUUID();
          outputs.set(`${outRef}:stdout`, result.stdout);
          outputs.set(`${errRef}:stderr`, '');
          return Promise.resolve({
            exitCode: 0,
            stdoutRef: outRef,
            stderrRef: errRef,
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1,
          });
        },
        readOutput: (_sandboxId, ref, stream) =>
          Promise.resolve(outputs.get(`${ref}:${stream}`) ?? ''),
        listDirectory: (_sandboxId, relativeDir) => {
          const prefix = `${relativeDir.replace(/\/+$/, '')}/`;
          const entries: V2SandboxDirectoryEntry[] = [];
          for (const [key, bytes] of files.entries()) {
            if (key.startsWith(prefix)) {
              entries.push({
                name: key.slice(prefix.length),
                isDir: false,
                isSymlink: false,
                sizeBytes: bytes.byteLength,
              });
            }
          }
          return Promise.resolve(entries);
        },
        getBytesFile: (_sandboxId, relativePath) => {
          const bytes = files.get(relativePath);
          if (bytes === undefined) return Promise.reject(new Error('file not found'));
          return Promise.resolve(bytes);
        },
        destroy: () => {
          files.clear();
          inputList = [];
          outputs.clear();
          return Promise.resolve();
        },
      },
    };
  };
}

function computeAttemptReservationMicroUsd(
  gateway: V2PythonStepGateway,
  rate: ModelRateRow | null | undefined,
  budgetMode: V2PythonExecutionInput['budgetMode'],
  inputTokens: number,
  maxOutputTokens: number,
): number {
  if (gateway.simulated) {
    return budgetMode === 'simulated_full_protocol' ? 250 : 0;
  }
  if (rate === undefined || rate === null) {
    throw new ModelGatewayFailure('model_unavailable');
  }
  return Math.max(1, estimateCostMicroUsd(rate, inputTokens, maxOutputTokens));
}

function toRedactedCleanupErrorCode(error: unknown): string {
  if (isDomainError(error)) {
    return error.code;
  }
  if (error instanceof Error) {
    const safeName = error.name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48);
    return safeName.length > 0 ? safeName : 'error';
  }
  return 'unknown_error';
}

function redactBoundedId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
}

function defaultEmitCleanupIncident(incident: V2SandboxCleanupIncident): void {
  console.warn(JSON.stringify(incident));
}

async function runFakeFastPath(
  head: AgentHeadDO,
  claim: V2PythonTaskClaim,
  runId: string,
  principalId: string,
  taskInput: { readonly prompt?: string; readonly instructions?: string },
  r2Bucket: R2BucketPort | undefined,
): Promise<V2PythonExecutionOutcome> {
  const loadedInputs = (await head.taskArtifacts({
    kind: 'load_task_inputs',
    tenantId: claim.tenantId,
    principalId,
    agentId: claim.agentId,
    requestId: crypto.randomUUID(),
    taskId: claim.targetId,
    runId,
    leaseEpoch: claim.leaseEpoch,
    workerId: claim.workerId,
  })) as readonly V2TaskInputFileDto[];

  const inputFiles = await Promise.all(
    loadedInputs.map(async (file) => ({
      filename: file.filename,
      mediaType: file.mediaType,
      bytes: await resolveV2StoredFileBytes(file, r2Bucket),
    })),
  );

  const sandboxResult = runV2FakePythonSandbox({
    prompt: taskInput.prompt ?? '',
    ...(taskInput.instructions === undefined ? {} : { instructions: taskInput.instructions }),
    inputFiles,
  });

  if (sandboxResult.outputFiles.length > 0) {
    const staged = await stageV2OutputFilesForPublish({
      bucket: r2Bucket,
      tenantId: claim.tenantId,
      taskId: claim.targetId,
      runId,
      files: sandboxResult.outputFiles,
    });
    let published: V2PublishTaskOutputsResultDto;
    try {
      published = (await head.taskArtifacts({
        kind: 'publish_task_outputs',
        tenantId: claim.tenantId,
        principalId,
        agentId: claim.agentId,
        requestId: crypto.randomUUID(),
        taskId: claim.targetId,
        runId,
        leaseEpoch: claim.leaseEpoch,
        workerId: claim.workerId,
        simulated: true,
        outputs: staged.outputs,
      })) as V2PublishTaskOutputsResultDto;
    } catch (error) {
      await deleteV2R2KeysBestEffort(r2Bucket, staged.stagedR2Keys);
      throw error;
    }
    if (!published.accepted) {
      await deleteV2R2KeysBestEffort(r2Bucket, staged.stagedR2Keys);
      return { status: 'failed', reasonCode: 'lease_lost' };
    }
  }

  return {
    status: 'completed',
    summaryText: sandboxResult.summaryText,
    detailText: sandboxResult.detailText,
    modelLabel: FAKE_MODEL_LABEL,
    simulated: true,
    truncated: false,
    reasonCode: 'ok',
  };
}

/**
 * V2 durable `python.agent` task runner supporting both local fake execution and real
 * Daytona sandboxes (`EMBER_SANDBOX_MODE=daytona`) with strict lease/run fencing,
 * cancellation, deadline enforcement, aggregate file/spend bounds, and guaranteed cleanup.
 */
export async function executeV2PythonAgentTask(
  input: V2PythonExecutionInput,
): Promise<V2PythonExecutionOutcome> {
  const { env, claim, gateway } = input;
  const nowFn = input.now ?? Date.now;
  const sandboxConfig = resolveV2SandboxConfig(env);

  if (sandboxConfig.kind === 'disabled') {
    return { status: 'failed', reasonCode: sandboxConfig.reason };
  }

  if (
    sandboxConfig.kind === 'daytona' &&
    !sandboxConfig.allowedTenants.has(claim.tenantId.toLowerCase())
  ) {
    return { status: 'failed', reasonCode: 'sandbox_tenant_not_allowed' };
  }

  const rawContext = JSON.parse(claim.contextJson) as {
    readonly kind?: string;
    readonly runId?: string;
    readonly inputJson?: string;
    readonly principalId?: string;
    readonly deadlineAtMs?: number | null;
  };
  if (rawContext.kind !== 'python.agent' || rawContext.runId === undefined) {
    return { status: 'failed', reasonCode: 'local_task_driver_unavailable' };
  }

  const runId = rawContext.runId;
  const principalId = rawContext.principalId ?? claim.agentId;
  const taskInput = JSON.parse(rawContext.inputJson ?? '{}') as {
    readonly prompt?: string;
    readonly instructions?: string;
  };
  const head = env.AGENT_HEAD.getByName(formatRecoveryAgentKey(claim.tenantId, claim.agentId));

  if (
    sandboxConfig.kind === 'fake' &&
    gateway.simulated === true &&
    input.sandboxFactory === undefined
  ) {
    return runFakeFastPath(head, claim, runId, principalId, taskInput, env.EMBER_BLOBS);
  }

  if (
    gateway.stepPythonAgent === undefined ||
    gateway.providerId === undefined ||
    gateway.modelLabel === undefined ||
    gateway.simulated === undefined ||
    (!gateway.simulated &&
      (gateway.providerId === 'fake' || input.modelRate === undefined || input.modelRate === null))
  ) {
    return { status: 'failed', reasonCode: 'model_gateway_unavailable' };
  }
  const stepGateway: V2PythonStepGateway = gateway;

  const sandboxFactory: V2PythonSandboxFactory =
    input.sandboxFactory ??
    (sandboxConfig.kind === 'daytona'
      ? createDaytonaSandboxFactory(sandboxConfig)
      : createV2InMemoryFakeSandboxFactory());
  const sandboxOwner =
    sandboxConfig.kind === 'daytona' ? sandboxConfig.owner : `ember-${env.EMBER_ENV}:v2-fake`;

  const deadlineAtMs = rawContext.deadlineAtMs ?? null;
  const runAbort = new AbortController();
  let abortReason: 'lease_lost' | 'cancelled' | 'deadline_exceeded' | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatInFlight: Promise<void> | null = null;

  const stopTimers = async () => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    if (heartbeatInFlight !== null) {
      await heartbeatInFlight.catch(() => undefined);
    }
  };

  if (deadlineAtMs !== null) {
    const remaining = deadlineAtMs - nowFn();
    if (remaining <= 0) {
      return { status: 'failed', reasonCode: 'deadline_exceeded' };
    }
    deadlineTimer = setTimeout(() => {
      if (abortReason === null) abortReason = 'deadline_exceeded';
      runAbort.abort();
    }, remaining);
  }

  const leaseWindowMs = Math.max(3_000, claim.leaseExpiresAtMs - nowFn());
  const heartbeatIntervalMs = Math.min(
    MAX_HEARTBEAT_INTERVAL_MS,
    Math.max(1_000, Math.floor(leaseWindowMs / 3)),
  );
  heartbeatTimer = setInterval(() => {
    if (runAbort.signal.aborted || heartbeatInFlight !== null) return;
    heartbeatInFlight = (async () => {
      try {
        const res = await head.renewTaskLease({
          tenantId: claim.tenantId,
          agentId: claim.agentId,
          taskId: claim.targetId,
          runId,
          leaseEpoch: claim.leaseEpoch,
          workerId: claim.workerId,
          extendMs: TASK_LEASE_RENEW_MS,
        });
        if (!res.renewed && !runAbort.signal.aborted) {
          abortReason = res.cancelRequested ? 'cancelled' : 'lease_lost';
          runAbort.abort();
        }
      } catch {
        // Authoritative fence on next RPC / commit still protects against lease loss.
      } finally {
        heartbeatInFlight = null;
      }
    })();
  }, heartbeatIntervalMs);

  let sandboxHandle: V2PythonSandboxHandle | null = null;
  let sandboxId: Id | null = null;
  let outcome: V2PythonExecutionOutcome;
  let cleanupDestroyErrorCode: string | null = null;
  let cleanupCloseErrorCode: string | null = null;

  const runLoop = async (): Promise<V2PythonExecutionOutcome> => {
    const loadedInputs = (await head.taskArtifacts({
      kind: 'load_task_inputs',
      tenantId: claim.tenantId,
      principalId,
      agentId: claim.agentId,
      requestId: crypto.randomUUID(),
      taskId: claim.targetId,
      runId,
      leaseEpoch: claim.leaseEpoch,
      workerId: claim.workerId,
    })) as readonly V2TaskInputFileDto[];

    const decodedInputs = await Promise.all(
      loadedInputs.map(async (file) => ({
        ...file,
        bytes: await resolveV2StoredFileBytes(file, env.EMBER_BLOBS),
      })),
    );
    const inputTotalBytes = decodedInputs.reduce((sum, f) => sum + f.size, 0);
    const inputFiles: PythonAgentInputFile[] = decodedInputs.map((file) => {
      const previewText = buildTextPreview(file.filename, file.mediaType, file.bytes);
      return Object.freeze({
        artifactId: file.artifactId,
        filename: file.filename,
        mediaType: file.mediaType,
        sizeBytes: file.size,
        ...(previewText === undefined ? {} : { previewText }),
      });
    });

    const messages: PythonAgentStepMessage[] = [];
    let runLlmUsed = 0;
    let runPythonExecsUsed = 0;
    let stagedAnyOutputs = false;

    const ensureSandbox = async (): Promise<
      | { readonly kind: 'ready'; readonly provider: V2PythonSandboxPort; readonly id: Id }
      | { readonly kind: 'failed'; readonly reasonCode: string }
    > => {
      if (sandboxHandle !== null && sandboxId !== null) {
        return { kind: 'ready', provider: sandboxHandle.provider, id: sandboxId };
      }

      sandboxHandle = await sandboxFactory({
        tenantId: claim.tenantId,
        runId,
        owner: sandboxOwner,
        signal: runAbort.signal,
      });
      const created = await sandboxHandle.provider.create({
        tenantId: claim.tenantId,
        runId,
        imageDigest: 'daytona-small',
        cpuMilli: 1_000,
        memoryMiB: 1_024,
        maxLifetimeSec: DEFAULT_SANDBOX_LIFETIME_SEC,
        networkPolicyId: 'deny-all',
      });
      sandboxId = created.sandboxId;
      await sandboxHandle.provider.waitReady(sandboxId, DEFAULT_READY_DEADLINE_MS);

      for (const file of decodedInputs) {
        await sandboxHandle.provider.putBytesFile(sandboxId, `inputs/${file.filename}`, file.bytes);
      }

      return { kind: 'ready', provider: sandboxHandle.provider, id: sandboxId };
    };

    while (!runAbort.signal.aborted) {
      if (deadlineAtMs !== null && nowFn() >= deadlineAtMs) {
        return { status: 'failed', reasonCode: 'deadline_exceeded' };
      }
      if (runLlmUsed >= PYTHON_AGENT_LIMITS.maxLlmCallsPerRun) {
        return { status: 'failed', reasonCode: 'run_llm_limit_reached' };
      }

      const remainingRunLlm = PYTHON_AGENT_LIMITS.maxLlmCallsPerRun - runLlmUsed;
      const remainingPy = PYTHON_AGENT_LIMITS.maxPythonExecsPerRun - runPythonExecsUsed;
      const remainingPythonCalls = remainingRunLlm <= 1 ? 0 : Math.max(0, remainingPy);

      const stepInput = {
        taskId: claim.targetId,
        prompt: taskInput.prompt ?? '',
        ...(taskInput.instructions === undefined ? {} : { instructions: taskInput.instructions }),
        inputFiles,
        messages,
        maxOutputTokens: MODEL_LIMITS.pythonAgentMaxOutputTokens,
        remainingPythonCalls,
      };
      const preflight = preflightPythonAgentStep(stepInput);
      const effectiveBudgetMode =
        input.budgetMode ?? (stepGateway.simulated ? 'disabled_echo_only' : 'real');
      const estimatedMicroUsd = computeAttemptReservationMicroUsd(
        stepGateway,
        input.modelRate,
        effectiveBudgetMode,
        preflight.inputTokens,
        preflight.maxOutputTokens,
      );
      if (
        input.perAttemptCeilingMicroUsd !== undefined &&
        estimatedMicroUsd > input.perAttemptCeilingMicroUsd
      ) {
        return { status: 'failed', reasonCode: 'budget_exceeded' };
      }

      const reservation = await head.reserveTaskModelAttempt({
        tenantId: claim.tenantId,
        principalId,
        agentId: claim.agentId,
        taskId: claim.targetId,
        runId,
        leaseEpoch: claim.leaseEpoch,
        providerId: stepGateway.simulated
          ? 'fake'
          : stepGateway.providerId === 'openrouter'
            ? 'openrouter'
            : 'openai',
        modelLabel: stepGateway.modelLabel,
        rateVersion: stepGateway.simulated ? FAKE_V2_RATE_VERSION : input.modelRate!.rateVersion,
        budgetMode: effectiveBudgetMode,
        estimatedMicroUsd,
      });
      if (reservation.kind === 'refused') {
        return { status: 'failed', reasonCode: reservation.reason };
      }

      const auth = await head.markAttemptSent({
        scope: { tenantId: claim.tenantId, agentId: claim.agentId },
        subjectType: 'task',
        subjectId: claim.targetId,
        attemptNo: reservation.attemptNo,
        operationId: reservation.operationId,
        leaseEpoch: claim.leaseEpoch,
        leaseOwner: claim.workerId,
      });
      if (
        !auth.authorized ||
        !Number.isSafeInteger(auth.startBeforeMs) ||
        nowFn() >= auth.startBeforeMs
      ) {
        await head
          .settleTaskModelAttempt({
            tenantId: claim.tenantId,
            agentId: claim.agentId,
            taskId: claim.targetId,
            attemptNo: reservation.attemptNo,
            operationId: reservation.operationId,
            requestedState: 'released',
            outcomeCode: 'not_sent',
          })
          .catch(() => undefined);
        return {
          status: 'failed',
          reasonCode: auth.authorized ? 'deadline_exceeded' : auth.reason,
        };
      }

      let gatewayResult: Awaited<ReturnType<V2PythonStepGateway['stepPythonAgent']>>;
      try {
        gatewayResult = await stepGateway.stepPythonAgent(stepInput, runAbort.signal);
      } catch (error) {
        const notSent = error instanceof ModelAuthorizationRefused;
        await head
          .settleTaskModelAttempt({
            tenantId: claim.tenantId,
            agentId: claim.agentId,
            taskId: claim.targetId,
            attemptNo: reservation.attemptNo,
            operationId: reservation.operationId,
            requestedState: notSent ? 'released' : 'unknown_billed',
            outcomeCode: notSent
              ? 'not_sent'
              : isModelGatewayFailure(error)
                ? error.code
                : 'model_unavailable',
          })
          .catch(() => undefined);
        if (abortReason !== null) {
          return { status: 'failed', reasonCode: abortReason };
        }
        return {
          status: 'failed',
          reasonCode: isModelGatewayFailure(error) ? error.code : 'model_unavailable',
        };
      }

      if (gatewayResult.usage === null) {
        await head.settleTaskModelAttempt({
          tenantId: claim.tenantId,
          agentId: claim.agentId,
          taskId: claim.targetId,
          attemptNo: reservation.attemptNo,
          operationId: reservation.operationId,
          requestedState: 'conservative_billed',
          outcomeCode: 'usage_missing',
        });
      } else {
        await head.settleTaskModelAttempt({
          tenantId: claim.tenantId,
          agentId: claim.agentId,
          taskId: claim.targetId,
          attemptNo: reservation.attemptNo,
          operationId: reservation.operationId,
          requestedState: 'settled',
          outcomeCode: 'ok',
          observedCostMicroUsd: gatewayResult.usage.costMicroUsd,
          inputTokens: gatewayResult.usage.inputTokens,
          outputTokens: gatewayResult.usage.outputTokens,
        });
      }

      runLlmUsed += 1;

      if (abortReason !== null) {
        return { status: 'failed', reasonCode: abortReason };
      }
      if (gatewayResult.simulated !== stepGateway.simulated) {
        return { status: 'failed', reasonCode: 'model_invalid_output' };
      }

      const stepOutput = gatewayResult.output;
      const isSimulatedRun = gatewayResult.simulated || sandboxConfig.kind === 'fake';

      if (stepOutput.kind === 'final') {
        return {
          status: 'completed',
          summaryText: stepOutput.summaryText,
          detailText: stepOutput.detailText,
          modelLabel: gatewayResult.modelLabel,
          simulated: isSimulatedRun,
          truncated: stepOutput.truncated,
          reasonCode: 'ok',
        };
      }

      if (runPythonExecsUsed >= PYTHON_AGENT_LIMITS.maxPythonExecsPerRun) {
        return { status: 'failed', reasonCode: 'python_run_limit' };
      }

      const sandboxReady = await ensureSandbox();
      if (sandboxReady.kind === 'failed') {
        return { status: 'failed', reasonCode: sandboxReady.reasonCode };
      }

      const execStartMs = nowFn();
      const execTimeoutMs =
        deadlineAtMs === null
          ? DEFAULT_EXEC_TIMEOUT_MS
          : Math.max(
              DAYTONA_SANDBOX_LIMITS.minExecTimeoutMs,
              Math.min(DEFAULT_EXEC_TIMEOUT_MS, deadlineAtMs - execStartMs),
            );

      await sandboxReady.provider.putTextFile(sandboxReady.id, 'main.py', stepOutput.code);
      let exitCode = 0;
      let timedOut = false;
      let stdout = '';
      let stderr = '';
      try {
        const execRes = await sandboxReady.provider.exec(
          sandboxReady.id,
          ['python3', '-c', PYTHON_RUNNER_BOOTSTRAP],
          execTimeoutMs,
        );
        exitCode = execRes.exitCode;
        stdout = await sandboxReady.provider.readOutput(
          sandboxReady.id,
          execRes.stdoutRef,
          'stdout',
          8_192,
        );
        stderr = await sandboxReady.provider.readOutput(
          sandboxReady.id,
          execRes.stderrRef,
          'stderr',
          8_192,
        );
      } catch (error) {
        if (isDomainError(error) && error.code === 'EXECUTION_TIMEOUT') {
          timedOut = true;
          exitCode = 124;
          stderr = 'Python execution timed out.';
        } else {
          throw error;
        }
      }

      runPythonExecsUsed += 1;
      const execDurationMs = Math.max(0, nowFn() - execStartMs);
      const publishedMeta: Array<{
        readonly filename: string;
        readonly size_bytes: number;
        readonly media_type: string;
      }> = [];

      if (exitCode === 0 && !timedOut) {
        const entries = await sandboxReady.provider.listDirectory(sandboxReady.id, 'outputs');
        if (entries.length > PYTHON_AGENT_LIMITS.maxOutputArtifactsPerTask) {
          return { status: 'failed', reasonCode: 'too_many_output_artifacts' };
        }

        const maxOutputFileBytes =
          env.EMBER_BLOBS !== undefined
            ? PYTHON_AGENT_LIMITS.maxFileBytes
            : Math.min(PYTHON_AGENT_LIMITS.maxFileBytes, V2_MAX_INLINE_ARTIFACT_BYTES);
        let plannedOutputBytes = 0;
        for (const entry of entries) {
          if (entry.isSymlink) return { status: 'failed', reasonCode: 'symlink_output_forbidden' };
          if (entry.isDir) return { status: 'failed', reasonCode: 'directory_output_forbidden' };
          if (!isSafeArtifactFilename(entry.name)) {
            return { status: 'failed', reasonCode: 'invalid_output_filename' };
          }
          if (entry.sizeBytes > maxOutputFileBytes) {
            return { status: 'failed', reasonCode: 'output_artifact_too_large' };
          }
          plannedOutputBytes += entry.sizeBytes;
        }
        if (inputTotalBytes + plannedOutputBytes > PYTHON_AGENT_LIMITS.maxTaskTotalFileBytes) {
          return { status: 'failed', reasonCode: 'task_file_budget_exceeded' };
        }

        const rawOutputs: Array<{
          readonly filename: string;
          readonly mediaType: string;
          readonly bytes: Uint8Array;
        }> = [];
        let actualOutputBytes = 0;

        for (const entry of entries) {
          const rawBytes = await sandboxReady.provider.getBytesFile(
            sandboxReady.id,
            `outputs/${entry.name}`,
          );
          if (rawBytes.byteLength > maxOutputFileBytes) {
            return { status: 'failed', reasonCode: 'output_artifact_too_large' };
          }
          actualOutputBytes += rawBytes.byteLength;
          if (inputTotalBytes + actualOutputBytes > PYTHON_AGENT_LIMITS.maxTaskTotalFileBytes) {
            return { status: 'failed', reasonCode: 'task_file_budget_exceeded' };
          }
          const mediaType = detectOutputMediaType(entry.name);
          if (!B3StagedUploadMediaTypeSchema.safeParse(mediaType).success) {
            return { status: 'failed', reasonCode: 'blocked_output_media_type' };
          }
          rawOutputs.push({
            filename: entry.name,
            mediaType,
            bytes: rawBytes,
          });
          publishedMeta.push({
            filename: entry.name,
            size_bytes: rawBytes.byteLength,
            media_type: mediaType,
          });
        }

        if (rawOutputs.length > 0 || stagedAnyOutputs) {
          const staged = await stageV2OutputFilesForPublish({
            bucket: env.EMBER_BLOBS,
            tenantId: claim.tenantId,
            taskId: claim.targetId,
            runId,
            files: rawOutputs,
          });
          let published: V2PublishTaskOutputsResultDto;
          try {
            published = (await head.taskArtifacts({
              kind: 'publish_task_outputs',
              tenantId: claim.tenantId,
              principalId,
              agentId: claim.agentId,
              requestId: crypto.randomUUID(),
              taskId: claim.targetId,
              runId,
              leaseEpoch: claim.leaseEpoch,
              workerId: claim.workerId,
              simulated: isSimulatedRun,
              outputs: staged.outputs,
            })) as V2PublishTaskOutputsResultDto;
          } catch (error) {
            await deleteV2R2KeysBestEffort(env.EMBER_BLOBS, staged.stagedR2Keys);
            throw error;
          }
          if (!published.accepted) {
            await deleteV2R2KeysBestEffort(env.EMBER_BLOBS, staged.stagedR2Keys);
            return { status: 'failed', reasonCode: abortReason ?? 'lease_lost' };
          }
          stagedAnyOutputs = rawOutputs.length > 0;
        }
      }

      const toolResultJson = JSON.stringify({
        exit_code: exitCode,
        timed_out: timedOut,
        duration_ms: execDurationMs,
        stdout: clampText(stdout, TOOL_OUTPUT_MAX_CHARS),
        stderr: clampText(stderr, TOOL_OUTPUT_MAX_CHARS),
        output_files: publishedMeta,
      });

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
    }

    return {
      status: 'failed',
      reasonCode: abortReason ?? 'aborted',
    };
  };

  try {
    outcome = await runLoop();
  } catch (error) {
    if (abortReason !== null) {
      outcome = { status: 'failed', reasonCode: abortReason };
    } else if (error instanceof ModelInputRefused) {
      outcome = { status: 'failed', reasonCode: 'model_input_refused' };
    } else if (isDomainError(error)) {
      if (error.code === 'STALE_LEASE') {
        outcome = { status: 'failed', reasonCode: 'lease_lost' };
      } else if (error.code === 'CANCELLED') {
        outcome = { status: 'failed', reasonCode: 'cancelled' };
      } else if (error.code === 'DEADLINE_EXCEEDED') {
        outcome = { status: 'failed', reasonCode: 'deadline_exceeded' };
      } else if (error.code === 'POLICY_DENIED') {
        outcome = { status: 'failed', reasonCode: 'sandbox_policy_denied' };
      } else {
        outcome = { status: 'failed', reasonCode: error.code.toLowerCase() };
      }
    } else {
      outcome = { status: 'failed', reasonCode: 'sandbox_execution_failed' };
    }
  } finally {
    await stopTimers();
    if (sandboxHandle !== null) {
      const handle: V2PythonSandboxHandle = sandboxHandle;
      if (sandboxId !== null) {
        try {
          await handle.provider.destroy(sandboxId);
        } catch (destroyError) {
          cleanupDestroyErrorCode = toRedactedCleanupErrorCode(destroyError);
        }
      }
      if (handle.close !== undefined) {
        try {
          await handle.close();
        } catch (closeError) {
          cleanupCloseErrorCode = toRedactedCleanupErrorCode(closeError);
        }
      }
    }
  }

  if (cleanupDestroyErrorCode !== null || cleanupCloseErrorCode !== null) {
    const emitIncident = input.onCleanupIncident ?? defaultEmitCleanupIncident;
    emitIncident({
      event: 'v2_python_sandbox_cleanup_failed',
      tenantId: claim.tenantId,
      taskId: claim.targetId,
      runId,
      owner: sandboxOwner,
      sandboxId: sandboxId === null ? null : redactBoundedId(sandboxId),
      destroyFailed: cleanupDestroyErrorCode !== null,
      closeFailed: cleanupCloseErrorCode !== null,
      ...(cleanupDestroyErrorCode === null ? {} : { destroyErrorCode: cleanupDestroyErrorCode }),
      ...(cleanupCloseErrorCode === null ? {} : { closeErrorCode: cleanupCloseErrorCode }),
      ttlMinutes: Math.min(
        Math.max(Math.ceil(DEFAULT_SANDBOX_LIFETIME_SEC / 60), 1),
        DAYTONA_SANDBOX_LIMITS.maxTtlMinutes,
      ),
    });
    const suffix = cleanupDestroyErrorCode !== null ? 'cleanup_failed' : 'close_failed';
    outcome =
      outcome.status === 'completed'
        ? {
            ...outcome,
            reasonCode:
              cleanupDestroyErrorCode !== null ? 'sandbox_cleanup_failed' : 'sandbox_close_failed',
          }
        : {
            ...outcome,
            reasonCode: outcome.reasonCode.endsWith(`:${suffix}`)
              ? outcome.reasonCode
              : `${outcome.reasonCode.slice(0, 108)}:${suffix}`,
          };
  }

  return outcome;
}
