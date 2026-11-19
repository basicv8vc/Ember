import {
  MAX_FENCE_EPOCH,
  type OrdinaryOutboxEntityKind,
  type OutboxEntityKind,
  type V2QueueName,
} from './schema.js';

export const V2_DISPATCH_ENVELOPE_SCHEMA_VERSION = 2 as const;
export const BUDGET_SYNC_PAYLOAD_SCHEMA_VERSION = 1 as const;

export const PRE_DEADLINE_RETRY_FLOOR_MS = 1_000;
export const PRE_DEADLINE_RETRY_SAFETY_MARGIN_MS = 5_000;
export const PRE_DEADLINE_RETRY_DEFAULT_GRACE_MS = 60_000;

export const ORDINARY_OUTBOX_ENTITY_KINDS = [
  'turn',
  'task',
  'schedule_occurrence',
  'handoff',
] as const satisfies readonly OrdinaryOutboxEntityKind[];

export const V2_QUEUE_NAMES = [
  'durable_turn',
  'agent_task',
] as const satisfies readonly V2QueueName[];

export const BUDGET_SYNC_SETTLEMENT_STATES = [
  'settled',
  'conservative_billed',
  'unknown_billed',
  'released',
] as const;

export type BudgetSyncSettlementState = (typeof BUDGET_SYNC_SETTLEMENT_STATES)[number];

export const BUDGET_SYNC_INCIDENT_REASONS = [
  'day_ceiling_exceeded',
  'reservation_exceeded',
  'usage_missing',
] as const;

export type BudgetSyncIncidentReason = (typeof BUDGET_SYNC_INCIDENT_REASONS)[number];

/**
 * Closed Queue wake-up envelope per V2-M0-B §2.2 & J5.
 * Carries identifiers and fence epoch only — never prompts, credentials, or `budget_sync`.
 */
export interface V2DispatchEnvelope {
  readonly schemaVersion: 2;
  readonly eventId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly entityKind: OrdinaryOutboxEntityKind;
  readonly entityId: string;
  readonly queueName: V2QueueName;
  readonly fenceEpoch: number;
}

/**
 * Immutable authoritative settlement payload written by Agent A to
 * `v2_dispatch_outbox (entity_kind = 'budget_sync', queue_name = NULL)`.
 * Agent B relays this payload verbatim to GlobalBudgetAuthority without reinterpreting amounts.
 */
export interface BudgetSyncOutboxPayload {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly utcDay: string;
  readonly globalGrantId: string;
  readonly operationId: string;
  readonly settlementRevision: number;
  readonly state: BudgetSyncSettlementState;
  readonly reservedMicroUsd: number;
  readonly chargeMicroUsd: number;
  readonly observedCostMicroUsd: number | null;
  readonly overageMicroUsd: number;
  readonly openIncidentReason: BudgetSyncIncidentReason | null;
}

export interface OutboxEnqueueCommand {
  readonly outboxId: string;
  readonly entityKind: OutboxEntityKind;
  readonly entityId: string;
  readonly queueName: V2QueueName | null;
  readonly payloadJson: string;
  readonly operationId?: string;
  readonly revision?: number;
  readonly fenceEpoch: number;
  readonly nextAttemptAtMs: number;
}

export interface ValidatedOutboxEnqueueCommand extends OutboxEnqueueCommand {
  readonly revision: number;
  readonly operationId: string | undefined;
}

export type DispatchEnvelopeValidationResult =
  | { readonly ok: true; readonly envelope: V2DispatchEnvelope }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type BudgetSyncValidationResult =
  | { readonly ok: true; readonly payload: BudgetSyncOutboxPayload }
  | { readonly ok: false; readonly code: string; readonly message: string };

export class OutboxConstraintError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OutboxConstraintError';
    this.code = code;
  }
}

const ENVELOPE_ALLOWED_KEYS = new Set<string>([
  'schemaVersion',
  'eventId',
  'tenantId',
  'agentId',
  'entityKind',
  'entityId',
  'queueName',
  'fenceEpoch',
]);

