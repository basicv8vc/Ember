import SwiftUI

/// Displays one persisted task event without inventing progress or interpretation.
public struct ActivityRow: View {
    private let event: TaskEventDTO

    public init(event: TaskEventDTO) {
        self.event = event
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: event.phase.designSystemSymbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(event.phase.designSystemColor)
                .frame(width: 28, height: 28)
                .background(event.phase.designSystemColor.opacity(0.12), in: Circle())
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(event.phase.designSystemLabel)
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)

                if let occurredAt = Self.date(from: event.occurredAt) {
                    Text(occurredAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("activity.time_unavailable")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 8)
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("activity-event-\(event.sequence)")
    }

    private static func date(from value: String) -> Date? {
        ConversationCardFormatting.date(from: value)
    }
}

#Preview("Activity event") {
    VStack(alignment: .leading, spacing: 12) {
        ActivityRow(event: TaskEventDTO(
            taskID: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!,
            sequence: 2,
            phase: .progress,
            occurredAt: "2026-11-01T08:30:00Z",
            traceID: UUID(uuidString: "00000000-0000-4000-8000-000000000002")!,
            payload: TaskEventPayloadDTO(simulated: true)
        ))

        InlineNotice(
            title: "connection.offline_title",
            message: "connection.offline_message",
            tone: .warning
        )
    }
    .padding()
    .background(EmberDesignTokens.groupedBackground)
}
