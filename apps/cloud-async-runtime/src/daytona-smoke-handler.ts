import {
  DAYTONA_INSTALLED_SDK_VERSION,
  DAYTONA_LABEL_OWNER,
  DAYTONA_PINNED_SDK_VERSION,
  DaytonaSdkSandboxClient,
  type DaytonaSandboxClient,
} from '@ember/sandbox-daytona';
import { createSmokeRunId, runCloudflareDaytonaSmoke } from './daytona-smoke.js';

export const DAYTONA_SMOKE_QUEUE_NAME = 'ember-staging-daytona-smoke';

export interface SmokeQueueMessageBody {
  readonly schemaVersion: 1;
  readonly action?: 'smoke' | 'ping';
  readonly runId: string;
  readonly owner: string;
  readonly requestedAtIso: string;
}

export interface SmokeQueueBinding {
  send(message: SmokeQueueMessageBody): Promise<void>;
}

export interface SmokeQueueMessage {
  readonly id?: string;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { readonly delaySeconds?: number }): void;
}

export interface SmokeQueueBatch {
  readonly queue: string;
  readonly messages: readonly SmokeQueueMessage[];
}

export interface DaytonaSmokeWorkerEnv {
  readonly DAYTONA_SMOKE_QUEUE: SmokeQueueBinding;
  readonly DAYTONA_API_KEY?: string;
  readonly DAYTONA_API_URL?: string;
  readonly DAYTONA_TARGET?: string;
  readonly EMBER_ENV?: string;
  readonly EMBER_SMOKE_TRIGGER_TOKEN?: string;
  readonly EMBER_DAYTONA_SMOKE_QUEUE_NAME?: string;
}

export interface DaytonaSmokeHandlerDeps {
  readonly clientFactory?: (options: {
    readonly apiKey: string;
    readonly apiUrl?: string;
    readonly target?: string;
  }) => DaytonaSandboxClient;
  readonly log?: (payload: Record<string, unknown>) => void;
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

function parseEnvelope(body: unknown): SmokeQueueMessageBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.runId !== 'string' ||
    record.runId.length === 0 ||
    typeof record.owner !== 'string' ||
    record.owner.length === 0 ||
    typeof record.requestedAtIso !== 'string'
  ) {
    return null;
  }
  const action = record.action === 'ping' ? 'ping' : 'smoke';
  return {
    schemaVersion: 1,
    action,
    runId: record.runId,
    owner: record.owner,
    requestedAtIso: record.requestedAtIso,
  };
}

function expectedQueueName(env: DaytonaSmokeWorkerEnv): string {
  return env.EMBER_DAYTONA_SMOKE_QUEUE_NAME?.trim() || DAYTONA_SMOKE_QUEUE_NAME;
}

function authorizeTrigger(request: Request, env: DaytonaSmokeWorkerEnv): Response | null {
  const expectedToken = env.EMBER_SMOKE_TRIGGER_TOKEN?.trim();
  const providedToken = bearerToken(request);

  if (!expectedToken) {
    return Response.json(
      { ok: false, error: 'EMBER_SMOKE_TRIGGER_TOKEN is not configured' },
      { status: 503 },
    );
  }

  if (providedToken === null || !constantTimeEqual(providedToken, expectedToken)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  if (!env.DAYTONA_API_KEY?.trim()) {
    return Response.json(
      { ok: false, error: 'DAYTONA_API_KEY is not configured' },
      { status: 503 },
    );
  }

  return null;
}

function sanitizeErrorMessage(error: unknown, apiKey: string | undefined): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return apiKey ? raw.replaceAll(apiKey, '[REDACTED]') : raw;
}

/**
 * Handles HTTP requests for the B3-B0 Daytona smoke worker (`/healthz`, authenticated `GET /sandboxes`, and `POST /smoke`).
 */
