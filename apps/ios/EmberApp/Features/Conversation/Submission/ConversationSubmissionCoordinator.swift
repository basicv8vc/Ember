import Foundation

/// One immutable user-message intent. clientSubmissionID is the B1 deduplication key;
/// transcriptEpoch fences sends composed before a transcript deletion.
public struct ConversationSubmission: Equatable, Sendable, Identifiable, CustomStringConvertible, CustomDebugStringConvertible {
    public let clientSubmissionID: UUID
    public let conversationID: ConversationID
    public let transcriptEpoch: Int64
    public let text: String

    public var id: UUID { clientSubmissionID }

    public init(
        clientSubmissionID: UUID = UUID(),
        conversationID: ConversationID,
        transcriptEpoch: Int64,
        text: String
    ) {
        self.clientSubmissionID = clientSubmissionID
        self.conversationID = conversationID
        self.transcriptEpoch = transcriptEpoch
        self.text = text
    }

    public var description: String {
        "ConversationSubmission(clientSubmissionID: \(clientSubmissionID), conversationID: \(conversationID.rawValue), transcriptEpoch: \(transcriptEpoch), text: <redacted>)"
    }

    public var debugDescription: String {
        description
    }
}

/// B1 turn status is deliberately separate from TaskStatus.
public enum ConversationSubmissionTurnStatus: String, Equatable, Sendable {
    case running
    case completed
    case failed
    case cancelled
}

/// The server receipt returned by POST messages or the unknown-ACK lookup route.
public struct ConversationSubmissionReceipt: Equatable, Sendable {
    public let clientSubmissionID: UUID
    public let conversationID: ConversationID
    public let messageID: MessageID
    public let sequence: Int64
    public let turnID: AssistantTurnID
    public let turnStatus: ConversationSubmissionTurnStatus
    public let transcriptEpoch: Int64

    public init(
        clientSubmissionID: UUID,
        conversationID: ConversationID,
        messageID: MessageID,
        sequence: Int64,
        turnID: AssistantTurnID,
        turnStatus: ConversationSubmissionTurnStatus,
        transcriptEpoch: Int64
    ) {
        self.clientSubmissionID = clientSubmissionID
        self.conversationID = conversationID
        self.messageID = messageID
        self.sequence = sequence
        self.turnID = turnID
        self.turnStatus = turnStatus
        self.transcriptEpoch = transcriptEpoch
    }
}

public enum ConversationSubmissionLookupResult: Equatable, Sendable {
    case found(ConversationSubmissionReceipt)
    case notFound
}

public enum ConversationSubmissionFailure: Equatable, Sendable {
    case rejected
    case invalidReceipt
}

public enum ConversationSubmissionState: Equatable, Sendable {
    case idle
    case prepared(ConversationSubmission)
    case submitting(ConversationSubmission)
    case unknownAcknowledgement(ConversationSubmission)
    case reconciling(ConversationSubmission)
    case retryableFailure(ConversationSubmission)
    case accepted(ConversationSubmission, ConversationSubmissionReceipt)
    /// A 409 is terminal for this intent: retain it as an unsent draft; never auto-mint a new ID.
    case conflict(ConversationSubmission)
    case failed(ConversationSubmission, ConversationSubmissionFailure)
    case cancelledBeforeDispatch(ConversationSubmission)
    case discardedByTranscriptDeletion(ConversationSubmission, currentEpoch: Int64)
}

/// Contract-aligned state machine for the B1 message submission lifecycle.
///
/// This is an in-memory coordinator and mock seam only. It performs no HTTP, disk persistence,
/// Keychain access, or real service calls. A future live adapter must implement the B1 routes.
@MainActor
public final class ConversationSubmissionCoordinator {
    public private(set) var state: ConversationSubmissionState = .idle

    private let repository: any ConversationSubmissionRepositoryProtocol
    private var activeAttemptID: UUID?

    public init(repository: any ConversationSubmissionRepositoryProtocol) {
        self.repository = repository
    }

    /// Prepares a fresh user intent. Calling this after a conflict represents an explicit
    /// user-initiated new send and therefore mints a new clientSubmissionID.
    @discardableResult
    public func prepare(
        conversationID: ConversationID,
        transcriptEpoch: Int64,
        text: String
    ) -> ConversationSubmission? {
        switch state {
        case .prepared, .submitting, .unknownAcknowledgement, .reconciling, .retryableFailure:
            return nil
        case .idle, .accepted, .conflict, .failed,
             .cancelledBeforeDispatch, .discardedByTranscriptDeletion:
            guard transcriptEpoch >= 0,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.trimmingCharacters(in: .whitespacesAndNewlines).count <= 4096 else {
                return nil
            }
            let submission = ConversationSubmission(
                conversationID: conversationID,
                transcriptEpoch: transcriptEpoch,
                text: text
            )
            state = .prepared(submission)
            return submission
        }
    }

