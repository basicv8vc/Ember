import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type ProtectedHeaderParameters,
} from 'jose';
import type { IdentityAssertion, IdentityVerifier, VerifiedIdentity } from './identity-verifier.js';

/**
 * Real Apple identity-token verification (ADR-0004 §5.2, annex I-3 / R-1).
 *
 * There is no `decode-only` path. `jwtVerify` verifies the RS256 signature against a key
 * resolved from Apple's JWKS before any claim is trusted. `createRemoteJWKSet` supplies
 * bounded fetching (timeout), negative caching (cooldown) and bounded positive caching
 * (max age); a local key resolver can be injected only for deterministic fixtures.
 *
 * All rejection paths return `null` with one fixed public 401 body. No reason, claim value,
 * token or header is returned or logged.
 */

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
export const APPLE_ALLOWED_ALGORITHM = 'RS256';

/** Contract §5.2: ±5 minutes of permitted clock skew. */
export const APPLE_DEFAULT_CLOCK_SKEW_SECONDS = 300;
/** An identity assertion must be exchanged promptly; `iat` is required and age-bounded. */
export const APPLE_DEFAULT_MAX_TOKEN_AGE_SECONDS = 600;
export const APPLE_DEFAULT_JWKS_TIMEOUT_MS = 5_000;
export const APPLE_DEFAULT_JWKS_COOLDOWN_MS = 30_000;
export const APPLE_DEFAULT_JWKS_CACHE_MAX_AGE_MS = 600_000;
export const APPLE_MAX_TOKEN_BYTES = 16_384;

const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Reverse-DNS bundle id with at least two labels. */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const PLACEHOLDER_AUDIENCE_FRAGMENTS = [
  'example',
  'placeholder',
  'changeme',
  'change-me',
  'replace-me',
  'your-',
  'your_',
];
/** Headers that could redirect key resolution or change JWS semantics are refused. */
const FORBIDDEN_HEADER_PARAMETERS = ['crit', 'jku', 'jwk', 'x5u', 'x5c', 'zip', 'b64'] as const;

export class AppleVerifierConfigError extends Error {
  override readonly name = 'AppleVerifierConfigError';
}

export interface AppleVerifierConfig {
  /** Exact `aud`: the Ember iOS bundle id. Placeholders are rejected (R-1). */
  readonly audience: string;
  /** Optional key-id pinning. When absent, any well-formed kid in Apple's JWKS is allowed. */
  readonly allowedKeyIds?: readonly string[];
  readonly clockSkewSeconds?: number;
  readonly maxTokenAgeSeconds?: number;
  readonly jwksTimeoutMs?: number;
  readonly jwksCooldownMs?: number;
  readonly jwksCacheMaxAgeMs?: number;
  /**
   * Test seam for locally signed JWT/JWKS fixtures. Production never sets this, so keys
   * always come from the fixed Apple HTTPS JWKS endpoint.
   */
  readonly keyResolver?: JWTVerifyGetKey;
  readonly now?: () => Date;
}

interface ResolvedAppleVerifierConfig {
  readonly audience: string;
  readonly allowedKeyIds: readonly string[] | undefined;
  readonly clockSkewSeconds: number;
  readonly maxTokenAgeSeconds: number;
  readonly keyResolver: JWTVerifyGetKey;
  readonly now: () => Date;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const resolved = value ?? fallback;

  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new AppleVerifierConfigError(`${name} must be an integer between ${min} and ${max}`);
  }

  return resolved;
}

