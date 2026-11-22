#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const G4_DEFAULT_BASE_URL = 'https://ember-v2-staging.slowfast.dev';
export const G4_APPROVED_MODEL_ID = 'deepseek/deepseek-v4.1-flash-1017';
export const G4_DEFAULT_SANDBOX_OWNER = 'ember-v2-staging:canary';
export const G4_MAX_TASK_DEADLINE_MS = 120_000;
export const G4_MAX_ARTIFACT_BYTES = 1_048_576;
export const G4_SAFE_FILENAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const G4_BLOCKED_MEDIA_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
]);

const SYNTHETIC_CSV_CONTENT = [
  'region,revenue,units',
  'north,120.50,10',
  'south,79.50,5',
  'west,200.00,15',
  '',
].join('\n');

export const G4_SYNTHETIC_CSV_FIXTURE = Object.freeze({
  filename: 'g4-canary-sales.csv',
  mediaType: 'text/csv',
  content: SYNTHETIC_CSV_CONTENT,
  sizeBytes: Buffer.byteLength(SYNTHETIC_CSV_CONTENT, 'utf8'),
  sha256: createHash('sha256').update(SYNTHETIC_CSV_CONTENT, 'utf8').digest('hex'),
  expectedSummary: Object.freeze({
    rows: 3,
    totalRevenue: 400,
    totalUnits: 30,
  }),
});

export const G4_DIRECT_TASK_PROMPT = [
  `Read /home/daytona/ember/inputs/${G4_SYNTHETIC_CSV_FIXTURE.filename}.`,
  'Compute total row count, total revenue, and total units across all rows, plus per-region sums.',
  'Write a concise summary CSV to /home/daytona/ember/outputs/g4-canary-summary.csv.',
  'Reply with the exact computed row count, total revenue, and total units.',
].join(' ');

export const G4_NL_TASK_PROMPT = [
  `Please analyze the attached synthetic CSV (${G4_SYNTHETIC_CSV_FIXTURE.filename}) using Python,`,
  'compute total revenue and total units across all regions,',
  'and write the summary table to outputs/g4-nl-summary.csv.',
].join(' ');

export const G4_CANCEL_TASK_PROMPT = [
  'Run a Python script using time.sleep(20) before writing any file,',
  'then write outputs/should-not-publish.txt.',
].join(' ');

export function isLoopbackUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  return (
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]'
  );
}

/**
 * Fails closed whenever a non-loopback target is given without explicit Founder authorization.
 */
