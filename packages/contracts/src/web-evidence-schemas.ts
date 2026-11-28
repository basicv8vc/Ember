import { z } from 'zod';
import { IdSchema } from './task-schemas.js';

/**
 * Hard bounds for the frozen V2 Web Evidence wire contract (Issue #302 PR A).
 * Changing any limit here is a wire contract change and must remain backwards
 * compatible with iOS/Web clients consuming `schema_version = 1`.
 */
export const WEB_EVIDENCE_LIMITS = Object.freeze({
  schemaVersion: 1,
  maxSources: 10,
  maxUrlChars: 2_048,
  maxTitleChars: 200,
  maxDomainChars: 253,
  maxSnippetChars: 400,
  maxPublishedAtChars: 64,
  maxSourceIdChars: 64,
  maxSerializedBytes: 16 * 1024,
} as const);

export const WEB_EVIDENCE_STATUSES = ['completed', 'partial', 'failed'] as const;
export type WebEvidenceStatus = (typeof WEB_EVIDENCE_STATUSES)[number];
export const WebEvidenceStatusSchema = z.enum(WEB_EVIDENCE_STATUSES);

const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isValidPublicHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return false;
    }
    return parsed.hostname.trim().length > 0;
  } catch {
    return false;
  }
}

export const WebSourceUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(WEB_EVIDENCE_LIMITS.maxUrlChars)
  .refine(isValidPublicHttpUrl, {
    message: 'url must be an http or https URL without embedded credentials',
  });

export const WebSourceSchema = z.strictObject({
  source_id: z.string().trim().min(1).max(WEB_EVIDENCE_LIMITS.maxSourceIdChars),
  index: z.number().int().min(1).max(WEB_EVIDENCE_LIMITS.maxSources),
  title: z.string().trim().min(1).max(WEB_EVIDENCE_LIMITS.maxTitleChars),
  url: WebSourceUrlSchema,
  domain: z.string().trim().min(1).max(WEB_EVIDENCE_LIMITS.maxDomainChars),
  snippet: z.string().trim().min(1).max(WEB_EVIDENCE_LIMITS.maxSnippetChars).optional(),
  published_at: z.string().trim().min(1).max(WEB_EVIDENCE_LIMITS.maxPublishedAtChars).optional(),
  fetched: z.boolean(),
});
export type WebSource = z.infer<typeof WebSourceSchema>;

export const WebEvidenceSchema = z
  .strictObject({
    schema_version: z.literal(WEB_EVIDENCE_LIMITS.schemaVersion),
    turn_id: IdSchema,
    status: WebEvidenceStatusSchema,
    sources: z.array(WebSourceSchema).max(WEB_EVIDENCE_LIMITS.maxSources),
  })
  .superRefine((value, ctx) => {
    if (value.status !== 'failed' && value.sources.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources'],
        message: 'completed or partial web evidence must include at least one source',
      });
    }

    const seenSourceIds = new Set<string>();
    const seenUrls = new Set<string>();

    for (let i = 0; i < value.sources.length; i += 1) {
      const source = value.sources[i]!;
      if (source.index !== i + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', i, 'index'],
          message: `source index must equal 1-based position ${i + 1}`,
        });
      }
      if (seenSourceIds.has(source.source_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', i, 'source_id'],
          message: 'source_id values must be unique within web_evidence',
        });
      }
      seenSourceIds.add(source.source_id);

      if (seenUrls.has(source.url)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', i, 'url'],
          message: 'source url values must be unique within web_evidence',
        });
      }
      seenUrls.add(source.url);
    }

    if (utf8ByteLength(JSON.stringify(value)) > WEB_EVIDENCE_LIMITS.maxSerializedBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources'],
        message: `web_evidence JSON exceeds ${WEB_EVIDENCE_LIMITS.maxSerializedBytes} UTF-8 bytes`,
      });
    }
  });
export type WebEvidence = z.infer<typeof WebEvidenceSchema>;

export const V2WebEvidenceItemSchema = z.strictObject({
  response_message_id: IdSchema,
  sequence: z.number().int().min(1),
  web_evidence: WebEvidenceSchema,
});
export type V2WebEvidenceItem = z.infer<typeof V2WebEvidenceItemSchema>;

export const V2ConversationWebEvidencePageSchema = z.strictObject({
  conversation_id: IdSchema,
  transcript_epoch: z.number().int().min(0),
  items: z.array(V2WebEvidenceItemSchema),
  next_after: z.number().int().min(0),
  has_more: z.boolean(),
});
export type V2ConversationWebEvidencePage = z.infer<typeof V2ConversationWebEvidencePageSchema>;
