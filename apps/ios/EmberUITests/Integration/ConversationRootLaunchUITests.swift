import XCTest

/// M3 default-entry UI smoke tests. M2 remains reachable with --ember-start-task-flow.
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
    }

    private func launch(_ app: XCUIApplication, arguments: [String]) {
        app.launchArguments = arguments + [
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US"
        ]
        app.launch()
    }
}
