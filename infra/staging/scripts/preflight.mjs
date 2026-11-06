#!/usr/bin/env node
/**
 * Staging environment preflight guard.
 *
 * The deployment owns one guarantee that no amount of documentation can enforce: a staging
 * API container must never be able to authenticate a caller through a development path, and
 * a staging deployment must never reach a paid model provider or a foreign database.
 *
 * The production code already fails closed on its own terms (the dev sign-in provider
 * denies NODE_ENV=staging, `/v1` rejects unconfigured tenants). This guard closes the
 * remaining gap: the legacy dev bearer tokens in `loadDevAuthConfig` are only refused under
 * NODE_ENV=production, so a staging environment file that carried them would hand out
 * tenant identities. Here that configuration is refused before a container starts.
 *
 * Deliberately dependency-free: it runs on the host before Docker, inside CI, and inside
 * the unit tests.
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const GUARD_VERSION = '1';

/** Marker prefix shared by every development-only environment variable. */
const DEV_AUTH_PREFIX = 'EMBER_DEV_AUTH_TENANT_';

/**
 * Provider/secret variable fragments that must never appear in a staging environment.
 * Staging is deterministic-execution only: no model provider, no sandbox vendor.
 * `MODEL_API_KEY` is listed explicitly because B2's `EMBER_MODEL_API_KEY` would otherwise
 * slip past the provider-name fragments and let a paid call be configured.
 */
const FORBIDDEN_KEY_FRAGMENTS = [
  'OPENAI',
  'ANTHROPIC',
  'GEMINI',
  'GOOGLE_AI',
  'GOOGLE_API_KEY',
  'OPENROUTER',
  'BEDROCK',
  'E2B',
  'MODEL_PROVIDER',
  'MODEL_API_KEY',
  'PROVIDER_API_KEY',
];

/** Hosts a staging DATABASE_URL may point at. Anything else is refused. */
const ALLOWED_DATABASE_HOSTS = new Set(['postgres', 'db', 'localhost', '127.0.0.1', '::1']);

/** Presence of these strings anywhere in the environment file is refused. */
const FORBIDDEN_VALUE_FRAGMENTS = ['shua'];

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const PLACEHOLDER_FRAGMENTS = ['example', 'placeholder', 'changeme', 'change-me', 'replace-me'];
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const LOCAL_HOSTNAMES = new Set(['localhost', 'api.localhost']);

/** Variables that mean "accept a certificate that cannot be verified". */
const TLS_BYPASS_VARIABLES = ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS_INSECURE'];

/**
 * Namespace an acceptance run is allowed to own.
 *
 * `compose.yaml` names every data volume `${EMBER_VOLUME_PREFIX}-<role>` and falls back to
 * `ember-staging`, so an E2E environment file that carried `EMBER_VOLUME_PREFIX=ember-staging`
 * would make the harness address — and clean up — the live staging volumes. The guard
 * therefore refuses every prefix outside `ember-e2e-*` in e2e mode, and the harness
 * additionally generates its own unique prefix per run instead of trusting the file.
 */
const E2E_RUN_PREFIX_PATTERN = /^ember-e2e-[a-z0-9][a-z0-9-]*$/;

/** True when `value` is a volume/project prefix an acceptance run may own. */
export function isE2eRunPrefix(value) {
  return E2E_RUN_PREFIX_PATTERN.test(value ?? '');
}

/**
 * A unique compose project name and volume prefix for one acceptance run. Generated at
 * run start and never read back from an environment file, so no run can ever point at
 * the staging or production volume set and teardown can only reach what it created.
 */
export function generateE2eRunPrefix() {
  return `ember-e2e-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Parse a dotenv-style file.
 *
 * Only `KEY=value` lines are supported. `#` starts a comment at the beginning of a line;
 * inline `#` is kept because it can legitimately be part of a password. Blank lines are
 * ignored. Quotes around a value are stripped.
 */
export function parseEnvFile(text) {
  const env = new Map();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env.set(key, value);
  }

  return env;
}

function isFalseOrAbsent(value) {
  return value === undefined || value === '' || value.toLowerCase() === 'false';
}

function describe(value) {
  return value === undefined ? '<unset>' : JSON.stringify(value);
}

