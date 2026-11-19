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
import type {
  EventRuntimeCoordinatorPort,
  RecoveryAdmissionPort,
  RecoveryRegistryPort,
} from '../recovery/ports.js';
import type { V2RecoveryCoverageRow } from '../recovery/schema.js';
import type { DurableObjectStorageLike } from '../storage.js';
import {
  checkLocalBudgetCapacitySync,
  enqueueBudgetReleaseCompensationSync,
  findLocalUnresolvedIncidentSync,
  reserveLocalAttemptSync,
  settleLocalAttemptAndEnqueueSync,
  type LocalBudgetCeilings,
} from './budget.js';
import {
  allocateConversationSequenceSync,
  assertHeadScopeSync,
  getConversationSync,
  getHeadMetaSync,
  getLatestAttemptForSubjectSync,
  getLatestRunForTaskSync,
  getMainConversationSync,
  getTaskRowSync,
  getTurnRowSync,
  listAttachmentsForMessageSync,
  listReservedAttemptsSync,
  readRecentTurnContextSync,
  sqlExecAll,
  sqlExecMaybe,
  toConversationMessageDto,
  toTurnDto,
} from './queries.js';
import type { AgentHeadRecoveryService, RecoveryCoordinatorHooks } from './recovery-service.js';
import type { AssistantTurnRow, ConversationMessageRow, ModelAttemptRow } from './schema.js';
import {
  evaluateTurnFence,
  evaluateTurnHandoffGate,
  toIsoTimestamp,
  toUtcDayString,
} from './state-machine.js';
import {
  ensureRecoveryCoverageAsync as ensureSharedRecoveryCoverageAsync,
  executeAuthoritativeTurnCommit,
  isCoverageValidAtSync as isSharedCoverageValidAtSync,
  syncAlarmAndRelayBudget as syncSharedAlarmAndRelayBudget,
  type TurnCommitDeps,
} from './turn-commit.js';

const B1_MESSAGE_PAGE_MAX_LIMIT = 100;

export interface TurnRecoverySeamHooks extends RecoveryCoordinatorHooks {
  /** Maps to `RecoveryCoverageCoordinator.getCoverageRowSync`. */
  readonly getCoverageRowSync?: () => V2RecoveryCoverageRow | null;
}

export interface TurnServiceDeps {
  readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly recoveryAdmission: RecoveryAdmissionPort;
  readonly eventCoordinator: EventRuntimeCoordinatorPort;
  readonly recoveryService: AgentHeadRecoveryService;
  readonly recoveryHooks: TurnRecoverySeamHooks;
  readonly recoveryRegistry: RecoveryRegistryPort;
  readonly globalBudget: GlobalBudgetAuthority;
  readonly nowMs: () => number;
  readonly idFactory?: () => Id;
  readonly localCeilings?: LocalBudgetCeilings;
  readonly globalDailyCeilingMicroUsd?: number;
}

interface ReplayLookupResult {
  readonly receipt: B1SendMessageReceipt;
  readonly currentTurnStatus: AssistantTurnRow['status'];
}

export class AgentHeadTurnService implements AgentHeadRpc {
  private readonly newId: () => Id;
  private readonly globalDailyCeilingMicroUsd: number;

  constructor(private readonly deps: TurnServiceDeps) {
    this.newId = deps.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.globalDailyCeilingMicroUsd =
      deps.globalDailyCeilingMicroUsd ?? V2_BUDGET_LIMITS.globalDailyMicroUsd;
  }

  private toTurnCommitDeps(): TurnCommitDeps {
    return {
      storage: this.deps.storage,
      recoveryAdmission: this.deps.recoveryAdmission,
      eventCoordinator: this.deps.eventCoordinator,
      recoveryHooks: this.deps.recoveryHooks,
      recoveryRegistry: this.deps.recoveryRegistry,
      earliestDiscovery: this.deps.recoveryService,
      nowMs: this.deps.nowMs,
      idFactory: this.newId,
      ...(this.deps.localCeilings !== undefined ? { localCeilings: this.deps.localCeilings } : {}),
    };
  }

  private isCoverageValidAtSync(requiredRecoveryAtMs: number): boolean {
    return isSharedCoverageValidAtSync(
      { storage: this.deps.storage, recoveryHooks: this.deps.recoveryHooks },
      requiredRecoveryAtMs,
    );
  }

