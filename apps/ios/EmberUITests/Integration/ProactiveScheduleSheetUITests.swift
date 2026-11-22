import XCTest

@MainActor
final class ProactiveScheduleSheetUITests: XCTestCase {
    func testSchedulesSheetShowsExistingFirstAndSupportsCreatePauseResumeCancel() {
        let app = XCUIApplication()
        launch(app, reset: true)

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))

        let openSchedulesButton = app.buttons["live-conversation-open-schedules"]
        XCTAssertTrue(openSchedulesButton.waitForExistence(timeout: 10))
        openSchedulesButton.tap()

        // Existing default sample e501 ("Morning Brief") is shown first; creation form is secondary.
        let activeSection = app.otherElements["schedules-section-active"]
        XCTAssertTrue(activeSection.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Morning Brief"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.textFields["schedules-title-input"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["mock-only-banner"].waitForExistence(timeout: 5))
        let subtitle = app.staticTexts["schedules-subtitle"]
        XCTAssertTrue(subtitle.exists)
        XCTAssertTrue(subtitle.label.contains("local demo mode"))
        attachScreenshot(app: app, name: "ux06-schedules-existing-first")

        let sampleID = "00000000-0000-4000-8000-00000000e501"
        let pauseButton = app.buttons["schedule-pause-\(sampleID)"]
        XCTAssertTrue(pauseButton.waitForExistence(timeout: 5))
        pauseButton.tap()

        let pausedSection = app.otherElements["schedules-section-paused"]
        XCTAssertTrue(pausedSection.waitForExistence(timeout: 5))
        attachScreenshot(app: app, name: "ux06-schedules-paused")

        let resumeButton = app.buttons["schedule-resume-\(sampleID)"]
        XCTAssertTrue(resumeButton.waitForExistence(timeout: 5))
        resumeButton.tap()
        XCTAssertTrue(app.buttons["schedule-pause-\(sampleID)"].waitForExistence(timeout: 5))

        // Open secondary New Schedule sheet
        let addButton = app.buttons["schedules-add-button"]
        XCTAssertTrue(addButton.waitForExistence(timeout: 5))
        addButton.tap()

        let titleField = app.textFields["schedules-title-input"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))
        titleField.tap()
        titleField.typeText("Afternoon Sync")

        let promptField = app.descendants(matching: .any)["schedules-prompt-input"]
        XCTAssertTrue(promptField.waitForExistence(timeout: 5))
        promptField.tap()
        promptField.typeText("Summarize afternoon blockers")

        let preset15m = app.buttons["schedules-preset-15m"]
        if preset15m.waitForExistence(timeout: 3) {
            preset15m.tap()
        }
        attachScreenshot(app: app, name: "ux06-schedules-create-sheet")

        let createButton = app.buttons["schedules-create-button"]
        XCTAssertTrue(createButton.waitForExistence(timeout: 5))
        XCTAssertTrue(createButton.isEnabled)
        createButton.tap()

        XCTAssertTrue(app.staticTexts["Afternoon Sync"].waitForExistence(timeout: 5))

        let cancelButtons = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH 'schedule-cancel-' AND identifier != 'schedule-cancel-\(sampleID)'")
        )
        XCTAssertTrue(cancelButtons.firstMatch.waitForExistence(timeout: 5))
        cancelButtons.firstMatch.tap()

        let confirmCancel = app.alerts.buttons["Cancel"].firstMatch
        XCTAssertTrue(confirmCancel.waitForExistence(timeout: 5))
        // Note: alert has two buttons labeled "Cancel" in en (dismiss vs destructive). Tap the destructive second button.
        let alertButtons = app.alerts.buttons
        XCTAssertGreaterThanOrEqual(alertButtons.count, 2)
        alertButtons.element(boundBy: alertButtons.count - 1).tap()

        let historySection = app.otherElements["schedules-section-history"]
        XCTAssertTrue(historySection.waitForExistence(timeout: 5))
        attachScreenshot(app: app, name: "ux06-schedules-history")

        let closeButton = app.buttons["schedules-sheet-close"]
        XCTAssertTrue(closeButton.waitForExistence(timeout: 5))
        closeButton.tap()
        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 5))
    }

    private func launch(_ app: XCUIApplication, reset: Bool) {
        var args = ["--ember-mock-chat-tasks"]
        if reset {
            args.append("--ember-mock-chat-tasks-reset")
        }
        args.append(contentsOf: ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"])
        app.launchArguments = args
        app.launch()
    }

    private func attachScreenshot(app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
