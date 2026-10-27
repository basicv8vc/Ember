import { Hono } from 'hono';
import { notConfiguredReadiness, type ReadinessCheck } from './readiness.js';

export const SERVICE_NAME = 'ember-api';

export interface AppDependencies {
  /** Optional so the app can be constructed without a database (unit tests). */
  readonly readiness?: ReadinessCheck;
  readonly serviceVersion?: string;
  readonly now?: () => Date;
}

/**
 * Build the Hono application without binding a socket.
 * The HTTP listener lives in `server.ts` / `index.ts`.
 */
export function createApp(deps: AppDependencies = {}): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());
  const readiness = deps.readiness ?? notConfiguredReadiness;
  const serviceVersion = deps.serviceVersion ?? '0.0.0';

  /**
   * Liveness: the process can serve HTTP. Deliberately independent of PostgreSQL,
   * so a database outage never makes an orchestrator kill a healthy process.
   */
  app.get('/healthz', (c) =>
    c.json(
      {
        status: 'ok',
        service: SERVICE_NAME,
        version: serviceVersion,
        checkedAt: now().toISOString(),
      },
      200,
    ),
  );

  /** Readiness: required dependencies are usable. Distinct from liveness. */
  app.get('/readyz', async (c) => {
    const result = await readiness();
    return c.json(
      {
        status: result.status,
        checks: result.checks,
        checkedAt: now().toISOString(),
      },
      result.status === 'ready' ? 200 : 503,
    );
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

  app.onError((_error, c) => {
    // Never leak stack traces, SQL, or filesystem paths to clients.
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
  });

  return app;
}