const BUDGET_SYNC_ALLOWED_KEYS = new Set<string>([
  'schemaVersion',
  'tenantId',
  'principalId',
  'agentId',
  'utcDay',
  'globalGrantId',
  'operationId',
  'settlementRevision',
  'state',
  'reservedMicroUsd',
  'chargeMicroUsd',
  'observedCostMicroUsd',
  'overageMicroUsd',
  'openIncidentReason',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeSafeInt(value: unknown, max = MAX_FENCE_EPOCH): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function isOrdinaryOutboxEntityKind(value: unknown): value is OrdinaryOutboxEntityKind {
  return (
    value === 'turn' || value === 'task' || value === 'schedule_occurrence' || value === 'handoff'
  );
}

export function isV2QueueName(value: unknown): value is V2QueueName {
  return value === 'durable_turn' || value === 'agent_task';
}

export function validateDispatchEnvelope(input: unknown): DispatchEnvelopeValidationResult {
  if (!isPlainRecord(input)) {
    return { ok: false, code: 'INVALID_ENVELOPE_TYPE', message: 'Envelope must be an object' };
  }

  for (const key of Object.keys(input)) {
    if (!ENVELOPE_ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        code: 'ENVELOPE_UNKNOWN_FIELD',
        message: `Unexpected envelope field '${key}' violates closed-envelope invariant`,
      };
    }
  }

  if (input['schemaVersion'] !== V2_DISPATCH_ENVELOPE_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'ENVELOPE_INVALID_VERSION',
      message: `Expected schemaVersion=2, got ${String(input['schemaVersion'])}`,
    };
  }

  if (input['entityKind'] === 'budget_sync') {
    return {
      ok: false,
      code: 'BUDGET_SYNC_FORBIDDEN_ON_QUEUE',
      message: 'budget_sync must never be dispatched via external V2DispatchEnvelope queues',
    };
  }

  if (!isOrdinaryOutboxEntityKind(input['entityKind'])) {
    return {
      ok: false,
      code: 'ENVELOPE_INVALID_ENTITY_KIND',
      message: `Invalid entityKind '${String(input['entityKind'])}'`,
    };
  }

  if (input['queueName'] === null || !isV2QueueName(input['queueName'])) {
    return {
      ok: false,
      code: 'ENVELOPE_INVALID_QUEUE_NAME',
      message: `Ordinary dispatch envelope requires non-null valid queueName, got ${String(input['queueName'])}`,
    };
  }

  const eventId = input['eventId'];
  const tenantId = input['tenantId'];
  const agentId = input['agentId'];
  const entityId = input['entityId'];
  const fenceEpoch = input['fenceEpoch'];

  if (
    !isNonEmptyString(eventId) ||
    !isNonEmptyString(tenantId) ||
    !isNonEmptyString(agentId) ||
    !isNonEmptyString(entityId)
  ) {
    return {
      ok: false,
      code: 'ENVELOPE_MISSING_IDENTIFIER',
      message: 'Envelope eventId, tenantId, agentId, and entityId must be non-empty strings',
    };
  }

  if (!isNonNegativeSafeInt(fenceEpoch)) {
    return {
      ok: false,
      code: 'ENVELOPE_INVALID_FENCE_EPOCH',
      message: `Invalid fenceEpoch '${String(fenceEpoch)}'`,
    };
  }

  return {
    ok: true,
    envelope: {
      schemaVersion: V2_DISPATCH_ENVELOPE_SCHEMA_VERSION,
      eventId,
      tenantId,
      agentId,
      entityKind: input['entityKind'],
      entityId,
      queueName: input['queueName'],
      fenceEpoch,
    },
  };
}

export function assertValidDispatchEnvelope(input: unknown): V2DispatchEnvelope {
  const result = validateDispatchEnvelope(input);
  if (!result.ok) {
    throw new OutboxConstraintError(result.code, result.message);
  }
  return result.envelope;
}