    /// Dispatches the currently prepared intent exactly once.
    public func dispatchPrepared() async {
        guard case .prepared(let submission) = state else { return }
        state = .submitting(submission)
        await dispatch(submission)
    }

    /// Convenience for callers that do not need a separate prepare/cancel phase.
    @discardableResult
    public func begin(
        conversationID: ConversationID,
        transcriptEpoch: Int64,
        text: String
    ) async -> ConversationSubmission? {
        guard let submission = prepare(
            conversationID: conversationID,
            transcriptEpoch: transcriptEpoch,
            text: text
        ) else {
            return nil
        }
        await dispatchPrepared()
        return submission
    }

    /// N-3 recovery: look up the existing clientSubmissionID first. A 200 adopts the original
    /// receipt; a 404 retries POST with the exact same ID, text and transcript epoch.
    @discardableResult
    public func recoverUnknownAcknowledgement(
        currentTranscriptEpoch: Int64
    ) async -> ConversationSubmission? {
        guard case .unknownAcknowledgement(let submission) = state else { return nil }
        guard prepareRecoveryForCurrentEpoch(submission, currentEpoch: currentTranscriptEpoch) else {
            return nil
        }

        let attemptID = UUID()
        activeAttemptID = attemptID
        state = .reconciling(submission)

        do {
            let result = try await repository.lookupSubmission(
                clientSubmissionID: submission.clientSubmissionID
            )
            guard activeAttemptID == attemptID,
                  case .reconciling(let current) = state,
                  current.clientSubmissionID == submission.clientSubmissionID else {
                return nil
            }

            switch result {
            case .found(let receipt):
                activeAttemptID = nil
                accept(receipt, for: submission)
            case .notFound:
                activeAttemptID = nil
                state = .submitting(submission)
                await dispatch(submission)
            }
            return submission
        } catch ConversationSubmissionRepositoryError.unavailable {
            guard activeAttemptID == attemptID else { return nil }
            activeAttemptID = nil
            state = .unknownAcknowledgement(submission)
            return nil
        } catch ConversationSubmissionRepositoryError.conflict {
            guard activeAttemptID == attemptID else { return nil }
            activeAttemptID = nil
            state = .conflict(submission)
            return nil
        } catch {
            guard activeAttemptID == attemptID else { return nil }
            activeAttemptID = nil
            state = .unknownAcknowledgement(submission)
            return nil
        }
    }

    /// Retries a definitive 503/5xx-style unavailable response. The caller owns backoff;
    /// the coordinator always reuses the same immutable submission and epoch.
    @discardableResult
    public func retryAfterUnavailable(
        currentTranscriptEpoch: Int64
    ) async -> ConversationSubmission? {
        guard case .retryableFailure(let submission) = state else { return nil }
        guard prepareRecoveryForCurrentEpoch(submission, currentEpoch: currentTranscriptEpoch) else {
            return nil
        }
        state = .submitting(submission)
        await dispatch(submission)
        return submission
    }

    /// Called when the POST acknowledgement deadline expires while its result is ambiguous.
    /// The old attempt is retired; a later response from it cannot overwrite reconciliation.
    public func markUnknownAcknowledgement() {
        guard case .submitting(let submission) = state else { return }
        activeAttemptID = nil
        state = .unknownAcknowledgement(submission)
    }

    /// Applies an authoritative receipt received through a separate reconciliation path.
    public func resolveAccepted(_ receipt: ConversationSubmissionReceipt) {
        switch state {
        case .submitting(let submission), .unknownAcknowledgement(let submission),
             .reconciling(let submission):
            // A delayed reconciliation result for a prior intent must not invalidate or
            // retire the active attempt for a newer submission.
            guard receipt.clientSubmissionID == submission.clientSubmissionID else { return }
            activeAttemptID = nil
            accept(receipt, for: submission)
        case .prepared, .idle, .retryableFailure, .accepted, .conflict, .failed,
             .cancelledBeforeDispatch, .discardedByTranscriptDeletion:
            return
        }
    }

