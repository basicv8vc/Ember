import { z } from 'zod';
import {
  CONVERSATION_SYSTEM_PROMPT,
  NOTES_ACTION_ITEMS_SYSTEM_PROMPT,
  PERSONAL_MEMORY_SAVE_SYSTEM_INSTRUCTION,
  PROACTIVE_SCHEDULE_CREATE_SYSTEM_INSTRUCTION,
  PYTHON_AGENT_SYSTEM_PROMPT,
  SCHEDULED_BRIEF_SYSTEM_PROMPT,
  buildBoundedPersonalMemoryContext,
  formatConversationMessageText,
} from '../context.js';
import { ModelAuthorizationRefused, ModelGatewayFailure } from '../errors.js';
import { MODEL_LIMITS, estimateTokensConservative } from '../limits.js';
import type { ModelRateRow } from '../rates.js';
import type {
  ConversationTurnInput,
  ConversationTurnOutput,
  CreateProactiveScheduleToolArguments,
  NotesActionItemsInput,
  NotesActionItemsOutput,
  PythonAgentStepInput,
  PythonAgentStepOutput,
} from '../types.js';

export const DELEGATE_NOTES_TOOL_NAME = 'delegate_notes_action_items' as const;
export const DELEGATE_PYTHON_TOOL_NAME = 'delegate_python_agent' as const;
export const SAVE_PERSONAL_MEMORY_TOOL_NAME = 'save_personal_memory' as const;
export const DELETE_PERSONAL_MEMORY_TOOL_NAME = 'delete_personal_memory' as const;
export const CREATE_PROACTIVE_SCHEDULE_TOOL_NAME = 'create_proactive_schedule' as const;
export const RUN_PYTHON_TOOL_NAME = 'run_python_script' as const;
export const DEFAULT_DELEGATION_ACK_TEXT =
  'I have started organizing these notes into action items.';
export const DEFAULT_PYTHON_DELEGATION_ACK_TEXT =
  'I have started running your Python task in an isolated sandbox.';
export const DEFAULT_MEMORY_SAVE_ACK_TEXT = "Got it — I'll remember that.";
export const DEFAULT_MEMORY_DELETE_ACK_TEXT =
  "Got it — I'll remove that from your personal memory.";
export const COMMITTED_MEMORY_SAVED_REPLY = 'Saved to your personal memory.';
export const COMMITTED_MEMORY_UPDATED_REPLY = 'Updated your personal memory.';
export const COMMITTED_MEMORY_DELETED_REPLY = 'Removed from your personal memory.';
export const DEFAULT_PROACTIVE_SCHEDULE_ACK_TEXT = 'I have created your proactive schedule.';

const HISTORICAL_NOTES_DELEGATION_MARKER = '[Prior turn called delegate_notes_action_items.]';
const HISTORICAL_PYTHON_DELEGATION_MARKER = '[Prior turn called delegate_python_agent.]';
const HISTORICAL_MEMORY_SAVE_MARKER = '[Prior turn called save_personal_memory.]';
const HISTORICAL_MEMORY_DELETE_MARKER = '[Prior turn called delete_personal_memory.]';
const HISTORICAL_PROACTIVE_SCHEDULE_MARKER = '[Prior turn called create_proactive_schedule.]';
const FORBIDDEN_PLAIN_TEXT_DELEGATION_REPLIES = new Set([
  DEFAULT_DELEGATION_ACK_TEXT,
  DEFAULT_PYTHON_DELEGATION_ACK_TEXT,
  DEFAULT_MEMORY_SAVE_ACK_TEXT,
  DEFAULT_MEMORY_DELETE_ACK_TEXT,
  COMMITTED_MEMORY_SAVED_REPLY,
  COMMITTED_MEMORY_UPDATED_REPLY,
  COMMITTED_MEMORY_DELETED_REPLY,
  DEFAULT_PROACTIVE_SCHEDULE_ACK_TEXT,
  HISTORICAL_NOTES_DELEGATION_MARKER,
  HISTORICAL_PYTHON_DELEGATION_MARKER,
  HISTORICAL_MEMORY_SAVE_MARKER,
  HISTORICAL_MEMORY_DELETE_MARKER,
  HISTORICAL_PROACTIVE_SCHEDULE_MARKER,
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Require explicit UTC `Z` or `±HH:MM` offset so floating/ambiguous timestamps are rejected. */
const ISO_OFFSET_REGEX = /(?:Z|[+-]\d{2}:\d{2})$/i;

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
  Object.freeze({
    type: 'function' as const,
    function: Object.freeze({
      name: DELEGATE_PYTHON_TOOL_NAME,
      description:
        'Create a durable background Python task inside an isolated sandbox with optional uploaded file, image, or PDF attachment IDs.',
      parameters: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: Object.freeze({
          title: Object.freeze({
            type: 'string',
            description: 'Short descriptive title for the Python task (1-128 characters).',
            minLength: 1,
            maxLength: 128,
          }),
          prompt: Object.freeze({
            type: 'string',
            description: 'Clear objective and requirements for the Python task.',
            minLength: 1,
            maxLength: 8000,
          }),
          instructions: Object.freeze({
            type: 'string',
            description: 'Optional concise output or formatting instructions.',
            minLength: 1,
            maxLength: 500,
          }),
          attachment_ids: Object.freeze({
            type: 'array',
            description: 'Optional uploaded attachment upload_id UUIDs referenced in context.',
            maxItems: 5,
            items: Object.freeze({ type: 'string' }),
          }),
        }),
      }),
    }),
  }),
]);

