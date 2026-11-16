import { CONVERSATION_SYSTEM_PROMPT, NOTES_ACTION_ITEMS_SYSTEM_PROMPT } from './context.js';
import { ModelInputRefused } from './errors.js';
import { MODEL_LIMITS, estimateTokensConservative, serializationOverheadTokens } from './limits.js';

export interface TokenPreflight {
  /** Characters that will be sent, including the fixed prompt and the JSON envelope. */
  readonly inputChars: number;
  /**
   * Conservative token estimate. Used to size a money reservation and to fail a request closed; it
   * is **not** a proof of what the provider will tokenize, and must never be presented as one.
   */
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
}

import { DELEGATION_TOOLS_TOKEN_ESTIMATE } from './providers/shared.js';

/** Fixed prompt and tool schema token estimates, computed once: compile-time constants. */
const SYSTEM_PROMPT_TOKENS = estimateTokensConservative(CONVERSATION_SYSTEM_PROMPT);
const NOTES_SYSTEM_PROMPT_TOKENS = estimateTokensConservative(NOTES_ACTION_ITEMS_SYSTEM_PROMPT);
const OVERHEAD_TOKENS = serializationOverheadTokens();

/**
 * Input preflight, in the only form this environment can honestly provide.
 *
 * Two different bounds are applied, and they are not interchangeable:
 *
 * 1. **Characters** are ours. `buildBoundedContext` already truncated the transcript, and the fixed
 *    prompt plus envelope overhead are added here. This is a hard, exact bound.
 * 2. **Tokens** are an estimate. It is priced conservatively (`estimateTokensConservative`) so that
 *    a reservation is never smaller than the likely charge, but it remains an estimate: the
 *    provider's tokenizer, cached-token accounting and price changes can all make the invoice larger
 *    than this number. That is why exceeding the *reservation* is a halting condition in the ledger
 *    rather than an impossible state here.
 *
 * The estimate is computed per message from the actual text rather than from a character count,
 * because a character count divided by four is a Latin-script assumption: 12 000 characters of
 * Chinese is roughly twelve times the token count that formula implies.
 */
export function preflightConversationTurn(input: {
  readonly messages: readonly { readonly text: string }[];
  readonly maxOutputTokens: number;
}): TokenPreflight {
  if (
    !Number.isInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 1 ||
    input.maxOutputTokens > MODEL_LIMITS.maxOutputTokens
  ) {
    throw new ModelInputRefused('max_output_invalid');
  }

  if (input.messages.length === 0) {
    throw new ModelInputRefused('no_context');
  }

  let messageChars = 0;
  let messageTokens = 0;

  for (const message of input.messages) {
    if (typeof message.text !== 'string') {
      throw new ModelInputRefused('context_invalid');
    }

    messageChars += message.text.length;
    messageTokens += estimateTokensConservative(message.text);
  }

  if (!Number.isInteger(messageChars) || messageChars < 1) {
    throw new ModelInputRefused('context_invalid');
  }

  if (messageChars > MODEL_LIMITS.maxContextChars) {
    throw new ModelInputRefused('context_too_large');
  }

  const inputChars =
    messageChars + MODEL_LIMITS.systemPromptChars + MODEL_LIMITS.serializationOverheadChars;
  const inputTokens =
    messageTokens + SYSTEM_PROMPT_TOKENS + DELEGATION_TOOLS_TOKEN_ESTIMATE + OVERHEAD_TOKENS;

  if (inputTokens > MODEL_LIMITS.maxInputTokens) {
    throw new ModelInputRefused('input_tokens_over_cap');
  }

  return Object.freeze({
    inputChars,
    inputTokens,
    maxOutputTokens: input.maxOutputTokens,
  });
}

export function preflightNotesActionItems(input: {
  readonly notes: string;
  readonly instructions?: string;
  readonly title?: string;
  readonly maxOutputTokens?: number;
}): TokenPreflight {
  const maxOutputTokens = input.maxOutputTokens ?? MODEL_LIMITS.notesMaxOutputTokens;
  if (
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > MODEL_LIMITS.notesMaxOutputTokens
  ) {
    throw new ModelInputRefused('max_output_invalid');
  }

  if (typeof input.notes !== 'string' || input.notes.trim().length === 0) {
    throw new ModelInputRefused('context_invalid');
  }

  const userPayloadChars =
    input.notes.length + (input.instructions?.length ?? 0) + (input.title?.length ?? 0);
  if (userPayloadChars > MODEL_LIMITS.maxContextChars) {
    throw new ModelInputRefused('context_too_large');
  }

  const userTokens =
    estimateTokensConservative(input.notes) +
    (input.instructions === undefined ? 0 : estimateTokensConservative(input.instructions)) +
    (input.title === undefined ? 0 : estimateTokensConservative(input.title));

  const inputChars =
    userPayloadChars + MODEL_LIMITS.systemPromptChars + MODEL_LIMITS.serializationOverheadChars;
  const inputTokens = userTokens + NOTES_SYSTEM_PROMPT_TOKENS + OVERHEAD_TOKENS;

  if (inputTokens > MODEL_LIMITS.maxInputTokens) {
    throw new ModelInputRefused('input_tokens_over_cap');
  }

  return Object.freeze({
    inputChars,
    inputTokens,
    maxOutputTokens,
  });
}
