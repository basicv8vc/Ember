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

export const GUARD_VERSION = '2';

/** Marker prefix shared by every development-only environment variable. */
const DEV_AUTH_PREFIX = 'EMBER_DEV_AUTH_TENANT_';

/**
 * Provider/secret variable fragments that must never appear in a staging environment.
 * Staging is deterministic-execution only: no model provider, no sandbox vendor
 * (`E2B` and `DAYTONA` cover the sandbox vendors — a deployment never carries a sandbox
 * credential, only the Daytona smoke harness does, and that is a CLI-side tool).
 * `MODEL_API_KEY` is listed explicitly because B2's `EMBER_MODEL_API_KEY` would otherwise
 * slip past the provider-name fragments and let a paid call be configured.
 *
 * L4-B narrows this without weakening it: exactly two variable *names* —
 * `EMBER_MODEL_API_KEY` and `EMBER_MODEL_PROVIDER` — are exempt, and only while a reviewed
 * authorization in `model-authorization.json` matches the configured provider and model id. Every
 * other provider surface (`OPENAI_API_KEY`, `ANTHROPIC_*`, `E2B_*`, `DAYTONA_*`, …) stays refused in
 * every mode, authorized or not. The exemption is a named door, not a removed wall.
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
  'DAYTONA',
  'MODEL_PROVIDER',
  'MODEL_API_KEY',
  'PROVIDER_API_KEY',
];

/** The only two variable names an authorization may exempt, and only together. */
const AUTHORIZABLE_MODEL_VARIABLES = new Set(['EMBER_MODEL_API_KEY', 'EMBER_MODEL_PROVIDER']);

/** Where the reviewed authorization lives. Fixed by module path: no environment may redirect it. */
export const MODEL_AUTHORIZATION_PATH = new URL('../model-authorization.json', import.meta.url);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const AUTHORIZATION_PLACEHOLDER = /pending|todo|tbd|replace|example|placeholder|changeme/i;
const OFFICIAL_PRICE_HOSTS = new Map([
  ['openai', new Set(['developers.openai.com', 'platform.openai.com'])],
  ['openrouter', new Set(['openrouter.ai'])],
]);

/** The authorization must cite a first-party HTTPS model/pricing page, never an aggregator. */
function isOfficialPriceSource(value, providerId) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }

  try {
    const source = new URL(value);

    const allowedHosts = OFFICIAL_PRICE_HOSTS.get(providerId);

    return (
      source.protocol === 'https:' &&
      allowedHosts?.has(source.hostname) === true &&
      source.username.length === 0 &&
      source.password.length === 0
    );
  } catch {
    return false;
  }
}

/**
 * How a paid-model deployment is bounded by its approval.
 *
 * The ceilings mirror the spend limits the Worker already enforces. They are duplicated here on purpose:
 * the guard runs on the host before Docker and cannot import TypeScript, so the approved *limits*
 * are restated in the artifact a reviewer signs. They may only lower the code defaults.
 */
const AUTHORIZATION_CEILING_KEYS = [
  'maxPerAttemptMicroUsd',
  'maxPrincipalDailyMicroUsd',
  'maxTenantDailyMicroUsd',
  'maxGlobalDailyMicroUsd',
  'maxPrincipalDailyTurns',
  'maxPaidSmokeTurns',
];
const AUTHORIZATION_CEILING_MAXIMUMS = Object.freeze({
  maxPerAttemptMicroUsd: 5_000,
  maxPrincipalDailyMicroUsd: 250_000,
  maxTenantDailyMicroUsd: 1_000_000,
  maxGlobalDailyMicroUsd: 5_000_000,
  maxPrincipalDailyTurns: 60,
  maxPaidSmokeTurns: 50,
});

/** Runtime defaults mirror apps/worker/src/config.ts when a deployment omits a budget variable. */
const MODEL_CEILING_VARIABLES = Object.freeze([
  ['EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD', 'maxPerAttemptMicroUsd', 5_000],
  ['EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD', 'maxPrincipalDailyMicroUsd', 250_000],
  ['EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD', 'maxTenantDailyMicroUsd', 1_000_000],
  ['EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD', 'maxGlobalDailyMicroUsd', 5_000_000],
  ['EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS', 'maxPrincipalDailyTurns', 60],
]);

/** Whole days from `from` to `to`, both `YYYY-MM-DD` in UTC. Negative when `to` is in the past. */
function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return Number.NEGATIVE_INFINITY;
  }

  return Math.round((end - start) / 86_400_000);
}

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

/** `YYYY-MM-DD` in UTC, matching the ledger's day boundary. */
export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Read the reviewed authorization artifact.
 *
 * Never throws: a missing, unreadable or malformed file yields `{ readable: false, entries: [] }`,
 * which refuses paid egress — the same outcome as no authorization at all. A guard that crashed on a
 * bad file would be a denial of service on the whole deployment, and a guard that defaulted to
 * "allowed" would be worse.
 */
