import type { Id } from '@ember/domain';
import type { BudgetSyncIncidentReason, BudgetSyncSettlementState } from '../recovery/envelope.js';

export type GlobalBudgetGrantState = BudgetSyncSettlementState | 'expired_consumed';

export interface GlobalBudgetReserveRequest {
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly agentId: Id;
  readonly operationId: Id;
  readonly leaseEpoch: number;
  readonly utcDay: string;
  readonly amountMicroUsd: number;
  readonly ceilingMicroUsd: number;
  readonly expiresAtMs: number;
}

export type GlobalBudgetReserveResult =
  | { readonly kind: 'reserved'; readonly globalGrantId: string; readonly replayed: boolean }
  | { readonly kind: 'budget_exceeded' }
  | {
      readonly kind: 'budget_halted';
      readonly reason: BudgetSyncIncidentReason;
    };

export interface GlobalBudgetAuthorizeSendRequest {
  readonly tenantId: Id;
  readonly operationId: Id;
  readonly globalGrantId: string;
}

export type GlobalBudgetAuthorizeSendResult =
  { readonly authorized: true; readonly startBeforeMs: number } | { readonly authorized: false };

export interface GlobalBudgetRenewGrantRequest {
  readonly tenantId: Id;
  readonly operationId: Id;
  readonly globalGrantId: string;
  readonly newExpiresAtMs: number;
}

export interface GlobalBudgetRenewGrantResult {
  readonly renewed: boolean;
  readonly state: string;
}

export interface GlobalBudgetSettleRequest {
  readonly tenantId: Id;
  readonly operationId: Id;
  readonly settlementRevision: number;
  readonly globalGrantId: string;
  readonly state: BudgetSyncSettlementState;
  readonly observedCostMicroUsd?: number | null;
  /**
   * Cumulative corrected charge for this operation:
   * - `released`: `0`
   * - `conservative_billed` / `unknown_billed`: initially `reservedMicroUsd`
   * - `settled`: `observedCostMicroUsd`
   * Global and local ledgers apply incremental delta `newCumulative - previouslyApplied`.
   */
  readonly chargeMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly openIncidentReason?: BudgetSyncIncidentReason;
}

export interface GlobalBudgetSettleResult {
  readonly applied: boolean;
  readonly alreadySettled: boolean;
  readonly conflict: boolean;
  readonly effectiveState: GlobalBudgetGrantState;
  readonly incidentOpened: boolean;
}

/**
 * Authoritative global budget coordination port implemented by Agent E (`GlobalBudgetDO`)
 * and consumed by Agent A (`AgentHeadDO` & `budget_sync` outbox refresher) per V2-M0-A §7.1.
 */
export interface GlobalBudgetAuthority {
  reserveGlobal(req: GlobalBudgetReserveRequest): Promise<GlobalBudgetReserveResult>;

  /**
   * Serially verifies an unused, unexpired Grant and absence of unresolved global incidents,
   * issuing at most one outbound send authorization per operation.
   */
  authorizeGlobalSend(
    req: GlobalBudgetAuthorizeSendRequest,
  ): Promise<GlobalBudgetAuthorizeSendResult>;

  renewGlobalGrant(req: GlobalBudgetRenewGrantRequest): Promise<GlobalBudgetRenewGrantResult>;

  /**
   * Immutable `(tenantId, operationId, settlementRevision)` idempotent settlement & late overage protocol:
   * - `settlementRevision = 0` for initial settlement/release; `>= 1` for late overage adjustments;
   * - Idempotent when replayed with identical payload at the same `(operationId, settlementRevision)`;
   * - Returns `{ applied: false, conflict: true }` on payload mismatch at an already applied revision.
   */
  settleGlobal(req: GlobalBudgetSettleRequest): Promise<GlobalBudgetSettleResult>;
}
