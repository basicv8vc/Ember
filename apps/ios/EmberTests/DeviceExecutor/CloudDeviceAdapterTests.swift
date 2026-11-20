import Foundation
import SwiftUI
import XCTest
@testable import Ember

final class CloudDeviceAdapterTests: XCTestCase {
    private var tempDirectories: [URL] = []

    override func tearDown() {
        StubCloudURLProtocol.setHandler(nil)
        for dir in tempDirectories {
            try? FileManager.default.removeItem(at: dir)
        }
        tempDirectories.removeAll()
        super.tearDown()
    }

    private func makeTempDirectory() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cloud-device-adapter-\(UUID().uuidString.lowercased())", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        tempDirectories.append(dir)
        return dir
    }

    private func makeConfiguration(
        origin: String = "https://api.ember.test",
        accountID: UUID = UUID(),
        localAccessSecret: String? = nil,
        workDelay: Duration = .zero,
        heartbeatInterval: Duration = .seconds(10)
    ) throws -> CloudDeviceEndpointConfiguration {
        try CloudDeviceEndpointConfiguration(
            origin: XCTUnwrap(URL(string: origin)),
            accountID: accountID,
            localAccessSecret: localAccessSecret,
            heartbeatInterval: heartbeatInterval,
            simulatedWorkDelay: workDelay
        )
    }

    private func makeStubSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubCloudURLProtocol.self]
        return URLSession(configuration: config)
    }

    // MARK: - 1. Configuration & Text Stats Contract

    func testEndpointOriginValidationRules() throws {
        XCTAssertNotNil(CloudDeviceEndpointConfiguration.validatedOrigin(try XCTUnwrap(URL(string: "https://edge.ember.ai"))))
        XCTAssertNotNil(CloudDeviceEndpointConfiguration.validatedOrigin(try XCTUnwrap(URL(string: "http://localhost:8787"))))
        XCTAssertNotNil(CloudDeviceEndpointConfiguration.validatedOrigin(try XCTUnwrap(URL(string: "http://127.0.0.1:8787"))))
        XCTAssertNotNil(CloudDeviceEndpointConfiguration.validatedOrigin(try XCTUnwrap(URL(string: "http://192.168.1.42:9000"))))
        XCTAssertNotNil(CloudDeviceEndpointConfiguration.validatedOrigin(try XCTUnwrap(URL(string: "http://macbook.local:8787/"))))

        // Reject public plain HTTP, query/fragment, credentials, and subpaths
        XCTAssertNil(CloudDeviceEndpointConfiguration.validatedOrigin(try XCTUnwrap(URL(string: "http://example.com"))))
        XCTAssertNil(CloudDeviceEndpointConfiguration.validatedOrigin(try XCTUnwrap(URL(string: "https://user:pass@edge.ember.ai"))))
        XCTAssertNil(CloudDeviceEndpointConfiguration.validatedOrigin(try XCTUnwrap(URL(string: "https://edge.ember.ai/v2"))))
        XCTAssertNil(CloudDeviceEndpointConfiguration.validatedOrigin(try XCTUnwrap(URL(string: "https://edge.ember.ai?x=1"))))
        XCTAssertNil(CloudDeviceEndpointConfiguration.validatedOrigin(try XCTUnwrap(URL(string: "https://edge.ember.ai#frag"))))
    }

    func testCloudDeviceTextStatsMatchesF2UnicodeAndLFContract() {
        XCTAssertEqual(
            CloudDeviceTextStats(text: ""),
            CloudDeviceTextStats(utf8Bytes: 0, unicodeScalars: 0, lines: 0)
        )
        XCTAssertEqual(
            CloudDeviceTextStats(text: "hello"),
            CloudDeviceTextStats(utf8Bytes: 5, unicodeScalars: 5, lines: 1)
        )
        XCTAssertEqual(
            CloudDeviceTextStats(text: "a\nb\n"),
            CloudDeviceTextStats(utf8Bytes: 4, unicodeScalars: 4, lines: 3)
        )
        XCTAssertEqual(
            CloudDeviceTextStats(text: "a\r\nb"),
            CloudDeviceTextStats(utf8Bytes: 4, unicodeScalars: 4, lines: 2)
        )
        XCTAssertEqual(
            CloudDeviceTextStats(text: "a\rb"),
            CloudDeviceTextStats(utf8Bytes: 3, unicodeScalars: 3, lines: 1)
        )
        // Emoji family: 1 Character in Swift, multiple Unicode scalars & UTF-8 bytes
        let emoji = "👨‍👩‍👧‍👦中"
        XCTAssertEqual(
            CloudDeviceTextStats(text: emoji),
            CloudDeviceTextStats(
                utf8Bytes: emoji.utf8.count,
                unicodeScalars: emoji.unicodeScalars.count,
                lines: 1
            )
        )
    }

    // MARK: - 2. End-to-End Wire Roundtrip & Authoritative Cloud IDs

    func testCloudAdapterRegistersClaimsExecutesNativeStatsAndCommitsWithAuthoritativeFence() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration(origin: "http://127.0.0.1:8787", localAccessSecret: "qa-secret-123")
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "b1-bearer-token")
        let creds = InMemoryCloudDeviceCredentialStore()
        let credential = try creds.loadOrCreateCredential(for: config.scopeIdentifier)

        let cloudTaskID = UUID()
        let cloudOperationID = UUID()
        let cloudRunID = UUID()
        let cloudEpoch = 3
        let inputText = "Hello Cloud!\nEmber iPhone node 🚀"
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        let recordedRequests = LockedRecorder<RecordedHTTPRequest>()
        StubCloudURLProtocol.setHandler { request in
            let path = request.url?.path ?? ""
            let bodyData = Self.readBody(request)
            let record = RecordedHTTPRequest(
                method: request.httpMethod ?? "",
                path: path,
                authorization: request.value(forHTTPHeaderField: "Authorization"),
                deviceToken: request.value(forHTTPHeaderField: CloudDeviceContract.deviceTokenHeader),
                localAccess: request.value(forHTTPHeaderField: CloudDeviceContract.localAccessHeader),
                bodyData: bodyData
            )
            recordedRequests.append(record)

            let dev = credential.normalizedDeviceID
            if path == "/v2/devices/\(dev)/register" {
                let json = """
                {"deviceId":"\(dev)","capability":"device.text.process","version":1,"readyUntilMs":\(clock.nowMs + 30_000)}
                """
                return (200, Data(json.utf8))
            }
            if path == "/v2/devices/\(dev)/claim" {
                let json = """
                {
                  "kind": "claimed",
                  "taskId": "\(cloudTaskID.uuidString.lowercased())",
                  "operationId": "\(cloudOperationID.uuidString.lowercased())",
                  "runId": "\(cloudRunID.uuidString.lowercased())",
                  "leaseEpoch": \(cloudEpoch),
                  "leaseExpiresAtMs": \(clock.nowMs + 30_000),
                  "deadlineAtMs": \(clock.nowMs + 60_000),
                  "capability": "device.text.process",
                  "version": 1,
                  "input": { "operation": "stats", "text": "Hello Cloud!\\nEmber iPhone node 🚀" }
                }
                """
                return (200, Data(json.utf8))
            }
            if path == "/v2/devices/\(dev)/tasks/\(cloudTaskID.uuidString.lowercased())/result" {
                return (200, Data(#"{"kind":"committed","replayed":false}"#.utf8))
            }
            XCTFail("Unexpected HTTP path: \(path)")
            return (404, Data())
        }

        let journal = CloudDeviceExecutionJournal(directory: dir)
        let client = CloudDeviceAPIClient(configuration: config, authProvider: auth, session: makeStubSession())
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: client,
            journal: journal,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )

        let outcome = try await adapter.runSingleCycle()
        XCTAssertEqual(outcome, .executed(taskId: cloudTaskID, outcome: .committed(replayed: false)))

        let requests = recordedRequests.snapshot()
        XCTAssertEqual(requests.map(\.path), [
            "/v2/devices/\(credential.normalizedDeviceID)/register",
            "/v2/devices/\(credential.normalizedDeviceID)/claim",
            "/v2/devices/\(credential.normalizedDeviceID)/tasks/\(cloudTaskID.uuidString.lowercased())/result",
        ])

        for req in requests {
            XCTAssertEqual(req.authorization, "Bearer b1-bearer-token")
            XCTAssertEqual(req.deviceToken, credential.token)
            XCTAssertEqual(req.localAccess, "qa-secret-123")
        }

        let resultPayload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try XCTUnwrap(requests.last?.bodyData)) as? [String: Any]
        )
        XCTAssertEqual(resultPayload["operationId"] as? String, cloudOperationID.uuidString.lowercased())
        XCTAssertEqual(resultPayload["runId"] as? String, cloudRunID.uuidString.lowercased())
        XCTAssertEqual(resultPayload["leaseEpoch"] as? Int, cloudEpoch)
        XCTAssertEqual(resultPayload["status"] as? String, "completed")
        let output = try XCTUnwrap(resultPayload["output"] as? [String: Any])
        XCTAssertEqual(output["utf8Bytes"] as? Int, inputText.utf8.count)
        XCTAssertEqual(output["unicodeScalars"] as? Int, inputText.unicodeScalars.count)
        XCTAssertEqual(output["lines"] as? Int, 2)

        // Journal preserves authoritative Cloud IDs and M2-C1 NativeTextTool checkpoint metadata.
        let savedRecord = try await journal.record(for: cloudTaskID)
        let record = try XCTUnwrap(savedRecord)
        XCTAssertEqual(record.taskId, cloudTaskID)
        XCTAssertEqual(record.operationId, cloudOperationID)
        XCTAssertEqual(record.runId, cloudRunID)
        XCTAssertEqual(record.leaseEpoch, cloudEpoch)
        XCTAssertEqual(record.phase, .committed(replayed: false))
        XCTAssertNil(record.pendingSubmission)
        XCTAssertEqual(record.nativeStepOutput?.structuredData?.objectValue?["word_count"]?.intValue, 6)
        let expectedUTF8Bytes = inputText.utf8.count
        XCTAssertEqual(record.nativeStepOutput?.structuredData?.objectValue?["utf8_bytes"]?.intValue, expectedUTF8Bytes)
    }

    func testQAFileConfigurationDecodingAndUnauthenticatedSessionError() async throws {
        let validJSON = """
        {
          "EMBER_DEVICE_RELAY_URL": "http://192.168.1.50:8787",
          "EMBER_DEVICE_ACCOUNT_ID": "11111111-1111-1111-1111-111111111111",
          "EMBER_DEVICE_SESSION_TOKEN": "qa-bearer-token",
          "EMBER_DEVICE_LOCAL_ACCESS": "lan-secret-xyz",
          "EMBER_DEVICE_WORK_DELAY_MS": 250
        }
        """
        let qaConfig = try JSONDecoder().decode(CloudDeviceQAFileConfiguration.self, from: Data(validJSON.utf8))
        let endpoint = try qaConfig.makeEndpointConfiguration()
        XCTAssertEqual(endpoint.origin.absoluteString, "http://192.168.1.50:8787")
        XCTAssertEqual(endpoint.localAccessSecret, "lan-secret-xyz")
        XCTAssertEqual(endpoint.simulatedWorkDelay, .milliseconds(250))

        let mockAuth = MockAuthSessionProvider(initialState: .unauthenticated)
        let creds = InMemoryCloudDeviceCredentialStore()
        let credential = try creds.loadOrCreateCredential(for: endpoint.scopeIdentifier)
        let client = CloudDeviceAPIClient(configuration: endpoint, authProvider: mockAuth, session: makeStubSession())
        do {
            _ = try await client.register(credential: credential)
            XCTFail("Expected unauthenticated error")
        } catch let error as CloudDeviceError {
            XCTAssertEqual(error, .unauthenticated)
        }
    }

    // MARK: - 3. Crash / Unknown ACK Recovery with Original Cloud Fence

    func testUnknownAckOnResultPreservesFenceAcrossRestartAndReplaysIdempotently() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let credential = try creds.loadOrCreateCredential(for: config.scopeIdentifier)

        let taskID = UUID()
        let operationID = UUID()
        let runID = UUID()
        let epoch = 7
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        let resultAttempts = LockedCounter()
        StubCloudURLProtocol.setHandler { request in
            let path = request.url?.path ?? ""
            let dev = credential.normalizedDeviceID
            if path == "/v2/devices/\(dev)/register" {
                return (200, Data(#"{"deviceId":"\#(dev)","capability":"device.text.process","version":1,"readyUntilMs":1700000030000}"#.utf8))
            }
            if path == "/v2/devices/\(dev)/claim" {
                return (200, Data("""
                {"kind":"claimed","taskId":"\(taskID.uuidString.lowercased())","operationId":"\(operationID.uuidString.lowercased())","runId":"\(runID.uuidString.lowercased())","leaseEpoch":\(epoch),"leaseExpiresAtMs":1700000030000,"deadlineAtMs":1700000060000,"capability":"device.text.process","version":1,"input":{"operation":"stats","text":"abc"}}
                """.utf8))
            }
            if path == "/v2/devices/\(dev)/tasks/\(taskID.uuidString.lowercased())/result" {
                let attempt = resultAttempts.increment()
                if attempt == 1 {
                    return (503, Data(#"{"error":"transient_unavailable"}"#.utf8))
                }
                return (200, Data(#"{"kind":"committed","replayed":true}"#.utf8))
            }
            XCTFail("Unexpected HTTP path: \(path)")
            return (404, Data())
        }

        let transport1 = CloudDeviceAPIClient(configuration: config, authProvider: auth, session: makeStubSession())
        let adapter1 = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: transport1,
            journal: CloudDeviceExecutionJournal(directory: dir),
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )

        do {
            _ = try await adapter1.runSingleCycle()
            XCTFail("Expected HTTP 503 failure on first /result attempt")
        } catch let error as CloudDeviceError {
            XCTAssertEqual(error, .httpStatus(503))
        }

        // Emulate cold restart: brand-new journal + adapter pointing at same disk directory.
        let journal2 = CloudDeviceExecutionJournal(directory: dir)
        let pendingBeforeFlush = try await journal2.pendingSubmissions()
        XCTAssertEqual(pendingBeforeFlush.count, 1)
        XCTAssertEqual(pendingBeforeFlush[0].taskId, taskID)
        XCTAssertEqual(pendingBeforeFlush[0].runId, runID)
        XCTAssertEqual(pendingBeforeFlush[0].leaseEpoch, epoch)

        let transport2 = CloudDeviceAPIClient(configuration: config, authProvider: auth, session: makeStubSession())
        let adapter2 = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: transport2,
            journal: journal2,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )

        // Next cycle must flush the pending submission BEFORE claiming any new task.
        let recoveryOutcome = try await adapter2.runSingleCycle()
        XCTAssertEqual(recoveryOutcome, .flushedPending(taskId: taskID, outcome: .committed(replayed: true)))

        let remainingPending = try await journal2.pendingSubmissions()
        XCTAssertTrue(remainingPending.isEmpty)
        let finalRecord = try await journal2.record(for: taskID)
        XCTAssertEqual(finalRecord?.phase, .committed(replayed: true))
    }

    // MARK: - 4. Unfinished Local Claim Recovery via Renew (Committed vs Fenced)

    func testUnfinishedClaimRenewsWithOriginalFenceOnRestartAndHandlesFencing() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        let taskID = UUID()
        let operationID = UUID()
        let runID = UUID()
        let offer = CloudDeviceClaimOffer(
            taskId: taskID,
            operationId: operationID,
            runId: runID,
            leaseEpoch: 2,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "resume me")
        )

        // Simulate crash mid-execution right after claiming.
        let journalBeforeCrash = CloudDeviceExecutionJournal(directory: dir)
        _ = try await journalBeforeCrash.recordClaim(offer, nowMs: clock.nowMs)

        let stub = MockCloudTransport(
            readyUntilMs: clock.nowMs + 30_000,
            renewOutcome: .fenced
        )
        let journalAfterRestart = CloudDeviceExecutionJournal(directory: dir)
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: stub,
            journal: journalAfterRestart,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )

        let outcome = try await adapter.runSingleCycle()
        XCTAssertEqual(outcome, .recoveredFenced(taskId: taskID))
        let submittedCount = await stub.resultSubmissions.count
        XCTAssertEqual(submittedCount, 0)
        let recovered = try await journalAfterRestart.record(for: taskID)
        XCTAssertEqual(recovered?.phase, .fenced)
    }

    func testUnfinishedClaimRenewsAndCompletesWhenCloudStillOwnsLease() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        let offer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 4,
            leaseExpiresAtMs: clock.nowMs + 20_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "line1\nline2")
        )

        let journal1 = CloudDeviceExecutionJournal(directory: dir)
        _ = try await journal1.recordClaim(offer, nowMs: clock.nowMs)

        let stub = MockCloudTransport(
            readyUntilMs: clock.nowMs + 30_000,
            renewOutcome: .renewed(leaseExpiresAtMs: clock.nowMs + 45_000),
            commitOutcome: .committed(replayed: false)
        )
        let journal2 = CloudDeviceExecutionJournal(directory: dir)
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: stub,
            journal: journal2,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )

        let outcome = try await adapter.runSingleCycle()
        XCTAssertEqual(outcome, .recoveredUnfinished(taskId: offer.taskId, outcome: .committed(replayed: false)))

        let submissions = await stub.resultSubmissions
        XCTAssertEqual(submissions.count, 1)
        XCTAssertEqual(submissions[0].operationId, offer.operationId)
        XCTAssertEqual(submissions[0].runId, offer.runId)
        XCTAssertEqual(submissions[0].leaseEpoch, offer.leaseEpoch)
        XCTAssertEqual(submissions[0].output, CloudDeviceTextStats(utf8Bytes: 11, unicodeScalars: 11, lines: 2))
    }

    // MARK: - 5. Mid-Execution Lease Renew Fenced & Supersede Epoch

    func testLongExecutionRenewsLeaseAndStopsWhenCloudFencesRun() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration(workDelay: .milliseconds(300), heartbeatInterval: .milliseconds(100))
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        let offer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "long task")
        )

        let stub = MockCloudTransport(
            readyUntilMs: clock.nowMs + 30_000,
            queuedClaims: [offer],
            renewOutcome: .fenced
        )
        let journal = CloudDeviceExecutionJournal(directory: dir)
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: stub,
            journal: journal,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )

        let outcome = try await adapter.runSingleCycle()
        XCTAssertEqual(outcome, .interruptedFenced(taskId: offer.taskId))
        let resultSubmissionsCount = await stub.resultSubmissions.count
        XCTAssertEqual(resultSubmissionsCount, 0)
        let saved = try await journal.record(for: offer.taskId)
        XCTAssertEqual(saved?.phase, .fenced)
    }

    func testHigherEpochClaimSupersedesPriorLocalRunRecord() async throws {
        let dir = try makeTempDirectory()
        let journal = CloudDeviceExecutionJournal(directory: dir)
        let taskID = UUID()
        let opID = UUID()
        let nowMs: Int64 = 1_700_000_000_000

        let offerEpoch1 = CloudDeviceClaimOffer(
            taskId: taskID,
            operationId: opID,
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: nowMs + 10_000,
            deadlineAtMs: nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "v1")
        )
        let run2 = UUID()
        let offerEpoch2 = CloudDeviceClaimOffer(
            taskId: taskID,
            operationId: opID,
            runId: run2,
            leaseEpoch: 2,
            leaseExpiresAtMs: nowMs + 30_000,
            deadlineAtMs: nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "v1")
        )

        _ = try await journal.recordClaim(offerEpoch1, nowMs: nowMs)
        _ = try await journal.stageResultSubmission(
            taskID: taskID,
            submission: CloudDeviceResultSubmission(fence: offerEpoch1.fence, output: CloudDeviceTextStats(text: "v1")),
            nowMs: nowMs + 10
        )

        let updated = try await journal.recordClaim(offerEpoch2, nowMs: nowMs + 20)
        XCTAssertEqual(updated.runId, run2)
        XCTAssertEqual(updated.leaseEpoch, 2)
        XCTAssertEqual(updated.phase, .claimed)
        XCTAssertNil(updated.pendingSubmission)
    }

    // MARK: - 6. Revocation, Capability Conflict, Oversized Input & Journal Bounds

    func testRevokedDeviceAndCapabilityConflictFailClosedWithoutRetry() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let credential = try creds.loadOrCreateCredential(for: config.scopeIdentifier)

        StubCloudURLProtocol.setHandler { _ in (403, Data(#"{"status":"revoked"}"#.utf8)) }
        let client = CloudDeviceAPIClient(configuration: config, authProvider: auth, session: makeStubSession())
        do {
            _ = try await client.register(credential: credential)
            XCTFail("Expected deviceRevoked")
        } catch let error as CloudDeviceError {
            XCTAssertEqual(error, .deviceRevoked)
            XCTAssertFalse(error.canRetry)
        }

        StubCloudURLProtocol.setHandler { _ in (409, Data(#"{"error":"capability_conflict"}"#.utf8)) }
        do {
            _ = try await client.register(credential: credential)
            XCTFail("Expected capabilityConflict")
        } catch let error as CloudDeviceError {
            XCTAssertEqual(error, .capabilityConflict)
            XCTAssertFalse(error.canRetry)
        }

        // Clean up unused temp directory reference check
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path))
    }

    func testOversizedOfferTextSubmitsFencedFailedStatusWithoutOutput() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        let oversizedText = String(repeating: "a", count: CloudDeviceContract.maxTextUTF16Units + 1)
        let offer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: oversizedText)
        )

        let stub = MockCloudTransport(readyUntilMs: clock.nowMs + 30_000, queuedClaims: [offer])
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: stub,
            journal: CloudDeviceExecutionJournal(directory: dir),
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )

        let outcome = try await adapter.runSingleCycle()
        XCTAssertEqual(outcome, .executed(taskId: offer.taskId, outcome: .committed(replayed: false)))
        let submissions = await stub.resultSubmissions
        XCTAssertEqual(submissions.count, 1)
        XCTAssertEqual(submissions[0].status, .failed)
        XCTAssertNil(submissions[0].output)
    }

    func testJournalPruningPreservesPendingCommitWhileEvictingOldestTerminal() async throws {
        let dir = try makeTempDirectory()
        let journal = CloudDeviceExecutionJournal(directory: dir, maxRecords: 2)
        let baseMs: Int64 = 1_700_000_000_000

        let pendingTaskID = UUID()
        let pendingOffer = CloudDeviceClaimOffer(
            taskId: pendingTaskID,
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: baseMs + 30_000,
            deadlineAtMs: baseMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "keep")
        )
        _ = try await journal.recordClaim(pendingOffer, nowMs: baseMs)
        _ = try await journal.stageResultSubmission(
            taskID: pendingTaskID,
            submission: CloudDeviceResultSubmission(
                fence: pendingOffer.fence,
                output: CloudDeviceTextStats(text: "keep")
            ),
            nowMs: baseMs + 1
        )

        let terminal1 = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: baseMs + 30_000,
            deadlineAtMs: baseMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "old")
        )
        _ = try await journal.recordClaim(terminal1, nowMs: baseMs + 2)
        _ = try await journal.recordCommitted(taskID: terminal1.taskId, fence: terminal1.fence, replayed: false, nowMs: baseMs + 3)

        let terminal2 = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: baseMs + 30_000,
            deadlineAtMs: baseMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "new")
        )
        _ = try await journal.recordClaim(terminal2, nowMs: baseMs + 4)
        _ = try await journal.recordCommitted(taskID: terminal2.taskId, fence: terminal2.fence, replayed: false, nowMs: baseMs + 5)

        let all = try await journal.allRecords()
        XCTAssertEqual(all.count, 2)
        let keptPending = try await journal.record(for: pendingTaskID)
        let prunedTerminal = try await journal.record(for: terminal1.taskId)
        let keptTerminal = try await journal.record(for: terminal2.taskId)
        XCTAssertNotNil(keptPending)
        XCTAssertNil(prunedTerminal)
        XCTAssertNotNil(keptTerminal)
    }

    // MARK: - 7. P1-1: iOS ScenePhase Lifecycle & Background Expiration

    func testBackgroundSuspendsClaimingAndForegroundReregistersAndRecoversPrioritizingPending() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration(heartbeatInterval: .seconds(10))
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)
        let bgManager = StubBackgroundTaskManager()

        let pendingOffer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "pending")
        )
        let unfinishedOffer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 2,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "unfinished\nline2")
        )
        let freshOffer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "fresh")
        )

        let journal = CloudDeviceExecutionJournal(directory: dir)
        let transport = RecordingCloudTransport(
            readyUntilMs: clock.nowMs + 30_000,
            queuedClaims: [freshOffer],
            renewOutcome: .renewed(leaseExpiresAtMs: clock.nowMs + 45_000),
            commitOutcome: .committed(replayed: true)
        )
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: transport,
            journal: journal,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock,
            backgroundTaskManager: bgManager
        )

        // Start in foreground, then enter background -> must stop claiming new work.
        await adapter.handleScenePhase(.background)
        let bgCycle = try await adapter.runSingleCycle()
        XCTAssertEqual(bgCycle, .idle)
        let claimCountInBg = await transport.claimCount
        XCTAssertEqual(claimCountInBg, 0, "Must not claim new tasks while in background")

        // Stage a pending submission and an unfinished claim (as if left behind prior to suspension).
        _ = try await journal.recordClaim(pendingOffer, nowMs: clock.nowMs)
        _ = try await journal.stageResultSubmission(
            taskID: pendingOffer.taskId,
            submission: CloudDeviceResultSubmission(
                fence: pendingOffer.fence,
                output: CloudDeviceTextStats(text: "pending")
            ),
            nowMs: clock.nowMs + 1
        )
        _ = try await journal.recordClaim(unfinishedOffer, nowMs: clock.nowMs + 2)

        let regCountBeforeForeground = await transport.registerCount

        // Return to foreground -> must re-register, flush pending first, then renew & recover unfinished, then claim.
        await adapter.handleScenePhase(.active)

        let cycle1 = try await adapter.runSingleCycle()
        XCTAssertEqual(cycle1, .flushedPending(taskId: pendingOffer.taskId, outcome: .committed(replayed: true)))
        let regCountAfterForeground = await transport.registerCount
        XCTAssertEqual(regCountAfterForeground, regCountBeforeForeground + 1, "Foreground resume must re-register device")

        let cycle2 = try await adapter.runSingleCycle()
        XCTAssertEqual(cycle2, .recoveredUnfinished(taskId: unfinishedOffer.taskId, outcome: .committed(replayed: true)))
        let renewedFences = await transport.renewedFences
        XCTAssertEqual(renewedFences, [unfinishedOffer.fence], "Unfinished task must verify original Cloud fence via /renew")

        let cycle3 = try await adapter.runSingleCycle()
        XCTAssertEqual(cycle3, .executed(taskId: freshOffer.taskId, outcome: .committed(replayed: true)))

        let leaked = await bgManager.activeTaskIDs
        XCTAssertTrue(leaked.isEmpty, "All background task identifiers must be released")
    }

    func testBackgroundExpirationInterruptsExecutionPreservesJournalAndReleasesBackgroundTask() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)
        let bgManager = StubBackgroundTaskManager()

        let offer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "interrupt me\nplease")
        )

        let toolGate = ControllableNativeTextTool()
        let transport = RecordingCloudTransport(
            readyUntilMs: clock.nowMs + 30_000,
            queuedClaims: [offer],
            renewOutcome: .renewed(leaseExpiresAtMs: clock.nowMs + 45_000)
        )
        let journal = CloudDeviceExecutionJournal(directory: dir)
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: transport,
            journal: journal,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            textTool: toolGate,
            clock: clock,
            backgroundTaskManager: bgManager
        )

        let cycleTask = Task {
            try await adapter.runSingleCycle()
        }

        // Deterministically wait until NativeTool execution has started.
        await toolGate.waitUntilStarted()
        await adapter.handleScenePhase(.background)

        let beganCount = await bgManager.beganCount
        XCTAssertGreaterThanOrEqual(beganCount, 1)
        let hasExpirationHandler = await bgManager.hasActiveExpirationHandler
        XCTAssertTrue(hasExpirationHandler, "beginBackgroundTask must install a real expiration handler")

        // Trigger iOS background expiration deterministically.
        await bgManager.triggerExpiration()

        do {
            _ = try await cycleTask.value
            XCTFail("Expected CancellationError when background execution expires")
        } catch is CancellationError {
            // Expected cooperative interruption
        }

        // Background task identifier must be released and never leaked.
        let activeBG = await bgManager.activeTaskIDs
        XCTAssertTrue(activeBG.isEmpty, "Background task identifier must be ended after expiration")
        let endedCount = await bgManager.endedCount
        XCTAssertEqual(endedCount, beganCount)

        // Durable journal must preserve the claimed record (not failedLocally or fenced) and nothing submitted.
        let submissionsBeforeResume = await transport.resultSubmissions.count
        XCTAssertEqual(submissionsBeforeResume, 0)
        let preserved = try await journal.record(for: offer.taskId)
        XCTAssertEqual(preserved?.phase, .claimed)

        // Allow tool to complete on foreground recovery, resume foreground, and verify /renew + completion.
        await toolGate.setShouldPause(false)
        await adapter.handleScenePhase(.active)
        let recovered = try await adapter.runSingleCycle()
        XCTAssertEqual(recovered, .recoveredUnfinished(taskId: offer.taskId, outcome: .committed(replayed: false)))
        let renewedFences = await transport.renewedFences
        XCTAssertEqual(renewedFences, [offer.fence])
    }

    // MARK: - 8. P1-2: Stop / Start Concurrency Safety & Monitor Reconnect

    func testStopWaitsForOldLoopAndRapidStopStartNeverCreatesDuplicateLoops() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        let gatedTransport = GatedCloudTransport(readyUntilMs: clock.nowMs + 30_000)
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: gatedTransport,
            journal: CloudDeviceExecutionJournal(directory: dir),
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )

        // Duplicate start() calls must not spawn >1 loop.
        await adapter.start()
        await adapter.start()
        await gatedTransport.waitForClaimEntry()

        // Start stop() while claim is blocked; verify stop() does not return until claim unwinds.
        let stopCompleted = LockedFlag()
        let stopTask = Task {
            await adapter.stop()
            stopCompleted.set(true)
        }

        // Wait until the gated claim observes cancellation, then release it.
        await gatedTransport.waitForCancellationObserved()
        XCTAssertFalse(stopCompleted.value, "stop() must wait for the old loop to exit before returning")
        await gatedTransport.releaseGate()
        await stopTask.value
        XCTAssertTrue(stopCompleted.value)

        let maxConcurrentAfterStop = await gatedTransport.maxConcurrentClaims
        XCTAssertEqual(maxConcurrentAfterStop, 1, "Never allow more than one concurrent execution loop")

        // Rapid stop -> start -> start -> stop sequence must maintain single-loop invariant.
        await gatedTransport.resetGate()
        async let s1: Void = adapter.start()
        async let s2: Void = adapter.start()
        _ = await (s1, s2)
        await gatedTransport.waitForClaimEntry()

        let rapidStop = Task { await adapter.stop() }
        await gatedTransport.waitForCancellationObserved()
        await gatedTransport.releaseGate()
        await rapidStop.value

        let maxConcurrentOverall = await gatedTransport.maxConcurrentClaims
        XCTAssertEqual(maxConcurrentOverall, 1, "Rapid stop/start must never produce multiple execution loops")
    }

    @MainActor
    func testMonitorReconnectIgnoresStaleStatusCallbacksFromPreviousAdapter() async throws {
        let dir1 = try makeTempDirectory()
        let dir2 = try makeTempDirectory()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds1 = InMemoryCloudDeviceCredentialStore()
        let creds2 = InMemoryCloudDeviceCredentialStore()
        let config1 = try makeConfiguration(origin: "https://one.ember.test")
        let config2 = try makeConfiguration(origin: "https://two.ember.test")
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        let transport1 = GatedCloudTransport(readyUntilMs: clock.nowMs + 30_000)
        let transport2 = RecordingCloudTransport(readyUntilMs: clock.nowMs + 30_000)

        let monitor = CloudDeviceAdapterMonitor()
        try await monitor.connect(
            configuration: config1,
            authProvider: auth,
            credentialStore: creds1,
            transport: transport1,
            journal: CloudDeviceExecutionJournal(directory: dir1),
            workspace: DeviceSandboxWorkspace(rootDirectory: dir1),
            clock: clock,
            autoStart: true
        )
        await transport1.waitForClaimEntry()
        let firstDeviceID = monitor.deviceID
        XCTAssertNotNil(firstDeviceID)

        // Reconnect while first adapter is mid-claim; release gate when cancelled.
        let reconnectTask = Task {
            try await monitor.connect(
                configuration: config2,
                authProvider: auth,
                credentialStore: creds2,
                transport: transport2,
                journal: CloudDeviceExecutionJournal(directory: dir2),
                workspace: DeviceSandboxWorkspace(rootDirectory: dir2),
                clock: clock,
                autoStart: false
            )
        }
        await transport1.waitForCancellationObserved()
        await transport1.releaseGate()
        try await reconnectTask.value

        // Flush MainActor queue to ensure any stale async statusHandler tasks from adapter 1 have run.
        await Task.yield()
        await Task.yield()

        let expectedSecondID = try creds2.loadOrCreateCredential(for: config2.scopeIdentifier).id
        XCTAssertNotEqual(firstDeviceID, expectedSecondID)
        XCTAssertEqual(monitor.deviceID, expectedSecondID, "Stale adapter callback must not overwrite new adapter deviceID")
        XCTAssertFalse(monitor.isRunning)
    }

    func testJournalWriteFailureBlocksResultSubmission() async throws {
        let dir = try makeTempDirectory()
        // Place a regular file where the journal directory wants to be so persistState() throws.
        let blockedDir = dir.appendingPathComponent("not-a-directory", isDirectory: false)
        try Data("blocker".utf8).write(to: blockedDir)

        let config = try makeConfiguration()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        let offer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "do not submit")
        )
        let transport = RecordingCloudTransport(readyUntilMs: clock.nowMs + 30_000, queuedClaims: [offer])
        let failingJournal = CloudDeviceExecutionJournal(directory: blockedDir)
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: transport,
            journal: failingJournal,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )

        do {
            _ = try await adapter.runSingleCycle()
            XCTFail("Expected journal persistence failure to throw")
        } catch {
            // Expected storage error
        }
        let submitted = await transport.resultSubmissions.count
        XCTAssertEqual(submitted, 0, "Unpersisted result must never be submitted when journal write fails")
    }

    func testStageFailureOnFencedJournalRecordBlocksResultSubmission() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        let offer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "fenced mid-run")
        )

        let journal = CloudDeviceExecutionJournal(directory: dir)
        // Tool fences the journal record while executing (simulating superseded/fenced record).
        let fencingTool = HookedNativeTextTool {
            _ = try await journal.recordFenced(
                taskID: offer.taskId,
                fence: offer.fence,
                reason: "Fenced externally during execution",
                nowMs: clock.nowMs + 5
            )
        }
        let transport = RecordingCloudTransport(readyUntilMs: clock.nowMs + 30_000, queuedClaims: [offer])
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: transport,
            journal: journal,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            textTool: fencingTool,
            clock: clock
        )

        let outcome = try await adapter.runSingleCycle()
        XCTAssertEqual(outcome, .interruptedFenced(taskId: offer.taskId))
        let submitted = await transport.resultSubmissions.count
        XCTAssertEqual(submitted, 0, "Must never submit result when recordCheckpoint/stageResultSubmission returns fenced record")
    }

    // MARK: - 9. P1-3: Real Execution Path Lease Safety

    func testRealExecutionChecksExpiredLeaseBeforeRunningTool() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration(heartbeatInterval: .seconds(10))
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_010_000)

        // Lease already expired relative to clock.nowMs, even though deadline is still in the future.
        let offer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs - 1,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "expired lease")
        )

        let toolCalled = LockedFlag()
        let tool = HookedNativeTextTool {
            toolCalled.set(true)
        }
        let transport = RecordingCloudTransport(readyUntilMs: clock.nowMs + 30_000, queuedClaims: [offer])
        let journal = CloudDeviceExecutionJournal(directory: dir)
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: transport,
            journal: journal,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            textTool: tool,
            clock: clock
        )

        let outcome = try await adapter.runSingleCycle()
        XCTAssertEqual(outcome, .interruptedFenced(taskId: offer.taskId))
        XCTAssertFalse(toolCalled.value, "NativeTool must not run when lease is already expired")
        let submitted = await transport.resultSubmissions.count
        XCTAssertEqual(submitted, 0)
        let saved = try await journal.record(for: offer.taskId)
        XCTAssertEqual(saved?.phase, .fenced)
    }

    func testRealExecutionRenewsLowLeaseAndCommitsOnSuccess() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration(heartbeatInterval: .seconds(10))
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        // Remaining lease is 5s <= 10s heartbeat threshold -> must trigger /renew before execution.
        let offer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs + 5_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "renew me")
        )
        let renewedExpiry = clock.nowMs + 35_000
        let transport = RecordingCloudTransport(
            readyUntilMs: clock.nowMs + 30_000,
            queuedClaims: [offer],
            renewOutcome: .renewed(leaseExpiresAtMs: renewedExpiry)
        )
        let journal = CloudDeviceExecutionJournal(directory: dir)
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: transport,
            journal: journal,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )

        let outcome = try await adapter.runSingleCycle()
        XCTAssertEqual(outcome, .executed(taskId: offer.taskId, outcome: .committed(replayed: false)))
        let renewed = await transport.renewedFences
        XCTAssertEqual(renewed, [offer.fence])
        let saved = try await journal.record(for: offer.taskId)
        XCTAssertEqual(saved?.leaseExpiresAtMs, renewedExpiry)
        XCTAssertEqual(saved?.phase, .committed(replayed: false))
    }

    func testRealExecutionStopsWhenLeaseExpiresDuringNativeToolWithoutSubmitting() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration(heartbeatInterval: .seconds(10))
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        let offer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "slow native tool")
        )

        // Advance clock past leaseExpiresAtMs inside NativeTool execution.
        let slowTool = HookedNativeTextTool {
            clock.advance(byMs: 31_000)
        }
        let transport = RecordingCloudTransport(readyUntilMs: clock.nowMs + 30_000, queuedClaims: [offer])
        let journal = CloudDeviceExecutionJournal(directory: dir)
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: transport,
            journal: journal,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            textTool: slowTool,
            clock: clock
        )

        let outcome = try await adapter.runSingleCycle()
        XCTAssertEqual(outcome, .interruptedFenced(taskId: offer.taskId))
        let submitted = await transport.resultSubmissions.count
        XCTAssertEqual(submitted, 0, "Expired lease during NativeTool execution must not submit a new result")
        let saved = try await journal.record(for: offer.taskId)
        XCTAssertEqual(saved?.phase, .fenced)
    }

    func testPendingSubmissionStillReplaysOriginalFenceAfterLocalLeaseExpiry() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_100_000)

        // Lease & deadline already passed, but result was already staged as pendingSubmission (Unknown ACK).
        let offer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 3,
            leaseExpiresAtMs: clock.nowMs - 50_000,
            deadlineAtMs: clock.nowMs - 10_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "unknown ack")
        )
        let expectedSubmission = CloudDeviceResultSubmission(
            fence: offer.fence,
            output: CloudDeviceTextStats(text: "unknown ack")
        )
        let journal = CloudDeviceExecutionJournal(directory: dir)
        _ = try await journal.recordClaim(offer, nowMs: clock.nowMs - 60_000)
        _ = try await journal.stageResultSubmission(
            taskID: offer.taskId,
            submission: expectedSubmission,
            nowMs: clock.nowMs - 55_000
        )

        let transport = RecordingCloudTransport(
            readyUntilMs: clock.nowMs + 30_000,
            commitOutcome: .committed(replayed: true)
        )
        let adapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: transport,
            journal: journal,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )

        let outcome = try await adapter.runSingleCycle()
        XCTAssertEqual(outcome, .flushedPending(taskId: offer.taskId, outcome: .committed(replayed: true)))
        let submissions = await transport.resultSubmissions
        XCTAssertEqual(submissions, [expectedSubmission])
    }

    // MARK: - 10. P2: Unified NativeTool Result Source

    func testWireResultOriginatesDirectlyFromNativeToolOutputAndMatchesF2Contract() async throws {
        let dir = try makeTempDirectory()
        let config = try makeConfiguration()
        let auth = try StaticCloudDeviceAuthProvider(bearerToken: "session-1")
        let creds = InMemoryCloudDeviceCredentialStore()
        let clock = MutableCloudDeviceClock(nowMs: 1_700_000_000_000)

        // 1. Verify Agent F's exact contract vector through real NativeTextTool:
        // "𝄞\r\ne\u{0301}\n" -> { utf8Bytes: 10, unicodeScalars: 6, lines: 3 }
        let contractText = "𝄞\r\ne\u{0301}\n"
        let realOffer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: contractText)
        )
        let realTransport = RecordingCloudTransport(readyUntilMs: clock.nowMs + 30_000, queuedClaims: [realOffer])
        let realJournal = CloudDeviceExecutionJournal(directory: dir)
        let realAdapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: realTransport,
            journal: realJournal,
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            clock: clock
        )
        let realOutcome = try await realAdapter.runSingleCycle()
        XCTAssertEqual(realOutcome, .executed(taskId: realOffer.taskId, outcome: .committed(replayed: false)))
        let realSubmissions = await realTransport.resultSubmissions
        XCTAssertEqual(realSubmissions.first?.output, CloudDeviceTextStats(utf8Bytes: 10, unicodeScalars: 6, lines: 3))

        let maybeSavedRecord = try await realJournal.record(for: realOffer.taskId)
        let savedRecord = try XCTUnwrap(maybeSavedRecord)
        let checkpointStats = try CloudDeviceTextStats(nativeToolOutput: XCTUnwrap(savedRecord.nativeStepOutput))
        XCTAssertEqual(checkpointStats, realSubmissions.first?.output)

        // 2. Verify CloudDeviceExecutorAdapter uses NativeTool output directly rather than recomputing from offer.input.text.
        let sentinelOutput = NativeToolOutput(
            summaryText: "Sentinel stats",
            outputText: "{}",
            structuredData: .object([
                "utf8_bytes": .int(77),
                "unicode_scalars": .int(55),
                "lf_line_count": .int(3),
            ])
        )
        let sentinelOffer = CloudDeviceClaimOffer(
            taskId: UUID(),
            operationId: UUID(),
            runId: UUID(),
            leaseEpoch: 1,
            leaseExpiresAtMs: clock.nowMs + 30_000,
            deadlineAtMs: clock.nowMs + 60_000,
            capability: CloudDeviceContract.textCapability,
            version: 1,
            input: CloudDeviceTextInput(operation: "stats", text: "abc")
        )
        let sentinelTransport = RecordingCloudTransport(readyUntilMs: clock.nowMs + 30_000, queuedClaims: [sentinelOffer])
        let sentinelAdapter = try CloudDeviceExecutorAdapter(
            configuration: config,
            authProvider: auth,
            credentialStore: creds,
            transport: sentinelTransport,
            journal: CloudDeviceExecutionJournal(directory: try makeTempDirectory()),
            workspace: DeviceSandboxWorkspace(rootDirectory: dir),
            textTool: FixedOutputNativeTool(output: sentinelOutput),
            clock: clock
        )
        _ = try await sentinelAdapter.runSingleCycle()
        let sentinelSubmissions = await sentinelTransport.resultSubmissions
        XCTAssertEqual(
            sentinelSubmissions.first?.output,
            CloudDeviceTextStats(utf8Bytes: 77, unicodeScalars: 55, lines: 3),
            "Wire result must come directly from NativeToolOutput, not independent recomputation"
        )
    }

    // MARK: - Test Helpers

    private static func readBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: bufferSize)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private struct RecordedHTTPRequest: Sendable {
    let method: String
    let path: String
    let authorization: String?
    let deviceToken: String?
    let localAccess: String?
    let bodyData: Data?
}

