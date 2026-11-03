import type {
  B1AssistantTurnDto,
  B1ConversationPage,
  B1MessageSubmissionReconciliationDto,
  B1SendMessageRequest,
  B1SendMessageReceipt,
  B1TaskResultDto,
} from '@ember/contracts';
import type { Id } from '@ember/domain';

/**
 * B1-1 persistence boundaries. No implementation uses network auth or model egress.
 * Tenant-scoped operations take a trusted server-derived tenantId; identity/session bootstrap
 * derives scope from verified provider identity or a server-side token digest, never caller JSON.
 * Approved by ADR-0004; multi-row changes are explicitly transactional.
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

export interface B1ProvisionedSession {
  readonly identity: B1ProvisionedIdentity;
  readonly session: B1SessionRecord;
}

export interface B1ConsumerProvisioningRepository {
  /**
   * Provision identity and persist the session digest in the same transaction (ADR-0004 I-4).
   * The raw bearer token never crosses this persistence boundary.
   */
  provisionIdentityAndCreateSession(command: {
    readonly provider: 'apple' | 'dev';
    readonly providerSubject: string;
    readonly tokenDigest: Uint8Array;
    readonly expiresAt: string;
    readonly idleExpiresAt: string;
  }): Promise<B1ProvisionedSession>;
}

export interface B1SessionRecord {
  readonly sessionId: Id;
  readonly consumerId: Id;
  readonly tenantId: Id;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
  readonly revokedAt: string | null;
}

/** Session lookup projection needed to resolve the unchanged AuthContext server-side. */
export interface B1AuthenticatedSession {
  readonly session: B1SessionRecord;
  readonly principalId: Id;
  readonly policyVersion: number;
}

export interface B1ConsumerSessionRepository {
  /** Server-authoritative lookup, with DB clock expiry/revocation checks and hourly idle sliding. */
  findActiveSession(tokenDigest: Uint8Array): Promise<B1AuthenticatedSession | null>;

  /**
   * Atomically rotate the session identified by the presented digest. A previously rotated
   * digest revokes every session for that consumer and returns `reuse_detected`; any other
   * missing, expired or revoked session returns `inactive`. Only SHA-256 digests cross this
   * persistence boundary.
   */
  rotateSession(command: {
    readonly currentTokenDigest: Uint8Array;
    readonly newTokenDigest: Uint8Array;
    readonly expiresAt: string;
    readonly idleExpiresAt: string;
  }): Promise<B1SessionRotationResult>;

  /** Idempotently revoke only the tenant-qualified session presented for logout. */
  revokeSession(command: { readonly sessionId: Id; readonly tenantId: Id }): Promise<void>;
}

export type B1SessionRotationResult =
  | { readonly kind: 'rotated'; readonly session: B1SessionRecord }
  | { readonly kind: 'reuse_detected' }
  | { readonly kind: 'inactive' };

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

  /** Tenant-scoped unknown-ACK lookup that joins the user message to its original turn receipt. */
  findSubmissionReceipt(command: {
    readonly tenantId: Id;
    readonly clientSubmissionId: Id;
  }): Promise<B1MessageSubmissionReconciliationDto | null>;

  /**
   * Increment the epoch and erase messages/turns in one transaction, never touching tasks/results.
   * Returns the exact counters required by the clear-transcript response.
   */
  clearTranscript(command: {
    readonly tenantId: Id;
    readonly conversationId: Id;
  }): Promise<B1TranscriptClearResult>;
}

export interface B1TranscriptClearResult {
  readonly deletedMessages: number;
  readonly deletedTurns: number;
  readonly transcriptEpoch: number;
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
