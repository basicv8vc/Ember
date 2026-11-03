import SwiftUI

struct ConversationScreen: View {
    let state: ConversationScreenState
    @Binding var draft: String
    let actions: ConversationScreenActions

    @FocusState private var composerIsFocused: Bool

    private var isGenerating: Bool {
        state.replyState == .generating || state.isSubmitting || state.isLoading
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            if state.commandStatus == .acknowledged {
                Text("conversation.submission.acknowledged", tableName: "Conversation")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 680, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("conversation-submission-status")
            }

            ConversationTimelineView(
                state: state,
                showsSuggestions: state.showsEmptyState && state.timeline.isEmpty && !composerIsFocused,
                onPromptSelected: selectPrompt,
                onRetry: actions.retry,
                onStopGenerating: actions.stopGenerating
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ConversationComposer(
                draft: $draft,
                focused: $composerIsFocused,
                isGenerating: isGenerating,
                onSend: actions.send
            )
        }
        .background(EmberDesignTokens.groupedBackground.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-home")
    }

    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "sparkle")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 42, height: 42)
                    .background(Color.accentColor.opacity(0.12), in: Circle())
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(state.partnerName)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text("conversation.header.subtitle", tableName: "Conversation")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 0)
            }

        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(EmberDesignTokens.groupedBackground)
    }

    private func selectPrompt(_ prompt: String) {
        guard case .populateDraft(let draft) = ConversationInteractionRules.promptSelection(prompt) else { return }
        actions.selectPrompt(draft)
        composerIsFocused = true
    }
}

/// The Lead injects the existing Task session and its navigation callback. This host owns only
/// the local Conversation repository and the cancellable mock-reply work.
struct ConversationDemoHost: View {
    let taskJourneySession: TaskJourneySession
    private let onOpenTaskDetail: (UUID) -> Void
    private let onOpenCommitmentDetail: (UUID) -> Void

    @State private var model: ConversationHostModel
    @State private var draft = ""

    init(
        taskJourneySession: TaskJourneySession,
        onOpenTaskDetail: @escaping (UUID) -> Void,
        onOpenCommitmentDetail: @escaping (UUID) -> Void = { _ in }
    ) {
        self.taskJourneySession = taskJourneySession
        self.onOpenTaskDetail = onOpenTaskDetail
        self.onOpenCommitmentDetail = onOpenCommitmentDetail
        _model = State(initialValue: ConversationHostModel())
    }

    private var screenState: ConversationScreenState {
        let timeline = model.snapshot.map {
            ConversationTimelineAdapter.entries(
                from: $0,
                taskJourneySession: taskJourneySession,
                onOpenTaskDetail: onOpenTaskDetail,
                onOpenCommitmentDetail: onOpenCommitmentDetail
            )
        } ?? []

        return ConversationScreenState(
            timeline: timeline,
            replyState: model.screenReplyState,
            suggestedPrompts: [
                String(localized: "conversation.prompt.reflect", table: "Conversation"),
                String(localized: "conversation.prompt.plan", table: "Conversation"),
                String(localized: "conversation.prompt.notes", table: "Conversation")
            ],
            showsEmptyState: model.showsEmptyState,
            isLoading: model.isLoading,
            isSubmitting: model.isSubmitting || model.isStoppingReply,
            commandStatus: model.commandStatus
        )
    }

    var body: some View {
        ConversationScreen(
            state: screenState,
            draft: $draft,
            actions: ConversationScreenActions(
                send: { text in
                    Task { await model.send(text) }
                },
                retry: model.retry,
                stopGenerating: {
                    Task { await model.stopReply() }
                },
                selectPrompt: { draft = $0 }
            )
        )
        .task { await model.load() }
        .onDisappear(perform: model.cancelReplyForDisappearance)
    }
}

private struct ConversationScreenPreviewHarness: View {
    @State private var draft = ""
    @State private var state: ConversationScreenState

    init(state: ConversationScreenState) {
        _state = State(initialValue: state)
    }

    var body: some View {
        ConversationScreen(
            state: state,
            draft: $draft,
            actions: ConversationScreenActions(
                send: { _ in },
                retry: { state.replyState = .generating },
                stopGenerating: { state.replyState = .idle },
                selectPrompt: { draft = $0 }
            )
        )
    }
}

#Preview("Conversation · repository fixture") {
    ConversationDemoHost(
        taskJourneySession: TaskJourneySession(),
        onOpenTaskDetail: { _ in }
    )
}

#Preview("Conversation · inline content") {
    ConversationScreenPreviewHarness(
        state: ConversationScreenState(
            timeline: [
                .message(
                    ConversationMessagePresentation(
                        id: "preview-user-1",
                        author: .user,
                        text: "Can you help me turn these notes into one manageable next step?",
                        timestamp: Date()
                    )
                ),
                .message(
                    ConversationMessagePresentation(
                        id: "preview-ember-1",
                        author: .ember,
                        text: "MOCK reply: Start with the action that removes the most uncertainty.",
                        timestamp: Date()
                    )
                ),
                .activity(
                    ConversationActivityPresentation(
                        id: "preview-activity-1",
                        title: "MOCK activity update",
                        detail: "This typed slot can host Agent C's task or outcome card.",
                        timestamp: Date()
                    )
                ),
                .inlineCard(id: "preview-inline-card", accessibilityLabel: "Example inline task card") {
                    Label {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Example linked task")
                                .font(.subheadline.weight(.semibold))
                            Text("A card view can be injected here by the Lead adapter.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "checklist")
                            .foregroundStyle(Color.accentColor)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(EmberDesignTokens.cardBackground, in: RoundedRectangle(cornerRadius: 18))
                }
            ],
            suggestedPrompts: []
        )
    )
}

#Preview("Conversation · recoverable error") {
    ConversationScreenPreviewHarness(
        state: ConversationScreenState(
            timeline: [
                .message(
                    ConversationMessagePresentation(
                        id: "preview-user-error",
                        author: .user,
                        text: "Help me make a plan for the afternoon.",
                        timestamp: Date()
                    )
                )
            ],
            replyState: .failed(
                message: String(localized: "conversation.error.recoverable", table: "Conversation"),
                retryable: true
            ),
            suggestedPrompts: []
        )
    )
}
