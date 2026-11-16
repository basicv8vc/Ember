import { z } from 'zod';
import { CONVERSATION_SYSTEM_PROMPT, NOTES_ACTION_ITEMS_SYSTEM_PROMPT } from '../context.js';
import { ModelAuthorizationRefused, ModelGatewayFailure } from '../errors.js';
import { MODEL_LIMITS, estimateTokensConservative } from '../limits.js';
import type { ModelRateRow } from '../rates.js';
import type {
  ConversationTurnInput,
  ConversationTurnOutput,
  NotesActionItemsInput,
  NotesActionItemsOutput,
} from '../types.js';

export const DELEGATE_NOTES_TOOL_NAME = 'delegate_notes_action_items' as const;
export const DEFAULT_DELEGATION_ACK_TEXT =
  'I have started organizing these notes into action items.';

/**
 * Closed tool definition reviewed in code. Callers never supply or modify tool schemas.
 */
export const DELEGATION_TOOLS = Object.freeze([
  Object.freeze({
    type: 'function' as const,
    function: Object.freeze({
      name: DELEGATE_NOTES_TOOL_NAME,
      description:
        'Create a durable background task to extract structured action items from user-provided meeting or discussion notes.',
      parameters: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: ['notes'],
        properties: Object.freeze({
          title: Object.freeze({
            type: 'string',
            description: 'Short descriptive title for the notes task (1-128 characters).',
            minLength: 1,
            maxLength: 128,
          }),
          notes: Object.freeze({
            type: 'string',
            description:
              'The notes text supplied in the conversation to extract action items from.',
            minLength: 1,
            maxLength: 8000,
          }),
          instructions: Object.freeze({
            type: 'string',
            description: 'Optional concise instructions on format or focus.',
            minLength: 1,
            maxLength: 500,
          }),
        }),
      }),
    }),
  }),
]);

export const DELEGATION_TOOLS_TOKEN_ESTIMATE = estimateTokensConservative(
  JSON.stringify(DELEGATION_TOOLS),
);

