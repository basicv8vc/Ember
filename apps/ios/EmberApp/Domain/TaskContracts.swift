import Foundation

public enum TaskKind: String, Codable, CaseIterable, Sendable {
    case mockChat = "mock.chat"
    case mockCompute = "mock.compute"
    case mockFile = "mock.file"
    case mockApproval = "mock.approval"
}

public enum TaskStatus: String, Codable, CaseIterable, Sendable {
    case queued
    case running
    case waitingApproval = "waiting_approval"
    case retryableFailed = "retryable_failed"
    case completed
    case failed
    case cancelled
}

public enum TaskEventPhase: String, Codable, CaseIterable, Sendable {
    case accepted
    case leased
    case started
    case progress
    case waitingApproval = "waiting_approval"
    case approvalGranted = "approval_granted"
    case approvalDenied = "approval_denied"
    case retryScheduled = "retry_scheduled"
    case completed
    case failed
    case cancelled
}

public enum TaskRunStatus: String, Codable, CaseIterable, Sendable {
    case created
    case running
    case succeeded
    case failedRetryable = "failed_retryable"
    case failedTerminal = "failed_terminal"
    case leaseExpired = "lease_expired"
    case cancelled
}

public enum TaskExecutionPath: String, Codable, CaseIterable, Sendable {
    case fast
    case standard
    case heavy
}

public enum TaskErrorCode: String, Codable, CaseIterable, Sendable {
    case invalidArgument = "INVALID_ARGUMENT"
    case unauthenticated = "UNAUTHENTICATED"
    case notFound = "NOT_FOUND"
    case policyDenied = "POLICY_DENIED"
    case budgetExceeded = "BUDGET_EXCEEDED"
    case idempotencyConflict = "IDEMPOTENCY_CONFLICT"
    case workspaceVersionConflict = "WORKSPACE_VERSION_CONFLICT"
    case staleLease = "STALE_LEASE"
    case databaseUnavailable = "DB_UNAVAILABLE"
    case sandboxNotReady = "SANDBOX_NOT_READY"
    case executionTimeout = "EXECUTION_TIMEOUT"
    case mockToolFailed = "MOCK_TOOL_FAILED"
    case deadlineExceeded = "DEADLINE_EXCEEDED"
    case cancelled = "CANCELLED"
    case invalidStateTransition = "INVALID_STATE_TRANSITION"
}

public struct TaskReceiptDTO: Codable, Equatable, Sendable {
    public let taskID: UUID
    public let status: TaskStatus
    public let acceptedAt: String
    public let replayed: Bool

    public init(taskID: UUID, status: TaskStatus, acceptedAt: String, replayed: Bool) {
        self.taskID = taskID
        self.status = status
        self.acceptedAt = acceptedAt
        self.replayed = replayed
    }

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case status
        case acceptedAt = "accepted_at"
        case replayed
    }
}

public struct TaskDTO: Codable, Equatable, Sendable {
    public let taskID: UUID
    public let agentID: UUID
    public let kind: TaskKind
    public let status: TaskStatus
    public let currentRunID: UUID?
    public let attemptCount: Int
    public let createdAt: String
    public let updatedAt: String
    public let deadlineAt: String?

    public init(
        taskID: UUID,
        agentID: UUID,
        kind: TaskKind,
        status: TaskStatus,
        currentRunID: UUID?,
        attemptCount: Int,
        createdAt: String,
        updatedAt: String,
        deadlineAt: String?
    ) {
        self.taskID = taskID
        self.agentID = agentID
        self.kind = kind
        self.status = status
        self.currentRunID = currentRunID
        self.attemptCount = attemptCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.deadlineAt = deadlineAt
    }

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case agentID = "agent_id"
        case kind
        case status
        case currentRunID = "current_run_id"
        case attemptCount = "attempt_count"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case deadlineAt = "deadline_at"
    }
}

