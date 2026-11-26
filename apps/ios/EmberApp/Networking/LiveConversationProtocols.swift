import Foundation

struct LiveConversationSendSession: Sendable {
    let receipt: LiveB1Receipt
    let events: AsyncThrowingStream<LiveV2StreamEvent, Error>?
}

/// Abstraction over the live conversation repository so tests and mock B3 verification can
/// inject deterministic timelines through the same `LiveConversationHost` and `LiveConversationHostModel`.
protocol LiveConversationServiceProtocol: Sendable {
    func bootstrap() async throws -> EmberMeDTO
    func load() async throws -> ConversationSnapshot
    func recoverAfterRelaunch() async throws -> ConversationSnapshot
    func pending() async throws -> LiveConversationJournal.Pending?
    func discardPending() async throws
    func activeTurn() async throws -> LiveConversationJournal.Turn?
    func rejectedDraft() async throws -> LiveConversationJournal.Pending?
    func uploadAttachment(filename: String, mediaType: String, data: Data) async throws -> StagedUploadReceiptDTO
    func send(text: String, attachmentIDs: [UUID]) async throws -> LiveB1Receipt
    func sendStreaming(text: String, attachmentIDs: [UUID]) async throws -> LiveConversationSendSession
    func finishTurnFromStream(_ turn: LiveB1Turn) async
    func reconcilePending() async throws -> LiveB1Receipt?
    func pollActiveTurn() async throws -> LiveB1Turn?
    func cancelActiveTurn() async throws -> LiveB1Turn?
    func clearOnLogout() async
}

extension LiveConversationServiceProtocol {
    func send(text: String) async throws -> LiveB1Receipt {
        try await send(text: text, attachmentIDs: [])
    }

    func sendStreaming(text: String, attachmentIDs: [UUID]) async throws -> LiveConversationSendSession {
        let receipt = try await send(text: text, attachmentIDs: attachmentIDs)
        return LiveConversationSendSession(receipt: receipt, events: nil)
    }

    func finishTurnFromStream(_ turn: LiveB1Turn) async {}

    func discardPending() async throws {}
}

protocol LiveAuthControlling: Sendable {
    @discardableResult
    func signInWithApple() async throws -> EmberSessionRecord
    func logout() async -> LogoutOutcome
    func registerSignOutCleanup(_ hook: @escaping @Sendable () async -> Void) async
}

extension LiveConversationRepository: LiveConversationServiceProtocol {}

extension LiveAuthSessionCoordinator: LiveAuthControlling {}
