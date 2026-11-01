import XCTest
@testable import Ember

@MainActor
final class TaskComposeSubmissionModelTests: XCTestCase {
    func testNormalSubmissionShowsAcceptedOnlyAfterReceiptAndKeepsQueuedStatus() async throws {
        let repository = try RecordingTaskRepository()
        let session = TaskJourneySession(repository: repository, includeFixtureRecords: false)
        let model = makeModel(keys: ["normal-key"])
        model.draft = "A short planning note."

        let attempt = try XCTUnwrap(model.beginSubmission(simulateUnknownReceipt: false))
        XCTAssertTrue(model.isSubmitting)
        await model.finishSubmission(attempt, in: session) { _ in }

        guard case let .accepted(receipt) = model.state else {
            return XCTFail("A valid receipt should move the composer to Accepted.")
        }
        XCTAssertFalse(receipt.replayed)
        XCTAssertEqual(receipt.status, .queued)
        XCTAssertEqual(session.records.count, 1)
        XCTAssertEqual(session.records.first?.task.status, .queued)
        XCTAssertTrue(model.draft.isEmpty)
    }

    func testUnknownAcknowledgementReplaysTheExactRequestAndKey() async throws {
        let repository = try RecordingTaskRepository()
        let session = TaskJourneySession(repository: repository, includeFixtureRecords: false)
        let model = makeModel(keys: ["original-key", "must-not-be-used"])
        let note = "Keep the original note unchanged."
        model.draft = note

        let first = try XCTUnwrap(model.beginSubmission(simulateUnknownReceipt: true))
        await model.finishSubmission(first, in: session) { _ in }

        guard case let .unknownAcknowledgement(frozenRequest) = model.state else {
            return XCTFail("The simulated lost receipt should remain explicitly unconfirmed.")
        }
        XCTAssertEqual(frozenRequest.content, note)
        XCTAssertEqual(frozenRequest.idempotencyKey, "original-key")
        XCTAssertEqual(model.draft, note)
        XCTAssertFalse(model.canEditDraft)
        XCTAssertTrue(model.statusMessage?.contains("尚未确认") == true)
        XCTAssertTrue(session.records.isEmpty)

        let retry = try XCTUnwrap(model.beginSubmission(simulateUnknownReceipt: true))
        XCTAssertEqual(retry.request, frozenRequest)
        XCTAssertFalse(retry.simulateUnknownReceipt)
        await model.finishSubmission(retry, in: session) { _ in }

        guard case let .accepted(receipt) = model.state else {
            return XCTFail("A replayed receipt should resolve the unknown acknowledgement.")
        }
        XCTAssertTrue(receipt.replayed)
        XCTAssertEqual(session.records.map(\.id), [receipt.taskID])
        let attempts = await repository.recordedAttempts()
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(attempts.map(\.idempotencyKey), ["original-key", "original-key"])
        if attempts.count == 2 {
            XCTAssertEqual(attempts[1].prompt, attempts[0].prompt)
        }
    }

    func testDefiniteIdempotencyConflictKeepsDraftEditableAndUsesFreshKey() async throws {
        let repository = try RecordingTaskRepository(firstFailure: .idempotencyConflict)
        let session = TaskJourneySession(repository: repository, includeFixtureRecords: false)
        let model = makeModel(keys: ["conflicting-key", "recovery-key"])
        let originalNote = "The rejected draft stays in the editor."
        model.draft = originalNote

        let first = try XCTUnwrap(model.beginSubmission(simulateUnknownReceipt: false))
        await model.finishSubmission(first, in: session) { _ in }

        XCTAssertEqual(model.state, .definiteFailure(.idempotencyConflict))
        XCTAssertEqual(model.draft, originalNote)
        XCTAssertTrue(model.canEditDraft)
        XCTAssertFalse(model.isAwaitingReceipt)
        XCTAssertTrue(model.statusMessage?.contains("尚未确认") == false)
        XCTAssertFalse(model.statusMessage?.contains(originalNote) == true)

        let editedNote = "The user revised this note before retrying."
        model.draft = editedNote
        let recovery = try XCTUnwrap(model.beginSubmission(simulateUnknownReceipt: false))
        XCTAssertEqual(recovery.request.content, editedNote)
        XCTAssertEqual(recovery.request.idempotencyKey, "recovery-key")
        await model.finishSubmission(recovery, in: session) { _ in }

        guard case .accepted = model.state else {
            return XCTFail("The edited draft should be recoverable with a new idempotency key.")
        }
        let attempts = await repository.recordedAttempts()
        XCTAssertEqual(attempts.map(\.idempotencyKey), ["conflicting-key", "recovery-key"])
        if attempts.count == 2 {
            XCTAssertTrue(attempts[1].prompt.hasSuffix(editedNote))
        }
        XCTAssertEqual(session.records.count, 1)
    }

