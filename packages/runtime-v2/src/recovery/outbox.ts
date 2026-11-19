import type { DurableObjectStorageLike, QueueLike, SqlStorageLike } from '../storage.js';
import {
  computePreDeadlineRetryAtMs,
  OutboxConstraintError,
  validateDispatchEnvelope,
  validateOutboxEnqueueCommand,
  type V2DispatchEnvelope,
} from './envelope.js';
import type {
  AgentHeadRecoveryPort,
  AuthoritativeBusinessPort,
  EventRuntimeCoordinatorPort,
} from './ports.js';
import type {
  OrdinaryOutboxEntityKind,
  OutboxEntityKind,
  V2DispatchOutboxRow,
  V2QueueName,
} from './schema.js';

export const DEFAULT_DISPATCH_BATCH_LIMIT = 10;
export const DEFAULT_ENQUEUE_GRACE_MS = 60_000;
export const DEFAULT_PUBLISH_FAILURE_RETRY_MS = 2_000;

export interface DurableAgentIdentity {
  readonly tenantId: string;
  readonly agentId: string;
}

export type DispatchOutboxBatchResult = {
  readonly sentCount: number;
  readonly convergedCount: number;
  readonly failedCount: number;
  readonly items: ReadonlyArray<{
    readonly outboxId: string;
    readonly action: 'enqueued' | 'acked_terminal' | 'converged_due' | 'publish_failed';
    readonly nextAttemptAtMs: number | null;
  }>;
};

export type VerifyDispatchRejectionCode =
  | 'INVALID_ENVELOPE'
  | 'QUEUE_NAME_MISMATCH'
  | 'TENANT_OR_AGENT_MISMATCH'
  | 'OUTBOX_NOT_FOUND'
  | 'BUDGET_SYNC_FORBIDDEN'
  | 'OUTBOX_TUPLE_MISMATCH'
  | 'STALE_OR_FUTURE_EPOCH'
  | 'DEADLINE_EXPIRED';

export type VerifyAndClaimDispatchResult =
  | {
      readonly kind: 'claimed';
      readonly envelope: V2DispatchEnvelope;
      readonly ackQueueMessage: true;
      readonly claim: Extract<
        Awaited<ReturnType<AgentHeadRecoveryPort['claimDurableWork']>>,
        { kind: 'claimed' }
      >;
    }
  | {
      readonly kind: 'already_handled';
      readonly state: 'acked' | 'cancelled';
      readonly ackQueueMessage: true;
    }
  | {
      readonly kind: 'rejected';
      readonly code: VerifyDispatchRejectionCode;
      readonly message: string;
      readonly ackQueueMessage: true;
    }
  | {
      readonly kind: 'retry_later';
      readonly reason:
        'lease_active' | 'deadline_expired' | 'not_found' | 'stale_or_invalid_envelope';
      readonly ackQueueMessage: false;
    };

/**
 * DO SQLite `v2_dispatch_outbox` & Alarm coordination engine implementing
 * `EventRuntimeCoordinatorPort` and closed-envelope Queue fencing (J5).
 */
export class OutboxCoordinator implements EventRuntimeCoordinatorPort {
  readonly #sql: SqlStorageLike;
  readonly #storage?: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly #business?: Pick<
    AuthoritativeBusinessPort,
    'listDueBusinessActionsSync' | 'inspectOutboxTargetSync' | 'convergeDueBusinessItemSync'
  >;

  constructor(
    sql: SqlStorageLike,
    deps?: {
      readonly storage?: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
      readonly business?: Pick<
        AuthoritativeBusinessPort,
        'listDueBusinessActionsSync' | 'inspectOutboxTargetSync' | 'convergeDueBusinessItemSync'
      >;
    },
  ) {
    this.#sql = sql;
    this.#storage = deps?.storage;
    this.#business = deps?.business;
  }

