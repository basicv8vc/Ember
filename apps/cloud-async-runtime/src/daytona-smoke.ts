import { randomUUID } from 'node:crypto';

import type { SandboxSpec } from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import { SandboxAdapter } from '@ember/execution';
import {
  DAYTONA_DEFAULT_NETWORK_POLICY_ID,
  DAYTONA_INSTALLED_SDK_VERSION,
  DAYTONA_PINNED_SDK_VERSION,
  DAYTONA_PRICING,
  DAYTONA_SANDBOX_LIMITS,
  DAYTONA_SANDBOX_PROFILES,
  DaytonaSandboxProvider,
  DaytonaSdkSandboxClient,
  estimateCostUsd,
  sweepOrphanedSandboxes,
  type DaytonaSandboxClient,
} from '@ember/sandbox-daytona';

const SMOKE_TENANT_ID = '00000000-0000-4000-8000-00000000b3b0';

const FORBIDDEN_SECRET_PATTERNS = [
  'DAYTONA_API_KEY',
  'DAYTONA_JWT_TOKEN',
  'EMBER_',
  'CLOUDFLARE_',
  'NEON_',
  'DATABASE_',
  'HYPERDRIVE',
  'OPENROUTER',
  'OPENAI_',
  'ANTHROPIC_',
  'GEMINI_',
  'API_KEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PRIVATE_KEY',
] as const;

const PYTHON_OK_ARGV: readonly string[] = [
  'python3',
  '-c',
  [
    'import json, os, sys',
    `patterns = ${JSON.stringify(FORBIDDEN_SECRET_PATTERNS)}`,
    'matched = sorted(k for k in os.environ.keys() if any(p in k.upper() for p in patterns))',
    'vendor_meta = sorted(k for k in os.environ.keys() if k.upper().startswith("DAYTONA_") and k not in matched)',
    'print(json.dumps({"ok": True, "python": sys.version.split()[0], "uid": os.getuid(), "env_count": len(os.environ), "forbidden_keys": matched, "daytona_meta_keys": vendor_meta}))',
  ].join('; '),
];

const PYTHON_FAIL_ARGV: readonly string[] = [
  'python3',
  '-c',
  'import sys; print("b3-b0-stderr-probe", file=sys.stderr); sys.exit(42)',
];

const PYTHON_TIMEOUT_ARGV: readonly string[] = ['python3', '-c', 'import time; time.sleep(10)'];

const PYTHON_CANCEL_ARGV: readonly string[] = ['python3', '-c', 'import time; time.sleep(20)'];

const PYTHON_NETWORK_PROBE_ARGV: readonly string[] = [
  'python3',
  '-c',
  `import json, socket, urllib.error, urllib.request
socket.setdefaulttimeout(3)
def check_dns():
    try:
        ip = socket.gethostbyname("example.com")
        return {"blocked": False, "ip": ip}
    except Exception as exc:
        return {"blocked": True, "error": type(exc).__name__}

def check_https():
    try:
        with urllib.request.urlopen("https://example.com", timeout=3) as resp:
            return {"blocked": False, "status": resp.status}
    except Exception as exc:
        return {"blocked": True, "error": type(exc).__name__}

def check_metadata_http():
    req = urllib.request.Request("http://169.254.169.254/latest/meta-data/", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            return {"status": resp.status, "server": resp.headers.get("Server")}
    except urllib.error.HTTPError as exc:
        return {"status": exc.code, "server": exc.headers.get("Server") if exc.headers else None}
    except Exception as exc:
        return {"status": None, "error": type(exc).__name__}

print(json.dumps({"dns": check_dns(), "https": check_https(), "metadata_http": check_metadata_http()}))`,
];

export type SmokeStepStatus = 'PASS' | 'FAIL';

