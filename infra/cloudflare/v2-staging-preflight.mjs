#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNPROVISIONED_D1_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
export const G3_APPROVED_PROVIDER = 'openrouter';
export const G3_APPROVED_MODEL_ID = 'deepseek/deepseek-v4.1-flash-1017';
export const G3_MAX_BUDGET_CEILINGS = Object.freeze({
  perAttemptMicroUsd: 5_000,
  principalDailyMicroUsd: 50_000,
  tenantDailyMicroUsd: 50_000,
  globalDailyMicroUsd: 100_000,
  principalDailyTurns: 20,
});
export const REQUIRED_REAL_CANARY_SECRETS = Object.freeze([
  'EMBER_MODEL_API_KEY',
  'EMBER_MODEL_ALPHA_TENANT_IDS',
]);
export const OPTIONAL_REAL_CANARY_SECRETS = Object.freeze(['EMBER_V2_STAGING_ALLOWED_SUBJECTS']);
export const G3_REAL_CANARY_VARS = Object.freeze({
  EMBER_MODEL_MODE: 'real',
  EMBER_MODEL_PROVIDER: G3_APPROVED_PROVIDER,
  EMBER_MODEL_ID: G3_APPROVED_MODEL_ID,
  EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
  EMBER_MODEL_ATTEMPT_TIMEOUT_MS: '20000',
  EMBER_MODEL_TURN_LEASE_MS: '30000',
  EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD: String(G3_MAX_BUDGET_CEILINGS.perAttemptMicroUsd),
  EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD: String(
    G3_MAX_BUDGET_CEILINGS.principalDailyMicroUsd,
  ),
  EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD: String(G3_MAX_BUDGET_CEILINGS.tenantDailyMicroUsd),
  EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: String(G3_MAX_BUDGET_CEILINGS.globalDailyMicroUsd),
  GLOBAL_DAILY_CEILING_MICRO_USD: String(G3_MAX_BUDGET_CEILINGS.globalDailyMicroUsd),
  EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS: String(G3_MAX_BUDGET_CEILINGS.principalDailyTurns),
});
const FORBIDDEN_PLAINTEXT_SECRET_VARS = Object.freeze([
  ...REQUIRED_REAL_CANARY_SECRETS,
  ...OPTIONAL_REAL_CANARY_SECRETS,
  'DAYTONA_API_KEY',
]);
const SAFE_INT_REGEX = /^\d+$/;
const REQUIRED_V2_DO_CLASSES = new Map([
  ['AGENT_HEAD', 'AgentHeadDO'],
  ['GLOBAL_BUDGET', 'GlobalBudgetDO'],
]);
const REQUIRED_V2_QUEUES = [
  'ember-v2-staging-durable-turn',
  'ember-v2-staging-durable-turn-dlq',
  'ember-v2-staging-agent-task',
  'ember-v2-staging-agent-task-dlq',
];

/**
 * Strip single-line comments, block comments, and trailing commas from JSONC.
 */
export function parseJsonc(source) {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  const withoutTrailingCommas = out.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas);
}

function collectResourceNames(config) {
  const queues = new Set();
  for (const producer of config.queues?.producers ?? []) {
    if (producer.queue) queues.add(producer.queue);
  }
  for (const consumer of config.queues?.consumers ?? []) {
    if (consumer.queue) queues.add(consumer.queue);
    if (consumer.dead_letter_queue) queues.add(consumer.dead_letter_queue);
  }

  const d1Names = new Set(
    (config.d1_databases ?? []).map((db) => db.database_name).filter(Boolean),
  );
  const d1Ids = new Set(
    (config.d1_databases ?? [])
      .map((db) => db.database_id)
      .filter((id) => Boolean(id) && id !== UNPROVISIONED_D1_PLACEHOLDER),
  );
  const r2Buckets = new Set((config.r2_buckets ?? []).map((b) => b.bucket_name).filter(Boolean));
  const hyperdriveIds = new Set((config.hyperdrive ?? []).map((h) => h.id).filter(Boolean));
  const routes = new Set((config.routes ?? []).map((r) => r.pattern).filter(Boolean));

  return {
    name: config.name,
    queues,
    d1Names,
    d1Ids,
    r2Buckets,
    hyperdriveIds,
    routes,
  };
}

