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

        // Switching Chat -> Tasks -> Chat via Sidebar preserves the unsent Chat draft
        open.tap()
        XCTAssertTrue(app.buttons["ember-sidebar-tasks"].waitForExistence(timeout: 5))
        app.buttons["ember-sidebar-tasks"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["tasks-inbox-screen"].waitForExistence(timeout: 10))

        let openTasksSidebar = app.buttons["ember-sidebar-open-tasks"]
        XCTAssertTrue(openTasksSidebar.waitForExistence(timeout: 5))
        openTasksSidebar.tap()
        XCTAssertTrue(app.buttons["ember-sidebar-chat"].waitForExistence(timeout: 5))
        app.buttons["ember-sidebar-chat"].tap()

        XCTAssertTrue(composer.waitForExistence(timeout: 5))
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

        // Mutate Tasks state (cancel running task), then navigate via Sidebar and confirm Tasks state persists
        let runningRow = app.buttons["tasks-row-00000000-0000-4000-8000-00000000b312"]
        XCTAssertTrue(runningRow.waitForExistence(timeout: 10))
        runningRow.tap()

        let cancelButton = app.buttons["task-cancel"]
        for _ in 0..<4 {
            if cancelButton.exists && cancelButton.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(cancelButton.waitForExistence(timeout: 10))
        cancelButton.tap()
        let cancelDismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: cancelButton
        )
        wait(for: [cancelDismissed], timeout: 10)

        let backToTasks = app.navigationBars.buttons.firstMatch
        XCTAssertTrue(backToTasks.waitForExistence(timeout: 5))
        backToTasks.tap()
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))

        // Open Tasks Sidebar, dismiss via backdrop tap, then open Memory & Schedules while preserving Tasks context
        let open = app.buttons["ember-sidebar-open-tasks"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        XCTAssertTrue(open.isHittable)
        open.tap()

        let backdrop = app.buttons["ember-sidebar-backdrop"]
        XCTAssertTrue(backdrop.waitForExistence(timeout: 5))
        backdrop.tap()
        let backdropDismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: backdrop
        )
        wait(for: [backdropDismissed], timeout: 5)
        XCTAssertTrue(inbox.exists)
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        XCTAssertTrue(open.isHittable)

        open.tap()
        attachScreenshot(app, "nav02-sidebar-tasks")
        let memory = app.buttons["ember-sidebar-memory"]
        XCTAssertTrue(memory.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(memory.frame.height, 44)
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

        let openChat = app.buttons["ember-sidebar-open-chat"]
        XCTAssertTrue(openChat.waitForExistence(timeout: 5))
        openChat.tap()
        app.buttons["ember-sidebar-tasks"].tap()
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))
        XCTAssertFalse(
            app.descendants(matching: .any)["tasks-section-in-progress"].exists,
            "Cancelled Tasks state must persist across Sidebar switches."
        )
    }

    func testSidebarInZhHansDarkAndAccessibilityTextRemainsDismissable() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-mock-chat-tasks",
            "--ember-mock-chat-tasks-reset",
            "-AppleLanguages", "(zh-Hans)",
            "-AppleLocale", "zh_CN",
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
        XCTAssertTrue(app.staticTexts["你的个人 AI 助手"].exists)
        XCTAssertTrue(app.staticTexts["标签页"].exists)
        XCTAssertTrue(app.staticTexts["工具"].exists)
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
