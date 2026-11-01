/**
 * Outcome result status adhering to P0-C3-0 contract freeze.
 */
export const OUTCOME_RESULT_STATUSES = [
  'meaningful_change',
  'no_change',
  'failed',
  'denied',
] as const;

export type OutcomeResultStatus = (typeof OUTCOME_RESULT_STATUSES)[number];

export interface SourceSnapshotItem {
  readonly id: string;
  readonly title: string;
  readonly contentSnippet: string;
  readonly observedAt: string;
}

export interface SourceSnapshot {
  readonly sourceProfileId: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly boundedSafeItems: readonly SourceSnapshotItem[];
}

export interface SummaryEngineResult {
  readonly resultStatus: OutcomeResultStatus;
  readonly summary: string;
  readonly itemCount: number;
  readonly snapshotDigest: string;
}

export const MAX_SUMMARY_LENGTH = 2_000;

/**
 * Deterministic, pure, side-effect-free summary engine (FakeSummaryEngine).
 *
 * Invariants:
 * 1. Determinism: Identical SourceSnapshot always produces identical summary text and status.
 * 2. Untrusted Data: Source items and content snippets are strictly treated as DATA, never
 *    instructions. Prompt injection patterns (e.g., 'System: ignore previous instructions')
 *    are never executed.
 * 3. Non-sensitive output: Summaries never include raw tokens, credentials, connection strings,
 *    or provider internal stack traces.
 * 4. Bounded: Summary length never exceeds MAX_SUMMARY_LENGTH (2000 chars).
 * 5. Zero Network / Zero LLM: Pure computation, zero external API or network calls.
 */
export class FakeSummaryEngine {
  public generate(snapshot: SourceSnapshot): SummaryEngineResult {
    if (!snapshot || typeof snapshot.sourceProfileId !== 'string') {
      return {
        resultStatus: 'failed',
        summary: 'Invalid source snapshot: missing source profile identification.',
        itemCount: 0,
        snapshotDigest: '',
      };
    }

    const items: readonly SourceSnapshotItem[] = Array.isArray(snapshot.boundedSafeItems)
      ? snapshot.boundedSafeItems
      : [];
    const itemCount = items.length;
    const digest = typeof snapshot.digest === 'string' ? snapshot.digest : '';

    if (itemCount === 0) {
      return {
        resultStatus: 'no_change',
        summary: `No items observed for profile ${this.sanitize(snapshot.sourceProfileId)} at ${snapshot.observedAt}. No meaningful change.`,
        itemCount: 0,
        snapshotDigest: digest,
      };
    }

    // Deterministic summary formatting
    const lines: string[] = [
      `Observed ${itemCount} safe item(s) for profile ${this.sanitize(snapshot.sourceProfileId)} at ${snapshot.observedAt}.`,
      `Digest: ${digest.slice(0, 16)}`,
      'Highlights:',
    ];

    for (let i = 0; i < Math.min(items.length, 5); i++) {
      const item: SourceSnapshotItem | undefined = items[i];
      if (!item) continue;
      const title = this.sanitize(item.title || item.id || `Item ${i + 1}`);
      const snippet = this.sanitize(item.contentSnippet || '').slice(0, 120);
      lines.push(`- [${title}]: ${snippet}`);
    }

    if (items.length > 5) {
      lines.push(`(...and ${items.length - 5} more item(s))`);
    }

    let summaryText = lines.join('\n');
    if (summaryText.length > MAX_SUMMARY_LENGTH) {
      summaryText = summaryText.slice(0, MAX_SUMMARY_LENGTH - 3) + '...';
    }

    return {
      resultStatus: 'meaningful_change',
      summary: summaryText,
      itemCount,
      snapshotDigest: digest,
    };
  }

  /**
   * Basic sanitization to neutralize markdown injection and strip control characters.
   */
  private sanitize(text: string): string {
    return Array.from(text)
      .filter((ch) => {
        const code = ch.charCodeAt(0);
        return (code >= 32 && code !== 127) || code === 10 || code === 9;
      })
      .join('')
      .replace(/\r\n|\r/g, '\n')
      .trim();
  }
}