public struct TaskEventPayloadDTO: Codable, Equatable, Sendable {
    public let taskKind: TaskKind?
    public let runID: UUID?
    public let attempt: Int?
    public let route: TaskExecutionPath?
    public let fromStatus: TaskStatus?
    public let toStatus: TaskStatus?
    public let runStatus: TaskRunStatus?
    public let errorCode: TaskErrorCode?
    public let artifactID: UUID?
    public let workspaceVersion: Int?
    public let sandboxID: UUID?
    public let durationMs: Int?
    public let replayed: Bool?
    public let cancelRequested: Bool?
    public let policyVersion: Int?
    public let simulated: Bool?

    public init(
        taskKind: TaskKind? = nil,
        runID: UUID? = nil,
        attempt: Int? = nil,
        route: TaskExecutionPath? = nil,
        fromStatus: TaskStatus? = nil,
        toStatus: TaskStatus? = nil,
        runStatus: TaskRunStatus? = nil,
        errorCode: TaskErrorCode? = nil,
        artifactID: UUID? = nil,
        workspaceVersion: Int? = nil,
        sandboxID: UUID? = nil,
        durationMs: Int? = nil,
        replayed: Bool? = nil,
        cancelRequested: Bool? = nil,
        policyVersion: Int? = nil,
        simulated: Bool? = nil
    ) {
        self.taskKind = taskKind
        self.runID = runID
        self.attempt = attempt
        self.route = route
        self.fromStatus = fromStatus
        self.toStatus = toStatus
        self.runStatus = runStatus
        self.errorCode = errorCode
        self.artifactID = artifactID
        self.workspaceVersion = workspaceVersion
        self.sandboxID = sandboxID
        self.durationMs = durationMs
        self.replayed = replayed
        self.cancelRequested = cancelRequested
        self.policyVersion = policyVersion
        self.simulated = simulated
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case taskKind = "taskKind"
        case runID = "runId"
        case attempt
        case route
        case fromStatus
        case toStatus
        case runStatus
        case errorCode
        case artifactID = "artifactId"
        case workspaceVersion
        case sandboxID = "sandboxId"
        case durationMs
        case replayed
        case cancelRequested
        case policyVersion
        case simulated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DynamicPayloadKey.self)
        let allowedKeys = Set(CodingKeys.allCases.map(\.rawValue))
        guard container.allKeys.allSatisfy({ allowedKeys.contains($0.stringValue) }) else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "Task event payload contains an unsupported field."
                )
            )
        }

        taskKind = try container.decodeIfPresent(TaskKind.self, forKey: payloadKey("taskKind"))
        runID = try container.decodeIfPresent(UUID.self, forKey: payloadKey("runId"))
        attempt = try container.decodeIfPresent(Int.self, forKey: payloadKey("attempt"))
        route = try container.decodeIfPresent(TaskExecutionPath.self, forKey: payloadKey("route"))
        fromStatus = try container.decodeIfPresent(TaskStatus.self, forKey: payloadKey("fromStatus"))
        toStatus = try container.decodeIfPresent(TaskStatus.self, forKey: payloadKey("toStatus"))
        runStatus = try container.decodeIfPresent(TaskRunStatus.self, forKey: payloadKey("runStatus"))
        errorCode = try container.decodeIfPresent(TaskErrorCode.self, forKey: payloadKey("errorCode"))
        artifactID = try container.decodeIfPresent(UUID.self, forKey: payloadKey("artifactId"))
        workspaceVersion = try container.decodeIfPresent(Int.self, forKey: payloadKey("workspaceVersion"))
        sandboxID = try container.decodeIfPresent(UUID.self, forKey: payloadKey("sandboxId"))
        durationMs = try container.decodeIfPresent(Int.self, forKey: payloadKey("durationMs"))
        replayed = try container.decodeIfPresent(Bool.self, forKey: payloadKey("replayed"))
        cancelRequested = try container.decodeIfPresent(Bool.self, forKey: payloadKey("cancelRequested"))
        policyVersion = try container.decodeIfPresent(Int.self, forKey: payloadKey("policyVersion"))
        simulated = try container.decodeIfPresent(Bool.self, forKey: payloadKey("simulated"))
    }
}

