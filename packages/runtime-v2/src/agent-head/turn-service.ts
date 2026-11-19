import {
  B1ConversationPageSchema,
  B1SendMessageReceiptSchema,
  type B1AssistantTurnDto,
  type B1ConversationPage,
  type B1MessageSubmissionReconciliationDto,
  type B1SendMessageReceipt,
  type B1SendMessageRequest,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import {
  V2_B1_COMPAT_CONSTANTS,
  V2_BUDGET_LIMITS,
  V2_TIMING_LIMITS,
} from '../contracts/constants.js';
import type {
  AgentHeadRpc,
  B1ConversationIdentity,
  B1TranscriptClearResult,
  B2MessageAttachmentMeta,
  B2TaskDelegationCommand,
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
  ResolvedMessageAttachment,
} from '../contracts/agent-head-rpc.js';
import type { GlobalBudgetAuthority } from '../contracts/global-budget.js';
import {
  parseCommitTurnRequest,
  parseHandoffTurnRequest,
  parseMarkAttemptSentRequest,
  parsePrepareTurnRequest,
  parseRenewTurnLeaseRequest,
} from '../contracts/validation.js';
import type { V2DispatchEnvelope } from '../recovery/envelope.js';
import type { RecoveryRegistryPort } from '../recovery/ports.js';
import type { DurableObjectStorageLike } from '../storage.js';
import {
  checkLocalBudgetCapacitySync,
  findLocalUnresolvedIncidentSync,
  reserveLocalAttemptSync,
  settleLocalAttemptAndEnqueueSync,
  type LocalBudgetCeilings,
} from './budget.js';
import type { DefaultEventRuntimePorts } from './default-event-ports.js';
import {
  allocateConversationSequenceSync,
  assertHeadScopeSync,
  deterministicEdgeUuid,
  getConversationSync,
  getHeadMetaSync,
  getLatestAttemptForSubjectSync,
  getMainConversationSync,
  getTurnRowSync,
  insertEmberMessageSync,
  listAttachmentsForMessageSync,
  listReservedAttemptsSync,
  prepareEdgeSafeTaskCommand,
  readRecentTurnContextSync,
  sqlExecAll,
  sqlExecMaybe,
  toConversationMessageDto,
  toTurnDto,
} from './queries.js';
import type { AgentHeadRecoveryService } from './recovery-service.js';
import type { AssistantTurnRow, ConversationMessageRow, ModelAttemptRow } from './schema.js';
import {
  evaluateTurnFence,
  evaluateTurnHandoffGate,
  toIsoTimestamp,
  toUtcDayString,
} from './state-machine.js';

const SIMULATED_LABEL_PATTERN = /-(fake|echo)-/;
const B1_MESSAGE_PAGE_MAX_LIMIT = 100;

export interface TurnServiceDeps {
  readonly storage: DurableObjectStorageLike;
  readonly eventPorts: DefaultEventRuntimePorts;
  readonly recoveryService: AgentHeadRecoveryService;
  readonly recoveryRegistry: RecoveryRegistryPort;
  readonly globalBudget: GlobalBudgetAuthority;
  readonly nowMs: () => number;
  readonly idFactory?: () => Id;
  readonly localCeilings?: LocalBudgetCeilings;
  readonly globalDailyCeilingMicroUsd?: number;
  readonly flushBudgetSyncAfterCommit: () => Promise<void>;
}

interface ReplayLookupResult {
  readonly receipt: B1SendMessageReceipt;
  readonly currentTurnStatus: AssistantTurnRow['status'];
}

interface PreparedDelegationPayload {
  readonly taskId?: Id;
  readonly kind: 'notes.action_items' | 'python.agent';
  readonly title?: string;
  readonly inputJson: string;
  readonly digest: string;
  readonly idempotencyKey: string;
  readonly traceId: Id;
  readonly executionPath: 'standard' | 'heavy';
}

export class AgentHeadTurnService implements AgentHeadRpc {
  private readonly newId: () => Id;
  private readonly globalDailyCeilingMicroUsd: number;

  constructor(private readonly deps: TurnServiceDeps) {
    this.newId = deps.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.globalDailyCeilingMicroUsd =
      deps.globalDailyCeilingMicroUsd ?? V2_BUDGET_LIMITS.globalDailyMicroUsd;
  }

  private async ensureRecoveryCoverageAsync(input: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly generation: number;
    readonly targetAtMs: number;
    readonly requiredDiscoveryMs: number;
    readonly nowMs: number;
  }): Promise<{ readonly activeGeneration: number; readonly actualRecoveryAtMs: number }> {
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
        upsertRes = await this.deps.recoveryRegistry.upsertCoverage({
          tenantId: input.tenantId,
          agentId: input.agentId,
          generation: activeGen,
          recoveryAtMs: activeTarget,
          nowMs: this.deps.nowMs(),
        });
      } catch {
        // Uncertain timeout / ACK loss: verify authoritative D1 row once via standardized `getCoverage`
        try {
          const readBack = await this.deps.recoveryRegistry.getCoverage({
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
            const ff = this.deps.storage.transactionSync(() => {
              const latestReq =
                this.deps.recoveryService.earliestRequiredDiscoveryAtMsSync(this.deps.nowMs()) ??
                input.requiredDiscoveryMs;
              return this.deps.eventPorts.fastForwardEnsureSync(
                observedGen,
                Math.min(latestReq, input.requiredDiscoveryMs),
                this.deps.nowMs(),
              );
            });
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
        const ff = this.deps.storage.transactionSync(() => {
          const latestReq =
            this.deps.recoveryService.earliestRequiredDiscoveryAtMsSync(this.deps.nowMs()) ??
            input.requiredDiscoveryMs;
          return this.deps.eventPorts.fastForwardEnsureSync(
            observedGen,
            Math.min(latestReq, input.requiredDiscoveryMs),
            this.deps.nowMs(),
          );
        });
        activeGen = ff.generation;
        activeTarget = ff.targetAtMs;
        continue;
      }

      throw new DomainError('DB_UNAVAILABLE', 'recovery registry could not accept coverage');
    }

    throw new DomainError('DB_UNAVAILABLE', 'recovery registry coverage unresolved');
  }

  private findSubmissionReplaySync(
    conversationId: Id,
    request: B1SendMessageRequest,
    transcriptEpoch: number,
  ): ReplayLookupResult | null {
    const sql = this.deps.storage.sql;
    const msg = sqlExecMaybe<ConversationMessageRow>(
      sql,
      `SELECT * FROM conversation_messages WHERE client_submission_id = ?`,
      request.client_submission_id,
    );

    if (msg === null) {
      return null;
    }

    if (msg.conversation_id !== conversationId) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'client submission id belongs to another conversation',
      );
    }

    if (msg.text !== request.text) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'client submission id belongs to different message text',
      );
    }

    const storedAttachments = listAttachmentsForMessageSync(sql, msg.id);
    const requestedAttachmentIds = request.attachment_ids ?? [];
    if (
      storedAttachments.length !== requestedAttachmentIds.length ||
      storedAttachments.some((att, i) => att.uploadId !== requestedAttachmentIds[i])
    ) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'client submission id belongs to different attachments',
      );
    }

    const turn = sqlExecMaybe<AssistantTurnRow>(
      sql,
      `SELECT * FROM assistant_turns WHERE source_message_id = ?`,
      msg.id,
    );
    if (turn === null) {
      throw new DomainError('DB_UNAVAILABLE', 'stored submission has no assistant turn');
    }

    const receipt = B1SendMessageReceiptSchema.parse({
      message: {
        message_id: msg.id,
        conversation_id: msg.conversation_id,
        sequence: msg.sequence,
        kind: 'user',
        text: msg.text,
        client_submission_id: msg.client_submission_id,
        created_at: toIsoTimestamp(msg.created_at_ms),
      },
      turn: {
        turn_id: turn.id,
        status: 'running',
        created_at: toIsoTimestamp(turn.created_at_ms),
      },
      transcript_epoch: transcriptEpoch,
    });

    return {
      receipt,
      currentTurnStatus: turn.status,
    };
  }

  private resolveValidatedAttachments(
    request: B1SendMessageRequest,
    provided: readonly ResolvedMessageAttachment[] | undefined,
  ): readonly ResolvedMessageAttachment[] {
    const requestedIds = request.attachment_ids ?? [];
    if (requestedIds.length === 0) {
      return [];
    }
    if (provided === undefined || provided.length !== requestedIds.length) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'staged attachment metadata missing for requested attachment_ids',
      );
    }
    const byId = new Map(provided.map((att) => [att.uploadId, att]));
    return requestedIds.map((id) => {
      const match = byId.get(id);
      if (match === undefined) {
        throw new DomainError('INVALID_ARGUMENT', 'requested attachment metadata missing');
      }
      return match;
    });
  }

  private assertMessageQuotaSync(conversationId: Id, nowMs: number): void {
    const windowStart = nowMs - V2_B1_COMPAT_CONSTANTS.messageQuotaWindowMs;
    const row = this.deps.storage.sql
      .exec<{ readonly cnt: number }>(
        `SELECT COUNT(*) AS cnt
           FROM conversation_messages
          WHERE conversation_id = ?
            AND kind = 'user'
            AND created_at_ms >= ?`,
        conversationId,
        windowStart,
      )
      .one();

    if (row.cnt >= V2_B1_COMPAT_CONSTANTS.messageQuotaLimit) {
      throw new DomainError('BUDGET_EXCEEDED', 'conversation rolling 24h message quota exceeded');
    }
  }

  async prepareTurn(rawReq: PrepareTurnRequest): Promise<PrepareTurnResult> {
    const req = parsePrepareTurnRequest(rawReq);
    const resolvedAttachments = this.resolveValidatedAttachments(
      req.request,
      req.resolvedAttachments,
    );

    const budgetMode = req.modelReservation?.budgetMode ?? 'disabled_echo_only';
    const estimatedMicroUsd = req.modelReservation?.estimatedMicroUsd ?? 0;

    // Stage 1: Synchronous SQLite pre-check + exclusive coverage generation claim
    const stage1 = this.deps.storage.transactionSync(() => {
      const nowMs = this.deps.nowMs();
      assertHeadScopeSync(this.deps.storage.sql, req.scope.tenantId, req.scope.agentId);

      const conv = getConversationSync(this.deps.storage.sql, req.conversationId);
      if (conv === null) {
        throw new DomainError('NOT_FOUND', 'conversation not found in agent head');
      }
      if (req.request.transcript_epoch !== conv.transcript_epoch) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'submission transcript_epoch does not match current conversation epoch',
        );
      }

      const replay = this.findSubmissionReplaySync(
        req.conversationId,
        req.request,
        conv.transcript_epoch,
      );
      if (replay !== null) {
        return { kind: 'replay' as const, replay };
      }

      this.assertMessageQuotaSync(req.conversationId, nowMs);

      const utcDay = toUtcDayString(nowMs);
      if (budgetMode !== 'disabled_echo_only') {
        const cap = checkLocalBudgetCapacitySync({
          sql: this.deps.storage.sql,
          tenantId: req.scope.tenantId,
          principalId: req.scope.principalId,
          utcDay,
          amountMicroUsd: estimatedMicroUsd,
          turnsStartedDelta: 1,
          ...(this.deps.localCeilings !== undefined ? { ceilings: this.deps.localCeilings } : {}),
        });
        if (!cap.ok) {
          throw new DomainError(
            'BUDGET_EXCEEDED',
            cap.reason === 'budget_halted'
              ? 'unresolved local budget incident blocks paid turns'
              : 'local daily spend or turn ceiling exceeded',
          );
        }
      }

      const existingEarliest = this.deps.recoveryService.earliestRequiredDiscoveryAtMsSync(nowMs);
      const candidateDiscoveryMs = nowMs + V2_TIMING_LIMITS.d1RecoveryGraceMs;
      const requiredDiscoveryMs =
        existingEarliest === null
          ? candidateDiscoveryMs
          : Math.min(existingEarliest, candidateDiscoveryMs);

      const coveragePlan = this.deps.eventPorts.inspectCoverageSync(requiredDiscoveryMs, nowMs);
      const context = readRecentTurnContextSync(this.deps.storage.sql, req.conversationId);

      return {
        kind: 'proceed' as const,
        nowMs,
        utcDay,
        operationId: this.newId(),
        requiredDiscoveryMs,
        coveragePlan,
        context,
      };
    });

    if (stage1.kind === 'replay') {
      return {
        kind: 'replay',
        replayed: true,
        receipt: stage1.replay.receipt,
        currentTurnStatus: stage1.replay.currentTurnStatus,
      };
    }

    // Stage 2: External authoritative registration (ONLY outside transactionSync)
    let activeGeneration = stage1.coveragePlan.generation;
    let actualRecoveryAtMs =
      stage1.coveragePlan.kind === 'covered'
        ? stage1.coveragePlan.coveredRecoveryAtMs
        : stage1.coveragePlan.targetAtMs;
    const needsRegistryUpsert = stage1.coveragePlan.kind === 'register';

    if (stage1.coveragePlan.kind === 'register') {
      const regResult = await this.ensureRecoveryCoverageAsync({
        tenantId: req.scope.tenantId,
        agentId: req.scope.agentId,
        generation: stage1.coveragePlan.generation,
        targetAtMs: stage1.coveragePlan.targetAtMs,
        requiredDiscoveryMs: stage1.requiredDiscoveryMs,
        nowMs: stage1.nowMs,
      });
      activeGeneration = regResult.activeGeneration;
      actualRecoveryAtMs = regResult.actualRecoveryAtMs;
    }

    let globalGrantId: string | null = null;
    let globalGrantExpiresMs: number | null = null;
    if (budgetMode !== 'disabled_echo_only' && estimatedMicroUsd > 0) {
      const grantTtlBase = Math.max(req.leaseMs, req.turnDeadlineMs);
      globalGrantExpiresMs =
        this.deps.nowMs() + grantTtlBase + V2_TIMING_LIMITS.globalGrantTtlGraceMs;

      let reserveRes;
      try {
        reserveRes = await this.deps.globalBudget.reserveGlobal({
          tenantId: req.scope.tenantId,
          principalId: req.scope.principalId,
          agentId: req.scope.agentId,
          operationId: stage1.operationId,
          leaseEpoch: 1,
          utcDay: stage1.utcDay,
          amountMicroUsd: estimatedMicroUsd,
          ceilingMicroUsd: this.globalDailyCeilingMicroUsd,
          expiresAtMs: globalGrantExpiresMs,
        });
      } catch {
        throw new DomainError('DB_UNAVAILABLE', 'global budget authority unavailable');
      }

      if (reserveRes.kind === 'budget_exceeded') {
        throw new DomainError('BUDGET_EXCEEDED', 'global daily budget ceiling exceeded');
      }
      if (reserveRes.kind === 'budget_halted') {
        throw new DomainError(
          'BUDGET_EXCEEDED',
          `global budget halted due to ${reserveRes.reason}`,
        );
      }
      globalGrantId = reserveRes.globalGrantId;
    }

    // Stage 3: Atomic local commit (`transactionSync` #2) with full TOCTOU verification
    const stage3Outcome = this.deps.storage.transactionSync(() => {
      const commitNow = this.deps.nowMs();
      assertHeadScopeSync(this.deps.storage.sql, req.scope.tenantId, req.scope.agentId);
      const conv = getConversationSync(this.deps.storage.sql, req.conversationId);
      if (conv === null) {
        return {
          status: 'abort' as const,
          errorCode: 'NOT_FOUND' as const,
          reason: 'conversation disappeared before commit',
          durableCompensationEnqueued: false,
        };
      }

      // Check TOCTOU preconditions (epoch, duplicate submission, quota, local capacity)
      let abortClass:
        | { readonly status: 'replay'; readonly replay: ReplayLookupResult }
        | {
            readonly status: 'abort';
            readonly errorCode: 'IDEMPOTENCY_CONFLICT' | 'BUDGET_EXCEEDED' | 'DB_UNAVAILABLE';
            readonly reason: string;
          }
        | null = null;

      if (req.request.transcript_epoch !== conv.transcript_epoch) {
        abortClass = {
          status: 'abort',
          errorCode: 'IDEMPOTENCY_CONFLICT',
          reason: 'transcript_epoch changed concurrently',
        };
      } else {
        try {
          const concurrentReplay = this.findSubmissionReplaySync(
            req.conversationId,
            req.request,
            conv.transcript_epoch,
          );
          if (concurrentReplay !== null) {
            abortClass = { status: 'replay', replay: concurrentReplay };
          }
        } catch (err) {
          if (err instanceof DomainError && err.code === 'IDEMPOTENCY_CONFLICT') {
            abortClass = {
              status: 'abort',
              errorCode: 'IDEMPOTENCY_CONFLICT',
              reason: err.diagnostic,
            };
          } else {
            throw err;
          }
        }
      }

      if (abortClass === null) {
        try {
          this.assertMessageQuotaSync(req.conversationId, commitNow);
          if (budgetMode !== 'disabled_echo_only') {
            const cap = checkLocalBudgetCapacitySync({
              sql: this.deps.storage.sql,
              tenantId: req.scope.tenantId,
              principalId: req.scope.principalId,
              utcDay: stage1.utcDay,
              amountMicroUsd: estimatedMicroUsd,
              turnsStartedDelta: 1,
              ...(this.deps.localCeilings !== undefined
                ? { ceilings: this.deps.localCeilings }
                : {}),
            });
            if (!cap.ok) {
              abortClass = {
                status: 'abort',
                errorCode: 'BUDGET_EXCEEDED',
                reason: 'local budget exhausted during prepare',
              };
            }
          }
        } catch (err) {
          if (err instanceof DomainError && err.code === 'BUDGET_EXCEEDED') {
            abortClass = {
              status: 'abort',
              errorCode: 'BUDGET_EXCEEDED',
              reason: err.diagnostic,
            };
          } else {
            throw err;
          }
        }
      }

      // Check recovery coverage
      const existingEarliest =
        this.deps.recoveryService.earliestRequiredDiscoveryAtMsSync(commitNow);
      const turnDiscoveryMs = commitNow + V2_TIMING_LIMITS.d1RecoveryGraceMs;
      const requiredAtStage3 =
        existingEarliest === null ? turnDiscoveryMs : Math.min(existingEarliest, turnDiscoveryMs);

      let coverageConfirmed = false;
      if (abortClass === null) {
        if (needsRegistryUpsert) {
          coverageConfirmed = this.deps.eventPorts.confirmCoverageSync({
            generation: activeGeneration,
            actualRecoveryAtMs,
            applied: true,
            earliestRequiredRecoveryMs: requiredAtStage3,
            nowMs: commitNow,
          });
          if (!coverageConfirmed) {
            const currentCov = this.deps.eventPorts.getCoverageRowSync();
            if (
              currentCov.coverage_state === 'covered' &&
              currentCov.covered_recovery_at_ms !== null &&
              currentCov.covered_recovery_at_ms <= requiredAtStage3
            ) {
              coverageConfirmed = true;
            }
          }
        } else {
          const currentCov = this.deps.eventPorts.getCoverageRowSync();
          coverageConfirmed =
            currentCov.coverage_state === 'covered' &&
            currentCov.covered_recovery_at_ms !== null &&
            currentCov.covered_recovery_at_ms <= requiredAtStage3;
        }

        if (!coverageConfirmed) {
          abortClass = {
            status: 'abort',
            errorCode: 'DB_UNAVAILABLE',
            reason: 'recovery coverage lost or insufficient before commit',
          };
        }
      }

      if (abortClass !== null) {
        let durableComp = false;
        if (globalGrantId !== null) {
          const currentCov = this.deps.eventPorts.getCoverageRowSync();
          const compBound = commitNow + V2_TIMING_LIMITS.d1RecoveryGraceMs;
          const canConfirmOnAbort =
            needsRegistryUpsert &&
            this.deps.eventPorts.confirmCoverageSync({
              generation: activeGeneration,
              actualRecoveryAtMs,
              applied: true,
              earliestRequiredRecoveryMs: compBound,
              nowMs: commitNow,
            });
          const hasValidCoverage =
            canConfirmOnAbort ||
            (currentCov.coverage_state === 'covered' &&
              currentCov.covered_recovery_at_ms !== null &&
              currentCov.covered_recovery_at_ms <= compBound);

          if (hasValidCoverage) {
            this.deps.eventPorts.enqueueDurableOutboxSync({
              outboxId: `budget_sync:${stage1.operationId}:rev:0`,
              entityKind: 'budget_sync',
              entityId: stage1.operationId,
              queueName: null,
              payloadJson: JSON.stringify({
                schemaVersion: 1,
                tenantId: req.scope.tenantId,
                principalId: req.scope.principalId,
                agentId: req.scope.agentId,
                utcDay: stage1.utcDay,
                globalGrantId,
                operationId: stage1.operationId,
                settlementRevision: 0,
                state: 'released',
                reservedMicroUsd: estimatedMicroUsd,
                chargeMicroUsd: 0,
                observedCostMicroUsd: null,
                overageMicroUsd: 0,
                openIncidentReason: null,
              }),
              operationId: stage1.operationId,
              revision: 0,
              fenceEpoch: 1,
              nextAttemptAtMs: commitNow,
            });
            this.deps.eventPorts.recomputeAlarmSync(commitNow);
            durableComp = true;
          }
        }

        if (abortClass.status === 'replay') {
          return {
            status: 'replay' as const,
            replay: abortClass.replay,
            durableCompensationEnqueued: durableComp,
          };
        }
        return {
          status: 'abort' as const,
          errorCode: abortClass.errorCode,
          reason: abortClass.reason,
          durableCompensationEnqueued: durableComp,
        };
      }

      // All preconditions & recovery coverage verified: atomic local commit
      const sequence = allocateConversationSequenceSync(
        this.deps.storage.sql,
        req.conversationId,
        commitNow,
      );
      const userMessageId = this.newId();
      this.deps.storage.sql.exec(
        `INSERT INTO conversation_messages (
           id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms
         ) VALUES (?, ?, ?, 'user', ?, ?, ?)`,
        userMessageId,
        req.conversationId,
        sequence,
        req.request.text,
        req.request.client_submission_id,
        commitNow,
      );

      for (let i = 0; i < resolvedAttachments.length; i += 1) {
        const att = resolvedAttachments[i]!;
        this.deps.storage.sql.exec(
          `INSERT INTO message_attachments (
             message_id, position, upload_id, filename, media_type, size_bytes, r2_key, sha256
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          userMessageId,
          i,
          att.uploadId,
          att.filename,
          att.mediaType,
          att.sizeBytes,
          att.r2Key,
          att.sha256,
        );
      }

      const turnId = this.newId();
      const deadlineAtMs = commitNow + req.turnDeadlineMs;
      const isFast = req.executionMode === 'fast_interactive';
      const leaseExpiresAtMs = isFast ? Math.min(commitNow + req.leaseMs, deadlineAtMs) : null;
      const interactiveDeadlineMs = isFast
        ? Math.min(commitNow + req.interactiveDeadlineMs, deadlineAtMs)
        : null;

      this.deps.storage.sql.exec(
        `INSERT INTO assistant_turns (
           id, conversation_id, source_message_id, response_message_id, status, failure_reason,
           execution_mode, deadline_at_ms, interactive_deadline_ms, lease_epoch, lease_owner,
           lease_expires_at_ms, claim_count, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, NULL, 'running', NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        turnId,
        req.conversationId,
        userMessageId,
        req.executionMode,
        deadlineAtMs,
        interactiveDeadlineMs,
        isFast ? req.workerId : null,
        leaseExpiresAtMs,
        isFast ? 1 : 0,
        commitNow,
        commitNow,
      );

      const attemptNo = 1;
      if (req.modelReservation !== undefined) {
        reserveLocalAttemptSync({
          sql: this.deps.storage.sql,
          tenantId: req.scope.tenantId,
          principalId: req.scope.principalId,
          subjectType: 'turn',
          subjectId: turnId,
          attemptNo,
          operationId: stage1.operationId,
          utcDay: stage1.utcDay,
          leaseEpoch: 1,
          providerId: req.modelReservation.providerId,
          modelLabel: req.modelReservation.modelLabel,
          rateVersion: req.modelReservation.rateVersion,
          budgetMode: req.modelReservation.budgetMode,
          reservedMicroUsd: req.modelReservation.estimatedMicroUsd,
          globalGrantId,
          globalGrantExpiresMs,
          nowMs: commitNow,
          ...(this.deps.localCeilings !== undefined ? { ceilings: this.deps.localCeilings } : {}),
        });
      }

      const fallbackNextAttemptAtMs = isFast
        ? Math.min(
            leaseExpiresAtMs! + V2_TIMING_LIMITS.fastPathOutboxGraceMs,
            Math.max(commitNow + 1, deadlineAtMs - 1),
          )
        : commitNow;

      const outboxId = `turn:${turnId}:epoch:1`;
      const envelope: V2DispatchEnvelope = {
        schemaVersion: 2,
        eventId: outboxId,
        tenantId: req.scope.tenantId,
        agentId: req.scope.agentId,
        entityKind: 'turn',
        entityId: turnId,
        queueName: 'durable_turn',
        fenceEpoch: 1,
      };
      this.deps.eventPorts.enqueueDurableOutboxSync({
        outboxId,
        entityKind: 'turn',
        entityId: turnId,
        queueName: 'durable_turn',
        payloadJson: JSON.stringify(envelope),
        fenceEpoch: 1,
        nextAttemptAtMs: fallbackNextAttemptAtMs,
      });

      this.deps.eventPorts.recomputeAlarmSync(commitNow);

      const receipt = B1SendMessageReceiptSchema.parse({
        message: {
          message_id: userMessageId,
          conversation_id: req.conversationId,
          sequence,
          kind: 'user',
          text: req.request.text,
          client_submission_id: req.request.client_submission_id,
          created_at: toIsoTimestamp(commitNow),
        },
        turn: {
          turn_id: turnId,
          status: 'running',
          created_at: toIsoTimestamp(commitNow),
        },
        transcript_epoch: conv.transcript_epoch,
      });

      const attachmentsMeta: B2MessageAttachmentMeta[] = resolvedAttachments.map((att) => ({
        uploadId: att.uploadId,
        filename: att.filename,
        mediaType: att.mediaType,
        sizeBytes: att.sizeBytes,
      }));

      return {
        status: 'committed' as const,
        result: {
          kind: 'prepared' as const,
          replayed: false as const,
          receipt,
          turnId,
          attemptNo,
          operationId: stage1.operationId,
          leaseEpoch: 1,
          leaseExpiresAtMs,
          interactiveDeadlineMs,
          turnDeadlineMs: deadlineAtMs,
          utcDay: stage1.utcDay,
          reservedMicroUsd: req.modelReservation?.estimatedMicroUsd ?? 0,
          globalGrantId,
          context: [
            ...stage1.context,
            {
              sequence,
              kind: 'user' as const,
              text: req.request.text,
              ...(attachmentsMeta.length > 0 ? { attachments: attachmentsMeta } : {}),
            },
          ],
          attachments: attachmentsMeta,
        },
      };
    });

    await this.deps.eventPorts.flushPendingAlarmOp();

    if (stage3Outcome.status !== 'committed') {
      if (globalGrantId !== null) {
        if (stage3Outcome.durableCompensationEnqueued) {
          await this.deps.flushBudgetSyncAfterCommit();
        } else {
          // Best-effort direct release on uncommitted candidate when local coverage invalidated
          try {
            await this.deps.globalBudget.settleGlobal({
              tenantId: req.scope.tenantId,
              operationId: stage1.operationId,
              settlementRevision: 0,
              globalGrantId,
              state: 'released',
              observedCostMicroUsd: null,
              chargeMicroUsd: 0,
              reservedMicroUsd: estimatedMicroUsd,
            });
          } catch {
            // Uncommitted Grant expires safely into `expired_consumed` per V2-M0-A §7.2
          }
        }
      }

      if (stage3Outcome.status === 'replay') {
        return {
          kind: 'replay',
          replayed: true,
          receipt: stage3Outcome.replay.receipt,
          currentTurnStatus: stage3Outcome.replay.currentTurnStatus,
        };
      }
      throw new DomainError(stage3Outcome.errorCode, stage3Outcome.reason);
    }

    return stage3Outcome.result;
  }

  /**
   * 3-RPC single outbound send gate (`markAttemptSent`):
   * Stage 1: CAS `send_authorizing_at_ms` + check lease, cancel, expiry, unresolved local halt.
   * Stage 2: If `budgetMode !== 'disabled_echo_only'`, call `GlobalBudgetAuthority.authorizeGlobalSend`.
   * Stage 3: TOCTOU re-verify inside DO transactionSync and stamp `send_started_at_ms`.
   */
  async markAttemptSent(rawReq: MarkAttemptSentRequest): Promise<MarkAttemptSentResult> {
    const req = parseMarkAttemptSentRequest(rawReq);

    const checkAttemptGateSync = (
      isFinalCommit: boolean,
    ):
      | {
          readonly ok: true;
          readonly globalGrantId: string | null;
          readonly budgetMode: ModelAttemptRow['budget_mode'];
          readonly nowMs: number;
          readonly startBeforeMs: number;
        }
      | {
          readonly ok: false;
          readonly reason:
            'fenced' | 'expired' | 'cancelled' | 'already_sent' | 'budget_halted' | 'not_found';
        } => {
      const nowMs = this.deps.nowMs();
      const meta = getHeadMetaSync(this.deps.storage.sql);
      if (
        meta === null ||
        meta.tenant_id !== req.scope.tenantId ||
        meta.agent_id !== req.scope.agentId
      ) {
        return { ok: false, reason: 'not_found' };
      }

      const attempt = sqlExecMaybe<ModelAttemptRow>(
        this.deps.storage.sql,
        `SELECT *
           FROM model_attempts
          WHERE subject_type = ? AND subject_id = ? AND attempt_no = ?`,
        req.subjectType,
        req.subjectId,
        req.attemptNo,
      );

      if (attempt === null || attempt.operation_id !== req.operationId) {
        return { ok: false, reason: 'not_found' };
      }

      if (attempt.send_started_at_ms !== null || attempt.state !== 'reserved') {
        return { ok: false, reason: 'already_sent' };
      }
      if (!isFinalCommit && attempt.send_authorizing_at_ms !== null) {
        // Prior authorization may already have reached GlobalBudgetAuthority: refuse duplicate send
        return { ok: false, reason: 'already_sent' };
      }

      const halt = findLocalUnresolvedIncidentSync(
        this.deps.storage.sql,
        req.scope.tenantId,
        attempt.principal_id,
      );
      if (halt !== null) {
        return { ok: false, reason: 'budget_halted' };
      }

      let deadlineAtMs = nowMs + 1;
      let leaseExpiresAtMs: number | null = null;
      if (req.subjectType === 'turn') {
        const turn = getTurnRowSync(this.deps.storage.sql, req.subjectId);
        if (turn === null) {
          return { ok: false, reason: 'not_found' };
        }
        if (turn.cancel_requested_at_ms !== null) {
          return { ok: false, reason: 'cancelled' };
        }
        const fence = evaluateTurnFence(turn, req.leaseEpoch, req.leaseOwner, nowMs);
        if (!fence.ok) {
          return {
            ok: false,
            reason:
              fence.reason === 'terminal'
                ? 'fenced'
                : fence.reason === 'cancelled'
                  ? 'cancelled'
                  : fence.reason,
          };
        }
        deadlineAtMs = turn.deadline_at_ms;
        leaseExpiresAtMs = turn.lease_expires_at_ms;
      } else {
        const task = this.deps.storage.sql
          .exec<{
            readonly status: string;
            readonly lease_epoch: number;
            readonly lease_expires_at_ms: number | null;
            readonly deadline_at_ms: number | null;
            readonly cancel_requested_at_ms: number | null;
          }>(
            `SELECT status, lease_epoch, lease_expires_at_ms, deadline_at_ms, cancel_requested_at_ms
               FROM tasks WHERE id = ?`,
            req.subjectId,
          )
          .toArray()[0];
        if (task === undefined) {
          return { ok: false, reason: 'not_found' };
        }
        if (task.cancel_requested_at_ms !== null) {
          return { ok: false, reason: 'cancelled' };
        }
        if (task.status !== 'running' || task.lease_epoch !== req.leaseEpoch) {
          return { ok: false, reason: 'fenced' };
        }
        if (
          task.lease_expires_at_ms === null ||
          nowMs >= task.lease_expires_at_ms ||
          (task.deadline_at_ms !== null && nowMs >= task.deadline_at_ms)
        ) {
          return { ok: false, reason: 'expired' };
        }
        deadlineAtMs = task.deadline_at_ms ?? task.lease_expires_at_ms;
        leaseExpiresAtMs = task.lease_expires_at_ms;
      }

      if (attempt.global_grant_expires_ms !== null && nowMs >= attempt.global_grant_expires_ms) {
        return { ok: false, reason: 'expired' };
      }

      if (!isFinalCommit) {
        this.deps.storage.sql.exec(
          `UPDATE model_attempts
              SET send_authorizing_at_ms = ?
            WHERE subject_type = ? AND subject_id = ? AND attempt_no = ?
              AND send_started_at_ms IS NULL AND send_authorizing_at_ms IS NULL`,
          nowMs,
          req.subjectType,
          req.subjectId,
          req.attemptNo,
        );
      } else {
        this.deps.storage.sql.exec(
          `UPDATE model_attempts
              SET send_started_at_ms = ?
            WHERE subject_type = ? AND subject_id = ? AND attempt_no = ?
              AND send_started_at_ms IS NULL`,
          nowMs,
          req.subjectType,
          req.subjectId,
          req.attemptNo,
        );
      }

      const startBeforeMs = Math.min(
        leaseExpiresAtMs ?? deadlineAtMs,
        deadlineAtMs,
        attempt.global_grant_expires_ms ?? deadlineAtMs,
      );

      return {
        ok: true,
        globalGrantId: attempt.global_grant_id,
        budgetMode: attempt.budget_mode,
        nowMs,
        startBeforeMs,
      };
    };

    const pre = this.deps.storage.transactionSync(() => checkAttemptGateSync(false));
    if (!pre.ok) {
      return { authorized: false, reason: pre.reason };
    }

    let globalStartBeforeMs: number | null = null;
    if (pre.budgetMode !== 'disabled_echo_only' && pre.globalGrantId !== null) {
      let authRes;
      try {
        authRes = await this.deps.globalBudget.authorizeGlobalSend({
          tenantId: req.scope.tenantId,
          operationId: req.operationId,
          globalGrantId: pre.globalGrantId,
        });
      } catch {
        return { authorized: false, reason: 'budget_halted' };
      }
      if (!authRes.authorized) {
        return { authorized: false, reason: 'budget_halted' };
      }
      globalStartBeforeMs = authRes.startBeforeMs;
    }

    const post = this.deps.storage.transactionSync(() => checkAttemptGateSync(true));
    if (!post.ok) {
      return { authorized: false, reason: post.reason };
    }

    const effectiveStartBefore =
      globalStartBeforeMs === null
        ? post.startBeforeMs
        : Math.min(post.startBeforeMs, globalStartBeforeMs);

    return {
      authorized: true,
      sentAtMs: post.nowMs,
      startBeforeMs: effectiveStartBefore,
    };
  }

  async renewTurnLease(rawReq: RenewTurnLeaseRequest): Promise<RenewTurnLeaseResult> {
    const req = parseRenewTurnLeaseRequest(rawReq);
    const localResult = this.deps.storage.transactionSync(() => {
      const nowMs = this.deps.nowMs();
      const meta = getHeadMetaSync(this.deps.storage.sql);
      if (
        meta === null ||
        meta.tenant_id !== req.scope.tenantId ||
        meta.agent_id !== req.scope.agentId
      ) {
        return { renewed: false as const, reason: 'not_found' as const };
      }

      const turn = getTurnRowSync(this.deps.storage.sql, req.turnId);
      if (turn === null || turn.conversation_id !== req.conversationId) {
        return { renewed: false as const, reason: 'not_found' as const };
      }

      if (turn.cancel_requested_at_ms !== null) {
        return { renewed: false as const, reason: 'cancelled' as const };
      }

      const fence = evaluateTurnFence(turn, req.leaseEpoch, req.leaseOwner, nowMs);
      if (!fence.ok) {
        return {
          renewed: false as const,
          reason:
            fence.reason === 'terminal'
              ? ('fenced' as const)
              : fence.reason === 'cancelled'
                ? ('cancelled' as const)
                : fence.reason,
        };
      }

      const extendedUntilMs = Math.min(nowMs + req.extendMs, turn.deadline_at_ms);
      const nextLeaseExpiresAtMs = Math.max(turn.lease_expires_at_ms!, extendedUntilMs);

      this.deps.storage.sql.exec(
        `UPDATE assistant_turns
            SET lease_expires_at_ms = ?,
                updated_at_ms = ?
          WHERE id = ?`,
        nextLeaseExpiresAtMs,
        nowMs,
        turn.id,
      );

      // Push fallback turn outbox forward if still pending/enqueued
      const nextFallbackAtMs = Math.min(
        nextLeaseExpiresAtMs + V2_TIMING_LIMITS.fastPathOutboxGraceMs,
        Math.max(nowMs + 1, turn.deadline_at_ms - 1),
      );
      this.deps.storage.sql.exec(
        `UPDATE v2_dispatch_outbox
            SET next_attempt_at_ms = ?,
                updated_at_ms = ?
          WHERE entity_kind = 'turn'
            AND entity_id = ?
            AND fence_epoch = ?
            AND state IN ('pending', 'enqueued')`,
        nextFallbackAtMs,
        nowMs,
        turn.id,
        turn.lease_epoch,
      );

      this.deps.eventPorts.recomputeAlarmSync(nowMs);

      const activeAttempt = getLatestAttemptForSubjectSync(this.deps.storage.sql, 'turn', turn.id);
      return {
        renewed: true as const,
        leaseExpiresAtMs: nextLeaseExpiresAtMs,
        cancelRequested: false,
        grantToRenew:
          activeAttempt !== null &&
          activeAttempt.state === 'reserved' &&
          activeAttempt.global_grant_id !== null &&
          activeAttempt.budget_mode !== 'disabled_echo_only'
            ? {
                operationId: activeAttempt.operation_id,
                globalGrantId: activeAttempt.global_grant_id,
                newExpiresAtMs:
                  Math.max(nextLeaseExpiresAtMs, turn.deadline_at_ms) +
                  V2_TIMING_LIMITS.globalGrantTtlGraceMs,
              }
            : null,
      };
    });

    await this.deps.eventPorts.flushPendingAlarmOp();

    if (!localResult.renewed) {
      return localResult;
    }

    if (localResult.grantToRenew !== null) {
      try {
        await this.deps.globalBudget.renewGlobalGrant({
          tenantId: req.scope.tenantId,
          operationId: localResult.grantToRenew.operationId,
          globalGrantId: localResult.grantToRenew.globalGrantId,
          newExpiresAtMs: localResult.grantToRenew.newExpiresAtMs,
        });
      } catch {
        // Non-fatal: GlobalGrant already carries turnDeadline + 30s slack
      }
    }

    return {
      renewed: true,
      leaseExpiresAtMs: localResult.leaseExpiresAtMs,
      cancelRequested: localResult.cancelRequested,
    };
  }

  async handoffTurnToDurable(rawReq: HandoffTurnRequest): Promise<HandoffTurnResult> {
    const req = parseHandoffTurnRequest(rawReq);
    const outcome = this.deps.storage.transactionSync(() => {
      const nowMs = this.deps.nowMs();
      assertHeadScopeSync(this.deps.storage.sql, req.scope.tenantId, req.scope.agentId);

      const turn = getTurnRowSync(this.deps.storage.sql, req.turnId);
      if (turn === null || turn.conversation_id !== req.conversationId) {
        return { outcome: 'fenced' as const, currentStatus: 'failed' as const };
      }

      const activeAttempt = getLatestAttemptForSubjectSync(this.deps.storage.sql, 'turn', turn.id);

      const allowed = evaluateTurnHandoffGate({
        turn,
        req,
        activeAttempt,
        nowMs,
      });

      if (!allowed) {
        return {
          outcome: 'fenced' as const,
          currentStatus: turn.status,
        };
      }

      const nextLeaseEpoch = turn.lease_epoch + 1;
      const persistedHandle = req.providerJobHandle ?? turn.provider_job_handle;

      // Keep deadline_at_ms completely unchanged; move atomically to durable_queue
      this.deps.storage.sql.exec(
        `UPDATE assistant_turns
            SET execution_mode = 'durable_queue',
                lease_epoch = ?,
                lease_owner = NULL,
                lease_expires_at_ms = NULL,
                handoff_reason = ?,
                provider_job_handle = ?,
                updated_at_ms = ?
          WHERE id = ?`,
        nextLeaseEpoch,
        req.reason,
        persistedHandle,
        nowMs,
        turn.id,
      );

      this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
      this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);

      const outboxId = `handoff:${turn.id}:epoch:${nextLeaseEpoch}`;
      const envelope: V2DispatchEnvelope = {
        schemaVersion: 2,
        eventId: outboxId,
        tenantId: req.scope.tenantId,
        agentId: req.scope.agentId,
        entityKind: 'handoff',
        entityId: turn.id,
        queueName: 'durable_turn',
        fenceEpoch: nextLeaseEpoch,
      };
      this.deps.eventPorts.enqueueDurableOutboxSync({
        outboxId,
        entityKind: 'handoff',
        entityId: turn.id,
        queueName: 'durable_turn',
        payloadJson: JSON.stringify(envelope),
        fenceEpoch: nextLeaseEpoch,
        nextAttemptAtMs: nowMs,
      });

      this.deps.eventPorts.recomputeAlarmSync(nowMs);

      return {
        outcome: 'handed_off' as const,
        turnId: turn.id,
        nextLeaseEpoch,
        executionMode: 'durable_queue' as const,
      };
    });

    await this.deps.eventPorts.flushPendingAlarmOp();
    return outcome;
  }

  private async prepareDelegationCommand(
    tenantId: Id,
    agentId: Id,
    turnId: Id,
    delegation: B2TaskDelegationCommand,
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
        traceId: this.newId(),
        executionPath: 'standard',
      };
    }

    const attachmentIds = delegation.input.attachmentIds ?? [];
    const inputArtifactIds = await Promise.all(
      attachmentIds.map((uploadId) =>
        deterministicEdgeUuid(`ember.artifact:${tenantId}:${turnId}:${uploadId}`),
      ),
    );
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
        ...(inputArtifactIds.length > 0 ? { inputArtifactIds } : {}),
      },
    });
    return {
      kind: 'python.agent',
      ...(delegation.title !== undefined ? { title: delegation.title } : {}),
      inputJson: JSON.stringify(prepared.command.input),
      digest: prepared.digest,
      idempotencyKey,
      traceId: this.newId(),
      executionPath: 'heavy',
    };
  }

  private createOrReuseDelegatedTaskSync(
    tenantId: Id,
    agentId: Id,
    conversationId: Id,
    turnId: Id,
    prepared: PreparedDelegationPayload,
    nowMs: number,
  ): Id {
    const sql = this.deps.storage.sql;
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
      taskId = this.newId();
      sql.exec(
        `INSERT INTO tasks (
           id, kind, title, input_json, digest, idempotency_key, status,
           execution_path, execution_target, attempt_count, max_attempts,
           lease_epoch, next_run_at_ms, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 'cloud', 0, 3, 1, ?, ?, ?)`,
        taskId,
        prepared.kind,
        prepared.title ?? null,
        prepared.inputJson,
        prepared.digest,
        prepared.idempotencyKey,
        prepared.executionPath,
        nowMs,
        nowMs,
        nowMs,
      );
      sql.exec(
        `INSERT INTO task_events (
           id, task_id, sequence, phase, payload_json, trace_id, occurred_at_ms
         ) VALUES (?, ?, 1, 'accepted', ?, ?, ?)`,
        this.newId(),
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
      this.deps.eventPorts.enqueueDurableOutboxSync({
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
        this.newId(),
        conversationId,
        seq,
        taskId,
        nowMs,
      );
    }

    return taskId;
  }

  async commitTurn(rawReq: CommitTurnRequest): Promise<CommitTurnResult> {
    const req = parseCommitTurnRequest(rawReq);
    if (
      req.result.status === 'completed' &&
      !req.result.simulated &&
      SIMULATED_LABEL_PATTERN.test(req.result.modelLabel)
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'simulated model label cannot be committed with simulated=false',
      );
    }

    let preparedDelegation: PreparedDelegationPayload | null = null;
    if (req.result.status === 'completed' && req.result.delegation !== undefined) {
      preparedDelegation = await this.prepareDelegationCommand(
        req.scope.tenantId,
        req.scope.agentId,
        req.turnId,
        req.result.delegation,
      );

      // Ensure D1 recovery coverage covers delegated task due immediately (nowMs + 45_000) before commit
      const nowPre = this.deps.nowMs();
      const delegationBound = nowPre + V2_TIMING_LIMITS.d1RecoveryGraceMs;
      const delegationPlan = this.deps.storage.transactionSync(() =>
        this.deps.eventPorts.inspectCoverageSync(delegationBound, nowPre),
      );
      if (delegationPlan.kind === 'register') {
        const assured = await this.ensureRecoveryCoverageAsync({
          tenantId: req.scope.tenantId,
          agentId: req.scope.agentId,
          generation: delegationPlan.generation,
          targetAtMs: delegationPlan.targetAtMs,
          requiredDiscoveryMs: delegationBound,
          nowMs: nowPre,
        });
        this.deps.storage.transactionSync(() => {
          this.deps.eventPorts.confirmCoverageSync({
            generation: assured.activeGeneration,
            actualRecoveryAtMs: assured.actualRecoveryAtMs,
            applied: true,
            earliestRequiredRecoveryMs: delegationBound,
            nowMs: this.deps.nowMs(),
          });
        });
      }
    }

    const commitResult = this.deps.storage.transactionSync(() => {
      const nowMs = this.deps.nowMs();
      assertHeadScopeSync(this.deps.storage.sql, req.scope.tenantId, req.scope.agentId);

      const turn = getTurnRowSync(this.deps.storage.sql, req.turnId);
      const attempt =
        sqlExecMaybe<ModelAttemptRow>(
          this.deps.storage.sql,
          `SELECT *
             FROM model_attempts
            WHERE subject_type = 'turn' AND subject_id = ? AND attempt_no = ?`,
          req.turnId,
          req.attemptNo,
        ) ?? undefined;

      if (turn === null || turn.conversation_id !== req.conversationId) {
        return { outcome: 'fenced' as const, turn: null };
      }

      const fence = evaluateTurnFence(turn, req.leaseEpoch, req.leaseOwner, nowMs, {
        allowCancelRequested: true,
      });

      // Fencing failure (wrong owner, stale epoch, already terminal, or expired lease)
      if (
        !fence.ok &&
        !(
          turn.status === 'running' &&
          fence.reason === 'expired' &&
          nowMs >= turn.deadline_at_ms &&
          turn.lease_owner === req.leaseOwner &&
          turn.lease_epoch === req.leaseEpoch
        )
      ) {
        // Never allow a stale epoch to settle an active `'reserved'` attempt still owned by a newer epoch.
        // Only reconcile already-settled / `unknown_billed` / closed attempts (late overage / audit per §5.3 & §7.2).
        if (
          attempt !== undefined &&
          attempt.operation_id === req.operationId &&
          (attempt.state !== 'reserved' || turn.status !== 'running')
        ) {
          settleLocalAttemptAndEnqueueSync({
            sql: this.deps.storage.sql,
            coordinator: this.deps.eventPorts,
            tenantId: req.scope.tenantId,
            agentId: req.scope.agentId,
            attempt,
            requestedState: req.settlement.state,
            outcomeCode: req.settlement.outcomeCode,
            observedCostMicroUsd: req.settlement.observedCostMicroUsd ?? null,
            inputTokens: req.settlement.inputTokens ?? null,
            outputTokens: req.settlement.outputTokens ?? null,
            nowMs,
            ...(this.deps.localCeilings !== undefined ? { ceilings: this.deps.localCeilings } : {}),
            idFactory: this.newId,
          });
          this.deps.eventPorts.recomputeAlarmSync(nowMs);
        }
        return { outcome: 'fenced' as const, turn: toTurnDto(turn) };
      }

      // Lease itself expired before deadline -> fence publication, but preserve late overage if any
      if (turn.lease_expires_at_ms === null || nowMs >= turn.lease_expires_at_ms) {
        if (nowMs < turn.deadline_at_ms) {
          if (attempt !== undefined && attempt.operation_id === req.operationId) {
            settleLocalAttemptAndEnqueueSync({
              sql: this.deps.storage.sql,
              coordinator: this.deps.eventPorts,
              tenantId: req.scope.tenantId,
              agentId: req.scope.agentId,
              attempt,
              requestedState: req.settlement.state,
              outcomeCode: req.settlement.outcomeCode,
              observedCostMicroUsd: req.settlement.observedCostMicroUsd ?? null,
              inputTokens: req.settlement.inputTokens ?? null,
              outputTokens: req.settlement.outputTokens ?? null,
              nowMs,
              ...(this.deps.localCeilings !== undefined
                ? { ceilings: this.deps.localCeilings }
                : {}),
              idFactory: this.newId,
            });
            this.deps.eventPorts.recomputeAlarmSync(nowMs);
          }
          return { outcome: 'fenced' as const, turn: toTurnDto(turn) };
        }
      }

      // Settle local attempt + atomically enqueue `budget_sync` outbox in same transactionSync
      if (attempt !== undefined && attempt.operation_id === req.operationId) {
        settleLocalAttemptAndEnqueueSync({
          sql: this.deps.storage.sql,
          coordinator: this.deps.eventPorts,
          tenantId: req.scope.tenantId,
          agentId: req.scope.agentId,
          attempt,
          requestedState: req.settlement.state,
          outcomeCode: req.settlement.outcomeCode,
          observedCostMicroUsd: req.settlement.observedCostMicroUsd ?? null,
          inputTokens: req.settlement.inputTokens ?? null,
          outputTokens: req.settlement.outputTokens ?? null,
          nowMs,
          ...(this.deps.localCeilings !== undefined ? { ceilings: this.deps.localCeilings } : {}),
          idFactory: this.newId,
        });
      }

      // Cancelled Turn wins unconditionally over publishing completed reply
      if (turn.cancel_requested_at_ms !== null) {
        this.deps.storage.sql.exec(
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
        this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
        this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
        this.deps.eventPorts.recomputeAlarmSync(nowMs);
        const updated = getTurnRowSync(this.deps.storage.sql, turn.id)!;
        return { outcome: 'reconciled_only' as const, turn: toTurnDto(updated) };
      }

      // Exceeded total lifetime deadline -> fail with safe fixed message (timeout)
      if (nowMs >= turn.deadline_at_ms) {
        const { messageId, sequence } = insertEmberMessageSync({
          sql: this.deps.storage.sql,
          messageId: this.newId(),
          conversationId: turn.conversation_id,
          text: V2_B1_COMPAT_CONSTANTS.failureAssistantMessageText,
          modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
          simulated: true,
          nowMs,
        });
        this.deps.storage.sql.exec(
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
        this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
        this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
        this.deps.eventPorts.recomputeAlarmSync(nowMs);
        const updated = getTurnRowSync(this.deps.storage.sql, turn.id)!;
        if (req.result.status === 'failed') {
          return {
            outcome: 'published' as const,
            turn: toTurnDto(updated),
            responseMessageId: messageId,
            sequence,
            delegatedTaskId: null,
          };
        }
        return { outcome: 'reconciled_only' as const, turn: toTurnDto(updated) };
      }

      if (req.result.status === 'aborted_for_retry_or_reconcile') {
        const nextEpoch = turn.lease_epoch + 1;
        this.deps.storage.sql.exec(
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
        this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
        this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
        const outboxId = `turn:${turn.id}:epoch:${nextEpoch}`;
        const envelope: V2DispatchEnvelope = {
          schemaVersion: 2,
          eventId: outboxId,
          tenantId: req.scope.tenantId,
          agentId: req.scope.agentId,
          entityKind: 'turn',
          entityId: turn.id,
          queueName: 'durable_turn',
          fenceEpoch: nextEpoch,
        };
        this.deps.eventPorts.enqueueDurableOutboxSync({
          outboxId,
          entityKind: 'turn',
          entityId: turn.id,
          queueName: 'durable_turn',
          payloadJson: JSON.stringify(envelope),
          fenceEpoch: nextEpoch,
          nextAttemptAtMs: nowMs,
        });
        this.deps.eventPorts.recomputeAlarmSync(nowMs);
        const updated = getTurnRowSync(this.deps.storage.sql, turn.id)!;
        return { outcome: 'reconciled_only' as const, turn: toTurnDto(updated) };
      }

      if (req.result.status === 'failed') {
        const { messageId, sequence } = insertEmberMessageSync({
          sql: this.deps.storage.sql,
          messageId: this.newId(),
          conversationId: turn.conversation_id,
          text: V2_B1_COMPAT_CONSTANTS.failureAssistantMessageText,
          modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
          simulated: true,
          nowMs,
        });
        this.deps.storage.sql.exec(
          `UPDATE assistant_turns
              SET status = 'failed',
                  failure_reason = ?,
                  response_message_id = ?,
                  lease_owner = NULL,
                  lease_expires_at_ms = NULL,
                  updated_at_ms = ?
            WHERE id = ?`,
          req.result.failureReason,
          messageId,
          nowMs,
          turn.id,
        );
        this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
        this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
        this.deps.eventPorts.recomputeAlarmSync(nowMs);
        const updated = getTurnRowSync(this.deps.storage.sql, turn.id)!;
        return {
          outcome: 'published' as const,
          turn: toTurnDto(updated),
          responseMessageId: messageId,
          sequence,
          delegatedTaskId: null,
        };
      }

      // status === 'completed'
      let delegatedTaskId: Id | null = null;
      if (preparedDelegation !== null) {
        delegatedTaskId = this.createOrReuseDelegatedTaskSync(
          req.scope.tenantId,
          req.scope.agentId,
          turn.conversation_id,
          turn.id,
          preparedDelegation,
          nowMs,
        );
      }

      const { messageId, sequence } = insertEmberMessageSync({
        sql: this.deps.storage.sql,
        messageId: this.newId(),
        conversationId: turn.conversation_id,
        text: req.result.text,
        modelLabel: req.result.modelLabel,
        simulated: req.result.simulated,
        nowMs,
      });

      this.deps.storage.sql.exec(
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
      this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
      this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      this.deps.eventPorts.recomputeAlarmSync(nowMs);

      const updated = getTurnRowSync(this.deps.storage.sql, turn.id)!;
      return {
        outcome: 'published' as const,
        turn: toTurnDto(updated),
        responseMessageId: messageId,
        sequence,
        delegatedTaskId,
      };
    });

    await this.deps.eventPorts.flushPendingAlarmOp();
    await this.deps.flushBudgetSyncAfterCommit();
    return commitResult;
  }

  async cancelTurn(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
  }): Promise<B1AssistantTurnDto> {
    const dto = this.deps.storage.transactionSync(() => {
      const nowMs = this.deps.nowMs();
      assertHeadScopeSync(this.deps.storage.sql, req.tenantId, req.agentId);

      const turn = getTurnRowSync(this.deps.storage.sql, req.turnId);
      if (turn === null || turn.conversation_id !== req.conversationId) {
        throw new DomainError('NOT_FOUND', 'turn is not visible in this tenant');
      }

      if (turn.status !== 'running') {
        return toTurnDto(turn);
      }

      const reservedAttempts = listReservedAttemptsSync(this.deps.storage.sql, 'turn', turn.id);
      for (const attempt of reservedAttempts) {
        const provablyUnsent =
          attempt.send_started_at_ms === null && attempt.send_authorizing_at_ms === null;
        settleLocalAttemptAndEnqueueSync({
          sql: this.deps.storage.sql,
          coordinator: this.deps.eventPorts,
          tenantId: req.tenantId,
          agentId: req.agentId,
          attempt,
          requestedState: provablyUnsent ? 'released' : 'unknown_billed',
          outcomeCode: 'client_cancelled',
          nowMs,
          ...(this.deps.localCeilings !== undefined ? { ceilings: this.deps.localCeilings } : {}),
          idFactory: this.newId,
        });
      }

      this.deps.storage.sql.exec(
        `UPDATE assistant_turns
            SET status = 'cancelled',
                failure_reason = NULL,
                response_message_id = NULL,
                cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
                lease_owner = NULL,
                lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ?`,
        nowMs,
        nowMs,
        turn.id,
      );

      // J5: cancel ordinary turn/handoff outbox rows ONLY — never touch `budget_sync`!
      this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
      this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      this.deps.eventPorts.recomputeAlarmSync(nowMs);

      const updated = getTurnRowSync(this.deps.storage.sql, turn.id)!;
      return toTurnDto(updated);
    });

    await this.deps.eventPorts.flushPendingAlarmOp();
    await this.deps.flushBudgetSyncAfterCommit();
    return dto;
  }

  async clearTranscript(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
  }): Promise<B1TranscriptClearResult> {
    const result = this.deps.storage.transactionSync(() => {
      const nowMs = this.deps.nowMs();
      assertHeadScopeSync(this.deps.storage.sql, req.tenantId, req.agentId);

      const conv = getConversationSync(this.deps.storage.sql, req.conversationId);
      if (conv === null) {
        throw new DomainError('NOT_FOUND', 'conversation not found in agent head');
      }

      const turns = sqlExecAll<AssistantTurnRow>(
        this.deps.storage.sql,
        `SELECT * FROM assistant_turns WHERE conversation_id = ?`,
        req.conversationId,
      );

      for (const turn of turns) {
        const reserved = listReservedAttemptsSync(this.deps.storage.sql, 'turn', turn.id);
        for (const attempt of reserved) {
          const provablyUnsent =
            attempt.send_started_at_ms === null && attempt.send_authorizing_at_ms === null;
          settleLocalAttemptAndEnqueueSync({
            sql: this.deps.storage.sql,
            coordinator: this.deps.eventPorts,
            tenantId: req.tenantId,
            agentId: req.agentId,
            attempt,
            requestedState: provablyUnsent ? 'released' : 'unknown_billed',
            outcomeCode: 'client_cancelled',
            nowMs,
            ...(this.deps.localCeilings !== undefined ? { ceilings: this.deps.localCeilings } : {}),
            idFactory: this.newId,
          });
        }
        this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
        this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      }

      const msgCount = this.deps.storage.sql
        .exec<{ readonly cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM conversation_messages WHERE conversation_id = ?`,
          req.conversationId,
        )
        .one().cnt;

      const deletedTurns = turns.length;

      // Delete turns before messages; never touch tasks/runs/results/model_attempts/budget_sync
      this.deps.storage.sql.exec(
        `DELETE FROM assistant_turns WHERE conversation_id = ?`,
        req.conversationId,
      );
      this.deps.storage.sql.exec(
        `DELETE FROM message_attachments WHERE message_id IN (
           SELECT id FROM conversation_messages WHERE conversation_id = ?
         )`,
        req.conversationId,
      );
      this.deps.storage.sql.exec(
        `DELETE FROM conversation_messages WHERE conversation_id = ?`,
        req.conversationId,
      );

      const nextEpoch = conv.transcript_epoch + 1;
      this.deps.storage.sql.exec(
        `UPDATE conversations
            SET transcript_epoch = ?,
                updated_at_ms = ?
          WHERE id = ?`,
        nextEpoch,
        nowMs,
        req.conversationId,
      );

      this.deps.eventPorts.recomputeAlarmSync(nowMs);

      return {
        deletedMessages: msgCount,
        deletedTurns,
        transcriptEpoch: nextEpoch,
      };
    });

    await this.deps.eventPorts.flushPendingAlarmOp();
    await this.deps.flushBudgetSyncAfterCommit();
    return result;
  }

  async getMainConversation(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
  }): Promise<B1ConversationIdentity | null> {
    return Promise.resolve(
      this.deps.storage.transactionSync(() => {
        const meta = getHeadMetaSync(this.deps.storage.sql);
        if (meta === null || meta.tenant_id !== req.tenantId || meta.agent_id !== req.agentId) {
          return null;
        }
        const conv = getMainConversationSync(this.deps.storage.sql);
        if (conv === null) {
          return null;
        }
        return {
          conversationId: conv.id,
          tenantId: meta.tenant_id,
          agentId: meta.agent_id,
          transcriptEpoch: conv.transcript_epoch,
          lastSequence: conv.last_sequence,
        };
      }),
    );
  }

  async readMessages(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
    readonly after: number;
    readonly limit: number;
  }): Promise<B1ConversationPage> {
    if (
      !Number.isSafeInteger(req.after) ||
      req.after < 0 ||
      !Number.isSafeInteger(req.limit) ||
      req.limit < 1 ||
      req.limit > B1_MESSAGE_PAGE_MAX_LIMIT
    ) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid readMessages pagination cursor');
    }

    return Promise.resolve(
      this.deps.storage.transactionSync(() => {
        assertHeadScopeSync(this.deps.storage.sql, req.tenantId, req.agentId);
        const conv = getConversationSync(this.deps.storage.sql, req.conversationId);
        if (conv === null) {
          throw new DomainError('NOT_FOUND', 'conversation not found in agent head');
        }

        const rows = sqlExecAll<ConversationMessageRow>(
          this.deps.storage.sql,
          `SELECT *
             FROM conversation_messages
            WHERE conversation_id = ?
              AND sequence > ?
            ORDER BY sequence ASC
            LIMIT ?`,
          req.conversationId,
          req.after,
          req.limit + 1,
        );

        const hasMore = rows.length > req.limit;
        const pageMessages = rows.slice(0, req.limit).map(toConversationMessageDto);
        const lastMsg = pageMessages.at(-1);

        return B1ConversationPageSchema.parse({
          conversation_id: conv.id,
          transcript_epoch: conv.transcript_epoch,
          messages: pageMessages,
          next_after: lastMsg === undefined ? req.after : lastMsg.sequence,
          has_more: hasMore,
        });
      }),
    );
  }

  async findSubmissionReceipt(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly clientSubmissionId: Id;
  }): Promise<B1MessageSubmissionReconciliationDto | null> {
    return Promise.resolve(
      this.deps.storage.transactionSync(() => {
        const meta = getHeadMetaSync(this.deps.storage.sql);
        if (meta === null || meta.tenant_id !== req.tenantId || meta.agent_id !== req.agentId) {
          return null;
        }

        const row = this.deps.storage.sql
          .exec<{
            readonly message_id: string;
            readonly conversation_id: string;
            readonly sequence: number;
            readonly text: string;
            readonly client_submission_id: string;
            readonly message_created_at_ms: number;
            readonly turn_id: string;
            readonly turn_created_at_ms: number;
            readonly transcript_epoch: number;
          }>(
            `SELECT m.id AS message_id,
                    m.conversation_id,
                    m.sequence,
                    m.text,
                    m.client_submission_id,
                    m.created_at_ms AS message_created_at_ms,
                    t.id AS turn_id,
                    t.created_at_ms AS turn_created_at_ms,
                    c.transcript_epoch
               FROM conversation_messages m
               JOIN conversations c ON c.id = m.conversation_id
               JOIN assistant_turns t ON t.source_message_id = m.id
              WHERE m.client_submission_id = ?
                AND m.kind = 'user'
              LIMIT 1`,
            req.clientSubmissionId,
          )
          .toArray()[0];

        if (row === undefined) {
          return null;
        }

        return B1SendMessageReceiptSchema.parse({
          message: {
            message_id: row.message_id,
            conversation_id: row.conversation_id,
            sequence: row.sequence,
            kind: 'user',
            text: row.text,
            client_submission_id: row.client_submission_id,
            created_at: toIsoTimestamp(row.message_created_at_ms),
          },
          turn: {
            turn_id: row.turn_id,
            status: 'running',
            created_at: toIsoTimestamp(row.turn_created_at_ms),
          },
          transcript_epoch: row.transcript_epoch,
        });
      }),
    );
  }

  async getTurn(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
  }): Promise<B1AssistantTurnDto | null> {
    return Promise.resolve(
      this.deps.storage.transactionSync(() => {
        const meta = getHeadMetaSync(this.deps.storage.sql);
        if (meta === null || meta.tenant_id !== req.tenantId || meta.agent_id !== req.agentId) {
          return null;
        }
        const turn = getTurnRowSync(this.deps.storage.sql, req.turnId);
        if (turn === null || turn.conversation_id !== req.conversationId) {
          return null;
        }
        return toTurnDto(turn);
      }),
    );
  }
}