export const SAVE_PERSONAL_MEMORY_TOOL = Object.freeze({
  type: 'function' as const,
  function: Object.freeze({
    name: SAVE_PERSONAL_MEMORY_TOOL_NAME,
    description:
      'Save a user-requested personal preference or fact to account memory. Call ONLY when the latest actual user message explicitly asks Ember to remember something.',
    parameters: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'content'],
      properties: Object.freeze({
        kind: Object.freeze({
          type: 'string',
          enum: Object.freeze(['preference', 'fact']),
          description: 'Whether this is a user preference or a personal fact.',
        }),
        content: Object.freeze({
          type: 'string',
          description:
            'Concise statement of the user-requested preference or fact to remember (1-500 characters).',
          minLength: 1,
          maxLength: 500,
        }),
        key: Object.freeze({
          type: 'string',
          description:
            'Optional stable lowercase key (letters, digits, dot, underscore, hyphen; 1-64 chars) to update an existing memory in place.',
          minLength: 1,
          maxLength: 64,
        }),
        replace_id: Object.freeze({
          type: 'string',
          description:
            'Optional #id prefix or UUID of an existing saved memory to replace/update in place.',
          minLength: 4,
          maxLength: 64,
        }),
      }),
    }),
  }),
});

export const DELETE_PERSONAL_MEMORY_TOOL = Object.freeze({
  type: 'function' as const,
  function: Object.freeze({
    name: DELETE_PERSONAL_MEMORY_TOOL_NAME,
    description:
      'Forget/delete a user-requested personal preference or fact from account memory. Call ONLY when the latest actual user message explicitly asks Ember to forget or remove a saved memory.',
    parameters: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: Object.freeze({
        memory_id: Object.freeze({
          type: 'string',
          description:
            'Optional #id prefix or UUID of the saved memory to forget (preferred when shown in saved memory context).',
          minLength: 4,
          maxLength: 64,
        }),
        key: Object.freeze({
          type: 'string',
          description: 'Optional existing key of the saved memory to forget.',
          minLength: 1,
          maxLength: 64,
        }),
        content_match: Object.freeze({
          type: 'string',
          description:
            'Optional concise phrase matching the saved memory content to forget when no id or key is known.',
          minLength: 1,
          maxLength: 200,
        }),
      }),
    }),
  }),
});

export const CREATE_PROACTIVE_SCHEDULE_TOOL = Object.freeze({
  type: 'function' as const,
  function: Object.freeze({
    name: CREATE_PROACTIVE_SCHEDULE_TOOL_NAME,
    description:
      'Create a durable proactive schedule (one-time reminder, follow-up, or recurring brief) ONLY when the latest actual user message explicitly asks to schedule one with unambiguous timing and explicit timezone/offset.',
    parameters: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title', 'prompt', 'trigger_type'],
      properties: Object.freeze({
        kind: Object.freeze({
          type: 'string',
          enum: Object.freeze(['reminder', 'brief', 'follow_up']),
          description: 'Schedule category: reminder, brief, or follow_up.',
        }),
        title: Object.freeze({
          type: 'string',
          description: 'Short descriptive title for the schedule (1-140 characters).',
          minLength: 1,
          maxLength: 140,
        }),
        prompt: Object.freeze({
          type: 'string',
          description: 'Reminder text or brief/follow-up instructions (1-2000 characters).',
          minLength: 1,
          maxLength: 2000,
        }),
        trigger_type: Object.freeze({
          type: 'string',
          enum: Object.freeze(['once', 'interval', 'cron']),
          description:
            'Trigger type: once (ISO-8601 fire_at with explicit Z or ±HH:MM offset), interval (interval_seconds), or cron (cron_expr + IANA timezone).',
        }),
        fire_at: Object.freeze({
          type: 'string',
          description:
            'ISO-8601 timestamp with explicit Z or ±HH:MM offset when trigger_type is once.',
          minLength: 1,
          maxLength: 64,
        }),
        interval_seconds: Object.freeze({
          type: 'integer',
          description: 'Interval in seconds (60-2592000) when trigger_type is interval.',
          minimum: 60,
          maximum: 2592000,
        }),
        cron_expr: Object.freeze({
          type: 'string',
          description: '5-field cron expression (e.g. "0 8 * * *") when trigger_type is cron.',
          minLength: 1,
          maxLength: 120,
        }),
        timezone: Object.freeze({
          type: 'string',
          description:
            'Explicit IANA timezone (e.g. "America/Los_Angeles" or "UTC"); required for cron.',
          minLength: 1,
          maxLength: 100,
        }),
        delivery_mode: Object.freeze({
          type: 'string',
          enum: Object.freeze(['direct_reminder', 'model_brief']),
          description: 'Optional delivery mode override (direct_reminder or model_brief).',
        }),
      }),
    }),
  }),
});

