import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  assertPositiveSafeInt,
  assertSafeLocalDatabaseUrl,
  assertValidConcurrencyLevels,
} from '../local-guard.js';

export { assertPositiveSafeInt, assertSafeLocalDatabaseUrl, assertValidConcurrencyLevels };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const PINNED_LOCAL_WORKER_KEYS = new Set([
  'EMBER_ENV',
  'EMBER_MODEL_MODE',
  'EMBER_B1_FAKE_RESPONDER_ENABLED',
  'EMBER_V2_ISOLATED_HARNESS',
  'EMBER_DAYTONA_ENABLED',
  'FAKE_MODEL_GATEWAY_URL',
  'V2_FAULT_CONTROL_URL',
]);

const FORBIDDEN_V1_OR_CLOUD_KEYS = [
  'DATABASE_URL',
  'DIRECT_DATABASE_URL',
  'HYPERDRIVE',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DAYTONA_API_KEY',
  'DAYTONA_API_URL',
  'EMBER_APPLE_PRIVATE_KEY',
] as const;

const FORBIDDEN_CLOUD_CONFIG_FIELDS = [
  'route',
  'routes',
  'custom_domain',
  'domains',
  'zone_id',
  'account_id',
  'hyperdrive',
  'ai',
  'vectorize',
  'browser',
  'mtls_certificates',
  'send_email',
  'dispatch_namespaces',
  'cloudchamber',
  'containers',
] as const;

export interface LocalV2RuntimeGuardOptions {
  readonly targetUrl?: string;
  readonly fakeGatewayUrl?: string;
  readonly faultControlUrl?: string;
}

export interface PinnedLocalWorkerVars {
  readonly fakeGatewayUrl: string;
  readonly faultControlUrl: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate that a URL is strictly HTTP/HTTPS loopback (no remote cloud endpoints).
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
 * Strictly parse JSON or JSONC (line comments, block comments, trailing commas) and fail closed
 * on malformed input or unsupported config formats (e.g. TOML).
 */
export function parseStrictJsonc(
  rawText: string,
  sourceLabel = 'wrangler config',
): Record<string, unknown> {
  let stripped = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i]!;
    const next = i + 1 < rawText.length ? rawText[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        stripped += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      stripped += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stripped += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    stripped += ch;
  }

  if (inBlockComment) {
    throw new Error(`Invalid JSONC in ${sourceLabel}: unterminated block comment.`);
  }
  if (inString) {
    throw new Error(`Invalid JSONC in ${sourceLabel}: unterminated string literal.`);
  }

  // Strip trailing commas before '}' or ']' outside string literals.
  let normalized = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (inString) {
      normalized += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      normalized += ch;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < stripped.length && /\s/.test(stripped[j]!)) {
        j += 1;
      }
      const nextToken = stripped[j];
      if (nextToken === '}' || nextToken === ']') {
        continue;
      }
    }

    normalized += ch;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (err) {
    throw new Error(
      `Fail-closed Wrangler config parse error in ${sourceLabel}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid ${sourceLabel}: root JSON/JSONC value must be an object.`);
  }
  return parsed;
}

