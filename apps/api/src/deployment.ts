/**
 * Deployment classification (staging / production runtime support).
 *
 * Before this module existed the API could only declare `EMBER_ENV=local|test|ci`, so a shared
 * deployment had to lie and present itself as `ci`. That lie leaked into every guard that keyed
 * off the environment, and the development surfaces (dev tenant bearer tokens, `provider: "dev"`
 * sign-in) were only switched off by the *deployment tooling* rather than by the process itself.
 *
 * The rule implemented here is deliberately monotone: a run is a development run only when no
 * environment marker says otherwise. Two markers are consulted, `EMBER_ENV` (Ember's own, the
 * authoritative one) and `NODE_ENV` (the outer runtime's). The more restrictive of the two wins,
 * so `EMBER_ENV=local` cannot downgrade a `NODE_ENV=production` container, and `NODE_ENV=test`
 * cannot downgrade an `EMBER_ENV=staging` one.
 *
 * Two fail-closed details matter:
 *
 * - an unrecognised `NODE_ENV` (for example `NODE_ENV=qa`, or a mis-cased value that survives
 *   lowercasing nowhere in the known list) is classified as `production`, never as development.
 *   A marker the code does not understand must not be able to grant a development surface;
 * - an unrecognised `EMBER_ENV` is classified the same way. `loadApiConfig` rejects such a value
 *   outright, so this only matters for callers that classify without validating.
 *
 * Nothing here reads a flag. There is no variable that turns a development surface back on once
 * the classification says otherwise: the dev-auth and dev-provider gates consume
 * `developmentSurfacesAllowed` and only that.
 */

/** Environment bag accepted by every loader in this package (tests pass plain objects). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** How a process is deployed. Only `development` may expose a local-development surface. */
export type DeploymentClass = 'development' | 'staging' | 'production';

export interface DeploymentProfile {
  readonly deployment: DeploymentClass;
  /** Raw `NODE_ENV`, for operator diagnostics only. Never used as a decision by itself. */
  readonly nodeEnv: string | null;
  /**
   * The single marker that forced a non-development classification, written as `NAME=value`.
   * Exactly `null` when `deployment === 'development'`, so an error message can always name the
   * cause without repeating the whole environment.
   */
  readonly declaredBy: string | null;
  /** True only for a development run. Every development surface is gated on this field. */
  readonly developmentSurfacesAllowed: boolean;
}

interface Classification {
  readonly deployment: DeploymentClass;
  readonly declaredBy: string | null;
}

const SEVERITY: Readonly<Record<DeploymentClass, number>> = Object.freeze({
  development: 0,
  staging: 1,
  production: 2,
});

/**
 * `EMBER_ENV` values and their class.
 *
 * This table must cover `EMBER_ENVS` from `env.ts` exactly; a unit test asserts that so adding an
 * environment to the schema without classifying it here cannot silently pass review.
 */
export const EMBER_ENV_DEPLOYMENT: Readonly<Record<string, DeploymentClass>> = Object.freeze({
  local: 'development',
  test: 'development',
  ci: 'development',
  staging: 'staging',
  production: 'production',
});

/**
 * `NODE_ENV` values that are unambiguously a developer or CI run.
 *
 * `staging` and `production` are handled before this set is consulted; any other non-empty value
 * falls through to `production`, which is the fail-closed branch.
 */
const DEVELOPMENT_NODE_ENVS: ReadonlySet<string> = new Set([
  'development',
  'dev',
  'test',
  'local',
  'ci',
]);

/**
 * Markers are echoed into an error message and a log field, so only a short opaque token is
 * reproduced verbatim. Anything else is replaced rather than quoted.
 */
const SAFE_MARKER_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

function describeMarker(name: string, raw: string): string {
  return SAFE_MARKER_PATTERN.test(raw) ? `${name}=${raw}` : `${name}=<unrecognised>`;
}

function development(): Classification {
  return { deployment: 'development', declaredBy: null };
}

function classifyNodeEnv(raw: string | undefined): Classification {
  const trimmed = raw?.trim();

  if (trimmed === undefined || trimmed === '') {
    // Unset is not a signal either way: `EMBER_ENV` remains authoritative.
    return development();
  }

  const value = trimmed.toLowerCase();

  if (value === 'production') {
    return { deployment: 'production', declaredBy: 'NODE_ENV=production' };
  }

  if (value === 'staging') {
    return { deployment: 'staging', declaredBy: 'NODE_ENV=staging' };
  }

  if (DEVELOPMENT_NODE_ENVS.has(value)) {
    return development();
  }

  // Unknown marker: assume the strictest class rather than granting a development surface.
  return { deployment: 'production', declaredBy: describeMarker('NODE_ENV', trimmed) };
}

function classifyEmberEnv(raw: string | undefined): Classification {
  if (raw === undefined) {
    // Matches the schema default; `loadApiConfig` has already rejected every other shape.
    return development();
  }

  const deployment = EMBER_ENV_DEPLOYMENT[raw];

  if (deployment === undefined) {
    // Not trimmed on purpose: `loadApiConfig` compares this value exactly, and a padded or
    // mis-cased marker must not be read as the value it resembles.
    return { deployment: 'production', declaredBy: describeMarker('EMBER_ENV', raw) };
  }

  return deployment === 'development'
    ? development()
    : { deployment, declaredBy: `EMBER_ENV=${raw}` };
}

/**
 * Classify one environment bag.
 *
 * Deterministic, side-effect free and free of `process.env`: every caller passes the bag it is
 * about to use, so classification can never disagree with the values the process actually runs
 * with.
 */
export function resolveDeploymentProfile(env: EnvSource): DeploymentProfile {
  const node = classifyNodeEnv(env.NODE_ENV);
  const ember = classifyEmberEnv(env.EMBER_ENV);

  // `>=` keeps `NODE_ENV` as the reported cause on a tie: it is the marker an operator sets on
  // the container, so naming it is the most useful hint.
  const winner = SEVERITY[node.deployment] >= SEVERITY[ember.deployment] ? node : ember;

  return Object.freeze({
    deployment: winner.deployment,
    nodeEnv: env.NODE_ENV ?? null,
    declaredBy: winner.declaredBy,
    developmentSurfacesAllowed: winner.deployment === 'development',
  });
}
