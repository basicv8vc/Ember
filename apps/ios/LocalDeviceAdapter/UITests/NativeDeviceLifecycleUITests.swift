import XCTest

final class NativeDeviceLifecycleUITests: XCTestCase {
    @MainActor
    func testAdapterStopsForegroundWhenHomeIsPressed() {
        let adapter = XCUIApplication()
        adapter.launch()

        let foreground = adapter.staticTexts["native-device-adapter-scene"]
        let showForeground = NSPredicate(format: "label == %@", "Foreground")
        expectation(for: showForeground, evaluatedWith: foreground)
        waitForExpectations(timeout: 10)
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(adapter.wait(for: .runningBackground, timeout: 5)
                     || adapter.state == .runningBackgroundSuspended)
        adapter.activate()
        XCTAssertTrue(adapter.wait(for: .runningForeground, timeout: 5))
        expectation(for: showForeground, evaluatedWith: foreground)
        waitForExpectations(timeout: 10)
    }

    @MainActor
    func testPhysicalDeviceReclaimsAfterBackground() throws {
#if targetEnvironment(simulator)
        throw XCTSkip("Real iPhone and local workerd are required")
#else
        guard ProcessInfo.processInfo.environment["EMBER_DEVICE_PHYSICAL_LIFECYCLE"] == "1" else {
            throw XCTSkip("Enable the physical lifecycle scenario in the test runner environment")
        }
        let adapter = XCUIApplication()
        adapter.launch()

        let status = adapter.staticTexts["native-device-adapter-status"]
        let initial = try waitForClaim(status, timeout: 45) { _ in true }
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(adapter.wait(for: .runningBackground, timeout: 5)
                     || adapter.state == .runningBackgroundSuspended)

        // The runner is a separate process and leaves the adapter suspended for a full lease.
        Thread.sleep(forTimeInterval: 32)
        let backgroundState = adapter.state
        XCTAssertTrue(backgroundState == .runningBackground || backgroundState == .runningBackgroundSuspended)
        adapter.activate()
        XCTAssertTrue(adapter.wait(for: .runningForeground, timeout: 10))

        let reclaimed = try waitForClaim(status, timeout: 25) { claim in
            claim.taskID == initial.taskID && claim.runID != initial.runID && claim.epoch > initial.epoch
        }
        print("Physical device reclaimed task=\(reclaimed.taskID.uuidString) epoch=\(initial.epoch)->\(reclaimed.epoch)")
#endif
    }

    private struct Claim {
        let taskID: UUID
        let runID: UUID
        let epoch: Int

        init?(_ status: String) {
            let parts = status.split(separator: " ")
            guard parts.count == 4, parts[0] == "claimed",
                  parts[1].hasPrefix("task="), parts[2].hasPrefix("run="), parts[3].hasPrefix("epoch="),
                  let taskID = UUID(uuidString: String(parts[1].dropFirst("task=".count))),
                  let runID = UUID(uuidString: String(parts[2].dropFirst("run=".count))),
                  let epoch = Int(parts[3].dropFirst("epoch=".count))
            else { return nil }
            self.taskID = taskID
            self.runID = runID
            self.epoch = epoch
        }
    }

    @MainActor
    private func waitForClaim(
        _ element: XCUIElement,
        timeout: TimeInterval,
        matching: @escaping (Claim) -> Bool
    ) throws -> Claim {
        var observed: Claim?
        let predicate = NSPredicate { _, _ in
            guard element.exists, let claim = Claim(element.label), matching(claim) else { return false }
            observed = claim
            return true
        }
        expectation(for: predicate, evaluatedWith: nil)
        waitForExpectations(timeout: timeout)
        return try XCTUnwrap(observed)
    }

}
