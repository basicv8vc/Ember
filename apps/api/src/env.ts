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

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]']);

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

/** True for `localhost`, `::1`, and the whole IPv4 127.0.0.0/8 range. */
export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(host.toLowerCase())) {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(host);
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
