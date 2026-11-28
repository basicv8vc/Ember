import type {
  B2TaskDelegationCommand,
  CommitTurnSettlementInput,
  MarkAttemptSentRequest,
  MarkAttemptSentResult,
} from '../contracts/agent-head-rpc.js';
import type {
  PersonalMemoryContextItem,
  PersonalMemoryDeleteTurnCommand,
  PersonalMemorySaveTurnCommand,
} from '../contracts/personal-memory.js';
import type { ProactiveScheduleTurnCommand } from '../contracts/proactive-schedules.js';
import type { DurableObjectStorageLike, QueueLike } from '../storage.js';
import { relayDueBudgetSyncBatch, type GlobalBudgetSettlePort } from './budget-sync.js';
import type { V2DispatchEnvelope } from './envelope.js';
import {
  OutboxCoordinator,
  verifyAndClaimDispatchEnvelope,
  type DurableAgentIdentity,
  type VerifyAndClaimDispatchResult,
} from './outbox.js';
import type {
  AgentHeadRecoveryPort,
  AuthoritativeBusinessPort,
  RecoveryRegistryPort,
} from './ports.js';
import {
  AlarmMultiplexer,
  RecoveryCoverageCoordinator,
  type AgentRecoveryTargetPort,
  type AlarmCycleResult,
} from './registry.js';
import type { V2DispatchOutboxRow, V2QueueName, V2RecoveryCoverageRow } from './schema.js';
import { ScheduleRepository } from './schedules.js';

export interface DurableExecutionClaimContext {
  readonly operationId: string;
  readonly entityKind: 'turn' | 'task';
  readonly entityId: string;
  readonly attemptId?: string;
  readonly attemptNo: number;
  readonly sendState: 'unsent' | 'authorizing_unknown' | 'sent';
  readonly sendAuthorizingAtMs: number | null;
  readonly sendStartedAtMs: number | null;
  readonly deadlineAtMs: number | null;
  readonly providerJobHandle: string | null;
  readonly conversationId?: string;
  readonly interactiveHandoff?: boolean;
  readonly inputJson?: string;
  readonly personalMemories?: readonly PersonalMemoryContextItem[];
}

export interface FakeOrProviderJobOutcome {
  readonly status: 'succeeded' | 'failed' | 'retryable_failed' | 'unknown_billed';
  readonly operationId: string;
  readonly providerJobHandle: string | null;
  readonly outputJson: string | null;
  readonly errorCode: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicroUsd: number;
  } | null;
}

/**
 * Provider execution port supporting idempotent job handle polling vs initial dispatch
 * (M1-B4: never blind-replay uncertain or already-sent operations).
 */
export interface DurableProviderExecutorPort {
  pollProviderJob(cmd: {
    readonly providerJobHandle: string;
    readonly operationId: string;
    readonly signal?: AbortSignal;
  }): Promise<FakeOrProviderJobOutcome>;

  startProviderJob(cmd: {
    readonly operationId: string;
    readonly entityKind: 'turn' | 'task';
    readonly entityId: string;
    readonly inputJson?: string;
    readonly signal?: AbortSignal;
  }): Promise<FakeOrProviderJobOutcome>;
}

export type HandoffAdmissionValidation =
  | {
      readonly ok: true;
      readonly preservedDeadlineAtMs: number;
      readonly preservedOperationId: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'LEASE_OWNER_MISMATCH'
        | 'LEASE_EXPIRED'
        | 'DEADLINE_EXPIRED'
        | 'CANCEL_REQUESTED'
        | 'NOT_ACTIVE_FAST_PATH';
    };

/**
 * Validates Fast Path -> Durable Path handoff invariants (V2-M0-B §7 & J4):
 * - Requires active non-expired lease held by caller (`nowMs < leaseExpiresAtMs`)
 * - Rejects cancelled, wrong-owner, non-running, or deadline-expired entities
 * - Preserves original `deadlineAtMs` and `operationId` (never extends deadline)
 */
