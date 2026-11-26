import XCTest
@testable import Ember

final class ConversationTimelineScrollStateTests: XCTestCase {
    private func makeMetrics(
        contentMinY: CGFloat = -600,
        contentHeight: CGFloat = 1200,
        viewportWidth: CGFloat = 393,
        viewportHeight: CGFloat = 700,
        topInset: CGFloat = 0,
        bottomInset: CGFloat = 100
    ) -> ConversationTimelineViewportMetrics {
        ConversationTimelineViewportMetrics(
            contentMinY: contentMinY,
            contentHeight: contentHeight,
            viewportWidth: viewportWidth,
            viewportHeight: viewportHeight,
            topInset: topInset,
            bottomInset: bottomInset
        )
    }

    private func makeSnapshot(
        isLoading: Bool = false,
        entryIDs: [String] = ["m1", "m2", "m3"],
        lastUserEntryID: String? = "m1",
        replyState: ConversationReplyState = .idle,
        isSubmitting: Bool = false,
        streamingReplyText: String? = nil
    ) -> ConversationTimelineScrollSnapshot {
        ConversationTimelineScrollSnapshot(
            isLoading: isLoading,
            entryIDs: entryIDs,
            lastUserEntryID: lastUserEntryID,
            replyState: replyState,
            isSubmitting: isSubmitting,
            streamingReplyText: streamingReplyText
        )
    }

    func testInitialPositioningScrollsOnceWhenContentExistsOrAfterAsyncLoad() {
        var state = ConversationTimelineScrollState()

        // Preloaded timeline on appear scrolls immediately without animation.
        XCTAssertEqual(state.handleAppear(hasContent: true), .scrollToBottom(animated: false))
        XCTAssertTrue(state.hasPerformedInitialPositioning)
        XCTAssertTrue(state.isFollowingBottom)

        // Async load path: appear while loading waits until content arrives.
        var asyncState = ConversationTimelineScrollState()
        let loading = makeSnapshot(isLoading: true, entryIDs: [], lastUserEntryID: nil)
        let loaded = makeSnapshot(isLoading: false, entryIDs: ["m1", "m2"], lastUserEntryID: "m1")

        XCTAssertEqual(asyncState.handleAppear(hasContent: false), .none)
        XCTAssertFalse(asyncState.hasPerformedInitialPositioning)

        XCTAssertEqual(
            asyncState.handleStateChange(from: loading, to: loaded, reduceMotion: false),
            .scrollToBottom(animated: false)
        )
        XCTAssertTrue(asyncState.hasPerformedInitialPositioning)
        XCTAssertTrue(asyncState.isFollowingBottom)
    }

    func testStreamingDeltasFollowWithoutAnimationWhenNearBottom() {
        var state = ConversationTimelineScrollState()
        _ = state.handleAppear(hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1200), hasContent: true)

        let beforeDelta = makeSnapshot(
            entryIDs: ["m1", "conversation-streaming-reply"],
            lastUserEntryID: "m1",
            replyState: .generating,
            streamingReplyText: "Hello"
        )
        let afterDelta = makeSnapshot(
            entryIDs: ["m1", "conversation-streaming-reply"],
            lastUserEntryID: "m1",
            replyState: .generating,
            streamingReplyText: "Hello world, here is more text"
        )

        XCTAssertEqual(
            state.handleStateChange(from: beforeDelta, to: afterDelta, reduceMotion: false),
            .scrollToBottom(animated: false)
        )
        XCTAssertTrue(state.isFollowingBottom)

