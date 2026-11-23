import SwiftUI

struct ConversationScreen<HeaderMenu: View, TopNotices: View>: View {
    let state: ConversationScreenState
    @Binding var draft: String
    let actions: ConversationScreenActions
    var composerNote: LocalizedStringKey = "conversation.composer.local_note"
    var showsSubmissionAcknowledgement = true
    var replyPreparingText: LocalizedStringKey = "conversation.reply.preparing"
    var replyStopText: LocalizedStringKey = "conversation.reply.stop"
    var emberMessageAuthorText: LocalizedStringKey = "conversation.message.ember_mock"
    var onRefresh: (() async -> Void)? = nil
    var onOpenSidebar: (() -> Void)? = nil
    private let headerMenu: HeaderMenu
    private let topNotices: TopNotices

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var composerIsFocused: Bool
    @State private var isAttachmentMenuPresented = false
    @State private var isAttachmentMenuOverlayVisible = false

    init(
        state: ConversationScreenState,
        draft: Binding<String>,
        actions: ConversationScreenActions,
        composerNote: LocalizedStringKey = "conversation.composer.local_note",
        showsSubmissionAcknowledgement: Bool = true,
        replyPreparingText: LocalizedStringKey = "conversation.reply.preparing",
        replyStopText: LocalizedStringKey = "conversation.reply.stop",
        emberMessageAuthorText: LocalizedStringKey = "conversation.message.ember_mock",
        onRefresh: (() async -> Void)? = nil,
        onOpenSidebar: (() -> Void)? = nil,
        @ViewBuilder headerMenu: () -> HeaderMenu,
        @ViewBuilder topNotices: () -> TopNotices
    ) {
        self.state = state
        _draft = draft
        self.actions = actions
        self.composerNote = composerNote
        self.showsSubmissionAcknowledgement = showsSubmissionAcknowledgement
        self.replyPreparingText = replyPreparingText
        self.replyStopText = replyStopText
        self.emberMessageAuthorText = emberMessageAuthorText
        self.onRefresh = onRefresh
        self.onOpenSidebar = onOpenSidebar
        self.headerMenu = headerMenu()
        self.topNotices = topNotices()
    }

    private var isComposerBusy: Bool {
        state.replyState == .generating || state.isSubmitting || state.isStopping || state.isLoading
    }

