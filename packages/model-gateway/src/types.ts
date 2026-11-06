/**
 * The gateway is deliberately smaller than a "provider abstraction": it is the shape of the one
 * thing B2 does. No input carries a model, a temperature, a system prompt, a tool list, a stop
 * sequence or a provider, so a later feature cannot smuggle capability in through a parameter.
 */
export type ModelProviderId = 'fake' | 'openai';

export type ModelOperation = 'conversation.turn';

export type ModelExecutionMode = 'disabled' | 'fake' | 'real';

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Integer micro-USD computed from the pinned rate row. Never a float.
   *
   * Only meaningful when the provider reported token counts. A missing report is `null` at the
   * `ModelCallResult` level, because pricing "no tokens" would price the call at zero.
   */
  readonly costMicroUsd: number;
  readonly rateVersion: string;
}

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface ConversationTurnInput {
  readonly conversationId: string;
  readonly turnId: string;
  /** Bounded, oldest-first; the last entry is the message being answered. */
  readonly context: readonly ModelMessage[];
  readonly maxOutputTokens: number;
}

export interface ConversationTurnOutput {
  readonly text: string;
  readonly finishReason: 'stop' | 'length';
}

export interface ModelCallResult<T> {
  readonly output: T;
  readonly modelLabel: string;
  /** `true` only for the fake adapter. Asserted by tests, never assumed by a consumer. */
  readonly simulated: boolean;
  /**
   * Provider-reported usage, or `null` when a successful call did not report it.
   *
   * `null` is a first-class outcome, not an error: the reply is valid and may be published, but the
   * charge is unknown. A consumer must then book the full reservation as a conservative cost —
   * never zero. The type is nullable specifically so that "we were not told" cannot be silently
   * represented by the same value as "it was free".
   */
  readonly usage: ModelUsage | null;
}

/**
 * `AbortSignal` is a parameter, not an option: cancellation and deadline are the same mechanism, so
 * a slow provider and a user cancel take the same code path — the one that is tested.
 */
export interface ModelGateway {
  readonly providerId: ModelProviderId;
  readonly modelLabel: string;
  readonly simulated: boolean;
  readonly operations: readonly ModelOperation[];
  generateConversationTurn(
    input: ConversationTurnInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<ConversationTurnOutput>>;
}
