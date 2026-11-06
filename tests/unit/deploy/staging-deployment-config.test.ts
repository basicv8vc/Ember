import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateStagingEnv,
  generateE2eRunPrefix,
  isE2eRunPrefix,
  parseEnvFile,
  type GuardResult,
} from '../../../infra/staging/scripts/preflight.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STAGING_ENV_EXAMPLE = `${REPO_ROOT}infra/staging/env/staging.env.example`;
const LOCAL_ENV_EXAMPLE = `${REPO_ROOT}infra/staging/env/local-verify.env.example`;
const E2E_ENV_EXAMPLE = `${REPO_ROOT}infra/staging/env/local-e2e.env.example`;
const COMPOSE_FILE = `${REPO_ROOT}infra/staging/compose.yaml`;
const DOCKERFILE = `${REPO_ROOT}infra/staging/docker/Dockerfile`;
const CADDYFILE = `${REPO_ROOT}infra/staging/caddy/Caddyfile`;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function envFrom(path: string): Map<string, string> {
  return parseEnvFile(read(path));
}

/** A staging environment with every template placeholder replaced by a realistic value. */
function resolvedStagingEnv(): Map<string, string> {
  const env = envFrom(STAGING_ENV_EXAMPLE);
  env.set('DATABASE_URL', `postgres://ember:${'q'.repeat(32)}@postgres:5432/ember`);
  env.set('EMBER_STAGING_HOSTNAME', 'staging.ember-cloud.net');
  env.set('EMBER_ACME_EMAIL', 'ops@ember-cloud.net');
  return env;
}

function codes(result: GuardResult): string[] {
  return result.violations.map((violation) => violation.code);
}

/**
 * Extract one top-level service block from the compose file. Compose keys are two-space
 * indented; a block ends at the next two-space key.
 */
