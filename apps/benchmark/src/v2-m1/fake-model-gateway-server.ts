import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import {
  FAKE_MODEL_LABEL,
  FAKE_REPLY_PREFIX,
  estimateTokensConservative,
} from '@ember/model-gateway';

export type FakeGatewayMode =
  | 'fast_ok'
  | 'stream_sse'
  | 'slow_handoff'
  | 'missing_handle_hang'
  | 'usage_missing'
  | 'late_charge_revision'
  | 'error_5xx'
  | 'rate_limited';

export interface FakeGatewayScriptRule {
  readonly mode: FakeGatewayMode;
  readonly delayMs?: number;
  readonly streamChunks?: number;
  readonly chunkIntervalMs?: number;
  readonly replyText?: string;
  readonly costMicroUsd?: number;
  readonly lateRevisionCostMicroUsd?: number;
  readonly providerJobHandle?: string;
}

export interface FakeGatewayCallRecord {
  readonly callIndex: number;
  readonly operationId: string | null;
  readonly turnId: string | null;
  readonly pathname: string;
  readonly mode: FakeGatewayMode;
  readonly stream: boolean;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly aborted: boolean;
  readonly providerJobHandle: string | null;
  readonly statusCode: number;
}

export interface FakeModelGatewayAuditSnapshot {
  readonly totalCalls: number;
  readonly uniqueOperationIds: readonly string[];
  readonly abortedCalls: number;
  readonly jobPollCount: number;
  readonly calls: readonly FakeGatewayCallRecord[];
}

interface PendingJobRecord {
  readonly handle: string;
  readonly operationId: string | null;
  readonly replyText: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  readonly readyAtMs: number;
}

/**
 * Local loopback-only FakeModelGateway HTTP/SSE server for V2 M1 integration & benchmark tests.
 * Never opens external sockets and preserves deterministic `ember-fake-model-gateway-1` labeling.
 */
export class FakeModelGatewayServer {
  #server: http.Server | null = null;
  #baseUrl: string | null = null;
  #defaultRule: FakeGatewayScriptRule = { mode: 'fast_ok', costMicroUsd: 120 };
  #operationRules = new Map<string, FakeGatewayScriptRule>();
  #ruleQueue: FakeGatewayScriptRule[] = [];
  #calls: FakeGatewayCallRecord[] = [];
  #jobs = new Map<string, PendingJobRecord>();
  #lateRevisions = new Map<
    string,
    { readonly revision: number; readonly cumulativeMicroUsd: number }
  >();
  #jobPollCount = 0;

  get url(): string {
    if (this.#baseUrl === null) {
      throw new Error('FakeModelGatewayServer is not started');
    }
    return this.#baseUrl;
  }

