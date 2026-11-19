import {
  assertPositiveSafeInt,
  assertSafeLocalDatabaseUrl,
  assertValidConcurrencyLevels,
} from '../local-guard.js';

export { assertPositiveSafeInt, assertSafeLocalDatabaseUrl, assertValidConcurrencyLevels };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const FORBIDDEN_V1_OR_CLOUD_KEYS = [
  'DATABASE_URL',
  'DIRECT_DATABASE_URL',
  'HYPERDRIVE',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'DAYTONA_API_KEY',
  'EMBER_APPLE_PRIVATE_KEY',
] as const;

export interface LocalV2RuntimeGuardOptions {
  readonly targetUrl?: string;
  readonly fakeGatewayUrl?: string;
}

/**
 * Validate that a URL is strictly HTTP loopback (no remote cloud endpoints).
 */
export function assertLoopbackHttpUrl(label: string, rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid ${label}: expected valid HTTP loopback URL, got "${rawUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsafe ${label} protocol "${parsed.protocol}": expected http: or https:`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Unsafe ${label} host "${host}": local V2 harness only permits loopback hosts (127.0.0.1, localhost, ::1).`,
    );
  }
}

/**
 * Enforce strict local-only isolation for V2 M1 harness execution.
 * Refuses production/staging environments, real provider modes, Daytona egress, and non-loopback targets.
 */
export function assertSafeLocalV2RuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: LocalV2RuntimeGuardOptions = {},
): void {
  const emberEnv = (env.EMBER_ENV ?? '').trim().toLowerCase();
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  if (emberEnv === 'production' || emberEnv === 'staging' || nodeEnv === 'production') {
    throw new Error(
      `Unsafe V2 harness environment (EMBER_ENV="${emberEnv || 'unset'}", NODE_ENV="${nodeEnv || 'unset'}"): refuses to run in production or staging.`,
    );
  }

  const modelMode = (env.EMBER_MODEL_MODE ?? '').trim().toLowerCase();
  if (modelMode === 'real') {
    throw new Error(
      'Unsafe EMBER_MODEL_MODE="real": V2 M1 harness forbids real LLM provider calls; only fake mode is permitted.',
    );
  }

  const daytonaEnabled = (env.EMBER_DAYTONA_ENABLED ?? '').trim().toLowerCase();
  if (daytonaEnabled === 'true' || daytonaEnabled === '1') {
    throw new Error(
      'Unsafe EMBER_DAYTONA_ENABLED: V2 M1 harness forbids real Daytona cloud sandbox execution.',
    );
  }

  if (options.targetUrl !== undefined) {
    assertLoopbackHttpUrl('targetUrl', options.targetUrl);
  }
  if (options.fakeGatewayUrl !== undefined) {
    assertLoopbackHttpUrl('fakeGatewayUrl', options.fakeGatewayUrl);
  }
}

/**
 * Validate a parsed Wrangler config object so production/staging routes, Hyperdrive,
 * or non-isolated cloud bindings can never be booted by the local M1 harness.
 */
export function assertIsolatedWranglerConfig(rawConfig: Record<string, unknown>): void {
  if (Array.isArray(rawConfig.routes) && rawConfig.routes.length > 0) {
    throw new Error(
      'Unsafe Wrangler config: custom routes/domains are forbidden in local V2 M1 harness.',
    );
  }
  if (Array.isArray(rawConfig.hyperdrive) && rawConfig.hyperdrive.length > 0) {
    throw new Error(
      'Unsafe Wrangler config: V1 Hyperdrive bindings are forbidden in local V2 M1 harness.',
    );
  }
  const vars = rawConfig.vars;
  if (vars !== null && typeof vars === 'object' && !Array.isArray(vars)) {
    const varsRecord = vars as Record<string, unknown>;
    const envVal =
      typeof varsRecord.EMBER_ENV === 'string' ? varsRecord.EMBER_ENV.toLowerCase() : '';
    if (envVal === 'production' || envVal === 'staging') {
      throw new Error(
        `Unsafe Wrangler vars.EMBER_ENV="${envVal}": local V2 M1 harness refuses production/staging vars.`,
      );
    }
    const modeVal =
      typeof varsRecord.EMBER_MODEL_MODE === 'string'
        ? varsRecord.EMBER_MODEL_MODE.toLowerCase()
        : '';
    if (modeVal === 'real') {
      throw new Error(
        'Unsafe Wrangler vars.EMBER_MODEL_MODE="real": real LLM mode is forbidden in M1.',
      );
    }
    for (const key of FORBIDDEN_V1_OR_CLOUD_KEYS) {
      if (key in varsRecord && varsRecord[key] !== undefined && varsRecord[key] !== null) {
        const val = varsRecord[key];
        const nonEmpty = typeof val === 'string' ? val.trim().length > 0 : true;
        if (nonEmpty) {
          throw new Error(
            `Unsafe Wrangler vars.${key}: V1/cloud credentials and DB URLs must not be injected into local V2 harness.`,
          );
        }
      }
    }
  }
}

/**
 * Construct an isolated, sanitized local test var map for Worker bindings.
 */
export function buildSanitizedLocalWorkerVars(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = {
    EMBER_ENV: 'test',
    EMBER_MODEL_MODE: 'fake',
    EMBER_B1_FAKE_RESPONDER_ENABLED: 'true',
    EMBER_V2_ISOLATED_HARNESS: 'true',
    EMBER_DAYTONA_ENABLED: 'false',
  };
  const merged = { ...base, ...overrides };
  for (const forbidden of FORBIDDEN_V1_OR_CLOUD_KEYS) {
    if (forbidden in merged) {
      throw new Error(`Refusing to pass forbidden V1/cloud var "${forbidden}" to local V2 Worker.`);
    }
  }
  return merged;
}
