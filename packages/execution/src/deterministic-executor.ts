import type { RouteDecision, RunExecutionContext, SandboxUsageRecord } from '@ember/contracts';
import { DomainError, type ExecutionPath, type Id, type TaskKind } from '@ember/domain';
import {
  parseBoundedTimeoutMs,
  parseDelayMs,
  parseExecutionNow,
  realSleeper,
  systemExecutionClock,
  throwIfAborted,
  type ExecutionClock,
  type Sleeper,
} from './clock.js';
import { FakeLlm, type FakeLlmUsage } from './fake-llm.js';
import { FAKE_SANDBOX_IMAGE_DIGEST, FakeSandboxProvider } from './fake-sandbox.js';
import { assertSupportedComputeOperation } from './mock-compute.js';
import { parseTaskInput, parseTaskKind } from './validation.js';

/**
 * Task kinds that P0B-05 can *actually* execute.
 *
 * This list is the single source of truth for claim eligibility as well: the worker only
 * claims these kinds, so a `mock.file`/`mock.approval` Task is never claimed and then failed
 * because the feature is missing. P0B-06 (durable file results) and P0B-08 (approvals)
 * extend this list together with their own executor branch.
 */
export const EXECUTABLE_TASK_KINDS = ['mock.chat', 'mock.compute'] as const;

export type ExecutableTaskKind = (typeof EXECUTABLE_TASK_KINDS)[number];

export function isExecutableTaskKind(kind: TaskKind): kind is ExecutableTaskKind {
  return (EXECUTABLE_TASK_KINDS as readonly TaskKind[]).includes(kind);
}

export interface SimulatedTextOutput {
  readonly type: 'text';
  /** In-memory only. Never persisted before P0B-06. */
  readonly text: string;
  readonly usage: FakeLlmUsage;
}

export interface SimulatedDigestOutput {
  readonly type: 'sha256';
  readonly sha256: string;
  readonly usage: SandboxUsageRecord;
}

export type SimulatedExecutionOutput = SimulatedTextOutput | SimulatedDigestOutput;

/**
 * Outcome of one simulated execution.
 *
 * `durable: false` is deliberate: no ArtifactStore, Workspace CAS or result table exists in
 * P0B-05, so this result must never be described as a persisted artifact or as something a
 * restarted process could recover.
 */
export interface SimulatedExecutionResult {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly kind: TaskKind;
  readonly route: ExecutionPath;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly simulated: true;
  readonly durable: false;
  /** Simulated sandbox that produced the output, if one was used. It has been destroyed. */
  readonly sandboxId: Id | null;
  readonly output: SimulatedExecutionOutput;
}

export interface SimulatedExecutor {
  execute(
    ctx: RunExecutionContext,
    route: RouteDecision,
    signal: AbortSignal,
  ): Promise<SimulatedExecutionResult>;
}

export interface DeterministicExecutorOptions {
  readonly clock?: ExecutionClock;
  readonly sleep?: Sleeper;
  /** Injectable generator (used for deterministic fault injection in tests). */
  readonly llm?: FakeLlm;
  readonly llmDelayMs?: number;
  /** Simulated sandbox exec duration; drives the simulated usage counters. */
  readonly sandboxExecDurationMs?: number;
  /** Simulated `waitReady` deadline for the sandbox. */
  readonly sandboxReadyDeadlineMs?: number;
  /** Simulated exec timeout passed to `SandboxProvider.exec`. */
  readonly sandboxExecTimeoutMs?: number;
}

const SANDBOX_SPEC_BY_ROUTE: Readonly<
  Record<ExecutionPath, { readonly cpuMilli: number; readonly memoryMiB: number }>
> = Object.freeze({
  fast: { cpuMilli: 100, memoryMiB: 128 },
  standard: { cpuMilli: 250, memoryMiB: 256 },
  // Allowed by the contract, but never an excuse to allocate a real expensive resource: the
  // FakeSandbox only records simulated numbers in memory.
  heavy: { cpuMilli: 500, memoryMiB: 512 },
});

const SANDBOX_MAX_LIFETIME_SEC = 60;

/**
 * Executes the deterministic mock task kinds.
 *
 * `mock.chat` uses {@link FakeLlm}; `mock.compute` runs through the {@link FakeSandboxProvider}
 * lifecycle (create → waitReady → exec → stop → destroy) so the sandbox seam is exercised by
 * real code rather than by a unit test only. Anything else fails closed with `POLICY_DENIED`;
 * the worker never claims such a Task in the first place.
 */
export class DeterministicExecutor implements SimulatedExecutor {
  private readonly clock: ExecutionClock;
  private readonly sleep: Sleeper;
  private readonly llm: FakeLlm;
  private readonly sandboxExecDurationMs: number;
  private readonly sandboxReadyDeadlineMs: number;
  private readonly sandboxExecTimeoutMs: number;

