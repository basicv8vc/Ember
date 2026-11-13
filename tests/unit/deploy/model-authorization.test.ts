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
const TODAY = new Date('2026-11-11T09:00:00Z');

const MODEL_ID = 'gpt-5.6-luna';
const OPENROUTER_MODEL_ID = 'nvidia/nemotron-3.5-lightning';
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
    executionScope: 'resident',
    rateVersion: 'openai-gpt-5.6-luna-published-2026-11-10',
    approvedBy: 'CTO / Jia',
    approvedAt: '2026-11-07',
    expiresAt: '2027-02-07',
    priceSource: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    maxPerAttemptMicroUsd: 5_000,
    maxPrincipalDailyMicroUsd: 250_000,
    maxTenantDailyMicroUsd: 1_000_000,
    maxGlobalDailyMicroUsd: 5_000_000,
    maxPrincipalDailyTurns: 60,
    maxPaidSmokeTurns: 1,
    ...overrides,
  };
}

function openRouterAuthorization(
  overrides: Partial<ModelAuthorizationEntry> = {},
): ModelAuthorizationEntry {
  return authorization({
    authorizationId: 'L4C3-B2-OPENROUTER-DEEPINFRA-2026-11-11',
    providerId: 'openrouter',
    modelId: OPENROUTER_MODEL_ID,
    rateVersion: 'openrouter-nvidia-nemotron-3.5-lightning-deepinfra-bf16-2026-11-11',
    approvedBy: 'CTO',
    approvedAt: '2026-11-11',
    expiresAt: '2026-11-12',
    priceSource: 'https://openrouter.ai/nvidia/nemotron-3.5-lightning/providers',
    executionScope: 'smoke_only',
    maxPerAttemptMicroUsd: 5_000,
    maxPrincipalDailyMicroUsd: 5_000,
    maxTenantDailyMicroUsd: 5_000,
    maxGlobalDailyMicroUsd: 5_000,
    maxPrincipalDailyTurns: 1,
    maxPaidSmokeTurns: 1,
    stagingAlpha: {
      approval: {
        approvalId: 'EMBER-CLOUD-INTERNAL-MULTI-TURN',
        approvedBy: 'CTO',
        approvedAt: '2026-11-13',
      },
      budgetCeilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 250_000,
        tenantDailyMicroUsd: 1_000_000,
        globalDailyMicroUsd: 1_000_000,
        principalDailyTurns: 60,
      },
      externalApiKeySpendLimitUsd: 1,
      maxProviderAttemptsPerTurn: 1,
    },
    ...overrides,
  });
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

function openRouterRealEnv(): Map<string, string> {
  const env = realEnv('openrouter');
  env.set('EMBER_MODEL_ID', OPENROUTER_MODEL_ID);
  return env;
}

function codes(result: GuardResult): string[] {
  return result.violations.map((violation) => violation.code);
}

function messages(result: GuardResult): string {
  return result.violations.map((violation) => violation.message).join('\n');
}

