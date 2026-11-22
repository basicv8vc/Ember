import SwiftUI

private struct MockReceiptPresentation: Identifiable {
    let taskID: UUID

    var id: UUID { taskID }
}

struct EmberCloudTarget: Equatable, Sendable {
    let baseURL: URL
    let keychainConfiguration: KeychainSessionStore.Configuration
    let journalSubdirectory: String
    let authFenceSubdirectory: String
    let environmentBadge: String

    var isV2Staging: Bool {
        baseURL.host?.lowercased() == AppCompositionRoot.v2StagingHost
    }
}

@MainActor
enum AppCompositionRoot {
    static let defaultCloudBaseURL = "https://ember-api.slowfast.dev"
    static let v2StagingCloudBaseURL = "https://ember-v2-staging.slowfast.dev"
    static let v2StagingHost = "ember-v2-staging.slowfast.dev"
    static let defaultHost = "ember-api.slowfast.dev"
    static let persistedV2StagingDefaultsKey = "ember.debug.useV2Staging"
    static let infoPlistCloudBaseURLKey = "EmberCloudBaseURL"
    static let infoPlistAllowEnvironmentSwitchKey = "EmberAllowEnvironmentSwitch"

    private static let mockLaunchArguments: Set<String> = [
        "--ember-mock-demo",
        "--ember-show-onboarding",
        "--ember-start-task-flow",
        "--ember-start-conversation",
        "--ember-mock-chat-tasks",
    ]

    static func setPersistedV2Staging(_ enabled: Bool, userDefaults: UserDefaults = .standard) {
        if enabled {
            userDefaults.set(true, forKey: persistedV2StagingDefaultsKey)
        } else {
            userDefaults.removeObject(forKey: persistedV2StagingDefaultsKey)
        }
    }

    static func allowsEnvironmentSwitch(bundleInfo: [String: Any]? = Bundle.main.infoDictionary) -> Bool {
        #if DEBUG
        return true
        #else
        if let flag = bundleInfo?[infoPlistAllowEnvironmentSwitchKey] as? Bool {
            return flag
        }
        if let raw = bundleInfo?[infoPlistAllowEnvironmentSwitchKey] as? String {
            return raw == "1" || raw.lowercased() == "true" || raw.lowercased() == "yes"
        }
        return false
        #endif
    }

