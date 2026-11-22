import { z } from 'zod';
import type { AgentHeadCallerScope } from './agent-head-rpc.js';

export const PERSONAL_MEMORY_MAX_ITEMS = 50;
export const PERSONAL_MEMORY_MAX_CONTENT_CHARS = 500;
export const PERSONAL_MEMORY_MAX_KEY_CHARS = 64;
export const PERSONAL_MEMORY_MAX_RETRIEVED_ITEMS = 20;
export const PERSONAL_MEMORY_MAX_RETRIEVED_CHARS = 2_000;

export const personalMemoryIdSchema = z.uuid().transform((id) => id.toLowerCase());
export const personalMemoryKindSchema = z.enum(['preference', 'fact']);
export type PersonalMemoryKind = z.infer<typeof personalMemoryKindSchema>;

export const personalMemorySourceSchema = z.enum(['explicit_user_request', 'user_settings']);
export type PersonalMemorySource = z.infer<typeof personalMemorySourceSchema>;

export const personalMemoryKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(PERSONAL_MEMORY_MAX_KEY_CHARS)
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'invalid personal memory key');

export const personalMemoryContentSchema = z
  .string()
  .trim()
  .min(1)
  .max(PERSONAL_MEMORY_MAX_CONTENT_CHARS)
  .refine((text) => !/\p{Surrogate}/u.test(text), 'content contains invalid surrogate');

export const personalMemoryProvenanceInputSchema = z.strictObject({
  source: personalMemorySourceSchema,
  conversation_id: personalMemoryIdSchema.optional(),
  message_id: personalMemoryIdSchema.optional(),
});

export const savePersonalMemoryRequestSchema = z.strictObject({
  kind: personalMemoryKindSchema,
  content: personalMemoryContentSchema,
  key: personalMemoryKeySchema.optional(),
  client_request_id: personalMemoryIdSchema.optional(),
  provenance: personalMemoryProvenanceInputSchema,
});

export type SavePersonalMemoryRequest = z.infer<typeof savePersonalMemoryRequestSchema>;

export const personalMemoryRefIdSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^#+/, '').toLowerCase())
  .refine(
    (value) => /^[0-9a-f][0-9a-f-]{3,63}$/.test(value),
    'invalid personal memory reference id',
  );

export const personalMemorySaveTurnCommandSchema = z.strictObject({
  kind: personalMemoryKindSchema,
  content: personalMemoryContentSchema,
  key: personalMemoryKeySchema.optional(),
  replaceId: personalMemoryRefIdSchema.optional(),
});

export type PersonalMemorySaveTurnCommand = z.infer<typeof personalMemorySaveTurnCommandSchema>;

export const personalMemoryDeleteTargetSchema = z
  .strictObject({
    memoryId: personalMemoryRefIdSchema.optional(),
    key: personalMemoryKeySchema.optional(),
    contentMatch: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((text) => !/\p{Surrogate}/u.test(text), 'content_match contains invalid surrogate')
      .optional(),
  })
  .refine(
    (value) =>
      value.memoryId !== undefined || value.key !== undefined || value.contentMatch !== undefined,
    'at least one selector is required',
  )
  .readonly();

export type PersonalMemoryDeleteTarget = z.infer<typeof personalMemoryDeleteTargetSchema>;

export const personalMemoryDeleteTurnCommandSchema = z
  .strictObject({
    targets: z.array(personalMemoryDeleteTargetSchema).min(1).max(10).readonly(),
  })
  .readonly();

export type PersonalMemoryDeleteTurnCommand = z.infer<typeof personalMemoryDeleteTurnCommandSchema>;

export const updatePersonalMemoryRequestSchema = z
  .strictObject({
    kind: personalMemoryKindSchema.optional(),
    content: personalMemoryContentSchema.optional(),
    key: personalMemoryKeySchema.nullable().optional(),
  })
  .refine(
    (value) => value.kind !== undefined || value.content !== undefined || value.key !== undefined,
    'at least one field must be provided',
  );

export type UpdatePersonalMemoryRequest = z.infer<typeof updatePersonalMemoryRequestSchema>;

export interface PersonalMemoryProvenanceDto {
  readonly source: PersonalMemorySource;
  readonly conversation_id: string | null;
  readonly message_id: string | null;
}

export interface PersonalMemoryItemDto {
  readonly memory_id: string;
  readonly kind: PersonalMemoryKind;
  readonly key: string | null;
  readonly content: string;
  readonly provenance: PersonalMemoryProvenanceDto;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PersonalMemoryListDto {
  readonly items: readonly PersonalMemoryItemDto[];
  readonly limits: {
    readonly max_items: number;
    readonly max_content_chars: number;
  };
}

export interface PersonalMemorySaveResultDto {
  readonly item: PersonalMemoryItemDto;
  readonly created: boolean;
}

export interface PersonalMemoryUpdateResultDto {
  readonly item: PersonalMemoryItemDto;
}

export interface PersonalMemoryDeleteResultDto {
  readonly deleted: true;
  readonly memory_id: string;
}

export interface PersonalMemoryContextItem {
  readonly id?: string;
  readonly kind: PersonalMemoryKind;
  readonly key?: string;
  readonly content: string;
}

export type PersonalMemoryCommand = Omit<AgentHeadCallerScope, 'policyVersion'> &
  (
    | { readonly kind: 'list' }
    | { readonly kind: 'save'; readonly input: SavePersonalMemoryRequest }
    | {
        readonly kind: 'update';
        readonly memoryId: string;
        readonly input: UpdatePersonalMemoryRequest;
      }
    | { readonly kind: 'delete'; readonly memoryId: string }
  );

export type PersonalMemoryResponse =
  | PersonalMemoryListDto
  | PersonalMemorySaveResultDto
  | PersonalMemoryUpdateResultDto
  | PersonalMemoryDeleteResultDto;

export interface PersonalMemoryRpc {
  personalMemory(cmd: PersonalMemoryCommand): Promise<PersonalMemoryResponse>;
}
