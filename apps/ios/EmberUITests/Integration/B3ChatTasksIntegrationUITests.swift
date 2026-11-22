import XCTest

/// Verifies B3 Chat + Tasks dual-tab UI integration using `--ember-mock-chat-tasks`:
/// 1. Default landing on Chat tab with no normal chat regression.
/// 2. `task_reference` and `outcome_reference` render as real `TaskActivityCard` & `OutcomeCard` views.
/// 3. Navigation from Chat card and Tasks tab to Task Detail (timeline, cancel, result).
/// 4. Persisted state & chat messages reload cleanly across process relaunch.
@MainActor
final class B3ChatTasksIntegrationUITests: XCTestCase {
    func testChatCardsTasksTabCancelAndRelaunchPersistence() {
        let app = XCUIApplication()
        launch(app, reset: true)

        // 1. Default entrypoint is Chat tab
        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.staticTexts["task-flow-mock-only-label"].exists)

        // 2. Real TaskActivityCard and OutcomeCard render inline in Chat timeline
        let notesCard = app.buttons["task-activity-card-00000000-0000-4000-8000-00000000b311"]
        for _ in 0..<6 {
            if notesCard.exists && notesCard.isHittable { break }
            app.swipeDown()
        }
        XCTAssertTrue(notesCard.waitForExistence(timeout: 10))

        let outcomeCard = app.descendants(matching: .any)["outcome-card"].firstMatch
        XCTAssertTrue(outcomeCard.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.staticTexts
                .matching(NSPredicate(format: "label CONTAINS %@", "Confirm App Store review checklist"))
                .firstMatch
                .waitForExistence(timeout: 5)
        )
        attachScreenshot(app: app, name: "b3-01-chat-tab-cards")

        // 3. Open Task Detail from Chat's TaskActivityCard and verify activity + outcome
        XCTAssertTrue(notesCard.isHittable)
        notesCard.tap()
        XCTAssertTrue(app.descendants(matching: .any)["task-detail-summary"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["task-detail-timeline"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["task-detail-outcome"].waitForExistence(timeout: 10))
        attachScreenshot(app: app, name: "b3-02-task-detail-notes-outcome")

        let backToChat = app.navigationBars.buttons.firstMatch
        XCTAssertTrue(backToChat.waitForExistence(timeout: 10))
        backToChat.tap()
        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 10))

        // 4. Normal Chat still works without regression
        let composer = app.textFields["conversation-composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        let uniqueMessage = "B3 chat regression check"
        composer.typeText(uniqueMessage)
        let sendButton = app.buttons["conversation-send"]
        XCTAssertTrue(sendButton.isEnabled)
        sendButton.tap()

        let timeline = app.scrollViews["conversation-timeline"]
        let sentBubble = timeline.staticTexts
            .matching(identifier: "conversation-message-user")
            .matching(NSPredicate(format: "label CONTAINS %@", uniqueMessage))
            .firstMatch
        XCTAssertTrue(sentBubble.waitForExistence(timeout: 10))

        // 5. Switch to Tasks tab and verify status groups
        let tasksTabButton = app.tabBars.buttons["Tasks"]
        XCTAssertTrue(tasksTabButton.waitForExistence(timeout: 10))
        tasksTabButton.tap()

        XCTAssertTrue(app.descendants(matching: .any)["tasks-inbox-screen"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["tasks-section-needs-intervention"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["tasks-section-in-progress"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["tasks-section-completed"].waitForExistence(timeout: 10))
        attachScreenshot(app: app, name: "b3-03-tasks-tab-inbox")

        // 6. Open running task in Tasks tab and cancel it
        let runningRow = app.buttons["tasks-row-00000000-0000-4000-8000-00000000b312"]
        XCTAssertTrue(runningRow.waitForExistence(timeout: 10))
        runningRow.tap()

        let cancelButton = app.buttons["task-cancel"]
        for _ in 0..<4 {
            if cancelButton.exists && cancelButton.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(cancelButton.waitForExistence(timeout: 10))
        cancelButton.tap()

        // Wait until terminal state removes cancel button and cancelled badge appears
        let cancelRemoved = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: cancelButton
        )
        wait(for: [cancelRemoved], timeout: 10)
        let unavailableOutcome = app.descendants(matching: .any)["outcome-result-unavailable"]
        for _ in 0..<3 {
            if unavailableOutcome.exists { break }
            app.swipeUp()
        }
        XCTAssertTrue(unavailableOutcome.waitForExistence(timeout: 10))

        // 7. Terminate and relaunch WITHOUT reset to confirm persistence across relaunch
        app.terminate()
        launch(app, reset: false)

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))
        let reloadedTimeline = app.scrollViews["conversation-timeline"]
        let persistedBubble = reloadedTimeline.staticTexts
            .matching(identifier: "conversation-message-user")
            .matching(NSPredicate(format: "label CONTAINS %@", uniqueMessage))
            .firstMatch
        for _ in 0..<6 {
            if persistedBubble.exists { break }
            app.swipeUp()
        }
        XCTAssertTrue(persistedBubble.waitForExistence(timeout: 10))

        // Running task should remain cancelled after relaunch (not in In Progress)
        app.tabBars.buttons["Tasks"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["tasks-inbox-screen"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any)["tasks-section-in-progress"].exists)
        let cancelledRow = app.buttons["tasks-row-00000000-0000-4000-8000-00000000b312"]
        XCTAssertTrue(cancelledRow.waitForExistence(timeout: 10))
    }

    func testComposerPlusMenuOpensInsertsStarterPromptAndDismisses() {
        let app = XCUIApplication()
        launch(app, reset: true)

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))

