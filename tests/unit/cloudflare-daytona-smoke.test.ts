import { describe, expect, it } from 'vitest';

import {
  DAYTONA_SANDBOX_LIMITS,
  DaytonaExecCancelledError,
  type DaytonaCreateRequest,
  type DaytonaExecRequest,
  type DaytonaExecResult,
  type DaytonaListFilter,
  type DaytonaMetricsSample,
  type DaytonaSandboxClient,
  type DaytonaSandboxInfo,
} from '../../packages/sandbox-daytona/src/index.js';
import { runCloudflareDaytonaSmoke } from '../../apps/cloud-async-runtime/src/daytona-smoke.js';
import {
  DAYTONA_SMOKE_QUEUE_NAME,
  handleDaytonaSmokeFetch,
  handleDaytonaSmokeQueue,
  type DaytonaSmokeWorkerEnv,
  type SmokeQueueMessageBody,
} from '../../apps/cloud-async-runtime/src/daytona-smoke-handler.js';

interface TestSandbox {
  readonly sandboxId: string;
  state: 'started' | 'stopped' | 'destroying' | 'destroyed';
  readonly request: DaytonaCreateRequest;
  readonly createdAtMs: number;
  staleListPollsRemaining?: number;
}

class InMemorySmokeDaytonaClient implements DaytonaSandboxClient {
  public readonly sandboxes = new Map<string, TestSandbox>();
  public readonly createRequests: DaytonaCreateRequest[] = [];
  public readonly execRequests: DaytonaExecRequest[] = [];
  public readonly deletedIds: string[] = [];
  public failOnExecCommandMatch: string | null = null;
  public throwWithApiKeyInMessage: string | null = null;
  public transientDestroyingPolls = 0;
  public staleStartedListPolls = 0;
  public closedCount = 0;
  private sequence = 0;

  public async create(request: DaytonaCreateRequest): Promise<{ readonly sandboxId: string }> {
    if (this.throwWithApiKeyInMessage !== null) {
      throw new Error(`upstream error with key=${this.throwWithApiKeyInMessage}`);
    }
    this.createRequests.push(request);
    this.sequence += 1;
    const sandboxId = `sbx-b3b0-${this.sequence}`;
    this.sandboxes.set(sandboxId, {
      sandboxId,
      state: 'started',
      request,
      createdAtMs: Date.now(),
    });
    return Promise.resolve({ sandboxId });
  }

