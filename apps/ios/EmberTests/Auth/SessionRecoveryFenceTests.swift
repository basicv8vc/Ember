import XCTest
@testable import Ember

/// Behaviour of the durable rotation marker.
///
/// The property that matters is not "a file exists" but "an independent reader, as the next launch would
/// be, can see it" — and that `arm()` does not return before that is true.
final class SessionRecoveryFenceTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ember-fence-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let directory {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: directory.path
            )
            try? FileManager.default.removeItem(at: directory)
        }
        directory = nil
        try super.tearDownWithError()
    }

    func testArmIsVisibleToAFreshInstance() throws {
        let fence = FileSessionRecoveryFence(directory: directory)
        XCTAssertFalse(fence.isArmed)

        try fence.arm()
        XCTAssertTrue(fence.isArmed)

        // A separate instance is what the next launch sees: nothing in-memory carries over.
        let relaunched = FileSessionRecoveryFence(directory: directory)
        XCTAssertTrue(relaunched.isArmed)
    }

    func testClearRemovesTheMarker() throws {
        let fence = FileSessionRecoveryFence(directory: directory)
        try fence.arm()
        fence.clear()

        XCTAssertFalse(fence.isArmed)
        XCTAssertFalse(FileSessionRecoveryFence(directory: directory).isArmed)
        XCTAssertEqual(try contents(), [])
    }

    func testArmIsIdempotent() throws {
        let fence = FileSessionRecoveryFence(directory: directory)
        try fence.arm()
        try fence.arm()

        XCTAssertTrue(fence.isArmed)
        // No temporary siblings accumulate: the atomic write cleans up after itself.
        XCTAssertEqual(try contents(), [FileSessionRecoveryFence.fileName])
    }

    /// The marker must not become a second place where session material lives.
    func testTheMarkerCarriesNoCredential() throws {
        let fence = FileSessionRecoveryFence(directory: directory)
        try fence.arm()

        let payload = try XCTUnwrap(
            String(data: Data(contentsOf: markerURL()), encoding: .utf8)
        )
        XCTAssertEqual(payload, #"{"version":1}"#)

        // Belt and braces: nothing that could identify a session, a consumer or an Apple assertion.
        for forbidden in ["ems_", "token", "nonce", "consumer", "session", "@"] {
            XCTAssertFalse(payload.lowercased().contains(forbidden.lowercased()), forbidden)
        }
    }

    /// A marker that cannot be written must surface as an error, so the coordinator can refuse to rotate.
    func testArmFailsWhenTheDirectoryIsNotWritable() throws {
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o500],
            ofItemAtPath: directory.path
        )

        let fence = FileSessionRecoveryFence(directory: directory)
        XCTAssertThrowsError(try fence.arm()) { error in
            XCTAssertEqual(error as? AuthError, .recoveryFenceUnavailable)
        }
        XCTAssertFalse(fence.isArmed)
    }

    // MARK: - Helpers

    private func markerURL() -> URL {
        directory.appendingPathComponent(FileSessionRecoveryFence.fileName)
    }

    private func contents() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    }
}
