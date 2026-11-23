import SwiftUI
import UIKit

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

/// Interactive left-edge drawer container modeled after ChatGPT / Shua CoPaper:
/// no top-left toggle button; swipe left-to-right from the leading edge to open 1:1
/// and swipe right-to-left (or tap the exposed scrim) to close smoothly.
struct EmberSidebarContainer<Content: View>: View {
    @Binding var isShowingSidebar: Bool
    let canSwipeOpenFromEdge: Bool
    let selectedTab: LiveConversationHostModel.RootTab
    let needsInterventionCount: Int
    let hasMemoryRepository: Bool
    let memoryUnavailable: Bool
    let hasSchedulesRepository: Bool
    let schedulesUnavailable: Bool
    let isMockMode: Bool
    let environmentBadge: String
    let canSignOut: Bool

    let onOpenChat: () -> Void
    let onOpenTasks: () -> Void
    let onOpenMemory: () -> Void
    let onOpenSchedules: () -> Void
    let onSignOut: () -> Void
    @ViewBuilder let content: () -> Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var interactiveOffset: CGFloat = 0
    @State private var isDragging = false

    var body: some View {
        GeometryReader { geometry in
            let drawerWidth = max(240, min(320, geometry.size.width - 52))
            let progress = drawerWidth > 0 ? min(1, max(0, interactiveOffset / drawerWidth)) : 0
            let exposedWidth = max(0, geometry.size.width - interactiveOffset)

            ZStack(alignment: .leading) {
                content()
                    .offset(x: interactiveOffset)
                    .allowsHitTesting(!isShowingSidebar && !isDragging)
                    .accessibilityHidden(isShowingSidebar)
                    .accessibilityAction(named: Text(String(localized: "sidebar.open", table: "Conversation"))) {
                        setSidebarPresented(true, drawerWidth: drawerWidth, velocityX: 0)
                    }

                if interactiveOffset > 0.5 || isShowingSidebar {
                    Button {
                        setSidebarPresented(false, drawerWidth: drawerWidth, velocityX: 0)
                    } label: {
                        Color.black.opacity((colorScheme == .dark ? 0.52 : 0.28) * progress)
                            .ignoresSafeArea()
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .frame(width: exposedWidth)
                    .frame(maxHeight: .infinity)
                    .padding(.leading, max(0, interactiveOffset))
                    .allowsHitTesting(isShowingSidebar && !isDragging)
                    .accessibilityLabel(Text(String(localized: "sidebar.dismiss", table: "Conversation")))
                    .accessibilityIdentifier("ember-sidebar-backdrop")
                }

                EmberSidebarOverlay(
                    selectedTab: selectedTab,
                    needsInterventionCount: needsInterventionCount,
                    hasMemoryRepository: hasMemoryRepository,
                    memoryUnavailable: memoryUnavailable,
                    hasSchedulesRepository: hasSchedulesRepository,
                    schedulesUnavailable: schedulesUnavailable,
                    isMockMode: isMockMode,
                    environmentBadge: environmentBadge,
                    canSignOut: canSignOut,
                    onOpenChat: { dismissAndRun(onOpenChat, drawerWidth: drawerWidth) },
                    onOpenTasks: { dismissAndRun(onOpenTasks, drawerWidth: drawerWidth) },
                    onOpenMemory: { dismissAndRun(onOpenMemory, drawerWidth: drawerWidth) },
                    onOpenSchedules: { dismissAndRun(onOpenSchedules, drawerWidth: drawerWidth) },
                    onSignOut: { dismissAndRun(onSignOut, drawerWidth: drawerWidth) }
                )
                .frame(width: drawerWidth)
                .frame(maxHeight: .infinity)
                .background(SidebarPalette.paper.ignoresSafeArea(edges: .vertical))
                .overlay(alignment: .trailing) {
                    Rectangle()
                        .fill(SidebarPalette.hairline)
                        .frame(width: 1)
                        .ignoresSafeArea(edges: .vertical)
                        .accessibilityHidden(true)
                }
                .shadow(
                    color: .black.opacity((colorScheme == .dark ? 0.36 : 0.14) * progress),
                    radius: 16,
                    x: 4
                )
                .offset(x: interactiveOffset - drawerWidth)
                .allowsHitTesting(isShowingSidebar && !isDragging)
                .accessibilityHidden(!isShowingSidebar)
                .accessibilityAction(.escape) {
                    setSidebarPresented(false, drawerWidth: drawerWidth, velocityX: 0)
                }
                .accessibilityIdentifier("ember-sidebar")
            }
            .background(
                SidebarSwipeBridge(
                    isShowingSidebar: isShowingSidebar,
                    canSwipeOpenFromEdge: canSwipeOpenFromEdge,
                    currentOffset: { interactiveOffset },
                    onDragBegan: {
                        isDragging = true
                        UIApplication.shared.sendAction(
                            #selector(UIResponder.resignFirstResponder),
                            to: nil,
                            from: nil,
                            for: nil
                        )
                    },
                    onDragChanged: { translationX, startOffset in
                        let clamped = min(drawerWidth, max(0, startOffset + translationX))
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) {
                            interactiveOffset = clamped
                        }
                    },
                    onDragEnded: { translationX, velocityX, startOffset in
                        let current = min(drawerWidth, max(0, startOffset + translationX))
                        let progressAtLift = drawerWidth > 0 ? current / drawerWidth : 0
                        let projected = progressAtLift + (velocityX * 0.16) / max(1, drawerWidth)
                        let shouldOpen: Bool = isShowingSidebar
                            ? !(progressAtLift < 0.65 || projected < 0.55 || velocityX < -320)
                            : (progressAtLift > 0.35 || projected > 0.45 || velocityX > 320)
                        isDragging = false
                        setSidebarPresented(shouldOpen, drawerWidth: drawerWidth, velocityX: velocityX)
                    }
                )
            )
            .onChange(of: isShowingSidebar) { _, newValue in
                let target = newValue ? drawerWidth : 0
                guard !isDragging, abs(interactiveOffset - target) > 0.5 else { return }
                setSidebarPresented(newValue, drawerWidth: drawerWidth, velocityX: 0)
            }
        }
    }