export const NO_CONVERSATION_TOOLS = Object.freeze([] as const);

export const CONVERSATION_TOOLS_WITH_MEMORY = Object.freeze([
  ...DELEGATION_TOOLS,
  SAVE_PERSONAL_MEMORY_TOOL,
  DELETE_PERSONAL_MEMORY_TOOL,
]);

export const CONVERSATION_TOOLS_WITH_SCHEDULE = Object.freeze([
  ...DELEGATION_TOOLS,
  CREATE_PROACTIVE_SCHEDULE_TOOL,
]);

export const CONVERSATION_TOOLS_WITH_MEMORY_AND_SCHEDULE = Object.freeze([
  ...DELEGATION_TOOLS,
  SAVE_PERSONAL_MEMORY_TOOL,
  DELETE_PERSONAL_MEMORY_TOOL,
  CREATE_PROACTIVE_SCHEDULE_TOOL,
]);

export interface ConversationToolCapabilities {
  readonly allowDelegation?: boolean;
  readonly allowSavePersonalMemory?: boolean;
  readonly allowCreateProactiveSchedule?: boolean;
}

export function getConversationTools(capabilities?: boolean | ConversationToolCapabilities) {
  const allowDelegation =
    typeof capabilities === 'boolean' ? true : capabilities?.allowDelegation !== false;
  const allowMemory =
    typeof capabilities === 'boolean'
      ? capabilities
      : capabilities?.allowSavePersonalMemory === true;
  const allowSchedule =
    typeof capabilities === 'boolean' ? false : capabilities?.allowCreateProactiveSchedule === true;
  if (!allowDelegation && !allowMemory && !allowSchedule) return NO_CONVERSATION_TOOLS;
  if (allowDelegation) {
    if (allowMemory && allowSchedule) return CONVERSATION_TOOLS_WITH_MEMORY_AND_SCHEDULE;
    if (allowMemory) return CONVERSATION_TOOLS_WITH_MEMORY;
    if (allowSchedule) return CONVERSATION_TOOLS_WITH_SCHEDULE;
    return DELEGATION_TOOLS;
  }
  return Object.freeze([
    ...(allowMemory ? [SAVE_PERSONAL_MEMORY_TOOL, DELETE_PERSONAL_MEMORY_TOOL] : []),
    ...(allowSchedule ? [CREATE_PROACTIVE_SCHEDULE_TOOL] : []),
  ]);
}

export const PYTHON_AGENT_TOOLS = Object.freeze([
  Object.freeze({
    type: 'function' as const,
    function: Object.freeze({
      name: RUN_PYTHON_TOOL_NAME,
      description:
        'Execute a Python 3 script inside /home/daytona/ember with deny-all network access. Input files are in ./inputs/ and generated files to publish must be written to ./outputs/.',
      parameters: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: ['code'],
        properties: Object.freeze({
          code: Object.freeze({
            type: 'string',
            description: 'Complete Python 3 source code to write to main.py and execute.',
            minLength: 1,
            maxLength: 16384,
          }),
          purpose: Object.freeze({
            type: 'string',
            description: 'Optional concise 1-line summary of what this script checks or computes.',
            minLength: 1,
            maxLength: 200,
          }),
        }),
      }),
    }),
  }),
]);

export const DELEGATION_TOOLS_TOKEN_ESTIMATE = estimateTokensConservative(
  JSON.stringify(DELEGATION_TOOLS),
);

export const CONVERSATION_TOOLS_WITH_MEMORY_TOKEN_ESTIMATE = estimateTokensConservative(
  JSON.stringify(CONVERSATION_TOOLS_WITH_MEMORY),
);

export const CONVERSATION_TOOLS_WITH_SCHEDULE_TOKEN_ESTIMATE = estimateTokensConservative(
  JSON.stringify(CONVERSATION_TOOLS_WITH_SCHEDULE),
);

export const CONVERSATION_TOOLS_WITH_MEMORY_AND_SCHEDULE_TOKEN_ESTIMATE =
  estimateTokensConservative(JSON.stringify(CONVERSATION_TOOLS_WITH_MEMORY_AND_SCHEDULE));

export const PYTHON_AGENT_TOOLS_TOKEN_ESTIMATE = estimateTokensConservative(
  JSON.stringify(PYTHON_AGENT_TOOLS),
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

const delegatePythonToolArgsSchema = z.strictObject({
  title: optionalBoundedText(128),
  prompt: z.string().trim().min(1).max(8_000),
  instructions: optionalBoundedText(500),
  attachment_ids: z.array(z.string().trim().regex(UUID_REGEX, 'must be a UUID')).max(5).optional(),
});

const PERSONAL_MEMORY_KEY_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PERSONAL_MEMORY_REF_REGEX = /^[0-9a-f][0-9a-f-]{3,63}$/;

function normalizePersonalMemoryToolKey(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s:/\\]+/g, '_')
    .replace(/[^a-z0-9._-]+/g, '')
    .replace(/_+/g, '_')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
  return PERSONAL_MEMORY_KEY_REGEX.test(normalized) ? normalized : undefined;
}