const optionalBoundedText = (maxChars: number) =>
  z
    .string()
    .nullable()
    .optional()
    .transform((value) => {
      if (value === null || value === undefined) {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    })
    .refine((value) => value === undefined || value.length <= maxChars, {
      message: `must be at most ${maxChars} characters`,
    });

const delegateNotesToolArgsSchema = z.strictObject({
  title: optionalBoundedText(128),
  notes: z.string().trim().min(1).max(8_000),
  instructions: optionalBoundedText(500),
});

const toolCallSchema = z.object({
  type: z.string(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const completionMessageSchema = z.object({
  content: z.string().nullable().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

const notesActionItemSchema = z.object({
  action: z.string().trim().min(1).max(500),
  owner: optionalBoundedText(128),
  due: optionalBoundedText(128),
  details: optionalBoundedText(500),
});

const notesExtractionJsonSchema = z.object({
  summary: z.string().trim().min(1).max(4_096),
  action_items: z.array(notesActionItemSchema).max(100),
});

export function buildConversationTurnMessages(input: ConversationTurnInput) {
  return [
    { role: 'system' as const, content: CONVERSATION_SYSTEM_PROMPT },
    ...input.context.map((message) => ({ role: message.role, content: message.text })),
  ];
}

export function buildNotesExtractionMessages(input: NotesActionItemsInput) {
  const sections: string[] = [];
  if (input.title !== undefined) {
    sections.push(`Task title: ${input.title}`);
  }
  if (input.instructions !== undefined) {
    sections.push(`Instructions: ${input.instructions}`);
  }
  sections.push(`Notes:\n${input.notes}`);

  return [
    { role: 'system' as const, content: NOTES_ACTION_ITEMS_SYSTEM_PROMPT },
    { role: 'user' as const, content: sections.join('\n\n') },
  ];
}

export function rateRequestModifiers(rate: ModelRateRow, provider: 'openai' | 'openrouter') {
  if (provider === 'openai') {
    return rate.reasoningEffort === undefined ? {} : { reasoning_effort: rate.reasoningEffort };
  }

  return {
    ...(rate.promptCacheMode === undefined
      ? {}
      : { prompt_cache_options: { mode: rate.promptCacheMode } }),
    ...(rate.reasoningEffort === undefined
      ? {}
      : rate.reasoningEffort === 'none'
        ? { reasoning: { enabled: false } }
        : { reasoning: { effort: rate.reasoningEffort } }),
  };
}

export function parseConversationTurnChoice(choice: {
  readonly message: z.infer<typeof completionMessageSchema>;
  readonly finish_reason?: string | null | undefined;
}): ConversationTurnOutput {
  const finishReason = choice.finish_reason === 'length' ? ('length' as const) : ('stop' as const);
  const toolCalls = choice.message.tool_calls;

  if (toolCalls !== undefined && toolCalls.length > 0) {
    if (toolCalls.length !== 1) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const call = toolCalls[0]!;
    if (call.type !== 'function' || call.function.name !== DELEGATE_NOTES_TOOL_NAME) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    let rawArgs: unknown;
    try {
      rawArgs = JSON.parse(call.function.arguments);
    } catch {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const parsedArgs = delegateNotesToolArgsSchema.safeParse(rawArgs);
    if (!parsedArgs.success) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const rawText = typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
    const ackText =
      rawText.length > 0 ? clampText(rawText, 8_192).text : DEFAULT_DELEGATION_ACK_TEXT;

    const cleanArgs = {
      notes: parsedArgs.data.notes,
      ...(parsedArgs.data.title === undefined ? {} : { title: parsedArgs.data.title }),
      ...(parsedArgs.data.instructions === undefined
        ? {}
        : { instructions: parsedArgs.data.instructions }),
    };

    return Object.freeze({
      kind: 'delegate' as const,
      toolName: DELEGATE_NOTES_TOOL_NAME,
      text: ackText,
      finishReason,
      delegation: Object.freeze({
        toolName: DELEGATE_NOTES_TOOL_NAME,
        arguments: Object.freeze(cleanArgs),
      }),
    });
  }

  const text = choice.message.content;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ModelGatewayFailure('model_invalid_output');
  }

  return Object.freeze({
    kind: 'reply' as const,
    text,
    finishReason,
  });
}

export function parseNotesActionItemsChoice(choice: {
  readonly message: z.infer<typeof completionMessageSchema>;
  readonly finish_reason?: string | null | undefined;
}): NotesActionItemsOutput {
  if (choice.message.tool_calls !== undefined && choice.message.tool_calls.length > 0) {
    throw new ModelGatewayFailure('model_invalid_output');
  }

  const rawContent = choice.message.content;
  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    throw new ModelGatewayFailure('model_invalid_output');
  }

  const finishReason = choice.finish_reason === 'length' ? ('length' as const) : ('stop' as const);
  const trimmed = rawContent.trim();
  const unfenced = stripMarkdownFence(trimmed);

  let parsedJson: unknown = undefined;
  try {
    parsedJson = JSON.parse(unfenced);
  } catch {
    parsedJson = undefined;
  }

  const structured =
    parsedJson === undefined ? null : notesExtractionJsonSchema.safeParse(parsedJson);

  if (structured !== null && structured.success) {
    const lines = structured.data.action_items.map((item) => {
      const meta: string[] = [];
      if (item.owner !== undefined) {
        meta.push(`Owner: ${item.owner}`);
      }
      if (item.due !== undefined) {
        meta.push(`Due: ${item.due}`);
      }
      const header =
        meta.length === 0 ? `- [ ] ${item.action}` : `- [ ] ${item.action} (${meta.join(' | ')})`;
      return item.details === undefined ? header : `${header}\n  - ${item.details}`;
    });

    const rawSummary = structured.data.summary;
    const rawDetail =
      lines.length === 0
        ? `${rawSummary}\n\nNo explicit action items were found in these notes.`
        : `${rawSummary}\n\n${lines.join('\n')}`;

    const summary = clampText(rawSummary, MODEL_LIMITS.resultSummaryMaxChars);
    const detail = clampText(rawDetail, MODEL_LIMITS.resultDetailMaxChars);

    return Object.freeze({
      summaryText: summary.text,
      detailText: detail.text,
      truncated: summary.truncated || detail.truncated || finishReason === 'length',
      finishReason,
    });
  }

  // Fallback for models that emit clean Markdown/text directly rather than JSON.
  const firstLine =
    trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? trimmed;
  const summary = clampText(firstLine, Math.min(240, MODEL_LIMITS.resultSummaryMaxChars));
  const detail = clampText(trimmed, MODEL_LIMITS.resultDetailMaxChars);

  return Object.freeze({
    summaryText: summary.text,
    detailText: detail.text,
    truncated: detail.truncated || finishReason === 'length',
    finishReason,
  });
}

function stripMarkdownFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match === null ? text : match[1]!.trim();
}

export function clampText(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const suffix = '…';
  const keep = Math.max(1, maxChars - suffix.length);
  return {
    text: `${text.slice(0, keep).trimEnd()}${suffix}`,
    truncated: true,
  };
}

export function assertAuthorizedBeforeFetch(isAuthorized: () => boolean): void {
  if (!isAuthorized()) {
    throw new ModelAuthorizationRefused();
  }
}