export function loadModelAuthorizationManifest(source = MODEL_AUTHORIZATION_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(source, 'utf8'));

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.authorizations) ||
      parsed.schemaVersion !== 1
    ) {
      return Object.freeze({ readable: false, entries: Object.freeze([]), reason: 'shape' });
    }

    return Object.freeze({
      readable: true,
      entries: Object.freeze([...parsed.authorizations]),
      reason: null,
    });
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'json' : 'read';

    return Object.freeze({ readable: false, entries: Object.freeze([]), reason });
  }
}

function isPositiveInteger(value, max) {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

/**
 * Find the authorization that covers exactly this provider and model, on this day.
 *
 * Returns either `{ status: 'authorized', entry }` or `{ status: <reason> }`. The distinct reasons
 * exist so an operator can tell "nobody approved this model" from "the approval expired on Friday",
 * which is the difference between a configuration mistake and an operational stop.
 */
export function findModelAuthorization(manifest, query) {
  if (manifest === null || manifest === undefined || manifest.readable !== true) {
    return Object.freeze({ status: 'manifest_unreadable' });
  }

  const { providerId, modelId, today } = query;

  if (typeof modelId !== 'string' || modelId.trim().length === 0) {
    return Object.freeze({ status: 'model_unset' });
  }

  const candidates = manifest.entries.filter(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      entry.providerId === providerId &&
      entry.modelId === modelId,
  );

  if (candidates.length === 0) {
    return Object.freeze({ status: 'no_authorization' });
  }

  if (candidates.length > 1) {
    // Two approvals for one id is ambiguous: which ceiling applies? Refuse rather than pick.
    return Object.freeze({ status: 'duplicate_authorization' });
  }

  const entry = candidates[0];

  if (
    typeof entry.authorizationId !== 'string' ||
    typeof entry.approvedBy !== 'string' ||
    !['resident', 'smoke_only'].includes(entry.executionScope) ||
    !isOfficialPriceSource(entry.priceSource, entry.providerId) ||
    !ISO_DAY.test(entry.approvedAt ?? '') ||
    !ISO_DAY.test(entry.expiresAt ?? '') ||
    entry.authorizationId.trim().length === 0 ||
    entry.approvedBy.trim().length === 0 ||
    AUTHORIZATION_PLACEHOLDER.test(entry.authorizationId) ||
    AUTHORIZATION_PLACEHOLDER.test(entry.approvedBy)
  ) {
    return Object.freeze({ status: 'malformed_authorization' });
  }

  if (entry.expiresAt < entry.approvedAt) {
    return Object.freeze({ status: 'malformed_authorization' });
  }

  for (const key of AUTHORIZATION_CEILING_KEYS) {
    if (!isPositiveInteger(entry[key], AUTHORIZATION_CEILING_MAXIMUMS[key])) {
      return Object.freeze({ status: 'malformed_authorization' });
    }
  }

  if (today < entry.approvedAt) {
    return Object.freeze({ status: 'not_yet_valid' });
  }

  if (today > entry.expiresAt) {
    return Object.freeze({ status: 'expired' });
  }

  return Object.freeze({ status: 'authorized', entry: Object.freeze({ ...entry }) });
}

const AUTHORIZATION_FAILURE_MESSAGE = Object.freeze({
  manifest_unreadable:
    'the reviewed authorization file could not be read, so paid egress is refused; restore infra/staging/model-authorization.json',
  model_unset: 'EMBER_MODEL_ID is unset, so no authorization can match a pinned snapshot',
  no_authorization:
    'no entry in infra/staging/model-authorization.json covers this provider and model id: paid model calls need a reviewed authorization, not a deployment setting',
  duplicate_authorization:
    'more than one authorization covers this provider and model id, so which ceiling applies is ambiguous; remove the duplicate',
  malformed_authorization:
    'the matching authorization is incomplete: it needs an authorizationId, a named approvedBy, executionScope, an official HTTPS priceSource for the selected provider, ISO approvedAt/expiresAt, every spend ceiling, maxPrincipalDailyTurns and maxPaidSmokeTurns',
  not_yet_valid: 'the matching authorization does not start until a future date',
  expired:
    'the matching authorization has expired; a fresh dated approval must be merged before paid egress resumes',
});

/**
 * Evaluate a staging environment file.
 *
 * @param {Map<string, string>} env
 * @param {{
 *   mode?: 'staging' | 'local' | 'e2e',
 *   authorization?: { readable: boolean, entries: ReadonlyArray<object>, reason: string | null },
 *   now?: Date,
 * }} [options]
 *   `local` relaxes ONLY the public-hostname rules (so the same stack can be verified on a
 *   laptop with an internal CA). `e2e` is the acceptance profile for the full-lifecycle
 *   HTTP E2E: it additionally allows the test runtime markers and the deterministic Fake
 *   Model, and nothing else. Every authentication, credential and database rule stays
 *   identical in all three modes.
 *
 *   `authorization` and `now` exist so tests can pin the reviewed artifact and the day without
 *   touching the filesystem or the wall clock. Both default to the real thing, which is what the
 *   CLI and the deploy scripts use; neither is reachable from an environment file.
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

  // ---- 3. Paid model egress: refused unless a reviewed authorization covers it -----------
  //
  // L4-B keeps the refusal and installs an explicit door. `EMBER_MODEL_EXECUTION=real` is still a
  // violation in every profile unless `infra/staging/model-authorization.json` carries an unexpired
  // entry for the *exact* provider and pinned model id, and the credential variable is refused
  // unless that same entry exists. Nothing here can be satisfied by an environment file alone, and
  // nothing was deleted: every provider fragment below still refuses every other vendor surface.
  const modelExecution = (get('EMBER_MODEL_EXECUTION') ?? 'disabled').trim();
  const modelProviderId = (get('EMBER_MODEL_PROVIDER') ?? 'openai').trim();
  const modelId = (get('EMBER_MODEL_ID') ?? '').trim();
  const today = utcDay(options.now ?? new Date());

  const authorization =
    modelExecution === 'real' && mode !== 'e2e'
      ? findModelAuthorization(options.authorization ?? loadModelAuthorizationManifest(), {
          providerId: modelProviderId,
          modelId,
          today,
        })
      : Object.freeze({ status: 'not_requested' });

  for (const key of env.keys()) {
    const upper = key.toUpperCase();
    const fragment = FORBIDDEN_KEY_FRAGMENTS.find((candidate) => upper.includes(candidate));
    if (fragment === undefined) {
      continue;
    }
    if (authorization.entry !== undefined && AUTHORIZABLE_MODEL_VARIABLES.has(upper)) {
      // The one exempt pair, and only because a reviewed authorization covers exactly this
      // provider and model. Any other provider variable on the same file is still a violation.
      continue;
    }
    add(
      'E_PROVIDER_SECRET',
      key,
      `provider credential (${fragment}) is refused: staging must not be able to bill a model call or a sandbox`,
    );
  }

  // ---- 3b. B2 model execution ----------------------------------------------------------
  // `disabled` remains the staging contract. `fake` exists only in the e2e profile; a
  // shared-deployment marker must never serve simulated replies. `real` needs an authorization —
  // an approved model id, an unexpired dated decision and ceilings that only lower the defaults.
  if (modelExecution === 'real') {
    if (mode === 'e2e') {
      add(
        'E_MODEL_REAL',
        'EMBER_MODEL_EXECUTION',
        'is refused in the acceptance profile: an e2e run exercises the Fake Model and never spends money, authorized or not',
      );
    } else if (authorization.status !== 'authorized') {
      add(
        'E_MODEL_REAL',
        'EMBER_MODEL_EXECUTION',
        `is refused: ${AUTHORIZATION_FAILURE_MESSAGE[authorization.status] ?? 'no authorization covers this provider and model'}`,
      );
    } else {
      const entry = authorization.entry;
      const apiKey = get('EMBER_MODEL_API_KEY');

      if (entry.executionScope === 'smoke_only') {
        add(
          'E_MODEL_REAL',
          'EMBER_MODEL_EXECUTION',
          `authorization ${entry.authorizationId} is smoke_only and cannot enable a resident Staging Worker`,
        );
      }

      if (apiKey === undefined || apiKey.trim().length === 0) {
        add(
          'E_MODEL_CREDENTIAL',
          'EMBER_MODEL_API_KEY',
          `is required when EMBER_MODEL_EXECUTION=real under authorization ${entry.authorizationId}; provide it through the deployment secret store, never in git`,
        );
      }

      for (const [variable, ceilingKey, defaultValue] of MODEL_CEILING_VARIABLES) {
        const raw = get(variable);
        const value = raw === undefined ? defaultValue : Number(raw);
        const minValue = variable === 'EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD' ? 1 : 0;
        if (!Number.isSafeInteger(value) || value < minValue) {
          add(
            'E_MODEL_BUDGET',
            variable,
            `must be an integer >= ${minValue} (got ${describe(raw)})`,
          );
          continue;
        }
        if (value > entry[ceilingKey]) {
          add(
            'E_MODEL_BUDGET',
            variable,
            `exceeds the authorized ceiling of ${entry[ceilingKey]} for ${entry.authorizationId}; a deployment may only lower an approved limit`,
          );
        }
      }

      if (daysBetween(today, entry.expiresAt) <= 14) {
        warn(
          'W_MODEL_AUTHORIZATION_EXPIRING',
          `authorization ${entry.authorizationId} for ${entry.modelId} expires on ${entry.expiresAt}; the Worker refuses to boot real mode once it does`,
        );
      }
    }
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
      `must be "disabled" (got ${describe(modelExecution)}); "fake" is refused under staging markers and "real" is refused without an authorization`,
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
