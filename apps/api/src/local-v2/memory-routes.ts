import { DomainError } from '@ember/domain';
import {
  personalMemoryIdSchema,
  savePersonalMemoryRequestSchema,
  type PersonalMemoryCommand,
  type PersonalMemoryResponse,
} from '@ember/runtime-v2';
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { readBoundedBodyBytes, readJsonBody } from '../http/bounded-body.js';

const MAX_MEMORY_REQUEST_BYTES = 8 * 1024;

type MemoryRouteCommand<T = PersonalMemoryCommand> = T extends PersonalMemoryCommand
  ? Omit<T, 'tenantId' | 'principalId' | 'agentId' | 'requestId'>
  : never;

async function requireEmptyBody(c: AppContext): Promise<void> {
  const body = await readBoundedBodyBytes(c.req.raw, 0);
  if (body.ok || body.reason !== 'empty_body') {
    throw new DomainError('INVALID_ARGUMENT', 'request body must be empty');
  }
}

function readMemoryId(value: string | undefined): string {
  const parsed = personalMemoryIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError('INVALID_ARGUMENT', 'invalid personal memory id');
  }
  return parsed.data;
}

export function createMemoryRoutes(
  authenticate: MiddlewareHandler<AppBindings>,
  run: (command: MemoryRouteCommand) => Promise<PersonalMemoryResponse>,
) {
  const routes = new Hono<AppBindings>();
  const validateQuery: MiddlewareHandler<AppBindings> = async (c, next) => {
    if (new URL(c.req.url).searchParams.size > 0) {
      throw new DomainError('INVALID_ARGUMENT', 'unexpected query parameters');
    }
    await next();
  };

  routes.use('/memories', authenticate, validateQuery);
  routes.use('/memories/*', authenticate, validateQuery);

  routes.get('/memories', async (c) => {
    await requireEmptyBody(c);
    return c.json(await run({ kind: 'list' }));
  });

  routes.post('/memories', async (c) => {
    const body = await readJsonBody(c.req.raw, MAX_MEMORY_REQUEST_BYTES);
    const parsed = body.ok ? savePersonalMemoryRequestSchema.safeParse(body.value) : undefined;
    if (!parsed?.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid personal memory request');
    }
    const result = await run({ kind: 'save', input: parsed.data });
    return c.json(result, 'created' in result && result.created ? 201 : 200);
  });

  routes.delete('/memories/:memoryId', async (c) => {
    await requireEmptyBody(c);
    return c.json(await run({ kind: 'delete', memoryId: readMemoryId(c.req.param('memoryId')) }));
  });

  return routes;
}