    func testSecondSubmitWhileSubmittingCannotCreateDuplicateTask() async throws {
        let repository = try RecordingTaskRepository()
        let session = TaskJourneySession(repository: repository, includeFixtureRecords: false)
        let model = makeModel(keys: ["single-task-key", "unused-key"])
        model.draft = "One intended task."

        let first = try XCTUnwrap(model.beginSubmission(simulateUnknownReceipt: false))
        XCTAssertNil(model.beginSubmission(simulateUnknownReceipt: false))

        var receiptCallbacks = 0
        await model.finishSubmission(first, in: session) { _ in receiptCallbacks += 1 }
        await model.finishSubmission(first, in: session) { _ in receiptCallbacks += 1 }

        let attempts = await repository.recordedAttempts()
        XCTAssertEqual(attempts.count, 1)
        XCTAssertEqual(session.records.count, 1)
        XCTAssertEqual(receiptCallbacks, 1)
        guard case let .accepted(receipt) = model.state else {
            return XCTFail("The completed submission should retain its accepted receipt.")
        }
        XCTAssertEqual(receipt.taskID, session.records.first?.id)
    }

    func testValidReceiptRemainsAcceptedWhenFollowUpSnapshotReadFails() async throws {
        let repository = try RecordingTaskRepository(failFetchAfterCreate: true)
        let session = TaskJourneySession(repository: repository, includeFixtureRecords: false)
        let model = makeModel(keys: ["accepted-receipt-key"])
        model.draft = "The create receipt is authoritative."

        let attempt = try XCTUnwrap(model.beginSubmission(simulateUnknownReceipt: false))
        await model.finishSubmission(attempt, in: session) { _ in }

        guard case let .accepted(receipt) = model.state else {
            return XCTFail("A valid create receipt must not become a definite submission failure.")
        }
        XCTAssertFalse(receipt.replayed)
        XCTAssertEqual(receipt.status, .queued)
        XCTAssertTrue(session.records.isEmpty)
        XCTAssertTrue(model.draft.isEmpty)
        XCTAssertNil(model.beginSubmission(simulateUnknownReceipt: false))
    }

    func testDefiniteRepositoryFailurePreservesDraftWithoutEchoingErrorText() async throws {
        let repository = try RecordingTaskRepository(firstFailure: .echoNote("do-not-log-this-note"))
        let session = TaskJourneySession(repository: repository, includeFixtureRecords: false)
        let model = makeModel(keys: ["failed-key"])
        let note = "do-not-log-this-note"
        model.draft = note

        let attempt = try XCTUnwrap(model.beginSubmission(simulateUnknownReceipt: false))
        await model.finishSubmission(attempt, in: session) { _ in }

        XCTAssertEqual(model.state, .definiteFailure(.rejected))
        XCTAssertEqual(model.draft, note)
        XCTAssertTrue(model.canEditDraft)
        XCTAssertFalse(model.isAwaitingReceipt)
        XCTAssertFalse(model.statusMessage?.contains(note) == true)
    }

    private func makeModel(keys: [String]) -> TaskComposeSubmissionModel {
        var remainingKeys = keys
        return TaskComposeSubmissionModel {
            guard !remainingKeys.isEmpty else {
                XCTFail("Unexpected idempotency-key allocation.")
                return "unexpected-key"
            }
            return remainingKeys.removeFirst()
        }
    }
}

private enum PlannedRepositoryFailure: Sendable {
    case idempotencyConflict
    case echoNote(String)
}

private struct NoteEchoFailure: Error, LocalizedError, Sendable {
    let note: String

    var errorDescription: String? {
        "Repository rejected request containing: \(note)"
    }
}

private struct RecordedCreateAttempt: Sendable {
    let idempotencyKey: String
    let prompt: String
}

private actor RecordingTaskRepository: TaskRepositoryProtocol {
    private let base: FakeTaskRepository
    private var firstFailure: PlannedRepositoryFailure?
    private let failFetchAfterCreate: Bool
    private var attempts: [RecordedCreateAttempt] = []

    init(
        firstFailure: PlannedRepositoryFailure? = nil,
        failFetchAfterCreate: Bool = false
    ) throws {
        self.base = try FakeTaskRepository()
        self.firstFailure = firstFailure
        self.failFetchAfterCreate = failFetchAfterCreate
    }

    func createTask(
        _ request: CreateTaskRequestDTO,
        idempotencyKey: String
    ) async throws -> TaskReceiptDTO {
        let prompt: String
        if case let .chat(_, value, _, _) = request {
            prompt = value
        } else {
            prompt = ""
        }
        attempts.append(RecordedCreateAttempt(idempotencyKey: idempotencyKey, prompt: prompt))

        if let failure = firstFailure {
            firstFailure = nil
            switch failure {
            case .idempotencyConflict:
                throw FakeTaskRepositoryError.idempotencyConflict
            case let .echoNote(note):
                throw NoteEchoFailure(note: note)
            }
        }
        return try await base.createTask(request, idempotencyKey: idempotencyKey)
    }

    func fetchTask(id: UUID) async throws -> TaskDTO {
        if failFetchAfterCreate {
            throw FakeTaskRepositoryError.taskNotFound
        }
        return try await base.fetchTask(id: id)
    }

    func fetchEvents(taskID: UUID, after sequence: Int?) async throws -> TaskEventPageDTO {
        try await base.fetchEvents(taskID: taskID, after: sequence)
    }

    func cancelTask(id: UUID) async throws -> TaskCancelDTO {
        try await base.cancelTask(id: id)
    }

    func recordedAttempts() -> [RecordedCreateAttempt] {
        attempts
    }
}