export function validateHandoffTransition(cmd: {
  readonly status: string;
  readonly leaseOwner: string | null;
  readonly callerLeaseOwner: string;
  readonly leaseExpiresAtMs: number | null;
  readonly deadlineAtMs: number;
  readonly cancelRequestedAtMs: number | null;
  readonly operationId: string;
  readonly nowMs: number;
}): HandoffAdmissionValidation {
  if (cmd.status !== 'running') {
    return { ok: false, code: 'NOT_ACTIVE_FAST_PATH' };
  }
  if (cmd.cancelRequestedAtMs !== null) {
    return { ok: false, code: 'CANCEL_REQUESTED' };
  }
  if (cmd.leaseOwner === null || cmd.leaseOwner !== cmd.callerLeaseOwner) {
    return { ok: false, code: 'LEASE_OWNER_MISMATCH' };
  }
  if (cmd.leaseExpiresAtMs === null || cmd.nowMs >= cmd.leaseExpiresAtMs) {
    return { ok: false, code: 'LEASE_EXPIRED' };
  }
  if (cmd.nowMs >= cmd.deadlineAtMs) {
    return { ok: false, code: 'DEADLINE_EXPIRED' };
  }
  return {
    ok: true,
    preservedDeadlineAtMs: cmd.deadlineAtMs,
    preservedOperationId: cmd.operationId,
  };
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableCounter(value: unknown): value is number | null {
  return value === null || isCounter(value);
}

function assertClaimContext(context: DurableExecutionClaimContext): void {
  const expectedState =
    context.sendStartedAtMs !== null
      ? 'sent'
      : context.sendAuthorizingAtMs !== null
        ? 'authorizing_unknown'
        : 'unsent';
  if (
    !context.operationId ||
    !context.entityId ||
    !isCounter(context.attemptNo) ||
    context.attemptNo < 1 ||
    context.attemptNo > 6 ||
    !isNullableCounter(context.sendStartedAtMs) ||
    !isNullableCounter(context.sendAuthorizingAtMs) ||
    !isNullableCounter(context.deadlineAtMs) ||
    context.sendState !== expectedState ||
    (context.providerJobHandle !== null &&
      (typeof context.providerJobHandle !== 'string' ||
        !context.providerJobHandle ||
        context.sendState === 'unsent'))
  ) {
    throw new Error('Invalid authoritative durable claim context');
  }
}

function uncertainOutcome(context: DurableExecutionClaimContext): FakeOrProviderJobOutcome {
  return {
    status: 'unknown_billed',
    operationId: context.operationId,
    providerJobHandle: null,
    outputJson: null,
    errorCode: 'UNCERTAIN_OUTCOME_NO_BLIND_REPLAY',
    usage: null,
  };
}

/** Model work only: existing handles are query-only; fresh sends require AgentHead authorization. */
export async function executeRecoveredOrFreshDurableWork(cmd: {
  readonly context: DurableExecutionClaimContext;
  readonly provider: DurableProviderExecutorPort;
  readonly sendGate?: {
    readonly markAttemptSent: (req: MarkAttemptSentRequest) => Promise<MarkAttemptSentResult>;
    readonly scope: MarkAttemptSentRequest['scope'];
    readonly leaseEpoch: number;
    readonly leaseOwner: string;
    readonly leaseExpiresAtMs: number;
  };
  readonly nowMs?: () => number;
  readonly signal?: AbortSignal;
}): Promise<FakeOrProviderJobOutcome> {
  const context = cmd.context;
  assertClaimContext(context);
  cmd.signal?.throwIfAborted();
  if (context.providerJobHandle !== null) {
    const outcome = await cmd.provider.pollProviderJob({
      providerJobHandle: context.providerJobHandle,
      operationId: context.operationId,
      signal: cmd.signal,
    });
    if (
      outcome.operationId !== context.operationId ||
      (outcome.providerJobHandle !== null &&
        outcome.providerJobHandle !== context.providerJobHandle)
    ) {
      throw new Error('Provider outcome does not match original durable operation');
    }
    return outcome;
  }

  if (context.sendState !== 'unsent') {
    return uncertainOutcome(context);
  }

  const gate = cmd.sendGate;
  if (gate === undefined) {
    throw new Error('Authoritative durable send gate required');
  }
  const now = cmd.nowMs ?? Date.now;
  const deadline = Math.min(context.deadlineAtMs ?? Infinity, gate.leaseExpiresAtMs);
  if (!Number.isSafeInteger(deadline) || now() >= deadline) {
    return uncertainOutcome(context);
  }
  let authorization: MarkAttemptSentResult;
  try {
    authorization = await gate.markAttemptSent({
      scope: gate.scope,
      subjectType: context.entityKind,
      subjectId: context.entityId,
      attemptNo: context.attemptNo,
      operationId: context.operationId,
      leaseEpoch: gate.leaseEpoch,
      leaseOwner: gate.leaseOwner,
    });
  } catch {
    // The authorization may already be durable. Never replay this operation blindly.
    return uncertainOutcome(context);
  }
  if (
    !authorization.authorized ||
    !isCounter(authorization.startBeforeMs) ||
    cmd.signal?.aborted ||
    now() >= Math.min(deadline, authorization.startBeforeMs)
  ) {
    return uncertainOutcome(context);
  }

  const outcome = await cmd.provider.startProviderJob({
    operationId: context.operationId,
    entityKind: context.entityKind,
    entityId: context.entityId,
    inputJson: context.inputJson,
    signal: cmd.signal,
  });
  if (outcome.operationId !== context.operationId) {
    throw new Error('Provider outcome does not match original durable operation');
  }
  return outcome;
}

/** Never synthesize a model operation ID or infer an unsent state from missing claim fields. */
export function parseClaimExecutionContext(cmd: {
  readonly targetKind: 'turn' | 'task';
  readonly targetId: string;
  readonly leaseEpoch: number;
  readonly contextJson: string;
}): DurableExecutionClaimContext {
  const parsed = JSON.parse(cmd.contextJson) as Record<string, unknown>;
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed['entityKind'] !== cmd.targetKind ||
    parsed['entityId'] !== cmd.targetId ||
    typeof parsed['operationId'] !== 'string' ||
    !isCounter(parsed['attemptNo']) ||
    !isNullableCounter(parsed['sendStartedAtMs']) ||
    !isNullableCounter(parsed['sendAuthorizingAtMs']) ||
    !isNullableCounter(parsed['deadlineAtMs']) ||
    (parsed['sendState'] !== 'unsent' &&
      parsed['sendState'] !== 'authorizing_unknown' &&
      parsed['sendState'] !== 'sent') ||
    (parsed['providerJobHandle'] !== null && typeof parsed['providerJobHandle'] !== 'string')
  ) {
    throw new Error('Invalid authoritative durable claim context');
  }
  const context: DurableExecutionClaimContext = {
    operationId: parsed['operationId'],
    entityKind: cmd.targetKind,
    entityId: cmd.targetId,
    attemptNo: parsed['attemptNo'],
    attemptId: typeof parsed['attemptId'] === 'string' ? parsed['attemptId'] : undefined,
    sendStartedAtMs: parsed['sendStartedAtMs'],
    sendAuthorizingAtMs: parsed['sendAuthorizingAtMs'],
    sendState: parsed['sendState'],
    deadlineAtMs: parsed['deadlineAtMs'],
    providerJobHandle: parsed['providerJobHandle'],
    ...(typeof parsed['conversationId'] === 'string'
      ? { conversationId: parsed['conversationId'] }
      : {}),
    interactiveHandoff:
      typeof parsed['interactiveHandoff'] === 'boolean' ? parsed['interactiveHandoff'] : undefined,
    inputJson:
      typeof parsed['inputJson'] === 'string'
        ? parsed['inputJson']
        : parsed['context'] !== undefined
          ? JSON.stringify(parsed['context'])
          : undefined,
    ...(Array.isArray(parsed['personalMemories'])
      ? { personalMemories: parsePersonalMemoryContextItems(parsed['personalMemories']) }
      : {}),
  };
  assertClaimContext(context);
  return context;
}

