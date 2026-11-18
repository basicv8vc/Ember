import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PYTHON_AGENT_LIMITS, type BlobStore, type StagedBlobRef } from '@ember/contracts';
import { DomainError, type Id, type LeasedRun } from '@ember/domain';
import type {
  ModelGateway,
  ModelRateRow,
  PythonAgentStepInput,
  PythonAgentStepOutput,
} from '@ember/model-gateway';
import type {
  PostgresPythonAgentExecutionRepository,
  PythonAgentAttemptReservation,
  PythonAgentCommitCompletionCommand,
  PythonAgentCommitFailureCommand,
  PythonAgentCommitResult,
  PythonAgentCommitStepCommand,
  PythonAgentFailureResult,
  PythonAgentLlmCharge,
  PythonAgentLoadContextResult,
  PythonAgentLoadedContext,
  PythonAgentOpKind,
  PythonAgentReserveLlmCommand,
  PythonAgentReserveLlmOutcome,
  PythonAgentReserveOpOutcome,
  PythonAgentStepCursor,
  PythonStepStagedOutput,
} from '@ember/postgres/b3-worker';
import {
  executePythonAgentRun,
  type PythonAgentDirectoryEntry,
  type PythonAgentSandboxHandle,
  type PythonAgentSandboxPort,
} from '../../apps/worker/src/b3/python-agent-executor.js';

const TENANT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849301';
const AGENT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849302';
const TASK_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849303';
const RUN_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849304';

const TEST_RATE: ModelRateRow = {
  providerId: 'openrouter',
  modelId: 'nvidia/nemotron-3.5-lightning',
  inputMicroUsdPerMillion: 60_000,
  outputMicroUsdPerMillion: 160_000,
  rateVersion: 'test-rate-v1',
  provenance: 'official_price_verified',
  source: 'unit test',
};

const TEST_POLICY = {
  baseDelayMs: 1_000,
  capDelayMs: 10_000,
};

function makeLease(overrides: Partial<LeasedRun> = {}): LeasedRun {
  return {
    tenantId: TENANT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    attempt: 1,
    leaseEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    ...overrides,
  };
}

class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, { bytes: Uint8Array; mediaType: string; stagedId: string }>();

  async stage(
    tenantId: Id,
    source: Uint8Array | ReadableStream<Uint8Array>,
    mediaType: string,
  ): Promise<StagedBlobRef> {
    const bytes =
      source instanceof Uint8Array
        ? source
        : new Uint8Array(await new Response(source).arrayBuffer());
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const stagedId = randomUUID();
    const storageKey = `staged/${tenantId}/${sha256}`;
    this.blobs.set(storageKey, { bytes, mediaType, stagedId });
    return {
      stagedId,
      storageKey,
      sha256,
      size: bytes.byteLength,
      mediaType,
    };
  }

  install(tenantId: Id, staged: StagedBlobRef) {
    return Promise.resolve({
      storageKey: `published/${tenantId}/${staged.sha256}`,
      sha256: staged.sha256,
      size: staged.size,
      mediaType: staged.mediaType,
    });
  }

  read(_tenantId: Id, storageKey: string): Promise<Uint8Array> {
    return Promise.resolve(this.blobs.get(storageKey)?.bytes ?? new Uint8Array(0));
  }

  verifyContent(): Promise<boolean> {
    return Promise.resolve(true);
  }

  assertInstalled(): Promise<boolean> {
    return Promise.resolve(true);
  }

  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }

  discard(): Promise<void> {
    return Promise.resolve();
  }

  sweepOrphans() {
    return Promise.resolve({
      scanned: 0,
      removedStaged: 0,
      removedBlobs: 0,
      retained: 0,
    });
  }
}

class MemorySandbox implements PythonAgentSandboxPort {
  createdSpecs: unknown[] = [];
  destroyedIds: Id[] = [];
  closedCount = 0;
  readonly files = new Map<string, Uint8Array>();
  readonly outputsEntries: PythonAgentDirectoryEntry[] = [];
  readonly execScripts: string[] = [];
  readonly stdoutByRef = new Map<string, string>();
  readonly stderrByRef = new Map<string, string>();