export function assertCanaryExecutionAuthorized({ baseUrl, confirmFounderAuthorization }) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported canary base URL protocol: ${parsed.protocol}`);
  }
  if (!isLoopbackUrl(baseUrl) && confirmFounderAuthorization !== true) {
    throw new Error(
      'Refusing remote G4 Daytona canary execution without explicit Founder authorization (--confirm-founder-authorization).',
    );
  }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

/**
 * Validates downloaded artifact metadata, HTTP security headers, byte size, and SHA-256 digest.
 */
export function validateDownloadedArtifact({ artifact, bytes, headers }) {
  const errors = [];
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, errors: ['missing artifact metadata'], computedSha256: null };
  }
  if (
    typeof artifact.filename !== 'string' ||
    !G4_SAFE_FILENAME_REGEX.test(artifact.filename) ||
    artifact.filename.includes('..')
  ) {
    errors.push(`unsafe output artifact filename: ${JSON.stringify(artifact.filename)}`);
  }
  const mediaType =
    typeof artifact.media_type === 'string' ? artifact.media_type.trim().toLowerCase() : '';
  if (mediaType.length === 0 || G4_BLOCKED_MEDIA_TYPES.has(mediaType)) {
    errors.push(
      `blocked or missing output artifact media_type: ${JSON.stringify(artifact.media_type)}`,
    );
  }
  if (
    !Number.isInteger(artifact.size) ||
    artifact.size <= 0 ||
    artifact.size > G4_MAX_ARTIFACT_BYTES
  ) {
    errors.push(`invalid output artifact size: ${String(artifact.size)}`);
  }
  if (!(bytes instanceof Uint8Array)) {
    return {
      ok: false,
      errors: [...errors, 'downloaded artifact body must be Uint8Array'],
      computedSha256: null,
    };
  }
  if (bytes.byteLength !== artifact.size) {
    errors.push(`byte length mismatch: expected ${artifact.size}, got ${bytes.byteLength}`);
  }
  const computedSha256 = sha256Hex(bytes);
  if (typeof artifact.sha256 !== 'string' || computedSha256 !== artifact.sha256.toLowerCase()) {
    errors.push(`sha256 mismatch: expected ${String(artifact.sha256)}, got ${computedSha256}`);
  }

  if (headers) {
    const contentType = getHeader(headers, 'content-type');
    if (contentType !== null) {
      const responseMediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
      if (G4_BLOCKED_MEDIA_TYPES.has(responseMediaType)) {
        errors.push(`blocked response Content-Type: ${JSON.stringify(contentType)}`);
      } else if (mediaType.length > 0 && responseMediaType !== mediaType) {
        errors.push(
          `Content-Type mismatch: expected ${mediaType}, got ${JSON.stringify(contentType)}`,
        );
      }
    }
    const nosniff = getHeader(headers, 'x-content-type-options');
    if (nosniff?.toLowerCase() !== 'nosniff') {
      errors.push(`expected X-Content-Type-Options: nosniff, got ${JSON.stringify(nosniff)}`);
    }
    const cacheControl = getHeader(headers, 'cache-control') ?? '';
    if (!cacheControl.toLowerCase().includes('no-store')) {
      errors.push(
        `expected Cache-Control containing no-store, got ${JSON.stringify(cacheControl)}`,
      );
    }
    const contentLength = getHeader(headers, 'content-length');
    if (contentLength !== null && contentLength !== String(bytes.byteLength)) {
      errors.push(`Content-Length mismatch: header=${contentLength}, body=${bytes.byteLength}`);
    }
  }

  if (mediaType.startsWith('text/') || mediaType === 'application/json') {
    const text = Buffer.from(bytes).toString('utf8').trim();
    if (text.length === 0) {
      errors.push('downloaded text artifact is empty');
    }
  }

  return { ok: errors.length === 0, errors, computedSha256 };
}

async function apiJson(
  fetchImpl,
  baseUrl,
  path,
  { method = 'GET', token, headers = {}, body } = {},
) {
  const mergedHeaders = {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: mergedHeaders,
    cache: 'no-store',
    redirect: 'error',
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, ok: response.ok, json, headers: response.headers };
}

async function apiBytes(fetchImpl, baseUrl, path, { token } = {}) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
    redirect: 'error',
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, ok: response.ok, bytes, headers: response.headers };
}

async function pollTaskUntilTerminal(
  fetchImpl,
  baseUrl,
  token,
  taskId,
  { timeoutMs = 130_000, pollIntervalMs = 500 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = null;
  while (Date.now() < deadline) {
    const res = await apiJson(fetchImpl, baseUrl, `/v1/me/tasks/${taskId}`, { token });
    if (res.status !== 200 || !res.json) {
      throw new Error(`GET /v1/me/tasks/${taskId} failed with HTTP ${res.status}`);
    }
    lastDetail = res.json;
    if (
      lastDetail.status === 'completed' ||
      lastDetail.status === 'failed' ||
      lastDetail.status === 'cancelled'
    ) {
      return lastDetail;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for task ${taskId} to reach terminal state (last status: ${lastDetail?.status ?? 'unknown'})`,
  );
}

