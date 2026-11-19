import {
  computePreDeadlineRetryAtMs,
  validateDispatchEnvelope,
  type V2DispatchEnvelope,
} from './envelope.js';
import type { AgentHeadRecoveryPort } from './ports.js';
import type { V2QueueName } from './schema.js';

export const DEFAULT_QUEUE_CLAIM_LEASE_MS = 45_000;
export const DEFAULT_DLQ_RETRY_GRACE_MS = 60_000;

export interface QueueMessageLike<Body = unknown> {
  readonly id: string;
  readonly body: Body;
  readonly attempts?: number;
  ack(): void;
  retry(options?: { readonly delaySeconds?: number }): void;
}

export interface DurableExecutorPort {
  executeDurableWork(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly targetKind: 'turn' | 'task';
    readonly targetId: string;
    readonly leaseEpoch: number;
    readonly leaseExpiresAtMs: number;
    readonly contextJson: string;
    readonly workerId: string;
  }): Promise<unknown>;
}

export interface AgentHeadDeadLetterPort {
  onDispatchDeadLetter(cmd: {
    readonly envelope: V2DispatchEnvelope;
    readonly errorCode: string;
    readonly nowMs: number;
    readonly graceMs?: number;
  }): Promise<{
    readonly action: 'rescheduled' | 'armed_deadline_convergence' | 'ignored_stale_or_terminal';
    readonly alarmAtMs: number | null;
  }>;
}

export interface QueueConsumerRouterPort {
  getAgentHeadRecoveryPort(tenantId: string, agentId: string): AgentHeadRecoveryPort;
  getDeadLetterPort(tenantId: string, agentId: string): AgentHeadDeadLetterPort;
}

export interface QueueBatchOutcome {
  readonly acked: number;
  readonly retried: number;
  readonly rejected: number;
  readonly executed: number;
}

/**
 * Stateless Durable Execution Worker consumer for primary `durable_turn` / `agent_task` queues.
 * Strictly validates closed `V2DispatchEnvelope`, claims fenced work via DO `claimDurableWork`,
 * runs executor outside DO, and commits via `commitDurableResult`.
 */
export async function handleDurableQueueBatch(cmd: {
  readonly queueName: V2QueueName;
  readonly messages: ReadonlyArray<QueueMessageLike>;
  readonly router: QueueConsumerRouterPort;
  readonly executor: DurableExecutorPort;
  readonly workerId: string;
  readonly leaseMs?: number;
  readonly retryDelaySeconds?: number;
}): Promise<QueueBatchOutcome> {
  const leaseMs = cmd.leaseMs ?? DEFAULT_QUEUE_CLAIM_LEASE_MS;
  const retryDelaySeconds = cmd.retryDelaySeconds ?? 10;
  let acked = 0;
  let retried = 0;
  let rejected = 0;
  let executed = 0;

  for (const message of cmd.messages) {
    const check = validateDispatchEnvelope(message.body);
    if (!check.ok || check.envelope.queueName !== cmd.queueName) {
      message.ack();
      acked += 1;
      rejected += 1;
      continue;
    }

    const envelope = check.envelope;
    const headPort = cmd.router.getAgentHeadRecoveryPort(envelope.tenantId, envelope.agentId);

    try {
      const claim = await headPort.claimDurableWork({
        envelope,
        workerId: cmd.workerId,
        leaseMs,
      });

      if (claim.kind === 'not_claimed') {
        if (
          claim.reason === 'terminal' ||
          claim.reason === 'not_found' ||
          claim.reason === 'stale_or_invalid_envelope' ||
          claim.reason === 'deadline_expired'
        ) {
          message.ack();
          acked += 1;
          if (claim.reason !== 'terminal') {
            rejected += 1;
          }
        } else {
          // lease_active: let Queue retry with backoff rather than double-executing
          message.retry({ delaySeconds: retryDelaySeconds });
          retried += 1;
        }
        continue;
      }

      const outcome = await cmd.executor.executeDurableWork({
        tenantId: envelope.tenantId,
        agentId: envelope.agentId,
        targetKind: claim.targetKind,
        targetId: claim.targetId,
        leaseEpoch: claim.leaseEpoch,
        leaseExpiresAtMs: claim.leaseExpiresAtMs,
        contextJson: claim.contextJson,
        workerId: cmd.workerId,
      });

      const commit = await headPort.commitDurableResult({
        tenantId: envelope.tenantId,
        agentId: envelope.agentId,
        entityType: claim.targetKind,
        entityId: claim.targetId,
        leaseEpoch: claim.leaseEpoch,
        workerId: cmd.workerId,
        outcome,
      });

      if (commit.accepted) {
        executed += 1;
      }
      // Ack Queue message whether accepted or fenced by newer epoch/cancellation
      message.ack();
      acked += 1;
    } catch {
      message.retry({ delaySeconds: retryDelaySeconds });
      retried += 1;
    }
  }

  return { acked, retried, rejected, executed };
}

