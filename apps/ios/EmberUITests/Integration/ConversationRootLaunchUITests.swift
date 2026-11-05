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

        let conversation = app.otherElements["conversation-home"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        let timeline = app.scrollViews["conversation-timeline"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 10))
        let composer = app.textFields["conversation-composer-input"]
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

        // Count message bubbles, not text nodes. On iOS 27 the combined bubble and its inner
        // StaticText both carry the message text, so a broad `descendants(matching: .any)` label
        // predicate double-counts a single message. The identifiers below mark one element per
        // bubble and are resolved inside the timeline container; the label predicate then picks
        // the bubble that actually carries this submission, so a duplicate still fails the count.
        let userMessages = timeline.staticTexts
            .matching(identifier: "conversation-message-user")
            .matching(NSPredicate(format: "label CONTAINS %@", text))
        XCTAssertTrue(userMessages.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(userMessages.count, 1, "The submitted message must be rendered as exactly one user bubble.")
        XCTAssertTrue(userMessages.firstMatch.label.contains(text), "The user bubble must carry the submitted text.")

        let mockReplies = timeline.staticTexts
            .matching(identifier: "conversation-message-ember")
            .matching(NSPredicate(format: "label CONTAINS %@", "MOCK reply:"))
        XCTAssertTrue(mockReplies.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(mockReplies.count, 1, "The mock reply must be rendered as exactly one Ember bubble.")
        XCTAssertTrue(mockReplies.firstMatch.label.contains("MOCK reply:"), "The Ember bubble must carry the mock reply.")
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
