import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPROVED_REAL_MODELS,
  MODEL_RATE_ROWS,
  PENDING_MODEL_CANDIDATES,
} from '@ember/model-gateway';
import {
  evaluateStagingEnv,
  findModelAuthorization,
  loadModelAuthorizationManifest,
  parseEnvFile,
  utcDay,
  type GuardResult,
  type ModelAuthorizationEntry,
  type ModelAuthorizationManifest,
} from '../../../infra/staging/scripts/preflight.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STAGING_ENV_EXAMPLE = `${REPO_ROOT}infra/staging/env/staging.env.example`;
const COMPOSE_FILE = `${REPO_ROOT}infra/staging/compose.yaml`;
const MANIFEST_FILE = `${REPO_ROOT}infra/staging/model-authorization.json`;

/** The day the review document is written, so an "expired" case does not depend on the CI clock. */
const TODAY = new Date('2026-11-07T09:00:00Z');

const MODEL_ID = 'gpt-5-mini-2025-08-07';
const AUTHORIZED_KEY = 'sk-live-AbCdEf0123456789AbCdEf0123456789';

function stagingEnv(): Map<string, string> {
  const env = parseEnvFile(readFileSync(STAGING_ENV_EXAMPLE, 'utf8'));
  env.set('DATABASE_URL', `postgres://ember:${'q'.repeat(32)}@postgres:5432/ember`);
  env.set('EMBER_STAGING_HOSTNAME', 'staging.ember-cloud.net');
  env.set('EMBER_ACME_EMAIL', 'ops@ember-cloud.net');
  return env;
}

function authorization(overrides: Partial<ModelAuthorizationEntry> = {}): ModelAuthorizationEntry {
  return {
    authorizationId: 'L4B-A1',
    providerId: 'openai',
    modelId: MODEL_ID,
    rateVersion: 'openai-gpt-5-mini-2025-08-07-invoice-2026-11-07',
    approvedBy: 'CTO / Jia',
    approvedAt: '2026-11-07',
    expiresAt: '2027-02-07',
    invoiceSource: 'OpenAI console invoice INV-TEST',
    maxPerAttemptMicroUsd: 5_000,
    maxPrincipalDailyMicroUsd: 250_000,
    maxTenantDailyMicroUsd: 1_000_000,
    maxGlobalDailyMicroUsd: 5_000_000,
    maxPaidSmokeTurns: 5,
    ...overrides,
  };
}

function manifest(...entries: ModelAuthorizationEntry[]): ModelAuthorizationManifest {
  return { readable: true, entries, reason: null };
}

/** A staging environment that asks for real inference with the credential present. */
function realEnv(provider = 'openai'): Map<string, string> {
  const env = stagingEnv();
  env.set('EMBER_MODEL_EXECUTION', 'real');
  env.set('EMBER_MODEL_PROVIDER', provider);
  env.set('EMBER_MODEL_ID', MODEL_ID);
  env.set('EMBER_MODEL_API_KEY', AUTHORIZED_KEY);
  return env;
}

function codes(result: GuardResult): string[] {
  return result.violations.map((violation) => violation.code);
}

function messages(result: GuardResult): string {
  return result.violations.map((violation) => violation.message).join('\n');
}

