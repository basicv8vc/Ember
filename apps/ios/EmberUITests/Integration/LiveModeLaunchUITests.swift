import XCTest

/// Explicit Live opt-in must never fall through to the historical Mock app.
@MainActor
final class LiveModeLaunchUITests: XCTestCase {
    func testInvalidLiveOriginFailsClosedInsteadOfShowingMockConversation() {
        let app = XCUIApplication()
        app.launchArguments = ["--ember-live-cloud"]
        app.launchEnvironment["EMBER_CLOUD_BASE_URL"] = "http://invalid.example"
        app.launch()

        XCTAssertTrue(
            app.staticTexts["Live Cloud configuration unavailable"].waitForExistence(timeout: 10)
        )
        XCTAssertFalse(app.otherElements["conversation-home"].exists)
        XCTAssertFalse(app.otherElements["live-cloud-mode"].exists)
    }
}