/**
 * Enforce strict local-only isolation for V2 M1 harness host environment and endpoint URLs.
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
  if (options.faultControlUrl !== undefined) {
    assertLoopbackHttpUrl('faultControlUrl', options.faultControlUrl);
  }
}

function assertSafeVarsMap(varsRecord: Record<string, unknown>, contextLabel: string): void {
  for (const [rawKey, rawVal] of Object.entries(varsRecord)) {
    const key = rawKey.trim();
    const valStr = typeof rawVal === 'string' ? rawVal.trim() : '';

    if (key === 'EMBER_ENV') {
      const lowered = valStr.toLowerCase();
      if (lowered === 'production' || lowered === 'staging') {
        throw new Error(
          `Unsafe ${contextLabel}.EMBER_ENV="${lowered}": local V2 M1 harness refuses production/staging vars.`,
        );
      }
    }

    if (key === 'EMBER_MODEL_MODE' && valStr.toLowerCase() === 'real') {
      throw new Error(
        `Unsafe ${contextLabel}.EMBER_MODEL_MODE="real": real LLM mode is forbidden in M1.`,
      );
    }

    if (key === 'EMBER_DAYTONA_ENABLED') {
      const lowered = valStr.toLowerCase();
      if (lowered === 'true' || lowered === '1' || (typeof rawVal === 'boolean' && rawVal)) {
        throw new Error(
          `Unsafe ${contextLabel}.EMBER_DAYTONA_ENABLED: real Daytona sandbox execution is forbidden in M1.`,
        );
      }
    } else if (
      key.startsWith('DAYTONA_') &&
      rawVal !== undefined &&
      rawVal !== null &&
      valStr.length > 0
    ) {
      throw new Error(
        `Unsafe ${contextLabel}.${key}: Daytona configuration/credentials are forbidden in local V2 harness.`,
      );
    }

    if ((FORBIDDEN_V1_OR_CLOUD_KEYS as readonly string[]).includes(key)) {
      const nonEmpty =
        rawVal !== undefined &&
        rawVal !== null &&
        (typeof rawVal === 'string' ? valStr.length > 0 : true);
      if (nonEmpty) {
        throw new Error(
          `Unsafe ${contextLabel}.${key}: V1/cloud credentials and DB URLs must not be injected into local V2 harness.`,
        );
      }
    }

    if (
      (key.endsWith('_URL') || key.endsWith('_ORIGIN') || key.endsWith('_ENDPOINT')) &&
      typeof rawVal === 'string' &&
      valStr.length > 0
    ) {
      assertLoopbackHttpUrl(`${contextLabel}.${key}`, valStr);
    }
  }
}

function assertNoRemoteBindingsInArray(
  arr: unknown,
  bindingKind: string,
  extraCheck?: (entry: Record<string, unknown>, index: number) => void,
): void {
  if (!Array.isArray(arr)) return;
  const entries = arr as readonly unknown[];
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    if (!isPlainObject(item)) continue;
    if (item.remote === true || item.experimental_remote === true) {
      throw new Error(
        `Unsafe Wrangler ${bindingKind}[${i}]: remote binding execution is forbidden in local V2 harness.`,
      );
    }
    if (
      item.preview_database_id !== undefined ||
      item.preview_id !== undefined ||
      item.preview_bucket_name !== undefined
    ) {
      throw new Error(
        `Unsafe Wrangler ${bindingKind}[${i}]: preview remote resource IDs are forbidden in local V2 harness.`,
      );
    }
    extraCheck?.(item, i);
  }
}

/**
 * Resolve the effective Wrangler config (merging selected `env.<name>` if provided) and fail closed
 * if the selected environment is missing or invalid.
 */
export function resolveEffectiveWranglerConfig(
  rawConfig: Record<string, unknown>,
  selectedEnv?: string,
): Record<string, unknown> {
  if (selectedEnv === undefined) {
    return rawConfig;
  }

  if (!isPlainObject(rawConfig.env) || !isPlainObject(rawConfig.env[selectedEnv])) {
    throw new Error(
      `Fail-closed Wrangler config error: requested env "${selectedEnv}" does not exist in config.env.`,
    );
  }

  const envBlock = rawConfig.env[selectedEnv];
  const baseVars = isPlainObject(rawConfig.vars) ? rawConfig.vars : {};
  const envVars = isPlainObject(envBlock.vars) ? envBlock.vars : {};

  return {
    ...rawConfig,
    ...envBlock,
    vars: {
      ...baseVars,
      ...envVars,
    },
  };
}

/**
 * Validate a parsed Wrangler config (and optional selected `env`) so production/staging routes,
 * Hyperdrive, remote bindings, external DO/service bindings, Daytona, and forbidden V1/cloud vars
 * can never be booted by the local M1 harness. Returns the effective resolved config.
 */