function parseBoundedPositiveInt(raw, name, max, errors) {
  if (typeof raw !== 'string' || !SAFE_INT_REGEX.test(raw.trim())) {
    errors.push(`real-LLM canary requires integer vars.${name} in [1, ${max}]`);
    return null;
  }
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    errors.push(`vars.${name}=${parsed} exceeds G3 canary ceiling [1, ${max}]`);
    return null;
  }
  return parsed;
}

/**
 * Validate an isolated V2 staging Wrangler config against V1 staging configs.
 */
export function validateV2StagingConfig({
  v2Config,
  v1Configs,
  migrationExists = true,
  requireProvisioned = false,
  allowRealLlmCanary = false,
}) {
  const errors = [];
  const notices = [];
  const vars = v2Config.vars ?? {};

  if (v2Config.name !== 'ember-v2-staging') {
    errors.push(`expected worker name "ember-v2-staging", got ${JSON.stringify(v2Config.name)}`);
  }
  if (vars.EMBER_ENV !== 'v2-staging') {
    errors.push(`expected vars.EMBER_ENV === "v2-staging", got ${JSON.stringify(vars.EMBER_ENV)}`);
  }
  if (vars.EMBER_V2_ALLOWED_HOST !== 'ember-v2-staging.slowfast.dev') {
    errors.push(
      `expected vars.EMBER_V2_ALLOWED_HOST === "ember-v2-staging.slowfast.dev", got ${JSON.stringify(vars.EMBER_V2_ALLOWED_HOST)}`,
    );
  }
  for (const secretVar of FORBIDDEN_PLAINTEXT_SECRET_VARS) {
    if (vars[secretVar] !== undefined) {
      errors.push(`vars.${secretVar} must be a Cloudflare Worker secret, never plaintext config`);
    }
  }

  if (allowRealLlmCanary) {
    if (vars.EMBER_MODEL_MODE !== 'fake' && vars.EMBER_MODEL_MODE !== 'real') {
      errors.push(
        `V2 real-LLM canary requires vars.EMBER_MODEL_MODE === "fake" or "real" (got ${JSON.stringify(vars.EMBER_MODEL_MODE)})`,
      );
    }
    if (vars.EMBER_SANDBOX_MODE !== 'fake' && vars.EMBER_SANDBOX_MODE !== 'disabled') {
      errors.push(
        `V2 real-LLM canary requires vars.EMBER_SANDBOX_MODE === "fake" or "disabled" until separate Daytona approval (got ${JSON.stringify(vars.EMBER_SANDBOX_MODE)})`,
      );
    }
    if (vars.EMBER_MODEL_PROVIDER !== G3_APPROVED_PROVIDER) {
      errors.push(
        `V2 real-LLM canary requires vars.EMBER_MODEL_PROVIDER === "${G3_APPROVED_PROVIDER}" (got ${JSON.stringify(vars.EMBER_MODEL_PROVIDER)})`,
      );
    }
    if (vars.EMBER_MODEL_ID !== G3_APPROVED_MODEL_ID) {
      errors.push(
        `V2 real-LLM canary requires vars.EMBER_MODEL_ID === "${G3_APPROVED_MODEL_ID}" (got ${JSON.stringify(vars.EMBER_MODEL_ID)})`,
      );
    }
    if (vars.EMBER_MODEL_ALPHA_SCOPE !== 'allowlist') {
      errors.push(
        `V2 real-LLM canary requires vars.EMBER_MODEL_ALPHA_SCOPE === "allowlist" (got ${JSON.stringify(vars.EMBER_MODEL_ALPHA_SCOPE)})`,
      );
    }

    const perAttempt = parseBoundedPositiveInt(
      vars.EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD,
      'EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD',
      G3_MAX_BUDGET_CEILINGS.perAttemptMicroUsd,
      errors,
    );
    const principalDaily = parseBoundedPositiveInt(
      vars.EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD,
      'EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD',
      G3_MAX_BUDGET_CEILINGS.principalDailyMicroUsd,
      errors,
    );
    const tenantDaily = parseBoundedPositiveInt(
      vars.EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD,
      'EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD',
      G3_MAX_BUDGET_CEILINGS.tenantDailyMicroUsd,
      errors,
    );
    const globalDaily = parseBoundedPositiveInt(
      vars.EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD,
      'EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD',
      G3_MAX_BUDGET_CEILINGS.globalDailyMicroUsd,
      errors,
    );
    const platformGlobalDaily = parseBoundedPositiveInt(
      vars.GLOBAL_DAILY_CEILING_MICRO_USD,
      'GLOBAL_DAILY_CEILING_MICRO_USD',
      G3_MAX_BUDGET_CEILINGS.globalDailyMicroUsd,
      errors,
    );
    parseBoundedPositiveInt(
      vars.EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS,
      'EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS',
      G3_MAX_BUDGET_CEILINGS.principalDailyTurns,
      errors,
    );

    if (principalDaily !== null && tenantDaily !== null && principalDaily > tenantDaily) {
      errors.push('principal daily budget ceiling cannot exceed tenant daily budget ceiling');
    }
    if (tenantDaily !== null && globalDaily !== null && tenantDaily > globalDaily) {
      errors.push('tenant daily budget ceiling cannot exceed global daily budget ceiling');
    }
    if (platformGlobalDaily !== null && globalDaily !== null && platformGlobalDaily > globalDaily) {
      errors.push(
        'GLOBAL_DAILY_CEILING_MICRO_USD cannot exceed EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD',
      );
    }
    if (perAttempt !== null && principalDaily !== null && perAttempt > principalDaily) {
      errors.push('per-attempt budget ceiling cannot exceed principal daily budget ceiling');
    }
  } else {
    if (vars.EMBER_MODEL_MODE !== 'fake') {
      errors.push(
        `V2 staging must keep vars.EMBER_MODEL_MODE === "fake" until separate provider-canary approval (got ${JSON.stringify(vars.EMBER_MODEL_MODE)})`,
      );
    }
    if (vars.EMBER_SANDBOX_MODE !== 'fake') {
      errors.push(
        `V2 staging must keep vars.EMBER_SANDBOX_MODE === "fake" until separate Daytona canary approval (got ${JSON.stringify(vars.EMBER_SANDBOX_MODE)})`,
      );
    }
    if (vars.GLOBAL_DAILY_CEILING_MICRO_USD !== undefined) {
      errors.push(
        `V2 fake staging must preserve default global ledger ceiling (unset GLOBAL_DAILY_CEILING_MICRO_USD, got ${JSON.stringify(vars.GLOBAL_DAILY_CEILING_MICRO_USD)})`,
      );
    }
  }
  if (vars.EMBER_V2_STAGING_ISOLATED !== 'true') {
    errors.push('expected vars.EMBER_V2_STAGING_ISOLATED === "true"');
  }
  if (v2Config.workers_dev !== false || v2Config.preview_urls !== false) {
    errors.push('expected workers_dev === false and preview_urls === false for unapproved staging');
  }
  if ((v2Config.hyperdrive ?? []).length > 0) {
    errors.push('V2 staging must not bind V1 Neon Hyperdrive');
  }
  if ((v2Config.r2_buckets ?? []).length > 0) {
    errors.push('V2 staging must not bind V1 R2 buckets');
  }

  // Durable Objects & SQLite migrations
  const doBindings = new Map(
    (v2Config.durable_objects?.bindings ?? []).map((b) => [b.name, b.class_name]),
  );
  for (const [binding, className] of REQUIRED_V2_DO_CLASSES) {
    if (doBindings.get(binding) !== className) {
      errors.push(`missing required Durable Object binding ${binding} -> ${className}`);
    }
  }
  const sqliteClasses = new Set(
    (v2Config.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []),
  );
  for (const className of REQUIRED_V2_DO_CLASSES.values()) {
    if (!sqliteClasses.has(className)) {
      errors.push(`missing SQLite DO migration for ${className}`);
    }
  }

  // D1 recovery registry
  const d1Recovery = (v2Config.d1_databases ?? []).find((db) => db.binding === 'D1_RECOVERY');
  if (!d1Recovery) {
    errors.push('missing required D1 binding D1_RECOVERY');
  } else {
    if (d1Recovery.database_name !== 'ember-v2-staging-recovery') {
      errors.push(
        `expected D1_RECOVERY database_name "ember-v2-staging-recovery", got ${JSON.stringify(d1Recovery.database_name)}`,
      );
    }
    if (d1Recovery.database_id === UNPROVISIONED_D1_PLACEHOLDER) {
      if (requireProvisioned) {
        errors.push(
          'D1_RECOVERY still uses the unprovisioned placeholder database_id; provision D1 after approval before deploying',
        );
      } else {
        notices.push(
          'UNPROVISIONED_PLACEHOLDER: D1_RECOVERY uses placeholder database_id (expected for local dry-run before cloud approval)',
        );
      }
    }
  }
  if (!migrationExists) {
    errors.push(
      'missing D1 recovery migration packages/runtime-v2/migrations/0001_v2_recovery_registry.sql',
    );
  }

  // Queues & cron
  const v2Res = collectResourceNames(v2Config);
  for (const queueName of REQUIRED_V2_QUEUES) {
    if (!v2Res.queues.has(queueName)) {
      errors.push(`missing required V2 staging queue ${queueName}`);
    }
  }
  if (!(v2Config.triggers?.crons ?? []).includes('* * * * *')) {
    errors.push('expected 1-minute cron trigger "* * * * *" for independent RecoverySweeper');
  }

  // Strict zero-collision check against every V1 staging config
  for (const v1Config of v1Configs) {
    const v1Res = collectResourceNames(v1Config);
    if (v2Res.name && v2Res.name === v1Res.name) {
      errors.push(`worker name collides with V1: ${v2Res.name}`);
    }
    for (const q of v2Res.queues) {
      if (v1Res.queues.has(q)) errors.push(`queue collides with V1: ${q}`);
    }
    for (const d of v2Res.d1Names) {
      if (v1Res.d1Names.has(d)) errors.push(`D1 database name collides with V1: ${d}`);
    }
    for (const id of v2Res.d1Ids) {
      if (v1Res.d1Ids.has(id)) errors.push(`D1 database_id collides with V1: ${id}`);
    }
    for (const b of v2Res.r2Buckets) {
      if (v1Res.r2Buckets.has(b)) errors.push(`R2 bucket collides with V1: ${b}`);
    }
    for (const h of v2Res.hyperdriveIds) {
      if (v1Res.hyperdriveIds.has(h)) errors.push(`Hyperdrive ID collides with V1: ${h}`);
    }
    for (const r of v2Res.routes) {
      if (v1Res.routes.has(r)) errors.push(`route collides with V1: ${r}`);
    }
  }

  return { ok: errors.length === 0, errors, notices };
}

