import Foundation

/// Narrow local domain boundary for loading and updating a conversation timeline.
/// Implementations must not perform network access or persist raw conversation text.
public protocol ConversationRepositoryProtocol: Sendable {
    func fetchConversation(id: ConversationID) async throws -> ConversationSnapshot

    func appendMessage(
        _ message: ConversationMessage,
        to conversationID: ConversationID
    ) async throws -> ConversationSnapshot

    func upsertAssistantTurn(
        _ turn: AssistantTurn,
        in conversationID: ConversationID
    ) async throws -> ConversationSnapshot
}

public enum ConversationRepositoryError: Error, Equatable, Sendable {
    case conversationNotFound(ConversationID)
    case duplicateConversation(ConversationID)
    case duplicateMessage(MessageID)
    case duplicateMessageSequence(ConversationID, Int)
    case nonSequentialMessageSequence(ConversationID, Int)
    case invalidMessage(ConversationID, MessageID)
    case invalidAssistantTurn(ConversationID, AssistantTurnID)
}
