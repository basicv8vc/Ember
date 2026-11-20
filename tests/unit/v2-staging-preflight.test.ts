import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
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
