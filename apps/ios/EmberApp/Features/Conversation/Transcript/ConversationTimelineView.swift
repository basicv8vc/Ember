import SwiftUI

struct ConversationTimelineView: View {
    let state: ConversationScreenState
    let showsSuggestions: Bool
    let onPromptSelected: (String) -> Void
    let onRetry: () -> Void
    let onStopGenerating: () -> Void
    var onDismissError: (() -> Void)? = nil
    let replyPreparingText: LocalizedStringKey
    let replyStopText: LocalizedStringKey
    let emberMessageAuthorText: LocalizedStringKey
    var onRefresh: (() async -> Void)? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase

    @State private var scrollState = ConversationTimelineScrollState()
    @State private var contentBounds: TimelineContentBounds?
    @State private var viewportBounds: TimelineViewportBounds?
    @State private var latestMeasuredMetrics: ConversationTimelineViewportMetrics?
    @State private var scrollRequest: TimelineScrollRequest?
    @State private var pendingDynamicTypeChange = false
    @State private var programmaticScrollResetTask: Task<Void, Never>?

    private let bottomAnchor = "conversation-timeline-bottom"
    private let scrollCoordinateSpace = "conversation-timeline-scroll-space"

    private var scrollSnapshot: ConversationTimelineScrollSnapshot {
        ConversationTimelineScrollSnapshot(state: state)
    }

    private var hasTimelineContent: Bool {
        !state.timeline.isEmpty
    }

    private var showsJumpToLatest: Bool {
        !state.isLoading && scrollState.showsJumpToLatest(hasContent: hasTimelineContent)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                ScrollView {
                    VStack(spacing: 0) {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            if state.isLoading && state.timeline.isEmpty {
                                ProgressView()
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 32)
                            } else if !state.isLoading && showsSuggestions {
                                ConversationEmptyStateView(
                                    emptyState: state.emptyState,
                                    prompts: state.suggestedPrompts,
                                    onPromptSelected: onPromptSelected
                                )
                            }

                            let timestampDividerIDs = ConversationTimelineTimestampGrouping.dividerEntryIDs(
                                for: state.timeline
                            )
                            ForEach(state.timeline) { entry in
                                VStack(alignment: .leading, spacing: 8) {
                                    if timestampDividerIDs.contains(entry.id),
                                       let timestamp = entry.timelineTimestamp {
                                        Text(ConversationTimelineTimestampGrouping.formattedDivider(for: timestamp))
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity, alignment: .center)
                                            .padding(.top, 4)
                                            .accessibilityIdentifier("conversation-timestamp-divider")
                                    }
                                    timelineRow(entry)
                                }
                            }

                            ConversationReplyStatusView(
                                state: state.replyState,
                                isSubmitting: state.isSubmitting,
                                isStreaming: !(state.streamingReplyText ?? "").isEmpty,
                                onRetry: onRetry,
                                onStopGenerating: onStopGenerating,
                                onDismissError: onDismissError,
                                preparingText: replyPreparingText,
                                stopText: replyStopText
                            )
                        }
                        .frame(maxWidth: 680, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.horizontal, 16)
                        .padding(.top, 18)
                        .padding(.bottom, 20)

