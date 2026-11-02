import SwiftUI

/// Renders only facts carried by the server-reported Task event DTO.
public struct ActivityEventRow: View {
    private let event: TaskEventDTO
    private let facts: ActivityEventFacts

    public init(event: TaskEventDTO) {
        self.event = event
        self.facts = Self.facts(for: event)
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: event.phase.designSystemSymbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(event.phase.designSystemColor)
                .frame(width: 28, height: 28)
                .background(event.phase.designSystemColor.opacity(0.12), in: Circle())
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(LocalizedStringKey(facts.titleKey), tableName: "ConversationCards")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if facts.isMockOnly {
                        ConversationMockTag()
                    }
                }

                if facts.fromStatus != nil || facts.toStatus != nil {
                    HStack(spacing: 5) {
                        if let fromStatus = facts.fromStatus {
                            TaskStatusBadge(status: fromStatus)
                        }
                        if facts.fromStatus != nil, facts.toStatus != nil {
                            Image(systemName: "arrow.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .accessibilityHidden(true)
                        }
                        if let toStatus = facts.toStatus {
                            TaskStatusBadge(status: toStatus)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }

                if let attempt = facts.attempt {
                    HStack(spacing: 4) {
                        Text("card.event.attempt", tableName: "ConversationCards")
                        Text(attempt, format: .number)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                if let route = facts.route {
                    HStack(spacing: 4) {
                        Text("card.event.route", tableName: "ConversationCards")
                        Text(LocalizedStringKey(Self.routeKey(route)), tableName: "ConversationCards")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                if let errorCode = facts.errorCode {
                    HStack(spacing: 4) {
                        Text("card.event.error_code", tableName: "ConversationCards")
                        Text(errorCode.rawValue)
                            .fontDesign(.monospaced)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                if facts.cancelRequested {
                    ConversationCardNotice(textKey: "card.cancel_pending", symbol: "hourglass")
                }

                if let occurredAt = ConversationCardFormatting.date(from: event.occurredAt) {
                    Label {
                        Text(occurredAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                            .font(.caption)
                    } icon: {
                        Text("card.event.occurred_at", tableName: "ConversationCards")
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                } else {
                    Text("card.time_unavailable", tableName: "ConversationCards")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 6)
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("activity-event-\(event.sequence)")
    }

    static func facts(for event: TaskEventDTO) -> ActivityEventFacts {
        let titleKey: String
        switch event.phase {
        case .accepted: titleKey = "card.event.accepted"
        case .leased: titleKey = "card.event.leased"
        case .started: titleKey = "card.event.started"
        case .progress: titleKey = "card.event.progress"
        case .waitingApproval: titleKey = "card.event.waiting_approval"
        case .approvalGranted: titleKey = "card.event.approval_granted"
        case .approvalDenied: titleKey = "card.event.approval_denied"
        case .retryScheduled: titleKey = "card.event.retry_scheduled"
        case .completed: titleKey = "card.event.completed"
        case .failed: titleKey = "card.event.failed"
        case .cancelled: titleKey = "card.event.cancelled"
        }

        return ActivityEventFacts(
            titleKey: titleKey,
            fromStatus: event.payload.fromStatus,
            toStatus: event.payload.toStatus,
            attempt: event.payload.attempt,
            route: event.payload.route,
            errorCode: event.payload.errorCode,
            cancelRequested: event.payload.cancelRequested == true,
            isMockOnly: event.payload.simulated == true
        )
    }

    private static func routeKey(_ route: TaskExecutionPath) -> String {
        switch route {
        case .fast: "card.route.fast"
        case .standard: "card.route.standard"
        case .heavy: "card.route.heavy"
        }
    }
}

struct ActivityEventFacts: Equatable {
    let titleKey: String
    let fromStatus: TaskStatus?
    let toStatus: TaskStatus?
    let attempt: Int?
    let route: TaskExecutionPath?
    let errorCode: TaskErrorCode?
    let cancelRequested: Bool
    let isMockOnly: Bool
}

#Preview("Activity facts") {
    VStack(alignment: .leading, spacing: 8) {
        ActivityEventRow(event: TaskEventDTO(
            taskID: UUID(uuidString: "00000000-0000-4000-8000-000000000101")!,
            sequence: 1,
            phase: .accepted,
            occurredAt: "2026-11-02T01:00:00Z",
            traceID: UUID(uuidString: "00000000-0000-4000-8000-000000000301")!,
            payload: TaskEventPayloadDTO(taskKind: .mockChat, simulated: true)
        ))
        ActivityEventRow(event: TaskEventDTO(
            taskID: UUID(uuidString: "00000000-0000-4000-8000-000000000101")!,
            sequence: 2,
            phase: .progress,
            occurredAt: "2026-11-02T01:01:00Z",
            traceID: UUID(uuidString: "00000000-0000-4000-8000-000000000301")!,
            payload: TaskEventPayloadDTO(
                attempt: 1,
                fromStatus: .queued,
                toStatus: .running,
                simulated: true
            )
        ))
    }
    .padding()
    .background(EmberDesignTokens.groupedBackground)
}
