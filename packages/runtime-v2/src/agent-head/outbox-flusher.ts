import type { GlobalBudgetAuthority } from '../contracts/global-budget.js';
import { validateBudgetSyncOutboxPayload } from '../recovery/envelope.js';
import type { V2DispatchOutboxRow } from '../recovery/schema.js';
import type { DurableObjectStorageLike } from '../storage.js';
import type { DefaultEventRuntimePorts } from './default-event-ports.js';
import { sqlExecAll } from './queries.js';

export interface FlushBudgetSyncSummary {
  readonly attempted: number;
  readonly acked: number;
  readonly conflicted: number;
  readonly failed: number;
}

/**
 * Relays due `v2_dispatch_outbox (entity_kind = 'budget_sync', queue_name IS NULL)` rows
 * to `GlobalBudgetAuthority.settleGlobal` outside any DO SQLite transaction.
 *
 * - On `applied` or `alreadySettled` (with `conflict: false`): marks outbox `acked` and stamps
 *   `model_attempts.global_synced_at_ms = nowMs`, then recomputes Alarm (moving backward/deleting if idle).
 * - On `conflict: true`: increments retry counters and backs off with diagnostic error code (never auto-drops).
 * - On transport/transient errors: applies bounded exponential backoff without cancelling `budget_sync`.
 */
export async function flushDueBudgetSyncOutbox(input: {
  readonly storage: DurableObjectStorageLike;
  readonly eventPorts: DefaultEventRuntimePorts;
  readonly globalBudget: GlobalBudgetAuthority;
  readonly nowMs: () => number;
  readonly limit?: number;
}): Promise<FlushBudgetSyncSummary> {
  const limit = input.limit ?? 10;
  const sampleNow = input.nowMs();

  const dueRows = input.storage.transactionSync(() =>
    sqlExecAll<V2DispatchOutboxRow>(
      input.storage.sql,
      `SELECT *
         FROM v2_dispatch_outbox
        WHERE entity_kind = 'budget_sync'
          AND state IN ('pending', 'enqueued', 'dead_lettered')
          AND next_attempt_at_ms <= ?
        ORDER BY next_attempt_at_ms ASC, revision ASC, outbox_id ASC
        LIMIT ?`,
      sampleNow,
      limit,
    ),
  );

  let acked = 0;
  let conflicted = 0;
  let failed = 0;

  for (const row of dueRows) {
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(row.payload_json);
    } catch {
      failed += 1;
      continue;
    }

    const validated = validateBudgetSyncOutboxPayload(parsedPayload);
    if (!validated.ok) {
      failed += 1;
      continue;
    }
    const p = validated.payload;

    try {
      const res = await input.globalBudget.settleGlobal({
        tenantId: p.tenantId,
        operationId: p.operationId,
        settlementRevision: p.settlementRevision,
        globalGrantId: p.globalGrantId,
        state: p.state,
        observedCostMicroUsd: p.observedCostMicroUsd,
        chargeMicroUsd: p.chargeMicroUsd,
        reservedMicroUsd: p.reservedMicroUsd,
        ...(p.openIncidentReason !== null ? { openIncidentReason: p.openIncidentReason } : {}),
      });

      const doneAt = input.nowMs();
      if (res.conflict) {
        conflicted += 1;
        input.storage.transactionSync(() => {
          input.storage.sql.exec(
            `UPDATE v2_dispatch_outbox
                SET publish_attempts = publish_attempts + 1,
                    last_error_code = 'BUDGET_SYNC_CONFLICT',
                    next_attempt_at_ms = ?,
                    updated_at_ms = ?
              WHERE outbox_id = ?`,
            doneAt + 60_000,
            doneAt,
            row.outbox_id,
          );
          input.eventPorts.recomputeAlarmSync(doneAt);
        });
        await input.eventPorts.flushPendingAlarmOp();
        continue;
      }

      if (res.applied || res.alreadySettled) {
        acked += 1;
        input.storage.transactionSync(() => {
          input.eventPorts.ackOutboxSync(row.outbox_id, row.fence_epoch, doneAt);
          input.storage.sql.exec(
            `UPDATE model_attempts
                SET global_synced_at_ms = ?
              WHERE operation_id = ?
                AND settlement_revision = ?`,
            doneAt,
            p.operationId,
            p.settlementRevision,
          );
          input.eventPorts.recomputeAlarmSync(doneAt);
        });
        await input.eventPorts.flushPendingAlarmOp();
      }
    } catch {
      failed += 1;
      const failAt = input.nowMs();
      const backoffMs = Math.min(300_000, 2_000 * 2 ** Math.min(row.publish_attempts, 7));
      input.storage.transactionSync(() => {
        input.storage.sql.exec(
          `UPDATE v2_dispatch_outbox
              SET publish_attempts = publish_attempts + 1,
                  last_error_code = 'GLOBAL_BUDGET_UNAVAILABLE',
                  next_attempt_at_ms = ?,
                  updated_at_ms = ?
            WHERE outbox_id = ? AND state IN ('pending', 'enqueued', 'dead_lettered')`,
          failAt + backoffMs,
          failAt,
          row.outbox_id,
        );
        input.eventPorts.recomputeAlarmSync(failAt);
      });
      await input.eventPorts.flushPendingAlarmOp();
    }
  }

  return {
    attempted: dueRows.length,
    acked,
    conflicted,
    failed,
  };
}
