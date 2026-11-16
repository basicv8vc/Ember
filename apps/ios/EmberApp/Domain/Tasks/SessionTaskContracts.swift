import Foundation

/// Validated Task kind supported by B1/B3 Consumer Session Task endpoints.
/// Preserves existing M2 mock kinds while supporting real V1 task kinds such as `notes.action_items`.
public struct SessionTaskKind: RawRepresentable, Hashable, Codable, Sendable {
    public static let notesActionItems = SessionTaskKind(rawValue: "notes.action_items")!
    public static let pythonAgent = SessionTaskKind(rawValue: "python.agent")!
    public static let pythonSandbox = SessionTaskKind(rawValue: "sandbox.python")!
    public static let mockChat = SessionTaskKind(rawValue: "mock.chat")!
    public static let mockCompute = SessionTaskKind(rawValue: "mock.compute")!
    public static let mockFile = SessionTaskKind(rawValue: "mock.file")!
    public static let mockApproval = SessionTaskKind(rawValue: "mock.approval")!

    public let rawValue: String

    public init?(rawValue: String) {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed == rawValue, trimmed.count <= 128 else {
            return nil
        }
        self.rawValue = trimmed
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        guard let value = Self(rawValue: raw) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid task kind.")
        }
        self = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var isMockOnly: Bool {
        rawValue.hasPrefix("mock.")
    }

    public var localizedDisplayTitle: String {
        switch rawValue {
        case Self.notesActionItems.rawValue:
            String(localized: "tasks.kind.notes_action_items", table: "Conversation")
        case Self.pythonAgent.rawValue, Self.pythonSandbox.rawValue:
            String(localized: "tasks.kind.python_sandbox", table: "Conversation")
        case Self.mockChat.rawValue:
            String(localized: "tasks.kind.mock_chat", table: "Conversation")
        case Self.mockCompute.rawValue:
            String(localized: "tasks.kind.mock_compute", table: "Conversation")
        case Self.mockFile.rawValue:
            String(localized: "tasks.kind.mock_file", table: "Conversation")
        case Self.mockApproval.rawValue:
            String(localized: "tasks.kind.mock_approval", table: "Conversation")
        default:
            rawValue
        }
    }
}

public enum SessionTaskStatusGroup: String, CaseIterable, Hashable, Sendable {
    case needsIntervention
    case inProgress
    case completed

    public var localizedSectionTitle: String {
        switch self {
        case .needsIntervention:
            String(localized: "tasks.group.needs_intervention", table: "Conversation")
        case .inProgress:
            String(localized: "tasks.group.in_progress", table: "Conversation")
        case .completed:
            String(localized: "tasks.group.completed", table: "Conversation")
        }
    }
}

public extension TaskStatus {
    var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled:
            true
        case .queued, .running, .waitingApproval, .retryableFailed:
            false
        }
    }

    var sessionGroup: SessionTaskStatusGroup {
        switch self {
        case .waitingApproval:
            .needsIntervention
        case .queued, .running, .retryableFailed:
            .inProgress
        case .completed, .failed, .cancelled:
            .completed
        }
    }
}

private struct SessionWireKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

private enum SessionWireDecode {
    static func key(_ name: String) -> SessionWireKey { SessionWireKey(stringValue: name)! }

    static func check(
        _ container: KeyedDecodingContainer<SessionWireKey>,
        allowed: Set<String>,
        codingPath: [CodingKey]
    ) throws {
        guard Set(container.allKeys.map(\.stringValue)).isSubset(of: allowed) else {
            throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Unexpected wire key."))
        }
    }

    static func isoString(
        _ container: KeyedDecodingContainer<SessionWireKey>,
        _ name: String,
        codingPath: [CodingKey]
    ) throws -> String {
        let raw = try container.decode(String.self, forKey: key(name))
        guard EmberWireDate.parse(raw) != nil else {
            throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Invalid timestamp."))
        }
        return raw
    }

