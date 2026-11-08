import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { resolveDeploymentProfile } from './deployment.js';

export class ApiConfigError extends Error {
  override readonly name = 'ApiConfigError';
}

/**
 * Every environment this API is allowed to declare.
 *
 * `local`/`test`/`ci` are developer and CI runs. `staging` and `production` are *shared*
 * deployments: they are reachable over the network, hold real user rows and must never expose a
 * development-only surface. See `deployment.ts` for how the class is derived.
 */
export const EMBER_ENVS = ['local', 'test', 'ci', 'staging', 'production'] as const;

export type EmberEnv = (typeof EMBER_ENVS)[number];
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ApiConfig {
  readonly env: EmberEnv;
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly allowNonLoopbackBind: boolean;
  /** Shared controlled blob root; null keeps Artifact reads fail-closed and unavailable. */
  readonly blobRoot: string | null;
  /** Development expires overdue Turns on poll; shared APIs leave terminalization to a responder or cancel. */
  readonly expireTurnsOnRead: boolean;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost']);

const apiEnvSchema = z.object({
  EMBER_ENV: z.enum(EMBER_ENVS).default('local'),
  EMBER_HOST: z.string().trim().min(1).max(255).default('127.0.0.1'),
  EMBER_PORT: z.coerce
    .number()
    .int('EMBER_PORT must be an integer')
    .min(1, 'EMBER_PORT must be at least 1')
    .max(65_535, 'EMBER_PORT must be at most 65535')
    .default(8787),
  EMBER_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  EMBER_ALLOW_NON_LOOPBACK_BIND: z.enum(['true', 'false']).default('false'),
  EMBER_API_BLOB_ROOT: z.string().trim().min(1).optional(),
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
 * Normalise a listener host into the form Node's `server.listen()` expects.
 *
 * Bracketed IPv6 literals such as `[::1]` are valid in URLs but are resolved as a
 * hostname by `server.listen()`, which fails with `ENOTFOUND`. Store and pass the
 * unbracketed address so validation and the actual socket bind agree.
 */
export function normalizeHost(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Strict loopback check.
 *
 * Accepts only:
 * - the controlled hostname `localhost`;
 * - syntactically valid IPv4 addresses inside `127.0.0.0/8`;
 * - the IPv6 loopback address `::1` (any equivalent spelling, brackets allowed).
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
  const host = normalizeHost(values.EMBER_HOST);

  if (host === '') {
    throw new ApiConfigError('EMBER_HOST must not be empty');
  }

  const blobRoot = parsed.data.EMBER_API_BLOB_ROOT ?? null;

  if (blobRoot !== null && !isAbsolute(blobRoot)) {
    throw new ApiConfigError('EMBER_API_BLOB_ROOT must be an absolute path');
  }

  if (!isLoopbackHost(host) && !allowNonLoopbackBind) {
    throw new ApiConfigError(
      `Refusing to bind non-loopback host "${host}" without EMBER_ALLOW_NON_LOOPBACK_BIND=true`,
    );
  }

  return {
    env: values.EMBER_ENV,
    host,
    port: values.EMBER_PORT,
    logLevel: values.EMBER_LOG_LEVEL,
    allowNonLoopbackBind,
    blobRoot,
    expireTurnsOnRead: resolveDeploymentProfile(env).deployment === 'development',
  };
}
