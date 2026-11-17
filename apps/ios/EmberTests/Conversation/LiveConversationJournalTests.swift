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

    func testTerminal409SurvivesRelaunchAsDraftNotPending() async throws {
        let consumer = UUID()
        let original = LiveConversationJournal.Pending(
            clientSubmissionID: UUID(), conversationID: UUID(),
            transcriptEpoch: 2, text: "Preserve this draft")
        let first = LiveConversationJournal(directory: directory)
        try await first.bind(consumerID: consumer)
        try await first.prepare(original, consumerID: consumer)
        try await first.markConflict(original, consumerID: consumer)

        let second = LiveConversationJournal(directory: directory)
        let pending = try await second.pending(for: consumer)
        let rejected = try await second.rejectedDraft(for: consumer)
        XCTAssertNil(pending)
        XCTAssertEqual(rejected, original)

        // Only an explicit new send discards the old rejected draft.
        let newIntent = LiveConversationJournal.Pending(
            clientSubmissionID: UUID(), conversationID: original.conversationID,
            transcriptEpoch: 3, text: "Deliberate new send")
        try await second.prepare(newIntent, consumerID: consumer)
        let newPending = try await second.pending(for: consumer)
        let previousDraft = try await second.rejectedDraft(for: consumer)
        XCTAssertEqual(newPending, newIntent)
        XCTAssertNil(previousDraft)
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

    func testPendingPreservesAttachmentIDsAndDecodesLegacyRecordsWithoutThem() async throws {
        let uploadID = UUID()
        let withAttachments = LiveConversationJournal.Pending(
            clientSubmissionID: UUID(),
            conversationID: UUID(),
            transcriptEpoch: 1,
            text: "Run regression on CSV",
            attachmentIDs: [uploadID]
        )
        let encoded = try JSONEncoder().encode(withAttachments)
        let decoded = try JSONDecoder().decode(LiveConversationJournal.Pending.self, from: encoded)
        XCTAssertEqual(decoded.attachmentIDs, [uploadID])
        XCTAssertEqual(decoded.submission.attachmentIDs, [uploadID])

        let legacyJSON = Data("""
        {
          "clientSubmissionID":"11111111-1111-4111-8111-111111111111",
          "conversationID":"22222222-2222-4222-8222-222222222222",
          "transcriptEpoch":3,
          "text":"Legacy entry"
        }
        """.utf8)
        let decodedLegacy = try JSONDecoder().decode(LiveConversationJournal.Pending.self, from: legacyJSON)
        XCTAssertTrue(decodedLegacy.attachmentIDs.isEmpty)
        XCTAssertTrue(decodedLegacy.submission.attachmentIDs.isEmpty)
    }
}
