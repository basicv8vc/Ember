import { DomainError } from '@ember/domain';
import {
  proactiveScheduleCreateSchema,
  proactiveScheduleIdSchema,
  type ProactiveScheduleCommand,
  type ProactiveScheduleResponse,
} from '@ember/runtime-v2';
import { Hono, type MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { readBoundedBodyBytes, readJsonBody } from '../http/bounded-body.js';

const MAX_SCHEDULE_REQUEST_BYTES = 16 * 1024;

type ProactiveScheduleRouteCommand<T = ProactiveScheduleCommand> =
  T extends ProactiveScheduleCommand
    ? Omit<T, 'tenantId' | 'principalId' | 'agentId' | 'requestId'>
    : never;

async function parseBody<S extends z.ZodType>(c: AppContext, schema: S): Promise<z.output<S>> {
  const body = await readJsonBody(c.req.raw, MAX_SCHEDULE_REQUEST_BYTES);
  const parsed = body.ok ? schema.safeParse(body.value) : undefined;
  if (!parsed?.success) throw new DomainError('INVALID_ARGUMENT', 'invalid schedule request');
  return parsed.data;
}

async function requireEmptyBody(c: AppContext): Promise<void> {
  const body = await readBoundedBodyBytes(c.req.raw, 0);
  if (body.ok || body.reason !== 'empty_body') throw new DomainError('INVALID_ARGUMENT');
}

function readScheduleId(value: string | undefined): string {
  const id = proactiveScheduleIdSchema.safeParse(value);
  if (!id.success) throw new DomainError('INVALID_ARGUMENT', 'invalid schedule ID');
  return id.data;
}

export function createProactiveScheduleRoutes(
  authenticate: MiddlewareHandler<AppBindings>,
  run: (command: ProactiveScheduleRouteCommand) => Promise<ProactiveScheduleResponse>,
) {
  const routes = new Hono<AppBindings>();
  const validateQuery: MiddlewareHandler<AppBindings> = async (c, next) => {
    if (new URL(c.req.url).searchParams.size > 0) throw new DomainError('INVALID_ARGUMENT');
    await next();
  };

  routes.use('/schedules', authenticate, validateQuery);
  routes.use('/schedules/*', authenticate, validateQuery);

  routes.post('/schedules', async (c) => {
    const input = await parseBody(c, proactiveScheduleCreateSchema);
    const result = await run({ kind: 'create', input });
    return c.json(result, 'replayed' in result && result.replayed === false ? 201 : 200);
  });

  routes.get('/schedules', async (c) => {
    await requireEmptyBody(c);
    return c.json(await run({ kind: 'list' }));
  });

  routes.get('/schedules/:scheduleId', async (c) => {
    await requireEmptyBody(c);
    return c.json(
      await run({ kind: 'get', scheduleId: readScheduleId(c.req.param('scheduleId')) }),
    );
  });

  routes.post('/schedules/:scheduleId/pause', async (c) => {
    await requireEmptyBody(c);
    return c.json(
      await run({ kind: 'pause', scheduleId: readScheduleId(c.req.param('scheduleId')) }),
    );
  });

  routes.post('/schedules/:scheduleId/resume', async (c) => {
    await requireEmptyBody(c);
    return c.json(
      await run({ kind: 'resume', scheduleId: readScheduleId(c.req.param('scheduleId')) }),
    );
  });

  routes.post('/schedules/:scheduleId/cancel', async (c) => {
    await requireEmptyBody(c);
    return c.json(
      await run({ kind: 'cancel', scheduleId: readScheduleId(c.req.param('scheduleId')) }),
    );
  });

  return routes;
}
