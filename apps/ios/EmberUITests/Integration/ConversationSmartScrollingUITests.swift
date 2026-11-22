import XCTest

@MainActor
final class ConversationSmartScrollingUITests: XCTestCase {
    func testScrollUpShowsJumpToLatestWithoutCoveringComposerAndTapReturnsToBottom() {
        let app = XCUIApplication()
        launch(app, arguments: ["--ember-start-conversation"])

        let timeline = app.scrollViews["conversation-timeline"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 10))

        let latestFixtureMessage = timeline.staticTexts
            .matching(identifier: "conversation-message-user")
            .matching(NSPredicate(format: "label CONTAINS %@", "把结果整理成一段简短摘要。"))
            .firstMatch
        XCTAssertTrue(latestFixtureMessage.waitForExistence(timeout: 10))
        XCTAssertTrue(latestFixtureMessage.isHittable, "Initial load should position at the newest message.")

        let jumpButton = app.buttons["conversation-jump-to-latest"]
        XCTAssertFalse(jumpButton.exists, "Jump to Latest must stay hidden while at the bottom.")

        // Scroll upward to read older messages.
        for _ in 0..<4 {
            timeline.swipeDown()
            if jumpButton.exists { break }
        }
        XCTAssertTrue(jumpButton.waitForExistence(timeout: 5), "Jump to Latest must appear after scrolling up.")
        XCTAssertTrue(jumpButton.isHittable)

        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(
            jumpButton.frame.maxY,
            composer.frame.minY + 1,
            "Jump to Latest must float above the composer without covering it."
        )

        // Tapping Jump to Latest scrolls back to the bottom and hides the button.
        jumpButton.tap()
        let disappeared = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: jumpButton
        )
        wait(for: [disappeared], timeout: 5)
        XCTAssertTrue(latestFixtureMessage.waitForExistence(timeout: 5))
        XCTAssertTrue(latestFixtureMessage.isHittable)

        // Scrolling up and then sending a message returns to the newest content.
        for _ in 0..<4 {
            timeline.swipeDown()
            if jumpButton.exists { break }
        }
        XCTAssertTrue(jumpButton.waitForExistence(timeout: 5))

        composer.tap()
        let newText = "Smart scroll send check"
        composer.typeText(newText)
        let sendButton = app.buttons["conversation-send"]
        XCTAssertTrue(sendButton.isEnabled)
        sendButton.tap()

        let sentBubble = timeline.staticTexts
            .matching(identifier: "conversation-message-user")
            .matching(NSPredicate(format: "label CONTAINS %@", newText))
            .firstMatch
        XCTAssertTrue(sentBubble.waitForExistence(timeout: 10))
        XCTAssertFalse(jumpButton.exists, "Sending a message should return to bottom and hide Jump to Latest.")
    }

    func testManualScrollBackToBottomHidesJumpToLatestAndResumesFollowing() {
        let app = XCUIApplication()
        launch(app, arguments: ["--ember-start-conversation"])

        let timeline = app.scrollViews["conversation-timeline"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 10))

        let latestFixtureMessage = timeline.staticTexts
            .matching(identifier: "conversation-message-user")
            .matching(NSPredicate(format: "label CONTAINS %@", "把结果整理成一段简短摘要。"))
            .firstMatch
        XCTAssertTrue(latestFixtureMessage.waitForExistence(timeout: 10))

        let jumpButton = app.buttons["conversation-jump-to-latest"]
        for _ in 0..<4 {
            timeline.swipeDown()
            if jumpButton.exists { break }
        }
        XCTAssertTrue(jumpButton.waitForExistence(timeout: 5), "Jump to Latest must appear after scrolling up.")

        // Manually scroll back down to the bottom without tapping Jump to Latest.
        for _ in 0..<5 {
            timeline.swipeUp()
            if !jumpButton.exists { break }
        }
        let disappeared = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: jumpButton
        )
        wait(for: [disappeared], timeout: 5)
        XCTAssertTrue(latestFixtureMessage.isHittable)

        // Following must be re-enabled so a new reply stays visible at the bottom.
        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("Resume follow check")
        app.buttons["conversation-send"].tap()

        let replyBubble = timeline.staticTexts
            .matching(identifier: "conversation-message-ember")
            .matching(NSPredicate(format: "label CONTAINS %@", "MOCK reply:"))
            .firstMatch
        XCTAssertTrue(replyBubble.waitForExistence(timeout: 10))
        XCTAssertTrue(replyBubble.isHittable)
        XCTAssertFalse(jumpButton.exists)
    }

    func testJumpToLatestRemainsAccessibleUnderLargeDynamicType() {
        let app = XCUIApplication()
        launch(
            app,
            arguments: [
                "--ember-start-conversation",
                "-UIPreferredContentSizeCategoryName",
                "UICTContentSizeCategoryAccessibilityLarge",
            ]
        )

        let timeline = app.scrollViews["conversation-timeline"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 10))

        let jumpButton = app.buttons["conversation-jump-to-latest"]
        XCTAssertFalse(jumpButton.exists)

        for _ in 0..<4 {
            timeline.swipeDown()
            if jumpButton.exists { break }
        }
        XCTAssertTrue(jumpButton.waitForExistence(timeout: 5))
        XCTAssertTrue(jumpButton.isHittable)
        XCTAssertGreaterThanOrEqual(jumpButton.frame.height, 44)
        XCTAssertEqual(jumpButton.label, "Jump to latest")

        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(jumpButton.frame.maxY, composer.frame.minY + 1)

        jumpButton.tap()
        let disappeared = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: jumpButton
        )
        wait(for: [disappeared], timeout: 5)
    }

    private func launch(_ app: XCUIApplication, arguments: [String]) {
        app.launchArguments = arguments + [
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US"
        ]
        app.launch()
    }
}