export interface SmokeStepOutcome {
  readonly status: SmokeStepStatus;
  readonly wallTimeMs: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface CloudflareDaytonaSmokeOptions {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly target?: string;
  readonly runId: string;
  readonly owner?: string;
  readonly queueName?: string;
  readonly messageId?: string;
  readonly messageAttempts?: number;
  readonly execTimeoutMs?: number;
  readonly cancelAbortDelayMs?: number;
  readonly clock?: () => number;
  readonly clientFactory?: (options: {
    readonly apiKey: string;
    readonly apiUrl?: string;
    readonly target?: string;
  }) => DaytonaSandboxClient;
}

export interface CloudflareDaytonaSmokeReport {
  readonly marker: 'CLOUDFLARE_DAYTONA_SMOKE_PASS' | 'CLOUDFLARE_DAYTONA_SMOKE_FAIL';
  readonly runId: string;
  readonly owner: string;
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
  readonly queue: {
    readonly name: string | null;
    readonly messageId: string | null;
    readonly attempts: number | null;
  };
  readonly runtime: {
    readonly hasWebSocketPair: boolean;
    readonly installedSdkVersion: string;
    readonly pinnedSdkVersion: string;
    readonly cpuTimeSource: 'cloudflare_tail_trace_item';
    readonly wallTimeMs: number;
    readonly processCpuUsageDeltaUs: { readonly user: number; readonly system: number } | null;
  };
  readonly profile: {
    readonly id: string;
    readonly snapshot: string;
    readonly sandboxClass: string;
    readonly networkPolicyId: string;
    readonly maxSandboxLifetimeSec: number;
    readonly maxExecTimeoutMs: number;
    readonly idleStopMinutes: number;
    readonly autoDeleteMinutesAfterStop: number;
  };
  readonly sandboxes: {
    readonly primaryId: string | null;
    readonly cancelId: string | null;
  };
  readonly timingsMs: {
    readonly createMs: number | null;
    readonly waitReadyMs: number | null;
    readonly coldStartMs: number | null;
    readonly pythonOkMs: number | null;
    readonly pythonFailMs: number | null;
    readonly pythonTimeoutMs: number | null;
    readonly networkProbeMs: number | null;
    readonly destroyMs: number | null;
    readonly cancelCreateAndReadyMs: number | null;
    readonly cancelAbortObservedMs: number | null;
    readonly cancelDestroyMs: number | null;
    readonly orphanSweepMs: number | null;
    readonly totalWallTimeMs: number;
  };
  readonly lifecycle: {
    readonly networkBlockAllReported: boolean | null;
    readonly autoStopIntervalMinutes: number | null;
    readonly autoDeleteIntervalMinutes: number | null;
    readonly autoDestroyAtMs: number | null;
    readonly sandboxClassReported: string | null;
    readonly snapshotReported: string | null;
  };
  readonly isolation: {
    readonly secretsAbsentInSandbox: boolean;
    readonly forbiddenKeysFound: readonly string[];
    readonly dnsBlocked: boolean | null;
    readonly httpsBlocked: boolean | null;
    readonly metadataHttpStatus: number | null;
    readonly metadataServerHeader: string | null;
  };
  readonly cleanup: {
    readonly primaryLiveAfterDestroy: readonly string[];
    readonly finalLiveSandboxIds: readonly string[];
    readonly orphanSweptIds: readonly string[];
    readonly orphanSweepFailures: number;
  };
  readonly cost: {
    readonly basis: 'RESERVATION_WALL_CLOCK';
    readonly pricing: typeof DAYTONA_PRICING;
    readonly primaryHoldSeconds: number | null;
    readonly cancelHoldSeconds: number | null;
    readonly estimatedTotalUsd: number | null;
  };
  readonly steps: Readonly<Record<string, SmokeStepOutcome>>;
  readonly errors: readonly string[];
}

function redactSecrets(message: string, secrets: readonly string[]): string {
  let sanitized = message;
  for (const secret of secrets) {
    if (secret.length > 0) {
      sanitized = sanitized.replaceAll(secret, '[REDACTED]');
    }
  }
  return sanitized;
}

function formatError(error: unknown, secrets: readonly string[]): string {
  if (error instanceof DomainError) {
    return redactSecrets(`${error.name}(${error.code}): ${error.message}`, secrets);
  }
  if (error instanceof Error) {
    return redactSecrets(`${error.name}: ${error.message}`, secrets);
  }
  return redactSecrets(String(error), secrets);
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

/**
 * Audits that no live sandboxes remain for this smoke run's owner.
 *
 * Daytona's `list()` index is eventually consistent and can briefly report a just-deleted sandbox
 * as `destroying` or `started` after `GET /sandbox/{id}` already confirms it is gone or destroying.
 * Polls briefly only while every listed sandbox is in `destroying` or confirmed gone/destroying
 * by `client.get(id)`.
 */
async function waitForSandboxesCleaned(
  provider: DaytonaSandboxProvider,
  client: DaytonaSandboxClient,
  clock: () => number,
  maxSettleMs = 10_000,
): Promise<{
  readonly liveSandboxIds: readonly string[];
  readonly liveStates: Readonly<Record<string, string>>;
  readonly initialLiveStates: Readonly<Record<string, string>>;
  readonly settleAttempts: number;
}> {
  const start = clock();
  let audit = await provider.verifyNoLiveSandboxes();
  const initialLiveStates = audit.liveStates;
  let settleAttempts = 0;

  while (audit.liveSandboxIds.length > 0 && clock() - start < maxSettleMs) {
    const confirmedDeletingOrGone = await Promise.all(
      audit.liveSandboxIds.map(async (id) => {
        if (audit.liveStates[id] === 'destroying') {
          return true;
        }
        const info = await client.get(id).catch(() => null);
        return info === null || info.state === 'destroyed' || info.state === 'destroying';
      }),
    );
    if (!confirmedDeletingOrGone.every(Boolean)) {
      break;
    }
    settleAttempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 500));
    audit = await provider.verifyNoLiveSandboxes();
  }