function composeSection(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, `service ${name} must exist in compose.yaml`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('staging preflight guard', () => {
  it('accepts a fully resolved staging environment', () => {
    const result = evaluateStagingEnv(resolvedStagingEnv());

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('staging');
  });

  it('refuses the shipped template until its placeholders are replaced', () => {
    const result = evaluateStagingEnv(envFrom(STAGING_ENV_EXAMPLE));

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('E_PLACEHOLDER_VALUE');
    expect(codes(result)).toContain('E_EDGE_HOSTNAME');
  });

  it('accepts the local verification profile in local mode', () => {
    const env = envFrom(LOCAL_ENV_EXAMPLE);
    env.set('DATABASE_URL', `postgres://ember:${'q'.repeat(32)}@postgres:5432/ember`);

    expect(evaluateStagingEnv(env, { mode: 'local' }).violations).toEqual([]);
  });

  it('requires the same formal staging marker in local mode', () => {
    // The local profile verifies the staging configuration, so it must carry the formal
    // shared-deployment marker too. `ci` is development-class and misclassifies a run
    // that serves (or would serve) real clients.
    const env = envFrom(LOCAL_ENV_EXAMPLE);
    env.set('DATABASE_URL', `postgres://ember:${'q'.repeat(32)}@postgres:5432/ember`);
    env.set('EMBER_ENV', 'ci');

    expect(codes(evaluateStagingEnv(env, { mode: 'local' }))).toContain('E_EMBER_ENV');
  });

  it('refuses the local profile as if it were staging', () => {
    // The relaxed mode must only relax hostnames. Everything that makes the deployment
    // dangerous is still refused when the same file is evaluated for real staging.
    const env = envFrom(LOCAL_ENV_EXAMPLE);
    env.set('DATABASE_URL', `postgres://ember:${'q'.repeat(32)}@postgres:5432/ember`);

    expect(codes(evaluateStagingEnv(env))).toContain('E_EDGE_HOSTNAME');
  });

  it.each([
    ['EMBER_DEV_PROVIDER_ENABLED', 'true', 'E_DEV_PROVIDER'],
    ['EMBER_DEV_PROVIDER_ISOLATED', 'true', 'E_DEV_PROVIDER'],
    ['EMBER_B1_FAKE_RESPONDER_ENABLED', 'true', 'E_FAKE_RESPONDER'],
    ['EMBER_SCHEDULER_ENABLED', 'true', 'E_SCHEDULER'],
    ['NODE_ENV', 'production', 'E_NODE_ENV'],
    ['NODE_ENV', 'development', 'E_NODE_ENV'],
    ['EMBER_ENV', 'production', 'E_EMBER_ENV'],
    ['EMBER_ENV', 'ci', 'E_EMBER_ENV'],
    ['EMBER_ENV', 'test', 'E_EMBER_ENV'],
    ['EMBER_ENV', 'local', 'E_EMBER_ENV'],
    ['EMBER_LOG_LEVEL', 'debug', 'E_LOG_LEVEL'],
    ['EMBER_HOST', '127.0.0.1', 'E_API_HOST'],
    ['EMBER_ALLOW_NON_LOOPBACK_BIND', 'false', 'E_NON_LOOPBACK_OPT_IN'],
    ['EMBER_APPLE_BUNDLE_ID', 'com.example.app', 'E_APPLE_AUDIENCE'],
    ['EMBER_WORKER_MODE', 'poll', 'E_WORKER_MODE'],
    ['EMBER_WORKER_SIMULATED_EXECUTION', 'local-only', 'E_WORKER_SIMULATED'],
    ['EMBER_WORKER_BLOB_ROOT', 'relative/blobs', 'E_WORKER_BLOB_ROOT'],
    ['EMBER_CADDY_CONFIG', 'Caddyfile.internal', 'E_EDGE_TLS_MODE'],
    ['EMBER_MODEL_EXECUTION', 'real', 'E_MODEL_REAL'],
    ['EMBER_MODEL_EXECUTION', 'fake', 'E_MODEL_EXECUTION'],
    ['EMBER_MODEL_API_KEY', 'sk-not-a-real-key', 'E_PROVIDER_SECRET'],
    ['DAYTONA_API_KEY', 'dtn-not-a-real-key', 'E_PROVIDER_SECRET'],
  ])('refuses %s=%s', (variable, value, expectedCode) => {
    const env = resolvedStagingEnv();
    env.set(variable, value);

    expect(codes(evaluateStagingEnv(env))).toContain(expectedCode);
  });

  it('refuses every legacy dev tenant credential variable', () => {
    const env = resolvedStagingEnv();
    env.set('EMBER_DEV_AUTH_TENANT_A_TOKEN', `${'a'.repeat(32)}`);
    env.set('EMBER_DEV_AUTH_TENANT_A_TENANT_ID', '11111111-1111-1111-1111-111111111111');

    const result = evaluateStagingEnv(env);

    expect(codes(result).filter((code) => code === 'E_DEV_TENANT_TOKEN')).toHaveLength(2);
  });

  it('keeps the dev-token refusal in local mode as well', () => {
    const env = envFrom(LOCAL_ENV_EXAMPLE);
    env.set('DATABASE_URL', `postgres://ember:${'q'.repeat(32)}@postgres:5432/ember`);
    env.set('EMBER_DEV_AUTH_TENANT_A_TOKEN', `${'a'.repeat(32)}`);

    expect(codes(evaluateStagingEnv(env, { mode: 'local' }))).toContain('E_DEV_TENANT_TOKEN');
  });

  it('refuses provider credentials so staging can never bill a model call or a sandbox', () => {
    const env = resolvedStagingEnv();
    env.set('OPENAI_API_KEY', 'sk-not-a-real-key');
    env.set('E2B_API_KEY', 'e2b-not-a-real-key');
    env.set('DAYTONA_API_KEY', 'dtn-not-a-real-key');

    const result = evaluateStagingEnv(env);

    expect(codes(result).filter((code) => code === 'E_PROVIDER_SECRET')).toHaveLength(3);
  });

  it('refuses Daytona sandbox-vendor variables in every mode', () => {
    // A deployment must never carry a sandbox credential — the compose `env_file` would
    // hand it straight to the container. A malicious or misconfigured file with
    // DAYTONA_API_KEY (or any DAYTONA_* vendor surface) must fail the guard in every mode,
    // including e2e: the acceptance run never talks to a sandbox vendor.
    for (const mode of ['staging', 'local', 'e2e'] as const) {
      for (const variable of ['DAYTONA_API_KEY', 'DAYTONA_API_URL']) {
        const env = resolvedStagingEnv();
        env.set(
          variable,
          variable === 'DAYTONA_API_KEY' ? 'dtn-not-a-real-key' : 'https://api.daytona.io',
        );

        const result = evaluateStagingEnv(env, { mode });

        expect(
          codes(result).filter((code) => code === 'E_PROVIDER_SECRET'),
          `${variable} must be refused in ${mode} mode`,
        ).toHaveLength(1);
      }
    }
  });

  it('refuses a database that is not the private compose service', () => {
    const env = resolvedStagingEnv();
    env.set('DATABASE_URL', `postgres://ember:${'q'.repeat(32)}@db.prod.internal:5432/ember`);

    expect(codes(evaluateStagingEnv(env))).toContain('E_DATABASE_HOST');
  });

  it('refuses any reference to the Shua production estate', () => {
    const env = resolvedStagingEnv();
    env.set('DATABASE_URL', `postgres://ember:${'q'.repeat(32)}@postgres:5432/shua_prod`);

    expect(codes(evaluateStagingEnv(env))).toContain('E_FOREIGN_ESTATE');
  });

  it('refuses percent-encoded credentials that would silently change the URL', () => {
    const env = resolvedStagingEnv();
    env.set('DATABASE_URL', 'postgres://ember:a%40b%3A%2F@postgres:5432/ember');

    expect(codes(evaluateStagingEnv(env))).toContain('E_DATABASE_ENCODING');
  });

  it('refuses a TLS verification bypass', () => {
    const env = resolvedStagingEnv();
    env.set('NODE_TLS_REJECT_UNAUTHORIZED', '0');

    expect(codes(evaluateStagingEnv(env))).toContain('E_TLS_BYPASS');
  });

  it('reports a mismatched artifact blob root as a warning, not a violation', () => {
    const env = resolvedStagingEnv();
    env.set('EMBER_API_BLOB_ROOT', '/tmp/elsewhere');

    const result = evaluateStagingEnv(env);

    expect(result.ok).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain('W_BLOB_ROOT_MISMATCH');
  });
});

describe('e2e acceptance profile guard', () => {
  /** The e2e template with its throwaway password replaced. */
  function resolvedE2eEnv(): Map<string, string> {
    const env = envFrom(E2E_ENV_EXAMPLE);
    env.set('DATABASE_URL', `postgres://ember:${'q'.repeat(32)}@postgres:5432/ember`);
    return env;
  }

  it('accepts the shipped e2e profile in e2e mode', () => {
    const result = evaluateStagingEnv(resolvedE2eEnv(), { mode: 'e2e' });

    expect(result.violations).toEqual([]);
    expect(result.mode).toBe('e2e');
  });

  it('keeps every authentication refusal in e2e mode', () => {
    // The e2e profile relaxes runtime identity and the Fake Model, nothing else. A
    // development credential in this file must still be refused before anything starts.
    const env = resolvedE2eEnv();
    env.set('EMBER_DEV_PROVIDER_ENABLED', 'true');
    env.set('EMBER_DEV_AUTH_TENANT_A_TOKEN', `${'a'.repeat(32)}`);
    env.set('EMBER_MODEL_API_KEY', 'sk-not-a-real-key');

    const found = evaluateStagingEnv(env, { mode: 'e2e' }).violations.map((v) => v.code);

    expect(found).toContain('E_DEV_PROVIDER');
    expect(found).toContain('E_DEV_TENANT_TOKEN');
    expect(found).toContain('E_PROVIDER_SECRET');
  });

  it('refuses shared-deployment markers in e2e mode', () => {
    for (const [variable, value] of [
      ['NODE_ENV', 'staging'],
      ['NODE_ENV', 'production'],
      ['EMBER_ENV', 'ci'],
    ] as const) {
      const env = resolvedE2eEnv();
      env.set(variable, value);
      expect(codes(evaluateStagingEnv(env, { mode: 'e2e' })), `${variable}=${value}`).toContain(
        variable === 'NODE_ENV' ? 'E_NODE_ENV' : 'E_EMBER_ENV',
      );
    }
  });

  it('refuses anything but the Fake Model in e2e mode', () => {
    for (const value of ['real', 'disabled', 'nonsense']) {
      const env = resolvedE2eEnv();
      env.set('EMBER_MODEL_EXECUTION', value);
      expect(codes(evaluateStagingEnv(env, { mode: 'e2e' })), value).toContain(
        value === 'real' ? 'E_MODEL_REAL' : 'E_MODEL_EXECUTION',
      );
    }
  });

  it('refuses the e2e profile when evaluated as staging', () => {
    // The Fake Model must be unreachable from any mode that could describe a deployment.
    const env = envFrom(E2E_ENV_EXAMPLE);
    env.set('DATABASE_URL', `postgres://ember:${'q'.repeat(32)}@postgres:5432/ember`);
    env.set('EMBER_STAGING_HOSTNAME', 'staging.ember-cloud.net');
    env.set('EMBER_ACME_EMAIL', 'ops@ember-cloud.net');

    const refused = codes(evaluateStagingEnv(env, { mode: 'staging' }));

    expect(refused).toContain('E_MODEL_EXECUTION');
    expect(refused).toContain('E_NODE_ENV');
    expect(refused).toContain('E_EMBER_ENV');
  });

  it('refuses a volume prefix that addresses a shared deployment', () => {
    // The P0 scenario: an environment file carrying the staging/production volume
    // prefix would make a harness `down --volumes` delete live data volumes. In e2e
    // mode only the ember-e2e-* acceptance namespace is ever addressable.
    for (const value of [
      'ember-staging',
      'ember-staging-e2e',
      'ember-production',
      'ember-staging-pgdata',
      'Ember-Staging',
      'ember-e2e-UPPER',
      'ember-e2e-',
      'ember-e2e',
      'e2e',
      'default',
      '',
      '  ember-e2e-x  ',
      'ember-e2e-x;down',
      'ember-e2e-x/../ember-staging',
    ]) {
      const env = resolvedE2eEnv();
      env.set('EMBER_VOLUME_PREFIX', value);
      expect(
        codes(evaluateStagingEnv(env, { mode: 'e2e' })),
        `prefix=${JSON.stringify(value)}`,
      ).toContain('E_E2E_VOLUME_PREFIX');
    }
  });

  it('refuses an e2e environment with no volume prefix at all', () => {
    // compose.yaml falls back to `ember-staging` when the variable is absent — the
    // worst possible default for an acceptance run, so the guard demands an explicit
    // acceptance-namespace prefix.
    const env = resolvedE2eEnv();
    env.delete('EMBER_VOLUME_PREFIX');

    expect(codes(evaluateStagingEnv(env, { mode: 'e2e' }))).toContain('E_E2E_VOLUME_PREFIX');
  });

  it('accepts only ember-e2e-* run prefixes', () => {
    expect(isE2eRunPrefix('ember-e2e-1')).toBe(true);
    expect(isE2eRunPrefix('ember-e2e-mabc123f')).toBe(true);
    expect(isE2eRunPrefix('ember-e2e-placeholder')).toBe(true);
    expect(isE2eRunPrefix('ember-staging')).toBe(false);
    expect(isE2eRunPrefix('ember-staging-e2e')).toBe(false);
    expect(isE2eRunPrefix('ember-production')).toBe(false);
    expect(isE2eRunPrefix(undefined)).toBe(false);
    expect(isE2eRunPrefix('')).toBe(false);
    expect(isE2eRunPrefix('ember-e2e-')).toBe(false);
  });

  it('generates a unique acceptance-run prefix per call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      const prefix = generateE2eRunPrefix();
      expect(isE2eRunPrefix(prefix), prefix).toBe(true);
      seen.add(prefix);
    }
    expect(seen.size).toBe(64);
  });

  it('ignores the volume namespace in every deployment mode except e2e', () => {
    // The prefix rule is e2e-scoped: staging/local compose defaults (`ember-staging`)
    // are legitimate there and must not start failing.
    const env = resolvedStagingEnv();
    expect(codes(evaluateStagingEnv(env))).not.toContain('E_E2E_VOLUME_PREFIX');
  });
});