function parsePersonalMemoryContextItems(raw: unknown[]): readonly PersonalMemoryContextItem[] {
  const items: PersonalMemoryContextItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    const kind = record['kind'];
    const content = record['content'];
    const key = record['key'];
    if (
      (kind === 'preference' || kind === 'fact') &&
      typeof content === 'string' &&
      content.length > 0
    ) {
      items.push({
        ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
        kind,
        ...(typeof key === 'string' && key.length > 0 ? { key } : {}),
        content,
      });
    }
  }
  return items;
}

function parsePersonalMemorySaveTurnCommand(raw: unknown): PersonalMemorySaveTurnCommand | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  for (const prop of Object.keys(record)) {
    if (prop !== 'kind' && prop !== 'content' && prop !== 'key' && prop !== 'replaceId') {
      return null;
    }
  }
  const kind = record['kind'];
  if (kind !== 'preference' && kind !== 'fact') {
    return null;
  }
  const rawContent = record['content'];
  if (typeof rawContent !== 'string') {
    return null;
  }
  const content = rawContent.trim();
  if (content.length < 1 || content.length > 500 || /\p{Surrogate}/u.test(content)) {
    return null;
  }
  let key: string | undefined;
  const rawKey = record['key'];
  if (rawKey !== undefined) {
    if (typeof rawKey !== 'string') {
      return null;
    }
    const trimmedKey = rawKey.trim().toLowerCase();
    if (
      trimmedKey.length < 1 ||
      trimmedKey.length > 64 ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(trimmedKey)
    ) {
      return null;
    }
    key = trimmedKey;
  }
  let replaceId: string | undefined;
  const rawReplaceId = record['replaceId'];
  if (rawReplaceId !== undefined) {
    if (typeof rawReplaceId !== 'string') {
      return null;
    }
    const normalizedRef = rawReplaceId.trim().replace(/^#+/, '').toLowerCase();
    if (!/^[0-9a-f][0-9a-f-]{3,63}$/.test(normalizedRef)) {
      return null;
    }
    replaceId = normalizedRef;
  }
  return {
    kind,
    content,
    ...(key === undefined ? {} : { key }),
    ...(replaceId === undefined ? {} : { replaceId }),
  };
}