    static func optionalIsoString(
        _ container: KeyedDecodingContainer<SessionWireKey>,
        _ name: String,
        codingPath: [CodingKey]
    ) throws -> String? {
        guard let raw = try container.decodeIfPresent(String.self, forKey: key(name)) else { return nil }
        guard EmberWireDate.parse(raw) != nil else {
            throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Invalid timestamp."))
        }
        return raw
    }
}

/// Authoritative server Task snapshot for B1 Session Task endpoints (`GET /v1/me/tasks`, `GET /v1/me/tasks/:id`).
public struct SessionTaskDTO: Identifiable, Equatable, Codable, Sendable {
    public let taskID: UUID
    public let agentID: UUID
    public let kind: SessionTaskKind
    public let title: String?
    public let status: TaskStatus
    public let currentRunID: UUID?
    public let attemptCount: Int
    public let cancelRequested: Bool
    public let createdAt: String
    public let updatedAt: String
    public let deadlineAt: String?
    public let resultState: SessionTaskResultState?

    public var id: UUID { taskID }

    public var displayTitle: String {
        if let title {
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return kind.localizedDisplayTitle
    }

    public var updatedDate: Date {
        EmberWireDate.parse(updatedAt) ?? EmberWireDate.parse(createdAt) ?? .distantPast
    }

    public init(
        taskID: UUID,
        agentID: UUID,
        kind: SessionTaskKind,
        title: String? = nil,
        status: TaskStatus,
        currentRunID: UUID? = nil,
        attemptCount: Int = 0,
        cancelRequested: Bool = false,
        createdAt: String,
        updatedAt: String,
        deadlineAt: String? = nil,
        resultState: SessionTaskResultState? = nil
    ) {
        self.taskID = taskID
        self.agentID = agentID
        self.kind = kind
        self.title = title
        self.status = status
        self.currentRunID = currentRunID
        self.attemptCount = attemptCount
        self.cancelRequested = cancelRequested
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.deadlineAt = deadlineAt
        self.resultState = resultState
    }

    fileprivate static let allowedKeys: Set<String> = [
        "task_id", "agent_id", "kind", "title", "status",
        "current_run_id", "attempt_count", "cancel_requested",
        "created_at", "updated_at", "deadline_at", "result_state",
    ]

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case agentID = "agent_id"
        case kind
        case title
        case status
        case currentRunID = "current_run_id"
        case attemptCount = "attempt_count"
        case cancelRequested = "cancel_requested"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case deadlineAt = "deadline_at"
        case resultState = "result_state"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: SessionWireKey.self)
        try SessionWireDecode.check(container, allowed: Self.allowedKeys, codingPath: decoder.codingPath)
        try self.init(from: container, codingPath: decoder.codingPath)
    }

    fileprivate init(
        from container: KeyedDecodingContainer<SessionWireKey>,
        codingPath: [CodingKey]
    ) throws {
        taskID = try container.decode(UUID.self, forKey: SessionWireDecode.key("task_id"))
        agentID = try container.decode(UUID.self, forKey: SessionWireDecode.key("agent_id"))
        kind = try container.decode(SessionTaskKind.self, forKey: SessionWireDecode.key("kind"))
        let decodedTitle = try container.decodeIfPresent(String.self, forKey: SessionWireDecode.key("title"))
        if let decodedTitle, decodedTitle.count > 240 {
            throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Task title too long."))
        }
        title = decodedTitle
        status = try container.decode(TaskStatus.self, forKey: SessionWireDecode.key("status"))
        currentRunID = try container.decodeIfPresent(UUID.self, forKey: SessionWireDecode.key("current_run_id"))
        attemptCount = try container.decode(Int.self, forKey: SessionWireDecode.key("attempt_count"))
        guard attemptCount >= 0 else {
            throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Negative attempt count."))
        }
        cancelRequested = try container.decodeIfPresent(Bool.self, forKey: SessionWireDecode.key("cancel_requested")) ?? false
        createdAt = try SessionWireDecode.isoString(container, "created_at", codingPath: codingPath)
        updatedAt = try SessionWireDecode.isoString(container, "updated_at", codingPath: codingPath)
        deadlineAt = try SessionWireDecode.optionalIsoString(container, "deadline_at", codingPath: codingPath)
        resultState = try container.decodeIfPresent(SessionTaskResultState.self, forKey: SessionWireDecode.key("result_state"))

        if let resultState {
            if resultState == .pending && status.isTerminal {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Terminal task cannot have pending result_state."))
            }
            if resultState != .pending && !status.isTerminal {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Non-terminal task cannot have available/unavailable result_state."))
            }
        }
    }
}