describe('staging compose topology', () => {
  const compose = read(COMPOSE_FILE);

  it('never publishes the database port', () => {
    expect(composeSection(compose, 'postgres')).not.toMatch(/^\s+ports:/m);
  });

  it('keeps PostgreSQL on an internal-only network', () => {
    expect(compose).toMatch(/db:\n\s+driver: bridge\n\s+internal: true/);
  });

  it('takes the database password from a mounted secret, not the environment', () => {
    const postgres = composeSection(compose, 'postgres');

    expect(postgres).toContain('POSTGRES_PASSWORD_FILE');
    expect(postgres).not.toMatch(/POSTGRES_PASSWORD:\s*\S/);
    expect(compose).toMatch(/secrets:\n\s+postgres_password:/);
  });

  it('publishes the API only on loopback', () => {
    const api = composeSection(compose, 'api');

    expect(api).toMatch(/'127\.0\.0\.1:\$\{EMBER_API_HOST_PORT:-8787\}:8787'/);
  });

  it('keeps the migration job out of the default `up`', () => {
    const migrate = composeSection(compose, 'migrate');

    expect(migrate).toMatch(/profiles: \['tools'\]/);
  });

  it('runs the application containers read-only with all capabilities dropped', () => {
    // `no-new-privileges` is factored into the shared `x-hardening` anchor; both application
    // services must inherit it rather than restate it.
    const hardening = compose.slice(compose.indexOf('x-hardening: &hardening'));
    expect(hardening.slice(0, 200)).toContain('no-new-privileges:true');

    for (const service of ['api', 'worker']) {
      const block = composeSection(compose, service);
      expect(block, service).toContain('read_only: true');
      expect(block, service).toMatch(/cap_drop:\n\s+- ALL/);
      expect(block, service).toMatch(/<<: \*hardening/);
    }
  });

  it('pins every image to an exact version, never a floating tag', () => {
    expect(compose).not.toMatch(/:latest\b/);
    expect(compose).toContain('postgres:17.6-alpine');
    expect(compose).toContain('caddy:2.10.2-alpine');
  });

  it('bounds container log retention', () => {
    expect(compose).toMatch(/max-size: '10m'/);
    expect(compose).toMatch(/max-file: '5'/);
  });

  it('keeps stable default volume names with an opt-in prefix for side runs', () => {
    expect(compose).toContain('name: ${EMBER_VOLUME_PREFIX:-ember-staging}-pgdata');
    expect(compose).toContain('name: ${EMBER_VOLUME_PREFIX:-ember-staging}-caddy-data');
  });
});