    /// Resolves the active cloud target and isolated local storage namespace.
    /// - Explicit `EMBER_CLOUD_BASE_URL` takes precedence and fails closed if invalid or non-HTTPS.
    /// - `--ember-live-cloud` explicitly selects V1 (`ember-api.slowfast.dev`).
    /// - `--ember-v2-staging` selects the isolated V2 Staging environment (`ember-v2-staging.slowfast.dev`)
    ///   with a separate Keychain account and conversation journal directory so V1 sessions are never overwritten.
    /// - `--ember-persist-v2-staging` or the internal switch persists V2 Staging in `UserDefaults` when
    ///   running in Debug or when `EmberAllowEnvironmentSwitch` is enabled in `Info.plist`.
    /// - `EmberCloudBaseURL` in `Info.plist` configures the build-time target for standalone Release daily-use builds.
    /// - Default remains V1 (`ember-api.slowfast.dev`).
    static func resolveCloudTarget(
        arguments: Set<String>,
        environment: [String: String],
        userDefaults: UserDefaults = .standard,
        bundleInfo: [String: Any]? = Bundle.main.infoDictionary
    ) -> EmberCloudTarget? {
        let canSwitchEnvironment = allowsEnvironmentSwitch(bundleInfo: bundleInfo)
        if canSwitchEnvironment,
           arguments.contains("--ember-v2-staging"),
           arguments.contains("--ember-persist-v2-staging") {
            setPersistedV2Staging(true, userDefaults: userDefaults)
        }

        let origin: String
        if let envOrigin = environment["EMBER_CLOUD_BASE_URL"], !envOrigin.isEmpty {
            origin = envOrigin
        } else if arguments.contains("--ember-live-cloud") {
            origin = defaultCloudBaseURL
        } else if arguments.contains("--ember-v2-staging") {
            origin = v2StagingCloudBaseURL
        } else if canSwitchEnvironment, userDefaults.bool(forKey: persistedV2StagingDefaultsKey) {
            origin = v2StagingCloudBaseURL
        } else if let infoOrigin = (bundleInfo?[infoPlistCloudBaseURLKey] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
                  !infoOrigin.isEmpty {
            origin = infoOrigin
        } else {
            origin = defaultCloudBaseURL
        }

        guard let url = URL(string: origin),
              LiveEmberSessionAPI.isAcceptableBaseURL(url),
              let host = url.host?.lowercased()
        else {
            return nil
        }

        if host == defaultHost {
            return EmberCloudTarget(
                baseURL: url,
                keychainConfiguration: .live,
                journalSubdirectory: "EmberConversation",
                authFenceSubdirectory: FileSessionRecoveryFence.directoryName,
                environmentBadge: "LIVE CLOUD"
            )
        }

        if host == v2StagingHost {
            return EmberCloudTarget(
                baseURL: url,
                keychainConfiguration: KeychainSessionStore.Configuration(
                    service: KeychainSessionStore.Configuration.live.service,
                    account: "ember.session.v2-staging"
                ),
                journalSubdirectory: "EmberConversation-v2-staging",
                authFenceSubdirectory: "\(FileSessionRecoveryFence.directoryName)-v2-staging",
                environmentBadge: "V2 STAGING"
            )
        }

        let sanitizedHost = host.replacingOccurrences(
            of: #"[^a-z0-9.-]"#,
            with: "_",
            options: .regularExpression
        )
        return EmberCloudTarget(
            baseURL: url,
            keychainConfiguration: KeychainSessionStore.Configuration(
                service: KeychainSessionStore.Configuration.live.service,
                account: "ember.session.\(sanitizedHost)"
            ),
            journalSubdirectory: "EmberConversation-\(sanitizedHost)",
            authFenceSubdirectory: "\(FileSessionRecoveryFence.directoryName)-\(sanitizedHost)",
            environmentBadge: "CUSTOM CLOUD"
        )
    }

    /// Live Ember Cloud is the default entrypoint.
    /// Mock flows remain explicitly selectable via launch arguments for UI tests.
    /// An explicitly invalid or non-HTTPS EMBER_CLOUD_BASE_URL fails closed; never fall back to Mock.
    @ViewBuilder
    static func makeRootView() -> some View {
        let arguments = Set(ProcessInfo.processInfo.arguments)
        if arguments.contains("--ember-device-executor") {
            DeviceExecutorWorkbenchView(model: DeviceExecutorWorkbenchModel())
        } else if arguments.isDisjoint(with: mockLaunchArguments)
            || arguments.contains("--ember-live-cloud")
            || arguments.contains("--ember-v2-staging") {
            LiveCloudRootView(
                arguments: arguments,
                environment: ProcessInfo.processInfo.environment
            )
        } else if arguments.contains("--ember-mock-chat-tasks") {
            LiveConversationHost(
                model: MockB3Composition.make(
                    resetStorage: arguments.contains("--ember-mock-chat-tasks-reset")
                )
            )
        } else {
            IntegratedAppRootView()
        }
    }
}

@MainActor
private enum LiveComposition {
    static func make(target: EmberCloudTarget) throws -> LiveConversationHostModel {
        let client = EmberAPIClient()
        let api = try LiveEmberSessionAPI(baseURL: target.baseURL, client: client)
        let transport = try EmberAuthenticatedTransport(baseURL: target.baseURL, client: client)
        // Built before the coordinator so the durable-intent cleanup can be handed to it at
        // construction. Registering it afterwards would leave a window in which a logout clears the
        // credential but leaves unsent private text on disk.
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        )[0]
        let journal = LiveConversationJournal(
            directory: appSupport.appendingPathComponent(target.journalSubdirectory, isDirectory: true)
        )
        let fence = FileSessionRecoveryFence(
            directory: appSupport.appendingPathComponent(target.authFenceSubdirectory, isDirectory: true)
        )
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: api,
            transport: transport,
            store: KeychainSessionStore(configuration: target.keychainConfiguration),
            appleSignIn: AppleSignInAuthorizer(),
            fence: fence,
            signOutCleanupHooks: [{ try? await journal.reset() }]
        ))
        let supportsStreaming = target.baseURL.host?.lowercased() != AppCompositionRoot.defaultHost
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth),
            journal: journal,
            supportsStreaming: supportsStreaming
        )
        let taskRepository = LiveB1SessionTaskRepository(auth: auth)
        let scheduleRepository = LiveProactiveScheduleRepository(auth: auth)
        let memoryRepository = LivePersonalMemoryRepository(auth: auth)
        // Process-local caches only: identity is re-established by `bootstrap()` on every entry, so
        // this is not the security boundary and may settle asynchronously.
        Task { await auth.registerSignOutCleanup { await repository.clearOnLogout() } }
        return LiveConversationHostModel(
            repository: repository,
            auth: auth,
            taskRepository: taskRepository,
            scheduleRepository: scheduleRepository,
            memoryRepository: memoryRepository,
            cloudBaseURL: target.baseURL.host?.lowercased() == AppCompositionRoot.defaultHost ? nil : target.baseURL,
            deviceAuthProvider: target.baseURL.host?.lowercased() == AppCompositionRoot.defaultHost ? nil : auth,
            environmentBadge: target.environmentBadge
        )
    }
}

