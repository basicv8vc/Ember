import XCTest

@MainActor
final class DeviceExecutorWorkbenchUITests: XCTestCase {
    func testDeviceExecutorWorkbenchRunsNativePipeline() {
        let app = XCUIApplication()
        app.launchArguments = ["--ember-device-executor"]
        app.launch()

        let notesButton = app.buttons["device-run-notes-pdf"]
        XCTAssertTrue(notesButton.waitForExistence(timeout: 10))
        notesButton.tap()

        let status = app.staticTexts["device-status-message"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertTrue(status.label.contains("completed"))

        let taskRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'device-task-row-'")).firstMatch
        if !taskRow.waitForExistence(timeout: 5) {
            app.swipeUp()
        }
        XCTAssertTrue(taskRow.waitForExistence(timeout: 10))
        taskRow.tap()

        XCTAssertTrue(app.otherElements["task-detail-summary"].waitForExistence(timeout: 10))
    }
}