private final class LockedRecorder<Element>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Element] = []

    func append(_ item: Element) {
        lock.lock()
        defer { lock.unlock() }
        items.append(item)
    }

    func snapshot() -> [Element] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }
}

private final class StubCloudURLProtocol: URLProtocol {
    private final class StateBox: @unchecked Sendable {
        let lock = NSLock()
        var handler: ((URLRequest) throws -> (Int, Data))?
    }

    private static let box = StateBox()

    static func setHandler(_ handler: ((URLRequest) throws -> (Int, Data))?) {
        box.lock.lock()
        defer { box.lock.unlock() }
        box.handler = handler
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.box.lock.lock()
        let handler = Self.box.handler
        Self.box.lock.unlock()

        guard let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (statusCode, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class MutableCloudDeviceClock: CloudDeviceClock, @unchecked Sendable {
    private let lock = NSLock()
    private var _nowMs: Int64

    init(nowMs: Int64) {
        self._nowMs = nowMs
    }

    var nowMs: Int64 {
        lock.lock()
        defer { lock.unlock() }
        return _nowMs
    }

    func advance(byMs delta: Int64) {
        lock.lock()
        _nowMs += delta
        lock.unlock()
    }

    func sleep(for duration: Duration) async throws {
        try await Task.sleep(for: .milliseconds(10))
        let (seconds, attoseconds) = duration.components
        let ms = (seconds * 1_000) + (attoseconds / 1_000_000_000_000_000)
        advance(byMs: ms)
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = false

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _value
    }

    func set(_ newValue: Bool) {
        lock.lock()
        _value = newValue
        lock.unlock()
    }
}

private actor StubBackgroundTaskManager: BackgroundTaskManaging {
    private var nextID = 1
    private var handlers: [Int: @Sendable () -> Void] = [:]
    private(set) var activeTaskIDs: Set<Int> = []
    private(set) var beganCount = 0
    private(set) var endedCount = 0

    var hasActiveExpirationHandler: Bool {
        !handlers.isEmpty
    }

    func beginBackgroundTask(
        name: String,
        expirationHandler: @escaping @Sendable () -> Void
    ) async -> Int {
        let id = nextID
        nextID += 1
        beganCount += 1
        activeTaskIDs.insert(id)
        handlers[id] = expirationHandler
        return id
    }

    func endBackgroundTask(_ identifier: Int) async {
        if activeTaskIDs.remove(identifier) != nil {
            endedCount += 1
            handlers.removeValue(forKey: identifier)
        }
    }

    func triggerExpiration() async {
        let activeHandlers = Array(handlers.values)
        for handler in activeHandlers {
            handler()
        }
    }
}

private actor ControllableNativeTextTool: NativeTool {
    nonisolated let name: DeviceToolName = .textProcess
    private let delegate = NativeTextTool()
    private var shouldPause = true
    private var started = false
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []
    private var pauseContinuation: CheckedContinuation<Void, Error>?

    func setShouldPause(_ pause: Bool) {
        shouldPause = pause
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { continuation in
            startedWaiters.append(continuation)
        }
    }

    func execute(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) async throws -> NativeToolOutput {
        started = true
        let waiters = startedWaiters
        startedWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }

        if shouldPause {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    if Task.isCancelled {
                        continuation.resume(throwing: CancellationError())
                    } else {
                        self.pauseContinuation = continuation
                    }
                }
            } onCancel: {
                Task { await self.cancelPause() }
            }
        }
        return try await delegate.execute(context: context, arguments: arguments)
    }

