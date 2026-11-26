import XCTest

/// NAV-02 focused UI checks for the native TabView + interactive edge-swipe sidebar
/// and accessible menu triggers (P1/P2 review gates).
@MainActor
final class EmberSidebarUITests: XCTestCase {
    func testChatLeftEdgeSwipeAndAccessibleMenuOpenSidebarWithoutTopLeftButton() {
        let app = makeMockApp()
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.buttons["ember-sidebar-open-chat"].exists, "Chat header must not show a top-left sidebar toggle button.")
        XCTAssertFalse(app.buttons["ember-sidebar-close"].exists, "Sidebar drawer must not clutter header with a close button.")

        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("Keep this draft while browsing")
        XCTAssertEqual(composer.value(forKey: "hasKeyboardFocus") as? Bool, true)

        // P1: Focusable >= 44pt assistive/menu path on Chat opens Sidebar without top-left button
        let chatMenu = app.buttons["live-conversation-menu"]
        XCTAssertTrue(chatMenu.waitForExistence(timeout: 5))
        XCTAssertTrue(chatMenu.isHittable)
        XCTAssertGreaterThanOrEqual(chatMenu.frame.width, 44)
        XCTAssertGreaterThanOrEqual(chatMenu.frame.height, 44)
        XCTAssertFalse(chatMenu.label.isEmpty)
        chatMenu.tap()

        let menuOpenSidebar = app.buttons["live-conversation-open-sidebar"]
        XCTAssertTrue(menuOpenSidebar.waitForExistence(timeout: 5))
        XCTAssertTrue(menuOpenSidebar.isHittable)
        menuOpenSidebar.tap()

        let chatItem = app.buttons["ember-sidebar-chat"]
        XCTAssertTrue(chatItem.waitForExistence(timeout: 5))
        XCTAssertTrue(chatItem.isHittable)
        XCTAssertGreaterThanOrEqual(chatItem.frame.height, 44)
        XCTAssertEqual(app.keyboards.count, 0, "Opening Sidebar via menu must dismiss keyboard cleanly.")

        let backdrop = app.buttons["ember-sidebar-backdrop"]
        XCTAssertTrue(backdrop.waitForExistence(timeout: 5))
        XCTAssertTrue(backdrop.isHittable)
        XCTAssertGreaterThanOrEqual(backdrop.frame.width, 44)
        XCTAssertFalse(backdrop.label.isEmpty)
        backdrop.tap()
        waitUntilMissing(chatItem)
        XCTAssertEqual(composer.value as? String, "Keep this draft while browsing")

        // Left-edge swipe gesture path also opens Sidebar cleanly
        openSidebarByEdgeSwipe(app)
        XCTAssertTrue(chatItem.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["ember-sidebar-tasks"].exists)
        XCTAssertTrue(app.buttons["ember-sidebar-memory"].exists)
        XCTAssertTrue(app.buttons["ember-sidebar-schedules"].exists)
        XCTAssertFalse(app.buttons["ember-sidebar-sign-out"].exists, "Mock mode must never expose Cloud sign-out.")

        attachScreenshot(app, "nav02-sidebar-chat")

        closeSidebarBySwipeLeft(app)
        waitUntilMissing(chatItem)
        XCTAssertEqual(composer.value as? String, "Keep this draft while browsing")
        XCTAssertTrue(app.buttons["conversation-send"].isEnabled)

        // Switching Chat -> Tasks -> Chat via Sidebar swipes preserves the unsent Chat draft
        openSidebarByEdgeSwipe(app)
        XCTAssertTrue(app.buttons["ember-sidebar-tasks"].waitForExistence(timeout: 5))
        app.buttons["ember-sidebar-tasks"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["tasks-inbox-screen"].waitForExistence(timeout: 10))