function normalizePersonalMemoryRefId(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = value.trim().replace(/^#+/, '').toLowerCase();
  return PERSONAL_MEMORY_REF_REGEX.test(normalized) ? normalized : undefined;
}

const savePersonalMemoryToolArgsSchema = z.strictObject({
  kind: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['preference', 'fact'])),
  content: z
    .string()
    .trim()
    .min(1)
    .refine((text) => !/\p{Surrogate}/u.test(text), 'content contains invalid surrogate')
    .transform((text) => clampText(text, 500).text),
  key: z.string().nullable().optional().transform(normalizePersonalMemoryToolKey),
  replace_id: z.string().nullable().optional().transform(normalizePersonalMemoryRefId),
});

const deletePersonalMemoryToolArgsSchema = z
  .strictObject({
    memory_id: z.string().nullable().optional().transform(normalizePersonalMemoryRefId),
    key: z.string().nullable().optional().transform(normalizePersonalMemoryToolKey),
    content_match: optionalBoundedText(200),
  })
  .refine(
    (value) =>
      value.memory_id !== undefined || value.key !== undefined || value.content_match !== undefined,
    'at least one selector (memory_id, key, or content_match) is required',
  );

const createProactiveScheduleToolArgsSchema = z
  .strictObject({
    kind: z.enum(['reminder', 'brief', 'follow_up']),
    title: z.string().trim().min(1).max(140),
    prompt: z.string().trim().min(1).max(2_000),
    trigger_type: z.enum(['once', 'interval', 'cron']),
    fire_at: optionalBoundedText(64),
    interval_seconds: z.number().int().min(60).max(2_592_000).optional(),
    cron_expr: optionalBoundedText(120),
    timezone: optionalBoundedText(100),
    delivery_mode: z.enum(['direct_reminder', 'model_brief']).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.trigger_type === 'once') {
      if (
        data.fire_at === undefined ||
        !ISO_OFFSET_REGEX.test(data.fire_at) ||
        !Number.isFinite(Date.parse(data.fire_at))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['fire_at'],
          message:
            'valid ISO-8601 fire_at with explicit timezone offset or Z is required for once trigger',
        });
      }
      if (data.interval_seconds !== undefined || data.cron_expr !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['trigger_type'],
          message: 'interval_seconds and cron_expr are not allowed for once trigger',
        });
      }
    } else if (data.trigger_type === 'interval') {
      if (data.interval_seconds === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['interval_seconds'],
          message: 'interval_seconds is required for interval trigger',
        });
      }
      if (
        data.fire_at !== undefined &&
        (!ISO_OFFSET_REGEX.test(data.fire_at) || !Number.isFinite(Date.parse(data.fire_at)))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['fire_at'],
          message: 'fire_at must be valid ISO-8601 with explicit offset or Z',
        });
      }
      if (data.cron_expr !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['cron_expr'],
          message: 'cron_expr is not allowed for interval trigger',
        });
      }
    } else if (data.trigger_type === 'cron') {
      if (data.cron_expr === undefined || data.timezone === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['cron_expr'],
          message: 'cron_expr and explicit timezone are required for cron trigger',
        });
      }
      if (data.fire_at !== undefined || data.interval_seconds !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['trigger_type'],
          message: 'fire_at and interval_seconds are not allowed for cron trigger',
        });
      }
    }
  });

const runPythonToolArgsSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(16_384)
    .refine((v) => v.trim().length > 0, 'code must be non-empty'),
  purpose: optionalBoundedText(200),
});

