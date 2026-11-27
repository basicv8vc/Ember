import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import {
  OPENROUTER_CHAT_COMPLETIONS_URL,
  FAKE_MODEL_LABEL,
  type PythonAgentStepOutput,
} from '@ember/model-gateway';
import {
  PYTHON_AGENT_LIMITS,
  type B3StagedUploadReceiptDto,
  type B3TaskArtifactsListDto,
} from '@ember/contracts';
import {
  AgentEventRuntimeFacade,
  AgentHeadCore,
  V2_MAX_INLINE_ARTIFACT_BYTES,
  type DurableObjectStorageLike,
  type GlobalBudgetAuthority,
  type RecoveryRegistryPort,
  type ResolvedMessageAttachment,
  type SqlStorageCursorLike,
  type SqlStorageRow,
  type V2DispatchEnvelope,
  type V2PythonTaskSubmitResultDto,
  type V2TaskArtifactDownloadDto,
} from '@ember/runtime-v2';
import { GlobalBudgetAuthorityCore } from '../../packages/runtime-v2/src/global-budget/authority.js';
import {
  DAYTONA_SANDBOX_LIMITS,
  DaytonaSandboxProvider,
  type DaytonaCreateRequest,
  type DaytonaDirectoryEntry,
  type DaytonaExecRequest,
  type DaytonaListFilter,
  type DaytonaSandboxClient,
  type DaytonaSandboxInfo,
} from '@ember/sandbox-daytona';
import { resolveV2ModelRuntime } from '../../apps/api/src/local-v2/model-runtime.js';
import {
  executeV2PythonAgentTask,
  type V2PythonSandboxFactory,
  type V2PythonStepGateway,
  type V2PythonTaskClaim,
  type V2SandboxCleanupIncident,
} from '../../apps/api/src/local-v2/python-agent-runner.js';
import {
  resolveV2SandboxConfig,
  type V2SandboxEnv,
} from '../../apps/api/src/local-v2/runtime-config.js';
import { createDurableExecutor } from '../../apps/api/src/local-v2/runtime-durable.js';
import type { AgentHeadDO, LocalRuntimeEnv } from '../../apps/api/src/local-v2/runtime-head.js';

const TENANT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d840101';
const OTHER_TENANT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d840999';
const AGENT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d840102';
const PRINCIPAL_ID = '018f5f2e-0e91-7a30-ae62-bcb97d840103';
const CONVERSATION_ID = '018f5f2e-0e91-7a30-ae62-bcb97d840105';

function toBase64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createInMemoryDoStorage(): DurableObjectStorageLike {
  const db = new DatabaseSync(':memory:');
  let inTransaction = false;
  let alarmAt: number | null = null;

  return {
    sql: {
      exec<T extends SqlStorageRow = SqlStorageRow>(
        query: string,
        ...bindings: unknown[]
      ): SqlStorageCursorLike<T> {
        const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
        const hasReturning = /\bRETURNING\b/i.test(query);
        if (bindings.length === 0 && !isReader && !hasReturning) {
          db.exec(query);
          return {
            toArray: () => [] as T[],
            one: () => {
              throw new Error('Expected 1 row, got 0');
            },
            rowsRead: 0,
            rowsWritten: 0,
            [Symbol.iterator]: () => ([] as T[])[Symbol.iterator](),
          };
        }
        const stmt = db.prepare(query);
        let rows: T[] = [];
        if (isReader || hasReturning) {
          rows = stmt.all(...(bindings as never[])) as T[];
        } else {
          stmt.run(...(bindings as never[]));
        }
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`Expected 1 row, got ${rows.length}`);
            return rows[0]!;
          },
          rowsRead: rows.length,
          rowsWritten: isReader ? 0 : 1,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync<T>(closure: () => T): T {
      if (inTransaction) return closure();
      inTransaction = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        const res = closure();
        db.exec('COMMIT');
        return res;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        inTransaction = false;
      }
    },
    getAlarm: () => Promise.resolve(alarmAt),
    setAlarm: (at) => {
      alarmAt = typeof at === 'number' ? at : at.getTime();
      return Promise.resolve();
    },
    deleteAlarm: () => {
      alarmAt = null;
      return Promise.resolve();
    },
  };
}

function createMockRegistry(): RecoveryRegistryPort {
  return {
    upsertCoverage: (cmd) =>
      Promise.resolve({
        accepted: true,
        currentGeneration: cmd.generation,
        actualRecoveryAtMs: cmd.recoveryAtMs,
      }),
    postponeCoverage: (cmd) =>
      Promise.resolve({
        updated: true,
        currentGeneration: cmd.newGeneration,
        actualRecoveryAtMs: cmd.nextRecoveryAtMs,
      }),
    retireCoverage: () => Promise.resolve({ retired: true }),
    getCoverage: () =>
      Promise.resolve({
        exists: false,
        currentGeneration: null,
        actualRecoveryAtMs: null,
        status: null,
        retryNotBeforeMs: null,
      }),
  };
}

function createMockGlobalBudget(): GlobalBudgetAuthority {
  return {
    reserveGlobal: () => Promise.reject(new Error('unused')),
    authorizeGlobalSend: () => Promise.reject(new Error('unused')),
    renewGlobalGrant: () => Promise.reject(new Error('unused')),
    settleGlobal: () => Promise.reject(new Error('unused')),
  };
}

function createTestCore(clockRef: { now: number }) {
  const storage = createInMemoryDoStorage();
  const registry = createMockRegistry();
  const core = new AgentHeadCore({
    storage,
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    recoveryRegistry: registry,
    globalBudget: createMockGlobalBudget(),
    nowMs: () => clockRef.now,
    eventRuntimeFactory: (business) => {
      const facade = new AgentEventRuntimeFacade({
        tenantId: TENANT_ID,
        agentId: AGENT_ID,
        storage,
        business,
      });
      return {
        recoveryAdmission: facade.coverage,
        eventCoordinator: facade.outbox,
        recoveryHooks: {
          reconcileCoverageSync: (cmd) => facade.coverage.reconcileFromRegistrySync(cmd),
          confirmCoveragePlanSync: (cmd) => facade.coverage.confirmRegistryPlanSync(cmd),
          getOutboxByIdSync: (outboxId) => facade.outbox.getOutboxByIdSync(outboxId),
          syncPlatformAlarm: (targetAlarmAtMs, nowMs) =>
            facade.alarm.syncPlatformAlarm(targetAlarmAtMs, nowMs),
          getCoverageRowSync: () => facade.coverage.getCoverageRowSync(),
        },
      };
    },
  });
  core.bootstrapHead({ conversationId: CONVERSATION_ID });
  return { core, storage };
}

