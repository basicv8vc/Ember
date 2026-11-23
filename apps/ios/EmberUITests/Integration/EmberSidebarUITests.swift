import XCTest

/// NAV-02 focused UI checks for the native TabView + ChatGPT/CoPaper-style interactive swipe sidebar.
@MainActor
final class EmberSidebarUITests: XCTestCase {
    func testChatLeftEdgeSwipeOpensSidebarWithoutTopLeftButtonAndPreservesDraft() {
        let app = makeMockApp()
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.buttons["ember-sidebar-open-chat"].exists, "Chat header must not show a top-left sidebar toggle button.")
        XCTAssertFalse(app.buttons["ember-sidebar-close"].exists, "Sidebar drawer must not clutter header with a close button.")

        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("Keep this draft while browsing")

        openSidebarByEdgeSwipe(app)

        let chatItem = app.buttons["ember-sidebar-chat"]
        XCTAssertTrue(chatItem.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["ember-sidebar-tasks"].exists)
        XCTAssertTrue(app.buttons["ember-sidebar-memory"].exists)
        XCTAssertTrue(app.buttons["ember-sidebar-schedules"].exists)
        XCTAssertFalse(app.buttons["ember-sidebar-sign-out"].exists, "Mock mode must never expose Cloud sign-out.")

        attachScreenshot(app, "nav02-sidebar-chat")

        closeSidebarBySwipeLeft(app)
        let closed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: chatItem
        )
        wait(for: [closed], timeout: 5)
        XCTAssertEqual(composer.value as? String, "Keep this draft while browsing")
        XCTAssertTrue(app.buttons["conversation-send"].isEnabled)

        // Switching Chat -> Tasks -> Chat via Sidebar swipes preserves the unsent Chat draft
        openSidebarByEdgeSwipe(app)
        XCTAssertTrue(app.buttons["ember-sidebar-tasks"].waitForExistence(timeout: 5))
        app.buttons["ember-sidebar-tasks"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["tasks-inbox-screen"].waitForExistence(timeout: 10))

        openSidebarByEdgeSwipe(app)
        XCTAssertTrue(app.buttons["ember-sidebar-chat"].waitForExistence(timeout: 5))
        app.buttons["ember-sidebar-chat"].tap()

        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, "Keep this draft while browsing")
        XCTAssertTrue(app.buttons["conversation-send"].isEnabled)
    }

    func testTasksLeftEdgeSwipeAndDetailPopIsolationKeepTasksState() {
        let app = makeMockApp()
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        app.tabBars.buttons["Tasks"].tap()
        let inbox = app.descendants(matching: .any)["tasks-inbox-screen"]
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["ember-sidebar-open-tasks"].exists, "Tasks toolbar must not show a top-left sidebar toggle button.")
        XCTAssertTrue(app.buttons["tasks-open-schedules"].exists)

        // Inside a pushed Task detail view, left-edge swipe must stay reserved for native back navigation
        let runningRow = app.buttons["tasks-row-00000000-0000-4000-8000-00000000b312"]
        XCTAssertTrue(runningRow.waitForExistence(timeout: 10))
        runningRow.tap()

        let cancelButton = app.buttons["task-cancel"]
        for _ in 0..<4 {
            if cancelButton.exists && cancelButton.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(cancelButton.waitForExistence(timeout: 10))

        // Left-edge swipe on pushed TaskDetailView pops back rather than pulling Sidebar
        let edgeStart = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let edgeMid = app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5))
        edgeStart.press(forDuration: 0.01, thenDragTo: edgeMid)
        XCTAssertFalse(app.buttons["ember-sidebar-chat"].exists)
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))

        // Re-open running task and cancel it to mutate Tasks state
        XCTAssertTrue(runningRow.waitForExistence(timeout: 10))
        runningRow.tap()
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

        // Open Tasks Sidebar via edge swipe, dismiss via backdrop tap, then open Memory & Schedules
        openSidebarByEdgeSwipe(app)
        let backdrop = app.buttons["ember-sidebar-backdrop"]
        XCTAssertTrue(backdrop.waitForExistence(timeout: 5))
        backdrop.tap()
        let backdropDismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: backdrop
        )
        wait(for: [backdropDismissed], timeout: 5)
        XCTAssertTrue(inbox.exists)
        XCTAssertFalse(app.buttons["ember-sidebar-chat"].exists)

        openSidebarByEdgeSwipe(app)
        attachScreenshot(app, "nav02-sidebar-tasks")
        let memory = app.buttons["ember-sidebar-memory"]
        XCTAssertTrue(memory.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(memory.frame.height, 44)
        memory.tap()
        let memoryClose = app.buttons["memory-sheet-close"]
        XCTAssertTrue(memoryClose.waitForExistence(timeout: 10))
        memoryClose.tap()
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))

        openSidebarByEdgeSwipe(app)
        let schedules = app.buttons["ember-sidebar-schedules"]
        XCTAssertTrue(schedules.waitForExistence(timeout: 5))
        schedules.tap()
        let schedulesClose = app.buttons["schedules-sheet-close"]
        XCTAssertTrue(schedulesClose.waitForExistence(timeout: 10))
        schedulesClose.tap()
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))

        openSidebarByEdgeSwipe(app)
        app.buttons["ember-sidebar-chat"].tap()
        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["Chat"].exists)

        openSidebarByEdgeSwipe(app)
        XCTAssertTrue(app.buttons["ember-sidebar-tasks"].waitForExistence(timeout: 5))
        app.buttons["ember-sidebar-tasks"].tap()
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))
        XCTAssertFalse(
            app.descendants(matching: .any)["tasks-section-in-progress"].exists,
            "Cancelled Tasks state must persist across Sidebar swipe switches."
        )
    }

    func testSidebarSwipeInZhHansDarkAndAccessibilityTextRemainsDismissable() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ember-mock-chat-tasks",
            "--ember-mock-chat-tasks-reset",
            "-AppleLanguages", "(zh-Hans)",
            "-AppleLocale", "zh_CN",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityLarge",
        ]
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        openSidebarByEdgeSwipe(app)

        let tasksItem = app.buttons["ember-sidebar-tasks"]
        XCTAssertTrue(tasksItem.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["你的个人 AI 助手"].exists)
        XCTAssertTrue(app.staticTexts["标签页"].exists)
        XCTAssertTrue(app.staticTexts["工具"].exists)
        XCTAssertTrue(app.buttons["ember-sidebar-memory"].exists)
        XCTAssertTrue(app.buttons["ember-sidebar-schedules"].exists)

        attachScreenshot(app, "nav02-sidebar-zhHans-dark-AX")

        closeSidebarBySwipeLeft(app)
        let closed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: tasksItem
        )
        wait(for: [closed], timeout: 5)
        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 5))
    }

    private func openSidebarByEdgeSwipe(_ app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.5))
        start.press(forDuration: 0.01, thenDragTo: end)
    }

    private func closeSidebarBySwipeLeft(_ app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.5))
        start.press(forDuration: 0.01, thenDragTo: end)
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
