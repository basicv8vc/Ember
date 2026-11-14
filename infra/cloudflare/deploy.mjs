#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const cloudApiBaseUrl = 'https://ember-cloud-api-staging.10kpaper.workers.dev';
const neonProjectId = 'silent-boat-95177889';
const neonBranch = 'staging';
const neonDatabase = 'ember_staging';
const neonMigrationRole = 'ember_staging_migrator';
const dryRun = process.argv.slice(2).includes('--dry-run');

const workers = [
  {
    label: 'API',
    packageName: '@ember/api',
    name: 'ember-cloud-api-staging',
    config: 'wrangler.staging.jsonc',
    configPath: 'apps/api/wrangler.staging.jsonc',
  },
  {
    label: 'Async Runtime',
    packageName: '@ember/cloud-async-runtime',
    name: 'ember-assistant-turn-runtime-staging',
    config: 'wrangler.staging.jsonc',
    configPath: 'apps/cloud-async-runtime/wrangler.staging.jsonc',
  },
];

function command(commandName, args, options = {}) {
  const { capture = false, env = process.env } = options;
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(commandName, args, {
      cwd: repoRoot,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
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

function wranglerArgs(worker, args) {
  return ['--filter', worker.packageName, 'exec', 'wrangler', ...args, '--config', worker.config];
}

async function assertCloudTarget() {
  for (const worker of workers) {
    const source = await readFile(resolve(repoRoot, worker.configPath), 'utf8');
    if (
      !source.includes(`"name": "${worker.name}"`) ||
      !source.includes('"EMBER_ENV": "staging"')
    ) {
      throw new Error(`refusing deployment: ${worker.configPath} does not identify Ember Cloud`);
    }
  }
}

async function activeVersion(worker) {
  const result = await command(
    'pnpm',
    wranglerArgs(worker, ['deployments', 'list', '--name', worker.name, '--json']),
    { capture: true },
  );
  const deployments = JSON.parse(result.stdout);
  const latestDeployment = deployments
    .filter((deployment) => Number.isFinite(Date.parse(deployment.created_on)))
    .sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on))[0];
  const versions = latestDeployment?.versions ?? [];
  if (versions.length !== 1 || versions[0].percentage !== 100) {
    throw new Error(
      `refusing deployment: ${worker.name} has no single 100% version in its latest deployment`,
    );
  }
  process.stdout.write(`Rollback target for ${worker.name}: ${versions[0].version_id}\n`);
  return versions[0].version_id;
}

async function assertRuntimeSecrets() {
  const runtime = workers[1];
  const result = await command(
    'pnpm',
    wranglerArgs(runtime, ['secret', 'list', '--name', runtime.name]),
    { capture: true },
  );
  const secrets = JSON.parse(result.stdout);
  const names = new Set(secrets.map((secret) => secret.name));
  for (const name of ['EMBER_MODEL_API_KEY', 'EMBER_MODEL_ALPHA_TENANT_IDS']) {
    if (!names.has(name)) {
      throw new Error(`required Ember Cloud Runtime secret is missing: ${name}`);
    }
  }
}

async function migrationConnectionString() {
  const result = await command(
    'neon',
    [
      'connection-string',
      neonBranch,
      '--project-id',
      neonProjectId,
      '--role-name',
      neonMigrationRole,
      '--database-name',
      neonDatabase,
      '--ssl',
      'verify-full',
    ],
    { capture: true },
  );
  const connectionString = result.stdout.trim();
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('Neon CLI did not return a valid migration connection');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !parsed.hostname.endsWith('.neon.tech') ||
    parsed.pathname !== `/${neonDatabase}` ||
    decodeURIComponent(parsed.username) !== neonMigrationRole
  ) {
    throw new Error('Neon migration connection did not match the Ember Cloud target');
  }
  return connectionString;
}

async function verifyApi() {
  const request = async (path) => {
    const response = await fetch(`${cloudApiBaseUrl}${path}`, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null);
    return { response, body };
  };

  const health = await request('/healthz');
  if (!health.response.ok || health.body?.status !== 'ok') {
    throw new Error(`/healthz verification failed (${health.response.status})`);
  }

  const readiness = await request('/readyz');
  if (
    !readiness.response.ok ||
    readiness.body?.status !== 'ready' ||
    readiness.body?.checks?.database?.status !== 'up'
  ) {
    throw new Error(`/readyz database verification failed (${readiness.response.status})`);
  }

  const auth = await request('/v1/me');
  if (auth.response.status !== 401 || auth.body?.error?.code !== 'UNAUTHENTICATED') {
    throw new Error(`/v1/me anonymous-auth verification failed (${auth.response.status})`);
  }
}

async function rollback(worker, versionId) {
  await command(
    'pnpm',
    wranglerArgs(worker, [
      'rollback',
      versionId,
      '--name',
      worker.name,
      '--yes',
      '--message',
      'Ember Cloud health verification failed; restored previous version',
    ]),
  );
  process.stdout.write(`Restored ${worker.name} to ${versionId}\n`);
}

async function deploy() {
  await assertCloudTarget();
  await command('pnpm', ['--filter', '@ember/api', 'exec', 'wrangler', 'whoami']);
  await assertRuntimeSecrets();

  // Capture the active versions before any mutating operation. These are the rollback targets.
  const previousVersions = new Map();
  for (const worker of workers) {
    previousVersions.set(worker.name, await activeVersion(worker));
  }

  // Build workspace package exports before Wrangler bundles the Workers.
  await command('pnpm', ['build']);

  for (const worker of workers) {
    await command('pnpm', wranglerArgs(worker, ['deploy', '--dry-run']));
  }

  if (dryRun) {
    process.stdout.write(
      'Ember Cloud preflight passed; no migration or deployment was performed.\n',
    );
    return;
  }

  const databaseUrl = await migrationConnectionString();
  process.stdout.write(`Applying migrations to Neon ${neonBranch}/${neonDatabase}\n`);
  await command('pnpm', ['db:migrate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, EMBER_ENV: 'staging' },
  });

  const attempted = [];
  try {
    for (const worker of workers) {
      attempted.push(worker);
      await command(
        'pnpm',
        wranglerArgs(worker, ['deploy', '--message', `Ember Cloud ${worker.label}`]),
      );
      if (worker.label === 'API') {
        await verifyApi();
        process.stdout.write('API, database readiness, and anonymous auth checks passed.\n');
      }
    }
    await verifyApi();

    const sha = (await command('git', ['rev-parse', 'HEAD'], { capture: true })).stdout.trim();
    process.stdout.write(`EMBER_CLOUD_READY ${sha} ${cloudApiBaseUrl}\n`);
  } catch (error) {
    process.stderr.write(`Deployment verification failed: ${error.message}\n`);
    for (const worker of attempted.reverse()) {
      try {
        await rollback(worker, previousVersions.get(worker.name));
      } catch (rollbackError) {
        process.stderr.write(`Rollback failed for ${worker.name}: ${rollbackError.message}\n`);
      }
    }
    throw error;
  }
}

deploy().catch((error) => {
  process.stderr.write(`Ember Cloud deployment stopped: ${error.message}\n`);
  process.exitCode = 1;
});
