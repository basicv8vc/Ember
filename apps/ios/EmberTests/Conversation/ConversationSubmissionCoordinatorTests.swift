import XCTest
@testable import Ember

@MainActor
final class ConversationSubmissionCoordinatorTests: XCTestCase {
    private let conversationID = ConversationID(
        rawValue: UUID(uuidString: "73000000-0000-4000-8000-000000000001")!
    )

    func testPreparedSubmissionCanBeCancelledBeforeDispatch() async throws {
        let repository = MockConversationSubmissionRepository()
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let submission = try XCTUnwrap(
            coordinator.prepare(conversationID: conversationID, transcriptEpoch: 0, text: "Do not send yet.")
        )

        coordinator.cancelBeforeDispatch()
        await coordinator.dispatchPrepared()

        XCTAssertEqual(coordinator.state, .cancelledBeforeDispatch(submission))
        let recorded = await repository.recordedSubmissions()
        XCTAssertTrue(recorded.isEmpty)
    }

    func testDispatchPreparedReturnsB1ReceiptFields() async throws {
        let repository = MockConversationSubmissionRepository(submitOutcomes: [.accepted])
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let submission = try XCTUnwrap(
            coordinator.prepare(conversationID: conversationID, transcriptEpoch: 4, text: "Send once.")
        )

        await coordinator.dispatchPrepared()

        guard case .accepted(let accepted, let receipt) = coordinator.state else {
            return XCTFail("Expected accepted state")
        }
        XCTAssertEqual(accepted, submission)
        XCTAssertEqual(receipt.clientSubmissionID, submission.clientSubmissionID)
        XCTAssertEqual(receipt.transcriptEpoch, 4)
        XCTAssertGreaterThan(receipt.sequence, 0)
        XCTAssertEqual(receipt.turnStatus, .running)
    }

    func testUnknownAckLookupAdoptsCommittedReceiptWithoutSecondPost() async throws {
        let repository = MockConversationSubmissionRepository(
            submitOutcomes: [.unknownAcknowledgement(committed: true)]
        )
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 2,
            text: "The server committed this, but the ACK was lost."
        )
        let submission = try XCTUnwrap(result)

        let recovered = await coordinator.recoverUnknownAcknowledgement(currentTranscriptEpoch: 2)