    private func cancelPause() {
        if let continuation = pauseContinuation {
            pauseContinuation = nil
            continuation.resume(throwing: CancellationError())
        }
    }
}

private struct HookedNativeTextTool: NativeTool {
    let name: DeviceToolName = .textProcess
    private let delegate = NativeTextTool()
    private let hook: @Sendable () async throws -> Void

    init(hook: @escaping @Sendable () async throws -> Void) {
        self.hook = hook
    }

    func execute(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) async throws -> NativeToolOutput {
        try await hook()
        return try await delegate.execute(context: context, arguments: arguments)
    }
}

private struct FixedOutputNativeTool: NativeTool {
    let name: DeviceToolName = .textProcess
    let output: NativeToolOutput

    func execute(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) async throws -> NativeToolOutput {
        try context.checkCancellation()
        return output
    }
}

private actor RecordingCloudTransport: CloudDeviceAPITransporting {
    private let readyUntilMs: Int64
    private var queuedClaims: [CloudDeviceClaimOffer]
    private let renewOutcome: CloudDeviceRenewOutcome
    private let commitOutcome: CloudDeviceCommitOutcome
    private(set) var registerCount = 0
    private(set) var claimCount = 0
    private(set) var renewedFences: [CloudDeviceFence] = []
    private(set) var resultSubmissions: [CloudDeviceResultSubmission] = []

    init(
        readyUntilMs: Int64,
        queuedClaims: [CloudDeviceClaimOffer] = [],
        renewOutcome: CloudDeviceRenewOutcome = .renewed(leaseExpiresAtMs: 0),
        commitOutcome: CloudDeviceCommitOutcome = .committed(replayed: false)
    ) {
        self.readyUntilMs = readyUntilMs
        self.queuedClaims = queuedClaims
        self.renewOutcome = renewOutcome
        self.commitOutcome = commitOutcome
    }

    func register(credential: CloudDeviceCredential) async throws -> CloudDeviceRegistrationReceipt {
        registerCount += 1
        return CloudDeviceRegistrationReceipt(
            deviceId: credential.id,
            capability: CloudDeviceContract.textCapability,
            version: CloudDeviceContract.capabilityVersion,
            readyUntilMs: readyUntilMs
        )
    }

    func claim(credential: CloudDeviceCredential) async throws -> CloudDeviceClaimResponse {
        claimCount += 1
        guard !queuedClaims.isEmpty else { return .idle }
        return .claimed(queuedClaims.removeFirst())
    }

    func renew(
        credential: CloudDeviceCredential,
        taskID: UUID,
        fence: CloudDeviceFence,
        previousLeaseExpiresAtMs: Int64,
        deadlineAtMs: Int64
    ) async throws -> CloudDeviceRenewOutcome {
        renewedFences.append(fence)
        return renewOutcome
    }

    func submitResult(
        credential: CloudDeviceCredential,
        taskID: UUID,
        submission: CloudDeviceResultSubmission
    ) async throws -> CloudDeviceCommitOutcome {
        resultSubmissions.append(submission)
        return commitOutcome
    }
}

