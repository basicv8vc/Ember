import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  PYTHON_AGENT_LIMITS,
  type B1TaskDetailDto,
  type B1TaskListDto,
  type B3StagedUploadReceiptDto,
  type B3TaskArtifactsListDto,
} from '@ember/contracts';
import {
  AgentEventRuntimeFacade,
  AgentHeadCore,
  V2_MAX_INLINE_ARTIFACT_BYTES,
  applyAgentHeadMigrations,
  createDefaultAgentHeadMigrations,
  runV2FakePythonSandbox,
  type DurableObjectStorageLike,
  type GlobalBudgetAuthority,
  type RecoveryRegistryPort,
  type SqlStorageCursorLike,
  type SqlStorageRow,
  type V2DispatchEnvelope,
  type V2PublishTaskOutputsResultDto,
  type V2PythonTaskSubmitResultDto,
  type V2TaskArtifactDownloadDto,
  type V2TaskInputFileDto,
} from '@ember/runtime-v2';

const TENANT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d840101';
const AGENT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d840102';
const PRINCIPAL_A = '018f5f2e-0e91-7a30-ae62-bcb97d840103';
const PRINCIPAL_B = '018f5f2e-0e91-7a30-ae62-bcb97d840104';
const CONVERSATION_ID = '018f5f2e-0e91-7a30-ae62-bcb97d840105';

function toBase64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
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
        const stmt = db.prepare(query);
        const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
        let rows: T[] = [];
        if (isReader) {
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
    reserveGlobal: () => Promise.reject(new Error('unused in task-artifact unit test')),
    authorizeGlobalSend: () => Promise.reject(new Error('unused in task-artifact unit test')),
    renewGlobalGrant: () => Promise.reject(new Error('unused in task-artifact unit test')),
    settleGlobal: () => Promise.reject(new Error('unused in task-artifact unit test')),
  };
}

