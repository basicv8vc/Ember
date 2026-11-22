import { PYTHON_AGENT_LIMITS } from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import { V2_B1_COMPAT_CONSTANTS, V2_TIMING_LIMITS } from '../contracts/constants.js';
import type {
  B2TaskDelegationCommand,
  CommitTurnRequest,
  CommitTurnResult,
  CommitTurnSettlementInput,
} from '../contracts/agent-head-rpc.js';
import type { V2DispatchEnvelope } from '../recovery/envelope.js';
import type {
  AgentHeadRecoveryPort,
  AuthoritativeBusinessPort,
  EventRuntimeCoordinatorPort,
  RecoveryAdmissionPort,
  RecoveryRegistryPort,
} from '../recovery/ports.js';
import type { V2RecoveryCoverageRow } from '../recovery/schema.js';
import type { DurableObjectStorageLike } from '../storage.js';
import {
  doesSettlementNeedBudgetCoverageSync,
  getBoundModelAttemptSync,
  reconcileBoundAttemptSettlementSync,
  settleLocalAttemptAndEnqueueSync,
  type LocalBudgetCeilings,
} from './budget.js';
import {
  PERSONAL_MEMORY_LIMIT_EXCEEDED_REPLY,
  PERSONAL_MEMORY_SAVED_REPLY,
  PERSONAL_MEMORY_SAVE_UNAVAILABLE_REPLY,
  PERSONAL_MEMORY_UPDATED_REPLY,
  savePersonalMemoryFromTurnSync,
} from './memory-service.js';
import {
  PROACTIVE_SCHEDULE_INVALID_REPLY,
  PROACTIVE_SCHEDULE_UNAVAILABLE_REPLY,
  computeProactiveScheduleDigest,
  createProactiveScheduleFromTurnSync,
  toProactiveScheduleCreateInputFromTurn,
} from './proactive-schedule-service.js';
import {
  allocateConversationSequenceSync,
  getHeadMetaSync,
  getTurnRowSync,
  insertEmberMessageSync,
  prepareEdgeSafeTaskCommand,
  sqlExecMaybe,
  toTurnDto,
} from './queries.js';
import { evaluateTurnFence } from './state-machine.js';

export const SIMULATED_LABEL_PATTERN = /-(fake|echo)-/;
const DEFAULT_PYTHON_TASK_DEADLINE_MS = 120_000;

export interface TurnCommitRecoveryHooks {
  readonly reconcileCoverageSync: (cmd: {
    readonly expectedGen: number;
    readonly nowMs: number;
  }) => Awaited<ReturnType<AgentHeadRecoveryPort['reconcileFromRegistry']>>;
  readonly confirmCoveragePlanSync: (cmd: {
    readonly generation: number;
    readonly actualRecoveryAtMs: number | null;
    readonly applied: boolean;
    readonly nowMs: number;
  }) => { readonly confirmed: boolean };
  readonly syncPlatformAlarm?: (
    targetAlarmAtMs: number | null,
    nowMs: number,
  ) => Promise<boolean | void>;
  readonly relayBudgetSync?: (nowMs: number) => Promise<void>;
  readonly getCoverageRowSync?: () => V2RecoveryCoverageRow | null;
}

export interface CoverageRegistrationResult {
  readonly activeGeneration: number;
  readonly actualRecoveryAtMs: number;
}

export interface CoverageHelperDeps {
  readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly recoveryAdmission: RecoveryAdmissionPort;
  readonly recoveryHooks: TurnCommitRecoveryHooks;
  readonly recoveryRegistry: RecoveryRegistryPort;
  readonly earliestDiscovery: Pick<AuthoritativeBusinessPort, 'earliestRequiredDiscoveryAtMsSync'>;
  readonly nowMs: () => number;
}

export interface TurnCommitDeps extends CoverageHelperDeps {
  readonly eventCoordinator: EventRuntimeCoordinatorPort;
  readonly idFactory: () => Id;
  readonly localCeilings?: LocalBudgetCeilings;
  readonly allowRecurringModelBriefs?: boolean;
}

interface PreparedDelegationPayload {
  readonly kind: 'notes.action_items' | 'python.agent';
  readonly title?: string;
  readonly inputJson: string;
  readonly digest: string;
  readonly idempotencyKey: string;
  readonly traceId: Id;
  readonly executionPath: 'standard' | 'heavy';
  readonly attachmentIds: readonly Id[];
}

export function readCoverageRowSync(deps: {
  readonly storage: Pick<DurableObjectStorageLike, 'sql'>;
  readonly recoveryHooks: Pick<TurnCommitRecoveryHooks, 'getCoverageRowSync'>;
}): V2RecoveryCoverageRow | null {
  if (deps.recoveryHooks.getCoverageRowSync !== undefined) {
    return deps.recoveryHooks.getCoverageRowSync();
  }
  return sqlExecMaybe<V2RecoveryCoverageRow>(
    deps.storage.sql,
    `SELECT * FROM v2_recovery_coverage WHERE id = 1`,
  );
}

