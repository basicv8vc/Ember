import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class ConversationHostModel {
    let conversationID: ConversationID

    private let repository: any ConversationRepositoryProtocol
    private let replyDelayNanoseconds: UInt64
    private var pendingReply: PendingReply?
    private var replyWork: Task<Void, Never>?

    private(set) var loadState: ConversationLoadState = .idle
    private(set) var snapshot: ConversationSnapshot?
    private(set) var replyState: ConversationReplyState = .idle
    private(set) var loadFailureMessage: String?
    private(set) var isSubmitting = false
    private(set) var isStoppingReply = false

    var isLoading: Bool {
        if case .loading = loadState { return true }
        return false
    }

    var showsEmptyState: Bool {
        guard let snapshot else { return false }
        return snapshot.messages.isEmpty
    }

    var screenReplyState: ConversationReplyState {
        if let loadFailureMessage {
            return .failed(message: loadFailureMessage, retryable: true)
        }
        return replyState
    }

    init(
        conversationID: ConversationID = ConversationFixtures.mainConversationID,
        repository: (any ConversationRepositoryProtocol)? = nil,
        replyDelayNanoseconds: UInt64 = 900_000_000
    ) {
        self.conversationID = conversationID
        self.repository = repository ?? (try! ConversationFixtures.makeRepository())
        self.replyDelayNanoseconds = replyDelayNanoseconds
    }

    func load() async {
        guard snapshot == nil else { return }
        loadState = .loading
        loadFailureMessage = nil

        do {
            let loaded = try await repository.fetchConversation(id: conversationID)
            snapshot = loaded
            loadState = ConversationLoadState.resolved(loaded)
        } catch let error as ConversationRepositoryError {
            loadState = .failed(error)
            loadFailureMessage = String(localized: "conversation.error.load", table: "Conversation")
        } catch {
            loadState = .idle
            loadFailureMessage = String(localized: "conversation.error.load", table: "Conversation")
        }
    }

    func send(_ text: String) async {
        guard let submission = ConversationInteractionRules.submission(
            for: text,
            isGenerating: replyState == .generating || isSubmitting
        ) else { return }

        if snapshot == nil {
            await load()
        }
        guard let snapshot else { return }

        let turnID = AssistantTurnID(rawValue: UUID())
        let timestamp = Date()
        let triggeringMessage = ConversationMessage(
            id: MessageID(rawValue: UUID()),
            conversationID: conversationID,
            sequence: (snapshot.messages.map(\.sequence).max() ?? 0) + 1,
            turnID: turnID,
            createdAt: timestamp,
            kind: .user(text: submission.message)
        )

        do {
            let turn = try AssistantTurn(
                id: turnID,
                conversationID: conversationID,
                triggeringMessage: triggeringMessage,
                createdAt: timestamp
            )
            pendingReply = PendingReply(
                messageText: submission.message,
                triggeringMessage: triggeringMessage,
                assistantTurn: turn,
                replyMessageID: MessageID(rawValue: UUID()),
                shouldStartReply: true
            )
            loadFailureMessage = nil
            isSubmitting = true
            await persistPendingInputAndStartReply(turnID: turnID)
        } catch {
            isSubmitting = false
            replyState = .failed(
                message: String(localized: "conversation.error.recoverable", table: "Conversation"),
                retryable: false
            )
        }
    }

    func retry() {
        guard !isSubmitting else { return }
        guard snapshot != nil else {
            Task { await load() }
            return
        }
        guard ConversationInteractionRules.retryAction(for: replyState) == .retryMockReply,
              let turnID = pendingReply?.assistantTurn.id else { return }

        isSubmitting = true
        Task { await persistPendingInputAndStartReply(turnID: turnID) }
    }

    func stopReply() async {
        guard ConversationInteractionRules.stopAction(for: replyState) == .stopMockReply else { return }
        guard !isStoppingReply else { return }

        isStoppingReply = true
        let stoppedReply = pendingReply
        replyWork?.cancel()
        replyWork = nil
        pendingReply = nil

        if let stoppedReply {
            do {
                let current = try await repository.fetchConversation(id: conversationID)
                let activity = ConversationMessage(
                    id: MessageID(rawValue: UUID()),
                    conversationID: conversationID,
                    sequence: (current.messages.map(\.sequence).max() ?? 0) + 1,
                    turnID: stoppedReply.assistantTurn.id,
                    createdAt: Date(),
                    kind: .activity(ActivityMessage(
                        text: String(localized: "conversation.reply.stop_detail", table: "Conversation"),
                        source: .system
                    ))
                )
                snapshot = try await repository.appendMessage(activity, to: conversationID)
            } catch {
                // The local reply is still stopped if recording its transcript activity fails.
            }
        }

        replyState = .idle
        isStoppingReply = false
    }

    func cancelReplyForDisappearance() {
        if var pending = pendingReply, isSubmitting {
            pending.shouldStartReply = false
            pendingReply = pending
            isSubmitting = false
            replyState = .idle
            return
        }
        replyWork?.cancel()
        replyWork = nil
        pendingReply = nil
        if replyState == .generating {
            replyState = .idle
        }
    }

    func waitForReply() async {
        let currentWork = replyWork
        await currentWork?.value
    }

    static func mockReply(for message: String) -> String {
        let normalized = message.lowercased()
        if normalized.contains("plan") || normalized.contains("day") {
            return String(localized: "conversation.mock_reply.plan", table: "Conversation")
        }
        if normalized.contains("note") || normalized.contains("action") {
            return String(localized: "conversation.mock_reply.notes", table: "Conversation")
        }
        return String(localized: "conversation.mock_reply.default", table: "Conversation")
    }

    private func persistPendingInputAndStartReply(turnID: AssistantTurnID) async {
        guard var pending = pendingReply, pending.assistantTurn.id == turnID else { return }

        do {
            var current = try await repository.fetchConversation(id: conversationID)
            guard pendingReply?.assistantTurn.id == turnID else { return }

            if let persistedMessage = current.messages.first(where: { $0.id == pending.triggeringMessage.id }) {
                pending.triggeringMessage = persistedMessage
            } else {
                let nextSequence = (current.messages.map(\.sequence).max() ?? 0) + 1
                let message = ConversationMessage(
                    id: pending.triggeringMessage.id,
                    conversationID: conversationID,
                    sequence: nextSequence,
                    turnID: turnID,
                    createdAt: pending.triggeringMessage.createdAt,
                    kind: .user(text: pending.messageText)
                )
                current = try await repository.appendMessage(message, to: conversationID)
                pending.triggeringMessage = message
                pending.shouldStartReply = pendingReply?.assistantTurn.id == turnID
                    ? (pendingReply?.shouldStartReply ?? false)
                    : false
            }

            let turn = try AssistantTurn(
                id: pending.assistantTurn.id,
                conversationID: conversationID,
                triggeringMessage: pending.triggeringMessage,
                createdAt: pending.assistantTurn.createdAt
            )
            if !current.assistantTurns.contains(where: { $0.id == turnID }) {
                current = try await repository.upsertAssistantTurn(turn, in: conversationID)
            }

            pending.assistantTurn = turn
            snapshot = current
            guard pendingReply?.assistantTurn.id == turnID else { return }
            pending.shouldStartReply = pendingReply?.shouldStartReply ?? false
            pendingReply = pending
            isSubmitting = false
            if pending.shouldStartReply {
                replyState = .generating
                beginMockReply(turnID: turnID)
            } else {
                pendingReply = nil
                replyState = .idle
            }
        } catch {
            guard pendingReply?.assistantTurn.id == turnID else { return }
            isSubmitting = false
            replyState = .failed(
                message: String(localized: "conversation.error.recoverable", table: "Conversation"),
                retryable: true
            )
        }
    }

    private func beginMockReply(turnID: AssistantTurnID) {
        replyWork?.cancel()
        replyWork = Task { [weak self] in
            await self?.completeMockReply(turnID: turnID)
        }
    }

    private func completeMockReply(turnID: AssistantTurnID) async {
        guard let pending = pendingReply, pending.assistantTurn.id == turnID else { return }

        do {
            if replyDelayNanoseconds > 0 {
                try await Task.sleep(nanoseconds: replyDelayNanoseconds)
            }
            guard !Task.isCancelled,
                  pendingReply?.assistantTurn.id == turnID else { return }

            let current = try await repository.fetchConversation(id: conversationID)
            guard !Task.isCancelled,
                  pendingReply?.assistantTurn.id == turnID else { return }

            if current.messages.contains(where: { $0.id == pending.replyMessageID }) {
                snapshot = current
                finishReply(turnID: turnID)
                return
            }

            let reply = ConversationMessage(
                id: pending.replyMessageID,
                conversationID: conversationID,
                sequence: (current.messages.map(\.sequence).max() ?? 0) + 1,
                turnID: turnID,
                createdAt: Date(),
                kind: .ember(text: Self.mockReply(for: pending.messageText))
            )
            let updated = try await repository.appendMessage(reply, to: conversationID)
            guard !Task.isCancelled,
                  pendingReply?.assistantTurn.id == turnID else { return }

            snapshot = updated
            finishReply(turnID: turnID)
        } catch is CancellationError {
            return
        } catch {
            guard pendingReply?.assistantTurn.id == turnID else { return }
            replyState = .failed(
                message: String(localized: "conversation.error.recoverable", table: "Conversation"),
                retryable: true
            )
            replyWork = nil
        }
    }

    private func finishReply(turnID: AssistantTurnID) {
        guard pendingReply?.assistantTurn.id == turnID else { return }
        pendingReply = nil
        replyState = .idle
        replyWork = nil
    }

    private struct PendingReply {
        let messageText: String
        var triggeringMessage: ConversationMessage
        var assistantTurn: AssistantTurn
        let replyMessageID: MessageID
        var shouldStartReply: Bool
    }
}