    private var canAttachMoreFiles: Bool {
        !isComposerBusy
            && !state.isUploadingAttachment
            && state.attachments.count < B3AttachmentLimits.maxAttachmentsPerMessage
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            topNotices

            if state.commandStatus == .acknowledged && showsSubmissionAcknowledgement {
                Text("conversation.submission.acknowledged", tableName: "Conversation")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 680, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("conversation-submission-status")
            }

            ConversationTimelineView(
                state: state,
                showsSuggestions: state.showsEmptyState && state.timeline.isEmpty,
                onPromptSelected: selectPrompt,
                onRetry: actions.retry,
                onStopGenerating: actions.stopGenerating,
                onDismissError: actions.onDismissError,
                replyPreparingText: replyPreparingText,
                replyStopText: replyStopText,
                emberMessageAuthorText: emberMessageAuthorText,
                onRefresh: onRefresh
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ConversationComposer(
                draft: $draft,
                focused: $composerIsFocused,
                replyState: state.replyState,
                isLoading: state.isLoading,
                isSubmitting: state.isSubmitting,
                isStopping: state.isStopping,
                note: composerNote,
                showsNote: ConversationInteractionRules.shouldShowComposerNote(
                    timelineIsEmpty: state.timeline.isEmpty,
                    isLoading: state.isLoading
                ),
                stopText: replyStopText,
                attachments: state.attachments,
                isUploadingAttachment: state.isUploadingAttachment,
                attachmentError: state.attachmentError,
                isAttachmentMenuPresented: $isAttachmentMenuPresented,
                hidesAttachmentTrigger: isAttachmentMenuOverlayVisible,
                onPickAttachment: actions.onPickAttachment,
                onRemoveAttachment: actions.onRemoveAttachment,
                onStopGenerating: actions.stopGenerating,
                onSend: actions.send
            )
        }
        .overlayPreferenceValue(ConversationAttachmentButtonAnchorKey.self) { anchor in
            GeometryReader { proxy in
                if let onPickAttachment = actions.onPickAttachment,
                   let anchor,
                   isAttachmentMenuPresented || isAttachmentMenuOverlayVisible {
                    ConversationAttachmentPopoverOverlay(
                        isPresented: $isAttachmentMenuPresented,
                        isOverlayVisible: $isAttachmentMenuOverlayVisible,
                        sourceRect: proxy[anchor],
                        containerSize: proxy.size,
                        canAttachFile: canAttachMoreFiles,
                        attachedCount: state.attachments.count,
                        onTakePhoto: actions.onTakePhoto,
                        onChoosePhoto: actions.onChoosePhoto,
                        onChooseFile: onPickAttachment,
                        onSelectStarterPrompt: { starter in
                            draft = ConversationInteractionRules.insertingStarterPrompt(starter, into: draft)
                            composerIsFocused = true
                        }
                    )
                }
            }
        }
        .onChange(of: isComposerBusy) { _, busy in
            if busy && isAttachmentMenuPresented {
                isAttachmentMenuPresented = false
            }
        }
        .onChange(of: state.isUploadingAttachment) { _, uploading in
            if uploading && isAttachmentMenuPresented {
                isAttachmentMenuPresented = false
            }
        }
        .background(EmberDesignTokens.groupedBackground.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-home")
    }

    private var header: some View {
        VStack(spacing: 0) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    wrappedHeaderContent
                } else {
                    ViewThatFits(in: .horizontal) {
                        singleRowHeaderContent
                        wrappedHeaderContent
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 8)

            Rectangle()
                .fill(EmberDesignTokens.separator)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
        .background(EmberDesignTokens.groupedBackground)
    }

    private var singleRowHeaderContent: some View {
        HStack(alignment: .center, spacing: 10) {
            headerLeading

            VStack(alignment: .leading, spacing: 2) {
                Text(state.partnerName)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)

                headerSubtitleView
            }

            Spacer(minLength: 4)

            if let pill = state.environmentPill {
                environmentPillView(pill)
            }

            headerMenu
        }
    }

    private var wrappedHeaderContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                headerLeading

                VStack(alignment: .leading, spacing: 2) {
                    Text(state.partnerName)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .truncationMode(.tail)

                    headerSubtitleView
                }

                Spacer(minLength: 4)

