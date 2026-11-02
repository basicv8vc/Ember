/**
 * Reusable Consent conformance kit for @ember/connectors.
 *
 * PURPOSE
 * The frozen Consent contract (`docs/P0C3-C-CONSENT-CONTRACT.md`) must hold for EVERY
 * implementation, not just the in-memory fake. This module expresses the contract as an
 * adapter-driven behavioral suite so the durable PostgreSQL consent repository (Agent A) can be
 * certified without `@ember/connectors` depending on postgres.
 *
 * USAGE (durable repository, inside its own package):
 * ```ts
 * await assertConsentConformance({
 *   name: 'PostgresConsentRepository',
 *   reset: () => truncateConsentTables(),
 *   grant: (params, now) => repo.grant(params, now),
 *   get: (tenantId, profileId, now) => repo.get(tenantId, profileId, now),
 *   revoke: (tenantId, profileId, now) => repo.revoke(tenantId, profileId, now),
 *   list: (tenantId, now) => repo.list(tenantId, now),
 * });
 * ```
 *
 * This module performs no I/O, no network calls, and imports no test framework.
 */

import { deepFreeze } from './canonical.js';
import {
  createConsentAuthorizationFence,
  SOURCE_READ_OPERATION,
  SOURCE_READ_SCOPE,
  toAuthorizedConsentGeneration,
  validateConsentAuthorizationFence,
} from './consent.js';
import { FIXTURE_PROFILE_RELEASES, TEST_TENANT_A, TEST_TENANT_B } from './fixtures.js';
import { evaluateSourceAccess } from './source-policy.js';
import type {
  AuthorizedConsentGeneration,
  ConsentGrant,
  GrantConsentParams,
  SourceAccessDecision,
  SourceAccessPolicy,
  SourceProfileId,
  TrustedSourceAccessContext,
} from './types.js';

export type ConsentConformanceAwaitable<T> = T | Promise<T>;

/** Fixed evaluation clock used by every conformance case (deterministic, no wall-clock reads). */
export const CONSENT_CONFORMANCE_CLOCK = new Date('2026-11-01T12:00:00.000Z');

const CONFORMANCE_PROFILE_ID: SourceProfileId = FIXTURE_PROFILE_RELEASES.sourceProfileId;

const CONFORMANCE_POLICY: SourceAccessPolicy = deepFreeze({
  version: 1,
  allowedSourceProfileIds: [CONFORMANCE_PROFILE_ID],
  allowedOperations: [SOURCE_READ_OPERATION],
  defaultAction: 'deny',
});

/**
 * Port an implementation must provide to be certified against the frozen Consent contract.
 * Every method may be synchronous or asynchronous.
 */
export interface ConsentConformanceAdapter {
  /** Human-readable implementation name used in violation messages. */
  readonly name: string;
  /** Drops all persisted state between cases. */
  reset(): ConsentConformanceAwaitable<void>;
  grant(params: GrantConsentParams, now: Date): ConsentConformanceAwaitable<ConsentGrant>;
  get(
    tenantId: string,
    sourceProfileId: string,
    now: Date,
  ): ConsentConformanceAwaitable<ConsentGrant | null>;
  revoke(
    tenantId: string,
    sourceProfileId: string,
    now: Date,
  ): ConsentConformanceAwaitable<ConsentGrant>;
  list(tenantId: string, now: Date): ConsentConformanceAwaitable<readonly ConsentGrant[]>;
  /**
   * Optional authoritative generation view. When omitted, the suite derives it from `get`, which
   * is exactly what a durable repository must be able to reproduce transactionally.
   */
  resolveGeneration?(
    tenantId: string,
    sourceProfileId: string,
    now: Date,
  ): ConsentConformanceAwaitable<AuthorizedConsentGeneration | null>;
}

export interface ConsentConformanceCaseResult {
  readonly id: string;
  readonly requirement: string;
  readonly title: string;
  readonly passed: boolean;
  readonly error: string | null;
}

