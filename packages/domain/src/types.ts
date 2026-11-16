/**
 * Core domain vocabulary for Ember.
 *
 * This package is deliberately free of HTTP, database, filesystem, network and clock
 * dependencies. Infrastructure decides how values are stored or transported; this module
 * decides what they mean.
 */

import type { DomainErrorCode } from './errors.js';

/**
 * Server-generated UUID (RFC 9562). Clients never choose an `Id`.
 *
 * The type stays a plain string so persisted rows and JSON payloads do not need casts.
 * UUID syntax is enforced at system boundaries by `@ember/contracts` (and by PostgreSQL),
 * not by branding every literal in the domain layer.
 */
export type Id = string;

/**
 * Verified caller identity. Constructed by the gateway from a local development token,
 * never from request-body fields.
 */
export interface AuthContext {
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly policyVersion: number;
}

export const EXECUTION_PATHS = ['fast', 'standard', 'heavy'] as const;

/** Coarse execution tier selected by the execution router. */
export type ExecutionPath = (typeof EXECUTION_PATHS)[number];

/** Task kinds supported across durable execution. */
export const TASK_KINDS = [
  'mock.chat',
  'mock.compute',
  'mock.file',
  'mock.approval',
  'notes.action_items',
  'python.agent',
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

export interface MockChatInput {
  /** Deterministic prompt handed to the future FakeLLM. */
  readonly prompt: string;
  /** Optional deterministic output cap; P0-B does not bill real tokens. */
  readonly maxOutputTokens?: number;
}

export interface MockComputeInput {
  /** Whitelisted deterministic operation. Unknown operations are rejected at the boundary. */
  readonly operation: 'sha256';
  /** Input text for the operation. */
  readonly text: string;
}

export interface MockFileInput {
  /**
   * Workspace-relative logical file key. It is never a host absolute path and never a
   * shell argument; a future workspace/sandbox layer resolves it inside the sandbox.
   */
  readonly fileKey: string;
  /** UTF-8 text content written to the logical file. */
  readonly content: string;
  /** Optional IANA-style media type without parameters. */
  readonly mediaType?: string;
}

export interface MockApprovalInput {
  /** Logical action label requiring approval. It is not an executable command. */
  readonly action: string;
  /** Optional human-readable reason. */
  readonly reason?: string;
}

export interface NotesActionItemsInput {
  /** Bounded meeting/discussion notes to convert into durable action items. */
  readonly notes: string;
  /** Optional short formatting/focus instruction supplied by delegation tool call. */
  readonly instructions?: string;
}

export interface PythonAgentInput {
  /** User objective / task prompt passed to the Python execution agent. */
  readonly prompt: string;
  /** Optional short formatting/execution instruction supplied by delegation tool call. */
  readonly instructions?: string;
  /** Optional published user input artifact IDs bound atomically at Task creation. */
  readonly inputArtifactIds?: readonly Id[];
}

/** Correlates each supported task kind with exactly one input shape. */
export interface TaskInputByKind {
  readonly 'mock.chat': MockChatInput;
  readonly 'mock.compute': MockComputeInput;
  readonly 'mock.file': MockFileInput;
  readonly 'mock.approval': MockApprovalInput;
  readonly 'notes.action_items': NotesActionItemsInput;
  readonly 'python.agent': PythonAgentInput;
}

export type MockTaskInput = TaskInputByKind[TaskKind];

export interface TaskCommandBase {
  readonly agentId: Id;
  /**
   * Idempotency key taken from the HTTP header by the gateway (or server-derived turn key).
   * It is deliberately not part of the client-supplied body.
   */
  readonly idempotencyKey: string;
  /** Optional RFC 3339 / ISO 8601 deadline with an explicit timezone. */
  readonly deadlineAt?: string;
  /** Optional concise human-readable Task title. */
  readonly title?: string;
}

/**
 * Validated internal command. `kind` and `input` are correlated so a caller cannot pair
 * `mock.compute` with a chat payload once the command has passed the contract boundary.
 */
export type TaskCommand = {
  readonly [K in TaskKind]: TaskCommandBase & {
    readonly kind: K;
    readonly input: TaskInputByKind[K];
  };
}[TaskKind];

/** Acknowledged, persisted task creation. Not a completion result. */
export interface TaskReceipt {
  readonly taskId: Id;
  readonly status: TaskStatus;
  readonly acceptedAt: string;
  readonly replayed: boolean;
}

/** Tenant-scoped read model for a task. */
export interface TaskView {
  readonly taskId: Id;
  readonly agentId: Id;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly currentRunId: Id | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadlineAt: string | null;
}

/**
 * One execution attempt. A task may have many runs; an expired run is not itself a final
 * task outcome, because a later run may still complete the task.
 */
export interface RunRecord {
  readonly runId: Id;
  readonly taskId: Id;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly status: RunStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** A run currently owned by a worker through a leased, fenced claim. */
export interface LeasedRun {
  readonly taskId: Id;
  readonly runId: Id;
  readonly tenantId: Id;
  readonly attempt: number;
  /** Fencing token; database-enforced atomicity belongs to P0B-04. */
  readonly leaseEpoch: number;
  readonly leaseExpiresAt: string;
}

export const TASK_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export type TaskTerminalStatus = (typeof TASK_TERMINAL_STATUSES)[number];

/**
 * Task lifecycle. `accepted` is intentionally absent: it is an event/receipt fact, not a
 * task status. `waiting_external` is reserved by the RFC but not implemented in P0-B.
 */
export const TASK_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'retryable_failed',
  ...TASK_TERMINAL_STATUSES,
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_TERMINAL_STATUSES = [
  'succeeded',
  'failed_retryable',
  'failed_terminal',
  'lease_expired',
  'cancelled',
] as const;

export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number];

export const APPROVAL_STATUSES = Object.freeze([
  'pending',
  'approved',
  'denied',
  'expired',
] as const);

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_TERMINAL_STATUSES = Object.freeze([
  'approved',
  'denied',
  'expired',
] as const satisfies readonly ApprovalStatus[]);

export type ApprovalTerminalStatus = (typeof APPROVAL_TERMINAL_STATUSES)[number];

export const APPROVAL_DECISIONS = Object.freeze(['approve', 'deny'] as const);

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface ApprovalView {
  readonly approvalId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly leaseEpoch: number;
  readonly actionDigest: string;
  readonly status: ApprovalStatus;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApprovalDecisionReceipt {
  readonly approvalId: Id;
  readonly taskId: Id;
  readonly status: 'approved' | 'denied';
  readonly taskStatus: TaskStatus;
  readonly decidedAt: string;
  readonly replayed: boolean;
}

/**
 * Run lifecycle. `failed_retryable` is terminal for *that run*; the task itself may return
 * to `queued` and receive a new run.
 */
export const RUN_STATUSES = ['created', 'running', ...RUN_TERMINAL_STATUSES] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Event phases are facts that already happened. `accepted` exists here (and only here),
 * not in `TaskStatus`.
 */
export const TASK_EVENT_PHASES = [
  'accepted',
  'leased',
  'started',
  'progress',
  'waiting_approval',
  'approval_granted',
  'approval_denied',
  'retry_scheduled',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskEventPhase = (typeof TASK_EVENT_PHASES)[number];

/**
 * Closed set of safe event metadata. Every field is an enum, UUID, non-negative integer or
 * boolean, so there is no free-text channel for prompts, tokens, API keys or tool output.
 * Adding a field requires an explicit contract change and redaction review.
 *
 * Phase-specific required fields (for example `taskKind` on `accepted`) are enforced by the
 * later event-store/application layer, not by P0B-02.
 */
export interface TaskEventPayload {
  readonly taskKind?: TaskKind;
  readonly runId?: Id;
  readonly attempt?: number;
  readonly route?: ExecutionPath;
  readonly fromStatus?: TaskStatus;
  readonly toStatus?: TaskStatus;
  readonly runStatus?: RunStatus;
  readonly errorCode?: DomainErrorCode;
  readonly artifactId?: Id;
  readonly workspaceVersion?: number;
  readonly sandboxId?: Id;
  readonly durationMs?: number;
  readonly replayed?: boolean;
  readonly cancelRequested?: boolean;
  readonly policyVersion?: number;
  readonly simulated?: boolean;
}

/** Append-only fact used by the event log, pollers and SSE clients. */
export interface TaskEvent {
  readonly taskId: Id;
  readonly sequence: number;
  readonly phase: TaskEventPhase;
  readonly occurredAt: string;
  readonly traceId: Id;
  readonly payload: TaskEventPayload;
}
