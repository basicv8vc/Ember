import Foundation

/// Deterministic process-memory repository for previews and tests.
/// This actor is intentionally not Codable and never writes conversation text to disk.
public actor InMemoryConversationRepository: ConversationRepositoryProtocol {
    private var snapshots: [ConversationID: ConversationSnapshot]

    public init(fixtures: [ConversationSnapshot]) throws {
        var indexed: [ConversationID: ConversationSnapshot] = [:]

        for snapshot in fixtures {
            let conversationID = snapshot.conversation.id
            guard indexed[conversationID] == nil else {
                throw ConversationRepositoryError.duplicateConversation(conversationID)
            }
            try Self.validate(snapshot)
            indexed[conversationID] = snapshot
        }

        snapshots = indexed
    }

    public func fetchConversation(id: ConversationID) async throws -> ConversationSnapshot {
        guard let snapshot = snapshots[id] else {
            throw ConversationRepositoryError.conversationNotFound(id)
        }
        return snapshot
    }

    public func appendMessage(
        _ message: ConversationMessage,
        to conversationID: ConversationID
    ) async throws -> ConversationSnapshot {
        guard let snapshot = snapshots[conversationID] else {
            throw ConversationRepositoryError.conversationNotFound(conversationID)
        }
        guard message.conversationID == conversationID else {
            throw ConversationRepositoryError.invalidMessage(conversationID, message.id)
        }
        guard !snapshot.messages.contains(where: { $0.id == message.id }) else {
            throw ConversationRepositoryError.duplicateMessage(message.id)
        }

        let nextSequence = (snapshot.messages.map(\.sequence).max() ?? 0) + 1
        guard message.sequence == nextSequence else {
            throw ConversationRepositoryError.nonSequentialMessageSequence(
                conversationID,
                message.sequence
            )
        }

        let updatedAt = max(snapshot.conversation.updatedAt, message.createdAt)
        let updatedConversation = Conversation(
            id: snapshot.conversation.id,
            createdAt: snapshot.conversation.createdAt,
            updatedAt: updatedAt
        )
        let updated = ConversationSnapshot(
            conversation: updatedConversation,
            messages: snapshot.messages + [message],
            assistantTurns: snapshot.assistantTurns
        )
        try Self.validate(updated)
        snapshots[conversationID] = updated
        return updated
    }

    public func upsertAssistantTurn(
        _ turn: AssistantTurn,
        in conversationID: ConversationID
    ) async throws -> ConversationSnapshot {
        guard let snapshot = snapshots[conversationID] else {
            throw ConversationRepositoryError.conversationNotFound(conversationID)
        }
        guard turn.conversationID == conversationID,
              let triggeringMessage = snapshot.messages.first(where: {
                  $0.id == turn.triggeringMessageID && $0.conversationID == conversationID
              }),
              AssistantTurn.triggeringMessageValidationError(
                  triggeringMessage,
                  in: conversationID
              ) == nil else {
            throw ConversationRepositoryError.invalidAssistantTurn(conversationID, turn.id)
        }

        var turns = snapshot.assistantTurns
        if let index = turns.firstIndex(where: { $0.id == turn.id }) {
            guard turns[index] == turn else {
                throw ConversationRepositoryError.invalidAssistantTurn(conversationID, turn.id)
            }
            turns[index] = turn
        } else {
            turns.append(turn)
        }

        let updated = ConversationSnapshot(
            conversation: snapshot.conversation,
            messages: snapshot.messages,
            assistantTurns: turns
        )
        try Self.validate(updated)
        snapshots[conversationID] = updated
        return updated
    }

    private static func validate(_ snapshot: ConversationSnapshot) throws {
        let conversationID = snapshot.conversation.id
        var messageIDs = Set<MessageID>()
        var sequences = Set<Int>()
        var messagesByID: [MessageID: ConversationMessage] = [:]

        for message in snapshot.messages {
            guard message.conversationID == conversationID,
                  message.sequence > 0 else {
                throw ConversationRepositoryError.invalidMessage(conversationID, message.id)
            }
            guard messageIDs.insert(message.id).inserted else {
                throw ConversationRepositoryError.duplicateMessage(message.id)
            }
            messagesByID[message.id] = message
            guard sequences.insert(message.sequence).inserted else {
                throw ConversationRepositoryError.duplicateMessageSequence(
                    conversationID,
                    message.sequence
                )
            }
        }

        var turnIDs = Set<AssistantTurnID>()
        for turn in snapshot.assistantTurns {
            guard turn.conversationID == conversationID,
                  let triggeringMessage = messagesByID[turn.triggeringMessageID],
                  AssistantTurn.triggeringMessageValidationError(
                      triggeringMessage,
                      in: conversationID
                  ) == nil,
                  turnIDs.insert(turn.id).inserted else {
                throw ConversationRepositoryError.invalidAssistantTurn(conversationID, turn.id)
            }
        }
    }
}