/** Raised when an implementation violates the frozen Consent contract. */
export class ConsentConformanceViolation extends Error {
  readonly results: readonly ConsentConformanceCaseResult[];

  constructor(adapterName: string, results: readonly ConsentConformanceCaseResult[]) {
    const failures = results.filter((result) => !result.passed);
    const summary = failures
      .map((failure) => `${failure.id}: ${failure.error ?? 'failed'}`)
      .join('; ');
    super(`Consent conformance failed for ${adapterName} (${failures.length} case(s)): ${summary}`);
    this.name = 'ConsentConformanceViolation';
    this.results = results;
  }
}

/** Assertion callback supplied to each case. */
export type ConsentConformanceCheck = (condition: boolean, message: string) => void;

export interface ConsentConformanceCase {
  readonly id: string;
  readonly requirement: string;
  readonly title: string;
  run(adapter: ConsentConformanceAdapter, check: ConsentConformanceCheck): Promise<void>;
}

class ConsentConformanceCaseFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentConformanceCaseFailure';
  }
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

function grantParams(overrides: Partial<GrantConsentParams> = {}): GrantConsentParams {
  return {
    tenantId: TEST_TENANT_A,
    sourceProfileId: CONFORMANCE_PROFILE_ID,
    allowedOperations: [SOURCE_READ_OPERATION],
    scopes: [SOURCE_READ_SCOPE],
    ...overrides,
  };
}

function conformanceContext(tenantId: string = TEST_TENANT_A): TrustedSourceAccessContext {
  return {
    tenantId,
    commitmentId: 'cmt_consent_conformance_0001',
    taskId: 'tsk_consent_conformance_0001',
    runId: 'run_consent_conformance_0001',
    leaseEpoch: 1,
    authorizedAt: CONSENT_CONFORMANCE_CLOCK.toISOString(),
  };
}

function decide(
  grant: ConsentGrant | null,
  now: Date = CONSENT_CONFORMANCE_CLOCK,
  context: TrustedSourceAccessContext = conformanceContext(),
): SourceAccessDecision {
  return evaluateSourceAccess({
    profile: FIXTURE_PROFILE_RELEASES,
    context,
    grant,
    policy: CONFORMANCE_POLICY,
    operation: SOURCE_READ_OPERATION,
    requiredScopes: [SOURCE_READ_SCOPE],
    now,
  });
}

function describeDecision(decision: SourceAccessDecision): string {
  return decision.allowed ? 'allow' : `deny(${decision.denialCode})`;
}

function describeGrant(grant: ConsentGrant | null): string {
  if (grant === null) {
    return 'no grant';
  }
  return `grant(status=${grant.status}, version=${grant.version}, grantId=${grant.grantId})`;
}

async function resolveGeneration(
  adapter: ConsentConformanceAdapter,
  tenantId: string,
  now: Date,
): Promise<AuthorizedConsentGeneration | null> {
  if (typeof adapter.resolveGeneration === 'function') {
    return adapter.resolveGeneration(tenantId, CONFORMANCE_PROFILE_ID, now);
  }
  const grant = await adapter.get(tenantId, CONFORMANCE_PROFILE_ID, now);
  return grant === null ? null : toAuthorizedConsentGeneration(grant, now);
}

async function expectRejection(
  operation: () => ConsentConformanceAwaitable<unknown>,
): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

/**
 * The frozen Consent conformance matrix. Order is stable; ids map 1:1 to the requirements in
 * `docs/P0C3-C-CONSENT-CONTRACT.md`.
 */
const CONSENT_CONFORMANCE_CASE_LIST: ConsentConformanceCase[] = [];

CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-01',
  requirement: 'R1-missing-grant-denies',
  title: 'A lineage without a grant is denied (fail closed)',
  async run(adapter, check) {
    await adapter.reset();
    const grant = await adapter.get(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      CONSENT_CONFORMANCE_CLOCK,
    );
    check(
      grant === null,
      `expected no grant for an ungranted lineage, got ${describeGrant(grant)}`,
    );
    const decision = decide(grant);
    check(
      !decision.allowed && decision.denialCode === 'CONSENT_NOT_FOUND',
      `expected deny(CONSENT_NOT_FOUND), got ${describeDecision(decision)}`,
    );
  },
});

CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-02',
  requirement: 'R2-revocation-is-terminal',
  title: 'Revocation denies reads, is terminal, and bumps the generation exactly once',
  async run(adapter, check) {
    await adapter.reset();
    const granted = await adapter.grant(grantParams(), CONSENT_CONFORMANCE_CLOCK);
    check(granted.status === 'active', `expected active grant, got ${describeGrant(granted)}`);
    check(
      decide(granted).allowed,
      `expected allow before revocation, got ${describeDecision(decide(granted))}`,
    );

    const revoked = await adapter.revoke(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      addMinutes(CONSENT_CONFORMANCE_CLOCK, 1),
    );
    check(revoked.status === 'revoked', `expected revoked status, got ${describeGrant(revoked)}`);
    check(revoked.revokedAt !== null, 'revoked grant must carry revokedAt');
    check(
      revoked.version === granted.version + 1,
      `revocation must bump version exactly once (${granted.version} -> ${revoked.version})`,
    );

    const current = await adapter.get(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      addMinutes(CONSENT_CONFORMANCE_CLOCK, 2),
    );
    check(
      current !== null && current.status === 'revoked',
      `expected persisted revoked grant, got ${describeGrant(current)}`,
    );
    const decided = decide(current, addMinutes(CONSENT_CONFORMANCE_CLOCK, 2));
    check(
      !decided.allowed && decided.denialCode === 'CONSENT_REVOKED',
      `expected deny(CONSENT_REVOKED), got ${describeDecision(decided)}`,
    );

    // Idempotent: revoking twice must not inflate the version or resurrect the grant.
    const revokedAgain = await adapter.revoke(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      addMinutes(CONSENT_CONFORMANCE_CLOCK, 3),
    );
    check(
      revokedAgain.version === revoked.version,
      `repeated revocation must not bump version (${revoked.version} -> ${revokedAgain.version})`,
    );
    check(
      revokedAgain.revokedAt === revoked.revokedAt,
      'repeated revocation must preserve the original revokedAt',
    );
  },
});
CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-03',
  requirement: 'R3-expiry-is-derived',
  title: 'Expiry is derived at read time from expiresAt and never rewrites the record',
  async run(adapter, check) {
    await adapter.reset();
    const expiresAt = addMinutes(CONSENT_CONFORMANCE_CLOCK, 60).toISOString();
    const granted = await adapter.grant(grantParams({ expiresAt }), CONSENT_CONFORMANCE_CLOCK);

    const justBefore = new Date(Date.parse(expiresAt) - 1);
    const activeGrant = await adapter.get(TEST_TENANT_A, CONFORMANCE_PROFILE_ID, justBefore);
    check(
      activeGrant !== null && activeGrant.status === 'active',
      `expected active 1ms before expiry, got ${describeGrant(activeGrant)}`,
    );

    const atExpiry = new Date(Date.parse(expiresAt));
    const expiredGrant = await adapter.get(TEST_TENANT_A, CONFORMANCE_PROFILE_ID, atExpiry);
    check(
      expiredGrant !== null && expiredGrant.status === 'expired',
      `expected derived expired at expiresAt, got ${describeGrant(expiredGrant)}`,
    );
    check(
      expiredGrant !== null &&
        expiredGrant.grantId === granted.grantId &&
        expiredGrant.version === granted.version,
      'expiry derivation must not mint a new generation or bump version',
    );
    check(
      expiredGrant !== null && expiredGrant.expiresAt === expiresAt,
      'expiry derivation must preserve the recorded expiresAt',
    );
    const decided = decide(expiredGrant, atExpiry);
    check(
      !decided.allowed && decided.denialCode === 'CONSENT_EXPIRED',
      `expected deny(CONSENT_EXPIRED), got ${describeDecision(decided)}`,
    );
  },
});

CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-04',
  requirement: 'R4-tenant-isolation',
  title: 'Grants are tenant-scoped and cannot be read, listed, or revoked cross-tenant',
  async run(adapter, check) {
    await adapter.reset();
    const grantA = await adapter.grant(grantParams(), CONSENT_CONFORMANCE_CLOCK);

    const foreignRead = await adapter.get(
      TEST_TENANT_B,
      CONFORMANCE_PROFILE_ID,
      CONSENT_CONFORMANCE_CLOCK,
    );
    check(
      foreignRead === null,
      `cross-tenant read must be hidden, got ${describeGrant(foreignRead)}`,
    );

    const foreignList = await adapter.list(TEST_TENANT_B, CONSENT_CONFORMANCE_CLOCK);
    check(
      foreignList.length === 0,
      `cross-tenant list must be empty, got ${foreignList.length} row(s)`,
    );

    const foreignRevokeRejected = await expectRejection(() =>
      adapter.revoke(TEST_TENANT_B, CONFORMANCE_PROFILE_ID, CONSENT_CONFORMANCE_CLOCK),
    );
    check(foreignRevokeRejected, 'cross-tenant revoke must be rejected (uniform NOT_FOUND)');

    const stillActive = await adapter.get(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      CONSENT_CONFORMANCE_CLOCK,
    );
    check(
      stillActive !== null &&
        stillActive.status === 'active' &&
        stillActive.version === grantA.version,
      `foreign revoke must not mutate tenant A, got ${describeGrant(stillActive)}`,
    );

    const tenantBGrant = await adapter.grant(
      grantParams({ tenantId: TEST_TENANT_B }),
      CONSENT_CONFORMANCE_CLOCK,
    );
    check(
      tenantBGrant.tenantId === TEST_TENANT_B,
      `grant must remain bound to its tenant, got ${tenantBGrant.tenantId}`,
    );
    const tenantAStill = await adapter.get(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      CONSENT_CONFORMANCE_CLOCK,
    );
    check(
      tenantAStill !== null && tenantAStill.grantId === grantA.grantId,
      'granting for tenant B must not disturb tenant A',
    );
    const tenantBList = await adapter.list(TEST_TENANT_B, CONSENT_CONFORMANCE_CLOCK);
    const onlyTenantBGrant = tenantBList[0];
    check(
      tenantBList.length === 1 &&
        onlyTenantBGrant !== undefined &&
        onlyTenantBGrant.grantId === tenantBGrant.grantId,
      `tenant B list must contain exactly its own grant, got ${tenantBList.length} row(s)`,
    );
  },
});

CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-05',
  requirement: 'R5-scope-and-operation-binding',
  title: 'A grant for other operations or scopes does not authorize a source read',
  async run(adapter, check) {
    await adapter.reset();
    const narrow = await adapter.grant(
      grantParams({ allowedOperations: ['read_metadata'], scopes: [SOURCE_READ_SCOPE] }),
      CONSENT_CONFORMANCE_CLOCK,
    );
    const operationDenied = decide(narrow);
    check(
      !operationDenied.allowed && operationDenied.denialCode === 'OPERATION_NOT_ALLOWED',
      `expected deny(OPERATION_NOT_ALLOWED), got ${describeDecision(operationDenied)}`,
    );

    // Re-grant with the right operation but an insufficient scope must still be denied.
    const wrongScope = await adapter.grant(
      grantParams({ allowedOperations: [SOURCE_READ_OPERATION], scopes: ['source.readwrite'] }),
      addMinutes(CONSENT_CONFORMANCE_CLOCK, 1),
    );
    const scopeDenied = decide(wrongScope, addMinutes(CONSENT_CONFORMANCE_CLOCK, 1));
    check(
      !scopeDenied.allowed && scopeDenied.denialCode === 'SCOPE_NOT_GRANTED',
      `expected deny(SCOPE_NOT_GRANTED), got ${describeDecision(scopeDenied)}`,
    );
    check(
      scopeDenied.allowed === false && scopeDenied.denialCode !== 'CONSENT_NOT_FOUND',
      'scope denial must not masquerade as a missing grant',
    );

    const correct = await adapter.grant(grantParams(), addMinutes(CONSENT_CONFORMANCE_CLOCK, 2));
    check(
      decide(correct, addMinutes(CONSENT_CONFORMANCE_CLOCK, 2)).allowed,
      'a grant carrying the read operation and read scope must authorize the read',
    );
  },
});

CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-06',
  requirement: 'R6-regrant-mints-new-generation',
  title: 'Re-granting after revocation mints a new generation with a strictly greater version',
  async run(adapter, check) {
    await adapter.reset();
    const first = await adapter.grant(grantParams(), CONSENT_CONFORMANCE_CLOCK);
    await adapter.revoke(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      addMinutes(CONSENT_CONFORMANCE_CLOCK, 1),
    );
    const second = await adapter.grant(grantParams(), addMinutes(CONSENT_CONFORMANCE_CLOCK, 2));

    check(
      second.grantId !== first.grantId,
      `re-grant must mint a new grantId (still ${first.grantId})`,
    );
    check(
      second.version > first.version,
      `re-grant must have a strictly greater version (${first.version} -> ${second.version})`,
    );
    check(second.status === 'active', `re-grant must be active, got ${describeGrant(second)}`);
    check(second.revokedAt === null, 're-grant must not inherit revokedAt');
    check(
      first.status !== 'active' || first.version !== second.version,
      'the superseded generation must not stay current',
    );

    const current = await adapter.get(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      addMinutes(CONSENT_CONFORMANCE_CLOCK, 2),
    );
    check(
      current !== null && current.grantId === second.grantId && current.version === second.version,
      `authoritative generation must be the re-grant, got ${describeGrant(current)}`,
    );
    check(
      decide(current, addMinutes(CONSENT_CONFORMANCE_CLOCK, 2)).allowed,
      'the re-granted generation must authorize reads',
    );
  },
});

CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-07',
  requirement: 'R7-generation-fence-binding',
  title: 'An authorization fence is only valid for the current authoritative generation',
  async run(adapter, check) {
    await adapter.reset();
    const first = await adapter.grant(grantParams(), CONSENT_CONFORMANCE_CLOCK);
    const fence = createConsentAuthorizationFence(first, CONSENT_CONFORMANCE_CLOCK);

    const currentValidation = validateConsentAuthorizationFence({
      fence,
      tenantId: TEST_TENANT_A,
      sourceProfileId: CONFORMANCE_PROFILE_ID,
      authoritative: await resolveGeneration(adapter, TEST_TENANT_A, CONSENT_CONFORMANCE_CLOCK),
      now: CONSENT_CONFORMANCE_CLOCK,
    });
    check(
      currentValidation.valid && currentValidation.code === 'VALID',
      `expected VALID fence for current generation, got ${currentValidation.code}`,
    );

    await adapter.revoke(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      addMinutes(CONSENT_CONFORMANCE_CLOCK, 1),
    );
    const revokedValidation = validateConsentAuthorizationFence({
      fence,
      tenantId: TEST_TENANT_A,
      sourceProfileId: CONFORMANCE_PROFILE_ID,
      authoritative: await resolveGeneration(
        adapter,
        TEST_TENANT_A,
        addMinutes(CONSENT_CONFORMANCE_CLOCK, 1),
      ),
      now: addMinutes(CONSENT_CONFORMANCE_CLOCK, 1),
    });
    check(
      !revokedValidation.valid && revokedValidation.denialCode === 'CONSENT_REVOKED',
      `expected deny(CONSENT_REVOKED) for a fence on a revoked generation, got ${revokedValidation.code}`,
    );

    await adapter.grant(grantParams(), addMinutes(CONSENT_CONFORMANCE_CLOCK, 2));
    const staleValidation = validateConsentAuthorizationFence({
      fence,
      tenantId: TEST_TENANT_A,
      sourceProfileId: CONFORMANCE_PROFILE_ID,
      authoritative: await resolveGeneration(
        adapter,
        TEST_TENANT_A,
        addMinutes(CONSENT_CONFORMANCE_CLOCK, 2),
      ),
      now: addMinutes(CONSENT_CONFORMANCE_CLOCK, 2),
    });
    check(
      !staleValidation.valid && staleValidation.denialCode === 'CONSENT_FENCE_STALE',
      `expected deny(CONSENT_FENCE_STALE) for a superseded generation, got ${staleValidation.denialCode}`,
    );

    const tampered = validateConsentAuthorizationFence({
      fence: { ...fence, grantVersion: first.version + 1 },
      tenantId: TEST_TENANT_A,
      sourceProfileId: CONFORMANCE_PROFILE_ID,
      authoritative: await resolveGeneration(
        adapter,
        TEST_TENANT_A,
        addMinutes(CONSENT_CONFORMANCE_CLOCK, 2),
      ),
      now: addMinutes(CONSENT_CONFORMANCE_CLOCK, 2),
    });
    check(
      !tampered.valid && tampered.code === 'CONSENT_FENCE_TAMPERED',
      `expected CONSENT_FENCE_TAMPERED for an edited fence, got ${tampered.code}`,
    );

    const crossTenant = validateConsentAuthorizationFence({
      fence,
      tenantId: TEST_TENANT_B,
      sourceProfileId: CONFORMANCE_PROFILE_ID,
      authoritative: await resolveGeneration(adapter, TEST_TENANT_B, CONSENT_CONFORMANCE_CLOCK),
      now: CONSENT_CONFORMANCE_CLOCK,
    });
    check(
      !crossTenant.valid && crossTenant.denialCode === 'TENANT_MISMATCH',
      `expected deny(TENANT_MISMATCH) for a cross-tenant fence, got ${crossTenant.denialCode}`,
    );
  },
});

CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-08',
  requirement: 'R8-version-monotonicity',
  title: 'Generation versions increase strictly across repeated grant/revoke cycles',
  async run(adapter, check) {
    await adapter.reset();
    const observed: number[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const now = addMinutes(CONSENT_CONFORMANCE_CLOCK, cycle * 2);
      const granted = await adapter.grant(grantParams(), now);
      observed.push(granted.version);
      const revoked = await adapter.revoke(
        TEST_TENANT_A,
        CONFORMANCE_PROFILE_ID,
        addMinutes(now, 1),
      );
      observed.push(revoked.version);
    }

    for (let index = 1; index < observed.length; index += 1) {
      const previous = observed[index - 1];
      const current = observed[index];
      check(
        previous !== undefined && current !== undefined && current > previous,
        `versions must strictly increase, observed [${observed.join(', ')}] at index ${index}`,
      );
    }
    const firstVersion = observed[0];
    check(
      firstVersion !== undefined && firstVersion >= 1,
      `initial version must be >= 1, observed ${String(firstVersion)}`,
    );
  },
});

CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-09',
  requirement: 'R9-reaffirmation-is-idempotent',
  title: 'Re-requesting identical active terms is idempotent (no version inflation)',
  async run(adapter, check) {
    await adapter.reset();
    const first = await adapter.grant(grantParams(), CONSENT_CONFORMANCE_CLOCK);
    const second = await adapter.grant(grantParams(), addMinutes(CONSENT_CONFORMANCE_CLOCK, 5));

    check(
      second.grantId === first.grantId,
      `idempotent re-grant must reuse the generation (${first.grantId} -> ${second.grantId})`,
    );
    check(
      second.version === first.version,
      `idempotent re-grant must not bump version (${first.version} -> ${second.version})`,
    );
    check(
      second.grantedAt === first.grantedAt,
      'idempotent re-grant must preserve the original grantedAt',
    );

    // Different terms are NOT a re-affirmation: they must produce a new generation.
    const widened = await adapter.grant(
      grantParams({ scopes: [SOURCE_READ_SCOPE, 'source.metadata'] }),
      addMinutes(CONSENT_CONFORMANCE_CLOCK, 6),
    );
    check(
      widened.grantId !== first.grantId,
      'changing grant terms must mint a new generation rather than silently no-op',
    );
  },
});
CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-10',
  requirement: 'R10-fail-closed-on-invalid-input',
  title: 'Invalid or hostile input is rejected on writes and denied (not thrown) on reads',
  async run(adapter, check) {
    await adapter.reset();

    const urlProfileRejected = await expectRejection(() =>
      adapter.grant(
        { ...grantParams(), sourceProfileId: 'https://attacker.example/collect' },
        CONSENT_CONFORMANCE_CLOCK,
      ),
    );
    check(urlProfileRejected, 'a URL-shaped sourceProfileId must be rejected at grant time');

    const emptyTenantRejected = await expectRejection(() =>
      adapter.grant({ ...grantParams(), tenantId: '' }, CONSENT_CONFORMANCE_CLOCK),
    );
    check(emptyTenantRejected, 'an empty tenantId must be rejected at grant time');

    const pastExpiryRejected = await expectRejection(() =>
      adapter.grant(
        grantParams({ expiresAt: addMinutes(CONSENT_CONFORMANCE_CLOCK, -1).toISOString() }),
        CONSENT_CONFORMANCE_CLOCK,
      ),
    );
    check(pastExpiryRejected, 'a grant that is already expired must be rejected at grant time');

    const emptyOperationRejected = await expectRejection(() =>
      adapter.grant(grantParams({ allowedOperations: [] }), CONSENT_CONFORMANCE_CLOCK),
    );
    check(emptyOperationRejected, 'a grant with no allowed operations must be rejected');

    const malformedRead = await adapter.get('', CONFORMANCE_PROFILE_ID, CONSENT_CONFORMANCE_CLOCK);
    check(
      malformedRead === null,
      'a malformed tenant read must fail closed with null, not a throw',
    );

    const malformedProfileRead = await adapter.get(
      TEST_TENANT_A,
      'not a valid profile id',
      CONSENT_CONFORMANCE_CLOCK,
    );
    check(malformedProfileRead === null, 'a malformed sourceProfileId read must fail closed');

    const malformedClockRead = await adapter.get(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      new Date('not-a-date'),
    );
    check(malformedClockRead === null, 'an invalid evaluation clock must fail closed');

    const malformedList = await adapter.list('', CONSENT_CONFORMANCE_CLOCK);
    check(malformedList.length === 0, 'a malformed tenant list must fail closed with no rows');

    const decision = decide(null);
    check(
      !decision.allowed && decision.denialCode === 'CONSENT_NOT_FOUND',
      `expected deny(CONSENT_NOT_FOUND) for absent consent, got ${describeDecision(decision)}`,
    );
  },
});

CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-11',
  requirement: 'R11-records-are-immutable',
  title: 'Returned and stored grant records cannot be mutated by callers',
  async run(adapter, check) {
    await adapter.reset();
    const granted = await adapter.grant(grantParams(), CONSENT_CONFORMANCE_CLOCK);

    // Mutating a returned value must never change persisted authorization state.
    try {
      (granted as { status: string }).status = 'revoked';
    } catch {
      // Frozen objects throw in strict mode; that is acceptable and expected.
    }
    try {
      (granted.allowedOperations as string[]).push('admin_mutate');
    } catch {
      // Ignore: immutability enforced.
    }

    const reloaded = await adapter.get(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      CONSENT_CONFORMANCE_CLOCK,
    );
    check(
      reloaded !== null && reloaded.status === 'active',
      `mutating a returned record must not change stored status, got ${describeGrant(reloaded)}`,
    );
    check(
      reloaded !== null && !reloaded.allowedOperations.includes('admin_mutate'),
      'mutating a returned operations array must not widen stored authorization',
    );
    check(
      reloaded !== null && reloaded.version === granted.version,
      'mutating a returned record must not alter the stored version',
    );

    const repeated = await adapter.get(
      TEST_TENANT_A,
      CONFORMANCE_PROFILE_ID,
      CONSENT_CONFORMANCE_CLOCK,
    );
    check(
      repeated !== null &&
        reloaded !== null &&
        repeated.grantId === reloaded.grantId &&
        repeated.version === reloaded.version,
      'repeated reads must report a stable generation',
    );
  },
});

