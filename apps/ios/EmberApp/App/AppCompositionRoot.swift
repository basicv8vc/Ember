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

    private let forceOnboarding: Bool
    private let startInTaskFlow: Bool

    init() {
        let arguments = Set(ProcessInfo.processInfo.arguments)
        forceOnboarding = arguments.contains("--ember-show-onboarding")
        startInTaskFlow = arguments.contains("--ember-start-task-flow")
    }

    private var showsOnboarding: Bool {
        if forceOnboarding, !enteredFromOnboarding {
            return true
        }
        if startInTaskFlow {
            return false
        }
        return !hasEnteredMockDemo
    }

    var body: some View {
        Group {
            if showsOnboarding {
                WelcomeOnboardingView(onViewDemo: enterMockDemo)
            } else {
                TaskJourneyDemoContainer(session: session)
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
