import SwiftUI

/// NAV-01: a small, floating presentation for the two destinations Ember actually ships.
/// Routing and task state still belong to LiveConversationHost's existing TabView.
struct EmberFloatingTabBar: View {
    @Binding var selection: LiveConversationHostModel.RootTab
    let needsInterventionCount: Int

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 4) {
            destination(
                .chat,
                title: "tab.chat",
                symbol: "bubble.left.and.bubble.right",
                identifier: "ember-nav-chat"
            )
            destination(
                .tasks,
                title: "tab.tasks",
                symbol: "checklist",
                identifier: "ember-nav-tasks"
            )
        }
        .padding(6)
        .background(.regularMaterial, in: Capsule())
        .overlay {
            Capsule()
                .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.08), radius: 14, y: 5)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ember-floating-tab-bar")
    }

    private func destination(
        _ tab: LiveConversationHostModel.RootTab,
        title: LocalizedStringKey,
        symbol: String,
        identifier: String
    ) -> some View {
        let isSelected = selection == tab
        return Button {
            guard selection != tab else { return }
            if reduceMotion {
                selection = tab
            } else {
                withAnimation(.easeInOut(duration: 0.18)) {
                    selection = tab
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.system(size: 19, weight: .medium))

                if dynamicTypeSize.isAccessibilitySize {
                    Text(title, tableName: "Conversation")
                        .font(.footnote.weight(.medium))
                        .lineLimit(1)
                }

                if tab == .tasks && needsInterventionCount > 0 {
                    Text(needsInterventionCount > 99 ? "99+" : "\(needsInterventionCount)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Color(uiColor: .systemOrange), in: Capsule())
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(isSelected ? EmberDesignTokens.emberMarkTint : Color.secondary)
            .padding(.horizontal, 10)
            .frame(minWidth: 64, minHeight: 48)
            .background(isSelected ? EmberDesignTokens.emberSoftSurface : Color.clear, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title, tableName: "Conversation"))
        .accessibilityValue(
            Text(verbatim: tab == .tasks ? tasksAttentionAccessibilityValue : "")
        )
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }

    private var tasksAttentionAccessibilityValue: String {
        guard needsInterventionCount > 0 else { return "" }
        return String(
            format: String(localized: "navigation.tasks.attention_count", table: "Conversation"),
            needsInterventionCount
        )
    }
}
