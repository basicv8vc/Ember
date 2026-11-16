import Foundation

/// The only durable source of client_submission_id and retry text. Never stored in UserDefaults/logs.
/// The journal is per installation and must be cleared when L1 logs out.
actor LiveConversationJournal {
    struct Pending: Codable, Sendable, Equatable {
        let clientSubmissionID: UUID
        let conversationID: UUID
        let transcriptEpoch: Int64
        let text: String
        let attachmentIDs: [UUID]

        init(
            clientSubmissionID: UUID,
            conversationID: UUID,
            transcriptEpoch: Int64,
            text: String,
            attachmentIDs: [UUID] = []
        ) {
            self.clientSubmissionID = clientSubmissionID
            self.conversationID = conversationID
            self.transcriptEpoch = transcriptEpoch
            self.text = text
            self.attachmentIDs = attachmentIDs
        }

        private enum CodingKeys: String, CodingKey {
            case clientSubmissionID
            case conversationID
            case transcriptEpoch
            case text
            case attachmentIDs
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            clientSubmissionID = try container.decode(UUID.self, forKey: .clientSubmissionID)
            conversationID = try container.decode(UUID.self, forKey: .conversationID)
            transcriptEpoch = try container.decode(Int64.self, forKey: .transcriptEpoch)
            text = try container.decode(String.self, forKey: .text)
            attachmentIDs = try container.decodeIfPresent([UUID].self, forKey: .attachmentIDs) ?? []
        }

        var submission: ConversationSubmission {
            ConversationSubmission(
                clientSubmissionID: clientSubmissionID,
                conversationID: ConversationID(rawValue: conversationID),
                transcriptEpoch: transcriptEpoch,
                text: text,
                attachmentIDs: attachmentIDs
            )
        }
    }

    struct Turn: Codable, Sendable, Equatable {
        let conversationID: UUID
        let transcriptEpoch: Int64
        let turnID: UUID
    }

    private struct State: Codable {
        var consumerID: UUID?
        var pending: Pending?
        var turn: Turn?
        /// A definitive HTTP 409 is terminal, never an unknown-ACK retry.
        /// Retain the original text as an explicit, non-replayable user draft.
        var rejected: Pending?
    }

    private let file: URL
    private var cached: State?

    init(directory: URL? = nil) {
        let base = directory ?? FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        )[0].appendingPathComponent("EmberConversation", isDirectory: true)
        file = base.appendingPathComponent("pending-send.json")
    }

    /// Binding is always to a server-issued consumer. Never move a pending send to another identity.
    func bind(consumerID: UUID) throws {
        var state = try read()
        if state.consumerID != nil && state.consumerID != consumerID {
            state = State(consumerID: consumerID, pending: nil, turn: nil, rejected: nil)
            try persist(state)
            return
        }
        if state.consumerID == nil {
            state.consumerID = consumerID
            try persist(state)
        }
    }

    func pending(for consumerID: UUID) throws -> Pending? {
        let state = try read()
        guard state.consumerID == consumerID else { return nil }
        return state.pending
    }

    func turn(for consumerID: UUID) throws -> Turn? {
        let state = try read()
        guard state.consumerID == consumerID else { return nil }
        return state.turn
    }

    /// Rejected drafts are not returned by pending(), even after relaunch.
    func rejectedDraft(for consumerID: UUID) throws -> Pending? {
        let state = try read()
        guard state.consumerID == consumerID else { return nil }
        return state.rejected
    }

    /// The write must complete before the first POST. If it fails, the network request is forbidden.
    func prepare(_ pending: Pending, consumerID: UUID) throws {
        var state = try read()
        guard state.consumerID == consumerID, state.pending == nil else {
            throw LiveB1Failure.unknownAcknowledgement
        }
        // A new prepare is a deliberate user action, not automatic recovery.
        state.rejected = nil
        state.pending = pending
        try persist(state)
    }

    /// Move an unequivocally rejected intent out of the recoverable outbox.
    /// This atomic transition makes a subsequent receipt 404 ineligible for POST replay.
    func markConflict(_ pending: Pending, consumerID: UUID) throws {
        var state = try read()
        guard state.consumerID == consumerID, state.pending == pending else {
            throw LiveB1Failure.storageUnavailable
        }
        state.rejected = pending
        state.pending = nil
        try persist(state)
    }

    /// Preserve the turn identity even if process death occurs after receiving the receipt.
    func accepted(_ receipt: LiveB1Receipt, for pending: Pending, consumerID: UUID) throws {
        var state = try read()
        guard state.consumerID == consumerID, state.pending == pending,
              receipt.clientSubmissionID == pending.clientSubmissionID,
              receipt.conversationID == pending.conversationID,
              Int64(receipt.transcriptEpoch) == pending.transcriptEpoch else {
            throw LiveB1Failure.invalidResponse
        }
        state.turn = Turn(conversationID: receipt.conversationID,
                          transcriptEpoch: pending.transcriptEpoch, turnID: receipt.turnID)
        state.pending = nil
        try persist(state)
    }

    func discardPending(consumerID: UUID) throws {
        var state = try read()
        guard state.consumerID == consumerID else { return }
        state.pending = nil
        try persist(state)
    }

    func clearTurn(consumerID: UUID, turnID: UUID) throws {
        var state = try read()
        guard state.consumerID == consumerID, state.turn?.turnID == turnID else { return }
        state.turn = nil
        try persist(state)
    }

    func reset() throws {
        // Preserve no conversation content or identity after explicit sign-out.
        try persist(State(consumerID: nil, pending: nil, turn: nil, rejected: nil))
    }

    private func read() throws -> State {
        if let cached { return cached }
        guard FileManager.default.fileExists(atPath: file.path) else {
            let empty = State(consumerID: nil, pending: nil, turn: nil, rejected: nil)
            cached = empty
            return empty
        }
        do {
            let state = try JSONDecoder().decode(State.self, from: Data(contentsOf: file))
            cached = state
            return state
        } catch {
            // Corrupt intent must not be silently regenerated with a new ID.
            throw LiveB1Failure.storageUnavailable
        }
    }

    private func persist(_ value: State) throws {
        do {
            let directory = file.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var metadata = URLResourceValues()
            metadata.isExcludedFromBackup = true
            var mutableDirectory = directory
            try mutableDirectory.setResourceValues(metadata)

            let data = try JSONEncoder().encode(value)
            // Atomic publication, protected at rest. If storage is unavailable, fail before sending.
            try data.write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
            try fsyncURL(file)
            try fsyncURL(directory)
            cached = value
        } catch {
            throw LiveB1Failure.storageUnavailable
        }
    }

    private func fsyncURL(_ url: URL) throws {
        let descriptor = open(url.path, O_RDONLY)
        guard descriptor >= 0 else { throw LiveB1Failure.storageUnavailable }
        defer { close(descriptor) }
        guard fsync(descriptor) == 0 else { throw LiveB1Failure.storageUnavailable }
    }
}
