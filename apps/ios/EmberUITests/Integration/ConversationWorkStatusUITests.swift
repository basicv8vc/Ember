import XCTest

/// User-facing entry to ongoing Task work without opening a separate navigation menu.
@MainActor
final class ConversationWorkStatusUITests: XCTestCase {
    func testKnownTaskStatusIsVisibleAndOpensTasksWithoutClearingDraft() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-mock-chat-tasks",
            "--ember-mock-chat-tasks-reset",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        let entry = app.buttons["chat-work-status-entry"]
        XCTAssertTrue(entry.waitForExistence(timeout: 12))
        XCTAssertGreaterThanOrEqual(entry.frame.height, 44)
        XCTAssertTrue(entry.label.contains("Needs you"))
        XCTAssertTrue(entry.label.contains("Active work"))

        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        let draft = "Please continue the quarterly review"
        composer.typeText(draft)

        entry.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["tasks-inbox-screen"].waitForExistence(timeout: 10)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["tasks-section-needs-intervention"].exists
        )

        app.tabBars.buttons["Chat"].tap()
        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 10))
        XCTAssertEqual(composer.value as? String, draft)
        XCTAssertTrue(entry.exists)
    }
}
