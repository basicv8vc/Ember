import type { D1DatabaseLike } from '@ember/runtime-v2';
import type { ReadinessCheck } from '../readiness.js';

export interface V2QueueNameEnv {
  readonly EMBER_V2_DURABLE_TURN_QUEUE_NAME?: string;
  readonly EMBER_V2_DURABLE_TURN_DLQ_NAME?: string;
  readonly EMBER_V2_AGENT_TASK_QUEUE_NAME?: string;
  readonly EMBER_V2_AGENT_TASK_DLQ_NAME?: string;
}

export interface V2HostPolicyEnv {
  readonly EMBER_ENV: string;
  readonly EMBER_V2_ALLOWED_HOST?: string;
}

const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]'] as const);

/**
 * Resolve allowed Hostnames for the V2 edge worker.
 * Local/test/ci allow loopback only; v2-staging requires an explicit approved hostname.
 */
export function resolveV2AllowedHosts(env: V2HostPolicyEnv): readonly string[] {
  if (['local', 'test', 'ci'].includes(env.EMBER_ENV)) {
    return LOOPBACK_HOSTS;
  }
  if (env.EMBER_ENV === 'v2-staging') {
    const host = env.EMBER_V2_ALLOWED_HOST?.trim().toLowerCase() ?? '';
    if (host.length === 0 || host.includes('/') || host.includes(':')) {
      throw new Error('EMBER_V2_ALLOWED_HOST must be a bare hostname in v2-staging');
    }
    return [host];
  }
  throw new Error(`Unsupported V2 EMBER_ENV: ${env.EMBER_ENV}`);
}

/**
 * Parse an optional comma-separated Apple subject allowlist for V2 staging.
 * Returns null when unset/blank (meaning any valid Apple account for the bundle ID is allowed).
 */
export function parseAllowedSubjects(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  const subjects = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return subjects.length === 0 ? null : new Set(subjects);
}

export type ResolvedV2QueueTarget =
  | { readonly kind: 'primary'; readonly logicalQueue: 'durable_turn' | 'agent_task' }
  | { readonly kind: 'dlq'; readonly expectedQueueName: 'durable_turn' | 'agent_task' };

/**
 * Map a physical Cloudflare Queue name to its logical V2 queue or DLQ target.
 * Defaults match wrangler.local-v2.jsonc; staging overrides match wrangler.v2-staging.jsonc.
 */
export function resolveV2QueueTarget(
  queueName: string,
  env: V2QueueNameEnv = {},
): ResolvedV2QueueTarget | null {
  const durableTurn = env.EMBER_V2_DURABLE_TURN_QUEUE_NAME ?? 'durable_turn';
  const agentTask = env.EMBER_V2_AGENT_TASK_QUEUE_NAME ?? 'agent_task';
  const durableTurnDlq = env.EMBER_V2_DURABLE_TURN_DLQ_NAME ?? 'durable_turn_dlq';
  const agentTaskDlq = env.EMBER_V2_AGENT_TASK_DLQ_NAME ?? 'agent_task_dlq';

  if (queueName === durableTurn) return { kind: 'primary', logicalQueue: 'durable_turn' };
  if (queueName === agentTask) return { kind: 'primary', logicalQueue: 'agent_task' };
  if (queueName === durableTurnDlq) return { kind: 'dlq', expectedQueueName: 'durable_turn' };
  if (queueName === agentTaskDlq) return { kind: 'dlq', expectedQueueName: 'agent_task' };
  return null;
}

/**
 * Build a readiness probe backed by D1_RECOVERY `SELECT 1`.
 * Errors are collapsed into `down` so internal D1 details never reach clients.
 */
export function createD1RecoveryReadiness(db: D1DatabaseLike): ReadinessCheck {
  return async () => {
    const startedAt = performance.now();
    try {
      await db.prepare('SELECT 1').first();
      return {
        status: 'ready',
        checks: {
          d1_recovery: { status: 'up', latencyMs: Math.round(performance.now() - startedAt) },
        },
      };
    } catch {
      return {
        status: 'unavailable',
        checks: {
          d1_recovery: { status: 'down', latencyMs: Math.round(performance.now() - startedAt) },
        },
      };
    }
  };
}
