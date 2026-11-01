/**
 * Deterministic Fake Source Reader for @ember/connectors.
 *
 * Implements:
 * - 100% deterministic fixture retrieval; zero external network calls.
 * - Strict bounds checking, UTF-8 byte validation, and content sanitization.
 * - SHA-256 digest computed over canonical JSON representation.
 * - Deep immutability via recursive Object.freeze.
 * - Cooperative cancellation via AbortSignal.
 */

import { computeCanonicalDigest, deepFreeze } from './canonical.js';
import { createCancelledError, createNotFoundError } from './errors.js';
import {
  FIXTURE_ALERTS_ITEMS,
  FIXTURE_PROFILE_ALERTS,
  FIXTURE_PROFILE_RELEASES,
  FIXTURE_RELEASES_ITEMS,
} from './fixtures.js';
import { sanitizeSnapshotItem, validateSnapshotBounds } from './sanitizer.js';
import {
  SOURCE_SNAPSHOT_LIMITS,
  type SourceReader,
  type SourceSnapshot,
  type SourceSnapshotItem,
  type TrustedSourceAccessContext,
} from './types.js';

export interface FakeSourceReaderOptions {
  /** Optional custom fixtures mapped by sourceProfileId */
  readonly fixtureMap?: Map<string, readonly SourceSnapshotItem[]>;
  /** Optional artificial latency in ms to test cooperative cancellation */
  readonly simulatedLatencyMs?: number;
  /** Optional fixed observation timestamp for deterministic tests */
  readonly fixedObservedAt?: string;
  /** Custom max payload bytes ceiling */
  readonly maxPayloadBytes?: number;
}

export class FakeSourceReader implements SourceReader {
  private readonly fixtures = new Map<string, readonly SourceSnapshotItem[]>();
  private readonly simulatedLatencyMs: number;
  private readonly fixedObservedAt?: string;
  private readonly maxPayloadBytes: number;

  constructor(options: FakeSourceReaderOptions = {}) {
    this.simulatedLatencyMs = options.simulatedLatencyMs ?? 0;
    this.fixedObservedAt = options.fixedObservedAt;
    this.maxPayloadBytes = options.maxPayloadBytes ?? SOURCE_SNAPSHOT_LIMITS.maxPayloadBytes;

    // Load defaults
    this.fixtures.set(FIXTURE_PROFILE_RELEASES.sourceProfileId, FIXTURE_RELEASES_ITEMS);
    this.fixtures.set(FIXTURE_PROFILE_ALERTS.sourceProfileId, FIXTURE_ALERTS_ITEMS);

    // Overlay custom fixtures
    if (options.fixtureMap) {
      for (const [key, items] of options.fixtureMap.entries()) {
        this.fixtures.set(key, items);
      }
    }
  }

  setFixture(sourceProfileId: string, items: readonly SourceSnapshotItem[]): void {
    this.fixtures.set(sourceProfileId, items);
  }

  async readSnapshot(
    sourceProfileId: string,
    _context: TrustedSourceAccessContext,
    signal?: AbortSignal,
  ): Promise<SourceSnapshot> {
    if (signal?.aborted) {
      throw createCancelledError('Snapshot read was aborted prior to execution');
    }

    if (this.simulatedLatencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve();
        }, this.simulatedLatencyMs);

        const onAbort = () => {
          clearTimeout(timer);
          reject(createCancelledError('Snapshot read was aborted during simulated latency'));
        };

        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    if (signal?.aborted) {
      throw createCancelledError('Snapshot read was aborted after execution');
    }

    const rawItems = this.fixtures.get(sourceProfileId);
    if (!rawItems) {
      throw createNotFoundError(`No fixture found for sourceProfileId: ${sourceProfileId}`);
    }

    // Sanitize and validate every item
    const sanitizedItems: SourceSnapshotItem[] = rawItems.map((item, idx) =>
      sanitizeSnapshotItem(item, idx),
    );

    // Validate bounds (items count and total UTF-8 payload bytes)
    validateSnapshotBounds(sanitizedItems, SOURCE_SNAPSHOT_LIMITS.maxItems, this.maxPayloadBytes);

    // Compute canonical digest over canonical JSON representation of { sourceProfileId, items }
    const digest = computeCanonicalDigest({
      sourceProfileId,
      items: sanitizedItems,
    });

    const observedAt = this.fixedObservedAt ?? new Date().toISOString();

    const snapshot: SourceSnapshot = {
      sourceProfileId,
      observedAt,
      digest,
      items: Object.freeze(sanitizedItems),
    };

    return deepFreeze(snapshot);
  }
}