export function isCoverageValidAtSync(
  deps: {
    readonly storage: Pick<DurableObjectStorageLike, 'sql'>;
    readonly recoveryHooks: Pick<TurnCommitRecoveryHooks, 'getCoverageRowSync'>;
  },
  requiredRecoveryAtMs: number,
): boolean {
  const cov = readCoverageRowSync(deps);
  return (
    cov !== null &&
    cov.coverage_state === 'covered' &&
    cov.covered_recovery_at_ms !== null &&
    cov.covered_recovery_at_ms <= requiredRecoveryAtMs
  );
}

export async function syncAlarmAndRelayBudget(input: {
  readonly recoveryHooks: Pick<TurnCommitRecoveryHooks, 'syncPlatformAlarm' | 'relayBudgetSync'>;
  readonly alarmAtMs: number | null | undefined;
  readonly nowMs: number;
  readonly shouldRelayBudgetSync: boolean;
  readonly recomputeAlarmSync?: (nowMs: number) => number | null;
}): Promise<void> {
  let relayAttempted = false;
  try {
    if (input.shouldRelayBudgetSync && input.recoveryHooks.relayBudgetSync !== undefined) {
      relayAttempted = true;
      await input.recoveryHooks.relayBudgetSync(input.nowMs);
    }
  } finally {
    if (input.alarmAtMs !== undefined && input.recoveryHooks.syncPlatformAlarm !== undefined) {
      const targetAlarmAtMs = relayAttempted
        ? input.recomputeAlarmSync !== undefined
          ? input.recomputeAlarmSync(input.nowMs)
          : null
        : input.alarmAtMs;
      await input.recoveryHooks.syncPlatformAlarm(targetAlarmAtMs, input.nowMs);
    }
  }
}

export function planHigherGenerationRetrySync(
  deps: CoverageHelperDeps,
  observedGen: number,
  fallbackRequiredMs: number,
): { readonly generation: number; readonly targetAtMs: number } {
  const now = deps.nowMs();
  const earliest = deps.earliestDiscovery.earliestRequiredDiscoveryAtMsSync(now);
  const boundedReq =
    earliest === null ? fallbackRequiredMs : Math.min(earliest, fallbackRequiredMs);

  const planned = deps.recoveryHooks.reconcileCoverageSync({
    expectedGen: observedGen,
    nowMs: now,
  });
  if (planned.action === 'repair_ensure') {
    return {
      generation: planned.generation,
      targetAtMs: Math.min(planned.recoveryAtMs, boundedReq),
    };
  }

  const inspect = deps.recoveryAdmission.inspectCoverageSync(boundedReq, now);
  if (inspect.kind === 'register') {
    return { generation: inspect.generation, targetAtMs: inspect.targetAtMs };
  }
  return { generation: inspect.generation, targetAtMs: inspect.coveredRecoveryAtMs };
}

export async function ensureRecoveryCoverageAsync(
  deps: CoverageHelperDeps,
  input: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly generation: number;
    readonly targetAtMs: number;
    readonly requiredDiscoveryMs: number;
  },
): Promise<CoverageRegistrationResult> {
  let activeGen = input.generation;
  let activeTarget = input.targetAtMs;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let upsertRes:
      | {
          readonly accepted: boolean;
          readonly currentGeneration: number;
          readonly actualRecoveryAtMs: number | null;
        }
      | undefined;
    try {
      upsertRes = await deps.recoveryRegistry.upsertCoverage({
        tenantId: input.tenantId,
        agentId: input.agentId,
        generation: activeGen,
        recoveryAtMs: activeTarget,
        nowMs: deps.nowMs(),
      });
    } catch {
      try {
        const readBack = await deps.recoveryRegistry.getCoverage({
          tenantId: input.tenantId,
          agentId: input.agentId,
        });
        if (
          readBack.exists &&
          readBack.currentGeneration === activeGen &&
          readBack.actualRecoveryAtMs !== null &&
          readBack.actualRecoveryAtMs <= activeTarget
        ) {
          return {
            activeGeneration: activeGen,
            actualRecoveryAtMs: readBack.actualRecoveryAtMs,
          };
        }
        if (attempt === 0 && readBack.exists && readBack.currentGeneration !== null) {
          const observedGen = readBack.currentGeneration;
          const ff = deps.storage.transactionSync(() =>
            planHigherGenerationRetrySync(deps, observedGen, input.requiredDiscoveryMs),
          );
          activeGen = ff.generation;
          activeTarget = ff.targetAtMs;
          continue;
        }
        throw new DomainError('DB_UNAVAILABLE', 'recovery registry upsert failed');
      } catch (err) {
        if (err instanceof DomainError) {
          throw err;
        }
        throw new DomainError('DB_UNAVAILABLE', 'recovery registry unavailable');
      }
    }

    if (
      upsertRes.accepted &&
      upsertRes.actualRecoveryAtMs !== null &&
      upsertRes.actualRecoveryAtMs <= activeTarget
    ) {
      return {
        activeGeneration: upsertRes.currentGeneration,
        actualRecoveryAtMs: upsertRes.actualRecoveryAtMs,
      };
    }

    if (attempt === 0) {
      const observedGen = upsertRes.currentGeneration;
      const ff = deps.storage.transactionSync(() =>
        planHigherGenerationRetrySync(deps, observedGen, input.requiredDiscoveryMs),
      );
      activeGen = ff.generation;
      activeTarget = ff.targetAtMs;
      continue;
    }

    throw new DomainError('DB_UNAVAILABLE', 'recovery registry could not accept coverage');
  }

  throw new DomainError('DB_UNAVAILABLE', 'recovery registry coverage unresolved');
}

