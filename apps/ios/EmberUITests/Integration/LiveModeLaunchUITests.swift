import XCTest

/// Default launch connects to Live Ember Cloud; explicit invalid origins must fail closed instead of falling through to Mock.
@MainActor
final class LiveModeLaunchUITests: XCTestCase {
    func testDefaultLaunchOpensLiveEmberCloudInsteadOfMockDemo() {
        let app = XCUIApplication()
        app.launchArguments = []
        app.launch()

        let liveEntry = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier IN {'live-conversation-sign-in', 'live-cloud-mode'}"))
            .firstMatch
        XCTAssertTrue(liveEntry.waitForExistence(timeout: 15))
        XCTAssertFalse(app.descendants(matching: .any)["mock-only-banner"].exists)
        XCTAssertFalse(app.buttons["View the mock demo"].exists)
    }

    /// Evidence of the real Live UI entry. No Cloud staging credentials are assumed.
    /// The screenshot is kept as an XCResult attachment, not mistaken for a live E2E chat.
    func testLiveCloudRequiresAppleSignInAndKeepsScreenshotEvidence() {
        let app = XCUIApplication()
        app.launchArguments = ["--ember-live-cloud"]
        app.launchEnvironment["EMBER_CLOUD_BASE_URL"] = "https://ember.invalid"
        app.launch()

        let signIn = app.descendants(matching: .any)
            .matching(identifier: "live-conversation-sign-in").firstMatch
        if !signIn.waitForExistence(timeout: 3) {
            let signOutButton = app.buttons["live-conversation-sign-out"]
            if signOutButton.waitForExistence(timeout: 3) && signOutButton.isEnabled {
                signOutButton.tap()
                let confirmSignOut = app.alerts.buttons.element(boundBy: 1)
                if confirmSignOut.waitForExistence(timeout: 5) {
                    confirmSignOut.tap()
                }
            }
        }
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