private actor GatedCloudTransport: CloudDeviceAPITransporting {
    private let readyUntilMs: Int64
    private var currentConcurrentClaims = 0
    private(set) var maxConcurrentClaims = 0
    private var enteredClaim = false
    private var cancellationObserved = false
    private var gateReleased = false
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var cancelWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(readyUntilMs: Int64) {
        self.readyUntilMs = readyUntilMs
    }

    func resetGate() {
        enteredClaim = false
        cancellationObserved = false
        gateReleased = false
    }

    func waitForClaimEntry() async {
        if enteredClaim { return }
        await withCheckedContinuation { continuation in
            entryWaiters.append(continuation)
        }
    }

    func waitForCancellationObserved() async {
        if cancellationObserved { return }
        await withCheckedContinuation { continuation in
            cancelWaiters.append(continuation)
        }
    }

    func releaseGate() {
        gateReleased = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }

    func register(credential: CloudDeviceCredential) async throws -> CloudDeviceRegistrationReceipt {
        CloudDeviceRegistrationReceipt(
            deviceId: credential.id,
            capability: CloudDeviceContract.textCapability,
            version: CloudDeviceContract.capabilityVersion,
            readyUntilMs: readyUntilMs
        )
    }

    func claim(credential: CloudDeviceCredential) async throws -> CloudDeviceClaimResponse {
        currentConcurrentClaims += 1
        maxConcurrentClaims = max(maxConcurrentClaims, currentConcurrentClaims)
        defer { currentConcurrentClaims -= 1 }

        enteredClaim = true
        let eWaiters = entryWaiters
        entryWaiters.removeAll()
        for w in eWaiters { w.resume() }

        await withTaskCancellationHandler {
            if !gateReleased {
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    if self.gateReleased {
                        continuation.resume()
                    } else {
                        self.releaseWaiters.append(continuation)
                    }
                }
            }
        } onCancel: {
            Task { await self.markCancellationObserved() }
        }
        try Task.checkCancellation()
        return .idle
    }

    private func markCancellationObserved() {
        cancellationObserved = true
        let waiters = cancelWaiters
        cancelWaiters.removeAll()
        for w in waiters { w.resume() }
    }

    func renew(
        credential: CloudDeviceCredential,
        taskID: UUID,
        fence: CloudDeviceFence,
        previousLeaseExpiresAtMs: Int64,
        deadlineAtMs: Int64
    ) async throws -> CloudDeviceRenewOutcome {
        .renewed(leaseExpiresAtMs: deadlineAtMs)
    }

    func submitResult(
        credential: CloudDeviceCredential,
        taskID: UUID,
        submission: CloudDeviceResultSubmission
    ) async throws -> CloudDeviceCommitOutcome {
        .committed(replayed: false)
    }
}

