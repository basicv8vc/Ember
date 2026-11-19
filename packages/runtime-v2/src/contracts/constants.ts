import { PYTHON_AGENT_LIMITS } from '@ember/contracts';
import { MODEL_BUDGET_ABSOLUTE_CEILINGS, MODEL_LIMITS } from '@ember/model-gateway';

/**
 * Frozen timing parameters for V2 Agent Head, Interactive Fast Path,
 * B1 waitUntil compatibility, and D1 Recovery Registry (V2-M0-A §6.1 & §8.1).
 */
export const V2_TIMING_LIMITS = Object.freeze({
  /** SSE streaming interactive lease duration (ms). */
  sseLeaseDurationMs: 45_000,
  /** SSE active streaming lease renewal interval (ms), strictly < lease / 2. */
  sseLeaseRenewIntervalMs: 15_000,
  /** SSE interactive reasoning window before durable handoff (ms). */
  sseInteractiveDeadlineMs: 120_000,
  /** SSE soft handoff window bounds (ms). */
  sseSoftHandoffWindowStartMs: 105_000,
  sseSoftHandoffWindowEndMs: 115_000,
  /** V2 long-turn handoff total lifetime budget (ms). */
  sseLongTurnDeadlineMs: 600_000,

  /** B1 non-streaming `ctx.waitUntil()` bounded fast lease (ms, strictly < CF 30s limit). */
  b1WaitUntilLeaseDurationMs: 25_000,
  /** B1 non-streaming `ctx.waitUntil()` soft handoff window (ms). */
  b1WaitUntilInteractiveDeadlineMs: 22_000,
  /** Frozen B1 total Turn lifetime deadline (ms). */
  b1TurnDeadlineMs: MODEL_LIMITS.turnDeadlineMs,

  /** Durable queue worker default and ceiling lease durations (ms). */
  durableDefaultLeaseMs: 30_000,
  durableMaxLeaseMs: 45_000,

  /** Delay past active fast lease expiry before durable fallback outbox fires (ms). */
  fastPathOutboxGraceMs: 5_000,
  /** Common independent discovery grace bound D(O) = due + D1_RECOVERY_GRACE_MS (ms). */
  d1RecoveryGraceMs: 45_000,
  /** Additional GlobalBudgetDO grant TTL slack past max(lease, turnDeadline) (ms). */
  globalGrantTtlGraceMs: 30_000,
  /** Default send authorization validity window returned by Global/Agent Head (ms). */
  sendAuthorizeWindowMs: 30_000,

  /** Single non-streaming provider HTTP attempt timeout (ms). */
  attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
  /** Streaming first-token / idle-chunk timeout (ms). */
  streamIdleTimeoutMs: 30_000,

  /** Bounded Alarm batch size per duty cycle (V2-M0-B §3.1). */
  alarmBatchLimit: 10,
} as const);

/**
 * Inherited V1 spend ceilings and per-Task cumulative limits (V2-M0-A §5.2 & §7).
 */
export const V2_BUDGET_LIMITS = Object.freeze({
  perAttemptMicroUsd: MODEL_BUDGET_ABSOLUTE_CEILINGS.perAttemptMicroUsd,
  principalDailyMicroUsd: MODEL_BUDGET_ABSOLUTE_CEILINGS.principalDailyMicroUsd,
  tenantDailyMicroUsd: MODEL_BUDGET_ABSOLUTE_CEILINGS.tenantDailyMicroUsd,
  globalDailyMicroUsd: MODEL_BUDGET_ABSOLUTE_CEILINGS.globalDailyMicroUsd,
  principalDailyTurns: MODEL_BUDGET_ABSOLUTE_CEILINGS.principalDailyTurns,
  maxAttemptsPerTurn: MODEL_LIMITS.maxAttemptsPerTurn,
  maxModelAttemptsPerTask: MODEL_LIMITS.maxModelAttemptsPerTask,
  maxModelCostPerTaskMicroUsd: MODEL_LIMITS.maxModelCostPerTaskMicroUsd,
  pythonAgentMaxLlmCallsPerRun: PYTHON_AGENT_LIMITS.maxLlmCallsPerRun,
  pythonAgentMaxLlmCallsPerTask: PYTHON_AGENT_LIMITS.maxLlmCallsPerTask,
  pythonAgentMaxTaskCostMicroUsd: PYTHON_AGENT_LIMITS.maxTaskCostMicroUsd,
} as const);

/**
 * Inherited B1 abuse-guard and fixed safe failure response constants.
 * Mirrors `packages/postgres/src/repositories/b1-conversation-write.ts` & `b1-turn-publication.ts`.
 */
export const V2_B1_COMPAT_CONSTANTS = Object.freeze({
  messageQuotaLimit: 200,
  messageQuotaWindowMs: 24 * 60 * 60 * 1_000,
  maxContextMessages: MODEL_LIMITS.maxContextMessages,
  simulatedModelLabel: 'ember-fake-llm-1',
  failureAssistantMessageText: 'This simulated reply could not be completed. Please try again.',
} as const);