function parsePersonalMemoryDeleteTurnCommand(
  raw: unknown,
): PersonalMemoryDeleteTurnCommand | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  for (const prop of Object.keys(record)) {
    if (prop !== 'targets') {
      return null;
    }
  }
  if (
    !Array.isArray(record['targets']) ||
    record['targets'].length < 1 ||
    record['targets'].length > 10
  ) {
    return null;
  }
  const targets: PersonalMemoryDeleteTurnCommand['targets'][number][] = [];
  for (const entry of record['targets']) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const targetRecord = entry as Record<string, unknown>;
    for (const prop of Object.keys(targetRecord)) {
      if (prop !== 'memoryId' && prop !== 'key' && prop !== 'contentMatch') {
        return null;
      }
    }
    let memoryId: string | undefined;
    if (targetRecord['memoryId'] !== undefined) {
      if (typeof targetRecord['memoryId'] !== 'string') return null;
      const normalizedRef = targetRecord['memoryId'].trim().replace(/^#+/, '').toLowerCase();
      if (!/^[0-9a-f][0-9a-f-]{3,63}$/.test(normalizedRef)) return null;
      memoryId = normalizedRef;
    }
    let key: string | undefined;
    if (targetRecord['key'] !== undefined) {
      if (typeof targetRecord['key'] !== 'string') return null;
      const trimmedKey = targetRecord['key'].trim().toLowerCase();
      if (
        trimmedKey.length < 1 ||
        trimmedKey.length > 64 ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(trimmedKey)
      ) {
        return null;
      }
      key = trimmedKey;
    }
    let contentMatch: string | undefined;
    if (targetRecord['contentMatch'] !== undefined) {
      if (typeof targetRecord['contentMatch'] !== 'string') return null;
      const trimmedMatch = targetRecord['contentMatch'].trim();
      if (
        trimmedMatch.length < 1 ||
        trimmedMatch.length > 200 ||
        /\p{Surrogate}/u.test(trimmedMatch)
      ) {
        return null;
      }
      contentMatch = trimmedMatch;
    }
    if (memoryId === undefined && key === undefined && contentMatch === undefined) {
      return null;
    }
    targets.push({
      ...(memoryId === undefined ? {} : { memoryId }),
      ...(key === undefined ? {} : { key }),
      ...(contentMatch === undefined ? {} : { contentMatch }),
    });
  }
  return { targets };
}

const ALLOWED_PROACTIVE_SCHEDULE_PROPS = new Set([
  'kind',
  'title',
  'prompt',
  'triggerType',
  'fireAt',
  'intervalSeconds',
  'cronExpr',
  'timezone',
  'deliveryMode',
]);
const ISO_OFFSET_REGEX = /(?:Z|[+-]\d{2}:\d{2})$/i;