/**
 * Evaluate a staging environment file.
 *
 * @param {Map<string, string>} env
 * @param {{ mode?: 'staging' | 'local' | 'e2e' }} [options]
 *   `local` relaxes ONLY the public-hostname rules (so the same stack can be verified on a
 *   laptop with an internal CA). `e2e` is the acceptance profile for the full-lifecycle
 *   HTTP E2E: it additionally allows the test runtime markers and the deterministic Fake
 *   Model, and nothing else. Every authentication, credential and database rule stays
 *   identical in all three modes.
 * @returns {{ ok: boolean, mode: string, violations: Array<{code: string, variable: string, message: string}>, warnings: Array<{code: string, message: string}> }}
 */
export function evaluateStagingEnv(env, options = {}) {
  const mode = options.mode === 'local' ? 'local' : options.mode === 'e2e' ? 'e2e' : 'staging';
  const violations = [];
  const warnings = [];

  const add = (code, variable, message) => {
    violations.push({ code, variable, message });
  };
  const warn = (code, message) => {
    warnings.push({ code, message });
  };

  const get = (key) => env.get(key);

  // ---- 1. Runtime identity -------------------------------------------------------------
  const nodeEnv = get('NODE_ENV');
  const emberEnv = get('EMBER_ENV');
  if (mode === 'e2e') {
    // The acceptance profile runs the same images with test markers so the Worker's B2
    // guard permits the deterministic Fake Model. Shared-deployment markers are still
    // refused: this mode is for the E2E harness, never for a host that serves clients.
    if (nodeEnv !== 'test') {
      add(
        'E_NODE_ENV',
        'NODE_ENV',
        `must be "test" in e2e mode (got ${describe(nodeEnv)}); staging/production markers refuse the Fake Model the E2E exercises`,
      );
    }
    if (emberEnv !== 'test') {
      add('E_EMBER_ENV', 'EMBER_ENV', `must be "test" in e2e mode (got ${describe(emberEnv)})`);
    }
  } else {
    if (nodeEnv !== 'staging') {
      add(
        'E_NODE_ENV',
        'NODE_ENV',
        `must be "staging" (got ${describe(nodeEnv)}); "production" makes the API refuse to start and unset re-opens local defaults`,
      );
    }

    if (emberEnv !== 'staging') {
      add(
        'E_EMBER_ENV',
        'EMBER_ENV',
        `must be "staging" (got ${describe(emberEnv)}); the formal shared-deployment marker — "ci" is development-class and would misclassify this deployment, re-opening development surfaces`,
      );
    }
  }

  const logLevel = get('EMBER_LOG_LEVEL');
  if (!['info', 'warn', 'error'].includes(logLevel ?? '')) {
    add(
      'E_LOG_LEVEL',
      'EMBER_LOG_LEVEL',
      `must be info, warn or error (got ${describe(logLevel)}); debug is refused in staging`,
    );
  }

  // ---- 2. No development authentication, in any form ------------------------------------
  for (const variable of ['EMBER_DEV_PROVIDER_ENABLED', 'EMBER_DEV_PROVIDER_ISOLATED']) {
    if (!isFalseOrAbsent(get(variable))) {
      add(
        'E_DEV_PROVIDER',
        variable,
        'development sign-in is refused on a publicly reachable deployment',
      );
    }
  }

  for (const key of env.keys()) {
    if (key.startsWith(DEV_AUTH_PREFIX)) {
      add(
        'E_DEV_TENANT_TOKEN',
        key,
        'legacy development bearer credentials are never valid on staging: remove the whole EMBER_DEV_AUTH_TENANT_* set',
      );
    }
  }

  if (!isFalseOrAbsent(get('EMBER_B1_FAKE_RESPONDER_ENABLED'))) {
    add(
      'E_FAKE_RESPONDER',
      'EMBER_B1_FAKE_RESPONDER_ENABLED',
      'the simulated turn responder is a local/test capability only',
    );
  }

  if (!isFalseOrAbsent(get('EMBER_SCHEDULER_ENABLED'))) {
    add(
      'E_SCHEDULER',
      'EMBER_SCHEDULER_ENABLED',
      'the autonomous scheduler stays disabled until Gate 3 review',
    );
  }

  // ---- 3. No paid model provider, no sandbox vendor -------------------------------------
  for (const key of env.keys()) {
    const upper = key.toUpperCase();
    const fragment = FORBIDDEN_KEY_FRAGMENTS.find((candidate) => upper.includes(candidate));
    if (fragment !== undefined) {
      add(
        'E_PROVIDER_SECRET',
        key,
        `provider credential (${fragment}) is refused: staging must not be able to bill a model call`,
      );
    }
  }

  // ---- 3b. B2 model execution ----------------------------------------------------------
  // `real` is refused in every mode: enabling a paid provider is a reviewed code change
  // (approval registry, invoice-verified rate, credential) and never an environment switch.
  // `fake` exists only in the e2e profile; a shared-deployment marker must never serve
  // simulated replies. `disabled` is the staging contract.
  const modelExecution = (get('EMBER_MODEL_EXECUTION') ?? 'disabled').trim();
  if (modelExecution === 'real') {
    add(
      'E_MODEL_REAL',
      'EMBER_MODEL_EXECUTION',
      'is refused in every profile: paid model calls require a reviewed approval, an invoice-verified rate and a credential, none of which a deployment may enable by itself',
    );
  } else if (mode === 'e2e') {
    if (modelExecution !== 'fake') {
      add(
        'E_MODEL_EXECUTION',
        'EMBER_MODEL_EXECUTION',
        `must be "fake" in e2e mode (got ${describe(modelExecution)}); the profile exists to exercise the deterministic Fake Model`,
      );
    }
  } else if (modelExecution !== 'disabled') {
    add(
      'E_MODEL_EXECUTION',
      'EMBER_MODEL_EXECUTION',
      `must be "disabled" (got ${describe(modelExecution)}); "fake" is refused under staging markers and "real" is refused everywhere`,
    );
  }

  // ---- 4. Database boundary -------------------------------------------------------------
  const databaseUrl = get('DATABASE_URL');
  if (databaseUrl === undefined || databaseUrl === '') {
    add('E_DATABASE_URL', 'DATABASE_URL', 'is required');
  } else {
    let parsed;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      parsed = undefined;
      add('E_DATABASE_URL', 'DATABASE_URL', 'must be a postgres:// URL');
    }

    if (parsed !== undefined) {
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        add('E_DATABASE_URL', 'DATABASE_URL', 'must use the postgres:// scheme');
      }
      if (!ALLOWED_DATABASE_HOSTS.has(parsed.hostname)) {
        add(
          'E_DATABASE_HOST',
          'DATABASE_URL',
          `host ${describe(parsed.hostname)} is not an allowed staging database host (${[...ALLOWED_DATABASE_HOSTS].join(', ')}); a staging deployment must never point at a shared or production database`,
        );
      }
      if (parsed.password === '') {
        add('E_DATABASE_PASSWORD', 'DATABASE_URL', 'must carry a password');
      }
      if (databaseUrl.includes('%')) {
        add(
          'E_DATABASE_ENCODING',
          'DATABASE_URL',
          'must not percent-encode credentials; generate a URL-safe password instead',
        );
      }
      if (parsed.hostname !== 'postgres' && mode !== 'local') {
        add(
          'E_DATABASE_HOST',
          'DATABASE_URL',
          'staging must use the compose service name "postgres" on the private network',
        );
      }
      if (parsed.searchParams.get('sslmode') === 'disable' && mode === 'staging') {
        warn(
          'W_SSLMODE_DISABLE',
          'sslmode=disable is accepted only because the database port is never published',
        );
      }
    }
  }

  // ---- 5. Listener policy ---------------------------------------------------------------
  if (get('EMBER_HOST') !== '0.0.0.0') {
    add(
      'E_API_HOST',
      'EMBER_HOST',
      `must be 0.0.0.0 so the edge proxy can reach the API inside the container (got ${describe(get('EMBER_HOST'))})`,
    );
  }
  if (get('EMBER_ALLOW_NON_LOOPBACK_BIND') !== 'true') {
    add(
      'E_NON_LOOPBACK_OPT_IN',
      'EMBER_ALLOW_NON_LOOPBACK_BIND',
      'must be true; the API refuses a non-loopback listener otherwise and the container would never start',
    );
  }
  if (mode === 'e2e' && get('EMBER_EDGE_BIND') !== '127.0.0.1') {
    // The acceptance profile must never publish a port off-host. The edge bind is the one
    // listener whose address comes from the environment, so it is pinned here and again
    // force-injected by the harness (process env overrides `--env-file` interpolation).
    add(
      'E_EDGE_BIND',
      'EMBER_EDGE_BIND',
      `must be 127.0.0.1 in e2e mode (got ${describe(get('EMBER_EDGE_BIND'))}); the acceptance stack must never be reachable off-host`,
    );
  }

  // ---- 6. Apple audience ----------------------------------------------------------------
  const bundleId = get('EMBER_APPLE_BUNDLE_ID');
  if (bundleId === undefined || bundleId === '') {
    add(
      'E_APPLE_AUDIENCE',
      'EMBER_APPLE_BUNDLE_ID',
      'is required; the API refuses to start without it',
    );
  } else {
    const lowered = bundleId.toLowerCase();
    if (
      !BUNDLE_ID_PATTERN.test(bundleId) ||
      PLACEHOLDER_FRAGMENTS.some((fragment) => lowered.includes(fragment))
    ) {
      add(
        'E_APPLE_AUDIENCE',
        'EMBER_APPLE_BUNDLE_ID',
        `must be the real iOS bundle id (got ${describe(bundleId)})`,
      );
    }
  }

  // ---- 7. Worker shape ------------------------------------------------------------------
  // The task poll lane requires the deterministic-executor opt-in, and the runtime refuses
  // that combination in shared deployments ("it stays a local/test capability until P0B-06
  // provides durable execution results", deployment classification, #126). Deployment
  // profiles therefore run `reaper-only` (lease reaping, the scheduler, and the B2 turn
  // responder when model execution is on); the acceptance profile exercises the task lane
  // legally under test markers.
  if (mode === 'e2e') {
    if (get('EMBER_WORKER_MODE') !== 'poll') {
      add(
        'E_WORKER_MODE',
        'EMBER_WORKER_MODE',
        `must be "poll" in e2e mode (got ${describe(get('EMBER_WORKER_MODE'))}); the acceptance run exercises the task lane legally under test markers`,
      );
    }
    if (get('EMBER_WORKER_SIMULATED_EXECUTION') !== 'local-only') {
      add(
        'E_WORKER_SIMULATED',
        'EMBER_WORKER_SIMULATED_EXECUTION',
        'must be "local-only" in e2e mode: poll mode is refused without the explicit deterministic-executor opt-in',
      );
    }
  } else {
    if (get('EMBER_WORKER_MODE') !== 'reaper-only') {
      add(
        'E_WORKER_MODE',
        'EMBER_WORKER_MODE',
        `must be "reaper-only" (got ${describe(get('EMBER_WORKER_MODE'))}); the runtime refuses the task poll lane's deterministic executor in shared deployments`,
      );
    }
    if (get('EMBER_WORKER_SIMULATED_EXECUTION') !== 'disabled') {
      add(
        'E_WORKER_SIMULATED',
        'EMBER_WORKER_SIMULATED_EXECUTION',
        'must be "disabled": simulated execution is a local/test capability and the runtime refuses it in shared deployments',
      );
    }
  }
  const blobRoot = get('EMBER_WORKER_BLOB_ROOT');
  if (blobRoot === undefined || !blobRoot.startsWith('/')) {
    add(
      'E_WORKER_BLOB_ROOT',
      'EMBER_WORKER_BLOB_ROOT',
      'must be an absolute path on the shared blob volume',
    );
  }
  if (get('EMBER_WORKER_ID') === undefined || get('EMBER_WORKER_ID') === '') {
    add('E_WORKER_ID', 'EMBER_WORKER_ID', 'is required');
  }
  if (blobRoot !== undefined && blobRoot.length > 0 && get('EMBER_API_BLOB_ROOT') !== blobRoot) {
    warn(
      'W_BLOB_ROOT_MISMATCH',
      'EMBER_API_BLOB_ROOT differs from EMBER_WORKER_BLOB_ROOT; artifact downloads would fail closed',
    );
  }

  // ---- 8. Public entry point -------------------------------------------------------------
  const hostname = get('EMBER_STAGING_HOSTNAME');
  if (hostname === undefined || hostname === '') {
    add('E_EDGE_HOSTNAME', 'EMBER_STAGING_HOSTNAME', 'is required for TLS');
  } else if (mode !== 'staging') {
    if (!LOCAL_HOSTNAMES.has(hostname)) {
      warn(
        'W_LOCAL_HOSTNAME',
        `local verification expects a loopback hostname such as "localhost" (got ${describe(hostname)})`,
      );
    }
  } else if (
    !HOSTNAME_PATTERN.test(hostname) ||
    PLACEHOLDER_FRAGMENTS.some((f) => hostname.includes(f))
  ) {
    add(
      'E_EDGE_HOSTNAME',
      'EMBER_STAGING_HOSTNAME',
      `must be the real public DNS name, not a placeholder (got ${describe(hostname)})`,
    );
  }

  const caddyConfig = get('EMBER_CADDY_CONFIG') ?? 'Caddyfile';
  if (mode === 'staging' && caddyConfig !== 'Caddyfile') {
    add(
      'E_EDGE_TLS_MODE',
      'EMBER_CADDY_CONFIG',
      'must be "Caddyfile" (public ACME) on staging; the internal CA variant is for local verification only',
    );
  }
  if (mode !== 'staging' && caddyConfig === 'Caddyfile') {
    warn('W_LOCAL_ACME', 'local verification normally uses EMBER_CADDY_CONFIG=Caddyfile.internal');
  }

  // ---- 9. No TLS verification bypass -----------------------------------------------------
  for (const variable of TLS_BYPASS_VARIABLES) {
    if (env.has(variable) || env.has('EMBER_' + variable)) {
      add('E_TLS_BYPASS', variable, 'must not be set: it disables certificate verification');
    }
  }

  // ---- 10. Nothing may reference the production estate -----------------------------------
  for (const [key, value] of env) {
    const lowered = value.toLowerCase();
    if (FORBIDDEN_VALUE_FRAGMENTS.some((fragment) => lowered.includes(fragment))) {
      add(
        'E_FOREIGN_ESTATE',
        key,
        'references a resource outside this staging deployment; staging must not touch the Shua production estate',
      );
    }
    if (/replace_with|changeme|change_me|placeholder/i.test(value)) {
      add(
        'E_PLACEHOLDER_VALUE',
        key,
        'still contains a template placeholder; the example file is not deployable as-is',
      );
    }
  }

  // ---- 11. Acceptance-run volume namespace (e2e only) ------------------------------------
  // An e2e run may only ever address volumes inside its own `ember-e2e-*` namespace. A
  // prefix outside that namespace — `ember-staging`, `ember-staging-e2e`, `ember-production`,
  // anything else — would make the harness point at (and tear down) volumes that belong to
  // a live deployment. The harness itself additionally generates a unique prefix per run
  // and force-injects it, so an environment file cannot select the namespace at all; this
  // rule is the fail-closed backstop for anyone composing `--env-file` by hand.
  if (mode === 'e2e') {
    const prefix = get('EMBER_VOLUME_PREFIX');
    if (!isE2eRunPrefix(prefix)) {
      add(
        'E_E2E_VOLUME_PREFIX',
        'EMBER_VOLUME_PREFIX',
        `must be an acceptance-run prefix matching "ember-e2e-*" (got ${describe(prefix)}); any other prefix would address volumes owned by a shared deployment and the run's teardown would delete them`,
      );
    }
  }

  return Object.freeze({
    ok: violations.length === 0,
    mode,
    violations: Object.freeze(violations),
    warnings: Object.freeze(warnings),
  });
}