CONSENT_CONFORMANCE_CASE_LIST.push({
  id: 'C-12',
  requirement: 'R12-list-scope-and-determinism',
  title: 'Listing is tenant-scoped, duplicate-free, and deterministically ordered',
  async run(adapter, check) {
    await adapter.reset();
    await adapter.grant(grantParams(), CONSENT_CONFORMANCE_CLOCK);
    await adapter.grant(
      grantParams({ sourceProfileId: 'sp_system_alerts' }),
      CONSENT_CONFORMANCE_CLOCK,
    );
    await adapter.grant(grantParams({ tenantId: TEST_TENANT_B }), CONSENT_CONFORMANCE_CLOCK);

    const listA = await adapter.list(TEST_TENANT_A, CONSENT_CONFORMANCE_CLOCK);
    check(listA.length === 2, `expected 2 grants for tenant A, got ${listA.length}`);
    check(
      listA.every((grant) => grant.tenantId === TEST_TENANT_A),
      'tenant listing must never leak foreign-tenant grants',
    );
    const ids = listA.map((grant) => grant.sourceProfileId);
    const sorted = [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    check(
      ids.join('|') === sorted.join('|'),
      `listing must be deterministically ordered, got [${ids.join(', ')}]`,
    );
    check(new Set(ids).size === ids.length, 'listing must not return duplicate lineages');

    const listB = await adapter.list(TEST_TENANT_B, CONSENT_CONFORMANCE_CLOCK);
    check(listB.length === 1, `expected 1 grant for tenant B, got ${listB.length}`);
  },
});

/** Immutable conformance matrix; each id maps to one requirement in the consent contract doc. */
export const CONSENT_CONFORMANCE_CASES: readonly ConsentConformanceCase[] = Object.freeze(
  CONSENT_CONFORMANCE_CASE_LIST,
);

/**
 * Runs the full conformance matrix against an adapter.
 * Never throws for contract violations; returns one result per case instead.
 */
export async function runConsentConformanceSuite(
  adapter: ConsentConformanceAdapter,
): Promise<readonly ConsentConformanceCaseResult[]> {
  const results: ConsentConformanceCaseResult[] = [];
  for (const testCase of CONSENT_CONFORMANCE_CASES) {
    const check: ConsentConformanceCheck = (condition, message) => {
      if (!condition) {
        throw new ConsentConformanceCaseFailure(message);
      }
    };
    try {
      await testCase.run(adapter, check);
      results.push({
        id: testCase.id,
        requirement: testCase.requirement,
        title: testCase.title,
        passed: true,
        error: null,
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        requirement: testCase.requirement,
        title: testCase.title,
        passed: false,
        error: error instanceof Error ? error.message : 'unknown conformance failure',
      });
    }
  }
  return Object.freeze(results);
}

/**
 * Runs the conformance matrix and throws {@link ConsentConformanceViolation} if any case fails.
 * This is the entry point a durable implementation's own test suite should call.
 */
export async function assertConsentConformance(
  adapter: ConsentConformanceAdapter,
): Promise<readonly ConsentConformanceCaseResult[]> {
  const results = await runConsentConformanceSuite(adapter);
  if (results.some((result) => !result.passed)) {
    throw new ConsentConformanceViolation(adapter.name, results);
  }
  return results;
}
