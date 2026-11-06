import { IdSchema } from '@ember/contracts';
import type { AuthContext } from '@ember/domain';
import { z } from 'zod';
import { resolveDeploymentProfile, type EnvSource } from '../deployment.js';

/**
 * Local-development tenant authentication (P0B-07a).
 *
 * P0-B has no identity provider: a real OAuth/OIDC flow is explicitly out of scope. Instead
 * the API reads a small, explicit set of *local* tenant credentials from the environment and
 * maps a presented bearer token to a verified `AuthContext`. This module only parses and
 * validates configuration; token comparison lives in `bearer-authenticator.ts`.
 *
 * Rules that keep this boundary honest:
 * - a tenant identity comes from configuration only, never from a request body or query;
 * - at least two independent tenants can be configured (slots `A` and `B`), so cross-tenant
 *   isolation is testable without inventing a second code path;
 * - unconfigured slots are simply absent, and a slot that is partially configured is a
 *   startup error instead of a silent half-identity;
 * - error messages name environment variables but never contain token values.
 */

/** Configuration failure for local dev auth. Messages never contain token values. */
export class DevAuthConfigError extends Error {
  override readonly name = 'DevAuthConfigError';
}

/**
 * One configured dev tenant.
 *
 * `token` is the raw bearer token. It is kept only long enough to build a digest map, is
 * never logged, never echoed in an error and never persisted.
 */
export interface DevTenantCredential extends AuthContext {
  readonly token: string;
}

/** Independent tenant slots. Adding a slot here is the only code change needed for a third. */
export const DEV_AUTH_SLOTS = ['A', 'B'] as const;
export type DevAuthSlot = (typeof DEV_AUTH_SLOTS)[number];

/** Shared prefix of every dev auth variable: `EMBER_DEV_AUTH_TENANT_<SLOT>_<FIELD>`. */
export const DEV_AUTH_ENV_PREFIX = 'EMBER_DEV_AUTH_TENANT_';

export interface DevAuthConfig {
  /** Configured tenants. Empty is valid: every `/v1` request then fails closed with 401. */
  readonly tenants: readonly DevTenantCredential[];
  /**
   * True when the deployment itself forbids dev tenant bearer tokens (staging, production, or an
   * unrecognised environment marker). When true `tenants` is always empty: the credentials are
   * not parsed, not retained and cannot authenticate anything.
   */
  readonly disabled: boolean;
  /** The marker that disabled them, e.g. `NODE_ENV=production`. `null` for a development run. */
  readonly disabledBy: string | null;
  /**
   * Names — never values — of credential variables that were present and ignored because the
   * deployment forbids them. A non-empty list means a secret was injected where it must not be,
   * so the composition root reports it loudly.
   */
  readonly ignoredVariables: readonly string[];
}

const TOKEN_MIN_CHARS = 16;
const TOKEN_MAX_CHARS = 256;

/**
 * Bearer tokens are header values, so only RFC 6750 `b64token` characters are accepted.
 * This rejects whitespace, control characters and non-ASCII input before any comparison.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;

const tokenSchema = z.string().min(TOKEN_MIN_CHARS).max(TOKEN_MAX_CHARS).regex(TOKEN_PATTERN);
const policyVersionSchema = z.coerce.number().int().nonnegative().max(1_000_000);

function readValue(env: EnvSource, name: string): string | undefined {
  const raw = env[name];

  if (raw === undefined) {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parsePolicyVersion(raw: string, variableName: string): number {
  const parsed = policyVersionSchema.safeParse(raw);

  if (!parsed.success) {
    throw new DevAuthConfigError(`${variableName} must be a non-negative integer`);
  }

  return parsed.data;
}

/**
 * Load the dev tenant credentials from an explicit environment object.
 *
 * Staging and production have no dev tenant authentication. This is decided by the deployment
 * classification, not by the presence of a flag: when the process is not a development run the
 * credentials are never parsed, so no environment variable can re-open the path.
 *
 * Previously this function threw unconditionally on `NODE_ENV=production`, which made a
 * production boot impossible even with no dev credentials configured at all. The refusal is now
 * scoped to the thing that is actually unsafe: credential material. A shared deployment whose
 * environment carries `EMBER_DEV_AUTH_TENANT_*` starts normally, ignores the values and reports
 * their *names* through `ignoredVariables`; every request that presents one of those tokens is
 * rejected with 401.
 *
 * @throws {DevAuthConfigError} in a development run, when a slot is only partially configured,
 * when a value is malformed, or when two slots share one token.
 */
