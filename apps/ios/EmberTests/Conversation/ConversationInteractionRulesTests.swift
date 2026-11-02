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
}
