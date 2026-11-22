import XCTest

@MainActor
final class ConversationComposerErgonomicsUITests: XCTestCase {
    func testSendStopDraftPreservationAndTouchTargetsInConversation() {
        let app = XCUIApplication()
        launch(app, arguments: ["--ember-start-conversation", "--ember-mock-slow-reply"])

        let timeline = app.scrollViews["conversation-timeline"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 10))

        // Active conversation hides persistent composer footnote.
        XCTAssertFalse(app.staticTexts["conversation-composer-note"].exists)

        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        let sendButton = app.buttons["conversation-send"]
        XCTAssertTrue(sendButton.waitForExistence(timeout: 5))

        // 1. Empty / whitespace draft does not enable Send.
        XCTAssertFalse(sendButton.isEnabled)
        XCTAssertGreaterThanOrEqual(sendButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(sendButton.frame.height, 44)

        // 2. Scroll up away from bottom so Jump to Latest appears, then send a message.
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        composer.typeText("   ")
        XCTAssertFalse(sendButton.isEnabled, "Whitespace-only draft must not enable Send.")

        // 3. Valid draft sends once and transitions composer to Stop.
        let firstMessage = "Verify composer stop flow"
        composer.typeText(firstMessage)
        XCTAssertTrue(sendButton.isEnabled)
        sendButton.tap()

        let stopButton = app.buttons["conversation-composer-stop"]
        XCTAssertTrue(stopButton.waitForExistence(timeout: 5), "Generating reply must expose Stop inside Composer.")
        XCTAssertTrue(stopButton.isHittable)
        XCTAssertGreaterThanOrEqual(stopButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(stopButton.frame.height, 44)

        // 4. Scroll up while generating and type a follow-up draft: Stop remains visible and draft is preserved.
        timeline.swipeDown()
        composer.tap()
        let preservedDraft = "Follow-up draft kept after stop"
        composer.typeText(preservedDraft)

        XCTAssertTrue(stopButton.exists, "Stop must remain visible while user types a draft during generation.")
        XCTAssertTrue(stopButton.isHittable)
        XCTAssertFalse(sendButton.exists, "Send must not fire while generation exposes Stop.")

        // 5. Tapping Stop halts generation, keeps draft, does not submit draft, and restores Send.
        stopButton.tap()

        XCTAssertTrue(sendButton.waitForExistence(timeout: 5), "Normal Send state must return after stopping.")
        XCTAssertTrue(sendButton.isEnabled, "Preserved non-empty draft must immediately re-enable Send.")

        let draftValue = composer.value as? String ?? ""
        XCTAssertTrue(
            draftValue.contains(preservedDraft),
            "Stopping generation must preserve the user's typed draft. Got: \(draftValue)"
        )

        let unsubmittedBubbles = timeline.staticTexts
            .matching(identifier: "conversation-message-user")
            .matching(NSPredicate(format: "label CONTAINS %@", preservedDraft))
        XCTAssertEqual(unsubmittedBubbles.count, 0, "Stopping generation must never submit the draft.")

        // 6. Now send the preserved draft and verify it arrives cleanly.
        sendButton.tap()
        let submittedFollowUp = timeline.staticTexts
            .matching(identifier: "conversation-message-user")
            .matching(NSPredicate(format: "label CONTAINS %@", preservedDraft))
            .firstMatch
        XCTAssertTrue(submittedFollowUp.waitForExistence(timeout: 10))
    }

    func testAttachmentMenuAndTouchTargetsStayWithinBoundsAndPreserveDraft() {
        let app = XCUIApplication()
        launch(app, arguments: ["--ember-mock-chat-tasks", "--ember-mock-chat-tasks-reset"])

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.staticTexts["conversation-composer-note"].exists)

        let attachButton = app.buttons["conversation-attach-file"]
        let sendButton = app.buttons["conversation-send"]
        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(attachButton.waitForExistence(timeout: 10))
        XCTAssertTrue(sendButton.waitForExistence(timeout: 10))
        XCTAssertTrue(composer.waitForExistence(timeout: 10))

        XCTAssertGreaterThanOrEqual(attachButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(attachButton.frame.height, 44)
        XCTAssertGreaterThanOrEqual(sendButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(sendButton.frame.height, 44)

        // Type draft and verify keyboard opens, then open attachment menu with keyboard visible.
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        composer.typeText("Keep my draft")

        let attachForTap = app.buttons["conversation-attach-file"]
        XCTAssertTrue(attachForTap.waitForExistence(timeout: 5))
        attachForTap.tap()
        let menu = app.descendants(matching: .any)["conversation-attachment-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 5))
        attachScreenshot(app: app, name: "ux04-pr2-keyboard-attachment-menu")

        let window = app.windows.firstMatch
        XCTAssertLessThanOrEqual(menu.frame.width, 272.5)
        XCTAssertGreaterThanOrEqual(menu.frame.minX, 8)
        XCTAssertLessThanOrEqual(menu.frame.maxX, window.frame.width - 8)
        XCTAssertGreaterThanOrEqual(menu.frame.minY, 8)
        XCTAssertLessThanOrEqual(menu.frame.maxY, window.frame.height - 8)

        // Dismiss attachment menu and confirm draft is preserved.
        let dismissBackdrop = app.buttons["conversation-attachment-menu-dismiss"]
        XCTAssertTrue(dismissBackdrop.waitForExistence(timeout: 5))
        dismissBackdrop.tap()

        let dismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: menu
        )
        wait(for: [dismissed], timeout: 5)
        XCTAssertEqual(composer.value as? String, "Keep my draft")
        attachScreenshot(app: app, name: "ux04-pr2-keyboard-open")

        // Dismiss keyboard interactively by dragging timeline down.
        let timeline = app.scrollViews["conversation-timeline"]
        timeline.swipeDown()
    }

    func testSendReturnsToNormalStateAfterNaturalCompletionAndMultilineWorksInZhHansDarkAX() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-start-conversation",
            "-AppleLanguages", "(zh-Hans)",
            "-AppleLocale", "zh_Hans",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityLarge",
            "-UIUserInterfaceStyle", "dark",
        ]
        app.launch()

        let timeline = app.scrollViews["conversation-timeline"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["conversation-composer-note"].exists)

        let composer = app.textFields["conversation-composer-input"]
        let sendButton = app.buttons["conversation-send"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertTrue(sendButton.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(sendButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(sendButton.frame.height, 44)

        let initialReplies = timeline.staticTexts.matching(identifier: "conversation-message-ember").count

        composer.tap()
        composer.typeText("Please organize today's top priorities into three clear next steps and flag any blockers before noon.")
        XCTAssertTrue(sendButton.isEnabled)
        sendButton.tap()

        let expectedReplyCount = initialReplies + 1
        let replyAppeared = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "count >= %d", expectedReplyCount),
            object: timeline.staticTexts.matching(identifier: "conversation-message-ember")
        )
        wait(for: [replyAppeared], timeout: 10)
        XCTAssertTrue(sendButton.waitForExistence(timeout: 5), "Normal Send control must return after reply finishes.")
        XCTAssertFalse(sendButton.isEnabled)
    }

    private func launch(_ app: XCUIApplication, arguments: [String]) {
        app.launchArguments = arguments + [
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US"
        ]
        app.launch()
    }

    private func attachScreenshot(app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