@MainActor
private struct LiveCloudRootView: View {
    @State private var target: EmberCloudTarget?
    @State private var model: LiveConversationHostModel?
    private let environment: [String: String]
    private let allowsEnvironmentSwitch: Bool

    init(arguments: Set<String>, environment: [String: String]) {
        self.environment = environment
        self.allowsEnvironmentSwitch = AppCompositionRoot.allowsEnvironmentSwitch()
        let resolved = AppCompositionRoot.resolveCloudTarget(
            arguments: arguments,
            environment: environment
        )
        _target = State(initialValue: resolved)
        _model = State(initialValue: resolved.flatMap { try? LiveComposition.make(target: $0) })
    }

    var body: some View {
        if let target, let model {
            let toggleBinding: Binding<Bool>? = allowsEnvironmentSwitch
                ? Binding(
                    get: { target.isV2Staging },
                    set: { enabled in
                        AppCompositionRoot.setPersistedV2Staging(enabled)
                        let nextTarget = AppCompositionRoot.resolveCloudTarget(
                            arguments: [],
                            environment: environment
                        )
                        self.target = nextTarget
                        self.model = nextTarget.flatMap { try? LiveComposition.make(target: $0) }
                    }
                )
                : nil
            LiveConversationHost(
                model: model,
                debugUseV2Staging: toggleBinding
            )
            .id(target.baseURL.absoluteString)
        } else {
            ContentUnavailableView(
                "Live Cloud configuration unavailable",
                systemImage: "network.slash",
                description: Text("Set a secure EMBER_CLOUD_BASE_URL for the Live Alpha build.")
            )
        }
    }
}

@MainActor
private enum MockB3Composition {
    static func make(resetStorage: Bool) -> LiveConversationHostModel {
        let storageURL = MockSessionTaskRepository.defaultStorageURL()
        let taskRepository = MockSessionTaskRepository(
            storageURL: storageURL,
            resetStorage: resetStorage
        )
        let initialMessages = resetStorage
            ? []
            : MockSessionTaskRepository.loadPersistedUserMessages(from: storageURL)
        let repository = MockB3ConversationRepository(
            taskRepository: taskRepository,
            initialUserMessages: initialMessages
        )
        let auth = MockAuthController()
        let scheduleRepository = InMemoryProactiveScheduleRepository()
        let memoryRepository = InMemoryPersonalMemoryRepository()
        let initialAttachments: [ComposerAttachment] = ProcessInfo.processInfo.arguments.contains("--ember-mock-staged-attachments")
            ? [
                ComposerAttachment(
                    id: UUID(uuidString: "00000000-0000-4000-8000-00000000c101")!,
                    filename: "q4-launch-summary.csv",
                    mediaType: "text/csv",
                    sizeBytes: 24_576
                ),
                ComposerAttachment(
                    id: UUID(uuidString: "00000000-0000-4000-8000-00000000c102")!,
                    filename: "notes.pdf",
                    mediaType: "application/pdf",
                    sizeBytes: 12_288
                ),
            ]
            : []
        return LiveConversationHostModel(
            repository: repository,
            auth: auth,
            taskRepository: taskRepository,
            scheduleRepository: scheduleRepository,
            memoryRepository: memoryRepository,
            isMockMode: true,
            initialStagedAttachments: initialAttachments
        )
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