private struct DynamicPayloadKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init?(stringValue: String) {
        self.stringValue = stringValue
    }

    init?(intValue: Int) {
        return nil
    }
}

private func payloadKey(_ stringValue: String) -> DynamicPayloadKey {
    guard let key = DynamicPayloadKey(stringValue: stringValue) else {
        preconditionFailure("Static CodingKey could not be created")
    }
    return key
}

public struct TaskEventDTO: Codable, Equatable, Sendable {
    public let taskID: UUID
    public let sequence: Int
    public let phase: TaskEventPhase
    public let occurredAt: String
    public let traceID: UUID
    public let payload: TaskEventPayloadDTO

    public init(
        taskID: UUID,
        sequence: Int,
        phase: TaskEventPhase,
        occurredAt: String,
        traceID: UUID,
        payload: TaskEventPayloadDTO
    ) {
        self.taskID = taskID
        self.sequence = sequence
        self.phase = phase
        self.occurredAt = occurredAt
        self.traceID = traceID
        self.payload = payload
    }

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case sequence
        case phase
        case occurredAt = "occurred_at"
        case traceID = "trace_id"
        case payload
    }
}

public struct TaskEventPageDTO: Codable, Equatable, Sendable {
    public let taskID: UUID
    public let events: [TaskEventDTO]

    public init(taskID: UUID, events: [TaskEventDTO]) {
        self.taskID = taskID
        self.events = events
    }

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case events
    }
}

public struct TaskCancelDTO: Codable, Equatable, Sendable {
    public let taskID: UUID
    public let status: TaskStatus
    public let cancelRequested: Bool
    public let cancelRequestedAt: String?
    public let terminal: Bool
    public let updatedAt: String

    public init(
        taskID: UUID,
        status: TaskStatus,
        cancelRequested: Bool,
        cancelRequestedAt: String?,
        terminal: Bool,
        updatedAt: String
    ) {
        self.taskID = taskID
        self.status = status
        self.cancelRequested = cancelRequested
        self.cancelRequestedAt = cancelRequestedAt
        self.terminal = terminal
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case status
        case cancelRequested = "cancel_requested"
        case cancelRequestedAt = "cancel_requested_at"
        case terminal
        case updatedAt = "updated_at"
    }
}

public enum ApprovalStatus: String, Codable, CaseIterable, Sendable {
    case pending
    case approved
    case denied
    case expired
}

public struct ApprovalDTO: Codable, Equatable, Sendable {
    public let approvalID: UUID
    public let taskID: UUID
    public let runID: UUID
    public let leaseEpoch: Int
    public let actionDigest: String
    public let status: ApprovalStatus
    public let expiresAt: String
    public let decidedAt: String?
    public let createdAt: String
    public let updatedAt: String

    public init(
        approvalID: UUID,
        taskID: UUID,
        runID: UUID,
        leaseEpoch: Int,
        actionDigest: String,
        status: ApprovalStatus,
        expiresAt: String,
        decidedAt: String?,
        createdAt: String,
        updatedAt: String
    ) {
        self.approvalID = approvalID
        self.taskID = taskID
        self.runID = runID
        self.leaseEpoch = leaseEpoch
        self.actionDigest = actionDigest
        self.status = status
        self.expiresAt = expiresAt
        self.decidedAt = decidedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case approvalID = "approval_id"
        case taskID = "task_id"
        case runID = "run_id"
        case leaseEpoch = "lease_epoch"
        case actionDigest = "action_digest"
        case status
        case expiresAt = "expires_at"
        case decidedAt = "decided_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public enum ConnectionPhase: String, Codable, Sendable {
    case idle
    case connecting
    case connected
    case disconnected
}

public enum TaskCommandInFlight: String, Codable, Sendable {
    case creatingTask = "creating_task"
    case cancellingTask = "cancelling_task"
}

public enum TaskExecutionCapability: String, Codable, Sendable {
    case mockOnly = "mock_only"
    case real
}

/// Orthogonal UI inputs. taskStatus is server state; the other fields are local state.
public struct TaskPresentationState: Codable, Equatable, Sendable {
    public let taskStatus: TaskStatus?
    public let connectionPhase: ConnectionPhase
    public let commandInFlight: TaskCommandInFlight?
    public let capability: TaskExecutionCapability

