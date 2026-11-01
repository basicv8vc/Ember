import XCTest

final class LaunchSmokeUITests: XCTestCase {
    func testLaunchDisplaysMockOnlyNotice() {
        let app = XCUIApplication()
        app.launch()

        let notice = app.staticTexts["mock-only-label"]
        XCTAssertTrue(notice.waitForExistence(timeout: 10))
        XCTAssertEqual(notice.label, "MOCK ONLY · No real AI execution")
    }
}
