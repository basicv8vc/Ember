import type { B1AssistantTurnDto } from '@ember/contracts';
import type { Id } from '@ember/domain';
import type { PendingAssistantTurn } from './b1-turn-publication.js';

/**
 * Trusted budgets, structurally identical to `@ember/model-gateway`'s ceilings.
 *
 * Declared locally so the persistence package does not depend on the gateway: the repository must
 * be usable (and testable) without any inference code being present at all.
 */
export interface B2BudgetCeilings {
  readonly perAttemptMicroUsd: number;
  readonly principalDailyMicroUsd: number;
  readonly tenantDailyMicroUsd: number;
  readonly globalDailyMicroUsd: number;
  readonly principalDailyTurns: number;
}

/** A claimed Turn: this worker owns publication until the lease expires or the epoch moves. */
export interface B2TurnLease extends PendingAssistantTurn {
  readonly leaseEpoch: number;
  readonly leaseOwner: string;
  readonly deadlineAt: string;
  readonly leaseExpiresAt: string;
}

export type B2ClaimOutcome =
  | { readonly kind: 'claimed'; readonly lease: B2TurnLease }
  | {
      readonly kind: 'not_claimed';
      readonly reason: 'not_found' | 'not_running' | 'deadline_expired' | 'lease_active';
    };

export interface B2AttemptReservation {
  readonly attemptNo: number;
  readonly operationId: Id;
  /** `YYYY-MM-DD` in UTC, sampled from the database clock, not the worker's. */
  readonly utcDay: string;
  readonly reservedMicroUsd: number;
}

export type B2ReserveOutcome =
  | { readonly kind: 'reserved'; readonly attempt: B2AttemptReservation }
  | { readonly kind: 'attempts_exhausted' }
  | { readonly kind: 'budget_exceeded'; readonly scope: 'global' | 'tenant' | 'principal' }
  | { readonly kind: 'principal_unavailable' }
  | { readonly kind: 'lease_lost' };

export interface B2AttemptCharge {
  readonly tenantId: Id;
  readonly turnId: Id;
  readonly attemptNo: number;
  readonly outcomeCode: string;
  /** `settled` books the actual cost; `unknown_billed` keeps the reservation; `released` returns it. */
  readonly state: 'settled' | 'unknown_billed' | 'released';
  readonly observedCostMicroUsd?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
}

export type B2SettlementOutcome =
  | { readonly kind: 'applied'; readonly state: string; readonly appliedMicroUsd: number | null }
  | { readonly kind: 'already_settled'; readonly state: string }
  | { readonly kind: 'not_found' };

export type B2PublicationResult =
  | { readonly outcome: 'published'; readonly turn: B1AssistantTurnDto }
  | { readonly outcome: 'fenced'; readonly turn: B1AssistantTurnDto | null };

export interface B2TurnContextRow {
  readonly sequence: number;
  readonly kind: 'user' | 'ember';
  readonly text: string;
}

export interface B2ReserveAttemptCommand {
  readonly lease: B2TurnLease;
  readonly ceilings: B2BudgetCeilings;
  readonly reservedMicroUsd: number;
  readonly rateVersion: string;
  readonly providerId: 'openai';
  readonly modelLabel: string;
}

export interface B2PublishCommand {
  readonly lease: B2TurnLease;
  readonly result:
    | {
        readonly status: 'completed';
        readonly text: string;
        readonly modelLabel: string;
        readonly simulated: boolean;
      }
    | {
        readonly status: 'failed';
        readonly failureReason: 'timeout' | 'internal_error';
      };
}