  public async get(sandboxId: string): Promise<DaytonaSandboxInfo | null> {
    const sbx = this.sandboxes.get(sandboxId);
    if (sbx === undefined || sbx.state === 'destroyed') {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      sandboxId: sbx.sandboxId,
      state: sbx.state,
      snapshot: sbx.request.snapshot,
      sandboxClass: 'container',
      cpu: 1,
      memoryGiB: 1,
      diskGiB: 3,
      createdAtMs: sbx.createdAtMs,
      networkBlockAll: sbx.request.networkBlockAll,
      autoStopIntervalMinutes: sbx.request.autoStopIntervalMinutes,
      autoDeleteIntervalMinutes: sbx.request.autoDeleteIntervalMinutes,
      autoDestroyAtMs: sbx.createdAtMs + sbx.request.ttlMinutes * 60_000,
      labels: sbx.request.labels,
      errorReason: null,
    });
  }

  public async list(filter: DaytonaListFilter): Promise<readonly DaytonaSandboxInfo[]> {
    const labels = filter.labels ?? {};
    const out: DaytonaSandboxInfo[] = [];
    for (const sbx of this.sandboxes.values()) {
      if (sbx.state === 'destroyed' && (sbx.staleListPollsRemaining ?? 0) > 0) {
        sbx.staleListPollsRemaining = (sbx.staleListPollsRemaining ?? 0) - 1;
        out.push({
          sandboxId: sbx.sandboxId,
          state: 'started',
          snapshot: sbx.request.snapshot,
          sandboxClass: 'container',
          cpu: 1,
          memoryGiB: 1,
          diskGiB: 3,
          createdAtMs: sbx.createdAtMs,
          networkBlockAll: sbx.request.networkBlockAll,
          autoStopIntervalMinutes: sbx.request.autoStopIntervalMinutes,
          autoDeleteIntervalMinutes: sbx.request.autoDeleteIntervalMinutes,
          autoDestroyAtMs: sbx.createdAtMs + sbx.request.ttlMinutes * 60_000,
          labels: sbx.request.labels,
          errorReason: null,
        });
        continue;
      }
      if (sbx.state === 'destroying') {
        if (this.transientDestroyingPolls > 0) {
          this.transientDestroyingPolls -= 1;
        } else {
          sbx.state = 'destroyed';
        }
      }
      if (sbx.state === 'destroyed') {
        continue;
      }
      const matchesLabels = Object.entries(labels).every(([k, v]) => sbx.request.labels[k] === v);
      if (!matchesLabels) {
        continue;
      }
      if (filter.states !== undefined && !filter.states.includes(sbx.state)) {
        continue;
      }
      const info = await this.get(sbx.sandboxId);
      if (info !== null) {
        out.push(info);
      }
    }
    return out;
  }

  public async start(sandboxId: string): Promise<void> {
    const sbx = this.sandboxes.get(sandboxId);
    if (sbx !== undefined) {
      sbx.state = 'started';
    }
    return Promise.resolve();
  }

  public async stop(sandboxId: string): Promise<void> {
    const sbx = this.sandboxes.get(sandboxId);
    if (sbx !== undefined) {
      sbx.state = 'stopped';
    }
    return Promise.resolve();
  }

  public async delete(sandboxId: string): Promise<boolean> {
    const sbx = this.sandboxes.get(sandboxId);
    if (sbx === undefined || sbx.state === 'destroyed') {
      return Promise.resolve(true);
    }
    this.deletedIds.push(sandboxId);
    sbx.state = this.transientDestroyingPolls > 0 ? 'destroying' : 'destroyed';
    if (sbx.state === 'destroyed' && this.staleStartedListPolls > 0) {
      sbx.staleListPollsRemaining = this.staleStartedListPolls;
      this.staleStartedListPolls = 0;
    }
    return Promise.resolve(true);
  }

  public async exec(_sandboxId: string, request: DaytonaExecRequest): Promise<DaytonaExecResult> {
    this.execRequests.push(request);
    if (
      this.failOnExecCommandMatch !== null &&
      request.command.includes(this.failOnExecCommandMatch)
    ) {
      throw new Error('injected exec failure');
    }

    if (request.command.includes('forbidden_keys')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: '{"ok":true,"python":"3.12.0","uid":1001,"env_count":5,"forbidden_keys":[]}\n',
        stderr: '',
        timedOut: false,
      });
    }

    if (request.command.includes('b3-b0-stderr-probe')) {
      return Promise.resolve({
        exitCode: 42,
        stdout: '',
        stderr: 'b3-b0-stderr-probe\n',
        timedOut: false,
      });
    }

    if (request.command.includes('time.sleep(10)')) {
      return Promise.resolve({
        exitCode: 124,
        stdout: '',
        stderr: 'command exceeded its timeout',
        timedOut: true,
      });
    }

    if (request.command.includes('metadata_http')) {
      return Promise.resolve({
        exitCode: 0,
        stdout:
          '{"dns":{"blocked":true,"error":"gaierror"},"https":{"blocked":true,"error":"URLError"},"metadata_http":{"status":403,"server":"envoy"}}\n',
        stderr: '',
        timedOut: false,
      });
    }

    if (request.command.includes('time.sleep(20)')) {
      return new Promise((_resolve, reject) => {
        if (request.signal?.aborted) {
          reject(new DaytonaExecCancelledError());
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error('expected abort before timeout'));
        }, 5_000);
        request.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DaytonaExecCancelledError());
          },
          { once: true },
        );
      });
    }

    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
  }

  public upload(): Promise<void> {
    return Promise.resolve();
  }

  public download(): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(0));
  }

  public exists(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public latestMetrics(): Promise<DaytonaMetricsSample | null> {
    return Promise.resolve(null);
  }

  public close(): Promise<void> {
    this.closedCount += 1;
    return Promise.resolve();
  }
}

