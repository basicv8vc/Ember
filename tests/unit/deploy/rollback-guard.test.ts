/**
 * rollback.sh must clear the same fail-closed preflight guard as deploy.sh before any
 * Docker operation: a rollback with a malicious or misconfigured environment file is
 * refused exactly like a deploy, or the rollback path would be a way to start the stack
 * with a configuration the guard forbids.
 *
 * The assertions target the guard's own output (permission check + violation codes) and
 * prove the refusal happens before anything container-related runs.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnvFile } from '../../../infra/staging/scripts/preflight.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STAGING_ENV_EXAMPLE = `${REPO_ROOT}infra/staging/env/staging.env.example`;
const ROLLBACK_SH = `${REPO_ROOT}infra/staging/scripts/rollback.sh`;

interface BashResult {
  status: number;
  stdout: string;
  stderr: string;
}

function bash(script: string, env: Record<string, string> = {}): BashResult {
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * A staging environment file the guard accepts (same resolution as the unit tests),
 * optionally poisoned, with the given file mode.
 */
function stagingEnvFile(mutate?: (env: Map<string, string>) => void, mode = 0o600): string {
  const env = parseEnvFile(readFileSync(STAGING_ENV_EXAMPLE, 'utf8'));
  env.set('DATABASE_URL', `postgres://ember:${'q'.repeat(32)}@postgres:5432/ember`);
  env.set('EMBER_STAGING_HOSTNAME', 'staging.ember-cloud.net');
  env.set('EMBER_ACME_EMAIL', 'ops@ember-cloud.net');
  mutate?.(env);

  const dir = mkdtempSync(join(tmpdir(), 'ember-rollback-guard-'));
  const path = join(dir, 'staging.env');
  writeFileSync(path, `${[...env].map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  chmodSync(path, mode);
  return path;
}

function rollback(envFile: string): BashResult {
  const releaseDir = mkdtempSync(join(tmpdir(), 'ember-rollback-guard-release-'));
  return bash(`"${ROLLBACK_SH}" --env-file=${envFile} --to=git-guardtest`, {
    EMBER_RELEASE_DIR: releaseDir,
  });
}

describe('rollback.sh preflight gate', () => {
  it('accepts a well-formed environment file and proceeds past the guard', () => {
    const result = rollback(stagingEnvFile());

    expect(result.stderr).toContain('preflight passed');
    // Past the gate the run is expected to stop at the image checks (the test tag was
    // never built) — which proves the guard is the first gate, not the only one.
    expect(result.stderr).not.toContain('preflight FAILED');
  });

  it('refuses an environment file with loose permissions', () => {
    const result = rollback(stagingEnvFile(undefined, 0o644));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be mode 600 or 400');
    expect(result.stderr).not.toContain('preflight passed');
    expect(result.stderr).not.toContain('rolling back to');
  });

  it('refuses a malicious Daytona sandbox credential', () => {
    const result = rollback(
      stagingEnvFile((env) => {
        env.set('DAYTONA_API_KEY', 'dtn-evil-key-000000');
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('E_PROVIDER_SECRET');
    expect(result.stderr).toContain('preflight FAILED');
    expect(result.stderr).not.toContain('rolling back to');
  });

  it('refuses a malicious model-provider credential', () => {
    const result = rollback(
      stagingEnvFile((env) => {
        env.set('OPENAI_API_KEY', 'sk-evil-key-00000000');
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('E_PROVIDER_SECRET');
    expect(result.stderr).toContain('preflight FAILED');
    expect(result.stderr).not.toContain('rolling back to');
  });

  it('refuses legacy dev tenant tokens', () => {
    const result = rollback(
      stagingEnvFile((env) => {
        env.set('EMBER_DEV_AUTH_TENANT_A_TOKEN', 'a'.repeat(32));
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('E_DEV_TENANT_TOKEN');
    expect(result.stderr).toContain('preflight FAILED');
    expect(result.stderr).not.toContain('rolling back to');
  });

  it('refuses a production marker on a staging rollback', () => {
    const result = rollback(
      stagingEnvFile((env) => {
        env.set('NODE_ENV', 'production');
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('E_NODE_ENV');
    expect(result.stderr).toContain('preflight FAILED');
    expect(result.stderr).not.toContain('rolling back to');
  });
});