/// Authoritative server Task detail snapshot for `GET /v1/me/tasks/{task_id}` (`B1TaskDetailDtoSchema`).
public struct SessionTaskDetailDTO: Codable, Equatable, Sendable {
    public let summary: SessionTaskDTO
    public let result: SessionTaskTextResult?

    public var taskID: UUID { summary.taskID }
    public var status: TaskStatus { summary.status }
    public var resultState: SessionTaskResultState? { summary.resultState }

    public var asResultDTO: SessionTaskResultDTO? {
        guard let resultState = summary.resultState else { return nil }
        return SessionTaskResultDTO(
            taskID: summary.taskID,
            taskStatus: summary.status,
            resultState: resultState,
            result: result
        )
    }

    private static let allowedKeys: Set<String> = SessionTaskDTO.allowedKeys.union(["result"])

    public init(summary: SessionTaskDTO, result: SessionTaskTextResult? = nil) {
        self.summary = summary
        self.result = result
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: SessionWireKey.self)
        try SessionWireDecode.check(container, allowed: Self.allowedKeys, codingPath: decoder.codingPath)
        summary = try SessionTaskDTO(from: container, codingPath: decoder.codingPath)
        result = try container.decodeIfPresent(SessionTaskTextResult.self, forKey: SessionWireDecode.key("result"))

        if let resultState = summary.resultState {
            if (resultState == .available) != (result != nil) {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Detail result presence mismatch."))
            }
        } else if !summary.status.isTerminal && result != nil {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Non-terminal task cannot carry result."))
        }
    }

    public func encode(to encoder: Encoder) throws {
        try summary.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(result, forKey: .result)
    }

    private enum CodingKeys: String, CodingKey {
        case result
    }
}

/// Wire page for `GET /v1/me/tasks`. Accepts either `{ "tasks": [...], ... }` or a JSON array `[...]`.
public struct SessionTaskListDTO: Decodable, Equatable, Sendable {
    public let tasks: [SessionTaskDTO]
    public let nextAfter: String?
    public let hasMore: Bool?

    private static let allowedKeys: Set<String> = ["tasks", "next_after", "has_more"]

    public init(tasks: [SessionTaskDTO], nextAfter: String? = nil, hasMore: Bool? = nil) {
        self.tasks = tasks
        self.nextAfter = nextAfter
        self.hasMore = hasMore
    }

    public init(from decoder: Decoder) throws {
        if let arrayContainer = try? decoder.singleValueContainer(),
           let array = try? arrayContainer.decode([SessionTaskDTO].self) {
            self.tasks = array
            self.nextAfter = nil
            self.hasMore = nil
            return
        }

        let container = try decoder.container(keyedBy: SessionWireKey.self)
        try SessionWireDecode.check(container, allowed: Self.allowedKeys, codingPath: decoder.codingPath)
        tasks = try container.decode([SessionTaskDTO].self, forKey: SessionWireDecode.key("tasks"))
        nextAfter = try container.decodeIfPresent(String.self, forKey: SessionWireDecode.key("next_after"))
        hasMore = try container.decodeIfPresent(Bool.self, forKey: SessionWireDecode.key("has_more"))
    }
}

/// Server-persisted Task event payload supporting real V1 `taskKind` values under the same strict key allowlist.
public struct SessionTaskEventPayloadDTO: Codable, Equatable, Sendable {
    public let taskKind: SessionTaskKind?
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

