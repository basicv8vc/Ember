import { isIP } from 'node:net';
import { z } from 'zod';

export class ApiConfigError extends Error {
  override readonly name = 'ApiConfigError';
}

export type EmberEnv = 'local' | 'test' | 'ci';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ApiConfig {
  readonly env: EmberEnv;
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly allowNonLoopbackBind: boolean;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost']);

const apiEnvSchema = z.object({
  EMBER_ENV: z.enum(['local', 'test', 'ci']).default('local'),
  EMBER_HOST: z.string().min(1).max(255).default('127.0.0.1'),
  EMBER_PORT: z.coerce
    .number()
    .int('EMBER_PORT must be an integer')
    .min(1, 'EMBER_PORT must be at least 1')
    .max(65_535, 'EMBER_PORT must be at most 65535')
    .default(8787),
  EMBER_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  EMBER_ALLOW_NON_LOOPBACK_BIND: z.enum(['true', 'false']).default('false'),
});

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
}

/**
 * Canonicalise a syntactically valid IPv6 address so `0:0:0:0:0:0:0:1` and `::1`
 * compare equal. Returns `null` when the address cannot be normalised.
 */
function canonicalizeIpv6(address: string): string | null {
  try {
    return new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Strict loopback check.
 *
 * Accepts only:
 * - the controlled hostname `localhost`;
 * - syntactically valid IPv4 addresses inside `127.0.0.0/8`;
 * - the IPv6 loopback address `::1` (any equivalent spelling).
 *
 * Invalid input such as `127.999.999.999` or `127.1` is rejected: the policy must
 * not depend on how the OS or DNS later interprets a malformed address.
 */
export function isLoopbackHost(host: string): boolean {
  const candidate = host.trim().toLowerCase();

  if (LOOPBACK_HOSTNAMES.has(candidate)) {
    return true;
  }

  const address =
    candidate.startsWith('[') && candidate.endsWith(']') ? candidate.slice(1, -1) : candidate;
  const family = isIP(address);

  if (family === 4) {
    const [firstOctet] = address.split('.').map(Number);
    return firstOctet === 127;
  }

  if (family === 6) {
    return canonicalizeIpv6(address) === '::1';
  }

  return false;
}

/**
 * Validate API environment variables.
 *
 * The listener defaults to `127.0.0.1`. Binding any non-loopback address requires
 * the explicit `EMBER_ALLOW_NON_LOOPBACK_BIND=true` opt-in so a local run cannot
 * accidentally expose the service on a LAN/public interface.
 *
 * @throws {ApiConfigError} when values are missing or malformed.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = apiEnvSchema.safeParse(env);

  if (!parsed.success) {
    throw new ApiConfigError(`Invalid API environment: ${formatIssues(parsed.error)}`);
  }

  const values = parsed.data;
  const allowNonLoopbackBind = values.EMBER_ALLOW_NON_LOOPBACK_BIND === 'true';

  if (!isLoopbackHost(values.EMBER_HOST) && !allowNonLoopbackBind) {
    throw new ApiConfigError(
      `Refusing to bind non-loopback host "${values.EMBER_HOST}" without EMBER_ALLOW_NON_LOOPBACK_BIND=true`,
    );
  }

  return {
    env: values.EMBER_ENV,
    host: values.EMBER_HOST,
    port: values.EMBER_PORT,
    logLevel: values.EMBER_LOG_LEVEL,
    allowNonLoopbackBind,
  };
}
