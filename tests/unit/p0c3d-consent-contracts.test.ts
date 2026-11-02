import {
  CONSENT_DENIAL_CODES,
  CONSENT_LIMITS,
  CONSENT_OPERATIONS,
  CONSENT_STATUSES,
  ConsentGrantDtoSchema,
  DEFAULT_CONSENT_OPERATIONS,
  GrantConsentRequestSchema,
  PERSISTED_CONSENT_STATUSES,
  RevokeConsentRequestSchema,
  parseGrantConsentRequestDto,
  parseRevokeConsentRequestDto,
  toConsentGrantDto,
  toConsentGrantListDto,
  toConsentGrantReceiptDto,
  type ConsentGrant,
} from '@ember/contracts';
import { InvalidArgumentError } from '@ember/domain';
import { describe, expect, it } from 'vitest';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CONSENT_ID = '22222222-2222-4222-8222-222222222222';
const PROFILE = 'fixture.github-release';
const GRANTED_AT = '2026-01-01T00:00:00.000Z';

function sampleGrant(overrides: Partial<ConsentGrant> = {}): ConsentGrant {
  return {
    consentId: CONSENT_ID,
    tenantId: TENANT_ID,
    sourceProfileId: PROFILE,
    status: 'active',
    allowedOperations: ['read_snapshot', 'publish_outcome'],
    scopes: ['repo:read'],
    grantedAt: GRANTED_AT,
    expiresAt: null,
    revokedAt: null,
    version: 1,
    createdAt: GRANTED_AT,
    updatedAt: GRANTED_AT,
    ...overrides,
  };
}

/** Collects `path` values from a thrown `InvalidArgumentError` so assertions stay exact. */
function issuePathsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidArgumentError);
    return (error as InvalidArgumentError).issues.map((issue) => issue.path);
  }

  throw new Error('expected the parser to reject the value');
}

describe('P0-C3D consent vocabulary', () => {
  it('stores only the two statuses that are observable facts', () => {
    expect(PERSISTED_CONSENT_STATUSES).toStrictEqual(['active', 'revoked']);
    // `expired` is a derived status: it must never be storable, or it could go stale.
    expect(CONSENT_STATUSES).toStrictEqual(['active', 'revoked', 'expired']);
  });

  it('keeps the operation list closed and defaulted to everything', () => {
    expect(CONSENT_OPERATIONS).toStrictEqual(['read_snapshot', 'publish_outcome']);
    expect(DEFAULT_CONSENT_OPERATIONS).toStrictEqual(['read_snapshot', 'publish_outcome']);
    expect(Object.isFrozen(DEFAULT_CONSENT_OPERATIONS)).toBe(true);
    expect(CONSENT_LIMITS.maxOperations).toBe(CONSENT_OPERATIONS.length);
  });

  it('exposes denial codes that are distinct from HTTP text', () => {
    expect(CONSENT_DENIAL_CODES).toStrictEqual([
      'CONSENT_NOT_FOUND',
      'CONSENT_REVOKED',
      'CONSENT_EXPIRED',
      'OPERATION_NOT_ALLOWED',
      'CONSENT_VERSION_STALE',
    ]);
  });
});

describe('GrantConsentRequestSchema', () => {
  it('accepts a minimal grant that only names the source profile', () => {
    const parsed = parseGrantConsentRequestDto({ source_profile_id: PROFILE });

    expect(parsed).toStrictEqual({ source_profile_id: PROFILE });
    // Omitted operations are resolved by the repository, not by the wire schema.
    expect(parsed.allowed_operations).toBeUndefined();
  });

  it('accepts the full explicit form, including an explicit null expiry', () => {
    const parsed = parseGrantConsentRequestDto({
      source_profile_id: PROFILE,
      allowed_operations: ['read_snapshot'],
      scopes: ['repo:read', 'issues.read'],
      expires_at: null,
    });

    expect(parsed.allowed_operations).toStrictEqual(['read_snapshot']);
    expect(parsed.scopes).toStrictEqual(['repo:read', 'issues.read']);
    expect(parsed.expires_at).toBeNull();
  });

  it('rejects an unknown field so a client cannot smuggle credential material', () => {
    const payload = { source_profile_id: PROFILE, access_token: 'ghp_not_a_real_token' };
    const result = GrantConsentRequestSchema.safeParse(payload);

    expect(result.success).toBe(false);
    const issue = result.success ? undefined : result.error.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');

    // The parser keeps only the field path and the rule code, so a rejected value can never be
    // echoed back to the client; an unknown key is reported against the object itself.
    expect(issuePathsOf(() => parseGrantConsentRequestDto(payload))).toStrictEqual(['<root>']);
  });

  it('rejects a date-only expiry instead of coercing it', () => {
    const paths = issuePathsOf(() =>
      parseGrantConsentRequestDto({ source_profile_id: PROFILE, expires_at: '2030-01-01' }),
    );

    expect(paths).toContain('expires_at');
  });

  it('rejects an empty operation list, an unknown operation and duplicates', () => {
    const parse = (allowedOperations: readonly string[]) =>
      GrantConsentRequestSchema.safeParse({
        source_profile_id: PROFILE,
        allowed_operations: allowedOperations,
      }).success;

    expect(parse([])).toBe(false);
    expect(parse(['read_snapshot', 'delete_everything'])).toBe(false);
    expect(parse(['read_snapshot', 'publish_outcome', 'read_snapshot'])).toBe(false);
  });

  it('rejects scopes that are not bounded lower-case token labels', () => {
    const invalidScopes: readonly (readonly string[])[] = [
      ['Repo:Read'],
      ['https://example.test/repo?token=x'],
      [''],
      ['a'.repeat(CONSENT_LIMITS.scopeMaxChars + 1)],
    ];

    for (const scopes of invalidScopes) {
      expect(
        GrantConsentRequestSchema.safeParse({ source_profile_id: PROFILE, scopes }).success,
      ).toBe(false);
    }

    const tooMany = Array.from(
      { length: CONSENT_LIMITS.maxScopes + 1 },
      (_, index) => `scope-${index}`,
    );
    expect(
      GrantConsentRequestSchema.safeParse({ source_profile_id: PROFILE, scopes: tooMany }).success,
    ).toBe(false);
  });

  it('rejects a malformed source profile id and reports its path', () => {
    const paths = issuePathsOf(() =>
      parseGrantConsentRequestDto({ source_profile_id: 'GH Release' }),
    );

    expect(paths).toContain('source_profile_id');
  });

  it('rejects a non-object body without echoing the payload', () => {
    const paths = issuePathsOf(() => parseGrantConsentRequestDto('source_profile_id=x'));

    expect(paths).toStrictEqual(['<root>']);
  });
});

