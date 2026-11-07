#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

const TIMEOUT_MS = 12_000;
const DUPLICATE_RETRIES = 8;
const results = [];

function usage() {
  process.stdout.write(
    'Usage: pnpm smoke:cloudflare -- --base-url https://ember-cloud-api.<account>.workers.dev --mode preflight|full\n',
  );
}

function parseArgs(args) {
  const options = {
    baseUrl: process.env.EMBER_CLOUDFLARE_SMOKE_BASE_URL ?? '',
    mode: 'preflight',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--base-url') {
      options.baseUrl = args[++index] ?? '';
      continue;
    }
    if (arg === '--mode') {
      options.mode = args[++index] ?? '';
      continue;
    }
    throw new Error('unknown argument');
  }

  if (options.mode !== 'preflight' && options.mode !== 'full') {
    throw new Error('invalid mode');
  }

  const url = new URL(options.baseUrl);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.workers.dev') ||
    !url.hostname.startsWith('ember-cloud-api.') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('base URL must be the HTTPS ember-cloud-api workers.dev origin');
  }

  return { ...options, baseUrl: url.origin };
}

function record(name, state, detail = '') {
  results.push({ name, state, detail });
  const label = state === 'NOT VERIFIED' ? 'NOT VERIFIED' : state;
  process.stdout.write(`${label.padEnd(12)} ${name}${detail ? ` (${detail})` : ''}\n`);
}