        XCTAssertEqual(recovered, submission)
        guard case .accepted(let accepted, let receipt) = coordinator.state else {
            return XCTFail("Lookup should adopt the already committed receipt")
        }
        XCTAssertEqual(accepted, submission)
        XCTAssertEqual(receipt.clientSubmissionID, submission.clientSubmissionID)
        let recorded = await repository.recordedSubmissions()
        let lookups = await repository.recordedLookupIDs()
        XCTAssertEqual(recorded, [submission])
        XCTAssertEqual(lookups, [submission.clientSubmissionID])
    }

    func testUnknownAck404RetriesExactSameSubmission() async throws {
        let repository = MockConversationSubmissionRepository(
            submitOutcomes: [.unknownAcknowledgement(committed: false), .accepted]
        )
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 3,
            text: "Retry only after lookup says not found."
        )
        let original = try XCTUnwrap(result)

        let recovered = await coordinator.recoverUnknownAcknowledgement(currentTranscriptEpoch: 3)

        XCTAssertEqual(recovered, original)
        guard case .accepted(let accepted, let receipt) = coordinator.state else {
            return XCTFail("A lookup 404 should retry the same POST")
        }
        XCTAssertEqual(accepted, original)
        XCTAssertEqual(receipt.clientSubmissionID, original.clientSubmissionID)
        XCTAssertEqual(receipt.transcriptEpoch, original.transcriptEpoch)
        let recorded = await repository.recordedSubmissions()
        XCTAssertEqual(recorded, [original, original])
    }

    func testLookup404WithNewerTranscriptEpochDoesNotResubmitStaleText() async throws {
        let repository = MockConversationSubmissionRepository(
            submitOutcomes: [.unknownAcknowledgement(committed: false), .accepted]
        )
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: "This intent belongs to the deleted transcript."
        )
        let stale = try XCTUnwrap(result)

        let recovered = await coordinator.recoverUnknownAcknowledgement(currentTranscriptEpoch: 1)

        XCTAssertNil(recovered)
        XCTAssertEqual(
            coordinator.state,
            .discardedByTranscriptDeletion(stale, currentEpoch: 1)
        )
        let recorded = await repository.recordedSubmissions()
        XCTAssertEqual(recorded, [stale])
    }

    func testLookupUnavailableKeepsUnknownAckWithoutPostingAgain() async throws {
        let repository = MockConversationSubmissionRepository(
            submitOutcomes: [.unknownAcknowledgement(committed: false)],
            lookupOutcomes: [.unavailable]
        )
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: "Keep pending until reconciliation is possible."
        )
        let original = try XCTUnwrap(result)

        let recovered = await coordinator.recoverUnknownAcknowledgement(currentTranscriptEpoch: 0)

        XCTAssertNil(recovered)
        XCTAssertEqual(coordinator.state, .unknownAcknowledgement(original))
        let recorded = await repository.recordedSubmissions()
        XCTAssertEqual(recorded, [original])
    }

    func testConflictStopsAutomaticRetryAndPreservesDraft() async throws {
        let repository = MockConversationSubmissionRepository(submitOutcomes: [.conflict])
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: "Keep this as an unsent draft."
        )
        let original = try XCTUnwrap(result)

        XCTAssertEqual(coordinator.state, .conflict(original))
        let recovery = await coordinator.recoverUnknownAcknowledgement(currentTranscriptEpoch: 0)
        XCTAssertNil(recovery)
        let recorded = await repository.recordedSubmissions()
        XCTAssertEqual(recorded, [original])
    }

    func testExplicitNewSendAfterConflictGetsFreshSubmissionID() async throws {
        let repository = MockConversationSubmissionRepository(submitOutcomes: [.conflict, .accepted])
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 1,
            text: "Send only after the user explicitly chooses again."
        )
        let original = try XCTUnwrap(result)
        XCTAssertEqual(coordinator.state, .conflict(original))

        let newSubmission = try XCTUnwrap(
            coordinator.prepare(
                conversationID: conversationID,
                transcriptEpoch: 1,
                text: original.text
            )
        )
        XCTAssertNotEqual(newSubmission.clientSubmissionID, original.clientSubmissionID)
        XCTAssertEqual(newSubmission.transcriptEpoch, original.transcriptEpoch)
        await coordinator.dispatchPrepared()

        guard case .accepted(let accepted, _) = coordinator.state else {
            return XCTFail("Explicit new send should be independently accepted")
        }
        XCTAssertEqual(accepted, newSubmission)
    }

    func testUnavailableRetryUsesSameSubmissionIDAndEpoch() async throws {
        let repository = MockConversationSubmissionRepository(
            submitOutcomes: [.unavailable, .accepted]
        )
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 7,
            text: "Retry after backoff."
        )
        let original = try XCTUnwrap(result)

        XCTAssertEqual(coordinator.state, .retryableFailure(original))
        let retried = await coordinator.retryAfterUnavailable(currentTranscriptEpoch: 7)
        XCTAssertEqual(retried, original)

        guard case .accepted(let accepted, let receipt) = coordinator.state else {
            return XCTFail("Expected accepted after retry")
        }
        XCTAssertEqual(accepted, original)
        XCTAssertEqual(receipt.transcriptEpoch, 7)
        let recorded = await repository.recordedSubmissions()
        XCTAssertEqual(recorded, [original, original])
    }

    func testDuplicateBeginIsPreventedWhileSubmissionIsUnknown() async throws {
        let repository = MockConversationSubmissionRepository(
            submitOutcomes: [.unknownAcknowledgement(committed: false)]
        )
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: "First send."
        )
        let original = try XCTUnwrap(result)

        let duplicate = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: "Duplicate send."
        )

        XCTAssertNil(duplicate)
        XCTAssertEqual(coordinator.state, .unknownAcknowledgement(original))
        let recorded = await repository.recordedSubmissions()
        XCTAssertEqual(recorded, [original])
    }

    func testInvalidReceiptIsNotAccepted() async throws {
        let repository = MockConversationSubmissionRepository(submitOutcomes: [.invalidReceipt])
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: "Validate client submission identity."
        )
        let original = try XCTUnwrap(result)

        XCTAssertEqual(coordinator.state, .failed(original, .invalidReceipt))
    }

    func testReceiptFromDifferentTranscriptEpochIsNotAccepted() async throws {
        let repository = MockConversationSubmissionRepository(submitOutcomes: [.invalidEpochReceipt])
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 5,
            text: "Validate transcript epoch."
        )
        let original = try XCTUnwrap(result)

        XCTAssertEqual(coordinator.state, .failed(original, .invalidReceipt))
    }

    func testReceiptForDifferentConversationIsNotAccepted() async throws {
        let repository = MockConversationSubmissionRepository(
            submitOutcomes: [.invalidConversationReceipt]
        )
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: "Validate conversation identity."
        )
        let original = try XCTUnwrap(result)

        XCTAssertEqual(coordinator.state, .failed(original, .invalidReceipt))
    }

    func testEmptyTextOrNegativeEpochIsNotSubmitted() async {
        let repository = MockConversationSubmissionRepository()
        let coordinator = ConversationSubmissionCoordinator(repository: repository)

        let empty = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: " \n "
        )
        let negativeEpoch = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: -1,
            text: "Never invent an epoch."
        )

        XCTAssertNil(empty)
        XCTAssertNil(negativeEpoch)
        let recorded = await repository.recordedSubmissions()
        XCTAssertTrue(recorded.isEmpty)
    }

    func testTranscriptDeletionRetiresUnknownOutboxAndRequiresFreshID() async throws {
        let repository = MockConversationSubmissionRepository(
            submitOutcomes: [.unknownAcknowledgement(committed: false), .accepted]
        )
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: "This text was composed before chat clear."
        )
        let stale = try XCTUnwrap(result)

        coordinator.transcriptWasDeleted(currentEpoch: 1)

        XCTAssertEqual(
            coordinator.state,
            .discardedByTranscriptDeletion(stale, currentEpoch: 1)
        )
        let recovery = await coordinator.recoverUnknownAcknowledgement(currentTranscriptEpoch: 1)
        XCTAssertNil(recovery)

        let deliberate = try XCTUnwrap(
            coordinator.prepare(
                conversationID: conversationID,
                transcriptEpoch: 1,
                text: stale.text
            )
        )
        XCTAssertNotEqual(deliberate.clientSubmissionID, stale.clientSubmissionID)
        XCTAssertEqual(deliberate.transcriptEpoch, 1)
        await coordinator.dispatchPrepared()

        guard case .accepted(let accepted, _) = coordinator.state else {
            return XCTFail("A fresh user send at the new epoch should succeed")
        }
        XCTAssertEqual(accepted, deliberate)
    }

    func testLateReceiptCanResolveUnknownAcknowledgement() async throws {
        let repository = MockConversationSubmissionRepository(
            submitOutcomes: [.unknownAcknowledgement(committed: false)]
        )
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let result = await coordinator.begin(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: "Resolve through a late authoritative receipt."
        )
        let original = try XCTUnwrap(result)
        let receipt = ConversationSubmissionReceipt(
            clientSubmissionID: original.clientSubmissionID,
            conversationID: original.conversationID,
            messageID: MessageID(rawValue: UUID()),
            sequence: 19,
            turnID: AssistantTurnID(rawValue: UUID()),
            turnStatus: .running,
            transcriptEpoch: 0
        )

        coordinator.resolveAccepted(receipt)

        guard case .accepted(let accepted, let acceptedReceipt) = coordinator.state else {
            return XCTFail("Late receipt should resolve unknown acknowledgement")
        }
        XCTAssertEqual(accepted, original)
        XCTAssertEqual(acceptedReceipt, receipt)
    }

    func testLateResponseFromSupersededAttemptCannotOverwriteRecoveryRetry() async throws {
        let repository = DeferredConversationSubmissionRepository()
        let coordinator = ConversationSubmissionCoordinator(repository: repository)
        let firstAttempt = Task {
            await coordinator.begin(
                conversationID: conversationID,
                transcriptEpoch: 2,
                text: "Same immutable submission across attempts."
            )
        }

        await repository.waitForSubmissionCount(1)
        guard case .submitting(let original) = coordinator.state else {
            return XCTFail("Expected first attempt to be submitting")
        }

        coordinator.markUnknownAcknowledgement()
        let recovery = Task {
            await coordinator.recoverUnknownAcknowledgement(currentTranscriptEpoch: 2)
        }
        await repository.waitForSubmissionCount(2)

        await repository.resolve(index: 0)
        await Task.yield()
        XCTAssertEqual(coordinator.state, .submitting(original))

        await repository.resolve(index: 1)
        let firstResult = await firstAttempt.value
        let recoveryResult = await recovery.value
        XCTAssertEqual(firstResult, original)
        XCTAssertEqual(recoveryResult, original)
        guard case .accepted(let accepted, _) = coordinator.state else {
            return XCTFail("Latest attempt should own the accepted state")
        }
        XCTAssertEqual(accepted, original)
    }

    func testMockRepositoryRejectsReusingSubmissionIDWithDifferentText() async throws {
        let repository = MockConversationSubmissionRepository()
        let original = ConversationSubmission(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: "Original payload."
        )
        _ = try await repository.submit(original)
        let altered = ConversationSubmission(
            clientSubmissionID: original.clientSubmissionID,
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: "Different payload."
        )

        do {
            _ = try await repository.submit(altered)
            XCTFail("Same client submission ID with different text must conflict")
        } catch let error as ConversationSubmissionRepositoryError {
            XCTAssertEqual(error, .conflict)
        }
    }

    func testSubmissionDescriptionRedactsRawText() {
        let secret = "private conversation text"
        let submission = ConversationSubmission(
            conversationID: conversationID,
            transcriptEpoch: 0,
            text: secret
        )

        XCTAssertFalse(String(describing: submission).contains(secret))
        XCTAssertFalse(String(reflecting: submission).contains(secret))
    }
}

