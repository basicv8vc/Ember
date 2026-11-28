import { sanitizePublicWebUrl, type WebFetchContentKind } from './web-search.js';

export const WEB_EVIDENCE_COLLECTOR_LIMITS = Object.freeze({
  schemaVersion: 1,
  maxSources: 10,
  maxUrlChars: 2_048,
  maxTitleChars: 200,
  maxDomainChars: 253,
  maxSnippetChars: 400,
  maxPublishedAtChars: 64,
  maxSerializedBytes: 16 * 1024,
} as const);

export type WebEvidenceStatus = 'completed' | 'partial' | 'failed';

export interface WebSource {
  readonly source_id: string;
  readonly index: number;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly snippet?: string;
  readonly published_at?: string;
  readonly fetched: boolean;
}

export interface WebEvidence {
  readonly schema_version: 1;
  readonly turn_id: string;
  readonly status: WebEvidenceStatus;
  readonly sources: readonly WebSource[];
}

export interface SearchEvidenceResultInput {
  readonly url: string;
  readonly title: string;
  readonly snippet?: string;
  readonly snippets?: readonly string[];
  readonly publishedDate?: string;
}

export interface FetchEvidenceResultInput {
  readonly url: string;
  readonly title: string;
  readonly publishedDate?: string;
  readonly content: string;
  readonly contentKind?: WebFetchContentKind;
}

const textEncoder = new TextEncoder();

interface MutableSourceDraft {
  readonly source_id: string;
  title: string;
  readonly url: string;
  readonly domain: string;
  snippet?: string;
  published_at?: string;
  fetched: boolean;
}

function sliceSafely(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  let end = maxChars - 1;
  const code = value.charCodeAt(end - 1);
  // Avoid splitting a UTF-16 surrogate pair before appending ellipsis.
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return `${value.slice(0, end).trimEnd()}…`;
}

function normalizeBoundedText(raw: string | undefined, maxChars: number): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return undefined;
  }
  return sliceSafely(collapsed, maxChars);
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function deterministicSourceId(turnId: string, canonicalUrl: string): string {
  const payload = `${turnId}\n${canonicalUrl}`;
  const hi = fnv1a32(payload, 0x811c9dc5).toString(16).padStart(8, '0');
  const lo = fnv1a32(`v1:${payload}`, 0x050c5d1f).toString(16).padStart(8, '0');
  return `ws_${hi}${lo}`;
}

