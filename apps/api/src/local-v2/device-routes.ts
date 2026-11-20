import { DomainError } from '@ember/domain';
import {
  deviceClaimSchema,
  deviceDispatchSchema,
  deviceIdSchema,
  deviceRegistrationSchema,
  deviceRenewSchema,
  deviceResultSchema,
  type DeviceExecutionCommand,
  type DeviceExecutionResponse,
} from '@ember/runtime-v2';
import { Hono, type MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { readBoundedBodyBytes, readJsonBody } from '../http/bounded-body.js';

const MAX_DEVICE_REQUEST_BYTES = 32 * 1024;

type DeviceRouteCommand<T = DeviceExecutionCommand> = T extends DeviceExecutionCommand
  ? Omit<T, 'tenantId' | 'principalId' | 'agentId' | 'requestId'>
  : never;

async function parseBody<S extends z.ZodType>(c: AppContext, schema: S): Promise<z.output<S>> {
  const body = await readJsonBody(c.req.raw, MAX_DEVICE_REQUEST_BYTES);
  const parsed = body.ok ? schema.safeParse(body.value) : undefined;
  if (!parsed?.success) throw new DomainError('INVALID_ARGUMENT', 'invalid device request');
  return parsed.data;
}

async function requireEmptyBody(c: AppContext): Promise<void> {
  const body = await readBoundedBodyBytes(c.req.raw, 0);
  if (body.ok || body.reason !== 'empty_body') throw new DomainError('INVALID_ARGUMENT');
}

function readId(value: string | undefined): string {
  const id = deviceIdSchema.safeParse(value);
  if (!id.success) throw new DomainError('INVALID_ARGUMENT', 'invalid device or task ID');
  return id.data;
}

async function deviceIdentity(c: AppContext) {
  const deviceId = readId(c.req.param('deviceId'));
  const token = c.req.header('X-Device-Token');
  if (token === undefined || !/^[0-9a-f]{64}$/.test(token)) {
    throw new DomainError('POLICY_DENIED', 'device credential required');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const tokenDigest = Buffer.from(digest).toString('hex');
  return { deviceId, tokenDigest };
}

export function createDeviceRoutes(
  authenticate: MiddlewareHandler<AppBindings>,
  run: (command: DeviceRouteCommand) => Promise<DeviceExecutionResponse>,
) {
  const routes = new Hono<AppBindings>();
  const validateQuery: MiddlewareHandler<AppBindings> = async (c, next) => {
    if (new URL(c.req.url).searchParams.size > 0) throw new DomainError('INVALID_ARGUMENT');
    await next();
  };
  routes.use('/devices/*', authenticate, validateQuery);
  routes.use('/device-tasks', authenticate, validateQuery);
  routes.use('/device-tasks/*', authenticate, validateQuery);
  routes.post('/devices/:deviceId/register', async (c) =>
    c.json(
      await run({
        kind: 'register',
        ...(await deviceIdentity(c)),
        ...(await parseBody(c, deviceRegistrationSchema)),
      }),
    ),
  );
  routes.post('/devices/:deviceId/revoke', async (c) => {
    await requireEmptyBody(c);
    return c.json(await run({ kind: 'revoke', deviceId: readId(c.req.param('deviceId')) }));
  });
  routes.post('/device-tasks', async (c) => {
    const result = await run({ kind: 'dispatch', ...(await parseBody(c, deviceDispatchSchema)) });
    return c.json(result, 'replayed' in result && result.replayed === false ? 201 : 200);
  });
  routes.get('/device-tasks/:taskId', async (c) => {
    await requireEmptyBody(c);
    return c.json(await run({ kind: 'status', taskId: readId(c.req.param('taskId')) }));
  });
  routes.post('/device-tasks/:taskId/cancel', async (c) => {
    await requireEmptyBody(c);
    return c.json(await run({ kind: 'cancel', taskId: readId(c.req.param('taskId')) }));
  });
  routes.post('/devices/:deviceId/claim', async (c) => {
    await parseBody(c, deviceClaimSchema);
    return c.json(await run({ kind: 'claim', ...(await deviceIdentity(c)) }));
  });
  routes.post('/devices/:deviceId/tasks/:taskId/renew', async (c) => {
    const result = await run({
      kind: 'renew',
      taskId: readId(c.req.param('taskId')),
      ...(await deviceIdentity(c)),
      ...(await parseBody(c, deviceRenewSchema)),
    });
    return c.json(result, 'kind' in result && result.kind === 'fenced' ? 409 : 200);
  });
  routes.post('/devices/:deviceId/tasks/:taskId/result', async (c) => {
    const result = await run({
      kind: 'result',
      taskId: readId(c.req.param('taskId')),
      ...(await deviceIdentity(c)),
      ...(await parseBody(c, deviceResultSchema)),
    });
    return c.json(result, 'kind' in result && result.kind === 'fenced' ? 409 : 200);
  });
  return routes;
}
