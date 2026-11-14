import SwiftUI

private struct MockReceiptPresentation: Identifiable {
    let taskID: UUID

    var id: UUID { taskID }
}

@MainActor
enum AppCompositionRoot {
    static let defaultCloudBaseURL = "https://ember-cloud-api-staging.10kpaper.workers.dev"

    private static let mockLaunchArguments: Set<String> = [
        "--ember-mock-demo",
        "--ember-show-onboarding",
        "--ember-start-task-flow",
        "--ember-start-conversation",
    ]

    /// Live Ember Cloud is the default entrypoint.
    /// Mock flows remain explicitly selectable via launch arguments for UI tests.
    /// An explicitly invalid or non-HTTPS EMBER_CLOUD_BASE_URL fails closed; never fall back to Mock.
    @ViewBuilder
    static func makeRootView() -> some View {
        let arguments = Set(ProcessInfo.processInfo.arguments)
        if arguments.isDisjoint(with: mockLaunchArguments) || arguments.contains("--ember-live-cloud") {
            let origin = ProcessInfo.processInfo.environment["EMBER_CLOUD_BASE_URL"] ?? defaultCloudBaseURL
            if let url = URL(string: origin),
               let model = try? LiveComposition.make(baseURL: url) {
                LiveConversationHost(model: model)
            } else {
                ContentUnavailableView(
                    "Live Cloud configuration unavailable",
                    systemImage: "network.slash",
                    description: Text("Set a secure EMBER_CLOUD_BASE_URL for the Live Alpha build.")
                )
            }
        } else {
            IntegratedAppRootView()
        }
    }
}

@MainActor
private enum LiveComposition {
    static func make(baseURL: URL) throws -> LiveConversationHostModel {
        let client = EmberAPIClient()
        let api = try LiveEmberSessionAPI(baseURL: baseURL, client: client)
        let transport = try EmberAuthenticatedTransport(baseURL: baseURL, client: client)
        // Built before the coordinator so the durable-intent cleanup can be handed to it at
        // construction. Registering it afterwards would leave a window in which a logout clears the
        // credential but leaves unsent private text on disk.
        let journal = LiveConversationJournal()
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: api,
            transport: transport,
            store: KeychainSessionStore(),
            appleSignIn: AppleSignInAuthorizer(),
            signOutCleanupHooks: [{ try? await journal.reset() }]
        ))
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth), journal: journal
        )
        // Process-local caches only: identity is re-established by `bootstrap()` on every entry, so
        // this is not the security boundary and may settle asynchronously.
        Task { await auth.registerSignOutCleanup { await repository.clearOnLogout() } }
        return LiveConversationHostModel(repository: repository, auth: auth)
    }
}

@MainActor
private struct IntegratedAppRootView: View {
    @AppStorage("ember.mockDemo.hasEntered") private var hasEnteredMockDemo = false
    @State private var session = TaskJourneySession()
    @State private var enteredFromOnboarding = false
    @State private var shownReceiptTaskIDs: Set<UUID> = []
    @State private var receiptPresentation: MockReceiptPresentation?
    @State private var taskNavigationPath: [UUID] = []
    @State private var showsCommitmentDemoNotice = false

    private let forceOnboarding: Bool
    private let startInTaskFlow: Bool
    private let startInConversation: Bool

    init() {
        let arguments = Set(ProcessInfo.processInfo.arguments)
        forceOnboarding = arguments.contains("--ember-show-onboarding")
        startInTaskFlow = arguments.contains("--ember-start-task-flow")
        startInConversation = arguments.contains("--ember-start-conversation")
    }

    private var showsOnboarding: Bool {
        if forceOnboarding, !enteredFromOnboarding {
            return true
        }
        if startInTaskFlow || startInConversation {
            return false
        }
        return !hasEnteredMockDemo
    }

    var body: some View {
        Group {
            if showsOnboarding {
                WelcomeOnboardingView(onViewDemo: enterMockDemo)
            } else if startInTaskFlow {
                // Keep the existing M2 flow available to its launch-flagged UI tests.
                TaskJourneyDemoContainer(session: session)
            } else {
                VStack(spacing: 0) {
                    MockOnlyBanner()
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                        .padding(.bottom, 8)
                        .background(EmberDesignTokens.groupedBackground)

                    NavigationStack(path: $taskNavigationPath) {
                        ConversationDemoHost(
                            taskJourneySession: session,
                            onOpenTaskDetail: openTaskDetail,
                            onOpenCommitmentDetail: openCommitmentDemo
                        )
                        .navigationDestination(for: UUID.self) { taskID in
                            TaskDetailView(session: session)
                                .onAppear { session.select(taskID: taskID) }
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .onChange(of: session.records.map(\.id)) { _, _ in
            presentReceiptForNewSessionTask()
        }
        .sheet(item: $receiptPresentation, onDismiss: presentReceiptForNewSessionTask) { presentation in
            MockReceiptAcknowledgementView(taskID: presentation.taskID) {
                receiptPresentation = nil
            }
        }
        .alert("MOCK ONLY · Commitment preview", isPresented: $showsCommitmentDemoNotice) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("This is a fixed local preview. Live Commitment details and actions are not available.")
        }
    }

    private func openTaskDetail(_ taskID: UUID) {
        guard session.records.contains(where: { $0.id == taskID }),
              taskNavigationPath.last != taskID else { return }
        session.select(taskID: taskID)
        taskNavigationPath.append(taskID)
    }

    private func openCommitmentDemo(_ commitmentID: UUID) {
        guard commitmentID == ConversationFixtures.commitmentID else { return }
        showsCommitmentDemoNotice = true
    }

    private func enterMockDemo() {
        hasEnteredMockDemo = true
        enteredFromOnboarding = true
    }

    private func presentReceiptForNewSessionTask() {
        guard receiptPresentation == nil else { return }

        guard let record = session.records.first(where: { record in
            guard case .createdInThisSession = record.origin else { return false }
            return !shownReceiptTaskIDs.contains(record.id)
        }) else { return }

        shownReceiptTaskIDs.insert(record.id)
        receiptPresentation = MockReceiptPresentation(taskID: record.id)
    }
}
