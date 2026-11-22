import CoreGraphics
import Foundation

/// Viewport and scroll-content measurements captured from `ConversationTimelineView`
/// in the scroll view's named coordinate space.
struct ConversationTimelineViewportMetrics: Equatable, Sendable {
    var contentMinY: CGFloat
    var contentHeight: CGFloat
    var viewportWidth: CGFloat
    var viewportHeight: CGFloat
    var topInset: CGFloat
    var bottomInset: CGFloat

    /// Y coordinate of the visible bottom edge above the composer/keyboard safe-area inset.
    var visibleBottomY: CGFloat {
        max(0, viewportHeight - bottomInset)
    }

    /// Y coordinate of the bottom edge of the scrollable transcript content.
    var contentMaxY: CGFloat {
        contentMinY + contentHeight
    }

    /// How many points of transcript content currently extend below the visible bottom edge.
    var distanceFromBottom: CGFloat {
        max(0, contentMaxY - visibleBottomY)
    }

    /// Distance scrolled downward from the top of the transcript (increases as user scrolls down).
    var scrollOffset: CGFloat {
        topInset - contentMinY
    }

    /// Rounds coordinates to avoid sub-pixel layout noise triggering redundant SwiftUI state updates.
    func quantized(step: CGFloat = 0.5) -> Self {
        func quantize(_ value: CGFloat) -> CGFloat {
            guard value.isFinite, step > 0 else { return 0 }
            return (value / step).rounded() * step
        }
        return Self(
            contentMinY: quantize(contentMinY),
            contentHeight: quantize(contentHeight),
            viewportWidth: quantize(viewportWidth),
            viewportHeight: quantize(viewportHeight),
            topInset: quantize(topInset),
            bottomInset: quantize(bottomInset)
        )
    }
}

/// Scroll action emitted by `ConversationTimelineScrollState`.
enum ConversationTimelineScrollDirective: Equatable, Sendable {
    case none
    case scrollToBottom(animated: Bool)
}

/// Narrow projection of `ConversationScreenState` containing only the properties
/// that should participate in smart conversation scrolling.
struct ConversationTimelineScrollSnapshot: Equatable, Sendable {
    let isLoading: Bool
    let entryIDs: [String]
    let lastUserEntryID: String?
    let replyState: ConversationReplyState
    let isSubmitting: Bool
    let streamingReplyText: String?

    var hasContent: Bool {
        !entryIDs.isEmpty
    }

    var persistentEntryIDs: [String] {
        entryIDs.filter { id in
            id != "conversation-message-user-pending" && id != "conversation-streaming-reply"
        }
    }

    init(
        isLoading: Bool,
        entryIDs: [String],
        lastUserEntryID: String?,
        replyState: ConversationReplyState,
        isSubmitting: Bool,
        streamingReplyText: String?
    ) {
        self.isLoading = isLoading
        self.entryIDs = entryIDs
        self.lastUserEntryID = lastUserEntryID
        self.replyState = replyState
        self.isSubmitting = isSubmitting
        self.streamingReplyText = streamingReplyText
    }

    init(state: ConversationScreenState) {
        self.isLoading = state.isLoading
        self.entryIDs = state.timeline.map(\.id)
        self.lastUserEntryID = state.timeline.last { entry in
            if case .message(let message) = entry {
                return message.author == .user
            }
            return false
        }?.id
        self.replyState = state.replyState
        self.isSubmitting = state.isSubmitting
        self.streamingReplyText = state.streamingReplyText
    }
}

/// Tracks whether the conversation transcript should follow new content at the bottom
/// or preserve the user's manual reading position, and controls "Jump to latest" visibility.
struct ConversationTimelineScrollState: Equatable, Sendable {
    struct Configuration: Equatable, Sendable {
        var unfollowOffsetDeltaThreshold: CGFloat = 3
        var unfollowDistanceThreshold: CGFloat = 18
        var refollowDistanceThreshold: CGFloat = 10
        var jumpToLatestDistanceThreshold: CGFloat = 48
        var settledBottomTolerance: CGFloat = 2
        var programmaticUpwardInterruptThreshold: CGFloat = 6
    }

    let config: Configuration
    private(set) var isFollowingBottom: Bool = true
    private(set) var isProgrammaticScrollToBottom: Bool = false
    private(set) var isAnimatedProgrammaticScroll: Bool = false
    private(set) var hasPerformedInitialPositioning: Bool = false
    private(set) var latestMetrics: ConversationTimelineViewportMetrics?
    private var programmaticScrollBestDistance: CGFloat?

    init(config: Configuration = Configuration()) {
        self.config = config
    }

    /// Whether the floating "Jump to latest" control should be shown.
    func showsJumpToLatest(hasContent: Bool) -> Bool {
        guard hasContent,
              !isFollowingBottom,
              !isProgrammaticScrollToBottom,
              let latestMetrics else {
            return false
        }
        return latestMetrics.distanceFromBottom > config.jumpToLatestDistanceThreshold
    }