        openSidebarByEdgeSwipe(app)
        XCTAssertTrue(chatItem.waitForExistence(timeout: 5))
        chatItem.tap()

        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, "Keep this draft while browsing")
        XCTAssertTrue(app.buttons["conversation-send"].isEnabled)
    }

    func testTasksAccessibleMenuEdgeSwipeAndDetailPopIsolationKeepTasksState() {
        let app = makeMockApp()
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        app.tabBars.buttons["Tasks"].tap()
        let inbox = app.descendants(matching: .any)["tasks-inbox-screen"]
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["ember-sidebar-open-tasks"].exists, "Tasks toolbar must not show a top-left sidebar toggle button.")
        XCTAssertTrue(app.buttons["tasks-open-schedules"].exists)

        // P1: Accessible trailing menu opens Sidebar from Tasks root
        let tasksMenu = app.buttons["tasks-navigation-menu"]
        XCTAssertTrue(tasksMenu.waitForExistence(timeout: 5))
        XCTAssertTrue(tasksMenu.isHittable)
        tasksMenu.tap()
        let openFromTasksMenu = app.buttons["tasks-open-sidebar"]
        XCTAssertTrue(openFromTasksMenu.waitForExistence(timeout: 5))
        openFromTasksMenu.tap()
        let chatItem = app.buttons["ember-sidebar-chat"]
        XCTAssertTrue(chatItem.waitForExistence(timeout: 5))
        closeSidebarBySwipeLeft(app)
        waitUntilMissing(chatItem)

        // Inside a pushed Task detail view, left-edge swipe stays reserved for native back navigation
        let runningRow = app.buttons["tasks-row-00000000-0000-4000-8000-00000000b312"]
        XCTAssertTrue(runningRow.waitForExistence(timeout: 10))
        runningRow.tap()

        let cancelButton = app.buttons["task-cancel"]
        for _ in 0..<4 {
            if cancelButton.exists && cancelButton.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(cancelButton.waitForExistence(timeout: 10))

        let edgeStart = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let edgeMid = app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5))
        edgeStart.press(forDuration: 0.01, thenDragTo: edgeMid)
        XCTAssertFalse(chatItem.exists)
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))

        // Cancel running task to mutate Tasks state, then verify preservation across Sidebar switches
        XCTAssertTrue(runningRow.waitForExistence(timeout: 10))
        runningRow.tap()
        for _ in 0..<4 {
            if cancelButton.exists && cancelButton.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(cancelButton.waitForExistence(timeout: 10))
        cancelButton.tap()
        waitUntilMissing(cancelButton, timeout: 10)

        let backToTasks = app.navigationBars.buttons.firstMatch
        XCTAssertTrue(backToTasks.waitForExistence(timeout: 5))
        backToTasks.tap()
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))

        openSidebarByEdgeSwipe(app)
        let backdrop = app.buttons["ember-sidebar-backdrop"]
        XCTAssertTrue(backdrop.waitForExistence(timeout: 5))
        backdrop.tap()
        waitUntilMissing(backdrop)
        XCTAssertTrue(inbox.exists)
        XCTAssertFalse(chatItem.exists)

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
        chatItem.tap()
        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["Chat"].exists)

        openSidebarByEdgeSwipe(app)
        XCTAssertTrue(app.buttons["ember-sidebar-tasks"].waitForExistence(timeout: 5))
        app.buttons["ember-sidebar-tasks"].tap()
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))
        XCTAssertFalse(
            app.descendants(matching: .any)["tasks-section-in-progress"].exists,
            "Cancelled Tasks state must persist across Sidebar switches."
        )
    }

    func testSidebarEdgeSwipeBoundariesAndScrollCoexistence() {
        let app = makeMockApp()
        app.launch()

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        let chatItem = app.buttons["ember-sidebar-chat"]

        // P2: Starting inside the 40pt edge zone near the outer threshold (x ~= 35pt on 402pt / ~32pt on 375pt)
        // must still open Sidebar even though finger moves beyond x > 40pt before pan recognition begins.
        let nearOuterEdgeStart = app.coordinate(withNormalizedOffset: CGVector(dx: 0.087, dy: 0.5))
        let rightEnd = app.coordinate(withNormalizedOffset: CGVector(dx: 0.84, dy: 0.5))
        nearOuterEdgeStart.press(forDuration: 0.01, thenDragTo: rightEnd)
        XCTAssertTrue(chatItem.waitForExistence(timeout: 5), "Drag starting at ~35pt inside 40pt edge zone must open Sidebar.")
        closeSidebarBySwipeLeft(app)
        waitUntilMissing(chatItem)

        // P2: Drag starting in main content (x > 40pt) must NOT open Sidebar
        let contentStart = app.coordinate(withNormalizedOffset: CGVector(dx: 0.30, dy: 0.16))
        let contentEnd = app.coordinate(withNormalizedOffset: CGVector(dx: 0.84, dy: 0.16))
        contentStart.press(forDuration: 0.01, thenDragTo: contentEnd)
        XCTAssertFalse(chatItem.exists, "Drag starting outside 40pt edge zone must not open Sidebar.")
        XCTAssertTrue(app.otherElements["conversation-home"].exists)

        // P2: Vertical scroll starting near the left edge must NOT open Sidebar
        let verticalStart = app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.72))
        let verticalEnd = app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.28))
        verticalStart.press(forDuration: 0.01, thenDragTo: verticalEnd)
        XCTAssertFalse(chatItem.exists, "Vertical scroll near left edge must not falsely open Sidebar.")
        XCTAssertTrue(app.otherElements["conversation-home"].exists)

        // P2: Smoke check horizontal ScrollView & modal isolation in Schedules sheet
        let menuButton = app.buttons["live-conversation-menu"]
        XCTAssertTrue(menuButton.waitForExistence(timeout: 5))
        menuButton.tap()
        let openSchedules = app.buttons["live-conversation-open-schedules"]
        XCTAssertTrue(openSchedules.waitForExistence(timeout: 5))
        openSchedules.tap()

        let addSchedule = app.buttons["schedules-add-button"]
        XCTAssertTrue(addSchedule.waitForExistence(timeout: 10))
        addSchedule.tap()
        let preset1m = app.buttons["schedules-preset-1m"]
        XCTAssertTrue(preset1m.waitForExistence(timeout: 5))
        preset1m.swipeLeft()
        let presetTomorrow = app.buttons["schedules-preset-tomorrow-9am"]
        XCTAssertTrue(presetTomorrow.waitForExistence(timeout: 5))
        presetTomorrow.tap()
        XCTAssertFalse(chatItem.exists, "Horizontal scroll inside sheets must never trigger window Sidebar pan.")
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
        waitUntilMissing(tasksItem)
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

    private func waitUntilMissing(_ element: XCUIElement, timeout: TimeInterval = 5) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: element
        )
        wait(for: [expectation], timeout: timeout)
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
