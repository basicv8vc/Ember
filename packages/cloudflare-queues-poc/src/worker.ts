import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  parseDispatchEnvelope,
  queueRetryDelaySeconds,
  workflowInstanceId,
  type TaskDispatchEnvelope,
} from './dispatch.js';

interface PocTaskRecord {
  readonly tenantId: string;
  readonly status: 'queued' | 'running' | 'completed' | 'cancelled';
  readonly cancelRequested: boolean;
  readonly attempt: number;
}

interface Env {
  readonly TASK_QUEUE: Queue<TaskDispatchEnvelope>;
  readonly TASK_WORKFLOW: Workflow<TaskDispatchEnvelope>;
  /** Local-only stand-in for the PostgreSQL execution boundary; never use in production. */
  readonly POC_STATE: KVNamespace;
}

interface QueueMessageLike {
  readonly id: string;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

interface QueueBatchLike {
  readonly queue: string;
  readonly messages: readonly QueueMessageLike[];
}

function isAlreadyExists(code: number): boolean {
  return code === 10405;
}

export class TaskWorkflow extends WorkflowEntrypoint<Env, TaskDispatchEnvelope> {
  async run(event: WorkflowEvent<TaskDispatchEnvelope>, step: WorkflowStep): Promise<unknown> {
    const dispatch = parseDispatchEnvelope(event.payload);
    if (dispatch === null) {
      throw new TypeError('invalid task dispatch envelope');
    }

    const claim = await step.do('claim-current-lease', async () => {
      const key = `task:${dispatch.taskId}`;
      const task = await this.env.POC_STATE.get<PocTaskRecord>(key, 'json');

      // The fake record is tenant-scoped to prove the envelope is not authority. A real
      // implementation must replace this branch with the PostgreSQL lease API.
      if (task === null || task.tenantId !== dispatch.tenantId) {
        return { disposition: 'not-owned' as const };
      }
      if (task.cancelRequested || task.status === 'cancelled') {
        return { disposition: 'cancelled' as const };
      }
      if (task.status !== 'queued') {
        return { disposition: 'already-claimed-or-terminal' as const };
      }

      await this.env.POC_STATE.put(
        key,
        JSON.stringify({ ...task, status: 'running', attempt: task.attempt + 1 }),
      );
      return { disposition: 'claimed' as const, attempt: task.attempt + 1 };
    });

    if (claim.disposition !== 'claimed') {
      return claim;
    }

    const execution = await step.do(
      'commit-idempotent-effect',
      {
        retries: { limit: 2, delay: '1 second', backoff: 'exponential' },
        timeout: '30 seconds',
      },
      async () => {
        const task = await this.env.POC_STATE.get<PocTaskRecord>(`task:${dispatch.taskId}`, 'json');
        if (task === null || task.tenantId !== dispatch.tenantId) {
          throw new Error('lease owner changed');
        }
        if (task.cancelRequested || task.status === 'cancelled') {
          return { disposition: 'cancelled' as const };
        }

        const effectKey = `effect:${dispatch.tenantId}:${dispatch.taskId}:result-v1`;
        const existed = (await this.env.POC_STATE.get(effectKey)) !== null;
        if (!existed) {
          // This deterministic KV write is only a fake side effect. Real effects must use
          // the Task/Run + leaseEpoch-aware PostgreSQL checkpoint/result transaction.
          await this.env.POC_STATE.put(effectKey, JSON.stringify({ eventId: dispatch.eventId }));
        }

        await this.recordAttempt(dispatch.eventId);
        if (await this.consumeFailpoint(`fault:after-effect:${dispatch.eventId}`)) {
          throw new Error('simulated crash after effect before step commit');
        }

        return { disposition: 'effect-committed' as const, duplicate: existed, effectKey };
      },
    );

    await step.do('finish-current-lease', async () => {
      const key = `task:${dispatch.taskId}`;
      const task = await this.env.POC_STATE.get<PocTaskRecord>(key, 'json');
      if (task === null || task.tenantId !== dispatch.tenantId) {
        throw new Error('lease owner changed before finish');
      }
      if (task.cancelRequested || task.status === 'cancelled') {
        await this.env.POC_STATE.put(key, JSON.stringify({ ...task, status: 'cancelled' }));
        return { status: 'cancelled' as const };
      }

      await this.env.POC_STATE.put(key, JSON.stringify({ ...task, status: 'completed' }));
      return { status: 'completed' as const };
    });

    return { disposition: 'finished', execution };
  }

  private async recordAttempt(eventId: string): Promise<void> {
    const key = `attempts:${eventId}`;
    const current = Number((await this.env.POC_STATE.get(key)) ?? '0');
    await this.env.POC_STATE.put(key, String(current + 1));
  }

  private async consumeFailpoint(key: string): Promise<boolean> {
    if ((await this.env.POC_STATE.get(key)) !== 'once') {
      return false;
    }

    await this.env.POC_STATE.delete(key);
    return true;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // This endpoint exists only to exercise the producer path under local Wrangler/Vitest.
    // Deployment is intentionally disabled in wrangler.jsonc.
    if (new URL(request.url).pathname !== '/_poc/dispatch' || request.method !== 'POST') {
      return new Response('not found', { status: 404 });
    }

    const body: unknown = await request.json().catch(() => null);
    const dispatch = parseDispatchEnvelope(body);
    if (dispatch === null) {
      return Response.json({ error: 'invalid dispatch envelope' }, { status: 400 });
    }

    await env.TASK_QUEUE.send(dispatch);
    return Response.json({ accepted: true, eventId: dispatch.eventId }, { status: 202 });
  },

  async queue(
    batch: MessageBatch<TaskDispatchEnvelope>,
    env: Env,
    _context: ExecutionContext,
  ): Promise<void> {
    if (batch.queue === 'ember-poc-task-dispatch-dlq') {
      for (const message of batch.messages) {
        // Keep only a receipt in this harness. A production DLQ consumer must persist a
        // tenant-scoped operational record and must not copy prompts or payloads to logs.
        await env.POC_STATE.put(
          `dlq:${message.id}`,
          JSON.stringify({ attempts: message.attempts }),
        );
        message.ack();
      }
      return;
    }

    await consumeQueueBatch(batch as unknown as QueueBatchLike, env);
  },
};

async function consumeQueueBatch(batch: QueueBatchLike, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const dispatch = parseDispatchEnvelope(message.body);
    if (dispatch === null) {
      // Do not log the body. Cloudflare's configured retry ceiling routes exhausted
      // deliveries to the DLQ; it does not replace Ember's PostgreSQL terminal state.
      message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts) });
      continue;
    }

    const id = workflowInstanceId(dispatch.eventId);
    const result = await env.TASK_WORKFLOW.createBatch({
      instances: [{ id, params: dispatch }],
    }).catch(() => null);
    if (result === null) {
      // A transient Workflow API failure must redeliver the Queue message. It is safe to
      // retry because the immutable outbox event produces the same Workflow instance ID.
      message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts) });
      continue;
    }
    const created = result.created.some((instance) => instance.id === id);
    const duplicate = result.errors.some((error) => error.id === id && isAlreadyExists(error.code));

    if (created || duplicate) {
      // Queue ACK records only that the Workflow instance exists, not that Ember's Task
      // completed. Workflow retries and PostgreSQL lease/reaper logic own later recovery.
      message.ack();
      continue;
    }

    message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts) });
  }
}
