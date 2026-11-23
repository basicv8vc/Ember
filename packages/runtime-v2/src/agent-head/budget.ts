import { DomainError, type Id } from '@ember/domain';
import { V2_BUDGET_LIMITS } from '../contracts/constants.js';
import type { GlobalBudgetAuthority } from '../contracts/global-budget.js';
import { isRealGlobalGrantId } from '../global-budget/platform.js';
import {
  BUDGET_SYNC_PAYLOAD_SCHEMA_VERSION,
  type BudgetSyncIncidentReason,
  type BudgetSyncOutboxPayload,
  type BudgetSyncSettlementState,
} from '../recovery/envelope.js';
import type { EventRuntimeCoordinatorPort } from '../recovery/ports.js';
import type { DurableObjectStorageLike, SqlStorageLike } from '../storage.js';
import type {
  AgentSpendScopeKind,
  ModelAttemptBudgetMode,
  ModelAttemptProviderId,
  ModelAttemptRow,
  ModelAttemptSubjectType,
} from './schema.js';

export interface LocalBudgetCeilings {
  readonly perAttemptMicroUsd: number;
  readonly principalDailyMicroUsd: number;
  readonly tenantDailyMicroUsd: number;
  readonly principalDailyTurns: number;
}

export const DEFAULT_LOCAL_BUDGET_CEILINGS: LocalBudgetCeilings = Object.freeze({
  perAttemptMicroUsd: V2_BUDGET_LIMITS.perAttemptMicroUsd,
  principalDailyMicroUsd: V2_BUDGET_LIMITS.principalDailyMicroUsd,
  tenantDailyMicroUsd: V2_BUDGET_LIMITS.tenantDailyMicroUsd,
  principalDailyTurns: V2_BUDGET_LIMITS.principalDailyTurns,
});

export interface LocalHaltStatus {
  readonly scopeKind: AgentSpendScopeKind;
  readonly reason: BudgetSyncIncidentReason;
}

/**
 * Checks whether an unresolved local `agent_budget_incidents` row blocks paid execution
 * for the given tenant or principal within the requested `budgetMode`.
 */
export function findLocalUnresolvedIncidentSync(
  sql: SqlStorageLike,
  tenantId: Id,
  principalId: Id,
  budgetMode: ModelAttemptBudgetMode,
): LocalHaltStatus | null {
  const row = sql
    .exec<{ readonly scope_kind: AgentSpendScopeKind; readonly reason: BudgetSyncIncidentReason }>(
      `SELECT scope_kind, reason
         FROM agent_budget_incidents
        WHERE resolved_at_ms IS NULL
          AND (budget_mode = ? OR budget_mode IS NULL)
          AND (
            (scope_kind = 'tenant' AND scope_id = ?)
            OR (scope_kind = 'principal' AND scope_id = ?)
          )
        ORDER BY CASE scope_kind WHEN 'tenant' THEN 0 ELSE 1 END, detected_at_ms ASC
        LIMIT 1`,
      budgetMode,
      tenantId,
      principalId,
    )
    .toArray()[0];
  return row === undefined ? null : { scopeKind: row.scope_kind, reason: row.reason };
}

/** Ensures there are no unresolved local incidents in the tenant scope for the given `budgetMode`. */
export function hasAnyUnresolvedLocalIncidentSync(
  sql: SqlStorageLike,
  tenantId: Id,
  principalId: Id,
  budgetMode: ModelAttemptBudgetMode,
): LocalHaltStatus | null {
  return findLocalUnresolvedIncidentSync(sql, tenantId, principalId, budgetMode);
}

function getSpendDayRowSync(
  sql: SqlStorageLike,
  scopeKind: AgentSpendScopeKind,
  scopeId: Id,
  utcDay: string,
  budgetMode: ModelAttemptBudgetMode,
): {
  readonly reserved_micro_usd: number;
  readonly consumed_micro_usd: number;
  readonly turns_started: number;
} {
  const row = sql
    .exec<{
      readonly reserved_micro_usd: number;
      readonly consumed_micro_usd: number;
      readonly turns_started: number;
    }>(
      `SELECT reserved_micro_usd, consumed_micro_usd, turns_started
         FROM agent_spend_days
        WHERE scope_kind = ? AND scope_id = ? AND utc_day = ? AND budget_mode = ?`,
      scopeKind,
      scopeId,
      utcDay,
      budgetMode,
    )
    .toArray()[0];

  return row ?? { reserved_micro_usd: 0, consumed_micro_usd: 0, turns_started: 0 };
}

/**
 * Verifies local tenant/principal daily spend and turn count ceilings BEFORE making any external
 * `GlobalBudgetAuthority.reserveGlobal` call or mutating local spend buckets.
 */