describe('staging image build', () => {
  const dockerfile = read(DOCKERFILE);

  it('pins the Node and pnpm versions as build arguments', () => {
    expect(dockerfile).toMatch(/ARG NODE_IMAGE=node:24\.\d+\.\d+-bookworm-slim/);
    expect(dockerfile).toMatch(/ARG PNPM_VERSION=\d+\.\d+\.\d+/);
  });

  it('installs strictly from the lockfile', () => {
    expect(dockerfile).toContain('pnpm install --frozen-lockfile');
  });

  it('runs both images as an unprivileged user', () => {
    expect(dockerfile.match(/^USER 10001:10001$/gm)).toHaveLength(2);
    expect(dockerfile).not.toMatch(/^USER root$/m);
  });

  it('does not bake NODE_ENV=production into the image', () => {
    // The API refuses to start with NODE_ENV=production while development credentials share
    // the composition root (docs/CLOUD-STAGING-SECURITY.md R-1). Baking it here would make
    // every container crash-loop.
    expect(dockerfile).not.toMatch(/ENV[^\n]*NODE_ENV=production/);
  });

  it('verifies the compiled entry points exist before the image is tagged', () => {
    expect(dockerfile).toContain('apps/api/dist/index.js');
    expect(dockerfile).toContain('apps/worker/dist/index.js');
    expect(dockerfile).toContain('packages/model-gateway/dist/index.js');
    expect(dockerfile).toContain('packages/postgres/dist/cli/migrate.js');
  });

  it('resolves the model-gateway workspace manifest in the frozen install', () => {
    // A frozen lockfile install compares the whole importer set: a missing manifest fails
    // the build, and a missing package leaves the Worker without its B2 runtime.
    expect(dockerfile).toContain(
      'COPY packages/model-gateway/package.json packages/model-gateway/package.json',
    );
  });
});

