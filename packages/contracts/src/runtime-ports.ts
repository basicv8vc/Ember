import type { AuthContext, Id, TaskStatus } from '@ember/domain';
import type {
  B1AssistantTurnDto,
  B1ConversationPage,
  B1MessageSubmissionReconciliationDto,
  B1SendMessageReceipt,
  B1SendMessageRequest,
  B1TaskCancelDto,
  B1TaskDetailDto,
  B1TaskEventPageDto,
  B1TaskListDto,
  B1TaskResultDto,
  B3StagedUploadReceiptDto,
  B3TaskArtifactsListDto,
} from './b1-live-schemas.js';

/**
 * Provider-neutral B1/B3 HTTP & runtime persistence boundaries plus the structural Cloudflare R2
 * bucket port. Moving these pure TypeScript contracts into `@ember/contracts` decouples V2 Edge
 * Workers and shared API routes from `@ember/postgres`.
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
  /** Server-authoritative lookup, with expiry/revocation checks and hourly idle sliding. */
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
   * Serialize epoch checks and sequence allocation on the conversation.
   * A first send inserts one user message and one running assistant_turn in one transaction.
   * Same id and same text in the current epoch returns an identical receipt.
   */
  submitUserMessage(command: {
    readonly tenantId: Id;
    readonly principalId?: Id;
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

  /**
   * Unknown-ACK lookup uses the original receipt, not the Turn's current status.
   * Foreign tenant IDs remain invisible.
   */
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

export interface B1TaskListQuery {
  readonly status?: TaskStatus;
  readonly limit?: number;
  readonly after?: string;
}

export interface B1TaskReadRepository {
  /** Tenant-scoped keyset-paginated list of Tasks sorted newest-first. */
  listTasks(tenantId: Id, query?: B1TaskListQuery): Promise<B1TaskListDto>;
  /** Tenant-scoped detail read returning the canonical Task summary DTO. */
  getTaskDetail(tenantId: Id, taskId: Id): Promise<B1TaskDetailDto | null>;
  /** Tenant-scoped exclusive-sequence page of durable `task_events`. */
  listTaskEvents(tenantId: Id, taskId: Id, after?: number): Promise<B1TaskEventPageDto | null>;
  /** Tenant-scoped transactional Task cancellation following ADR-0001 convergence rules. */
  cancelTask(tenantId: Id, taskId: Id): Promise<B1TaskCancelDto | null>;
}

export interface StageUploadInput {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly now?: Date;
}

export interface B3ArtifactDownload {
  readonly artifactId: Id;
  readonly filename: string | null;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface B3StagedUploadRepository {
  stageUpload(ctx: AuthContext, input: StageUploadInput): Promise<B3StagedUploadReceiptDto>;
  listTaskArtifacts(ctx: AuthContext, taskId: Id): Promise<B3TaskArtifactsListDto | null>;
  getTaskArtifactDownload(ctx: AuthContext, artifactId: Id): Promise<B3ArtifactDownload | null>;
  sweepExpiredUnboundUploads(now?: Date): Promise<{ readonly removed: number }>;
}

export interface CreateAgentCommand {
  readonly name: string;
  /** Defaults to the verified AuthContext policy version. */
  readonly policyVersion?: number;
}

export interface AgentView {
  readonly agentId: Id;
  readonly name: string;
  readonly policyVersion: number;
  readonly workspaceId: Id;
  /** New workspaces start at version 0. */
  readonly workspaceVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Minimal tenant-scoped agent persistence boundary. */
export interface AgentRepository {
  /** Atomically create an agent and its single initial workspace in the caller's tenant. */
  create(ctx: AuthContext, command: CreateAgentCommand): Promise<AgentView>;
  /** Return `null` for a missing agent and for an agent owned by another tenant. */
  get(ctx: AuthContext, agentId: Id): Promise<AgentView | null>;
}

/** Structural R2 object body returned by `R2Bucket.get()`. */
export interface R2ObjectBodyPort {
  readonly size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Structural R2 put options subset used by Ember storage adapters. */
export interface R2PutOptionsPort {
  readonly httpMetadata?: { readonly contentType?: string };
  readonly customMetadata?: Readonly<Record<string, string>>;
}

/**
 * Structural Cloudflare R2 bucket contract (edge-safe, zero `@cloudflare/workers-types` or `node:*` deps).
 */
export interface R2BucketPort {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string | Blob,
    options?: R2PutOptionsPort,
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyPort | null>;
  delete(keys: string | string[]): Promise<void>;
}
