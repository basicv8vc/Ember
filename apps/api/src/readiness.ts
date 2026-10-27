/** Result shape of a readiness probe. Liveness never uses this. */
export interface ReadinessResult {
  readonly status: 'ready' | 'unavailable';
  readonly checks: Record<string, ReadinessCheckDetail>;
}

export interface ReadinessCheckDetail {
  readonly status: 'up' | 'down' | 'not_configured';
  readonly latencyMs?: number;
}

export type ReadinessCheck = () => Promise<ReadinessResult>;

/** The smallest surface `pg.Pool` needs to expose for the readiness probe. */
export interface DatabaseProbe {
  query(text: string): Promise<unknown>;
}

export function notConfiguredReadiness(): Promise<ReadinessResult> {
  return Promise.resolve({
    status: 'unavailable',
    checks: { database: { status: 'not_configured' } },
  });
}

/**
 * Build a readiness probe backed by `SELECT 1`.
 * Errors are collapsed into `down` so connection details never reach clients.
 */
export function createDatabaseReadiness(probe: DatabaseProbe): ReadinessCheck {
  return async () => {
    const startedAt = performance.now();

    try {
      await probe.query('SELECT 1');
      return {
        status: 'ready',
        checks: {
          database: { status: 'up', latencyMs: Math.round(performance.now() - startedAt) },
        },
      };
    } catch {
      return {
        status: 'unavailable',
        checks: {
          database: { status: 'down', latencyMs: Math.round(performance.now() - startedAt) },
        },
      };
    }
  };
}