export function loadDevAuthConfig(env: EnvSource = process.env): DevAuthConfig {
  const profile = resolveDeploymentProfile(env);

  if (!profile.developmentSurfacesAllowed) {
    const ignoredVariables = Object.keys(env)
      .filter((name) => name.startsWith(DEV_AUTH_ENV_PREFIX))
      .filter((name) => readValue(env, name) !== undefined)
      .sort();

    return Object.freeze({
      tenants: Object.freeze([]),
      disabled: true,
      disabledBy: profile.declaredBy,
      ignoredVariables: Object.freeze(ignoredVariables),
    });
  }

  const tenants: DevTenantCredential[] = [];
  const seenTokens = new Set<string>();

  for (const slot of DEV_AUTH_SLOTS) {
    const prefix = `${DEV_AUTH_ENV_PREFIX}${slot}_`;
    const tokenVariable = `${prefix}TOKEN`;
    const token = readValue(env, tokenVariable);
    const tenantVariable = `${prefix}TENANT_ID`;
    const tenantId = readValue(env, tenantVariable);
    const principalVariable = `${prefix}PRINCIPAL_ID`;
    const principalId = readValue(env, principalVariable);
    const policyVersionVariable = `${prefix}POLICY_VERSION`;
    const policyVersion = readValue(env, policyVersionVariable);

    if (
      token === undefined &&
      tenantId === undefined &&
      principalId === undefined &&
      policyVersion === undefined
    ) {
      // Documented, valid state: the slot is unused and no token can authenticate for it.
      continue;
    }

    if (token === undefined || tenantId === undefined || principalId === undefined) {
      const missing = [
        token === undefined ? tokenVariable : undefined,
        tenantId === undefined ? tenantVariable : undefined,
        principalId === undefined ? principalVariable : undefined,
      ].filter((name): name is string => name !== undefined);

      throw new DevAuthConfigError(
        `dev auth tenant slot ${slot} is incomplete; set ${missing.join(', ')} as well (or unset the whole slot)`,
      );
    }

    const parsedToken = tokenSchema.safeParse(token);

    if (!parsedToken.success) {
      // The rejected value is intentionally not interpolated: it is a secret.
      throw new DevAuthConfigError(
        `${tokenVariable} must be ${TOKEN_MIN_CHARS}-${TOKEN_MAX_CHARS} characters of [A-Za-z0-9._~+/=-]`,
      );
    }

    const parsedTenantId = IdSchema.safeParse(tenantId);

    if (!parsedTenantId.success) {
      throw new DevAuthConfigError(`${tenantVariable} must be a UUID`);
    }

    const parsedPrincipalId = IdSchema.safeParse(principalId);

    if (!parsedPrincipalId.success) {
      throw new DevAuthConfigError(`${principalVariable} must be a UUID`);
    }

    const resolvedPolicyVersion =
      policyVersion === undefined ? 1 : parsePolicyVersion(policyVersion, policyVersionVariable);

    if (seenTokens.has(parsedToken.data)) {
      throw new DevAuthConfigError(
        `${tokenVariable} duplicates another slot; each dev tenant needs its own token`,
      );
    }

    seenTokens.add(parsedToken.data);
    tenants.push(
      Object.freeze({
        token: parsedToken.data,
        tenantId: parsedTenantId.data,
        principalId: parsedPrincipalId.data,
        policyVersion: resolvedPolicyVersion,
      }),
    );
  }

  return Object.freeze({
    tenants: Object.freeze(tenants),
    disabled: false,
    disabledBy: null,
    ignoredVariables: Object.freeze([]),
  });
}
