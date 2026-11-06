#!/usr/bin/env node
/**
 * Cloud staging full-lifecycle HTTP E2E (acceptance).
 *
 * Drives the REAL staging topology — postgres 17, API container, Worker container, Caddy
 * edge with TLS — through HTTP only, with B2's deterministic Fake Model producing the
 * assistant reply:
 *
 *   E-1  migrations apply (16) and re-run idempotently
 *   E-2  user authentication: real POST /v1/auth/session on a loopback one-shot (the only
 *        legal sign-in shape offline), then every call through the TLS edge with the
 *        issued session token
 *   E-3  conversation surfaced by GET /v1/me (auto-provisioned at sign-in)
 *   E-4  message accepted (201 + running Turn)
 *   E-5  Worker executes the Turn through the Model Gateway (fake) and persists the
 *        Assistant reply (kind "ember", simulated: true, label ember-fake-model-gateway-1)
 *   E-6  iOS read path: the reply is visible through GET .../messages over TLS
 *   E-7  Worker restart recovery: a Turn submitted while the Worker is stopped is not
 *        lost and is completed by the fresh Worker process
 *   E-8  API restart durability: history readable with the pre-restart token
 *   E-9  auth negatives on the public listener: no credential 401, forged Apple assertion
 *        401, dev sign-in 404, legacy dev bearer 401
 *   E-10 real model mode off: responder runs `fake`, no provider credential anywhere
 *   E-11 log redaction: no token, assertion or message body in api/worker logs
 *
 * Usage:
 *   node infra/staging/scripts/cloud-e2e.mjs --env-file /tmp/ember-staging-e2e.env [--keep]
 *
 * The env file must pass `preflight.sh --mode=e2e`. The script owns the compose project
 * named by EMBER_VOLUME_PREFIX and tears it down afterwards unless `--keep` is given.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnvFile } from './preflight.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT_DIR = fileURLToPath(new URL('./', import.meta.url));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function parseArgs(argv) {
  const args = { keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--env-file') {
      args.envFile = argv[i + 1];
      i += 1;
    } else if (token.startsWith('--env-file=')) {
      args.envFile = token.slice('--env-file='.length);
    } else if (token === '--keep') {
      args.keep = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.envFile || !existsSync(args.envFile)) {
  process.stderr.write('usage: cloud-e2e.mjs --env-file <path> [--keep]\n');
  process.exit(2);
}

const envMap = parseEnvFile(readFileSync(args.envFile, 'utf8'));
const envGet = (key, fallback) => envMap.get(key) ?? fallback;

const PROJECT = envGet('EMBER_VOLUME_PREFIX', 'ember-staging-e2e');
const HOSTNAME = envGet('EMBER_STAGING_HOSTNAME', 'localhost');
const HTTPS_PORT = envGet('EMBER_EDGE_HTTPS_PORT', '443');
const BASE_URL = HTTPS_PORT === '443' ? `https://${HOSTNAME}` : `https://${HOSTNAME}:${HTTPS_PORT}`;
const PASSWORD_FILE = envGet('EMBER_POSTGRES_PASSWORD_FILE', '');
const DB_PASSWORD =
  PASSWORD_FILE && existsSync(PASSWORD_FILE) ? readFileSync(PASSWORD_FILE, 'utf8').trim() : '';

const composeArgs = [
  'compose',
  '-p',
  PROJECT,
  '--env-file',
  args.envFile,
  '-f',
  `${REPO_ROOT}infra/staging/compose.yaml`,
];

/** Internal CA certificate (Caddy local authority), extracted before the first TLS call. */
let caCert = '';

function compose(command, { capture = true, allowFail = false } = {}) {
  const result = spawnSync('docker', [...composeArgs, ...command], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, EMBER_STAGING_ENV_FILE: args.envFile },
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `docker compose ${command.join(' ')} failed (${result.status}):\n${output.slice(-2000)}`,
    );
  }
  return capture ? output : '';
}