  enqueueDurableOutboxSync(cmd: {
    readonly outboxId: string;
    readonly entityKind: OutboxEntityKind;
    readonly entityId: string;
    readonly queueName: V2QueueName | null;
    readonly payloadJson: string;
    readonly operationId?: string;
    readonly revision?: number;
    readonly fenceEpoch: number;
    readonly nextAttemptAtMs: number;
    readonly nowMs?: number;
  }): void {
    const validated = validateOutboxEnqueueCommand(cmd);
    const nowMs = cmd.nowMs ?? validated.nextAttemptAtMs;

    this.#sql.exec(
      `INSERT INTO v2_dispatch_outbox (
        outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id,
        revision, state, next_attempt_at_ms, last_enqueued_at_ms, publish_attempts,
        dlq_count, fence_epoch, last_error_code, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, 0, 0, ?, NULL, ?, ?)
      ON CONFLICT (outbox_id) DO NOTHING`,
      validated.outboxId,
      validated.entityKind,
      validated.entityId,
      validated.queueName,
      validated.payloadJson,
      validated.operationId ?? null,
      validated.revision,
      validated.nextAttemptAtMs,
      validated.fenceEpoch,
      nowMs,
      nowMs,
    );
  }

  cancelEntityOutboxSync(
    entityKind: OrdinaryOutboxEntityKind,
    entityId: string,
    nowMs: number,
  ): void {
    if ((entityKind as OutboxEntityKind) === 'budget_sync') {
      throw new OutboxConstraintError(
        'BUDGET_SYNC_CANNOT_BE_CANCELLED',
        'ADR-0001 / J5 invariant: budget_sync outbox items must never be cancelled',
      );
    }

    this.#sql.exec(
      `UPDATE v2_dispatch_outbox
       SET state = 'cancelled', updated_at_ms = ?
       WHERE entity_kind = ?
         AND entity_id = ?
         AND entity_kind <> 'budget_sync'
         AND state IN ('pending', 'enqueued', 'dead_lettered')`,
      nowMs,
      entityKind,
      entityId,
    );
  }

  ackOutboxSync(outboxId: string, fenceEpoch: number, nowMs: number): void {
    this.#sql.exec(
      `UPDATE v2_dispatch_outbox
       SET state = 'acked', last_error_code = NULL, updated_at_ms = ?
       WHERE outbox_id = ?
         AND fence_epoch = ?
         AND state IN ('pending', 'enqueued', 'dead_lettered')`,
      nowMs,
      outboxId,
      fenceEpoch,
    );
  }

  applyOutboxDeadLetterSync(cmd: {
    readonly outboxId: string;
    readonly fenceEpoch: number;
    readonly errorCode: string;
    readonly nextAttemptAtMs: number;
    readonly nowMs: number;
  }): boolean {
    const existing = this.#sql
      .exec<{
        outbox_id: string;
        state: string;
        fence_epoch: number;
        entity_kind: OutboxEntityKind;
      }>(
        `SELECT outbox_id, state, fence_epoch, entity_kind
         FROM v2_dispatch_outbox
         WHERE outbox_id = ?`,
        cmd.outboxId,
      )
      .toArray();
    const row = existing[0];
    if (
      row === undefined ||
      row.entity_kind === 'budget_sync' ||
      row.fence_epoch !== cmd.fenceEpoch ||
      (row.state !== 'pending' && row.state !== 'enqueued' && row.state !== 'dead_lettered')
    ) {
      return false;
    }

    this.#sql.exec(
      `UPDATE v2_dispatch_outbox
       SET state = 'dead_lettered',
           dlq_count = dlq_count + 1,
           last_error_code = ?,
           next_attempt_at_ms = ?,
           updated_at_ms = ?
       WHERE outbox_id = ? AND fence_epoch = ? AND state IN ('pending', 'enqueued', 'dead_lettered')`,
      cmd.errorCode,
      cmd.nextAttemptAtMs,
      cmd.nowMs,
      cmd.outboxId,
      cmd.fenceEpoch,
    );
    return true;
  }

  /**
   * Computes earliest DO Alarm target across:
   * - `AuthoritativeBusinessPort.earliestRequiredDiscoveryAtMsSync(nowMs)` (if wired)
   * - Active `v2_schedules.next_fire_at_ms`
   * - Pending / enqueued / dead_lettered `v2_dispatch_outbox.next_attempt_at_ms` (including `budget_sync`)
   */
  recomputeAlarmSync(_nowMs: number): number | null {
    const candidates: number[] = [];

    const dueActions =
      this.#business?.listDueBusinessActionsSync(Number.MAX_SAFE_INTEGER, 10) ?? [];
    for (const action of dueActions) {
      candidates.push(action.deadlineAtMs);
    }

    const schedMin = this.#sql
      .exec<{ min_ts: number | null }>(
        `SELECT MIN(next_fire_at_ms) AS min_ts
         FROM v2_schedules
         WHERE status = 'active'`,
      )
      .toArray()[0]?.min_ts;
    if (schedMin !== null && schedMin !== undefined) {
      candidates.push(schedMin);
    }

    const outboxMin = this.#sql
      .exec<{ min_ts: number | null }>(
        `SELECT MIN(next_attempt_at_ms) AS min_ts
         FROM v2_dispatch_outbox
         WHERE state IN ('pending', 'enqueued', 'dead_lettered')`,
      )
      .toArray()[0]?.min_ts;
    if (outboxMin !== null && outboxMin !== undefined) {
      candidates.push(outboxMin);
    }

    if (candidates.length === 0) {
      return null;
    }
    return Math.min(...candidates);
  }

  listDueOrdinaryOutboxSync(
    nowMs: number,
    limit = DEFAULT_DISPATCH_BATCH_LIMIT,
  ): ReadonlyArray<V2DispatchOutboxRow> {
    const bounded = Math.max(1, Math.min(limit, DEFAULT_DISPATCH_BATCH_LIMIT));
    return this.#sql
      .exec<V2DispatchOutboxRow & Record<string, never>>(
        `SELECT * FROM v2_dispatch_outbox
         WHERE entity_kind <> 'budget_sync'
           AND queue_name IS NOT NULL
           AND state IN ('pending', 'enqueued', 'dead_lettered')
           AND next_attempt_at_ms <= ?
         ORDER BY next_attempt_at_ms ASC, outbox_id ASC
         LIMIT ?`,
        nowMs,
        bounded,
      )
      .toArray();
  }

  getOutboxByIdSync(outboxId: string): V2DispatchOutboxRow | null {
    const rows = this.#sql
      .exec<V2DispatchOutboxRow & Record<string, never>>(
        'SELECT * FROM v2_dispatch_outbox WHERE outbox_id = ?',
        outboxId,
      )
      .toArray();
    return rows[0] ?? null;
  }

  markPublishSuccessSync(cmd: {
    readonly outboxId: string;
    readonly fenceEpoch: number;
    readonly nextAttemptAtMs: number;
    readonly nowMs: number;
  }): void {
    this.#sql.exec(
      `UPDATE v2_dispatch_outbox
       SET state = 'enqueued',
           last_enqueued_at_ms = ?,
           next_attempt_at_ms = ?,
           publish_attempts = publish_attempts + 1,
           last_error_code = NULL,
           updated_at_ms = ?
       WHERE outbox_id = ?
         AND fence_epoch = ?
         AND state IN ('pending', 'enqueued', 'dead_lettered')`,
      cmd.nowMs,
      cmd.nextAttemptAtMs,
      cmd.nowMs,
      cmd.outboxId,
      cmd.fenceEpoch,
    );
  }

  markPublishFailureSync(cmd: {
    readonly outboxId: string;
    readonly fenceEpoch: number;
    readonly errorCode: string;
    readonly nextAttemptAtMs: number;
    readonly nowMs: number;
  }): void {
    this.#sql.exec(
      `UPDATE v2_dispatch_outbox
       SET publish_attempts = publish_attempts + 1,
           last_error_code = ?,
           next_attempt_at_ms = ?,
           updated_at_ms = ?
       WHERE outbox_id = ?
         AND fence_epoch = ?
         AND state IN ('pending', 'enqueued', 'dead_lettered')`,
      cmd.errorCode,
      cmd.nextAttemptAtMs,
      cmd.nowMs,
      cmd.outboxId,
      cmd.fenceEpoch,
    );
  }

  /**
   * Publishes due ordinary outbox rows outside `transactionSync()` after pre-flighting
   * business freshness, applying B1 pre-deadline retry capping (`1s` floor / `5s` margin).
   */
  async dispatchDueOrdinaryOutbox(cmd: {
    readonly nowMs: number;
    readonly queues: Readonly<Record<V2QueueName, QueueLike<V2DispatchEnvelope>>>;
    readonly graceMs?: number;
    readonly failureRetryMs?: number;
    readonly limit?: number;
  }): Promise<DispatchOutboxBatchResult> {
    if (!this.#storage || !this.#business) {
      throw new Error(
        'dispatchDueOrdinaryOutbox requires OutboxCoordinator constructed with storage and business ports',
      );
    }
    const storage = this.#storage;
    const business = this.#business;
    const graceMs = cmd.graceMs ?? DEFAULT_ENQUEUE_GRACE_MS;
    const failureRetryMs = cmd.failureRetryMs ?? DEFAULT_PUBLISH_FAILURE_RETRY_MS;

    const planned: Array<
      | {
          readonly mode: 'send';
          readonly row: V2DispatchOutboxRow;
          readonly envelope: V2DispatchEnvelope;
          readonly deadlineAtMs: number;
        }
      | {
          readonly mode: 'already_resolved';
          readonly outboxId: string;
          readonly action: 'acked_terminal' | 'converged_due';
        }
    > = [];

    storage.transactionSync(() => {
      const dueRows = this.listDueOrdinaryOutboxSync(cmd.nowMs, cmd.limit);
      for (const row of dueRows) {
        if (row.entity_kind === 'budget_sync' || row.queue_name === null) {
          continue;
        }
        const target = business.inspectOutboxTargetSync(row.entity_kind, row.entity_id);
        if (!target.exists || target.isTerminal || row.fence_epoch < target.currentLeaseEpoch) {
          this.ackOutboxSync(row.outbox_id, row.fence_epoch, cmd.nowMs);
          planned.push({
            mode: 'already_resolved',
            outboxId: row.outbox_id,
            action: 'acked_terminal',
          });
          continue;
        }

        if (target.cancelRequested || cmd.nowMs >= target.deadlineAtMs) {
          if (target.targetKind !== null && target.targetId !== null) {
            business.convergeDueBusinessItemSync(target.targetKind, target.targetId, cmd.nowMs);
          }
          this.ackOutboxSync(row.outbox_id, row.fence_epoch, cmd.nowMs);
          planned.push({
            mode: 'already_resolved',
            outboxId: row.outbox_id,
            action: 'converged_due',
          });
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(row.payload_json);
        } catch {
          this.applyOutboxDeadLetterSync({
            outboxId: row.outbox_id,
            fenceEpoch: row.fence_epoch,
            errorCode: 'CORRUPT_OUTBOX_JSON',
            nextAttemptAtMs: target.deadlineAtMs,
            nowMs: cmd.nowMs,
          });
          continue;
        }
        const envCheck = validateDispatchEnvelope(parsed);
        if (!envCheck.ok) {
          this.applyOutboxDeadLetterSync({
            outboxId: row.outbox_id,
            fenceEpoch: row.fence_epoch,
            errorCode: envCheck.code,
            nextAttemptAtMs: target.deadlineAtMs,
            nowMs: cmd.nowMs,
          });
          continue;
        }

        planned.push({
          mode: 'send',
          row,
          envelope: envCheck.envelope,
          deadlineAtMs: target.deadlineAtMs,
        });
      }
    });

    const items: Array<{
      readonly outboxId: string;
      readonly action: 'enqueued' | 'acked_terminal' | 'converged_due' | 'publish_failed';
      readonly nextAttemptAtMs: number | null;
    }> = [];

    let sentCount = 0;
    let convergedCount = 0;
    let failedCount = 0;

    for (const entry of planned) {
      if (entry.mode === 'already_resolved') {
        convergedCount += 1;
        items.push({ outboxId: entry.outboxId, action: entry.action, nextAttemptAtMs: null });
        continue;
      }

      const targetQueue = cmd.queues[entry.envelope.queueName];
      try {
        await targetQueue.send(entry.envelope, { contentType: 'json' });
        const retryDecision = computePreDeadlineRetryAtMs(cmd.nowMs, entry.deadlineAtMs, graceMs);
        const nextAttemptAtMs = retryDecision.shouldRetry
          ? retryDecision.nextAttemptAtMs
          : retryDecision.alarmAtMs;

        storage.transactionSync(() => {
          this.markPublishSuccessSync({
            outboxId: entry.row.outbox_id,
            fenceEpoch: entry.row.fence_epoch,
            nextAttemptAtMs,
            nowMs: cmd.nowMs,
          });
        });

        sentCount += 1;
        items.push({ outboxId: entry.row.outbox_id, action: 'enqueued', nextAttemptAtMs });
      } catch (error) {
        const retryAtMs = Math.min(cmd.nowMs + failureRetryMs, entry.deadlineAtMs);
        const errorCode =
          error instanceof Error && error.message.length > 0
            ? `QUEUE_SEND_FAILED:${error.message.slice(0, 64)}`
            : 'QUEUE_SEND_FAILED';
        storage.transactionSync(() => {
          this.markPublishFailureSync({
            outboxId: entry.row.outbox_id,
            fenceEpoch: entry.row.fence_epoch,
            errorCode,
            nextAttemptAtMs: retryAtMs,
            nowMs: cmd.nowMs,
          });
        });
        failedCount += 1;
        items.push({
          outboxId: entry.row.outbox_id,
          action: 'publish_failed',
          nextAttemptAtMs: retryAtMs,
        });
      }
    }

    return {
      sentCount,
      convergedCount,
      failedCount,
      items,
    };
  }
}