private actor DeferredConversationSubmissionRepository: ConversationSubmissionRepositoryProtocol {
    private var submissions: [ConversationSubmission] = []
    private var continuations: [CheckedContinuation<ConversationSubmissionReceipt, Error>] = []
    private var countWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var lookupIDs: [UUID] = []

    func submit(
        _ submission: ConversationSubmission
    ) async throws -> ConversationSubmissionReceipt {
        try await withCheckedThrowingContinuation { continuation in
            submissions.append(submission)
            continuations.append(continuation)
            let ready = countWaiters.filter { $0.0 <= submissions.count }
            countWaiters.removeAll { $0.0 <= submissions.count }
            ready.forEach { $0.1.resume() }
        }
    }

    func lookupSubmission(
        clientSubmissionID: UUID
    ) async throws -> ConversationSubmissionLookupResult {
        lookupIDs.append(clientSubmissionID)
        return .notFound
    }

    func waitForSubmissionCount(_ count: Int) async {
        if submissions.count >= count { return }
        await withCheckedContinuation { continuation in
            countWaiters.append((count, continuation))
        }
    }

    func resolve(index: Int) {
        let submission = submissions[index]
        continuations[index].resume(
            returning: ConversationSubmissionReceipt(
                clientSubmissionID: submission.clientSubmissionID,
                conversationID: submission.conversationID,
                messageID: MessageID(rawValue: UUID()),
                sequence: Int64(index + 1),
                turnID: AssistantTurnID(rawValue: UUID()),
                turnStatus: .running,
                transcriptEpoch: submission.transcriptEpoch
            )
        )
    }
}
