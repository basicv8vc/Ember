import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  G3_REAL_CANARY_VARS,
  UNPROVISIONED_D1_PLACEHOLDER,
  parseJsonc,
  validateV2StagingConfig,
} from '../../infra/cloudflare/v2-staging-preflight.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

function loadRealConfigs() {
  const v2Config = parseJsonc(
    readFileSync(resolve(REPO_ROOT, 'apps/api/wrangler.v2-staging.jsonc'), 'utf8'),
  );
  const v1Configs = [
    parseJsonc(readFileSync(resolve(REPO_ROOT, 'apps/api/wrangler.staging.jsonc'), 'utf8')),
    parseJsonc(
      readFileSync(resolve(REPO_ROOT, 'apps/cloud-async-runtime/wrangler.staging.jsonc'), 'utf8'),
    ),
  ];
  const migrationExists = existsSync(
    resolve(REPO_ROOT, 'packages/runtime-v2/migrations/0001_v2_recovery_registry.sql'),
  );
  return { v2Config, v1Configs, migrationExists };
}

describe('V2 staging preflight validator', () => {
  it('accepts the repository wrangler.v2-staging.jsonc with provisioned D1', () => {
    const { v2Config, v1Configs, migrationExists } = loadRealConfigs();
    const result = validateV2StagingConfig({
      v2Config,
      v1Configs,
      migrationExists,
      requireProvisioned: true,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.notices).toEqual([]);
  });

  it('blocks live deploy when D1_RECOVERY uses the unprovisioned placeholder', () => {
    const { v2Config, v1Configs, migrationExists } = loadRealConfigs();
    const mutated = structuredClone(v2Config);
    const d1 = mutated.d1_databases?.[0];
    if (d1) d1.database_id = UNPROVISIONED_D1_PLACEHOLDER;

    const dryRunResult = validateV2StagingConfig({
      v2Config: mutated,
      v1Configs,
      migrationExists,
      requireProvisioned: false,
    });
    expect(dryRunResult.ok).toBe(true);
    expect(dryRunResult.notices.some((n) => n.includes('UNPROVISIONED_PLACEHOLDER'))).toBe(true);

    const strictResult = validateV2StagingConfig({
      v2Config: mutated,
      v1Configs,
      migrationExists,
      requireProvisioned: true,
    });
    expect(strictResult.ok).toBe(false);
    expect(strictResult.errors.some((e) => e.includes('placeholder database_id'))).toBe(true);
  });

  it('rejects any V1 resource collision (worker name, queue, route, or Hyperdrive)', () => {
    const { v2Config, v1Configs, migrationExists } = loadRealConfigs();
    const mutated = structuredClone(v2Config);
    const firstProducer = mutated.queues?.producers?.[0];
    if (firstProducer) firstProducer.queue = 'ember-staging-assistant-turns';
    mutated.routes = [{ pattern: 'ember-api.slowfast.dev', custom_domain: true }];
    mutated.hyperdrive = [{ binding: 'HYPERDRIVE', id: 'f7da9cff26b843fda8187764f9b81b25' }];

    const result = validateV2StagingConfig({
      v2Config: mutated,
      v1Configs,
      migrationExists,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('queue collides with V1'))).toBe(true);
    expect(result.errors.some((e) => e.includes('route collides with V1'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Hyperdrive ID collides with V1'))).toBe(true);
  });

  it('rejects real-provider mode before separate provider-canary approval', () => {
    const { v2Config, v1Configs, migrationExists } = loadRealConfigs();
    const mutated = structuredClone(v2Config);
    mutated.vars = { ...mutated.vars, EMBER_MODEL_MODE: 'real' };

    const result = validateV2StagingConfig({
      v2Config: mutated,
      v1Configs,
      migrationExists,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('EMBER_MODEL_MODE === "fake"'))).toBe(true);
  });

  it('allows bounded G3 real-LLM canary only with explicit flag, pinned model, allowlist, and strict caps', () => {
    const { v2Config, v1Configs, migrationExists } = loadRealConfigs();
    const canaryConfig = structuredClone(v2Config);
    canaryConfig.vars = { ...canaryConfig.vars, ...G3_REAL_CANARY_VARS };

    const validResult = validateV2StagingConfig({
      v2Config: canaryConfig,
      v1Configs,
      migrationExists,
      requireProvisioned: true,
      allowRealLlmCanary: true,
    });
    expect(validResult.ok).toBe(true);
    expect(validResult.errors).toEqual([]);

    const pollutedFakeConfig = structuredClone(v2Config);
    pollutedFakeConfig.vars = {
      ...pollutedFakeConfig.vars,
      GLOBAL_DAILY_CEILING_MICRO_USD: '100000',
    };
    const pollutedFakeResult = validateV2StagingConfig({
      v2Config: pollutedFakeConfig,
      v1Configs,
      migrationExists,
    });
    expect(pollutedFakeResult.ok).toBe(false);
    expect(pollutedFakeResult.errors.some((e) => e.includes('default global ledger ceiling'))).toBe(
      true,
    );

    const looseBudget = structuredClone(canaryConfig);
    looseBudget.vars = {
      ...looseBudget.vars,
      EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '250000',
      GLOBAL_DAILY_CEILING_MICRO_USD: '250000',
    };
    const looseResult = validateV2StagingConfig({
      v2Config: looseBudget,
      v1Configs,
      migrationExists,
      allowRealLlmCanary: true,
    });
    expect(looseResult.ok).toBe(false);
    expect(looseResult.errors.some((e) => e.includes('exceeds G3 canary ceiling'))).toBe(true);

    const broadScope = structuredClone(canaryConfig);
    broadScope.vars = { ...broadScope.vars, EMBER_MODEL_ALPHA_SCOPE: 'authenticated_tenants' };
    const broadScopeResult = validateV2StagingConfig({
      v2Config: broadScope,
      v1Configs,
      migrationExists,
      allowRealLlmCanary: true,
    });
    expect(broadScopeResult.ok).toBe(false);
    expect(broadScopeResult.errors.some((e) => e.includes('EMBER_MODEL_ALPHA_SCOPE'))).toBe(true);

    const daytonaCanary = structuredClone(canaryConfig);
    daytonaCanary.vars = { ...daytonaCanary.vars, EMBER_SANDBOX_MODE: 'daytona' };
    const daytonaResult = validateV2StagingConfig({
      v2Config: daytonaCanary,
      v1Configs,
      migrationExists,
      allowRealLlmCanary: true,
    });
    expect(daytonaResult.ok).toBe(false);
    expect(daytonaResult.errors.some((e) => e.includes('EMBER_SANDBOX_MODE'))).toBe(true);

    const plaintextSecret = structuredClone(canaryConfig);
    plaintextSecret.vars = {
      ...plaintextSecret.vars,
      EMBER_MODEL_API_KEY: 'sk-or-v1-must-never-be-plaintext',
    };
    const secretResult = validateV2StagingConfig({
      v2Config: plaintextSecret,
      v1Configs,
      migrationExists,
      allowRealLlmCanary: true,
    });
    expect(secretResult.ok).toBe(false);
    expect(secretResult.errors.some((e) => e.includes('Cloudflare Worker secret'))).toBe(true);
  });

  it('rejects real Daytona or unset EMBER_SANDBOX_MODE before separate canary approval', () => {
    const { v2Config, v1Configs, migrationExists } = loadRealConfigs();

    const daytonaConfig = structuredClone(v2Config);
    daytonaConfig.vars = { ...daytonaConfig.vars, EMBER_SANDBOX_MODE: 'daytona' };
    const daytonaResult = validateV2StagingConfig({
      v2Config: daytonaConfig,
      v1Configs,
      migrationExists,
    });
    expect(daytonaResult.ok).toBe(false);
    expect(daytonaResult.errors.some((e) => e.includes('EMBER_SANDBOX_MODE === "fake"'))).toBe(
      true,
    );

    const unsetConfig = structuredClone(v2Config);
    if (unsetConfig.vars) {
      delete unsetConfig.vars.EMBER_SANDBOX_MODE;
    }
    const unsetResult = validateV2StagingConfig({
      v2Config: unsetConfig,
      v1Configs,
      migrationExists,
    });
    expect(unsetResult.ok).toBe(false);
    expect(unsetResult.errors.some((e) => e.includes('EMBER_SANDBOX_MODE === "fake"'))).toBe(true);
  });

  it('accepts a provisioned D1 database_id when --require-provisioned is set', () => {
    const { v2Config, v1Configs, migrationExists } = loadRealConfigs();
    const mutated = structuredClone(v2Config);
    const d1 = mutated.d1_databases?.[0];
    if (d1) d1.database_id = '11111111-2222-3333-4444-555555555555';
    expect(d1?.database_id).not.toBe(UNPROVISIONED_D1_PLACEHOLDER);

    const result = validateV2StagingConfig({
      v2Config: mutated,
      v1Configs,
      migrationExists,
      requireProvisioned: true,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.notices).toEqual([]);
  });
});
