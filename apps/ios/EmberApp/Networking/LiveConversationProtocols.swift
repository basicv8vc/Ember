import Foundation

/// Abstraction over the live conversation repository so tests and mock B3 verification can
/// inject deterministic timelines through the same `LiveConversationHost` and `LiveConversationHostModel`.
protocol LiveConversationServiceProtocol: Sendable {
    func bootstrap() async throws -> EmberMeDTO
    func load() async throws -> ConversationSnapshot
    func recoverAfterRelaunch() async throws -> ConversationSnapshot
    func pending() async throws -> LiveConversationJournal.Pending?
    func activeTurn() async throws -> LiveConversationJournal.Turn?
    func rejectedDraft() async throws -> LiveConversationJournal.Pending?
    func send(text: String) async throws -> LiveB1Receipt
    func reconcilePending() async throws -> LiveB1Receipt?
    func pollActiveTurn() async throws -> LiveB1Turn?
    func cancelActiveTurn() async throws -> LiveB1Turn?
    func clearOnLogout() async
}

protocol LiveAuthControlling: Sendable {
    @discardableResult
    func signInWithApple() async throws -> EmberSessionRecord
    func logout() async -> LogoutOutcome
    func registerSignOutCleanup(_ hook: @escaping @Sendable () async -> Void) async
}

extension LiveConversationRepository: LiveConversationServiceProtocol {}

extension LiveAuthSessionCoordinator: LiveAuthControlling {}
