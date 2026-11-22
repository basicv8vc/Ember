import XCTest
@testable import Ember

final class ConversationInteractionRulesTests: XCTestCase {
    func testWhitespaceOnlyDraftDoesNotProduceSubmission() {
        XCTAssertNil(ConversationInteractionRules.submission(for: " \n\t ", isGenerating: false))
        XCTAssertNil(ConversationInteractionRules.submission(for: "Follow up", isGenerating: true))
    }

    func testSubmissionPreservesExactDraftAndClearsAndUnfocusesComposer() throws {
        let draft = "  first line\nsecond line  "
        let submission = try XCTUnwrap(
            ConversationInteractionRules.submission(for: draft, isGenerating: false)
        )

        XCTAssertEqual(submission.message, draft)
        XCTAssertEqual(submission.draftAfterSubmission, "")
        XCTAssertFalse(submission.composerShouldFocusAfterSubmission)
    }

    func testSuggestedPromptOnlyPopulatesDraft() {
        let prompt = "Help me think this through."

        XCTAssertEqual(ConversationInteractionRules.promptSelection(prompt), .populateDraft(prompt))
    }

    func testStopActionOnlyTargetsTheLocalMockReply() {
        XCTAssertEqual(ConversationInteractionRules.stopAction(for: .generating), .stopMockReply)
        XCTAssertNil(ConversationInteractionRules.stopAction(for: .idle))
        XCTAssertNil(
            ConversationInteractionRules.stopAction(for: .failed(message: "Try again", retryable: true))
        )
    }

    func testRetryActionIsOnlyAvailableForRetryableFailures() {
        XCTAssertEqual(
            ConversationInteractionRules.retryAction(
                for: .failed(message: "Try again", retryable: true)
            ),
            .retryMockReply
        )
        XCTAssertNil(
            ConversationInteractionRules.retryAction(
                for: .failed(message: "Not retryable", retryable: false)
            )
        )
        XCTAssertNil(ConversationInteractionRules.retryAction(for: .generating))
        XCTAssertNil(ConversationInteractionRules.retryAction(for: .idle))
    }

    func testInsertingStarterPromptPopulatesEmptyDraftAndAppendsWithoutOverwriting() {
        let starter = "Turn these notes into clear, prioritized action items."

        XCTAssertEqual(
            ConversationInteractionRules.insertingStarterPrompt(starter, into: "  \n "),
            starter
        )
        XCTAssertEqual(
            ConversationInteractionRules.insertingStarterPrompt(starter, into: "Weekly sync:"),
            "Weekly sync:\n\n\(starter)"
        )
        XCTAssertEqual(
            ConversationInteractionRules.insertingStarterPrompt(starter, into: "Weekly sync:\n\n\(starter)"),
            "Weekly sync:\n\n\(starter)"
        )
    }

    func testTrailingActionFollowsSendStopStateTable() {
        // Idle, empty or whitespace-only draft -> disabled Send
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: " \n\t ",
                replyState: .idle,
                isSubmitting: false
            ),
            .send(isEnabled: false)
        )

        // Idle, nonempty valid draft -> enabled Send
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: "Summarize this week",
                replyState: .idle,
                isSubmitting: false
            ),
            .send(isEnabled: true)
        )

        // Submitting message -> disabled/pending action; avoid premature cancellation
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: "Follow up",
                replyState: .idle,
                isSubmitting: true
            ),
            .submitting
        )
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: "",
                replyState: .generating,
                isSubmitting: true
            ),
            .submitting
        )

        // Generating reply -> Stop (both with empty draft and nonempty draft)
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: "",
                replyState: .generating,
                isSubmitting: false
            ),
            .stop(isEnabled: true)
        )
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: "Draft typed during reply",
                replyState: .generating,
                isSubmitting: false
            ),
            .stop(isEnabled: true)
        )

        // Stopping in progress -> disabled Stop to prevent duplicate cancel requests
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: "Draft typed during reply",
                replyState: .generating,
                isSubmitting: false,
                isStopping: true
            ),
            .stop(isEnabled: false)
        )

        // Reply completed / cancelled / failed -> return to appropriate Send state
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: "Draft typed during reply",
                replyState: .idle,
                isSubmitting: false
            ),
            .send(isEnabled: true)
        )
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: "Draft typed during reply",
                replyState: .failed(message: "Interrupted", retryable: true),
                isSubmitting: false
            ),
            .send(isEnabled: true)
        )

        // Upload in progress -> respect upload/send restrictions
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: "Analyze file",
                replyState: .idle,
                isSubmitting: false,
                isUploadingAttachment: true
            ),
            .send(isEnabled: false)
        )

        // Historical conversation loading -> never expose misleading Stop
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: "Hello",
                replyState: .generating,
                isSubmitting: false,
                isLoading: true
            ),
            .send(isEnabled: false)
        )
        XCTAssertEqual(
            ConversationInteractionRules.trailingAction(
                for: "",
                replyState: .idle,
                isSubmitting: false,
                isLoading: true
            ),
            .send(isEnabled: false)
        )
    }

    func testComposerNoteShownOnlyForNonLoadingEmptyTimeline() {
        XCTAssertTrue(ConversationInteractionRules.shouldShowComposerNote(timelineIsEmpty: true, isLoading: false))
        XCTAssertFalse(ConversationInteractionRules.shouldShowComposerNote(timelineIsEmpty: true, isLoading: true))
        XCTAssertFalse(ConversationInteractionRules.shouldShowComposerNote(timelineIsEmpty: false, isLoading: false))
        XCTAssertFalse(ConversationInteractionRules.shouldShowComposerNote(timelineIsEmpty: false, isLoading: true))
    }

    func testAttachmentPopoverLayoutClampsWidthAndHeightWithinNarrowAndKeyboardViewports() {
        XCTAssertEqual(ConversationAttachmentPopoverLayout.menuWidth(for: 320), 272)
        XCTAssertEqual(ConversationAttachmentPopoverLayout.menuWidth(for: 393), 272)
        XCTAssertEqual(ConversationAttachmentPopoverLayout.menuWidth(for: 280), 252)

        // Standard 320pt screen: stays inside 14pt horizontal margins
        let rect320 = ConversationAttachmentPopoverLayout.destinationRect(
            sourceRect: CGRect(x: 14, y: 490, width: 42, height: 42),
            measuredMenuSize: CGSize(width: 272, height: 300),
            containerSize: CGSize(width: 320, height: 548)
        )
        XCTAssertEqual(rect320.width, 272)
        XCTAssertGreaterThanOrEqual(rect320.minX, 14)
        XCTAssertLessThanOrEqual(rect320.maxX, 320 - 14)
        XCTAssertGreaterThanOrEqual(rect320.minY, 12)
        XCTAssertLessThanOrEqual(rect320.maxY, 548 - 8)

        // Keyboard open + large Dynamic Type on compact 320pt viewport: clamps height inside available space
        let rectKeyboard = ConversationAttachmentPopoverLayout.destinationRect(
            sourceRect: CGRect(x: 14, y: 210, width: 42, height: 42),
            measuredMenuSize: CGSize(width: 272, height: 420),
            containerSize: CGSize(width: 320, height: 260)
        )
        XCTAssertEqual(rectKeyboard.width, 272)
        XCTAssertGreaterThanOrEqual(rectKeyboard.minY, 12)
        XCTAssertLessThanOrEqual(rectKeyboard.maxY, 260 - 8)
        XCTAssertEqual(rectKeyboard.height, 260 - 12 - 8)
    }
}