export function validateBudgetSyncOutboxPayload(input: unknown): BudgetSyncValidationResult {
  if (!isPlainRecord(input)) {
    return {
      ok: false,
      code: 'INVALID_BUDGET_SYNC_PAYLOAD',
      message: 'budget_sync payload must be an object',
    };
  }

  for (const key of Object.keys(input)) {
    if (!BUDGET_SYNC_ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        code: 'BUDGET_SYNC_UNKNOWN_FIELD',
        message: `Unexpected budget_sync field '${key}'`,
      };
    }
  }

  if (input['schemaVersion'] !== BUDGET_SYNC_PAYLOAD_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'BUDGET_SYNC_INVALID_VERSION',
      message: `Expected budget_sync schemaVersion=1, got ${String(input['schemaVersion'])}`,
    };
  }

  const requiredStrings = [
    'tenantId',
    'principalId',
    'agentId',
    'utcDay',
    'globalGrantId',
    'operationId',
  ] as const;
  for (const field of requiredStrings) {
    if (!isNonEmptyString(input[field])) {
      return {
        ok: false,
        code: 'BUDGET_SYNC_MISSING_FIELD',
        message: `budget_sync payload field '${field}' must be a non-empty string`,
      };
    }
  }

  const state = input['state'];
  if (!BUDGET_SYNC_SETTLEMENT_STATES.includes(state as BudgetSyncSettlementState)) {
    return {
      ok: false,
      code: 'BUDGET_SYNC_INVALID_STATE',
      message: `Invalid budget_sync state '${String(state)}'`,
    };
  }

  const settlementRevision = input['settlementRevision'];
  const reservedMicroUsd = input['reservedMicroUsd'];
  const chargeMicroUsd = input['chargeMicroUsd'];
  const overageMicroUsd = input['overageMicroUsd'];
  const observedCostMicroUsd = input['observedCostMicroUsd'];
  const openIncidentReason = input['openIncidentReason'];

  if (
    !isNonNegativeSafeInt(settlementRevision) ||
    !isNonNegativeSafeInt(reservedMicroUsd, Number.MAX_SAFE_INTEGER) ||
    !isNonNegativeSafeInt(chargeMicroUsd, Number.MAX_SAFE_INTEGER) ||
    !isNonNegativeSafeInt(overageMicroUsd, Number.MAX_SAFE_INTEGER)
  ) {
    return {
      ok: false,
      code: 'BUDGET_SYNC_INVALID_INTEGER',
      message:
        'budget_sync settlementRevision, reservedMicroUsd, chargeMicroUsd, and overageMicroUsd must be non-negative safe integers',
    };
  }

  if (
    observedCostMicroUsd !== null &&
    !isNonNegativeSafeInt(observedCostMicroUsd, Number.MAX_SAFE_INTEGER)
  ) {
    return {
      ok: false,
      code: 'BUDGET_SYNC_INVALID_OBSERVED_COST',
      message: 'budget_sync observedCostMicroUsd must be null or a non-negative safe integer',
    };
  }

  if (
    openIncidentReason !== null &&
    !BUDGET_SYNC_INCIDENT_REASONS.includes(openIncidentReason as BudgetSyncIncidentReason)
  ) {
    return {
      ok: false,
      code: 'BUDGET_SYNC_INVALID_INCIDENT_REASON',
      message:
        typeof openIncidentReason === 'string'
          ? `Invalid budget_sync openIncidentReason '${openIncidentReason}'`
          : 'Invalid budget_sync openIncidentReason (expected valid reason string or null)',
    };
  }

  return {
    ok: true,
    payload: {
      schemaVersion: BUDGET_SYNC_PAYLOAD_SCHEMA_VERSION,
      tenantId: input['tenantId'] as string,
      principalId: input['principalId'] as string,
      agentId: input['agentId'] as string,
      utcDay: input['utcDay'] as string,
      globalGrantId: input['globalGrantId'] as string,
      operationId: input['operationId'] as string,
      settlementRevision,
      state: state as BudgetSyncSettlementState,
      reservedMicroUsd,
      chargeMicroUsd,
      observedCostMicroUsd,
      overageMicroUsd,
      openIncidentReason: openIncidentReason as BudgetSyncIncidentReason | null,
    },
  };
}

/**
 * Validates outbox enqueue commands against frozen J1/J5 constraints:
 * - Default initial revision = 0 (strictly safe integer >= 0)
 * - Ordinary dispatch (`turn | task | schedule_occurrence | handoff`): non-null `queueName`
 * - `budget_sync`: `queueName === null`, non-empty `operationId`, and valid verbatim `BudgetSyncOutboxPayload`
 */
