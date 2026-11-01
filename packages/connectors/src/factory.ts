/**
 * Factory and runtime injection helpers for @ember/connectors.
 *
 * Provides ready-to-inject components for Agent B (guarded worker runtime).
 */

import { InMemorySourceAuditSink } from './audit.js';
import { FakeConsentRegistry } from './fake-consent-registry.js';
import { FakeSourceReader } from './fake-source-reader.js';
import { FIXTURE_PROFILE_ALERTS, FIXTURE_PROFILE_RELEASES } from './fixtures.js';
import { GuardedSourceReader } from './guarded-source-reader.js';
import type {
  ConsentRegistry,
  SourceAccessPolicy,
  SourceAuditSink,
  SourceProfile,
  SourceSnapshotItem,
} from './types.js';

export interface CreateFakeGuardedSourceReaderOptions {
  readonly profiles?: readonly SourceProfile[];
  readonly policy?: SourceAccessPolicy;
  readonly registry?: ConsentRegistry;
  readonly auditSink?: SourceAuditSink;
  readonly fixtureMap?: Map<string, readonly SourceSnapshotItem[]>;
  readonly simulatedLatencyMs?: number;
  readonly nowProvider?: () => Date;
}

export interface FakeGuardedSourceReaderBundle {
  readonly guardedReader: GuardedSourceReader;
  readonly innerReader: FakeSourceReader;
  readonly registry: ConsentRegistry;
  readonly auditSink: SourceAuditSink;
  readonly policy: SourceAccessPolicy;
  readonly profiles: ReadonlyMap<string, SourceProfile>;
}

/**
 * Creates a fully wired, guarded fake source reader bundle ready for injection into
 * the commitment execution runtime.
 */
export function createFakeGuardedSourceReader(
  options: CreateFakeGuardedSourceReaderOptions = {},
): FakeGuardedSourceReaderBundle {
  const profileList = options.profiles ?? [FIXTURE_PROFILE_RELEASES, FIXTURE_PROFILE_ALERTS];

  const profileMap = new Map<string, SourceProfile>();
  for (const profile of profileList) {
    profileMap.set(profile.sourceProfileId, profile);
  }

  const defaultPolicy: SourceAccessPolicy = {
    version: 1,
    allowedSourceProfileIds: profileList.map((p) => p.sourceProfileId),
    allowedOperations: ['read_snapshot'],
    defaultAction: 'deny',
  };

  const policy = options.policy ?? defaultPolicy;
  const registry = options.registry ?? new FakeConsentRegistry();
  const auditSink = options.auditSink ?? new InMemorySourceAuditSink();

  const innerReader = new FakeSourceReader({
    fixtureMap: options.fixtureMap,
    simulatedLatencyMs: options.simulatedLatencyMs,
  });

  const guardedReader = new GuardedSourceReader({
    reader: innerReader,
    registry,
    profiles: profileMap,
    policy,
    auditSink,
    nowProvider: options.nowProvider,
  });

  return {
    guardedReader,
    innerReader,
    registry,
    auditSink,
    policy,
    profiles: profileMap,
  };
}