function runCommand(commandName, args, cwd, { capture = false } = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(commandName, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
    }
    child.once('error', rejectCommand);
    child.once('close', (code) => {
      if (code !== 0) {
        rejectCommand(new Error(`${commandName} exited with status ${code ?? 'unknown'}`));
        return;
      }
      resolveCommand({ stdout, stderr });
    });
  });
}

/**
 * Validate bound secret names for G3 real-LLM canary.
 * EMBER_V2_STAGING_ALLOWED_SUBJECTS is optional because real-mode login enforces
 * the derived-tenant allowlist against EMBER_MODEL_ALPHA_TENANT_IDS.
 */
export function validateRealCanarySecretNames(secretNames) {
  const names = new Set(secretNames);
  const errors = [];
  const notices = [];
  const missing = REQUIRED_REAL_CANARY_SECRETS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    errors.push(`Missing required G3 staging secrets: ${missing.join(', ')}`);
  }
  if (names.has('DAYTONA_API_KEY')) {
    errors.push('DAYTONA_API_KEY must NOT be bound during G3 real-LLM canary');
  }
  if (!names.has('EMBER_V2_STAGING_ALLOWED_SUBJECTS')) {
    notices.push(
      'EMBER_V2_STAGING_ALLOWED_SUBJECTS is not bound; G3 real-mode login enforces derived-tenant allowlist via EMBER_MODEL_ALPHA_TENANT_IDS.',
    );
  }
  return { ok: errors.length === 0, errors, notices };
}

