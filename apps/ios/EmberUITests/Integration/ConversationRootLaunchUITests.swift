import XCTest

/// M3 default-entry UI smoke tests. M2 remains reachable with --ember-start-task-flow.
@MainActor
final class ConversationRootLaunchUITests: XCTestCase {
    func testForcedOnboardingEntersConversationHome() {
        let app = XCUIApplication()
        launch(app, arguments: ["--ember-show-onboarding"])

        let demoButton = app.buttons["View the mock demo"]
        XCTAssertTrue(demoButton.waitForExistence(timeout: 10))
        demoButton.tap()

        XCTAssertTrue(
            app.descendants(matching: .any)["conversation-home"].waitForExistence(timeout: 10)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["mock-only-banner"].waitForExistence(timeout: 10)
        )
        XCTAssertFalse(app.staticTexts["task-flow-mock-only-label"].exists)
    }

    func testDirectConversationEntryLoadsTimelineAndComposer() {
        let app = XCUIApplication()
        launch(app, arguments: ["--ember-start-conversation"])

        XCTAssertTrue(
            app.descendants(matching: .any)["conversation-home"].waitForExistence(timeout: 10)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["conversation-composer-input"].waitForExistence(timeout: 10)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["conversation-timeline"].waitForExistence(timeout: 10)
        )
        XCTAssertFalse(app.staticTexts["task-flow-mock-only-label"].exists)
    }

    func testOnboardingChatSendShowsMockAcknowledgementOnce() {
        let app = XCUIApplication()
        launch(app, arguments: ["--ember-show-onboarding"])

        let demoButton = app.buttons["View the mock demo"]
        XCTAssertTrue(demoButton.waitForExistence(timeout: 10))
        demoButton.tap()

        let conversation = app.descendants(matching: .any)["conversation-home"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        let composer = app.descendants(matching: .any)["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        let text = "Verify the first chat mock acknowledgement."
        composer.typeText(text)

        let sendButton = app.buttons["conversation-send"]
        XCTAssertTrue(sendButton.isEnabled)
        sendButton.tap()

        let acknowledgements = app.staticTexts.matching(identifier: "conversation-submission-status")
        XCTAssertTrue(acknowledgements.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(acknowledgements.firstMatch.label, "MOCK ACK · Message accepted")
        XCTAssertEqual(acknowledgements.count, 1)

        let userMessage = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", text)
        )
        XCTAssertTrue(userMessage.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(userMessage.count, 1)

        let mockReply = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "MOCK reply:")
        )
        XCTAssertTrue(mockReply.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(mockReply.count, 1)
        XCTAssertTrue(composer.isEnabled, "The composer should leave its submitting state after the mock reply.")
    }

    func testPreloadedTaskReferenceNavigatesToTaskDetail() {
        let app = XCUIApplication()
        launch(app, arguments: ["--ember-start-conversation"])

        let card = app.buttons["task-activity-card-00000000-0000-4000-8000-000000000103"]
        for _ in 0..<6 {
            if card.exists && card.isHittable { break }
            app.swipeDown()
        }
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        XCTAssertTrue(card.isHittable)
        card.tap()

        XCTAssertTrue(
            app.descendants(matching: .any)["task-detail-summary"].waitForExistence(timeout: 10)
        )

        let detailDisclosure = app.descendants(matching: .any)["mock-only-banner"]
        XCTAssertTrue(detailDisclosure.waitForExistence(timeout: 10))
        XCTAssertTrue(detailDisclosure.isHittable, "MOCK ONLY disclosure must remain visible in Task Detail")

        let backButton = app.navigationBars.buttons.firstMatch
        XCTAssertTrue(backButton.waitForExistence(timeout: 10))
        backButton.tap()

        let conversation = app.descendants(matching: .any)["conversation-home"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        XCTAssertTrue(detailDisclosure.isHittable, "MOCK ONLY disclosure must remain visible after returning")
    }

    private func launch(_ app: XCUIApplication, arguments: [String]) {
        app.launchArguments = arguments + [
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US"
        ]
        app.launch()
    }
}
