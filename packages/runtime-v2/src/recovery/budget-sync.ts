import type { DurableObjectStorageLike, SqlStorageLike } from '../storage.js';
import { validateBudgetSyncOutboxPayload, type BudgetSyncOutboxPayload } from './envelope.js';
import type { OutboxCoordinator } from './outbox.js';
import type { V2DispatchOutboxRow } from './schema.js';

export const DEFAULT_BUDGET_SYNC_BATCH_LIMIT = 10;
export const DEFAULT_BUDGET_SYNC_RETRY_BASE_MS = 5_000;
export const DEFAULT_BUDGET_SYNC_RETRY_MAX_MS = 60_000;

export interface GlobalBudgetSettleResult {
  readonly accepted: boolean;
  readonly conflict?: boolean;
  readonly alreadySettled?: boolean;
  readonly appliedDeltaMicroUsd?: number;
  readonly errorCode?: string;
}

/**
 * Port to Agent A's authoritative `GlobalBudgetAuthority`.
 * Agent B passes `BudgetSyncOutboxPayload` verbatim and never computes refunds or fees.
 */
export interface GlobalBudgetSettlePort {
  settleGlobal(payload: BudgetSyncOutboxPayload): Promise<GlobalBudgetSettleResult>;
}

export interface BudgetSyncRelayBatchResult {
  readonly ackedCount: number;
  readonly retriedCount: number;
  readonly conflictCount: number;
  readonly items: ReadonlyArray<{
    readonly outboxId: string;
    readonly operationId: string;
    readonly revision: number;
    readonly status: 'acked' | 'retried' | 'conflict' | 'invalid_payload';
  }>;
}

/**
 * Reads due `budget_sync` outbox rows (never routed to external queues), relays immutable
 * `BudgetSyncOutboxPayload` verbatim to `GlobalBudgetSettlePort.settleGlobal`, and ACKs
 * strictly after explicit Global confirmation (`accepted && !conflict`).
 */