describe('staging edge configuration', () => {
  const caddyfile = read(CADDYFILE);

  it('disables the admin API', () => {
    expect(caddyfile).toMatch(/admin off/);
  });

  it('sends HSTS and hides the proxy identity', () => {
    expect(caddyfile).toContain('Strict-Transport-Security');
    expect(caddyfile).toMatch(/-Server/);
  });

  it('does not buffer streaming responses', () => {
    expect(caddyfile).toContain('flush_interval -1');
  });

  it('bounds request bodies at the edge', () => {
    expect(caddyfile).toMatch(/max_size 2MB/);
  });
});

describe('staging environment templates', () => {
  it('ship with every development capability switched off', () => {
    for (const file of [STAGING_ENV_EXAMPLE, LOCAL_ENV_EXAMPLE, E2E_ENV_EXAMPLE]) {
      const env = envFrom(file);

      expect(env.get('EMBER_DEV_PROVIDER_ENABLED'), file).toBe('false');
      expect(env.get('EMBER_DEV_PROVIDER_ISOLATED'), file).toBe('false');
      expect(env.get('EMBER_B1_FAKE_RESPONDER_ENABLED'), file).toBe('false');
      expect(env.get('EMBER_SCHEDULER_ENABLED'), file).toBe('false');
      expect([...env.keys()].filter((key) => key.startsWith('EMBER_DEV_AUTH_TENANT_'))).toEqual([]);
    }
  });

  it('contain no model-provider or sandbox credentials', () => {
    for (const file of [STAGING_ENV_EXAMPLE, LOCAL_ENV_EXAMPLE, E2E_ENV_EXAMPLE]) {
      const env = envFrom(file);

      for (const key of env.keys()) {
        expect(key, `${file}: ${key}`).not.toMatch(
          /OPENAI|ANTHROPIC|GEMINI|E2B|DAYTONA|BEDROCK|MODEL_API_KEY/i,
        );
      }
    }
  });

  it('pin model execution off for deployments and to the Fake Model for e2e', () => {
    // Real inference is a reviewed code change, never an environment switch. The e2e
    // profile is the one place the deterministic adapter is allowed, and it is labelled
    // simulated in every reply it publishes.
    expect(envFrom(STAGING_ENV_EXAMPLE).get('EMBER_MODEL_EXECUTION')).toBe('disabled');
    expect(envFrom(LOCAL_ENV_EXAMPLE).get('EMBER_MODEL_EXECUTION')).toBe('disabled');
    expect(envFrom(E2E_ENV_EXAMPLE).get('EMBER_MODEL_EXECUTION')).toBe('fake');
    expect(envFrom(E2E_ENV_EXAMPLE).get('NODE_ENV')).toBe('test');
  });

  it('ship with the formal staging marker on every shared-deployment profile', () => {
    // `EMBER_ENV=ci` was the historical workaround while the runtime enum lacked `staging`.
    // The runtime classifies development surfaces off this marker, so a shared deployment
    // must declare `staging` truthfully — both templates, no exceptions.
    expect(envFrom(STAGING_ENV_EXAMPLE).get('EMBER_ENV')).toBe('staging');
    expect(envFrom(LOCAL_ENV_EXAMPLE).get('EMBER_ENV')).toBe('staging');
    expect(envFrom(E2E_ENV_EXAMPLE).get('EMBER_ENV')).toBe('test');
  });

  it('never disable TLS verification', () => {
    for (const file of [STAGING_ENV_EXAMPLE, LOCAL_ENV_EXAMPLE, E2E_ENV_EXAMPLE]) {
      expect(envFrom(file).has('NODE_TLS_REJECT_UNAUTHORIZED'), file).toBe(false);
    }
  });
});