  constructor(
    private readonly onExec: (
      code: string,
      files: Map<string, Uint8Array>,
      outputsEntries: PythonAgentDirectoryEntry[],
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  ) {}

  create(spec: Parameters<PythonAgentSandboxPort['create']>[0]) {
    this.createdSpecs.push(spec);
    return Promise.resolve({ sandboxId: `sbx-${this.createdSpecs.length}` });
  }

  waitReady(): Promise<void> {
    return Promise.resolve();
  }

  putTextFile(_sandboxId: Id, relativePath: string, text: string): Promise<void> {
    this.files.set(relativePath, new TextEncoder().encode(text));
    return Promise.resolve();
  }

  putBytesFile(_sandboxId: Id, relativePath: string, bytes: Uint8Array): Promise<void> {
    this.files.set(relativePath, bytes);
    if (relativePath.startsWith('outputs/')) {
      const name = relativePath.slice('outputs/'.length);
      if (!this.outputsEntries.some((entry) => entry.name === name)) {
        this.outputsEntries.push({
          name,
          isDir: false,
          isSymlink: false,
          sizeBytes: bytes.byteLength,
        });
      }
    }
    return Promise.resolve();
  }

  getBytesFile(_sandboxId: Id, relativePath: string): Promise<Uint8Array> {
    const bytes = this.files.get(relativePath);
    if (bytes === undefined) {
      return Promise.reject(new Error(`missing file ${relativePath}`));
    }
    return Promise.resolve(bytes);
  }

  listDirectory(
    _sandboxId: Id,
    relativeDir: string,
  ): Promise<readonly PythonAgentDirectoryEntry[]> {
    if (relativeDir === 'outputs') {
      return Promise.resolve([...this.outputsEntries]);
    }
    return Promise.resolve([]);
  }

  async exec(_sandboxId: Id, _argv: readonly string[], _timeoutMs: number) {
    const raw = this.files.get('main.py');
    const code = raw === undefined ? '' : new TextDecoder().decode(raw);
    this.execScripts.push(code);
    const result = await this.onExec(code, this.files, this.outputsEntries);
    const idx = this.execScripts.length;
    const stdoutRef = `stdout-${idx}`;
    const stderrRef = `stderr-${idx}`;
    this.stdoutByRef.set(stdoutRef, result.stdout);
    this.stderrByRef.set(stderrRef, result.stderr);
    return {
      exitCode: result.exitCode,
      stdoutRef,
      stderrRef,
      artifactRefs: [],
    };
  }

  readOutput(_sandboxId: Id, ref: Id, stream: 'stdout' | 'stderr'): Promise<string> {
    return Promise.resolve(
      (stream === 'stdout' ? this.stdoutByRef.get(ref) : this.stderrByRef.get(ref)) ?? '',
    );
  }

  destroy(sandboxId: Id): Promise<void> {
    this.destroyedIds.push(sandboxId);
    return Promise.resolve();
  }
}

class MemoryPythonAgentRepository {
  context: PythonAgentLoadedContext;
  readonly settlements: PythonAgentLlmCharge[] = [];
  readonly opEvents: Array<{
    kind: 'reserve' | 'settle';
    opKind?: PythonAgentOpKind;
    operationId: string;
    state?: string;
  }> = [];
  readonly committedSteps: PythonAgentCommitStepCommand[] = [];
  readonly completions: PythonAgentCommitCompletionCommand[] = [];
  readonly failures: PythonAgentCommitFailureCommand[] = [];
  staleOnCommitStep = false;
  staleOnComplete = false;
  nextAttemptNo = 1;
  overrideReserveLlm: ((cmd: PythonAgentReserveLlmCommand) => PythonAgentReserveLlmOutcome) | null =
    null;
  overrideReserveOp: ((opKind: PythonAgentOpKind) => PythonAgentReserveOpOutcome) | null = null;

  constructor(overrides: Partial<PythonAgentLoadedContext> = {}) {
    this.context = {
      tenantId: TENANT_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      attempt: 1,
      leaseEpoch: 1,
      agentId: AGENT_ID,
      policyVersion: 1,
      deadlineAt: null,
      input: {
        prompt: 'Analyze CSV and generate summary.csv',
        instructions: 'Use ./inputs/data.csv',
      },
      inputFiles: [
        {
          artifactId: randomUUID(),
          filename: 'data.csv',
          mediaType: 'text/csv',
          sha256: 'abc',
          size: 24,
          bytes: new TextEncoder().encode('region_v2,amount_usd\nNA,42\n'),
        },
      ],
      checkpoints: [],
      latestStagedOutputs: [],
      usage: {
        taskLlmCallsUsed: 0,
        taskCostMicroUsd: 0,
        runLlmCallsUsed: 0,
        taskSandboxCreatesUsed: 0,
        runSandboxCreatesUsed: 0,
        taskPythonExecsUsed: 0,
        runPythonExecsUsed: 0,
      },
      ...overrides,
    };
  }

  loadAgentContext(): Promise<PythonAgentLoadContextResult> {
    return Promise.resolve({ kind: 'ready', context: this.context });
  }

  reserveLlmAttempt(command: PythonAgentReserveLlmCommand): Promise<PythonAgentReserveLlmOutcome> {
    if (this.overrideReserveLlm !== null) {
      return Promise.resolve(this.overrideReserveLlm(command));
    }
    const attemptNo = this.nextAttemptNo++;
    const attempt: PythonAgentAttemptReservation = {
      attemptNo,
      operationId: `llm:${attemptNo}`,
      utcDay: '2026-11-16',
      reservedMicroUsd: command.reservedMicroUsd,
    };
    return Promise.resolve({ kind: 'reserved', attempt });
  }

