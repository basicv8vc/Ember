import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  introspectWorkflowInstance,
} from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker.js';
import {
  parseDispatchEnvelope,
  queueRetryDelaySeconds,
  workflowInstanceId,
  type TaskDispatchEnvelope,
} from '../src/dispatch.js';

const UUID_A = '20000000-0000-4000-8000-000000000001';
const UUID_B = '20000000-0000-4000-8000-000000000002';

interface TaskRecord {
  readonly tenantId: string;
  readonly status: 'queued' | 'running' | 'completed' | 'cancelled';
  readonly cancelRequested: boolean;
  readonly attempt: number;
}

function envelope(
  taskId = crypto.randomUUID(),
  tenantId = UUID_A,
  eventId = crypto.randomUUID(),
): TaskDispatchEnvelope {
  return { schemaVersion: 1, eventId, tenantId, taskId };
}

async function seedTask(
  taskId: string,
  tenantId: string,
  overrides: Partial<TaskRecord> = {},
): Promise<void> {
  const record: TaskRecord = {
    tenantId,
    status: 'queued',
    cancelRequested: false,
    attempt: 0,
    ...overrides,
  };
  await env.POC_STATE.put(`task:${taskId}`, JSON.stringify(record));
}

async function deliverQueueMessage(
  payload: unknown,
  options: { readonly id?: string; readonly attempts?: number } = {},
) {
  const batch = createMessageBatch('ember-poc-task-dispatch', [
    {
      id: options.id ?? crypto.randomUUID(),
      timestamp: new Date(),
      body: payload,
      attempts: options.attempts ?? 1,
    },
  ]);
  const context = createExecutionContext();
  await worker.queue(batch as MessageBatch<TaskDispatchEnvelope>, env, context);
  return getQueueResult(batch, context);
}

async function waitFor<T>(read: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

describe('Cloudflare Queues + Workflows local PoC', () => {
  it('publishes through a local Queue, creates one stable Workflow, and ACKs duplicate delivery', async () => {
    const dispatch = envelope();
    const id = workflowInstanceId(dispatch.eventId);
    await seedTask(dispatch.taskId, dispatch.tenantId);

    await using workflow = await introspectWorkflowInstance(env.TASK_WORKFLOW, id);
    const response = await exports.default.fetch(
      new Request('https://poc.invalid/_poc/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dispatch),
      }),
    );

    expect(response.status).toBe(202);
    await workflow.waitForStatus('complete');
    expect(
      await env.POC_STATE.get(`effect:${dispatch.tenantId}:${dispatch.taskId}:result-v1`),
    ).not.toBeNull();

    const duplicate = await deliverQueueMessage(dispatch);
    expect(duplicate.explicitAcks).toHaveLength(1);
    expect(await env.POC_STATE.get(`attempts:${dispatch.eventId}`)).toBe('1');
  });

  it('recovers a crash after an idempotent effect without applying the effect twice', async () => {
    const dispatch = envelope();
    const id = workflowInstanceId(dispatch.eventId);
    const effectKey = `effect:${dispatch.tenantId}:${dispatch.taskId}:result-v1`;
    await seedTask(dispatch.taskId, dispatch.tenantId);
    await env.POC_STATE.put(`fault:after-effect:${dispatch.eventId}`, 'once');

    await using workflow = await introspectWorkflowInstance(env.TASK_WORKFLOW, id);
    await workflow.modify(async (modifier) => modifier.disableRetryDelays());
    await env.TASK_WORKFLOW.create({ id, params: dispatch });
    await workflow.waitForStatus('complete');

    expect(await env.POC_STATE.get(`attempts:${dispatch.eventId}`)).toBe('2');
    expect(await env.POC_STATE.get(effectKey, 'json')).toEqual({ eventId: dispatch.eventId });
    const task = await env.POC_STATE.get<TaskRecord>(`task:${dispatch.taskId}`, 'json');
    expect(task?.status).toBe('completed');
  });

  it('retries a timed-out Workflow step and rejects a cross-tenant dispatch before any effect', async () => {
    const timed = envelope();
    const timedId = workflowInstanceId(timed.eventId);
    const effectKey = `effect:${timed.tenantId}:${timed.taskId}:result-v1`;
    await seedTask(timed.taskId, timed.tenantId);

    await using timedWorkflow = await introspectWorkflowInstance(env.TASK_WORKFLOW, timedId);
    await timedWorkflow.modify(async (modifier) => {
      await modifier.disableRetryDelays();
      await modifier.forceStepTimeout({ name: 'commit-idempotent-effect' }, 1);
    });
    await env.TASK_WORKFLOW.create({ id: timedId, params: timed });
    await timedWorkflow.waitForStatus('complete');
    expect(await env.POC_STATE.get(effectKey)).not.toBeNull();

    const foreignTaskId = crypto.randomUUID();
    const foreign = envelope(foreignTaskId, UUID_A, crypto.randomUUID());
    await seedTask(foreign.taskId, UUID_B);
    const foreignId = workflowInstanceId(foreign.eventId);
    await using foreignWorkflow = await introspectWorkflowInstance(env.TASK_WORKFLOW, foreignId);
    await env.TASK_WORKFLOW.create({ id: foreignId, params: foreign });
    await foreignWorkflow.waitForStatus('complete');

    expect(
      await env.POC_STATE.get(`effect:${foreign.tenantId}:${foreign.taskId}:result-v1`),
    ).toBeNull();
    expect((await env.POC_STATE.get<TaskRecord>(`task:${foreign.taskId}`, 'json'))?.status).toBe(
      'queued',
    );
  });

  it('routes exhausted invalid deliveries to the configured local dead-letter Queue', async () => {
    const malformed = {
      schemaVersion: 1,
      eventId: 'not-a-uuid',
      tenantId: UUID_A,
      taskId: UUID_B,
    };

    await env.TASK_QUEUE.send(malformed as unknown as TaskDispatchEnvelope);
    const receipt = await waitFor(async () => {
      const listed = await env.POC_STATE.list({ prefix: 'dlq:' });
      return listed.keys.length > 0 ? (listed.keys[0]?.name ?? null) : null;
    }, 'dead-letter receipt');
    expect(receipt).toMatch(/^dlq:/);
  });

  it('uses a closed envelope and bounded exponential Queue retry delay', async () => {
    const dispatch = envelope();
    expect(parseDispatchEnvelope(dispatch)).toEqual(dispatch);
    expect(parseDispatchEnvelope({ ...dispatch, prompt: 'must not be queued' })).toBeNull();
    expect(queueRetryDelaySeconds(1)).toBe(1);
    expect(queueRetryDelaySeconds(2)).toBe(2);
    expect(queueRetryDelaySeconds(3)).toBe(4);
    expect(queueRetryDelaySeconds(99)).toBe(300);

    const result = await deliverQueueMessage({ payload: dispatch }, { attempts: 2 });
    expect(result.retryMessages).toHaveLength(1);
  });

  it('does not retry a cancelled Task', async () => {
    const dispatch = envelope();
    const id = workflowInstanceId(dispatch.eventId);
    await seedTask(dispatch.taskId, dispatch.tenantId, { cancelRequested: true });

    await using workflow = await introspectWorkflowInstance(env.TASK_WORKFLOW, id);
    await env.TASK_WORKFLOW.create({ id, params: dispatch });
    await workflow.waitForStatus('complete');
    expect(
      await env.POC_STATE.get(`effect:${dispatch.tenantId}:${dispatch.taskId}:result-v1`),
    ).toBeNull();
  });
});