function wrapCoreAsLocalEnv(
  core: AgentHeadCore,
  overrides: Partial<V2SandboxEnv> = {},
): LocalRuntimeEnv {
  return {
    EMBER_ENV: 'test',
    EMBER_MODEL_MODE: 'fake',
    EMBER_SANDBOX_MODE: 'daytona',
    DAYTONA_API_KEY: 'daytona-test-key-unused',
    EMBER_DAYTONA_ALLOWED_TENANTS: TENANT_ID,
    AGENT_HEAD: {
      getByName: () => core as unknown as AgentHeadDO,
      idFromName: () => ({ toString: () => `${TENANT_ID}:${AGENT_ID}` }) as never,
    },
    ...overrides,
  } as unknown as LocalRuntimeEnv;
}

function makeTaskEnvelope(taskId: string, fenceEpoch = 0): V2DispatchEnvelope {
  return {
    schemaVersion: 2,
    eventId: `task:${taskId}:epoch:${fenceEpoch}`,
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    entityKind: 'task',
    entityId: taskId,
    queueName: 'agent_task',
    fenceEpoch,
  };
}

async function claimTask(
  core: AgentHeadCore,
  taskId: string,
  workerId: string,
  leaseMs = 30_000,
  fenceEpoch = 0,
): Promise<V2PythonTaskClaim> {
  const claim = await core.claimDurableWork({
    envelope: makeTaskEnvelope(taskId, fenceEpoch),
    workerId,
    leaseMs,
  });
  if (claim.kind !== 'claimed') {
    throw new Error(`Expected claimed task ${taskId}, got ${claim.kind}`);
  }
  return {
    ...claim,
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    workerId,
  };
}

interface FakeDaytonaInstance {
  readonly sandboxId: string;
  readonly request: DaytonaCreateRequest;
  state: DaytonaSandboxInfo['state'];
  readonly files: Map<string, Buffer>;
}

function createFakeDaytonaClient(options?: {
  readonly reportNetworkBlockAll?: boolean;
  readonly deleteResult?: boolean | Error;
  readonly closeError?: Error;
  readonly onExec?: (
    sandbox: FakeDaytonaInstance,
    request: DaytonaExecRequest,
  ) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut?: boolean;
  }>;
  readonly extraEntriesInOutputs?: readonly DaytonaDirectoryEntry[];
}) {
  const sandboxes = new Map<string, FakeDaytonaInstance>();
  const createdRequests: DaytonaCreateRequest[] = [];
  const execRequests: DaytonaExecRequest[] = [];
  let deletedCount = 0;
  let closedCount = 0;
  let nextSeq = 1;

  const client: DaytonaSandboxClient = {
    create(request) {
      createdRequests.push(request);
      const sandboxId = `sbx-${nextSeq++}`;
      sandboxes.set(sandboxId, {
        sandboxId,
        request,
        state: 'started',
        files: new Map(),
      });
      return Promise.resolve({ sandboxId });
    },
    get(sandboxId) {
      const box = sandboxes.get(sandboxId);
      if (!box) return Promise.resolve(null);
      return Promise.resolve({
        sandboxId: box.sandboxId,
        state: box.state,
        snapshot: box.request.snapshot,
        sandboxClass: 'container',
        cpu: 1,
        memoryGiB: 1,
        diskGiB: 4,
        createdAtMs: 1_760_000_000_000,
        networkBlockAll: options?.reportNetworkBlockAll ?? box.request.networkBlockAll,
        autoStopIntervalMinutes: box.request.autoStopIntervalMinutes,
        autoDeleteIntervalMinutes: box.request.autoDeleteIntervalMinutes,
        autoDestroyAtMs: null,
        labels: box.request.labels,
        errorReason: null,
      });
    },
    list(filter: DaytonaListFilter) {
      const out: DaytonaSandboxInfo[] = [];
      for (const box of sandboxes.values()) {
        if (filter.states && !filter.states.includes(box.state)) continue;
        out.push({
          sandboxId: box.sandboxId,
          state: box.state,
          snapshot: box.request.snapshot,
          sandboxClass: 'container',
          cpu: 1,
          memoryGiB: 1,
          diskGiB: 4,
          createdAtMs: 1_760_000_000_000,
          networkBlockAll: options?.reportNetworkBlockAll ?? box.request.networkBlockAll,
          autoStopIntervalMinutes: box.request.autoStopIntervalMinutes,
          autoDeleteIntervalMinutes: box.request.autoDeleteIntervalMinutes,
          autoDestroyAtMs: null,
          labels: box.request.labels,
          errorReason: null,
        });
      }
      return Promise.resolve(out);
    },
    start() {
      return Promise.resolve();
    },
    stop(sandboxId) {
      const box = sandboxes.get(sandboxId);
      if (box) box.state = 'stopped';
      return Promise.resolve();
    },
    delete(sandboxId) {
      if (options?.deleteResult instanceof Error) {
        return Promise.reject(options.deleteResult);
      }
      if (options?.deleteResult === false) {
        return Promise.resolve(false);
      }
      const box = sandboxes.get(sandboxId);
      if (box) {
        box.state = 'destroyed';
        deletedCount += 1;
      }
      return Promise.resolve(true);
    },
    async exec(sandboxId, request) {
      execRequests.push(request);
      const box = sandboxes.get(sandboxId);
      if (!box || box.state === 'destroyed') {
        throw new Error('sandbox missing');
      }
      if (options?.onExec) {
        const res = await options.onExec(box, request);
        return {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          timedOut: res.timedOut ?? false,
        };
      }
      // Default simulated script behavior inside the sandbox virtual filesystem.
      const inputCsv =
        box.files
          .get(`${DAYTONA_SANDBOX_LIMITS.workspaceRoot}/inputs/sales.csv`)
          ?.toString('utf-8') ?? '';
      box.files.set(
        `${DAYTONA_SANDBOX_LIMITS.workspaceRoot}/outputs/report.csv`,
        Buffer.from(`summary\n${inputCsv.trim()}\n`, 'utf-8'),
      );
      return {
        exitCode: 0,
        stdout: 'ok: wrote outputs/report.csv\n',
        stderr: '',
        timedOut: false,
      };
    },
    upload(sandboxId, absolutePath, data) {
      const box = sandboxes.get(sandboxId);
      if (!box) throw new Error('sandbox missing');
      box.files.set(absolutePath, Buffer.from(data));
      return Promise.resolve();
    },
    download(sandboxId, absolutePath) {
      const box = sandboxes.get(sandboxId);
      const file = box?.files.get(absolutePath);
      if (!file) return Promise.reject(new Error(`missing file: ${absolutePath}`));
      return Promise.resolve(Buffer.from(file));
    },
    exists(sandboxId, absolutePath) {
      const box = sandboxes.get(sandboxId);
      return Promise.resolve(box?.files.has(absolutePath) ?? false);
    },
    listDirectory(sandboxId, absolutePath) {
      const box = sandboxes.get(sandboxId);
      if (!box) return Promise.resolve([]);
      const prefix = `${absolutePath.replace(/\/+$/, '')}/`;
      const entries: DaytonaDirectoryEntry[] = [];
      for (const [fullPath, data] of box.files.entries()) {
        if (fullPath.startsWith(prefix)) {
          entries.push({
            name: fullPath.slice(prefix.length),
            isDir: false,
            isSymlink: false,
            sizeBytes: data.byteLength,
          });
        }
      }
      if (options?.extraEntriesInOutputs) {
        entries.push(...options.extraEntriesInOutputs);
      }
      return Promise.resolve(entries);
    },
    latestMetrics() {
      return Promise.resolve(null);
    },
    close() {
      closedCount += 1;
      if (options?.closeError) {
        return Promise.reject(options.closeError);
      }
      return Promise.resolve();
    },
  };

  return {
    client,
    createdRequests,
    execRequests,
    liveCount: () => [...sandboxes.values()].filter((s) => s.state !== 'destroyed').length,
    getDeletedCount: () => deletedCount,
    getClosedCount: () => closedCount,
    makeFactory:
      (): V2PythonSandboxFactory =>
      ({ tenantId, runId, owner, signal }) => ({
        provider: new DaytonaSandboxProvider({
          tenantId,
          runId,
          client,
          snapshot: 'daytona-small',
          sandboxClass: 'container',
          owner,
          signal,
        }),
        close: () => client.close!(),
      }),
  };
}