describe('paid model authorization artifact', () => {
  it('records the exact CTO route while the Staging Runtime remains disabled by default', () => {
    const onDisk = loadModelAuthorizationManifest();

    expect(onDisk.readable).toBe(true);
    expect(onDisk.entries).toHaveLength(1);
    expect(onDisk.entries[0]).toMatchObject(openRouterAuthorization());

    const normalStagingEnv = stagingEnv();
    expect(normalStagingEnv.get('EMBER_MODEL_EXECUTION')).toBe('disabled');
    expect(evaluateStagingEnv(normalStagingEnv, { authorization: onDisk, now: TODAY }).ok).toBe(
      true,
    );

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

  it('recognizes OpenRouter only with its own official catalog page for the exact model', () => {
    expect(
      findModelAuthorization(manifest(openRouterAuthorization()), {
        providerId: 'openrouter',
        modelId: OPENROUTER_MODEL_ID,
        today: '2026-11-11',
      }),
    ).toMatchObject({ status: 'authorized' });
  });

  it('keeps the committed OpenRouter smoke-only approval unavailable to a resident deployment', () => {
    const env = realEnv('openrouter');
    env.set('EMBER_MODEL_ID', OPENROUTER_MODEL_ID);

    const result = evaluateStagingEnv(env, {
      authorization: loadModelAuthorizationManifest(),
      now: TODAY,
    });

    expect(codes(result)).toContain('E_MODEL_REAL');
    expect(messages(result)).toContain('smoke_only');
    expect(
      findModelAuthorization(loadModelAuthorizationManifest(), {
        providerId: 'openrouter',
        modelId: OPENROUTER_MODEL_ID,
        today: '2026-11-11',
      }),
    ).toMatchObject({ status: 'authorized' });
    expect(result.warnings.map((warning) => warning.code)).toContain(
      'W_MODEL_AUTHORIZATION_EXPIRING',
    );
  });

  it('does not accept an OpenAI price citation as OpenRouter pricing approval', () => {
    const env = realEnv('openrouter');
    env.set('EMBER_MODEL_ID', OPENROUTER_MODEL_ID);

    const result = evaluateStagingEnv(env, {
      authorization: manifest(
        openRouterAuthorization({
          priceSource: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
        }),
      ),
      now: TODAY,
    });

    expect(codes(result)).toContain('E_MODEL_REAL');
    expect(messages(result)).toContain('incomplete');
  });

  it('fails closed on a prototype-looking provider id in the authorization file', () => {
    const result = findModelAuthorization(manifest(authorization({ providerId: '__proto__' })), {
      providerId: '__proto__',
      modelId: MODEL_ID,
      today: '2026-11-07',
    });

    expect(result.status).toBe('malformed_authorization');
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
      { executionScope: 'resident_worker' as ModelAuthorizationEntry['executionScope'] },
      { expiresAt: 'not-a-date' },
      { priceSource: 'https://third-party.example/models/gpt-5.6-luna' },
      { maxPerAttemptMicroUsd: 0 },
      { maxPrincipalDailyTurns: 0 },
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

  it('compares every effective Worker budget default to the authorization', () => {
    const result = evaluateStagingEnv(openRouterRealEnv(), {
      authorization: manifest(openRouterAuthorization()),
      now: TODAY,
    });

    const budgetVariables = result.violations
      .filter((violation) => violation.code === 'E_MODEL_BUDGET')
      .map((violation) => violation.variable);

    expect(budgetVariables).toEqual([
      'EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD',
      'EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD',
      'EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD',
      'EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS',
    ]);
  });

  it('rejects explicit dollar and principal Turn budgets above their separate approvals', () => {
    for (const [variable, value] of [
      ['EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD', 5_001],
      ['EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD', 5_001],
      ['EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD', 5_001],
      ['EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD', 5_001],
      ['EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS', 2],
    ] as const) {
      const env = openRouterRealEnv();
      env.set('EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD', '5000');
      env.set('EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD', '5000');
      env.set('EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD', '5000');
      env.set('EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD', '5000');
      env.set('EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS', '1');
      env.set(variable, String(value));

      const result = evaluateStagingEnv(env, {
        authorization: manifest(openRouterAuthorization()),
        now: TODAY,
      });

      expect(
        result.violations.some(
          (violation) => violation.code === 'E_MODEL_BUDGET' && violation.variable === variable,
        ),
        `${variable}=${value}`,
      ).toBe(true);
    }
  });

  it('accepts lower runtime budgets while keeping principal daily Turns distinct from Smoke Turns', () => {
    const env = openRouterRealEnv();
    env.set('EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD', '4000');
    env.set('EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD', '4000');
    env.set('EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD', '4000');
    env.set('EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD', '4000');
    env.set('EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS', '1');

    const result = evaluateStagingEnv(env, {
      authorization: manifest(openRouterAuthorization({ maxPrincipalDailyTurns: 2 })),
      now: TODAY,
    });

    expect(codes(result)).not.toContain('E_MODEL_BUDGET');
    // Smoke-only scope still blocks this resident deployment profile.
    expect(codes(result)).toContain('E_MODEL_REAL');
    expect(messages(result)).toContain('smoke_only');
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
  it('reads the committed manifest and matches the code-side OpenRouter approval', () => {
    const parsed = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as {
      schemaVersion: number;
      authorizations: ModelAuthorizationEntry[];
    };

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.authorizations).toHaveLength(1);
    expect(parsed.authorizations[0]).toMatchObject(openRouterAuthorization());
    expect(APPROVED_REAL_MODELS).toMatchObject([
      {
        providerId: 'openrouter',
        modelId: OPENROUTER_MODEL_ID,
        approval: {
          approvalId: 'L4C3-B2-OPENROUTER-DEEPINFRA-2026-11-11',
          approvedBy: 'CTO',
          approvedAt: '2026-11-11',
          expiresAt: '2026-11-12',
        },
        executionScope: 'smoke_only',
        budgetCeilings: {
          perAttemptMicroUsd: 5_000,
          principalDailyMicroUsd: 5_000,
          tenantDailyMicroUsd: 5_000,
          globalDailyMicroUsd: 5_000,
          principalDailyTurns: 1,
        },
        maxPaidSmokeTurns: 1,
        openRouterRouting: {
          only: ['deepinfra'],
          allowFallbacks: false,
          dataCollection: 'deny',
          zdr: true,
          requireParameters: true,
        },
      },
    ]);
    expect(
      MODEL_RATE_ROWS.filter((row) => row.provenance !== 'unverified').map((row) => [
        row.providerId,
        row.modelId,
      ]),
    ).toEqual([['openrouter', OPENROUTER_MODEL_ID]]);
  });

  it('leaves direct OpenAI routing unapproved', () => {
    expect(PENDING_MODEL_CANDIDATES).toHaveLength(1);
    const openAiCandidate = PENDING_MODEL_CANDIDATES[0];
    expect(openAiCandidate).toMatchObject({
      providerId: 'openai',
      modelId: MODEL_ID,
    });
    expect(openAiCandidate?.rationale.length).toBeGreaterThan(0);

    const approvedIds = new Set(APPROVED_REAL_MODELS.map((entry) => entry.modelId));
    for (const candidate of PENDING_MODEL_CANDIDATES) {
      expect(approvedIds.has(candidate.modelId)).toBe(false);
    }
    expect(approvedIds).toEqual(new Set([OPENROUTER_MODEL_ID]));
  });

  it('prices the candidate and records shutdown dates for deprecated snapshots', () => {
    const candidateRate = MODEL_RATE_ROWS.find((row) => row.modelId === MODEL_ID);

    expect(candidateRate).toBeDefined();
    expect(candidateRate?.shutdownDate).toBeNull();
    expect(candidateRate?.inputMicroUsdPerMillion).toBe(200_000);
    expect(candidateRate?.outputMicroUsdPerMillion).toBe(1_200_000);
    expect(candidateRate?.reasoningEffort).toBe('none');
    expect(candidateRate?.provenance).toBe('unverified');
    expect(candidateRate?.source).toContain(
      'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    );

    const openRouterRate = MODEL_RATE_ROWS.find(
      (row) => row.providerId === 'openrouter' && row.modelId === OPENROUTER_MODEL_ID,
    );
    expect(openRouterRate).toMatchObject({
      inputMicroUsdPerMillion: 60_000,
      outputMicroUsdPerMillion: 160_000,
      provenance: 'official_price_verified',
      reasoningEffort: 'none',
    });
    expect(openRouterRate?.source).toContain(
      'https://openrouter.ai/api/v1/models/nvidia/nemotron-3.5-lightning/endpoints',
    );

    const retiredGpt5Mini = MODEL_RATE_ROWS.find((row) => row.modelId === 'gpt-5-mini-2025-08-07');
    expect(retiredGpt5Mini?.shutdownDate).toBe('2026-12-11');
    expect(MODEL_RATE_ROWS.find((row) => row.modelId === 'gpt-5-mini')?.shutdownDate).toBe(
      '2026-12-11',
    );

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
  it('blanks the model key in every container other than the worker', () => {
    const compose = readFileSync(COMPOSE_FILE, 'utf8');
    const migrateService = compose.slice(
      compose.indexOf('\n  migrate:'),
      compose.indexOf('\n  api:'),
    );
    const apiService = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));
    const edgeService = compose.slice(compose.indexOf('\n  edge:'), compose.indexOf('\nnetworks:'));

    expect(migrateService).toContain("EMBER_MODEL_API_KEY: ''");
    expect(apiService).toContain("EMBER_MODEL_API_KEY: ''");
    expect(edgeService).toContain("EMBER_MODEL_API_KEY: ''");
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
