import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { B1TaskDetailDtoSchema, B1TaskResultDtoSchema } from '@ember/contracts';
import { isDomainError } from '@ember/domain';
import {
  DELEGATE_PYTHON_TOOL_NAME,
  MODEL_LIMITS,
  OpenRouterModelGateway,
  RUN_PYTHON_TOOL_NAME,
  type FetchLike,
  type FetchResponseLike,
  type ModelRateRow,
  type OpenRouterRoutingPolicy,
} from '@ember/model-gateway';
import {
  B2_ABSOLUTE_DAY_CEILINGS,
  PostgresB1ConversationReadRepository,
  PostgresB1ConversationWriteRepository,
  PostgresB1TaskReadRepository,
  PostgresB3StagedUploadRepository,
  PostgresB3TaskDispatchOutboxRepository,
  PostgresByteaBlobStore,
  PostgresLeaseQueue,
  PostgresModelTurnExecutionRepository,
  PostgresNotesTaskExecutionRepository,
  PostgresPythonAgentExecutionRepository,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
  createPool,
  loadDatabaseConfig,
  resolveLeaseQueueConfig,
  systemClock,
} from '@ember/postgres';
import {
  DeterministicExecutionRouter,
  createDefaultSentinelPolicy,
  SAFE_MOCK_ACTION_CATEGORIES,
  SENTINEL_POLICY_VERSION,
} from '@ember/execution';
import { createModelTurnResponder } from '../../apps/worker/src/b1/model-turn-responder.js';
import { createNotesTaskHandler } from '../../apps/worker/src/notes-task-handler.js';
import {
  executePythonAgentRun,
  type PythonAgentDirectoryEntry,
  type PythonAgentSandboxPort,
} from '../../apps/worker/src/b3/python-agent-executor.js';
import type { WorkerLogger } from '../../apps/worker/src/logger.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

const MODEL_LABEL = 'nvidia/nemotron-3.5-lightning';
const OPENROUTER_RATE: ModelRateRow = {
  providerId: 'openrouter',
  modelId: MODEL_LABEL,
  inputMicroUsdPerMillion: 60_000,
  outputMicroUsdPerMillion: 160_000,
  rateVersion: 'openrouter-b3-python-it-rate',
  provenance: 'official_price_verified',
  source: 'b3 python postgres integration test',
  reasoningEffort: 'none',
  promptCacheMode: 'explicit',
};
const OPENROUTER_ROUTING: OpenRouterRoutingPolicy = Object.freeze({
  only: ['deepinfra'],
  allowFallbacks: false,
  dataCollection: 'deny',
  zdr: true,
  requireParameters: true,
});
const CEILINGS = {
  perAttemptMicroUsd: 5_000,
  principalDailyMicroUsd: 250_000,
  tenantDailyMicroUsd: 1_000_000,
  globalDailyMicroUsd: 5_000_000,
  principalDailyTurns: 60,
};
const SILENT_LOGGER: WorkerLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let db: TestDatabase;
let writer: PostgresB1ConversationWriteRepository;
let reader: PostgresB1ConversationReadRepository;
let turnRepo: PostgresModelTurnExecutionRepository;
let taskReadRepo: PostgresB1TaskReadRepository;
let uploadRepo: PostgresB3StagedUploadRepository;
let outboxRepo: PostgresB3TaskDispatchOutboxRepository;
let pythonRepo: PostgresPythonAgentExecutionRepository;
let notesRepo: PostgresNotesTaskExecutionRepository;
let taskRepo: PostgresTaskRepository;
let contextReader: PostgresRunExecutionContextReader;
let pythonLeaseQueue: PostgresLeaseQueue;
let notesLeaseQueue: PostgresLeaseQueue;

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  };
}

function makeOpenRouterGateway(fetchImpl: FetchLike): OpenRouterModelGateway {
  return new OpenRouterModelGateway({
    apiKey: 'sk-or-test-key-integration-b3-py-0123456789abcd',
    modelId: MODEL_LABEL,
    rate: OPENROUTER_RATE,
    routing: OPENROUTER_ROUTING,
    isAuthorized: () => true,
    fetchImpl,
  });
}

async function createTenantFixture() {
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();

  await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
    tenantId,
    'b3 py it tenant',
  ]);
  await db.pool.query("INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')", [
    principalId,
    tenantId,
  ]);
  await db.pool.query('INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)', [
    randomUUID(),
    tenantId,
    principalId,
  ]);
  await db.pool.query(
    'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
    [agentId, tenantId, 'Ember'],
  );
  await db.pool.query(
    "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
    [conversationId, tenantId, agentId],
  );

  return { tenantId, principalId, agentId, conversationId };
}

async function clearGlobalSpend(): Promise<void> {
  await db.pool.query(
    "DELETE FROM model_global_spend_days WHERE utc_day = (clock_timestamp() AT TIME ZONE 'UTC')::date",
  );
}

class FakePostgresSandbox implements PythonAgentSandboxPort {
  readonly files = new Map<string, Uint8Array>();
  readonly outputs: PythonAgentDirectoryEntry[] = [];
  readonly destroyed: string[] = [];
  private execCounter = 0;

