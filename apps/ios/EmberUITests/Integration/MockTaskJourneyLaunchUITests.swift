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

        XCTAssertTrue(app.staticTexts["Local mock receipt"].waitForExistence(timeout: 10))
        app.buttons["mock-receipt-continue"].tap()
        XCTAssertTrue(app.staticTexts["本机会话任务"].waitForExistence(timeout: 10))
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