describe('paid model authorization artifact', () => {
  it('ships empty, so the merged default still refuses real inference', () => {
    const onDisk = loadModelAuthorizationManifest();

    expect(onDisk.readable).toBe(true);
    expect(onDisk.entries).toEqual([]);

    const result = evaluateStagingEnv(realEnv(), { authorization: onDisk, now: TODAY });

    expect(codes(result)).toContain('E_MODEL_REAL');
    expect(messages(result)).toContain('no entry in infra/staging/model-authorization.json');
  });

  it('admits real only when the manifest authorizes the exact provider and pinned model', () => {
    const result = evaluateStagingEnv(realEnv(), {
      authorization: manifest(authorization()),
      now: TODAY,
    });

    expect(codes(result)).not.toContain('E_MODEL_REAL');
    expect(codes(result)).not.toContain('E_PROVIDER_SECRET');
    expect(codes(result)).not.toContain('E_MODEL_CREDENTIAL');
    expect(result.ok).toBe(true);
  });

  it('admits the credential variable only together with an authorization, never on its own', () => {
    const withoutAuthorization = stagingEnv();
    withoutAuthorization.set('EMBER_MODEL_API_KEY', AUTHORIZED_KEY);
    withoutAuthorization.set('EMBER_MODEL_PROVIDER', 'openai');

    const refused = evaluateStagingEnv(withoutAuthorization, { now: TODAY });
    expect(codes(refused).filter((code) => code === 'E_PROVIDER_SECRET')).toHaveLength(2);

    const admitted = evaluateStagingEnv(realEnv(), {
      authorization: manifest(authorization()),
      now: TODAY,
    });
    expect(codes(admitted)).not.toContain('E_PROVIDER_SECRET');
  });

  it('still refuses every other provider variable while an authorization is in force', () => {
    const env = realEnv();
    env.set('OPENAI_API_KEY', 'sk-not-the-approved-variable');
    env.set('DAYTONA_API_KEY', 'dtn-not-a-real-key');

    const result = evaluateStagingEnv(env, {
      authorization: manifest(authorization()),
      now: TODAY,
    });

    expect(codes(result).filter((code) => code === 'E_PROVIDER_SECRET')).toHaveLength(2);
  });

  it('refuses a model the manifest does not name', () => {
    const env = realEnv();
    env.set('EMBER_MODEL_ID', 'gpt-4.1-mini-2025-04-14');

    const result = evaluateStagingEnv(env, {
      authorization: manifest(authorization()),
      now: TODAY,
    });

    expect(codes(result)).toContain('E_MODEL_REAL');
  });

  it('refuses real with no pinned model id at all', () => {
    const env = realEnv();
    env.delete('EMBER_MODEL_ID');

    const result = evaluateStagingEnv(env, {
      authorization: manifest(authorization()),
      now: TODAY,
    });

    expect(codes(result)).toContain('E_MODEL_REAL');
    expect(messages(result)).toContain('EMBER_MODEL_ID is unset');
  });

  it('refuses an expired authorization and says so', () => {
    const result = evaluateStagingEnv(realEnv(), {
      // A real approval window that simply ran out — not a malformed one, which has its own case.
      authorization: manifest(authorization({ approvedAt: '2026-08-01', expiresAt: '2026-11-06' })),
      now: TODAY,
    });

    expect(codes(result)).toContain('E_MODEL_REAL');
    expect(messages(result)).toContain('has expired');
  });

  it('refuses an authorization dated in the future', () => {
    const result = evaluateStagingEnv(realEnv(), {
      authorization: manifest(authorization({ approvedAt: '2026-12-01', expiresAt: '2027-03-01' })),
      now: TODAY,
    });

    expect(codes(result)).toContain('E_MODEL_REAL');
    expect(messages(result)).toContain('does not start until a future date');
  });

  it('refuses a template authorization that was never filled in', () => {
    for (const override of [
      { authorizationId: 'PENDING-CTO-SIGNOFF' },
      { authorizedByPlaceholder: true, approvedBy: 'TODO' },
      { expiresAt: 'not-a-date' },
      { maxPerAttemptMicroUsd: 0 },
      { maxPaidSmokeTurns: 500 },
    ]) {
      const result = evaluateStagingEnv(realEnv(), {
        authorization: manifest(
          authorization(
            'authorizedByPlaceholder' in override ? { approvedBy: override.approvedBy } : override,
          ),
        ),
        now: TODAY,
      });

      expect(codes(result), JSON.stringify(override)).toContain('E_MODEL_REAL');
      expect(messages(result), JSON.stringify(override)).toContain('incomplete');
    }
  });

  it('refuses two authorizations for one model rather than picking a ceiling', () => {
    const result = evaluateStagingEnv(realEnv(), {
      authorization: manifest(authorization(), authorization({ authorizationId: 'L4B-A1-BIS' })),
      now: TODAY,
    });

    expect(codes(result)).toContain('E_MODEL_REAL');
    expect(messages(result)).toContain('more than one authorization');
  });

  it('refuses real in the acceptance profile even when authorized', () => {
    const env = stagingEnv();
    env.set('NODE_ENV', 'test');
    env.set('EMBER_ENV', 'test');
    env.set('EMBER_WORKER_MODE', 'poll');
    env.set('EMBER_WORKER_SIMULATED_EXECUTION', 'local-only');
    env.set('EMBER_VOLUME_PREFIX', 'ember-e2e-model-auth-test');
    env.set('EMBER_EDGE_BIND', '127.0.0.1');
    env.set('EMBER_CADDY_CONFIG', 'Caddyfile.internal');
    env.set('EMBER_MODEL_EXECUTION', 'real');
    env.set('EMBER_MODEL_PROVIDER', 'openai');
    env.set('EMBER_MODEL_ID', MODEL_ID);
    env.set('EMBER_MODEL_API_KEY', AUTHORIZED_KEY);

    const result = evaluateStagingEnv(env, {
      mode: 'e2e',
      authorization: manifest(authorization()),
      now: TODAY,
    });

    expect(codes(result)).toContain('E_MODEL_REAL');
    // The e2e profile never exempts a provider credential either.
    expect(codes(result)).toContain('E_PROVIDER_SECRET');
  });

  it('refuses a deployment ceiling above the authorized one', () => {
    const env = realEnv();
    env.set('EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD', String(5_000_001));

    const result = evaluateStagingEnv(env, {
      authorization: manifest(authorization({ maxGlobalDailyMicroUsd: 1_000_000 })),
      now: TODAY,
    });

    expect(codes(result)).toContain('E_MODEL_BUDGET');
  });

  it('accepts a deployment that only lowers an authorized ceiling', () => {
    const env = realEnv();
    env.set('EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD', '250000');
    env.set('EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD', '50000');

    const result = evaluateStagingEnv(env, {
      authorization: manifest(authorization()),
      now: TODAY,
    });

    expect(codes(result)).not.toContain('E_MODEL_BUDGET');
    expect(result.ok).toBe(true);
  });

  it('warns when the authorization expires within a fortnight', () => {
    const result = evaluateStagingEnv(realEnv(), {
      authorization: manifest(authorization({ expiresAt: '2026-11-20' })),
      now: TODAY,
    });

    expect(result.warnings.map((warning) => warning.code)).toContain(
      'W_MODEL_AUTHORIZATION_EXPIRING',
    );
  });

  it('treats an unreadable manifest as "no authorization", never as "allowed"', () => {
    const result = evaluateStagingEnv(realEnv(), {
      authorization: { readable: false, entries: [], reason: 'json' },
      now: TODAY,
    });

    expect(codes(result)).toContain('E_MODEL_REAL');
    expect(messages(result)).toContain('could not be read');
  });

  it('derives the day in UTC so the approval boundary matches the ledger', () => {
    expect(utcDay(new Date('2026-11-07T23:59:59Z'))).toBe('2026-11-07');
    expect(utcDay(new Date('2026-11-08T00:00:00Z'))).toBe('2026-11-08');
  });
});