                        Color.clear
                            .frame(height: 1)
                            .id(bottomAnchor)
                    }
                    .modifier(LegacyTimelineContentBoundsModifier(coordinateSpaceName: scrollCoordinateSpace))
                }
                .coordinateSpace(name: scrollCoordinateSpace)
                .modifier(
                    TimelineScrollGeometryObserverModifier(
                        coordinateSpaceName: scrollCoordinateSpace,
                        scrollRequest: scrollRequest,
                        onMetrics: { metrics in
                            latestMeasuredMetrics = metrics
                            applyScrollMetricsIfActive(proxy: proxy)
                        },
                        onLegacyContentBounds: { newBounds in
                            guard newBounds != contentBounds else { return }
                            contentBounds = newBounds
                            updateLegacyMetricsIfReady(proxy: proxy)
                        },
                        onLegacyViewportBounds: { newBounds in
                            guard newBounds != viewportBounds else { return }
                            viewportBounds = newBounds
                            updateLegacyMetricsIfReady(proxy: proxy)
                        }
                    )
                )
                .scrollDismissesKeyboard(.interactively)
                .modifier(OptionalRefreshableModifier(onRefresh: onRefresh))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("conversation-timeline")

                if showsJumpToLatest {
                    ConversationJumpToLatestButton {
                        let directive = scrollState.handleJumpToLatestTap(reduceMotion: reduceMotion)
                        executeScrollDirective(directive, proxy: proxy)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .scale(scale: 0.85).combined(with: .opacity)
                    )
                }
            }
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.2),
                value: showsJumpToLatest
            )
            .onAppear {
                let directive = scrollState.handleAppear(hasContent: hasTimelineContent)
                if directive != .none {
                    DispatchQueue.main.async {
                        guard scrollState.isFollowingBottom else { return }
                        executeScrollDirective(directive, proxy: proxy)
                    }
                }
            }
            .onDisappear {
                programmaticScrollResetTask?.cancel()
                programmaticScrollResetTask = nil
                scrollState.finishProgrammaticScroll()
            }
            .onChange(of: scrollSnapshot) { oldValue, newValue in
                let directive = scrollState.handleStateChange(
                    from: oldValue,
                    to: newValue,
                    reduceMotion: reduceMotion
                )
                if directive != .none {
                    DispatchQueue.main.async {
                        guard scrollState.isFollowingBottom else { return }
                        executeScrollDirective(directive, proxy: proxy)
                    }
                }
            }
            .onChange(of: dynamicTypeSize) { _, _ in
                pendingDynamicTypeChange = true
            }
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active {
                    applyScrollMetricsIfActive(proxy: proxy)
                    let directive = scrollState.handleBecameActive(hasContent: hasTimelineContent)
                    if directive != .none {
                        DispatchQueue.main.async {
                            guard scrollState.isFollowingBottom else { return }
                            executeScrollDirective(directive, proxy: proxy)
                        }
                    }
                }
            }
        }
    }

    private func updateLegacyMetricsIfReady(proxy: ScrollViewProxy) {
        guard let contentBounds, let viewportBounds else { return }
        latestMeasuredMetrics = ConversationTimelineViewportMetrics(
            contentMinY: contentBounds.minY,
            contentHeight: contentBounds.height,
            viewportWidth: viewportBounds.width,
            viewportHeight: viewportBounds.height,
            topInset: viewportBounds.topInset,
            bottomInset: viewportBounds.bottomInset
        )
        applyScrollMetricsIfActive(proxy: proxy)
    }

    private func applyScrollMetricsIfActive(proxy: ScrollViewProxy) {
        guard scenePhase == .active,
              let metrics = latestMeasuredMetrics else {
            return
        }
        let dynamicTypeChanged = pendingDynamicTypeChange
        pendingDynamicTypeChange = false

        let directive = scrollState.handleMetricsChange(
            metrics,
            hasContent: hasTimelineContent,
            dynamicTypeChanged: dynamicTypeChanged
        )
        executeScrollDirective(directive, proxy: proxy)
    }

    private func executeScrollDirective(
        _ directive: ConversationTimelineScrollDirective,
        proxy: ScrollViewProxy
    ) {
        guard case .scrollToBottom(let animated) = directive else { return }
        let shouldAnimate = animated && !reduceMotion
        programmaticScrollResetTask?.cancel()
        programmaticScrollResetTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(shouldAnimate ? 480 : 120))
            guard !Task.isCancelled else { return }
            scrollState.finishProgrammaticScroll()
            if scrollState.isFollowingBottom,
               (latestMeasuredMetrics?.distanceFromBottom ?? 0) > scrollState.config.settledBottomTolerance {
                performScrollToBottom(animated: false, proxy: proxy)
            }
        }

        performScrollToBottom(animated: shouldAnimate, proxy: proxy)
    }

    private func performScrollToBottom(animated: Bool, proxy: ScrollViewProxy) {
        if #available(iOS 18.0, *) {
            scrollRequest = TimelineScrollRequest(animated: animated)
        } else if animated {
            withAnimation(.easeInOut(duration: 0.35)) {
                proxy.scrollTo(bottomAnchor, anchor: .bottom)
            }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                proxy.scrollTo(bottomAnchor, anchor: .bottom)
            }
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
    let emptyState: ConversationEmptyStateConfiguration?
    let prompts: [String]
    let onPromptSelected: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: "flame.fill")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(EmberDesignTokens.chatBrandInk)
                    .frame(width: 48, height: 48)
                    .background(EmberDesignTokens.chatAgentBubble, in: Circle())
                    .accessibilityHidden(true)

                if let emptyState {
                    Text(emptyState.title)
                        .font(.system(.largeTitle, design: .default, weight: .semibold))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(emptyState.subtitle)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if let capabilityNote = emptyState.capabilityNote, !capabilityNote.isEmpty {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "info.circle")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .padding(.top, 2)
                                .accessibilityHidden(true)

                            Text(capabilityNote)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            EmberDesignTokens.chatAgentBubble,
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(EmberDesignTokens.chatHairline, lineWidth: 1)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("conversation-empty-capability-note")
                    }
                } else {
                    Text(String(localized: "conversation.empty.title", table: "Conversation"))
                        .font(.system(.largeTitle, design: .default, weight: .semibold))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(String(localized: "conversation.empty.message", table: "Conversation"))
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let emptyState, !emptyState.prompts.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(String(localized: "conversation.suggestions.title", table: "Conversation"))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)

                    ForEach(emptyState.prompts) { item in
                        Button {
                            onPromptSelected(item.prompt)
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: item.iconName)
                                    .font(.callout.weight(.semibold))
                                    .foregroundStyle(EmberDesignTokens.chatBrandInk)
                                    .frame(width: 24, height: 24)
                                    .padding(.top, 1)
                                    .accessibilityHidden(true)

                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.title)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.primary)
                                        .fixedSize(horizontal: false, vertical: true)

                                    Text(item.prompt)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .frame(minHeight: EmberDesignTokens.minTapTarget)
                            .background(
                                EmberDesignTokens.chatPaper,
                                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                            )
                            .overlay {
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .strokeBorder(EmberDesignTokens.chatHairline, lineWidth: 1)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text(verbatim: "\(item.title). \(item.prompt)"))
                        .accessibilityHint(Text("conversation.prompt.hint", tableName: "Conversation"))
                        .accessibilityIdentifier("conversation-suggested-prompt")
                    }
                }
            } else if !prompts.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(String(localized: "conversation.suggestions.title", table: "Conversation"))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)

                    ForEach(prompts, id: \.self) { prompt in
                        Button {
                            onPromptSelected(prompt)
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "sparkle")
                                    .font(.callout.weight(.semibold))
                                    .foregroundStyle(EmberDesignTokens.chatBrandInk)
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
                            .frame(minHeight: EmberDesignTokens.minTapTarget)
                            .background(
                                EmberDesignTokens.chatPaper,
                                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                            )
                            .overlay {
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .strokeBorder(EmberDesignTokens.chatHairline, lineWidth: 1)
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
        .padding(.top, 24)
        .padding(.bottom, 8)
    }
}

