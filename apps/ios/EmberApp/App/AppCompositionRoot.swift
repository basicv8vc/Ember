import SwiftUI

private struct MockReceiptPresentation: Identifiable {
    let taskID: UUID

    var id: UUID { taskID }
}

@MainActor
enum AppCompositionRoot {
    static func makeRootView() -> some View {
        IntegratedAppRootView()
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