async function validateTaskRunOutputs({
  fetchImpl,
  baseUrl,
  token,
  taskId,
  expectedInputFilename,
}) {
  const listRes = await apiJson(fetchImpl, baseUrl, `/v1/me/tasks/${taskId}/artifacts`, { token });
  if (listRes.status !== 200 || !listRes.json || !Array.isArray(listRes.json.artifacts)) {
    throw new Error(`GET /v1/me/tasks/${taskId}/artifacts failed with HTTP ${listRes.status}`);
  }
  const artifacts = listRes.json.artifacts;
  const userInputs = artifacts.filter((a) => a.created_by === 'user');
  const runOutputs = artifacts.filter((a) => a.created_by === 'run');
  if (!userInputs.some((a) => a.filename === expectedInputFilename)) {
    throw new Error(`Missing bound input artifact ${expectedInputFilename} on task ${taskId}`);
  }
  if (runOutputs.length === 0) {
    throw new Error(`Expected >= 1 committed output artifact on task ${taskId}, got 0`);
  }
  if (runOutputs.length > 5) {
    throw new Error(`Too many committed output artifacts on task ${taskId}: ${runOutputs.length}`);
  }
  const seenNames = new Set();
  const validatedOutputs = [];
  for (const artifact of runOutputs) {
    if (seenNames.has(artifact.filename)) {
      throw new Error(
        `Duplicate output artifact filename detected on task ${taskId}: ${artifact.filename}`,
      );
    }
    seenNames.add(artifact.filename);
    const dl = await apiBytes(fetchImpl, baseUrl, `/v1/me/artifacts/${artifact.artifact_id}`, {
      token,
    });
    if (dl.status !== 200) {
      throw new Error(`GET /v1/me/artifacts/${artifact.artifact_id} failed with HTTP ${dl.status}`);
    }
    const check = validateDownloadedArtifact({
      artifact,
      bytes: dl.bytes,
      headers: dl.headers,
    });
    if (!check.ok) {
      throw new Error(
        `Artifact validation failed for ${artifact.filename}: ${check.errors.join('; ')}`,
      );
    }
    validatedOutputs.push({
      artifactId: artifact.artifact_id,
      filename: artifact.filename,
      mediaType: artifact.media_type,
      sizeBytes: artifact.size,
      sha256: check.computedSha256,
    });
  }
  return validatedOutputs;
}

/**
 * Runs the bounded G4 Daytona Canary acceptance sequence against a configured Ember V2 target.
 */