/**
 * Performs J5 closed-envelope + DO outbox 5-tuple + authoritative lease-epoch validation
 * before claiming durable work. Zero state mutation occurs on rejected envelopes.
 */
export async function verifyAndClaimDispatchEnvelope(cmd: {
  readonly rawEnvelope: unknown;
  readonly expectedQueueName: V2QueueName;
  readonly identity: DurableAgentIdentity;
  readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly coordinator: OutboxCoordinator;
  readonly business: Pick<AuthoritativeBusinessPort, 'inspectOutboxTargetSync'>;
  readonly recoveryPort: Pick<AgentHeadRecoveryPort, 'claimDurableWork'>;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly nowMs: number;
}): Promise<VerifyAndClaimDispatchResult> {
  const validation = validateDispatchEnvelope(cmd.rawEnvelope);
  if (!validation.ok) {
    return {
      kind: 'rejected',
      code:
        validation.code === 'BUDGET_SYNC_FORBIDDEN_ON_QUEUE'
          ? 'BUDGET_SYNC_FORBIDDEN'
          : 'INVALID_ENVELOPE',
      message: validation.message,
      ackQueueMessage: true,
    };
  }
  const envelope = validation.envelope;

  if (envelope.queueName !== cmd.expectedQueueName) {
    return {
      kind: 'rejected',
      code: 'QUEUE_NAME_MISMATCH',
      message: `Expected queue '${cmd.expectedQueueName}', received '${envelope.queueName}'`,
      ackQueueMessage: true,
    };
  }

  if (envelope.tenantId !== cmd.identity.tenantId || envelope.agentId !== cmd.identity.agentId) {
    return {
      kind: 'rejected',
      code: 'TENANT_OR_AGENT_MISMATCH',
      message: `Cross-tenant/agent mismatch: envelope=${envelope.tenantId}:${envelope.agentId}, target=${cmd.identity.tenantId}:${cmd.identity.agentId}`,
      ackQueueMessage: true,
    };
  }

  const precheck = cmd.storage.transactionSync<
    | { readonly status: 'proceed'; readonly deadlineAtMs: number }
    | { readonly status: 'already_handled'; readonly state: 'acked' | 'cancelled' }
    | {
        readonly status: 'rejected';
        readonly code: VerifyDispatchRejectionCode;
        readonly message: string;
      }
  >(() => {
    const row = cmd.coordinator.getOutboxByIdSync(envelope.eventId);
    if (row === null) {
      return {
        status: 'rejected',
        code: 'OUTBOX_NOT_FOUND',
        message: `No outbox row found for eventId '${envelope.eventId}'`,
      };
    }
    if (row.entity_kind === 'budget_sync' || row.queue_name === null) {
      return {
        status: 'rejected',
        code: 'BUDGET_SYNC_FORBIDDEN',
        message: `Outbox '${envelope.eventId}' is budget_sync and forbidden on external queues`,
      };
    }
    if (
      row.entity_kind !== envelope.entityKind ||
      row.entity_id !== envelope.entityId ||
      row.queue_name !== envelope.queueName ||
      row.fence_epoch !== envelope.fenceEpoch
    ) {
      return {
        status: 'rejected',
        code: 'OUTBOX_TUPLE_MISMATCH',
        message: `Envelope tuple mismatch against persisted outbox '${envelope.eventId}'`,
      };
    }
    if (row.state === 'acked' || row.state === 'cancelled') {
      return {
        status: 'already_handled',
        state: row.state,
      };
    }

    const target = cmd.business.inspectOutboxTargetSync(envelope.entityKind, envelope.entityId);
    if (!target.exists || envelope.fenceEpoch !== target.currentLeaseEpoch) {
      return {
        status: 'rejected',
        code: 'STALE_OR_FUTURE_EPOCH',
        message: `Envelope fenceEpoch=${envelope.fenceEpoch} !== authoritative currentLeaseEpoch=${target.currentLeaseEpoch}`,
      };
    }
    if (cmd.nowMs >= target.deadlineAtMs) {
      return {
        status: 'rejected',
        code: 'DEADLINE_EXPIRED',
        message: `Entity deadline ${target.deadlineAtMs} already reached at nowMs=${cmd.nowMs}`,
      };
    }

    return {
      status: 'proceed',
      deadlineAtMs: target.deadlineAtMs,
    };
  });

  if (precheck.status === 'already_handled') {
    return {
      kind: 'already_handled',
      state: precheck.state,
      ackQueueMessage: true,
    };
  }
  if (precheck.status === 'rejected') {
    return {
      kind: 'rejected',
      code: precheck.code,
      message: precheck.message,
      ackQueueMessage: true,
    };
  }

  const claimResult = await cmd.recoveryPort.claimDurableWork({
    envelope,
    workerId: cmd.workerId,
    leaseMs: cmd.leaseMs,
  });

  if (claimResult.kind === 'claimed') {
    cmd.storage.transactionSync(() => {
      cmd.coordinator.ackOutboxSync(envelope.eventId, envelope.fenceEpoch, cmd.nowMs);
    });
    return {
      kind: 'claimed',
      envelope,
      ackQueueMessage: true,
      claim: claimResult,
    };
  }

  if (claimResult.reason === 'terminal') {
    cmd.storage.transactionSync(() => {
      cmd.coordinator.ackOutboxSync(envelope.eventId, envelope.fenceEpoch, cmd.nowMs);
    });
    return {
      kind: 'already_handled',
      state: 'acked',
      ackQueueMessage: true,
    };
  }

  return {
    kind: 'retry_later',
    reason: claimResult.reason,
    ackQueueMessage: false,
  };
}
