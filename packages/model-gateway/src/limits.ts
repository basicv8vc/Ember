/**
 * Hard limits for one Assistant Turn inference.
 *
 * These are the only bounds a caller can rely on, and they are enforced in characters before a
 * request is built. Token counts are an estimate we cannot verify offline; characters we own.
 *
 * **The token estimate is a conservative reservation upper bound, not a guarantee.** It may
 * over-count (which costs budget headroom) but it must never under-count, because a reservation that
 * is too small is a spend ceiling that does not hold. Nothing in this package may describe it as a
 * strict bound on the provider's tokenizer: the only thing that actually stops an over-charge is the
 * overage path in `model_turn_attempts` raising a halt.
 */
export const MODEL_LIMITS = Object.freeze({
  /** Last N messages of the same conversation, oldest dropped first. */
  maxContextMessages: 8,
  /** Hard character ceiling for concatenated context text. Enforced before request construction. */
  maxContextChars: 12_000,
  /** Provider-side output cap passed as `max_completion_tokens`. */
  maxOutputTokens: 512,
  /** Output cap for structured Notes -> Action Items extraction. */
  notesMaxOutputTokens: 1_024,
  /** Output cap for each Python agent step (code generation or final summary). */
  pythonAgentMaxOutputTokens: 1_536,
  /** Hard character ceiling for Python agent step prompt + history. */
  pythonAgentMaxContextChars: 24_000,
  /** Bounded result text fields matching 0013_task_results.sql. */
  resultSummaryMaxChars: 2_048,
  resultDetailMaxChars: 16_384,
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
  /** Per-Task ceiling on cumulative model attempts across Runs/retries (<= placement §11.3 cap of 6). */
  maxModelAttemptsPerTask: 4,
  /** Per-Task cumulative reserved/applied model spend ceiling in micro-USD ($0.02). */
  maxModelCostPerTaskMicroUsd: 20_000,
  /**
   * ASCII characters per token, as used to *price* a request. Real tokenizers are near 4 for English
   * prose; this figure is a planning ratio and proves nothing about any actual request.
   */
  asciiCharsPerToken: 4,
  /**
   * Token weight assumed for **one non-ASCII code point**.
   *
   * `charsPerToken = 4` is a Latin-script assumption. Chinese text is the counter-example that
   * matters here: a Han character is commonly 1-2 tokens under current tokenizers, so pricing it at
   * a quarter of a token under-reserved the call by roughly an order of magnitude. CJK, emoji and
   * combining marks are therefore priced at 2 tokens per code point, which over-counts rather than
   * under-counts.
   */
  nonAsciiTokensPerChar: 2,
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

/**
 * Conservative token estimate for one string, in code points.
 *
 * ASCII is priced at 4 characters per token; everything else at
 * `nonAsciiTokensPerChar` tokens per code point. Iterating code points (not UTF-16 units) matters:
 * a single emoji is two units and would otherwise be counted twice.
 *
 * The result is an upper bound *for reservation purposes only*. It is intentionally pessimistic
 * about non-Latin scripts, and a caller must refuse a request rather than shrink the reservation to
 * fit a cap.
 */
export function estimateTokensConservative(text: string): number {
  let asciiCharacters = 0;
  let otherCodePoints = 0;

  for (const character of text) {
    if (character.codePointAt(0)! < 0x80) {
      asciiCharacters += 1;
    } else {
      otherCodePoints += 1;
    }
  }

  return (
    Math.ceil(asciiCharacters / MODEL_LIMITS.asciiCharsPerToken) +
    otherCodePoints * MODEL_LIMITS.nonAsciiTokensPerChar
  );
}

/** Token allowance for the fixed envelope, priced as ASCII. */
export function serializationOverheadTokens(): number {
  return Math.ceil(MODEL_LIMITS.serializationOverheadChars / MODEL_LIMITS.asciiCharsPerToken);
}
