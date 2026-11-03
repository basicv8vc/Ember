import type {
  B1AssistantTurnDto,
  B1ConversationMessage,
  B1ConversationPage,
  B1SendMessageRequest,
  B1SendMessageReceipt,
  B1TaskResultDto,
} from '@ember/contracts';
import type { Id } from '@ember/domain';

/**
 * B1-1 persistence boundaries. No implementation uses network auth or model egress.
 * Every operation gets a trusted server-derived tenantId; none accepts caller-supplied tenant JSON.
 * Approved by ADR-0004; methods that change multiple rows must be implemented transactionally.
 */
export interface B1ConsumerIdentity {
  readonly consumerId: Id;
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly provider: 'apple' | 'dev';
  readonly providerSubject: string;
}

export interface B1ProvisionedIdentity {
  readonly consumerId: Id;
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly agentId: Id;
  readonly conversationId: Id;
}

export interface B1ConsumerProvisioningRepository {
  /** Entire consumer, principal, agent and main conversation is created in one transaction. */
  provisionIdentity(identity: {
    readonly provider: 'apple' | 'dev';
    readonly providerSubject: string;
  }): Promise<B1ProvisionedIdentity>;
}

export interface B1SessionRecord {
  readonly sessionId: Id;
  readonly consumerId: Id;
  readonly tenantId: Id;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
  readonly revokedAt: string | null;
}

export interface B1ConsumerSessionRepository {
  /** Raw bearer token is never persisted or returned by this repository. */
  createSession(command: {
    readonly tenantId: Id;
    readonly consumerId: Id;
    readonly tokenDigest: Uint8Array;
    readonly expiresAt: string;
    readonly idleExpiresAt: string;
  }): Promise<B1SessionRecord>;

  /** Server-authoritative lookup, with DB clock expiry and revocation checks. */
  findActiveSession(tokenDigest: Uint8Array): Promise<B1SessionRecord | null>;

  /** Atomically rotate: revoke original, then persist the new digest and replay guard. */
  rotateSession(command: {
    readonly sessionId: Id;
    readonly tenantId: Id;
    readonly newTokenDigest: Uint8Array;
    readonly expiresAt: string;
    readonly idleExpiresAt: string;
  }): Promise<B1SessionRecord>;

  revokeSession(command: {
    readonly sessionId: Id;
    readonly tenantId: Id;
    readonly reason: 'logout' | 'reuse_detected';
  }): Promise<void>;
}

export interface B1ConversationIdentity {
  readonly conversationId: Id;
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly transcriptEpoch: number;
  readonly lastSequence: number;
}

export interface B1ConversationRepository {
  getMainConversation(tenantId: Id, agentId: Id): Promise<B1ConversationIdentity | null>;

  /**
   * A lock on the conversation row serializes epoch checks and sequence allocation.
   * A first send inserts one user message and one running assistant_turn in one transaction.
   * Same id and same text in the current epoch returns an identical receipt.
   */
  submitUserMessage(command: {
    readonly tenantId: Id;
    readonly conversationId: Id;
    readonly request: B1SendMessageRequest;
  }): Promise<{ readonly replayed: boolean; readonly receipt: B1SendMessageReceipt }>;

  /** Forward-only cursor, always scoped by the verified tenant identity. */
  readMessages(command: {
    readonly tenantId: Id;
    readonly conversationId: Id;
    readonly after: number;
    readonly limit: number;
  }): Promise<B1ConversationPage>;

  findMessageBySubmission(command: {
    readonly tenantId: Id;
    readonly clientSubmissionId: Id;
  }): Promise<B1ConversationMessage | null>;

  /** Increment epoch and erase the transcript atomically, never touching tasks/results. */
  clearTranscript(command: { readonly tenantId: Id; readonly conversationId: Id }): Promise<number>;
}

export interface B1AssistantTurnRepository {
  getTurn(command: {
    readonly tenantId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
  }): Promise<B1AssistantTurnDto | null>;

  /** Single transaction writes response message and running -> terminal transition. */
  finishTurn(command: {
    readonly tenantId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
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
          readonly safeMessage: string;
        };
  }): Promise<B1AssistantTurnDto>;

  /** Idempotent cancellation of a running turn; terminal rows never reopen. */
  cancelTurn(command: {
    readonly tenantId: Id;
    readonly conversationId: Id;
    readonly turnId: Id;
  }): Promise<B1AssistantTurnDto>;
}

export interface B1TaskResultRepository {
  /** Read joins authoritative Task status; terminal tasks must never appear pending. */
  getTaskResult(tenantId: Id, taskId: Id): Promise<B1TaskResultDto | null>;
}