export async function handleDaytonaSmokeFetch(
  request: Request,
  env: DaytonaSmokeWorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/healthz') {
    return Response.json({
      ok: true,
      worker: 'ember-daytona-smoke-staging',
      env: env.EMBER_ENV ?? 'unknown',
      queue: expectedQueueName(env),
      installedSdkVersion: DAYTONA_INSTALLED_SDK_VERSION,
      pinnedSdkVersion: DAYTONA_PINNED_SDK_VERSION,
      hasWebSocketPair:
        typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === 'function',
      hasDaytonaApiKey: Boolean(env.DAYTONA_API_KEY?.trim()),
      hasTriggerToken: Boolean(env.EMBER_SMOKE_TRIGGER_TOKEN?.trim()),
    });
  }

  if (request.method === 'GET' && url.pathname === '/sandboxes') {
    const authError = authorizeTrigger(request, env);
    if (authError !== null) {
      return authError;
    }

    const apiKey = env.DAYTONA_API_KEY?.trim() as string;
    const apiUrl = env.DAYTONA_API_URL?.trim();
    const target = env.DAYTONA_TARGET?.trim();

    const client = new DaytonaSdkSandboxClient({
      apiKey,
      ...(apiUrl ? { apiUrl } : {}),
      ...(target ? { target } : {}),
    });

    try {
      const listed = await client.list({});
      const sweptIds: string[] = [];

      if (url.searchParams.get('sweep_b3_b0') === '1') {
        for (const item of listed) {
          const owner = item.labels[DAYTONA_LABEL_OWNER];
          if (typeof owner === 'string' && owner.startsWith('ember-b3-b0:')) {
            const deleted = await client.delete(item.sandboxId, 30_000).catch(() => false);
            if (deleted) {
              sweptIds.push(item.sandboxId);
            }
          }
        }
      }

      return Response.json({
        ok: true,
        count: listed.length,
        sweptIds,
        sandboxes: listed.map((item) => ({
          sandboxId: item.sandboxId,
          state: item.state,
          snapshot: item.snapshot,
          sandboxClass: item.sandboxClass,
          networkBlockAll: item.networkBlockAll,
          createdAtMs: item.createdAtMs,
          owner: item.labels[DAYTONA_LABEL_OWNER] ?? null,
          errorReason: item.errorReason,
        })),
      });
    } catch (error) {
      return Response.json(
        { ok: false, error: sanitizeErrorMessage(error, apiKey) },
        { status: 502 },
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  if (request.method === 'POST' && url.pathname === '/smoke') {
    const authError = authorizeTrigger(request, env);
    if (authError !== null) {
      return authError;
    }

    const runId = createSmokeRunId();
    const owner = `ember-b3-b0:${runId.slice(0, 16)}`;
    const sync = url.searchParams.get('sync') === '1';

    if (sync) {
      const apiKey = env.DAYTONA_API_KEY?.trim() as string;
      const apiUrl = env.DAYTONA_API_URL?.trim();
      const target = env.DAYTONA_TARGET?.trim();
      const report = await runCloudflareDaytonaSmoke({
        apiKey,
        ...(apiUrl ? { apiUrl } : {}),
        ...(target ? { target } : {}),
        runId,
        owner,
      });
      return Response.json(
        { event: report.marker, report },
        { status: report.marker === 'CLOUDFLARE_DAYTONA_SMOKE_PASS' ? 200 : 500 },
      );
    }

    const action = url.searchParams.get('action') === 'ping' ? 'ping' : 'smoke';
    const envelope: SmokeQueueMessageBody = {
      schemaVersion: 1,
      action,
      runId,
      owner,
      requestedAtIso: new Date().toISOString(),
    };

    await env.DAYTONA_SMOKE_QUEUE.send(envelope);

    return Response.json(
      {
        ok: true,
        queued: true,
        action,
        queue: expectedQueueName(env),
        runId,
        owner,
        requestedAtIso: envelope.requestedAtIso,
      },
      { status: 202 },
    );
  }

  return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
}

/**
 * Handles Cloudflare Queue Consumer batches for the B3-B0 Daytona compatibility smoke.
 */
export async function handleDaytonaSmokeQueue(
  batch: SmokeQueueBatch,
  env: DaytonaSmokeWorkerEnv,
  deps: DaytonaSmokeHandlerDeps = {},
): Promise<void> {
  const emit = deps.log ?? ((payload) => console.log(JSON.stringify(payload)));
  const queueName = expectedQueueName(env);

  if (batch.queue !== queueName) {
    for (const message of batch.messages) {
      emit({
        event: 'B3_B0_SMOKE_SKIPPED',
        reason: 'unexpected_queue',
        queue: batch.queue,
        expectedQueue: queueName,
      });
      message.ack();
    }
    return;
  }

  const apiKey = env.DAYTONA_API_KEY?.trim();

  for (const message of batch.messages) {
    try {
      const envelope = parseEnvelope(message.body);
      if (envelope === null) {
        emit({
          event: 'B3_B0_SMOKE_SKIPPED',
          reason: 'invalid_envelope',
          messageId: message.id ?? null,
        });
        message.ack();
        continue;
      }

      if (envelope.action === 'ping') {
        emit({
          event: 'B3_B0_QUEUE_PING',
          runId: envelope.runId,
          queue: batch.queue,
          messageId: message.id ?? null,
          attempts: message.attempts,
        });
        message.ack();
        continue;
      }

      if (!apiKey) {
        emit({
          event: 'B3_B0_SMOKE_BLOCKED',
          runId: envelope.runId,
          reason: 'DAYTONA_API_KEY_MISSING',
        });
        message.ack();
        continue;
      }

      const apiUrl = env.DAYTONA_API_URL?.trim();
      const target = env.DAYTONA_TARGET?.trim();
      const report = await runCloudflareDaytonaSmoke({
        apiKey,
        ...(apiUrl ? { apiUrl } : {}),
        ...(target ? { target } : {}),
        runId: envelope.runId,
        owner: envelope.owner,
        queueName: batch.queue,
        ...(message.id === undefined ? {} : { messageId: message.id }),
        messageAttempts: message.attempts,
        ...(deps.clientFactory === undefined ? {} : { clientFactory: deps.clientFactory }),
      });

      emit({
        event: report.marker,
        report,
      });
      message.ack();
    } catch (error) {
      emit({
        event: 'CLOUDFLARE_DAYTONA_SMOKE_FAIL',
        error: sanitizeErrorMessage(error, apiKey),
        messageId: message.id ?? null,
      });
      // Smoke failures are never auto-retried by the Queue so a broken smoke cannot loop Daytona spend.
      message.ack();
    }
  }
}
