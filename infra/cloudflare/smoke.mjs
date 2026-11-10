#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const TIMEOUT_MS = 12_000;
const DUPLICATE_RETRIES = 4;
const results = [];

function usage() {
  process.stdout.write(
    'Usage: pnpm smoke:cloudflare -- --base-url https://ember-cloud-api-staging.<account>.workers.dev --mode preflight|full\n',
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
    !url.hostname.startsWith('ember-cloud-api-staging.') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('base URL must be the HTTPS ember-cloud-api-staging workers.dev origin');
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

/**
 * Send a committed write through a loopback proxy, then reset the client connection after the
 * upstream Worker has returned its complete response. This models a lost ACK without changing
 * the Worker or asking it to write test data twice.
 */
async function postAndDropResponse(baseUrl, path, { token, body }) {
  let upstreamStatus = 0;
  let upstreamCompleted = false;
  const proxy = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));

      const headers = { accept: 'application/json', 'content-type': 'application/json' };
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      const upstream = await fetch(new URL(path, `${baseUrl}/`), {
        method: 'POST',
        headers,
        body: Buffer.concat(chunks),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      upstreamStatus = upstream.status;
      await upstream.arrayBuffer();
      upstreamCompleted = true;
      outgoing.destroy();
    })().catch(() => outgoing.destroy());
  });

  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });

  let clientConnectionDropped = false;
  try {
    const address = proxy.address();
    if (address === null || typeof address === 'string') {
      throw new Error('loopback proxy did not bind a TCP port');
    }
    const localResponse = await fetch(`http://127.0.0.1:${address.port}/drop-ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await localResponse.arrayBuffer();
  } catch {
    clientConnectionDropped = true;
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }

  return { upstreamStatus, upstreamCompleted, clientConnectionDropped };
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

  let sessionToken = winner.json.access_token;
  const sessionShape =
    uuid(winner.json.session_id) &&
    uuid(winner.json.consumer_id) &&
    typeof winner.json.access_token === 'string' &&
    typeof winner.json.expires_at === 'string';
  record('Apple session follows the B1 response contract', sessionShape ? 'PASS' : 'FAIL');
  if (!sessionShape) {
    record('B1 refresh and Conversation flow', 'NOT VERIFIED', 'invalid session response');
    return;
  }

  const replay = await request(baseUrl, '/v1/auth/session', { method: 'POST', body: signInBody });
  check('sequential Apple nonce replay rejected', replay, [401]);

  const refreshedSession = await request(baseUrl, '/v1/auth/session/refresh', {
    method: 'POST',
    token: sessionToken,
  });
  const refreshShape =
    uuid(refreshedSession.json?.session_id) &&
    refreshedSession.json?.consumer_id === winner.json.consumer_id &&
    typeof refreshedSession.json?.access_token === 'string' &&
    typeof refreshedSession.json?.expires_at === 'string';
  check(
    'POST B1 session refresh rotates the bearer token',
    refreshedSession,
    [200],
    () => refreshShape,
  );
  if (!refreshShape) {
    record('B1 Conversation flow', 'NOT VERIFIED', 'session refresh failed');
    return;
  }

  const oldSession = await request(baseUrl, '/v1/me', { token: sessionToken });
  check(
    'rotated B1 session token is rejected',
    oldSession,
    [401],
    (json) => json?.error?.code === 'UNAUTHENTICATED',
  );
  sessionToken = refreshedSession.json.access_token;

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
  const droppedAck = await postAndDropResponse(
    baseUrl,
    `/v1/conversations/${conversationId}/messages`,
    { token: sessionToken, body: sendBody },
  );
  const committedWithoutAck =
    droppedAck.upstreamStatus === 201 &&
    droppedAck.upstreamCompleted &&
    droppedAck.clientConnectionDropped;
  record(
    'committed B1 message survives a dropped client connection',
    committedWithoutAck ? 'PASS' : 'FAIL',
    `upstream HTTP ${droppedAck.upstreamStatus}; upstream response consumed; client connection ${droppedAck.clientConnectionDropped ? 'dropped' : 'not dropped'}`,
  );
  if (!committedWithoutAck) {
    record(
      'B1 message reads and Turn flow',
      'NOT VERIFIED',
      'commit/connection-drop sequence incomplete',
    );
    return;
  }

  const unknownAck = await request(
    baseUrl,
    `/v1/message-submissions/${encodeURIComponent(submissionId)}`,
    { token: sessionToken },
  );
  const receiptShape =
    uuid(unknownAck.json?.message?.message_id) &&
    unknownAck.json?.message?.client_submission_id === submissionId &&
    uuid(unknownAck.json?.turn?.turn_id) &&
    unknownAck.json?.turn?.status === 'running';
  check(
    'GET Unknown ACK recovers the committed B1 message and Turn',
    unknownAck,
    [200],
    () => receiptShape,
  );
  if (!receiptShape) {
    record('B1 message retry and Turn flow', 'NOT VERIFIED', 'no valid recovered write receipt');
    return;
  }
  const receipt = unknownAck.json;

  const retryAfterDisconnect = await request(
    baseUrl,
    `/v1/conversations/${conversationId}/messages`,
    { method: 'POST', token: sessionToken, body: sendBody },
  );
  check(
    'retry after dropped ACK returns the original receipt',
    retryAfterDisconnect,
    [200],
    (json) => JSON.stringify(json) === JSON.stringify(receipt),
  );

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
    (result) => result.status === 200 && JSON.stringify(result.json) === JSON.stringify(receipt),
  );
  record(
    'concurrent message retries are idempotent',
    replayReceiptsMatch ? 'PASS' : 'FAIL',
    `${duplicateSends.filter((result) => result.status === 200).length}/${DUPLICATE_RETRIES} HTTP 200`,
  );

  const turnPath = `/v1/conversations/${conversationId}/turns/${receipt.turn.turn_id}`;
  const turn = await request(baseUrl, turnPath, { token: sessionToken });
  const turnShape =
    turn.json?.turn_id === receipt.turn.turn_id &&
    turn.json?.conversation_id === conversationId &&
    ['running', 'completed', 'failed', 'cancelled'].includes(turn.json?.status);
  check('GET B1 Turn returns the persisted Turn', turn, [200], () => turnShape);

  const cancelTurn = await request(baseUrl, `${turnPath}/cancel`, {
    method: 'POST',
    token: sessionToken,
  });
  const cancelShape =
    cancelTurn.json?.turn_id === receipt.turn.turn_id &&
    ['cancelled', 'completed', 'failed'].includes(cancelTurn.json?.status);
  const cancellationRacedWithCompletion = cancelShape && cancelTurn.json.status !== 'cancelled';
  record(
    'POST B1 Turn cancellation',
    !cancelShape ? 'FAIL' : cancellationRacedWithCompletion ? 'NOT VERIFIED' : 'PASS',
    `HTTP ${cancelTurn.status}; stored status ${cancelTurn.json?.status ?? 'unavailable'}`,
  );

  const terminalTurn = await request(baseUrl, turnPath, { token: sessionToken });
  check(
    'GET B1 Turn observes the persisted terminal state',
    terminalTurn,
    [200],
    (json) => json?.turn_id === receipt.turn.turn_id && json?.status === cancelTurn.json?.status,
  );

  const stableAck = await request(
    baseUrl,
    `/v1/message-submissions/${encodeURIComponent(submissionId)}`,
    { token: sessionToken },
  );
  check(
    'Unknown ACK remains the original receipt after Turn transition',
    stableAck,
    [200],
    (json) => JSON.stringify(json) === JSON.stringify(receipt),
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
          message.message_id === receipt.message.message_id && message.text === syntheticText,
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
