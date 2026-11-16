import type { ExecutionRouter, RouteDecision, RunExecutionContext } from '@ember/contracts';
import type {
  AuthContext,
  ExecutionPath,
  MockTaskInput,
  TaskCommand,
  TaskInputByKind,
  TaskKind,
} from '@ember/domain';
import { parsePolicyVersion, parseTaskInput, parseTaskKind } from './validation.js';

/**
 * Revision of the routing table implemented by this module.
 *
 * P0B-05 ships exactly one revision, so routing behaviour cannot change without a code
 * change and a review. `RouteDecision.policyVersion` is a *different* value: it reports the
 * trusted server-side policy version of the caller/agent (see
 * `docs/P0B-05-IMPLEMENTATION.md` §3.3), never the router revision and never client input.
 */
export const ROUTER_POLICY_VERSION = 1;

/**
 * Bounded, content-independent routing thresholds.
 *
 * Every threshold is a size on the already validated input. No value here is derived from
 * the request body in a way that could let a client choose an execution tier.
 */
export const ROUTER_THRESHOLDS = Object.freeze({
  /** `mock.chat` stays on `fast` while both prompt size and the requested output cap are small. */
  chatFastPromptChars: 256,
  chatFastMaxOutputTokens: 256,
  /** `mock.compute` stays on `fast` while the hashed payload is small. */
  computeFastTextChars: 512,
  /** `mock.file` uses `standard` up to this content size and `heavy` above it. */
  fileStandardContentChars: 8_192,
});

/**
 * Closed set of stable routing explanations.
 *
 * A reason must never contain prompt text, file content, identifiers or any other variable
 * data. Callers and tests can assert membership in this set instead of matching free text.
 */
export const ROUTE_REASONS = [
  'chat_short_prompt_fast',
  'chat_long_prompt_standard',
  'chat_large_output_cap_standard',
  'compute_small_input_fast',
  'compute_large_input_standard',
  'file_small_content_standard',
  'file_large_content_heavy',
  'approval_policy_standard',
  'notes_action_items_standard',
  'python_agent_heavy',
] as const;

export type RouteReason = (typeof ROUTE_REASONS)[number];

/**
 * The only inputs the routing policy is allowed to observe.
 *
 * It is a projection of the trusted `RunExecutionContext`: the worker never invents an
 * `AuthContext` (there is no verified end-user principal at execution time), and it never
 * routes on client-controlled fields. `TaskCommand` remains the single task vocabulary; this
 * type adds no second task shape.
 */
export type TrustedRouteContext = Pick<RunExecutionContext, 'policyVersion' | 'kind' | 'input'>;

/**
 * Router entry point used by the worker.
 *
 * Kept separate (and narrower) than `ExecutionRouter` so an execution-side caller cannot
 * fabricate an `AuthContext`. `DeterministicExecutionRouter` implements both interfaces and
 * both delegate to the same pure policy function.
 */
export interface ExecutionRouterForRun {
  decideForExecution(ctx: TrustedRouteContext): Promise<RouteDecision>;
}

interface RouteMetrics {
  readonly size: number;
  readonly maxOutputTokens: number;
}

function metricsOf(kind: TaskKind, input: MockTaskInput): RouteMetrics {
  switch (kind) {
    case 'mock.chat': {
      const chat = input as TaskInputByKind['mock.chat'];
      return { size: chat.prompt.length, maxOutputTokens: chat.maxOutputTokens ?? 0 };
    }
    case 'mock.compute': {
      const compute = input as TaskInputByKind['mock.compute'];
      return { size: compute.text.length, maxOutputTokens: 0 };
    }
    case 'mock.file': {
      const file = input as TaskInputByKind['mock.file'];
      return { size: file.content.length, maxOutputTokens: 0 };
    }
    case 'mock.approval': {
      const approval = input as TaskInputByKind['mock.approval'];
      return { size: approval.action.length, maxOutputTokens: 0 };
    }
    case 'notes.action_items': {
      const notes = input as TaskInputByKind['notes.action_items'];
      return { size: notes.notes.length, maxOutputTokens: 0 };
    }
    case 'python.agent': {
      const py = input as TaskInputByKind['python.agent'];
      return { size: py.prompt.length, maxOutputTokens: 0 };
    }
  }
}

function decision(path: ExecutionPath, reason: RouteReason, policyVersion: number): RouteDecision {
  return Object.freeze({ path, reason, policyVersion });
}

/**
 * Pure routing policy.
 *
 * Deterministic: the decision depends only on the validated kind, the payload size and the
 * trusted policy version. There is no randomness, no clock, no network, no database and no
 * mutable state, so repeated calls with the same input return an equal decision.
 */
function routeFor(input: TrustedRouteContext): RouteDecision {
  const policyVersion = parsePolicyVersion(input.policyVersion);
  const kind = parseTaskKind(input.kind);
  // Re-validating here means a forged payload cannot reach the threshold comparison.
  const validated = parseTaskInput(kind, input.input);
  const metrics = metricsOf(kind, validated);

  switch (kind) {
    case 'mock.chat':
      if (metrics.size > ROUTER_THRESHOLDS.chatFastPromptChars) {
        return decision('standard', 'chat_long_prompt_standard', policyVersion);
      }
      if (metrics.maxOutputTokens > ROUTER_THRESHOLDS.chatFastMaxOutputTokens) {
        return decision('standard', 'chat_large_output_cap_standard', policyVersion);
      }
      return decision('fast', 'chat_short_prompt_fast', policyVersion);

    case 'mock.compute':
      return metrics.size > ROUTER_THRESHOLDS.computeFastTextChars
        ? decision('standard', 'compute_large_input_standard', policyVersion)
        : decision('fast', 'compute_small_input_fast', policyVersion);

    // Routing only. Durable file output (ArtifactStore/Workspace CAS) is P0B-06, so a
    // `heavy` decision here never allocates real expensive resources.
    case 'mock.file':
      return metrics.size > ROUTER_THRESHOLDS.fileStandardContentChars
        ? decision('heavy', 'file_large_content_heavy', policyVersion)
        : decision('standard', 'file_small_content_standard', policyVersion);

    // Recognised by policy only; the approval workflow is P0B-08.
    case 'mock.approval':
      return decision('standard', 'approval_policy_standard', policyVersion);

    case 'notes.action_items':
      return decision('standard', 'notes_action_items_standard', policyVersion);

    case 'python.agent':
      return decision('heavy', 'python_agent_heavy', policyVersion);
  }
}

/**
 * Deterministic server-side execution-path router.
 *
 * Two entry points, one policy:
 * - `decide(ctx, cmd)` is the contract method for a future request-path caller that already
 *   holds a verified `AuthContext` (P0B-07);
 * - `decideForExecution(ctx)` is the worker entry point, driven only by the trusted,
 *   database-derived execution context.
 */
export class DeterministicExecutionRouter implements ExecutionRouter, ExecutionRouterForRun {
  readonly policyVersion = ROUTER_POLICY_VERSION;

  decide(ctx: AuthContext, cmd: TaskCommand): Promise<RouteDecision> {
    // Rejections, not synchronous throws: the contract method always returns a promise, so a
    // caller has exactly one failure mode to handle.
    return Promise.resolve().then(() =>
      routeFor({ policyVersion: ctx.policyVersion, kind: cmd.kind, input: cmd.input }),
    );
  }

  decideForExecution(ctx: TrustedRouteContext): Promise<RouteDecision> {
    return Promise.resolve().then(() => routeFor(ctx));
  }
}