export function assertIsolatedWranglerConfig(
  rawConfig: Record<string, unknown>,
  selectedEnv?: string,
): Record<string, unknown> {
  const effective = resolveEffectiveWranglerConfig(rawConfig, selectedEnv);

  for (const field of FORBIDDEN_CLOUD_CONFIG_FIELDS) {
    const val = effective[field];
    if (val === undefined || val === null) continue;
    if (Array.isArray(val) && val.length === 0) continue;
    if (typeof val === 'boolean' && !val) continue;
    throw new Error(
      `Unsafe Wrangler config field "${field}": cloud routing, account metadata, or remote bindings are forbidden in local V2 M1 harness.`,
    );
  }

  assertNoRemoteBindingsInArray(effective.d1_databases, 'd1_databases');
  assertNoRemoteBindingsInArray(effective.r2_buckets, 'r2_buckets');
  assertNoRemoteBindingsInArray(effective.kv_namespaces, 'kv_namespaces');
  assertNoRemoteBindingsInArray(effective.services, 'services', (entry, idx) => {
    if (typeof entry.service === 'string' && entry.service.trim().length > 0) {
      throw new Error(
        `Unsafe Wrangler services[${idx}] ("${entry.service}"): external service bindings are forbidden in isolated local V2 harness.`,
      );
    }
  });

  if (
    isPlainObject(effective.durable_objects) &&
    Array.isArray(effective.durable_objects.bindings)
  ) {
    assertNoRemoteBindingsInArray(
      effective.durable_objects.bindings,
      'durable_objects.bindings',
      (entry, idx) => {
        if (typeof entry.script_name === 'string' && entry.script_name.trim().length > 0) {
          throw new Error(
            `Unsafe Wrangler durable_objects.bindings[${idx}].script_name ("${entry.script_name}"): cross-script/remote DO bindings are forbidden in isolated local V2 harness.`,
          );
        }
      },
    );
  }

  if (isPlainObject(effective.vars)) {
    assertSafeVarsMap(effective.vars, 'Wrangler vars');
  }

  return effective;
}

/**
 * Refuse accidental `.dev.vars` or `.env` inheritance in a Wrangler config directory.
 */
export function assertNoAccidentalEnvFiles(configDir: string, selectedEnv?: string): void {
  const candidates = ['.dev.vars', '.env', '.env.local', '.env.staging', '.env.production'];
  if (selectedEnv !== undefined && selectedEnv.trim().length > 0) {
    candidates.push(`.dev.vars.${selectedEnv}`, `.env.${selectedEnv}`);
  }
  for (const filename of candidates) {
    const full = path.join(configDir, filename);
    if (existsSync(full)) {
      throw new Error(
        `Fail-closed isolation error: found "${full}". Local V2 harness refuses directories containing .dev.vars or .env files to prevent accidental secret inheritance.`,
      );
    }
  }
}

/**
 * Validate caller-supplied worker var overrides before booting any local services.
 */
export function validateWorkerVarOverrides(overrides: Record<string, string> = {}): void {
  for (const key of Object.keys(overrides)) {
    if (PINNED_LOCAL_WORKER_KEYS.has(key)) {
      throw new Error(
        `Refusing to override pinned local V2 harness var "${key}". Pinned isolation and loopback gateway vars are immutable.`,
      );
    }
  }
  assertSafeVarsMap(overrides, 'options.vars');
}

/**
 * Construct an isolated, sanitized local test var map for Worker bindings, pinning all safety
 * invariants and loopback URLs so `overrides` can never weaken isolation.
 */
export function buildSanitizedLocalWorkerVars(
  pinned: PinnedLocalWorkerVars,
  overrides: Record<string, string> = {},
): Record<string, string> {
  assertLoopbackHttpUrl('fakeGatewayUrl', pinned.fakeGatewayUrl);
  assertLoopbackHttpUrl('faultControlUrl', pinned.faultControlUrl);
  validateWorkerVarOverrides(overrides);

  const merged: Record<string, string> = {
    ...overrides,
    EMBER_ENV: 'test',
    EMBER_MODEL_MODE: 'fake',
    EMBER_B1_FAKE_RESPONDER_ENABLED: 'true',
    EMBER_V2_ISOLATED_HARNESS: 'true',
    EMBER_DAYTONA_ENABLED: 'false',
    FAKE_MODEL_GATEWAY_URL: pinned.fakeGatewayUrl,
    V2_FAULT_CONTROL_URL: pinned.faultControlUrl,
  };

  assertSafeVarsMap(merged, 'merged worker vars');
  return merged;
}
