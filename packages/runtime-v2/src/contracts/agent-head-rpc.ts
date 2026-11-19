import type {
  B1AssistantTurnDto,
  B1ConversationPage,
  B1MessageSubmissionReconciliationDto,
  B1SendMessageReceipt,
  B1SendMessageRequest,
  B3StagedUploadMediaType,
  DelegationToolName,
} from '@ember/contracts';
import type { Id, NotesActionItemsInput } from '@ember/domain';
import type { ModelAttemptBudgetMode, ModelAttemptProviderId } from '../agent-head/schema.js';
import type { BudgetSyncSettlementState } from '../recovery/envelope.js';
import type { TurnExecutionMode } from '../recovery/ports.js';

export type { TurnExecutionMode };

export interface AgentHeadCallerScope {
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly agentId: Id;
  readonly policyVersion: number;
  readonly requestId: Id;
}

export interface ModelReservationInput {
  readonly budgetMode: ModelAttemptBudgetMode;
  readonly providerId: ModelAttemptProviderId;
  readonly modelLabel: string;
  readonly rateVersion: string;
  readonly maxAttempts: number;
  readonly estimatedMicroUsd: number;
}

/** Pre-validated staged upload metadata persisted into `message_attachments` when attachments are present. */
export interface ResolvedMessageAttachment {
  readonly uploadId: Id;
  readonly filename: string;
  readonly mediaType: B3StagedUploadMediaType;
  readonly sizeBytes: number;
  readonly r2Key: string;
  readonly sha256: string;
}

export interface B2MessageAttachmentMeta {
  readonly uploadId: Id;
  readonly filename: string;
  readonly mediaType: B3StagedUploadMediaType;
  readonly sizeBytes: number;
}

export interface B2TurnContextRow {
  readonly sequence: number;
  readonly kind: 'user' | 'ember';
  readonly text: string;
  readonly attachments?: readonly B2MessageAttachmentMeta[];
}

export type B2TaskDelegationCommand =
  | {
      readonly toolName: Extract<DelegationToolName, 'delegate_notes_action_items'>;
      readonly title?: string;
      readonly input: NotesActionItemsInput;
    }
  | {
      readonly toolName: Extract<DelegationToolName, 'delegate_python_agent'>;
      readonly title?: string;
      readonly input: {
        readonly prompt: string;
        readonly instructions?: string;
        readonly attachmentIds?: readonly Id[];
      };
    };

export interface B1ConversationIdentity {
  readonly conversationId: Id;
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly transcriptEpoch: number;
  readonly lastSequence: number;
}

export interface B1TranscriptClearResult {
  readonly deletedMessages: number;
  readonly deletedTurns: number;
  readonly transcriptEpoch: number;
}

export interface PrepareTurnRequest {
  readonly scope: AgentHeadCallerScope;
  readonly conversationId: Id;
  readonly request: B1SendMessageRequest;
  readonly workerId: string;
  /** `45_000` (SSE stream), `25_000` (B1 waitUntil), or durable leaseMs. */
  readonly leaseMs: number;
  /** `120_000` (SSE stream) or `22_000` (B1 waitUntil soft handoff). */
  readonly interactiveDeadlineMs: number;
  /** `60_000` (B1 compat) or `600_000` (V2 long-turn handoff budget). */
  readonly turnDeadlineMs: number;
  readonly executionMode: TurnExecutionMode;
  readonly modelReservation?: ModelReservationInput;
  /** Resolved staged attachment records matching `request.attachment_ids` order. */
  readonly resolvedAttachments?: readonly ResolvedMessageAttachment[];
}

export type PrepareTurnResult =
  | {
      readonly kind: 'prepared';
      readonly replayed: false;
      readonly receipt: B1SendMessageReceipt;
      readonly turnId: Id;
      readonly attemptNo: number;
      readonly operationId: Id;
      readonly leaseEpoch: number;
      readonly leaseExpiresAtMs: number | null;
      readonly interactiveDeadlineMs: number | null;
      readonly turnDeadlineMs: number;
      readonly utcDay: string;
      readonly reservedMicroUsd: number;
      readonly globalGrantId: string | null;
      readonly context: readonly B2TurnContextRow[];
      readonly attachments: readonly B2MessageAttachmentMeta[];
    }
  | {
      readonly kind: 'replay';
      readonly replayed: true;
      readonly receipt: B1SendMessageReceipt;
      readonly currentTurnStatus: 'running' | 'completed' | 'failed' | 'cancelled';
    };

/** Single outbound send gate & active lease / cancellation / halt check prior to provider HTTP egress. */
export interface MarkAttemptSentRequest {
  readonly scope: Pick<AgentHeadCallerScope, 'tenantId' | 'agentId'>;
  readonly subjectType: 'turn' | 'task';
  readonly subjectId: Id;
  readonly attemptNo: number;
  readonly operationId: Id;
  readonly leaseEpoch: number;
  readonly leaseOwner: string;
}

