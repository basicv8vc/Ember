import Foundation

/// Stable identity of a Conversation. Deliberately not Codable until a reviewed wire
/// contract exists.
public struct ConversationID: Hashable, Sendable {
    public let rawValue: UUID

    public init(rawValue: UUID) {
        self.rawValue = rawValue
    }
}

/// Message identity is distinct from both the Conversation and assistant turn identity.
public struct MessageID: Hashable, Sendable {
    public let rawValue: UUID

    public init(rawValue: UUID) {
        self.rawValue = rawValue
    }
}

/// Identifies one assistant response lifecycle. It is not a Task identity.
public struct AssistantTurnID: Hashable, Sendable {
    public let rawValue: UUID

    public init(rawValue: UUID) {
        self.rawValue = rawValue
    }
}

public struct Conversation: Equatable, Sendable {
    public let id: ConversationID
    public let createdAt: Date
    public let updatedAt: Date

    public init(id: ConversationID, createdAt: Date, updatedAt: Date) {
        self.id = id
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// A reference points to a durable Task. Task status is intentionally not copied here.
public struct TaskReference: Equatable, Sendable {
    public let taskID: UUID

    public init(taskID: UUID) {
        self.taskID = taskID
    }
}

/// A reference points to a durable Commitment. Commitment lifecycle is not copied here.
public struct CommitmentReference: Equatable, Sendable {
    public let commitmentID: UUID

    public init(commitmentID: UUID) {
        self.commitmentID = commitmentID
    }
}

/// A typed reference to an outcome or an artifact that can be resolved independently.
public enum OutcomeReference: Equatable, Sendable {
    case taskResult(taskID: UUID)
    case artifact(artifactID: UUID, taskID: UUID?)
    case commitmentOutcome(outcomeID: UUID, commitmentID: UUID)
}

public enum ActivitySource: String, Equatable, Sendable {
    case system
    case task
    case commitment
}

/// Concise activity text is a typed timeline item, never an assistant message or Task state.
public struct ActivityMessage: Equatable, Sendable {
    public let text: String
    public let source: ActivitySource

    public init(text: String, source: ActivitySource) {
        self.text = text
        self.source = source
    }
}

/// Closed set of message kinds. An adapter must reject unknown wire kinds instead of
/// treating them as user or assistant prose.
public enum ConversationMessageKind: Equatable, Sendable {
    case user(text: String)
    case ember(text: String)
    case activity(ActivityMessage)
    case taskReference(TaskReference)
    case commitmentReference(CommitmentReference)
    case outcomeReference(OutcomeReference)
}

public struct ConversationMessage: Equatable, Sendable {
    public let id: MessageID
    public let conversationID: ConversationID
    /// Monotonically increasing, repository-assigned timeline position.
    public let sequence: Int
    public let turnID: AssistantTurnID?
    public let createdAt: Date
    public let kind: ConversationMessageKind

    public init(
        id: MessageID,
        conversationID: ConversationID,
        sequence: Int,
        turnID: AssistantTurnID? = nil,
        createdAt: Date,
        kind: ConversationMessageKind
    ) {
        self.id = id
        self.conversationID = conversationID
        self.sequence = sequence
        self.turnID = turnID
        self.createdAt = createdAt
        self.kind = kind
    }
}

/// Assistant-turn identity and trigger only. Its lifecycle lives in
/// `ConversationStateDimensions.turnStatuses` and is independent from TaskStatus.
public struct AssistantTurn: Equatable, Sendable {
    public let id: AssistantTurnID
    public let conversationID: ConversationID
    public let triggeringMessageID: MessageID
    public let createdAt: Date

    public init(
        id: AssistantTurnID,
        conversationID: ConversationID,
        triggeringMessage: ConversationMessage,
        createdAt: Date
    ) throws {
        if let validationError = Self.triggeringMessageValidationError(
            triggeringMessage,
            in: conversationID
        ) {
            throw validationError
        }

        self.id = id
        self.conversationID = conversationID
        self.triggeringMessageID = triggeringMessage.id
        self.createdAt = createdAt
    }

    static func triggeringMessageValidationError(
        _ message: ConversationMessage,
        in conversationID: ConversationID
    ) -> AssistantTurnValidationError? {
        guard message.conversationID == conversationID else {
            return .triggeringMessageBelongsToDifferentConversation
        }
        guard case .user = message.kind else {
            return .triggeringMessageMustBeUser
        }
        return nil
    }
}

public enum AssistantTurnValidationError: Error, Equatable, Sendable {
    case triggeringMessageBelongsToDifferentConversation
    case triggeringMessageMustBeUser
}

/// Read-only, in-memory view of a conversation. Ordering is normalized on construction;
/// sequence collisions are rejected by the repository.
public struct ConversationSnapshot: Equatable, Sendable {
    public let conversation: Conversation
    public let messages: [ConversationMessage]
    public let assistantTurns: [AssistantTurn]

    public init(
        conversation: Conversation,
        messages: [ConversationMessage],
        assistantTurns: [AssistantTurn]
    ) {
        self.conversation = conversation
        self.messages = messages.sorted {
            if $0.sequence != $1.sequence {
                return $0.sequence < $1.sequence
            }
            return $0.id.rawValue.uuidString < $1.id.rawValue.uuidString
        }
        self.assistantTurns = assistantTurns.sorted {
            if $0.createdAt != $1.createdAt {
                return $0.createdAt < $1.createdAt
            }
            return $0.id.rawValue.uuidString < $1.id.rawValue.uuidString
        }
    }
}
