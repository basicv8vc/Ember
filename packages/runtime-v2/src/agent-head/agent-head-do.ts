import type {
  B1AssistantTurnDto,
  B1ConversationPage,
  B1MessageSubmissionReconciliationDto,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import { V2_BUDGET_LIMITS, V2_TIMING_LIMITS } from '../contracts/constants.js';
import type {
  AgentHeadRpc,
  B1ConversationIdentity,
  B1TranscriptClearResult,
  CommitTurnRequest,
  CommitTurnResult,
  HandoffTurnRequest,
  HandoffTurnResult,
  MarkAttemptSentRequest,
  MarkAttemptSentResult,
  PrepareTurnRequest,
  PrepareTurnResult,
  RenewTurnLeaseRequest,
  RenewTurnLeaseResult,
} from '../contracts/agent-head-rpc.js';
import type { DeviceExecutionCommand, DeviceExecutionRpc } from '../contracts/device-execution.js';
import type {
  PersonalMemoryCommand,
  PersonalMemoryResponse,
  PersonalMemoryRpc,
} from '../contracts/personal-memory.js';
import type { GlobalBudgetAuthority } from '../contracts/global-budget.js';
import { applyAgentHeadMigrations, type AgentHeadMigrationStep } from '../migrations.js';
import type {
  BudgetSyncIncidentReason,
  BudgetSyncOutboxPayload,
  BudgetSyncSettlementState,
  V2DispatchEnvelope,
} from '../recovery/envelope.js';
import type {
  AgentHeadRecoveryPort,
  AuthoritativeBusinessPort,
  EventRuntimeCoordinatorPort,
  RecoveryAdmissionPort,
  RecoveryRegistryPort,
} from '../recovery/ports.js';
import type { OrdinaryOutboxEntityKind } from '../recovery/schema.js';
import type { DurableObjectStorageLike } from '../storage.js';
import {
  createGlobalBudgetSettlePortAdapter,
  enqueueBudgetReleaseCompensationSync,
  reserveLocalAttemptSync,
  settleLocalAttemptAndEnqueueSync,
  type AgentBudgetSettleBridgeResult,
  type LocalBudgetCeilings,
  type LocalSettlementResult,
} from './budget.js';
import { AgentHeadDeviceService } from './device-service.js';
import { AgentHeadMemoryService } from './memory-service.js';
import { getHeadMetaSync, getTaskRowSync, sqlExecMaybe } from './queries.js';
import { AgentHeadRecoveryService } from './recovery-service.js';
import {
  createDefaultAgentHeadMigrations,
  type ModelAttemptBudgetMode,
  type ModelAttemptProviderId,
  type ModelAttemptRow,
} from './schema.js';
import { checkTaskModelLimits, toUtcDayString } from './state-machine.js';
import { syncAlarmAndRelayBudget as syncSharedAlarmAndRelayBudget } from './turn-commit.js';
import { AgentHeadTurnService, type TurnRecoverySeamHooks } from './turn-service.js';

export interface AgentHeadEventRuntimeBindings {
  /** B-owned `RecoveryAdmissionPort` (production: `RecoveryCoverageCoordinator`). */
  readonly recoveryAdmission: RecoveryAdmissionPort;
  /** B-owned `EventRuntimeCoordinatorPort` (production: `OutboxCoordinator`). */
  readonly eventCoordinator: EventRuntimeCoordinatorPort;
  /** B-owned coordinator seam delegates (production: `RecoveryCoverageCoordinator`, `AlarmMultiplexer`, `relayDueBudgetSyncBatch`). */
  readonly recoveryHooks: TurnRecoverySeamHooks;
}

export type AgentHeadCoreOptions = {
  readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly recoveryRegistry: RecoveryRegistryPort;
  readonly globalBudget: GlobalBudgetAuthority;
  readonly nowMs?: () => number;
  readonly idFactory?: () => Id;
  readonly localCeilings?: LocalBudgetCeilings;
  readonly globalDailyCeilingMicroUsd?: number;
  readonly migrations?: readonly AgentHeadMigrationStep[];
} & (
  | AgentHeadEventRuntimeBindings
  | {
      /**
       * Factory callback invoked synchronously inside `new AgentHeadCore(...)` once `this.recoveryService`
       * (`AuthoritativeBusinessPort`) exists, cleanly resolving circular B-coordinator wiring.
       */
      readonly eventRuntimeFactory: (
        business: AuthoritativeBusinessPort,
      ) => AgentHeadEventRuntimeBindings;
    }
);

function createLazyEventCoordinatorProxy(
  getTarget: () => EventRuntimeCoordinatorPort,
): EventRuntimeCoordinatorPort {
  return {
    enqueueDurableOutboxSync: (cmd) => getTarget().enqueueDurableOutboxSync(cmd),
    cancelEntityOutboxSync: (entityKind, entityId, nowMs) =>
      getTarget().cancelEntityOutboxSync(entityKind, entityId, nowMs),
    ackOutboxSync: (outboxId, fenceEpoch, nowMs) =>
      getTarget().ackOutboxSync(outboxId, fenceEpoch, nowMs),
    applyOutboxDeadLetterSync: (cmd) => getTarget().applyOutboxDeadLetterSync(cmd),
    recomputeAlarmSync: (nowMs) => getTarget().recomputeAlarmSync(nowMs),
  };
}

function createLazyRecoveryHooksProxy(
  getTarget: () => TurnRecoverySeamHooks,
): TurnRecoverySeamHooks {
  return {
    reconcileCoverageSync: (cmd) => getTarget().reconcileCoverageSync(cmd),
    confirmCoveragePlanSync: (cmd) => getTarget().confirmCoveragePlanSync(cmd),
    getOutboxByIdSync: (outboxId) => getTarget().getOutboxByIdSync?.(outboxId) ?? null,
    syncPlatformAlarm: (targetAlarmAtMs, nowMs) =>
      getTarget().syncPlatformAlarm?.(targetAlarmAtMs, nowMs) ?? Promise.resolve(),
    relayBudgetSync: (nowMs) => getTarget().relayBudgetSync?.(nowMs) ?? Promise.resolve(),
    getCoverageRowSync: () => getTarget().getCoverageRowSync?.() ?? null,
  };
}

function createLazyRecoveryAdmissionProxy(
  getTarget: () => RecoveryAdmissionPort,
): RecoveryAdmissionPort {
  return {
    inspectCoverageSync: (requiredRecoveryAtMs, nowMs) =>
      getTarget().inspectCoverageSync(requiredRecoveryAtMs, nowMs),
    confirmCoverageSync: (cmd) => getTarget().confirmCoverageSync(cmd),
  };
}

export interface AgentHeadBootstrapInput {
  readonly conversationId: Id;
  readonly policyVersion?: number;
  readonly homeRegion?: string | null;
}

/**
 * Authoritative V2 `AgentHeadDO` business core composing ONLY Agent A responsibilities:
 * - Single SQLite schema migrations (`applyAgentHeadMigrations` with v1 business + v2 recovery);
 * - `AgentHeadRpc` (3-RPC `prepareTurn` -> `markAttemptSent` -> `commitTurn`, lease renew, handoff, cancel, clear, Direct reads);
 * - `AuthoritativeBusinessPort` (sync due business actions, convergence, outbox inspection, schedule materialization);
 * - `AgentHeadRecoveryPort` (`claimDurableWork` / `commitDurableResult`, plus coverage plan delegation to Agent B);
 * - Local `model_attempts` / `agent_spend_days` / `agent_budget_incidents` & atomic `budget_sync` outbox commits.
 *
 * Outbox publishing, Alarm multiplexing, `v2_recovery_coverage` state transitions, and `budget_sync`
 * relaying are strictly delegated to Agent B via injected ports (`EventRuntimeCoordinatorPort`,
 * `RecoveryAdmissionPort`, and `recoveryHooks`).
 */
export class AgentHeadCore
  implements
    AgentHeadRpc,
    AgentHeadRecoveryPort,
    AuthoritativeBusinessPort,
    DeviceExecutionRpc,
    PersonalMemoryRpc
{
  private readonly deviceService: AgentHeadDeviceService;
  private readonly memoryService: AgentHeadMemoryService;
  readonly recoveryService: AgentHeadRecoveryService;
  readonly turnService: AgentHeadTurnService;

  private readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  private readonly tenantId: Id;
  private readonly agentId: Id;
  private readonly eventCoordinator: EventRuntimeCoordinatorPort;
  private readonly recoveryHooks: TurnRecoverySeamHooks;
  private readonly globalBudget: GlobalBudgetAuthority;
  private readonly nowMsFn: () => number;
  private readonly newId: () => Id;
  private readonly localCeilings: LocalBudgetCeilings | undefined;
  private readonly globalDailyCeilingMicroUsd: number;
  private readonly migrations: readonly AgentHeadMigrationStep[];

  constructor(options: AgentHeadCoreOptions) {
    this.storage = options.storage;
    this.tenantId = options.tenantId;
    this.agentId = options.agentId;
    this.globalBudget = options.globalBudget;
    this.nowMsFn = options.nowMs ?? (() => Date.now());
    this.newId = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.localCeilings = options.localCeilings;
    this.globalDailyCeilingMicroUsd =
      options.globalDailyCeilingMicroUsd ?? V2_BUDGET_LIMITS.globalDailyMicroUsd;
    this.migrations = options.migrations ?? createDefaultAgentHeadMigrations();

    let resolvedBindings: AgentHeadEventRuntimeBindings | undefined =
      'eventRuntimeFactory' in options ? undefined : options;

    const getEventCoordinator = (): EventRuntimeCoordinatorPort => {
      if (resolvedBindings === undefined) {
        throw new Error('AgentHeadCore eventRuntimeFactory not yet initialized');
      }
      return resolvedBindings.eventCoordinator;
    };
    const getRecoveryHooks = (): TurnRecoverySeamHooks => {
      if (resolvedBindings === undefined) {
        throw new Error('AgentHeadCore eventRuntimeFactory not yet initialized');
      }
      return resolvedBindings.recoveryHooks;
    };
    const getRecoveryAdmission = (): RecoveryAdmissionPort => {
      if (resolvedBindings === undefined) {
        throw new Error('AgentHeadCore eventRuntimeFactory not yet initialized');
      }
      return resolvedBindings.recoveryAdmission;
    };

    this.recoveryService = new AgentHeadRecoveryService({
      storage: this.storage,
      eventCoordinator: createLazyEventCoordinatorProxy(getEventCoordinator),
      recoveryAdmission: createLazyRecoveryAdmissionProxy(getRecoveryAdmission),
      recoveryRegistry: options.recoveryRegistry,
      hooks: createLazyRecoveryHooksProxy(getRecoveryHooks),
      nowMs: this.nowMsFn,
      idFactory: this.newId,
      ...(this.localCeilings !== undefined ? { localCeilings: this.localCeilings } : {}),
    });

    if ('eventRuntimeFactory' in options) {
      resolvedBindings = options.eventRuntimeFactory(this.recoveryService);
    }
    const bindings = resolvedBindings!;
    this.eventCoordinator = bindings.eventCoordinator;
    this.recoveryHooks = bindings.recoveryHooks;

    this.deviceService = new AgentHeadDeviceService({
      storage: this.storage,
      recoveryAdmission: bindings.recoveryAdmission,
      recoveryHooks: bindings.recoveryHooks,
      recoveryRegistry: options.recoveryRegistry,
      earliestDiscovery: this.recoveryService,
      recovery: this.recoveryService,
      eventCoordinator: bindings.eventCoordinator,
      nowMs: this.nowMsFn,
      newId: this.newId,
    });

    this.memoryService = new AgentHeadMemoryService({
      storage: this.storage,
      nowMs: this.nowMsFn,
      newId: this.newId,
    });

    this.turnService = new AgentHeadTurnService({
      storage: this.storage,
      recoveryAdmission: bindings.recoveryAdmission,
      eventCoordinator: bindings.eventCoordinator,
      recoveryService: this.recoveryService,
      recoveryHooks: bindings.recoveryHooks,
      recoveryRegistry: options.recoveryRegistry,
      globalBudget: this.globalBudget,
      nowMs: this.nowMsFn,
      idFactory: this.newId,
      ...(this.localCeilings !== undefined ? { localCeilings: this.localCeilings } : {}),
      globalDailyCeilingMicroUsd: this.globalDailyCeilingMicroUsd,
    });
  }

  deviceExecution(cmd: DeviceExecutionCommand) {
    return this.deviceService.execute(cmd);
  }

  private syncAlarmAndRelayBudget(input: {
    readonly alarmAtMs: number | null | undefined;
    readonly nowMs: number;
    readonly shouldRelayBudgetSync: boolean;
  }): Promise<void> {
    return syncSharedAlarmAndRelayBudget({
      recoveryHooks: this.recoveryHooks,
      alarmAtMs: input.alarmAtMs,
      nowMs: input.nowMs,
      shouldRelayBudgetSync: input.shouldRelayBudgetSync,
      recomputeAlarmSync: (ts) =>
        this.storage.transactionSync(() => this.eventCoordinator.recomputeAlarmSync(ts)),
    });
  }

  /**
   * Returns a `GlobalBudgetSettlePort`-compatible bridge for Agent B's single
   * `relayDueBudgetSyncBatch` (`packages/runtime-v2/src/recovery/budget-sync.ts`).
   */
  createGlobalBudgetSettlePort(): {
    settleGlobal(payload: BudgetSyncOutboxPayload): Promise<AgentBudgetSettleBridgeResult>;
  } {
    return createGlobalBudgetSettlePortAdapter({
      storage: this.storage,
      globalBudget: this.globalBudget,
      nowMs: this.nowMsFn,
    });
  }

  /**
   * Executes the single unified DO SQLite migration entrypoint (`applyAgentHeadMigrations`)
   * and anchors `agent_head_meta` + the tenant's `main` conversation.
   */
  bootstrapHead(input: AgentHeadBootstrapInput): B1ConversationIdentity {
    const nowMs = this.nowMsFn();
    applyAgentHeadMigrations(this.storage, this.migrations, nowMs);

    return this.storage.transactionSync(() => {
      const existingMeta = getHeadMetaSync(this.storage.sql);
      if (existingMeta !== null) {
        if (existingMeta.tenant_id !== this.tenantId || existingMeta.agent_id !== this.agentId) {
          throw new DomainError(
            'POLICY_DENIED',
            'agent head DO identity anchor does not match caller scope',
          );
        }
      } else {
        this.storage.sql.exec(
          `INSERT INTO agent_head_meta (
             id, tenant_id, agent_id, policy_version, home_region, created_at_ms, updated_at_ms
           ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
          this.tenantId,
          this.agentId,
          input.policyVersion ?? 1,
          input.homeRegion ?? null,
          nowMs,
          nowMs,
        );
      }

      this.storage.sql.exec(
        `INSERT INTO conversations (
           id, kind, last_sequence, transcript_epoch, created_at_ms, updated_at_ms
         ) VALUES (?, 'main', 0, 0, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        input.conversationId,
        nowMs,
        nowMs,
      );

      const conv = this.storage.sql
        .exec<{
          readonly id: string;
          readonly last_sequence: number;
          readonly transcript_epoch: number;
        }>(
          `SELECT id, last_sequence, transcript_epoch FROM conversations WHERE kind = 'main' LIMIT 1`,
        )
        .one();

      return {
        conversationId: conv.id,
        tenantId: this.tenantId,
        agentId: this.agentId,
        transcriptEpoch: conv.transcript_epoch,
        lastSequence: conv.last_sequence,
      };
    });
  }

  // ---- AgentHeadRpc delegation ----

  prepareTurn(req: PrepareTurnRequest): Promise<PrepareTurnResult> {
    return this.turnService.prepareTurn(req);
  }

  markAttemptSent(req: MarkAttemptSentRequest): Promise<MarkAttemptSentResult> {
    return this.turnService.markAttemptSent(req);
  }

  renewTurnLease(req: RenewTurnLeaseRequest): Promise<RenewTurnLeaseResult> {
    return this.turnService.renewTurnLease(req);
  }

  handoffTurnToDurable(req: HandoffTurnRequest): Promise<HandoffTurnResult> {
    return this.turnService.handoffTurnToDurable(req);
  }

  commitTurn(req: CommitTurnRequest): Promise<CommitTurnResult> {
    return this.turnService.commitTurn(req);
  }

  cancelTurn(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
  }): Promise<B1AssistantTurnDto> {
    return this.turnService.cancelTurn(req);
  }

  clearTranscript(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
  }): Promise<B1TranscriptClearResult> {
    return this.turnService.clearTranscript(req);
  }

  personalMemory(cmd: PersonalMemoryCommand): Promise<PersonalMemoryResponse> {
    return this.memoryService.execute(cmd);
  }

  getMainConversation(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
  }): Promise<B1ConversationIdentity | null> {
    return this.turnService.getMainConversation(req);
  }

  readMessages(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
    readonly after: number;
    readonly limit: number;
  }): Promise<B1ConversationPage> {
    return this.turnService.readMessages(req);
  }

  findSubmissionReceipt(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly clientSubmissionId: Id;
  }): Promise<B1MessageSubmissionReconciliationDto | null> {
    return this.turnService.findSubmissionReceipt(req);
  }

  getTurn(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
  }): Promise<B1AssistantTurnDto | null> {
    return this.turnService.getTurn(req);
  }

  // ---- AuthoritativeBusinessPort delegation ----

  earliestRequiredDiscoveryAtMsSync(nowMs: number): number | null {
    return this.recoveryService.earliestRequiredDiscoveryAtMsSync(nowMs);
  }

  listDueBusinessActionsSync(nowMs: number, limit: number) {
    return this.recoveryService.listDueBusinessActionsSync(nowMs, limit);
  }

  convergeDueBusinessItemSync(targetKind: 'turn' | 'task', targetId: string, nowMs: number): void {
    this.recoveryService.convergeDueBusinessItemSync(targetKind, targetId, nowMs);
  }

  inspectOutboxTargetSync(entityKind: OrdinaryOutboxEntityKind, entityId: string) {
    return this.recoveryService.inspectOutboxTargetSync(entityKind, entityId);
  }

  materializeScheduleOccurrenceSync(
    scheduleId: string,
    occurrenceSeq: number,
    nowMs: number,
  ): void {
    this.recoveryService.materializeScheduleOccurrenceSync(scheduleId, occurrenceSeq, nowMs);
  }

  // ---- AgentHeadRecoveryPort delegation ----

  reconcileFromRegistry(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly expectedGen: number;
    readonly nowMs: number;
  }) {
    return this.recoveryService.reconcileFromRegistry(cmd);
  }

  confirmRegistryPlan(cmd: {
    readonly generation: number;
    readonly actualRecoveryAtMs: number | null;
    readonly applied: boolean;
  }) {
    return this.recoveryService.confirmRegistryPlan(cmd);
  }

  claimDurableWork(cmd: {
    readonly envelope: V2DispatchEnvelope;
    readonly workerId: string;
    readonly leaseMs: number;
  }) {
    return this.recoveryService.claimDurableWork(cmd);
  }

  commitDurableResult(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly entityType: 'turn' | 'task';
    readonly entityId: string;
    readonly leaseEpoch: number;
    readonly workerId: string;
    readonly outcome: unknown;
  }) {
    return this.recoveryService.commitDurableResult(cmd);
  }

  // ---- Task Model Attempt Reservation & Settlement (V1 ceiling preservation) ----

  async reserveTaskModelAttempt(cmd: {
    readonly tenantId: Id;
    readonly principalId: Id;
    readonly agentId: Id;
    readonly taskId: Id;
    readonly runId: Id;
    readonly leaseEpoch: number;
    readonly providerId: ModelAttemptProviderId;
    readonly modelLabel: string;
    readonly rateVersion: string;
    readonly budgetMode: ModelAttemptBudgetMode;
    readonly estimatedMicroUsd: number;
  }): Promise<
    | {
        readonly kind: 'reserved';
        readonly attemptNo: number;
        readonly operationId: Id;
        readonly globalGrantId: string | null;
        readonly utcDay: string;
      }
    | {
        readonly kind: 'refused';
        readonly reason:
          | 'not_found'
          | 'fenced'
          | 'attempts_exhausted'
          | 'cost_ceiling_exceeded'
          | 'budget_exceeded'
          | 'budget_halted';
      }
  > {
    if (cmd.budgetMode !== 'disabled_echo_only' && cmd.estimatedMicroUsd <= 0) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'metered budget mode requires positive estimatedMicroUsd reservation',
      );
    }
    const pre = this.storage.transactionSync(() => {
      const nowMs = this.nowMsFn();
      const meta = getHeadMetaSync(this.storage.sql);
      if (meta === null || meta.tenant_id !== cmd.tenantId || meta.agent_id !== cmd.agentId) {
        return { ok: false as const, reason: 'not_found' as const };
      }

      const task = getTaskRowSync(this.storage.sql, cmd.taskId);
      if (
        task === null ||
        task.execution_target !== 'cloud' ||
        task.status !== 'running' ||
        task.cancel_requested_at_ms !== null ||
        task.lease_epoch !== cmd.leaseEpoch ||
        task.current_run_id !== cmd.runId ||
        task.lease_expires_at_ms === null ||
        nowMs >= task.lease_expires_at_ms ||
        (task.deadline_at_ms !== null && nowMs >= task.deadline_at_ms)
      ) {
        return { ok: false as const, reason: 'fenced' as const };
      }

      const taskAgg = this.storage.sql
        .exec<{ readonly cnt: number; readonly total_cost: number }>(
          `SELECT COUNT(*) AS cnt,
                  COALESCE(SUM(
                    CASE
                      WHEN state = 'reserved' THEN reserved_micro_usd
                      WHEN state = 'released' THEN 0
                      ELSE COALESCE(applied_cost_micro_usd, reserved_micro_usd)
                    END
                  ), 0) AS total_cost
             FROM model_attempts
            WHERE subject_type = 'task' AND subject_id = ?`,
          task.id,
        )
        .one();

      const runAgg = this.storage.sql
        .exec<{ readonly cnt: number }>(
          `SELECT COUNT(*) AS cnt
             FROM model_attempts
            WHERE subject_type = 'task' AND subject_id = ? AND lease_epoch = ?`,
          task.id,
          cmd.leaseEpoch,
        )
        .one();

      const limitCheck = checkTaskModelLimits({
        taskKind: task.kind,
        existingTaskAttempts: taskAgg.cnt,
        existingRunAttempts: runAgg.cnt,
        existingTaskCostMicroUsd: taskAgg.total_cost,
        candidateReserveMicroUsd: cmd.estimatedMicroUsd,
      });
      if (!limitCheck.allowed) {
        return { ok: false as const, reason: limitCheck.reason };
      }

      return {
        ok: true as const,
        nowMs,
        utcDay: toUtcDayString(nowMs),
        attemptNo: taskAgg.cnt + 1,
        operationId: this.newId(),
        expiresAtMs:
          Math.max(task.lease_expires_at_ms, task.deadline_at_ms ?? task.lease_expires_at_ms) +
          V2_TIMING_LIMITS.globalGrantTtlGraceMs,
      };
    });

    if (!pre.ok) {
      return { kind: 'refused', reason: pre.reason };
    }

    let globalGrantId: string | null = null;
    if (cmd.budgetMode !== 'disabled_echo_only' && cmd.estimatedMicroUsd > 0) {
      const globalRes = await this.globalBudget.reserveGlobal({
        tenantId: cmd.tenantId,
        principalId: cmd.principalId,
        agentId: cmd.agentId,
        operationId: pre.operationId,
        leaseEpoch: cmd.leaseEpoch,
        utcDay: pre.utcDay,
        amountMicroUsd: cmd.estimatedMicroUsd,
        ceilingMicroUsd: this.globalDailyCeilingMicroUsd,
        expiresAtMs: pre.expiresAtMs,
      });
      if (globalRes.kind !== 'reserved') {
        return {
          kind: 'refused',
          reason: globalRes.kind === 'budget_halted' ? 'budget_halted' : 'budget_exceeded',
        };
      }
      globalGrantId = globalRes.globalGrantId;
    }

    const committed = this.storage.transactionSync(() => {
      const nowMs = this.nowMsFn();
      const task = getTaskRowSync(this.storage.sql, cmd.taskId);
      if (
        task === null ||
        task.execution_target !== 'cloud' ||
        task.status !== 'running' ||
        task.lease_epoch !== cmd.leaseEpoch ||
        task.current_run_id !== cmd.runId ||
        task.lease_expires_at_ms === null ||
        nowMs >= task.lease_expires_at_ms ||
        (task.deadline_at_ms !== null && nowMs >= task.deadline_at_ms)
      ) {
        let alarmAtMs: number | null | undefined;
        if (globalGrantId !== null) {
          enqueueBudgetReleaseCompensationSync({
            coordinator: this.eventCoordinator,
            tenantId: cmd.tenantId,
            principalId: cmd.principalId,
            agentId: cmd.agentId,
            utcDay: pre.utcDay,
            globalGrantId,
            operationId: pre.operationId,
            reservedMicroUsd: cmd.estimatedMicroUsd,
            fenceEpoch: cmd.leaseEpoch,
            nowMs,
          });
          alarmAtMs = this.eventCoordinator.recomputeAlarmSync(nowMs);
        }
        return { ok: false as const, reason: 'fenced' as const, nowMs, alarmAtMs };
      }

      try {
        reserveLocalAttemptSync({
          sql: this.storage.sql,
          tenantId: cmd.tenantId,
          principalId: cmd.principalId,
          subjectType: 'task',
          subjectId: task.id,
          attemptNo: pre.attemptNo,
          operationId: pre.operationId,
          utcDay: pre.utcDay,
          leaseEpoch: cmd.leaseEpoch,
          providerId: cmd.providerId,
          modelLabel: cmd.modelLabel,
          rateVersion: cmd.rateVersion,
          budgetMode: cmd.budgetMode,
          reservedMicroUsd: cmd.estimatedMicroUsd,
          globalGrantId,
          globalGrantExpiresMs: globalGrantId !== null ? pre.expiresAtMs : null,
          nowMs,
          ...(this.localCeilings !== undefined ? { ceilings: this.localCeilings } : {}),
        });
      } catch (err) {
        let alarmAtMs: number | null | undefined;
        if (globalGrantId !== null) {
          enqueueBudgetReleaseCompensationSync({
            coordinator: this.eventCoordinator,
            tenantId: cmd.tenantId,
            principalId: cmd.principalId,
            agentId: cmd.agentId,
            utcDay: pre.utcDay,
            globalGrantId,
            operationId: pre.operationId,
            reservedMicroUsd: cmd.estimatedMicroUsd,
            fenceEpoch: cmd.leaseEpoch,
            nowMs,
          });
          alarmAtMs = this.eventCoordinator.recomputeAlarmSync(nowMs);
        }
        if (err instanceof DomainError && err.code === 'BUDGET_EXCEEDED') {
          return { ok: false as const, reason: 'budget_exceeded' as const, nowMs, alarmAtMs };
        }
        throw err;
      }

      return { ok: true as const, nowMs, alarmAtMs: undefined as number | null | undefined };
    });

    if (!committed.ok) {
      await this.syncAlarmAndRelayBudget({
        alarmAtMs: committed.alarmAtMs,
        nowMs: committed.nowMs,
        shouldRelayBudgetSync: globalGrantId !== null,
      });
      return { kind: 'refused', reason: committed.reason };
    }

    return {
      kind: 'reserved',
      attemptNo: pre.attemptNo,
      operationId: pre.operationId,
      globalGrantId,
      utcDay: pre.utcDay,
    };
  }

  async settleTaskModelAttempt(cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly taskId: Id;
    readonly attemptNo: number;
    readonly operationId: Id;
    readonly requestedState: BudgetSyncSettlementState;
    readonly outcomeCode: string;
    readonly observedCostMicroUsd?: number | null;
    readonly inputTokens?: number | null;
    readonly outputTokens?: number | null;
  }): Promise<LocalSettlementResult | null> {
    const tx = this.storage.transactionSync(() => {
      const nowMs = this.nowMsFn();
      const attempt = sqlExecMaybe<ModelAttemptRow>(
        this.storage.sql,
        `SELECT * FROM model_attempts WHERE subject_type = 'task' AND subject_id = ? AND attempt_no = ?`,
        cmd.taskId,
        cmd.attemptNo,
      );
      if (attempt === null || attempt.operation_id !== cmd.operationId) {
        return null;
      }

      const res = settleLocalAttemptAndEnqueueSync({
        sql: this.storage.sql,
        coordinator: this.eventCoordinator,
        tenantId: cmd.tenantId,
        agentId: cmd.agentId,
        attempt,
        requestedState: cmd.requestedState,
        outcomeCode: cmd.outcomeCode,
        observedCostMicroUsd: cmd.observedCostMicroUsd ?? null,
        inputTokens: cmd.inputTokens ?? null,
        outputTokens: cmd.outputTokens ?? null,
        nowMs,
        ...(this.localCeilings !== undefined ? { ceilings: this.localCeilings } : {}),
        idFactory: this.newId,
      });
      const alarmAtMs = this.eventCoordinator.recomputeAlarmSync(nowMs);
      return { res, alarmAtMs, nowMs };
    });

    if (tx === null) {
      return null;
    }

    await this.syncAlarmAndRelayBudget({
      alarmAtMs: tx.alarmAtMs,
      nowMs: tx.nowMs,
      shouldRelayBudgetSync: tx.res.outboxId !== null,
    });
    return tx.res;
  }
}

export type { BudgetSyncIncidentReason };
