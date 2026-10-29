export { linkAbortSignals, realSleeper, systemExecutionClock } from './clock.js';
export type { AbortLink, ExecutionClock, Sleeper } from './clock.js';
export {
  BUDGET_DIMENSIONS,
  BUDGET_GUARD_LIMITS,
  consumeBudgetReservation,
  createBudgetLedger,
  evaluateBudget,
  releaseBudgetReservation,
  reserveBudget,
  snapshotFromLedger,
  toBudgetDeniedError,
  toUtcDayKey,
  type BudgetAllowDecision,
  type BudgetAmount,
  type BudgetDecision,
  type BudgetDenyDecision,
  type BudgetDimension,
  type BudgetLedgerScope,
  type BudgetLedgerState,
  type BudgetPolicy,
  type BudgetProjection,
  type BudgetReservation,
  type BudgetSettlement,
  type BudgetSnapshot,
  type BudgetUsage,
  type BudgetViolation,
} from './budget-guard.js';
export { sha256Hex, simulatedId } from './crypto.js';
export {
  DeterministicExecutionRouter,
  ROUTER_POLICY_VERSION,
  ROUTER_THRESHOLDS,
  ROUTE_REASONS,
  type ExecutionRouterForRun,
  type RouteReason,
  type TrustedRouteContext,
} from './execution-router.js';
export { FAKE_LLM_LIMITS, FAKE_LLM_MODEL, FakeLlm } from './fake-llm.js';
export type { FakeLlmFault, FakeLlmRequest, FakeLlmResponse, FakeLlmUsage } from './fake-llm.js';
export {
  FAKE_SANDBOX_IMAGE_DIGEST,
  FAKE_SANDBOX_LIMITS,
  FAKE_SANDBOX_OPERATIONS,
  FakeSandboxProvider,
  type FakeSandboxOperation,
  type FakeSandboxProviderOptions,
  type FakeSandboxState,
} from './fake-sandbox.js';
export {
  assertSupportedComputeOperation,
  computeSha256,
  runMockCompute,
  SUPPORTED_COMPUTE_OPERATIONS,
  type ComputeOperation,
  type MockComputeResult,
} from './mock-compute.js';
export {
  DeterministicExecutor,
  EXECUTABLE_TASK_KINDS,
  isExecutableTaskKind,
  type DeterministicExecutorOptions,
  type ExecutableTaskKind,
  type SimulatedDigestOutput,
  type SimulatedExecutionOutput,
  type SimulatedExecutionResult,
  type SimulatedExecutor,
  type SimulatedTextOutput,
} from './deterministic-executor.js';