    /// A transcript deletion invalidates all pending/in-flight sends from the previous epoch.
    /// Their text may remain in the composer as an unsent draft, but this outbox entry is retired.
    public func transcriptWasDeleted(currentEpoch: Int64) {
        guard currentEpoch >= 0 else { return }

        let pending: ConversationSubmission
        switch state {
        case .prepared(let submission), .submitting(let submission),
             .unknownAcknowledgement(let submission), .reconciling(let submission),
             .retryableFailure(let submission):
            pending = submission
        case .idle, .accepted, .conflict, .failed, .cancelledBeforeDispatch,
             .discardedByTranscriptDeletion:
            return
        }

        guard currentEpoch > pending.transcriptEpoch else { return }
        activeAttemptID = nil
        state = .discardedByTranscriptDeletion(pending, currentEpoch: currentEpoch)
    }

    /// Cancellation is definitive only before repository dispatch.
    public func cancelBeforeDispatch() {
        guard case .prepared(let submission) = state else { return }
        state = .cancelledBeforeDispatch(submission)
    }

    private func dispatch(_ submission: ConversationSubmission) async {
        let attemptID = UUID()
        activeAttemptID = attemptID

        do {
            let receipt = try await repository.submit(submission)
            guard activeAttemptID == attemptID,
                  case .submitting(let current) = state,
                  current.clientSubmissionID == submission.clientSubmissionID else {
                return
            }
            activeAttemptID = nil
            accept(receipt, for: submission)
        } catch ConversationSubmissionRepositoryError.unknownAcknowledgement {
            guard activeAttemptID == attemptID else { return }
            activeAttemptID = nil
            state = .unknownAcknowledgement(submission)
        } catch ConversationSubmissionRepositoryError.conflict {
            guard activeAttemptID == attemptID else { return }
            activeAttemptID = nil
            state = .conflict(submission)
        } catch ConversationSubmissionRepositoryError.unavailable {
            guard activeAttemptID == attemptID else { return }
            activeAttemptID = nil
            state = .retryableFailure(submission)
        } catch ConversationSubmissionRepositoryError.rejected {
            guard activeAttemptID == attemptID else { return }
            activeAttemptID = nil
            state = .failed(submission, .rejected)
        } catch {
            // A transport failure is ambiguous: reconcile by clientSubmissionID before retrying.
            guard activeAttemptID == attemptID else { return }
            activeAttemptID = nil
            state = .unknownAcknowledgement(submission)
        }
    }

    private func prepareRecoveryForCurrentEpoch(
        _ submission: ConversationSubmission,
        currentEpoch: Int64
    ) -> Bool {
        guard currentEpoch >= 0 else { return false }
        if currentEpoch > submission.transcriptEpoch {
            activeAttemptID = nil
            state = .discardedByTranscriptDeletion(
                submission,
                currentEpoch: currentEpoch
            )
            return false
        }
        if currentEpoch < submission.transcriptEpoch {
            activeAttemptID = nil
            state = .conflict(submission)
            return false
        }
        return true
    }

    private func accept(
        _ receipt: ConversationSubmissionReceipt,
        for submission: ConversationSubmission
    ) {
        guard receipt.clientSubmissionID == submission.clientSubmissionID,
              receipt.conversationID == submission.conversationID,
              receipt.transcriptEpoch == submission.transcriptEpoch,
              receipt.sequence > 0 else {
            state = .failed(submission, .invalidReceipt)
            return
        }
        state = .accepted(submission, receipt)
    }
}

public enum ConversationSubmissionRepositoryError: Error, Equatable, Sendable {
    /// The server may have committed the request, but the client did not receive its receipt.
    case unknownAcknowledgement
    /// Existing B1 409 IDEMPOTENCY_CONFLICT; this intent must not be auto-resubmitted.
    case conflict
    /// B1 503/5xx-style retryable service unavailability.
    case unavailable
    /// A definitive non-retryable request/auth/resource failure.
    case rejected
}

public protocol ConversationSubmissionRepositoryProtocol: Sendable {
    func submit(_ submission: ConversationSubmission) async throws -> ConversationSubmissionReceipt
    func lookupSubmission(
        clientSubmissionID: UUID
    ) async throws -> ConversationSubmissionLookupResult
}

