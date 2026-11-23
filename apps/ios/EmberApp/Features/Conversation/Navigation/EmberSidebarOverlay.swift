import SwiftUI

/// NAV-02: an iPhone-friendly directory for Ember's existing destinations.
/// It does not create Spaces, change the TabView router, or own any cloud actions.
struct EmberSidebarOverlay: View {
    let selectedTab: LiveConversationHostModel.RootTab
    let needsInterventionCount: Int
    let hasMemoryRepository: Bool
    let memoryUnavailable: Bool
    let hasSchedulesRepository: Bool
    let schedulesUnavailable: Bool
    let isMockMode: Bool
    let environmentBadge: String
    let canSignOut: Bool

    let onDismiss: () -> Void
    let onOpenChat: () -> Void
    let onOpenTasks: () -> Void
    let onOpenMemory: () -> Void
    let onOpenSchedules: () -> Void
    let onSignOut: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AccessibilityFocusState private var closeHasFocus: Bool

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture(perform: onDismiss)
                    .accessibilityElement()
                    .accessibilityLabel(Text("sidebar.dismiss", tableName: "Conversation"))
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("ember-sidebar-backdrop")

                directory
                    .frame(width: max(0, min(320, geometry.size.width - 44)))
                    .frame(maxHeight: .infinity)
                    .background(Color(uiColor: .secondarySystemGroupedBackground).ignoresSafeArea(edges: .vertical))
                    .shadow(color: .black.opacity(0.16), radius: 14, x: 4)
                    .transition(reduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity))
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
        }
        .accessibilityIdentifier("ember-sidebar")
        .onAppear { closeHasFocus = true }
    }

    private var directory: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "flame.fill")
                    .font(.headline)
                    .foregroundStyle(EmberDesignTokens.emberMarkTint)
                    .frame(width: 38, height: 38)
                    .background(EmberDesignTokens.emberSoftSurface, in: Circle())
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Ember")
                        .font(.headline)
                    Text("sidebar.subtitle", tableName: "Conversation")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 0)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("sidebar.close", tableName: "Conversation"))
                .accessibilityIdentifier("ember-sidebar-close")
                .accessibilityFocused($closeHasFocus)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 6) {
                        sectionHeading("sidebar.tabs")
                        destination(
                            title: "tab.chat",
                            symbol: "bubble.left.and.bubble.right",
                            identifier: "ember-sidebar-chat",
                            isSelected: selectedTab == .chat,
                            action: onOpenChat
                        )
                        destination(
                            title: "tab.tasks",
                            symbol: "checklist",
                            identifier: "ember-sidebar-tasks",
                            isSelected: selectedTab == .tasks,
                            count: needsInterventionCount,
                            action: onOpenTasks
                        )
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        sectionHeading("sidebar.tools")
                        destination(
                            title: "memory.nav_title",
                            symbol: "brain.head.profile",
                            identifier: "ember-sidebar-memory",
                            isAvailable: hasMemoryRepository,
                            showsUnavailable: memoryUnavailable || !hasMemoryRepository,
                            action: onOpenMemory
                        )
                        destination(
                            title: "schedules.nav_title",
                            symbol: "calendar.badge.clock",
                            identifier: "ember-sidebar-schedules",
                            isAvailable: hasSchedulesRepository,
                            showsUnavailable: schedulesUnavailable || !hasSchedulesRepository,
                            action: onOpenSchedules
                        )
                    }

                    if !isMockMode {
                        VStack(alignment: .leading, spacing: 6) {
                            sectionHeading("sidebar.account")
                            Button(action: onSignOut) {
                                Label {
                                    Text("conversation.live.sign_out", tableName: "Conversation")
                                } icon: {
                                    Image(systemName: "rectangle.portrait.and.arrow.right")
                                }
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Color(uiColor: .systemRed))
                                .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                                .padding(.horizontal, 14)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(!canSignOut)
                            .accessibilityIdentifier("ember-sidebar-sign-out")
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 20)
            }

            Divider()
                .padding(.horizontal, 16)

            HStack(spacing: 8) {
                Image(systemName: isMockMode ? "testtube.2" : "cloud")
                    .accessibilityHidden(true)
                Text(isMockMode ? "MOCK ONLY" : environmentBadge)
                    .font(.caption.weight(.semibold))
                    .lineLimit(2)
            }
            .foregroundStyle(isMockMode ? EmberDesignTokens.mockPillForeground : Color.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .accessibilityIdentifier("ember-sidebar-environment")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ember-sidebar-directory")
    }

    private func sectionHeading(_ key: LocalizedStringKey) -> some View {
        Text(key, tableName: "Conversation")
            .font(.caption2.weight(.semibold))
            .tracking(1)
            .foregroundStyle(.secondary)
            .padding(.leading, 14)
            .padding(.bottom, 4)
    }

    private func destination(
        title: LocalizedStringKey,
        symbol: String,
        identifier: String,
        isSelected: Bool = false,
        count: Int = 0,
        isAvailable: Bool = true,
        showsUnavailable: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.body)
                    .frame(width: 24)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title, tableName: "Conversation")
                        .font(.body.weight(isSelected ? .semibold : .regular))
                    if showsUnavailable {
                        Text("sidebar.unavailable", tableName: "Conversation")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer(minLength: 0)

                if count > 0 {
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 4)
                        .background(EmberDesignTokens.emberSoftSurface, in: Capsule())
                        .accessibilityHidden(true)
                }

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.semibold))
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(isSelected ? EmberDesignTokens.emberMarkTint : Color.primary)
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .background(isSelected ? EmberDesignTokens.emberSoftSurface : Color.clear,
                        in: RoundedRectangle(cornerRadius: 16))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isAvailable)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}