/// Projects typed domain messages into the transcript's existing rows and inline-card slots.
/// Agent C's shared renderer composes through `ConversationTimelineEntry.inlineCard`.
@MainActor
enum ConversationTimelineAdapter {
    static func entries(
        from snapshot: ConversationSnapshot,
        taskJourneySession: TaskJourneySession,
        onOpenTaskDetail: @escaping (UUID) -> Void,
        onOpenCommitmentDetail: @escaping (UUID) -> Void
    ) -> [ConversationTimelineEntry] {
        snapshot.messages
            .sorted { $0.sequence < $1.sequence }
            .map { message in
                entry(
                    for: message,
                    taskRecords: taskJourneySession.records,
                    taskJourneySession: taskJourneySession,
                    onOpenTaskDetail: onOpenTaskDetail,
                    onOpenCommitmentDetail: onOpenCommitmentDetail
                )
            }
    }

    static func taskRecord(withID taskID: UUID, in records: [TaskJourneyRecord]) -> TaskJourneyRecord? {
        records.first { $0.task.taskID == taskID }
    }

    static func commitmentFixture(
        for reference: CommitmentReference
    ) -> ConversationCardRenderer.CommitmentFixture? {
        let fixture = ConversationCardRenderer.commitmentFixture
        return fixture.id == reference.commitmentID ? fixture : nil
    }

