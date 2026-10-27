import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadDatabaseConfig,
  redactDatabaseUrl,
} from '../../packages/postgres/src/config.js';
import { ApiConfigError, isLoopbackHost, loadApiConfig } from '../../apps/api/src/env.js';

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

  it('allows a non-loopback bind only when explicitly enabled', () => {
    const config = loadApiConfig({
      EMBER_HOST: '0.0.0.0',
      EMBER_ALLOW_NON_LOOPBACK_BIND: 'true',
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.allowNonLoopbackBind).toBe(true);
  });
});

describe('isLoopbackHost', () => {
  it('recognises loopback hosts and rejects public ones', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.10.20.30')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
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

describe('redactDatabaseUrl', () => {
  it('removes the password but keeps host and database', () => {
    const redacted = redactDatabaseUrl('postgres://ember:top-secret@127.0.0.1:55432/ember');

    expect(redacted).not.toContain('top-secret');
    expect(redacted).toContain('127.0.0.1:55432');
    expect(redacted).toContain('/ember');
  });

  it('never throws on malformed input', () => {
    expect(redactDatabaseUrl('not a url')).toBe('<invalid-database-url>');
  });
});
