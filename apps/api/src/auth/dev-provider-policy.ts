import type { AddressInfo } from 'node:net';
import { ApiConfigError, isLoopbackHost, loadApiConfig, type EmberEnv } from '../env.js';

/**
 * R-9 / Q-1 gate for `provider: "dev"` (annex §5.5).
 *
 * The dev path is reachable only when ALL FOUR independent conditions hold:
 *   1. NODE_ENV is not production (nor a shared staging marker);
 *   2. an explicit opt-in flag is set;
 *   3. the ACTUAL bound listener is loopback-only (from `server.address()`, never the
 *      request's Host header, and never from a promise that a config value is honest);
 *   4. the run declares an isolated local/test/CI environment.
 *
 * The gate is evaluated per request against the live listener address, so an app that was
 * built before the socket was bound (or a listener later changed) cannot enable the path.
 * When any condition fails, the HTTP layer answers 404 exactly like an unknown route, so
 * the capability is not advertised. Boot-time assertions refuse to start a process whose
 * configuration could never satisfy the gate.
 */

export type LoopbackListener = AddressInfo | string | null;

export const ISOLATED_EMBER_ENVS: readonly EmberEnv[] = Object.freeze(['local', 'test', 'ci']);

export const DEV_PROVIDER_DENIAL_REASONS = [
  'production_environment',
  'opt_in_missing',
  'not_isolated_environment',
  'listener_not_loopback',
] as const;

export type DevProviderDenialReason = (typeof DEV_PROVIDER_DENIAL_REASONS)[number];

export interface DevProviderDecision {
  readonly enabled: boolean;
  readonly deniedBy: readonly DevProviderDenialReason[];
}

export interface DevProviderPolicy {
  evaluate(): DevProviderDecision;
}

export interface B1AuthEnvironment {
  readonly nodeEnv: string | undefined;
  readonly emberEnv: EmberEnv;
  readonly host: string;
  readonly allowNonLoopbackBind: boolean;
  readonly devProviderOptIn: boolean;
  readonly isolatedEnvironmentOptIn: boolean;
}

function readFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] === 'true';
}

/** Parse the auth-relevant environment without changing the shape of `ApiConfig`. */
export function loadB1AuthEnvironment(env: NodeJS.ProcessEnv = process.env): B1AuthEnvironment {
  const api = loadApiConfig(env);

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    emberEnv: api.env,
    host: api.host,
    allowNonLoopbackBind: api.allowNonLoopbackBind,
    devProviderOptIn: readFlag(env, 'EMBER_DEV_PROVIDER_ENABLED'),
    isolatedEnvironmentOptIn: readFlag(env, 'EMBER_DEV_PROVIDER_ISOLATED'),
  });
}

/**
 * Boot-time refusal (R-9): a production process with the dev provider enabled must not
 * start, and neither must a process that would bind a non-loopback interface with it on.
 * Call this before serving the first request.
 */
export function assertDevProviderBootConfig(config: B1AuthEnvironment): void {
  if (config.nodeEnv === 'production' && config.devProviderOptIn) {
    throw new ApiConfigError(
      'refusing to start: EMBER_DEV_PROVIDER_ENABLED=true with NODE_ENV=production',
    );
  }

  if (config.devProviderOptIn && !isLoopbackHost(config.host)) {
    throw new ApiConfigError(
      'refusing to start: EMBER_DEV_PROVIDER_ENABLED requires a loopback EMBER_HOST',
    );
  }

  if (config.devProviderOptIn && config.allowNonLoopbackBind) {
    throw new ApiConfigError(
      'refusing to start: EMBER_DEV_PROVIDER_ENABLED is incompatible with EMBER_ALLOW_NON_LOOPBACK_BIND=true',
    );
  }
}

/**
 * A network listener is loopback-only when the *bound* address is a loopback literal.
 * `null` (not listening yet), a unix-socket path and `0.0.0.0` / `::` all fail closed.
 */
export function isLoopbackOnlyListener(address: LoopbackListener): boolean {
  if (address === null || typeof address === 'string') {
    return false;
  }

  return isLoopbackHost(address.address);
}

export interface CreateDevProviderPolicyOptions {
  readonly environment: B1AuthEnvironment;
  /** Supplies the real bound address; defaults to "not bound", which is never eligible. */
  readonly actualListener?: () => LoopbackListener;
}

export function createDevProviderPolicy(
  options: CreateDevProviderPolicyOptions,
): DevProviderPolicy {
  const environment = options.environment;
  const actualListener = options.actualListener ?? (() => null);

  return Object.freeze({
    evaluate(): DevProviderDecision {
      const deniedBy: DevProviderDenialReason[] = [];
      const nodeEnv = environment.nodeEnv ?? '';

      if (nodeEnv === 'production' || nodeEnv === 'staging') {
        deniedBy.push('production_environment');
      }

      if (!environment.devProviderOptIn) {
        deniedBy.push('opt_in_missing');
      }

      if (
        !environment.isolatedEnvironmentOptIn ||
        !ISOLATED_EMBER_ENVS.includes(environment.emberEnv)
      ) {
        deniedBy.push('not_isolated_environment');
      }

      if (!isLoopbackOnlyListener(actualListener()) || environment.allowNonLoopbackBind) {
        deniedBy.push('listener_not_loopback');
      }

      return Object.freeze({ enabled: deniedBy.length === 0, deniedBy: Object.freeze(deniedBy) });
    },
  });
}