        let attachButton = app.buttons["conversation-attach-file"]
        XCTAssertTrue(attachButton.waitForExistence(timeout: 10))
        XCTAssertTrue(attachButton.isEnabled)
        attachButton.tap()

        let menu = app.descendants(matching: .any)["conversation-attachment-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 5))
        let cameraRow = app.buttons["conversation-attachment-menu-camera"]
        XCTAssertTrue(cameraRow.waitForExistence(timeout: 5))
        let photoRow = app.buttons["conversation-attachment-menu-photo"]
        XCTAssertTrue(photoRow.waitForExistence(timeout: 5))
        let chooseFileRow = app.buttons["conversation-attachment-menu-file"]
        XCTAssertTrue(chooseFileRow.waitForExistence(timeout: 5))
        XCTAssertTrue(chooseFileRow.isHittable)
        let notesRow = app.buttons["conversation-attachment-menu-notes"]
        XCTAssertTrue(notesRow.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["conversation-attachment-menu-data"].waitForExistence(timeout: 5))

        attachScreenshot(app: app, name: "b3-04-composer-plus-menu")

        // Tap outside backdrop dismisses menu cleanly
        let dismissBackdrop = app.buttons["conversation-attachment-menu-dismiss"]
        if dismissBackdrop.exists && dismissBackdrop.isHittable {
            dismissBackdrop.tap()
        } else {
            attachButton.tap()
        }
        let menuDismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: menu
        )
        wait(for: [menuDismissed], timeout: 5)

        // Re-open menu and use starter prompt action
        attachButton.tap()
        XCTAssertTrue(notesRow.waitForExistence(timeout: 5))
        notesRow.tap()

        let menuClosedAfterPrompt = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: menu
        )
        wait(for: [menuClosedAfterPrompt], timeout: 5)

        let composer = app.textFields["conversation-composer-input"]
        let value = composer.value as? String ?? ""
        XCTAssertTrue(value.contains("action items"), "Expected starter prompt in composer, got: \(value)")
        XCTAssertTrue(app.buttons["conversation-send"].isEnabled)
    }

    func testMemorySheetSaveEditDeleteInMockConversation() {
        let app = XCUIApplication()
        launch(app, reset: true)

        XCTAssertTrue(app.otherElements["conversation-home"].waitForExistence(timeout: 12))

        let openMemoryButton = app.buttons["live-conversation-open-memory"]
        XCTAssertTrue(openMemoryButton.waitForExistence(timeout: 10))
        openMemoryButton.tap()

        let input = app.descendants(matching: .any)["memory-composer-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.typeText("Keep daily briefs in bullet points")

        let saveButton = app.buttons["memory-composer-save"]
        XCTAssertTrue(saveButton.waitForExistence(timeout: 5))
        XCTAssertTrue(saveButton.isEnabled)
        saveButton.tap()

        XCTAssertTrue(
            app.staticTexts["Keep daily briefs in bullet points"].waitForExistence(timeout: 5)
        )

        // Verify the newly added item row has a dedicated edit & delete button (beyond default sample b901)
        let editButtons = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH 'memory-edit-' AND identifier != 'memory-edit-00000000-0000-4000-8000-00000000b901'")
        )
        XCTAssertTrue(editButtons.firstMatch.waitForExistence(timeout: 5))
        let newEditID = editButtons.firstMatch.identifier
        let newUUIDSuffix = String(newEditID.dropFirst("memory-edit-".count))
        editButtons.firstMatch.tap()

        let editInput = app.descendants(matching: .any)["memory-edit-input"]
        XCTAssertTrue(editInput.waitForExistence(timeout: 5))
        editInput.tap()
        editInput.typeText(" with action items")

        let editSave = app.buttons["memory-edit-save"]
        XCTAssertTrue(editSave.isEnabled)
        editSave.tap()

        XCTAssertTrue(
            app.staticTexts
                .matching(NSPredicate(format: "label CONTAINS 'with action items'"))
                .firstMatch
                .waitForExistence(timeout: 5)
        )

        let deleteButton = app.buttons["memory-delete-\(newUUIDSuffix)"]
        XCTAssertTrue(deleteButton.waitForExistence(timeout: 5))
        deleteButton.tap()

        let confirmDelete = app.alerts.buttons["Delete"]
        XCTAssertTrue(confirmDelete.waitForExistence(timeout: 5))
        confirmDelete.tap()

        let deletedExpectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: app.buttons["memory-delete-\(newUUIDSuffix)"]
        )
        wait(for: [deletedExpectation], timeout: 5)

        let closeButton = app.buttons["memory-sheet-close"]
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
