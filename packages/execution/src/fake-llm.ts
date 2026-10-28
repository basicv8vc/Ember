import { TASK_INPUT_LIMITS, toInvalidArgumentError } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import { z } from 'zod';
import { parseBoundedTimeoutMs, parseDelayMs, realSleeper, throwIfAborted } from './clock.js';
import type { Sleeper } from './clock.js';
import { sha256Hex } from './crypto.js';

/** Identifier reported in every response. It is not a real model name. */
export const FAKE_LLM_MODEL = 'ember-fake-llm-1';

/**
 * Hard limits for the simulated generator.
 *
 * `maxCompletionTokens` is the internal cap; a request cap must also satisfy the contract
 * limit `TASK_INPUT_LIMITS.chatMaxOutputTokensMax`. Output length is bounded by the resolved
 * token budget, so a caller can never obtain an unbounded completion.
 */
export const FAKE_LLM_LIMITS = Object.freeze({
  maxCompletionTokens: 512,
  defaultCompletionTokens: 32,
  maxDelayMs: 5_000,
  /** Simulated prompt accounting only: ~4 characters per token. */
  charsPerToken: 4,
});

/**
 * Fixed, deterministic fault injection.
 *
 * - `tool_failed` → `MOCK_TOOL_FAILED` (retryable)
 * - `timeout`     → `EXECUTION_TIMEOUT` (retryable)
 * - `denied`      → `POLICY_DENIED` (terminal)
 */
export type FakeLlmFault = 'none' | 'tool_failed' | 'timeout' | 'denied';

export interface FakeLlmRequest {
  readonly prompt: string;
  readonly maxOutputTokens?: number;
}

export interface FakeLlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface FakeLlmResponse {
  readonly model: typeof FAKE_LLM_MODEL;
  /** Bounded, deterministic text. In-memory only: nothing is persisted in P0B-05. */
  readonly text: string;
  readonly usage: FakeLlmUsage;
  readonly simulated: true;
}

export interface FakeLlmOptions {
  /** Injected scheduler/wait; tests pass a recorder instead of sleeping. */
  readonly sleep?: Sleeper;
  /** Simulated latency before a response is produced. */
  readonly delayMs?: number;
  /** Simulated execution timeout; a delay at or beyond it yields `EXECUTION_TIMEOUT`. */
  readonly timeoutMs?: number;
  readonly fault?: FakeLlmFault;
}

const requestSchema = z.strictObject({
  prompt: z.string().min(1).max(TASK_INPUT_LIMITS.chatPromptMaxChars),
  maxOutputTokens: z.number().int().min(1).max(TASK_INPUT_LIMITS.chatMaxOutputTokensMax).optional(),
});

const FAULT_CODES = {
  tool_failed: 'MOCK_TOOL_FAILED',
  timeout: 'EXECUTION_TIMEOUT',
  denied: 'POLICY_DENIED',
} as const;

/**
 * Small closed vocabulary. Word selection is driven by the prompt digest, so the same prompt
 * always yields the same text while no prompt content is ever echoed back verbatim.
 */
const FAKE_VOCABULARY = [
  'ember',
  'simulated',
  'deterministic',
  'agent',
  'runtime',
  'lease',
  'task',
  'policy',
  'mock',
  'sandbox',
  'response',
  'bounded',
] as const;

function wordAt(index: number): string {
  return FAKE_VOCABULARY[index % FAKE_VOCABULARY.length] ?? 'ember';
}

function generateText(prompt: string, completionTokens: number): string {
  const digest = sha256Hex(prompt);
  const words: string[] = [];

  for (let index = 0; index < completionTokens; index += 1) {
    const nibbleOffset = (index % 32) * 2;
    words.push(wordAt(Number.parseInt(digest.slice(nibbleOffset, nibbleOffset + 2), 16)));
  }

  return words.join(' ');
}

/**
 * Deterministic stand-in for a language model.
 *
 * Guarantees:
 * - the same request and options always produce the same text and usage;
 * - no HTTP client, no SDK and no environment variable is read, so no API key can be used;
 * - the prompt is never logged, persisted, executed or interpreted as a tool/shell command;
 * - the response never exceeds the resolved simulated token budget.
 *
 * The response exists in memory only. P0B-05 has no ArtifactStore/result persistence, so
 * callers must not treat it as a durable model output.
 */
export class FakeLlm {
  private readonly sleep: Sleeper;
  private readonly delayMs: number;
  private readonly timeoutMs: number | undefined;
  private readonly fault: FakeLlmFault;

  constructor(options: FakeLlmOptions = {}) {
    this.sleep = options.sleep ?? realSleeper;
    this.delayMs = parseDelayMs(options.delayMs, 'delayMs', FAKE_LLM_LIMITS.maxDelayMs);
    this.timeoutMs =
      options.timeoutMs === undefined
        ? undefined
        : parseBoundedTimeoutMs(options.timeoutMs, 'timeoutMs', FAKE_LLM_LIMITS.maxDelayMs);
    this.fault = options.fault ?? 'none';
  }

  /** Simulated latency this instance applies to every generation. */
  get simulatedDelayMs(): number {
    return this.delayMs;
  }

  async generate(request: FakeLlmRequest, signal?: AbortSignal): Promise<FakeLlmResponse> {
    const parsed = requestSchema.safeParse(request);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    throwIfAborted(signal);

    // A simulated timeout never waits beyond its own bound.
    if (this.timeoutMs !== undefined && this.delayMs >= this.timeoutMs) {
      await this.sleep(this.timeoutMs, signal);
      throwIfAborted(signal);
      throw new DomainError('EXECUTION_TIMEOUT', 'simulated generation exceeded its timeout');
    }

    await this.sleep(this.delayMs, signal);
    throwIfAborted(signal);

    if (this.fault !== 'none') {
      throw new DomainError(FAULT_CODES[this.fault], `injected simulated fault: ${this.fault}`);
    }

    const requestedTokens = parsed.data.maxOutputTokens ?? FAKE_LLM_LIMITS.defaultCompletionTokens;
    const completionTokens = Math.min(requestedTokens, FAKE_LLM_LIMITS.maxCompletionTokens);
    const promptTokens = Math.min(
      Math.ceil(parsed.data.prompt.length / FAKE_LLM_LIMITS.charsPerToken),
      TASK_INPUT_LIMITS.chatPromptMaxChars,
    );

    return Object.freeze({
      model: FAKE_LLM_MODEL,
      text: generateText(parsed.data.prompt, completionTokens),
      usage: Object.freeze({ promptTokens, completionTokens }),
      simulated: true as const,
    });
  }
}