  constructor(
    private readonly runner: (
      stepIndex: number,
      files: Map<string, Uint8Array>,
      outputs: PythonAgentDirectoryEntry[],
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  ) {}

  create() {
    return Promise.resolve({ sandboxId: `pg-sbx-${randomUUID()}` });
  }

  waitReady(): Promise<void> {
    return Promise.resolve();
  }

  putTextFile(_sandboxId: string, relativePath: string, text: string): Promise<void> {
    this.files.set(relativePath, new TextEncoder().encode(text));
    return Promise.resolve();
  }

  putBytesFile(_sandboxId: string, relativePath: string, bytes: Uint8Array): Promise<void> {
    this.files.set(relativePath, bytes);
    if (relativePath.startsWith('outputs/')) {
      const name = relativePath.slice('outputs/'.length);
      if (!this.outputs.some((o) => o.name === name)) {
        this.outputs.push({ name, isDir: false, isSymlink: false, sizeBytes: bytes.byteLength });
      }
    }
    return Promise.resolve();
  }

  getBytesFile(_sandboxId: string, relativePath: string): Promise<Uint8Array> {
    const bytes = this.files.get(relativePath);
    if (bytes === undefined) {
      return Promise.reject(new Error(`missing ${relativePath}`));
    }
    return Promise.resolve(bytes);
  }

  listDirectory(
    _sandboxId: string,
    relativeDir: string,
  ): Promise<readonly PythonAgentDirectoryEntry[]> {
    return Promise.resolve(relativeDir === 'outputs' ? [...this.outputs] : []);
  }

  async exec() {
    this.execCounter += 1;
    const res = await this.runner(this.execCounter, this.files, this.outputs);
    return {
      exitCode: res.exitCode,
      stdoutRef: `out-${this.execCounter}:${res.stdout}`,
      stderrRef: `err-${this.execCounter}:${res.stderr}`,
      artifactRefs: [],
    };
  }

  readOutput(_sandboxId: string, ref: string): Promise<string> {
    const sep = ref.indexOf(':');
    return Promise.resolve(sep >= 0 ? ref.slice(sep + 1) : '');
  }

  destroy(sandboxId: string): Promise<void> {
    this.destroyed.push(sandboxId);
    return Promise.resolve();
  }
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 16 });
  writer = new PostgresB1ConversationWriteRepository(db.pool);
  reader = new PostgresB1ConversationReadRepository(db.pool);
  turnRepo = new PostgresModelTurnExecutionRepository(db.pool);
  taskReadRepo = new PostgresB1TaskReadRepository(db.pool);
  uploadRepo = new PostgresB3StagedUploadRepository(db.pool);
  outboxRepo = new PostgresB3TaskDispatchOutboxRepository(db.pool);
  pythonRepo = new PostgresPythonAgentExecutionRepository(db.pool);
  notesRepo = new PostgresNotesTaskExecutionRepository(db.pool);
  taskRepo = new PostgresTaskRepository(db.pool);
  contextReader = new PostgresRunExecutionContextReader(db.pool, systemClock);
  pythonLeaseQueue = new PostgresLeaseQueue(db.pool, {
    claimableKinds: ['python.agent'],
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 5_000,
  });
  notesLeaseQueue = new PostgresLeaseQueue(db.pool, {
    claimableKinds: ['notes.action_items'],
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 5_000,
  });
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('B3-B1 PostgreSQL integration: migration 0021, staged uploads, python.agent execution & checkpoint recovery', () => {
  it('verifies migration 0021 tables and constraints', async () => {
    const tables = await db.observerPool.query<{ readonly table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name IN (
            'bytea_staged_blobs',
            'bytea_blobs',
            'user_staged_uploads',
            'conversation_message_attachments',
            'b3_task_dispatch_outbox'
          )`,
      [db.schema],
    );
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual([
      'b3_task_dispatch_outbox',
      'bytea_blobs',
      'bytea_staged_blobs',
      'conversation_message_attachments',
      'user_staged_uploads',
    ]);
  });

  it('enforces upload tenant/principal isolation and executes atomic delegation -> self-healing python loop -> artifact download', async () => {
    await clearGlobalSpend();
    const tenantA = await createTenantFixture();
    const tenantB = await createTenantFixture();

    const csvText = 'txn_region_code,gross_amount_usd_v2\nNA,125\nEU,75\nNA,25\n';
    const stagedUpload = await uploadRepo.stageUpload(
      { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 },
      {
        filename: 'revenue.csv',
        mediaType: 'text/csv',
        bytes: new TextEncoder().encode(csvText),
      },
    );

    // Cross-tenant principal cannot reference tenantA's staged upload.
    await expect(
      writer.submitUserMessage({
        tenantId: tenantB.tenantId,
        principalId: tenantB.principalId,
        conversationId: tenantB.conversationId,
        request: {
          client_submission_id: randomUUID(),
          text: 'steal file',
          transcript_epoch: 0,
          attachment_ids: [stagedUpload.upload_id],
        },
      }),
    ).rejects.toSatisfy((err: unknown) => isDomainError(err) && err.code === 'INVALID_ARGUMENT');

    const submitted = await writer.submitUserMessage({
      tenantId: tenantA.tenantId,
      principalId: tenantA.principalId,
      conversationId: tenantA.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Compute regional totals from revenue.csv and produce summary.csv',
        transcript_epoch: 0,
        attachment_ids: [stagedUpload.upload_id],
      },
    });

    // Turn delegates to delegate_python_agent -> atomically binds upload, creates Task + Run + outbox.
    let modelTurnCalls = 0;
    const turnGateway = makeOpenRouterGateway(() => {
      modelTurnCalls += 1;
      return Promise.resolve(
        jsonResponse({
          model: MODEL_LABEL,
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '好的，我将在隔离沙盒中分析 revenue.csv 并生成汇总 CSV。',
                tool_calls: [
                  {
                    id: 'call_py_del_1',
                    type: 'function',
                    function: {
                      name: DELEGATE_PYTHON_TOOL_NAME,
                      arguments: JSON.stringify({
                        title: 'Revenue Rollup',
                        prompt:
                          'Sum gross_amount_usd_v2 grouped by txn_region_code and write outputs/summary.csv',
                        attachment_ids: [stagedUpload.upload_id],
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 70, completion_tokens: 40, cost: 0.00001 },
        }),
      );
    });

    let delegatedTaskId = '';
    const turnSummary = await createModelTurnResponder({
      mode: 'real',
      repository: turnRepo,
      gateway: turnGateway,
      workerId: 'worker-b3-py-turn',
      leaseMs: 30_000,
      ceilings: CEILINGS,
      maxAttempts: 2,
      attemptTimeoutMs: 20_000,
      rate: OPENROUTER_RATE,
      onlyTurn: {
        tenantId: tenantA.tenantId,
        conversationId: tenantA.conversationId,
        turnId: submitted.receipt.turn.turn_id,
      },
      onTaskDelegated: (ev) => {
        delegatedTaskId = ev.taskId;
      },
    }).processOnce();

    expect(turnSummary.completed).toBe(1);
    expect(modelTurnCalls).toBe(1);
    expect(delegatedTaskId).not.toBe('');

    // Verify outbox event exists and notes-only queue ignores python.agent tasks.
    const outboxEvent = await outboxRepo.getEvent(delegatedTaskId);
    expect(outboxEvent).toMatchObject({
      taskId: delegatedTaskId,
      tenantId: tenantA.tenantId,
      kind: 'python.agent',
      status: 'queued',
    });
    const wrongQueueClaim = await notesLeaseQueue.claimNext('notes-worker-1', new Date());
    expect(wrongQueueClaim).toBeNull();

    // Claim python.agent run and execute self-healing 2-step Python loop.
    const lease = await pythonLeaseQueue.claimTaskForRun(
      tenantA.tenantId,
      delegatedTaskId,
      'py-worker-1',
      new Date(),
    );
    expect(lease).not.toBeNull();

    let agentStepCalls = 0;
    const agentGateway = makeOpenRouterGateway(() => {
      agentStepCalls += 1;
      if (agentStepCalls === 1) {
        return Promise.resolve(
          jsonResponse({
            model: MODEL_LABEL,
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'py_step_1',
                      type: 'function',
                      function: {
                        name: RUN_PYTHON_TOOL_NAME,
                        arguments: JSON.stringify({
                          code: "import csv\nprint(row['amount'])",
                          purpose: 'Attempt initial aggregation',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 150, completion_tokens: 35, cost: 0.000015 },
          }),
        );
      }
      if (agentStepCalls === 2) {
        return Promise.resolve(
          jsonResponse({
            model: MODEL_LABEL,
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'py_step_2',
                      type: 'function',
                      function: {
                        name: RUN_PYTHON_TOOL_NAME,
                        arguments: JSON.stringify({
                          code: "open('outputs/summary.csv','w').write('txn_region_code,total\\nNA,150\\nEU,75\\n')",
                          purpose: 'Fix column names and write summary.csv',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 210, completion_tokens: 45, cost: 0.00002 },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          model: MODEL_LABEL,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Regional totals computed: NA=150, EU=75 (saved to summary.csv).',
              },
            },
          ],
          usage: { prompt_tokens: 260, completion_tokens: 30, cost: 0.00002 },
        }),
      );
    });

    const outputCsvBytes = new TextEncoder().encode('txn_region_code,total\nNA,150\nEU,75\n');
    const sandbox = new FakePostgresSandbox((stepIndex, files, outputs) => {
      // Input CSV staged from bound user_staged_uploads must exist in inputs/revenue.csv.
      expect(new TextDecoder().decode(files.get('inputs/revenue.csv'))).toBe(csvText);
      if (stepIndex === 1) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: "KeyError: 'amount'" });
      }
      files.set('outputs/summary.csv', outputCsvBytes);
      outputs.push({
        name: 'summary.csv',
        isDir: false,
        isSymlink: false,
        sizeBytes: outputCsvBytes.byteLength,
      });
      return Promise.resolve({ exitCode: 0, stdout: 'wrote summary.csv', stderr: '' });
    });

    const blobStore = new PostgresByteaBlobStore(db.pool, {
      ownership: {
        taskId: lease!.taskId,
        runId: lease!.runId,
        leaseEpoch: lease!.leaseEpoch,
      },
    });

    const outcome = await executePythonAgentRun(lease!, {
      mode: 'real',
      leaseQueue: pythonLeaseQueue,
      repository: pythonRepo,
      blobStore,
      gateway: agentGateway,
      createSandbox: () => ({ provider: sandbox }),
      sandboxOwner: 'b3-it-owner',
      policy: resolveLeaseQueueConfig({ leaseDurationMs: 30_000, heartbeatIntervalMs: 5_000 }),
      ceilings: {
        perAttemptMicroUsd: CEILINGS.perAttemptMicroUsd,
        principalDailyMicroUsd: CEILINGS.principalDailyMicroUsd,
        tenantDailyMicroUsd: CEILINGS.tenantDailyMicroUsd,
        globalDailyMicroUsd: CEILINGS.globalDailyMicroUsd,
      },
      rate: OPENROUTER_RATE,
      leaseDurationMs: 30_000,
      attemptTimeoutMs: 20_000,
      logger: SILENT_LOGGER,
    });

    expect(outcome).toMatchObject({
      outcome: 'succeeded',
      sandboxCreated: true,
      pythonExecs: 2,
      llmCalls: 3,
    });
    expect(sandbox.destroyed).toHaveLength(1);

    // Verify task detail, task result, and downloadable output artifact in PG bytea store.
    const detail = await taskReadRepo.getTaskDetail(tenantA.tenantId, delegatedTaskId);
    expect(B1TaskDetailDtoSchema.safeParse(detail).success).toBe(true);
    expect(detail?.status).toBe('completed');

    const taskResult = await taskReadRepo.getTaskResult(tenantA.tenantId, delegatedTaskId);
    expect(B1TaskResultDtoSchema.safeParse(taskResult).success).toBe(true);
    expect(taskResult?.result_state).toBe('available');
    if (taskResult?.result_state === 'available') {
      expect(taskResult.result.summary_text).toContain('Regional totals computed');
    }

    const artifactsList = await uploadRepo.listTaskArtifacts(
      { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 },
      delegatedTaskId,
    );
    expect(artifactsList?.artifacts).toHaveLength(2);
    const inputArtifact = artifactsList!.artifacts.find((a) => a.created_by === 'user');
    const outArtifact = artifactsList!.artifacts.find((a) => a.created_by === 'run');
    expect(inputArtifact?.filename).toBe('revenue.csv');
    expect(outArtifact).toBeDefined();
    expect(outArtifact!.filename).toBe('summary.csv');

    const downloaded = await uploadRepo.getTaskArtifactDownload(
      { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 },
      outArtifact!.artifact_id,
    );
    expect(downloaded).not.toBeNull();
    expect(new TextDecoder().decode(downloaded!.bytes)).toBe(
      'txn_region_code,total\nNA,150\nEU,75\n',
    );
    expect(downloaded!.sha256).toBe(createHash('sha256').update(outputCsvBytes).digest('hex'));

    // Cross-tenant download must return null.
    const foreignDownload = await uploadRepo.getTaskArtifactDownload(
      { tenantId: tenantB.tenantId, principalId: tenantB.principalId, policyVersion: 1 },
      outArtifact!.artifact_id,
    );
    expect(foreignDownload).toBeNull();

    // Conversation timeline includes completion outcome message.
    const messages = await reader.readMessages({
      tenantId: tenantA.tenantId,
      conversationId: tenantA.conversationId,
      after: 0,
      limit: 20,
    });
    expect(messages.messages.some((m) => m.kind === 'outcome_reference')).toBe(true);
  });

  it('persists checkpoints across retryable failure and restores staged outputs on Run 2', async () => {
    await clearGlobalSpend();
    const tenant = await createTenantFixture();
    const submitted = await writer.submitUserMessage({
      tenantId: tenant.tenantId,
      principalId: tenant.principalId,
      conversationId: tenant.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Run two-stage Python computation',
        transcript_epoch: 0,
      },
    });

    const turnGateway = makeOpenRouterGateway(() =>
      Promise.resolve(
        jsonResponse({
          model: MODEL_LABEL,
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: 'Starting Python task.',
                tool_calls: [
                  {
                    id: 'call_py_retry',
                    type: 'function',
                    function: {
                      name: DELEGATE_PYTHON_TOOL_NAME,
                      arguments: JSON.stringify({
                        title: 'Two-stage compute',
                        prompt: 'Write intermediate.csv then complete',
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 25, cost: 0.00001 },
        }),
      ),
    );

    let taskId = '';
    await createModelTurnResponder({
      mode: 'real',
      repository: turnRepo,
      gateway: turnGateway,
      workerId: 'worker-b3-py-turn-2',
      leaseMs: 30_000,
      ceilings: CEILINGS,
      maxAttempts: 2,
      attemptTimeoutMs: 20_000,
      rate: OPENROUTER_RATE,
      onlyTurn: {
        tenantId: tenant.tenantId,
        conversationId: tenant.conversationId,
        turnId: submitted.receipt.turn.turn_id,
      },
      onTaskDelegated: (ev) => {
        taskId = ev.taskId;
      },
    }).processOnce();

    // Run 1 executes step 1 (stages intermediate.csv) and then fails retryably on LLM call 2 (HTTP 503).
    const lease1 = await pythonLeaseQueue.claimTaskForRun(
      tenant.tenantId,
      taskId,
      'py-worker-retry-1',
      new Date(),
    );
    expect(lease1).not.toBeNull();

    let run1Calls = 0;
    const run1Gateway = makeOpenRouterGateway(() => {
      run1Calls += 1;
      if (run1Calls === 1) {
        return Promise.resolve(
          jsonResponse({
            model: MODEL_LABEL,
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'step_1_ckpt',
                      type: 'function',
                      function: {
                        name: RUN_PYTHON_TOOL_NAME,
                        arguments: JSON.stringify({
                          code: "open('outputs/intermediate.csv','w').write('k,v\\na,1\\n')",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.00001 },
          }),
        );
      }
      return Promise.resolve(jsonResponse({ error: { message: 'upstream unavailable' } }, 503));
    });

    const intermediateBytes = new TextEncoder().encode('k,v\na,1\n');
    const sandbox1 = new FakePostgresSandbox((_idx, files, outputs) => {
      files.set('outputs/intermediate.csv', intermediateBytes);
      outputs.push({
        name: 'intermediate.csv',
        isDir: false,
        isSymlink: false,
        sizeBytes: intermediateBytes.byteLength,
      });
      return Promise.resolve({ exitCode: 0, stdout: 'wrote intermediate', stderr: '' });
    });

    const outcome1 = await executePythonAgentRun(lease1!, {
      mode: 'real',
      leaseQueue: pythonLeaseQueue,
      repository: pythonRepo,
      blobStore: new PostgresByteaBlobStore(db.pool, {
        ownership: {
          taskId: lease1!.taskId,
          runId: lease1!.runId,
          leaseEpoch: lease1!.leaseEpoch,
        },
      }),
      gateway: run1Gateway,
      createSandbox: () => ({ provider: sandbox1 }),
      sandboxOwner: 'b3-it-owner',
      policy: resolveLeaseQueueConfig({ leaseDurationMs: 30_000, heartbeatIntervalMs: 5_000 }),
      ceilings: {
        perAttemptMicroUsd: CEILINGS.perAttemptMicroUsd,
        principalDailyMicroUsd: CEILINGS.principalDailyMicroUsd,
        tenantDailyMicroUsd: CEILINGS.tenantDailyMicroUsd,
        globalDailyMicroUsd: CEILINGS.globalDailyMicroUsd,
      },
      rate: OPENROUTER_RATE,
      leaseDurationMs: 30_000,
      attemptTimeoutMs: 20_000,
      logger: SILENT_LOGGER,
    });

    expect(outcome1.outcome).toBe('failed_retryable');
    expect(sandbox1.destroyed).toHaveLength(1);

    // Make retry eligible immediately for deterministic test execution.
    await db.pool.query(
      "UPDATE tasks SET next_run_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid",
      [taskId],
    );

    const lease2 = await pythonLeaseQueue.claimTaskForRun(
      tenant.tenantId,
      taskId,
      'py-worker-retry-2',
      new Date(),
    );
    expect(lease2).not.toBeNull();
    expect(lease2!.attempt).toBe(2);

    // Verify loadAgentContext restores step 1 checkpoint and staged output bytes.
    const loaded2 = await pythonRepo.loadAgentContext(lease2!);
    expect(loaded2.kind).toBe('ready');
    if (loaded2.kind === 'ready') {
      expect(loaded2.context.checkpoints).toHaveLength(1);
      expect(loaded2.context.checkpoints[0]!.toolCallId).toBe('step_1_ckpt');
      expect(loaded2.context.latestStagedOutputs).toHaveLength(1);
      expect(new TextDecoder().decode(loaded2.context.latestStagedOutputs[0]!.bytes)).toBe(
        'k,v\na,1\n',
      );
    }

    // Run 2 executes step 2 on a fresh sandbox (verifying intermediate.csv was restored) & completes.
    let run2Calls = 0;
    const run2Gateway = makeOpenRouterGateway(() => {
      run2Calls += 1;
      if (run2Calls === 1) {
        return Promise.resolve(
          jsonResponse({
            model: MODEL_LABEL,
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'step_2_ckpt',
                      type: 'function',
                      function: {
                        name: RUN_PYTHON_TOOL_NAME,
                        arguments: JSON.stringify({ code: 'print("done")' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 150, completion_tokens: 20, cost: 0.00001 },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          model: MODEL_LABEL,
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Recovered and completed.' },
            },
          ],
          usage: { prompt_tokens: 180, completion_tokens: 20, cost: 0.00001 },
        }),
      );
    });

    const sandbox2 = new FakePostgresSandbox((_idx, files) => {
      expect(new TextDecoder().decode(files.get('outputs/intermediate.csv'))).toBe('k,v\na,1\n');
      return Promise.resolve({ exitCode: 0, stdout: 'done', stderr: '' });
    });

    const outcome2 = await executePythonAgentRun(lease2!, {
      mode: 'real',
      leaseQueue: pythonLeaseQueue,
      repository: pythonRepo,
      blobStore: new PostgresByteaBlobStore(db.pool, {
        ownership: {
          taskId: lease2!.taskId,
          runId: lease2!.runId,
          leaseEpoch: lease2!.leaseEpoch,
        },
      }),
      gateway: run2Gateway,
      createSandbox: () => ({ provider: sandbox2 }),
      sandboxOwner: 'b3-it-owner',
      policy: resolveLeaseQueueConfig({ leaseDurationMs: 30_000, heartbeatIntervalMs: 5_000 }),
      ceilings: {
        perAttemptMicroUsd: CEILINGS.perAttemptMicroUsd,
        principalDailyMicroUsd: CEILINGS.principalDailyMicroUsd,
        tenantDailyMicroUsd: CEILINGS.tenantDailyMicroUsd,
        globalDailyMicroUsd: CEILINGS.globalDailyMicroUsd,
      },
      rate: OPENROUTER_RATE,
      leaseDurationMs: 30_000,
      attemptTimeoutMs: 20_000,
      logger: SILENT_LOGGER,
    });

    expect(outcome2).toMatchObject({ outcome: 'succeeded', pythonExecs: 1, llmCalls: 2 });
    const finalArtifacts = await uploadRepo.listTaskArtifacts(
      { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 },
      taskId,
    );
    expect(finalArtifacts?.artifacts.map((a) => a.filename)).toEqual(['intermediate.csv']);
  });

  it('executes stage -> checkpoint -> commitCompletion under least-privilege cloud runtime grants', async () => {
    await clearGlobalSpend();
    const tenant = await createTenantFixture();
    const submitted = await writer.submitUserMessage({
      tenantId: tenant.tenantId,
      principalId: tenant.principalId,
      conversationId: tenant.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Generate summary.csv via python',
        transcript_epoch: 0,
      },
    });

    const sourceUrl = process.env.TEST_DATABASE_URL!;
    const role = `ember_b3_rt_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID().replaceAll('-', '');
    const quotedRole = `"${role}"`;
    const quotedSchema = `"${db.schema}"`;
    const databaseName = decodeURIComponent(new URL(sourceUrl).pathname.slice(1));
    const quotedDatabase = `"${databaseName.replaceAll('"', '""')}"`;

    await db.roleAdminPool.query(`CREATE ROLE ${quotedRole} LOGIN PASSWORD '${password}'`);
    let runtimePool: ReturnType<typeof createPool> | undefined;

    try {
      await db.adminPool.query(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${quotedRole}`);
      // Mirror the exact least-privilege grants assigned to Ember Cloud's `ember_staging_runtime_app` role.
      const tableGrants: readonly (readonly [string, string])[] = [
        ['agents', 'SELECT, INSERT'],
        ['approvals', 'SELECT, UPDATE'],
        ['artifacts', 'SELECT, INSERT'],
        ['assistant_turns', 'SELECT, INSERT, UPDATE'],
        ['b1_turn_dispatch_outbox', 'SELECT, INSERT, UPDATE'],
        ['b3_task_dispatch_outbox', 'SELECT, INSERT, UPDATE, DELETE'],
        ['blobs', 'SELECT, INSERT'],
        ['budget_operations', 'SELECT, INSERT, UPDATE'],
        ['bytea_blobs', 'SELECT, INSERT, DELETE'],
        ['bytea_staged_blobs', 'SELECT, INSERT, DELETE'],
        ['consumer_identities', 'SELECT, INSERT, UPDATE'],
        ['consumer_sessions', 'SELECT, INSERT, UPDATE'],
        ['consumers', 'SELECT, INSERT'],
        ['conversation_message_attachments', 'SELECT, INSERT'],
        ['conversation_messages', 'SELECT, INSERT'],
        ['conversations', 'SELECT, INSERT, UPDATE'],
        ['model_budget_incidents', 'SELECT, INSERT, UPDATE'],
        ['model_global_spend_days', 'SELECT, INSERT, UPDATE'],
        ['model_spend_days', 'SELECT, INSERT, UPDATE'],
        ['model_turn_attempts', 'SELECT, INSERT, UPDATE'],
        ['principals', 'SELECT, INSERT'],
        ['runs', 'SELECT, INSERT, UPDATE'],
        ['staged_blobs', 'SELECT, INSERT, UPDATE, DELETE'],
        ['step_checkpoints', 'SELECT, INSERT'],
        ['task_events', 'SELECT, INSERT'],
        ['task_model_attempts', 'SELECT, INSERT, UPDATE'],
        ['task_results', 'SELECT, INSERT'],
        ['tasks', 'SELECT, INSERT, UPDATE'],
        ['tenants', 'INSERT'],
        ['user_staged_uploads', 'SELECT, INSERT, UPDATE, DELETE'],
      ];
      for (const [table, privs] of tableGrants) {
        await db.adminPool.query(
          `GRANT ${privs} ON TABLE ${quotedSchema}."${table}" TO ${quotedRole}`,
        );
      }
      await db.roleAdminPool.query(
        `ALTER ROLE ${quotedRole} IN DATABASE ${quotedDatabase} SET search_path TO ${quotedSchema}`,
      );

      const loginUrl = new URL(sourceUrl);
      loginUrl.username = role;
      loginUrl.password = password;
      runtimePool = createPool({
        ...loadDatabaseConfig({ DATABASE_URL: loginUrl.toString() }),
        maxConnections: 4,
        searchPath: db.schema,
      });

      const rtTurnRepo = new PostgresModelTurnExecutionRepository(runtimePool);
      const rtLeaseQueue = new PostgresLeaseQueue(runtimePool, {
        claimableKinds: ['python.agent'],
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 5_000,
      });
      const rtPythonRepo = new PostgresPythonAgentExecutionRepository(runtimePool);
      const rtUploadRepo = new PostgresB3StagedUploadRepository(runtimePool);

      let taskId = '';
      await createModelTurnResponder({
        mode: 'real',
        repository: rtTurnRepo,
        gateway: makeOpenRouterGateway(() =>
          Promise.resolve(
            jsonResponse({
              model: MODEL_LABEL,
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: 'Starting Python task.',
                    tool_calls: [
                      {
                        id: 'call_priv_delegate',
                        type: 'function',
                        function: {
                          name: DELEGATE_PYTHON_TOOL_NAME,
                          arguments: JSON.stringify({
                            title: 'Least-privilege runtime test',
                            prompt: 'Write /home/daytona/ember/outputs/summary.csv',
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.00001 },
            }),
          ),
        ),
        workerId: 'rt-turn-priv',
        leaseMs: 30_000,
        ceilings: CEILINGS,
        maxAttempts: 2,
        attemptTimeoutMs: 20_000,
        rate: OPENROUTER_RATE,
        onlyTurn: {
          tenantId: tenant.tenantId,
          conversationId: tenant.conversationId,
          turnId: submitted.receipt.turn.turn_id,
        },
        onTaskDelegated: (ev) => {
          taskId = ev.taskId;
        },
      }).processOnce();
      expect(taskId).not.toBe('');

      const lease = await rtLeaseQueue.claimTaskForRun(
        tenant.tenantId,
        taskId,
        'rt-worker-priv',
        new Date(),
      );
      expect(lease).not.toBeNull();

      let callCount = 0;
      const gateway = makeOpenRouterGateway(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve(
            jsonResponse({
              model: MODEL_LABEL,
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_priv_step',
                        type: 'function',
                        function: {
                          name: RUN_PYTHON_TOOL_NAME,
                          arguments: JSON.stringify({ code: 'print("ok")' }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.00001 },
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            model: MODEL_LABEL,
            choices: [
              {
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'Summary generated.' },
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 15, cost: 0.00001 },
          }),
        );
      });

      const sandbox = new FakePostgresSandbox((_idx, files, outputs) => {
        const csvBytes = new TextEncoder().encode('txn_region_code,total_amount\napac,200.0\n');
        files.set('outputs/summary.csv', csvBytes);
        outputs.push({
          name: 'summary.csv',
          isDir: false,
          isSymlink: false,
          sizeBytes: csvBytes.byteLength,
        });
        return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '' });
      });

      const outcome = await executePythonAgentRun(lease!, {
        mode: 'real',
        leaseQueue: rtLeaseQueue,
        repository: rtPythonRepo,
        blobStore: new PostgresByteaBlobStore(runtimePool, {
          ownership: {
            taskId: lease!.taskId,
            runId: lease!.runId,
            leaseEpoch: lease!.leaseEpoch,
          },
        }),
        gateway,
        createSandbox: () => ({ provider: sandbox }),
        sandboxOwner: 'b3-it-owner',
        policy: resolveLeaseQueueConfig({ leaseDurationMs: 30_000, heartbeatIntervalMs: 5_000 }),
        ceilings: {
          perAttemptMicroUsd: CEILINGS.perAttemptMicroUsd,
          principalDailyMicroUsd: CEILINGS.principalDailyMicroUsd,
          tenantDailyMicroUsd: CEILINGS.tenantDailyMicroUsd,
          globalDailyMicroUsd: CEILINGS.globalDailyMicroUsd,
        },
        rate: OPENROUTER_RATE,
        leaseDurationMs: 30_000,
        attemptTimeoutMs: 20_000,
        logger: SILENT_LOGGER,
      });

      expect(outcome).toMatchObject({ outcome: 'succeeded', pythonExecs: 1, llmCalls: 2 });

      const listed = await rtUploadRepo.listTaskArtifacts(
        { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 },
        taskId,
      );
      expect(listed?.artifacts.map((a) => a.filename)).toEqual(['summary.csv']);
    } finally {
      await runtimePool?.end().catch(() => undefined);
      await db.roleAdminPool
        .query(`ALTER ROLE ${quotedRole} IN DATABASE ${quotedDatabase} RESET ALL`)
        .catch(() => undefined);
      await db.adminPool
        .query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quotedSchema} FROM ${quotedRole}`)
        .catch(() => undefined);
      await db.adminPool
        .query(`REVOKE ALL PRIVILEGES ON SCHEMA ${quotedSchema} FROM ${quotedRole}`)
        .catch(() => undefined);
      await db.roleAdminPool.query(`DROP ROLE IF EXISTS ${quotedRole}`).catch(() => undefined);
    }
  });

  it('enforces shared principal daily budget, incident halts, and consumers fail-closed across Turn, Notes, and Python Agent', async () => {
    await clearGlobalSpend();

    // 1. Fail closed (`principal_unavailable`) when a tenant has no `consumers` row.
    const orphanTenantId = randomUUID();
    const orphanAgentId = randomUUID();
    await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
      orphanTenantId,
      'orphan py tenant',
    ]);
    await db.pool.query(
      'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
      [orphanAgentId, orphanTenantId, 'Ember'],
    );
    const orphanTask = await taskRepo.create(
      { tenantId: orphanTenantId, principalId: randomUUID(), policyVersion: 1 },
      {
        agentId: orphanAgentId,
        kind: 'python.agent',
        title: 'No consumer task',
        input: { prompt: 'print(1)' },
        idempotencyKey: `orphan-${randomUUID()}`,
      },
    );
    const orphanLease = await pythonLeaseQueue.claimTaskForRun(
      orphanTenantId,
      orphanTask.taskId,
      'py-orphan-worker',
      new Date(),
    );
    expect(orphanLease).not.toBeNull();
    const orphanRes = await pythonRepo.reserveLlmAttempt({
      lease: orphanLease!,
      ceilings: {
        perAttemptMicroUsd: CEILINGS.perAttemptMicroUsd,
        principalDailyMicroUsd: CEILINGS.principalDailyMicroUsd,
        tenantDailyMicroUsd: CEILINGS.tenantDailyMicroUsd,
        globalDailyMicroUsd: CEILINGS.globalDailyMicroUsd,
      },
      maxAttemptsPerTask: 6,
      maxAttemptsPerRun: 4,
      maxTaskCostMicroUsd: 20_000,
      reservedMicroUsd: 100,
      rateVersion: OPENROUTER_RATE.rateVersion,
      providerId: 'openrouter',
      modelLabel: MODEL_LABEL,
    });
    expect(orphanRes).toEqual({ kind: 'principal_unavailable' });

    // 2. Same-principal spend sharing across Assistant Turn + Notes Task + Python Agent.
    const fixture = await createTenantFixture();
    const authCtx = {
      tenantId: fixture.tenantId,
      principalId: fixture.principalId,
      policyVersion: 1,
    };

    const turnSub = await writer.submitUserMessage({
      tenantId: fixture.tenantId,
      principalId: fixture.principalId,
      conversationId: fixture.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Summarize sprint',
        transcript_epoch: 0,
      },
    });
    const turnClaim = await turnRepo.claimTurn({
      turn: {
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        turnId: turnSub.receipt.turn.turn_id,
      },
      workerId: 'turn-budget-worker',
      leaseMs: 30_000,
    });
    expect(turnClaim.kind).toBe('claimed');
    if (turnClaim.kind !== 'claimed') return;

    const turnRes = await turnRepo.reserveAttempt({
      lease: turnClaim.lease,
      ceilings: CEILINGS,
      maxAttempts: 2,
      reservedMicroUsd: 200,
      rateVersion: OPENROUTER_RATE.rateVersion,
      providerId: 'openrouter',
      modelLabel: MODEL_LABEL,
    });
    expect(turnRes.kind).toBe('reserved');
    await turnRepo.markAttemptSent({ lease: turnClaim.lease, attemptNo: 1 });
    await turnRepo.settleAttempt({
      tenantId: fixture.tenantId,
      turnId: turnSub.receipt.turn.turn_id,
      attemptNo: 1,
      state: 'settled',
      outcomeCode: 'ok',
      observedCostMicroUsd: 120,
      inputTokens: 40,
      outputTokens: 10,
    });
    const turnPub1 = await turnRepo.publishCompletion({
      lease: turnClaim.lease,
      result: {
        status: 'completed',
        text: 'Turn 1 complete',
        modelLabel: MODEL_LABEL,
        simulated: false,
      },
    });
    expect(turnPub1.outcome).toBe('published');

    // Run a Notes task on the same tenant/principal via `createNotesTaskHandler`.
    const notesTask = await taskRepo.create(authCtx, {
      agentId: fixture.agentId,
      kind: 'notes.action_items',
      title: 'Shared principal notes',
      input: { notes: '- Alice: ship release' },
      idempotencyKey: `notes-shared-${randomUUID()}`,
    });
    const notesLease = await notesLeaseQueue.claimTaskForRun(
      fixture.tenantId,
      notesTask.taskId,
      'notes-budget-worker',
      new Date(),
    );
    expect(notesLease).not.toBeNull();
    const notesGateway = makeOpenRouterGateway(() =>
      Promise.resolve(
        jsonResponse({
          model: MODEL_LABEL,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  summary: '1 action item',
                  action_items: [{ action: 'Ship release', owner: 'Alice' }],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.00008 },
        }),
      ),
    );
    const notesOutcome = await createNotesTaskHandler({
      mode: 'real',
      contextReader,
      router: new DeterministicExecutionRouter(),
      repository: notesRepo,
      gateway: notesGateway,
      policy: resolveLeaseQueueConfig({ leaseDurationMs: 30_000, heartbeatIntervalMs: 5_000 }),
      ceilings: CEILINGS,
      maxAttemptsPerTask: MODEL_LIMITS.maxModelAttemptsPerTask,
      maxTaskCostMicroUsd: MODEL_LIMITS.maxModelCostPerTaskMicroUsd,
      attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
      rate: OPENROUTER_RATE,
      clock: systemClock,
      sentinelPolicy: () =>
        createDefaultSentinelPolicy({
          policyId: 'test-sentinel',
          policyVersion: SENTINEL_POLICY_VERSION,
          tenantId: fixture.tenantId,
          allowedActions: SAFE_MOCK_ACTION_CATEGORIES,
        }),
      logger: SILENT_LOGGER,
    }).handle(notesLease!, new AbortController().signal);
    expect(notesOutcome.type).toBe('committed');

    // Run a Python task attempt on the same tenant/principal and settle 300 micro-USD.
    const pyTask = await taskRepo.create(authCtx, {
      agentId: fixture.agentId,
      kind: 'python.agent',
      title: 'Shared principal python',
      input: { prompt: 'Compute metrics' },
      idempotencyKey: `py-shared-${randomUUID()}`,
    });
    const pyLease = await pythonLeaseQueue.claimTaskForRun(
      fixture.tenantId,
      pyTask.taskId,
      'py-budget-worker',
      new Date(),
    );
    expect(pyLease).not.toBeNull();

    // Principal spend already includes Turn (120) + Notes (80) = 200; reserving 330 requires >= 530 ceiling.
    const pyRes1 = await pythonRepo.reserveLlmAttempt({
      lease: pyLease!,
      ceilings: {
        perAttemptMicroUsd: CEILINGS.perAttemptMicroUsd,
        principalDailyMicroUsd: 530,
        tenantDailyMicroUsd: CEILINGS.tenantDailyMicroUsd,
        globalDailyMicroUsd: CEILINGS.globalDailyMicroUsd,
      },
      maxAttemptsPerTask: 6,
      maxAttemptsPerRun: 4,
      maxTaskCostMicroUsd: 20_000,
      reservedMicroUsd: 330,
      rateVersion: OPENROUTER_RATE.rateVersion,
      providerId: 'openrouter',
      modelLabel: MODEL_LABEL,
    });
    expect(pyRes1.kind).toBe('reserved');
    await pythonRepo.markLlmAttemptSent({ lease: pyLease!, attemptNo: 1 });
    await pythonRepo.settleLlmAttempt({
      tenantId: fixture.tenantId,
      taskId: pyTask.taskId,
      attemptNo: 1,
      state: 'settled',
      outcomeCode: 'ok',
      observedCostMicroUsd: 300,
      inputTokens: 100,
      outputTokens: 50,
    });

    // Both principal and tenant ledgers hold Turn (120) + Notes (80) + Python (300) = 500 micro-USD,
    // and both Notes & Python task_model_attempts persist principal_id.
    const persistedPrincipals = await db.pool.query<{
      readonly task_id: string;
      readonly principal_id: string;
    }>(
      `SELECT task_id, principal_id
         FROM task_model_attempts
        WHERE tenant_id = $1 AND task_id = ANY($2::uuid[])`,
      [fixture.tenantId, [notesTask.taskId, pyTask.taskId]],
    );
    expect(persistedPrincipals.rows).toHaveLength(2);
    expect(persistedPrincipals.rows.every((r) => r.principal_id === fixture.principalId)).toBe(
      true,
    );

    const principalSpendAfter1 = await db.pool.query<{
      readonly reserved_micro_usd: string;
      readonly consumed_micro_usd: string;
    }>(
      `SELECT reserved_micro_usd, consumed_micro_usd
         FROM model_spend_days
        WHERE tenant_id = $1 AND scope_kind = 'principal' AND scope_id = $2`,
      [fixture.tenantId, fixture.principalId],
    );
    expect(Number(principalSpendAfter1.rows[0]?.reserved_micro_usd)).toBe(0);
    expect(Number(principalSpendAfter1.rows[0]?.consumed_micro_usd)).toBe(500);

    const tenantSpendAfter1 = await db.pool.query<{
      readonly reserved_micro_usd: string;
      readonly consumed_micro_usd: string;
    }>(
      `SELECT reserved_micro_usd, consumed_micro_usd
         FROM model_spend_days
        WHERE tenant_id = $1 AND scope_kind = 'tenant' AND scope_id = $1`,
      [fixture.tenantId],
    );
    expect(Number(tenantSpendAfter1.rows[0]?.reserved_micro_usd)).toBe(0);
    expect(Number(tenantSpendAfter1.rows[0]?.consumed_micro_usd)).toBe(500);

    // 3. Python attempt 2 requesting 50 against principalDailyMicroUsd=530 must refuse AND rollback global/tenant holds.
    const pyRefused = await pythonRepo.reserveLlmAttempt({
      lease: pyLease!,
      ceilings: {
        perAttemptMicroUsd: CEILINGS.perAttemptMicroUsd,
        principalDailyMicroUsd: 530,
        tenantDailyMicroUsd: CEILINGS.tenantDailyMicroUsd,
        globalDailyMicroUsd: CEILINGS.globalDailyMicroUsd,
      },
      maxAttemptsPerTask: 6,
      maxAttemptsPerRun: 4,
      maxTaskCostMicroUsd: 20_000,
      reservedMicroUsd: 50,
      rateVersion: OPENROUTER_RATE.rateVersion,
      providerId: 'openrouter',
      modelLabel: MODEL_LABEL,
    });
    expect(pyRefused).toEqual({ kind: 'budget_exceeded', scope: 'principal' });

    const leakedHolds = await db.pool.query<{
      readonly scope_kind: string;
      readonly reserved_micro_usd: string;
    }>(
      `SELECT scope_kind, reserved_micro_usd
         FROM model_spend_days
        WHERE tenant_id = $1`,
      [fixture.tenantId],
    );
    expect(leakedHolds.rows.every((r) => Number(r.reserved_micro_usd) === 0)).toBe(true);

    // 4. Conversely, Python spend counts against a subsequent Assistant Turn's principalDailyMicroUsd cap.
    const turn2Sub = await writer.submitUserMessage({
      tenantId: fixture.tenantId,
      principalId: fixture.principalId,
      conversationId: fixture.conversationId,
      request: { client_submission_id: randomUUID(), text: 'Followup', transcript_epoch: 0 },
    });
    const turn2Claim = await turnRepo.claimTurn({
      turn: {
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        turnId: turn2Sub.receipt.turn.turn_id,
      },
      workerId: 'turn-budget-worker-2',
      leaseMs: 30_000,
    });
    expect(turn2Claim.kind).toBe('claimed');
    if (turn2Claim.kind !== 'claimed') return;

    const turn2Refused = await turnRepo.reserveAttempt({
      lease: turn2Claim.lease,
      ceilings: { ...CEILINGS, principalDailyMicroUsd: 530 },
      maxAttempts: 2,
      reservedMicroUsd: 50,
      rateVersion: OPENROUTER_RATE.rateVersion,
      providerId: 'openrouter',
      modelLabel: MODEL_LABEL,
    });
    expect(turn2Refused).toEqual({ kind: 'budget_exceeded', scope: 'principal' });

    // 5. Principal day_ceiling_exceeded incident opened by Python settlement halts subsequent Python calls.
    const pyCeilings = {
      perAttemptMicroUsd: CEILINGS.perAttemptMicroUsd,
      principalDailyMicroUsd: CEILINGS.principalDailyMicroUsd,
      tenantDailyMicroUsd: CEILINGS.tenantDailyMicroUsd,
      globalDailyMicroUsd: CEILINGS.globalDailyMicroUsd,
    };
    const pyRes2 = await pythonRepo.reserveLlmAttempt({
      lease: pyLease!,
      ceilings: pyCeilings,
      maxAttemptsPerTask: 6,
      maxAttemptsPerRun: 4,
      maxTaskCostMicroUsd: 20_000,
      reservedMicroUsd: 100,
      rateVersion: OPENROUTER_RATE.rateVersion,
      providerId: 'openrouter',
      modelLabel: MODEL_LABEL,
    });
    expect(pyRes2.kind).toBe('reserved');
    await pythonRepo.markLlmAttemptSent({ lease: pyLease!, attemptNo: 2 });
    const overageSettle = await pythonRepo.settleLlmAttempt({
      tenantId: fixture.tenantId,
      taskId: pyTask.taskId,
      attemptNo: 2,
      state: 'settled',
      outcomeCode: 'ok',
      observedCostMicroUsd: B2_ABSOLUTE_DAY_CEILINGS.principalMicroUsd,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(overageSettle.kind).toBe('applied');
    if (overageSettle.kind === 'applied') {
      expect(overageSettle.incidentsOpened).toBeGreaterThanOrEqual(1);
    }

    const haltedPy = await pythonRepo.reserveLlmAttempt({
      lease: pyLease!,
      ceilings: pyCeilings,
      maxAttemptsPerTask: 6,
      maxAttemptsPerRun: 4,
      maxTaskCostMicroUsd: 20_000,
      reservedMicroUsd: 10,
      rateVersion: OPENROUTER_RATE.rateVersion,
      providerId: 'openrouter',
      modelLabel: MODEL_LABEL,
    });
    expect(haltedPy).toEqual({
      kind: 'budget_halted',
      scope: 'principal',
      reason: 'day_ceiling_exceeded',
    });
  });
});