    private func dismissAndRun(_ action: () -> Void, drawerWidth: CGFloat) {
        setSidebarPresented(false, drawerWidth: drawerWidth, velocityX: 0)
        action()
    }

    private func setSidebarPresented(_ present: Bool, drawerWidth: CGFloat, velocityX: CGFloat) {
        let target = present ? drawerWidth : 0
        let remaining = abs(target - interactiveOffset)
        let normalizedVelocity: CGFloat
        if remaining > 8 {
            let directional = present ? velocityX : -velocityX
            normalizedVelocity = min(5.0, max(0.0, directional / remaining))
        } else {
            normalizedVelocity = 0
        }

        let animation: Animation? = reduceMotion
            ? nil
            : .interpolatingSpring(stiffness: 320, damping: 34, initialVelocity: normalizedVelocity)

        withAnimation(animation) {
            interactiveOffset = target
        }
        if isShowingSidebar != present {
            isShowingSidebar = present
        }
    }
}

private struct SidebarSwipeBridge: UIViewRepresentable {
    let isShowingSidebar: Bool
    let canSwipeOpenFromEdge: Bool
    let currentOffset: () -> CGFloat
    let onDragBegan: () -> Void
    let onDragChanged: (CGFloat, CGFloat) -> Void
    let onDragEnded: (CGFloat, CGFloat, CGFloat) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> BridgeView {
        let view = BridgeView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        view.onWindowChanged = { [weak coordinator = context.coordinator] window in
            coordinator?.attachIfNeeded(to: window)
        }
        return view
    }

    func updateUIView(_ uiView: BridgeView, context: Context) {
        context.coordinator.parent = self
        if let window = uiView.window {
            context.coordinator.attachIfNeeded(to: window)
        }
    }