function parseProactiveScheduleTurnCommand(raw: unknown): ProactiveScheduleTurnCommand | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  for (const prop of Object.keys(record)) {
    if (!ALLOWED_PROACTIVE_SCHEDULE_PROPS.has(prop)) {
      return null;
    }
  }
  const kind = record['kind'];
  if (kind !== 'reminder' && kind !== 'brief' && kind !== 'follow_up') {
    return null;
  }
  const rawTitle = record['title'];
  const rawPrompt = record['prompt'];
  if (typeof rawTitle !== 'string' || typeof rawPrompt !== 'string') {
    return null;
  }
  const title = rawTitle.trim();
  const prompt = rawPrompt.trim();
  if (title.length < 1 || title.length > 140 || prompt.length < 1 || prompt.length > 2_000) {
    return null;
  }
  const triggerType = record['triggerType'];
  if (triggerType !== 'once' && triggerType !== 'interval' && triggerType !== 'cron') {
    return null;
  }
  const rawFireAt = record['fireAt'];
  const rawInterval = record['intervalSeconds'];
  const rawCron = record['cronExpr'];
  const rawTz = record['timezone'];
  const rawDelivery = record['deliveryMode'];

  if (rawFireAt !== undefined && typeof rawFireAt !== 'string') return null;
  if (
    rawInterval !== undefined &&
    (typeof rawInterval !== 'number' ||
      !Number.isInteger(rawInterval) ||
      rawInterval < 60 ||
      rawInterval > 2_592_000)
  ) {
    return null;
  }
  if (rawCron !== undefined && typeof rawCron !== 'string') return null;
  if (rawTz !== undefined && typeof rawTz !== 'string') return null;
  if (
    rawDelivery !== undefined &&
    rawDelivery !== 'direct_reminder' &&
    rawDelivery !== 'model_brief'
  ) {
    return null;
  }

  const fireAt = typeof rawFireAt === 'string' ? rawFireAt.trim() : undefined;
  const cronExpr = typeof rawCron === 'string' ? rawCron.trim() : undefined;
  const timezone = typeof rawTz === 'string' ? rawTz.trim() : undefined;

  if (
    fireAt !== undefined &&
    (fireAt.length === 0 ||
      fireAt.length > 64 ||
      !ISO_OFFSET_REGEX.test(fireAt) ||
      !Number.isFinite(Date.parse(fireAt)))
  ) {
    return null;
  }
  if (cronExpr !== undefined && (cronExpr.length === 0 || cronExpr.length > 120)) return null;
  if (timezone !== undefined && (timezone.length === 0 || timezone.length > 100)) return null;

  if (triggerType === 'once') {
    if (fireAt === undefined || rawInterval !== undefined || cronExpr !== undefined) return null;
  } else if (triggerType === 'interval') {
    if (rawInterval === undefined || cronExpr !== undefined) return null;
  } else if (triggerType === 'cron') {
    if (
      cronExpr === undefined ||
      timezone === undefined ||
      fireAt !== undefined ||
      rawInterval !== undefined
    ) {
      return null;
    }
  }

  return {
    kind,
    title,
    prompt,
    triggerType,
    ...(fireAt !== undefined ? { fireAt } : {}),
    ...(rawInterval !== undefined ? { intervalSeconds: rawInterval } : {}),
    ...(cronExpr !== undefined ? { cronExpr } : {}),
    ...(timezone !== undefined ? { timezone } : {}),
    ...(rawDelivery !== undefined ? { deliveryMode: rawDelivery } : {}),
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELEGATION_OUTER_PROPS = new Set(['toolName', 'title', 'input']);
const NOTES_INPUT_PROPS = new Set(['notes', 'instructions']);
const PYTHON_INPUT_PROPS = new Set(['prompt', 'instructions', 'attachmentIds']);

function readBoundedTrimmedString(raw: unknown, maxChars: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length >= 1 && trimmed.length <= maxChars ? trimmed : null;
}

function parseDelegationCommand(raw: unknown): B2TaskDelegationCommand | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  for (const prop of Object.keys(record)) {
    if (!DELEGATION_OUTER_PROPS.has(prop)) {
      return null;
    }
  }
  let title: string | undefined;
  if (record['title'] !== undefined) {
    const parsedTitle = readBoundedTrimmedString(record['title'], 128);
    if (parsedTitle === null) return null;
    title = parsedTitle;
  }
  const rawInput = record['input'];
  if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return null;
  }
  const inputRecord = rawInput as Record<string, unknown>;

  if (record['toolName'] === 'delegate_notes_action_items') {
    for (const prop of Object.keys(inputRecord)) {
      if (!NOTES_INPUT_PROPS.has(prop)) return null;
    }
    const notes = readBoundedTrimmedString(inputRecord['notes'], 8_000);
    if (notes === null) return null;
    let instructions: string | undefined;
    if (inputRecord['instructions'] !== undefined) {
      instructions = readBoundedTrimmedString(inputRecord['instructions'], 500) ?? undefined;
      if (instructions === undefined) return null;
    }
    return {
      toolName: 'delegate_notes_action_items',
      ...(title !== undefined ? { title } : {}),
      input: { notes, ...(instructions !== undefined ? { instructions } : {}) },
    };
  }

  if (record['toolName'] === 'delegate_python_agent') {
    for (const prop of Object.keys(inputRecord)) {
      if (!PYTHON_INPUT_PROPS.has(prop)) return null;
    }
    const prompt = readBoundedTrimmedString(inputRecord['prompt'], 8_000);
    if (prompt === null) return null;
    let instructions: string | undefined;
    if (inputRecord['instructions'] !== undefined) {
      instructions = readBoundedTrimmedString(inputRecord['instructions'], 500) ?? undefined;
      if (instructions === undefined) return null;
    }
    let attachmentIds: readonly string[] | undefined;
    if (inputRecord['attachmentIds'] !== undefined) {
      if (
        !Array.isArray(inputRecord['attachmentIds']) ||
        inputRecord['attachmentIds'].length > 5 ||
        inputRecord['attachmentIds'].some((id) => typeof id !== 'string' || !UUID_REGEX.test(id))
      ) {
        return null;
      }
      attachmentIds = inputRecord['attachmentIds'] as readonly string[];
    }
    return {
      toolName: 'delegate_python_agent',
      ...(title !== undefined ? { title } : {}),
      input: {
        prompt,
        ...(instructions !== undefined ? { instructions } : {}),
        ...(attachmentIds !== undefined ? { attachmentIds } : {}),
      },
    };
  }

  return null;
}