/**
 * Ensures D1 recovery coverage exists outside `transactionSync` when an upcoming durable
 * obligation (`budget_sync` or delegated task) is not yet locally covered.
 */
export async function prepareObligationCoverageAsync(
  deps: CoverageHelperDeps,
  input: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly shouldCoverSync: () => boolean;
  },
): Promise<CoverageRegistrationResult | null> {
  const pre = deps.storage.transactionSync(() => {
    const meta = getHeadMetaSync(deps.storage.sql);
    if (meta === null || meta.tenant_id !== input.tenantId || meta.agent_id !== input.agentId) {
      return null;
    }
    if (!input.shouldCoverSync()) {
      return null;
    }
    const nowPre = deps.nowMs();
    const bound = nowPre + V2_TIMING_LIMITS.d1RecoveryGraceMs;
    const plan = deps.recoveryAdmission.inspectCoverageSync(bound, nowPre);
    return plan.kind === 'register'
      ? { generation: plan.generation, targetAtMs: plan.targetAtMs, bound }
      : null;
  });

  if (pre === null) {
    return null;
  }

  return ensureRecoveryCoverageAsync(deps, {
    tenantId: input.tenantId,
    agentId: input.agentId,
    generation: pre.generation,
    targetAtMs: pre.targetAtMs,
    requiredDiscoveryMs: pre.bound,
  });
}

/**
 * Confirms an in-flight D1 coverage registration or verifies existing local coverage atomically
 * inside `transactionSync()`, throwing `DB_UNAVAILABLE` if the durable obligation lacks coverage.
 */
export function confirmOrVerifyCoverageInTxSync(
  deps: Pick<CoverageHelperDeps, 'storage' | 'recoveryAdmission' | 'recoveryHooks'>,
  registration: CoverageRegistrationResult | null,
  boundMs: number,
  nowMs: number,
  errorReason: string,
): void {
  let covered = false;
  if (registration !== null) {
    covered = deps.recoveryAdmission.confirmCoverageSync({
      generation: registration.activeGeneration,
      actualRecoveryAtMs: registration.actualRecoveryAtMs,
      applied: true,
      earliestRequiredRecoveryMs: boundMs,
      nowMs,
    });
  }
  if (!covered) {
    covered = isCoverageValidAtSync(deps, boundMs);
  }
  if (!covered) {
    throw new DomainError('DB_UNAVAILABLE', errorReason);
  }
}

async function prepareDelegationCommand(
  tenantId: Id,
  agentId: Id,
  turnId: Id,
  delegation: B2TaskDelegationCommand,
  newId: () => Id,
): Promise<PreparedDelegationPayload> {
  const idempotencyKey = `turn-delegation:${turnId}:${delegation.toolName}`;

  if (delegation.toolName === 'delegate_notes_action_items') {
    const prepared = await prepareEdgeSafeTaskCommand({
      agentId,
      idempotencyKey,
      kind: 'notes.action_items',
      ...(delegation.title !== undefined ? { title: delegation.title } : {}),
      input: delegation.input,
    });
    return {
      kind: 'notes.action_items',
      ...(delegation.title !== undefined ? { title: delegation.title } : {}),
      inputJson: JSON.stringify(prepared.command.input),
      digest: prepared.digest,
      idempotencyKey,
      traceId: newId(),
      executionPath: 'standard',
      attachmentIds: [],
    };
  }

  const attachmentIds = [
    ...new Set((delegation.input.attachmentIds ?? []).map((id) => id.toLowerCase())),
  ];
  const prepared = await prepareEdgeSafeTaskCommand({
    agentId,
    idempotencyKey,
    kind: 'python.agent',
    ...(delegation.title !== undefined ? { title: delegation.title } : {}),
    input: {
      prompt: delegation.input.prompt,
      ...(delegation.input.instructions !== undefined
        ? { instructions: delegation.input.instructions }
        : {}),
      ...(attachmentIds.length > 0 ? { inputArtifactIds: attachmentIds } : {}),
    },
  });
  return {
    kind: 'python.agent',
    ...(delegation.title !== undefined ? { title: delegation.title } : {}),
    inputJson: JSON.stringify(prepared.command.input),
    digest: prepared.digest,
    idempotencyKey,
    traceId: newId(),
    executionPath: 'heavy',
    attachmentIds,
  };
}

