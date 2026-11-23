import XCTest

/// NAV-02 focused UI checks for the native TabView + capability-aware sidebar.
@MainActor
final class EmberSidebarUITests: XCTestCase {
    func testChatSidebarOpensShowsOnlyActualDestinationsAndPreservesDraft() {
        let app = makeMockApp()
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("Keep this draft while browsing")

        let open = app.buttons["ember-sidebar-open-chat"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(open.frame.width, 44)
        XCTAssertGreaterThanOrEqual(open.frame.height, 44)
        open.tap()

        let close = app.buttons["ember-sidebar-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(close.frame.width, 44)
        XCTAssertGreaterThanOrEqual(close.frame.height, 44)
        XCTAssertTrue(app.buttons["ember-sidebar-chat"].exists)
        XCTAssertTrue(app.buttons["ember-sidebar-tasks"].exists)
        XCTAssertTrue(app.buttons["ember-sidebar-memory"].exists)
        XCTAssertTrue(app.buttons["ember-sidebar-schedules"].exists)
        XCTAssertFalse(app.buttons["ember-sidebar-sign-out"].exists, "Mock mode must never expose Cloud sign-out.")

        attachScreenshot(app, "nav02-sidebar-chat")

        close.tap()
        let dismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: close
        )
        wait(for: [dismissed], timeout: 5)
        XCTAssertEqual(composer.value as? String, "Keep this draft while browsing")
        XCTAssertTrue(app.buttons["conversation-send"].isEnabled)
    }

    func testTasksSidebarCanOpenMemoryAndSchedulesWithoutLosingTasksContext() {
        let app = makeMockApp()
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        app.tabBars.buttons["Tasks"].tap()
        let inbox = app.descendants(matching: .any)["tasks-inbox-screen"]
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))

        let open = app.buttons["ember-sidebar-open-tasks"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.tap()

        let memory = app.buttons["ember-sidebar-memory"]
        XCTAssertTrue(memory.waitForExistence(timeout: 5))
        memory.tap()
        let memoryClose = app.buttons["memory-sheet-close"]
        XCTAssertTrue(memoryClose.waitForExistence(timeout: 10))
        memoryClose.tap()
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))

        open.tap()
        let schedules = app.buttons["ember-sidebar-schedules"]
        XCTAssertTrue(schedules.waitForExistence(timeout: 5))
        schedules.tap()
        let schedulesClose = app.buttons["schedules-sheet-close"]
        XCTAssertTrue(schedulesClose.waitForExistence(timeout: 10))
        schedulesClose.tap()
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))

        open.tap()
        app.buttons["ember-sidebar-chat"].tap()
        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["Chat"].exists)
    }

    func testSidebarInZhHansDarkAndAccessibilityTextRemainsDismissable() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-mock-chat-tasks",
            "--ember-mock-chat-tasks-reset",
            "-AppleLanguages", "(zh-Hans)",
            "-AppleLocale", "zh_Hans",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityLarge",
            "-UIUserInterfaceStyle", "dark",
        ]
        app.launch()

        let open = app.buttons["ember-sidebar-open-chat"]
        XCTAssertTrue(open.waitForExistence(timeout: 12))
        open.tap()
        let close = app.buttons["ember-sidebar-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertTrue(close.isHittable)
        XCTAssertTrue(app.buttons["ember-sidebar-tasks"].exists)
        XCTAssertTrue(app.buttons["ember-sidebar-memory"].exists)
        XCTAssertTrue(app.buttons["ember-sidebar-schedules"].exists)

        attachScreenshot(app, "nav02-sidebar-zhHans-dark-AX")
        close.tap()
        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 5))
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

    private func attachScreenshot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