  return {
    liveSandboxIds: audit.liveSandboxIds,
    liveStates: audit.liveStates,
    initialLiveStates,
    settleAttempts,
  };
}

function buildSpec(tenantId: string, runId: string, snapshot: string): SandboxSpec {
  return {
    tenantId,
    runId,
    imageDigest: snapshot,
    cpuMilli: 1_000,
    memoryMiB: 1_024,
    maxLifetimeSec: DAYTONA_SANDBOX_LIMITS.maxSandboxLifetimeSec,
    networkPolicyId: DAYTONA_DEFAULT_NETWORK_POLICY_ID,
  };
}

function readCpuUsage(): { readonly user: number; readonly system: number } | null {
  try {
    if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function') {
      const usage = process.cpuUsage();
      return { user: usage.user, system: usage.system };
    }
  } catch {
    // cpuUsage is unavailable or throws in some serverless isolates.
  }
  return null;
}

function diffCpuUsage(
  before: { readonly user: number; readonly system: number } | null,
  after: { readonly user: number; readonly system: number } | null,
): { readonly user: number; readonly system: number } | null {
  if (before === null || after === null) {
    return null;
  }
  return {
    user: Math.max(0, after.user - before.user),
    system: Math.max(0, after.system - before.system),
  };
}

/**
 * Executes the B3-B0 Cloudflare Workers + Daytona compatibility smoke inside a Queue Consumer
 * or compatible Worker isolate, reusing `@ember/sandbox-daytona` and `SandboxAdapter`.
 */