    private static let allowedKeys: Set<String> = [
        "taskKind", "runId", "attempt", "route", "fromStatus", "toStatus",
        "runStatus", "errorCode", "artifactId", "workspaceVersion", "sandboxId",
        "durationMs", "replayed", "cancelRequested", "policyVersion", "simulated",
    ]

    public init(
        taskKind: SessionTaskKind? = nil,
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

    enum CodingKeys: String, CodingKey {
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
        let container = try decoder.container(keyedBy: SessionWireKey.self)
        try SessionWireDecode.check(container, allowed: Self.allowedKeys, codingPath: decoder.codingPath)

        taskKind = try container.decodeIfPresent(SessionTaskKind.self, forKey: SessionWireDecode.key("taskKind"))
        runID = try container.decodeIfPresent(UUID.self, forKey: SessionWireDecode.key("runId"))
        attempt = try container.decodeIfPresent(Int.self, forKey: SessionWireDecode.key("attempt"))
        route = try container.decodeIfPresent(TaskExecutionPath.self, forKey: SessionWireDecode.key("route"))
        fromStatus = try container.decodeIfPresent(TaskStatus.self, forKey: SessionWireDecode.key("fromStatus"))
        toStatus = try container.decodeIfPresent(TaskStatus.self, forKey: SessionWireDecode.key("toStatus"))
        runStatus = try container.decodeIfPresent(TaskRunStatus.self, forKey: SessionWireDecode.key("runStatus"))
        errorCode = try container.decodeIfPresent(TaskErrorCode.self, forKey: SessionWireDecode.key("errorCode"))
        artifactID = try container.decodeIfPresent(UUID.self, forKey: SessionWireDecode.key("artifactId"))
        workspaceVersion = try container.decodeIfPresent(Int.self, forKey: SessionWireDecode.key("workspaceVersion"))
        sandboxID = try container.decodeIfPresent(UUID.self, forKey: SessionWireDecode.key("sandboxId"))
        durationMs = try container.decodeIfPresent(Int.self, forKey: SessionWireDecode.key("durationMs"))
        replayed = try container.decodeIfPresent(Bool.self, forKey: SessionWireDecode.key("replayed"))
        cancelRequested = try container.decodeIfPresent(Bool.self, forKey: SessionWireDecode.key("cancelRequested"))
        policyVersion = try container.decodeIfPresent(Int.self, forKey: SessionWireDecode.key("policyVersion"))
        simulated = try container.decodeIfPresent(Bool.self, forKey: SessionWireDecode.key("simulated"))
    }

    public func asLegacyPayload() -> TaskEventPayloadDTO {
        TaskEventPayloadDTO(
            taskKind: taskKind.flatMap { TaskKind(rawValue: $0.rawValue) },
            runID: runID,
            attempt: attempt,
            route: route,
            fromStatus: fromStatus,
            toStatus: toStatus,
            runStatus: runStatus,
            errorCode: errorCode,
            artifactID: artifactID,
            workspaceVersion: workspaceVersion,
            sandboxID: sandboxID,
            durationMs: durationMs,
            replayed: replayed,
            cancelRequested: cancelRequested,
            policyVersion: policyVersion,
            simulated: simulated
        )
    }
}

public struct SessionTaskEventDTO: Identifiable, Codable, Equatable, Sendable {
    public let taskID: UUID
    public let sequence: Int
    public let phase: TaskEventPhase
    public let occurredAt: String
    public let traceID: UUID
    public let payload: SessionTaskEventPayloadDTO

    public var id: Int { sequence }