async function verifyRealCanarySecrets(repoRoot) {
  const { stdout } = await runCommand(
    'pnpm',
    [
      '--filter',
      '@ember/api',
      'exec',
      'wrangler',
      'secret',
      'list',
      '--name',
      'ember-v2-staging',
      '--config',
      'wrangler.v2-staging.jsonc',
    ],
    repoRoot,
    { capture: true },
  );
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('Unexpected wrangler secret list output');
  }
  const names = parsed.map((entry) => entry?.name).filter(Boolean);
  const result = validateRealCanarySecretNames(names);
  for (const notice of result.notices) {
    process.stdout.write(`[notice] ${notice}\n`);
  }
  if (!result.ok) {
    throw new Error(result.errors.join('; '));
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const skipWrangler = args.has('--skip-wrangler');
  const requireProvisioned = args.has('--require-provisioned');
  const allowRealLlmCanary = args.has('--allow-real-llm-canary');
  const modelModeReal = args.has('--model-mode=real');
  const verifySecrets = args.has('--verify-secrets');
  const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

  const v2Path = resolve(repoRoot, 'apps/api/wrangler.v2-staging.jsonc');
  const v1Paths = [
    resolve(repoRoot, 'apps/api/wrangler.staging.jsonc'),
    resolve(repoRoot, 'apps/cloud-async-runtime/wrangler.staging.jsonc'),
  ];
  const migrationPath = resolve(
    repoRoot,
    'packages/runtime-v2/migrations/0001_v2_recovery_registry.sql',
  );

  const [v2Source, ...v1Sources] = await Promise.all([
    readFile(v2Path, 'utf8'),
    ...v1Paths.map((p) => readFile(p, 'utf8')),
  ]);

  const v2Config = parseJsonc(v2Source);
  if (modelModeReal) {
    v2Config.vars = {
      ...(v2Config.vars ?? {}),
      ...(allowRealLlmCanary ? G3_REAL_CANARY_VARS : { EMBER_MODEL_MODE: 'real' }),
    };
  }

  const result = validateV2StagingConfig({
    v2Config,
    v1Configs: v1Sources.map(parseJsonc),
    migrationExists: existsSync(migrationPath),
    requireProvisioned,
    allowRealLlmCanary,
  });

  for (const notice of result.notices) {
    process.stdout.write(`[notice] ${notice}\n`);
  }

  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`[error] ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('V2 staging config isolation and safety checks passed.\n');

  if (verifySecrets) {
    if (!allowRealLlmCanary) {
      throw new Error('--verify-secrets requires --allow-real-llm-canary');
    }
    await verifyRealCanarySecrets(repoRoot);
    process.stdout.write('V2 staging G3 canary secret bindings verified.\n');
  }

  if (!skipWrangler) {
    process.stdout.write('Running local Wrangler bundle dry-run (no cloud resources touched)...\n');
    const canaryVarFlags =
      modelModeReal && allowRealLlmCanary
        ? Object.entries(G3_REAL_CANARY_VARS).flatMap(([key, value]) => [
            '--var',
            `${key}:${value}`,
          ])
        : [];
    await runCommand(
      'pnpm',
      [
        '--filter',
        '@ember/api',
        'exec',
        'wrangler',
        'deploy',
        '--dry-run',
        '--config',
        'wrangler.v2-staging.jsonc',
        ...canaryVarFlags,
      ],
      repoRoot,
    );
    process.stdout.write('V2 staging Wrangler dry-run passed.\n');
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`V2 staging preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