                headerMenu
            }

            if let pill = state.environmentPill {
                environmentPillView(pill)
                    .padding(.leading, onOpenSidebar != nil ? 54 : 44)
            }
        }
    }

    @ViewBuilder
    private var headerLeading: some View {
        if let onOpenSidebar {
            Button {
                composerIsFocused = false
                onOpenSidebar()
            } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .frame(width: EmberDesignTokens.minTapTarget, height: EmberDesignTokens.minTapTarget)
                    .background(
                        Color(uiColor: UIColor { traits in
                            traits.userInterfaceStyle == .dark
                                ? UIColor(red: 0.161, green: 0.161, blue: 0.161, alpha: 1)
                                : UIColor(red: 0.953, green: 0.953, blue: 0.953, alpha: 1)
                        }),
                        in: Circle()
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(String(localized: "sidebar.open", table: "Conversation")))
            .accessibilityIdentifier("ember-sidebar-open-chat")
        } else {
            headerEmblem
        }
    }

    private var headerEmblem: some View {
        Image(systemName: "flame.fill")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(EmberDesignTokens.emberMarkTint)
            .frame(width: 34, height: 34)
            .background(EmberDesignTokens.emberSoftSurface, in: Circle())
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var headerSubtitleView: some View {
        if let subtitle = state.headerSubtitle, !subtitle.isEmpty {
            if let identifier = state.headerSubtitleAccessibilityIdentifier, !identifier.isEmpty {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(identifier)
            } else {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Text("conversation.header.subtitle", tableName: "Conversation")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private func environmentPillView(_ pill: ConversationEnvironmentPill) -> some View {
        HStack(spacing: 4) {
            if pill.tone == .mock {
                Image(systemName: "testtube.2")
                    .font(.caption2.weight(.bold))
                    .accessibilityHidden(true)
            }
            Text(pill.title)
                .font(.caption2.weight(pill.tone == .mock ? .bold : .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(environmentPillForeground(for: pill.tone))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(environmentPillBackground(for: pill.tone), in: Capsule())
        .overlay {
            Capsule()
                .strokeBorder(environmentPillBorder(for: pill.tone), lineWidth: 1)
        }
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: pill.accessibilityLabel))
        .accessibilityIdentifier(pill.accessibilityIdentifier)
    }

    private func environmentPillForeground(for tone: ConversationEnvironmentPill.Tone) -> Color {
        switch tone {
        case .mock:
            EmberDesignTokens.mockPillForeground
        case .staging:
            Color(uiColor: .systemTeal)
        case .custom:
            Color(uiColor: .systemIndigo)
        case .cloud:
            .secondary
        }
    }

    private func environmentPillBackground(for tone: ConversationEnvironmentPill.Tone) -> Color {
        switch tone {
        case .mock:
            Color(uiColor: .systemOrange).opacity(0.16)
        case .staging:
            Color(uiColor: .systemTeal).opacity(0.12)
        case .custom:
            Color(uiColor: .systemIndigo).opacity(0.12)
        case .cloud:
            EmberDesignTokens.cardBackground
        }
    }

    private func environmentPillBorder(for tone: ConversationEnvironmentPill.Tone) -> Color {
        switch tone {
        case .mock:
            Color(uiColor: .systemOrange).opacity(0.45)
        case .staging:
            Color(uiColor: .systemTeal).opacity(0.30)
        case .custom:
            Color(uiColor: .systemIndigo).opacity(0.28)
        case .cloud:
            EmberDesignTokens.separator
        }
    }

    private func selectPrompt(_ prompt: String) {
        guard case .populateDraft(let draft) = ConversationInteractionRules.promptSelection(prompt) else { return }
        actions.selectPrompt(draft)
        composerIsFocused = true
    }
}

extension ConversationScreen where HeaderMenu == EmptyView, TopNotices == EmptyView {
    init(
        state: ConversationScreenState,
        draft: Binding<String>,
        actions: ConversationScreenActions,
        composerNote: LocalizedStringKey = "conversation.composer.local_note",
        showsSubmissionAcknowledgement: Bool = true,
        replyPreparingText: LocalizedStringKey = "conversation.reply.preparing",
        replyStopText: LocalizedStringKey = "conversation.reply.stop",
        emberMessageAuthorText: LocalizedStringKey = "conversation.message.ember_mock",
        onRefresh: (() async -> Void)? = nil
    ) {
        self.init(
            state: state,
            draft: draft,
            actions: actions,
            composerNote: composerNote,
            showsSubmissionAcknowledgement: showsSubmissionAcknowledgement,
            replyPreparingText: replyPreparingText,
            replyStopText: replyStopText,
            emberMessageAuthorText: emberMessageAuthorText,
            onRefresh: onRefresh,
            headerMenu: { EmptyView() },
            topNotices: { EmptyView() }
        )
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
        let slowReply = ProcessInfo.processInfo.arguments.contains("--ember-mock-slow-reply")
        _model = State(
            initialValue: ConversationHostModel(
                replyDelayNanoseconds: slowReply ? 25_000_000_000 : 900_000_000
            )
        )
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
            isStopping: model.isStoppingReply,
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
                    model.triggerStopReply()
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
