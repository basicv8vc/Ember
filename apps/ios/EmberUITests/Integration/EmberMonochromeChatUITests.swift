import XCTest

/// UX-04 PR 3: Native visual regression gates. These tests check real controls,
/// not the marketing/HTML concept screenshots.
@MainActor
final class EmberMonochromeChatUITests: XCTestCase {
    func testFirstRunHeadlineAndStarterPromptKeepSendExplicit() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-show-onboarding",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()

        let demo = app.buttons["View the mock demo"]
        XCTAssertTrue(demo.waitForExistence(timeout: 12))
        demo.tap()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["mock-only-banner"].exists)
        XCTAssertTrue(app.staticTexts["More life. Less busywork."].waitForExistence(timeout: 10))

        let composer = app.textFields["conversation-composer-input"]
        let prompt = app.buttons.matching(identifier: "conversation-suggested-prompt").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
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
        XCTAssertFalse(app.buttons["conversation-send"].isEnabled)
        capture(app, name: "visual-v1-active-chat-en")
    }

    func testChineseDarkLargeTypeRetainsComposerAndModeDisclosure() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-show-onboarding",
            "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_Hans",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityLarge",
            "-UIUserInterfaceStyle", "dark",
        ]
        app.launch()

        let demo = app.buttons["View the mock demo"]
        // The onboarding button is localized in Chinese in this launch configuration.
        // Select its stable function by the same label only when English; instead use
        // the existing mock Chat/Tasks launch for accessibility verification.
        if demo.exists {
            demo.tap()
        } else {
            app.terminate()
            app.launchArguments = [
                "--ember-mock-chat-tasks", "--ember-mock-chat-tasks-reset",
                "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_Hans",
                "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityLarge",
                "-UIUserInterfaceStyle", "dark",
            ]
            app.launch()
        }

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.descendants(matching: .any)["mock-only-banner"].exists)
        XCTAssertTrue(app.textFields["conversation-composer-input"].exists)
        XCTAssertTrue(app.tabBars.buttons.firstMatch.isHittable)
        capture(app, name: "visual-v1-dark-zhHans-AX")
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
