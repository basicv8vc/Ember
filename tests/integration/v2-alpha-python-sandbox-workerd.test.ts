import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  B1ConversationPageSchema,
  B1MeResponseSchema,
  B1SessionResponseSchema,
  B1TaskCancelDtoSchema,
  B1TaskDetailDtoSchema,
  B1TaskEventPageDtoSchema,
  B1TaskListDtoSchema,
  B1TaskResultDtoSchema,
  B3StagedUploadReceiptDtoSchema,
  B3TaskArtifactsListDtoSchema,
} from '@ember/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V2LocalRuntimeHarness } from '../../apps/benchmark/src/v2-m1/index.js';

const configPath = fileURLToPath(
  new URL('../../apps/api/wrangler.local-v2.jsonc', import.meta.url),
);

const SALES_CSV = ['region,revenue,units', 'north,120.50,10', 'south,79.50,5', 'west,200,15'].join(
  '\n',
);

async function signIn(harness: V2LocalRuntimeHarness, assertion: string): Promise<string> {
  const response = await harness.fetchOverHttp('/v1/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'dev',
      identity_token: assertion,
      nonce: `nonce-${randomUUID()}`,
    }),
  });
  expect(response.status).toBe(201);
  return B1SessionResponseSchema.parse(await response.json()).access_token;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('V2 Tools & Execution: Python Sandbox & Artifact Delivery in workerd', () => {
  let harness: V2LocalRuntimeHarness;

  beforeEach(async () => {
    harness = await V2LocalRuntimeHarness.start({ target: { kind: 'ab_runtime', configPath } });
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  it('uploads CSV, executes python.agent in V2 queue worker, serves progress events and downloadable artifact, and enforces tenant isolation', async () => {
    const tokenA = await signIn(harness, `v2-alpha-f-a-${randomUUID()}`);
    const tokenB = await signIn(harness, `v2-alpha-f-b-${randomUUID()}`);

    const meRes = await harness.fetchOverHttp('/v1/me', { headers: authHeaders(tokenA) });
    expect(meRes.status).toBe(200);
    const me = B1MeResponseSchema.parse(await meRes.json());

    // 1. Upload bounded CSV dataset via B3-compatible /v1/me/uploads.
    const uploadRes = await harness.fetchOverHttp('/v1/me/uploads', {
      method: 'POST',
      headers: { ...authHeaders(tokenA), 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'sales.csv',
        media_type: 'text/csv',
        content: SALES_CSV,
      }),
    });
    expect(uploadRes.status).toBe(201);
    const upload = B3StagedUploadReceiptDtoSchema.parse(await uploadRes.json());

    // 2. Submit V2 python.agent task with idempotency key.
    const reqId = randomUUID();
    const submitBody = JSON.stringify({
      title: 'Analyze sales.csv',
      prompt: 'Summarize sales.csv numeric columns\n# output: sales-report.csv',
      attachment_ids: [upload.upload_id],
    });
    const submitRes = await harness.fetchOverHttp('/v2/tasks/python', {
      method: 'POST',
      headers: {
        ...authHeaders(tokenA),
        'content-type': 'application/json',
        'idempotency-key': reqId,
      },
      body: submitBody,
    });
    expect(submitRes.status).toBe(201);
    const submitted = (await submitRes.json()) as {
      readonly task: ReturnType<typeof B1TaskDetailDtoSchema.parse>;
      readonly created: boolean;
    };
    const taskId = B1TaskDetailDtoSchema.parse(submitted.task).task_id;
    expect(submitted.created).toBe(true);

    // Idempotent replay returns 200 with the same task_id.
    const replayRes = await harness.fetchOverHttp('/v2/tasks/python', {
      method: 'POST',
      headers: {
        ...authHeaders(tokenA),
        'content-type': 'application/json',
        'idempotency-key': reqId,
      },
      body: submitBody,
    });
    expect(replayRes.status).toBe(200);

    // 3. Verify task_reference card appears in the conversation transcript.
    const pageRes = await harness.fetchOverHttp(
      `/v1/conversations/${me.conversation.conversation_id}/messages`,
      { headers: authHeaders(tokenA) },
    );
    expect(pageRes.status).toBe(200);
    const page = B1ConversationPageSchema.parse(await pageRes.json());
    expect(page.messages.some((m) => m.kind === 'task_reference' && m.task_id === taskId)).toBe(
      true,
    );

    // 4. Wait for V2 AGENT_TASK_QUEUE worker to complete the bounded sandbox run.
    let finalDetail: ReturnType<typeof B1TaskDetailDtoSchema.parse> | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const detailRes = await harness.fetchOverHttp(`/v1/me/tasks/${taskId}`, {
        headers: authHeaders(tokenA),
      });
      expect(detailRes.status).toBe(200);
      finalDetail = B1TaskDetailDtoSchema.parse(await detailRes.json());
      if (finalDetail.status === 'completed') break;
      await setTimeout(100);
    }
    expect(finalDetail?.status).toBe('completed');
    expect(finalDetail?.kind).toBe('python.agent');

    // 5. Verify B1 task list, events, and result endpoints.
    const listRes = await harness.fetchOverHttp('/v1/me/tasks?status=completed', {
      headers: authHeaders(tokenA),
    });
    expect(listRes.status).toBe(200);
    expect(
      B1TaskListDtoSchema.parse(await listRes.json()).tasks.some((t) => t.task_id === taskId),
    ).toBe(true);

    const eventsRes = await harness.fetchOverHttp(`/v1/me/tasks/${taskId}/events`, {
      headers: authHeaders(tokenA),
    });
    expect(eventsRes.status).toBe(200);
    const phases = B1TaskEventPageDtoSchema.parse(await eventsRes.json()).events.map(
      (e) => e.phase,
    );
    expect(phases).toContain('accepted');
    expect(phases).toContain('leased');
    expect(phases).toContain('progress');
    expect(phases).toContain('completed');

    const resultRes = await harness.fetchOverHttp(`/v1/me/tasks/${taskId}/result`, {
      headers: authHeaders(tokenA),
    });
    expect(resultRes.status).toBe(200);
    const taskResult = B1TaskResultDtoSchema.parse(await resultRes.json());
    expect(taskResult.result_state).toBe('available');
    if (taskResult.result_state === 'available') {
      expect(taskResult.result.summary_text).toContain('sales.csv');
      expect(taskResult.result.simulated).toBe(true);
    }

    // 6. List task artifacts & download the generated CSV artifact with strict security headers.
    const artifactsRes = await harness.fetchOverHttp(`/v1/me/tasks/${taskId}/artifacts`, {
      headers: authHeaders(tokenA),
    });
    expect(artifactsRes.status).toBe(200);
    const artifacts = B3TaskArtifactsListDtoSchema.parse(await artifactsRes.json()).artifacts;
    const outputArtifact = artifacts.find(
      (a) => a.created_by === 'run' && a.filename === 'sales-report.csv',
    );
    expect(outputArtifact).toBeDefined();

    const downloadRes = await harness.fetchOverHttp(
      `/v1/me/artifacts/${outputArtifact!.artifact_id}`,
      { headers: authHeaders(tokenA) },
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-type')).toBe('text/csv');
    expect(downloadRes.headers.get('content-disposition')).toBe(
      'attachment; filename="sales-report.csv"',
    );
    expect(downloadRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(downloadRes.headers.get('cache-control')).toBe('private, no-store');
    const csvBody = await downloadRes.text();
    expect(csvBody).toContain('source_file,column,count,sum,min,max,mean');
    expect(csvBody).toContain('sales.csv,revenue,3,400,79.50,200,133.33');
    expect(csvBody).toContain('sales.csv,units,3,30,5,15,10');
    expect(createHash('sha256').update(Buffer.from(csvBody, 'utf-8')).digest('hex')).toBe(
      outputArtifact!.sha256,
    );

    // 7. Cross-tenant isolation: Tenant B receives 404 on every Task & Artifact route.
    for (const path of [
      `/v1/me/tasks/${taskId}`,
      `/v1/me/tasks/${taskId}/events`,
      `/v1/me/tasks/${taskId}/result`,
      `/v1/me/tasks/${taskId}/artifacts`,
      `/v1/me/artifacts/${outputArtifact!.artifact_id}`,
    ]) {
      const forbidden = await harness.fetchOverHttp(path, { headers: authHeaders(tokenB) });
      expect(forbidden.status).toBe(404);
    }

    // 8. Cancel endpoint works cleanly on terminal task (returns terminal=true, status='completed').
    const cancelRes = await harness.fetchOverHttp(`/v1/me/tasks/${taskId}/cancel`, {
      method: 'POST',
      headers: authHeaders(tokenA),
    });
    expect(cancelRes.status).toBe(200);
    const cancelled = B1TaskCancelDtoSchema.parse(await cancelRes.json());
    expect(cancelled.terminal).toBe(true);
  });

  it('connects chat upload -> natural-language delegate_python_agent -> durable queue -> downloadable SHA-256 artifact', async () => {
    const token = await signIn(harness, `v2-alpha-f-nl-${randomUUID()}`);
    const meRes = await harness.fetchOverHttp('/v1/me', { headers: authHeaders(token) });
    expect(meRes.status).toBe(200);
    const me = B1MeResponseSchema.parse(await meRes.json());
    const conversationId = me.conversation.conversation_id;

    // 1. Stage CSV upload for chat attachment.
    const uploadRes = await harness.fetchOverHttp('/v1/me/uploads', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'nl-sales.csv',
        media_type: 'text/csv',
        content: SALES_CSV,
      }),
    });
    expect(uploadRes.status).toBe(201);
    const upload = B3StagedUploadReceiptDtoSchema.parse(await uploadRes.json());

    // 2. Script the loopback gateway to emit a delegate_python_agent tool delegation without
    //    manually specifying attachmentIds — runtime turn-commit binds the message's upload.
    harness.fakeGateway.enqueueRules({
      mode: 'fast_ok',
      replyText: 'I have started a Python analysis task for your uploaded CSV.',
      delegation: {
        toolName: 'delegate_python_agent',
        arguments: {
          title: 'NL Sales Summary',
          prompt: 'Analyze nl-sales.csv\n# output: nl-summary.csv',
        },
      },
    });

    // 3. Send natural-language chat message with attachment_ids (B1 durable path -> DO commitTurn).
    const msgRes = await harness.fetchOverHttp(`/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        client_submission_id: randomUUID(),
        text: 'Please analyze the attached CSV and produce a summary table.',
        transcript_epoch: me.conversation.transcript_epoch,
        attachment_ids: [upload.upload_id],
      }),
    });
    expect(msgRes.status).toBe(201);

    // 4. Locate the delegated python.agent task created for this principal and wait for completion.
    let delegatedTaskId: string | undefined;
    let completed = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const listRes = await harness.fetchOverHttp('/v1/me/tasks', {
        headers: authHeaders(token),
      });
      expect(listRes.status).toBe(200);
      const tasks = B1TaskListDtoSchema.parse(await listRes.json()).tasks;
      const pyTask = tasks.find((t) => t.kind === 'python.agent');
      if (pyTask) {
        delegatedTaskId = pyTask.task_id;
        if (pyTask.status === 'completed') {
          completed = true;
          break;
        }
      }
      await setTimeout(100);
    }
    expect(delegatedTaskId).toBeDefined();
    expect(completed).toBe(true);

    // 5. Transcript contains a task_reference card pointing to the delegated task.
    const pageRes = await harness.fetchOverHttp(`/v1/conversations/${conversationId}/messages`, {
      headers: authHeaders(token),
    });
    expect(pageRes.status).toBe(200);
    const page = B1ConversationPageSchema.parse(await pageRes.json());
    expect(
      page.messages.some((m) => m.kind === 'task_reference' && m.task_id === delegatedTaskId),
    ).toBe(true);

    // 6. Both uploaded input and generated output artifact are accessible and SHA-256 verified.
    const artifactsRes = await harness.fetchOverHttp(`/v1/me/tasks/${delegatedTaskId}/artifacts`, {
      headers: authHeaders(token),
    });
    expect(artifactsRes.status).toBe(200);
    const artifacts = B3TaskArtifactsListDtoSchema.parse(await artifactsRes.json()).artifacts;
    const inputArtifact = artifacts.find(
      (a) => a.created_by === 'user' && a.filename === 'nl-sales.csv',
    );
    const outputArtifact = artifacts.find(
      (a) => a.created_by === 'run' && a.filename === 'nl-summary.csv',
    );
    expect(inputArtifact).toBeDefined();
    expect(outputArtifact).toBeDefined();

    const downloadRes = await harness.fetchOverHttp(
      `/v1/me/artifacts/${outputArtifact!.artifact_id}`,
      { headers: authHeaders(token) },
    );
    expect(downloadRes.status).toBe(200);
    const csvBody = await downloadRes.text();
    expect(csvBody).toContain('nl-sales.csv,revenue,3,400,79.50,200,133.33');
    expect(createHash('sha256').update(Buffer.from(csvBody, 'utf-8')).digest('hex')).toBe(
      outputArtifact!.sha256,
    );
  });
});
