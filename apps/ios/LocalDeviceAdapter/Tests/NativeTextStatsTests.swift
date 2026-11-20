import Foundation
import XCTest
@testable import LocalDeviceAdapter

final class NativeTextStatsTests: XCTestCase {
    func testCountsUTF8UnicodeScalarsAndLFSeparatedLinesWithoutNormalization() {
        let result = NativeTextStats(text: "A😀e\u{301}\r\n中\n")
        XCTAssertEqual(result.utf8Bytes, 14)
        XCTAssertEqual(result.unicodeScalars, 8)
        XCTAssertEqual(result.lines, 3)
        XCTAssertEqual(NativeTextStats(text: "").lines, 0)
        XCTAssertEqual(NativeTextStats(text: "a\rb").lines, 1)
        XCTAssertEqual(NativeTextStats(text: "\n").lines, 2)
    }

    func testConfigurationAllowsOnlyExplicitLocalOrigin() throws {
        let decoder = JSONDecoder()
        func config(_ url: String) throws -> LocalDeviceConfiguration {
            let data = try JSONSerialization.data(withJSONObject: [
                "EMBER_DEVICE_RELAY_URL": url,
                "EMBER_DEVICE_ACCOUNT_ID": "db5c0d5b-12d9-4d65-9394-65d8acf391f9",
                "EMBER_DEVICE_SESSION_TOKEN": "test-session",
                "EMBER_DEVICE_LOCAL_ACCESS": "test-secret",
            ])
            return try decoder.decode(LocalDeviceConfiguration.self, from: data)
        }
        XCTAssertEqual(try config("http://192.168.1.10:8787").origin.port, 8787)
        XCTAssertEqual(try config("http://qa-mac.local:8787").origin.host, "qa-mac.local")
        XCTAssertThrowsError(try config("http://example.com:8787"))
        XCTAssertThrowsError(try config("http://192.168.1.10:8787/other"))
        XCTAssertThrowsError(try config("http://192.168.1.10@example.com:8787"))
    }
}

final class LocalDeviceOutboxTests: XCTestCase {
    private func configuration(account: UUID) throws -> LocalDeviceConfiguration {
        let data = try JSONSerialization.data(withJSONObject: [
            "EMBER_DEVICE_RELAY_URL": "http://127.0.0.1:8787",
            "EMBER_DEVICE_ACCOUNT_ID": account.uuidString,
            "EMBER_DEVICE_SESSION_TOKEN": "test-session",
            "EMBER_DEVICE_LOCAL_ACCESS": "test-secret",
        ])
        return try JSONDecoder().decode(LocalDeviceConfiguration.self, from: data)
    }

    private func candidate() -> LocalDevicePendingResult {
        .init(
            taskID: UUID(),
            submission: .init(
                fence: .init(operationId: UUID(), runId: UUID(), leaseEpoch: 5),
                output: .init(text: "Text\r\n中")
            )
        )
    }

    func testUnknownAcknowledgmentRetainsOriginalPendingResultAcrossRestart() async throws {
        let root = URL.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let account = try configuration(account: UUID())
        let state = try LocalDeviceState(configuration: account, root: root)
        let pending = candidate()
        try state.savePending(pending)

        do {
            _ = try await state.submitPending(pending) { _ in
                throw URLError(.networkConnectionLost)
            }
            XCTFail("Expected lost acknowledgment")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .networkConnectionLost)
        }

        let resumed = try LocalDeviceState(configuration: account, root: root)
        let otherAccount = try LocalDeviceState(configuration: configuration(account: UUID()), root: root)
        XCTAssertNil(try otherAccount.loadPending())
        let recovered = try XCTUnwrap(resumed.loadPending())
        let result = try await resumed.submitPending(recovered) { original in
            XCTAssertEqual(original.taskID, pending.taskID)
            XCTAssertEqual(original.submission.operationId, pending.submission.operationId)
            XCTAssertEqual(original.submission.runId, pending.submission.runId)
            XCTAssertEqual(original.submission.leaseEpoch, pending.submission.leaseEpoch)
            XCTAssertEqual(original.submission.output, pending.submission.output)
            return try LocalDeviceClient.decodeCommitReceipt(
                status: 200, data: Data(#"{"kind":"committed","replayed":true}"#.utf8)
            )
        }
        guard case .committed(replayed: true) = result else {
            return XCTFail("Expected the original result receipt")
        }
        XCTAssertNil(try resumed.loadPending())
    }

    func testDistinguishesExplicitFencingFromConflictingResult() async throws {
        let root = URL.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let state = try LocalDeviceState(configuration: configuration(account: UUID()), root: root)
        let pending = candidate()
        try state.savePending(pending)

        do {
            _ = try await state.submitPending(pending) { _ in
                try LocalDeviceClient.decodeCommitReceipt(
                    status: 409, data: Data(#"{"error":{"code":"IDEMPOTENCY_CONFLICT"}}"#.utf8)
                )
            }
            XCTFail("Expected a conflict")
        } catch let error as LocalDeviceError {
            XCTAssertEqual(error, .resultConflict)
        }
        XCTAssertEqual(try state.loadPending()?.taskID, pending.taskID)

        let result = try await state.submitPending(pending) { _ in
            try LocalDeviceClient.decodeCommitReceipt(
                status: 409, data: Data(#"{"kind":"fenced"}"#.utf8)
            )
        }
        guard case .fenced = result else { return XCTFail("Expected an explicit fence") }
        XCTAssertNil(try state.loadPending())
    }
}
