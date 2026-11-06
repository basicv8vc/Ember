import Foundation
import XCTest
@testable import Ember

@MainActor
final class LiveConversationJournalTests: XCTestCase {
    private let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("ember-live-journal-\(UUID().uuidString)", isDirectory: true)

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }

    func testColdStartPreservesTheOriginalSubmissionIDAndBody() async throws {
        let first = LiveConversationJournal(directory: directory)
        let consumer = UUID()
        let conversation = UUID()
        let original = LiveConversationJournal.Pending(
            clientSubmissionID: UUID(), conversationID: conversation,
            transcriptEpoch: 4, text: "Private message never appears in a log")
        try await first.bind(consumerID: consumer)
        try await first.prepare(original, consumerID: consumer)

        // A fresh actor reads the same file, which is the actual relaunch boundary.
        let restored = LiveConversationJournal(directory: directory)
        let restoredValue = try await restored.pending(for: consumer)
        XCTAssertEqual(restoredValue, original)
        XCTAssertEqual(restoredValue?.submission.clientSubmissionID, original.clientSubmissionID)
    }

    func testPendingIDCannotBeRegeneratedWhileUnresolved() async throws {
        let store = LiveConversationJournal(directory: directory)
        let consumer = UUID()
        try await store.bind(consumerID: consumer)
        let pending = LiveConversationJournal.Pending(
            clientSubmissionID: UUID(), conversationID: UUID(),
            transcriptEpoch: 0, text: "One send")
        try await store.prepare(pending, consumerID: consumer)
        do {
            try await store.prepare(LiveConversationJournal.Pending(
                clientSubmissionID: UUID(), conversationID: pending.conversationID,
                transcriptEpoch: 0, text: "Second send"), consumerID: consumer)
            XCTFail("an unresolved send must block a new intent")
        } catch let error as LiveB1Failure {
            XCTAssertEqual(error, .unknownAcknowledgement)
        }
        let existing = try await store.pending(for: consumer)
        XCTAssertEqual(existing, pending)
    }

    func testSwitchingConsumersNeverMovesPrivateOutbox() async throws {
        let store = LiveConversationJournal(directory: directory)
        let firstID = UUID()
        let secondID = UUID()
        try await store.bind(consumerID: firstID)
        try await store.prepare(.init(
            clientSubmissionID: UUID(), conversationID: UUID(),
            transcriptEpoch: 2, text: "Previous consumer private text"), consumerID: firstID)
        try await store.bind(consumerID: secondID)
        let second = try await store.pending(for: secondID)
        let first = try await store.pending(for: firstID)
        XCTAssertNil(second)
        XCTAssertNil(first)
    }

    func testLogoutClearsPendingAndTurnCheckpoint() async throws {
        let store = LiveConversationJournal(directory: directory)
        let consumer = UUID()
        try await store.bind(consumerID: consumer)
        try await store.prepare(.init(
            clientSubmissionID: UUID(), conversationID: UUID(),
            transcriptEpoch: 0, text: "Pending"), consumerID: consumer)
        try await store.reset()
        let relaunched = LiveConversationJournal(directory: directory)
        let pending = try await relaunched.pending(for: consumer)
        XCTAssertNil(pending)
    }
}