export async function runG4DaytonaCanary({
  baseUrl = G4_DEFAULT_BASE_URL,
  bearerToken,
  confirmFounderAuthorization = false,
  allowSimulated = false,
  expectedModelLabel = G4_APPROVED_MODEL_ID,
  sandboxOwner = G4_DEFAULT_SANDBOX_OWNER,
  tenantId,
  includeNlChat = false,
  includeCancellation = true,
  taskTimeoutMs = 130_000,
  pollIntervalMs = 500,
  cancelWaitForRunningMs = 8_000,
  fetchImpl = fetch,
  sweepOrphans,
} = {}) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  assertCanaryExecutionAuthorized({ baseUrl: normalizedBaseUrl, confirmFounderAuthorization });
  if (typeof bearerToken !== 'string' || bearerToken.trim().length === 0) {
    throw new Error('bearerToken is required for G4 Daytona canary');
  }
  const token = bearerToken.trim();
  const startedAt = Date.now();

  // 1. Health, readiness, and authenticated principal identity.
  const health = await apiJson(fetchImpl, normalizedBaseUrl, '/healthz');
  if (health.status !== 200 || health.json?.status !== 'ok') {
    throw new Error(`/healthz check failed with HTTP ${health.status}`);
  }
  const ready = await apiJson(fetchImpl, normalizedBaseUrl, '/readyz');
  if (ready.status !== 200 || ready.json?.status !== 'ready') {
    throw new Error(`/readyz check failed with HTTP ${ready.status}`);
  }
  const meRes = await apiJson(fetchImpl, normalizedBaseUrl, '/v1/me', { token });
  if (
    meRes.status !== 200 ||
    !meRes.json?.agent?.agent_id ||
    !meRes.json?.conversation?.conversation_id
  ) {
    throw new Error(`/v1/me failed with HTTP ${meRes.status}`);
  }
  const agentId = meRes.json.agent.agent_id;
  const conversationId = meRes.json.conversation.conversation_id;
  const transcriptEpoch = meRes.json.conversation.transcript_epoch;

  // 2. Stage synthetic CSV and submit direct bounded python.agent task.
  const uploadRes = await apiJson(fetchImpl, normalizedBaseUrl, '/v1/me/uploads', {
    method: 'POST',
    token,
    body: {
      filename: G4_SYNTHETIC_CSV_FIXTURE.filename,
      media_type: G4_SYNTHETIC_CSV_FIXTURE.mediaType,
      content: G4_SYNTHETIC_CSV_FIXTURE.content,
    },
  });
  if (uploadRes.status !== 201 || !uploadRes.json?.upload_id) {
    throw new Error(`Synthetic CSV upload failed with HTTP ${uploadRes.status}`);
  }
  const uploadId = uploadRes.json.upload_id;
  const idempotencyKey = randomUUID();
  const submitPayload = {
    title: 'G4 Daytona Canary CSV',
    prompt: G4_DIRECT_TASK_PROMPT,
    attachment_ids: [uploadId],
  };
  const submitRes = await apiJson(fetchImpl, normalizedBaseUrl, '/v2/tasks/python', {
    method: 'POST',
    token,
    headers: { 'idempotency-key': idempotencyKey },
    body: submitPayload,
  });
  if (
    submitRes.status !== 201 ||
    submitRes.json?.created !== true ||
    !submitRes.json?.task?.task_id
  ) {
    throw new Error(`POST /v2/tasks/python failed with HTTP ${submitRes.status}`);
  }
  const directTaskId = submitRes.json.task.task_id;

  const replayRes = await apiJson(fetchImpl, normalizedBaseUrl, '/v2/tasks/python', {
    method: 'POST',
    token,
    headers: { 'idempotency-key': idempotencyKey },
    body: submitPayload,
  });
  if (
    replayRes.status !== 200 ||
    replayRes.json?.created !== false ||
    replayRes.json?.task?.task_id !== directTaskId
  ) {
    throw new Error(`Idempotent replay check failed (HTTP ${replayRes.status})`);
  }

  const directTerminal = await pollTaskUntilTerminal(
    fetchImpl,
    normalizedBaseUrl,
    token,
    directTaskId,
    { timeoutMs: taskTimeoutMs, pollIntervalMs },
  );
  if (directTerminal.status !== 'completed') {
    throw new Error(
      `Direct G4 canary task ${directTaskId} ended with status ${directTerminal.status}`,
    );
  }

  const directResultRes = await apiJson(
    fetchImpl,
    normalizedBaseUrl,
    `/v1/me/tasks/${directTaskId}/result`,
    { token },
  );
  if (
    directResultRes.status !== 200 ||
    directResultRes.json?.result_state !== 'available' ||
    !directResultRes.json?.result
  ) {
    throw new Error(`Direct task result unavailable (HTTP ${directResultRes.status})`);
  }
  const directResult = directResultRes.json.result;
  if (!allowSimulated && directResult.simulated !== false) {
    throw new Error(
      'Refusing simulated result in real G4 Daytona canary (expected simulated: false)',
    );
  }
  if (!allowSimulated && directResult.model_label !== expectedModelLabel) {
    throw new Error(
      `Unexpected model_label ${JSON.stringify(directResult.model_label)} (expected ${expectedModelLabel})`,
    );
  }

  const directEventsRes = await apiJson(
    fetchImpl,
    normalizedBaseUrl,
    `/v1/me/tasks/${directTaskId}/events`,
    { token },
  );
  if (directEventsRes.status !== 200 || !Array.isArray(directEventsRes.json?.events)) {
    throw new Error(
      `GET /v1/me/tasks/${directTaskId}/events failed with HTTP ${directEventsRes.status}`,
    );
  }

  const directOutputs = await validateTaskRunOutputs({
    fetchImpl,
    baseUrl: normalizedBaseUrl,
    token,
    taskId: directTaskId,
    expectedInputFilename: G4_SYNTHETIC_CSV_FIXTURE.filename,
  });

  // 3. Optional NL chat attachment delegation scenario.
  let nlDelegation = null;
  if (includeNlChat) {
    const priorTasksRes = await apiJson(fetchImpl, normalizedBaseUrl, '/v1/me/tasks?limit=50', {
      token,
    });
    if (priorTasksRes.status !== 200 || !Array.isArray(priorTasksRes.json?.tasks)) {
      throw new Error(`GET /v1/me/tasks failed with HTTP ${priorTasksRes.status}`);
    }
    const priorTaskIds = new Set(priorTasksRes.json.tasks.map((t) => t.task_id).filter(Boolean));
    priorTaskIds.add(directTaskId);

    const nlUploadRes = await apiJson(fetchImpl, normalizedBaseUrl, '/v1/me/uploads', {
      method: 'POST',
      token,
      body: {
        filename: G4_SYNTHETIC_CSV_FIXTURE.filename,
        media_type: G4_SYNTHETIC_CSV_FIXTURE.mediaType,
        content: G4_SYNTHETIC_CSV_FIXTURE.content,
      },
    });
    if (nlUploadRes.status !== 201 || !nlUploadRes.json?.upload_id) {
      throw new Error(`NL CSV upload failed with HTTP ${nlUploadRes.status}`);
    }
    const msgRes = await apiJson(
      fetchImpl,
      normalizedBaseUrl,
      `/v1/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        token,
        body: {
          client_submission_id: randomUUID(),
          text: G4_NL_TASK_PROMPT,
          transcript_epoch: transcriptEpoch,
          attachment_ids: [nlUploadRes.json.upload_id],
        },
      },
    );
    if (msgRes.status !== 201) {
      throw new Error(`NL chat message failed with HTTP ${msgRes.status}`);
    }

    const nlDeadline = Date.now() + taskTimeoutMs;
    let nlTaskId = null;
    let nlTerminal = null;
    while (Date.now() < nlDeadline) {
      const tasksRes = await apiJson(fetchImpl, normalizedBaseUrl, '/v1/me/tasks?limit=20', {
        token,
      });
      if (tasksRes.status === 200 && Array.isArray(tasksRes.json?.tasks)) {
        const candidate = tasksRes.json.tasks.find(
          (t) => t.kind === 'python.agent' && !priorTaskIds.has(t.task_id),
        );
        if (candidate) {
          nlTaskId = candidate.task_id;
          if (
            candidate.status === 'completed' ||
            candidate.status === 'failed' ||
            candidate.status === 'cancelled'
          ) {
            nlTerminal = candidate;
            break;
          }
        }
      }
      await sleep(pollIntervalMs);
    }
    if (!nlTaskId || !nlTerminal || nlTerminal.status !== 'completed') {
      throw new Error(
        `NL delegated task did not complete (taskId=${nlTaskId ?? 'none'}, status=${nlTerminal?.status ?? 'timeout'})`,
      );
    }

    let hasTaskCard = false;
    let afterCursor = 0;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const pageRes = await apiJson(
        fetchImpl,
        normalizedBaseUrl,
        `/v1/conversations/${conversationId}/messages?after=${afterCursor}&limit=50`,
        { token },
      );
      if (pageRes.status !== 200 || !Array.isArray(pageRes.json?.messages)) {
        throw new Error(
          `GET /v1/conversations/${conversationId}/messages failed with HTTP ${pageRes.status}`,
        );
      }
      if (
        pageRes.json.messages.some((m) => m.kind === 'task_reference' && m.task_id === nlTaskId)
      ) {
        hasTaskCard = true;
        break;
      }
      if (
        pageRes.json.has_more !== true ||
        !Number.isInteger(pageRes.json.next_after) ||
        pageRes.json.next_after <= afterCursor
      ) {
        break;
      }
      afterCursor = pageRes.json.next_after;
    }
    if (!hasTaskCard) {
      throw new Error(`Transcript missing task_reference card for delegated task ${nlTaskId}`);
    }

    const nlOutputs = await validateTaskRunOutputs({
      fetchImpl,
      baseUrl: normalizedBaseUrl,
      token,
      taskId: nlTaskId,
      expectedInputFilename: G4_SYNTHETIC_CSV_FIXTURE.filename,
    });
    nlDelegation = {
      taskId: nlTaskId,
      status: nlTerminal.status,
      outputs: nlOutputs,
    };
  }

  // 4. In-flight cancellation verification with zero committed output artifacts.
  let cancellation = null;
  if (includeCancellation) {
    const cancelSubmitRes = await apiJson(fetchImpl, normalizedBaseUrl, '/v2/tasks/python', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: {
        title: 'G4 Daytona Canary Cancellation Probe',
        prompt: G4_CANCEL_TASK_PROMPT,
      },
    });
    if (cancelSubmitRes.status !== 201 || !cancelSubmitRes.json?.task?.task_id) {
      throw new Error(`Cancellation probe submit failed with HTTP ${cancelSubmitRes.status}`);
    }
    const cancelTaskId = cancelSubmitRes.json.task.task_id;
    const waitRunningDeadline = Date.now() + cancelWaitForRunningMs;
    let observedStatus = cancelSubmitRes.json.task.status;
    while (observedStatus === 'queued' && Date.now() < waitRunningDeadline) {
      await sleep(Math.min(pollIntervalMs, 200));
      const detail = await apiJson(fetchImpl, normalizedBaseUrl, `/v1/me/tasks/${cancelTaskId}`, {
        token,
      });
      if (detail.status === 200 && detail.json?.status) {
        observedStatus = detail.json.status;
      }
    }

    const cancelRes = await apiJson(
      fetchImpl,
      normalizedBaseUrl,
      `/v1/me/tasks/${cancelTaskId}/cancel`,
      { method: 'POST', token },
    );
    if (
      (cancelRes.status !== 200 && cancelRes.status !== 202) ||
      cancelRes.json?.cancel_requested !== true
    ) {
      throw new Error(
        `POST /v1/me/tasks/${cancelTaskId}/cancel failed with HTTP ${cancelRes.status}`,
      );
    }

    const cancelTerminal = await pollTaskUntilTerminal(
      fetchImpl,
      normalizedBaseUrl,
      token,
      cancelTaskId,
      { timeoutMs: taskTimeoutMs, pollIntervalMs },
    );
    if (cancelTerminal.status === 'completed') {
      throw new Error(`Cancelled task ${cancelTaskId} unexpectedly completed`);
    }

    const cancelArtifactsRes = await apiJson(
      fetchImpl,
      normalizedBaseUrl,
      `/v1/me/tasks/${cancelTaskId}/artifacts`,
      { token },
    );
    if (cancelArtifactsRes.status !== 200 || !Array.isArray(cancelArtifactsRes.json?.artifacts)) {
      throw new Error(
        `GET /v1/me/tasks/${cancelTaskId}/artifacts failed with HTTP ${cancelArtifactsRes.status}`,
      );
    }
    const leakedRunOutputs = cancelArtifactsRes.json.artifacts.filter(
      (a) => a.created_by === 'run',
    );
    if (leakedRunOutputs.length > 0) {
      throw new Error(
        `Cancelled task ${cancelTaskId} exposed ${leakedRunOutputs.length} committed output artifact(s)`,
      );
    }

    cancellation = {
      taskId: cancelTaskId,
      statusBeforeCancel: observedStatus,
      terminalStatus: cancelTerminal.status,
      committedRunArtifacts: 0,
    };
  }

  // 5. Daytona control-plane orphan sweep / zero live sandbox confirmation.
  let cleanup = { checked: false, liveCount: null, destroyed: [], failed: [] };
  if (typeof sweepOrphans === 'function') {
    const sweep = await sweepOrphans({
      owner: sandboxOwner,
      ...(tenantId ? { tenantId } : {}),
    });
    cleanup = {
      checked: true,
      liveCount: sweep.liveCount,
      destroyed: sweep.destroyed ?? [],
      failed: sweep.failed ?? [],
    };
    const liveBeforeSweep = sweep.liveCount ?? 0;
    const destroyedCount = sweep.destroyed?.length ?? 0;
    const failedCount = sweep.failed?.length ?? 0;
    if (liveBeforeSweep > 0 || failedCount > 0) {
      throw new Error(
        `Daytona cleanup check failed: liveBeforeSweep=${liveBeforeSweep}, destroyed=${destroyedCount}, failed=${failedCount}`,
      );
    }
  }

  return {
    ok: true,
    baseUrl: normalizedBaseUrl,
    agentId,
    fixtureSha256: G4_SYNTHETIC_CSV_FIXTURE.sha256,
    directTask: {
      taskId: directTaskId,
      status: directTerminal.status,
      modelLabel: directResult.model_label,
      simulated: directResult.simulated,
      eventCount: directEventsRes.json.events.length,
      outputs: directOutputs,
    },
    nlDelegation,
    cancellation,
    cleanup,
    elapsedMs: Date.now() - startedAt,
  };
}

async function runDaytonaOrphanSweep({ apiKey, apiUrl, target, owner, tenantId }) {
  const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const distPath = resolve(repoRoot, 'packages/sandbox-daytona/dist/index.js');
  if (!existsSync(distPath)) {
    throw new Error('packages/sandbox-daytona/dist/index.js not built; run `pnpm run build` first');
  }
  const { DaytonaSdkSandboxClient, sweepOrphanedSandboxes } = await import(
    pathToFileURL(distPath).href
  );
  const client = new DaytonaSdkSandboxClient({
    apiKey,
    ...(apiUrl ? { apiUrl } : {}),
    ...(target ? { target } : {}),
    useDeprecatedPolling: true,
  });
  try {
    return await sweepOrphanedSandboxes({
      client,
      owner,
      ...(tenantId ? { tenantId } : {}),
      minAgeMs: 0,
    });
  } finally {
    await client.close();
  }
}

function parseCliArgs(argv) {
  const options = {
    baseUrl: process.env.EMBER_V2_STAGING_URL ?? G4_DEFAULT_BASE_URL,
    bearerToken: process.env.EMBER_CANARY_BEARER_TOKEN ?? '',
    confirmFounderAuthorization: false,
    allowSimulated: false,
    includeNlChat: false,
    includeCancellation: true,
    sweepOrphans: false,
    sweepOnly: false,
    owner: process.env.EMBER_SANDBOX_OWNER ?? G4_DEFAULT_SANDBOX_OWNER,
    tenantId: process.env.EMBER_CANARY_TENANT_ID ?? '',
    daytonaApiUrl: process.env.DAYTONA_API_URL ?? '',
    daytonaTarget: process.env.DAYTONA_TARGET ?? '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirm-founder-authorization') options.confirmFounderAuthorization = true;
    else if (arg === '--allow-simulated') options.allowSimulated = true;
    else if (arg === '--include-nl-chat') options.includeNlChat = true;
    else if (arg === '--skip-cancellation') options.includeCancellation = false;
    else if (arg === '--sweep-orphans') options.sweepOrphans = true;
    else if (arg === '--sweep-only') options.sweepOnly = true;
    else if (arg === '--base-url') options.baseUrl = argv[++i] ?? '';
    else if (arg === '--bearer-token') options.bearerToken = argv[++i] ?? '';
    else if (arg === '--owner') options.owner = argv[++i] ?? '';
    else if (arg === '--tenant-id') options.tenantId = argv[++i] ?? '';
    else if (arg === '--daytona-api-url') options.daytonaApiUrl = argv[++i] ?? '';
    else if (arg === '--daytona-target') options.daytonaTarget = argv[++i] ?? '';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const daytonaApiKey = process.env.DAYTONA_API_KEY?.trim() ?? '';

  if (opts.sweepOnly) {
    if (!opts.confirmFounderAuthorization) {
      throw new Error('--sweep-only requires --confirm-founder-authorization');
    }
    if (daytonaApiKey.length === 0) {
      throw new Error('DAYTONA_API_KEY environment variable is required for --sweep-only');
    }
    const sweep = await runDaytonaOrphanSweep({
      apiKey: daytonaApiKey,
      apiUrl: opts.daytonaApiUrl || undefined,
      target: opts.daytonaTarget || undefined,
      owner: opts.owner,
      tenantId: opts.tenantId || undefined,
    });
    process.stdout.write(`${JSON.stringify(sweep, null, 2)}\n`);
    if (sweep.failed.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  let sweepFn;
  if (opts.sweepOrphans) {
    if (!opts.confirmFounderAuthorization) {
      throw new Error('--sweep-orphans requires --confirm-founder-authorization');
    }
    if (daytonaApiKey.length === 0) {
      throw new Error('DAYTONA_API_KEY environment variable is required for --sweep-orphans');
    }
    sweepFn = ({ owner, tenantId }) =>
      runDaytonaOrphanSweep({
        apiKey: daytonaApiKey,
        apiUrl: opts.daytonaApiUrl || undefined,
        target: opts.daytonaTarget || undefined,
        owner,
        tenantId,
      });
  }

  const report = await runG4DaytonaCanary({
    baseUrl: opts.baseUrl,
    bearerToken: opts.bearerToken,
    confirmFounderAuthorization: opts.confirmFounderAuthorization,
    allowSimulated: opts.allowSimulated,
    sandboxOwner: opts.owner,
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    includeNlChat: opts.includeNlChat,
    includeCancellation: opts.includeCancellation,
    ...(sweepFn ? { sweepOrphans: sweepFn } : {}),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`G4 Daytona canary failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