const toolCallSchema = z.object({
  id: z.string().min(1).max(128).optional(),
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

export type ProviderUserContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

export type ProviderChatMessage =
  | {
      readonly role: 'system';
      readonly content: string;
    }
  | {
      readonly role: 'user';
      readonly content: string | readonly ProviderUserContentPart[];
    }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly tool_calls?: readonly {
        readonly id: string;
        readonly type: 'function';
        readonly function: { readonly name: string; readonly arguments: string };
      }[];
    }
  | {
      readonly role: 'tool';
      readonly tool_call_id: string;
      readonly content: string;
    };

export { formatConversationMessageText };

function formatContextTurnMessage(
  message: ConversationTurnInput['context'][number],
): ProviderChatMessage {
  if (message.role === 'assistant') {
    const trimmed = message.text.trim();
    // Neutralize prior canned delegation acknowledgements so subsequent turns do not imitate
    // them as plain-text answers instead of emitting tool calls.
    if (trimmed === DEFAULT_DELEGATION_ACK_TEXT) {
      return { role: 'assistant', content: HISTORICAL_NOTES_DELEGATION_MARKER };
    }
    if (trimmed === DEFAULT_PYTHON_DELEGATION_ACK_TEXT) {
      return { role: 'assistant', content: HISTORICAL_PYTHON_DELEGATION_MARKER };
    }
    if (
      trimmed === DEFAULT_MEMORY_SAVE_ACK_TEXT ||
      trimmed === COMMITTED_MEMORY_SAVED_REPLY ||
      trimmed === COMMITTED_MEMORY_UPDATED_REPLY
    ) {
      return { role: 'assistant', content: HISTORICAL_MEMORY_SAVE_MARKER };
    }
    if (trimmed === DEFAULT_MEMORY_DELETE_ACK_TEXT || trimmed === COMMITTED_MEMORY_DELETED_REPLY) {
      return { role: 'assistant', content: HISTORICAL_MEMORY_DELETE_MARKER };
    }
    if (trimmed === DEFAULT_PROACTIVE_SCHEDULE_ACK_TEXT) {
      return { role: 'assistant', content: HISTORICAL_PROACTIVE_SCHEDULE_MARKER };
    }
  }

  const formattedText = formatConversationMessageText(message);
  if (message.role === 'user' && message.attachments !== undefined) {
    const imageParts = message.attachments
      .filter(
        (att): att is typeof att & { readonly imageDataUrl: string } =>
          typeof att.imageDataUrl === 'string' && att.imageDataUrl.length > 0,
      )
      .map((att) => ({
        type: 'image_url' as const,
        image_url: { url: att.imageDataUrl },
      }));
    if (imageParts.length > 0) {
      return {
        role: 'user',
        content: [{ type: 'text', text: formattedText }, ...imageParts],
      };
    }
  }

  return {
    role: message.role,
    content: formattedText,
  };
}

export function buildConversationTurnMessages(input: ConversationTurnInput): ProviderChatMessage[] {
  const systemParts: string[] = [
    input.allowDelegationTools === false
      ? SCHEDULED_BRIEF_SYSTEM_PROMPT
      : CONVERSATION_SYSTEM_PROMPT,
  ];
  if (input.enablePersonalMemorySaveTool === true) {
    systemParts.push(PERSONAL_MEMORY_SAVE_SYSTEM_INSTRUCTION);
  }
  if (input.enableProactiveScheduleTool === true) {
    systemParts.push(PROACTIVE_SCHEDULE_CREATE_SYSTEM_INSTRUCTION);
    if (
      typeof input.currentTimeIso === 'string' &&
      Number.isFinite(Date.parse(input.currentTimeIso))
    ) {
      systemParts.push(`Authoritative current UTC time: ${input.currentTimeIso}.`);
    }
  }
  const systemPrompt = systemParts.join(' ');
  const memoryBlock =
    input.personalMemories !== undefined && input.personalMemories.length > 0
      ? buildBoundedPersonalMemoryContext(input.personalMemories).text
      : '';
  return [
    { role: 'system' as const, content: systemPrompt },
    ...(memoryBlock.length > 0 ? [{ role: 'user' as const, content: memoryBlock }] : []),
    ...input.context.map(formatContextTurnMessage),
  ];
}

export function buildNotesExtractionMessages(input: NotesActionItemsInput): ProviderChatMessage[] {
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

export function buildPythonAgentInitialUserText(input: PythonAgentStepInput): string {
  const sections: string[] = [];
  if (input.title !== undefined) {
    sections.push(`Task title: ${input.title}`);
  }
  if (input.instructions !== undefined) {
    sections.push(`Instructions: ${input.instructions}`);
  }
  sections.push(`Objective:\n${input.prompt}`);

  if (input.inputFiles.length > 0) {
    const fileDescriptions = input.inputFiles.map((file) => {
      const header = `- /home/daytona/ember/inputs/${file.filename} (${file.mediaType}, ${file.sizeBytes} bytes)`;
      if (file.previewText === undefined || file.previewText.length === 0) {
        return header;
      }
      return `${header}\nPreview:\n${file.previewText}`;
    });
    sections.push(`Input files:\n${fileDescriptions.join('\n\n')}`);
  }

  return sections.join('\n\n');
}

export function buildPythonAgentMessages(input: PythonAgentStepInput): ProviderChatMessage[] {
  const result: ProviderChatMessage[] = [
    { role: 'system', content: PYTHON_AGENT_SYSTEM_PROMPT },
    { role: 'user', content: buildPythonAgentInitialUserText(input) },
  ];

  for (const msg of input.messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.text });
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: msg.text.length > 0 ? msg.text : null,
          tool_calls: msg.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.argumentsJson },
          })),
        });
      } else {
        result.push({ role: 'assistant', content: msg.text });
      }
    } else if (msg.role === 'tool' && msg.toolCallId !== undefined) {
      result.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.text,
      });
    }
  }

  return result;
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