/// In-memory repository for deterministic previews and unit tests only.
public actor MockConversationSubmissionRepository: ConversationSubmissionRepositoryProtocol {
    public enum SubmitOutcome: Sendable {
        case accepted
        case unknownAcknowledgement(committed: Bool)
        case conflict
        case unavailable
        case rejected
        case invalidReceipt
        case invalidEpochReceipt
        case invalidConversationReceipt
    }

    public enum LookupOutcome: Sendable {
        case notFound
        case unavailable
    }

    private var submitOutcomes: [SubmitOutcome]
    private var lookupOutcomes: [LookupOutcome]
    private var submissions: [ConversationSubmission] = []
    private var committedSubmissions: [UUID: ConversationSubmission] = [:]
    private var lookupIDs: [UUID] = []
    private var receipts: [UUID: ConversationSubmissionReceipt] = [:]
    private var nextSequence: Int64 = 1

    public init(
        submitOutcomes: [SubmitOutcome] = [.accepted],
        lookupOutcomes: [LookupOutcome] = []
    ) {
        self.submitOutcomes = submitOutcomes
        self.lookupOutcomes = lookupOutcomes
    }

    public func submit(
        _ submission: ConversationSubmission
    ) async throws -> ConversationSubmissionReceipt {
        submissions.append(submission)

        if let committed = committedSubmissions[submission.clientSubmissionID] {
            guard committed == submission,
                  let existing = receipts[submission.clientSubmissionID] else {
                throw ConversationSubmissionRepositoryError.conflict
            }
            return existing
        }

        let outcome = submitOutcomes.isEmpty ? .accepted : submitOutcomes.removeFirst()
        switch outcome {
        case .accepted:
            let receipt = makeReceipt(for: submission)
            committedSubmissions[submission.clientSubmissionID] = submission
            receipts[submission.clientSubmissionID] = receipt
            return receipt
        case .unknownAcknowledgement(let committed):
            if committed {
                committedSubmissions[submission.clientSubmissionID] = submission
                receipts[submission.clientSubmissionID] = makeReceipt(for: submission)
            }
            throw ConversationSubmissionRepositoryError.unknownAcknowledgement
        case .conflict:
            throw ConversationSubmissionRepositoryError.conflict
        case .unavailable:
            throw ConversationSubmissionRepositoryError.unavailable
        case .rejected:
            throw ConversationSubmissionRepositoryError.rejected
        case .invalidReceipt:
            return ConversationSubmissionReceipt(
                clientSubmissionID: UUID(),
                conversationID: ConversationID(rawValue: UUID()),
                messageID: MessageID(rawValue: UUID()),
                sequence: nextSequence,
                turnID: AssistantTurnID(rawValue: UUID()),
                turnStatus: .running,
                transcriptEpoch: submission.transcriptEpoch
            )
        case .invalidEpochReceipt:
            return ConversationSubmissionReceipt(
                clientSubmissionID: submission.clientSubmissionID,
                conversationID: submission.conversationID,
                messageID: MessageID(rawValue: UUID()),
                sequence: nextSequence,
                turnID: AssistantTurnID(rawValue: UUID()),
                turnStatus: .running,
                transcriptEpoch: submission.transcriptEpoch + 1
            )
        case .invalidConversationReceipt:
            return ConversationSubmissionReceipt(
                clientSubmissionID: submission.clientSubmissionID,
                conversationID: ConversationID(rawValue: UUID()),
                messageID: MessageID(rawValue: UUID()),
                sequence: nextSequence,
                turnID: AssistantTurnID(rawValue: UUID()),
                turnStatus: .running,
                transcriptEpoch: submission.transcriptEpoch
            )
        }
    }

    public func lookupSubmission(
        clientSubmissionID: UUID
    ) async throws -> ConversationSubmissionLookupResult {
        lookupIDs.append(clientSubmissionID)

        if let receipt = receipts[clientSubmissionID] {
            return .found(receipt)
        }

        let outcome = lookupOutcomes.isEmpty ? .notFound : lookupOutcomes.removeFirst()
        switch outcome {
        case .notFound:
            return .notFound
        case .unavailable:
            throw ConversationSubmissionRepositoryError.unavailable
        }
    }

    public func recordedSubmissions() -> [ConversationSubmission] {
        submissions
    }

    public func recordedLookupIDs() -> [UUID] {
        lookupIDs
    }

    public func setNextSequence(_ sequence: Int64) {
        guard sequence > 0 else { return }
        nextSequence = max(nextSequence, sequence)
    }

    private func makeReceipt(
        for submission: ConversationSubmission
    ) -> ConversationSubmissionReceipt {
        defer { nextSequence += 1 }
        return ConversationSubmissionReceipt(
            clientSubmissionID: submission.clientSubmissionID,
            conversationID: submission.conversationID,
            messageID: MessageID(rawValue: UUID()),
            sequence: nextSequence,
            turnID: AssistantTurnID(rawValue: UUID()),
            turnStatus: .running,
            transcriptEpoch: submission.transcriptEpoch
        )
    }
}
