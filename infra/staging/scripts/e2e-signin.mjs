#!/usr/bin/env node
/**
 * E2E session sign-in helper. Runs INSIDE a one-shot container from the API image.
 *
 * The main stack's public listener can never sign a caller in: the dev provider is gated
 * on a loopback listener by design (R-9) and Apple verification needs a real device token.
 * This helper starts the real API entry point bound to loopback with the dev provider
 * legitimately enabled (test markers + isolated opt-in), calls the real
 * `POST /v1/auth/session` route, and prints the issued session token on stdout.
 *
 * The session rows live in the shared staging database, so the token authenticates every
 * subsequent call through the TLS edge exactly like an iOS session would.
 *
 * Output (one JSON line): {"token": "...", "expires_at": "..."}
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = process.env.EMBER_PORT || '8787';
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  EMBER_HOST: '127.0.0.1',
  EMBER_PORT: PORT,
  // R-9: this container binds loopback only, so the dev sign-in gate is legitimately
  // satisfied here and nowhere else in the deployment.
  EMBER_DEV_PROVIDER_ENABLED: 'true',
  EMBER_DEV_PROVIDER_ISOLATED: 'true',
};

const child = spawn('node', ['apps/api/dist/index.js'], {
  cwd: '/app',
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOutput = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => (childOutput += chunk));
child.stderr.on('data', (chunk) => (childOutput += chunk));

function fail(message) {
  process.stderr.write(`e2e-signin: ${message}\n`);
  if (childOutput.length > 0) {
    process.stderr.write(childOutput.slice(-2000));
  }
  child.kill('SIGKILL');
  process.exit(1);
}

try {
  // Wait for the real entry point to answer.
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // not up yet
    }
    if (child.exitCode !== null) {
      fail(`API exited early with code ${child.exitCode}`);
    }
    await delay(200);
  }
  if (!ready) {
    fail('API did not become healthy in time');
  }

  const session = await fetch(`${BASE}/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'dev',
      identity_token: `e2e-assertion-${randomBytes(16).toString('hex')}`,
      nonce: `e2e-nonce-${randomBytes(16).toString('hex')}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await session.json().catch(() => ({}));
  if (session.status !== 201 || typeof body.access_token !== 'string') {
    fail(`sign-in failed with HTTP ${session.status}`);
  }

  process.stdout.write(
    `${JSON.stringify({ token: body.access_token, expires_at: body.expires_at })}\n`,
  );
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}
