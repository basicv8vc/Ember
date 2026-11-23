import XCTest

/// NAV-01 regression tests for the floating two-destination shell.
/// Run locally with the Ember scheme; no paid provider or Cloud API is required.
@MainActor
final class EmberFloatingTabBarUITests: XCTestCase {
    func testFloatingBarSwitchesRealTabsAndDoesNotOverlayTaskDetail() {
        let app = makeMockApp()
        app.launch()

        let bar = app.otherElements["ember-floating-tab-bar"]
        let chat = app.buttons["ember-nav-chat"]
        let tasks = app.buttons["ember-nav-tasks"]
        XCTAssertTrue(bar.waitForExistence(timeout: 12))
        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 10))
        XCTAssertTrue(chat.isHittable)
        XCTAssertTrue(tasks.isHittable)
        XCTAssertGreaterThanOrEqual(chat.frame.width, 44)
        XCTAssertGreaterThanOrEqual(chat.frame.height, 44)
        XCTAssertGreaterThanOrEqual(tasks.frame.width, 44)
        XCTAssertGreaterThanOrEqual(tasks.frame.height, 44)
        XCTAssertLessThanOrEqual(bar.frame.width, app.windows.firstMatch.frame.width - 28)
        XCTAssertFalse(app.tabBars.buttons["Tasks"].isHittable, "The system tab bar must not duplicate the floating bar.")

        tasks.tap()
        XCTAssertTrue(app.descendants(matching: .any)["tasks-inbox-screen"].waitForExistence(timeout: 10))

        let taskRow = app.buttons["tasks-row-00000000-0000-4000-8000-00000000b311"]
        for _ in 0..<4 {
            if taskRow.exists && taskRow.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(taskRow.waitForExistence(timeout: 10))
        XCTAssertTrue(taskRow.isHittable)
        taskRow.tap()
        XCTAssertTrue(app.descendants(matching: .any)["task-detail-summary"].waitForExistence(timeout: 10))
        XCTAssertFalse(bar.exists, "Navigation must not cover a pushed Task Detail page.")

        let back = app.navigationBars.buttons.firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 10))
        back.tap()
        XCTAssertTrue(bar.waitForExistence(timeout: 10), "Return to root must restore navigation.")

        chat.tap()
        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["conversation-send"].exists)
    }

    func testComposerKeyboardTemporarilyHidesBarAndSendRestoresIt() {
        let app = makeMockApp()
        app.launch()

        let bar = app.otherElements["ember-floating-tab-bar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 12))
        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))

        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let dismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: bar
        )
        wait(for: [dismissed], timeout: 5)

        composer.typeText("NAV-01 keyboard safe area check")
        let send = app.buttons["conversation-send"]
        XCTAssertTrue(send.isEnabled)
        send.tap()

        XCTAssertTrue(bar.waitForExistence(timeout: 10), "After Send unfocuses the composer, navigation should return.")
        XCTAssertTrue(app.buttons["ember-nav-tasks"].isHittable)
    }

    private func makeMockApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-mock-chat-tasks",
            "--ember-mock-chat-tasks-reset",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        return app
    }
}
