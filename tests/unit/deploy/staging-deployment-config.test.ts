import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateStagingEnv,
  parseEnvFile,
  type GuardResult,
} from '../../../infra/staging/scripts/preflight.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STAGING_ENV_EXAMPLE = `${REPO_ROOT}infra/staging/env/staging.env.example`;
const LOCAL_ENV_EXAMPLE = `${REPO_ROOT}infra/staging/env/local-verify.env.example`;
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
    ['EMBER_LOG_LEVEL', 'debug', 'E_LOG_LEVEL'],
    ['EMBER_HOST', '127.0.0.1', 'E_API_HOST'],
    ['EMBER_ALLOW_NON_LOOPBACK_BIND', 'false', 'E_NON_LOOPBACK_OPT_IN'],
    ['EMBER_APPLE_BUNDLE_ID', 'com.example.app', 'E_APPLE_AUDIENCE'],
    ['EMBER_WORKER_MODE', 'reaper-only', 'E_WORKER_MODE'],
    ['EMBER_WORKER_SIMULATED_EXECUTION', 'disabled', 'E_WORKER_SIMULATED'],
    ['EMBER_WORKER_BLOB_ROOT', 'relative/blobs', 'E_WORKER_BLOB_ROOT'],
    ['EMBER_CADDY_CONFIG', 'Caddyfile.internal', 'E_EDGE_TLS_MODE'],
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

  it('refuses provider credentials so staging can never bill a model call', () => {
    const env = resolvedStagingEnv();
    env.set('OPENAI_API_KEY', 'sk-not-a-real-key');
    env.set('E2B_API_KEY', 'e2b-not-a-real-key');

    const result = evaluateStagingEnv(env);

    expect(codes(result).filter((code) => code === 'E_PROVIDER_SECRET')).toHaveLength(2);
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
    expect(dockerfile).toContain('packages/postgres/dist/cli/migrate.js');
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
    for (const file of [STAGING_ENV_EXAMPLE, LOCAL_ENV_EXAMPLE]) {
      const env = envFrom(file);

      expect(env.get('EMBER_DEV_PROVIDER_ENABLED'), file).toBe('false');
      expect(env.get('EMBER_DEV_PROVIDER_ISOLATED'), file).toBe('false');
      expect(env.get('EMBER_B1_FAKE_RESPONDER_ENABLED'), file).toBe('false');
      expect(env.get('EMBER_SCHEDULER_ENABLED'), file).toBe('false');
      expect([...env.keys()].filter((key) => key.startsWith('EMBER_DEV_AUTH_TENANT_'))).toEqual([]);
    }
  });

  it('contain no model-provider or sandbox credentials', () => {
    for (const file of [STAGING_ENV_EXAMPLE, LOCAL_ENV_EXAMPLE]) {
      const env = envFrom(file);

      for (const key of env.keys()) {
        expect(key, `${file}: ${key}`).not.toMatch(/OPENAI|ANTHROPIC|GEMINI|E2B|BEDROCK/i);
      }
    }
  });

  it('never disable TLS verification', () => {
    for (const file of [STAGING_ENV_EXAMPLE, LOCAL_ENV_EXAMPLE]) {
      expect(envFrom(file).has('NODE_TLS_REJECT_UNAUTHORIZED'), file).toBe(false);
    }
  });
});
