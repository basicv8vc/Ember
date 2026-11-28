import { describe, expect, it } from 'vitest';
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
      blobRoot: null,
      expireTurnsOnRead: true,
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

  it('accepts the shared deployment environments', () => {
    for (const env of ['staging', 'production'] as const) {
      const config = loadApiConfig({ EMBER_ENV: env });
      expect(config.env).toBe(env);
      expect(config.expireTurnsOnRead).toBe(false);
    }
  });

  it('keeps staging Turns pending when both responder modes are disabled', () => {
    const config = loadApiConfig({
      EMBER_ENV: 'staging',
      NODE_ENV: 'staging',
      EMBER_B1_FAKE_RESPONDER_ENABLED: 'false',
      EMBER_MODEL_EXECUTION: 'disabled',
    });

    expect(config.expireTurnsOnRead).toBe(false);
  });

  it('fails closed when NODE_ENV marks a shared deployment', () => {
    const config = loadApiConfig({ EMBER_ENV: 'local', NODE_ENV: 'staging' });

    expect(config.expireTurnsOnRead).toBe(false);
  });

  it('rejects an environment it does not know', () => {
    for (const env of ['prod', 'staging2', 'STAGING', '']) {
      expect(() => loadApiConfig({ EMBER_ENV: env })).toThrow(ApiConfigError);
    }
  });

  it('accepts only an absolute API blob root', () => {
    expect(loadApiConfig({ EMBER_API_BLOB_ROOT: '/var/lib/ember/blobs' }).blobRoot).toBe(
      '/var/lib/ember/blobs',
    );
    expect(() => loadApiConfig({ EMBER_API_BLOB_ROOT: 'relative/blobs' })).toThrow(
      /EMBER_API_BLOB_ROOT must be an absolute path/,
    );
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
