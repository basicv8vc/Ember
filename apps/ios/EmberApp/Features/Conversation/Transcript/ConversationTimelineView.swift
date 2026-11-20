import SwiftUI

struct ConversationTimelineView: View {
    let state: ConversationScreenState
    let showsSuggestions: Bool
    let onPromptSelected: (String) -> Void
    let onRetry: () -> Void
    let onStopGenerating: () -> Void
    let replyPreparingText: LocalizedStringKey
    let replyStopText: LocalizedStringKey
    let emberMessageAuthorText: LocalizedStringKey
    var onRefresh: (() async -> Void)? = nil

    private let bottomAnchor = "conversation-timeline-bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if state.isLoading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 32)
                    } else if showsSuggestions {
                        ConversationEmptyStateView(
                            prompts: state.suggestedPrompts,
                            onPromptSelected: onPromptSelected
                        )
                    }

                    ForEach(state.timeline) { entry in
                        timelineRow(entry)
                    }

                    ConversationReplyStatusView(
                        state: state.replyState,
                        onRetry: onRetry,
                        onStopGenerating: onStopGenerating,
                        preparingText: replyPreparingText,
                        stopText: replyStopText
                    )

                    Color.clear
                        .frame(height: 1)
                        .id(bottomAnchor)
                }
                .frame(maxWidth: 680, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.horizontal, 16)
                .padding(.top, 18)
                .padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.interactively)
            .modifier(OptionalRefreshableModifier(onRefresh: onRefresh))
            .onAppear {
                DispatchQueue.main.async {
                    proxy.scrollTo(bottomAnchor, anchor: .bottom)
                }
            }
            .onChange(of: state.timeline.count) { _, _ in
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(bottomAnchor, anchor: .bottom)
                }
            }
            .onChange(of: state.replyState) { _, _ in
                proxy.scrollTo(bottomAnchor, anchor: .bottom)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("conversation-timeline")
        }
    }

    @ViewBuilder
    private func timelineRow(_ entry: ConversationTimelineEntry) -> some View {
        switch entry {
        case .message(let message):
            ConversationMessageBubble(message: message, authorText: emberMessageAuthorText)
        case .activity(let activity):
            ConversationActivityRow(activity: activity)
        case .inlineContent(let content):
            content.content
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(Text(verbatim: content.accessibilityLabel))
        }
    }
}

private struct ConversationEmptyStateView: View {
    let prompts: [String]
    let onPromptSelected: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text("conversation.empty.title", tableName: "Conversation")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.primary)

                Text("conversation.empty.message", tableName: "Conversation")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !prompts.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("conversation.suggestions.title", tableName: "Conversation")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)

                    ForEach(prompts, id: \.self) { prompt in
                        Button {
                            onPromptSelected(prompt)
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "sparkle")
                                    .font(.callout.weight(.semibold))
                                    .foregroundStyle(Color.accentColor)
                                    .padding(.top, 1)
                                    .accessibilityHidden(true)

                                Text(prompt)
                                    .font(.callout)
                                    .foregroundStyle(.primary)
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 13)
                            .background(
                                EmberDesignTokens.cardBackground,
                                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                            )
                            .overlay {
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint(Text("conversation.prompt.hint", tableName: "Conversation"))
                        .accessibilityIdentifier("conversation-suggested-prompt")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }
}

private struct ConversationMessageBubble: View {
    let message: ConversationMessagePresentation
    let authorText: LocalizedStringKey

    private var isUser: Bool {
        message.author == .user
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isUser {
                Spacer(minLength: 34)
            }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                HStack(spacing: 5) {
                    if !isUser {
                        Image(systemName: "sparkle")
                            .font(.caption2.weight(.semibold))
                            .accessibilityHidden(true)
                        Text(authorText, tableName: "Conversation")
                    } else {
                        Text("conversation.message.you", tableName: "Conversation")
                    }
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

                Group {
                    if isUser {
                        Text(verbatim: message.text)
                    } else {
                        ConversationMarkdownText(text: message.text)
                    }
                }
                .font(.body)
                .foregroundStyle(isUser ? Color.white : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

                if let timestamp = message.timestamp {
                    Text(timestamp.formatted(date: .omitted, time: .shortened))
                        .font(.caption2)
                        .foregroundStyle(isUser ? Color.white.opacity(0.78) : Color.secondary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .frame(maxWidth: 620, alignment: isUser ? .trailing : .leading)
            .background(
                isUser ? Color.accentColor : EmberDesignTokens.cardBackground,
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            .overlay {
                if !isUser {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
                }
            }

            if !isUser {
                Spacer(minLength: 34)
            }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .accessibilityElement(children: .combine)
        // The combined bubble and its inner text node are both exposed as StaticText on
        // iOS 27, so a label predicate alone matches the same message twice. This stable
        // identifier marks the bubble itself (one element per message), which lets UI tests
        // count messages without relying on label formatting.
        .accessibilityIdentifier(isUser ? "conversation-message-user" : "conversation-message-ember")
    }
}

private struct ConversationActivityRow: View {
    let activity: ConversationActivityPresentation

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "circle.dotted")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .padding(.top, 2)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(activity.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)

                if let detail = activity.detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let timestamp = activity.timestamp {
                    Text(timestamp.formatted(date: .omitted, time: .shortened))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(EmberDesignTokens.cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct ConversationReplyStatusView: View {
    let state: ConversationReplyState
    let onRetry: () -> Void
    let onStopGenerating: () -> Void
    let preparingText: LocalizedStringKey
    let stopText: LocalizedStringKey

    @ViewBuilder
    var body: some View {
        switch state {
        case .idle:
            EmptyView()
        case .generating:
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: "sparkle")
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)

                Text(preparingText, tableName: "Conversation")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button(action: onStopGenerating) {
                    Label {
                        Text(stopText, tableName: "Conversation")
                    } icon: {
                        Image(systemName: "stop.fill")
                    }
                    .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .tint(.secondary)
                .accessibilityIdentifier("conversation-stop-reply")
            }
            .padding(13)
            .background(EmberDesignTokens.cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
            }
            .accessibilityElement(children: .contain)
        case .failed(let message, _):
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(.red)
                    .accessibilityHidden(true)

                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if ConversationInteractionRules.retryAction(for: state) == .retryMockReply {
                    Button(action: onRetry) {
                        Label {
                            Text("conversation.reply.retry", tableName: "Conversation")
                        } icon: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .font(.footnote.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                    .accessibilityIdentifier("conversation-retry")
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .background(Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.red.opacity(0.2), lineWidth: 1)
            }
            .accessibilityElement(children: .contain)
        }
    }
}

private struct OptionalRefreshableModifier: ViewModifier {
    let onRefresh: (() async -> Void)?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let onRefresh {
            content.refreshable {
                await onRefresh()
            }
        } else {
            content
        }
    }
}