export function checkLocalBudgetCapacitySync(input: {
  readonly sql: SqlStorageLike;
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly utcDay: string;
  readonly budgetMode: ModelAttemptBudgetMode;
  readonly amountMicroUsd: number;
  readonly turnsStartedDelta: number;
  readonly ceilings?: LocalBudgetCeilings;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'budget_halted' | 'budget_exceeded' } {
  const ceilings = input.ceilings ?? DEFAULT_LOCAL_BUDGET_CEILINGS;

  const halt = findLocalUnresolvedIncidentSync(
    input.sql,
    input.tenantId,
    input.principalId,
    input.budgetMode,
  );
  if (halt !== null) {
    return { ok: false, reason: 'budget_halted' };
  }

  if (input.amountMicroUsd > ceilings.perAttemptMicroUsd) {
    return { ok: false, reason: 'budget_exceeded' };
  }

  const tenantBucket = getSpendDayRowSync(
    input.sql,
    'tenant',
    input.tenantId,
    input.utcDay,
    input.budgetMode,
  );
  if (
    tenantBucket.reserved_micro_usd + tenantBucket.consumed_micro_usd + input.amountMicroUsd >
    ceilings.tenantDailyMicroUsd
  ) {
    return { ok: false, reason: 'budget_exceeded' };
  }

  const principalBucket = getSpendDayRowSync(
    sqlOrPass(input.sql),
    'principal',
    input.principalId,
    input.utcDay,
    input.budgetMode,
  );
  if (
    principalBucket.reserved_micro_usd + principalBucket.consumed_micro_usd + input.amountMicroUsd >
      ceilings.principalDailyMicroUsd ||
    principalBucket.turns_started + input.turnsStartedDelta > ceilings.principalDailyTurns
  ) {
    return { ok: false, reason: 'budget_exceeded' };
  }

  return { ok: true };
}

function sqlOrPass(sql: SqlStorageLike): SqlStorageLike {
  return sql;
}

function upsertReserveBucketSync(input: {
  readonly sql: SqlStorageLike;
  readonly scopeKind: AgentSpendScopeKind;
  readonly scopeId: Id;
  readonly utcDay: string;
  readonly budgetMode: ModelAttemptBudgetMode;
  readonly amountMicroUsd: number;
  readonly turnsStartedDelta: number;
  readonly nowMs: number;
}): void {
  input.sql.exec(
    `INSERT INTO agent_spend_days
       (scope_kind, scope_id, utc_day, budget_mode, reserved_micro_usd, consumed_micro_usd, overage_micro_usd, turns_started, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT (scope_kind, scope_id, utc_day, budget_mode) DO UPDATE
        SET reserved_micro_usd = agent_spend_days.reserved_micro_usd + excluded.reserved_micro_usd,
            turns_started = agent_spend_days.turns_started + excluded.turns_started,
            updated_at_ms = excluded.updated_at_ms`,
    input.scopeKind,
    input.scopeId,
    input.utcDay,
    input.budgetMode,
    input.amountMicroUsd,
    input.turnsStartedDelta,
    input.nowMs,
  );
}

/**
 * Reserves local tenant & principal daily spend and inserts the `'reserved'` `model_attempts` row.
 * Throws `DomainError('BUDGET_EXCEEDED', ...)` on capacity or unresolved incident failure.
 */
export function reserveLocalAttemptSync(input: {
  readonly sql: SqlStorageLike;
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly subjectType: ModelAttemptSubjectType;
  readonly subjectId: Id;
  readonly attemptNo: number;
  readonly operationId: Id;
  readonly utcDay: string;
  readonly leaseEpoch: number;
  readonly providerId: ModelAttemptProviderId;
  readonly modelLabel: string;
  readonly rateVersion: string;
  readonly budgetMode: ModelAttemptBudgetMode;
  readonly reservedMicroUsd: number;
  readonly globalGrantId: string | null;
  readonly globalGrantExpiresMs: number | null;
  readonly nowMs: number;
  readonly ceilings?: LocalBudgetCeilings;
}): void {
  const turnsDelta =
    input.subjectType === 'turn' &&
    input.attemptNo === 1 &&
    input.budgetMode !== 'disabled_echo_only'
      ? 1
      : 0;
  const check = checkLocalBudgetCapacitySync({
    sql: input.sql,
    tenantId: input.tenantId,
    principalId: input.principalId,
    utcDay: input.utcDay,
    budgetMode: input.budgetMode,
    amountMicroUsd: input.reservedMicroUsd,
    turnsStartedDelta: turnsDelta,
    ceilings: input.ceilings,
  });
  if (!check.ok) {
    throw new DomainError(
      'BUDGET_EXCEEDED',
      check.reason === 'budget_halted'
        ? 'local unresolved budget incident halts paid model calls'
        : 'local daily budget ceiling exceeded',
    );
  }

  if (input.reservedMicroUsd > 0 || turnsDelta > 0) {
    upsertReserveBucketSync({
      sql: input.sql,
      scopeKind: 'tenant',
      scopeId: input.tenantId,
      utcDay: input.utcDay,
      budgetMode: input.budgetMode,
      amountMicroUsd: input.reservedMicroUsd,
      turnsStartedDelta: 0,
      nowMs: input.nowMs,
    });
    upsertReserveBucketSync({
      sql: input.sql,
      scopeKind: 'principal',
      scopeId: input.principalId,
      utcDay: input.utcDay,
      budgetMode: input.budgetMode,
      amountMicroUsd: input.reservedMicroUsd,
      turnsStartedDelta: turnsDelta,
      nowMs: input.nowMs,
    });
  }

  input.sql.exec(
    `INSERT INTO model_attempts (
       subject_type, subject_id, attempt_no, operation_id, principal_id, utc_day,
       lease_epoch, provider_id, model_label, rate_version, budget_mode, state,
       reserved_micro_usd, applied_cost_micro_usd, overage_micro_usd, settlement_revision,
       global_grant_id, global_grant_expires_ms, started_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, 0, 0, 0, ?, ?, ?)`,
    input.subjectType,
    input.subjectId,
    input.attemptNo,
    input.operationId,
    input.principalId,
    input.utcDay,
    input.leaseEpoch,
    input.providerId,
    input.modelLabel,
    input.rateVersion,
    input.budgetMode,
    input.reservedMicroUsd,
    input.globalGrantId,
    input.globalGrantExpiresMs,
    input.nowMs,
  );
}

function splitBucketCharge(
  reserved: number,
  consumed: number,
  releaseMicroUsd: number,
  chargeDeltaMicroUsd: number,
  ceiling: number,
): {
  readonly nextReserved: number;
  readonly appliedDelta: number;
  readonly overageDelta: number;
} {
  const nextReserved = Math.max(0, reserved - releaseMicroUsd);
  const room = Math.max(0, ceiling - (nextReserved + consumed));
  const appliedDelta = Math.min(chargeDeltaMicroUsd, room);
  const overageDelta = Math.max(0, chargeDeltaMicroUsd - appliedDelta);
  return { nextReserved, appliedDelta, overageDelta };
}

function applyBucketSettlementDeltaSync(input: {
  readonly sql: SqlStorageLike;
  readonly scopeKind: AgentSpendScopeKind;
  readonly scopeId: Id;
  readonly utcDay: string;
  readonly budgetMode: ModelAttemptBudgetMode;
  readonly releaseMicroUsd: number;
  readonly chargeDeltaMicroUsd: number;
  readonly ceiling: number;
  readonly nowMs: number;
}): { readonly appliedDelta: number; readonly overageDelta: number } {
  input.sql.exec(
    `INSERT INTO agent_spend_days
       (scope_kind, scope_id, utc_day, budget_mode, reserved_micro_usd, consumed_micro_usd, overage_micro_usd, turns_started, updated_at_ms)
     VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)
     ON CONFLICT (scope_kind, scope_id, utc_day, budget_mode) DO NOTHING`,
    input.scopeKind,
    input.scopeId,
    input.utcDay,
    input.budgetMode,
    input.nowMs,
  );

  const row = input.sql
    .exec<{ readonly reserved_micro_usd: number; readonly consumed_micro_usd: number }>(
      `SELECT reserved_micro_usd, consumed_micro_usd
         FROM agent_spend_days
        WHERE scope_kind = ? AND scope_id = ? AND utc_day = ? AND budget_mode = ?`,
      input.scopeKind,
      input.scopeId,
      input.utcDay,
      input.budgetMode,
    )
    .one();

  const split = splitBucketCharge(
    row.reserved_micro_usd,
    row.consumed_micro_usd,
    input.releaseMicroUsd,
    input.chargeDeltaMicroUsd,
    input.ceiling,
  );

  input.sql.exec(
    `UPDATE agent_spend_days
        SET reserved_micro_usd = ?,
            consumed_micro_usd = consumed_micro_usd + ?,
            overage_micro_usd = overage_micro_usd + ?,
            updated_at_ms = ?
      WHERE scope_kind = ? AND scope_id = ? AND utc_day = ? AND budget_mode = ?`,
    split.nextReserved,
    split.appliedDelta,
    split.overageDelta,
    input.nowMs,
    input.scopeKind,
    input.scopeId,
    input.utcDay,
    input.budgetMode,
  );

  return { appliedDelta: split.appliedDelta, overageDelta: split.overageDelta };
}

function insertIncidentSync(input: {
  readonly sql: SqlStorageLike;
  readonly id: Id;
  readonly scopeKind: AgentSpendScopeKind;
  readonly scopeId: Id;
  readonly utcDay: string;
  readonly budgetMode: ModelAttemptBudgetMode;
  readonly reason: BudgetSyncIncidentReason;
  readonly subjectType: ModelAttemptSubjectType;
  readonly subjectId: Id;
  readonly attemptNo: number;
  readonly observedMicroUsd: number;
  readonly appliedMicroUsd: number;
  readonly overageMicroUsd: number;
  readonly reservationMicroUsd: number;
  readonly nowMs: number;
}): void {
  input.sql.exec(
    `INSERT INTO agent_budget_incidents (
       id, scope_kind, scope_id, utc_day, budget_mode, reason, subject_type, subject_id, attempt_no,
       observed_micro_usd, applied_micro_usd, overage_micro_usd, reservation_micro_usd, detected_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.scopeKind,
    input.scopeId,
    input.utcDay,
    input.budgetMode,
    input.reason,
    input.subjectType,
    input.subjectId,
    input.attemptNo,
    input.observedMicroUsd,
    input.appliedMicroUsd,
    input.overageMicroUsd,
    input.reservationMicroUsd,
    input.nowMs,
  );
}

export function formatBudgetSyncOutboxId(operationId: Id, settlementRevision: number): string {
  return `budget_sync:${operationId}:rev:${settlementRevision}`;
}

export function buildBudgetSyncOutboxPayload(input: {
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly agentId: Id;
  readonly utcDay: string;
  readonly globalGrantId: string;
  readonly operationId: Id;
  readonly settlementRevision: number;
  readonly state: BudgetSyncSettlementState;
  readonly reservedMicroUsd: number;
  readonly chargeMicroUsd: number;
  readonly observedCostMicroUsd: number | null;
  readonly overageMicroUsd: number;
  readonly openIncidentReason: BudgetSyncIncidentReason | null;
}): BudgetSyncOutboxPayload {
  return {
    schemaVersion: BUDGET_SYNC_PAYLOAD_SCHEMA_VERSION,
    tenantId: input.tenantId,
    principalId: input.principalId,
    agentId: input.agentId,
    utcDay: input.utcDay,
    globalGrantId: input.globalGrantId,
    operationId: input.operationId,
    settlementRevision: input.settlementRevision,
    state: input.state,
    reservedMicroUsd: input.reservedMicroUsd,
    chargeMicroUsd: input.chargeMicroUsd,
    observedCostMicroUsd: input.observedCostMicroUsd,
    overageMicroUsd: input.overageMicroUsd,
    openIncidentReason: input.openIncidentReason,
  };
}

export function enqueueBudgetSyncOutboxSync(input: {
  readonly coordinator: EventRuntimeCoordinatorPort;
  readonly payload: BudgetSyncOutboxPayload;
  readonly fenceEpoch: number;
  readonly nowMs: number;
}): string {
  const outboxId = formatBudgetSyncOutboxId(
    input.payload.operationId,
    input.payload.settlementRevision,
  );
  input.coordinator.enqueueDurableOutboxSync({
    outboxId,
    entityKind: 'budget_sync',
    entityId: input.payload.operationId,
    queueName: null,
    payloadJson: JSON.stringify(input.payload),
    operationId: input.payload.operationId,
    revision: input.payload.settlementRevision,
    fenceEpoch: input.fenceEpoch,
    nextAttemptAtMs: input.nowMs,
  });
  return outboxId;
}

/** Enqueues an authoritative `rev=0` released `budget_sync` compensation outbox row when a global grant is aborted before local commit. */
export function enqueueBudgetReleaseCompensationSync(input: {
  readonly coordinator: EventRuntimeCoordinatorPort;
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly agentId: Id;
  readonly utcDay: string;
  readonly globalGrantId: string;
  readonly operationId: Id;
  readonly reservedMicroUsd: number;
  readonly fenceEpoch: number;
  readonly nowMs: number;
}): string {
  const payload = buildBudgetSyncOutboxPayload({
    tenantId: input.tenantId,
    principalId: input.principalId,
    agentId: input.agentId,
    utcDay: input.utcDay,
    globalGrantId: input.globalGrantId,
    operationId: input.operationId,
    settlementRevision: 0,
    state: 'released',
    reservedMicroUsd: input.reservedMicroUsd,
    chargeMicroUsd: 0,
    observedCostMicroUsd: null,
    overageMicroUsd: 0,
    openIncidentReason: null,
  });
  return enqueueBudgetSyncOutboxSync({
    coordinator: input.coordinator,
    payload,
    fenceEpoch: input.fenceEpoch,
    nowMs: input.nowMs,
  });
}

export interface LocalSettlementResult {
  readonly outcome: 'settled' | 'late_overage_booked' | 'audit_only' | 'already_settled';
  readonly finalState: ModelAttemptRow['state'];
  readonly settlementRevision: number;
  readonly outboxId: string | null;
  readonly incidentsOpened: number;
}

/**
 * Looks up a `model_attempts` row strictly bound to `(subjectType, subjectId, attemptNo, operationId)`.
 */
export function getBoundModelAttemptSync(
  sql: SqlStorageLike,
  subjectType: ModelAttemptSubjectType,
  subjectId: Id,
  attemptNo: number,
  operationId: Id,
): ModelAttemptRow | null {
  return (
    sql
      .exec<ModelAttemptRow & Record<string, string | number | null>>(
        `SELECT *
           FROM model_attempts
          WHERE subject_type = ? AND subject_id = ? AND attempt_no = ? AND operation_id = ?
          LIMIT 1`,
        subjectType,
        subjectId,
        attemptNo,
        operationId,
      )
      .toArray()[0] ?? null
  );
}

/**
 * Returns `true` when settling/reconciling the exact-bound attempt will enqueue a new
 * `budget_sync` outbox obligation requiring confirmed D1 recovery coverage.
 */
export function doesSettlementNeedBudgetCoverageSync(input: {
  readonly sql: SqlStorageLike;
  readonly subjectType: ModelAttemptSubjectType;
  readonly subjectId: Id;
  readonly attemptNo: number;
  readonly operationId: Id;
  readonly observedCostMicroUsd?: number | null;
}): boolean {
  const attempt = getBoundModelAttemptSync(
    input.sql,
    input.subjectType,
    input.subjectId,
    input.attemptNo,
    input.operationId,
  );
  if (attempt === null || attempt.global_grant_id === null) {
    return false;
  }
  if (attempt.state === 'reserved') {
    return true;
  }
  const observed = input.observedCostMicroUsd ?? null;
  if (observed === null) {
    return false;
  }
  const previouslyApplied = attempt.applied_cost_micro_usd ?? attempt.reserved_micro_usd;
  return observed > previouslyApplied;
}

/**
 * Single A-owned exact-binding late settlement / fenced reconciliation path.
 * Never touches active `'reserved'` attempts unless `allowActiveReservedSettle` is explicitly true
 * (e.g. subject already deleted or terminal), preserving original `utc_day` and monotone revisions.
 */
export function reconcileBoundAttemptSettlementSync(input: {
  readonly sql: SqlStorageLike;
  readonly coordinator: EventRuntimeCoordinatorPort;
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly subjectType: ModelAttemptSubjectType;
  readonly subjectId: Id;
  readonly attemptNo: number;
  readonly operationId: Id;
  readonly requestedState: BudgetSyncSettlementState;
  readonly outcomeCode: string;
  readonly observedCostMicroUsd?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly nowMs: number;
  readonly allowActiveReservedSettle: boolean;
  readonly ceilings?: LocalBudgetCeilings;
  readonly idFactory?: () => Id;
}):
  | { readonly matched: false; readonly outboxId: null }
  | {
      readonly matched: true;
      readonly outboxId: string | null;
      readonly result: LocalSettlementResult;
    } {
  const attempt = getBoundModelAttemptSync(
    input.sql,
    input.subjectType,
    input.subjectId,
    input.attemptNo,
    input.operationId,
  );
  if (attempt === null) {
    return { matched: false, outboxId: null };
  }
  if (attempt.state === 'reserved' && !input.allowActiveReservedSettle) {
    return { matched: false, outboxId: null };
  }
  const result = settleLocalAttemptAndEnqueueSync({
    sql: input.sql,
    coordinator: input.coordinator,
    tenantId: input.tenantId,
    agentId: input.agentId,
    attempt,
    requestedState: input.requestedState,
    outcomeCode: input.outcomeCode,
    observedCostMicroUsd: input.observedCostMicroUsd ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    nowMs: input.nowMs,
    ...(input.ceilings !== undefined ? { ceilings: input.ceilings } : {}),
    ...(input.idFactory !== undefined ? { idFactory: input.idFactory } : {}),
  });
  return {
    matched: true,
    outboxId: result.outboxId,
    result,
  };
}

/**
 * Settles (or applies a late overage revision to) a `model_attempts` row and atomically enqueues
 * a `budget_sync` outbox row inside the same SQLite `transactionSync()` whenever `global_grant_id !== null`.
 *
 * Enforces V2-M0-A §5.3 & §7.2 invariants:
 * - Only provably unsent attempts (`send_started_at_ms === null && send_authorizing_at_ms === null`)
 *   may transition to `released`. Sent/uncertain attempts requesting `released` are safely forced
 *   to `unknown_billed` (never refunded).
 * - Initial settlement uses `settlement_revision = 0`; late overage increments `settlement_revision`
 *   monotonically (`>= 1`) and charges only `delta = newCumulativeCharge - previouslyAppliedCharge`.
 * - Missing-usage 2xx (`conservative_billed`) and overages open `agent_budget_incidents`.
 */
export function settleLocalAttemptAndEnqueueSync(input: {
  readonly sql: SqlStorageLike;
  readonly coordinator: EventRuntimeCoordinatorPort;
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly attempt: ModelAttemptRow;
  readonly requestedState: BudgetSyncSettlementState;
  readonly outcomeCode: string;
  readonly observedCostMicroUsd?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly nowMs: number;
  readonly ceilings?: LocalBudgetCeilings;
  readonly idFactory?: () => Id;
}): LocalSettlementResult {
  const { sql, coordinator, attempt, nowMs } = input;
  const ceilings = input.ceilings ?? DEFAULT_LOCAL_BUDGET_CEILINGS;
  const newId = input.idFactory ?? (() => globalThis.crypto.randomUUID());

  const observed = input.observedCostMicroUsd ?? null;

  // Already past 'reserved': check late settlement overage rules (V2-M0-A §5.3 & §7.2 rule 5)
  if (attempt.state !== 'reserved') {
    const previouslyApplied = attempt.applied_cost_micro_usd ?? attempt.reserved_micro_usd;
    if (observed === null) {
      return {
        outcome: 'already_settled',
        finalState: attempt.state,
        settlementRevision: attempt.settlement_revision,
        outboxId: null,
        incidentsOpened: 0,
      };
    }

    // Late overage must NEVER be dropped, even after unknown_billed / conservative_billed / settled
    if (observed > previouslyApplied) {
      const nextRev = attempt.settlement_revision + 1;
      const chargeDelta = observed - previouslyApplied;
      const newOverageTotal = Math.max(0, observed - attempt.reserved_micro_usd);

      const tenantCharge = applyBucketSettlementDeltaSync({
        sql,
        scopeKind: 'tenant',
        scopeId: input.tenantId,
        utcDay: attempt.utc_day,
        budgetMode: attempt.budget_mode,
        releaseMicroUsd: 0,
        chargeDeltaMicroUsd: chargeDelta,
        ceiling: ceilings.tenantDailyMicroUsd,
        nowMs,
      });
      applyBucketSettlementDeltaSync({
        sql,
        scopeKind: 'principal',
        scopeId: attempt.principal_id,
        utcDay: attempt.utc_day,
        budgetMode: attempt.budget_mode,
        releaseMicroUsd: 0,
        chargeDeltaMicroUsd: chargeDelta,
        ceiling: ceilings.principalDailyMicroUsd,
        nowMs,
      });

      const incidentReason: BudgetSyncIncidentReason =
        tenantCharge.overageDelta > 0 ? 'day_ceiling_exceeded' : 'reservation_exceeded';

      insertIncidentSync({
        sql,
        id: newId(),
        scopeKind: 'tenant',
        scopeId: input.tenantId,
        utcDay: attempt.utc_day,
        budgetMode: attempt.budget_mode,
        reason: incidentReason,
        subjectType: attempt.subject_type,
        subjectId: attempt.subject_id,
        attemptNo: attempt.attempt_no,
        observedMicroUsd: observed,
        appliedMicroUsd: tenantCharge.appliedDelta,
        overageMicroUsd: tenantCharge.overageDelta,
        reservationMicroUsd: attempt.reserved_micro_usd,
        nowMs,
      });

      const nextState: ModelAttemptRow['state'] =
        attempt.state === 'unknown_billed' || attempt.state === 'conservative_billed'
          ? attempt.state
          : 'settled';

      sql.exec(
        `UPDATE model_attempts
            SET observed_cost_micro_usd = ?,
                applied_cost_micro_usd = ?,
                overage_micro_usd = ?,
                settlement_revision = ?,
                settled_at_ms = COALESCE(settled_at_ms, ?),
                global_synced_at_ms = NULL
          WHERE subject_type = ? AND subject_id = ? AND attempt_no = ?`,
        observed,
        observed,
        newOverageTotal,
        nextRev,
        nowMs,
        attempt.subject_type,
        attempt.subject_id,
        attempt.attempt_no,
      );

      let outboxId: string | null = null;
      if (attempt.global_grant_id !== null) {
        const payload = buildBudgetSyncOutboxPayload({
          tenantId: input.tenantId,
          principalId: attempt.principal_id,
          agentId: input.agentId,
          utcDay: attempt.utc_day,
          globalGrantId: attempt.global_grant_id,
          operationId: attempt.operation_id,
          settlementRevision: nextRev,
          state: nextState,
          reservedMicroUsd: attempt.reserved_micro_usd,
          chargeMicroUsd: observed,
          observedCostMicroUsd: observed,
          overageMicroUsd: newOverageTotal,
          openIncidentReason: incidentReason,
        });
        outboxId = enqueueBudgetSyncOutboxSync({
          coordinator,
          payload,
          fenceEpoch: attempt.lease_epoch,
          nowMs,
        });
      }

      return {
        outcome: 'late_overage_booked',
        finalState: nextState,
        settlementRevision: nextRev,
        outboxId,
        incidentsOpened: 1,
      };
    }

    // Late observed cost <= previouslyApplied: audit field backfill only if missing, NEVER refund!
    if (attempt.observed_cost_micro_usd === null) {
      sql.exec(
        `UPDATE model_attempts
            SET observed_cost_micro_usd = ?,
                input_tokens = COALESCE(input_tokens, ?),
                output_tokens = COALESCE(output_tokens, ?)
          WHERE subject_type = ? AND subject_id = ? AND attempt_no = ?`,
        observed,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        attempt.subject_type,
        attempt.subject_id,
        attempt.attempt_no,
      );
      return {
        outcome: 'audit_only',
        finalState: attempt.state,
        settlementRevision: attempt.settlement_revision,
        outboxId: null,
        incidentsOpened: 0,
      };
    }

    return {
      outcome: 'already_settled',
      finalState: attempt.state,
      settlementRevision: attempt.settlement_revision,
      outboxId: null,
      incidentsOpened: 0,
    };
  }

  // Initial settlement from 'reserved' at revision = 0
  const provablyUnsent =
    attempt.send_started_at_ms === null && attempt.send_authorizing_at_ms === null;
  const effectiveState: BudgetSyncSettlementState =
    input.requestedState === 'released' && !provablyUnsent
      ? 'unknown_billed'
      : input.requestedState;

  let cumulativeCharge = 0;
  let billingBasis = 'not_billed';
  let observedToPersist: number | null = null;

  if (effectiveState === 'released') {
    cumulativeCharge = 0;
    billingBasis = 'not_billed';
  } else if (effectiveState === 'conservative_billed') {
    cumulativeCharge = attempt.reserved_micro_usd;
    billingBasis = 'conservative_reservation';
  } else if (effectiveState === 'unknown_billed') {
    cumulativeCharge = attempt.reserved_micro_usd;
    billingBasis = 'unknown_billed_reservation';
    observedToPersist = observed;
  } else {
    if (observed === null) {
      throw new DomainError('INVALID_ARGUMENT', 'settled state requires observedCostMicroUsd');
    }
    cumulativeCharge = observed;
    observedToPersist = observed;
    billingBasis = 'provider_usage';
  }

  const releaseFromReserved = attempt.reserved_micro_usd;
  const chargeDelta = cumulativeCharge;
  const overageBeyondReservation = Math.max(0, cumulativeCharge - attempt.reserved_micro_usd);

  let incidentsOpened = 0;
  let openIncidentReason: BudgetSyncIncidentReason | null = null;

  if (releaseFromReserved > 0 || chargeDelta > 0) {
    const tenantCharge = applyBucketSettlementDeltaSync({
      sql,
      scopeKind: 'tenant',
      scopeId: input.tenantId,
      utcDay: attempt.utc_day,
      budgetMode: attempt.budget_mode,
      releaseMicroUsd: releaseFromReserved,
      chargeDeltaMicroUsd: chargeDelta,
      ceiling: ceilings.tenantDailyMicroUsd,
      nowMs,
    });
    applyBucketSettlementDeltaSync({
      sql,
      scopeKind: 'principal',
      scopeId: attempt.principal_id,
      utcDay: attempt.utc_day,
      budgetMode: attempt.budget_mode,
      releaseMicroUsd: releaseFromReserved,
      chargeDeltaMicroUsd: chargeDelta,
      ceiling: ceilings.principalDailyMicroUsd,
      nowMs,
    });

    if (tenantCharge.overageDelta > 0) {
      openIncidentReason = 'day_ceiling_exceeded';
      insertIncidentSync({
        sql,
        id: newId(),
        scopeKind: 'tenant',
        scopeId: input.tenantId,
        utcDay: attempt.utc_day,
        budgetMode: attempt.budget_mode,
        reason: 'day_ceiling_exceeded',
        subjectType: attempt.subject_type,
        subjectId: attempt.subject_id,
        attemptNo: attempt.attempt_no,
        observedMicroUsd: cumulativeCharge,
        appliedMicroUsd: tenantCharge.appliedDelta,
        overageMicroUsd: tenantCharge.overageDelta,
        reservationMicroUsd: attempt.reserved_micro_usd,
        nowMs,
      });
      incidentsOpened += 1;
    } else if (observedToPersist !== null && observedToPersist > attempt.reserved_micro_usd) {
      openIncidentReason = 'reservation_exceeded';
      insertIncidentSync({
        sql,
        id: newId(),
        scopeKind: 'tenant',
        scopeId: input.tenantId,
        utcDay: attempt.utc_day,
        budgetMode: attempt.budget_mode,
        reason: 'reservation_exceeded',
        subjectType: attempt.subject_type,
        subjectId: attempt.subject_id,
        attemptNo: attempt.attempt_no,
        observedMicroUsd: observedToPersist,
        appliedMicroUsd: observedToPersist,
        overageMicroUsd: overageBeyondReservation,
        reservationMicroUsd: attempt.reserved_micro_usd,
        nowMs,
      });
      incidentsOpened += 1;
    }
  }

  if (effectiveState === 'conservative_billed') {
    if (openIncidentReason === null) {
      openIncidentReason = 'usage_missing';
    }
    insertIncidentSync({
      sql,
      id: newId(),
      scopeKind: 'tenant',
      scopeId: input.tenantId,
      utcDay: attempt.utc_day,
      budgetMode: attempt.budget_mode,
      reason: 'usage_missing',
      subjectType: attempt.subject_type,
      subjectId: attempt.subject_id,
      attemptNo: attempt.attempt_no,
      observedMicroUsd: attempt.reserved_micro_usd,
      appliedMicroUsd: attempt.reserved_micro_usd,
      overageMicroUsd: 0,
      reservationMicroUsd: attempt.reserved_micro_usd,
      nowMs,
    });
    incidentsOpened += 1;
  }

  const rev = 0;
  sql.exec(
    `UPDATE model_attempts
        SET state = ?,
            outcome_code = ?,
            applied_cost_micro_usd = ?,
            observed_cost_micro_usd = ?,
            input_tokens = ?,
            output_tokens = ?,
            billing_basis = ?,
            overage_micro_usd = ?,
            settlement_revision = ?,
            settled_at_ms = ?
      WHERE subject_type = ? AND subject_id = ? AND attempt_no = ? AND state = 'reserved'`,
    effectiveState,
    input.outcomeCode,
    cumulativeCharge,
    observedToPersist,
    input.inputTokens ?? null,
    input.outputTokens ?? null,
    billingBasis,
    overageBeyondReservation,
    rev,
    nowMs,
    attempt.subject_type,
    attempt.subject_id,
    attempt.attempt_no,
  );

  let outboxId: string | null = null;
  if (attempt.global_grant_id !== null) {
    const payload = buildBudgetSyncOutboxPayload({
      tenantId: input.tenantId,
      principalId: attempt.principal_id,
      agentId: input.agentId,
      utcDay: attempt.utc_day,
      globalGrantId: attempt.global_grant_id,
      operationId: attempt.operation_id,
      settlementRevision: rev,
      state: effectiveState,
      reservedMicroUsd: attempt.reserved_micro_usd,
      chargeMicroUsd: cumulativeCharge,
      observedCostMicroUsd: observedToPersist,
      overageMicroUsd: overageBeyondReservation,
      openIncidentReason,
    });
    outboxId = enqueueBudgetSyncOutboxSync({
      coordinator,
      payload,
      fenceEpoch: attempt.lease_epoch,
      nowMs,
    });
  }

  return {
    outcome: 'settled',
    finalState: effectiveState,
    settlementRevision: rev,
    outboxId,
    incidentsOpened,
  };
}

/** Structural bridge matching Agent B's `GlobalBudgetSettlePort` (`recovery/budget-sync.ts`). */
export interface AgentBudgetSettleBridgeResult {
  readonly accepted: boolean;
  readonly conflict?: boolean;
  readonly alreadySettled?: boolean;
}

/**
 * Adapts Agent E's authoritative `GlobalBudgetAuthority` to Agent B's `GlobalBudgetSettlePort`
 * used by B's single `relayDueBudgetSyncBatch` relay, stamping local
 * `model_attempts.global_synced_at_ms` strictly upon confirmed Global settlement ACK.
 */
export function createGlobalBudgetSettlePortAdapter(input: {
  readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly globalBudget: GlobalBudgetAuthority;
  readonly realGlobalBudget?: GlobalBudgetAuthority;
  readonly nowMs: () => number;
}): {
  settleGlobal(payload: BudgetSyncOutboxPayload): Promise<AgentBudgetSettleBridgeResult>;
} {
  function selectAuthority(payload: BudgetSyncOutboxPayload): GlobalBudgetAuthority {
    if (input.realGlobalBudget === undefined) {
      return input.globalBudget;
    }
    const attempt = input.storage.sql
      .exec<{ readonly budget_mode: ModelAttemptBudgetMode }>(
        `SELECT budget_mode
           FROM model_attempts
          WHERE operation_id = ?
          LIMIT 1`,
        payload.operationId,
      )
      .toArray()[0];
    if (attempt !== undefined) {
      return attempt.budget_mode === 'real' ? input.realGlobalBudget : input.globalBudget;
    }
    return isRealGlobalGrantId(payload.globalGrantId) ? input.realGlobalBudget : input.globalBudget;
  }

  return {
    async settleGlobal(payload: BudgetSyncOutboxPayload): Promise<AgentBudgetSettleBridgeResult> {
      const authority = selectAuthority(payload);
      const res = await authority.settleGlobal({
        tenantId: payload.tenantId,
        operationId: payload.operationId,
        settlementRevision: payload.settlementRevision,
        globalGrantId: payload.globalGrantId,
        state: payload.state,
        observedCostMicroUsd: payload.observedCostMicroUsd,
        chargeMicroUsd: payload.chargeMicroUsd,
        reservedMicroUsd: payload.reservedMicroUsd,
        ...(payload.openIncidentReason !== null
          ? { openIncidentReason: payload.openIncidentReason }
          : {}),
      });

      const accepted = (res.applied || res.alreadySettled) && !res.conflict;
      if (accepted) {
        const syncedAtMs = input.nowMs();
        input.storage.transactionSync(() => {
          input.storage.sql.exec(
            `UPDATE model_attempts
                SET global_synced_at_ms = ?
              WHERE operation_id = ?
                AND settlement_revision <= ?
                AND global_synced_at_ms IS NULL`,
            syncedAtMs,
            payload.operationId,
            payload.settlementRevision,
          );
        });
      }

      return {
        accepted,
        conflict: res.conflict,
        alreadySettled: res.alreadySettled,
      };
    },
  };
}
