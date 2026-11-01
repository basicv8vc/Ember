import type {
  RouteDecision,
  RunExecutionContext,
  SandboxProvider,
  SandboxProviderFactory,
  SandboxSpec,
  SandboxUsageRecord,
} from '@ember/contracts';
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
import {
  FAKE_SANDBOX_IMAGE_DIGEST,
  FakeSandboxProvider,
  FakeSandboxProviderFactory,
} from './fake-sandbox.js';
import { assertSupportedComputeOperation, computeSha256 } from './mock-compute.js';
import { SandboxAdapter, withBoundedTimeout } from './sandbox-adapter.js';
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

export interface SimulatedApprovalOutput {
  readonly type: 'approval';
  readonly action: string;
  readonly reason: string;
  readonly actionDigest: string;
  readonly usage: SandboxUsageRecord;
}

export type SimulatedExecutionOutput =
  SimulatedTextOutput | SimulatedDigestOutput | SimulatedApprovalOutput;

export function canonicalApprovalActionPayload(input: {
  readonly action: string;
  readonly reason?: string | undefined;
}): string {
  return JSON.stringify({ action: input.action, reason: input.reason ?? '' });
}

export function computeApprovalActionDigest(input: {
  readonly action: string;
  readonly reason?: string | undefined;
}): string {
  return computeSha256(canonicalApprovalActionPayload(input)).value;
}

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
  executeApproval?(
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
  /** Optional observer invoked when a FakeSandboxProvider is created for a Run. */
  readonly onSandboxProvider?: (provider: FakeSandboxProvider) => void;
  /** Optional factory for creating Run-scoped SandboxProvider instances; defaults to in-memory fake factory. */
  readonly sandboxFactory?: SandboxProviderFactory;
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
  private readonly onSandboxProvider: ((provider: FakeSandboxProvider) => void) | undefined;
  private readonly sandboxFactory: SandboxProviderFactory;

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
    this.onSandboxProvider = options.onSandboxProvider;
    this.sandboxFactory =
      options.sandboxFactory ??
      new FakeSandboxProviderFactory({
        clock: this.clock,
        sleep: this.sleep,
        execDurationMs: this.sandboxExecDurationMs,
      });
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

  /**
   * Execute the pre-approval preparation step for `mock.approval` inside a transient
   * `FakeSandboxProvider` session (`create → waitReady → exec → readOutput → usage → stop → destroy`).
   *
   * This is separate from {@link execute} so the non-durable P0B-05 handler continues to
   * refuse `mock.approval` without an `ApprovalRepository`, while the P0B-08d durable worker
   * exercises the full sandbox lifecycle and guarantees the sandbox is destroyed before
   * entering `waiting_approval`.
   */
  async executeApproval(
    ctx: RunExecutionContext,
    route: RouteDecision,
    signal: AbortSignal,
  ): Promise<SimulatedExecutionResult> {
    const kind = parseTaskKind(ctx.kind);

    if (kind !== 'mock.approval') {
      throw new DomainError('POLICY_DENIED', 'executeApproval only accepts mock.approval tasks');
    }

    const input = parseTaskInput(kind, ctx.input) as Extract<
      ReturnType<typeof parseTaskInput>,
      { action: string }
    >;

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
      const reason = input.reason ?? '';
      const payload = canonicalApprovalActionPayload({
        action: input.action,
        reason,
      });
      const sandbox = await this.runInSandbox(ctx, route, 'sha256', payload, signal);

      return this.result(ctx, route, startedAt, startedAtHr, sandbox.sandboxId, {
        type: 'approval',
        action: input.action,
        reason,
        actionDigest: sandbox.digest,
        usage: sandbox.usage,
      });
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
    throwIfAborted(signal);
    const sizing = SANDBOX_SPEC_BY_ROUTE[route.path];

    const provider = await this.resolveSandboxProvider(ctx, signal);

    if (provider instanceof FakeSandboxProvider) {
      this.onSandboxProvider?.(provider);
    }

    const adapter = new SandboxAdapter(provider, {
      readyDeadlineMs: this.sandboxReadyDeadlineMs,
      execTimeoutMs: this.sandboxExecTimeoutMs,
      cleanupTimeoutMs: Math.min(this.sandboxExecTimeoutMs, 5_000),
    });

    const spec: SandboxSpec = {
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      imageDigest: FAKE_SANDBOX_IMAGE_DIGEST,
      cpuMilli: sizing.cpuMilli,
      memoryMiB: sizing.memoryMiB,
      maxLifetimeSec: SANDBOX_MAX_LIFETIME_SEC,
      networkPolicyId: 'none',
    };

    const res = await adapter.run({
      spec,
      argv: ['sha256', text],
      signal,
      readyDeadlineMs: this.sandboxReadyDeadlineMs,
      execTimeoutMs: this.sandboxExecTimeoutMs,
      beforeExec: () => {
        // Reject an unsupported operation before the sandbox is asked to do anything.
        assertSupportedComputeOperation(operation);
      },
    });

    return {
      sandboxId: res.sandboxId,
      digest: res.digest,
      usage: res.usage,
    };
  }

  private async resolveSandboxProvider(
    ctx: RunExecutionContext,
    signal: AbortSignal,
  ): Promise<SandboxProvider> {
    const factoryTimeoutMs = Math.min(this.sandboxReadyDeadlineMs, 5_000);
    const provider = await withBoundedTimeout<SandboxProvider>(
      () =>
        this.sandboxFactory.createProvider({
          tenantId: ctx.tenantId,
          runId: ctx.runId,
          signal,
        }),
      factoryTimeoutMs,
      'factory_create',
      signal,
    );

    const candidate = provider as unknown;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof (candidate as Record<string, unknown>)['create'] !== 'function' ||
      typeof (candidate as Record<string, unknown>)['exec'] !== 'function'
    ) {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox factory returned an invalid provider');
    }

    return provider;
  }
}