    public init(
        taskID: UUID,
        sequence: Int,
        phase: TaskEventPhase,
        occurredAt: String,
        traceID: UUID,
        payload: SessionTaskEventPayloadDTO
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

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: SessionWireKey.self)
        try SessionWireDecode.check(
            container,
            allowed: ["task_id", "sequence", "phase", "occurred_at", "trace_id", "payload"],
            codingPath: decoder.codingPath
        )
        taskID = try container.decode(UUID.self, forKey: SessionWireDecode.key("task_id"))
        sequence = try container.decode(Int.self, forKey: SessionWireDecode.key("sequence"))
        guard sequence >= 1 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid sequence."))
        }
        phase = try container.decode(TaskEventPhase.self, forKey: SessionWireDecode.key("phase"))
        occurredAt = try SessionWireDecode.isoString(container, "occurred_at", codingPath: decoder.codingPath)
        traceID = try container.decode(UUID.self, forKey: SessionWireDecode.key("trace_id"))
        payload = try container.decode(SessionTaskEventPayloadDTO.self, forKey: SessionWireDecode.key("payload"))
    }

    public func asTaskEventDTO() -> TaskEventDTO {
        TaskEventDTO(
            taskID: taskID,
            sequence: sequence,
            phase: phase,
            occurredAt: occurredAt,
            traceID: traceID,
            payload: payload.asLegacyPayload()
        )
    }
}

public struct SessionTaskEventPageDTO: Codable, Equatable, Sendable {
    public let taskID: UUID
    public let events: [SessionTaskEventDTO]

    public init(taskID: UUID, events: [SessionTaskEventDTO]) {
        self.taskID = taskID
        self.events = events
    }

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case events
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: SessionWireKey.self)
        try SessionWireDecode.check(container, allowed: ["task_id", "events"], codingPath: decoder.codingPath)
        taskID = try container.decode(UUID.self, forKey: SessionWireDecode.key("task_id"))
        events = try container.decode([SessionTaskEventDTO].self, forKey: SessionWireDecode.key("events"))
    }
}

/// Frozen `B1TaskResultDtoSchema` states.
public enum SessionTaskResultState: String, Codable, Equatable, Sendable {
    case pending
    case available
    case unavailable
}

/// Frozen `B1TaskResultDtoSchema.result` payload.
public struct SessionTaskTextResult: Codable, Equatable, Sendable {
    public let summaryText: String
    public let detailText: String?
    public let modelLabel: String
    public let simulated: Bool
    public let producedAt: String

    private static let allowedKeys: Set<String> = [
        "summary_text", "detail_text", "model_label", "simulated", "produced_at",
    ]

    public init(
        summaryText: String,
        detailText: String?,
        modelLabel: String,
        simulated: Bool,
        producedAt: String
    ) {
        self.summaryText = summaryText
        self.detailText = detailText
        self.modelLabel = modelLabel
        self.simulated = simulated
        self.producedAt = producedAt
    }

    enum CodingKeys: String, CodingKey {
        case summaryText = "summary_text"
        case detailText = "detail_text"
        case modelLabel = "model_label"
        case simulated
        case producedAt = "produced_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: SessionWireKey.self)
        try SessionWireDecode.check(container, allowed: Self.allowedKeys, codingPath: decoder.codingPath)

        summaryText = try container.decode(String.self, forKey: SessionWireDecode.key("summary_text"))
        guard summaryText.count <= 2048 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "summary_text exceeds limit."))
        }
        detailText = try container.decodeIfPresent(String.self, forKey: SessionWireDecode.key("detail_text"))
        if let detailText, detailText.count > 16384 {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "detail_text exceeds limit."))
        }
        modelLabel = try container.decode(String.self, forKey: SessionWireDecode.key("model_label"))
        guard !modelLabel.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Empty model_label."))
        }
        simulated = try container.decode(Bool.self, forKey: SessionWireDecode.key("simulated"))
        producedAt = try SessionWireDecode.isoString(container, "produced_at", codingPath: decoder.codingPath)
    }
}

/// Frozen `B1TaskResultDtoSchema` for `GET /v1/tasks/{task_id}/result` enforcing X-1..X-9 invariants.
public struct SessionTaskResultDTO: Codable, Equatable, Sendable {
    public let taskID: UUID
    public let taskStatus: TaskStatus
    public let resultState: SessionTaskResultState
    public let result: SessionTaskTextResult?

