/**
 * Hard limits for one Assistant Turn inference.
 *
 * These are the only bounds a caller can rely on, and they are enforced in characters before a
 * request is built. Token counts are an estimate we cannot verify offline; characters we own.
 * `charsPerToken` exists to *price and reserve* a call, never to prove a token bound.
 */
export const MODEL_LIMITS = Object.freeze({
  /** Last N messages of the same conversation, oldest dropped first. */
  maxContextMessages: 8,
  /** Hard character ceiling for concatenated context text. Enforced before request construction. */
  maxContextChars: 12_000,
  /** Provider-side output cap passed as `max_completion_tokens`. */
  maxOutputTokens: 512,
  /** Fixed system prompt, versioned in code with the operation it belongs to. */
  systemPromptChars: 900,
  /** JSON envelope, role labels and schema overhead added to the character estimate. */
  serializationOverheadChars: 512,
  /** One provider request may not outlive this, even when the Turn deadline allows more. */
  attemptTimeoutMs: 20_000,
  /** B1's authoritative Turn budget is 60 s, including queueing, both attempts and the commit. */
  turnDeadlineMs: 60_000,
  /** Sentinels that make an unbounded call impossible even if a caller misbehaves. */
  maxInputTokens: 8_000,
  /** Illustrative only: used with the pinned rate row to size a reservation. */
  charsPerToken: 4,
  /** At most two outbound starts per Turn; the attempt table enforces the same bound. */
  maxAttemptsPerTurn: 2,
  /** $0.005 — the largest reservation one attempt may hold. */
  maxReservedMicroUsdPerAttempt: 5_000,
  /** B2 ceiling defaults, copied into trusted configuration; the database holds the absolute cap. */
  defaultPrincipalDailyMicroUsd: 250_000,
  defaultTenantDailyMicroUsd: 1_000_000,
  defaultGlobalDailyMicroUsd: 5_000_000,
  defaultPrincipalDailyTurns: 60,
} as const);

/** Absolute ceilings the database also enforces; trusted configuration may only lower them. */
export const MODEL_BUDGET_ABSOLUTE_CEILINGS = Object.freeze({
  perAttemptMicroUsd: 5_000,
  principalDailyMicroUsd: 250_000,
  tenantDailyMicroUsd: 1_000_000,
  globalDailyMicroUsd: 5_000_000,
  principalDailyTurns: 60,
} as const);
