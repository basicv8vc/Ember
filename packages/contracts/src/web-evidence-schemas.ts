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

const BLOCKED_LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

function parseIPv4Octets(host: string): readonly [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return null;
  }
  const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] as const;
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return octets;
}

function isPublicIPv4Octets(octets: readonly [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a >= 224) return false;
  return true;
}

function parseIPv6Hextets(host: string): readonly number[] | null {
  const cleanHost = host.split('%', 1)[0] ?? host;
  if (!cleanHost.includes(':')) {
    return null;
  }

  let working = cleanHost;
  let embeddedIpv4Octets: readonly [number, number, number, number] | null = null;
  const lastColon = working.lastIndexOf(':');
  const tail = working.slice(lastColon + 1);
  if (tail.includes('.')) {
    embeddedIpv4Octets = parseIPv4Octets(tail);
    if (embeddedIpv4Octets === null) {
      return null;
    }
    const hi = ((embeddedIpv4Octets[0] << 8) | embeddedIpv4Octets[1]).toString(16);
    const lo = ((embeddedIpv4Octets[2] << 8) | embeddedIpv4Octets[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const parts = working.split('::');
  if (parts.length > 2) {
    return null;
  }

  const parseSegment = (segment: string): number[] | null => {
    if (segment === '') return [];
    const groups = segment.split(':');
    const parsed: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) {
        return null;
      }
      parsed.push(Number.parseInt(group, 16));
    }
    return parsed;
  };

  const head = parseSegment(parts[0] ?? '');
  if (head === null) return null;

  if (parts.length === 1) {
    return head.length === 8 ? head : null;
  }

  const tailGroups = parseSegment(parts[1] ?? '');
  if (tailGroups === null) return null;

  const missing = 8 - (head.length + tailGroups.length);
  if (missing < 1) {
    return null;
  }
  return [...head, ...Array.from({ length: missing }, () => 0), ...tailGroups];
}

function isPublicIPv6Hextets(groups: readonly number[]): boolean {
  if (groups.every((g) => g === 0)) return false; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false; // ::1
  if ((groups[0]! & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((groups[0]! & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((groups[0]! & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  // ::ffff:0:0/96 IPv4-mapped IPv6
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const hi = groups[6]!;
    const lo = groups[7]!;
    return isPublicIPv4Octets([
      (hi >> 8) & 0xff,
      hi & 0xff,
      (lo >> 8) & 0xff,
      lo & 0xff,
    ]);
  }
  return true;
}

export function isValidPublicHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return false;
    }
    let host = parsed.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
    while (host.endsWith('.')) {
      host = host.slice(0, -1);
    }
    if (host.length === 0 || host.includes('..')) {
      return false;
    }

    const ipv4 = parseIPv4Octets(host);
    if (ipv4 !== null) {
      return isPublicIPv4Octets(ipv4);
    }

    const ipv6 = parseIPv6Hextets(host);
    if (ipv6 !== null) {
      return isPublicIPv6Hextets(ipv6);
    }

    if (
      BLOCKED_LOCAL_HOSTNAMES.has(host) ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return false;
    }

    const labels = host.split('.');
    if (labels.length < 2 || labels.some((label) => label.length === 0)) {
      return false;
    }
    const tld = labels[labels.length - 1]!;
    return /[a-z]/i.test(tld);
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
    message: 'url must be a public http or https URL without embedded credentials or private/local hosts',
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