    /// Handles initial appearance and re-appearance (e.g., returning from Task Detail or tab switches).
    mutating func handleAppear(hasContent: Bool) -> ConversationTimelineScrollDirective {
        if !hasPerformedInitialPositioning {
            guard hasContent else { return .none }
            hasPerformedInitialPositioning = true
            isFollowingBottom = true
            beginProgrammaticScrollToBottom()
            return .scrollToBottom(animated: false)
        }

        if isFollowingBottom,
           hasContent,
           (latestMetrics?.distanceFromBottom ?? 0) > config.settledBottomTolerance {
            beginProgrammaticScrollToBottom()
            return .scrollToBottom(animated: false)
        }

        return .none
    }

    /// Re-anchors to the bottom when returning to the active foreground if following is enabled.
    mutating func handleBecameActive(hasContent: Bool) -> ConversationTimelineScrollDirective {
        guard hasPerformedInitialPositioning,
              isFollowingBottom,
              hasContent,
              (latestMetrics?.distanceFromBottom ?? 0) > config.settledBottomTolerance else {
            return .none
        }
        beginProgrammaticScrollToBottom()
        return .scrollToBottom(animated: false)
    }

    /// Handles timeline, streaming, submission, loading, and conversation-switch transitions.
    mutating func handleStateChange(
        from old: ConversationTimelineScrollSnapshot,
        to new: ConversationTimelineScrollSnapshot,
        reduceMotion: Bool
    ) -> ConversationTimelineScrollDirective {
        guard old != new else { return .none }

        if !new.hasContent {
            if old.hasContent {
                isFollowingBottom = true
                finishProgrammaticScroll()
                hasPerformedInitialPositioning = false
            }
            return .none
        }

        let oldPersistent = Set(old.persistentEntryIDs)
        let newPersistent = Set(new.persistentEntryIDs)
        if !oldPersistent.isEmpty && !newPersistent.isEmpty && oldPersistent.isDisjoint(with: newPersistent) {
            isFollowingBottom = true
            hasPerformedInitialPositioning = true
            beginProgrammaticScrollToBottom()
            return .scrollToBottom(animated: false)
        }

        if !hasPerformedInitialPositioning || (!old.hasContent && new.hasContent) || (old.isLoading && !new.isLoading) {
            hasPerformedInitialPositioning = true
            if isFollowingBottom {
                beginProgrammaticScrollToBottom()
                return .scrollToBottom(animated: false)
            }
            return .none
        }

        let replacedPendingUserMessage = old.lastUserEntryID == "conversation-message-user-pending"
            && new.lastUserEntryID != nil
            && new.lastUserEntryID != "conversation-message-user-pending"
            && !new.entryIDs.contains("conversation-message-user-pending")
        let revertedToExistingUserMessage = new.lastUserEntryID.map { oldPersistent.contains($0) } ?? false
        let newUserMessageAppeared = new.lastUserEntryID != nil
            && new.lastUserEntryID != old.lastUserEntryID
            && !replacedPendingUserMessage
            && !revertedToExistingUserMessage
        // ConversationDemoHost sets `isSubmitting = true` while stopping a reply too;
        // only treat `isSubmitting` as a new send when not already generating.
        let startedSubmittingNewTurn = !old.isSubmitting && new.isSubmitting
            && old.replyState != .generating && new.replyState != .generating

        if newUserMessageAppeared || startedSubmittingNewTurn {
            let shouldAnimate = !reduceMotion
            isFollowingBottom = true
            beginProgrammaticScrollToBottom(animated: shouldAnimate)
            return .scrollToBottom(animated: shouldAnimate)
        }

        guard isFollowingBottom else {
            return .none
        }

        if new.streamingReplyText != old.streamingReplyText,
           let streaming = new.streamingReplyText,
           !streaming.isEmpty {
            beginProgrammaticScrollToBottom()
            return .scrollToBottom(animated: false)
        }

        if new.entryIDs.last != old.entryIDs.last || new.entryIDs.count > old.entryIDs.count {
            let animate = !reduceMotion && new.replyState != .generating && old.streamingReplyText == nil
            beginProgrammaticScrollToBottom(animated: animate)
            return .scrollToBottom(animated: animate)
        }

        if new.replyState != old.replyState {
            switch new.replyState {
            case .generating, .failed:
                beginProgrammaticScrollToBottom()
                return .scrollToBottom(animated: false)
            case .idle:
                return .none
            }
        }

        return .none
    }

