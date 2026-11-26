import SwiftUI

/// A truthful, compact entry to already-known Task work. Never creates task state or a timer.
struct ConversationWorkSummary: Equatable {
    let needsAttentionCount: Int
    let activeCount: Int

    init?(needsAttentionCount: Int, activeCount: Int) {
        guard needsAttentionCount >= 0, activeCount >= 0,
              needsAttentionCount > 0 || activeCount > 0 else { return nil }
        self.needsAttentionCount = needsAttentionCount
        self.activeCount = activeCount
    }
}

/// Visible above the transcript, so ongoing work stays discoverable even when reading old messages.
/// Tasks remains the authoritative inbox and owns all actions/approvals.
struct ConversationWorkStatusEntry: View {
    let summary: ConversationWorkSummary
    let onOpenTasks: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: onOpenTasks) {
            HStack(spacing: 10) {
                Image(systemName: summary.needsAttentionCount > 0 ? "hand.raised.fill" : "clock.arrow.circlepath")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(summary.needsAttentionCount > 0
                        ? Color(uiColor: .systemOrange)
                        : EmberDesignTokens.chatBrandInk)
                    .frame(width: 20)
                    .accessibilityHidden(true)

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        counters
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        counters
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 12 : 9)
            .frame(minHeight: EmberDesignTokens.minTapTarget)
            .background(EmberDesignTokens.chatPaper, in: RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(EmberDesignTokens.chatHairline, lineWidth: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("chat.work.open_tasks", tableName: "Conversation"))
        .accessibilityIdentifier("chat-work-status-entry")
    }

    @ViewBuilder
    private var counters: some View {
        if summary.needsAttentionCount > 0 {
            HStack(spacing: 5) {
                Text("chat.work.needs_you", tableName: "Conversation")
                    .font(.footnote.weight(.semibold))
                Text(summary.needsAttentionCount, format: .number)
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(Color(uiColor: .systemOrange))
            }
        }
        if summary.activeCount > 0 {
            HStack(spacing: 5) {
                Text("chat.work.active", tableName: "Conversation")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(summary.activeCount, format: .number)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
    }
}
