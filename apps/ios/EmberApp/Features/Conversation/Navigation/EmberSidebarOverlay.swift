import SwiftUI

private enum SidebarPalette {
    // Mirrors UX-04 PR 3 monochrome Visual V1 palette (`EmberDesignTokens.chat*`)
    // so PR #284 renders monochrome independently without adding merge conflicts.
    static let paper = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.125, green: 0.125, blue: 0.125, alpha: 1)
            : .white
    })

    static let softSurface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.161, green: 0.161, blue: 0.161, alpha: 1)
            : UIColor(red: 0.953, green: 0.953, blue: 0.953, alpha: 1)
    })

    static let selectedRow = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.220, green: 0.220, blue: 0.220, alpha: 1)
            : UIColor(red: 0.914, green: 0.914, blue: 0.914, alpha: 1)
    })

    static let hairline = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.270, green: 0.270, blue: 0.270, alpha: 1)
            : UIColor(red: 0.885, green: 0.885, blue: 0.885, alpha: 1)
    })

    static let badgeFill = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.96, green: 0.96, blue: 0.96, alpha: 1)
            : UIColor(red: 0.09, green: 0.09, blue: 0.09, alpha: 1)
    })

    static let badgeForeground = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? .black : .white
    })
}

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
    @Environment(\.colorScheme) private var colorScheme
    @AccessibilityFocusState private var closeHasFocus: Bool
    @State private var dragOffsetX: CGFloat = 0

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Color.black.opacity(colorScheme == .dark ? 0.52 : 0.28)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture(perform: onDismiss)
                    .transition(.opacity)
                    .accessibilityHidden(true)

                HStack(spacing: 0) {
                    directory
                        .frame(width: max(0, min(320, geometry.size.width - 44)))
                        .frame(maxHeight: .infinity)
                        .background(SidebarPalette.paper.ignoresSafeArea(edges: .vertical))
                        .overlay(alignment: .trailing) {
                            Rectangle()
                                .fill(SidebarPalette.hairline)
                                .frame(width: 1)
                                .ignoresSafeArea(edges: .vertical)
                                .accessibilityHidden(true)
                        }
                        .shadow(color: .black.opacity(colorScheme == .dark ? 0.36 : 0.14), radius: 16, x: 4)
                        .offset(x: dragOffsetX)
                        .gesture(
                            DragGesture(minimumDistance: 20, coordinateSpace: .local)
                                .onChanged { value in
                                    dragOffsetX = min(0, value.translation.width)
                                }
                                .onEnded { value in
                                    if value.translation.width < -50 || value.predictedEndTranslation.width < -100 {
                                        dragOffsetX = 0
                                        onDismiss()
                                    } else if reduceMotion {
                                        dragOffsetX = 0
                                    } else {
                                        withAnimation(.easeOut(duration: 0.18)) {
                                            dragOffsetX = 0
                                        }
                                    }
                                }
                        )
                        .transition(reduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity))

                    Button(action: onDismiss) {
                        Color.clear
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel(Text(String(localized: "sidebar.dismiss", table: "Conversation")))
                    .accessibilityIdentifier("ember-sidebar-backdrop")
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(.escape, onDismiss)
        .accessibilityIdentifier("ember-sidebar")
        .onAppear { closeHasFocus = true }
    }

    private var directory: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "flame.fill")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(Color.primary)
                    .frame(width: 38, height: 38)
                    .background(SidebarPalette.softSurface, in: Circle())
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Ember")
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text(String(localized: "sidebar.subtitle", table: "Conversation"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
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
                .accessibilityLabel(Text(String(localized: "sidebar.close", table: "Conversation")))
                .accessibilityIdentifier("ember-sidebar-close")
                .accessibilityFocused($closeHasFocus)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 18)

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 6) {
                        sectionHeading("sidebar.tabs")
                        destination(
                            titleKey: "tab.chat",
                            symbol: "bubble.left.and.bubble.right",
                            identifier: "ember-sidebar-chat",
                            isSelected: selectedTab == .chat,
                            action: onOpenChat
                        )
                        destination(
                            titleKey: "tab.tasks",
                            symbol: "checklist",
                            identifier: "ember-sidebar-tasks",
                            isSelected: selectedTab == .tasks,
                            count: needsInterventionCount,
                            action: onOpenTasks
                        )
                    }

                    if hasMemoryRepository || hasSchedulesRepository {
                        VStack(alignment: .leading, spacing: 6) {
                            sectionHeading("sidebar.tools")
                            if hasMemoryRepository {
                                destination(
                                    titleKey: "memory.nav_title",
                                    symbol: "brain.head.profile",
                                    identifier: "ember-sidebar-memory",
                                    isAvailable: !memoryUnavailable,
                                    showsUnavailable: memoryUnavailable,
                                    action: onOpenMemory
                                )
                            }
                            if hasSchedulesRepository {
                                destination(
                                    titleKey: "schedules.nav_title",
                                    symbol: "calendar.badge.clock",
                                    identifier: "ember-sidebar-schedules",
                                    isAvailable: !schedulesUnavailable,
                                    showsUnavailable: schedulesUnavailable,
                                    action: onOpenSchedules
                                )
                            }
                        }
                    }

                    if !isMockMode {
                        VStack(alignment: .leading, spacing: 6) {
                            sectionHeading("sidebar.account")
                            Button(role: .destructive, action: onSignOut) {
                                Label {
                                    Text(String(localized: "conversation.live.sign_out", table: "Conversation"))
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

            Rectangle()
                .fill(SidebarPalette.hairline)
                .frame(height: 1)
                .padding(.horizontal, 16)
                .accessibilityHidden(true)

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

    private func sectionHeading(_ key: String.LocalizationValue) -> some View {
        Text(String(localized: key, table: "Conversation"))
            .font(.caption2.weight(.semibold))
            .tracking(1)
            .foregroundStyle(.secondary)
            .padding(.leading, 14)
            .padding(.bottom, 4)
    }

    private func destination(
        titleKey: String.LocalizationValue,
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
                    .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                    .frame(width: 24)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text(String(localized: titleKey, table: "Conversation"))
                        .font(.body.weight(isSelected ? .semibold : .regular))
                        .foregroundStyle(isAvailable ? Color.primary : Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if showsUnavailable {
                        Text(String(localized: "sidebar.unavailable", table: "Conversation"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: 0)

                if count > 0 {
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(SidebarPalette.badgeForeground)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 4)
                        .background(SidebarPalette.badgeFill, in: Capsule())
                        .accessibilityHidden(true)
                }

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.primary)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(minHeight: 52)
            .background(
                isSelected ? SidebarPalette.selectedRow : Color.clear,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .opacity(isAvailable ? 1.0 : 0.65)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isAvailable)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}