export async function relayDueBudgetSyncBatch(cmd: {
  readonly sql: SqlStorageLike;
  readonly storage: Pick<DurableObjectStorageLike, 'transactionSync'>;
  readonly coordinator: Pick<OutboxCoordinator, 'ackOutboxSync'>;
  readonly globalBudget: GlobalBudgetSettlePort;
  readonly nowMs: number;
  readonly limit?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
}): Promise<BudgetSyncRelayBatchResult> {
  const boundedLimit = Math.max(1, Math.min(cmd.limit ?? DEFAULT_BUDGET_SYNC_BATCH_LIMIT, 20));
  const retryBaseMs = cmd.retryBaseMs ?? DEFAULT_BUDGET_SYNC_RETRY_BASE_MS;
  const retryMaxMs = cmd.retryMaxMs ?? DEFAULT_BUDGET_SYNC_RETRY_MAX_MS;

  const dueRows = cmd.storage.transactionSync(() =>
    cmd.sql
      .exec<V2DispatchOutboxRow & Record<string, never>>(
        `SELECT * FROM v2_dispatch_outbox
         WHERE entity_kind = 'budget_sync'
           AND queue_name IS NULL
           AND state IN ('pending', 'enqueued', 'dead_lettered')
           AND next_attempt_at_ms <= ?
         ORDER BY operation_id ASC, revision ASC, next_attempt_at_ms ASC, outbox_id ASC
         LIMIT ?`,
        cmd.nowMs,
        boundedLimit,
      )
      .toArray(),
  );

  let ackedCount = 0;
  let retriedCount = 0;
  let conflictCount = 0;
  const items: Array<{
    readonly outboxId: string;
    readonly operationId: string;
    readonly revision: number;
    readonly status: 'acked' | 'retried' | 'conflict' | 'invalid_payload';
  }> = [];

  for (const row of dueRows) {
    const operationId = row.operation_id ?? row.entity_id;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_json);
    } catch {
      cmd.storage.transactionSync(() => {
        cmd.sql.exec(
          `UPDATE v2_dispatch_outbox
           SET publish_attempts = publish_attempts + 1,
               last_error_code = 'BUDGET_SYNC_CORRUPT_JSON',
               next_attempt_at_ms = ?,
               updated_at_ms = ?
           WHERE outbox_id = ?`,
          cmd.nowMs + retryMaxMs,
          cmd.nowMs,
          row.outbox_id,
        );
      });
      conflictCount += 1;
      items.push({
        outboxId: row.outbox_id,
        operationId,
        revision: row.revision,
        status: 'invalid_payload',
      });
      continue;
    }

    const validation = validateBudgetSyncOutboxPayload(parsed);
    if (!validation.ok) {
      cmd.storage.transactionSync(() => {
        cmd.sql.exec(
          `UPDATE v2_dispatch_outbox
           SET publish_attempts = publish_attempts + 1,
               last_error_code = ?,
               next_attempt_at_ms = ?,
               updated_at_ms = ?
           WHERE outbox_id = ?`,
          validation.code,
          cmd.nowMs + retryMaxMs,
          cmd.nowMs,
          row.outbox_id,
        );
      });
      conflictCount += 1;
      items.push({
        outboxId: row.outbox_id,
        operationId,
        revision: row.revision,
        status: 'invalid_payload',
      });
      continue;
    }

    const backoffMs = Math.min(retryMaxMs, retryBaseMs * Math.max(1, row.publish_attempts + 1));

    try {
      const outcome = await cmd.globalBudget.settleGlobal(validation.payload);

      if (outcome.conflict === true) {
        // Never ACK a same-revision conflicting settlement; retain for alert & inspection.
        cmd.storage.transactionSync(() => {
          cmd.sql.exec(
            `UPDATE v2_dispatch_outbox
             SET publish_attempts = publish_attempts + 1,
                 last_error_code = ?,
                 next_attempt_at_ms = ?,
                 updated_at_ms = ?
             WHERE outbox_id = ? AND state IN ('pending', 'enqueued', 'dead_lettered')`,
            outcome.errorCode ?? 'BUDGET_SYNC_REVISION_CONFLICT',
            cmd.nowMs + retryMaxMs,
            cmd.nowMs,
            row.outbox_id,
          );
        });
        conflictCount += 1;
        items.push({
          outboxId: row.outbox_id,
          operationId,
          revision: row.revision,
          status: 'conflict',
        });
        continue;
      }

      if (outcome.accepted) {
        cmd.storage.transactionSync(() => {
          cmd.coordinator.ackOutboxSync(row.outbox_id, row.fence_epoch, cmd.nowMs);
        });
        ackedCount += 1;
        items.push({
          outboxId: row.outbox_id,
          operationId,
          revision: row.revision,
          status: 'acked',
        });
        continue;
      }

      cmd.storage.transactionSync(() => {
        cmd.sql.exec(
          `UPDATE v2_dispatch_outbox
           SET publish_attempts = publish_attempts + 1,
               last_error_code = ?,
               next_attempt_at_ms = ?,
               updated_at_ms = ?
           WHERE outbox_id = ? AND state IN ('pending', 'enqueued', 'dead_lettered')`,
          outcome.errorCode ?? 'GLOBAL_BUDGET_NOT_CONFIRMED',
          cmd.nowMs + backoffMs,
          cmd.nowMs,
          row.outbox_id,
        );
      });
      retriedCount += 1;
      items.push({
        outboxId: row.outbox_id,
        operationId,
        revision: row.revision,
        status: 'retried',
      });
    } catch (error) {
      const errorCode =
        error instanceof Error && error.message.length > 0
          ? `GLOBAL_BUDGET_UNAVAILABLE:${error.message.slice(0, 64)}`
          : 'GLOBAL_BUDGET_UNAVAILABLE';
      cmd.storage.transactionSync(() => {
        cmd.sql.exec(
          `UPDATE v2_dispatch_outbox
           SET publish_attempts = publish_attempts + 1,
               last_error_code = ?,
               next_attempt_at_ms = ?,
               updated_at_ms = ?
           WHERE outbox_id = ? AND state IN ('pending', 'enqueued', 'dead_lettered')`,
          errorCode,
          cmd.nowMs + backoffMs,
          cmd.nowMs,
          row.outbox_id,
        );
      });
      retriedCount += 1;
      items.push({
        outboxId: row.outbox_id,
        operationId,
        revision: row.revision,
        status: 'retried',
      });
    }
  }

  return {
    ackedCount,
    retriedCount,
    conflictCount,
    items,
  };
}