    public init(
        taskStatus: TaskStatus?,
        connectionPhase: ConnectionPhase,
        commandInFlight: TaskCommandInFlight?,
        capability: TaskExecutionCapability
    ) {
        self.taskStatus = taskStatus
        self.connectionPhase = connectionPhase
        self.commandInFlight = commandInFlight
        self.capability = capability
    }

    enum CodingKeys: String, CodingKey {
        case taskStatus = "task_status"
        case connectionPhase = "connection_phase"
        case commandInFlight = "command_in_flight"
        case capability
    }
}

public enum CreateTaskRequestDTO: Encodable, Sendable {
    case chat(agentID: UUID, prompt: String, maxOutputTokens: Int?, deadlineAt: String?)
    case compute(agentID: UUID, text: String, deadlineAt: String?)
    case file(agentID: UUID, fileKey: String, content: String, mediaType: String?, deadlineAt: String?)
    case approval(agentID: UUID, action: String, reason: String?, deadlineAt: String?)

    private enum RequestKeys: String, CodingKey {
        case agentID = "agent_id"
        case kind
        case input
        case deadlineAt = "deadline_at"
    }

    private enum ChatKeys: String, CodingKey {
        case prompt
        case maxOutputTokens = "maxOutputTokens"
    }

    private enum ComputeKeys: String, CodingKey {
        case operation
        case text
    }

    private enum FileKeys: String, CodingKey {
        case fileKey
        case content
        case mediaType
    }

    private enum ApprovalKeys: String, CodingKey {
        case action
        case reason
    }

    public func encode(to encoder: Encoder) throws {
        var request = encoder.container(keyedBy: RequestKeys.self)
        switch self {
        case let .chat(agentID, prompt, maxOutputTokens, deadlineAt):
            try request.encode(agentID, forKey: .agentID)
            try request.encode(TaskKind.mockChat, forKey: .kind)
            var container = request.nestedContainer(keyedBy: ChatKeys.self, forKey: .input)
            try container.encode(prompt, forKey: .prompt)
            try container.encodeIfPresent(maxOutputTokens, forKey: .maxOutputTokens)
            try request.encodeIfPresent(deadlineAt, forKey: .deadlineAt)
        case let .compute(agentID, text, deadlineAt):
            try request.encode(agentID, forKey: .agentID)
            try request.encode(TaskKind.mockCompute, forKey: .kind)
            var container = request.nestedContainer(keyedBy: ComputeKeys.self, forKey: .input)
            try container.encode("sha256", forKey: .operation)
            try container.encode(text, forKey: .text)
            try request.encodeIfPresent(deadlineAt, forKey: .deadlineAt)
        case let .file(agentID, fileKey, content, mediaType, deadlineAt):
            try request.encode(agentID, forKey: .agentID)
            try request.encode(TaskKind.mockFile, forKey: .kind)
            var container = request.nestedContainer(keyedBy: FileKeys.self, forKey: .input)
            try container.encode(fileKey, forKey: .fileKey)
            try container.encode(content, forKey: .content)
            try container.encodeIfPresent(mediaType, forKey: .mediaType)
            try request.encodeIfPresent(deadlineAt, forKey: .deadlineAt)
        case let .approval(agentID, action, reason, deadlineAt):
            try request.encode(agentID, forKey: .agentID)
            try request.encode(TaskKind.mockApproval, forKey: .kind)
            var container = request.nestedContainer(keyedBy: ApprovalKeys.self, forKey: .input)
            try container.encode(action, forKey: .action)
            try container.encodeIfPresent(reason, forKey: .reason)
            try request.encodeIfPresent(deadlineAt, forKey: .deadlineAt)
        }
    }
}
