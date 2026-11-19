import { MODEL_BUDGET_ABSOLUTE_CEILINGS } from '@ember/model-gateway';
import { GLOBAL_BUDGET_SCHEMA } from './schema.js';

import type {
  GlobalBudgetAuthorizeSendRequest,
  GlobalBudgetAuthorizeSendResult,
  GlobalBudgetGrantState,
  GlobalBudgetRenewGrantRequest,
  GlobalBudgetRenewGrantResult,
  GlobalBudgetReserveRequest,
  GlobalBudgetReserveResult,
  GlobalBudgetSettleRequest,
  GlobalBudgetSettleResult,
} from '../contracts/global-budget.js';
import type { BudgetSyncIncidentReason } from '../recovery/envelope.js';
import type { DurableObjectStorageLike, SqlStorageRow } from '../storage.js';

type Binding = SqlStorageRow[string];

type LedgerStorage = Pick<DurableObjectStorageLike, 'transactionSync'> & {
  sql: { exec<T extends SqlStorageRow>(query: string, ...bindings: Binding[]): { toArray(): T[] } };
};

type Grant = {
  operation_id: string;
  global_grant_id: string;
  tenant_id: string;
  principal_id: string;
  agent_id: string;
  lease_epoch: number;
  utc_day: string;
  amount_micro_usd: number;
  request_ceiling_micro_usd: number;
  initial_expires_at_ms: number;
  expires_at_ms: number;
  authorized_at_ms: number | null;
  state: 'reserved' | GlobalBudgetGrantState;
  cumulative_charge_micro_usd: number;
};

type Day = {
  ceiling_micro_usd: number;
  reserved_micro_usd: number;
  consumed_micro_usd: number;
  overage_micro_usd: string;
};

const DENIED = { kind: 'budget_exceeded' } as const;
const EXPIRY_BATCH_SIZE = 100;

