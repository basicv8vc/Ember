import SwiftUI

struct ConversationScreen: View {
    let state: ConversationScreenState
    @Binding var draft: String
    let actions: ConversationScreenActions

    @FocusState private var composerIsFocused: Bool

    private var isGenerating: Bool {
        state.replyState == .generating
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            ConversationTimelineView(
                state: state,
                showsSuggestions: state.timeline.isEmpty && !composerIsFocused,
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
        .accessibilityIdentifier("conversation-home")
    }

    private var header: some View {
        VStack(spacing: 12) {
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

            MockOnlyBanner()
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

/// A local-only host for previews and Lead integration. It deliberately holds no durable Task state.
struct ConversationDemoHost: View {
    @State private var draft = ""
    @State private var timeline: [ConversationTimelineEntry] = []
    @State private var replyState: ConversationReplyState = .idle
    @State private var pendingMessage: String?
    @State private var nextMessageID = 0
    @State private var mockReplyWork: Task<Void, Never>?

    private var suggestedPrompts: [String] {
        [
            String(localized: "conversation.prompt.reflect", table: "Conversation"),
            String(localized: "conversation.prompt.plan", table: "Conversation"),
            String(localized: "conversation.prompt.notes", table: "Conversation")
        ]
    }

    private var screenState: ConversationScreenState {
        ConversationScreenState(
            partnerName: "Ember",
            timeline: timeline,
            replyState: replyState,
            suggestedPrompts: suggestedPrompts
        )
    }

    var body: some View {
        ConversationScreen(
            state: screenState,
            draft: $draft,
            actions: ConversationScreenActions(
                send: send,
                retry: retry,
                stopGenerating: stopGenerating,
                selectPrompt: { draft = $0 }
            )
        )
        .onDisappear(perform: endMockReplyIfNeeded)
    }

    private func send(_ text: String) {
        guard let submission = ConversationInteractionRules.submission(
            for: text,
            isGenerating: replyState == .generating
        ) else { return }

        appendUserMessage(submission.message)
        beginMockReply(for: submission.message)
    }

    private func retry() {
        guard ConversationInteractionRules.retryAction(for: replyState) == .retryMockReply,
              let pendingMessage else { return }
        beginMockReply(for: pendingMessage)
    }

    private func beginMockReply(for message: String) {
        mockReplyWork?.cancel()
        pendingMessage = message
        replyState = .generating

        // A short, static demo pause makes the explicit stop action usable; it shows no fake stream.
        mockReplyWork = Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: 900_000_000)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }
            appendEmberMessage(mockReply(for: message))
            pendingMessage = nil
            replyState = .idle
            mockReplyWork = nil
        }
    }

    private func stopGenerating() {
        guard ConversationInteractionRules.stopAction(for: replyState) == .stopMockReply else { return }

        mockReplyWork?.cancel()
        mockReplyWork = nil
        pendingMessage = nil
        replyState = .idle
        timeline.append(
            .activity(
                ConversationActivityPresentation(
                    id: nextID(prefix: "activity"),
                    title: String(localized: "conversation.reply.stopped", table: "Conversation"),
                    detail: String(localized: "conversation.reply.stop_detail", table: "Conversation"),
                    timestamp: Date()
                )
            )
        )
    }

    private func endMockReplyIfNeeded() {
        mockReplyWork?.cancel()
        mockReplyWork = nil
        pendingMessage = nil
        if replyState == .generating {
            replyState = .idle
        }
    }

    private func appendUserMessage(_ text: String) {
        timeline.append(
            .message(
                ConversationMessagePresentation(
                    id: nextID(prefix: "message"),
                    author: .user,
                    text: text,
                    timestamp: Date()
                )
            )
        )
    }

    private func appendEmberMessage(_ text: String) {
        timeline.append(
            .message(
                ConversationMessagePresentation(
                    id: nextID(prefix: "message"),
                    author: .ember,
                    text: text,
                    timestamp: Date()
                )
            )
        )
    }

    private func nextID(prefix: String) -> String {
        defer { nextMessageID += 1 }
        return "\(prefix)-\(nextMessageID)"
    }

    private func mockReply(for message: String) -> String {
        let normalized = message.lowercased()
        if normalized.contains("plan") || normalized.contains("day") {
            return String(localized: "conversation.mock_reply.plan", table: "Conversation")
        }
        if normalized.contains("note") || normalized.contains("action") {
            return String(localized: "conversation.mock_reply.notes", table: "Conversation")
        }
        return String(localized: "conversation.mock_reply.default", table: "Conversation")
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

#Preview("Conversation · empty") {
    ConversationDemoHost()
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