    private static let allowedKeys: Set<String> = [
        "task_id", "task_status", "result_state", "result",
    ]

    public init(
        taskID: UUID,
        taskStatus: TaskStatus,
        resultState: SessionTaskResultState,
        result: SessionTaskTextResult?
    ) {
        self.taskID = taskID
        self.taskStatus = taskStatus
        self.resultState = resultState
        self.result = result
    }

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case taskStatus = "task_status"
        case resultState = "result_state"
        case result
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: SessionWireKey.self)
        try SessionWireDecode.check(container, allowed: Self.allowedKeys, codingPath: decoder.codingPath)

        taskID = try container.decode(UUID.self, forKey: SessionWireDecode.key("task_id"))
        taskStatus = try container.decode(TaskStatus.self, forKey: SessionWireDecode.key("task_status"))
        resultState = try container.decode(SessionTaskResultState.self, forKey: SessionWireDecode.key("result_state"))
        result = try container.decodeIfPresent(SessionTaskTextResult.self, forKey: SessionWireDecode.key("result"))

        // Contract invariants (B1TaskResultDtoSchema superRefine):
        // - Terminal tasks never have pending results.
        // - Available/unavailable results require a terminal task.
        // - Only `available` may contain a non-nil result object.
        if resultState == .pending && taskStatus.isTerminal {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Terminal task cannot have pending result."))
        }
        if resultState != .pending && !taskStatus.isTerminal {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Non-terminal task cannot have available/unavailable result."))
        }
        if (resultState == .available) != (result != nil) {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Result presence mismatch."))
        }
    }
}

public enum B3AttachmentLimits {
    public static let maxFileBytes = 262_144
    public static let maxAttachmentsPerMessage = 5
    public static let allowedMediaTypes: Set<String> = [
        "text/plain",
        "text/csv",
        "text/markdown",
    ]

    public static func mediaType(forFileExtension rawExtension: String) -> String? {
        switch rawExtension.lowercased() {
        case "csv":
            "text/csv"
        case "md", "markdown":
            "text/markdown"
        case "txt", "text", "log", "tsv":
            "text/plain"
        default:
            nil
        }
    }

    public static func defaultExtension(forMediaType mediaType: String) -> String {
        switch mediaType {
        case "text/csv":
            "csv"
        case "text/markdown":
            "md"
        default:
            "txt"
        }
    }

    public static func isSafeArtifactFilename(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 128, !value.contains("..") else { return false }
        let scalars = Array(value.unicodeScalars)
        guard let first = scalars.first, isAsciiAlnum(first) else { return false }
        return scalars.allSatisfy { scalar in
            isAsciiAlnum(scalar) || scalar == "." || scalar == "_" || scalar == "-"
        }
    }

    /// Normalizes arbitrary user-picked file names (including spaces or Unicode characters) into an ASCII
    /// filename accepted by `ArtifactFilenameSchema` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, without `..`).
    public static func safeUploadFilename(_ rawName: String, mediaType: String) -> String {
        let base = URL(fileURLWithPath: rawName).lastPathComponent
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var sanitized = String(base.unicodeScalars.map { scalar -> Character in
            if isAsciiAlnum(scalar) || scalar == "." || scalar == "_" || scalar == "-" {
                return Character(scalar)
            }
            return "_"
        })
        while sanitized.contains("..") {
            sanitized = sanitized.replacingOccurrences(of: "..", with: "_")
        }
        while sanitized.hasPrefix(".") || sanitized.hasPrefix("_") || sanitized.hasPrefix("-") {
            sanitized.removeFirst()
        }

        let ext = defaultExtension(forMediaType: mediaType)
        if sanitized.isEmpty {
            sanitized = "upload.\(ext)"
        } else if URL(fileURLWithPath: sanitized).pathExtension.isEmpty {
            sanitized += ".\(ext)"
        }

        if let first = sanitized.unicodeScalars.first, !isAsciiAlnum(first) {
            sanitized = "file_" + sanitized
        }

        if sanitized.count > 128 {
            let dotExt = ".\(ext)"
            let maxStem = max(1, 128 - dotExt.count)
            let rawStem = (sanitized as NSString).deletingPathExtension
            let clippedStem = String(rawStem.prefix(maxStem))
            sanitized = clippedStem + dotExt
        }

        if !isSafeArtifactFilename(sanitized) {
            return "upload.\(ext)"
        }
        return sanitized
    }