export async function runCloudflareDaytonaSmoke(
  options: CloudflareDaytonaSmokeOptions,
): Promise<CloudflareDaytonaSmokeReport> {
  const clock = options.clock ?? Date.now;
  const startedAtMs = clock();
  const cpuBefore = readCpuUsage();
  const secrets = [options.apiKey];
  const profile = DAYTONA_SANDBOX_PROFILES['container-small'];
  if (profile === undefined) {
    throw new Error('container-small profile missing from DAYTONA_SANDBOX_PROFILES');
  }

  const owner = options.owner ?? `ember-b3-b0:${options.runId.slice(0, 16)}`;
  const execTimeoutMs = options.execTimeoutMs ?? 2_000;
  const cancelAbortDelayMs = options.cancelAbortDelayMs ?? 1_500;
  const steps: Record<string, SmokeStepOutcome> = {};
  const errors: string[] = [];

  const state: {
    primarySandboxId: Id | null;
    cancelSandboxId: Id | null;
    primaryHoldStartedAtMs: number | null;
    primaryHoldSeconds: number | null;
    cancelHoldStartedAtMs: number | null;
    cancelHoldSeconds: number | null;
    createMs: number | null;
    waitReadyMs: number | null;
    pythonOkMs: number | null;
    pythonFailMs: number | null;
    pythonTimeoutMs: number | null;
    networkProbeMs: number | null;
    destroyMs: number | null;
    cancelCreateAndReadyMs: number | null;
    cancelAbortObservedMs: number | null;
    cancelDestroyMs: number | null;
    orphanSweepMs: number | null;
    networkBlockAllReported: boolean | null;
    autoStopIntervalMinutes: number | null;
    autoDeleteIntervalMinutes: number | null;
    autoDestroyAtMs: number | null;
    sandboxClassReported: string | null;
    snapshotReported: string | null;
    secretsAbsentInSandbox: boolean;
    forbiddenKeysFound: string[];
    dnsBlocked: boolean | null;
    httpsBlocked: boolean | null;
    metadataHttpStatus: number | null;
    metadataServerHeader: string | null;
    primaryLiveAfterDestroy: readonly string[];
    finalLiveSandboxIds: readonly string[];
    orphanSweptIds: readonly string[];
    orphanSweepFailures: number;
  } = {
    primarySandboxId: null,
    cancelSandboxId: null,
    primaryHoldStartedAtMs: null,
    primaryHoldSeconds: null,
    cancelHoldStartedAtMs: null,
    cancelHoldSeconds: null,
    createMs: null,
    waitReadyMs: null,
    pythonOkMs: null,
    pythonFailMs: null,
    pythonTimeoutMs: null,
    networkProbeMs: null,
    destroyMs: null,
    cancelCreateAndReadyMs: null,
    cancelAbortObservedMs: null,
    cancelDestroyMs: null,
    orphanSweepMs: null,
    networkBlockAllReported: null,
    autoStopIntervalMinutes: null,
    autoDeleteIntervalMinutes: null,
    autoDestroyAtMs: null,
    sandboxClassReported: null,
    snapshotReported: null,
    secretsAbsentInSandbox: false,
    forbiddenKeysFound: [],
    dnsBlocked: null,
    httpsBlocked: null,
    metadataHttpStatus: null,
    metadataServerHeader: null,
    primaryLiveAfterDestroy: [],
    finalLiveSandboxIds: [],
    orphanSweptIds: [],
    orphanSweepFailures: 0,
  };

  const client = (
    options.clientFactory ??
    ((cfg) =>
      new DaytonaSdkSandboxClient({
        apiKey: cfg.apiKey,
        ...(cfg.apiUrl === undefined ? {} : { apiUrl: cfg.apiUrl }),
        ...(cfg.target === undefined ? {} : { target: cfg.target }),
      }))
  )({
    apiKey: options.apiKey,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.target === undefined ? {} : { target: options.target }),
  });

  const provider = new DaytonaSandboxProvider({
    tenantId: SMOKE_TENANT_ID,
    runId: options.runId,
    client,
    snapshot: profile.snapshot,
    sandboxClass: profile.sandboxClass,
    diskGiB: profile.diskGiB,
    owner,
    clock,
  });

  const runStep = async <T>(
    name: string,
    body: () => Promise<{
      readonly value: T;
      readonly details?: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<T> => {
    const stepStart = clock();
    try {
      const result = await body();
      steps[name] = {
        status: 'PASS',
        wallTimeMs: Math.round(clock() - stepStart),
        ...(result.details === undefined ? {} : { details: result.details }),
      };
      return result.value;
    } catch (error) {
      const formatted = formatError(error, secrets);
      steps[name] = {
        status: 'FAIL',
        wallTimeMs: Math.round(clock() - stepStart),
        error: formatted,
      };
      errors.push(`${name}: ${formatted}`);
      throw error;
    }
  };

  // Phase 1: Primary container-small lifecycle
  try {
    await runStep('preflight', async () => {
      const capabilities = await provider.capabilities();
      return {
        value: undefined,
        details: {
          capabilities,
          installedSdkVersion: DAYTONA_INSTALLED_SDK_VERSION,
          pinnedSdkVersion: DAYTONA_PINNED_SDK_VERSION,
          hasWebSocketPair:
            typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === 'function',
        },
      };
    });

    state.primarySandboxId = await runStep('create', async () => {
      const start = clock();
      const created = await provider.create(
        buildSpec(SMOKE_TENANT_ID, options.runId, profile.snapshot),
      );
      state.createMs = Math.round(clock() - start);
      state.primaryHoldStartedAtMs = clock();
      return {
        value: created.sandboxId,
        details: { sandboxId: created.sandboxId },
      };
    });

    await runStep('waitReady', async () => {
      const start = clock();
      await provider.waitReady(
        state.primarySandboxId as Id,
        DAYTONA_SANDBOX_LIMITS.maxReadyDeadlineMs,
      );
      state.waitReadyMs = Math.round(clock() - start);

      const info = await client.get(state.primarySandboxId as Id);
      if (info === null) {
        throw new Error('sandbox disappeared after waitReady');
      }

      state.networkBlockAllReported = info.networkBlockAll;
      state.autoStopIntervalMinutes = info.autoStopIntervalMinutes;
      state.autoDeleteIntervalMinutes = info.autoDeleteIntervalMinutes;
      state.autoDestroyAtMs = info.autoDestroyAtMs;
      state.sandboxClassReported = info.sandboxClass;
      state.snapshotReported = info.snapshot;

      if (info.sandboxClass !== profile.sandboxClass) {
        throw new Error(`expected class ${profile.sandboxClass}, got ${String(info.sandboxClass)}`);
      }
      if (info.networkBlockAll !== true) {
        throw new Error('networkBlockAll was not reported as true');
      }

      return {
        value: undefined,
        details: {
          state: info.state,
          cpu: info.cpu,
          memoryGiB: info.memoryGiB,
          diskGiB: info.diskGiB,
          networkBlockAll: info.networkBlockAll,
        },
      };
    });

    await runStep('pythonExecOk', async () => {
      const start = clock();
      const execResult = await provider.exec(state.primarySandboxId as Id, PYTHON_OK_ARGV, 30_000);
      state.pythonOkMs = Math.round(clock() - start);

      const stdout = await provider.readOutput(state.primarySandboxId as Id, execResult.stdoutRef);
      const stderr = await provider.readOutput(state.primarySandboxId as Id, execResult.stderrRef);

      if (execResult.exitCode !== 0) {
        throw new Error(`expected exit code 0, got ${execResult.exitCode}; stderr=${stderr}`);
      }

      const parsed = JSON.parse(stdout.trim()) as {
        readonly ok?: unknown;
        readonly python?: unknown;
        readonly uid?: unknown;
        readonly env_count?: unknown;
        readonly forbidden_keys?: unknown;
        readonly daytona_meta_keys?: unknown;
      };

      if (parsed.ok !== true) {
        throw new Error('python probe did not emit ok=true');
      }

      const matched = Array.isArray(parsed.forbidden_keys)
        ? parsed.forbidden_keys.filter((item): item is string => typeof item === 'string')
        : [];
      const vendorMetaKeys = Array.isArray(parsed.daytona_meta_keys)
        ? parsed.daytona_meta_keys.filter((item): item is string => typeof item === 'string')
        : [];
      state.forbiddenKeysFound = matched;
      state.secretsAbsentInSandbox = matched.length === 0;

      if (!state.secretsAbsentInSandbox) {
        throw new Error(`forbidden secret-like env keys found in sandbox: ${matched.join(', ')}`);
      }

      return {
        value: undefined,
        details: {
          exitCode: execResult.exitCode,
          pythonVersion: parsed.python,
          uid: parsed.uid,
          envCount: parsed.env_count,
          secretsAbsentInSandbox: state.secretsAbsentInSandbox,
          daytonaMetaKeys: vendorMetaKeys,
        },
      };
    });

    await runStep('pythonExecFail', async () => {
      const start = clock();
      const execResult = await provider.exec(
        state.primarySandboxId as Id,
        PYTHON_FAIL_ARGV,
        30_000,
      );
      state.pythonFailMs = Math.round(clock() - start);

      const stderr = await provider.readOutput(state.primarySandboxId as Id, execResult.stderrRef);
      if (execResult.exitCode !== 42) {
        throw new Error(`expected exit code 42, got ${execResult.exitCode}`);
      }
      if (!stderr.includes('b3-b0-stderr-probe')) {
        throw new Error(`expected stderr probe marker, got: ${stderr}`);
      }

      return {
        value: undefined,
        details: { exitCode: execResult.exitCode, stderrMatched: true },
      };
    });

    await runStep('pythonExecTimeout', async () => {
      const start = clock();
      let observedCode: string | null = null;
      try {
        await provider.exec(state.primarySandboxId as Id, PYTHON_TIMEOUT_ARGV, execTimeoutMs);
      } catch (error) {
        if (error instanceof DomainError) {
          observedCode = error.code;
        } else {
          throw error;
        }
      }
      state.pythonTimeoutMs = Math.round(clock() - start);

      if (observedCode !== 'EXECUTION_TIMEOUT') {
        throw new Error(`expected EXECUTION_TIMEOUT, got ${String(observedCode)}`);
      }

      return {
        value: undefined,
        details: { observedCode, configuredTimeoutMs: execTimeoutMs },
      };
    });

    await runStep('networkIsolationProbe', async () => {
      const start = clock();
      const execResult = await provider.exec(
        state.primarySandboxId as Id,
        PYTHON_NETWORK_PROBE_ARGV,
        30_000,
      );
      state.networkProbeMs = Math.round(clock() - start);

      const stdout = await provider.readOutput(state.primarySandboxId as Id, execResult.stdoutRef);
      if (execResult.exitCode !== 0) {
        throw new Error(`network probe exited with ${execResult.exitCode}`);
      }

      const parsed = JSON.parse(stdout.trim()) as {
        readonly dns?: { readonly blocked?: boolean };
        readonly https?: { readonly blocked?: boolean };
        readonly metadata_http?: {
          readonly status?: number | null;
          readonly server?: string | null;
        };
      };

      state.dnsBlocked = parsed.dns?.blocked ?? null;
      state.httpsBlocked = parsed.https?.blocked ?? null;
      state.metadataHttpStatus = parsed.metadata_http?.status ?? null;
      state.metadataServerHeader = parsed.metadata_http?.server ?? null;

      if (state.dnsBlocked !== true || state.httpsBlocked !== true) {
        throw new Error(
          `egress was not blocked under deny-all (dnsBlocked=${String(state.dnsBlocked)}, httpsBlocked=${String(state.httpsBlocked)})`,
        );
      }

      return {
        value: undefined,
        details: {
          dnsBlocked: state.dnsBlocked,
          httpsBlocked: state.httpsBlocked,
          metadataHttpStatus: state.metadataHttpStatus,
          metadataServerHeader: state.metadataServerHeader,
        },
      };
    });

    await runStep('usagePrimary', async () => {
      const usage = await provider.usage(state.primarySandboxId as Id);
      return {
        value: undefined,
        details: {
          cpuSeconds: usage.cpuSeconds,
          memoryGiBSeconds: usage.memoryGiBSeconds,
          egressBytes: usage.egressBytes,
        },
      };
    });
  } catch {
    // Error is already captured in steps/errors; cleanup runs in finally.
  } finally {
    if (state.primarySandboxId !== null) {
      const destroyStart = clock();
      try {
        await provider.destroy(state.primarySandboxId);
        state.destroyMs = Math.round(clock() - destroyStart);
        if (state.primaryHoldStartedAtMs !== null) {
          state.primaryHoldSeconds = round3((clock() - state.primaryHoldStartedAtMs) / 1_000);
        }
        steps['destroyPrimary'] = { status: 'PASS', wallTimeMs: state.destroyMs };
      } catch (error) {
        state.destroyMs = Math.round(clock() - destroyStart);
        const formatted = formatError(error, secrets);
        steps['destroyPrimary'] = { status: 'FAIL', wallTimeMs: state.destroyMs, error: formatted };
        errors.push(`destroyPrimary: ${formatted}`);
      }

      const verifyStart = clock();
      try {
        const audit = await waitForSandboxesCleaned(provider, client, clock);

        state.primaryLiveAfterDestroy = audit.liveSandboxIds;
        steps['verifyPrimaryCleaned'] = {
          status: state.primaryLiveAfterDestroy.length === 0 ? 'PASS' : 'FAIL',
          wallTimeMs: Math.round(clock() - verifyStart),
          details: {
            liveSandboxIds: state.primaryLiveAfterDestroy,
            liveStates: audit.liveStates,
            initialLiveStates: audit.initialLiveStates,
            settleAttempts: audit.settleAttempts,
          },
        };
        if (state.primaryLiveAfterDestroy.length > 0) {
          errors.push(
            `verifyPrimaryCleaned: leftover sandboxes ${JSON.stringify(audit.liveStates)}`,
          );
        }
      } catch (error) {
        const formatted = formatError(error, secrets);
        steps['verifyPrimaryCleaned'] = {
          status: 'FAIL',
          wallTimeMs: Math.round(clock() - verifyStart),
          error: formatted,
        };
        errors.push(`verifyPrimaryCleaned: ${formatted}`);
      }
    }
  }

  // Phase 2: SandboxAdapter + AbortController cancellation & cleanup path
  const cancelController = new AbortController();
  const cancelProvider = new DaytonaSandboxProvider({
    tenantId: SMOKE_TENANT_ID,
    runId: `${options.runId}-cancel`,
    client,
    snapshot: profile.snapshot,
    sandboxClass: profile.sandboxClass,
    diskGiB: profile.diskGiB,
    owner,
    signal: cancelController.signal,
    clock,
  });
  const cancelAdapter = new SandboxAdapter(cancelProvider, {
    readyDeadlineMs: 60_000,
    execTimeoutMs: 30_000,
    cleanupTimeoutMs: 60_000,
  });

  try {
    await runStep('cancelAndAdapterCleanup', async () => {
      const setupStart = clock();
      const created = await cancelAdapter.create(
        buildSpec(SMOKE_TENANT_ID, `${options.runId}-cancel`, profile.snapshot),
      );
      state.cancelSandboxId = created.sandboxId;
      state.cancelHoldStartedAtMs = clock();

      await cancelAdapter.waitReady(state.cancelSandboxId, 60_000);
      state.cancelCreateAndReadyMs = Math.round(clock() - setupStart);

      const abortStart = clock();
      const abortTimer = setTimeout(() => {
        cancelController.abort();
      }, cancelAbortDelayMs);

      let cancelledCode: string | null = null;
      try {
        await cancelAdapter.exec(
          state.cancelSandboxId,
          PYTHON_CANCEL_ARGV,
          20_000,
          cancelController.signal,
        );
      } catch (error) {
        if (error instanceof DomainError) {
          cancelledCode = error.code;
        } else {
          throw error;
        }
      } finally {
        clearTimeout(abortTimer);
      }

      state.cancelAbortObservedMs = Math.round(clock() - abortStart);
      if (cancelledCode !== 'CANCELLED') {
        throw new Error(`expected CANCELLED on abort, got ${String(cancelledCode)}`);
      }

      return {
        value: undefined,
        details: {
          sandboxId: state.cancelSandboxId,
          cancelledCode,
          cancelCreateAndReadyMs: state.cancelCreateAndReadyMs,
          cancelAbortObservedMs: state.cancelAbortObservedMs,
        },
      };
    });
  } catch {
    // Captured in steps/errors; cleanup runs in finally.
  } finally {
    if (state.cancelSandboxId !== null) {
      const destroyStart = clock();
      try {
        // Destroy via cancelProvider directly since cancelController is already aborted and
        // SandboxAdapter.destroy checks abort signal before calling provider.destroy.
        await cancelProvider.destroy(state.cancelSandboxId);
        state.cancelDestroyMs = Math.round(clock() - destroyStart);
        if (state.cancelHoldStartedAtMs !== null) {
          state.cancelHoldSeconds = round3((clock() - state.cancelHoldStartedAtMs) / 1_000);
        }
        steps['destroyCancelled'] = { status: 'PASS', wallTimeMs: state.cancelDestroyMs };
      } catch (error) {
        state.cancelDestroyMs = Math.round(clock() - destroyStart);
        const formatted = formatError(error, secrets);
        steps['destroyCancelled'] = {
          status: 'FAIL',
          wallTimeMs: state.cancelDestroyMs,
          error: formatted,
        };
        errors.push(`destroyCancelled: ${formatted}`);
      }
    }

    const sweepStart = clock();
    try {
      await waitForSandboxesCleaned(provider, client, clock);

      const sweep = await sweepOrphanedSandboxes({
        client,
        owner,
        tenantId: SMOKE_TENANT_ID,
        minAgeMs: 0,
        now: clock,
      });
      state.orphanSweptIds = sweep.destroyed;
      state.orphanSweepFailures = sweep.failed.length;

      const finalAudit = await waitForSandboxesCleaned(provider, client, clock);
      state.orphanSweepMs = Math.round(clock() - sweepStart);
      state.finalLiveSandboxIds = finalAudit.liveSandboxIds;

      steps['finalCleanupAudit'] = {
        status:
          state.finalLiveSandboxIds.length === 0 && state.orphanSweepFailures === 0
            ? 'PASS'
            : 'FAIL',
        wallTimeMs: state.orphanSweepMs,
        details: {
          orphanSweptIds: state.orphanSweptIds,
          orphanSweepFailures: state.orphanSweepFailures,
          finalLiveSandboxIds: state.finalLiveSandboxIds,
          finalLiveStates: finalAudit.liveStates,
          settleAttempts: finalAudit.settleAttempts,
        },
      };

      if (state.finalLiveSandboxIds.length > 0 || state.orphanSweepFailures > 0) {
        errors.push(
          `finalCleanupAudit: live=${JSON.stringify(finalAudit.liveStates)} failures=${state.orphanSweepFailures}`,
        );
      }
    } catch (error) {
      state.orphanSweepMs = Math.round(clock() - sweepStart);
      const formatted = formatError(error, secrets);
      steps['finalCleanupAudit'] = {
        status: 'FAIL',
        wallTimeMs: state.orphanSweepMs,
        error: formatted,
      };
      errors.push(`finalCleanupAudit: ${formatted}`);
    }
  }

  await client.close?.().catch(() => undefined);

  const finishedAtMs = clock();
  const totalWallTimeMs = Math.round(finishedAtMs - startedAtMs);
  const cpuAfter = readCpuUsage();

  const primaryCost =
    state.primaryHoldSeconds === null
      ? 0
      : estimateCostUsd({
          cpu: profile.cpu,
          memoryGiB: profile.memoryGiB,
          diskGiB: profile.diskGiB,
          seconds: state.primaryHoldSeconds,
        });
  const cancelCost =
    state.cancelHoldSeconds === null
      ? 0
      : estimateCostUsd({
          cpu: profile.cpu,
          memoryGiB: profile.memoryGiB,
          diskGiB: profile.diskGiB,
          seconds: state.cancelHoldSeconds,
        });
  const estimatedTotalUsd =
    state.primaryHoldSeconds === null && state.cancelHoldSeconds === null
      ? null
      : Math.round((primaryCost + cancelCost) * 1_000_000) / 1_000_000;

  const allPassed =
    errors.length === 0 &&
    Object.values(steps).every((step) => step.status === 'PASS') &&
    state.finalLiveSandboxIds.length === 0;

  return {
    marker: allPassed ? 'CLOUDFLARE_DAYTONA_SMOKE_PASS' : 'CLOUDFLARE_DAYTONA_SMOKE_FAIL',
    runId: options.runId,
    owner,
    startedAtIso: new Date(startedAtMs).toISOString(),
    finishedAtIso: new Date(finishedAtMs).toISOString(),
    queue: {
      name: options.queueName ?? null,
      messageId: options.messageId ?? null,
      attempts: options.messageAttempts ?? null,
    },
    runtime: {
      hasWebSocketPair:
        typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === 'function',
      installedSdkVersion: DAYTONA_INSTALLED_SDK_VERSION,
      pinnedSdkVersion: DAYTONA_PINNED_SDK_VERSION,
      cpuTimeSource: 'cloudflare_tail_trace_item',
      wallTimeMs: totalWallTimeMs,
      processCpuUsageDeltaUs: diffCpuUsage(cpuBefore, cpuAfter),
    },
    profile: {
      id: profile.id,
      snapshot: profile.snapshot,
      sandboxClass: profile.sandboxClass,
      networkPolicyId: DAYTONA_DEFAULT_NETWORK_POLICY_ID,
      maxSandboxLifetimeSec: DAYTONA_SANDBOX_LIMITS.maxSandboxLifetimeSec,
      maxExecTimeoutMs: DAYTONA_SANDBOX_LIMITS.maxExecTimeoutMs,
      idleStopMinutes: DAYTONA_SANDBOX_LIMITS.idleStopMinutes,
      autoDeleteMinutesAfterStop: DAYTONA_SANDBOX_LIMITS.autoDeleteMinutesAfterStop,
    },
    sandboxes: {
      primaryId: state.primarySandboxId,
      cancelId: state.cancelSandboxId,
    },
    timingsMs: {
      createMs: state.createMs,
      waitReadyMs: state.waitReadyMs,
      coldStartMs:
        state.createMs !== null && state.waitReadyMs !== null
          ? state.createMs + state.waitReadyMs
          : null,
      pythonOkMs: state.pythonOkMs,
      pythonFailMs: state.pythonFailMs,
      pythonTimeoutMs: state.pythonTimeoutMs,
      networkProbeMs: state.networkProbeMs,
      destroyMs: state.destroyMs,
      cancelCreateAndReadyMs: state.cancelCreateAndReadyMs,
      cancelAbortObservedMs: state.cancelAbortObservedMs,
      cancelDestroyMs: state.cancelDestroyMs,
      orphanSweepMs: state.orphanSweepMs,
      totalWallTimeMs,
    },
    lifecycle: {
      networkBlockAllReported: state.networkBlockAllReported,
      autoStopIntervalMinutes: state.autoStopIntervalMinutes,
      autoDeleteIntervalMinutes: state.autoDeleteIntervalMinutes,
      autoDestroyAtMs: state.autoDestroyAtMs,
      sandboxClassReported: state.sandboxClassReported,
      snapshotReported: state.snapshotReported,
    },
    isolation: {
      secretsAbsentInSandbox: state.secretsAbsentInSandbox,
      forbiddenKeysFound: state.forbiddenKeysFound,
      dnsBlocked: state.dnsBlocked,
      httpsBlocked: state.httpsBlocked,
      metadataHttpStatus: state.metadataHttpStatus,
      metadataServerHeader: state.metadataServerHeader,
    },
    cleanup: {
      primaryLiveAfterDestroy: state.primaryLiveAfterDestroy,
      finalLiveSandboxIds: state.finalLiveSandboxIds,
      orphanSweptIds: state.orphanSweptIds,
      orphanSweepFailures: state.orphanSweepFailures,
    },
    cost: {
      basis: 'RESERVATION_WALL_CLOCK',
      pricing: DAYTONA_PRICING,
      primaryHoldSeconds: state.primaryHoldSeconds,
      cancelHoldSeconds: state.cancelHoldSeconds,
      estimatedTotalUsd,
    },
    steps,
    errors,
  };
}

/**
 * Generates a unique smoke run identifier safe for Worker and Daytona labels.
 */
export function createSmokeRunId(): string {
  return randomUUID();
}