export function parseConversationTurnChoice(
  choice: {
    readonly message: z.infer<typeof completionMessageSchema>;
    readonly finish_reason?: string | null | undefined;
  },
  options?: {
    readonly allowDelegation?: boolean;
    readonly allowSavePersonalMemory?: boolean;
    readonly allowCreateProactiveSchedule?: boolean;
  },
): ConversationTurnOutput {
  const finishReason = choice.finish_reason === 'length' ? ('length' as const) : ('stop' as const);
  const toolCalls = choice.message.tool_calls;

  if (toolCalls !== undefined && toolCalls.length > 0) {
    const rawText = typeof choice.message.content === 'string' ? choice.message.content.trim() : '';

    if (toolCalls.length > 1) {
      if (options?.allowSavePersonalMemory !== true) {
        throw new ModelGatewayFailure('model_invalid_output');
      }
      const allSaveMemory = toolCalls.every(
        (call) => call.type === 'function' && call.function.name === SAVE_PERSONAL_MEMORY_TOOL_NAME,
      );
      const allDeleteMemory = toolCalls.every(
        (call) =>
          call.type === 'function' && call.function.name === DELETE_PERSONAL_MEMORY_TOOL_NAME,
      );
      if (!allSaveMemory && !allDeleteMemory) {
        throw new ModelGatewayFailure('model_invalid_output');
      }

      if (allDeleteMemory) {
        const targets: {
          readonly memoryId?: string;
          readonly key?: string;
          readonly contentMatch?: string;
        }[] = [];
        const seen = new Set<string>();
        for (const call of toolCalls) {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(call.function.arguments);
          } catch {
            throw new ModelGatewayFailure('model_invalid_output');
          }
          const parsedArgs = deletePersonalMemoryToolArgsSchema.safeParse(parsedJson);
          if (!parsedArgs.success) {
            throw new ModelGatewayFailure('model_invalid_output');
          }
          const target = {
            ...(parsedArgs.data.memory_id === undefined
              ? {}
              : { memoryId: parsedArgs.data.memory_id }),
            ...(parsedArgs.data.key === undefined ? {} : { key: parsedArgs.data.key }),
            ...(parsedArgs.data.content_match === undefined
              ? {}
              : { contentMatch: parsedArgs.data.content_match }),
          };
          const dedupKey = `${target.memoryId ?? ''}:${target.key ?? ''}:${target.contentMatch ?? ''}`;
          if (!seen.has(dedupKey) && targets.length < 10) {
            seen.add(dedupKey);
            targets.push(Object.freeze(target));
          }
        }
        const ackText =
          rawText.length > 0 ? clampText(rawText, 8_192).text : DEFAULT_MEMORY_DELETE_ACK_TEXT;
        return Object.freeze({
          kind: 'delete_memory' as const,
          toolName: DELETE_PERSONAL_MEMORY_TOOL_NAME,
          text: ackText,
          finishReason,
          memory: Object.freeze({
            toolName: DELETE_PERSONAL_MEMORY_TOOL_NAME,
            arguments: Object.freeze({ targets: Object.freeze(targets) }),
          }),
        });
      }

      const parsedMemories: z.infer<typeof savePersonalMemoryToolArgsSchema>[] = [];
      const seen = new Set<string>();
      for (const call of toolCalls) {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(call.function.arguments);
        } catch {
          throw new ModelGatewayFailure('model_invalid_output');
        }
        const parsedArgs = savePersonalMemoryToolArgsSchema.safeParse(parsedJson);
        if (!parsedArgs.success) {
          throw new ModelGatewayFailure('model_invalid_output');
        }
        const dedupKey = `${parsedArgs.data.kind}:${parsedArgs.data.key ?? ''}:${parsedArgs.data.replace_id ?? ''}:${parsedArgs.data.content}`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          parsedMemories.push(parsedArgs.data);
        }
      }
      const first = parsedMemories[0]!;
      const allSameKind = parsedMemories.every((item) => item.kind === first.kind);
      const distinctKeys = new Set(
        parsedMemories.map((item) => item.key).filter((k): k is string => k !== undefined),
      );
      const sharedKey =
        parsedMemories.length === 1
          ? first.key
          : distinctKeys.size === 1 && parsedMemories.every((item) => item.key !== undefined)
            ? [...distinctKeys][0]
            : undefined;
      const distinctReplaceIds = new Set(
        parsedMemories
          .map((item) => item.replace_id)
          .filter((id): id is string => id !== undefined),
      );
      const sharedReplaceId =
        parsedMemories.length === 1
          ? first.replace_id
          : distinctReplaceIds.size === 1 &&
              parsedMemories.every((item) => item.replace_id !== undefined)
            ? [...distinctReplaceIds][0]
            : undefined;
      const mergedContent =
        parsedMemories.length === 1
          ? first.content
          : clampText(parsedMemories.map((item) => item.content).join('; '), 500).text;
      const ackText =
        rawText.length > 0 ? clampText(rawText, 8_192).text : DEFAULT_MEMORY_SAVE_ACK_TEXT;
      const cleanArgs = {
        kind: allSameKind ? first.kind : ('fact' as const),
        content: mergedContent,
        ...(sharedKey === undefined ? {} : { key: sharedKey }),
        ...(sharedReplaceId === undefined ? {} : { replaceId: sharedReplaceId }),
      };
      return Object.freeze({
        kind: 'save_memory' as const,
        toolName: SAVE_PERSONAL_MEMORY_TOOL_NAME,
        text: ackText,
        finishReason,
        memory: Object.freeze({
          toolName: SAVE_PERSONAL_MEMORY_TOOL_NAME,
          arguments: Object.freeze(cleanArgs),
        }),
      });
    }

    const call = toolCalls[0]!;
    if (call.type !== 'function') {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    let rawArgs: unknown;
    try {
      rawArgs = JSON.parse(call.function.arguments);
    } catch {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    if (call.function.name === DELEGATE_NOTES_TOOL_NAME) {
      if (options?.allowDelegation === false) {
        throw new ModelGatewayFailure('model_invalid_output');
      }
      const parsedArgs = delegateNotesToolArgsSchema.safeParse(rawArgs);
      if (!parsedArgs.success) {
        throw new ModelGatewayFailure('model_invalid_output');
      }

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

    if (call.function.name === DELEGATE_PYTHON_TOOL_NAME) {
      if (options?.allowDelegation === false) {
        throw new ModelGatewayFailure('model_invalid_output');
      }
      const parsedArgs = delegatePythonToolArgsSchema.safeParse(rawArgs);
      if (!parsedArgs.success) {
        throw new ModelGatewayFailure('model_invalid_output');
      }

      const ackText =
        rawText.length > 0 ? clampText(rawText, 8_192).text : DEFAULT_PYTHON_DELEGATION_ACK_TEXT;
      const dedupedAttachmentIds =
        parsedArgs.data.attachment_ids === undefined
          ? undefined
          : Object.freeze([...new Set(parsedArgs.data.attachment_ids)]);

      const cleanArgs = {
        prompt: parsedArgs.data.prompt,
        ...(parsedArgs.data.title === undefined ? {} : { title: parsedArgs.data.title }),
        ...(parsedArgs.data.instructions === undefined
          ? {}
          : { instructions: parsedArgs.data.instructions }),
        ...(dedupedAttachmentIds === undefined || dedupedAttachmentIds.length === 0
          ? {}
          : { attachmentIds: dedupedAttachmentIds }),
      };

      return Object.freeze({
        kind: 'delegate' as const,
        toolName: DELEGATE_PYTHON_TOOL_NAME,
        text: ackText,
        finishReason,
        delegation: Object.freeze({
          toolName: DELEGATE_PYTHON_TOOL_NAME,
          arguments: Object.freeze(cleanArgs),
        }),
      });
    }

    if (call.function.name === SAVE_PERSONAL_MEMORY_TOOL_NAME) {
      if (options?.allowSavePersonalMemory !== true) {
        throw new ModelGatewayFailure('model_invalid_output');
      }
      const parsedArgs = savePersonalMemoryToolArgsSchema.safeParse(rawArgs);
      if (!parsedArgs.success) {
        throw new ModelGatewayFailure('model_invalid_output');
      }

      const ackText =
        rawText.length > 0 ? clampText(rawText, 8_192).text : DEFAULT_MEMORY_SAVE_ACK_TEXT;
      const cleanArgs = {
        kind: parsedArgs.data.kind,
        content: parsedArgs.data.content,
        ...(parsedArgs.data.key === undefined ? {} : { key: parsedArgs.data.key }),
        ...(parsedArgs.data.replace_id === undefined
          ? {}
          : { replaceId: parsedArgs.data.replace_id }),
      };

      return Object.freeze({
        kind: 'save_memory' as const,
        toolName: SAVE_PERSONAL_MEMORY_TOOL_NAME,
        text: ackText,
        finishReason,
        memory: Object.freeze({
          toolName: SAVE_PERSONAL_MEMORY_TOOL_NAME,
          arguments: Object.freeze(cleanArgs),
        }),
      });
    }

    if (call.function.name === DELETE_PERSONAL_MEMORY_TOOL_NAME) {
      if (options?.allowSavePersonalMemory !== true) {
        throw new ModelGatewayFailure('model_invalid_output');
      }
      const parsedArgs = deletePersonalMemoryToolArgsSchema.safeParse(rawArgs);
      if (!parsedArgs.success) {
        throw new ModelGatewayFailure('model_invalid_output');
      }

      const ackText =
        rawText.length > 0 ? clampText(rawText, 8_192).text : DEFAULT_MEMORY_DELETE_ACK_TEXT;
      const target = Object.freeze({
        ...(parsedArgs.data.memory_id === undefined ? {} : { memoryId: parsedArgs.data.memory_id }),
        ...(parsedArgs.data.key === undefined ? {} : { key: parsedArgs.data.key }),
        ...(parsedArgs.data.content_match === undefined
          ? {}
          : { contentMatch: parsedArgs.data.content_match }),
      });

      return Object.freeze({
        kind: 'delete_memory' as const,
        toolName: DELETE_PERSONAL_MEMORY_TOOL_NAME,
        text: ackText,
        finishReason,
        memory: Object.freeze({
          toolName: DELETE_PERSONAL_MEMORY_TOOL_NAME,
          arguments: Object.freeze({ targets: Object.freeze([target]) }),
        }),
      });
    }

    if (call.function.name === CREATE_PROACTIVE_SCHEDULE_TOOL_NAME) {
      if (options?.allowCreateProactiveSchedule !== true) {
        throw new ModelGatewayFailure('model_invalid_output');
      }
      const parsedArgs = createProactiveScheduleToolArgsSchema.safeParse(rawArgs);
      if (!parsedArgs.success) {
        throw new ModelGatewayFailure('model_invalid_output');
      }

      const ackText =
        rawText.length > 0 ? clampText(rawText, 8_192).text : DEFAULT_PROACTIVE_SCHEDULE_ACK_TEXT;
      const d = parsedArgs.data;
      const cleanArgs: CreateProactiveScheduleToolArguments = {
        kind: d.kind,
        title: d.title,
        prompt: d.prompt,
        triggerType: d.trigger_type,
        ...(d.fire_at === undefined ? {} : { fireAt: d.fire_at }),
        ...(d.interval_seconds === undefined ? {} : { intervalSeconds: d.interval_seconds }),
        ...(d.cron_expr === undefined ? {} : { cronExpr: d.cron_expr }),
        ...(d.timezone === undefined ? {} : { timezone: d.timezone }),
        ...(d.delivery_mode === undefined ? {} : { deliveryMode: d.delivery_mode }),
      };

      return Object.freeze({
        kind: 'create_schedule' as const,
        toolName: CREATE_PROACTIVE_SCHEDULE_TOOL_NAME,
        text: ackText,
        finishReason,
        schedule: Object.freeze({
          toolName: CREATE_PROACTIVE_SCHEDULE_TOOL_NAME,
          arguments: Object.freeze(cleanArgs),
        }),
      });
    }

    throw new ModelGatewayFailure('model_invalid_output');
  }

  const text = choice.message.content;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ModelGatewayFailure('model_invalid_output');
  }

  if (FORBIDDEN_PLAIN_TEXT_DELEGATION_REPLIES.has(text.trim())) {
    throw new ModelGatewayFailure('model_invalid_output');
  }

  return Object.freeze({
    kind: 'reply' as const,
    text,
    finishReason,
  });
}