    /// Evaluates viewport and content geometry changes to detect user scroll intent vs layout growth.
    mutating func handleMetricsChange(
        _ newMetrics: ConversationTimelineViewportMetrics,
        hasContent: Bool,
        dynamicTypeChanged: Bool = false
    ) -> ConversationTimelineScrollDirective {
        guard newMetrics.viewportHeight > 0, newMetrics.viewportWidth > 0 else {
            return .none
        }

        guard let old = latestMetrics else {
            latestMetrics = newMetrics
            if hasContent,
               isFollowingBottom,
               newMetrics.distanceFromBottom > config.settledBottomTolerance {
                beginProgrammaticScrollToBottom(initialDistance: newMetrics.distanceFromBottom)
                return .scrollToBottom(animated: false)
            }
            if newMetrics.distanceFromBottom <= config.settledBottomTolerance {
                finishProgrammaticScroll()
            }
            return .none
        }

        latestMetrics = newMetrics

        guard hasContent else {
            finishProgrammaticScroll()
            return .none
        }

        let offsetDelta = newMetrics.scrollOffset - old.scrollOffset
        let contentHeightDelta = newMetrics.contentHeight - old.contentHeight
        let visibleBottomDelta = newMetrics.visibleBottomY - old.visibleBottomY
        let viewportWidthChanged = abs(newMetrics.viewportWidth - old.viewportWidth) > 1
        let newDistance = newMetrics.distanceFromBottom
        let oldDistance = old.distanceFromBottom
        let layoutGrowthDelta = max(0, contentHeightDelta) + max(0, -visibleBottomDelta)
        let unexplainedDistanceIncrease = (newDistance - oldDistance) - layoutGrowthDelta

        if isProgrammaticScrollToBottom, newDistance <= config.settledBottomTolerance {
            finishProgrammaticScroll()
        }

        if viewportWidthChanged || dynamicTypeChanged {
            if isFollowingBottom, newDistance > config.settledBottomTolerance {
                beginProgrammaticScrollToBottom(initialDistance: newDistance)
                return .scrollToBottom(animated: false)
            }
            return .none
        }

        if isProgrammaticScrollToBottom {
            // Adjust the best-distance watermark for content growth or viewport shrink so
            // streaming deltas or keyboard animations don't look like an upward drag.
            let adjustedBest = (programmaticScrollBestDistance ?? oldDistance) + layoutGrowthDelta
            let bestSoFar = min(adjustedBest, newDistance)
            programmaticScrollBestDistance = bestSoFar

            let movedAwayFromBest = newDistance - adjustedBest
            if newDistance > config.unfollowDistanceThreshold,
               (movedAwayFromBest > config.programmaticUpwardInterruptThreshold
                || (offsetDelta < -config.programmaticUpwardInterruptThreshold && unexplainedDistanceIncrease > 0.5)) {
                finishProgrammaticScroll()
                isFollowingBottom = false
                return .none
            }
            if !isAnimatedProgrammaticScroll,
               isFollowingBottom,
               (contentHeightDelta > 0.5 || visibleBottomDelta < -0.5),
               newDistance > config.settledBottomTolerance {
                return .scrollToBottom(animated: false)
            }
            return .none
        }

        if isFollowingBottom {
            let scrolledUpward = offsetDelta < -config.unfollowOffsetDeltaThreshold
                && newDistance > config.unfollowDistanceThreshold
            let gentleOrDetachedUpwardScroll = newDistance > config.unfollowDistanceThreshold
                && unexplainedDistanceIncrease > 0.5

            if scrolledUpward || gentleOrDetachedUpwardScroll {
                isFollowingBottom = false
                return .none
            }

            if newDistance > config.settledBottomTolerance,
               (contentHeightDelta > 0.5 || visibleBottomDelta < -0.5) {
                beginProgrammaticScrollToBottom(initialDistance: newDistance)
                return .scrollToBottom(animated: false)
            }

            return .none
        } else {
            if newDistance <= config.refollowDistanceThreshold {
                isFollowingBottom = true
            }
            return .none
        }
    }

    /// Re-enables bottom following and returns a scroll directive when the user taps "Jump to latest".
    mutating func handleJumpToLatestTap(reduceMotion: Bool) -> ConversationTimelineScrollDirective {
        let shouldAnimate = !reduceMotion
        isFollowingBottom = true
        beginProgrammaticScrollToBottom(animated: shouldAnimate)
        return .scrollToBottom(animated: shouldAnimate)
    }

    /// Clears the in-flight programmatic scroll guard after a scroll completes or times out.
    mutating func finishProgrammaticScroll() {
        isProgrammaticScrollToBottom = false
        isAnimatedProgrammaticScroll = false
        programmaticScrollBestDistance = nil
    }

    private mutating func beginProgrammaticScrollToBottom(
        animated: Bool = false,
        initialDistance: CGFloat? = nil
    ) {
        isProgrammaticScrollToBottom = true
        isAnimatedProgrammaticScroll = animated
        programmaticScrollBestDistance = initialDistance ?? latestMetrics?.distanceFromBottom
    }
}