private actor MockCloudTransport: CloudDeviceAPITransporting {
    private let readyUntilMs: Int64
    private var queuedClaims: [CloudDeviceClaimOffer]
    private let renewOutcome: CloudDeviceRenewOutcome
    private let commitOutcome: CloudDeviceCommitOutcome
    private(set) var resultSubmissions: [CloudDeviceResultSubmission] = []

    init(
        readyUntilMs: Int64,
        queuedClaims: [CloudDeviceClaimOffer] = [],
        renewOutcome: CloudDeviceRenewOutcome = .renewed(leaseExpiresAtMs: 0),
        commitOutcome: CloudDeviceCommitOutcome = .committed(replayed: false)
    ) {
        self.readyUntilMs = readyUntilMs
        self.queuedClaims = queuedClaims
        self.renewOutcome = renewOutcome
        self.commitOutcome = commitOutcome
    }

    func register(credential: CloudDeviceCredential) async throws -> CloudDeviceRegistrationReceipt {
        CloudDeviceRegistrationReceipt(
            deviceId: credential.id,
            capability: CloudDeviceContract.textCapability,
            version: CloudDeviceContract.capabilityVersion,
            readyUntilMs: readyUntilMs
        )
    }

    func claim(credential: CloudDeviceCredential) async throws -> CloudDeviceClaimResponse {
        guard !queuedClaims.isEmpty else { return .idle }
        return .claimed(queuedClaims.removeFirst())
    }

    func renew(
        credential: CloudDeviceCredential,
        taskID: UUID,
        fence: CloudDeviceFence,
        previousLeaseExpiresAtMs: Int64,
        deadlineAtMs: Int64
    ) async throws -> CloudDeviceRenewOutcome {
        renewOutcome
    }

    func submitResult(
        credential: CloudDeviceCredential,
        taskID: UUID,
        submission: CloudDeviceResultSubmission
    ) async throws -> CloudDeviceCommitOutcome {
        resultSubmissions.append(submission)
        return commitOutcome
    }
}
