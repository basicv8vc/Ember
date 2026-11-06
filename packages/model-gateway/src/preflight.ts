import { ModelInputRefused } from './errors.js';
import { MODEL_LIMITS } from './limits.js';

export interface TokenPreflight {
  /** Characters that will be sent, including the fixed prompt and the JSON envelope. */
  readonly inputChars: number;
  /** Estimated input tokens. Used for pricing and reservation only, never as a security bound. */
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Model-exact token preflight, in the only form this environment can honestly provide.
 *
 * The hard bound is **characters**, because characters are ours: context text is already bounded by
 * `buildBoundedContext`, and the fixed prompt plus envelope overhead is added here. The token figure
 * is an estimate at a documented ratio and exists to size a money reservation. §8.3 of the B2
 * proposal is explicit that a 4 chars/token figure is not a hard reserve bound, so this function
 * fails closed when the estimate alone exceeds `maxInputTokens` rather than trusting it.
 */
export function preflightConversationTurn(input: {
  readonly characters: number;
  readonly maxOutputTokens: number;
}): TokenPreflight {
  if (
    !Number.isInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 1 ||
    input.maxOutputTokens > MODEL_LIMITS.maxOutputTokens
  ) {
    throw new ModelInputRefused('max_output_invalid');
  }

  if (!Number.isInteger(input.characters) || input.characters < 1) {
    throw new ModelInputRefused('context_invalid');
  }

  if (input.characters > MODEL_LIMITS.maxContextChars) {
    throw new ModelInputRefused('context_too_large');
  }

  const inputChars =
    input.characters + MODEL_LIMITS.systemPromptChars + MODEL_LIMITS.serializationOverheadChars;
  const inputTokens = Math.ceil(inputChars / MODEL_LIMITS.charsPerToken);

  if (inputTokens > MODEL_LIMITS.maxInputTokens) {
    throw new ModelInputRefused('input_tokens_over_cap');
  }

  return Object.freeze({
    inputChars,
    inputTokens,
    maxOutputTokens: input.maxOutputTokens,
  });
}