describe('B3-B0 Cloudflare Daytona smoke runner', () => {
  it('runs the full container-small Python lifecycle, deny-all check, cancel cleanup, and zero-residue audit', async () => {
    const client = new InMemorySmokeDaytonaClient();
    client.transientDestroyingPolls = 1;
    client.staleStartedListPolls = 1;

    const report = await runCloudflareDaytonaSmoke({
      apiKey: 'daytona-secret-value-for-test',
      runId: 'run-b3-b0-001',
      owner: 'ember-b3-b0:test',
      queueName: DAYTONA_SMOKE_QUEUE_NAME,
      messageId: 'msg-1',
      messageAttempts: 1,
      execTimeoutMs: 500,
      cancelAbortDelayMs: 25,
      clientFactory: () => client,
    });

    expect(report.marker).toBe('CLOUDFLARE_DAYTONA_SMOKE_PASS');
    expect(report.errors).toEqual([]);
    expect(report.profile.id).toBe('container-small');
    expect(report.profile.snapshot).toBe('daytona-small');
    expect(report.profile.networkPolicyId).toBe('deny-all');
    expect(report.lifecycle.networkBlockAllReported).toBe(true);
    expect(report.lifecycle.autoStopIntervalMinutes).toBe(DAYTONA_SANDBOX_LIMITS.idleStopMinutes);
    expect(report.lifecycle.autoDeleteIntervalMinutes).toBe(0);
    expect(report.isolation.secretsAbsentInSandbox).toBe(true);
    expect(report.isolation.dnsBlocked).toBe(true);
    expect(report.isolation.httpsBlocked).toBe(true);
    expect(report.cleanup.primaryLiveAfterDestroy).toEqual([]);
    expect(report.cleanup.finalLiveSandboxIds).toEqual([]);
    expect(client.createRequests).toHaveLength(2);
    expect(client.createRequests.every((req) => req.networkBlockAll === true)).toBe(true);
    expect(client.deletedIds).toEqual(['sbx-b3b0-1', 'sbx-b3b0-2']);
    expect(client.closedCount).toBe(1);
    expect(report.steps['verifyPrimaryCleaned']?.details?.['settleAttempts']).toBe(1);
    expect(JSON.stringify(report)).not.toContain('daytona-secret-value-for-test');
  });

  it('destroys sandboxes in finally when an exception occurs mid-execution and redacts api keys', async () => {
    const client = new InMemorySmokeDaytonaClient();
    client.failOnExecCommandMatch = 'b3-b0-stderr-probe';

    const report = await runCloudflareDaytonaSmoke({
      apiKey: 'super-secret-daytona-key',
      runId: 'run-b3-b0-fail',
      cancelAbortDelayMs: 25,
      clientFactory: () => client,
    });

    expect(report.marker).toBe('CLOUDFLARE_DAYTONA_SMOKE_FAIL');
    expect(report.steps['destroyPrimary']?.status).toBe('PASS');
    expect(report.cleanup.primaryLiveAfterDestroy).toEqual([]);
    expect(report.cleanup.finalLiveSandboxIds).toEqual([]);

    const errorClient = new InMemorySmokeDaytonaClient();
    errorClient.throwWithApiKeyInMessage = 'super-secret-daytona-key';
    const redactedReport = await runCloudflareDaytonaSmoke({
      apiKey: 'super-secret-daytona-key',
      runId: 'run-b3-b0-redact',
      cancelAbortDelayMs: 25,
      clientFactory: () => errorClient,
    });

    const serialized = JSON.stringify(redactedReport);
    expect(serialized).not.toContain('super-secret-daytona-key');
    expect(serialized).toContain('[REDACTED]');
  });
});