function isSafeInteger(value: number, min = 0, max = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function settlementResponse(grant: Grant | undefined, conflict: boolean): GlobalBudgetSettleResult {
  return {
    applied: false,
    alreadySettled: !conflict,
    conflict,
    // A conflict carries no authorization or information about someone else's grant.
    effectiveState: grant && grant.state !== 'reserved' ? grant.state : 'released',
    incidentOpened: false,
  };
}

/** SQLite authority over a single platform ledger. The caller supplies trusted server time. */
export class GlobalBudgetLedger {
  constructor(
    private readonly storage: LedgerStorage,
    private readonly nowMs: () => number,
    private readonly newGrantId: () => string,
    private readonly dailyCeilingMicroUsd: number,
  ) {
    if (
      !isSafeInteger(dailyCeilingMicroUsd, 0, MODEL_BUDGET_ABSOLUTE_CEILINGS.globalDailyMicroUsd)
    ) {
      throw new Error('Invalid global daily budget ceiling');
    }
    storage.transactionSync(() => storage.sql.exec(GLOBAL_BUDGET_SCHEMA));
  }

  private exec<T extends SqlStorageRow>(query: string, ...bindings: Binding[]): T[] {
    return this.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  private grant(operationId: string): Grant | undefined {
    return this.exec<Grant>(
      'SELECT * FROM global_budget_reservations WHERE operation_id = ?',
      operationId,
    )[0];
  }

  private ownedGrant(req: GlobalBudgetAuthorizeSendRequest): Grant | undefined {
    const grant = this.grant(req.operationId);
    if (grant?.tenant_id === req.tenantId && grant.global_grant_id === req.globalGrantId) {
      return grant;
    }
  }

  private day(utcDay: string): Day | undefined {
    return this.exec<Day>('SELECT * FROM global_spend_days WHERE utc_day = ?', utcDay)[0];
  }

  private halt(): BudgetSyncIncidentReason | undefined {
    return this.exec<{ reason: BudgetSyncIncidentReason }>(
      'SELECT reason FROM global_budget_incidents WHERE resolved_at_ms IS NULL ORDER BY incident_id LIMIT 1',
    )[0]?.reason;
  }

  reserveGlobal(req: GlobalBudgetReserveRequest): GlobalBudgetReserveResult {
    return this.storage.transactionSync(() => {
      const now = this.nowMs();
      const reason = this.halt();
      if (reason) return { kind: 'budget_halted', reason };

      if (req.ceilingMicroUsd !== this.dailyCeilingMicroUsd) return DENIED;

      const existing = this.grant(req.operationId);
      if (existing) {
        if (
          existing.tenant_id !== req.tenantId ||
          existing.principal_id !== req.principalId ||
          existing.agent_id !== req.agentId ||
          existing.lease_epoch !== req.leaseEpoch ||
          existing.utc_day !== req.utcDay ||
          existing.amount_micro_usd !== req.amountMicroUsd ||
          existing.request_ceiling_micro_usd !== req.ceilingMicroUsd ||
          existing.initial_expires_at_ms !== req.expiresAtMs ||
          this.expireIfDue(existing, now).state !== 'reserved'
        ) {
          return DENIED;
        }
        return { kind: 'reserved', globalGrantId: existing.global_grant_id, replayed: true };
      }

      if (
        req.utcDay !== new Date(now).toISOString().slice(0, 10) ||
        !isSafeInteger(req.leaseEpoch) ||
        !isSafeInteger(req.expiresAtMs, now + 1) ||
        !isSafeInteger(req.amountMicroUsd, 1, MODEL_BUDGET_ABSOLUTE_CEILINGS.perAttemptMicroUsd)
      ) {
        return DENIED;
      }

      const day = this.day(req.utcDay);
      // A trusted configuration change takes effect with a fresh UTC bucket. Keep
      // historical holds and late settlements on the ceiling recorded with their day.
      if (day && day.ceiling_micro_usd !== this.dailyCeilingMicroUsd) return DENIED;
      const required =
        BigInt(
          (day?.reserved_micro_usd ?? 0) + (day?.consumed_micro_usd ?? 0) + req.amountMicroUsd,
        ) + BigInt(day?.overage_micro_usd ?? '0');
      if (required > BigInt(this.dailyCeilingMicroUsd)) return DENIED;

      const grantId = this.newGrantId();
      this.exec(
        `INSERT INTO global_spend_days (utc_day, ceiling_micro_usd, reserved_micro_usd)
         VALUES (?, ?, ?)
         ON CONFLICT (utc_day) DO UPDATE SET
           reserved_micro_usd = reserved_micro_usd + excluded.reserved_micro_usd`,
        req.utcDay,
        this.dailyCeilingMicroUsd,
        req.amountMicroUsd,
      );
      this.exec(
        `INSERT INTO global_budget_reservations (
           operation_id, global_grant_id, tenant_id, principal_id, agent_id, lease_epoch,
           utc_day, amount_micro_usd, request_ceiling_micro_usd, initial_expires_at_ms,
           expires_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`,
        req.operationId,
        grantId,
        req.tenantId,
        req.principalId,
        req.agentId,
        req.leaseEpoch,
        req.utcDay,
        req.amountMicroUsd,
        req.ceilingMicroUsd,
        req.expiresAtMs,
        req.expiresAtMs,
      );
      return { kind: 'reserved', globalGrantId: grantId, replayed: false };
    });
  }

  authorizeGlobalSend(req: GlobalBudgetAuthorizeSendRequest): GlobalBudgetAuthorizeSendResult {
    return this.storage.transactionSync(() => {
      const now = this.nowMs();
      const bound = this.ownedGrant(req);
      if (!bound) return { authorized: false };
      const grant = this.expireIfDue(bound, now);
      if (grant.state !== 'reserved' || grant.authorized_at_ms !== null || this.halt()) {
        return { authorized: false };
      }
      this.exec(
        'UPDATE global_budget_reservations SET authorized_at_ms = ? WHERE operation_id = ?',
        now,
        grant.operation_id,
      );
      return { authorized: true, startBeforeMs: grant.expires_at_ms };
    });
  }

  renewGlobalGrant(req: GlobalBudgetRenewGrantRequest): GlobalBudgetRenewGrantResult {
    return this.storage.transactionSync(() => {
      const now = this.nowMs();
      const bound = this.ownedGrant(req);
      if (!bound) return { renewed: false, state: 'not_found' };
      const grant = this.expireIfDue(bound, now);
      if (
        grant.state !== 'reserved' ||
        this.halt() ||
        !isSafeInteger(req.newExpiresAtMs, grant.expires_at_ms)
      ) {
        return { renewed: false, state: grant.state };
      }
      if (req.newExpiresAtMs > grant.expires_at_ms) {
        this.exec(
          'UPDATE global_budget_reservations SET expires_at_ms = ? WHERE operation_id = ?',
          req.newExpiresAtMs,
          grant.operation_id,
        );
      }
      return { renewed: true, state: grant.state };
    });
  }

  settleGlobal(req: GlobalBudgetSettleRequest): GlobalBudgetSettleResult {
    return this.storage.transactionSync(() => {
      const now = this.nowMs();
      const bound = this.ownedGrant(req);
      if (!bound || bound.amount_micro_usd !== req.reservedMicroUsd) {
        return settlementResponse(undefined, true);
      }

      const observed = req.observedCostMicroUsd ?? null;
      const reportedIncident = req.openIncidentReason ?? null;
      const payload = JSON.stringify([req.state, observed, req.chargeMicroUsd, reportedIncident]);
      const prior = this.exec<{ payload_json: string }>(
        `SELECT payload_json FROM global_budget_settlements
          WHERE operation_id = ? AND settlement_revision = ?`,
        req.operationId,
        req.settlementRevision,
      )[0];
      if (prior) return settlementResponse(bound, prior.payload_json !== payload);

      if (
        !isSafeInteger(req.settlementRevision) ||
        !isSafeInteger(req.chargeMicroUsd) ||
        (observed !== null && !isSafeInteger(observed)) ||
        (req.state === 'settled' && observed === null) ||
        (req.state === 'released' &&
          (req.settlementRevision !== 0 ||
            req.chargeMicroUsd !== 0 ||
            (observed !== null && observed !== 0) ||
            reportedIncident !== null))
      ) {
        return settlementResponse(bound, true);
      }

      const grant = this.expireIfDue(bound, now);
      if (
        req.state === 'released' &&
        grant.state === 'reserved' &&
        grant.authorized_at_ms !== null
      ) {
        return settlementResponse(grant, true);
      }

      const initialSettlement = grant.state === 'reserved';
      const effectiveState = grant.state === 'reserved' ? req.state : grant.state;
      const reserved = grant.amount_micro_usd;
      const conservativeFloor =
        req.state === 'unknown_billed' || req.state === 'conservative_billed' ? reserved : 0;
      const previous = grant.cumulative_charge_micro_usd;
      // An older revision can report new evidence, but it can never undo a charge or a Halt.
      const cumulative = Math.max(previous, req.chargeMicroUsd, observed ?? 0, conservativeFloor);
      const delta = cumulative - previous;
      const dayOverage =
        initialSettlement || delta > 0
          ? this.applyCharge(grant.utc_day, initialSettlement ? reserved : 0, delta)
          : 0;

      if (initialSettlement || delta > 0) {
        this.exec(
          `UPDATE global_budget_reservations
              SET state = ?, cumulative_charge_micro_usd = ?, overage_micro_usd = ?
            WHERE operation_id = ?`,
          effectiveState,
          cumulative,
          Math.max(0, cumulative - reserved),
          grant.operation_id,
        );
      }

      this.exec(
        `INSERT INTO global_budget_settlements (
           operation_id, settlement_revision, payload_json, cumulative_charge_micro_usd,
           delta_micro_usd, day_overage_delta_micro_usd, received_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        grant.operation_id,
        req.settlementRevision,
        payload,
        cumulative,
        delta,
        dayOverage,
        now,
      );

      const reasons = new Set<BudgetSyncIncidentReason>();
      if (reportedIncident) reasons.add(reportedIncident);
      if (req.state === 'conservative_billed') reasons.add('usage_missing');
      if (dayOverage > 0) reasons.add('day_ceiling_exceeded');
      if (Math.max(req.chargeMicroUsd, observed ?? 0) > reserved)
        reasons.add('reservation_exceeded');

      let incidentOpened = false;
      for (const reason of reasons) {
        const [incident] = this.exec<{ incident_id: number }>(
          `INSERT INTO global_budget_incidents (operation_id, settlement_revision, reason, opened_at_ms)
           SELECT ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM global_budget_incidents
               WHERE operation_id = ? AND reason = ? AND (resolved_at_ms IS NULL OR ? = 0)
            )
           RETURNING incident_id`,
          grant.operation_id,
          req.settlementRevision,
          reason,
          now,
          grant.operation_id,
          reason,
          delta,
        );
        incidentOpened ||= incident !== undefined;
      }

      const applied = initialSettlement || delta > 0 || incidentOpened;
      return { applied, alreadySettled: !applied, conflict: false, effectiveState, incidentOpened };
    });
  }

  /** Audited storage operation for a trusted administrative caller. */
  resolveIncident(incidentId: number, resolvedBy: string, note: string): boolean {
    if (!resolvedBy.trim() || !note.trim()) return false;
    return this.storage.transactionSync(
      () =>
        this.exec(
          `UPDATE global_budget_incidents SET resolved_at_ms = ?, resolved_by = ?, resolution_note = ?
          WHERE incident_id = ? AND resolved_at_ms IS NULL RETURNING incident_id`,
          this.nowMs(),
          resolvedBy,
          note,
          incidentId,
        ).length === 1,
    );
  }

  nextExpiryAtMs(): number | null {
    return (
      this.exec<{ expires_at_ms: number }>(
        `SELECT expires_at_ms FROM global_budget_reservations
        WHERE state = 'reserved' ORDER BY expires_at_ms, operation_id LIMIT 1`,
      )[0]?.expires_at_ms ?? null
    );
  }

  expireDue(): number {
    return this.storage.transactionSync(() => {
      const now = this.nowMs();
      const due = this.exec<Grant>(
        `SELECT * FROM global_budget_reservations WHERE state = 'reserved' AND expires_at_ms <= ?
          ORDER BY expires_at_ms, operation_id LIMIT ?`,
        now,
        EXPIRY_BATCH_SIZE,
      );
      for (const grant of due) this.expireIfDue(grant, now);
      return due.length;
    });
  }

  private expireIfDue(grant: Grant, now: number): Grant {
    if (grant.state !== 'reserved' || now < grant.expires_at_ms) return grant;
    const amount = grant.amount_micro_usd;
    this.applyCharge(grant.utc_day, amount, amount);
    this.exec(
      `UPDATE global_budget_reservations
          SET state = 'expired_consumed', cumulative_charge_micro_usd = ?
        WHERE operation_id = ?`,
      amount,
      grant.operation_id,
    );
    return { ...grant, state: 'expired_consumed', cumulative_charge_micro_usd: amount };
  }

  private applyCharge(utcDay: string, release: number, delta: number): number {
    const day = this.day(utcDay);
    if (!day) throw new Error('Missing global spend day');

    // V1 charge splitting: honor other grants and track any amount above the available room.
    const remainingReserved = day.reserved_micro_usd - release;
    const room = day.ceiling_micro_usd - remainingReserved - day.consumed_micro_usd;
    const applied = Math.min(delta, room);
    const overage = delta - applied;
    // A single charge is a safe integer. The day's aggregate overage may exceed that range.
    this.exec(
      `UPDATE global_spend_days SET reserved_micro_usd = ?, consumed_micro_usd = ?, overage_micro_usd = ?
        WHERE utc_day = ?`,
      remainingReserved,
      day.consumed_micro_usd + applied,
      (BigInt(day.overage_micro_usd) + BigInt(overage)).toString(),
      utcDay,
    );
    return overage;
  }
}
