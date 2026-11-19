import type {
  B1AssistantTurnDto,
  B1ConversationPage,
  B1SendMessageReceipt,
  B1SendMessageRequest,
  B3StagedUploadMediaType,
} from '@ember/contracts';
import type { AuthContext, Id } from '@ember/domain';
import type { ContextRow } from '@ember/model-gateway';
import type { B1TranscriptClearResult } from '@ember/postgres';

export type HeadScope = Pick<AuthContext, 'tenantId'> & { readonly agentId: Id };
export type CallerScope = AuthContext & HeadScope & { readonly requestId: Id };

interface ConversationKey extends HeadScope {
  readonly conversationId: Id;
}

interface TurnKey extends ConversationKey {
  readonly turnId: Id;
}

export interface ResolvedMessageAttachment {
  readonly uploadId: Id;
  readonly filename: string;
  readonly mediaType: B3StagedUploadMediaType;
  readonly sizeBytes: number;
  readonly r2Key: string;
  readonly sha256: string;
}

export interface PrepareTurnRequest {
  readonly scope: CallerScope;
  readonly conversationId: Id;
  readonly request: B1SendMessageRequest;
  readonly workerId: string;
  readonly resolvedAttachments?: readonly ResolvedMessageAttachment[];
  readonly executionMode: 'fast_interactive' | 'durable_queue';
  readonly leaseMs: number;
  readonly interactiveDeadlineMs: number;
  readonly turnDeadlineMs: number;
  readonly modelReservation: {
    readonly budgetMode: 'simulated_full_protocol';
    readonly providerId: 'fake';
    readonly modelLabel: string;
    readonly rateVersion: string;
    readonly maxAttempts: number;
    readonly estimatedMicroUsd: number;
  };
}

export interface PreparedTurn {
  readonly kind: 'prepared';
  readonly replayed: false;
  readonly receipt: B1SendMessageReceipt;
  readonly turnId: Id;
  readonly attemptNo: number;
  readonly operationId: Id;
  readonly leaseEpoch: number;
  readonly leaseExpiresAtMs: number | null;
  /** These are absolute, authority-issued timestamps in the prepared response. */
  readonly interactiveDeadlineMs: number | null;
  readonly turnDeadlineMs: number;
  readonly globalGrantId: string | null;
  readonly reservedMicroUsd: number;
  readonly context: readonly ContextRow[];
}

export type PrepareTurnResult =
  | PreparedTurn
  | {
      readonly kind: 'replay';
      readonly replayed: true;
      readonly receipt: B1SendMessageReceipt;
      readonly currentTurnStatus: B1AssistantTurnDto['status'];
    };

interface FencedTurn {
  readonly scope: HeadScope;
  readonly conversationId: Id;
  readonly turnId: Id;
  readonly leaseEpoch: number;
  readonly leaseOwner: string;
}

export interface MarkAttemptSentRequest {
  readonly scope: HeadScope;
  readonly subjectType: 'turn';
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

export type HandoffTurnRequest = FencedTurn & {
  readonly reason: 'interactive_deadline_120s' | 'client_disconnect_handoff';
  readonly providerJobHandle?: string;
};

export interface CommitTurnRequest extends FencedTurn {
  readonly attemptNo: number;
  readonly operationId: Id;
  readonly settlement: {
    readonly state: 'settled' | 'conservative_billed' | 'unknown_billed' | 'released';
    readonly outcomeCode:
      | 'ok'
      | 'model_timeout'
      | 'model_unavailable'
      | 'model_rate_limited'
      | 'model_auth_failed'
      | 'model_invalid_output'
      | 'client_cancelled'
      | 'not_sent'
      | 'usage_missing';
    readonly observedCostMicroUsd?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
  readonly result:
    | {
        readonly status: 'completed';
        readonly text: string;
        readonly modelLabel: string;
        readonly simulated: true;
      }
    | { readonly status: 'failed'; readonly failureReason: 'timeout' | 'internal_error' }
    | { readonly status: 'aborted_for_retry_or_reconcile' };
}

export type CommitTurnResult =
  | {
      readonly outcome: 'published';
      readonly turn: B1AssistantTurnDto;
      readonly responseMessageId: Id;
      readonly sequence: number;
      readonly delegatedTaskId: Id | null;
    }
  | { readonly outcome: 'reconciled_only'; readonly turn: B1AssistantTurnDto }
  | { readonly outcome: 'fenced'; readonly turn: B1AssistantTurnDto | null };

/** Consumer view of the M0 Agent Head contract, pending the shared RPC package and D0. */
export interface EdgeAgentHeadRpc {
  prepareTurn(request: PrepareTurnRequest): Promise<PrepareTurnResult>;
  markAttemptSent(request: MarkAttemptSentRequest): Promise<MarkAttemptSentResult>;
  renewTurnLease(request: FencedTurn & { readonly extendMs: number }): Promise<
    | {
        readonly renewed: true;
        readonly leaseExpiresAtMs: number;
        readonly cancelRequested: boolean;
      }
    | { readonly renewed: false; readonly reason: 'fenced' | 'expired' | 'cancelled' | 'not_found' }
  >;
  handoffTurnToDurable(request: HandoffTurnRequest): Promise<
    | {
        readonly outcome: 'handed_off';
        readonly turnId: Id;
        readonly nextLeaseEpoch: number;
        readonly executionMode: 'durable_queue';
      }
    | { readonly outcome: 'fenced'; readonly currentStatus: B1AssistantTurnDto['status'] }
  >;
  commitTurn(request: CommitTurnRequest): Promise<CommitTurnResult>;
  readMessages(
    request: ConversationKey & { readonly after: number; readonly limit: number },
  ): Promise<B1ConversationPage>;
  findSubmissionReceipt(
    request: HeadScope & { readonly clientSubmissionId: Id },
  ): Promise<B1SendMessageReceipt | null>;
  getTurn(request: TurnKey): Promise<B1AssistantTurnDto | null>;
  cancelTurn(request: TurnKey): Promise<B1AssistantTurnDto>;
  clearTranscript(request: ConversationKey): Promise<B1TranscriptClearResult>;
}