export type MarkAttemptSentResult =
  | { readonly authorized: true; readonly sentAtMs: number; readonly startBeforeMs: number }
  | {
      readonly authorized: false;
      readonly reason:
        'fenced' | 'expired' | 'cancelled' | 'already_sent' | 'budget_halted' | 'not_found';
    };

export interface RenewTurnLeaseRequest {
  readonly scope: Pick<AgentHeadCallerScope, 'tenantId' | 'agentId'>;
  readonly conversationId: Id;
  readonly turnId: Id;
  readonly leaseEpoch: number;
  readonly leaseOwner: string;
  readonly extendMs: number;
}

export type RenewTurnLeaseResult =
  | { readonly renewed: true; readonly leaseExpiresAtMs: number; readonly cancelRequested: boolean }
  | {
      readonly renewed: false;
      readonly reason: 'fenced' | 'expired' | 'cancelled' | 'not_found';
    };

export type HandoffTurnReason =
  | 'interactive_deadline_120s'
  | 'client_disconnect_handoff'
  | 'tool_delegation'
  | 'waituntil_window_handoff';

export interface HandoffTurnRequest {
  readonly scope: Pick<AgentHeadCallerScope, 'tenantId' | 'agentId'>;
  readonly conversationId: Id;
  readonly turnId: Id;
  readonly leaseEpoch: number;
  readonly leaseOwner: string;
  readonly reason: HandoffTurnReason;
  readonly providerJobHandle?: string;
  readonly checkpointRef?: string;
}

export type HandoffTurnResult =
  | {
      readonly outcome: 'handed_off';
      readonly turnId: Id;
      readonly nextLeaseEpoch: number;
      readonly executionMode: 'durable_queue';
    }
  | {
      readonly outcome: 'fenced';
      readonly currentStatus: 'completed' | 'failed' | 'cancelled' | 'running';
    };

export type CommitTurnOutcomeCode =
  | 'ok'
  | 'model_timeout'
  | 'model_unavailable'
  | 'model_rate_limited'
  | 'model_auth_failed'
  | 'model_invalid_output'
  | 'client_cancelled'
  | 'not_sent'
  | 'usage_missing';

export interface CommitTurnSettlementInput {
  readonly state: BudgetSyncSettlementState;
  readonly outcomeCode: CommitTurnOutcomeCode;
  readonly observedCostMicroUsd?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
}

export interface CommitTurnRequest {
  readonly scope: Pick<AgentHeadCallerScope, 'tenantId' | 'agentId'>;
  readonly conversationId: Id;
  readonly turnId: Id;
  readonly leaseEpoch: number;
  readonly leaseOwner: string;
  readonly attemptNo: number;
  readonly operationId: Id;
  readonly settlement: CommitTurnSettlementInput;
  readonly result:
    | {
        readonly status: 'completed';
        readonly text: string;
        readonly modelLabel: string;
        readonly simulated: boolean;
        readonly delegation?: B2TaskDelegationCommand;
      }
    | {
        readonly status: 'failed';
        readonly failureReason: 'timeout' | 'internal_error';
      }
    | {
        readonly status: 'aborted_for_retry_or_reconcile';
      };
}

export type CommitTurnResult =
  | {
      readonly outcome: 'published';
      readonly turn: B1AssistantTurnDto;
      readonly responseMessageId: Id;
      readonly sequence: number;
      readonly delegatedTaskId: Id | null;
    }
  | {
      readonly outcome: 'reconciled_only';
      readonly turn: B1AssistantTurnDto;
    }
  | {
      readonly outcome: 'fenced';
      readonly turn: B1AssistantTurnDto | null;
    };

/**
 * Authoritative RPC interface exposed by Agent A (`AgentHeadDO`) and consumed by
 * Agent F (`Edge API Worker` & `Interactive Executor`) per V2-M0-A §5.1.
 */
export interface AgentHeadRpc {
  prepareTurn(req: PrepareTurnRequest): Promise<PrepareTurnResult>;
  markAttemptSent(req: MarkAttemptSentRequest): Promise<MarkAttemptSentResult>;
  renewTurnLease(req: RenewTurnLeaseRequest): Promise<RenewTurnLeaseResult>;
  handoffTurnToDurable(req: HandoffTurnRequest): Promise<HandoffTurnResult>;
  commitTurn(req: CommitTurnRequest): Promise<CommitTurnResult>;
  cancelTurn(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
  }): Promise<B1AssistantTurnDto>;
  clearTranscript(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
  }): Promise<B1TranscriptClearResult>;
  getMainConversation(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
  }): Promise<B1ConversationIdentity | null>;
  readMessages(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
    readonly after: number;
    readonly limit: number;
  }): Promise<B1ConversationPage>;
  findSubmissionReceipt(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly clientSubmissionId: Id;
  }): Promise<B1MessageSubmissionReconciliationDto | null>;
  getTurn(req: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
  }): Promise<B1AssistantTurnDto | null>;
}