  constructor(options: DeterministicExecutorOptions = {}) {
    this.clock = options.clock ?? systemExecutionClock;
    this.sleep = options.sleep ?? realSleeper;
    this.llm = options.llm ?? new FakeLlm({ sleep: this.sleep, delayMs: options.llmDelayMs ?? 0 });
    this.sandboxExecDurationMs = parseDelayMs(
      options.sandboxExecDurationMs,
      'sandboxExecDurationMs',
      5_000,
      1,
    );
    this.sandboxReadyDeadlineMs = parseBoundedTimeoutMs(
      options.sandboxReadyDeadlineMs ?? 5_000,
      'sandboxReadyDeadlineMs',
      60_000,
    );
    this.sandboxExecTimeoutMs = parseBoundedTimeoutMs(
      options.sandboxExecTimeoutMs ?? 10_000,
      'sandboxExecTimeoutMs',
      60_000,
    );
  }

  async execute(
    ctx: RunExecutionContext,
    route: RouteDecision,
    signal: AbortSignal,
  ): Promise<SimulatedExecutionResult> {
    const kind = parseTaskKind(ctx.kind);

    if (!isExecutableTaskKind(kind)) {
      throw new DomainError('POLICY_DENIED', 'task kind has no executor in this build');
    }

    // Re-validate persisted input at the execution boundary: a database row is data, not a
    // type guarantee.
    const input = parseTaskInput(kind, ctx.input);

    if (ctx.deadlineAt !== null) {
      const deadline = new Date(ctx.deadlineAt);
      const now = parseExecutionNow(this.clock.now(), 'clock.now()');

      if (!Number.isFinite(deadline.getTime())) {
        throw new DomainError('DB_UNAVAILABLE', 'persisted task deadline is not a valid instant');
      }

      if (deadline.getTime() <= now.getTime()) {
        throw new DomainError('DEADLINE_EXCEEDED', 'task deadline elapsed before execution');
      }
    }

    throwIfAborted(signal);

    const startedAt = parseExecutionNow(this.clock.now(), 'clock.now()');
    const startedAtHr = performance.now();

    try {
      switch (kind) {
        case 'mock.chat': {
          const chat = input as Extract<typeof input, { prompt: string }>;
          const response = await this.llm.generate(
            { prompt: chat.prompt, maxOutputTokens: chat.maxOutputTokens },
            signal,
          );

          return this.result(ctx, route, startedAt, startedAtHr, null, {
            type: 'text',
            text: response.text,
            usage: response.usage,
          });
        }

        case 'mock.compute': {
          const compute = input as Extract<typeof input, { text: string }>;
          const sandbox = await this.runInSandbox(
            ctx,
            route,
            compute.operation,
            compute.text,
            signal,
          );

          return this.result(ctx, route, startedAt, startedAtHr, sandbox.sandboxId, {
            type: 'sha256',
            sha256: sandbox.digest,
            usage: sandbox.usage,
          });
        }

        default:
          throw new DomainError('POLICY_DENIED', 'task kind has no executor in this build');
      }
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    }
  }

  private result(
    ctx: RunExecutionContext,
    route: RouteDecision,
    startedAt: Date,
    startedAtHr: number,
    sandboxId: Id | null,
    output: SimulatedExecutionOutput,
  ): SimulatedExecutionResult {
    return Object.freeze({
      tenantId: ctx.tenantId,
      taskId: ctx.taskId,
      runId: ctx.runId,
      kind: ctx.kind,
      route: route.path,
      startedAt: startedAt.toISOString(),
      durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
      simulated: true as const,
      durable: false as const,
      sandboxId,
      output,
    });
  }

  /**
   * Drive one deterministic operation through the full sandbox lifecycle.
   *
   * The provider is tenant-scoped and bound to this Run's abort signal, so cancellation and
   * lease loss stop the simulation. The sandbox is always stopped and destroyed, and its
   * simulated usage is read before destruction (usage after destroy fails closed).
   */
  private async runInSandbox(
    ctx: RunExecutionContext,
    route: RouteDecision,
    operation: unknown,
    text: string,
    signal: AbortSignal,
  ): Promise<{ sandboxId: Id; digest: string; usage: SandboxUsageRecord }> {
    const sizing = SANDBOX_SPEC_BY_ROUTE[route.path];
    const provider = new FakeSandboxProvider({
      tenantId: ctx.tenantId,
      clock: this.clock,
      sleep: this.sleep,
      signal,
      execDurationMs: this.sandboxExecDurationMs,
    });

    const { sandboxId } = await provider.create({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      imageDigest: FAKE_SANDBOX_IMAGE_DIGEST,
      cpuMilli: sizing.cpuMilli,
      memoryMiB: sizing.memoryMiB,
      maxLifetimeSec: SANDBOX_MAX_LIFETIME_SEC,
      networkPolicyId: 'none',
    });

    try {
      await provider.waitReady(sandboxId, this.sandboxReadyDeadlineMs);

      // Reject an unsupported operation before the sandbox is asked to do anything. The
      // digest itself is produced by the simulated command below, so this only validates.
      assertSupportedComputeOperation(operation);

      const exec = await provider.exec(sandboxId, ['sha256', text], this.sandboxExecTimeoutMs);

      if (exec.exitCode !== 0) {
        throw new DomainError('MOCK_TOOL_FAILED', 'simulated sandbox command did not succeed');
      }

      const digest = await provider.readOutput(sandboxId, exec.stdoutRef);
      const usage = await provider.usage(sandboxId);

      return { sandboxId, digest, usage };
    } finally {
      await provider.stop(sandboxId).catch(() => undefined);
      await provider.destroy(sandboxId).catch(() => undefined);
    }
  }
}