export function canonicalizeWebEvidenceUrl(rawUrl: string): string | null {
  const sanitized = sanitizePublicWebUrl(rawUrl);
  if (sanitized === null) {
    return null;
  }
  try {
    const parsed = new URL(sanitized);
    let normalized = parsed.toString();
    // WHATWG URL retains a lone trailing `#` even when `parsed.hash === ''`; strip it for deduping.
    if (parsed.hash === '' && normalized.endsWith('#')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized.length <= WEB_EVIDENCE_COLLECTOR_LIMITS.maxUrlChars ? normalized : null;
  } catch {
    return null;
  }
}

export function extractDomainFromUrl(canonicalUrl: string): string {
  const hostname = new URL(canonicalUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const trimmed = hostname.trim();
  if (trimmed.length === 0) {
    return 'unknown';
  }
  return trimmed.slice(0, WEB_EVIDENCE_COLLECTOR_LIMITS.maxDomainChars);
}

function serializeToIndexedSources(drafts: readonly MutableSourceDraft[]): WebSource[] {
  return drafts.map((draft, idx) => ({
    source_id: draft.source_id,
    index: idx + 1,
    title: draft.title,
    url: draft.url,
    domain: draft.domain,
    ...(draft.snippet !== undefined ? { snippet: draft.snippet } : {}),
    ...(draft.published_at !== undefined ? { published_at: draft.published_at } : {}),
    fetched: draft.fetched,
  }));
}

/**
 * Collects deterministic, bounded, URL-validated web search and page fetch receipts
 * for a single conversation turn without making extra network or model calls.
 */
export class WebEvidenceCollector {
  readonly #turnId: string;
  readonly #orderedUrls: string[] = [];
  readonly #sourcesByUrl = new Map<string, MutableSourceDraft>();
  #hadFailure = false;

  constructor(turnId: string) {
    const trimmed = turnId.trim();
    if (trimmed.length === 0) {
      throw new RangeError('turnId must be a non-empty string');
    }
    this.#turnId = trimmed;
  }

  recordSearchSuccess(results: readonly SearchEvidenceResultInput[]): void {
    for (const item of results) {
      const canonicalUrl = canonicalizeWebEvidenceUrl(item.url);
      if (canonicalUrl === null) {
        continue;
      }

      const domain = extractDomainFromUrl(canonicalUrl);
      const nextTitle =
        normalizeBoundedText(item.title, WEB_EVIDENCE_COLLECTOR_LIMITS.maxTitleChars) ?? domain;
      const rawSnippet =
        item.snippet ?? (item.snippets !== undefined ? item.snippets.join(' ') : undefined);
      const nextSnippet = normalizeBoundedText(
        rawSnippet,
        WEB_EVIDENCE_COLLECTOR_LIMITS.maxSnippetChars,
      );
      const trimmedPublished = item.publishedDate?.trim();
      const nextPublishedAt =
        trimmedPublished &&
        trimmedPublished.length > 0 &&
        trimmedPublished.length <= WEB_EVIDENCE_COLLECTOR_LIMITS.maxPublishedAtChars
          ? trimmedPublished
          : undefined;

      const existing = this.#sourcesByUrl.get(canonicalUrl);
      if (existing !== undefined) {
        if (existing.title === existing.domain && nextTitle !== domain) {
          existing.title = nextTitle;
        }
        if (existing.snippet === undefined && nextSnippet !== undefined) {
          existing.snippet = nextSnippet;
        }
        if (existing.published_at === undefined && nextPublishedAt !== undefined) {
          existing.published_at = nextPublishedAt;
        }
        continue;
      }

      if (this.#orderedUrls.length >= WEB_EVIDENCE_COLLECTOR_LIMITS.maxSources) {
        continue;
      }

      const draft: MutableSourceDraft = {
        source_id: deterministicSourceId(this.#turnId, canonicalUrl),
        title: nextTitle,
        url: canonicalUrl,
        domain,
        ...(nextSnippet !== undefined ? { snippet: nextSnippet } : {}),
        ...(nextPublishedAt !== undefined ? { published_at: nextPublishedAt } : {}),
        fetched: false,
      };
      this.#orderedUrls.push(canonicalUrl);
      this.#sourcesByUrl.set(canonicalUrl, draft);
    }
  }

  getSourceIndexForUrl(rawUrl: string): number | undefined {
    const canonicalUrl = canonicalizeWebEvidenceUrl(rawUrl);
    if (canonicalUrl === null) {
      return undefined;
    }
    const zeroBased = this.#orderedUrls.indexOf(canonicalUrl);
    return zeroBased >= 0 ? zeroBased + 1 : undefined;
  }

  recordFetchSuccess(result: FetchEvidenceResultInput): void {
    // Only mark a source as fetched when real full-page text was extracted;
    // highlights-only fallbacks or empty bodies must stay fetched=false.
    if (result.content.trim().length === 0 || result.contentKind === 'empty') {
      return;
    }
    const hasFullText = result.contentKind !== 'highlights';

    const canonicalUrl = canonicalizeWebEvidenceUrl(result.url);
    if (canonicalUrl === null) {
      return;
    }

    const domain = extractDomainFromUrl(canonicalUrl);
    const candidateTitle = normalizeBoundedText(
      result.title,
      WEB_EVIDENCE_COLLECTOR_LIMITS.maxTitleChars,
    );
    const contentSnippet = normalizeBoundedText(
      result.content,
      WEB_EVIDENCE_COLLECTOR_LIMITS.maxSnippetChars,
    );
    const trimmedPublished = result.publishedDate?.trim();
    const nextPublishedAt =
      trimmedPublished &&
      trimmedPublished.length > 0 &&
      trimmedPublished.length <= WEB_EVIDENCE_COLLECTOR_LIMITS.maxPublishedAtChars
        ? trimmedPublished
        : undefined;

    const existing = this.#sourcesByUrl.get(canonicalUrl);
    if (existing !== undefined) {
      if (hasFullText) {
        existing.fetched = true;
      }
      if (
        candidateTitle !== undefined &&
        candidateTitle !== canonicalUrl &&
        existing.title === existing.domain
      ) {
        existing.title = candidateTitle;
      }
      if (existing.snippet === undefined && contentSnippet !== undefined) {
        existing.snippet = contentSnippet;
      }
      if (existing.published_at === undefined && nextPublishedAt !== undefined) {
        existing.published_at = nextPublishedAt;
      }
      return;
    }

    if (this.#orderedUrls.length >= WEB_EVIDENCE_COLLECTOR_LIMITS.maxSources) {
      return;
    }

    const draft: MutableSourceDraft = {
      source_id: deterministicSourceId(this.#turnId, canonicalUrl),
      title:
        candidateTitle !== undefined && candidateTitle !== canonicalUrl ? candidateTitle : domain,
      url: canonicalUrl,
      domain,
      ...(contentSnippet !== undefined ? { snippet: contentSnippet } : {}),
      ...(nextPublishedAt !== undefined ? { published_at: nextPublishedAt } : {}),
      fetched: hasFullText,
    };
    this.#orderedUrls.push(canonicalUrl);
    this.#sourcesByUrl.set(canonicalUrl, draft);
  }

  recordToolFailure(): void {
    this.#hadFailure = true;
  }

  build(): WebEvidence | undefined {
    if (this.#orderedUrls.length === 0) {
      return undefined;
    }

    const drafts: MutableSourceDraft[] = this.#orderedUrls.map((url) => ({
      ...this.#sourcesByUrl.get(url)!,
    }));
    const status: WebEvidenceStatus = this.#hadFailure ? 'partial' : 'completed';

    let candidate: WebEvidence = {
      schema_version: WEB_EVIDENCE_COLLECTOR_LIMITS.schemaVersion,
      turn_id: this.#turnId,
      status,
      sources: serializeToIndexedSources(drafts),
    };

    // Trim optional snippets from trailing sources first to honor the 16 KiB cap.
    for (
      let i = drafts.length - 1;
      i >= 0 &&
      textEncoder.encode(JSON.stringify(candidate)).byteLength >
        WEB_EVIDENCE_COLLECTOR_LIMITS.maxSerializedBytes;
      i -= 1
    ) {
      if (drafts[i]!.snippet !== undefined) {
        delete drafts[i]!.snippet;
        candidate = {
          ...candidate,
          sources: serializeToIndexedSources(drafts),
        };
      }
    }

    // If still above budget (e.g., max-length URLs), drop trailing sources cleanly.
    while (
      drafts.length > 0 &&
      textEncoder.encode(JSON.stringify(candidate)).byteLength >
        WEB_EVIDENCE_COLLECTOR_LIMITS.maxSerializedBytes
    ) {
      drafts.pop();
      candidate = {
        ...candidate,
        sources: serializeToIndexedSources(drafts),
      };
    }

    return drafts.length > 0 ? candidate : undefined;
  }
}