function createTestCore(clockRef: { now: number }) {
  const storage = createInMemoryDoStorage();
  const registry = createMockRegistry();
  let facade!: AgentEventRuntimeFacade;
  const core = new AgentHeadCore({
    storage,
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    recoveryRegistry: registry,
    globalBudget: createMockGlobalBudget(),
    nowMs: () => clockRef.now,
    eventRuntimeFactory: (business) => {
      facade = new AgentEventRuntimeFacade({
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
  return { core, storage, facade };
}

function makeTaskEnvelope(taskId: string, fenceEpoch: number): V2DispatchEnvelope {
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

describe('V2 Tools & Execution — runV2FakePythonSandbox', () => {
  it('computes bounded CSV numeric statistics and emits a downloadable CSV artifact', () => {
    const csv = ['region,revenue,units', 'north,120.50,10', 'south,79.50,5', 'west,200,15'].join(
      '\n',
    );
    const result = runV2FakePythonSandbox({
      prompt: 'Summarize sales.csv\n# output: sales-summary.csv',
      inputFiles: [
        {
          filename: 'sales.csv',
          mediaType: 'text/csv',
          bytes: new TextEncoder().encode(csv),
        },
      ],
    });

    expect(result.outputFiles).toHaveLength(1);
    expect(result.outputFiles[0]?.filename).toBe('sales-summary.csv');
    expect(result.outputFiles[0]?.mediaType).toBe('text/csv');
    const report = new TextDecoder().decode(result.outputFiles[0]!.bytes);
    expect(report).toContain('source_file,column,count,sum,min,max,mean');
    expect(report).toContain('sales.csv,revenue,3,400,79.50,200,133.33');
    expect(report).toContain('sales.csv,units,3,30,5,15,10');
  });

  it('parses RFC-4180 quoted CSV cells with embedded commas without shifting columns', () => {
    const csv = [
      '"region, area","revenue, USD",units',
      '"North, ""Tier 1""",120.50,10',
      '"South, Coastal",79.50,5',
    ].join('\r\n');
    const result = runV2FakePythonSandbox({
      prompt: 'Summarize quoted.csv',
      inputFiles: [
        {
          filename: 'quoted.csv',
          mediaType: 'text/csv',
          bytes: new TextEncoder().encode(csv),
        },
      ],
    });

    const report = new TextDecoder().decode(result.outputFiles[0]!.bytes);
    expect(report).toContain('quoted.csv,"revenue, USD",2,200,79.50,120.50,100');
    expect(report).toContain('quoted.csv,units,2,15,5,10,7.50');
  });

  it('rejects unsafe input filenames fail-closed', () => {
    expect(() =>
      runV2FakePythonSandbox({
        prompt: 'Analyze',
        inputFiles: [
          {
            filename: '../secret.csv',
            mediaType: 'text/csv',
            bytes: new TextEncoder().encode('a,b\n1,2\n'),
          },
        ],
      }),
    ).toThrow(/Invalid request input|unsafe input filename/);
  });
});

describe('V2 AgentHeadTaskArtifactService', () => {
  it('stages uploads, submits idempotent python tasks linked to conversation, enforces bounds and principal isolation', async () => {
    const clock = { now: 1_760_000_000_000 };
    const { core } = createTestCore(clock);

    // 1. Blocked active web MIME type is rejected.
    await expect(
      core.taskArtifacts({
        kind: 'stage_upload',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840201',
        filename: 'evil.html',
        mediaType: 'text/html',
        contentBase64: toBase64('<script>alert(1)</script>'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // 2. Oversized inline upload is rejected.
    await expect(
      core.taskArtifacts({
        kind: 'stage_upload',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840202',
        filename: 'huge.csv',
        mediaType: 'text/csv',
        contentBase64: Buffer.alloc(V2_MAX_INLINE_ARTIFACT_BYTES + 1, 0x61).toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // 3. Stage valid CSV upload.
    const upload = (await core.taskArtifacts({
      kind: 'stage_upload',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840203',
      filename: 'sales.csv',
      mediaType: 'text/csv',
      contentBase64: toBase64('region,revenue\nnorth,100\nsouth,200\n'),
    })) as B3StagedUploadReceiptDto;
    expect(upload.filename).toBe('sales.csv');

    // 4. Submit python task with client_request_id; replay returns created=false; conflict throws 409.
    const clientRequestId = '018f5f2e-0e91-7a30-ae62-bcb97d840210';
    const submitted = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840204',
      input: {
        title: 'Sales CSV summary',
        prompt: 'Analyze sales.csv',
        attachment_ids: [upload.upload_id],
        client_request_id: clientRequestId,
      },
    })) as V2PythonTaskSubmitResultDto;
    expect(submitted.created).toBe(true);
    expect(submitted.task.kind).toBe('python.agent');
    expect(submitted.task.status).toBe('queued');

    const replay = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840205',
      input: {
        title: 'Sales CSV summary',
        prompt: 'Analyze sales.csv',
        attachment_ids: [upload.upload_id],
        client_request_id: clientRequestId,
      },
    })) as V2PythonTaskSubmitResultDto;
    expect(replay.created).toBe(false);
    expect(replay.task.task_id).toBe(submitted.task.task_id);

    await expect(
      core.taskArtifacts({
        kind: 'submit_python_task',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840206',
        input: {
          title: 'Different prompt',
          prompt: 'Something else',
          client_request_id: clientRequestId,
        },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    // 5. Verify task_reference message was appended to the main conversation.
    const page = await core.readMessages({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      after: 0,
      limit: 20,
    });
    expect(
      page.messages.some(
        (m) => m.kind === 'task_reference' && m.task_id === submitted.task.task_id,
      ),
    ).toBe(true);

    // 6. Principal B cannot see Principal A's bound artifact or download it.
    const listA = (await core.taskArtifacts({
      kind: 'list_task_artifacts',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840209',
      taskId: submitted.task.task_id,
    })) as B3TaskArtifactsListDto;
    expect(listA.artifacts).toHaveLength(1);

    const downloadB = (await core.taskArtifacts({
      kind: 'download_artifact',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_B,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840211',
      artifactId: upload.upload_id,
    })) as V2TaskArtifactDownloadDto | null;
    expect(downloadB).toBeNull();

    // 7. Cancel queued task cleanly.
    clock.now += 1_000;
    await core.taskArtifacts({
      kind: 'cancel_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840212',
      taskId: submitted.task.task_id,
    });
    const detail = (await core.taskArtifacts({
      kind: 'get_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840213',
      taskId: submitted.task.task_id,
    })) as B1TaskDetailDto;
    expect(detail.status).toBe('cancelled');
  });

  it('P1-1: keeps staged outputs invisible until atomic completion and exposes only the winning retry output', async () => {
    const clock = { now: 1_760_000_000_000 };
    const { core, storage } = createTestCore(clock);

    const submitted = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840301',
      input: { title: 'Atomic visibility', prompt: 'Generate output' },
    })) as V2PythonTaskSubmitResultDto;
    const taskId = submitted.task.task_id;

    // Claim run 1.
    const claim1 = await core.claimDurableWork({
      envelope: makeTaskEnvelope(taskId, 0),
      workerId: 'worker-1',
      leaseMs: 10_000,
    });
    expect(claim1.kind).toBe('claimed');
    if (claim1.kind !== 'claimed') throw new Error('expected claim1');
    const run1Id = (JSON.parse(claim1.contextJson) as { runId: string }).runId;

    // Stage output from run 1.
    const pub1 = (await core.taskArtifacts({
      kind: 'publish_task_outputs',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840302',
      taskId,
      runId: run1Id,
      leaseEpoch: claim1.leaseEpoch,
      workerId: 'worker-1',
      outputs: [
        {
          filename: 'attempt1.csv',
          mediaType: 'text/csv',
          contentBase64: toBase64('attempt,val\n1,100\n'),
        },
      ],
    })) as V2PublishTaskOutputsResultDto;
    expect(pub1.accepted).toBe(true);
    const staleArtifactId = pub1.artifactIds[0]!;

    // Before commitDurableResult, run 1 output MUST NOT be visible or downloadable!
    const preCommitList = (await core.taskArtifacts({
      kind: 'list_task_artifacts',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840303',
      taskId,
    })) as B3TaskArtifactsListDto;
    expect(preCommitList.artifacts).toHaveLength(0);
    const preCommitDownload = (await core.taskArtifacts({
      kind: 'download_artifact',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840304',
      artifactId: staleArtifactId,
    })) as V2TaskArtifactDownloadDto | null;
    expect(preCommitDownload).toBeNull();

    // Exceeding per-task output artifact cap is rejected.
    await expect(
      core.taskArtifacts({
        kind: 'publish_task_outputs',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840305',
        taskId,
        runId: run1Id,
        leaseEpoch: claim1.leaseEpoch,
        workerId: 'worker-1',
        outputs: Array.from(
          { length: PYTHON_AGENT_LIMITS.maxOutputArtifactsPerTask + 1 },
          (_, i) => ({
            filename: `out-${i}.csv`,
            mediaType: 'text/csv',
            contentBase64: toBase64('a,b\n1,2\n'),
          }),
        ),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    // Simulate worker-1 crash & lease expiry -> recovery re-enqueues task for retry (run 2).
    clock.now += 15_000;
    core.recoveryService.convergeDueBusinessItemSync('task', taskId, clock.now);
    const outboxRow = storage.sql
      .exec<{
        readonly outbox_id: string;
        readonly fence_epoch: number;
        readonly payload_json: string;
      }>(
        `SELECT outbox_id, fence_epoch, payload_json
           FROM v2_dispatch_outbox
          WHERE entity_kind = 'task' AND entity_id = ? AND state = 'pending'
          ORDER BY created_at_ms DESC LIMIT 1`,
        taskId,
      )
      .one();

    const claim2 = await core.claimDurableWork({
      envelope: JSON.parse(outboxRow.payload_json) as V2DispatchEnvelope,
      workerId: 'worker-2',
      leaseMs: 10_000,
    });
    expect(claim2.kind).toBe('claimed');
    if (claim2.kind !== 'claimed') throw new Error('expected claim2');
    const run2Id = (JSON.parse(claim2.contextJson) as { runId: string }).runId;
    expect(run2Id).not.toBe(run1Id);

    // Run 2 publishes different output content.
    const pub2 = (await core.taskArtifacts({
      kind: 'publish_task_outputs',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840306',
      taskId,
      runId: run2Id,
      leaseEpoch: claim2.leaseEpoch,
      workerId: 'worker-2',
      outputs: [
        {
          filename: 'final-attempt2.csv',
          mediaType: 'text/csv',
          contentBase64: toBase64('attempt,val\n2,250\n'),
        },
      ],
    })) as V2PublishTaskOutputsResultDto;
    expect(pub2.accepted).toBe(true);
    const winningArtifactId = pub2.artifactIds[0]!;

    // Commit run 2 atomically via commitDurableResult.
    const committed = await core.commitDurableResult({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      entityType: 'task',
      entityId: taskId,
      leaseEpoch: claim2.leaseEpoch,
      workerId: 'worker-2',
      outcome: {
        status: 'completed',
        summaryText: 'Done on attempt 2',
        detailText: 'Winning attempt 2 output ready',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        reasonCode: 'ok',
      },
    });
    expect(committed.accepted).toBe(true);

    // Only run 2's winning artifact is visible and downloadable; run 1's stale output is purged.
    const finalList = (await core.taskArtifacts({
      kind: 'list_task_artifacts',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840307',
      taskId,
    })) as B3TaskArtifactsListDto;
    expect(finalList.artifacts).toHaveLength(1);
    expect(finalList.artifacts[0]?.artifact_id).toBe(winningArtifactId);
    expect(finalList.artifacts[0]?.filename).toBe('final-attempt2.csv');

    const staleDownload = (await core.taskArtifacts({
      kind: 'download_artifact',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840308',
      artifactId: staleArtifactId,
    })) as V2TaskArtifactDownloadDto | null;
    expect(staleDownload).toBeNull();

    const winningDownload = (await core.taskArtifacts({
      kind: 'download_artifact',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840309',
      artifactId: winningArtifactId,
    })) as V2TaskArtifactDownloadDto | null;
    expect(winningDownload?.filename).toBe('final-attempt2.csv');

    // Also verify publish -> cancel leaves zero visible output artifacts.
    const cancelTaskSub = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840310',
      input: { title: 'Cancel after publish', prompt: 'Cancel me' },
    })) as V2PythonTaskSubmitResultDto;
    const cancelClaim = await core.claimDurableWork({
      envelope: makeTaskEnvelope(cancelTaskSub.task.task_id, 0),
      workerId: 'worker-c',
      leaseMs: 10_000,
    });
    expect(cancelClaim.kind).toBe('claimed');
    if (cancelClaim.kind !== 'claimed') throw new Error('expected cancelClaim');
    const cancelRunId = (JSON.parse(cancelClaim.contextJson) as { runId: string }).runId;
    const cancelPub = (await core.taskArtifacts({
      kind: 'publish_task_outputs',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840311',
      taskId: cancelTaskSub.task.task_id,
      runId: cancelRunId,
      leaseEpoch: cancelClaim.leaseEpoch,
      workerId: 'worker-c',
      outputs: [
        { filename: 'aborted.csv', mediaType: 'text/csv', contentBase64: toBase64('x\n1\n') },
      ],
    })) as V2PublishTaskOutputsResultDto;
    expect(cancelPub.accepted).toBe(true);

    await core.taskArtifacts({
      kind: 'cancel_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840312',
      taskId: cancelTaskSub.task.task_id,
    });
    const cancelledArtifacts = (await core.taskArtifacts({
      kind: 'list_task_artifacts',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840313',
      taskId: cancelTaskSub.task.task_id,
    })) as B3TaskArtifactsListDto;
    expect(cancelledArtifacts.artifacts).toHaveLength(0);
  });

  it('P1-2: enforces staged upload expiry, prunes expired unbound uploads for quota recovery, and preserves bound inputs', async () => {
    const clock = { now: 1_760_000_000_000 };
    const { core } = createTestCore(clock);

    // Bind one upload to a task so we verify bound inputs are NEVER pruned after TTL.
    const boundUpload = (await core.taskArtifacts({
      kind: 'stage_upload',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840400',
      filename: 'bound.csv',
      mediaType: 'text/csv',
      contentBase64: toBase64('k,v\na,1\n'),
    })) as B3StagedUploadReceiptDto;
    const boundTask = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840401',
      input: { prompt: 'Keep bound input', attachment_ids: [boundUpload.upload_id] },
    })) as V2PythonTaskSubmitResultDto;

    // Fill unbound upload quota to the exact limit.
    const unboundIds: string[] = [];
    for (let i = 0; i < PYTHON_AGENT_LIMITS.maxUnboundUploadsPerUser; i += 1) {
      const receipt = (await core.taskArtifacts({
        kind: 'stage_upload',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: `018f5f2e-0e91-7a30-ae62-bcb97d8404${String(10 + i).padStart(2, '0')}`,
        filename: `u${i}.csv`,
        mediaType: 'text/csv',
        contentBase64: toBase64(`x\n${i}\n`),
      })) as B3StagedUploadReceiptDto;
      unboundIds.push(receipt.upload_id);
    }

    // One more upload before expiry hits quota.
    await expect(
      core.taskArtifacts({
        kind: 'stage_upload',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840450',
        filename: 'over-quota.csv',
        mediaType: 'text/csv',
        contentBase64: toBase64('x\n99\n'),
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

    // Advance clock to exact expiry boundary.
    clock.now += PYTHON_AGENT_LIMITS.maxUploadTtlMs;

    // Binding an expired unbound upload is rejected.
    await expect(
      core.taskArtifacts({
        kind: 'submit_python_task',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840451',
        input: { prompt: 'Bind expired', attachment_ids: [unboundIds[0]!] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // Staging a new upload prunes expired unbound rows and recovers quota!
    const fresh = (await core.taskArtifacts({
      kind: 'stage_upload',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840452',
      filename: 'recovered.csv',
      mediaType: 'text/csv',
      contentBase64: toBase64('x\n1\n'),
    })) as B3StagedUploadReceiptDto;
    expect(fresh.filename).toBe('recovered.csv');

    // Previously bound input was NOT pruned.
    const boundList = (await core.taskArtifacts({
      kind: 'list_task_artifacts',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840453',
      taskId: boundTask.task.task_id,
    })) as B3TaskArtifactsListDto;
    expect(boundList.artifacts).toHaveLength(1);
    expect(boundList.artifacts[0]?.artifact_id).toBe(boundUpload.upload_id);
  });

  it('P1-3: enforces live lease (runId/workerId/expiry/cancellation) and SHA-256/size verification on load_task_inputs', async () => {
    const clock = { now: 1_760_000_000_000 };
    const { core, storage } = createTestCore(clock);

    const upload = (await core.taskArtifacts({
      kind: 'stage_upload',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840500',
      filename: 'data.csv',
      mediaType: 'text/csv',
      contentBase64: toBase64('a,b\n1,2\n'),
    })) as B3StagedUploadReceiptDto;

    const submitted = (await core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840501',
      input: { prompt: 'Check input fence', attachment_ids: [upload.upload_id] },
    })) as V2PythonTaskSubmitResultDto;
    const taskId = submitted.task.task_id;

    const claim = await core.claimDurableWork({
      envelope: makeTaskEnvelope(taskId, 0),
      workerId: 'worker-owner',
      leaseMs: 10_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') throw new Error('expected claim');
    const runId = (JSON.parse(claim.contextJson) as { runId: string }).runId;

    // Valid fence succeeds.
    const okInputs = (await core.taskArtifacts({
      kind: 'load_task_inputs',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840502',
      taskId,
      runId,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'worker-owner',
    })) as readonly V2TaskInputFileDto[];
    expect(okInputs).toHaveLength(1);
    expect(okInputs[0]?.filename).toBe('data.csv');

    // Wrong workerId rejected.
    await expect(
      core.taskArtifacts({
        kind: 'load_task_inputs',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840503',
        taskId,
        runId,
        leaseEpoch: claim.leaseEpoch,
        workerId: 'wrong-worker',
      }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    // Wrong runId rejected.
    await expect(
      core.taskArtifacts({
        kind: 'load_task_inputs',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840504',
        taskId,
        runId: '018f5f2e-0e91-7a30-ae62-bcb97d840599',
        leaseEpoch: claim.leaseEpoch,
        workerId: 'worker-owner',
      }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    // Corrupted input content fails closed with DB_UNAVAILABLE.
    storage.sql.exec(
      `UPDATE v2_task_artifacts SET content_b64 = ? WHERE id = ?`,
      toBase64('a,b\n9,9\n'),
      upload.upload_id,
    );
    await expect(
      core.taskArtifacts({
        kind: 'load_task_inputs',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840505',
        taskId,
        runId,
        leaseEpoch: claim.leaseEpoch,
        workerId: 'worker-owner',
      }),
    ).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });

    // Expired lease rejected.
    clock.now += 15_000;
    await expect(
      core.taskArtifacts({
        kind: 'load_task_inputs',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840506',
        taskId,
        runId,
        leaseEpoch: claim.leaseEpoch,
        workerId: 'worker-owner',
      }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    // Cancelled task rejected even within lease window.
    clock.now -= 10_000;
    await core.taskArtifacts({
      kind: 'cancel_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840507',
      taskId,
    });
    await expect(
      core.taskArtifacts({
        kind: 'load_task_inputs',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840508',
        taskId,
        runId,
        leaseEpoch: claim.leaseEpoch,
        workerId: 'worker-owner',
      }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });
  });

  it('P2-4: advances list_tasks cursor stably across same-timestamp ties and status filters', async () => {
    const clock = { now: 1_760_000_000_000 };
    const { core } = createTestCore(clock);

    // Create 2 tasks at t0, 2 tasks at t0 + 1000 (testing same-timestamp tie-break).
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      if (i === 2) clock.now += 1_000;
      const res = (await core.taskArtifacts({
        kind: 'submit_python_task',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: `018f5f2e-0e91-7a30-ae62-bcb97d84060${i}`,
        input: { title: `Task ${i}`, prompt: `Prompt ${i}` },
      })) as V2PythonTaskSubmitResultDto;
      ids.push(res.task.task_id);
    }

    // Cancel one of the tasks to verify status filter + pagination.
    await core.taskArtifacts({
      kind: 'cancel_task',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840610',
      taskId: ids[1]!,
    });

    const page1 = (await core.taskArtifacts({
      kind: 'list_tasks',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840611',
      limit: 2,
    })) as B1TaskListDto;
    expect(page1.tasks).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_after).not.toBeNull();

    const page2 = (await core.taskArtifacts({
      kind: 'list_tasks',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840612',
      limit: 2,
      after: page1.next_after!,
    })) as B1TaskListDto;
    expect(page2.tasks).toHaveLength(2);
    expect(page2.has_more).toBe(false);
    expect(page2.next_after).toBeNull();

    const allPagedIds = [...page1.tasks, ...page2.tasks].map((t) => t.task_id);
    expect(new Set(allPagedIds).size).toBe(4);
    expect(new Set(allPagedIds)).toEqual(new Set(ids));

    // Status filter + cursor pagination over the 3 queued tasks.
    const qPage1 = (await core.taskArtifacts({
      kind: 'list_tasks',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840613',
      status: 'queued',
      limit: 2,
    })) as B1TaskListDto;
    expect(qPage1.tasks).toHaveLength(2);
    expect(qPage1.has_more).toBe(true);
    const qPage2 = (await core.taskArtifacts({
      kind: 'list_tasks',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_A,
      agentId: AGENT_ID,
      requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840614',
      status: 'queued',
      limit: 2,
      after: qPage1.next_after!,
    })) as B1TaskListDto;
    expect(qPage2.tasks).toHaveLength(1);
    expect(qPage2.has_more).toBe(false);
    expect([...qPage1.tasks, ...qPage2.tasks].every((t) => t.status === 'queued')).toBe(true);

    // Malformed cursor fails closed with INVALID_ARGUMENT.
    await expect(
      core.taskArtifacts({
        kind: 'list_tasks',
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_A,
        agentId: AGENT_ID,
        requestId: '018f5f2e-0e91-7a30-ae62-bcb97d840615',
        after: 'not-a-valid-cursor!!!',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('upgrades existing v1–v7 DO storage with data cleanly to v8 preserving checksums and existing rows', () => {
    const storage = createInMemoryDoStorage();
    const allMigrations = createDefaultAgentHeadMigrations();
    const v1ToV7 = allMigrations.filter((m) => m.version <= 7);
    const upToV8 = allMigrations.filter((m) => m.version <= 8);
    expect(v1ToV7.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(upToV8.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const first = applyAgentHeadMigrations(storage, v1ToV7, 1_760_000_000_000);
    expect(first.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Seed existing v1–v7 data (personal_memories + proactive_schedules).
    storage.sql.exec(
      `INSERT INTO personal_memories (
        id, tenant_id, principal_id, kind, content, provenance_source, created_at_ms, updated_at_ms
      ) VALUES ('mem-1', ?, ?, 'preference', 'Prefer concise answers', 'user_settings', 1000, 1000)`,
      TENANT_ID,
      PRINCIPAL_A,
    );
    storage.sql.exec(
      `INSERT INTO v2_schedules (
        schedule_id, tenant_id, agent_id, source_kind, source_id, schedule_kind,
        timezone, next_fire_at_ms, misfire_policy, status, version, created_at_ms, updated_at_ms
      ) VALUES ('sched-1', ?, ?, 'reminder', 'r1', 'once', 'UTC', 2000, 'coalesce_latest', 'active', 1, 1000, 1000)`,
      TENANT_ID,
      AGENT_ID,
    );
    storage.sql.exec(
      `INSERT INTO proactive_schedules (
        schedule_id, principal_id, idempotency_key, kind, title, prompt,
        delivery_mode, digest, created_at_ms, updated_at_ms
      ) VALUES ('sched-1', ?, 'idem-1', 'reminder', 'Morning Brief', 'Summarize today',
        'direct_reminder', 'dig-1', 1000, 1000)`,
      PRINCIPAL_A,
    );

    // Upgrade to v8: v1–v7 must be alreadyApplied with matching checksums; only v8 applies.
    const upgraded = applyAgentHeadMigrations(storage, upToV8, 1_760_000_010_000);
    expect(upgraded.alreadyAppliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(upgraded.appliedVersions).toEqual([8]);

    // Existing rows survive intact and v2_task_artifacts table exists.
    expect(
      storage.sql
        .exec<{ readonly cnt: number }>('SELECT COUNT(*) AS cnt FROM personal_memories')
        .one().cnt,
    ).toBe(1);
    expect(
      storage.sql
        .exec<{ readonly cnt: number }>('SELECT COUNT(*) AS cnt FROM proactive_schedules')
        .one().cnt,
    ).toBe(1);
    expect(
      storage.sql
        .exec<{ readonly cnt: number }>('SELECT COUNT(*) AS cnt FROM v2_task_artifacts')
        .one().cnt,
    ).toBe(0);
  });
});
