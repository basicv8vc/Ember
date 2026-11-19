import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  assertPositiveSafeInt,
  assertSafeLocalDatabaseUrl,
  assertValidConcurrencyLevels,
  DEFAULT_LOCAL_TEST_DATABASE_URL,
  resolveSafeLocalDatabaseUrl,
} from '../../apps/benchmark/src/local-guard.js';
import { runV1BaselineBenchmark } from '../../apps/benchmark/src/v1-baseline.js';

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

  it('rejects remote/cloud DB hosts, production/staging DB names, and prod/staging environments', async () => {
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

    // Must fail even when enableLocalLoad=true
    await expect(
      runV1BaselineBenchmark({
        databaseUrl: 'postgres://user:secret@db.supabase.co:5432/ember_test',
        enableLocalLoad: true,
        concurrencyLevels: [1],
        requestsPerLevel: 1,
      }),
    ).rejects.toThrow(/loopback/i);
  });

  it('rejects invalid concurrency levels and non-positive integers before opening any DB pool', async () => {
    expect(() => assertValidConcurrencyLevels([])).toThrow(/at least one/i);
    expect(() => assertValidConcurrencyLevels([0])).toThrow(/concurrencyLevel/i);
    expect(() => assertValidConcurrencyLevels([-5])).toThrow(/concurrencyLevel/i);
    expect(() => assertValidConcurrencyLevels([1.5])).toThrow(/concurrencyLevel/i);
    expect(() => assertValidConcurrencyLevels([101])).toThrow(/concurrencyLevel/i);
    expect(() => assertPositiveSafeInt('requestsPerLevel', 0)).toThrow(/requestsPerLevel/i);

    await expect(
      runV1BaselineBenchmark({
        concurrencyLevels: [0],
        requestsPerLevel: 5,
      }),
    ).rejects.toThrow(/concurrencyLevel/i);

    await expect(
      runV1BaselineBenchmark({
        concurrencyLevels: [1, 150],
        enableLocalLoad: true,
        requestsPerLevel: 5,
      }),
    ).rejects.toThrow(/concurrencyLevel/i);
  });

  it('rejects pg-connection-string query-host overrides, encoded keys, and encoded prod DB names before opening any connection', async () => {
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
        await expect(
          runV1BaselineBenchmark({
            databaseUrl: badUrl,
            enableLocalLoad: true,
            concurrencyLevels: [1],
            requestsPerLevel: 1,
          }),
        ).rejects.toThrow();
      }

      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
    }
  });
});
