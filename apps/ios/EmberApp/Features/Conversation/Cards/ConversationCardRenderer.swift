import SwiftUI

/// Adapts task journey records and fixed demo fixtures to the existing inline card views.
/// The Conversation host can place these views directly between transcript messages.
enum ConversationCardRenderer {
    struct TaskActivity: View {
        private let record: TaskJourneyRecord
        private let onOpenTaskDetail: (UUID) -> Void

        init(record: TaskJourneyRecord, onOpenTaskDetail: @escaping (UUID) -> Void) {
            self.record = record
            self.onOpenTaskDetail = onOpenTaskDetail
        }

        var body: some View {
            TaskActivityCard(
                title: record.title,
                task: record.task,
                presentation: record.presentation,
                onOpenDetail: { onOpenTaskDetail(record.task.taskID) }
            )
        }
    }

    struct ActivityEvents: View {
        private let events: [TaskEventDTO]

        init(events: [TaskEventDTO]) {
            self.events = Self.orderedEvents(events)
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(events, id: \.sequence) { event in
                    ActivityEventRow(event: event)
                }
            }
            .accessibilityElement(children: .contain)
        }

        static func orderedEvents(_ events: [TaskEventDTO]) -> [TaskEventDTO] {
            events.enumerated()
                .sorted { left, right in
                    if left.element.sequence == right.element.sequence {
                        return left.offset < right.offset
                    }
                    return left.element.sequence < right.element.sequence
                }
                .map(\.element)
        }
    }

    struct Commitment: View {
        private let onOpenDetails: (UUID) -> Void

        init(onOpenDetails: @escaping (UUID) -> Void) {
            self.onOpenDetails = onOpenDetails
        }

        var body: some View {
            CommitmentCard(
                title: commitmentFixture.title,
                status: commitmentFixture.status,
                schedule: commitmentFixture.schedule,
                isMockOnly: commitmentFixture.isMockOnly,
                onOpenDetails: { onOpenDetails(commitmentFixture.id) }
            )
            .id(commitmentFixture.id)
            .accessibilityIdentifier("conversation-commitment-\(commitmentFixture.id.uuidString.lowercased())")
        }
    }

    struct Outcome: View {
        private let record: TaskJourneyRecord
        private let onCopy: (() -> Void)?

        init(record: TaskJourneyRecord, onCopy: (() -> Void)? = nil) {
            self.record = record
            self.onCopy = onCopy
        }

        var body: some View {
            let presentation = outcomePresentation(for: record)
            OutcomeCard(
                title: presentation.title,
                readableContent: presentation.readableContent,
                isMockOnly: presentation.isMockOnly,
                onCopy: onCopy
            )
        }
    }

    struct OutcomePresentation: Equatable {
        let title: String
        let readableContent: String?
        let isMockOnly: Bool
    }

    /// The demo Commitment card has no production DTO source. Keep all displayed facts explicit
    /// and leave schedule absent until a real schedule value is available.
    struct CommitmentFixture {
        let id: UUID
        let title: String
        let status: CommitmentCard.Status
        let schedule: CommitmentCard.Schedule?
        let isMockOnly: Bool
    }

    static let commitmentFixture = CommitmentFixture(
        id: ConversationFixtures.commitmentID,
        title: "Review the weekly plan",
        status: .active,
        schedule: nil,
        isMockOnly: true
    )

    static func outcomePresentation(for record: TaskJourneyRecord) -> OutcomePresentation {
        guard record.task.status == .completed,
              let fixture = record.outcomeFixture else {
            return OutcomePresentation(
                title: String(localized: "card.result", table: "ConversationCards"),
                readableContent: nil,
                isMockOnly: false
            )
        }

        return OutcomePresentation(
            title: fixture.label,
            readableContent: OutcomeCard.hasReadableContent(fixture.content) ? fixture.content : nil,
            isMockOnly: true
        )
    }
}

#Preview("Conversation timeline with structured cards · MOCK ONLY") {
    let record = ConversationCardRendererPreviewData.completedRecord

    ScrollView {
        VStack(alignment: .leading, spacing: 12) {
            ConversationRendererPreviewMessage(speaker: "You", text: "整理这周的会议笔记。")
            ConversationRendererPreviewMessage(speaker: "Ember", text: "我先按主题归纳，再列出可执行事项。")
            ConversationCardRenderer.TaskActivity(record: record, onOpenTaskDetail: { _ in })
            ConversationCardRenderer.ActivityEvents(events: record.events)
            ConversationCardRenderer.Commitment(onOpenDetails: { _ in })
            ConversationCardRenderer.Outcome(record: record)
            ConversationRendererPreviewMessage(speaker: "You", text: "把结果整理成一段简短摘要。")
        }
        .padding()
    }
    .background(EmberDesignTokens.groupedBackground)
}

private enum ConversationCardRendererPreviewData {
    static let completedRecord: TaskJourneyRecord = {
        let fixture = try! BundledMockScenarioProvider().load(.completed)
        let task = fixture.task!

        return TaskJourneyRecord(
            title: "完成与结果样例 · 演示",
            task: task,
            events: fixture.events,
            presentation: TaskPresentationState(
                taskStatus: task.status,
                connectionPhase: .connected,
                commandInFlight: nil,
                capability: .mockOnly
            ),
            origin: .fixture(.completed),
            outcomeFixture: fixture.outcomeFixture,
            approvalAvailability: fixture.approvalAvailability
        )
    }()
}

private struct ConversationRendererPreviewMessage: View {
    let speaker: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(speaker)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EmberDesignTokens.cardBackground, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }
}
