#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNPROVISIONED_D1_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
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

/**
 * Validate an isolated V2 staging Wrangler config against V1 staging configs.
 */
export function validateV2StagingConfig({
  v2Config,
  v1Configs,
  migrationExists = true,
  requireProvisioned = false,
}) {
  const errors = [];
  const notices = [];

  if (v2Config.name !== 'ember-v2-staging') {
    errors.push(`expected worker name "ember-v2-staging", got ${JSON.stringify(v2Config.name)}`);
  }
  if (v2Config.vars?.EMBER_ENV !== 'v2-staging') {
    errors.push(
      `expected vars.EMBER_ENV === "v2-staging", got ${JSON.stringify(v2Config.vars?.EMBER_ENV)}`,
    );
  }
  if (v2Config.vars?.EMBER_MODEL_MODE !== 'fake') {
    errors.push(
      `V2 staging must keep vars.EMBER_MODEL_MODE === "fake" until separate provider-canary approval (got ${JSON.stringify(v2Config.vars?.EMBER_MODEL_MODE)})`,
    );
  }
  if (v2Config.vars?.EMBER_SANDBOX_MODE !== 'fake') {
    errors.push(
      `V2 staging must keep vars.EMBER_SANDBOX_MODE === "fake" until separate Daytona canary approval (got ${JSON.stringify(v2Config.vars?.EMBER_SANDBOX_MODE)})`,
    );
  }
  if (v2Config.vars?.EMBER_V2_STAGING_ISOLATED !== 'true') {
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

function runCommand(commandName, args, cwd) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(commandName, args, {
      cwd,
      stdio: 'inherit',
    });
    child.once('error', rejectCommand);
    child.once('close', (code) => {
      if (code !== 0) {
        rejectCommand(new Error(`${commandName} exited with status ${code ?? 'unknown'}`));
        return;
      }
      resolveCommand();
    });
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const skipWrangler = args.has('--skip-wrangler');
  const requireProvisioned = args.has('--require-provisioned');
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

  const result = validateV2StagingConfig({
    v2Config: parseJsonc(v2Source),
    v1Configs: v1Sources.map(parseJsonc),
    migrationExists: existsSync(migrationPath),
    requireProvisioned,
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

  if (!skipWrangler) {
    process.stdout.write('Running local Wrangler bundle dry-run (no cloud resources touched)...\n');
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