  private ensureRecoveryCoverageAsync(input: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly generation: number;
    readonly targetAtMs: number;
    readonly requiredDiscoveryMs: number;
  }): Promise<{ readonly activeGeneration: number; readonly actualRecoveryAtMs: number }> {
    return ensureSharedRecoveryCoverageAsync(this.toTurnCommitDeps(), input);
  }

  private syncAlarmAndRelayBudget(input: {
    readonly alarmAtMs: number | null | undefined;
    readonly nowMs: number;
    readonly shouldRelayBudgetSync: boolean;
  }): Promise<void> {
    return syncSharedAlarmAndRelayBudget({
      recoveryHooks: this.deps.recoveryHooks,
      alarmAtMs: input.alarmAtMs,
      nowMs: input.nowMs,
      shouldRelayBudgetSync: input.shouldRelayBudgetSync,
    });
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
    if (budgetMode !== 'disabled_echo_only' && estimatedMicroUsd <= 0) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'metered budget mode requires positive estimatedMicroUsd reservation',
      );
    }

    // Stage 1: Synchronous SQLite pre-check + exclusive coverage generation claim via Agent B port
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

      const coveragePlan = this.deps.recoveryAdmission.inspectCoverageSync(
        requiredDiscoveryMs,
        nowMs,
      );
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
          commitNow,
          alarmAtMs: undefined as number | null | undefined,
        };
      }

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

      const existingEarliest =
        this.deps.recoveryService.earliestRequiredDiscoveryAtMsSync(commitNow);
      const turnDiscoveryMs = commitNow + V2_TIMING_LIMITS.d1RecoveryGraceMs;
      const requiredAtStage3 =
        existingEarliest === null ? turnDiscoveryMs : Math.min(existingEarliest, turnDiscoveryMs);

      let coverageConfirmed = false;
      if (abortClass === null) {
        if (needsRegistryUpsert) {
          coverageConfirmed = this.deps.recoveryAdmission.confirmCoverageSync({
            generation: activeGeneration,
            actualRecoveryAtMs,
            applied: true,
            earliestRequiredRecoveryMs: requiredAtStage3,
            nowMs: commitNow,
          });
          if (!coverageConfirmed) {
            coverageConfirmed = this.isCoverageValidAtSync(requiredAtStage3);
          }
        } else {
          coverageConfirmed = this.isCoverageValidAtSync(requiredAtStage3);
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
        let alarmAtMs: number | null | undefined;
        if (globalGrantId !== null) {
          const compBound = commitNow + V2_TIMING_LIMITS.d1RecoveryGraceMs;
          const canConfirmOnAbort =
            needsRegistryUpsert &&
            this.deps.recoveryAdmission.confirmCoverageSync({
              generation: activeGeneration,
              actualRecoveryAtMs,
              applied: true,
              earliestRequiredRecoveryMs: compBound,
              nowMs: commitNow,
            });
          const hasValidCoverage = canConfirmOnAbort || this.isCoverageValidAtSync(compBound);

          if (hasValidCoverage) {
            enqueueBudgetReleaseCompensationSync({
              coordinator: this.deps.eventCoordinator,
              tenantId: req.scope.tenantId,
              principalId: req.scope.principalId,
              agentId: req.scope.agentId,
              utcDay: stage1.utcDay,
              globalGrantId,
              operationId: stage1.operationId,
              reservedMicroUsd: estimatedMicroUsd,
              fenceEpoch: 1,
              nowMs: commitNow,
            });
            alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(commitNow);
            durableComp = true;
          }
        }

        if (abortClass.status === 'replay') {
          return {
            status: 'replay' as const,
            replay: abortClass.replay,
            durableCompensationEnqueued: durableComp,
            commitNow,
            alarmAtMs,
          };
        }
        return {
          status: 'abort' as const,
          errorCode: abortClass.errorCode,
          reason: abortClass.reason,
          durableCompensationEnqueued: durableComp,
          commitNow,
          alarmAtMs,
        };
      }

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
      this.deps.eventCoordinator.enqueueDurableOutboxSync({
        outboxId,
        entityKind: 'turn',
        entityId: turnId,
        queueName: 'durable_turn',
        payloadJson: JSON.stringify(envelope),
        fenceEpoch: 1,
        nextAttemptAtMs: fallbackNextAttemptAtMs,
      });

      const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(commitNow);

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
        commitNow,
        alarmAtMs,
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

    if (stage3Outcome.status !== 'committed') {
      await this.syncAlarmAndRelayBudget({
        alarmAtMs: stage3Outcome.alarmAtMs,
        nowMs: stage3Outcome.commitNow,
        shouldRelayBudgetSync: globalGrantId !== null && stage3Outcome.durableCompensationEnqueued,
      });

      if (globalGrantId !== null && !stage3Outcome.durableCompensationEnqueued) {
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

    await this.syncAlarmAndRelayBudget({
      alarmAtMs: stage3Outcome.alarmAtMs,
      nowMs: stage3Outcome.commitNow,
      shouldRelayBudgetSync: false,
    });

    return stage3Outcome.result;
  }

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
        const task = getTaskRowSync(this.deps.storage.sql, req.subjectId);
        if (task === null) {
          return { ok: false, reason: 'not_found' };
        }
        if (task.cancel_requested_at_ms !== null) {
          return { ok: false, reason: 'cancelled' };
        }
        const run =
          task.current_run_id !== null
            ? getLatestRunForTaskSync(this.deps.storage.sql, task.id)
            : null;
        if (
          task.status !== 'running' ||
          task.lease_epoch !== req.leaseEpoch ||
          task.current_run_id === null ||
          run === null ||
          run.id !== task.current_run_id ||
          run.status !== 'running' ||
          run.lease_epoch !== req.leaseEpoch ||
          run.worker_id !== req.leaseOwner
        ) {
          return { ok: false, reason: 'fenced' };
        }
        if (
          task.lease_expires_at_ms === null ||
          nowMs >= task.lease_expires_at_ms ||
          nowMs >= run.leased_until_ms ||
          (task.deadline_at_ms !== null && nowMs >= task.deadline_at_ms)
        ) {
          return { ok: false, reason: 'expired' };
        }
        deadlineAtMs =
          task.deadline_at_ms ?? Math.min(task.lease_expires_at_ms, run.leased_until_ms);
        leaseExpiresAtMs = Math.min(task.lease_expires_at_ms, run.leased_until_ms);
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
    if (pre.budgetMode !== 'disabled_echo_only') {
      if (pre.globalGrantId === null) {
        return { authorized: false, reason: 'budget_halted' };
      }
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

      const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);

      const activeAttempt = getLatestAttemptForSubjectSync(this.deps.storage.sql, 'turn', turn.id);
      return {
        renewed: true as const,
        nowMs,
        alarmAtMs,
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

    if (!localResult.renewed) {
      return localResult;
    }

    await this.syncAlarmAndRelayBudget({
      alarmAtMs: localResult.alarmAtMs,
      nowMs: localResult.nowMs,
      shouldRelayBudgetSync: false,
    });

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
    const tx = this.deps.storage.transactionSync(() => {
      const nowMs = this.deps.nowMs();
      assertHeadScopeSync(this.deps.storage.sql, req.scope.tenantId, req.scope.agentId);

      const turn = getTurnRowSync(this.deps.storage.sql, req.turnId);
      if (turn === null || turn.conversation_id !== req.conversationId) {
        return {
          res: { outcome: 'fenced' as const, currentStatus: 'failed' as const },
          alarmAtMs: undefined as number | null | undefined,
          nowMs,
        };
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
          res: { outcome: 'fenced' as const, currentStatus: turn.status },
          alarmAtMs: undefined as number | null | undefined,
          nowMs,
        };
      }

      const nextLeaseEpoch = turn.lease_epoch + 1;
      const persistedHandle = req.providerJobHandle ?? turn.provider_job_handle;

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

      this.deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
      this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);

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
      this.deps.eventCoordinator.enqueueDurableOutboxSync({
        outboxId,
        entityKind: 'handoff',
        entityId: turn.id,
        queueName: 'durable_turn',
        payloadJson: JSON.stringify(envelope),
        fenceEpoch: nextLeaseEpoch,
        nextAttemptAtMs: nowMs,
      });

      const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);

      return {
        res: {
          outcome: 'handed_off' as const,
          turnId: turn.id,
          nextLeaseEpoch,
          executionMode: 'durable_queue' as const,
        },
        alarmAtMs,
        nowMs,
      };
    });

    await this.syncAlarmAndRelayBudget({
      alarmAtMs: tx.alarmAtMs,
      nowMs: tx.nowMs,
      shouldRelayBudgetSync: false,
    });
    return tx.res;
  }

  async commitTurn(rawReq: CommitTurnRequest): Promise<CommitTurnResult> {
    const req = parseCommitTurnRequest(rawReq);
    return executeAuthoritativeTurnCommit(this.toTurnCommitDeps(), {
      tenantId: req.scope.tenantId,
      agentId: req.scope.agentId,
      conversationId: req.conversationId,
      turnId: req.turnId,
      leaseEpoch: req.leaseEpoch,
      leaseOwner: req.leaseOwner,
      attemptNo: req.attemptNo,
      operationId: req.operationId,
      settlement: req.settlement,
      result: req.result,
      allowDeadlineTimeoutPublish: true,
      throwOnScopeMismatch: true,
    });
  }

  async cancelTurn(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
  }): Promise<B1AssistantTurnDto> {
    const tx = this.deps.storage.transactionSync(() => {
      const nowMs = this.deps.nowMs();
      assertHeadScopeSync(this.deps.storage.sql, req.tenantId, req.agentId);

      const turn = getTurnRowSync(this.deps.storage.sql, req.turnId);
      if (turn === null || turn.conversation_id !== req.conversationId) {
        throw new DomainError('NOT_FOUND', 'turn is not visible in this tenant');
      }

      if (turn.status !== 'running') {
        return {
          dto: toTurnDto(turn),
          alarmAtMs: undefined as number | null | undefined,
          nowMs,
          hasBudgetSync: false,
        };
      }

      let hasBudgetSync = false;
      const reservedAttempts = listReservedAttemptsSync(this.deps.storage.sql, 'turn', turn.id);
      for (const attempt of reservedAttempts) {
        const provablyUnsent =
          attempt.send_started_at_ms === null && attempt.send_authorizing_at_ms === null;
        const settled = settleLocalAttemptAndEnqueueSync({
          sql: this.deps.storage.sql,
          coordinator: this.deps.eventCoordinator,
          tenantId: req.tenantId,
          agentId: req.agentId,
          attempt,
          requestedState: provablyUnsent ? 'released' : 'unknown_billed',
          outcomeCode: 'client_cancelled',
          nowMs,
          ...(this.deps.localCeilings !== undefined ? { ceilings: this.deps.localCeilings } : {}),
          idFactory: this.newId,
        });
        if (settled.outboxId !== null) {
          hasBudgetSync = true;
        }
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

      this.deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
      this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);

      const updated = getTurnRowSync(this.deps.storage.sql, turn.id)!;
      return { dto: toTurnDto(updated), alarmAtMs, nowMs, hasBudgetSync };
    });

    await this.syncAlarmAndRelayBudget({
      alarmAtMs: tx.alarmAtMs,
      nowMs: tx.nowMs,
      shouldRelayBudgetSync: tx.hasBudgetSync,
    });
    return tx.dto;
  }

  async clearTranscript(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
  }): Promise<B1TranscriptClearResult> {
    const tx = this.deps.storage.transactionSync(() => {
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

      let hasBudgetSync = false;
      for (const turn of turns) {
        const reserved = listReservedAttemptsSync(this.deps.storage.sql, 'turn', turn.id);
        for (const attempt of reserved) {
          const provablyUnsent =
            attempt.send_started_at_ms === null && attempt.send_authorizing_at_ms === null;
          const settled = settleLocalAttemptAndEnqueueSync({
            sql: this.deps.storage.sql,
            coordinator: this.deps.eventCoordinator,
            tenantId: req.tenantId,
            agentId: req.agentId,
            attempt,
            requestedState: provablyUnsent ? 'released' : 'unknown_billed',
            outcomeCode: 'client_cancelled',
            nowMs,
            ...(this.deps.localCeilings !== undefined ? { ceilings: this.deps.localCeilings } : {}),
            idFactory: this.newId,
          });
          if (settled.outboxId !== null) {
            hasBudgetSync = true;
          }
        }
        this.deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
        this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      }

      const msgCount = this.deps.storage.sql
        .exec<{ readonly cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM conversation_messages WHERE conversation_id = ?`,
          req.conversationId,
        )
        .one().cnt;

      const deletedTurns = turns.length;

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

      const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);

      return {
        result: {
          deletedMessages: msgCount,
          deletedTurns,
          transcriptEpoch: nextEpoch,
        },
        alarmAtMs,
        nowMs,
        hasBudgetSync,
      };
    });

    await this.syncAlarmAndRelayBudget({
      alarmAtMs: tx.alarmAtMs,
      nowMs: tx.nowMs,
      shouldRelayBudgetSync: tx.hasBudgetSync,
    });
    return tx.result;
  }

  getMainConversation(req: {
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

  readMessages(req: {
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

  findSubmissionReceipt(req: {
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

  getTurn(req: {
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
