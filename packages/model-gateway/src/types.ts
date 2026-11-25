/**
 * The gateway is deliberately smaller than a "provider abstraction": it is the closed set of
 * reviewed model operations Ember performs. No input carries a model, a temperature, a system
 * prompt, a caller-defined tool list, a stop sequence or a provider, so a later feature cannot
 * smuggle capability in through a parameter.
 */
export type ModelProviderId = 'fake' | 'openai' | 'openrouter' | 'deepseek';
export type RealModelProviderId = Exclude<ModelProviderId, 'fake'>;

export type ModelOperation = 'conversation.turn' | 'task.notes_action_items' | 'task.python_agent';

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

export interface ConversationAttachmentMetadata {
  readonly uploadId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly imageDataUrl?: string;
}

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly attachments?: readonly ConversationAttachmentMetadata[];
}

export interface PersonalMemoryContextItem {
  readonly id?: string;
  readonly kind: 'preference' | 'fact';
  readonly key?: string;
  readonly content: string;
}

export interface ConversationTurnInput {
  readonly conversationId: string;
  readonly turnId: string;
  /** Bounded, oldest-first; the last entry is the message being answered. */
  readonly context: readonly ModelMessage[];
  /** Bounded account-scoped user-requested preferences/facts, newest-updated first. */
  readonly personalMemories?: readonly PersonalMemoryContextItem[];
  /**
   * Controls whether conversation-only delegation tools (`delegate_notes_action_items`,
   * `delegate_python_agent`) are advertised and accepted. Defaults to `true` for interactive
   * conversations; set to `false` for non-conversation scheduled executions (`model_brief`).
   */
  readonly allowDelegationTools?: boolean;
  /**
   * Explicit runtime capability gate for the closed `save_personal_memory` tool.
   * Defaults to `false` so V1 and non-conversation/scheduled executions never advertise or accept it.
   */
  readonly enablePersonalMemorySaveTool?: boolean;
  /**
   * Explicit runtime capability gate for the closed `create_proactive_schedule` tool.
   * Defaults to `false` so V1 and non-conversation/scheduled executions never advertise or accept it.
   */
  readonly enableProactiveScheduleTool?: boolean;
  /**
   * Explicit runtime capability gate for the closed `web_search` tool (Exa-backed in V2).
   * Defaults to `false` so V1, fake mode, and unconfigured runtimes never advertise or invoke it.
   */
  readonly enableWebSearchTool?: boolean;
  /**
   * Authoritative UTC ISO-8601 current timestamp supplied by the runtime when
   * `enableProactiveScheduleTool` is enabled so relative scheduling requests resolve accurately.
   */
  readonly currentTimeIso?: string;
  readonly maxOutputTokens: number;
}

export type ConversationDelegationCall =
  | {
      readonly toolName: 'delegate_notes_action_items';
      readonly arguments: {
        readonly title?: string;
        readonly notes: string;
        readonly instructions?: string;
      };
    }
  | {
      readonly toolName: 'delegate_python_agent';
      readonly arguments: {
        readonly title?: string;
        readonly prompt: string;
        readonly instructions?: string;
        readonly attachmentIds?: readonly string[];
      };
    };

export interface SavePersonalMemoryCall {
  readonly toolName: 'save_personal_memory';
  readonly arguments: {
    readonly kind: 'preference' | 'fact';
    readonly content: string;
    readonly key?: string;
    readonly replaceId?: string;
  };
}

export interface DeletePersonalMemoryTarget {
  readonly memoryId?: string;
  readonly key?: string;
  readonly contentMatch?: string;
}

export interface DeletePersonalMemoryCall {
  readonly toolName: 'delete_personal_memory';
  readonly arguments: {
    readonly targets: readonly DeletePersonalMemoryTarget[];
  };
}

export interface CreateProactiveScheduleToolArguments {
  readonly kind: 'reminder' | 'brief' | 'follow_up';
  readonly title: string;
  readonly prompt: string;
  readonly triggerType: 'once' | 'interval' | 'cron';
  readonly fireAt?: string;
  readonly intervalSeconds?: number;
  readonly cronExpr?: string;
  readonly timezone?: string;
  readonly deliveryMode?: 'direct_reminder' | 'model_brief';
}

export interface CreateProactiveScheduleCall {
  readonly toolName: 'create_proactive_schedule';
  readonly arguments: CreateProactiveScheduleToolArguments;
}

export type ConversationTurnOutput =
  | {
      readonly kind: 'reply';
      readonly text: string;
      readonly finishReason: 'stop' | 'length';
    }
  | {
      readonly kind: 'delegate';
      readonly toolName: ConversationDelegationCall['toolName'];
      readonly text: string;
      readonly finishReason: 'stop' | 'length';
      readonly delegation: ConversationDelegationCall;
    }
  | {
      readonly kind: 'save_memory';
      readonly toolName: SavePersonalMemoryCall['toolName'];
      readonly text: string;
      readonly finishReason: 'stop' | 'length';
      readonly memory: SavePersonalMemoryCall;
    }
  | {
      readonly kind: 'delete_memory';
      readonly toolName: DeletePersonalMemoryCall['toolName'];
      readonly text: string;
      readonly finishReason: 'stop' | 'length';
      readonly memory: DeletePersonalMemoryCall;
    }
  | {
      readonly kind: 'create_schedule';
      readonly toolName: CreateProactiveScheduleCall['toolName'];
      readonly text: string;
      readonly finishReason: 'stop' | 'length';
      readonly schedule: CreateProactiveScheduleCall;
    };

export interface NotesActionItemsInput {
  readonly taskId: string;
  readonly notes: string;
  readonly instructions?: string;
  readonly title?: string;
}

export interface NotesActionItemsOutput {
  readonly summaryText: string;
  readonly detailText: string;
  readonly truncated: boolean;
  readonly finishReason: 'stop' | 'length';
}

export interface PythonAgentInputFile {
  readonly artifactId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly previewText?: string;
}

export interface PythonAgentStepMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: 'run_python_script';
    readonly argumentsJson: string;
  }[];
}

export interface PythonAgentStepInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly instructions?: string;
  readonly title?: string;
  readonly inputFiles: readonly PythonAgentInputFile[];
  readonly messages: readonly PythonAgentStepMessage[];
  readonly maxOutputTokens?: number;
  /** Remaining run_python_script calls allowed; 0 forces a final answer without tools. */
  readonly remainingPythonCalls: number;
}

export type PythonAgentStepOutput =
  | {
      readonly kind: 'tool_call';
      readonly toolCallId: string;
      readonly code: string;
      readonly purpose?: string;
      readonly rawArgumentsJson: string;
      readonly assistantText?: string;
    }
  | {
      readonly kind: 'final';
      readonly summaryText: string;
      readonly detailText: string;
      readonly truncated: boolean;
      readonly finishReason: 'stop' | 'length';
    };

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
  extractNotesActionItems(
    input: NotesActionItemsInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<NotesActionItemsOutput>>;
  stepPythonAgent(
    input: PythonAgentStepInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<PythonAgentStepOutput>>;
}
