import XCTest

final class LaunchSmokeUITests: XCTestCase {
    func testLaunchDisplaysMockOnlyNotice() {
        let app = XCUIApplication()
        app.launchArguments = ["--ember-start-task-flow"]
        app.launch()

        let notice = app.staticTexts["task-flow-mock-only-label"]
        XCTAssertTrue(notice.waitForExistence(timeout: 10))
        XCTAssertTrue(notice.label.localizedCaseInsensitiveContains("MOCK ONLY"))
        XCTAssertTrue(app.buttons["compose-submit"].waitForExistence(timeout: 10))
    }
}