export function validateOutboxEnqueueCommand(
  cmd: OutboxEnqueueCommand,
): ValidatedOutboxEnqueueCommand {
  if (!isNonEmptyString(cmd.outboxId) || !isNonEmptyString(cmd.entityId)) {
    throw new OutboxConstraintError(
      'OUTBOX_MISSING_IDENTIFIER',
      'outboxId and entityId must be non-empty strings',
    );
  }
  if (!isNonNegativeSafeInt(cmd.fenceEpoch)) {
    throw new OutboxConstraintError(
      'OUTBOX_INVALID_FENCE_EPOCH',
      `Invalid outbox fenceEpoch: ${String(cmd.fenceEpoch)}`,
    );
  }
  if (!Number.isSafeInteger(cmd.nextAttemptAtMs) || cmd.nextAttemptAtMs < 0) {
    throw new OutboxConstraintError(
      'OUTBOX_INVALID_NEXT_ATTEMPT',
      `Invalid outbox nextAttemptAtMs: ${String(cmd.nextAttemptAtMs)}`,
    );
  }

  const revision = cmd.revision ?? 0;
  if (!isNonNegativeSafeInt(revision)) {
    throw new OutboxConstraintError(
      'OUTBOX_INVALID_REVISION',
      `Outbox revision must be a non-negative integer (initial=0), got ${String(cmd.revision)}`,
    );
  }

  if (cmd.entityKind === 'budget_sync') {
    if (cmd.queueName !== null) {
      throw new OutboxConstraintError(
        'BUDGET_SYNC_NON_NULL_QUEUE',
        `budget_sync outbox must have queueName=null (internal routing only), got '${String(cmd.queueName)}'`,
      );
    }
    if (!isNonEmptyString(cmd.operationId)) {
      throw new OutboxConstraintError(
        'BUDGET_SYNC_MISSING_OPERATION_ID',
        'budget_sync outbox requires a non-empty operationId',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(cmd.payloadJson);
    } catch {
      throw new OutboxConstraintError(
        'BUDGET_SYNC_INVALID_JSON',
        'budget_sync payloadJson must be valid JSON',
      );
    }
    const check = validateBudgetSyncOutboxPayload(parsed);
    if (!check.ok) {
      throw new OutboxConstraintError(check.code, check.message);
    }
    if (check.payload.operationId !== cmd.operationId) {
      throw new OutboxConstraintError(
        'BUDGET_SYNC_OPERATION_MISMATCH',
        `budget_sync payload operationId '${check.payload.operationId}' !== command operationId '${cmd.operationId}'`,
      );
    }
    if (check.payload.settlementRevision !== revision) {
      throw new OutboxConstraintError(
        'BUDGET_SYNC_REVISION_MISMATCH',
        `budget_sync payload settlementRevision ${check.payload.settlementRevision} !== outbox revision ${revision}`,
      );
    }
    return {
      ...cmd,
      revision,
      operationId: cmd.operationId,
    };
  }

  if (!isOrdinaryOutboxEntityKind(cmd.entityKind)) {
    throw new OutboxConstraintError(
      'OUTBOX_INVALID_ENTITY_KIND',
      `Invalid outbox entityKind '${String(cmd.entityKind)}'`,
    );
  }
  if (cmd.queueName === null || !isV2QueueName(cmd.queueName)) {
    throw new OutboxConstraintError(
      'ORDINARY_OUTBOX_NULL_OR_INVALID_QUEUE',
      `Ordinary outbox entityKind '${cmd.entityKind}' requires non-null queueName ('durable_turn' | 'agent_task')`,
    );
  }

  let parsedEnvelope: unknown;
  try {
    parsedEnvelope = JSON.parse(cmd.payloadJson);
  } catch {
    throw new OutboxConstraintError(
      'ORDINARY_OUTBOX_INVALID_JSON',
      'Ordinary outbox payloadJson must be valid JSON V2DispatchEnvelope',
    );
  }
  const envCheck = validateDispatchEnvelope(parsedEnvelope);
  if (!envCheck.ok) {
    throw new OutboxConstraintError(envCheck.code, envCheck.message);
  }
  const env = envCheck.envelope;
  if (
    env.eventId !== cmd.outboxId ||
    env.entityKind !== cmd.entityKind ||
    env.entityId !== cmd.entityId ||
    env.queueName !== cmd.queueName ||
    env.fenceEpoch !== cmd.fenceEpoch
  ) {
    throw new OutboxConstraintError(
      'ORDINARY_OUTBOX_ENVELOPE_MISMATCH',
      'Ordinary outbox payloadJson envelope fields must match outbox columns (eventId, entityKind, entityId, queueName, fenceEpoch)',
    );
  }

  return {
    ...cmd,
    revision,
    operationId: cmd.operationId,
  };
}

export type PreDeadlineRetryDecision =
  | { readonly shouldRetry: false; readonly alarmAtMs: number; readonly remainingMs: number }
  | { readonly shouldRetry: true; readonly nextAttemptAtMs: number; readonly remainingMs: number };

/**
 * Frozen B1 / V2 pre-deadline retry calculation (V2-M0-B §3.3 & J5/P2):
 * - remaining <= 1_000 ms: refuse further retries, arm DO Alarm at `deadlineAtMs` (without cancelling `budget_sync`).
 * - remaining > 1_000 ms: `min(nowMs + graceMs, max(nowMs + 1_000, deadlineAtMs - 5_000))`.
 */
export function computePreDeadlineRetryAtMs(
  nowMs: number,
  deadlineAtMs: number,
  graceMs = PRE_DEADLINE_RETRY_DEFAULT_GRACE_MS,
): PreDeadlineRetryDecision {
  const remainingMs = deadlineAtMs - nowMs;
  if (remainingMs <= PRE_DEADLINE_RETRY_FLOOR_MS) {
    return {
      shouldRetry: false,
      alarmAtMs: deadlineAtMs,
      remainingMs,
    };
  }
  const cappedGraceMs = Math.max(PRE_DEADLINE_RETRY_FLOOR_MS, graceMs);
  const nextAttemptAtMs = Math.min(
    nowMs + cappedGraceMs,
    Math.max(
      nowMs + PRE_DEADLINE_RETRY_FLOOR_MS,
      deadlineAtMs - PRE_DEADLINE_RETRY_SAFETY_MARGIN_MS,
    ),
  );
  return {
    shouldRetry: true,
    nextAttemptAtMs,
    remainingMs,
  };
}