/** Validate configuration at construction time so a broken deployment fails closed (R-1). */
function resolveConfig(config: AppleVerifierConfig): ResolvedAppleVerifierConfig {
  const audience = config.audience.trim();
  const lowered = audience.toLowerCase();

  if (
    audience.length === 0 ||
    audience.length > 253 ||
    !BUNDLE_ID_PATTERN.test(audience) ||
    PLACEHOLDER_AUDIENCE_FRAGMENTS.some((fragment) => lowered.includes(fragment))
  ) {
    // The rejected value is not interpolated: a config value could contain a credential.
    throw new AppleVerifierConfigError('EMBER_APPLE_BUNDLE_ID must be a real bundle id');
  }

  const allowedKeyIds = config.allowedKeyIds;

  if (allowedKeyIds !== undefined) {
    if (allowedKeyIds.length === 0 || allowedKeyIds.some((kid) => !KID_PATTERN.test(kid))) {
      throw new AppleVerifierConfigError('Apple allowed key ids must be non-empty and well formed');
    }
  }

  const jwksTimeoutMs = boundedInteger(
    config.jwksTimeoutMs,
    APPLE_DEFAULT_JWKS_TIMEOUT_MS,
    100,
    30_000,
    'jwksTimeoutMs',
  );
  const jwksCooldownMs = boundedInteger(
    config.jwksCooldownMs,
    APPLE_DEFAULT_JWKS_COOLDOWN_MS,
    1_000,
    600_000,
    'jwksCooldownMs',
  );
  const jwksCacheMaxAgeMs = boundedInteger(
    config.jwksCacheMaxAgeMs,
    APPLE_DEFAULT_JWKS_CACHE_MAX_AGE_MS,
    1_000,
    86_400_000,
    'jwksCacheMaxAgeMs',
  );

  // The JWKS endpoint is deliberately not configurable: an attacker-controlled verification
  // key would turn this module into a token-minting oracle. Only the Apple HTTPS endpoint is
  // used unless an in-process key resolver was explicitly injected for local fixtures.
  const keyResolver =
    config.keyResolver ??
    createRemoteJWKSet(new URL(APPLE_JWKS_URL), {
      timeoutDuration: jwksTimeoutMs,
      cooldownDuration: jwksCooldownMs,
      cacheMaxAge: jwksCacheMaxAgeMs,
    });

  return {
    audience,
    allowedKeyIds,
    clockSkewSeconds: boundedInteger(
      config.clockSkewSeconds,
      APPLE_DEFAULT_CLOCK_SKEW_SECONDS,
      0,
      600,
      'clockSkewSeconds',
    ),
    maxTokenAgeSeconds: boundedInteger(
      config.maxTokenAgeSeconds,
      APPLE_DEFAULT_MAX_TOKEN_AGE_SECONDS,
      1,
      3_600,
      'maxTokenAgeSeconds',
    ),
    keyResolver,
    now: config.now ?? (() => new Date()),
  };
}

function isAllowedHeader(
  header: ProtectedHeaderParameters,
  allowedKeyIds: readonly string[] | undefined,
): boolean {
  if (header.alg !== APPLE_ALLOWED_ALGORITHM) {
    return false;
  }

  const kid = header.kid;

  if (typeof kid !== 'string' || !KID_PATTERN.test(kid)) {
    return false;
  }

  if (allowedKeyIds !== undefined && !allowedKeyIds.includes(kid)) {
    return false;
  }

  if (header.typ !== undefined && header.typ !== 'JWT') {
    return false;
  }

  return FORBIDDEN_HEADER_PARAMETERS.every((parameter) => header[parameter] === undefined);
}

/** Constant-time comparison of the SHA-256 nonce binding (§5.2 "nonce hash matches"). */
function nonceMatches(payload: JWTPayload, rawNonce: string): boolean {
  if (typeof payload.nonce !== 'string' || payload.nonce.length === 0) {
    return false;
  }

  const expected = createHash('sha256').update(rawNonce, 'utf8').digest('hex');
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const presentedDigest = createHash('sha256').update(payload.nonce, 'utf8').digest();

  return timingSafeEqual(expectedDigest, presentedDigest);
}

