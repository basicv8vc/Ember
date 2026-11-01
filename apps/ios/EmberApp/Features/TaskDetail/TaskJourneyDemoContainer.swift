import SwiftUI

@MainActor
struct TaskJourneyDemoContainer: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var session: TaskJourneySession
    @State private var selectedTab: Tab = .compose

    init(session: TaskJourneySession? = nil) {
        _session = State(initialValue: session ?? TaskJourneySession())
    }

    var body: some View {
        VStack(spacing: 0) {
            mockOnlyBanner
            TabView(selection: $selectedTab) {
                NavigationStack {
                    TaskComposeView(session: session) { _ in
                        selectedTab = .inbox
                    }
                }
                .tabItem { Label("新任务", systemImage: "square.and.pencil") }
                .tag(Tab.compose)

                NavigationStack {
                    TaskInboxView(session: session) {
                        selectedTab = .detail
                    }
                }
                .tabItem { Label("我的承诺", systemImage: "tray.full") }
                .tag(Tab.inbox)

                NavigationStack {
                    TaskDetailView(session: session)
                }
                .tabItem { Label("详情", systemImage: "list.bullet.rectangle") }
                .tag(Tab.detail)
            }
            .tint(.orange)
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .background {
                session.markSceneBackgrounded()
            } else if newPhase == .active {
                Task { await session.resumeAfterSceneReturn() }
            }
        }
    }

    private var mockOnlyBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "flask.fill")
                .accessibilityHidden(true)
            Text("MOCK ONLY · No real AI execution")
                .font(.footnote.weight(.bold))
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("task-flow-mock-only-label")
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .foregroundStyle(.primary)
        .background(.orange.opacity(0.22))
    }

    private enum Tab: Hashable {
        case compose
        case inbox
        case detail
    }
}

#Preview("Task Flow · Light") {
    TaskJourneyDemoContainer()
}

#Preview("Task Flow · Dark · Large Text") {
    TaskJourneyDemoContainer()
        .preferredColorScheme(.dark)
        .environment(\.dynamicTypeSize, .accessibility2)
}
