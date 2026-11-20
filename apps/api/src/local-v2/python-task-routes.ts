import { DomainError } from '@ember/domain';
import {
  submitPythonTaskRequestSchema,
  v2TaskIdSchema,
  type TaskArtifactCommand,
  type V2PythonTaskSubmitResultDto,
} from '@ember/runtime-v2';
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppBindings } from '../http/app-context.js';
import { readJsonBody } from '../http/bounded-body.js';

const MAX_PYTHON_TASK_REQUEST_BYTES = 32 * 1024;

type PythonTaskSubmitCommand = Omit<
  Extract<TaskArtifactCommand, { kind: 'submit_python_task' }>,
  'tenantId' | 'principalId' | 'agentId' | 'requestId'
>;

export function createPythonTaskRoutes(
  authenticate: MiddlewareHandler<AppBindings>,
  run: (command: PythonTaskSubmitCommand) => Promise<V2PythonTaskSubmitResultDto>,
) {
  const routes = new Hono<AppBindings>();

  routes.use('/tasks/python', authenticate, async (c, next) => {
    if (new URL(c.req.url).searchParams.size > 0) {
      throw new DomainError('INVALID_ARGUMENT', 'unexpected query parameters');
    }
    await next();
  });

  routes.post('/tasks/python', async (c) => {
    const rawIdempotencyKey = c.req.header('idempotency-key');
    let headerClientRequestId: string | undefined;
    if (rawIdempotencyKey !== undefined) {
      const parsedHeader = v2TaskIdSchema.safeParse(rawIdempotencyKey.trim());
      if (!parsedHeader.success) {
        throw new DomainError('INVALID_ARGUMENT', 'invalid idempotency-key header');
      }
      headerClientRequestId = parsedHeader.data;
    }

    const body = await readJsonBody(c.req.raw, MAX_PYTHON_TASK_REQUEST_BYTES);
    const parsed = body.ok ? submitPythonTaskRequestSchema.safeParse(body.value) : undefined;
    if (!parsed?.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid python task request');
    }

    if (
      headerClientRequestId !== undefined &&
      parsed.data.client_request_id !== undefined &&
      headerClientRequestId !== parsed.data.client_request_id
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'idempotency-key header does not match client_request_id',
      );
    }

    const clientRequestId = parsed.data.client_request_id ?? headerClientRequestId;
    const input =
      clientRequestId === undefined
        ? parsed.data
        : { ...parsed.data, client_request_id: clientRequestId };
    const result = await run({ kind: 'submit_python_task', input });
    return c.json(result, result.created ? 201 : 200);
  });

  return routes;
}
