import Foundation

/// Server-backed conversation; Mock repository is deliberately not used anywhere in this path.
/// All send recovery is based on the original durable submission id and server-authoritative epoch.
actor LiveConversationRepository {
    private let client: LiveB1ConversationClient
    private let journal: LiveConversationJournal
    private let now: @Sendable () -> Date

    private var profile: EmberMeDTO?
    private var nextTurnPoll: [UUID: Date] = [:]

    init(client: LiveB1ConversationClient,
         journal: LiveConversationJournal,
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.journal = journal
        self.now = now
    }

    func bootstrap() async throws -> EmberMeDTO {
        let result = try await client.bootstrap()
        try await journal.bind(consumerID: result.consumerID)
        profile = result
        return result
    }

    func load() async throws -> ConversationSnapshot {
        let me = try await ensureProfile()
        let id = ConversationID(rawValue: me.conversation.conversationID)
        var all: [LiveB1Message] = []
        var after = 0
        var pages = 0
        while true {
            let page = try await client.page(conversationID: id.rawValue, after: after, limit: 100)
            guard page.transcriptEpoch == me.conversation.transcriptEpoch,
                  page.nextAfter >= after,
                  page.messages.first.map({ $0.sequence > after }) ?? true else {
                throw LiveB1Failure.staleEpoch
            }
            all.append(contentsOf: page.messages)
            pages += 1
            if !page.hasMore { break }
            guard !page.messages.isEmpty, pages < 200 else {
                throw LiveB1Failure.invalidResponse
            }
            after = page.nextAfter
        }
        let conversation = Conversation(id: id,
            createdAt: me.conversation.createdAt, updatedAt: me.conversation.updatedAt)
        return ConversationSnapshot(
            conversation: conversation,
            messages: all.map { $0.domainMessage(conversationID: id) },
            assistantTurns: [])
    }

    /// On every launch, reconcile an unresolved durable intent before enabling a new send.
    func recoverAfterRelaunch() async throws -> ConversationSnapshot {
        _ = try await bootstrap()
        if try await pending() != nil {
            _ = try await reconcilePending()
        }
        if try await activeTurn() != nil {
            _ = try await pollActiveTurn()
        }
        return try await load()
    }

    func pending() async throws -> LiveConversationJournal.Pending? {
        let me = try await ensureProfile()
        return try await journal.pending(for: me.consumerID)
    }

    func activeTurn() async throws -> LiveConversationJournal.Turn? {
        let me = try await ensureProfile()
        return try await journal.turn(for: me.consumerID)
    }

    /// A terminal 409 is retained solely for explicit user draft restoration.
    func rejectedDraft() async throws -> LiveConversationJournal.Pending? {
        let me = try await ensureProfile()
        return try await journal.rejectedDraft(for: me.consumerID)
    }

    /// A fresh UUIDv4 is created once, persisted with its exact body and epoch, then sent.
    func send(text: String) async throws -> LiveB1Receipt {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized.count <= 4096 else {
            throw LiveB1Failure.rejected
        }
        let me = try await ensureProfile()
        guard try await journal.pending(for: me.consumerID) == nil else {
            throw LiveB1Failure.unknownAcknowledgement
        }
        let pending = LiveConversationJournal.Pending(
            clientSubmissionID: UUID(),
            conversationID: me.conversation.conversationID,
            transcriptEpoch: Int64(me.conversation.transcriptEpoch),
            text: normalized)
        try await journal.prepare(pending, consumerID: me.consumerID)
        return try await dispatch(pending, consumerID: me.consumerID)
    }

    /// N-3: lookup first. An authoritative 404 permits replaying the *same* immutable intent.
    /// A lookup transport error never licenses a new POST or a new id.
    func reconcilePending() async throws -> LiveB1Receipt? {
        let me = try await bootstrap()
        guard let pending = try await journal.pending(for: me.consumerID) else { return nil }
        guard pending.conversationID == me.conversation.conversationID,
              pending.transcriptEpoch == Int64(me.conversation.transcriptEpoch) else {
            try await journal.discardPending(consumerID: me.consumerID)
            throw LiveB1Failure.staleEpoch
        }
        let found: LiveB1Receipt?
        do {
            found = try await client.lookup(pending.clientSubmissionID)
        } catch {
            // A failed lookup is still ambiguous; do not issue a POST.
            throw LiveB1Failure.unknownAcknowledgement
        }
        // Only an authoritative 404 permits replay. Preserve a 409 from that POST as a
        // terminal conflict, never mask it as an unknown lookup result.
        guard let receipt = found else {
            return try await dispatch(pending, consumerID: me.consumerID)
        }
        try validate(receipt, for: pending)
        try await journal.accepted(receipt, for: pending, consumerID: me.consumerID)
        return receipt
    }

    /// Serialized by this actor. A reserved slot is at least one second after the previous
    /// slot for the same Conversation, even when callers are waiting concurrently.
    func pollActiveTurn() async throws -> LiveB1Turn? {
        let me = try await ensureProfile()
        guard let active = try await journal.turn(for: me.consumerID) else { return nil }
        guard active.conversationID == me.conversation.conversationID,
              active.transcriptEpoch == Int64(me.conversation.transcriptEpoch) else {
            try await journal.clearTurn(consumerID: me.consumerID, turnID: active.turnID)
            throw LiveB1Failure.staleEpoch
        }
        let currentTime = now()
        let slot = max(currentTime, nextTurnPoll[active.conversationID] ?? currentTime)
        nextTurnPoll[active.conversationID] = slot.addingTimeInterval(1)
        let delay = slot.timeIntervalSince(currentTime)
        if delay > 0 { try await Task.sleep(for: .seconds(delay)) }

        let turn = try await client.turn(conversationID: active.conversationID, turnID: active.turnID)
        if turn.status != .running {
            try await journal.clearTurn(consumerID: me.consumerID, turnID: active.turnID)
        }
        return turn
    }

    func cancelActiveTurn() async throws -> LiveB1Turn? {
        let me = try await ensureProfile()
        guard let active = try await journal.turn(for: me.consumerID) else { return nil }
        let turn = try await client.cancel(conversationID: active.conversationID, turnID: active.turnID)
        if turn.status != .running {
            try await journal.clearTurn(consumerID: me.consumerID, turnID: active.turnID)
        }
        return turn
    }

    func clearOnLogout() async {
        try? await journal.reset()
        profile = nil
        nextTurnPoll.removeAll()
    }

    private func ensureProfile() async throws -> EmberMeDTO {
        if let profile { return profile }
        return try await bootstrap()
    }

    private func dispatch(_ pending: LiveConversationJournal.Pending, consumerID: UUID) async throws -> LiveB1Receipt {
        do {
            let receipt = try await client.send(pending.submission)
            try validate(receipt, for: pending)
            try await journal.accepted(receipt, for: pending, consumerID: consumerID)
            return receipt
        } catch let error as LiveB1Failure where error == .conflict {
            // A known 409 is terminal (N-4/TE-3), NOT an unknown ACK: persist it
            // outside pending so relaunch cannot query 404 and resend this intent.
            try await journal.markConflict(pending, consumerID: consumerID)
            throw LiveB1Failure.conflict
        } catch let error as LiveB1Failure where error == .invalidResponse {
            // A malformed 2xx is ambiguous, even if we cannot adopt its body.
            throw LiveB1Failure.unknownAcknowledgement
        } catch {
            // Includes L1 unknownWriteOutcome, timeout, offline, 5xx and revoked credentials.
            // Do not lose the durable intent and do not resend blindly.
            throw LiveB1Failure.unknownAcknowledgement
        }
    }

    private func validate(_ receipt: LiveB1Receipt,
                          for pending: LiveConversationJournal.Pending) throws {
        guard receipt.clientSubmissionID == pending.clientSubmissionID,
              receipt.conversationID == pending.conversationID,
              Int64(receipt.transcriptEpoch) == pending.transcriptEpoch,
              receipt.text == pending.text else {
            throw LiveB1Failure.invalidResponse
        }
    }
}
