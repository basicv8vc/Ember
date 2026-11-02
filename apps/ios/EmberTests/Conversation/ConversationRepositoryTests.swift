import Foundation
import XCTest
@testable import Ember

final class ConversationRepositoryTests: XCTestCase {
    func testFixtureHasStableMessageOrderingAndMultipleTurns() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let first = try await repository.fetchConversation(id: ConversationFixtures.mainConversationID)
        let second = try await repository.fetchConversation(id: ConversationFixtures.mainConversationID)

        XCTAssertEqual(first, second)
        XCTAssertEqual(first.messages.map(\.sequence), Array(1...9))
        XCTAssertEqual(first.assistantTurns.map(\.id), [
            ConversationFixtures.firstTurnID,
            ConversationFixtures.secondTurnID,
            ConversationFixtures.thirdTurnID,
        ])
        XCTAssertEqual(first.messages.first?.kind, .user(text: "整理这周的会议笔记。"))
        XCTAssertEqual(first.messages.last?.kind, .user(text: "把结果整理成一段简短摘要。"))
    }

    func testSnapshotSortsMessagesByExplicitSequenceNotInputOrder() {
        let fixture = ConversationFixtures.mainConversation
        let reversed = ConversationSnapshot(
            conversation: fixture.conversation,
            messages: Array(fixture.messages.reversed()),
            assistantTurns: Array(fixture.assistantTurns.reversed())
        )

        XCTAssertEqual(reversed.messages.map(\.sequence), fixture.messages.map(\.sequence))
        XCTAssertEqual(reversed.assistantTurns.map(\.id), fixture.assistantTurns.map(\.id))
    }

    func testTypedMessagesCoverUserEmberActivityTaskCommitmentAndOutcome() {
        let kinds = ConversationFixtures.mainConversation.messages.map(\.kind)

        XCTAssertTrue(kinds.contains { if case .user = $0 { true } else { false } })
        XCTAssertTrue(kinds.contains { if case .ember = $0 { true } else { false } })
        XCTAssertTrue(kinds.contains { if case .activity = $0 { true } else { false } })
        XCTAssertTrue(kinds.contains { if case let .taskReference(reference) = $0 {
            reference.taskID == ConversationFixtures.taskID
        } else { false } })
        XCTAssertTrue(kinds.contains { if case let .commitmentReference(reference) = $0 {
            reference.commitmentID == ConversationFixtures.commitmentID
        } else { false } })
        XCTAssertTrue(kinds.contains { if case let .outcomeReference(.artifact(artifactID, taskID)) = $0 {
            artifactID == ConversationFixtures.artifactID && taskID == ConversationFixtures.taskID
        } else { false } })
    }

    func testEmptyConversationIsAValidEmptyState() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let empty = try await repository.fetchConversation(
            id: ConversationFixtures.emptyConversation.conversation.id
        )

        XCTAssertTrue(empty.messages.isEmpty)
        XCTAssertTrue(empty.assistantTurns.isEmpty)
        XCTAssertEqual(ConversationLoadState.resolved(empty), .empty(empty))
        XCTAssertEqual(
            ConversationLoadState.resolved(ConversationFixtures.mainConversation),
            .loaded(ConversationFixtures.mainConversation)
        )
    }

    func testUnknownConversationReturnsTypedErrorState() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let missingID = ConversationID(
            rawValue: UUID(uuidString: "71000000-0000-4000-8000-000000000099")!
        )

        do {
            _ = try await repository.fetchConversation(id: missingID)
            XCTFail("Missing conversations must surface an explicit repository error.")
        } catch let error as ConversationRepositoryError {
            XCTAssertEqual(error, .conversationNotFound(missingID))
            XCTAssertEqual(ConversationLoadState.failed(error), .failed(error))
        } catch {
            XCTFail("Expected a typed repository error, got \(error).")
        }
    }

    func testAppendingMessageRequiresNextStableSequenceAndPreservesHistory() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let conversationID = ConversationFixtures.mainConversationID
        let turnID = ConversationFixtures.thirdTurnID
        let userMessage = ConversationMessage(
            id: MessageID(rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000010")!),
            conversationID: conversationID,
            sequence: 10,
            turnID: turnID,
            createdAt: Date(timeIntervalSince1970: 1_793_520_100),
            kind: .user(text: "还有一个补充。")
        )

        let updated = try await repository.appendMessage(userMessage, to: conversationID)

        XCTAssertEqual(updated.messages.map(\.sequence), Array(1...10))
        XCTAssertEqual(updated.messages.last, userMessage)
        XCTAssertEqual(updated.assistantTurns.count, 3)
        XCTAssertEqual(updated.conversation.updatedAt, userMessage.createdAt)
    }

    func testAssistantTurnIdentityCanBeUpsertedWithoutMutatingMessageHistory() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let before = try await repository.fetchConversation(id: ConversationFixtures.mainConversationID)
        let trigger = try XCTUnwrap(before.messages.first)
        let newTurn = try AssistantTurn(
            id: ConversationFixtures.firstTurnID,
            conversationID: before.conversation.id,
            triggeringMessage: trigger,
            createdAt: trigger.createdAt
        )

        let updated = try await repository.upsertAssistantTurn(
            newTurn,
            in: before.conversation.id
        )

        XCTAssertEqual(updated.messages, before.messages)
        XCTAssertEqual(updated.assistantTurns.count, before.assistantTurns.count)
        XCTAssertEqual(updated.assistantTurns.first?.id, newTurn.id)
    }

    func testAssistantTurnCannotUseAssistantMessageAsTrigger() async throws {
        let conversationID = ConversationID(
            rawValue: UUID(uuidString: "78000000-0000-4000-8000-000000000001")!
        )
        let messageID = MessageID(
            rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000099")!
        )
        let timestamp = Date(timeIntervalSince1970: 1_793_520_000)
        let conversation = Conversation(
            id: conversationID,
            createdAt: timestamp,
            updatedAt: timestamp
        )
        let assistantMessage = ConversationMessage(
            id: messageID,
            conversationID: conversationID,
            sequence: 1,
            createdAt: timestamp,
            kind: .ember(text: "我来整理这个请求。")
        )

        XCTAssertThrowsError(
            try AssistantTurn(
                id: ConversationFixtures.firstTurnID,
                conversationID: conversationID,
                triggeringMessage: assistantMessage,
                createdAt: timestamp
            )
        ) { error in
            XCTAssertEqual(
                error as? AssistantTurnValidationError,
                .triggeringMessageMustBeUser
            )
        }

        let conflictingUserMessage = ConversationMessage(
            id: messageID,
            conversationID: conversationID,
            sequence: 1,
            createdAt: timestamp,
            kind: .user(text: "整理这个请求。")
        )
        let turn = try AssistantTurn(
            id: ConversationFixtures.firstTurnID,
            conversationID: conversationID,
            triggeringMessage: conflictingUserMessage,
            createdAt: timestamp
        )
        let invalidSnapshot = ConversationSnapshot(
            conversation: conversation,
            messages: [assistantMessage],
            assistantTurns: [turn]
        )

        XCTAssertThrowsError(
            try InMemoryConversationRepository(fixtures: [invalidSnapshot])
        ) { error in
            XCTAssertEqual(
                error as? ConversationRepositoryError,
                .invalidAssistantTurn(conversationID, turn.id)
            )
        }

        let repository = try InMemoryConversationRepository(fixtures: [
            ConversationSnapshot(
                conversation: conversation,
                messages: [assistantMessage],
                assistantTurns: []
            ),
        ])

        do {
            _ = try await repository.upsertAssistantTurn(turn, in: conversationID)
            XCTFail("Upsert must validate the canonical repository message kind.")
        } catch let error as ConversationRepositoryError {
            XCTAssertEqual(error, .invalidAssistantTurn(conversationID, turn.id))
        }
    }

    func testTurnTaskConnectionAndCommandStatusesRemainIndependent() {
        let commandMessageID = ConversationFixtures.mainConversation.messages[0].id
        let dimensions = ConversationStateDimensions(
            turnStatuses: [ConversationFixtures.firstTurnID: .completed],
            taskStatuses: [ConversationFixtures.taskID: .running],
            connectionStatus: .reconnecting,
            commandStatuses: [commandMessageID: .unknownAcknowledgement]
        )

        XCTAssertEqual(dimensions.turnStatuses[ConversationFixtures.firstTurnID], .completed)
        XCTAssertEqual(dimensions.taskStatuses[ConversationFixtures.taskID], .running)
        XCTAssertEqual(dimensions.connectionStatus, .reconnecting)
        XCTAssertEqual(dimensions.commandStatuses[commandMessageID], .unknownAcknowledgement)
    }

    func testRepositoryRejectsDuplicateFixtureConversationAndMessageSequence() throws {
        let fixture = ConversationFixtures.mainConversation

        XCTAssertThrowsError(try InMemoryConversationRepository(fixtures: [fixture, fixture])) { error in
            XCTAssertEqual(
                error as? ConversationRepositoryError,
                .duplicateConversation(fixture.conversation.id)
            )
        }

        let duplicateSequence = ConversationSnapshot(
            conversation: fixture.conversation,
            messages: [fixture.messages[0], ConversationMessage(
                id: MessageID(rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000099")!),
                conversationID: fixture.conversation.id,
                sequence: fixture.messages[0].sequence,
                createdAt: fixture.messages[0].createdAt,
                kind: .activity(ActivityMessage(text: "Fixture activity", source: .system))
            )],
            assistantTurns: []
        )

        XCTAssertThrowsError(try InMemoryConversationRepository(fixtures: [duplicateSequence])) { error in
            XCTAssertEqual(
                error as? ConversationRepositoryError,
                .duplicateMessageSequence(fixture.conversation.id, fixture.messages[0].sequence)
            )
        }
    }
}