    static func dismantleUIView(_ uiView: BridgeView, coordinator: Coordinator) {
        coordinator.detach()
    }

    final class BridgeView: UIView {
        var onWindowChanged: ((UIWindow?) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            onWindowChanged?(window)
        }
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: SidebarSwipeBridge
        private weak var attachedWindow: UIWindow?
        private var openPan: UIPanGestureRecognizer?
        private var closePan: UIPanGestureRecognizer?
        private var startOffset: CGFloat = 0

        init(_ parent: SidebarSwipeBridge) {
            self.parent = parent
        }

        func attachIfNeeded(to window: UIWindow?) {
            guard attachedWindow !== window else { return }
            detach()
            guard let window else { return }

            let open = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
            open.maximumNumberOfTouches = 1
            open.cancelsTouchesInView = true
            open.delegate = self

            let close = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
            close.maximumNumberOfTouches = 1
            close.cancelsTouchesInView = true
            close.delegate = self

            window.addGestureRecognizer(open)
            window.addGestureRecognizer(close)
            attachedWindow = window
            openPan = open
            closePan = close
        }

        func detach() {
            if let attachedWindow {
                if let openPan { attachedWindow.removeGestureRecognizer(openPan) }
                if let closePan { attachedWindow.removeGestureRecognizer(closePan) }
            }
            attachedWindow = nil
            openPan = nil
            closePan = nil
        }

        @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
            guard let view = attachedWindow else { return }
            let translation = recognizer.translation(in: view)
            let velocity = recognizer.velocity(in: view)

            switch recognizer.state {
            case .began:
                startOffset = parent.currentOffset()
                parent.onDragBegan()
                parent.onDragChanged(translation.x, startOffset)
            case .changed:
                parent.onDragChanged(translation.x, startOffset)
            case .ended, .cancelled, .failed:
                parent.onDragEnded(translation.x, velocity.x, startOffset)
            default:
                break
            }
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let window = attachedWindow,
                  let pan = gestureRecognizer as? UIPanGestureRecognizer,
                  !hasPresentedModal(from: window.rootViewController)
            else {
                return false
            }

            let location = pan.location(in: window)
            let velocity = pan.velocity(in: window)
            let translation = pan.translation(in: window)

            if pan === openPan {
                guard !parent.isShowingSidebar, parent.canSwipeOpenFromEdge else { return false }
                guard location.x <= 40 else { return false }
                let movingRight = (velocity.x > 0 && velocity.x > abs(velocity.y) * 1.1)
                    || (translation.x > 0 && translation.x > abs(translation.y) * 1.1)
                return movingRight
            }

            if pan === closePan {
                guard parent.isShowingSidebar else { return false }
                let movingLeft = (velocity.x < 0 && abs(velocity.x) > abs(velocity.y) * 1.1)
                    || (translation.x < 0 && abs(translation.x) > abs(translation.y) * 1.1)
                return movingLeft
            }

            return false
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            false
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            guard let window = attachedWindow,
                  otherGestureRecognizer !== openPan,
                  otherGestureRecognizer !== closePan,
                  otherGestureRecognizer.view is UIScrollView,
                  !hasPresentedModal(from: window.rootViewController)
            else {
                return false
            }

            if gestureRecognizer === openPan {
                return !parent.isShowingSidebar
                    && parent.canSwipeOpenFromEdge
                    && otherGestureRecognizer.location(in: window).x <= 40
            }

            if gestureRecognizer === closePan {
                return parent.isShowingSidebar
            }

            return false
        }

        private func hasPresentedModal(from viewController: UIViewController?) -> Bool {
            guard let viewController else { return false }
            if viewController.presentedViewController != nil { return true }
            return viewController.children.contains(where: { hasPresentedModal(from: $0) })
        }
    }
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

    let onOpenChat: () -> Void
    let onOpenTasks: () -> Void
    let onOpenMemory: () -> Void
    let onOpenSchedules: () -> Void
    let onSignOut: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
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
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
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