function claimsAreValid(
  payload: JWTPayload,
  assertion: IdentityAssertion,
  config: ResolvedAppleVerifierConfig,
): boolean {
  // `sub` is the only identity key (I-3). Email / display name are never read here.
  if (
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0 ||
    payload.sub.length > 256 ||
    payload.sub.trim().length === 0
  ) {
    return false;
  }

  // `aud` must be exactly the configured bundle id, not merely contain it in an array.
  if (typeof payload.aud !== 'string' || payload.aud !== config.audience) {
    return false;
  }

  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    return false;
  }

  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    return false;
  }

  const nowSeconds = config.now().getTime() / 1_000;

  // jose enforces `exp` with `clockTolerance` and `iat` age with `maxTokenAge`; the explicit
  // future-`iat` check closes the remaining "issued in the future" case.
  if (payload.iat > nowSeconds + config.clockSkewSeconds) {
    return false;
  }

  return nonceMatches(payload, assertion.nonce);
}

async function verifyAssertion(
  assertion: IdentityAssertion,
  config: ResolvedAppleVerifierConfig,
): Promise<VerifiedIdentity | null> {
  const token = assertion.identityToken;

  if (
    Buffer.byteLength(token, 'utf8') > APPLE_MAX_TOKEN_BYTES ||
    !COMPACT_JWS_PATTERN.test(token)
  ) {
    return null;
  }

  let header: ProtectedHeaderParameters;

  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }

  if (!isAllowedHeader(header, config.allowedKeyIds)) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, config.keyResolver, {
      algorithms: [APPLE_ALLOWED_ALGORITHM],
      issuer: APPLE_ISSUER,
      audience: config.audience,
      clockTolerance: config.clockSkewSeconds,
      maxTokenAge: config.maxTokenAgeSeconds,
      currentDate: config.now(),
      requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
    });

    if (!claimsAreValid(payload, assertion, config)) {
      return null;
    }

    // `payload.sub` was checked above; the narrowing is repeated for the return value.
    const subject = payload.sub;
    return typeof subject === 'string'
      ? Object.freeze({ provider: 'apple' as const, providerSubject: subject })
      : null;
  } catch {
    // Signature, JWKS, issuer, audience, exp/iat or required-claim failure: one fixed result.
    return null;
  }
}

export function createAppleIdentityVerifier(config: AppleVerifierConfig): IdentityVerifier {
  const resolved = resolveConfig(config);

  return Object.freeze({
    provider: 'apple' as const,
    verify: (assertion: IdentityAssertion): Promise<VerifiedIdentity | null> =>
      verifyAssertion(assertion, resolved),
  });
}

/**
 * Read Apple verification settings from the environment.
 *
 * A missing or placeholder bundle id throws at boot: production must not start with a
 * verifier that silently rejects (or, worse, accepts untrusted) assertions.
 */
export function loadAppleVerifierConfig(env: NodeJS.ProcessEnv = process.env): AppleVerifierConfig {
  const audience = env.EMBER_APPLE_BUNDLE_ID?.trim();

  if (audience === undefined || audience === '') {
    throw new AppleVerifierConfigError('EMBER_APPLE_BUNDLE_ID is required for Apple sign-in');
  }

  const optionalInteger = (name: string): number | undefined => {
    const raw = env[name];
    return raw === undefined || raw.trim() === '' ? undefined : Number(raw.trim());
  };

  return {
    audience,
    clockSkewSeconds: optionalInteger('EMBER_APPLE_CLOCK_SKEW_SECONDS'),
    maxTokenAgeSeconds: optionalInteger('EMBER_APPLE_MAX_TOKEN_AGE_SECONDS'),
    jwksTimeoutMs: optionalInteger('EMBER_APPLE_JWKS_TIMEOUT_MS'),
    jwksCooldownMs: optionalInteger('EMBER_APPLE_JWKS_COOLDOWN_MS'),
    jwksCacheMaxAgeMs: optionalInteger('EMBER_APPLE_JWKS_CACHE_MAX_AGE_MS'),
  };
}
