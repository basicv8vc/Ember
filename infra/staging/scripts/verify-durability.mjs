#!/usr/bin/env node
/**
 * Staging acceptance harness: restart durability and log redaction.
 *
 * This runs the compiled artifacts that the staging images run (`apps/api/dist`,
 * `apps/worker/dist`) as real processes against a real PostgreSQL 17 database, and asserts
 * the two properties that a deployment can silently break:
 *
 *   A-5  A pending Turn survives a Worker being absent or restarted: it is discovered from
 *        PostgreSQL and completed by a fresh Worker.
 *   A-6  Conversation history is still readable after an API restart, using a Session token
 *        minted before the restart.
 *   A-9  Neither process writes a session token, a provider assertion or a message body to
 *        its logs.
 *
 * Sign-in uses the isolated development provider, which is a loopback-only, test-only path
 * (it can never be enabled on staging — that is what the preflight guard enforces). The
 * point of this harness is durability and redaction, not staging authentication.
 *
 *   node infra/staging/scripts/verify-durability.mjs \
 *     --admin-database-url postgres://ember:...@127.0.0.1:55433/ember_staging_verify
 */

import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DATABASE_NAME = 'ember_staging_durability';
const API_PORT = Number(process.env.EMBER_DURABILITY_PORT || 19611);
const BLOB_ROOT = '/tmp/ember-staging-durability-blobs';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--admin-database-url') {
      args.adminDatabaseUrl = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

/** Minimal child-process wrapper that records output for the redaction scan. */
class Process {
  constructor(command, args, env) {
    this.output = '';
    this.child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        this.output += chunk;
      });
    }
    this.exited = new Promise((resolve) => this.child.once('exit', resolve));
  }

  async stop(signal = 'SIGTERM') {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    this.child.kill(signal);
    await Promise.race([this.exited, delay(15_000)]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
      await this.exited;
    }
  }

  kill(signal) {
    this.child.kill(signal);
  }
}

async function waitFor(predicate, { timeoutMs, intervalMs = 100, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function http(path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function psql(adminUrl, sql, database = 'postgres') {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [url.toString(), '-t', '-A', '-c', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.once('exit', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`psql failed (${code}): ${err.split('\n')[0]}`));
    });
  });
}