    fileprivate static func isValidSha256(_ value: String) -> Bool {
        value.count == 64 && value.unicodeScalars.allSatisfy { scalar in
            (scalar >= "0" && scalar <= "9") || (scalar >= "a" && scalar <= "f")
        }
    }

    private static func isAsciiAlnum(_ scalar: UnicodeScalar) -> Bool {
        (scalar >= "A" && scalar <= "Z")
            || (scalar >= "a" && scalar <= "z")
            || (scalar >= "0" && scalar <= "9")
    }
}

/// Server receipt returned by `POST /v1/me/uploads` (`B3StagedUploadReceiptDtoSchema`).
public struct StagedUploadReceiptDTO: Identifiable, Codable, Equatable, Sendable {
    public let uploadID: UUID
    public let filename: String
    public let mediaType: String
    public let size: Int
    public let sha256: String
    public let expiresAt: String
    public let createdAt: String

    public var id: UUID { uploadID }

    private static let allowedKeys: Set<String> = [
        "upload_id", "filename", "media_type", "size", "sha256", "expires_at", "created_at",
    ]

    public init(
        uploadID: UUID,
        filename: String,
        mediaType: String,
        size: Int,
        sha256: String,
        expiresAt: String,
        createdAt: String
    ) {
        self.uploadID = uploadID
        self.filename = filename
        self.mediaType = mediaType
        self.size = size
        self.sha256 = sha256
        self.expiresAt = expiresAt
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case uploadID = "upload_id"
        case filename
        case mediaType = "media_type"
        case size
        case sha256
        case expiresAt = "expires_at"
        case createdAt = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: SessionWireKey.self)
        try SessionWireDecode.check(container, allowed: Self.allowedKeys, codingPath: decoder.codingPath)

        uploadID = try container.decode(UUID.self, forKey: SessionWireDecode.key("upload_id"))
        let decodedFilename = try container.decode(String.self, forKey: SessionWireDecode.key("filename"))
        guard B3AttachmentLimits.isSafeArtifactFilename(decodedFilename) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid upload filename."))
        }
        filename = decodedFilename

        let decodedMediaType = try container.decode(String.self, forKey: SessionWireDecode.key("media_type"))
        guard B3AttachmentLimits.allowedMediaTypes.contains(decodedMediaType) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unsupported upload media_type."))
        }
        mediaType = decodedMediaType

        let decodedSize = try container.decode(Int.self, forKey: SessionWireDecode.key("size"))
        guard decodedSize >= 0 && decodedSize <= B3AttachmentLimits.maxFileBytes else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Upload size out of range."))
        }
        size = decodedSize

        let decodedSha = try container.decode(String.self, forKey: SessionWireDecode.key("sha256"))
        guard B3AttachmentLimits.isValidSha256(decodedSha) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid sha256 digest."))
        }
        sha256 = decodedSha

        expiresAt = try SessionWireDecode.isoString(container, "expires_at", codingPath: decoder.codingPath)
        createdAt = try SessionWireDecode.isoString(container, "created_at", codingPath: decoder.codingPath)
    }
}

public enum TaskArtifactCreator: String, Codable, Equatable, Sendable {
    case user
    case run
}

/// Artifact metadata item from `GET /v1/me/tasks/{task_id}/artifacts` (`B3TaskArtifactItemDtoSchema`).
public struct TaskArtifactItemDTO: Identifiable, Codable, Equatable, Sendable {
    public let artifactID: UUID
    public let filename: String?
    public let mediaType: String
    public let size: Int
    public let sha256: String
    public let createdBy: TaskArtifactCreator
    public let createdAt: String