function createOrReuseDelegatedTaskSync(
  deps: TurnCommitDeps,
  tenantId: Id,
  principalId: Id | null,
  agentId: Id,
  conversationId: Id,
  prepared: PreparedDelegationPayload,
  nowMs: number,
): Id {
  const sql = deps.storage.sql;
  const existing = sql
    .exec<{ readonly id: string; readonly digest: string }>(
      `SELECT id, digest FROM tasks WHERE idempotency_key = ?`,
      prepared.idempotencyKey,
    )
    .toArray()[0];

  let taskId: Id;
  if (existing !== undefined) {
    if (existing.digest !== prepared.digest) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'delegated task idempotency key conflicts with existing command',
      );
    }
    taskId = existing.id;
  } else {
    taskId = deps.idFactory();
    const deadlineAtMs =
      prepared.kind === 'python.agent' ? nowMs + DEFAULT_PYTHON_TASK_DEADLINE_MS : null;
    if (prepared.kind === 'python.agent' && prepared.attachmentIds.length > 0) {
      const hasArtifactsTable =
        sql
          .exec<{ readonly name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'v2_task_artifacts'`,
          )
          .toArray().length > 0;
      if (hasArtifactsTable) {
        if (principalId === null) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            'principal is required to bind uploaded attachments',
          );
        }
        const expiryCutoffMs = nowMs - PYTHON_AGENT_LIMITS.maxUploadTtlMs;
        let totalAttachmentBytes = 0;
        for (const uploadId of prepared.attachmentIds) {
          const upload = sqlExecMaybe<{
            readonly id: string;
            readonly task_id: string | null;
            readonly size_bytes: number;
            readonly created_at_ms: number;
          }>(
            sql,
            `SELECT id, task_id, size_bytes, created_at_ms
               FROM v2_task_artifacts
              WHERE id = ? AND tenant_id = ? AND principal_id = ? AND created_by = 'user' AND committed = 1`,
            uploadId,
            tenantId,
            principalId,
          );
          if (
            upload === null ||
            upload.task_id !== null ||
            upload.created_at_ms <= expiryCutoffMs
          ) {
            throw new DomainError(
              'INVALID_ARGUMENT',
              'attachment_id is missing, expired, or already bound',
            );
          }
          totalAttachmentBytes += upload.size_bytes;
        }
        if (totalAttachmentBytes > PYTHON_AGENT_LIMITS.maxTaskTotalFileBytes) {
          throw new DomainError('INVALID_ARGUMENT', 'attachments exceed task file budget');
        }
      }
    }

    sql.exec(
      `INSERT INTO tasks (
         id, kind, title, input_json, digest, idempotency_key, status,
         execution_path, execution_target, attempt_count, max_attempts,
         lease_epoch, next_run_at_ms, deadline_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 'cloud', 0, 3, 1, ?, ?, ?, ?)`,
      taskId,
      prepared.kind,
      prepared.title ?? null,
      prepared.inputJson,
      prepared.digest,
      prepared.idempotencyKey,
      prepared.executionPath,
      nowMs,
      deadlineAtMs,
      nowMs,
      nowMs,
    );

    if (
      prepared.kind === 'python.agent' &&
      prepared.attachmentIds.length > 0 &&
      principalId !== null
    ) {
      const hasArtifactsTable =
        sql
          .exec<{ readonly name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'v2_task_artifacts'`,
          )
          .toArray().length > 0;
      if (hasArtifactsTable) {
        for (const uploadId of prepared.attachmentIds) {
          sql.exec(
            `UPDATE v2_task_artifacts
                SET task_id = ?
              WHERE id = ? AND tenant_id = ? AND principal_id = ? AND task_id IS NULL`,
            taskId,
            uploadId,
            tenantId,
            principalId,
          );
        }
      }
    }
    sql.exec(
      `INSERT INTO task_events (
         id, task_id, sequence, phase, payload_json, trace_id, occurred_at_ms
       ) VALUES (?, ?, 1, 'accepted', ?, ?, ?)`,
      deps.idFactory(),
      taskId,
      JSON.stringify({ taskKind: prepared.kind, replayed: false }),
      prepared.traceId,
      nowMs,
    );
    const outboxId = `task:${taskId}:epoch:1`;
    const envelope: V2DispatchEnvelope = {
      schemaVersion: 2,
      eventId: outboxId,
      tenantId,
      agentId,
      entityKind: 'task',
      entityId: taskId,
      queueName: 'agent_task',
      fenceEpoch: 1,
    };
    deps.eventCoordinator.enqueueDurableOutboxSync({
      outboxId,
      entityKind: 'task',
      entityId: taskId,
      queueName: 'agent_task',
      payloadJson: JSON.stringify(envelope),
      fenceEpoch: 1,
      nextAttemptAtMs: nowMs,
    });
  }

  const existingRef = sql
    .exec<{ readonly id: string }>(
      `SELECT id FROM conversation_messages WHERE task_id = ? AND kind = 'task_reference' LIMIT 1`,
      taskId,
    )
    .toArray()[0];

  if (existingRef === undefined) {
    const seq = allocateConversationSequenceSync(sql, conversationId, nowMs);
    sql.exec(
      `INSERT INTO conversation_messages (
         id, conversation_id, sequence, kind, task_id, created_at_ms
       ) VALUES (?, ?, ?, 'task_reference', ?, ?)`,
      deps.idFactory(),
      conversationId,
      seq,
      taskId,
      nowMs,
    );
  }

  return taskId;
}