function makeScriptedGateway(steps: readonly PythonAgentStepOutput[]): V2PythonStepGateway {
  let index = 0;
  return {
    providerId: 'fake',
    modelLabel: FAKE_MODEL_LABEL,
    simulated: true,
    stepPythonAgent() {
      const output = steps[Math.min(index, steps.length - 1)]!;
      index += 1;
      return Promise.resolve({
        output,
        modelLabel: FAKE_MODEL_LABEL,
        simulated: true,
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          costMicroUsd: 0,
          rateVersion: 'fake-zero-cost',
        },
        providerRequestId: `req-${index}`,
      });
    },
  };
}

describe('V2 Sandbox Configuration & Daytona Adapter Safety (Agent F)', () => {
  it('decouples EMBER_SANDBOX_MODE from LLM mode and fails closed on unset/invalid/missing-key config', () => {
    expect(resolveV2SandboxConfig({ EMBER_ENV: 'local' })).toEqual({
      kind: 'disabled',
      reason: 'sandbox_mode_unset',
    });
    expect(resolveV2SandboxConfig({ EMBER_ENV: 'local', EMBER_SANDBOX_MODE: 'disabled' })).toEqual({
      kind: 'disabled',
      reason: 'sandbox_disabled',
    });
    expect(resolveV2SandboxConfig({ EMBER_ENV: 'local', EMBER_SANDBOX_MODE: 'container' })).toEqual(
      {
        kind: 'disabled',
        reason: 'sandbox_mode_invalid',
      },
    );

    // Fake sandbox allowed in isolated environments even if LLM config is unrelated.
    expect(resolveV2SandboxConfig({ EMBER_ENV: 'local', EMBER_SANDBOX_MODE: 'fake' })).toEqual({
      kind: 'fake',
    });
    expect(
      resolveV2SandboxConfig({
        EMBER_ENV: 'v2-staging',
        EMBER_V2_STAGING_ISOLATED: 'true',
        EMBER_SANDBOX_MODE: 'fake',
      }),
    ).toEqual({ kind: 'fake' });
    expect(
      resolveV2SandboxConfig({
        EMBER_ENV: 'v2-staging',
        EMBER_V2_STAGING_ISOLATED: 'false',
        EMBER_SANDBOX_MODE: 'fake',
      }),
    ).toEqual({
      kind: 'disabled',
      reason: 'fake_sandbox_not_permitted',
    });

    // Daytona mode requires non-empty API key and a nonempty validated tenant UUID allowlist.
    expect(
      resolveV2SandboxConfig({ EMBER_ENV: 'v2-staging', EMBER_SANDBOX_MODE: 'daytona' }),
    ).toEqual({
      kind: 'disabled',
      reason: 'daytona_api_key_missing',
    });
    expect(
      resolveV2SandboxConfig({
        EMBER_ENV: 'v2-staging',
        EMBER_SANDBOX_MODE: 'daytona',
        DAYTONA_API_KEY: 'key-1',
      }),
    ).toEqual({
      kind: 'disabled',
      reason: 'daytona_allowlist_missing',
    });
    expect(
      resolveV2SandboxConfig({
        EMBER_ENV: 'v2-staging',
        EMBER_SANDBOX_MODE: 'daytona',
        DAYTONA_API_KEY: 'key-1',
        EMBER_DAYTONA_ALLOWED_TENANTS: '   ',
      }),
    ).toEqual({
      kind: 'disabled',
      reason: 'daytona_allowlist_missing',
    });
    for (const malformed of [',', 'not-a-uuid', `${TENANT_ID},bad`, `${TENANT_ID},`]) {
      expect(
        resolveV2SandboxConfig({
          EMBER_ENV: 'v2-staging',
          EMBER_SANDBOX_MODE: 'daytona',
          DAYTONA_API_KEY: 'key-1',
          EMBER_DAYTONA_ALLOWED_TENANTS: malformed,
        }),
      ).toEqual({
        kind: 'disabled',
        reason: 'daytona_allowlist_invalid',
      });
    }

    const resolved = resolveV2SandboxConfig({
      EMBER_ENV: 'v2-staging',
      EMBER_SANDBOX_MODE: 'daytona',
      DAYTONA_API_KEY: 'daytona-key',
      DAYTONA_API_URL: 'https://api.daytona.example',
      DAYTONA_TARGET: 'us',
      EMBER_SANDBOX_OWNER: 'v2-staging:canary',
      EMBER_DAYTONA_ALLOWED_TENANTS: ` ${TENANT_ID.toUpperCase()} `,
    });
    expect(resolved.kind).toBe('daytona');
    if (resolved.kind === 'daytona') {
      expect(resolved.apiKey).toBe('daytona-key');
      expect(resolved.apiUrl).toBe('https://api.daytona.example');
      expect(resolved.target).toBe('us');
      expect(resolved.owner).toBe('v2-staging:canary');
      expect(resolved.allowedTenants.has(TENANT_ID)).toBe(true);
    }
  });

  it('enforces kill-switch and missing/blank/malformed/disallowed tenant allowlist with zero sandbox creates', async () => {
    const clock = { now: 1_760_000_000_000 };
    const { core } = createTestCore(clock);
    const fakeDaytona = createFakeDaytonaClient();

    const submitted = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d841001',
      input: { title: 'Test', prompt: 'Run' },
    })) as V2PythonTaskSubmitResultDto;
    const claim = await claimTask(core, submitted.task.task_id, 'worker-1');

    let stepCalls = 0;
    const gateway: V2PythonStepGateway = {
      providerId: 'fake',
      modelLabel: FAKE_MODEL_LABEL,
      simulated: true,
      stepPythonAgent() {
        stepCalls += 1;
        return Promise.resolve({
          output: {
            kind: 'final',
            summaryText: 'done',
            detailText: 'done',
            truncated: false,
            finishReason: 'stop',
          },
          modelLabel: FAKE_MODEL_LABEL,
          simulated: true,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            costMicroUsd: 0,
            rateVersion: 'fake-zero-cost',
          },
          providerRequestId: 'unused',
        });
      },
    };

    const disabledOutcome = await executeV2PythonAgentTask({
      env: wrapCoreAsLocalEnv(core, { EMBER_SANDBOX_MODE: 'disabled' }),
      claim,
      gateway,
      sandboxFactory: fakeDaytona.makeFactory(),
    });
    expect(disabledOutcome).toEqual({ status: 'failed', reasonCode: 'sandbox_disabled' });

    const missingAllowlistOutcome = await executeV2PythonAgentTask({
      env: wrapCoreAsLocalEnv(core, {
        EMBER_SANDBOX_MODE: 'daytona',
        EMBER_DAYTONA_ALLOWED_TENANTS: undefined,
      }),
      claim,
      gateway,
      sandboxFactory: fakeDaytona.makeFactory(),
    });
    expect(missingAllowlistOutcome).toEqual({
      status: 'failed',
      reasonCode: 'daytona_allowlist_missing',
    });

    const blankAllowlistOutcome = await executeV2PythonAgentTask({
      env: wrapCoreAsLocalEnv(core, {
        EMBER_SANDBOX_MODE: 'daytona',
        EMBER_DAYTONA_ALLOWED_TENANTS: '   ',
      }),
      claim,
      gateway,
      sandboxFactory: fakeDaytona.makeFactory(),
    });
    expect(blankAllowlistOutcome).toEqual({
      status: 'failed',
      reasonCode: 'daytona_allowlist_missing',
    });

    const malformedAllowlistOutcome = await executeV2PythonAgentTask({
      env: wrapCoreAsLocalEnv(core, {
        EMBER_SANDBOX_MODE: 'daytona',
        EMBER_DAYTONA_ALLOWED_TENANTS: `${TENANT_ID},not-a-uuid`,
      }),
      claim,
      gateway,
      sandboxFactory: fakeDaytona.makeFactory(),
    });
    expect(malformedAllowlistOutcome).toEqual({
      status: 'failed',
      reasonCode: 'daytona_allowlist_invalid',
    });

    const blockedTenantOutcome = await executeV2PythonAgentTask({
      env: wrapCoreAsLocalEnv(core, {
        EMBER_SANDBOX_MODE: 'daytona',
        EMBER_DAYTONA_ALLOWED_TENANTS: OTHER_TENANT_ID,
      }),
      claim,
      gateway,
      sandboxFactory: fakeDaytona.makeFactory(),
    });
    expect(blockedTenantOutcome).toEqual({
      status: 'failed',
      reasonCode: 'sandbox_tenant_not_allowed',
    });
    expect(fakeDaytona.createdRequests).toHaveLength(0);
    expect(stepCalls).toBe(0);
  });

  it('executes multi-step python.agent through DaytonaSandboxProvider, enforces deny-all egress & cleanup, and publishes SHA-256 verified artifacts atomically', async () => {
    const clock = { now: 1_760_000_000_000 };
    const { core } = createTestCore(clock);
    const fakeDaytona = createFakeDaytonaClient();

    const inputCsv = 'region,revenue\nnorth,120\n';
    const upload = (await core.taskArtifacts({
      kind: 'stage_upload',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d841010',
      filename: 'sales.csv',
      mediaType: 'text/csv',
      contentBase64: toBase64(inputCsv),
    })) as B3StagedUploadReceiptDto;

    const submitted = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d841011',
      input: {
        title: 'Analyze CSV in Daytona',
        prompt: 'Summarize revenue',
        attachment_ids: [upload.upload_id],
      },
    })) as V2PythonTaskSubmitResultDto;
    const taskId = submitted.task.task_id;
    const claim = await claimTask(core, taskId, 'worker-daytona');

    const gateway = makeScriptedGateway([
      {
        kind: 'tool_call',
        toolCallId: 'call-1',
        code: "open('outputs/report.csv', 'w').write('summary\\n' + open('inputs/sales.csv').read())",
        rawArgumentsJson: JSON.stringify({
          code: "open('outputs/report.csv', 'w').write('summary\\n' + open('inputs/sales.csv').read())",
        }),
        assistantText: 'Running Python analysis script',
      },
      {
        kind: 'final',
        summaryText: 'Generated report.csv from sales.csv',
        detailText: 'Report contains normalized summary rows.',
        truncated: false,
        finishReason: 'stop',
      },
    ]);

    const outcome = await executeV2PythonAgentTask({
      env: wrapCoreAsLocalEnv(core, {
        EMBER_SANDBOX_OWNER: 'test:v2-daytona',
      }),
      claim,
      gateway,
      sandboxFactory: fakeDaytona.makeFactory(),
      now: () => clock.now,
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.summaryText).toContain('report.csv');
    }

    // DaytonaSandboxProvider enforced egress deny-all, ephemeral TTL, and full cleanup.
    expect(fakeDaytona.createdRequests).toHaveLength(1);
    expect(fakeDaytona.createdRequests[0]?.networkBlockAll).toBe(true);
    expect(fakeDaytona.createdRequests[0]?.ephemeral).toBe(true);
    expect(fakeDaytona.createdRequests[0]?.labels['ember.owner']).toBe('test:v2-daytona');
    expect(fakeDaytona.liveCount()).toBe(0);
    expect(fakeDaytona.getDeletedCount()).toBe(1);
    expect(fakeDaytona.getClosedCount()).toBe(1);

    // Output exists staged (committed=0) BEFORE durable completion; invisible to reads until committed.
    const preCommitList = (await core.taskArtifacts({
      kind: 'list_task_artifacts',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d841012',
      taskId,
    })) as B3TaskArtifactsListDto;
    expect(preCommitList.artifacts.some((a) => a.created_by === 'run')).toBe(false);

    // Commit task completion -> output becomes visible & SHA-256 matches exact bytes.
    const committed = await core.commitDurableResult({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      entityType: 'task',
      entityId: taskId,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'worker-daytona',
      outcome:
        outcome.status === 'completed'
          ? {
              status: 'completed',
              summaryText: outcome.summaryText,
              detailText: outcome.detailText,
              modelLabel: outcome.modelLabel,
              simulated: outcome.simulated,
              reasonCode: outcome.reasonCode,
            }
          : { status: 'failed', reasonCode: outcome.reasonCode },
    });
    expect(committed.accepted).toBe(true);

    const postCommitList = (await core.taskArtifacts({
      kind: 'list_task_artifacts',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d841013',
      taskId,
    })) as B3TaskArtifactsListDto;
    const outputMeta = postCommitList.artifacts.find((a) => a.filename === 'report.csv');
    expect(outputMeta).toBeDefined();
    const downloaded = (await core.taskArtifacts({
      kind: 'download_artifact',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d841014',
      artifactId: outputMeta!.artifact_id,
    })) as V2TaskArtifactDownloadDto | null;
    expect(downloaded).not.toBeNull();
    expect(downloaded!.contentBase64).toBeDefined();
    const decoded = Buffer.from(downloaded!.contentBase64!, 'base64');
    expect(decoded.toString('utf-8')).toBe('summary\nregion,revenue\nnorth,120\n');
    expect(sha256Hex(decoded)).toBe(downloaded!.sha256);
  });

  it('fails closed and destroys sandbox on egress policy tampering, unsafe output names, and oversized output artifacts', async () => {
    const runScenario = async (
      name: string,
      clientOpts: Parameters<typeof createFakeDaytonaClient>[0],
    ) => {
      const clock = { now: 1_760_000_000_000 };
      const { core } = createTestCore(clock);
      const fakeDaytona = createFakeDaytonaClient(clientOpts);
      const submitted = (await core.taskArtifacts({
        kind: 'submit_python_task',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        agentId: AGENT_ID,
        requestId: `018f5f2e-0e91-7a30-ae62-bcb97d8420${name.length}`,
        input: { title: name, prompt: name },
      })) as V2PythonTaskSubmitResultDto;
      const claim = await claimTask(core, submitted.task.task_id, 'worker-policy');

      const gateway = makeScriptedGateway([
        {
          kind: 'tool_call',
          toolCallId: 'call-1',
          code: 'print(1)',
          rawArgumentsJson: '{"code":"print(1)"}',
        },
        {
          kind: 'final',
          summaryText: 'done',
          detailText: 'done',
          truncated: false,
          finishReason: 'stop',
        },
      ]);
      const outcome = await executeV2PythonAgentTask({
        env: wrapCoreAsLocalEnv(core),
        claim,
        gateway,
        sandboxFactory: fakeDaytona.makeFactory(),
        now: () => clock.now,
      });
      expect(fakeDaytona.liveCount()).toBe(0);
      expect(fakeDaytona.getClosedCount()).toBe(1);
      return outcome;
    };

    const egressTampered = await runScenario('egress', { reportNetworkBlockAll: false });
    expect(egressTampered).toEqual({ status: 'failed', reasonCode: 'sandbox_policy_denied' });

    const unsafeFilename = await runScenario('unsafe', {
      extraEntriesInOutputs: [
        { name: '../escape.csv', isDir: false, isSymlink: false, sizeBytes: 12 },
      ],
    });
    expect(unsafeFilename).toEqual({ status: 'failed', reasonCode: 'invalid_output_filename' });

    const oversizedOutput = await runScenario('oversized', {
      extraEntriesInOutputs: [
        {
          name: 'huge.csv',
          isDir: false,
          isSymlink: false,
          sizeBytes: V2_MAX_INLINE_ARTIFACT_BYTES + 1,
        },
      ],
    });
    expect(oversizedOutput).toEqual({ status: 'failed', reasonCode: 'output_artifact_too_large' });
  });

  it('enforces maxPythonExecsPerRun, deadline expiry, and in-flight cancellation with cleanup', async () => {
    const clock = { now: 1_760_000_000_000 };
    const { core } = createTestCore(clock);

    // 1. In-flight cancellation aborts step/exec and destroys sandbox cleanly.
    const subCancel = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d843001',
      input: { title: 'Cancelable', prompt: 'Long run' },
    })) as V2PythonTaskSubmitResultDto;
    const claimCancel = await claimTask(core, subCancel.task.task_id, 'worker-cancel', 3_000);

    const fakeDaytonaCancel = createFakeDaytonaClient({
      onExec: async () => {
        await core.taskArtifacts({
          kind: 'cancel_task',
          tenantId: TENANT_ID,
          principalId: PRINCIPAL_ID,
          agentId: AGENT_ID,
          requestId: '018f5f2e-0e91-7a30-ae62-bcb97d843002',
          taskId: subCancel.task.task_id,
        });
        const renewRes = await core.renewTaskLease({
          tenantId: TENANT_ID,
          agentId: AGENT_ID,
          taskId: subCancel.task.task_id,
          runId: (JSON.parse(claimCancel.contextJson) as { runId: string }).runId,
          leaseEpoch: claimCancel.leaseEpoch,
          workerId: 'worker-cancel',
          extendMs: 45_000,
        });
        expect(renewRes).toMatchObject({
          renewed: false,
          cancelRequested: true,
        });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const cancelOutcome = await executeV2PythonAgentTask({
      env: wrapCoreAsLocalEnv(core),
      claim: claimCancel,
      gateway: makeScriptedGateway([
        {
          kind: 'tool_call',
          toolCallId: 'c1',
          code: 'print(1)',
          rawArgumentsJson: '{"code":"print(1)"}',
        },
        {
          kind: 'final',
          summaryText: 'should not complete',
          detailText: '',
          truncated: false,
          finishReason: 'stop',
        },
      ]),
      sandboxFactory: fakeDaytonaCancel.makeFactory(),
      now: () => clock.now,
    });
    expect(cancelOutcome.status).toBe('failed');
    expect(['cancelled', 'lease_lost', 'fenced']).toContain(cancelOutcome.reasonCode);
    expect(fakeDaytonaCancel.liveCount()).toBe(0);

    // 2. Exceeding maxPythonExecsPerRun fails closed without leaking sandboxes.
    const subLimit = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d843003',
      input: { title: 'Loop', prompt: 'Loop forever' },
    })) as V2PythonTaskSubmitResultDto;
    const claimLimit = await claimTask(core, subLimit.task.task_id, 'worker-limit');

    const fakeDaytonaLimit = createFakeDaytonaClient();
    const limitSteps: PythonAgentStepOutput[] = Array.from(
      { length: PYTHON_AGENT_LIMITS.maxPythonExecsPerRun + 2 },
      (_, idx) => ({
        kind: 'tool_call',
        toolCallId: `loop-${idx}`,
        code: 'print(1)',
        rawArgumentsJson: '{"code":"print(1)"}',
      }),
    );
    const limitOutcome = await executeV2PythonAgentTask({
      env: wrapCoreAsLocalEnv(core),
      claim: claimLimit,
      gateway: makeScriptedGateway(limitSteps),
      sandboxFactory: fakeDaytonaLimit.makeFactory(),
      now: () => clock.now,
    });
    expect(limitOutcome).toEqual({ status: 'failed', reasonCode: 'python_run_limit' });
    expect(fakeDaytonaLimit.liveCount()).toBe(0);

    // 3. Past deadline_at_ms fails immediately without creating a sandbox.
    const expiredClaim: V2PythonTaskClaim = {
      ...claimLimit,
      contextJson: JSON.stringify({
        ...JSON.parse(claimLimit.contextJson),
        deadlineAtMs: clock.now - 1,
      }),
    };
    const fakeDaytonaExpired = createFakeDaytonaClient();
    const expiredOutcome = await executeV2PythonAgentTask({
      env: wrapCoreAsLocalEnv(core),
      claim: expiredClaim,
      gateway: makeScriptedGateway([
        {
          kind: 'final',
          summaryText: 'unused',
          detailText: 'unused',
          truncated: false,
          finishReason: 'stop',
        },
      ]),
      sandboxFactory: fakeDaytonaExpired.makeFactory(),
      now: () => clock.now,
    });
    expect(expiredOutcome).toEqual({ status: 'failed', reasonCode: 'deadline_exceeded' });
    expect(fakeDaytonaExpired.createdRequests).toHaveLength(0);
  });

  it('binds chat uploads via resolve_staged_uploads + NL delegate_python_agent and preserves principal ownership without inputs', async () => {
    const clock = { now: 1_760_000_000_000 };
    const { core, storage } = createTestCore(clock);
    const submissionA = '11111111-1111-4111-8111-111111111101';
    const submissionB = '11111111-1111-4111-8111-111111111102';

    const upload = (await core.taskArtifacts({
      kind: 'stage_upload',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d844003',
      filename: 'sales.csv',
      mediaType: 'text/csv',
      contentBase64: toBase64('a,b\n1,2\n'),
    })) as B3StagedUploadReceiptDto;

    // Resolve upload cleanly, allow idempotent replay on submissionA, block reuse on submissionB.
    const resolvedA = (await core.taskArtifacts({
      kind: 'resolve_staged_uploads',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d844004',
      uploadIds: [upload.upload_id],
      clientSubmissionId: submissionA,
    })) as readonly ResolvedMessageAttachment[];
    expect(resolvedA).toHaveLength(1);
    expect(resolvedA[0]?.uploadId).toBe(upload.upload_id);

    const prepared = await core.prepareTurn({
      scope: {
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        agentId: AGENT_ID,
        policyVersion: 1,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d844005',
      },
      conversationId: CONVERSATION_ID,
      request: {
        client_submission_id: submissionA,
        text: 'Analyze attached file',
        transcript_epoch: 0,
        attachment_ids: [upload.upload_id],
      },
      workerId: 'edge-1',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
      modelReservation: {
        budgetMode: 'disabled_echo_only',
        providerId: 'fake',
        modelLabel: FAKE_MODEL_LABEL,
        rateVersion: 'fake-zero-cost',
        maxAttempts: 2,
        estimatedMicroUsd: 0,
      },
      resolvedAttachments: resolvedA,
    });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');

    // Different submission cannot reuse an already-linked staged upload.
    await expect(
      core.taskArtifacts({
        kind: 'resolve_staged_uploads',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d844006',
        uploadIds: [upload.upload_id],
        clientSubmissionId: submissionB,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const sent = await core.markAttemptSent({
      scope: { tenantId: TENANT_ID, agentId: AGENT_ID },
      subjectType: 'turn',
      subjectId: prepared.turnId,
      attemptNo: prepared.attemptNo,
      operationId: prepared.operationId,
      leaseEpoch: prepared.leaseEpoch,
      leaseOwner: 'edge-1',
    });
    expect(sent.authorized).toBe(true);

    const committed = await core.commitTurn({
      scope: { tenantId: TENANT_ID, agentId: AGENT_ID },
      conversationId: CONVERSATION_ID,
      turnId: prepared.turnId,
      leaseEpoch: prepared.leaseEpoch,
      leaseOwner: 'edge-1',
      attemptNo: prepared.attemptNo,
      operationId: prepared.operationId,
      settlement: { state: 'released', outcomeCode: 'ok' },
      result: {
        status: 'completed',
        text: 'Delegating to Python analysis.',
        modelLabel: FAKE_MODEL_LABEL,
        simulated: true,
        delegation: {
          toolName: 'delegate_python_agent',
          title: 'CSV Task',
          input: {
            prompt: 'Analyze the attached CSV',
            // Explicitly omit attachmentIds to verify fallback binding from message_attachments.
          },
        },
      },
    });
    expect(committed.outcome).toBe('published');
    if (committed.outcome !== 'published' || !committed.delegatedTaskId) {
      throw new Error('expected delegatedTaskId');
    }

    const boundRow = storage.sql
      .exec<{ readonly task_id: string | null }>(
        'SELECT task_id FROM v2_task_artifacts WHERE id = ?',
        upload.upload_id,
      )
      .one();
    expect(boundRow.task_id).toBe(committed.delegatedTaskId);

    const claimDelegated = await claimTask(core, committed.delegatedTaskId, 'worker-nl', 30_000, 1);
    const parsedClaimCtx = JSON.parse(claimDelegated.contextJson) as { principalId?: string };
    expect(parsedClaimCtx.principalId).toBe(PRINCIPAL_ID);
  });

  it('records bounded redacted cleanup incident and outcome when destroy() or close() fails', async () => {
    const clock = { now: 1_760_000_000_000 };
    const { core, storage } = createTestCore(clock);

    const submitted = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d845001',
      input: { title: 'Cleanup Fail Completed', prompt: 'Finish cleanly then fail destroy' },
    })) as V2PythonTaskSubmitResultDto;
    const claim = await claimTask(core, submitted.task.task_id, 'worker-cleanup');

    const fakeDaytona = createFakeDaytonaClient({
      deleteResult: new Error('daytona delete failed with secret sk-live-do-not-leak'),
      closeError: new Error('transport close failed'),
    });
    const incidents: V2SandboxCleanupIncident[] = [];

    const outcome = await executeV2PythonAgentTask({
      env: wrapCoreAsLocalEnv(core, { EMBER_SANDBOX_OWNER: 'test:v2-cleanup' }),
      claim,
      gateway: makeScriptedGateway([
        {
          kind: 'tool_call',
          toolCallId: 'call-clean-1',
          code: 'print(1)',
          rawArgumentsJson: '{"code":"print(1)"}',
        },
        {
          kind: 'final',
          summaryText: 'Computed output',
          detailText: 'Finished compute step.',
          truncated: false,
          finishReason: 'stop',
        },
      ]),
      sandboxFactory: fakeDaytona.makeFactory(),
      onCleanupIncident: (incident) => incidents.push(incident),
      now: () => clock.now,
    });

    expect(outcome).toMatchObject({
      status: 'completed',
      reasonCode: 'sandbox_cleanup_failed',
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      event: 'v2_python_sandbox_cleanup_failed',
      tenantId: TENANT_ID,
      taskId: submitted.task.task_id,
      owner: 'test:v2-cleanup',
      destroyFailed: true,
      closeFailed: true,
      destroyErrorCode: 'Error',
      closeErrorCode: 'Error',
      ttlMinutes: 2,
    });
    expect(JSON.stringify(incidents[0])).not.toContain('sk-live-do-not-leak');

    const committed = await core.commitDurableResult({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      entityType: 'task',
      entityId: submitted.task.task_id,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'worker-cleanup',
      outcome,
    });
    expect(committed.accepted).toBe(true);
    const resultRow = storage.sql
      .exec<{ readonly reason_code: string }>(
        'SELECT reason_code FROM task_results WHERE task_id = ?',
        submitted.task.task_id,
      )
      .one();
    expect(resultRow.reason_code).toBe('sandbox_cleanup_failed');

    // Also verify failed run preserves primary failure reason while recording :cleanup_failed suffix.
    const submittedFail = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d845002',
      input: { title: 'Cleanup Fail On Error', prompt: 'Tamper egress then fail delete' },
    })) as V2PythonTaskSubmitResultDto;
    const claimFail = await claimTask(core, submittedFail.task.task_id, 'worker-cleanup-2');
    const fakeDaytonaDeleteFalse = createFakeDaytonaClient({
      reportNetworkBlockAll: false,
      deleteResult: false,
    });
    const failIncidents: V2SandboxCleanupIncident[] = [];
    const failedOutcome = await executeV2PythonAgentTask({
      env: wrapCoreAsLocalEnv(core),
      claim: claimFail,
      gateway: makeScriptedGateway([
        {
          kind: 'tool_call',
          toolCallId: 'call-clean-2',
          code: 'print(1)',
          rawArgumentsJson: '{"code":"print(1)"}',
        },
      ]),
      sandboxFactory: fakeDaytonaDeleteFalse.makeFactory(),
      onCleanupIncident: (incident) => failIncidents.push(incident),
      now: () => clock.now,
    });
    expect(failedOutcome).toEqual({
      status: 'failed',
      reasonCode: 'sandbox_policy_denied:cleanup_failed',
    });
    expect(failIncidents).toHaveLength(1);
    expect(failIncidents[0]).toMatchObject({
      destroyFailed: true,
      closeFailed: false,
      destroyErrorCode: 'DEADLINE_EXCEEDED',
    });
  });

  it('wires real OpenRouter stepPythonAgent with Daytona, fails closed when stepPythonAgent is absent, and preserves fake+fake non-regression', async () => {
    const approvedModel = 'deepseek/deepseek-v4.1-flash-1017';
    const clock = { now: Date.now() };
    const headStorage = createInMemoryDoStorage();
    const gbStorage = createInMemoryDoStorage();
    const globalBudget = new GlobalBudgetAuthorityCore(gbStorage, 100_000);
    const core = new AgentHeadCore({
      storage: headStorage,
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      recoveryRegistry: createMockRegistry(),
      globalBudget,
      globalDailyCeilingMicroUsd: 100_000,
      nowMs: () => clock.now,
      eventRuntimeFactory: (business) => {
        const facade = new AgentEventRuntimeFacade({
          tenantId: TENANT_ID,
          agentId: AGENT_ID,
          storage: headStorage,
          business,
        });
        return {
          recoveryAdmission: facade.coverage,
          eventCoordinator: facade.outbox,
          recoveryHooks: {
            reconcileCoverageSync: (cmd) => facade.coverage.reconcileFromRegistrySync(cmd),
            confirmCoveragePlanSync: (cmd) => facade.coverage.confirmRegistryPlanSync(cmd),
            getOutboxByIdSync: (outboxId) => facade.outbox.getOutboxByIdSync(outboxId),
            syncPlatformAlarm: (targetAlarmAtMs, nowMs) =>
              facade.alarm.syncPlatformAlarm(targetAlarmAtMs, nowMs),
            getCoverageRowSync: () => facade.coverage.getCoverageRowSync(),
            relayBudgetSync: () => Promise.resolve(),
          },
        };
      },
    });
    core.bootstrapHead({ conversationId: CONVERSATION_ID });

    const fakeDaytona = createFakeDaytonaClient();
    const providerUrls: string[] = [];
    let stepTurn = 0;

    const realEnv = {
      EMBER_ENV: 'v2-staging',
      EMBER_V2_STAGING_ISOLATED: 'true',
      EMBER_MODEL_MODE: 'real',
      EMBER_MODEL_PROVIDER: 'openrouter',
      EMBER_MODEL_ID: approvedModel,
      EMBER_MODEL_API_KEY: 'sk-or-v1-valid-staging-canary-key-1234567890',
      EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
      EMBER_MODEL_ALPHA_TENANT_IDS: TENANT_ID,
      EMBER_SANDBOX_MODE: 'daytona',
      DAYTONA_API_KEY: 'daytona-test-key-unused',
      EMBER_DAYTONA_ALLOWED_TENANTS: TENANT_ID,
      EMBER_SANDBOX_OWNER: 'v2-staging:canary',
      AGENT_HEAD: {
        getByName: () => core as unknown as AgentHeadDO,
        idFromName: () => ({ toString: () => `${TENANT_ID}:${AGENT_ID}` }) as never,
      },
      GLOBAL_BUDGET: { getByName: () => globalBudget },
    } as unknown as LocalRuntimeEnv;

    const runtime = resolveV2ModelRuntime(realEnv, {
      fetchImpl: (url) => {
        providerUrls.push(url);
        stepTurn += 1;
        if (stepTurn === 1) {
          return Promise.resolve({
            status: 200,
            ok: true,
            json: () =>
              Promise.resolve({
                model: approvedModel,
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: 'Running analysis script.',
                      tool_calls: [
                        {
                          id: 'call_real_1',
                          type: 'function',
                          function: {
                            name: 'run_python_script',
                            arguments: JSON.stringify({
                              code: "open('outputs/report.csv','w').write('ok')",
                              purpose: 'Summarize sales',
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 150, completion_tokens: 30, cost: 0.000024 },
              }),
          });
        }
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () =>
            Promise.resolve({
              model: approvedModel,
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: JSON.stringify({
                      summaryText: 'Generated report.csv via real model + Daytona.',
                      detailText: 'Real LLM orchestrated Python execution in Daytona.',
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 200, completion_tokens: 40, cost: 0.000032 },
            }),
        });
      },
    });

    const upload = (await core.taskArtifacts({
      kind: 'stage_upload',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d846001',
      filename: 'sales.csv',
      mediaType: 'text/csv',
      contentBase64: toBase64('region,revenue\nnorth,120\n'),
    })) as B3StagedUploadReceiptDto;

    const submitted = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d846002',
      input: {
        title: 'Real LLM + Daytona CSV',
        prompt: 'Analyze sales.csv',
        attachment_ids: [upload.upload_id],
      },
    })) as V2PythonTaskSubmitResultDto;

    const claim = await claimTask(core, submitted.task.task_id, 'worker-real-daytona');

    // 1. Gateway missing stepPythonAgent must fail closed (never substitute FakeModelGateway).
    const executorNoStep = createDurableExecutor(
      realEnv,
      {
        streamConversationTurn: runtime.gateway.streamConversationTurn.bind(runtime.gateway),
        queryConversationJob: runtime.gateway.queryConversationJob.bind(runtime.gateway),
      },
      { modelRuntime: runtime, pythonSandboxFactory: fakeDaytona.makeFactory() },
    );
    const noStepOutcome = await executorNoStep.executeDurableWork(claim);
    expect(noStepOutcome).toEqual({
      status: 'failed',
      reasonCode: 'model_gateway_unavailable',
    });
    expect(fakeDaytona.createdRequests).toHaveLength(0);
    expect(providerUrls).toHaveLength(0);

    // 2. Real OpenRouter stepPythonAgent + DaytonaSandboxProvider executes, settles real cost, and cleans up.
    const realExecutor = createDurableExecutor(realEnv, runtime.gateway, {
      modelRuntime: runtime,
      pythonSandboxFactory: fakeDaytona.makeFactory(),
    });
    const realOutcome = await realExecutor.executeDurableWork(claim);
    expect(realOutcome).toMatchObject({
      status: 'completed',
      modelLabel: approvedModel,
      simulated: false,
      reasonCode: 'ok',
    });
    expect(providerUrls).toEqual([
      OPENROUTER_CHAT_COMPLETIONS_URL,
      OPENROUTER_CHAT_COMPLETIONS_URL,
    ]);
    expect(fakeDaytona.createdRequests).toHaveLength(1);
    expect(fakeDaytona.createdRequests[0]?.networkBlockAll).toBe(true);
    expect(fakeDaytona.liveCount()).toBe(0);
    expect(fakeDaytona.getDeletedCount()).toBe(1);
    expect(fakeDaytona.getClosedCount()).toBe(1);

    const committedReal = await core.commitDurableResult({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      entityType: 'task',
      entityId: submitted.task.task_id,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'worker-real-daytona',
      outcome: realOutcome,
    });
    expect(committedReal.accepted).toBe(true);

    const attempts = headStorage.sql
      .exec<{
        readonly state: string;
        readonly budget_mode: string;
        readonly provider_id: string;
        readonly model_label: string;
        readonly rate_version: string;
        readonly observed_cost_micro_usd: number;
      }>(
        'SELECT state, budget_mode, provider_id, model_label, rate_version, observed_cost_micro_usd FROM model_attempts WHERE subject_id = ? ORDER BY attempt_no ASC',
        submitted.task.task_id,
      )
      .toArray();
    expect(attempts).toEqual([
      {
        state: 'settled',
        budget_mode: 'real',
        provider_id: 'openrouter',
        model_label: approvedModel,
        rate_version: runtime.rateVersion,
        observed_cost_micro_usd: 24,
      },
      {
        state: 'settled',
        budget_mode: 'real',
        provider_id: 'openrouter',
        model_label: approvedModel,
        rate_version: runtime.rateVersion,
        observed_cost_micro_usd: 32,
      },
    ]);

    const taskResult = headStorage.sql
      .exec<{ readonly model_label: string; readonly simulated: number }>(
        'SELECT model_label, simulated FROM task_results WHERE task_id = ?',
        submitted.task.task_id,
      )
      .one();
    expect(taskResult).toEqual({
      model_label: approvedModel,
      simulated: 0,
    });

    // 3. Fake model + fake sandbox non-regression through createDurableExecutor.
    const uploadFake = (await core.taskArtifacts({
      kind: 'stage_upload',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: randomUUID(),
      filename: 'sales-fake.csv',
      mediaType: 'text/csv',
      contentBase64: toBase64('region,revenue\nnorth,120\n'),
    })) as B3StagedUploadReceiptDto;
    const fakeEnv = {
      EMBER_ENV: 'local',
      EMBER_MODEL_MODE: 'fake',
      EMBER_SANDBOX_MODE: 'fake',
      EMBER_V2_ISOLATED_HARNESS: 'true',
      FAKE_MODEL_GATEWAY_URL: 'http://127.0.0.1:8787',
      AGENT_HEAD: realEnv.AGENT_HEAD,
      GLOBAL_BUDGET: realEnv.GLOBAL_BUDGET,
    } as unknown as LocalRuntimeEnv;
    const fakeRuntime = resolveV2ModelRuntime(fakeEnv);
    const subFake = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: randomUUID(),
      input: {
        title: 'Fake+Fake CSV',
        prompt: 'Analyze sales-fake.csv\n# output: fake-summary.csv',
        attachment_ids: [uploadFake.upload_id],
      },
    })) as V2PythonTaskSubmitResultDto;
    const fakeClaim = await claimTask(core, subFake.task.task_id, 'worker-fake-fake');
    const fakeExecutor = createDurableExecutor(fakeEnv, fakeRuntime.gateway, {
      modelRuntime: fakeRuntime,
    });
    const fakeOutcome = await fakeExecutor.executeDurableWork(fakeClaim);
    expect(fakeOutcome).toMatchObject({
      status: 'completed',
      modelLabel: FAKE_MODEL_LABEL,
      simulated: true,
      reasonCode: 'ok',
    });

    // 4. Retry after lease expiry with prior model_attempt row routes back to python.agent (not streamConversationTurn).
    const subRetry = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      requestId: randomUUID(),
      input: { title: 'Retry Python Task', prompt: 'Retry after lease expiry' },
    })) as V2PythonTaskSubmitResultDto;
    const retryClaim1 = await claimTask(core, subRetry.task.task_id, 'worker-retry-1', 10_000);
    const retryRun1Id = (JSON.parse(retryClaim1.contextJson) as { runId: string }).runId;
    const reservedAttempt = await core.reserveTaskModelAttempt({
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      agentId: AGENT_ID,
      taskId: subRetry.task.task_id,
      runId: retryRun1Id,
      leaseEpoch: retryClaim1.leaseEpoch,
      providerId: 'fake',
      modelLabel: FAKE_MODEL_LABEL,
      rateVersion: 'fake-v2-m1',
      budgetMode: 'disabled_echo_only',
      estimatedMicroUsd: 0,
    });
    expect(reservedAttempt.kind).toBe('reserved');

    // Expire Run 1 lease without sending so AgentHeadRecoveryService re-enqueues epoch 2.
    clock.now += 15_000;
    core.convergeDueBusinessItemSync('task', subRetry.task.task_id, clock.now);
    const retryClaim2 = await claimTask(
      core,
      subRetry.task.task_id,
      'worker-retry-2',
      30_000,
      retryClaim1.leaseEpoch + 1,
    );
    const parsedRetryCtx = JSON.parse(retryClaim2.contextJson) as {
      attemptId?: string;
      kind?: string;
    };
    expect(parsedRetryCtx.attemptId).toBe('1');
    expect(parsedRetryCtx.kind).toBe('python.agent');

    const retryOutcome = await fakeExecutor.executeDurableWork(retryClaim2);
    expect(retryOutcome).toMatchObject({
      status: 'completed',
      modelLabel: FAKE_MODEL_LABEL,
      simulated: true,
      reasonCode: 'ok',
    });
  });
});