    static func outcomeRecord(
        for reference: OutcomeReference,
        in taskRecords: [TaskJourneyRecord]
    ) -> TaskJourneyRecord? {
        let taskID: UUID?
        switch reference {
        case .taskResult(let id):
            taskID = id
        case .artifact(_, let id):
            taskID = id
        case .commitmentOutcome:
            taskID = nil
        }
        guard let taskID else { return nil }
        return taskRecord(withID: taskID, in: taskRecords)
    }

    static func outcomePresentation(
        for reference: OutcomeReference,
        taskRecords: [TaskJourneyRecord]
    ) -> ConversationCardRenderer.OutcomePresentation {
        guard let record = outcomeRecord(for: reference, in: taskRecords) else {
            return ConversationCardRenderer.OutcomePresentation(
                title: String(localized: "card.result", table: "ConversationCards"),
                readableContent: nil,
                isMockOnly: false
            )
        }
        return ConversationCardRenderer.outcomePresentation(for: record)
    }

    private static func entry(
        for message: ConversationMessage,
        taskRecords: [TaskJourneyRecord],
        taskJourneySession: TaskJourneySession,
        onOpenTaskDetail: @escaping (UUID) -> Void,
        onOpenCommitmentDetail: @escaping (UUID) -> Void
    ) -> ConversationTimelineEntry {
        let messageID = "conversation-message-\(message.id.rawValue.uuidString.lowercased())"
        switch message.kind {
        case .user(let text):
            return .message(ConversationMessagePresentation(
                id: messageID,
                author: .user,
                text: text,
                timestamp: message.createdAt
            ))
        case .ember(let text):
            return .message(ConversationMessagePresentation(
                id: messageID,
                author: .ember,
                text: text,
                timestamp: message.createdAt
            ))
        case .activity(let activity):
            return .activity(ConversationActivityPresentation(
                id: messageID,
                title: activityTitle(for: activity.source),
                detail: activity.text,
                timestamp: message.createdAt
            ))
        case .taskReference(let reference):
            let title = String(localized: "card.task", table: "ConversationCards")
            if let record = taskRecord(withID: reference.taskID, in: taskRecords) {
                return .inlineCard(id: messageID, accessibilityLabel: title) {
                    ConversationCardRenderer.TaskActivity(record: record) { taskID in
                        taskJourneySession.select(taskID: taskID)
                        onOpenTaskDetail(taskID)
                    }
                }
            }
            return .inlineCard(id: messageID, accessibilityLabel: title) {
                ConversationUnavailableReferenceCard(
                    title: String(localized: "conversation.task.unavailable", table: "Conversation"),
                    identifier: reference.taskID.uuidString
                )
            }
        case .commitmentReference(let reference):
            guard let fixture = commitmentFixture(for: reference) else {
                let title = String(localized: "conversation.commitment.unavailable", table: "Conversation")
                return .inlineCard(id: messageID, accessibilityLabel: title) {
                    ConversationUnavailableReferenceCard(
                        title: title,
                        identifier: reference.commitmentID.uuidString
                    )
                }
            }

            let title = fixture.title
            return .inlineCard(id: messageID, accessibilityLabel: title) {
                ConversationCardRenderer.Commitment(onOpenDetails: onOpenCommitmentDetail)
            }
        case .outcomeReference(let reference):
            let presentation = outcomePresentation(for: reference, taskRecords: taskRecords)
            let record = outcomeRecord(for: reference, in: taskRecords)
            return .inlineCard(
                id: messageID,
                accessibilityLabel: presentation.title
            ) {
                if let record {
                    ConversationCardRenderer.Outcome(record: record)
                } else {
                    OutcomeCard(
                        title: presentation.title,
                        readableContent: nil,
                        isMockOnly: presentation.isMockOnly
                    )
                }
            }
        }
    }

    private static func activityTitle(for source: ActivitySource) -> String {
        switch source {
        case .system:
            String(localized: "conversation.activity.system", table: "Conversation")
        case .task:
            String(localized: "conversation.activity.task", table: "Conversation")
        case .commitment:
            String(localized: "conversation.activity.commitment", table: "Conversation")
        }
    }
}

private struct ConversationUnavailableReferenceCard: View {
    let title: String
    let identifier: String

    var body: some View {
        ConversationCardSurface {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "questionmark.circle")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 7) {
                        Text(title)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.primary)
                        ConversationMockTag()
                    }
                    Text(identifier)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("conversation-reference-unavailable")
    }
}