/**
 * Single authoritative Turn publication + exact-binding budget reconciliation entry shared between
 * `commitTurn` (interactive / direct RPC) and `commitDurableResult(entityType === 'turn')`.
 *
 * When a turn was cleared by `clearTranscript`, cancelled, expired, or superseded by a newer
 * epoch/worker, no turn publication occurs, while late observed cost on the exact `(turnId,
 * attemptNo, operationId)` operation reconciles atomically onto surviving `model_attempts` rows
 * with confirmed D1 recovery coverage for any new `budget_sync` outbox obligation.
 */
export async function executeAuthoritativeTurnCommit(
  deps: TurnCommitDeps,
  cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId?: Id;
    readonly turnId: Id;
    readonly attemptNo: number;
    readonly operationId: Id;
    readonly settlement: CommitTurnSettlementInput;
    readonly throwOnScopeMismatch: boolean;
  } & (
    | {
        readonly leaseEpoch: number;
        readonly leaseOwner: string;
        readonly result: CommitTurnRequest['result'];
        readonly allowDeadlineTimeoutPublish: boolean;
      }
    | { readonly accountingOnly: true }
  ),
): Promise<CommitTurnResult> {
  const publication = 'leaseEpoch' in cmd ? cmd : null;
  if (
    publication?.result.status === 'completed' &&
    !publication.result.simulated &&
    SIMULATED_LABEL_PATTERN.test(publication.result.modelLabel)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'simulated model label cannot be committed with simulated=false',
    );
  }

  let preparedDelegation: PreparedDelegationPayload | null = null;
  if (publication?.result.status === 'completed' && publication.result.delegation !== undefined) {
    let delegation = publication.result.delegation;
    if (
      delegation.toolName === 'delegate_python_agent' &&
      (delegation.input.attachmentIds === undefined || delegation.input.attachmentIds.length === 0)
    ) {
      const attachedRows = deps.storage.sql
        .exec<{ readonly upload_id: string }>(
          `SELECT ma.upload_id
             FROM assistant_turns t
             JOIN message_attachments ma ON ma.message_id = t.source_message_id
            WHERE t.id = ?
            ORDER BY ma.position ASC`,
          cmd.turnId,
        )
        .toArray();
      if (attachedRows.length > 0) {
        delegation = {
          ...delegation,
          input: {
            ...delegation.input,
            attachmentIds: attachedRows.map((row) => row.upload_id),
          },
        };
      }
    }
    preparedDelegation = await prepareDelegationCommand(
      cmd.tenantId,
      cmd.agentId,
      cmd.turnId,
      delegation,
      deps.idFactory,
    );
  }

  let preparedSchedule: {
    readonly input: ReturnType<typeof toProactiveScheduleCreateInputFromTurn>;
    readonly digest: string;
  } | null = null;
  if (
    publication?.result.status === 'completed' &&
    publication.result.proactiveScheduleCreate !== undefined
  ) {
    const scheduleInput = toProactiveScheduleCreateInputFromTurn(
      cmd.turnId,
      publication.result.proactiveScheduleCreate,
    );
    const digest = await computeProactiveScheduleDigest(scheduleInput);
    preparedSchedule = { input: scheduleInput, digest };
  }

  const coverageRegistration = await prepareObligationCoverageAsync(deps, {
    tenantId: cmd.tenantId,
    agentId: cmd.agentId,
    shouldCoverSync: () => {
      const bound = deps.nowMs() + V2_TIMING_LIMITS.d1RecoveryGraceMs;
      if (isCoverageValidAtSync(deps, bound)) {
        return false;
      }
      if (preparedDelegation !== null || preparedSchedule !== null) {
        const turn = getTurnRowSync(deps.storage.sql, cmd.turnId);
        if (turn !== null && turn.status === 'running') {
          return true;
        }
      }
      return doesSettlementNeedBudgetCoverageSync({
        sql: deps.storage.sql,
        subjectType: 'turn',
        subjectId: cmd.turnId,
        attemptNo: cmd.attemptNo,
        operationId: cmd.operationId,
        observedCostMicroUsd: cmd.settlement.observedCostMicroUsd ?? null,
      });
    },
  });

  const tx = deps.storage.transactionSync(() => {
    const nowMs = deps.nowMs();
    const meta = getHeadMetaSync(deps.storage.sql);
    if (meta === null || meta.tenant_id !== cmd.tenantId || meta.agent_id !== cmd.agentId) {
      if (cmd.throwOnScopeMismatch) {
        throw new DomainError(
          'POLICY_DENIED',
          'caller scope does not match agent head DO tenant/agent identity',
        );
      }
      return {
        result: { outcome: 'fenced' as const, turn: null },
        alarmAtMs: undefined as number | null | undefined,
        nowMs,
        hasBudgetSync: false,
      };
    }

    const turn = getTurnRowSync(deps.storage.sql, cmd.turnId);
    const attempt = getBoundModelAttemptSync(
      deps.storage.sql,
      'turn',
      cmd.turnId,
      cmd.attemptNo,
      cmd.operationId,
    );
    const hasAnyAttemptForTurn =
      attempt !== null ||
      deps.storage.sql
        .exec<{ readonly hit: number }>(
          `SELECT 1 AS hit FROM model_attempts WHERE subject_type = 'turn' AND subject_id = ? LIMIT 1`,
          cmd.turnId,
        )
        .toArray().length > 0;
    const attemptBindingValid =
      attempt !== null ||
      (publication?.allowDeadlineTimeoutPublish &&
        !hasAnyAttemptForTurn &&
        cmd.attemptNo === 1 &&
        (cmd.settlement.observedCostMicroUsd ?? null) === null);

    const conversationMismatch =
      turn !== null &&
      cmd.conversationId !== undefined &&
      turn.conversation_id !== cmd.conversationId;
    const fence =
      turn === null || publication === null
        ? ({ ok: false, reason: 'terminal' } as const)
        : evaluateTurnFence(turn, publication.leaseEpoch, publication.leaseOwner, nowMs, {
            allowCancelRequested: true,
          });
    const deadlineTimeoutOverride =
      turn !== null &&
      publication?.allowDeadlineTimeoutPublish &&
      turn.status === 'running' &&
      !fence.ok &&
      fence.reason === 'expired' &&
      nowMs >= turn.deadline_at_ms &&
      turn.lease_owner === publication.leaseOwner &&
      turn.lease_epoch === publication.leaseEpoch;

    const authorizedToPublish =
      turn !== null &&
      !conversationMismatch &&
      attemptBindingValid &&
      (fence.ok || deadlineTimeoutOverride);

    if (publication === null || !authorizedToPublish) {
      let alarmAtMs: number | null | undefined;
      let hasBudgetSync = false;

      const mayHaveSent =
        attempt !== null &&
        (attempt.send_started_at_ms !== null || attempt.send_authorizing_at_ms !== null);
      if (!conversationMismatch && attempt !== null && (publication !== null || mayHaveSent)) {
        const allowActiveReservedSettle =
          publication === null ||
          turn === null ||
          turn.status !== 'running' ||
          (mayHaveSent && cmd.settlement.observedCostMicroUsd != null);
        const needsBudgetCoverage =
          (attempt.state !== 'reserved' || allowActiveReservedSettle) &&
          doesSettlementNeedBudgetCoverageSync({
            sql: deps.storage.sql,
            subjectType: 'turn',
            subjectId: cmd.turnId,
            attemptNo: cmd.attemptNo,
            operationId: cmd.operationId,
            observedCostMicroUsd: cmd.settlement.observedCostMicroUsd ?? null,
          });

        if (needsBudgetCoverage) {
          confirmOrVerifyCoverageInTxSync(
            deps,
            coverageRegistration,
            nowMs + V2_TIMING_LIMITS.d1RecoveryGraceMs,
            nowMs,
            'recovery coverage lost or insufficient for late budget_sync',
          );
        }

        const reconciled = reconcileBoundAttemptSettlementSync({
          sql: deps.storage.sql,
          coordinator: deps.eventCoordinator,
          tenantId: cmd.tenantId,
          agentId: cmd.agentId,
          subjectType: 'turn',
          subjectId: cmd.turnId,
          attemptNo: cmd.attemptNo,
          operationId: cmd.operationId,
          requestedState: cmd.settlement.state,
          outcomeCode: cmd.settlement.outcomeCode,
          observedCostMicroUsd: cmd.settlement.observedCostMicroUsd ?? null,
          inputTokens: cmd.settlement.inputTokens ?? null,
          outputTokens: cmd.settlement.outputTokens ?? null,
          nowMs,
          allowActiveReservedSettle,
          ...(deps.localCeilings !== undefined ? { ceilings: deps.localCeilings } : {}),
          idFactory: deps.idFactory,
        });
        if (reconciled.matched && reconciled.outboxId !== null) {
          hasBudgetSync = true;
          alarmAtMs = deps.eventCoordinator.recomputeAlarmSync(nowMs);
        } else if (reconciled.matched) {
          alarmAtMs = deps.eventCoordinator.recomputeAlarmSync(nowMs);
        }
      }

      return {
        result: { outcome: 'fenced' as const, turn: turn === null ? null : toTurnDto(turn) },
        alarmAtMs,
        nowMs,
        hasBudgetSync,
      };
    }

    let hasBudgetSync = false;
    if (attempt !== null) {
      if (
        doesSettlementNeedBudgetCoverageSync({
          sql: deps.storage.sql,
          subjectType: 'turn',
          subjectId: cmd.turnId,
          attemptNo: cmd.attemptNo,
          operationId: cmd.operationId,
          observedCostMicroUsd: cmd.settlement.observedCostMicroUsd ?? null,
        })
      ) {
        confirmOrVerifyCoverageInTxSync(
          deps,
          coverageRegistration,
          nowMs + V2_TIMING_LIMITS.d1RecoveryGraceMs,
          nowMs,
          'recovery coverage lost or insufficient for budget_sync',
        );
      }

      const settled = settleLocalAttemptAndEnqueueSync({
        sql: deps.storage.sql,
        coordinator: deps.eventCoordinator,
        tenantId: cmd.tenantId,
        agentId: cmd.agentId,
        attempt,
        requestedState: cmd.settlement.state,
        outcomeCode: cmd.settlement.outcomeCode,
        observedCostMicroUsd: cmd.settlement.observedCostMicroUsd ?? null,
        inputTokens: cmd.settlement.inputTokens ?? null,
        outputTokens: cmd.settlement.outputTokens ?? null,
        nowMs,
        ...(deps.localCeilings !== undefined ? { ceilings: deps.localCeilings } : {}),
        idFactory: deps.idFactory,
      });
      hasBudgetSync = settled.outboxId !== null;
    }

    if (turn.cancel_requested_at_ms !== null) {
      deps.storage.sql.exec(
        `UPDATE assistant_turns
            SET status = 'cancelled',
                failure_reason = NULL,
                response_message_id = NULL,
                lease_owner = NULL,
                lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ?`,
        nowMs,
        turn.id,
      );
      deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
      deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      const alarmAtMs = deps.eventCoordinator.recomputeAlarmSync(nowMs);
      const updated = getTurnRowSync(deps.storage.sql, turn.id)!;
      return {
        result: { outcome: 'reconciled_only' as const, turn: toTurnDto(updated) },
        alarmAtMs,
        nowMs,
        hasBudgetSync,
      };
    }

    if (nowMs >= turn.deadline_at_ms) {
      const { messageId, sequence } = insertEmberMessageSync({
        sql: deps.storage.sql,
        messageId: deps.idFactory(),
        conversationId: turn.conversation_id,
        text: V2_B1_COMPAT_CONSTANTS.failureAssistantMessageText,
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
        nowMs,
      });
      deps.storage.sql.exec(
        `UPDATE assistant_turns
            SET status = 'failed',
                failure_reason = 'timeout',
                response_message_id = ?,
                lease_owner = NULL,
                lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ?`,
        messageId,
        nowMs,
        turn.id,
      );
      deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
      deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      const alarmAtMs = deps.eventCoordinator.recomputeAlarmSync(nowMs);
      const updated = getTurnRowSync(deps.storage.sql, turn.id)!;
      if (publication.result.status === 'failed') {
        return {
          result: {
            outcome: 'published' as const,
            turn: toTurnDto(updated),
            responseMessageId: messageId,
            sequence,
            delegatedTaskId: null,
          },
          alarmAtMs,
          nowMs,
          hasBudgetSync,
        };
      }
      return {
        result: { outcome: 'reconciled_only' as const, turn: toTurnDto(updated) },
        alarmAtMs,
        nowMs,
        hasBudgetSync,
      };
    }

    if (publication.result.status === 'aborted_for_retry_or_reconcile') {
      const nextEpoch = turn.lease_epoch + 1;
      deps.storage.sql.exec(
        `UPDATE assistant_turns
            SET execution_mode = 'durable_queue',
                lease_epoch = ?,
                lease_owner = NULL,
                lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ?`,
        nextEpoch,
        nowMs,
        turn.id,
      );
      deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
      deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      const outboxId = `turn:${turn.id}:epoch:${nextEpoch}`;
      const envelope: V2DispatchEnvelope = {
        schemaVersion: 2,
        eventId: outboxId,
        tenantId: cmd.tenantId,
        agentId: cmd.agentId,
        entityKind: 'turn',
        entityId: turn.id,
        queueName: 'durable_turn',
        fenceEpoch: nextEpoch,
      };
      deps.eventCoordinator.enqueueDurableOutboxSync({
        outboxId,
        entityKind: 'turn',
        entityId: turn.id,
        queueName: 'durable_turn',
        payloadJson: JSON.stringify(envelope),
        fenceEpoch: nextEpoch,
        nextAttemptAtMs: nowMs,
      });
      const alarmAtMs = deps.eventCoordinator.recomputeAlarmSync(nowMs);
      const updated = getTurnRowSync(deps.storage.sql, turn.id)!;
      return {
        result: { outcome: 'reconciled_only' as const, turn: toTurnDto(updated) },
        alarmAtMs,
        nowMs,
        hasBudgetSync,
      };
    }

    if (publication.result.status === 'failed') {
      const { messageId, sequence } = insertEmberMessageSync({
        sql: deps.storage.sql,
        messageId: deps.idFactory(),
        conversationId: turn.conversation_id,
        text: V2_B1_COMPAT_CONSTANTS.failureAssistantMessageText,
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
        nowMs,
      });
      deps.storage.sql.exec(
        `UPDATE assistant_turns
            SET status = 'failed',
                failure_reason = ?,
                response_message_id = ?,
                lease_owner = NULL,
                lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ?`,
        publication.result.failureReason,
        messageId,
        nowMs,
        turn.id,
      );
      deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
      deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      const alarmAtMs = deps.eventCoordinator.recomputeAlarmSync(nowMs);
      const updated = getTurnRowSync(deps.storage.sql, turn.id)!;
      return {
        result: {
          outcome: 'published' as const,
          turn: toTurnDto(updated),
          responseMessageId: messageId,
          sequence,
          delegatedTaskId: null,
        },
        alarmAtMs,
        nowMs,
        hasBudgetSync,
      };
    }

    let delegatedTaskId: Id | null = null;
    if (preparedDelegation !== null) {
      confirmOrVerifyCoverageInTxSync(
        deps,
        coverageRegistration,
        nowMs + V2_TIMING_LIMITS.d1RecoveryGraceMs,
        nowMs,
        'recovery coverage lost or insufficient for delegated task',
      );
      delegatedTaskId = createOrReuseDelegatedTaskSync(
        deps,
        cmd.tenantId,
        attempt?.principal_id ?? null,
        cmd.agentId,
        turn.conversation_id,
        preparedDelegation,
        nowMs,
      );
    }

    let assistantText = publication.result.text;
    if (publication.result.personalMemorySave !== undefined) {
      if (attempt === null) {
        assistantText = PERSONAL_MEMORY_SAVE_UNAVAILABLE_REPLY;
      } else {
        const saved = savePersonalMemoryFromTurnSync(deps.storage.sql, {
          tenantId: cmd.tenantId,
          principalId: attempt.principal_id,
          turnId: turn.id,
          conversationId: turn.conversation_id,
          sourceMessageId: turn.source_message_id,
          input: publication.result.personalMemorySave,
          nowMs,
          newId: deps.idFactory,
        });
        assistantText =
          saved.outcome === 'budget_exceeded'
            ? PERSONAL_MEMORY_LIMIT_EXCEEDED_REPLY
            : saved.created
              ? PERSONAL_MEMORY_SAVED_REPLY
              : PERSONAL_MEMORY_UPDATED_REPLY;
      }
    }

    if (preparedSchedule !== null) {
      if (attempt === null) {
        assistantText = PROACTIVE_SCHEDULE_UNAVAILABLE_REPLY;
      } else {
        confirmOrVerifyCoverageInTxSync(
          deps,
          coverageRegistration,
          nowMs + V2_TIMING_LIMITS.d1RecoveryGraceMs,
          nowMs,
          'proactive schedule recovery coverage unavailable',
        );
        const created = createProactiveScheduleFromTurnSync(deps.storage.sql, {
          tenantId: cmd.tenantId,
          principalId: attempt.principal_id,
          agentId: cmd.agentId,
          input: preparedSchedule.input,
          digest: preparedSchedule.digest,
          nowMs: nowMs,
          newId: deps.idFactory,
          ...(deps.allowRecurringModelBriefs === undefined
            ? {}
            : { allowRecurringModelBriefs: deps.allowRecurringModelBriefs }),
        });
        if (created.outcome === 'invalid') {
          assistantText = PROACTIVE_SCHEDULE_INVALID_REPLY;
        } else if (created.outcome === 'policy_denied') {
          assistantText = created.message;
        } else {
          assistantText = created.confirmationText;
        }
      }
    }

    const { messageId, sequence } = insertEmberMessageSync({
      sql: deps.storage.sql,
      messageId: deps.idFactory(),
      conversationId: turn.conversation_id,
      text: assistantText,
      modelLabel: publication.result.modelLabel,
      simulated: publication.result.simulated,
      nowMs,
    });

    deps.storage.sql.exec(
      `UPDATE assistant_turns
          SET status = 'completed',
              response_message_id = ?,
              linked_task_id = ?,
              lease_owner = NULL,
              lease_expires_at_ms = NULL,
              updated_at_ms = ?
        WHERE id = ?`,
      messageId,
      delegatedTaskId,
      nowMs,
      turn.id,
    );
    deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
    deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
    const alarmAtMs = deps.eventCoordinator.recomputeAlarmSync(nowMs);

    const updated = getTurnRowSync(deps.storage.sql, turn.id)!;
    return {
      result: {
        outcome: 'published' as const,
        turn: toTurnDto(updated),
        responseMessageId: messageId,
        sequence,
        delegatedTaskId,
      },
      alarmAtMs,
      nowMs,
      hasBudgetSync,
    };
  });

  await syncAlarmAndRelayBudget({
    recoveryHooks: deps.recoveryHooks,
    alarmAtMs: tx.alarmAtMs,
    nowMs: tx.nowMs,
    shouldRelayBudgetSync: tx.hasBudgetSync,
    recomputeAlarmSync: (ts) =>
      deps.storage.transactionSync(() => deps.eventCoordinator.recomputeAlarmSync(ts)),
  });
  return tx.result;
}