describe('B3-B0 Cloudflare Smoke Worker handlers', () => {
  it('enforces trigger token on POST /smoke and executes queue batch cleanly', async () => {
    const sent: SmokeQueueMessageBody[] = [];
    const env: DaytonaSmokeWorkerEnv = {
      EMBER_ENV: 'staging',
      DAYTONA_API_KEY: 'test-daytona-key',
      EMBER_SMOKE_TRIGGER_TOKEN: 'trigger-token-123',
      DAYTONA_SMOKE_QUEUE: {
        send: async (msg) => {
          sent.push(msg);
          return Promise.resolve();
        },
      },
    };

    const healthResp = await handleDaytonaSmokeFetch(
      new Request('https://example.workers.dev/healthz'),
      env,
    );
    expect(healthResp.status).toBe(200);
    const healthBody = (await healthResp.json()) as { readonly hasDaytonaApiKey: boolean };
    expect(healthBody.hasDaytonaApiKey).toBe(true);

    const unauthResp = await handleDaytonaSmokeFetch(
      new Request('https://example.workers.dev/smoke', { method: 'POST' }),
      env,
    );
    expect(unauthResp.status).toBe(401);

    const triggerResp = await handleDaytonaSmokeFetch(
      new Request('https://example.workers.dev/smoke', {
        method: 'POST',
        headers: { authorization: 'Bearer trigger-token-123' },
      }),
      env,
    );
    expect(triggerResp.status).toBe(202);
    expect(sent).toHaveLength(1);

    const client = new InMemorySmokeDaytonaClient();
    const logs: Record<string, unknown>[] = [];
    let acked = false;

    await handleDaytonaSmokeQueue(
      {
        queue: DAYTONA_SMOKE_QUEUE_NAME,
        messages: [
          {
            id: 'msg-queue-1',
            attempts: 1,
            body: sent[0],
            ack: () => {
              acked = true;
            },
            retry: () => {
              throw new Error('smoke should not retry');
            },
          },
        ],
      },
      env,
      {
        clientFactory: () => client,
        log: (payload) => logs.push(payload),
      },
    );

    expect(acked).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.['event']).toBe('CLOUDFLARE_DAYTONA_SMOKE_PASS');
  });

  it('supports ping action on queue and auth-gates GET /sandboxes', async () => {
    const sent: SmokeQueueMessageBody[] = [];
    const env: DaytonaSmokeWorkerEnv = {
      EMBER_ENV: 'staging',
      DAYTONA_API_KEY: 'test-daytona-key',
      EMBER_SMOKE_TRIGGER_TOKEN: 'trigger-token-123',
      DAYTONA_SMOKE_QUEUE: {
        send: async (msg) => {
          sent.push(msg);
          return Promise.resolve();
        },
      },
    };

    const unauthSandboxes = await handleDaytonaSmokeFetch(
      new Request('https://example.workers.dev/sandboxes'),
      env,
    );
    expect(unauthSandboxes.status).toBe(401);

    const pingResp = await handleDaytonaSmokeFetch(
      new Request('https://example.workers.dev/smoke?action=ping', {
        method: 'POST',
        headers: { authorization: 'Bearer trigger-token-123' },
      }),
      env,
    );
    expect(pingResp.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.action).toBe('ping');

    const logs: Record<string, unknown>[] = [];
    let acked = false;
    await handleDaytonaSmokeQueue(
      {
        queue: DAYTONA_SMOKE_QUEUE_NAME,
        messages: [
          {
            id: 'msg-ping-1',
            attempts: 1,
            body: sent[0],
            ack: () => {
              acked = true;
            },
            retry: () => {
              throw new Error('ping should not retry');
            },
          },
        ],
      },
      env,
      { log: (payload) => logs.push(payload) },
    );

    expect(acked).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.['event']).toBe('B3_B0_QUEUE_PING');
  });
});