export function parsePythonAgentStepChoice(
  choice: {
    readonly message: z.infer<typeof completionMessageSchema>;
    readonly finish_reason?: string | null | undefined;
  },
  remainingPythonCalls: number,
): PythonAgentStepOutput {
  const finishReason = choice.finish_reason === 'length' ? ('length' as const) : ('stop' as const);
  const toolCalls = choice.message.tool_calls;

  if (toolCalls !== undefined && toolCalls.length > 0) {
    if (remainingPythonCalls <= 0 || toolCalls.length !== 1) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const call = toolCalls[0]!;
    if (call.type !== 'function' || call.function.name !== RUN_PYTHON_TOOL_NAME) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    let rawArgs: unknown;
    try {
      rawArgs = JSON.parse(call.function.arguments);
    } catch {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const parsedArgs = runPythonToolArgsSchema.safeParse(rawArgs);
    if (!parsedArgs.success) {
      throw new ModelGatewayFailure('model_invalid_output');
    }

    const assistantText =
      typeof choice.message.content === 'string' && choice.message.content.trim().length > 0
        ? choice.message.content.trim()
        : undefined;

    return Object.freeze({
      kind: 'tool_call' as const,
      toolCallId:
        call.id ?? `call_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      code: parsedArgs.data.code,
      ...(parsedArgs.data.purpose === undefined ? {} : { purpose: parsedArgs.data.purpose }),
      rawArgumentsJson: call.function.arguments,
      ...(assistantText === undefined ? {} : { assistantText }),
    });
  }

  const rawContent = choice.message.content;
  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    throw new ModelGatewayFailure('model_invalid_output');
  }

  const trimmed = rawContent.trim();
  const firstLine =
    trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? trimmed;
  const summary = clampText(firstLine, Math.min(240, MODEL_LIMITS.resultSummaryMaxChars));
  const detail = clampText(trimmed, MODEL_LIMITS.resultDetailMaxChars);

  return Object.freeze({
    kind: 'final' as const,
    summaryText: summary.text,
    detailText: detail.text,
    truncated: summary.truncated || detail.truncated || finishReason === 'length',
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
  let head = text.slice(0, keep);
  if (head.length > 0) {
    const lastCode = head.charCodeAt(head.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      head = head.slice(0, -1);
    }
  }
  return {
    text: `${head.trimEnd()}${suffix}`,
    truncated: true,
  };
}

export function assertAuthorizedBeforeFetch(isAuthorized: () => boolean): void {
  if (!isAuthorized()) {
    throw new ModelAuthorizationRefused();
  }
}