        // Layout growth from the wrapped delta also triggers non-animated follow.
        XCTAssertEqual(
            state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1244), hasContent: true),
            .scrollToBottom(animated: false)
        )
        XCTAssertFalse(state.showsJumpToLatest(hasContent: true))
    }

    func testIntentionalUpwardScrollStopsFollowingAndShowsJumpToLatest() {
        var state = ConversationTimelineScrollState()
        _ = state.handleAppear(hasContent: true)
        // Settled at bottom: contentMaxY = -600 + 1200 = 600 == visibleBottomY (700 - 100)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1200), hasContent: true)
        XCTAssertTrue(state.isFollowingBottom)
        XCTAssertFalse(state.showsJumpToLatest(hasContent: true))

        // User scrolls upward by 120pt (contentMinY moves from -600 -> -480)
        let scrollUpDirective = state.handleMetricsChange(
            makeMetrics(contentMinY: -480, contentHeight: 1200),
            hasContent: true
        )
        XCTAssertEqual(scrollUpDirective, .none)
        XCTAssertFalse(state.isFollowingBottom)
        XCTAssertTrue(state.showsJumpToLatest(hasContent: true))

        // Subsequent streaming deltas, completion, and history additions must NOT pull user back down.
        let streaming1 = makeSnapshot(
            entryIDs: ["m1", "conversation-streaming-reply"],
            lastUserEntryID: "m1",
            replyState: .generating,
            streamingReplyText: "Part 1"
        )
        let streaming2 = makeSnapshot(
            entryIDs: ["m1", "conversation-streaming-reply"],
            lastUserEntryID: "m1",
            replyState: .generating,
            streamingReplyText: "Part 1 + Part 2"
        )
        XCTAssertEqual(state.handleStateChange(from: streaming1, to: streaming2, reduceMotion: false), .none)
        XCTAssertEqual(
            state.handleMetricsChange(makeMetrics(contentMinY: -480, contentHeight: 1340), hasContent: true),
            .none
        )

        let committed = makeSnapshot(
            entryIDs: ["m1", "m2"],
            lastUserEntryID: "m1",
            replyState: .idle,
            streamingReplyText: nil
        )
        XCTAssertEqual(state.handleStateChange(from: streaming2, to: committed, reduceMotion: false), .none)
        XCTAssertFalse(state.isFollowingBottom)
        XCTAssertTrue(state.showsJumpToLatest(hasContent: true))
    }

    func testManualScrollBackNearBottomResumesFollowingAndHidesJumpToLatest() {
        var state = ConversationTimelineScrollState()
        _ = state.handleAppear(hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1200), hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -450, contentHeight: 1200), hasContent: true)
        XCTAssertFalse(state.isFollowingBottom)
        XCTAssertTrue(state.showsJumpToLatest(hasContent: true))

        // User scrolls back down to within 6pt of bottom (contentMaxY = 606, visibleBottomY = 600)
        XCTAssertEqual(
            state.handleMetricsChange(makeMetrics(contentMinY: -594, contentHeight: 1200), hasContent: true),
            .none
        )
        XCTAssertTrue(state.isFollowingBottom)
        XCTAssertFalse(state.showsJumpToLatest(hasContent: true))
    }

    func testJumpToLatestTapScrollsAndReenablesFollowingRespectingReduceMotion() {
        var state = ConversationTimelineScrollState()
        _ = state.handleAppear(hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1200), hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -400, contentHeight: 1200), hasContent: true)
        XCTAssertTrue(state.showsJumpToLatest(hasContent: true))

        XCTAssertEqual(state.handleJumpToLatestTap(reduceMotion: false), .scrollToBottom(animated: true))
        XCTAssertTrue(state.isFollowingBottom)
        XCTAssertTrue(state.isAnimatedProgrammaticScroll)
        XCTAssertFalse(state.showsJumpToLatest(hasContent: true))

        // Intermediate animation frames scrolling downward and minor layout growth do not cancel
        // the animated glide by emitting an unanimated jump.
        XCTAssertEqual(
            state.handleMetricsChange(makeMetrics(contentMinY: -520, contentHeight: 1224), hasContent: true),
            .none
        )
        XCTAssertTrue(state.isFollowingBottom)

        // Settling at bottom clears programmatic flag.
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -624, contentHeight: 1224), hasContent: true)
        XCTAssertFalse(state.isProgrammaticScrollToBottom)
        XCTAssertFalse(state.isAnimatedProgrammaticScroll)

        // With Reduce Motion enabled, jump is non-animated.
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -400, contentHeight: 1224), hasContent: true)
        XCTAssertEqual(state.handleJumpToLatestTap(reduceMotion: true), .scrollToBottom(animated: false))
        XCTAssertFalse(state.isAnimatedProgrammaticScroll)
    }

    func testSendingNewMessageReenablesFollowingEvenWhenScrolledUp() {
        var state = ConversationTimelineScrollState()
        _ = state.handleAppear(hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1200), hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -350, contentHeight: 1200), hasContent: true)
        XCTAssertFalse(state.isFollowingBottom)

        let beforeSend = makeSnapshot(entryIDs: ["m1", "m2"], lastUserEntryID: "m1", isSubmitting: false)
        let afterSend = makeSnapshot(
            entryIDs: ["m1", "m2", "conversation-message-user-pending"],
            lastUserEntryID: "conversation-message-user-pending",
            isSubmitting: true
        )

        XCTAssertEqual(
            state.handleStateChange(from: beforeSend, to: afterSend, reduceMotion: false),
            .scrollToBottom(animated: true)
        )
        XCTAssertTrue(state.isFollowingBottom)
        XCTAssertFalse(state.showsJumpToLatest(hasContent: true))
    }

    func testStoppingReplyWhileScrolledUpDoesNotAutoScroll() {
        var state = ConversationTimelineScrollState()
        _ = state.handleAppear(hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1200), hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -350, contentHeight: 1200), hasContent: true)

        let generating = makeSnapshot(
            entryIDs: ["m1", "m2"],
            lastUserEntryID: "m1",
            replyState: .generating,
            isSubmitting: false
        )
        // ConversationDemoHost sets isSubmitting = true while isStoppingReply is true.
        let stopping = makeSnapshot(
            entryIDs: ["m1", "m2"],
            lastUserEntryID: "m1",
            replyState: .generating,
            isSubmitting: true
        )
        XCTAssertEqual(state.handleStateChange(from: generating, to: stopping, reduceMotion: false), .none)
        XCTAssertFalse(state.isFollowingBottom)
    }

    func testKeyboardPresentationRespectsFollowState() {
        // Following bottom -> keyboard shrinks visibleBottomY -> keep bottom visible.
        var followingState = ConversationTimelineScrollState()
        _ = followingState.handleAppear(hasContent: true)
        _ = followingState.handleMetricsChange(
            makeMetrics(contentMinY: -600, contentHeight: 1200, bottomInset: 100),
            hasContent: true
        )
        XCTAssertEqual(
            followingState.handleMetricsChange(
                makeMetrics(contentMinY: -600, contentHeight: 1200, bottomInset: 380),
                hasContent: true
            ),
            .scrollToBottom(animated: false)
        )
        XCTAssertTrue(followingState.isFollowingBottom)

        // Scrolled up -> keyboard opens -> preserve reading position.
        var detachedState = ConversationTimelineScrollState()
        _ = detachedState.handleAppear(hasContent: true)
        _ = detachedState.handleMetricsChange(
            makeMetrics(contentMinY: -600, contentHeight: 1200, bottomInset: 100),
            hasContent: true
        )
        _ = detachedState.handleMetricsChange(
            makeMetrics(contentMinY: -350, contentHeight: 1200, bottomInset: 100),
            hasContent: true
        )
        XCTAssertEqual(
            detachedState.handleMetricsChange(
                makeMetrics(contentMinY: -350, contentHeight: 1200, bottomInset: 380),
                hasContent: true
            ),
            .none
        )
        XCTAssertFalse(detachedState.isFollowingBottom)
    }

    func testConversationSwitchResetsToBottomAndReappearPreservesReadingPosition() {
        var state = ConversationTimelineScrollState()
        _ = state.handleAppear(hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1200), hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -350, contentHeight: 1200), hasContent: true)
        XCTAssertFalse(state.isFollowingBottom)

        // Navigating back or foregrounding while reading older messages preserves position.
        XCTAssertEqual(state.handleAppear(hasContent: true), .none)
        XCTAssertEqual(state.handleBecameActive(hasContent: true), .none)
        XCTAssertFalse(state.isFollowingBottom)

        // Switching to a completely different conversation resets to bottom.
        let convA = makeSnapshot(entryIDs: ["a1", "a2"], lastUserEntryID: "a1")
        let convB = makeSnapshot(entryIDs: ["b1", "b2"], lastUserEntryID: "b1")
        XCTAssertEqual(
            state.handleStateChange(from: convA, to: convB, reduceMotion: false),
            .scrollToBottom(animated: false)
        )
        XCTAssertTrue(state.isFollowingBottom)
    }

    func testUnrelatedStateUpdatesAndDynamicTypeDoNotFalselyUnfollow() {
        var state = ConversationTimelineScrollState()
        _ = state.handleAppear(hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1200), hasContent: true)

        let baseline = makeSnapshot(entryIDs: ["m1", "m2"], lastUserEntryID: "m1", replyState: .idle)
        XCTAssertEqual(state.handleStateChange(from: baseline, to: baseline, reduceMotion: false), .none)

        // Dynamic Type change while following stays following and re-anchors bottom.
        XCTAssertEqual(
            state.handleMetricsChange(
                makeMetrics(contentMinY: -550, contentHeight: 1350),
                hasContent: true,
                dynamicTypeChanged: true
            ),
            .scrollToBottom(animated: false)
        )
        XCTAssertTrue(state.isFollowingBottom)
    }

    func testGentle120HzUpwardDragUnfollowsAndLazyHeightShrinkAtBottomStaysFollowing() {
        var state = ConversationTimelineScrollState()
        _ = state.handleAppear(hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1200), hasContent: true)

        // LazyVStack shrinks estimated height by 43pt and clamps contentMinY to bottom -> stays following.
        XCTAssertEqual(
            state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1157), hasContent: true),
            .none
        )
        XCTAssertEqual(
            state.handleMetricsChange(makeMetrics(contentMinY: -557, contentHeight: 1157), hasContent: true),
            .none
        )
        XCTAssertTrue(state.isFollowingBottom)

        // Gentle 2pt/frame upward scroll (like 120Hz ProMotion thumb drag) unfollows once past threshold.
        for step in 1...10 {
            let minY = -557 + CGFloat(step * 2)
            _ = state.handleMetricsChange(makeMetrics(contentMinY: minY, contentHeight: 1157), hasContent: true)
        }
        XCTAssertFalse(state.isFollowingBottom)
    }

    func testPendingUserMessageAckReplacementWhileScrolledUpPreservesPosition() {
        var state = ConversationTimelineScrollState()
        _ = state.handleAppear(hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1200), hasContent: true)

        let beforeSend = makeSnapshot(entryIDs: ["m1"], lastUserEntryID: "m1", isSubmitting: false)
        let pendingSend = makeSnapshot(
            entryIDs: ["m1", "conversation-message-user-pending"],
            lastUserEntryID: "conversation-message-user-pending",
            isSubmitting: true
        )
        XCTAssertEqual(
            state.handleStateChange(from: beforeSend, to: pendingSend, reduceMotion: false),
            .scrollToBottom(animated: true)
        )

        // User settles at bottom, then intentionally scrolls up while waiting for ACK.
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -600, contentHeight: 1200), hasContent: true)
        _ = state.handleMetricsChange(makeMetrics(contentMinY: -350, contentHeight: 1200), hasContent: true)
        XCTAssertFalse(state.isFollowingBottom)

        // Server ACK replaces pending entry ID with persisted UUID -> must NOT yank user down.
        let acked = makeSnapshot(
            entryIDs: ["m1", "conversation-message-new-uuid"],
            lastUserEntryID: "conversation-message-new-uuid",
            replyState: .generating,
            isSubmitting: false
        )
        XCTAssertEqual(state.handleStateChange(from: pendingSend, to: acked, reduceMotion: false), .none)
        XCTAssertFalse(state.isFollowingBottom)
    }

    func testTimestampGroupingShowsDividersOnlyForFirstMessageGapOrDayChange() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!

        let day1Base = calendar.date(from: DateComponents(year: 2026, month: 11, day: 26, hour: 10, minute: 0))!
        let entries: [ConversationTimelineEntry] = [
            .message(ConversationMessagePresentation(id: "m1", author: .user, text: "hi", timestamp: day1Base)),
            .message(ConversationMessagePresentation(id: "m2", author: .ember, text: "hello", timestamp: day1Base.addingTimeInterval(30))),
            .message(ConversationMessagePresentation(id: "m3", author: .user, text: "quick follow-up", timestamp: day1Base.addingTimeInterval(10 * 60))),
            .message(ConversationMessagePresentation(id: "m4", author: .user, text: "later", timestamp: day1Base.addingTimeInterval(20 * 60))),
            .message(ConversationMessagePresentation(id: "m5", author: .ember, text: "next day", timestamp: day1Base.addingTimeInterval(24 * 60 * 60))),
        ]

        let dividerIDs = ConversationTimelineTimestampGrouping.dividerEntryIDs(for: entries, calendar: calendar)
        XCTAssertEqual(dividerIDs, Set(["m1", "m4", "m5"]))
    }
}
