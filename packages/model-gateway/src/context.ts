import { ModelInputRefused } from './errors.js';
import { MODEL_LIMITS } from './limits.js';
import type { ModelMessage } from './types.js';

/**
 * The fixed system prompt. It is versioned with the operation it belongs to and lives in code, not
 * in configuration: a configurable prompt would be an unreviewable change to what leaves the
 * platform. Its character count is part of the input bound.
 */
export const CONVERSATION_SYSTEM_PROMPT = [
  'You are Ember, a concise personal assistant inside a mobile chat.',
  'Answer in the language of the most recent user message.',
  'Be direct and specific; prefer short paragraphs over lists unless the user asked for a list.',
  'If you are unsure, say so instead of inventing facts, dates, prices or commitments.',
  'You cannot browse, run code, or act outside this conversation; never claim you did.',
].join(' ');

/** One transcript row as read from the conversation, in ascending `sequence` order. */
export interface ContextRow {
  readonly sequence: number;
  readonly kind: 'user' | 'ember';
  readonly text: string;
}

export interface BoundedContext {
  readonly messages: readonly ModelMessage[];
  readonly characters: number;
  readonly droppedMessages: number;
}

/**
 * Build the bounded context for one Turn.
 *
 * Rules (§4.5 of the B2 proposal), all deterministic and testable:
 * - at most `maxContextMessages` rows, already enforced by the read query;
 * - at most `maxContextChars` characters of text, oldest dropped first, never mid-message;
 * - the message being answered (the last row, a `user` message) is always included;
 * - `ember` maps to the `assistant` role; nothing else is included.
 *
 * A last row that is not a `user` message is a data anomaly, not something to guess about, so the
 * context is refused instead of being sent as a truncated conversation.
 */
export function buildBoundedContext(rows: readonly ContextRow[]): BoundedContext {
  if (rows.length === 0) {
    throw new ModelInputRefused('no_context');
  }

  if (rows.length > MODEL_LIMITS.maxContextMessages) {
    throw new ModelInputRefused('context_invalid');
  }

  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.sequence <= rows[index - 1]!.sequence) {
      throw new ModelInputRefused('context_invalid');
    }
  }

  const source = rows[rows.length - 1]!;

  if (source.kind !== 'user') {
    throw new ModelInputRefused('context_invalid');
  }

  const kept: ModelMessage[] = [];
  let characters = 0;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const role = row.kind === 'user' ? 'user' : 'assistant';
    const nextCharacters = characters + row.text.length;

    // Oldest-first truncation: stop adding as soon as the oldest remaining row would exceed the
    // bound. The source row is index `rows.length - 1`, so the first iteration always succeeds
    // (a `user` message is at most 4096 characters) and can never be dropped.
    if (nextCharacters > MODEL_LIMITS.maxContextChars) {
      break;
    }

    kept.push({ role, text: row.text });
    characters = nextCharacters;
  }

  if (kept.length === 0) {
    throw new ModelInputRefused('context_too_large');
  }

  kept.reverse();

  return Object.freeze({
    messages: Object.freeze(kept),
    characters,
    droppedMessages: rows.length - kept.length,
  });
}