private struct ConversationMessageBubble: View {
    let message: ConversationMessagePresentation
    let authorText: LocalizedStringKey

    private var isUser: Bool {
        message.author == .user
    }

    // The visible user label is intentionally removed, but VoiceOver still announces
    // the speaker and preserves the pending/unknown-ACK delivery note.
    private var accessibilityMessageLabel: Text {
        let speaker = isUser
            ? Text("conversation.message.you", tableName: "Conversation")
            : Text(authorText, tableName: "Conversation")
        let note = message.deliveryNote.map { Text(verbatim: ". \($0)") } ?? Text("")
        return speaker + Text(verbatim: ": \(message.text)") + note
    }

    @Environment(\.openURL) private var openURL

    var body: some View {
        if isUser {
            HStack(alignment: .bottom, spacing: 0) {
                Spacer(minLength: 56)

                VStack(alignment: .trailing, spacing: 4) {
                    Group {
                        if let linkedText = ConversationCardFormatting.linkifiedPlainText(for: message.text) {
                            Text(linkedText)
                                .tint(.primary)
                        } else {
                            Text(verbatim: message.text)
                        }
                    }
                    .font(.body)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(
                        EmberDesignTokens.chatUserBubble,
                        in: RoundedRectangle(cornerRadius: 20, style: .continuous)
                    )
                    .opacity(message.deliveryNote != nil ? 0.92 : 1.0)

                    if let deliveryNote = message.deliveryNote {
                        Text(deliveryNote)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.trailing, 4)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityMessageLabel)
            // Keep one stable combined element per message for the existing UX-03/UI tests.
            .accessibilityIdentifier(
                message.accessibilityIdentifierOverride ?? "conversation-message-user"
            )
        } else {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 5) {
                        Image(systemName: "flame.fill")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(EmberDesignTokens.chatBrandInk)
                            .accessibilityHidden(true)
                        Text(authorText, tableName: "Conversation")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }

                    ConversationMarkdownText(
                        text: message.text,
                        cachesParsedMarkdown: !message.isStreaming
                    )
                    .font(.body)
                    .foregroundStyle(.primary)
                    .tint(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)

                    if let deliveryNote = message.deliveryNote {
                        Text(deliveryNote)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 2)
                .opacity(message.deliveryNote != nil ? 0.92 : 1.0)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(accessibilityMessageLabel)
                // Keep one stable combined element per message for the existing UX-03/UI tests.
                .accessibilityIdentifier(
                    message.accessibilityIdentifierOverride ?? "conversation-message-ember"
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

enum ConversationTimelineTimestampGrouping {
    static let minimumGapSeconds: TimeInterval = 15 * 60

    static func dividerEntryIDs(
        for entries: [ConversationTimelineEntry],
        calendar: Calendar = .current
    ) -> Set<String> {
        var result: Set<String> = []
        var lastShownTimestamp: Date?

        for entry in entries {
            guard let timestamp = entry.timelineTimestamp else { continue }
            if let previous = lastShownTimestamp {
                let crossedDay = !calendar.isDate(timestamp, inSameDayAs: previous)
                let exceededGap = timestamp.timeIntervalSince(previous) >= minimumGapSeconds
                if crossedDay || exceededGap {
                    result.insert(entry.id)
                    lastShownTimestamp = timestamp
                }
            } else {
                result.insert(entry.id)
                lastShownTimestamp = timestamp
            }
        }

        return result
    }

    static func formattedDivider(
        for date: Date,
        relativeTo now: Date = Date(),
        calendar: Calendar = .current
    ) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

private extension ConversationTimelineEntry {
    var timelineTimestamp: Date? {
        switch self {
        case .message(let message):
            return message.timestamp
        case .activity(let activity):
            return activity.timestamp
        case .inlineContent:
            return nil
        }
    }
}

private struct ConversationActivityRow: View {
    let activity: ConversationActivityPresentation

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "circle.dotted")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.top, 2)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(activity.title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)

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
        .padding(.leading, 12)
        .padding(.vertical, 8)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(EmberDesignTokens.chatHairline)
                .frame(width: 2)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct ConversationReplyStatusView: View {
    let state: ConversationReplyState
    let isSubmitting: Bool
    var isStreaming: Bool = false
    let onRetry: () -> Void
    let onStopGenerating: () -> Void
    let onDismissError: (() -> Void)?
    let preparingText: LocalizedStringKey
    let stopText: LocalizedStringKey

    @ViewBuilder
    var body: some View {
        switch state {
        case .idle:
            if isSubmitting {
                HStack(alignment: .center, spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    Text("conversation.reply.sending", tableName: "Conversation")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(13)
                .background(EmberDesignTokens.chatAgentBubble, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("conversation-sending-reply")
            } else {
                EmptyView()
            }
        case .generating:
            HStack(alignment: .center, spacing: 12) {
                ProgressView()
                    .controlSize(.small)

                Group {
                    if isStreaming {
                        Text("conversation.reply.streaming", tableName: "Conversation")
                    } else {
                        Text(preparingText, tableName: "Conversation")
                    }
                }
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
                    .frame(minHeight: EmberDesignTokens.minTapTarget)
                }
                .buttonStyle(.bordered)
                .tint(.secondary)
                .accessibilityIdentifier("conversation-stop-reply")
            }
            .padding(13)
            .background(EmberDesignTokens.chatAgentBubble, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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
                        .frame(minHeight: EmberDesignTokens.minTapTarget)
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                    .accessibilityIdentifier("conversation-retry")
                }

                if let onDismissError {
                    Button(action: onDismissError) {
                        Image(systemName: "xmark")
                            .font(.caption.weight(.semibold))
                            .frame(minWidth: EmberDesignTokens.minTapTarget, minHeight: EmberDesignTokens.minTapTarget)
                    }
                    .buttonStyle(.bordered)
                    .tint(.secondary)
                    .accessibilityLabel(Text("tasks.detail.close", tableName: "Conversation"))
                    .accessibilityIdentifier("conversation-dismiss-error")
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

private struct ConversationJumpToLatestButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .modifier(JumpToLatestSurfaceModifier())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("conversation.timeline.jump_to_latest", tableName: "Conversation"))
        .accessibilityHint(Text("conversation.timeline.jump_to_latest_hint", tableName: "Conversation"))
        .accessibilityIdentifier("conversation-jump-to-latest")
    }
}

private struct JumpToLatestSurfaceModifier: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .glassEffect(Glass.regular.interactive(), in: Circle())
                .shadow(color: Color.black.opacity(0.12), radius: 10, x: 0, y: 4)
        } else {
            content
                .background(.ultraThinMaterial, in: Circle())
                .background(EmberDesignTokens.chatPaper.opacity(0.82), in: Circle())
                .overlay {
                    Circle().strokeBorder(EmberDesignTokens.chatHairline, lineWidth: 0.75)
                }
                .shadow(color: Color.black.opacity(0.12), radius: 10, x: 0, y: 4)
        }
    }
}

private struct TimelineScrollRequest: Equatable {
    let id = UUID()
    let animated: Bool
}

@available(iOS 18.0, *)
private struct ModernScrollPositionModifier: ViewModifier {
    let scrollRequest: TimelineScrollRequest?

    @State private var scrollPosition = ScrollPosition(idType: String.self)

    func body(content: Content) -> some View {
        content
            .scrollPosition($scrollPosition)
            .onChange(of: scrollRequest) { _, request in
                guard let request else { return }
                if request.animated {
                    withAnimation(.smooth(duration: 0.42)) {
                        scrollPosition.scrollTo(edge: .bottom)
                    }
                } else {
                    var transaction = Transaction()
                    transaction.disablesAnimations = true
                    withTransaction(transaction) {
                        scrollPosition.scrollTo(edge: .bottom)
                    }
                }
            }
    }
}

private struct LegacyTimelineContentBoundsModifier: ViewModifier {
    let coordinateSpaceName: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
        } else {
            content.background(
                GeometryReader { contentProxy in
                    Color.clear.preference(
                        key: TimelineContentBoundsPreferenceKey.self,
                        value: TimelineContentBounds(
                            minY: contentProxy.frame(in: .named(coordinateSpaceName)).minY,
                            height: contentProxy.size.height
                        ).quantized()
                    )
                }
            )
        }
    }
}

private struct TimelineScrollGeometryObserverModifier: ViewModifier {
    let coordinateSpaceName: String
    let scrollRequest: TimelineScrollRequest?
    let onMetrics: (ConversationTimelineViewportMetrics) -> Void
    let onLegacyContentBounds: (TimelineContentBounds) -> Void
    let onLegacyViewportBounds: (TimelineViewportBounds) -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .modifier(ModernScrollPositionModifier(scrollRequest: scrollRequest))
                .onScrollGeometryChange(for: ConversationTimelineViewportMetrics.self) { geometry in
                    ConversationTimelineViewportMetrics(
                        contentMinY: -(geometry.contentOffset.y + geometry.contentInsets.top),
                        contentHeight: geometry.contentSize.height,
                        viewportWidth: geometry.containerSize.width,
                        viewportHeight: geometry.containerSize.height,
                        topInset: 0,
                        bottomInset: 0
                    ).quantized()
                } action: { _, newMetrics in
                    onMetrics(newMetrics)
                }
        } else {
            content
                .background(
                    GeometryReader { viewportProxy in
                        let frame = viewportProxy.frame(in: .named(coordinateSpaceName))
                        Color.clear.preference(
                            key: TimelineViewportBoundsPreferenceKey.self,
                            value: TimelineViewportBounds(
                                width: viewportProxy.size.width,
                                height: frame.maxY,
                                topInset: max(0, frame.minY),
                                bottomInset: 0
                            ).quantized()
                        )
                    }
                )
                .onPreferenceChange(TimelineContentBoundsPreferenceKey.self) { newBounds in
                    guard let newBounds else { return }
                    onLegacyContentBounds(newBounds)
                }
                .onPreferenceChange(TimelineViewportBoundsPreferenceKey.self) { newBounds in
                    guard let newBounds else { return }
                    onLegacyViewportBounds(newBounds)
                }
        }
    }
}

