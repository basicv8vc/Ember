#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_V2_STAGING_URL = 'https://ember-v2-staging.slowfast.dev';
export const DEFAULT_V1_API_URL = 'https://ember-api.slowfast.dev';

async function fetchJson(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    ...init,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

/**
 * Verify the isolated V2 staging edge and confirm V1 non-regression.
 * Performs read-only / unauthenticated checks only; never mints credentials or triggers model spend.
 */
export async function runV2StagingSmoke({
  v2BaseUrl = DEFAULT_V2_STAGING_URL,
  v1BaseUrl = DEFAULT_V1_API_URL,
  checkV1 = true,
  fetchImpl = fetch,
} = {}) {
  const checks = [];
  const errors = [];

  const v2Health = await fetchJson(fetchImpl, `${v2BaseUrl}/healthz`);
  const v2HealthOk = v2Health.status === 200 && v2Health.body?.status === 'ok';
  checks.push({ name: 'v2_healthz', ok: v2HealthOk, status: v2Health.status });
  if (!v2HealthOk) errors.push(`V2 /healthz failed (HTTP ${v2Health.status})`);

  const v2Ready = await fetchJson(fetchImpl, `${v2BaseUrl}/readyz`);
  const v2ReadyOk =
    v2Ready.status === 200 &&
    v2Ready.body?.status === 'ready' &&
    v2Ready.body?.checks?.d1_recovery?.status === 'up';
  checks.push({
    name: 'v2_readyz',
    ok: v2ReadyOk,
    status: v2Ready.status,
    latencyMs: v2Ready.body?.checks?.d1_recovery?.latencyMs ?? null,
  });
  if (!v2ReadyOk) errors.push(`V2 /readyz D1 check failed (HTTP ${v2Ready.status})`);

  const v2AnonMe = await fetchJson(fetchImpl, `${v2BaseUrl}/v1/me`);
  const v2AnonMeOk = v2AnonMe.status === 401 && v2AnonMe.body?.error?.code === 'UNAUTHENTICATED';
  checks.push({ name: 'v2_me_unauthenticated', ok: v2AnonMeOk, status: v2AnonMe.status });
  if (!v2AnonMeOk) errors.push(`V2 /v1/me anonymous check failed (HTTP ${v2AnonMe.status})`);

  const v2AnonMemories = await fetchJson(fetchImpl, `${v2BaseUrl}/v2/memories`);
  const v2AnonMemoriesOk =
    v2AnonMemories.status === 401 && v2AnonMemories.body?.error?.code === 'UNAUTHENTICATED';
  checks.push({
    name: 'v2_memories_unauthenticated',
    ok: v2AnonMemoriesOk,
    status: v2AnonMemories.status,
  });
  if (!v2AnonMemoriesOk) {
    errors.push(`V2 /v2/memories anonymous check failed (HTTP ${v2AnonMemories.status})`);
  }

  const v2AnonSchedules = await fetchJson(fetchImpl, `${v2BaseUrl}/v2/schedules`);
  const v2AnonSchedulesOk =
    v2AnonSchedules.status === 401 && v2AnonSchedules.body?.error?.code === 'UNAUTHENTICATED';
  checks.push({
    name: 'v2_schedules_unauthenticated',
    ok: v2AnonSchedulesOk,
    status: v2AnonSchedules.status,
  });
  if (!v2AnonSchedulesOk) {
    errors.push(`V2 /v2/schedules anonymous check failed (HTTP ${v2AnonSchedules.status})`);
  }

  const v2DevDenied = await fetchJson(fetchImpl, `${v2BaseUrl}/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'dev',
      identity_token: 'smoke-probe-dev-denied',
      nonce: 'smoke-probe-nonce-0000000000000000',
    }),
  });
  const v2DevDeniedOk = v2DevDenied.status >= 400 && v2DevDenied.status < 500;
  checks.push({ name: 'v2_dev_provider_denied', ok: v2DevDeniedOk, status: v2DevDenied.status });
  if (!v2DevDeniedOk) {
    errors.push(`V2 /v1/auth/session dev-denial check failed (HTTP ${v2DevDenied.status})`);
  }

  if (checkV1) {
    const v1Health = await fetchJson(fetchImpl, `${v1BaseUrl}/healthz`);
    const v1HealthOk = v1Health.status === 200 && v1Health.body?.status === 'ok';
    checks.push({ name: 'v1_healthz', ok: v1HealthOk, status: v1Health.status });
    if (!v1HealthOk) errors.push(`V1 /healthz non-regression failed (HTTP ${v1Health.status})`);

    const v1Ready = await fetchJson(fetchImpl, `${v1BaseUrl}/readyz`);
    const v1ReadyOk =
      v1Ready.status === 200 &&
      v1Ready.body?.status === 'ready' &&
      v1Ready.body?.checks?.database?.status === 'up';
    checks.push({
      name: 'v1_readyz',
      ok: v1ReadyOk,
      status: v1Ready.status,
      latencyMs: v1Ready.body?.checks?.database?.latencyMs ?? null,
    });
    if (!v1ReadyOk) errors.push(`V1 /readyz non-regression failed (HTTP ${v1Ready.status})`);
  }

  return { ok: errors.length === 0, checks, errors };
}

async function main() {
  const args = process.argv.slice(2);
  const skipV1 = args.includes('--skip-v1');
  const v2BaseUrl = process.env.EMBER_V2_STAGING_URL ?? DEFAULT_V2_STAGING_URL;
  const v1BaseUrl = process.env.EMBER_V1_API_URL ?? DEFAULT_V1_API_URL;

  const result = await runV2StagingSmoke({ v2BaseUrl, v1BaseUrl, checkV1: !skipV1 });
  for (const check of result.checks) {
    const latency = check.latencyMs == null ? '' : ` (${check.latencyMs}ms)`;
    process.stdout.write(
      `[${check.ok ? 'PASS' : 'FAIL'}] ${check.name}: HTTP ${check.status}${latency}\n`,
    );
  }
  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`[error] ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('EMBER_V2_STAGING_SMOKE_OK\n');
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`V2 staging smoke failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
