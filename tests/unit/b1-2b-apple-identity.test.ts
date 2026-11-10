import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createLocalJWKSet,
  exportJWK,
  SignJWT,
  type JWK,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { describe, expect, it, vi } from 'vitest';

import {
  APPLE_ISSUER,
  AppleVerifierConfigError,
  createAppleIdentityVerifier,
  loadAppleVerifierConfig,
  type AppleVerifierConfig,
} from '../../apps/api/src/auth/apple-identity.js';
import { loadCloudflareAppleVerifierConfig } from '../../apps/api/src/cloudflare-worker-apple-config.js';

/**
 * B1-2B Apple identity verification. Deterministic, locally signed RS256 JWT/JWKS fixtures:
 * no Apple credentials, no Apple JWKS endpoint and no live network call in CI.
 */

const AUDIENCE = 'com.ember.alpha.test';
const IOS_BUNDLE_ID = 'com.basicv8vc.ember';
const KEY_ID = 'ember-local-fixture-key';
const SUBJECT = 'apple-sub-00123456789';
const RAW_NONCE = `nonce-${randomUUID()}`;
const NONCE_HASH = createHash('sha256').update(RAW_NONCE, 'utf8').digest('hex');
const FIXED_NOW = new Date('2026-11-05T02:00:00.000Z');
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1_000);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface Fixture {
  readonly privateKey: KeyObject;
  readonly keyResolver: JWTVerifyGetKey;
}

async function createFixture(): Promise<Fixture> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
  const jwk: JWK = await exportJWK(publicKey);
  const jwks: JSONWebKeySet = {
    keys: [{ ...jwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }],
  };

  return { privateKey, keyResolver: createLocalJWKSet(jwks) };
}

const fixture = await createFixture();
const secondFixture = await createFixture();

interface TokenOverrides {
  readonly header?: Record<string, unknown>;
  readonly claims?: JWTPayload;
  readonly privateKey?: KeyObject;
  readonly nonce?: string;
}

async function signToken(overrides: TokenOverrides = {}): Promise<string> {
  const claims: JWTPayload = {
    iss: APPLE_ISSUER,
    aud: AUDIENCE,
    sub: SUBJECT,
    iat: FIXED_NOW_SECONDS,
    exp: FIXED_NOW_SECONDS + 600,
    nonce: overrides.nonce ?? NONCE_HASH,
    // Explicitly not identity (I-3): the verifier must ignore these.
    email: 'person@example.test',
    name: 'Display Name',
    ...overrides.claims,
  };

  return await new SignJWT(claims)
    .setProtectedHeader({
      alg: 'RS256',
      kid: KEY_ID,
      typ: 'JWT',
      ...overrides.header,
    })
    .sign(overrides.privateKey ?? fixture.privateKey);
}

function verifier(overrides: Partial<AppleVerifierConfig> = {}) {
  return createAppleIdentityVerifier({
    audience: AUDIENCE,
    keyResolver: fixture.keyResolver,
    now: () => FIXED_NOW,
    ...overrides,
  });
}

function assertion(token: string, nonce: string = RAW_NONCE) {
  return { identityToken: token, nonce };
}

/** Re-encode a protected header without re-signing (used for header-only rejection cases). */
function replaceHeader(token: string, header: Record<string, unknown>): string {
  const parts = token.split('.');
  const encoded = Buffer.from(JSON.stringify(header)).toString('base64url');
  return `${encoded}.${parts[1] ?? ''}.${parts[2] ?? ''}`;
}

