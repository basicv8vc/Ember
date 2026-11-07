import { createHash } from 'node:crypto';
import type { Pool } from '@ember/postgres/b1-worker';
import { describe, expect, it, vi } from 'vitest';
import type {
  IdentityAssertion,
  IdentityVerifier,
} from '../../apps/api/src/auth/identity-verifier.js';
import {
  createCloudflareAppleNonceReplayStore,
  createCloudflareAppleNonceVerifier,
} from '../../apps/api/src/cloudflare-apple-replay.js';

describe('Cloudflare Apple nonce replay fence', () => {
  it('stores only a digest and accepts a nonce once', async () => {
    const accepted = new Set<string>();
    const pool = {
      query: vi.fn((sql: string, values?: readonly unknown[]) => {
        if (sql.includes('DELETE FROM')) {
          return Promise.resolve({ rows: [] });
        }

        const digest = values?.[0] as Buffer;
        const key = digest.toString('hex');
        if (accepted.has(key)) {
          return Promise.resolve({ rows: [] });
        }
        accepted.add(key);
        return Promise.resolve({ rows: [{ nonce_digest: digest }] });
      }),
    };
    const store = createCloudflareAppleNonceReplayStore(pool as unknown as Pick<Pool, 'query'>);

    await expect(store.consume('one-time-raw-nonce')).resolves.toBe(true);
    await expect(store.consume('one-time-raw-nonce')).resolves.toBe(false);

    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO'));
    expect(insertCall).toBeDefined();
    expect(insertCall?.[1]?.[0]).toEqual(
      createHash('sha256').update('one-time-raw-nonce', 'utf8').digest(),
    );
    expect((insertCall?.[1]?.[0] as Buffer).toString('utf8')).not.toContain('one-time-raw-nonce');
  });

  it('allows exactly one winner for concurrent exchanges of the same nonce', async () => {
    const accepted = new Set<string>();
    const pool = {
      query: vi.fn((sql: string, values?: readonly unknown[]) => {
        if (sql.includes('DELETE FROM')) {
          return Promise.resolve({ rows: [] });
        }

        const digest = values?.[0] as Buffer;
        const key = digest.toString('hex');
        if (accepted.has(key)) {
          return Promise.resolve({ rows: [] });
        }
        accepted.add(key);
        return Promise.resolve({ rows: [{ nonce_digest: digest }] });
      }),
    };
    const store = createCloudflareAppleNonceReplayStore(pool as unknown as Pick<Pool, 'query'>);

    const results = await Promise.all(
      Array.from({ length: 32 }, () => store.consume('concurrent-one-time-nonce')),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => !result)).toHaveLength(31);
    const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO'));
    expect(insertCalls).toHaveLength(32);
    expect(insertCalls.every(([sql]) => /ON CONFLICT \(nonce_digest\) DO NOTHING/.test(sql))).toBe(
      true,
    );
  });

  it('does not consume a nonce for an invalid Apple assertion', async () => {
    const base: IdentityVerifier = {
      provider: 'apple',
      verify: vi.fn(() => Promise.resolve(null)),
    };
    const consume = vi.fn(() => Promise.resolve(true));
    const verifier = createCloudflareAppleNonceVerifier(base, { consume });

    await expect(
      verifier.verify({ identityToken: 'forged', nonce: 'nonce' } satisfies IdentityAssertion),
    ).resolves.toBeNull();
    expect(consume).not.toHaveBeenCalled();
  });

  it('rejects a second exchange of the same verified assertion', async () => {
    const base: IdentityVerifier = {
      provider: 'apple',
      verify: vi.fn(({ identityToken }) =>
        Promise.resolve(
          identityToken === 'valid'
            ? { provider: 'apple' as const, providerSubject: 'apple-subject' }
            : null,
        ),
      ),
    };
    const used = new Set<string>();
    const verifier = createCloudflareAppleNonceVerifier(base, {
      consume(rawNonce) {
        if (used.has(rawNonce)) {
          return Promise.resolve(false);
        }
        used.add(rawNonce);
        return Promise.resolve(true);
      },
    });
    const assertion = { identityToken: 'valid', nonce: 'same-nonce' };

    await expect(verifier.verify(assertion)).resolves.toEqual({
      provider: 'apple',
      providerSubject: 'apple-subject',
    });
    await expect(verifier.verify(assertion)).resolves.toBeNull();
  });

  it('maps nonce-store failures to the closed database error without leaking diagnostics', async () => {
    const pool = {
      query: vi.fn(() => Promise.reject(new Error('postgres://secret@db/password=secret'))),
    };
    const store = createCloudflareAppleNonceReplayStore(pool);

    await expect(store.consume('nonce')).rejects.toMatchObject({
      code: 'DB_UNAVAILABLE',
      message: 'Database is unavailable',
    });
  });
});