/**
 * Pure DO-side deadline-bounded dead-letter convergence helper usable inside DO transactionSync
 * when DLQ delivers a failed dispatch back to `AgentHeadDO`.
 */
export function resolveDeadLetterRetrySchedule(cmd: {
  readonly nowMs: number;
  readonly deadlineAtMs: number;
  readonly isTerminalOrCancelled: boolean;
  readonly graceMs?: number;
}):
  | { readonly action: 'ignored_stale_or_terminal'; readonly alarmAtMs: null }
  | { readonly action: 'armed_deadline_convergence'; readonly alarmAtMs: number }
  | { readonly action: 'rescheduled'; readonly alarmAtMs: number } {
  if (cmd.isTerminalOrCancelled) {
    return { action: 'ignored_stale_or_terminal', alarmAtMs: null };
  }

  const decision = computePreDeadlineRetryAtMs(
    cmd.nowMs,
    cmd.deadlineAtMs,
    cmd.graceMs ?? DEFAULT_DLQ_RETRY_GRACE_MS,
  );
  if (!decision.shouldRetry) {
    return {
      action: 'armed_deadline_convergence',
      alarmAtMs: decision.alarmAtMs,
    };
  }
  return {
    action: 'rescheduled',
    alarmAtMs: decision.nextAttemptAtMs,
  };
}

/**
 * Stateless DLQ consumer: validates closed `V2DispatchEnvelope` and notifies `AgentHeadDO`
 * to apply `dead_lettered` state with pre-deadline `1s/5s` retry capping (never blind retry past deadline).
 */
export async function handleDurableDeadLetterBatch(cmd: {
  readonly expectedQueueName: V2QueueName;
  readonly messages: ReadonlyArray<QueueMessageLike>;
  readonly router: QueueConsumerRouterPort;
  readonly nowMs: () => number;
  readonly graceMs?: number;
}): Promise<{ readonly acked: number; readonly rejected: number; readonly retried: number }> {
  let acked = 0;
  let rejected = 0;
  let retried = 0;

  for (const message of cmd.messages) {
    const check = validateDispatchEnvelope(message.body);
    if (!check.ok || check.envelope.queueName !== cmd.expectedQueueName) {
      message.ack();
      acked += 1;
      rejected += 1;
      continue;
    }

    const dlqPort = cmd.router.getDeadLetterPort(check.envelope.tenantId, check.envelope.agentId);
    try {
      await dlqPort.onDispatchDeadLetter({
        envelope: check.envelope,
        errorCode: 'QUEUE_MAX_RETRIES_EXHAUSTED',
        nowMs: cmd.nowMs(),
        graceMs: cmd.graceMs,
      });
      message.ack();
      acked += 1;
    } catch {
      message.retry({ delaySeconds: 15 });
      retried += 1;
    }
  }

  return { acked, rejected, retried };
}
