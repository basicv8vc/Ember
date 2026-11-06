import type { AddressInfo } from 'node:net';
import { resolveDeploymentProfile, type DeploymentClass } from '../deployment.js';
import { ApiConfigError, isLoopbackHost, loadApiConfig, type EmberEnv } from '../env.js';

/**
 * R-9 / Q-1 gate for `provider: "dev"` (annex §5.5).
 *
 * The dev path is reachable only when ALL FOUR independent conditions hold:
 *   1. the process is a development deployment (neither `EMBER_ENV` nor `NODE_ENV` says
 *      staging or production — see `deployment.ts`);
 *   2. an explicit opt-in flag is set;
 *   3. the ACTUAL bound listener is loopback-only (from `server.address()`, never the
 *      request's Host header, and never from a promise that a config value is honest);
 *   4. the run declares an isolated local/test/CI environment.
 *
 * Condition 1 is derived from the deployment classification rather than from `NODE_ENV` alone,
 * so `EMBER_ENV=staging` can no longer reach the dev path by simply not setting `NODE_ENV`, and
 * no flag can restore it once the classification is not `development`.
 *
 * The gate is evaluated per request against the live listener address, so an app that was
 * built before the socket was bound (or a listener later changed) cannot enable the path.
 * When any condition fails, the HTTP layer answers 404 exactly like an unknown route, so
 * the capability is not advertised. Boot-time assertions refuse to start a process whose
 * configuration could never satisfy the gate.
 */

export type LoopbackListener = AddressInfo | string | null;

export const ISOLATED_EMBER_ENVS: readonly EmberEnv[] = Object.freeze(['local', 'test', 'ci']);

/**
 * Closed set of refusal causes, logged as metadata. `production_environment` covers every
 * deployment that is not `development`, which today means `staging` and `production`.
 */
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
  /** Deployment class of this process. Only `development` can reach the dev path. */
  readonly deployment: DeploymentClass;
  /** The marker that produced `deployment`; `null` for a development run. Diagnostics only. */
  readonly deploymentDeclaredBy: string | null;
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
  const profile = resolveDeploymentProfile(env);

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    emberEnv: api.env,
    deployment: profile.deployment,
    deploymentDeclaredBy: profile.declaredBy,
    host: api.host,
    allowNonLoopbackBind: api.allowNonLoopbackBind,
    devProviderOptIn: readFlag(env, 'EMBER_DEV_PROVIDER_ENABLED'),
    isolatedEnvironmentOptIn: readFlag(env, 'EMBER_DEV_PROVIDER_ISOLATED'),
  });
}

/**
 * Boot-time refusal (R-9): a process that is not a development deployment must not start with
 * the dev provider enabled, and neither must a process that would bind a non-loopback
 * interface with it on. Call this before serving the first request.
 *
 * This is a startup error rather than a silent downgrade because the operator explicitly asked
 * for a capability that does not exist here; refusing to boot surfaces the mistake immediately
 * instead of leaving a box that looks like it has dev sign-in but answers 404.
 */
export function assertDevProviderBootConfig(config: B1AuthEnvironment): void {
  if (config.devProviderOptIn && config.deployment !== 'development') {
    throw new ApiConfigError(
      `refusing to start: EMBER_DEV_PROVIDER_ENABLED=true is not permitted in a ` +
        `${config.deployment} deployment (${config.deploymentDeclaredBy ?? 'unknown marker'})`,
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

      // Derived from the deployment classification, so `EMBER_ENV=staging` denies the path even
      // when `NODE_ENV` is unset, and `NODE_ENV=production` denies it even when `EMBER_ENV=ci`
      // claims otherwise.
      if (environment.deployment !== 'development') {
        deniedBy.push('production_environment');
      }

      if (!environment.devProviderOptIn) {
        deniedBy.push('opt_in_missing');
      }

      // Defense in depth: an "isolated environment" is a development run that *declares* an
      // isolated `EMBER_ENV` and opts in. A production or staging marker makes the run
      // non-isolated no matter what `EMBER_ENV` claims, so this condition fails on its own
      // even if the deployment classification above were somehow bypassed.
      if (
        !environment.isolatedEnvironmentOptIn ||
        environment.deployment !== 'development' ||
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
