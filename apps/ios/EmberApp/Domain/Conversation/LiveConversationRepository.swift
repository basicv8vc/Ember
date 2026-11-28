import Foundation

/// Server-backed conversation; Mock repository is deliberately not used anywhere in this path.
/// All send recovery is based on the original durable submission id and server-authoritative epoch.
actor LiveConversationRepository {
    private let client: LiveB1ConversationClient
    private let journal: LiveConversationJournal
    private let supportsStreaming: Bool
    private let now: @Sendable () -> Date

    private struct WebEvidenceCacheState {
        let conversationID: UUID
        let transcriptEpoch: Int
        var scannedThroughSequence: Int
        var hasConfirmedEndpoint: Bool
        var evidenceByMessageID: [MessageID: WebEvidence]
    }

    private var profile: EmberMeDTO?
    private var nextTurnPoll: [UUID: Date] = [:]
    private var webEvidenceCache: WebEvidenceCacheState?

    init(client: LiveB1ConversationClient,
         journal: LiveConversationJournal,
         supportsStreaming: Bool = false,
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.journal = journal
        self.supportsStreaming = supportsStreaming
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
        let highestSequence = all.map(\.sequence).max() ?? 0
        let webEvidenceByMessageID = if all.isEmpty {
            resetWebEvidenceCache(conversationID: id.rawValue, expectedEpoch: me.conversation.transcriptEpoch)
        } else {
            await loadWebEvidence(
                conversationID: id.rawValue,
                expectedEpoch: me.conversation.transcriptEpoch,
                highestMessageSequence: highestSequence
            )
        }
        return ConversationSnapshot(
            conversation: conversation,
            messages: all.map { $0.domainMessage(conversationID: id) },
            assistantTurns: [],
            webEvidenceByMessageID: webEvidenceByMessageID
        )
    }

    private func resetWebEvidenceCache(conversationID: UUID, expectedEpoch: Int) -> [MessageID: WebEvidence] {
        if webEvidenceCache?.conversationID != conversationID || webEvidenceCache?.transcriptEpoch != expectedEpoch {
            webEvidenceCache = nil
        }
        return [:]
    }

    private func loadWebEvidence(
        conversationID: UUID,
        expectedEpoch: Int,
        highestMessageSequence: Int
    ) async -> [MessageID: WebEvidence] {
        if webEvidenceCache?.conversationID != conversationID || webEvidenceCache?.transcriptEpoch != expectedEpoch {
            webEvidenceCache = nil
        }

        var cache = webEvidenceCache ?? WebEvidenceCacheState(
            conversationID: conversationID,
            transcriptEpoch: expectedEpoch,
            scannedThroughSequence: 0,
            hasConfirmedEndpoint: false,
            evidenceByMessageID: [:]
        )

        if cache.hasConfirmedEndpoint && highestMessageSequence <= cache.scannedThroughSequence {
            return cache.evidenceByMessageID
        }

        var after = cache.scannedThroughSequence
        var pages = 0

        while true {
            let page: LiveV2WebEvidencePage
            do {
                page = try await client.webEvidencePage(
                    conversationID: conversationID,
                    after: after,
                    limit: 100
                )
            } catch {
                // V2 web-evidence hydration is additive: an unavailable/404 V1 backend or malformed
                // evidence payload degrades cleanly without blocking the primary chat transcript.
                webEvidenceCache = cache
                return cache.evidenceByMessageID
            }

            guard page.transcriptEpoch == expectedEpoch,
                  page.nextAfter >= after,
                  page.items.first.map({ $0.sequence > after }) ?? true else {
                webEvidenceCache = cache
                return cache.evidenceByMessageID
            }

            for item in page.items {
                if let domain = item.webEvidence.domainEvidence(), domain.hasDisplayableSources {
                    cache.evidenceByMessageID[MessageID(rawValue: item.responseMessageID)] = domain
                }
            }

            cache.hasConfirmedEndpoint = true
            cache.scannedThroughSequence = max(cache.scannedThroughSequence, page.nextAfter)
            pages += 1
            if !page.hasMore { break }
            // Advance even when `page.items` is empty on sparse transcripts where evidence only appears
            // in later pages, while still stopping if the cursor stops advancing.
            guard page.nextAfter > after, pages < 200 else { break }
            after = page.nextAfter
        }

        webEvidenceCache = cache
        return cache.evidenceByMessageID
    }

    /// On every launch, reconcile an unresolved durable intent before enabling a new send.
    func recoverAfterRelaunch() async throws -> ConversationSnapshot {
        _ = try await ensureProfile()
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

    /// Explicitly discards a stuck unconfirmed send when the user chooses to cancel recovery
    /// and restore their message as a draft.
    func discardPending() async throws {
        let me = try await ensureProfile()
        try await journal.discardPending(consumerID: me.consumerID)
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

    func uploadAttachment(filename: String, mediaType: String, data: Data) async throws -> StagedUploadReceiptDTO {
        _ = try await ensureProfile()
        return try await client.uploadAttachment(filename: filename, mediaType: mediaType, data: data)
    }

    /// A fresh UUIDv4 is created once, persisted with its exact body, attachments and epoch, then sent.
    func send(text: String, attachmentIDs: [UUID] = []) async throws -> LiveB1Receipt {
        let prepared = try await preparePendingSend(text: text, attachmentIDs: attachmentIDs)
        return try await dispatch(prepared.pending, consumerID: prepared.consumerID)
    }

    func sendStreaming(text: String, attachmentIDs: [UUID] = []) async throws -> LiveConversationSendSession {
        let prepared = try await preparePendingSend(text: text, attachmentIDs: attachmentIDs)
        guard supportsStreaming else {
            let receipt = try await dispatch(prepared.pending, consumerID: prepared.consumerID)
            return LiveConversationSendSession(receipt: receipt, events: nil)
        }
        return try await dispatchStreaming(prepared.pending, consumerID: prepared.consumerID)
    }

    func finishTurnFromStream(_ turn: LiveB1Turn) async {
        guard turn.status != .running, let me = try? await ensureProfile() else { return }
        try? await journal.clearTurn(consumerID: me.consumerID, turnID: turn.id)
    }

    private func preparePendingSend(
        text: String,
        attachmentIDs: [UUID]
    ) async throws -> (pending: LiveConversationJournal.Pending, consumerID: UUID) {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized.count <= 4096 else {
            throw LiveB1Failure.rejected
        }
        guard attachmentIDs.count <= B3AttachmentLimits.maxAttachmentsPerMessage,
              Set(attachmentIDs).count == attachmentIDs.count else {
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
            text: normalized,
            attachmentIDs: attachmentIDs)
        try await journal.prepare(pending, consumerID: me.consumerID)
        return (pending, me.consumerID)
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
        let nextSlot = slot.addingTimeInterval(1)
        nextTurnPoll[active.conversationID] = nextSlot
        let delay = slot.timeIntervalSince(currentTime)
        if delay > 0 {
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                // Roll back the reserved slot when cancelled before issuing the request
                // so resuming foreground polling is not pushed out by an unsent poll.
                if nextTurnPoll[active.conversationID] == nextSlot {
                    nextTurnPoll[active.conversationID] = slot
                }
                throw error
            }
        }

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
        webEvidenceCache = nil
    }

    private func ensureProfile() async throws -> EmberMeDTO {
        if let profile { return profile }
        return try await bootstrap()
    }

    private func dispatchStreaming(
        _ pending: LiveConversationJournal.Pending,
        consumerID: UUID,
        allowPreExecutionRetry: Bool = true
    ) async throws -> LiveConversationSendSession {
        do {
            let (receipt, events) = try await client.streamSend(pending.submission)
            try validate(receipt, for: pending)
            try await journal.accepted(receipt, for: pending, consumerID: consumerID)
            return LiveConversationSendSession(receipt: receipt, events: events)
        } catch LiveV2StreamFallbackError.endpointUnavailable {
            let receipt = try await dispatch(pending, consumerID: consumerID)
            return LiveConversationSendSession(receipt: receipt, events: nil)
        } catch AuthError.requestRejectedBeforeExecution where allowPreExecutionRetry {
            return try await dispatchStreaming(pending, consumerID: consumerID, allowPreExecutionRetry: false)
        } catch let error as AuthError where error.requiresNewSignIn || error == .accessDenied {
            throw error
        } catch let error as LiveB1Failure where error == .conflict {
            try await journal.markConflict(pending, consumerID: consumerID)
            throw LiveB1Failure.conflict
        } catch let error as LiveB1Failure where error == .rejected {
            try? await journal.discardPending(consumerID: consumerID)
            throw LiveB1Failure.rejected
        } catch let error as LiveB1Failure where error == .unavailable {
            // Keep pending intent so Retry reconciles via lookup before replaying the same id,
            // while surfacing the explicit 429/5xx service-unavailable signal to the UI.
            throw LiveB1Failure.unavailable
        } catch {
            throw LiveB1Failure.unknownAcknowledgement
        }
    }

    private func dispatch(
        _ pending: LiveConversationJournal.Pending,
        consumerID: UUID,
        allowPreExecutionRetry: Bool = true
    ) async throws -> LiveB1Receipt {
        do {
            let receipt = try await client.send(pending.submission)
            try validate(receipt, for: pending)
            try await journal.accepted(receipt, for: pending, consumerID: consumerID)
            return receipt
        } catch AuthError.requestRejectedBeforeExecution where allowPreExecutionRetry {
            return try await dispatch(pending, consumerID: consumerID, allowPreExecutionRetry: false)
        } catch let error as AuthError where error.requiresNewSignIn || error == .accessDenied {
            throw error
        } catch let error as LiveB1Failure where error == .conflict {
            // A known 409 is terminal (N-4/TE-3), NOT an unknown ACK: persist it
            // outside pending so relaunch cannot query 404 and resend this intent.
            try await journal.markConflict(pending, consumerID: consumerID)
            throw LiveB1Failure.conflict
        } catch let error as LiveB1Failure where error == .rejected {
            try? await journal.discardPending(consumerID: consumerID)
            throw LiveB1Failure.rejected
        } catch let error as LiveB1Failure where error == .unavailable {
            // Preserve durable intent for idempotent reconciliation while telling the user
            // the service returned 429/5xx instead of disguising it as unknown delivery.
            throw LiveB1Failure.unavailable
        } catch let error as LiveB1Failure where error == .invalidResponse {
            // A malformed 2xx is ambiguous, even if we cannot adopt its body.
            throw LiveB1Failure.unknownAcknowledgement
        } catch {
            // Includes L1 unknownWriteOutcome, timeout, offline and revoked credentials.
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