async function main() {
  const { adminDatabaseUrl } = parseArgs(process.argv.slice(2));
  const admin = adminDatabaseUrl ?? process.env.ADMIN_DATABASE_URL;

  if (!admin) {
    process.stderr.write('usage: verify-durability.mjs --admin-database-url postgres://...\n');
    process.exit(2);
  }

  const target = new URL(admin);
  target.pathname = `/${DATABASE_NAME}`;
  const databaseUrl = target.toString();
  const baseEnv = {
    PATH: process.env.PATH,
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    EMBER_ENV: 'test',
    EMBER_LOG_LEVEL: 'info',
  };

  rmSync(BLOB_ROOT, { recursive: true, force: true });
  mkdirSync(BLOB_ROOT, { recursive: true });

  process.stdout.write(`database: ${target.host}/${DATABASE_NAME}\n`);
  await psql(admin, `DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
  await psql(admin, `CREATE DATABASE "${DATABASE_NAME}"`);

  const migrate = spawn('node', ['packages/postgres/dist/cli/migrate.js'], {
    cwd: REPO_ROOT,
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    migrate.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('migrate failed'))));
  });
  record('migrations apply to a fresh database', true, DATABASE_NAME);

  const apiEnv = {
    ...baseEnv,
    EMBER_HOST: '127.0.0.1',
    EMBER_PORT: String(API_PORT),
    EMBER_DEV_PROVIDER_ENABLED: 'true',
    EMBER_DEV_PROVIDER_ISOLATED: 'true',
    EMBER_APPLE_BUNDLE_ID: 'com.ember.mobile',
  };
  const workerEnv = {
    ...baseEnv,
    EMBER_WORKER_MODE: 'poll',
    EMBER_WORKER_SIMULATED_EXECUTION: 'local-only',
    EMBER_WORKER_BLOB_ROOT: BLOB_ROOT,
    EMBER_WORKER_ID: 'staging-durability-worker',
    EMBER_WORKER_INTERVAL_MS: '200',
    EMBER_WORKER_ERROR_BACKOFF_MS: '100',
    EMBER_WORKER_LEASE_MS: '5000',
    EMBER_WORKER_HEARTBEAT_MS: '1000',
    EMBER_B1_FAKE_RESPONDER_ENABLED: 'true',
  };

  const processes = [];
  const startApi = async () => {
    const api = new Process('node', ['apps/api/dist/index.js'], apiEnv);
    processes.push(api);
    await waitFor(
      async () => {
        try {
          const health = await http('/healthz');
          return health.status === 200;
        } catch {
          return false;
        }
      },
      { timeoutMs: 20_000, label: 'API /healthz' },
    );
    return api;
  };

  // ---- 1. Sign in and submit a message with NO Worker running -------------------------
  let api = await startApi();
  const assertion = `durability-assertion-${randomBytes(16).toString('hex')}`;
  const nonce = `durability-nonce-${randomBytes(16).toString('hex')}`;
  const messageText = `durability-private-${randomBytes(12).toString('hex')}`;

  const session = await http('/v1/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'dev', identity_token: assertion, nonce }),
  });
  if (session.status !== 201) {
    throw new Error(`session creation failed with HTTP ${session.status}`);
  }
  const token = session.body.access_token;

  const me = await http('/v1/me', { headers: { authorization: `Bearer ${token}` } });
  const conversationId = me.body.conversation.conversation_id;

  const submissionId = randomUUID();
  const submitted = await http(`/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      client_submission_id: submissionId,
      text: messageText,
      transcript_epoch: me.body.conversation.transcript_epoch,
    }),
  });
  record(
    'message accepted with no Worker running',
    submitted.status === 201,
    `turn ${submitted.body?.turn?.turn_id}`,
  );
  const turnId = submitted.body.turn.turn_id;

  // ---- 2. Restart the API -------------------------------------------------------------
  await api.stop('SIGTERM');
  api = await startApi();
  record('API restarted', true, 'SIGTERM then fresh process');

  // ---- 3. Conversation history is readable with the pre-restart token -----------------
  const page = await http(`/v1/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const userMessagePresent =
    page.status === 200 &&
    Array.isArray(page.body?.messages) &&
    page.body.messages.some((message) => message.text === messageText);
  record('A-6 conversation history readable after API restart', userMessagePresent);

  // ---- 4. The pending Turn survived; a fresh Worker finishes it ------------------------
  const beforeWorker = await http(`/v1/conversations/${conversationId}/turns/${turnId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  record(
    'A-5 pending Turn persisted across the restart',
    beforeWorker.status === 200 && beforeWorker.body.status === 'running',
    `status=${beforeWorker.body?.status}`,
  );

  const worker = new Process('node', ['apps/worker/dist/index.js'], workerEnv);
  processes.push(worker);

  const completed = await waitFor(
    async () => {
      const turn = await http(`/v1/conversations/${conversationId}/turns/${turnId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return turn.status === 200 && turn.body.status === 'completed' ? turn.body : false;
    },
    { timeoutMs: 40_000, intervalMs: 250, label: 'turn completion by a fresh Worker' },
  );
  record(
    'A-5 fresh Worker recovered and completed the pending Turn',
    true,
    `status=${completed.status}`,
  );

  // ---- 5. The Worker restarts mid-life and the stack stays consistent ------------------
  await worker.stop('SIGTERM');
  const restartedWorker = new Process('node', ['apps/worker/dist/index.js'], workerEnv);
  processes.push(restartedWorker);
  await delay(1500);
  record(
    'A-5 Worker restarted cleanly and stayed healthy',
    restartedWorker.child.exitCode === null,
  );

  const finalPage = await http(`/v1/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const assistantPresent =
    finalPage.status === 200 && finalPage.body.messages.some((message) => message.kind === 'ember');
  record('A-6 assistant reply persisted in the transcript', assistantPresent);

  // ---- 6. Log redaction ---------------------------------------------------------------
  await Promise.all(processes.map((process) => process.stop('SIGTERM')));

  const logs = processes.map((process) => process.output).join('\n');
  const secrets = [
    ['session token', token],
    ['provider assertion', assertion],
    ['authentication nonce', nonce],
    ['private message text', messageText],
    ['database password', new URL(admin).password],
  ];
  const leaked = secrets.filter(([, value]) => value && value.length > 0 && logs.includes(value));
  record(
    'A-9 no credential or private body in process logs',
    leaked.length === 0,
    leaked.length === 0
      ? `${logs.split('\n').length} log lines scanned`
      : leaked.map(([name]) => name).join(', '),
  );

  // ---- 7. Cleanup ---------------------------------------------------------------------
  await psql(admin, `DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
  rmSync(BLOB_ROOT, { recursive: true, force: true });

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`durability check failed: ${error?.message ?? 'unknown'}\n`);
  process.exit(1);
});