describe('Apple identity-token verification (B1-2B)', () => {
  it('uses the iOS Bundle ID from the isolated Staging Worker config and rejects invalid assertions', async () => {
    const wranglerText = readFileSync(
      new URL('../../apps/api/wrangler.staging.jsonc', import.meta.url),
      'utf8',
    );
    const wranglerConfig = JSON.parse(wranglerText.replace(/,\s*([}\]])/g, '$1')) as {
      name: string;
      vars: { EMBER_APPLE_BUNDLE_ID: string; EMBER_ENV: string };
      hyperdrive: Array<{ binding: string; id: string }>;
      queues: { producers: Array<{ binding: string; queue: string }> };
    };
    const apiPackage = JSON.parse(
      readFileSync(new URL('../../apps/api/package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    const devVarsExample = readFileSync(
      new URL('../../apps/api/.dev.vars.example', import.meta.url),
      'utf8',
    );
    const iosProject = readFileSync(
      new URL('../../apps/ios/Ember.xcodeproj/project.pbxproj', import.meta.url),
      'utf8',
    );

    expect(iosProject).toContain(`PRODUCT_BUNDLE_IDENTIFIER = ${IOS_BUNDLE_ID};`);
    expect(wranglerConfig.name).toBe('ember-cloud-api-staging');
    expect(wranglerConfig.vars.EMBER_ENV).toBe('staging');
    expect(wranglerConfig.hyperdrive).toHaveLength(1);
    expect(wranglerConfig.hyperdrive[0]?.binding).toBe('HYPERDRIVE');
    expect(wranglerConfig.hyperdrive[0]?.id).toMatch(
      /^(REPLACE_WITH_STAGING_API_HYPERDRIVE_ID|[a-f0-9]{32})$/i,
    );
    expect(wranglerConfig.hyperdrive[0]?.id).not.toBe('a331dbebe08c4f4e9ec7eac2d2baf5a3');
    expect(wranglerConfig.queues.producers).toEqual([
      { binding: 'TURN_DISPATCH_QUEUE', queue: 'ember-staging-assistant-turns' },
    ]);
    expect(apiPackage.scripts['deploy:worker']).toContain('--config wrangler.staging.jsonc');
    expect(wranglerConfig.vars.EMBER_APPLE_BUNDLE_ID).toBe(IOS_BUNDLE_ID);
    expect(devVarsExample).toContain(`EMBER_APPLE_BUNDLE_ID=${IOS_BUNDLE_ID}`);

    const runtimeConfig = loadCloudflareAppleVerifierConfig(
      {
        EMBER_APPLE_BUNDLE_ID: wranglerConfig.vars.EMBER_APPLE_BUNDLE_ID,
      },
      fixture.keyResolver,
    );
    const runtimeVerifier = createAppleIdentityVerifier({
      ...runtimeConfig,
      now: () => FIXED_NOW,
    });

    expect(runtimeConfig.audience).toBe(IOS_BUNDLE_ID);
    await expect(
      runtimeVerifier.verify(assertion(await signToken({ claims: { aud: IOS_BUNDLE_ID } }))),
    ).resolves.toEqual({ provider: 'apple', providerSubject: SUBJECT });
    await expect(
      runtimeVerifier.verify(assertion(await signToken({ claims: { aud: 'com.ember.mobile' } }))),
    ).resolves.toBeNull();
    await expect(
      runtimeVerifier.verify(
        assertion(
          await signToken({ claims: { exp: FIXED_NOW_SECONDS - 301, aud: IOS_BUNDLE_ID } }),
        ),
      ),
    ).resolves.toBeNull();
    await expect(
      runtimeVerifier.verify(
        assertion(
          await signToken({
            claims: { aud: IOS_BUNDLE_ID },
            privateKey: secondFixture.privateKey,
          }),
        ),
      ),
    ).resolves.toBeNull();
    await expect(
      runtimeVerifier.verify(
        assertion(await signToken({ claims: { iss: 'https://evil.test', aud: IOS_BUNDLE_ID } })),
      ),
    ).resolves.toBeNull();
  });

  it('accepts a correctly signed token and returns only the stable sub claim', async () => {
    const token = await signToken();
    const result = await verifier().verify(assertion(token));

    expect(result).toEqual({ provider: 'apple', providerSubject: SUBJECT });
    expect(result?.providerSubject).not.toContain('person@example.test');
    expect(result?.providerSubject).not.toContain('Display Name');
  });

  it('rejects a token whose signature was made with another key', async () => {
    const token = await signToken({ privateKey: secondFixture.privateKey });

    expect(await verifier().verify(assertion(token))).toBeNull();
  });

  it('rejects a tampered payload (no decode-only authentication)', async () => {
    const token = await signToken();
    const parts = token.split('.');
    const header = parts[0] ?? '';
    const signature = parts[2] ?? '';
    const forgedPayload = Buffer.from(
      JSON.stringify({ iss: APPLE_ISSUER, aud: AUDIENCE, sub: 'attacker', nonce: NONCE_HASH }),
    ).toString('base64url');

    expect(
      await verifier().verify(assertion(`${header}.${forgedPayload}.${signature}`)),
    ).toBeNull();
  });

  it('rejects an unknown key id', async () => {
    const token = await signToken({ header: { kid: 'unknown-kid' } });

    expect(await verifier().verify(assertion(token))).toBeNull();
    expect(
      await verifier({ allowedKeyIds: ['pinned-other-key'] }).verify(assertion(await signToken())),
    ).toBeNull();
  });

  it('rejects a missing key id, alg=none, HS256 and forbidden key-redirecting headers', async () => {
    // `alg: none` and HS256 are built outside the RS256 signer on purpose: the verifier must
    // refuse them from the protected header before any key is even resolved.
    // `alg: none` is assembled by hand: jose's signer refuses the algorithm, which is exactly
    // why the verifier must reject the header before any key is resolved.
    const unsecuredHeader = Buffer.from(
      JSON.stringify({ alg: 'none', kid: KEY_ID, typ: 'JWT' }),
    ).toString('base64url');
    const unsecuredPayload = Buffer.from(
      JSON.stringify({
        iss: APPLE_ISSUER,
        aud: AUDIENCE,
        sub: SUBJECT,
        iat: FIXED_NOW_SECONDS,
        exp: FIXED_NOW_SECONDS + 600,
        nonce: NONCE_HASH,
      }),
    ).toString('base64url');
    const unprotected = `${unsecuredHeader}.${unsecuredPayload}.AAAA`;
    const hs256 = await new SignJWT({
      iss: APPLE_ISSUER,
      aud: AUDIENCE,
      sub: SUBJECT,
      iat: FIXED_NOW_SECONDS,
      exp: FIXED_NOW_SECONDS + 600,
      nonce: NONCE_HASH,
    })
      .setProtectedHeader({ alg: 'HS256', kid: KEY_ID, typ: 'JWT' })
      .sign(new TextEncoder().encode('a-local-hmac-secret'));

    expect(
      await verifier().verify(assertion(await signToken({ header: { kid: undefined } }))),
    ).toBeNull();
    expect(await verifier().verify(assertion(unprotected))).toBeNull();
    expect(await verifier().verify(assertion(hs256))).toBeNull();
    expect(
      await verifier().verify(
        assertion(await signToken({ header: { jku: 'https://evil.test/keys' } })),
      ),
    ).toBeNull();
    expect(
      await verifier().verify(assertion(await signToken({ header: { jwk: { kty: 'RSA' } } }))),
    ).toBeNull();
    expect(
      await verifier().verify(
        assertion(
          replaceHeader(await signToken(), {
            alg: 'RS256',
            kid: KEY_ID,
            typ: 'JWT',
            crit: ['exp'],
          }),
        ),
      ),
    ).toBeNull();
  });

  it('rejects a wrong issuer and a wrong audience', async () => {
    expect(
      await verifier().verify(assertion(await signToken({ claims: { iss: 'https://evil.test' } }))),
    ).toBeNull();
    expect(
      await verifier().verify(assertion(await signToken({ claims: { aud: 'com.other.app' } }))),
    ).toBeNull();
    expect(
      await verifier().verify(
        assertion(await signToken({ claims: { aud: [AUDIENCE, 'com.other.app'] } })),
      ),
    ).toBeNull();
  });

  it('rejects a missing, wrong or mismatched nonce while accepting the hash binding', async () => {
    expect(
      await verifier().verify(assertion(await signToken({ claims: { nonce: undefined } }))),
    ).toBeNull();
    expect(
      await verifier().verify(assertion(await signToken({ nonce: sha256Hex('other-nonce') }))),
    ).toBeNull();
    expect(await verifier().verify(assertion(await signToken(), 'wrong-client-nonce'))).toBeNull();
  });

  it('rejects expired, future-issued and stale tokens; permits only the configured skew', async () => {
    expect(
      await verifier().verify(
        assertion(await signToken({ claims: { exp: FIXED_NOW_SECONDS - 301 } })),
      ),
    ).toBeNull();
    expect(
      await verifier().verify(
        assertion(await signToken({ claims: { iat: FIXED_NOW_SECONDS + 301 } })),
      ),
    ).toBeNull();
    expect(
      await verifier().verify(
        assertion(await signToken({ claims: { iat: FIXED_NOW_SECONDS - 3_600 } })),
      ),
    ).toBeNull();

    // 60 seconds past exp is inside the ±5 minute tolerance.
    expect(
      await verifier().verify(
        assertion(await signToken({ claims: { exp: FIXED_NOW_SECONDS - 60 } })),
      ),
    ).toEqual({ provider: 'apple', providerSubject: SUBJECT });
  });

  it('rejects missing exp, iat, sub and malformed compact tokens', async () => {
    for (const claims of [
      { exp: undefined },
      { iat: undefined },
      { sub: undefined },
      { sub: '' },
    ]) {
      expect(await verifier().verify(assertion(await signToken({ claims })))).toBeNull();
    }

    for (const token of ['not-a-jwt', 'a.b', 'a.b.c.d', '', '.....']) {
      expect(await verifier().verify(assertion(token))).toBeNull();
    }
  });

  it('never performs a live Apple JWKS fetch when a local key resolver is injected', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      expect(await verifier().verify(assertion(await signToken()))).not.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails closed on absent, placeholder or out-of-range verification configuration', () => {
    expect(() => createAppleIdentityVerifier({ audience: '' })).toThrow(AppleVerifierConfigError);
    expect(() => createAppleIdentityVerifier({ audience: 'com.example.ember' })).toThrow(
      AppleVerifierConfigError,
    );
    expect(() => createAppleIdentityVerifier({ audience: 'single-label' })).toThrow(
      AppleVerifierConfigError,
    );
    expect(() =>
      createAppleIdentityVerifier({ audience: AUDIENCE, clockSkewSeconds: 9_999 }),
    ).toThrow(AppleVerifierConfigError);
    expect(() => createAppleIdentityVerifier({ audience: AUDIENCE, allowedKeyIds: [] })).toThrow(
      AppleVerifierConfigError,
    );
    expect(() => loadAppleVerifierConfig({})).toThrow(AppleVerifierConfigError);
    expect(loadAppleVerifierConfig({ EMBER_APPLE_BUNDLE_ID: AUDIENCE }).audience).toBe(AUDIENCE);
  });
});
