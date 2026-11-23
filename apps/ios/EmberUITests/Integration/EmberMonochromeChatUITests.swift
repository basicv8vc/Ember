import XCTest

/// UX-04 PR 3: Native visual regression gates. These tests check real controls,
/// not the marketing/HTML concept screenshots.
@MainActor
final class EmberMonochromeChatUITests: XCTestCase {
    func testFirstRunHeadlineAndStarterPromptKeepSendExplicit() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-mock-chat-tasks", "--ember-mock-chat-tasks-reset", "--ember-mock-empty-chat",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.descendants(matching: .any)["mock-only-banner"].exists)
        XCTAssertTrue(app.staticTexts["More life. Less busywork."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["conversation-composer-note"].waitForExistence(timeout: 5))

        let composer = app.textFields["conversation-composer-input"]
        let prompt = app.buttons.matching(identifier: "conversation-suggested-prompt").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(prompt.frame.height, 44)
        XCTAssertFalse(app.buttons["conversation-send"].isEnabled)

        prompt.tap()
        XCTAssertTrue(app.buttons["conversation-send"].isEnabled)
        XCTAssertFalse(app.descendants(matching: .any)["conversation-message-user-pending"].exists)
        capture(app, name: "visual-v1-first-run-en")
    }

    func testSentUserBubblePreservesAccessibleSpeakerAndMessageIdentity() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-mock-chat-tasks", "--ember-mock-chat-tasks-reset",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        let text = "Visual V1 verifies the message layout"
        composer.typeText(text)
        let send = app.buttons["conversation-send"]
        XCTAssertTrue(send.isEnabled)
        send.tap()

        let bubble = app.scrollViews["conversation-timeline"].staticTexts
            .matching(identifier: "conversation-message-user")
            .matching(NSPredicate(format: "label CONTAINS %@", text))
            .firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 10))
        XCTAssertTrue(bubble.label.contains("You"), "Speaker is retained for VoiceOver without a visible You header.")
        capture(app, name: "visual-v1-active-chat-en")
    }

    func testChineseDarkLargeTypeRetainsComposerAndModeDisclosure() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-mock-chat-tasks", "--ember-mock-chat-tasks-reset",
            "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityLarge",
            "-UIUserInterfaceStyle", "dark",
        ]
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts["个人 AI 伙伴"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["mock-only-banner"].exists)
        XCTAssertTrue(app.textFields["conversation-composer-input"].exists)
        let sendButton = app.buttons["conversation-send"]
        let attachButton = app.buttons["conversation-attach-file"]
        XCTAssertTrue(sendButton.exists)
        XCTAssertTrue(attachButton.exists)
        XCTAssertGreaterThanOrEqual(sendButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(sendButton.frame.height, 44)
        XCTAssertGreaterThanOrEqual(attachButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(attachButton.frame.height, 44)
        XCTAssertTrue(app.tabBars.buttons.firstMatch.isHittable)
        capture(app, name: "visual-v1-dark-zhHans-AX")
    }

    func testStreamingReplyExposesMonochromeStopButtonsAndMultilineBubble() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-start-conversation", "--ember-mock-slow-reply",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        let prompt = "Summarize Q4 goals across engineering, design, and launch readiness."
        composer.typeText(prompt)

        let sendButton = app.buttons["conversation-send"]
        XCTAssertTrue(sendButton.isEnabled)
        sendButton.tap()

        let composerStop = app.buttons["conversation-composer-stop"]
        let timelineStop = app.buttons["conversation-stop-reply"]
        XCTAssertTrue(composerStop.waitForExistence(timeout: 5))
        XCTAssertTrue(timelineStop.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(composerStop.frame.height, 44)
        XCTAssertGreaterThanOrEqual(timelineStop.frame.height, 44)
        capture(app, name: "visual-v1-streaming-stop")

        composerStop.tap()
        XCTAssertTrue(sendButton.waitForExistence(timeout: 5))
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