  markLlmAttemptSent(): Promise<boolean> {
    return Promise.resolve(true);
  }

  settleLlmAttempt(charge: PythonAgentLlmCharge) {
    this.settlements.push(charge);
    return Promise.resolve({ kind: 'settled' as const });
  }

  reserveAgentOperation(command: {
    readonly opKind: PythonAgentOpKind;
    readonly operationId: string;
  }): Promise<PythonAgentReserveOpOutcome> {
    this.opEvents.push({
      kind: 'reserve',
      opKind: command.opKind,
      operationId: command.operationId,
    });
    if (this.overrideReserveOp !== null) {
      return Promise.resolve(this.overrideReserveOp(command.opKind));
    }
    return Promise.resolve({ kind: 'reserved', operationId: command.operationId });
  }

  settleAgentOperation(command: {
    readonly operationId: string;
    readonly state: string;
  }): Promise<void> {
    this.opEvents.push({ kind: 'settle', operationId: command.operationId, state: command.state });
    return Promise.resolve();
  }

  commitStepCheckpoint(
    command: PythonAgentCommitStepCommand,
  ): Promise<{ readonly outcome: 'committed' | 'cancelled' | 'deadline_exceeded' }> {
    if (this.staleOnCommitStep) {
      return Promise.reject(new DomainError('STALE_LEASE', 'stale lease on step commit'));
    }
    this.committedSteps.push(command);
    return Promise.resolve({ outcome: 'committed' });
  }

  commitCompletion(command: PythonAgentCommitCompletionCommand): Promise<PythonAgentCommitResult> {
    if (this.staleOnComplete) {
      return Promise.reject(new DomainError('STALE_LEASE', 'stale lease on completion'));
    }
    this.completions.push(command);
    return Promise.resolve({
      outcome: 'committed',
      taskStatus: 'completed',
      runStatus: 'succeeded',
      publishedArtifactIds: command.finalStagedOutputs.map(() => randomUUID()),
    });
  }

  commitFailure(command: PythonAgentCommitFailureCommand): Promise<PythonAgentFailureResult> {
    this.failures.push(command);
    return Promise.resolve({
      outcome: 'committed',
      taskStatus:
        command.outcome === 'cancelled'
          ? 'cancelled'
          : command.outcome === 'failed_retryable'
            ? 'retryable_failed'
            : 'failed',
      runStatus:
        command.outcome === 'cancelled'
          ? 'cancelled'
          : command.outcome === 'failed_retryable'
            ? 'failed_retryable'
            : 'failed_terminal',
    });
  }
}

function scriptedGateway(steps: PythonAgentStepOutput[]): {
  readonly gateway: ModelGateway;
  readonly seenInputs: PythonAgentStepInput[];
} {
  const seenInputs: PythonAgentStepInput[] = [];
  const queue = [...steps];
  const gateway: ModelGateway = {
    providerId: 'openrouter',
    modelLabel: TEST_RATE.modelId,
    simulated: false,
    operations: ['conversation.turn', 'task.notes_action_items', 'task.python_agent'],
    generateConversationTurn() {
      return Promise.reject(new Error('unused'));
    },
    extractNotesActionItems() {
      return Promise.reject(new Error('unused'));
    },
    stepPythonAgent(input: PythonAgentStepInput) {
      seenInputs.push({
        ...input,
        messages: [...input.messages],
      });
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(new Error('script exhausted'));
      }
      return Promise.resolve({
        output: next,
        modelLabel: TEST_RATE.modelId,
        simulated: false,
        usage: {
          inputTokens: 120,
          outputTokens: 60,
          costMicroUsd: 25,
          rateVersion: TEST_RATE.rateVersion,
        },
      });
    },
  };
  return { gateway, seenInputs };
}

