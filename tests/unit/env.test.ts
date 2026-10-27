import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  describeDatabaseTarget,
  formatDatabaseTarget,
  loadDatabaseConfig,
} from '../../packages/postgres/src/config.js';
import {
  ApiConfigError,
  isLoopbackHost,
  loadApiConfig,
  normalizeHost,
} from '../../apps/api/src/env.js';

describe('loadApiConfig', () => {
  it('defaults to local mode on 127.0.0.1:8787', () => {
    const config = loadApiConfig({});

    expect(config).toEqual({
      env: 'local',
      host: '127.0.0.1',
      port: 8787,
      logLevel: 'info',
      allowNonLoopbackBind: false,
    });
  });

  it('accepts explicit loopback-friendly values', () => {
    const config = loadApiConfig({
      EMBER_ENV: 'test',
      EMBER_HOST: 'localhost',
      EMBER_PORT: '9999',
      EMBER_LOG_LEVEL: 'debug',
    });

    expect(config.host).toBe('localhost');
    expect(config.port).toBe(9999);
    expect(config.env).toBe('test');
    expect(config.logLevel).toBe('debug');
  });

  it('rejects an invalid port', () => {
    expect(() => loadApiConfig({ EMBER_PORT: '70000' })).toThrow(ApiConfigError);
    expect(() => loadApiConfig({ EMBER_PORT: 'not-a-port' })).toThrow(ApiConfigError);
  });

  it('refuses to bind a public interface without explicit opt-in', () => {
    expect(() => loadApiConfig({ EMBER_HOST: '0.0.0.0' })).toThrow(/EMBER_ALLOW_NON_LOOPBACK_BIND/);
    expect(() => loadApiConfig({ EMBER_HOST: '192.168.1.10' })).toThrow(ApiConfigError);
  });

  it('treats malformed loopback-looking addresses as non-loopback', () => {
    for (const host of ['127.999.999.999', '127.0.0.256', '127.1', '::2', '0.0.0.0']) {
      expect(() => loadApiConfig({ EMBER_HOST: host })).toThrow(ApiConfigError);
    }
  });

  it('normalises bracketed IPv6 and surrounding whitespace for the listener', () => {
    expect(loadApiConfig({ EMBER_HOST: '[::1]' }).host).toBe('::1');
    expect(loadApiConfig({ EMBER_HOST: '[0:0:0:0:0:0:0:1]' }).host).toBe('0:0:0:0:0:0:0:1');
    expect(loadApiConfig({ EMBER_HOST: ' 127.0.0.1 ' }).host).toBe('127.0.0.1');
  });

  it('rejects an empty host after normalisation', () => {
    expect(() => loadApiConfig({ EMBER_HOST: '[]' })).toThrow(/must not be empty/);
    expect(() => loadApiConfig({ EMBER_HOST: '   ' })).toThrow(ApiConfigError);
  });

  it('applies the loopback policy to the normalised host', () => {
    expect(() => loadApiConfig({ EMBER_HOST: '[::2]' })).toThrow(/EMBER_ALLOW_NON_LOOPBACK_BIND/);
    expect(loadApiConfig({ EMBER_HOST: '[::2]', EMBER_ALLOW_NON_LOOPBACK_BIND: 'true' }).host).toBe(
      '::2',
    );
  });

  it('allows a non-loopback bind only when explicitly enabled', () => {
    const config = loadApiConfig({
      EMBER_HOST: '0.0.0.0',
      EMBER_ALLOW_NON_LOOPBACK_BIND: 'true',
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.allowNonLoopbackBind).toBe(true);
  });
});

describe('normalizeHost', () => {
  it('strips exactly one pair of IPv6 brackets and trims whitespace', () => {
    expect(normalizeHost('[::1]')).toBe('::1');
    expect(normalizeHost('  [::1]  ')).toBe('::1');
    expect(normalizeHost('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeHost('localhost')).toBe('localhost');
    expect(normalizeHost('[[::1]]')).toBe('[::1]');
    expect(normalizeHost('[]')).toBe('');
  });
});

describe('isLoopbackHost', () => {
  it('accepts valid IPv4 loopback addresses and localhost', () => {
    for (const host of ['127.0.0.1', '127.10.20.30', '127.255.255.254', 'localhost', 'LOCALHOST']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('accepts the IPv6 loopback address in equivalent spellings', () => {
    for (const host of [
      '::1',
      '0:0:0:0:0:0:0:1',
      '[::1]',
      '0000:0000:0000:0000:0000:0000:0000:0001',
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('rejects malformed IP addresses that only look like loopback', () => {
    for (const host of [
      '127.999.999.999',
      '127.0.0.256',
      '127.0.0',
      '127.1',
      '127.0.0.1.5',
      '127.0.0.1:8787',
      '0127.0.0.1',
      '127.0.0.-1',
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it('rejects other IPv6 addresses, including IPv4-mapped loopback', () => {
    for (const host of ['::2', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1', '[::2]']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it('rejects unspecified, LAN, public and non-IP hosts', () => {
    for (const host of [
      '0.0.0.0',
      '192.168.1.10',
      '10.0.0.1',
      '8.8.8.8',
      'example.com',
      'localhost.attacker.example',
      'localhost.',
      '',
      '   ',
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('loadDatabaseConfig', () => {
  it('requires DATABASE_URL', () => {
    expect(() => loadDatabaseConfig({})).toThrow(ConfigError);
  });

  it('rejects non-PostgreSQL connection strings without echoing secrets', () => {
    const secret = 'super-secret-password';

    try {
      loadDatabaseConfig({ DATABASE_URL: `mysql://ember:${secret}@localhost:3306/ember` });
      expect.unreachable('expected configuration to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('applies validated defaults', () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: 'postgres://ember:secret@127.0.0.1:55432/ember',
    });

    expect(config.connectionString).toBe('postgres://ember:secret@127.0.0.1:55432/ember');
    expect(config.maxConnections).toBe(10);
    expect(config.connectionTimeoutMs).toBe(5_000);
    expect(config.statementTimeoutMs).toBe(10_000);
    expect(config.applicationName).toBe('ember');
  });

  it('rejects out-of-range pool settings', () => {
    const url = 'postgres://ember:secret@127.0.0.1:55432/ember';
    expect(() => loadDatabaseConfig({ DATABASE_URL: url, EMBER_DB_POOL_MAX: '0' })).toThrow(
      ConfigError,
    );
    expect(() => loadDatabaseConfig({ DATABASE_URL: url, EMBER_DB_POOL_MAX: '51' })).toThrow(
      ConfigError,
    );
  });
});

describe('describeDatabaseTarget', () => {
  it('returns only whitelisted metadata', () => {
    const target = describeDatabaseTarget('postgres://ember:secret@db.internal:5433/ember');

    expect(target).toEqual({ host: 'db.internal', port: 5433, database: 'ember' });
  });

  it('never leaks credentials or sensitive query parameters', () => {
    const connectionString =
      'postgres://ember:top-secret@db.internal:5432/ember' +
      '?password=another-secret&sslpassword=third-secret&sslmode=require';
    const serialized = JSON.stringify(describeDatabaseTarget(connectionString));

    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('another-secret');
    expect(serialized).not.toContain('third-secret');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('sslmode');
    expect(serialized).not.toContain('ember:');
  });

  it('drops percent-encoded passwords', () => {
    const target = describeDatabaseTarget('postgres://user:p%40ss%3Aword@127.0.0.1:55432/ember');
    const serialized = JSON.stringify(target);

    expect(serialized).not.toContain('p%40ss');
    expect(serialized).not.toContain('p@ss');
    expect(target).toEqual({ host: '127.0.0.1', port: 55432, database: 'ember' });
  });

  it('handles missing port, IPv6 hosts and unix-socket query parameters', () => {
    expect(describeDatabaseTarget('postgres://user:secret@db.internal/ember')).toEqual({
      host: 'db.internal',
      port: null,
      database: 'ember',
    });
    expect(describeDatabaseTarget('postgres://user:secret@[::1]:5432/ember')).toEqual({
      host: '::1',
      port: 5432,
      database: 'ember',
    });

    const unixSocket = describeDatabaseTarget(
      'postgres:///ember?host=%2Fvar%2Frun%2Fpostgresql&password=another-secret',
    );
    expect(unixSocket).toEqual({ host: null, port: null, database: 'ember' });
    expect(JSON.stringify(unixSocket)).not.toContain('another-secret');
    expect(JSON.stringify(unixSocket)).not.toContain('/var/run');
  });

  it('never throws on malformed input', () => {
    expect(describeDatabaseTarget('not a url')).toEqual({
      host: null,
      port: null,
      database: null,
    });
    expect(formatDatabaseTarget(describeDatabaseTarget('not a url'))).toBe(
      '<unknown-host>:<default-port>/<unknown-database>',
    );
  });

  it('formats metadata without any credential material', () => {
    const formatted = formatDatabaseTarget(
      describeDatabaseTarget('postgres://ember:top-secret@127.0.0.1:55432/ember?password=another'),
    );

    expect(formatted).toBe('127.0.0.1:55432/ember');
    expect(formatted).not.toContain('top-secret');
    expect(formatted).not.toContain('another');
  });
});
