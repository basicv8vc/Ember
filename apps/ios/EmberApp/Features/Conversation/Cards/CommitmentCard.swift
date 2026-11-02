import SwiftUI

/// Display-only projection for the audited Commitment DTO fields.
/// Map `status` and `schedule` from the DTO; do not supply values inferred from conversation text.
public struct CommitmentCard: View {
    public enum Status: String, CaseIterable, Sendable {
        case active
        case paused
        case completed
        case cancelled

        fileprivate var titleKey: String {
            switch self {
            case .active: "card.commitment.active"
            case .paused: "card.commitment.paused"
            case .completed: "card.commitment.completed"
            case .cancelled: "card.commitment.cancelled"
            }
        }

        fileprivate var color: Color {
            switch self {
            case .active: Color(uiColor: .systemTeal)
            case .paused: Color(uiColor: .systemOrange)
            case .completed: Color(uiColor: .systemGreen)
            case .cancelled: Color(uiColor: .secondaryLabel)
            }
        }

        fileprivate var symbol: String {
            switch self {
            case .active: "checkmark.circle"
            case .paused: "pause.circle"
            case .completed: "checkmark.seal"
            case .cancelled: "xmark.circle"
            }
        }
    }

    /// A schedule projection matching the existing `once` / `interval` DTO fields.
    public enum Schedule: Equatable, Sendable {
        case once(nextDueAt: String?)
        case interval(seconds: Int?, nextDueAt: String?)
    }

    private let title: String
    private let status: Status
    private let schedule: Schedule?
    private let isMockOnly: Bool
    private let onOpenDetails: () -> Void

    public init(
        title: String,
        status: Status,
        schedule: Schedule? = nil,
        isMockOnly: Bool = false,
        onOpenDetails: @escaping () -> Void
    ) {
        self.title = title
        self.status = status
        self.schedule = schedule
        self.isMockOnly = isMockOnly
        self.onOpenDetails = onOpenDetails
    }

    public var body: some View {
        Button(action: onOpenDetails) {
            ConversationCardSurface {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "calendar.badge.clock")
                            .font(.title3)
                            .foregroundStyle(Color(uiColor: .systemIndigo))
                            .accessibilityHidden(true)

                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 7) {
                                Text("card.commitment", tableName: "ConversationCards")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                if isMockOnly {
                                    ConversationMockTag()
                                }
                            }
                            Text(title)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .padding(.top, 4)
                            .accessibilityHidden(true)
                    }

                    HStack(spacing: 7) {
                        Image(systemName: status.symbol)
                            .accessibilityHidden(true)
                        Text(LocalizedStringKey(status.titleKey), tableName: "ConversationCards")
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(status.color)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(status.color.opacity(0.11), in: Capsule())
                    .accessibilityElement(children: .combine)

                    if let schedulePresentation = Self.schedulePresentation(for: schedule) {
                        scheduleContent(schedulePresentation)
                    }
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("card.commitment_open_hint", tableName: "ConversationCards"))
        .accessibilityIdentifier("commitment-card-\(status.rawValue)")
    }

    @ViewBuilder
    private func scheduleContent(_ presentation: SchedulePresentation) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            switch presentation.kind {
            case .once:
                Label {
                    Text("card.schedule.once", tableName: "ConversationCards")
                        .font(.footnote)
                } icon: {
                    Image(systemName: "calendar")
                        .accessibilityHidden(true)
                }
                .foregroundStyle(.secondary)
            case .interval:
                if let interval = presentation.intervalDescription {
                    HStack(spacing: 4) {
                        Text("card.schedule.every", tableName: "ConversationCards")
                        Text(interval)
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                }
            }

            if let nextDueAt = presentation.nextDueAt {
                Label {
                    HStack(spacing: 4) {
                        Text("card.schedule.next_due", tableName: "ConversationCards")
                        Text(nextDueAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                    }
                    .font(.footnote)
                } icon: {
                    Image(systemName: "clock")
                        .accessibilityHidden(true)
                }
                .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }

    static func schedulePresentation(for schedule: Schedule?) -> SchedulePresentation? {
        guard let schedule else { return nil }
        switch schedule {
        case let .once(nextDueAt):
            return SchedulePresentation(
                kind: .once,
                intervalDescription: nil,
                nextDueAt: nextDueAt.flatMap(ConversationCardFormatting.date(from:))
            )
        case let .interval(seconds, nextDueAt):
            let interval = seconds.flatMap(ConversationCardFormatting.duration(seconds:))
            let dueDate = nextDueAt.flatMap(ConversationCardFormatting.date(from:))
            guard interval != nil || dueDate != nil else { return nil }
            return SchedulePresentation(kind: .interval, intervalDescription: interval, nextDueAt: dueDate)
        }
    }

    struct SchedulePresentation: Equatable {
        enum Kind: Equatable {
            case once
            case interval
        }

        let kind: Kind
        let intervalDescription: String?
        let nextDueAt: Date?
    }
}

#Preview("Commitment status states · MOCK ONLY") {
    VStack(alignment: .leading, spacing: 12) {
        CommitmentCard(
            title: "Review the weekly plan",
            status: .active,
            schedule: .interval(seconds: 86_400, nextDueAt: "2026-11-03T09:00:00Z"),
            isMockOnly: true,
            onOpenDetails: {}
        )
        CommitmentCard(
            title: "Prepare a reading summary",
            status: .paused,
            schedule: .once(nextDueAt: nil),
            isMockOnly: true,
            onOpenDetails: {}
        )
        CommitmentCard(
            title: "Organize project notes",
            status: .completed,
            schedule: nil,
            isMockOnly: true,
            onOpenDetails: {}
        )
        CommitmentCard(
            title: "Send the monthly recap",
            status: .cancelled,
            schedule: nil,
            isMockOnly: true,
            onOpenDetails: {}
        )
    }
    .padding()
    .background(EmberDesignTokens.groupedBackground)
}

#Preview("Unavailable schedule data · MOCK ONLY") {
    VStack(alignment: .leading, spacing: 12) {
        CommitmentCard(
            title: "Commitment without a schedule",
            status: .active,
            schedule: nil,
            isMockOnly: true,
            onOpenDetails: {}
        )
        CommitmentCard(
            title: "Commitment with invalid schedule data",
            status: .active,
            schedule: .interval(seconds: nil, nextDueAt: "not-a-date"),
            isMockOnly: true,
            onOpenDetails: {}
        )
    }
    .padding()
    .background(EmberDesignTokens.groupedBackground)
}
