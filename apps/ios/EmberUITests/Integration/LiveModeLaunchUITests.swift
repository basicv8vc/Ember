import XCTest

/// Explicit Live opt-in must never fall through to the historical Mock app.
@MainActor
final class LiveModeLaunchUITests: XCTestCase {
    /// Evidence of the real Live UI entry. No Cloud staging credentials are assumed.
    /// The screenshot is kept as an XCResult attachment, not mistaken for a live E2E chat.
    func testLiveCloudRequiresAppleSignInAndKeepsScreenshotEvidence() {
        let app = XCUIApplication()
        app.launchArguments = ["--ember-live-cloud"]
        app.launchEnvironment["EMBER_CLOUD_BASE_URL"] = "https://ember.invalid"
        app.launch()

        let signIn = app.descendants(matching: .any)
            .matching(identifier: "live-conversation-sign-in").firstMatch
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
        XCTAssertFalse(app.otherElements["conversation-home"].exists)

        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Ember L2 Live Cloud sign-in entry (not staging E2E)"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

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
