import Foundation

/// Explicit repository states for a screen adapter to map into loading, empty, and recoverable
/// error UI. An empty history is a valid response, not a repository failure.
public enum ConversationLoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded(ConversationSnapshot)
    case empty(ConversationSnapshot)
    case failed(ConversationRepositoryError)

    public static func resolved(_ snapshot: ConversationSnapshot) -> ConversationLoadState {
        snapshot.messages.isEmpty ? .empty(snapshot) : .loaded(snapshot)
    }
}

/// Assistant response lifecycle only. These values never imply a Task lifecycle change.
public enum ConversationTurnStatus: String, Equatable, Sendable {
    case queued
    case streaming
    case completed
    case failed
    case cancelled
}

public enum ConversationConnectionStatus: String, Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case unavailable
}

/// Status of a local send command/acknowledgement, independent from turn and Task state.
public enum ConversationCommandStatus: String, Equatable, Sendable {
    case idle
    case submitting
    case acknowledged
    case unknownAcknowledgement
    case rejected
    case failed
}

/// Independent state dimensions used by a presentation adapter. Task values are the frozen
/// M2 `TaskStatus` contract; they are keyed by Task ID and never derived from transcript text.
public struct ConversationStateDimensions: Equatable, Sendable {
    public var turnStatuses: [AssistantTurnID: ConversationTurnStatus]
    public var taskStatuses: [UUID: TaskStatus]
    public var connectionStatus: ConversationConnectionStatus
    public var commandStatuses: [MessageID: ConversationCommandStatus]

    public init(
        turnStatuses: [AssistantTurnID: ConversationTurnStatus] = [:],
        taskStatuses: [UUID: TaskStatus] = [:],
        connectionStatus: ConversationConnectionStatus = .disconnected,
        commandStatuses: [MessageID: ConversationCommandStatus] = [:]
    ) {
        self.turnStatuses = turnStatuses
        self.taskStatuses = taskStatuses
        self.connectionStatus = connectionStatus
        self.commandStatuses = commandStatuses
    }
}