private struct TimelineContentBounds: Equatable {
    let minY: CGFloat
    let height: CGFloat

    func quantized(step: CGFloat = 0.5) -> Self {
        func quantize(_ value: CGFloat) -> CGFloat {
            guard value.isFinite, step > 0 else { return 0 }
            return (value / step).rounded() * step
        }
        return Self(minY: quantize(minY), height: quantize(height))
    }
}

private struct TimelineViewportBounds: Equatable {
    let width: CGFloat
    let height: CGFloat
    let topInset: CGFloat
    let bottomInset: CGFloat

    func quantized(step: CGFloat = 0.5) -> Self {
        func quantize(_ value: CGFloat) -> CGFloat {
            guard value.isFinite, step > 0 else { return 0 }
            return (value / step).rounded() * step
        }
        return Self(
            width: quantize(width),
            height: quantize(height),
            topInset: quantize(topInset),
            bottomInset: quantize(bottomInset)
        )
    }
}

private struct TimelineContentBoundsPreferenceKey: PreferenceKey {
    static let defaultValue: TimelineContentBounds? = nil

    static func reduce(value: inout TimelineContentBounds?, nextValue: () -> TimelineContentBounds?) {
        value = nextValue() ?? value
    }
}

private struct TimelineViewportBoundsPreferenceKey: PreferenceKey {
    static let defaultValue: TimelineViewportBounds? = nil

    static func reduce(value: inout TimelineViewportBounds?, nextValue: () -> TimelineViewportBounds?) {
        value = nextValue() ?? value
    }
}