    public var id: UUID { artifactID }

    public var displayFilename: String {
        if let filename, !filename.isEmpty {
            return filename
        }
        let ext = B3AttachmentLimits.defaultExtension(forMediaType: mediaType)
        return "artifact-\(artifactID.uuidString.lowercased().prefix(8)).\(ext)"
    }

    private static let allowedKeys: Set<String> = [
        "artifact_id", "filename", "media_type", "size", "sha256", "created_by", "created_at",
    ]

    public init(
        artifactID: UUID,
        filename: String?,
        mediaType: String,
        size: Int,
        sha256: String,
        createdBy: TaskArtifactCreator,
        createdAt: String
    ) {
        self.artifactID = artifactID
        self.filename = filename
        self.mediaType = mediaType
        self.size = size
        self.sha256 = sha256
        self.createdBy = createdBy
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case artifactID = "artifact_id"
        case filename
        case mediaType = "media_type"
        case size
        case sha256
        case createdBy = "created_by"
        case createdAt = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: SessionWireKey.self)
        try SessionWireDecode.check(container, allowed: Self.allowedKeys, codingPath: decoder.codingPath)

        artifactID = try container.decode(UUID.self, forKey: SessionWireDecode.key("artifact_id"))
        let decodedFilename = try container.decodeIfPresent(String.self, forKey: SessionWireDecode.key("filename"))
        if let decodedFilename, !B3AttachmentLimits.isSafeArtifactFilename(decodedFilename) {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid artifact filename."))
        }
        filename = decodedFilename

        let decodedMediaType = try container.decode(String.self, forKey: SessionWireDecode.key("media_type"))
        guard !decodedMediaType.isEmpty && decodedMediaType.count <= 128 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid artifact media_type."))
        }
        mediaType = decodedMediaType

        let decodedSize = try container.decode(Int.self, forKey: SessionWireDecode.key("size"))
        guard decodedSize >= 0 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Negative artifact size."))
        }
        size = decodedSize

        let decodedSha = try container.decode(String.self, forKey: SessionWireDecode.key("sha256"))
        guard B3AttachmentLimits.isValidSha256(decodedSha) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid artifact sha256."))
        }
        sha256 = decodedSha

        createdBy = try container.decode(TaskArtifactCreator.self, forKey: SessionWireDecode.key("created_by"))
        createdAt = try SessionWireDecode.isoString(container, "created_at", codingPath: decoder.codingPath)
    }
}

/// Response wrapper for `GET /v1/me/tasks/{task_id}/artifacts` (`B3TaskArtifactsListDtoSchema`).
public struct TaskArtifactsListDTO: Codable, Equatable, Sendable {
    public let taskID: UUID
    public let artifacts: [TaskArtifactItemDTO]

    private static let allowedKeys: Set<String> = ["task_id", "artifacts"]

    public init(taskID: UUID, artifacts: [TaskArtifactItemDTO]) {
        self.taskID = taskID
        self.artifacts = artifacts
    }

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case artifacts
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: SessionWireKey.self)
        try SessionWireDecode.check(container, allowed: Self.allowedKeys, codingPath: decoder.codingPath)

        taskID = try container.decode(UUID.self, forKey: SessionWireDecode.key("task_id"))
        let decoded = try container.decode([TaskArtifactItemDTO].self, forKey: SessionWireDecode.key("artifacts"))
        guard decoded.count <= 50 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Artifact list exceeds 50 items."))
        }
        artifacts = decoded
    }
}

public struct DownloadedTaskArtifact: Equatable, Sendable {
    public let artifactID: UUID
    public let filename: String
    public let mediaType: String
    public let data: Data

    public init(artifactID: UUID, filename: String, mediaType: String, data: Data) {
        self.artifactID = artifactID
        self.filename = filename
        self.mediaType = mediaType
        self.data = data
    }
}
