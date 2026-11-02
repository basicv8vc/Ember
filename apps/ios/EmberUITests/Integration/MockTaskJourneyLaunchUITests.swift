import XCTest

final class MockTaskJourneyLaunchUITests: XCTestCase {
    func testEnglishOnboardingCanReachReceiptAndSessionInbox() {
        let app = XCUIApplication()
        launch(app, arguments: ["--ember-show-onboarding"], locale: "en")

        let demoButton = app.buttons["View the mock demo"]
        XCTAssertTrue(demoButton.waitForExistence(timeout: 10))
        demoButton.tap()

        XCTAssertTrue(app.staticTexts["task-flow-mock-only-label"].waitForExistence(timeout: 10))
        let noteInput = app.textViews["compose-note-input"]
        XCTAssertTrue(noteInput.waitForExistence(timeout: 10))
        noteInput.tap()
        noteInput.typeText("Integration test note for a local mock task.")

        let submitButton = app.buttons["compose-submit"]
        if !submitButton.isHittable {
            app.swipeUp()
        }
        submitButton.tap()

        let receiptTitle = app.staticTexts["Local demo receipt"]
        XCTAssertTrue(receiptTitle.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["mock-receipt-task-id"].exists)
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "task is not complete")).firstMatch.exists
        )
        let continueButton = app.buttons["mock-receipt-continue"]
        XCTAssertTrue(continueButton.isHittable)
        continueButton.tap()
        XCTAssertTrue(app.staticTexts["本机会话任务"].waitForExistence(timeout: 10))
    }

    func testUnknownAcknowledgementReplayPresentsReceiptAndOneSessionTask() {
        let app = XCUIApplication()
        launch(app, arguments: ["--ember-start-task-flow"], locale: "en")

        app.buttons["填入示例"].tap()
        let noteInput = app.textViews["compose-note-input"]
        XCTAssertTrue(noteInput.waitForExistence(timeout: 10))

        let lostReceiptToggle = app.switches["compose-simulate-unknown-receipt"]
        XCTAssertTrue(lostReceiptToggle.waitForExistence(timeout: 10))
        if !lostReceiptToggle.isHittable {
            app.swipeUp()
        }
        lostReceiptToggle.tap()

        let submitButton = app.buttons["compose-submit"]
        if !submitButton.isHittable {
            app.swipeUp()
        }
        submitButton.tap()

        let unknownStatus = app.descendants(matching: .any)["compose-status-message"]
        XCTAssertTrue(unknownStatus.waitForExistence(timeout: 10))
        XCTAssertTrue(unknownStatus.label.contains("尚未确认"))
        XCTAssertFalse(noteInput.isEnabled)
        XCTAssertTrue((noteInput.value as? String)?.contains("新 onboarding") == true)
        XCTAssertFalse(app.descendants(matching: .any)["compose-receipt"].exists)
        XCTAssertFalse(app.staticTexts["Local demo receipt"].exists)

        submitButton.tap()

        let receiptTitle = app.staticTexts["Local demo receipt"]
        XCTAssertTrue(receiptTitle.waitForExistence(timeout: 10))
        let continueButton = app.buttons["mock-receipt-continue"]
        XCTAssertTrue(continueButton.isHittable)
        continueButton.tap()

        XCTAssertTrue(app.staticTexts["本机会话任务"].waitForExistence(timeout: 10))
        let createdTask = app.staticTexts.matching(NSPredicate(format: "label == %@", "笔记整理 · 本机会话")).firstMatch
        XCTAssertTrue(createdTask.waitForExistence(timeout: 10))
        XCTAssertEqual(
            app.staticTexts.matching(NSPredicate(format: "label == %@", "笔记整理 · 本机会话")).count,
            1
        )
        XCTAssertFalse(receiptTitle.exists)
    }

    func testSimplifiedChineseOnboardingAndDirectTaskFlowEntry() {
        let onboardingApp = XCUIApplication()
        launch(onboardingApp, arguments: ["--ember-show-onboarding"], locale: "zh-Hans")
        let demoButton = onboardingApp.buttons["查看模拟演示"]
        XCTAssertTrue(demoButton.waitForExistence(timeout: 10))
        demoButton.tap()
        XCTAssertTrue(onboardingApp.staticTexts["task-flow-mock-only-label"].waitForExistence(timeout: 10))
        onboardingApp.terminate()

        let directEntryApp = XCUIApplication()
        launch(directEntryApp, arguments: ["--ember-start-task-flow"], locale: "zh-Hans")
        XCTAssertTrue(directEntryApp.staticTexts["task-flow-mock-only-label"].waitForExistence(timeout: 10))
        XCTAssertTrue(directEntryApp.buttons["compose-submit"].waitForExistence(timeout: 10))
    }

    private func launch(_ app: XCUIApplication, arguments: [String], locale: String) {
        let appleLocale = locale == "en" ? "en_US" : "zh_CN"
        app.launchArguments = arguments + ["-AppleLanguages", "(\(locale))", "-AppleLocale", appleLocale]
        app.launch()
    }
}
