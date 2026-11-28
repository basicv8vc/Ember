import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  assertPositiveSafeInt,
  assertSafeLocalDatabaseUrl,
  assertValidConcurrencyLevels,
  DEFAULT_LOCAL_TEST_DATABASE_URL,
  resolveSafeLocalDatabaseUrl,
} from '../../apps/benchmark/src/local-guard.js';

describe('V2-M0-D Local-Only Benchmark Guards (Unit)', () => {
  it('accepts explicit local loopback test database URLs and safe defaults', () => {
    expect(resolveSafeLocalDatabaseUrl(undefined, {})).toBe(DEFAULT_LOCAL_TEST_DATABASE_URL);
    expect(() =>
      assertSafeLocalDatabaseUrl('postgres://ember:pass@127.0.0.1:5432/ember_test', {}),
    ).not.toThrow();
    expect(() =>
      assertSafeLocalDatabaseUrl('postgresql://ember@localhost:5432/local_bench_db', {}),
    ).not.toThrow();
    expect(() =>
      assertSafeLocalDatabaseUrl('postgres://ember@[::1]:5432/ember_test', {}),
    ).not.toThrow();
    expect(() =>
      assertSafeLocalDatabaseUrl(
        'postgres://ember:pass@127.0.0.1:5432/ember_test?sslmode=disable',
        {},
      ),
    ).not.toThrow();
  });

  it('ignores general DATABASE_URL fallback so remote/cloud DATABASE_URL is never touched by default', () => {
    const resolved = resolveSafeLocalDatabaseUrl(undefined, {
      DATABASE_URL: 'postgres://prod_user:secret@ep-cool-cloud.neon.tech:5432/neondb',
    });
    expect(resolved).toBe(DEFAULT_LOCAL_TEST_DATABASE_URL);
  });

  it('rejects remote/cloud DB hosts, production/staging DB names, and prod/staging environments', () => {
    expect(() =>
      assertSafeLocalDatabaseUrl(
        'postgres://user:secret@ep-cool-cloud.neon.tech:5432/ember_test',
        {},
      ),
    ).toThrow(/loopback/i);
    expect(() =>
      assertSafeLocalDatabaseUrl('postgres://user:secret@10.0.0.5:5432/ember_test', {}),
    ).toThrow(/loopback/i);
    expect(() =>
      assertSafeLocalDatabaseUrl('postgres://user:secret@127.0.0.1:5432/ember_prod', {}),
    ).toThrow(/production|staging/i);
    expect(() =>
      assertSafeLocalDatabaseUrl('postgres://user:secret@127.0.0.1:5432/ember_staging', {}),
    ).toThrow(/production|staging/i);
    expect(() =>
      assertSafeLocalDatabaseUrl('postgres://user:secret@127.0.0.1:5432/appdb', {}),
    ).toThrow(/test\/local/i);
    expect(() =>
      assertSafeLocalDatabaseUrl(DEFAULT_LOCAL_TEST_DATABASE_URL, { EMBER_ENV: 'production' }),
    ).toThrow(/production/i);
    expect(() =>
      assertSafeLocalDatabaseUrl(DEFAULT_LOCAL_TEST_DATABASE_URL, { NODE_ENV: 'production' }),
    ).toThrow(/production/i);
  });

  it('rejects invalid concurrency levels and non-positive integers before opening any DB pool', () => {
    expect(() => assertValidConcurrencyLevels([])).toThrow(/at least one/i);
    expect(() => assertValidConcurrencyLevels([0])).toThrow(/concurrencyLevel/i);
    expect(() => assertValidConcurrencyLevels([-5])).toThrow(/concurrencyLevel/i);
    expect(() => assertValidConcurrencyLevels([1.5])).toThrow(/concurrencyLevel/i);
    expect(() => assertValidConcurrencyLevels([101])).toThrow(/concurrencyLevel/i);
    expect(() => assertPositiveSafeInt('requestsPerLevel', 0)).toThrow(/requestsPerLevel/i);
  });

  it('rejects pg-connection-string query-host overrides, encoded keys, and encoded prod DB names before opening any connection', () => {
    const connectSpy = vi.spyOn(net.Socket.prototype, 'connect');
    try {
      const unsafeUrls = [
        'postgres://ember:pass@127.0.0.1:5432/ember_test?host=remote.example',
        'postgres://ember:pass@127.0.0.1:5432/ember_test?%68ost=remote.example',
        'postgres://ember:pass@127.0.0.1:5432/ember_test?sslmode=disable&host=remote.example',
        'postgres://ember:pass@127.0.0.1:5432/ember_test?hostaddr=10.0.0.5',
        'postgres://ember:pass@127.0.0.1:5432/ember_test?port=6432',
        'postgres://ember:pass@127.0.0.1:5432/ember_test?sslcert=/etc/passwd',
        'postgres://ember:pass@127.0.0.1:5432/ember_%70rod_test',
        'postgres://ember:pass@127.0.0.1:5432/ember_%6cive_test',
        'postgres://ember:pass@127.0.0.1:5432//ember_prod',
        '/var/run/postgresql ember_test',
      ];

      for (const badUrl of unsafeUrls) {
        expect(() => assertSafeLocalDatabaseUrl(badUrl, {})).toThrow();
      }

      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
    }
  });
});