describe('RevokeConsentRequestSchema', () => {
  it('accepts an absent compare-and-set', () => {
    expect(parseRevokeConsentRequestDto({})).toStrictEqual({});
  });

  it('accepts a positive integer expected_version', () => {
    expect(parseRevokeConsentRequestDto({ expected_version: 7 })).toStrictEqual({
      expected_version: 7,
    });

    for (const expectedVersion of [0, -1, 1.5]) {
      expect(
        RevokeConsentRequestSchema.safeParse({ expected_version: expectedVersion }).success,
      ).toBe(false);
    }
  });

  it('rejects unknown fields', () => {
    const result = RevokeConsentRequestSchema.safeParse({ reason: 'gdpr' });

    expect(result.success).toBe(false);
    const issue = result.success ? undefined : result.error.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
    expect(issuePathsOf(() => parseRevokeConsentRequestDto({ reason: 'gdpr' }))).toStrictEqual([
      '<root>',
    ]);
  });
});
describe('ConsentGrantDtoSchema and DTO mappers', () => {
  it('maps a domain grant to the snake_case wire shape', () => {
    const dto = toConsentGrantDto(sampleGrant());

    expect(dto).toStrictEqual({
      consent_id: CONSENT_ID,
      tenant_id: TENANT_ID,
      source_profile_id: PROFILE,
      status: 'active',
      allowed_operations: ['read_snapshot', 'publish_outcome'],
      scopes: ['repo:read'],
      granted_at: GRANTED_AT,
      expires_at: null,
      revoked_at: null,
      version: 1,
      created_at: GRANTED_AT,
      updated_at: GRANTED_AT,
    });
    expect(ConsentGrantDtoSchema.parse(dto)).toStrictEqual(dto);
  });

  it('round-trips a revoked, expiring grant', () => {
    const dto = toConsentGrantDto(
      sampleGrant({
        status: 'revoked',
        revokedAt: '2026-02-01T00:00:00.000Z',
        expiresAt: '2026-03-01T00:00:00.000Z',
        version: 3,
      }),
    );

    expect(dto.status).toBe('revoked');
    expect(dto.revoked_at).toBe('2026-02-01T00:00:00.000Z');
    expect(dto.expires_at).toBe('2026-03-01T00:00:00.000Z');
    expect(ConsentGrantDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('rejects a DTO that carries credential material', () => {
    const dto = { ...toConsentGrantDto(sampleGrant()), access_token: 'ghp_secret' };

    expect(ConsentGrantDtoSchema.safeParse(dto).success).toBe(false);
  });

  it('rejects a version below one and an empty operation list', () => {
    const base = toConsentGrantDto(sampleGrant());

    expect(ConsentGrantDtoSchema.safeParse({ ...base, version: 0 }).success).toBe(false);
    expect(ConsentGrantDtoSchema.safeParse({ ...base, allowed_operations: [] }).success).toBe(
      false,
    );
  });

  it('wraps lists and receipts without inventing fields', () => {
    const grant = sampleGrant();

    expect(toConsentGrantListDto([grant])).toStrictEqual({
      consents: [toConsentGrantDto(grant)],
    });
    expect(toConsentGrantReceiptDto(grant, true)).toStrictEqual({
      consent: toConsentGrantDto(grant),
      replayed: true,
    });
  });
});
