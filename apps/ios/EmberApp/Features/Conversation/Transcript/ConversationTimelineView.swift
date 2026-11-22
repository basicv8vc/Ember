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

                if let deliveryNote = message.deliveryNote {
                    Text(deliveryNote)
                        .font(.caption2)
                        .foregroundStyle(isUser ? Color.white.opacity(0.85) : Color.secondary)
                } else if let timestamp = message.timestamp {
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
            .opacity(message.deliveryNote != nil ? 0.85 : 1.0)
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
        .accessibilityIdentifier(
            message.accessibilityIdentifierOverride ?? (isUser ? "conversation-message-user" : "conversation-message-ember")
        )
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
                .background(EmberDesignTokens.cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
                }
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
                } else if let onDismissError {
                    Button(action: onDismissError) {
                        Image(systemName: "xmark")
                            .font(.caption.weight(.semibold))
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
                .background(EmberDesignTokens.cardBackground.opacity(0.65), in: Circle())
                .overlay {
                    Circle().strokeBorder(EmberDesignTokens.separator, lineWidth: 0.75)
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
                        contentMinY: -geometry.visibleRect.minY,
                        contentHeight: geometry.contentSize.height,
                        viewportWidth: geometry.visibleRect.width,
                        viewportHeight: geometry.visibleRect.height,
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