describe('B3-B1 PythonAgentExecutor unit tests', () => {
  it('completes a self-healing Python loop (KeyError -> inspect & fix -> staged CSV artifact) and cleans up sandbox', async () => {
    const repo = new MemoryPythonAgentRepository();
    const blobStore = new MemoryBlobStore();
    let execCount = 0;
    const sandbox = new MemorySandbox((_code, files, outputsEntries) => {
      execCount += 1;
      if (execCount === 1) {
        return Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: "KeyError: 'amount'",
        });
      }
      const csvOut = new TextEncoder().encode('region_v2,total_usd\nNA,42\n');
      files.set('outputs/summary.csv', csvOut);
      outputsEntries.push({
        name: 'summary.csv',
        isDir: false,
        isSymlink: false,
        sizeBytes: csvOut.byteLength,
      });
      return Promise.resolve({
        exitCode: 0,
        stdout: 'wrote outputs/summary.csv',
        stderr: '',
      });
    });

    const { gateway, seenInputs } = scriptedGateway([
      {
        kind: 'tool_call',
        toolCallId: 'call_1',
        code: "import csv\nprint(row['amount'])",
        rawArgumentsJson: '{"code":"..."}',
      },
      {
        kind: 'tool_call',
        toolCallId: 'call_2',
        code: "open('outputs/summary.csv','w').write('region_v2,total_usd\\nNA,42\\n')",
        rawArgumentsJson: '{"code":"..."}',
      },
      {
        kind: 'final',
        summaryText: 'Computed NA total: 42.',
        detailText: 'Self-healed column lookup to amount_usd and wrote summary.csv.',
        truncated: false,
        finishReason: 'stop',
      },
    ]);

    const outcome = await executePythonAgentRun(makeLease(), {
      mode: 'real',
      leaseQueue: { heartbeat: () => Promise.resolve(true) },
      repository: repo as unknown as PostgresPythonAgentExecutionRepository,
      blobStore,
      gateway,
      createSandbox: (): PythonAgentSandboxHandle => ({
        provider: sandbox,
        close: () => {
          sandbox.closedCount += 1;
          return Promise.resolve();
        },
      }),
      sandboxOwner: 'test-owner',
      policy: TEST_POLICY,
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 50_000,
        tenantDailyMicroUsd: 100_000,
        globalDailyMicroUsd: 500_000,
      },
      rate: TEST_RATE,
      leaseDurationMs: 15_000,
      attemptTimeoutMs: 5_000,
      logger: { info: () => {}, warn: () => {} },
    });

    expect(outcome).toMatchObject({
      outcome: 'succeeded',
      sandboxCreated: true,
      pythonExecs: 2,
      llmCalls: 3,
    });
    if (outcome.outcome === 'succeeded') {
      expect(outcome.publishedArtifactIds).toHaveLength(1);
    }
    expect(seenInputs).toHaveLength(3);
    expect(sandbox.createdSpecs).toEqual([
      expect.objectContaining({
        networkPolicyId: 'deny-all',
        maxLifetimeSec: 120,
      }),
    ]);
    // Input file uploaded once before first Python execution.
    expect(new TextDecoder().decode(sandbox.files.get('inputs/data.csv'))).toContain('amount_usd');
    // Both steps checkpointed, second step staged summary.csv.
    expect(repo.committedSteps).toHaveLength(2);
    expect(repo.committedSteps[0]!.exitCode).toBe(1);
    expect(repo.committedSteps[1]!.exitCode).toBe(0);
    expect(repo.committedSteps[1]!.stagedOutputs.map((o) => o.filename)).toEqual(['summary.csv']);
    // Sandbox destroyed and closed in finally.
    expect(sandbox.destroyedIds).toEqual(['sbx-1']);
    expect(sandbox.closedCount).toBe(1);
  });

  it('skips sandbox creation when LLM finishes directly without calling run_python_script', async () => {
    const repo = new MemoryPythonAgentRepository({ inputFiles: [] });
    let createSandboxCalls = 0;
    const { gateway } = scriptedGateway([
      {
        kind: 'final',
        summaryText: 'No Python needed.',
        detailText: 'Answered directly.',
        truncated: false,
        finishReason: 'stop',
      },
    ]);

    const outcome = await executePythonAgentRun(makeLease(), {
      mode: 'real',
      leaseQueue: { heartbeat: () => Promise.resolve(true) },
      repository: repo as unknown as PostgresPythonAgentExecutionRepository,
      blobStore: new MemoryBlobStore(),
      gateway,
      createSandbox: () => {
        createSandboxCalls += 1;
        throw new Error('should not create sandbox');
      },
      sandboxOwner: 'test-owner',
      policy: TEST_POLICY,
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 50_000,
        tenantDailyMicroUsd: 100_000,
        globalDailyMicroUsd: 500_000,
      },
      rate: TEST_RATE,
      leaseDurationMs: 15_000,
      attemptTimeoutMs: 5_000,
      logger: { info: () => {}, warn: () => {} },
    });

    expect(outcome).toEqual({
      outcome: 'succeeded',
      sandboxCreated: false,
      pythonExecs: 0,
      llmCalls: 1,
      publishedArtifactIds: [],
    });
    expect(createSandboxCalls).toBe(0);
  });

  it('restores checkpoint messages and staged outputs onto a fresh sandbox upon retry', async () => {
    const previousBytes = new TextEncoder().encode('col\n1\n');
    const previousSha = createHash('sha256').update(previousBytes).digest('hex');
    const priorOutput: PythonStepStagedOutput = {
      stagedId: randomUUID(),
      storageKey: `staged/${TENANT_ID}/${previousSha}`,
      sha256: previousSha,
      size: previousBytes.byteLength,
      mediaType: 'text/csv',
      filename: 'partial.csv',
    };
    const priorCheckpoint: PythonAgentStepCursor = {
      stepSequence: 1,
      runId: randomUUID(),
      attempt: 1,
      toolCallId: 'call_prev_1',
      code: 'open("outputs/partial.csv","w").write("col\\n1\\n")',
      exitCode: 0,
      timedOut: false,
      durationMs: 120,
      stdoutPreview: 'partial ok',
      stderrPreview: '',
      toolResultJson: '{"exit_code":0,"output_files":[{"filename":"partial.csv"}]}',
      stagedOutputs: [priorOutput],
    };

    const repo = new MemoryPythonAgentRepository({
      attempt: 2,
      checkpoints: [priorCheckpoint],
      latestStagedOutputs: [{ ...priorOutput, bytes: previousBytes }],
      usage: {
        taskLlmCallsUsed: 2,
        taskCostMicroUsd: 50,
        runLlmCallsUsed: 0,
        taskSandboxCreatesUsed: 1,
        runSandboxCreatesUsed: 0,
        taskPythonExecsUsed: 1,
        runPythonExecsUsed: 0,
      },
    });
    const sandbox = new MemorySandbox((_code, files, outputsEntries) => {
      const restored = new TextDecoder().decode(files.get('outputs/partial.csv'));
      expect(restored).toBe('col\n1\n');
      const finalBytes = new TextEncoder().encode('col\n1\n2\n');
      files.set('outputs/final.csv', finalBytes);
      outputsEntries.push({
        name: 'final.csv',
        isDir: false,
        isSymlink: false,
        sizeBytes: finalBytes.byteLength,
      });
      return Promise.resolve({ exitCode: 0, stdout: 'resumed ok', stderr: '' });
    });

    const { gateway, seenInputs } = scriptedGateway([
      {
        kind: 'tool_call',
        toolCallId: 'call_resume_2',
        code: 'print("resuming")',
        rawArgumentsJson: '{"code":"print(\\"resuming\\")"}',
      },
      {
        kind: 'final',
        summaryText: 'Resumed and completed.',
        detailText: 'Restored partial.csv and wrote final.csv.',
        truncated: false,
        finishReason: 'stop',
      },
    ]);

    const outcome = await executePythonAgentRun(makeLease({ attempt: 2 }), {
      mode: 'real',
      leaseQueue: { heartbeat: () => Promise.resolve(true) },
      repository: repo as unknown as PostgresPythonAgentExecutionRepository,
      blobStore: new MemoryBlobStore(),
      gateway,
      createSandbox: () => ({
        provider: sandbox,
        close: () => {
          sandbox.closedCount += 1;
          return Promise.resolve();
        },
      }),
      sandboxOwner: 'test-owner',
      policy: TEST_POLICY,
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 50_000,
        tenantDailyMicroUsd: 100_000,
        globalDailyMicroUsd: 500_000,
      },
      rate: TEST_RATE,
      leaseDurationMs: 15_000,
      attemptTimeoutMs: 5_000,
      logger: { info: () => {}, warn: () => {} },
    });

    expect(outcome.outcome).toBe('succeeded');
    expect(seenInputs[0]!.messages).toHaveLength(2);
    expect(seenInputs[0]!.messages[0]!.toolCalls?.[0]?.id).toBe('call_prev_1');
    expect(seenInputs[0]!.messages[1]!.text).toContain('partial.csv');
    expect(repo.completions[0]!.finalStagedOutputs.map((o) => o.filename).sort()).toEqual([
      'final.csv',
      'partial.csv',
    ]);
    expect(sandbox.destroyedIds).toEqual(['sbx-1']);
  });

  it('aborts and returns lease_lost when heartbeat fails during a slow step, while destroying sandbox', async () => {
    const repo = new MemoryPythonAgentRepository();
    const sandbox = new MemorySandbox(() =>
      Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '' }),
    );
    let heartbeatCalls = 0;

    const gateway: ModelGateway = {
      providerId: 'openrouter',
      modelLabel: TEST_RATE.modelId,
      simulated: false,
      operations: ['conversation.turn', 'task.notes_action_items', 'task.python_agent'],
      generateConversationTurn: () => Promise.reject(new Error('unused')),
      extractNotesActionItems: () => Promise.reject(new Error('unused')),
      stepPythonAgent(_input, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      },
    };

    const outcome = await executePythonAgentRun(makeLease(), {
      mode: 'real',
      leaseQueue: {
        heartbeat: () => {
          heartbeatCalls += 1;
          return Promise.resolve(false);
        },
      },
      repository: repo as unknown as PostgresPythonAgentExecutionRepository,
      blobStore: new MemoryBlobStore(),
      gateway,
      createSandbox: () => ({ provider: sandbox }),
      sandboxOwner: 'test-owner',
      policy: TEST_POLICY,
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 50_000,
        tenantDailyMicroUsd: 100_000,
        globalDailyMicroUsd: 500_000,
      },
      rate: TEST_RATE,
      leaseDurationMs: 150,
      attemptTimeoutMs: 10_000,
      logger: { info: () => {}, warn: () => {} },
    });

    expect(outcome).toEqual({ outcome: 'lease_lost' });
    expect(heartbeatCalls).toBeGreaterThanOrEqual(1);
    expect(repo.completions).toHaveLength(0);
    expect(repo.failures).toHaveLength(0);
  });

  it('rejects symlink or unsafe output filenames and still destroys sandbox in finally', async () => {
    const repo = new MemoryPythonAgentRepository();
    const sandbox = new MemorySandbox((_code, _files, outputsEntries) => {
      outputsEntries.push({
        name: '../escape.csv',
        isDir: false,
        isSymlink: true,
        sizeBytes: 10,
      });
      return Promise.resolve({ exitCode: 0, stdout: 'sneaky', stderr: '' });
    });

    const { gateway } = scriptedGateway([
      {
        kind: 'tool_call',
        toolCallId: 'call_bad_output',
        code: 'import os; os.symlink("/etc/passwd", "outputs/escape.csv")',
        rawArgumentsJson: '{"code":"symlink"}',
      },
    ]);

    const outcome = await executePythonAgentRun(makeLease(), {
      mode: 'real',
      leaseQueue: { heartbeat: () => Promise.resolve(true) },
      repository: repo as unknown as PostgresPythonAgentExecutionRepository,
      blobStore: new MemoryBlobStore(),
      gateway,
      createSandbox: () => ({
        provider: sandbox,
        close: () => {
          sandbox.closedCount += 1;
          return Promise.resolve();
        },
      }),
      sandboxOwner: 'test-owner',
      policy: TEST_POLICY,
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 50_000,
        tenantDailyMicroUsd: 100_000,
        globalDailyMicroUsd: 500_000,
      },
      rate: TEST_RATE,
      leaseDurationMs: 15_000,
      attemptTimeoutMs: 5_000,
      logger: { info: () => {}, warn: () => {} },
    });

    expect(outcome).toEqual({ outcome: 'failed_terminal', reason: 'symlink_output_forbidden' });
    expect(repo.failures[0]!.errorCode).toBe('POLICY_DENIED');
    expect(sandbox.destroyedIds).toEqual(['sbx-1']);
    expect(sandbox.closedCount).toBe(1);
  });

  it('enforces Task-level budget cap and STALE_LEASE convergence without committing results', async () => {
    const exhaustedRepo = new MemoryPythonAgentRepository({
      usage: {
        taskLlmCallsUsed: PYTHON_AGENT_LIMITS.maxLlmCallsPerTask,
        taskCostMicroUsd: 0,
        runLlmCallsUsed: 0,
        taskSandboxCreatesUsed: 0,
        runSandboxCreatesUsed: 0,
        taskPythonExecsUsed: 0,
        runPythonExecsUsed: 0,
      },
    });
    const { gateway } = scriptedGateway([]);

    const exhaustedOutcome = await executePythonAgentRun(makeLease(), {
      mode: 'real',
      leaseQueue: { heartbeat: () => Promise.resolve(true) },
      repository: exhaustedRepo as unknown as PostgresPythonAgentExecutionRepository,
      blobStore: new MemoryBlobStore(),
      gateway,
      createSandbox: () => {
        throw new Error('unused');
      },
      sandboxOwner: 'test-owner',
      policy: TEST_POLICY,
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 50_000,
        tenantDailyMicroUsd: 100_000,
        globalDailyMicroUsd: 500_000,
      },
      rate: TEST_RATE,
      leaseDurationMs: 15_000,
      attemptTimeoutMs: 5_000,
      logger: { info: () => {}, warn: () => {} },
    });

    expect(exhaustedOutcome).toEqual({
      outcome: 'failed_terminal',
      reason: 'task_budget_exhausted',
    });
    expect(exhaustedRepo.failures[0]!.errorCode).toBe('BUDGET_EXCEEDED');

    const staleRepo = new MemoryPythonAgentRepository();
    staleRepo.staleOnComplete = true;
    const { gateway: staleGateway } = scriptedGateway([
      {
        kind: 'final',
        summaryText: 'Done.',
        detailText: 'Done.',
        truncated: false,
        finishReason: 'stop',
      },
    ]);

    const staleOutcome = await executePythonAgentRun(makeLease(), {
      mode: 'real',
      leaseQueue: { heartbeat: () => Promise.resolve(true) },
      repository: staleRepo as unknown as PostgresPythonAgentExecutionRepository,
      blobStore: new MemoryBlobStore(),
      gateway: staleGateway,
      createSandbox: () => {
        throw new Error('unused');
      },
      sandboxOwner: 'test-owner',
      policy: TEST_POLICY,
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 50_000,
        tenantDailyMicroUsd: 100_000,
        globalDailyMicroUsd: 500_000,
      },
      rate: TEST_RATE,
      leaseDurationMs: 15_000,
      attemptTimeoutMs: 5_000,
      logger: { info: () => {}, warn: () => {} },
    });

    expect(staleOutcome).toEqual({ outcome: 'lease_lost' });
    expect(staleRepo.failures).toHaveLength(0);
  });

  it('fails closed without model egress or sandbox when principal mapping, principal budget, or principal halt refuses', async () => {
    const cases: readonly {
      readonly reserveOutcome: PythonAgentReserveLlmOutcome;
      readonly expectedReason: string;
      readonly expectedErrorCode: 'POLICY_DENIED' | 'BUDGET_EXCEEDED';
    }[] = [
      {
        reserveOutcome: { kind: 'principal_unavailable' },
        expectedReason: 'principal_unavailable',
        expectedErrorCode: 'POLICY_DENIED',
      },
      {
        reserveOutcome: { kind: 'budget_exceeded', scope: 'principal' },
        expectedReason: 'budget_exceeded:principal',
        expectedErrorCode: 'BUDGET_EXCEEDED',
      },
      {
        reserveOutcome: {
          kind: 'budget_halted',
          scope: 'principal',
          reason: 'day_ceiling_exceeded',
        },
        expectedReason: 'budget_halted:day_ceiling_exceeded',
        expectedErrorCode: 'BUDGET_EXCEEDED',
      },
    ];

    for (const testCase of cases) {
      const repo = new MemoryPythonAgentRepository();
      repo.overrideReserveLlm = (command) => {
        expect(command.ceilings.principalDailyMicroUsd).toBe(50_000);
        return testCase.reserveOutcome;
      };
      let gatewayCalled = 0;
      const gateway: ModelGateway = {
        providerId: 'openrouter',
        modelLabel: 'nvidia/nemotron-3.5-lightning',
        simulated: false,
        operations: ['conversation.turn', 'task.notes_action_items', 'task.python_agent'],
        generateConversationTurn: () => Promise.reject(new Error('unused')),
        extractNotesActionItems: () => Promise.reject(new Error('unused')),
        stepPythonAgent: () => {
          gatewayCalled += 1;
          return Promise.reject(new Error('must not call gateway'));
        },
      };

      const outcome = await executePythonAgentRun(makeLease(), {
        mode: 'real',
        leaseQueue: { heartbeat: () => Promise.resolve(true) },
        repository: repo as unknown as PostgresPythonAgentExecutionRepository,
        blobStore: new MemoryBlobStore(),
        gateway,
        createSandbox: () => {
          throw new Error('must not create sandbox');
        },
        sandboxOwner: 'test-owner',
        policy: TEST_POLICY,
        ceilings: {
          perAttemptMicroUsd: 5_000,
          principalDailyMicroUsd: 50_000,
          tenantDailyMicroUsd: 100_000,
          globalDailyMicroUsd: 500_000,
        },
        rate: TEST_RATE,
        leaseDurationMs: 15_000,
        attemptTimeoutMs: 5_000,
        logger: { info: () => {}, warn: () => {} },
      });

      expect(outcome).toEqual({ outcome: 'failed_terminal', reason: testCase.expectedReason });
      expect(gatewayCalled).toBe(0);
      expect(repo.failures[0]!.errorCode).toBe(testCase.expectedErrorCode);
    }
  });

  it('fails terminal without launching sandbox when loadAgentContext reports aggregate file budget exceeded', async () => {
    const repo = new MemoryPythonAgentRepository();
    repo.loadAgentContext = () =>
      Promise.resolve({
        kind: 'file_budget_exceeded',
        totalBytes: 36_000_000,
        maxBytes: PYTHON_AGENT_LIMITS.maxTaskTotalFileBytes,
      });

    let sandboxCreated = false;
    let gatewayCalled = false;
    const outcome = await executePythonAgentRun(makeLease(), {
      mode: 'real',
      leaseQueue: { heartbeat: () => Promise.resolve(true) },
      repository: repo as unknown as PostgresPythonAgentExecutionRepository,
      blobStore: new MemoryBlobStore(),
      gateway: {
        providerId: 'openrouter',
        modelLabel: TEST_RATE.modelId,
        simulated: false,
        operations: ['conversation.turn', 'task.notes_action_items', 'task.python_agent'],
        generateConversationTurn: () => Promise.reject(new Error('unused')),
        extractNotesActionItems: () => Promise.reject(new Error('unused')),
        stepPythonAgent: () => {
          gatewayCalled = true;
          return Promise.reject(new Error('must not call gateway'));
        },
      },
      createSandbox: () => {
        sandboxCreated = true;
        throw new Error('must not create sandbox');
      },
      sandboxOwner: 'test-owner',
      policy: TEST_POLICY,
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 50_000,
        tenantDailyMicroUsd: 100_000,
        globalDailyMicroUsd: 500_000,
      },
      rate: TEST_RATE,
      leaseDurationMs: 15_000,
      attemptTimeoutMs: 5_000,
      logger: { info: () => {}, warn: () => {} },
    });

    expect(outcome).toEqual({
      outcome: 'failed_terminal',
      reason: 'task_file_budget_exceeded',
    });
    expect(sandboxCreated).toBe(false);
    expect(gatewayCalled).toBe(false);
    expect(repo.failures[0]!.errorCode).toBe('POLICY_DENIED');
  });

  it('allows single 15 MiB file workflows within the 32 MiB aggregate budget and rejects oversized output checkpoints', async () => {
    const fifteenMiB = PYTHON_AGENT_LIMITS.maxFileBytes;
    const inputBytes = new Uint8Array(fifteenMiB);
    inputBytes.fill(0x61);
    const repoOk = new MemoryPythonAgentRepository({
      inputFiles: [
        {
          artifactId: randomUUID(),
          filename: 'big.bin',
          mediaType: 'application/octet-stream',
          sha256: 'a'.repeat(64),
          size: fifteenMiB,
          bytes: inputBytes,
        },
      ],
    });
    const out15 = new Uint8Array(fifteenMiB);
    out15.fill(0x62);

    const { gateway: okGateway } = scriptedGateway([
      {
        kind: 'tool_call',
        toolCallId: 'call_big_ok',
        code: 'pass',
        rawArgumentsJson: '{"code":"pass"}',
      },
      {
        kind: 'final',
        summaryText: 'Done',
        detailText: '15+15 MiB OK',
        truncated: false,
        finishReason: 'stop',
      },
    ]);
    const okSandbox = new MemorySandbox((_code, files, outputsEntries) => {
      files.set('outputs/out.bin', out15);
      outputsEntries.push({
        name: 'out.bin',
        isDir: false,
        isSymlink: false,
        sizeBytes: fifteenMiB,
      });
      return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '' });
    });

    const okOutcome = await executePythonAgentRun(makeLease(), {
      mode: 'real',
      leaseQueue: { heartbeat: () => Promise.resolve(true) },
      repository: repoOk as unknown as PostgresPythonAgentExecutionRepository,
      blobStore: new MemoryBlobStore(),
      gateway: okGateway,
      createSandbox: (): PythonAgentSandboxHandle => ({
        provider: okSandbox,
        close: () => Promise.resolve(),
      }),
      sandboxOwner: 'test-owner',
      policy: TEST_POLICY,
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 50_000,
        tenantDailyMicroUsd: 100_000,
        globalDailyMicroUsd: 500_000,
      },
      rate: TEST_RATE,
      leaseDurationMs: 15_000,
      attemptTimeoutMs: 5_000,
      logger: { info: () => {}, warn: () => {} },
    });
    expect(okOutcome.outcome).toBe('succeeded');
    expect(repoOk.completions[0]!.finalStagedOutputs).toHaveLength(1);

    // Now test 15 MiB input + two 10 MiB outputs (35 MiB > 32 MiB): rejected BEFORE reading outputs.
    const repoTooBig = new MemoryPythonAgentRepository({
      inputFiles: [
        {
          artifactId: randomUUID(),
          filename: 'big.bin',
          mediaType: 'application/octet-stream',
          sha256: 'a'.repeat(64),
          size: fifteenMiB,
          bytes: inputBytes,
        },
      ],
    });
    const { gateway: bigGateway } = scriptedGateway([
      {
        kind: 'tool_call',
        toolCallId: 'call_too_big',
        code: 'pass',
        rawArgumentsJson: '{"code":"pass"}',
      },
    ]);
    let downloadCalled = false;
    const bigSandbox = new MemorySandbox((_code, _files, outputsEntries) => {
      outputsEntries.push(
        { name: 'out1.bin', isDir: false, isSymlink: false, sizeBytes: 10 * 1024 * 1024 },
        { name: 'out2.bin', isDir: false, isSymlink: false, sizeBytes: 10 * 1024 * 1024 },
      );
      return Promise.resolve({ exitCode: 0, stdout: 'big', stderr: '' });
    });
    bigSandbox.getBytesFile = () => {
      downloadCalled = true;
      return Promise.reject(new Error('should not download outputs past task aggregate budget'));
    };

    const bigOutcome = await executePythonAgentRun(makeLease(), {
      mode: 'real',
      leaseQueue: { heartbeat: () => Promise.resolve(true) },
      repository: repoTooBig as unknown as PostgresPythonAgentExecutionRepository,
      blobStore: new MemoryBlobStore(),
      gateway: bigGateway,
      createSandbox: (): PythonAgentSandboxHandle => ({
        provider: bigSandbox,
        close: () => Promise.resolve(),
      }),
      sandboxOwner: 'test-owner',
      policy: TEST_POLICY,
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 50_000,
        tenantDailyMicroUsd: 100_000,
        globalDailyMicroUsd: 500_000,
      },
      rate: TEST_RATE,
      leaseDurationMs: 15_000,
      attemptTimeoutMs: 5_000,
      logger: { info: () => {}, warn: () => {} },
    });
    expect(bigOutcome).toEqual({
      outcome: 'failed_terminal',
      reason: 'task_file_budget_exceeded',
    });
    expect(downloadCalled).toBe(false);
    expect(repoTooBig.failures[0]!.errorCode).toBe('POLICY_DENIED');
  });
});