describe('authorization artifact ↔ code allowlist parity', () => {
  it('reads the committed manifest without a syntax error and keeps it empty', () => {
    const parsed = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as {
      schemaVersion: number;
      authorizations: ModelAuthorizationEntry[];
    };

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.authorizations).toEqual([]);
    // The code-side allowlist must be empty for the same reason the artifact is: L4-B ships the
    // gate, not the permission. Enabling real inference is one reviewed diff in both places.
    expect(APPROVED_REAL_MODELS).toEqual([]);
    expect(MODEL_RATE_ROWS.every((row) => row.provenance === 'unverified')).toBe(true);
  });

  it('names a candidate that is not approved and cannot resolve', () => {
    expect(PENDING_MODEL_CANDIDATES).toHaveLength(1);
    expect(PENDING_MODEL_CANDIDATES[0]?.modelId).toBe(MODEL_ID);

    const approvedIds = new Set(APPROVED_REAL_MODELS.map((entry) => entry.modelId));
    for (const candidate of PENDING_MODEL_CANDIDATES) {
      expect(approvedIds.has(candidate.modelId)).toBe(false);
    }
  });

  it('prices the candidate, and records the shutdown day of every deprecated snapshot', () => {
    const candidateRate = MODEL_RATE_ROWS.find((row) => row.modelId === MODEL_ID);

    expect(candidateRate).toBeDefined();
    expect(candidateRate?.shutdownDate).toBeNull();
    expect(candidateRate?.reasoningEffort).toBe('minimal');

    for (const row of MODEL_RATE_ROWS) {
      if (row.modelId.startsWith('gpt-4')) {
        expect(row.shutdownDate, row.modelId).toBe('2027-01-14');
      }
    }
  });

  it('matches the guard lookup semantics the artifact is written against', () => {
    const lookup = findModelAuthorization(manifest(authorization()), {
      providerId: 'openai',
      modelId: MODEL_ID,
      today: '2026-11-07',
    });

    expect(lookup.status).toBe('authorized');
    expect(lookup.status === 'authorized' ? lookup.entry.authorizationId : null).toBe('L4B-A1');
  });
});

describe('compose secret exposure', () => {
  it('blanks the model key inside the api container, which has no model gateway', () => {
    const compose = readFileSync(COMPOSE_FILE, 'utf8');
    const apiService = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));

    expect(apiService).toContain("EMBER_MODEL_API_KEY: ''");
  });

  it('passes the model variables to the worker through the shared environment file', () => {
    const compose = readFileSync(COMPOSE_FILE, 'utf8');
    const workerService = compose.slice(
      compose.indexOf('\n  worker:'),
      compose.indexOf('\n  edge:'),
    );

    expect(workerService).toContain('- ${EMBER_STAGING_ENV_FILE:-./env/staging.env}');
    // The worker must NOT blank the key: it is the only process that may use it.
    expect(workerService).not.toContain("EMBER_MODEL_API_KEY: ''");
  });
});