async function request(baseUrl, path, { method = 'GET', token, body } = {}) {
  const headers = { accept: 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const started = performance.now();
  try {
    const response = await fetch(new URL(path, `${baseUrl}/`), {
      method,
      headers,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let json;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, wallMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      status: 0,
      json: null,
      wallMs: Math.round(performance.now() - started),
      transportError: error?.name === 'TimeoutError' ? 'timeout' : 'network error',
    };
  }
}

function check(name, response, expectedStatuses, predicate = () => true) {
  const passed = expectedStatuses.includes(response.status) && predicate(response.json);
  const status = response.status === 0 ? response.transportError : `HTTP ${response.status}`;
  record(name, passed ? 'PASS' : 'FAIL', `${status}; wall ${response.wallMs} ms`);
  return passed;
}

function uuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function errorSignature(response) {
  const error = response.json?.error;
  return JSON.stringify({
    status: response.status,
    code: typeof error?.code === 'string' ? error.code : null,
    message: typeof error?.message === 'string' ? error.message : null,
  });
}

async function preflight(baseUrl) {
  const health = await request(baseUrl, '/healthz');
  check('GET /healthz', health, [200], (json) => json?.status === 'ok');

  const ready = await request(baseUrl, '/readyz');
  check('GET /readyz (PostgreSQL)', ready, [200], (json) => json?.status === 'ready');

  const devLogin = await request(baseUrl, '/v1/auth/session', {
    method: 'POST',
    body: {
      provider: 'dev',
      identity_token: 'cloudflare-smoke-dev-must-be-hidden',
      nonce: 'smoke',
    },
  });
  check(
    'development sign-in is hidden',
    devLogin,
    [404],
    (json) => json?.error?.code === 'NOT_FOUND',
  );

  const forgedApple = await request(baseUrl, '/v1/auth/session', {
    method: 'POST',
    body: {
      provider: 'apple',
      identity_token: 'not.a.real.jwt',
      nonce: 'cloudflare-smoke-invalid',
    },
  });
  check(
    'forged Apple assertion rejected',
    forgedApple,
    [401],
    (json) => json?.error?.code === 'UNAUTHENTICATED',
  );

  const noSession = await request(baseUrl, '/v1/me');
  check(
    'GET /v1/me without session',
    noSession,
    [401],
    (json) => json?.error?.code === 'UNAUTHENTICATED',
  );

  const forgedSession = await request(baseUrl, '/v1/me', {
    token: `ems_${'A'.repeat(43)}`,
  });
  check(
    'GET /v1/me with forged session',
    forgedSession,
    [401],
    (json) => json?.error?.code === 'UNAUTHENTICATED',
  );

  const missingRoute = await request(baseUrl, '/v1/cloudflare-smoke-unknown-route');
  check(
    'unknown route returns 404',
    missingRoute,
    [404],
    (json) => json?.error?.code === 'NOT_FOUND',
  );
}

async function readCredentialInput() {
  if (process.stdin.isTTY) {
    throw new Error('full mode requires non-echoed JSON piped through stdin');
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('stdin must contain the smoke credential JSON');
  }

  const validAssertion = (value) =>
    value !== null &&
    typeof value === 'object' &&
    typeof value.identity_token === 'string' &&
    value.identity_token.length > 0 &&
    typeof value.nonce === 'string' &&
    value.nonce.length > 0;

  if (!validAssertion(input?.primary)) {
    throw new Error('stdin primary assertion is incomplete');
  }
  if (input.secondary !== undefined && !validAssertion(input.secondary)) {
    throw new Error('stdin secondary assertion is incomplete');
  }
  return input;
}

async function fullFlow(baseUrl) {
  const credentials = await readCredentialInput();
  const signInBody = {
    provider: 'apple',
    identity_token: credentials.primary.identity_token,
    nonce: credentials.primary.nonce,
  };
  const concurrentSignIns = await Promise.all([
    request(baseUrl, '/v1/auth/session', { method: 'POST', body: signInBody }),
    request(baseUrl, '/v1/auth/session', { method: 'POST', body: signInBody }),
  ]);
  const statuses = concurrentSignIns.map((result) => result.status).sort((a, b) => a - b);
  const winner = concurrentSignIns.find((result) => result.status === 201);
  const oneWinner = statuses[0] === 201 && statuses[1] === 401;
  record(
    'concurrent Apple nonce replay permits one session',
    oneWinner ? 'PASS' : 'FAIL',
    `HTTP ${statuses.join(', ')}`,
  );
  if (winner === undefined || typeof winner.json?.access_token !== 'string') {
    record('B1 flow after Apple sign-in', 'NOT VERIFIED', 'no successful session token');
    return;
  }

  const sessionToken = winner.json.access_token;
  const sessionShape =
    uuid(winner.json.session_id) &&
    uuid(winner.json.consumer_id) &&
    typeof winner.json.expires_at === 'string';
  record('Apple session follows the B1 response contract', sessionShape ? 'PASS' : 'FAIL');
  const replay = await request(baseUrl, '/v1/auth/session', { method: 'POST', body: signInBody });
  check('sequential Apple nonce replay rejected', replay, [401]);

  const me = await request(baseUrl, '/v1/me', { token: sessionToken });
  const meShape =
    typeof me.json?.consumer_id === 'string' &&
    uuid(me.json?.agent?.agent_id) &&
    uuid(me.json?.conversation?.conversation_id) &&
    Number.isInteger(me.json?.conversation?.transcript_epoch);
  check('GET /v1/me returns provisioned B1 identity', me, [200], () => meShape);
  if (!meShape) {
    record('B1 message flow', 'NOT VERIFIED', 'bootstrap response unavailable');
    return;
  }

  const conversationId = me.json.conversation.conversation_id;
  const submissionId = randomUUID();
  const syntheticText = `Cloudflare smoke ${randomUUID()}`;
  const sendBody = {
    client_submission_id: submissionId,
    text: syntheticText,
    transcript_epoch: me.json.conversation.transcript_epoch,
    client_created_at: new Date().toISOString(),
  };
  const firstSend = await request(baseUrl, `/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    token: sessionToken,
    body: sendBody,
  });
  const receiptShape =
    uuid(firstSend.json?.message?.message_id) &&
    firstSend.json?.message?.client_submission_id === submissionId &&
    uuid(firstSend.json?.turn?.turn_id) &&
    firstSend.json?.turn?.status === 'running';
  check('POST B1 message creates synthetic message and Turn', firstSend, [201], () => receiptShape);
  if (!receiptShape) {
    record('B1 message reads and ACK recovery', 'NOT VERIFIED', 'no valid write receipt');
    return;
  }

  const duplicateSends = await Promise.all(
    Array.from({ length: DUPLICATE_RETRIES }, () =>
      request(baseUrl, `/v1/conversations/${conversationId}/messages`, {
        method: 'POST',
        token: sessionToken,
        body: sendBody,
      }),
    ),
  );
  const replayReceiptsMatch = duplicateSends.every(
    (result) =>
      result.status === 200 && JSON.stringify(result.json) === JSON.stringify(firstSend.json),
  );
  record(
    'concurrent message retries are idempotent',
    replayReceiptsMatch ? 'PASS' : 'FAIL',
    `${duplicateSends.filter((result) => result.status === 200).length}/${DUPLICATE_RETRIES} HTTP 200`,
  );

  const unknownAck = await request(
    baseUrl,
    `/v1/message-submissions/${encodeURIComponent(submissionId)}`,
    { token: sessionToken },
  );
  check(
    'GET Unknown ACK receipt matches original write',
    unknownAck,
    [200],
    (json) => JSON.stringify(json) === JSON.stringify(firstSend.json),
  );

  const transcript = await request(
    baseUrl,
    `/v1/conversations/${conversationId}/messages?after=0&limit=100`,
    { token: sessionToken },
  );
  check(
    'GET Conversation transcript includes submitted message',
    transcript,
    [200],
    (json) =>
      Array.isArray(json?.messages) &&
      json.messages.some(
        (message) =>
          message.message_id === firstSend.json.message.message_id &&
          message.text === syntheticText,
      ),
  );

  const secondary = credentials.secondary;
  if (secondary === undefined) {
    record(
      'cross-tenant isolation',
      'NOT VERIFIED',
      'requires a second distinct Apple test account',
    );
    return;
  }

  const secondSession = await request(baseUrl, '/v1/auth/session', {
    method: 'POST',
    body: { provider: 'apple', identity_token: secondary.identity_token, nonce: secondary.nonce },
  });
  const secondToken = secondSession.json?.access_token;
  const secondMe =
    typeof secondToken === 'string'
      ? await request(baseUrl, '/v1/me', { token: secondToken })
      : { status: 0, json: null, wallMs: secondSession.wallMs, transportError: 'no session token' };
  const distinctTenant =
    secondSession.status === 201 &&
    secondMe.status === 200 &&
    typeof secondMe.json?.consumer_id === 'string' &&
    secondMe.json.consumer_id !== me.json.consumer_id;
  record(
    'second Apple test account provisions a distinct tenant',
    distinctTenant ? 'PASS' : 'FAIL',
    `HTTP session ${secondSession.status}; HTTP me ${secondMe.status}`,
  );
  if (!distinctTenant) return;

  const foreignConversation = await request(
    baseUrl,
    `/v1/conversations/${conversationId}/messages`,
    { token: secondToken },
  );
  const unknownConversation = await request(baseUrl, `/v1/conversations/${randomUUID()}/messages`, {
    token: secondToken,
  });
  const conversationHidden =
    foreignConversation.status === 404 &&
    unknownConversation.status === 404 &&
    errorSignature(foreignConversation) === errorSignature(unknownConversation);

  const foreignSubmission = await request(baseUrl, `/v1/message-submissions/${submissionId}`, {
    token: secondToken,
  });
  const unknownSubmission = await request(baseUrl, `/v1/message-submissions/${randomUUID()}`, {
    token: secondToken,
  });
  const submissionHidden =
    foreignSubmission.status === 404 &&
    unknownSubmission.status === 404 &&
    errorSignature(foreignSubmission) === errorSignature(unknownSubmission);
  record(
    'cross-tenant reads are indistinguishable from unknown IDs',
    conversationHidden && submissionHidden ? 'PASS' : 'FAIL',
    `conversation ${foreignConversation.status}/${unknownConversation.status}; submission ${foreignSubmission.status}/${unknownSubmission.status}`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(`Smoke target: ${options.baseUrl} (${options.mode})\n`);
  await preflight(options.baseUrl);
  if (options.mode === 'full') await fullFlow(options.baseUrl);

  const passed = results.filter((result) => result.state === 'PASS').length;
  const failed = results.filter((result) => result.state === 'FAIL').length;
  const notVerified = results.filter((result) => result.state === 'NOT VERIFIED').length;
  process.stdout.write(`RESULT: ${passed} passed, ${failed} failed, ${notVerified} NOT VERIFIED\n`);
  process.exitCode = failed > 0 ? 1 : notVerified > 0 ? 2 : 0;
}

main().catch((error) => {
  const category = error instanceof Error ? error.name : 'unknown error';
  process.stderr.write(`FAIL smoke setup (${category})\n`);
  process.exitCode = 1;
});