/** Human-readable report, one line per finding. */
export function formatReport(result, envFileLabel = 'environment') {
  const lines = [`preflight guard v${GUARD_VERSION} (${result.mode}) — ${envFileLabel}`];

  if (result.violations.length === 0) {
    lines.push(`[ok] ${result.warnings.length} warning(s), no violations`);
  }
  for (const violation of result.violations) {
    lines.push(`[violation] ${violation.code} ${violation.variable}: ${violation.message}`);
  }
  for (const warning of result.warnings) {
    lines.push(`[warning] ${warning.code}: ${warning.message}`);
  }

  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const modeArg = args.find((argument) => argument.startsWith('--mode=')) ?? '--mode=staging';
  const mode = modeArg.slice('--mode='.length);
  const file = args.find((argument) => !argument.startsWith('--'));

  if (!['staging', 'local', 'e2e'].includes(mode)) {
    process.stderr.write(`unknown mode: ${mode}\n`);
    return 2;
  }

  if (file === undefined) {
    process.stderr.write('usage: preflight.mjs <env-file> [--mode=staging|local|e2e] [--json]\n');
    return 2;
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    process.stderr.write(`cannot read ${file}: ${error.message}\n`);
    return 2;
  }

  const result = evaluateStagingEnv(parseEnvFile(text), { mode });

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result, file)}\n`);
  }

  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('preflight.mjs');
if (invokedDirectly) {
  process.exitCode = main(process.argv);
}