/**
 * Converts a worker `FakeOrProviderJobOutcome` into the canonical payload expected by
 * Agent A's `AgentHeadRecoveryService.commitDurableResult`.
 */
export function toAgentHeadDurableCommitOutcome(cmd: {
  readonly targetKind: 'turn' | 'task';
  readonly context: DurableExecutionClaimContext;
  readonly outcome: FakeOrProviderJobOutcome;
  readonly modelLabel?: string;
  readonly simulated?: boolean;
}): Record<string, unknown> {
  assertClaimContext(cmd.context);
  if (
    cmd.targetKind !== cmd.context.entityKind ||
    cmd.outcome.operationId !== cmd.context.operationId
  ) {
    throw new Error('Durable settlement does not match original claim');
  }
  const usage = cmd.outcome.usage;
  const settlement: CommitTurnSettlementInput =
    usage !== null && isCounter(usage.costMicroUsd)
      ? {
          state: 'settled',
          outcomeCode: cmd.outcome.status === 'succeeded' ? 'ok' : 'model_unavailable',
          observedCostMicroUsd: usage.costMicroUsd,
          ...(isCounter(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
          ...(isCounter(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
        }
      : {
          state: cmd.outcome.status === 'unknown_billed' ? 'unknown_billed' : 'conservative_billed',
          outcomeCode: 'usage_missing',
        };
  const binding = {
    attemptNo: cmd.context.attemptNo,
    operationId: cmd.context.operationId,
    settlement,
  };
  const fallbackText = cmd.outcome.outputJson ?? '';
  if (cmd.targetKind === 'turn') {
    if (cmd.outcome.status === 'succeeded') {
      let text = fallbackText;
      let delegation: B2TaskDelegationCommand | undefined;
      let personalMemorySave: PersonalMemorySaveTurnCommand | undefined;
      let personalMemoryDelete: PersonalMemoryDeleteTurnCommand | undefined;
      let proactiveScheduleCreate: ProactiveScheduleTurnCommand | undefined;
      if (cmd.outcome.outputJson !== null) {
        try {
          const parsed = JSON.parse(cmd.outcome.outputJson) as Record<string, unknown>;
          if (typeof parsed['text'] === 'string' && parsed['text'].length > 0) {
            text = parsed['text'];
          }
          if (parsed['delegation'] !== undefined) {
            const parsedDelegation = parseDelegationCommand(parsed['delegation']);
            if (parsedDelegation === null) {
              return { ...binding, status: 'failed', failureReason: 'internal_error' };
            }
            delegation = parsedDelegation;
          }
          if (parsed['personalMemorySave'] !== undefined) {
            const parsedMem = parsePersonalMemorySaveTurnCommand(parsed['personalMemorySave']);
            if (parsedMem === null) {
              return { ...binding, status: 'failed', failureReason: 'internal_error' };
            }
            personalMemorySave = parsedMem;
          }
          if (parsed['personalMemoryDelete'] !== undefined) {
            const parsedDelete = parsePersonalMemoryDeleteTurnCommand(
              parsed['personalMemoryDelete'],
            );
            if (parsedDelete === null) {
              return { ...binding, status: 'failed', failureReason: 'internal_error' };
            }
            personalMemoryDelete = parsedDelete;
          }
          if (parsed['proactiveScheduleCreate'] !== undefined) {
            const parsedSched = parseProactiveScheduleTurnCommand(
              parsed['proactiveScheduleCreate'],
            );
            if (parsedSched === null) {
              return { ...binding, status: 'failed', failureReason: 'internal_error' };
            }
            proactiveScheduleCreate = parsedSched;
          }
        } catch {
          // Retain raw outputJson string when non-JSON text is supplied
        }
      }
      if (text.trim().length === 0 || text.length > 8_192) {
        return { ...binding, status: 'failed', failureReason: 'internal_error' };
      }
      return {
        ...binding,
        status: 'completed',
        text,
        ...(delegation !== undefined ? { delegation } : {}),
        ...(personalMemorySave !== undefined ? { personalMemorySave } : {}),
        ...(personalMemoryDelete !== undefined ? { personalMemoryDelete } : {}),
        ...(proactiveScheduleCreate !== undefined ? { proactiveScheduleCreate } : {}),
        ...(cmd.modelLabel !== undefined ? { modelLabel: cmd.modelLabel } : {}),
        ...(cmd.simulated !== undefined ? { simulated: cmd.simulated } : {}),
      };
    }
    return {
      ...binding,
      status: 'failed',
      failureReason: cmd.outcome.errorCode === 'TIMEOUT' ? 'timeout' : 'internal_error',
    };
  }

  const isCompleted = cmd.outcome.status === 'succeeded';
  return {
    ...binding,
    status: isCompleted ? 'completed' : 'failed',
    summaryText: isCompleted ? fallbackText : null,
    detailText: cmd.outcome.outputJson,
    ...(cmd.modelLabel !== undefined ? { modelLabel: cmd.modelLabel } : {}),
    ...(cmd.simulated !== undefined ? { simulated: cmd.simulated } : {}),
    reasonCode: cmd.outcome.errorCode ?? (isCompleted ? 'ok' : 'internal_error'),
  };
}

/**
 * Single cohesive Agent B runtime facade for `AgentHeadDO`, composing ScheduleRepository,
 * OutboxCoordinator, RecoveryCoverageCoordinator, and AlarmMultiplexer without duplicating
 * Agent A's business state machine.
 */
export class AgentEventRuntimeFacade {
  readonly storage: DurableObjectStorageLike;
  readonly identity: DurableAgentIdentity;
  readonly business: AuthoritativeBusinessPort;
  readonly schedules: ScheduleRepository;
  readonly outbox: OutboxCoordinator;
  readonly coverage: RecoveryCoverageCoordinator;
  readonly alarm: AlarmMultiplexer;

  constructor(cmd: {
    readonly storage: DurableObjectStorageLike;
    readonly tenantId: string;
    readonly agentId: string;
    readonly business: AuthoritativeBusinessPort;
    readonly recoveryGraceMs?: number;
    readonly coverageIdleGraceMs?: number;
  }) {
    this.storage = cmd.storage;
    this.identity = { tenantId: cmd.tenantId, agentId: cmd.agentId };
    this.business = cmd.business;
    this.schedules = new ScheduleRepository(cmd.storage.sql);
    this.outbox = new OutboxCoordinator(cmd.storage.sql, {
      storage: cmd.storage,
      business: cmd.business,
    });
    this.coverage = new RecoveryCoverageCoordinator({
      storage: cmd.storage,
      tenantId: cmd.tenantId,
      agentId: cmd.agentId,
      business: cmd.business,
      graceMs: cmd.recoveryGraceMs,
      idleGraceMs: cmd.coverageIdleGraceMs,
    });
    this.alarm = new AlarmMultiplexer({
      storage: cmd.storage,
      business: cmd.business,
      coordinator: this.outbox,
      schedules: this.schedules,
      coverage: this.coverage,
    });
  }

  async verifyAndClaim(cmd: {
    readonly rawEnvelope: unknown;
    readonly expectedQueueName: V2QueueName;
    readonly recoveryPort: Pick<AgentHeadRecoveryPort, 'claimDurableWork'>;
    readonly workerId: string;
    readonly leaseMs: number;
    readonly nowMs: number;
  }): Promise<VerifyAndClaimDispatchResult> {
    return verifyAndClaimDispatchEnvelope({
      rawEnvelope: cmd.rawEnvelope,
      expectedQueueName: cmd.expectedQueueName,
      identity: this.identity,
      storage: this.storage,
      coordinator: this.outbox,
      business: this.business,
      recoveryPort: cmd.recoveryPort,
      workerId: cmd.workerId,
      leaseMs: cmd.leaseMs,
      nowMs: cmd.nowMs,
    });
  }

  async handleAlarm(cmd: {
    readonly nowMs: number;
    readonly queues: Readonly<Record<V2QueueName, QueueLike<V2DispatchEnvelope>>>;
    readonly globalBudget: GlobalBudgetSettlePort;
    readonly registry?: RecoveryRegistryPort;
    readonly batchLimit?: number;
    readonly afterWork?: (nowMs: number) => Promise<unknown>;
  }): Promise<AlarmCycleResult> {
    return this.alarm.runAlarmCycle(cmd);
  }

  asRecoveryTarget(cmd: {
    readonly onRecoveryAlarm: (nowMs: number) => Promise<void>;
    readonly nowMsProvider: () => number;
  }): AgentRecoveryTargetPort {
    return {
      reconcileFromRegistry: (req) =>
        Promise.resolve(
          this.storage.transactionSync(() =>
            this.coverage.reconcileFromRegistrySync({
              expectedGen: req.expectedGen,
              nowMs: req.nowMs,
            }),
          ),
        ),
      confirmRegistryPlan: (req) =>
        Promise.resolve(
          this.storage.transactionSync(() =>
            this.coverage.confirmRegistryPlanSync({
              generation: req.generation,
              actualRecoveryAtMs: req.actualRecoveryAtMs,
              applied: req.applied,
              nowMs: cmd.nowMsProvider(),
            }),
          ),
        ),
      runRecoveryAlarmCycle: cmd.onRecoveryAlarm,
    };
  }

  /**
   * Produces Agent A's `TurnRecoverySeamHooks` / `RecoveryCoordinatorHooks` structure,
   * connecting Agent A's `AgentHeadCore` to Agent B's coverage, outbox, alarm, and verbatim `budget_sync` relay.
   */
  asTurnRecoveryHooks(cmd: {
    readonly globalBudget: GlobalBudgetSettlePort;
    readonly batchLimit?: number;
  }): {
    readonly getCoverageRowSync: () => V2RecoveryCoverageRow | null;
    readonly reconcileCoverageSync: (req: {
      readonly expectedGen: number;
      readonly nowMs: number;
    }) => Awaited<ReturnType<AgentHeadRecoveryPort['reconcileFromRegistry']>>;
    readonly confirmCoveragePlanSync: (req: {
      readonly generation: number;
      readonly actualRecoveryAtMs: number | null;
      readonly applied: boolean;
      readonly nowMs: number;
    }) => { readonly confirmed: boolean };
    readonly getOutboxByIdSync: (outboxId: string) => V2DispatchOutboxRow | null;
    readonly syncPlatformAlarm: (
      targetAlarmAtMs: number | null,
      nowMs: number,
      options?: { readonly forceRearmConsumed?: boolean },
    ) => Promise<boolean>;
    readonly relayBudgetSync: (nowMs: number) => Promise<void>;
  } {
    return {
      getCoverageRowSync: () => this.coverage.getCoverageRowSync(),
      reconcileCoverageSync: (req) => this.coverage.reconcileFromRegistrySync(req),
      confirmCoveragePlanSync: (req) => this.coverage.confirmRegistryPlanSync(req),
      getOutboxByIdSync: (outboxId) => this.outbox.getOutboxByIdSync(outboxId),
      syncPlatformAlarm: (targetAlarmAtMs, nowMs, options) =>
        this.alarm.syncPlatformAlarm(targetAlarmAtMs, nowMs, options),
      relayBudgetSync: async (nowMs) => {
        await relayDueBudgetSyncBatch({
          sql: this.storage.sql,
          storage: this.storage,
          coordinator: this.outbox,
          globalBudget: cmd.globalBudget,
          nowMs,
          limit: cmd.batchLimit,
        });
      },
    };
  }
}