  async start(): Promise<string> {
    if (this.#server !== null && this.#baseUrl !== null) {
      return this.#baseUrl;
    }

    const server = http.createServer((req, res) => {
      void this.#handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to bind FakeModelGatewayServer on loopback TCP port');
    }

    this.#server = server;
    this.#baseUrl = `http://127.0.0.1:${address.port}`;
    return this.#baseUrl;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#baseUrl = null;
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  setDefaultRule(rule: FakeGatewayScriptRule): void {
    this.#defaultRule = rule;
  }

  setOperationRule(operationId: string, rule: FakeGatewayScriptRule): void {
    this.#operationRules.set(operationId, rule);
  }

  enqueueRules(...rules: readonly FakeGatewayScriptRule[]): void {
    this.#ruleQueue.push(...rules);
  }

  reset(): void {
    this.#defaultRule = { mode: 'fast_ok', costMicroUsd: 120 };
    this.#operationRules.clear();
    this.#ruleQueue = [];
    this.#calls = [];
    this.#jobs.clear();
    this.#lateRevisions.clear();
    this.#jobPollCount = 0;
  }

  getAuditSnapshot(): FakeModelGatewayAuditSnapshot {
    const opIds = new Set<string>();
    let abortedCalls = 0;
    for (const c of this.#calls) {
      if (c.operationId !== null) {
        opIds.add(c.operationId);
      }
      if (c.aborted) {
        abortedCalls += 1;
      }
    }
    return {
      totalCalls: this.#calls.length,
      uniqueOperationIds: [...opIds],
      abortedCalls,
      jobPollCount: this.#jobPollCount,
      calls: [...this.#calls],
    };
  }

  async #handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url ?? '/', this.#baseUrl ?? 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      this.#sendJson(res, 200, {
        ok: true,
        simulated: true,
        mode: 'fake',
        modelLabel: FAKE_MODEL_LABEL,
        callCount: this.#calls.length,
      });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/v2/fake-model/jobs/')) {
      this.#jobPollCount += 1;
      const handle = decodeURIComponent(pathname.slice('/v2/fake-model/jobs/'.length));
      const job = this.#jobs.get(handle);
      if (job === undefined) {
        this.#sendJson(res, 404, { error: 'JOB_NOT_FOUND', handle });
        return;
      }
      const ready = Date.now() >= job.readyAtMs;
      if (!ready) {
        this.#sendJson(res, 200, {
          handle,
          status: 'running',
          modelLabel: FAKE_MODEL_LABEL,
          simulated: true,
        });
        return;
      }
      this.#sendJson(res, 200, {
        handle,
        status: 'completed',
        modelLabel: FAKE_MODEL_LABEL,
        simulated: true,
        text: job.replyText,
        usage: {
          inputTokens: job.inputTokens,
          outputTokens: job.outputTokens,
          costMicroUsd: job.costMicroUsd,
          rateVersion: 'fake-v2-m1',
        },
      });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/v2/fake-model/revisions/')) {
      const opId = decodeURIComponent(pathname.slice('/v2/fake-model/revisions/'.length));
      const rev = this.#lateRevisions.get(opId);
      if (rev === undefined) {
        this.#sendJson(res, 404, { error: 'NO_LATE_REVISION', operationId: opId });
        return;
      }
      this.#sendJson(res, 200, {
        operationId: opId,
        settlementRevision: rev.revision,
        cumulativeChargeMicroUsd: rev.cumulativeMicroUsd,
      });
      return;
    }

    if (
      req.method === 'POST' &&
      (pathname === '/v2/fake-model/complete' ||
        pathname === '/v2/fake-model/stream' ||
        pathname === '/v1/chat/completions')
    ) {
      const rawBody = await readRequestBody(req);
      let body: Record<string, unknown> = {};
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          this.#sendJson(res, 400, { error: 'INVALID_JSON' });
          return;
        }
      }

      const operationId =
        headerString(req, 'x-ember-operation-id') ??
        (typeof body.operationId === 'string' ? body.operationId : null);
      const turnId =
        headerString(req, 'x-ember-turn-id') ??
        (typeof body.turnId === 'string' ? body.turnId : null);
      const headerMode = headerString(req, 'x-ember-fault-mode') as FakeGatewayMode | null;

      const rule = this.#resolveRule(operationId, headerMode);
      const isStream = pathname === '/v2/fake-model/stream' || body.stream === true;
      const startedAtMs = Date.now();
      const promptText =
        typeof body.prompt === 'string'
          ? body.prompt
          : typeof body.text === 'string'
            ? body.text
            : 'simulated turn';
      const deterministicDigest = createHash('sha256')
        .update(`${turnId ?? 't'}:${operationId ?? 'op'}:${promptText}`)
        .digest('hex')
        .slice(0, 8);
      const replyText =
        rule.replyText ?? `${FAKE_REPLY_PREFIX}[${deterministicDigest}] Processed "${promptText}".`;
      const inputTokens = Math.max(1, estimateTokensConservative(promptText));
      const outputTokens = Math.max(1, estimateTokensConservative(replyText));
      const costMicroUsd = rule.costMicroUsd ?? 120;

      let aborted = false;
      const onClose = (): void => {
        if (!res.writableEnded) {
          aborted = true;
        }
      };
      req.on('close', onClose);

      const handle =
        rule.mode === 'missing_handle_hang'
          ? null
          : (rule.providerJobHandle ?? `fake_job_${randomUUID()}`);

      const recordCall = (statusCode: number): void => {
        req.off('close', onClose);
        this.#calls.push({
          callIndex: this.#calls.length + 1,
          operationId,
          turnId,
          pathname,
          mode: rule.mode,
          stream: isStream,
          startedAtMs,
          completedAtMs: aborted ? null : Date.now(),
          aborted,
          providerJobHandle: handle,
          statusCode,
        });
      };

      if (rule.mode === 'error_5xx') {
        if ((rule.delayMs ?? 0) > 0) {
          await sleep(rule.delayMs!);
        }
        if (aborted) {
          recordCall(499);
          return;
        }
        recordCall(503);
        this.#sendJson(res, 503, { error: 'MODEL_UNAVAILABLE', simulated: true });
        return;
      }

      if (rule.mode === 'rate_limited') {
        recordCall(429);
        this.#sendJson(res, 429, { error: 'MODEL_RATE_LIMITED', simulated: true });
        return;
      }

      if (rule.mode === 'missing_handle_hang') {
        await waitWithAbort(rule.delayMs ?? 5_000, req, () => aborted);
        if (aborted) {
          recordCall(499);
          return;
        }
        recordCall(504);
        this.#sendJson(res, 504, { error: 'MODEL_TIMEOUT_NO_HANDLE', simulated: true });
        return;
      }

      if (rule.mode === 'slow_handoff' && handle !== null) {
        const waitMs = rule.delayMs ?? 2_500;
        this.#jobs.set(handle, {
          handle,
          operationId,
          replyText,
          inputTokens,
          outputTokens,
          costMicroUsd,
          readyAtMs: Date.now() + Math.min(200, waitMs),
        });

        if (isStream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            'x-ember-provider-job-handle': handle,
          });
          res.write(
            `event: job_handle\ndata: ${JSON.stringify({ providerJobHandle: handle, modelLabel: FAKE_MODEL_LABEL })}\n\n`,
          );
          res.write(`event: delta\ndata: ${JSON.stringify({ text: FAKE_REPLY_PREFIX })}\n\n`);
          await waitWithAbort(waitMs, req, () => aborted);
          if (!aborted && !res.writableEnded) {
            res.write(
              `event: done\ndata: ${JSON.stringify({
                text: replyText,
                providerJobHandle: handle,
                usage: { inputTokens, outputTokens, costMicroUsd, rateVersion: 'fake-v2-m1' },
              })}\n\n`,
            );
            res.end();
          }
          recordCall(200);
          return;
        }

        await waitWithAbort(waitMs, req, () => aborted);
        if (aborted) {
          recordCall(499);
          return;
        }
        recordCall(200);
        this.#sendJson(res, 200, {
          modelLabel: FAKE_MODEL_LABEL,
          simulated: true,
          providerJobHandle: handle,
          text: replyText,
          usage: { inputTokens, outputTokens, costMicroUsd, rateVersion: 'fake-v2-m1' },
        });
        return;
      }

      if (rule.mode === 'late_charge_revision' && operationId !== null) {
        this.#lateRevisions.set(operationId, {
          revision: 1,
          cumulativeMicroUsd: rule.lateRevisionCostMicroUsd ?? costMicroUsd + 380,
        });
      }

      if ((rule.delayMs ?? 0) > 0) {
        await waitWithAbort(rule.delayMs!, req, () => aborted);
        if (aborted) {
          recordCall(499);
          return;
        }
      }

      const usage =
        rule.mode === 'usage_missing'
          ? null
          : {
              inputTokens,
              outputTokens,
              costMicroUsd,
              rateVersion: 'fake-v2-m1',
            };

      if (isStream) {
        const chunkCount = Math.max(2, rule.streamChunks ?? 4);
        const chunkDelay = Math.max(0, rule.chunkIntervalMs ?? 5);
        const words = splitIntoChunks(replyText, chunkCount);

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          ...(handle !== null ? { 'x-ember-provider-job-handle': handle } : {}),
        });
        if (handle !== null) {
          res.write(
            `event: job_handle\ndata: ${JSON.stringify({ providerJobHandle: handle, modelLabel: FAKE_MODEL_LABEL })}\n\n`,
          );
        }
        for (const chunk of words) {
          if (aborted || res.writableEnded) {
            break;
          }
          res.write(`event: delta\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
          if (chunkDelay > 0) {
            await waitWithAbort(chunkDelay, req, () => aborted);
          }
        }
        if (!aborted && !res.writableEnded) {
          res.write(
            `event: done\ndata: ${JSON.stringify({
              modelLabel: FAKE_MODEL_LABEL,
              simulated: true,
              providerJobHandle: handle,
              text: replyText,
              usage,
            })}\n\n`,
          );
          res.end();
        }
        recordCall(200);
        return;
      }

      recordCall(200);
      this.#sendJson(res, 200, {
        modelLabel: FAKE_MODEL_LABEL,
        simulated: true,
        providerJobHandle: handle,
        text: replyText,
        usage,
      });
      return;
    }

    this.#sendJson(res, 404, { error: 'NOT_FOUND', pathname });
  }

  #resolveRule(
    operationId: string | null,
    headerMode: FakeGatewayMode | null,
  ): FakeGatewayScriptRule {
    if (headerMode !== null) {
      return { ...this.#defaultRule, mode: headerMode };
    }
    if (operationId !== null) {
      const byOp = this.#operationRules.get(operationId);
      if (byOp !== undefined) {
        return byOp;
      }
    }
    const queued = this.#ruleQueue.shift();
    if (queued !== undefined) {
      return queued;
    }
    return this.#defaultRule;
  }

  #sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }
}

function headerString(req: http.IncomingMessage, name: string): string | null {
  const val = req.headers[name];
  if (typeof val === 'string' && val.trim().length > 0) {
    return val.trim();
  }
  return null;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitWithAbort(
  ms: number,
  req: http.IncomingMessage,
  isAborted: () => boolean,
): Promise<void> {
  if (ms <= 0 || isAborted()) return Promise.resolve();
  return new Promise((resolve) => {
    const onClose = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      req.off('close', onClose);
      resolve();
    }, ms);
    req.once('close', onClose);
  });
}

function splitIntoChunks(text: string, parts: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / parts));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out.length > 0 ? out : [text];
}