/** HTTPS request against the edge with the internal CA. */
function edgeRequest(path, { method = 'GET', token, body } = {}) {
  const url = new URL(path, BASE_URL);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { accept: 'application/json' };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
  }

  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        ca: caCert,
        servername: url.hostname,
        timeout: 15_000,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => {
          let parsed;
          try {
            parsed = text === '' ? undefined : JSON.parse(text);
          } catch {
            parsed = text;
          }
          resolve({ status: response.statusCode, headers: response.headers, body: parsed, text });
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', reject);
    if (payload !== undefined) {
      request.write(payload);
    }
    request.end();
  });
}

async function waitForReply({ token, conversationId, afterSequence, label, timeoutMs = 60_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await edgeRequest(`/v1/conversations/${conversationId}/messages`, { token });
    if (page.status === 200 && Array.isArray(page.body?.messages)) {
      const reply = page.body.messages.find(
        (message) => message.sequence > afterSequence && message.kind === 'ember',
      );
      if (reply !== undefined) {
        return { reply, page: page.body };
      }
    }
    await delay(500);
  }
  throw new Error(`timed out waiting for assistant reply (${label})`);
}

async function main() {
  // ---- 0. Secret file hygiene -----------------------------------------------------------
  if (PASSWORD_FILE && !existsSync(PASSWORD_FILE)) {
    mkdirSync(PASSWORD_FILE.slice(0, PASSWORD_FILE.lastIndexOf('/')), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(PASSWORD_FILE, DB_PASSWORD || randomBytes(24).toString('hex'), { mode: 0o600 });
  }

  const expectedMigrations = spawnSync('bash', ['-c', 'ls migrations/*.sql | wc -l'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).stdout.trim();

  process.stdout.write(
    `project: ${PROJECT}\nbase url: ${BASE_URL}\nmigrations on disk: ${expectedMigrations}\n`,
  );

  try {
    // The e2e project owns its prefixed volumes: start from a clean slate so the
    // throwaway password generated for this run always matches the database.
    compose(['down', '--volumes', '--remove-orphans'], { allowFail: true });

    // ---- 1. PostgreSQL + migrations ----------------------------------------------------
    compose(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres']);
    record('E-1a PostgreSQL 17 starts healthy', true);

    const run1 = compose(['--profile', 'tools', 'run', '--rm', 'migrate']);
    const applied1 = /migrations complete: (\d+) applied, (\d+) already applied/.exec(run1);
    record(
      `E-1b migrations apply (${expectedMigrations} on disk)`,
      applied1 !== null && Number(applied1[1]) === Number(expectedMigrations),
      applied1 ? applied1[0].trim() : run1.slice(-300),
    );

    const run2 = compose(['--profile', 'tools', 'run', '--rm', 'migrate']);
    const applied2 = /migrations complete: (\d+) applied, (\d+) already applied/.exec(run2);
    record(
      'E-1c re-run is a no-op (idempotent)',
      applied2 !== null &&
        Number(applied2[1]) === 0 &&
        Number(applied2[2]) === Number(expectedMigrations),
      applied2 ? applied2[0].trim() : run2.slice(-300),
    );

    // ---- 2. Stack up -------------------------------------------------------------------
    compose(['up', '-d', '--wait', '--wait-timeout', '240', 'api', 'worker', 'edge']);
    record('E-2a api/worker/edge containers start healthy', true);

    // Internal CA from the edge volume, for every HTTPS assertion below.
    const caVolume = `${PROJECT}-caddy-data`;
    const ca = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${caVolume}:/data:ro`,
        'alpine:3',
        'cat',
        '/data/caddy/pki/authorities/local/root.crt',
      ],
      { encoding: 'utf8' },
    );
    if (ca.status !== 0 || !ca.stdout.includes('BEGIN CERTIFICATE')) {
      throw new Error(`could not extract internal CA: ${ca.stderr}`);
    }
    caCert = ca.stdout;

    // ---- 3. Sign in through the real auth route -----------------------------------------
    const signin = spawnSync(
      'docker',
      [
        ...composeArgs,
        'run',
        '--rm',
        '--no-deps',
        '-v',
        `${SCRIPT_DIR}e2e-signin.mjs:/tmp/e2e-signin.mjs:ro`,
        '-e',
        'EMBER_DEV_PROVIDER_ENABLED=true',
        '-e',
        'EMBER_DEV_PROVIDER_ISOLATED=true',
        '-e',
        'EMBER_HOST=127.0.0.1',
        '-e',
        'EMBER_ALLOW_NON_LOOPBACK_BIND=false',
        'api',
        'node',
        '/tmp/e2e-signin.mjs',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, EMBER_STAGING_ENV_FILE: args.envFile },
      },
    );
    const signinLine = (signin.stdout ?? '')
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .pop();
    if (signin.status !== 0 || signinLine === undefined) {
      throw new Error(
        `sign-in one-shot failed (${signin.status}):\n${(signin.stdout ?? '') + (signin.stderr ?? '')}`,
      );
    }
    const { token } = JSON.parse(signinLine);
    record('E-2b POST /v1/auth/session issues a session token', token.startsWith('ems_'));

    // ---- 4. Identity + conversation -----------------------------------------------------
    const me = await edgeRequest('/v1/me', { token });
    const conversationId = me.body?.conversation?.conversation_id;
    const epoch = me.body?.conversation?.transcript_epoch;
    record(
      'E-3 GET /v1/me authenticates and surfaces the conversation',
      me.status === 200 && typeof conversationId === 'string' && typeof epoch === 'number',
      `conversation_id=${conversationId ?? '<none>'}`,
    );

    // ---- 5. Send a message (Worker is up) -----------------------------------------------
    const textA = `e2e-lifecycle-${randomBytes(8).toString('hex')}`;
    const submissionA = randomUUID();
    const sendA = await edgeRequest(`/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      token,
      body: { client_submission_id: submissionA, text: textA, transcript_epoch: epoch },
    });
    const turnIdA = sendA.body?.turn?.turn_id;
    record(
      'E-4 message accepted with a running Turn',
      sendA.status === 201 && sendA.body?.turn?.status === 'running' && typeof turnIdA === 'string',
      `turn_id=${turnIdA ?? '<none>'}`,
    );

    // ---- 6. Worker executes the Turn (Fake Model) ----------------------------------------
    const { reply: replyA, page: pageA } = await waitForReply({
      token,
      conversationId,
      afterSequence: sendA.body?.message?.sequence ?? 0,
      label: 'lifecycle reply',
    });
    record(
      'E-5 Worker persists the Assistant reply (Fake Model)',
      replyA.simulated === true &&
        /fake/.test(replyA.model_label) &&
        replyA.text.startsWith('[Simulated reply'),
      `model_label=${replyA.model_label}`,
    );

    const turnA = await edgeRequest(`/v1/conversations/${conversationId}/turns/${turnIdA}`, {
      token,
    });
    record(
      'E-5b Turn reaches completed with a response message',
      turnA.status === 200 &&
        turnA.body?.status === 'completed' &&
        turnA.body?.response_message_id != null,
      `status=${turnA.body?.status ?? '<none>'}`,
    );

    // ---- 7. iOS read path ----------------------------------------------------------------
    const readBack = await edgeRequest(`/v1/conversations/${conversationId}/messages`, { token });
    const visible = (readBack.body?.messages ?? []).some(
      (message) => message.kind === 'ember' && message.sequence === replyA.sequence,
    );
    record(
      'E-6 iOS read path sees the reply over TLS',
      readBack.status === 200 && visible,
      `messages=${readBack.body?.messages?.length ?? 0}`,
    );

    // ---- 8. Auth negatives on the public listener ------------------------------------------
    const noAuth = await edgeRequest('/v1/me');
    record('E-9a no credential is refused (401)', noAuth.status === 401);

    const forged = await edgeRequest('/v1/auth/session', {
      method: 'POST',
      body: {
        provider: 'apple',
        identity_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJldmUifQ.',
        nonce: randomBytes(8).toString('hex'),
      },
    });
    record(
      'E-9b forged Apple assertion is rejected',
      forged.status === 401 || forged.status === 400,
      `status=${forged.status}`,
    );

    const devOnPublic = await edgeRequest('/v1/auth/session', {
      method: 'POST',
      body: {
        provider: 'dev',
        identity_token: `e2e-assertion-${randomBytes(8).toString('hex')}`,
        nonce: randomBytes(8).toString('hex'),
      },
    });
    record(
      'E-9c dev sign-in is unavailable on the public listener (404)',
      devOnPublic.status === 404,
    );

    const legacyBearer = await edgeRequest('/v1/me', {
      token: `dev-${randomBytes(16).toString('hex')}`,
    });
    record('E-9d legacy dev bearer authenticates nothing (401)', legacyBearer.status === 401);

    // ---- 9. Worker restart recovery --------------------------------------------------------
    compose(['stop', 'worker']);
    const textB = `e2e-restart-${randomBytes(8).toString('hex')}`;
    const sendB = await edgeRequest(`/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      token,
      body: { client_submission_id: randomUUID(), text: textB, transcript_epoch: epoch },
    });
    record(
      'E-7a message accepted while the Worker is stopped',
      sendB.status === 201,
      `turn_id=${sendB.body?.turn?.turn_id ?? '<none>'}`,
    );

    await delay(3000);
    const pending = await edgeRequest(`/v1/conversations/${conversationId}/messages`, { token });
    const repliedEarly = (pending.body?.messages ?? []).some(
      (message) =>
        message.kind === 'ember' && message.sequence > (sendB.body?.message?.sequence ?? 0),
    );
    record('E-7b the pending Turn stays durable while no Worker runs', !repliedEarly);

    compose(['start', 'worker']);
    const { reply: replyB } = await waitForReply({
      token,
      conversationId,
      afterSequence: sendB.body?.message?.sequence ?? 0,
      label: 'restart recovery reply',
    });
    record(
      'E-7c a fresh Worker completes the pending Turn',
      replyB.simulated === true && /fake/.test(replyB.model_label),
      `sequence=${replyB.sequence}`,
    );

    // ---- 10. API restart durability ---------------------------------------------------------
    compose(['restart', 'api']);
    await delay(2000);
    const deadline = Date.now() + 30_000;
    let afterRestart;
    while (Date.now() < deadline) {
      try {
        afterRestart = await edgeRequest(`/v1/conversations/${conversationId}/messages`, { token });
        if (afterRestart.status === 200) {
          break;
        }
      } catch {
        // api still starting
      }
      await delay(500);
    }
    record(
      'E-8 conversation history readable after an API restart (same token)',
      afterRestart?.status === 200 &&
        (afterRestart.body?.messages?.length ?? 0) >= (pageA?.messages?.length ?? 0),
      `messages=${afterRestart?.body?.messages?.length ?? 0}`,
    );

    // ---- 11. Real model mode stays off --------------------------------------------------------
    const workerLogs = compose(['logs', '--no-color', '--tail', '400', 'worker'], {
      allowFail: true,
    });
    const responderLine = workerLogs
      .split('\n')
      .find((line) => line.includes('model assistant turn responder enabled'));
    record(
      'E-10a Worker runs the Model Gateway in fake mode only',
      responderLine !== undefined && responderLine.includes('fake'),
      responderLine ? responderLine.trim().slice(-120) : 'responder log line not found',
    );
    const realMode = envGet('EMBER_MODEL_EXECUTION', 'disabled');
    const providerKeyish = [...envMap.keys()].some((key) =>
      /API_KEY|OPENAI|ANTHROPIC|GEMINI|BEDROCK|E2B/i.test(key),
    );
    record(
      'E-10b environment carries no provider credential and no real mode',
      realMode === 'fake' && !providerKeyish,
      `EMBER_MODEL_EXECUTION=${realMode}`,
    );
    const providerTraffic =
      /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis/i.test(workerLogs);
    record('E-10c Worker logs show no provider endpoint', !providerTraffic);

    // ---- 12. Log redaction ---------------------------------------------------------------------
    const apiLogs = compose(['logs', '--no-color', '--tail', '400', 'api'], { allowFail: true });
    const allLogs = apiLogs + workerLogs;
    const leaks = [token, textA, textB, DB_PASSWORD].filter(
      (secret) => secret.length > 0 && allLogs.includes(secret),
    );
    record(
      'E-11 no token, message body or database password in process logs',
      leaks.length === 0,
      leaks.length === 0 ? undefined : `leaked: ${leaks.length} value(s)`,
    );
  } finally {
    if (!args.keep) {
      try {
        compose(['down', '--remove-orphans'], { allowFail: true });
      } catch {
        // teardown is best-effort
      }
    }
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\ncloud E2E: ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map((result) => result.name).join('; ')}\n`);
    process.exitCode = 1;
  }
}

await main();
