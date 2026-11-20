import CryptoKit
import Foundation
import SwiftUI
import XCTest
@testable import Ember

final class DeviceExecutorTests: XCTestCase {
    private var tempRoots: [URL] = []

    override func tearDown() {
        for root in tempRoots {
            try? FileManager.default.removeItem(at: root)
        }
        tempRoots.removeAll()
        super.tearDown()
    }

    private func makeSandboxRoot() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("EmberDeviceExecTests-\(UUID().uuidString.lowercased())", isDirectory: true)
        tempRoots.append(url)
        return url
    }

    private func makeExecutor(
        root: URL? = nil,
        tools: [any NativeTool] = NativeToolRegistry.defaultTools(),
        policy: DeviceSandboxPolicy = .default,
        backgroundTaskManager: any BackgroundTaskManaging = FakeBackgroundTaskManager(),
        bootSessionID: UUID = UUID(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) -> (executor: DeviceTaskExecutor, root: URL) {
        let dir = root ?? makeSandboxRoot()
        let journal = DeviceExecutionJournal(directory: dir)
        let workspace = DeviceSandboxWorkspace(rootDirectory: dir, policy: policy)
        let registry = NativeToolRegistry(tools: tools)
        let executor = DeviceTaskExecutor(
            journal: journal,
            workspace: workspace,
            registry: registry,
            policy: policy,
            backgroundTaskManager: backgroundTaskManager,
            bootSessionID: bootSessionID,
            now: now
        )
        return (executor, dir)
    }

    func testNativeTextToolStatsAndActionItemExtraction() async throws {
        let (executor, _) = makeExecutor()
        let sampleText = """
        # Launch Readiness
        - [ ] Confirm App Store privacy manifest
        TODO: Validate JSON aggregation on iPhone
        ACTION: Generate local PDF report
        Regular note line without action marker.
        """

        let statsOutcome = try await executor.executeAndWait(DeviceTaskSubmission(
            idempotencyKey: "text-stats-1",
            steps: [
                DeviceToolStep(
                    stepID: "stats",
                    tool: .textProcess,
                    arguments: ["op": .string("stats"), "text": .string(sampleText)]
                ),
            ]
        ))

        XCTAssertEqual(statsOutcome.status, .completed)
        XCTAssertEqual(statsOutcome.metrics?.stepsCompleted, 1)
        let statsObj = try XCTUnwrap(statsOutcome.structuredOutput?.objectValue)
        XCTAssertEqual(statsObj["line_count"]?.intValue, 5)
        XCTAssertGreaterThan(statsObj["word_count"]?.intValue ?? 0, 15)

        let extractOutcome = try await executor.executeAndWait(DeviceTaskSubmission(
            idempotencyKey: "text-extract-1",
            steps: [
                DeviceToolStep(
                    stepID: "extract",
                    tool: .textProcess,
                    arguments: ["op": .string("extract_action_items"), "text": .string(sampleText)]
                ),
            ]
        ))

        XCTAssertEqual(extractOutcome.status, .completed)
        let extractObj = try XCTUnwrap(extractOutcome.structuredOutput?.objectValue)
        XCTAssertEqual(extractObj["count"]?.intValue, 3)
        XCTAssertTrue(extractOutcome.detailText.contains("Confirm App Store privacy manifest"))
        XCTAssertTrue(extractOutcome.detailText.contains("Validate JSON aggregation on iPhone"))
        XCTAssertTrue(extractOutcome.detailText.contains("Generate local PDF report"))
    }

    func testNativeTextToolNormalizeRegexAndHeadings() async throws {
        let (executor, _) = makeExecutor()
        let raw = "# Intro\r\nalpha   \r\n\r\n\r\nbeta\r\nalpha\r\n## Details\r\nOrder #42 ready"

        let outcome = try await executor.executeAndWait(DeviceTaskSubmission(
            idempotencyKey: "text-pipeline-1",
            steps: [
                DeviceToolStep(
                    stepID: "headings",
                    tool: .textProcess,
                    arguments: ["op": .string("extract_headings"), "text": .string(raw)]
                ),
                DeviceToolStep(
                    stepID: "norm",
                    tool: .textProcess,
                    arguments: [
                        "op": .string("normalize"),
                        "text": .string(raw),
                        "unique_lines": .bool(true),
                        "drop_empty_lines": .bool(true),
                    ]
                ),
                DeviceToolStep(
                    stepID: "regex",
                    tool: .textProcess,
                    arguments: [
                        "op": .string("regex_match"),
                        "text": .string("{{prev.text}}"),
                        "pattern": .string("#\\d+"),
                    ]
                ),
            ]
        ))

        XCTAssertEqual(outcome.status, .completed)
        let matches = try XCTUnwrap(outcome.structuredOutput?.objectValue?["matches"]?.arrayValue)
        XCTAssertEqual(matches, [.string("#42")])
    }

    func testNativeJSONToolQueryAggregateAndCSV() async throws {
        let (executor, _) = makeExecutor()
        let jsonPayload = """
        {
          "records": [
            {"id": 1, "team": "ios", "latency": 12.0, "note": "fast, clean"},
            {"id": 2, "team": "ios", "latency": 18.0, "note": "quoted \\"value\\""},
            {"id": 3, "team": "cloud", "latency": 220.0, "note": "remote"}
          ]
        }
        """

        let queryOutcome = try await executor.executeAndWait(DeviceTaskSubmission(
            idempotencyKey: "json-query-1",
            steps: [
                DeviceToolStep(
                    stepID: "q",
                    tool: .jsonProcess,
                    arguments: [
                        "op": .string("query"),
                        "json": .string(jsonPayload),
                        "path": .string("records.*.team"),
                    ]
                ),
            ]
        ))
        XCTAssertEqual(queryOutcome.status, .completed)
        XCTAssertEqual(queryOutcome.structuredOutput?.objectValue?["match_count"]?.intValue, 3)

        let aggOutcome = try await executor.executeAndWait(DeviceTaskSubmission(
            idempotencyKey: "json-agg-1",
            steps: [
                DeviceToolStep(
                    stepID: "agg",
                    tool: .jsonProcess,
                    arguments: [
                        "op": .string("aggregate"),
                        "json": .string(jsonPayload),
                        "path": .string("records"),
                        "where": .object(["field": .string("team"), "equals": .string("ios")]),
                        "value_field": .string("latency"),
                    ]
                ),
            ]
        ))
        XCTAssertEqual(aggOutcome.status, .completed)
        let stats = try XCTUnwrap(aggOutcome.structuredOutput?.objectValue?["stats"]?.objectValue)
        XCTAssertEqual(stats["count"]?.intValue, 2)
        XCTAssertEqual(stats["sum"]?.doubleValue, 30.0)
        XCTAssertEqual(stats["avg"]?.doubleValue, 15.0)

        let csvOutcome = try await executor.executeAndWait(DeviceTaskSubmission(
            idempotencyKey: "json-csv-1",
            steps: [
                DeviceToolStep(
                    stepID: "csv",
                    tool: .jsonProcess,
                    arguments: [
                        "op": .string("to_csv"),
                        "json": .string(jsonPayload),
                        "path": .string("records"),
                        "columns": .array([.string("id"), .string("team"), .string("note")]),
                    ]
                ),
            ]
        ))
        XCTAssertEqual(csvOutcome.status, .completed)
        XCTAssertTrue(csvOutcome.detailText.contains("\"fast, clean\""))
        XCTAssertTrue(csvOutcome.detailText.contains("\"quoted \"\"value\"\"\""))
    }

    func testNativeJSONToolRejectsExcessiveDepth() async throws {
        let (executor, _) = makeExecutor(
            policy: DeviceSandboxPolicy(
                maxInputBytes: 1024 * 1024,
                maxOutputTextBytes: 64 * 1024,
                maxGeneratedFileBytes: 1024 * 1024,
                maxWorkspaceBytes: 4 * 1024 * 1024,
                maxStepsPerTask: 8,
                maxJSONDepth: 4,
                stepTimeoutMs: 5000,
                maxConcurrentTasks: 1,
                rejectOnCriticalThermalState: false
            )
        )

        let deepJSON = #"{"a":{"b":{"c":{"d":{"e":1}}}}}"#
        let outcome = try await executor.executeAndWait(DeviceTaskSubmission(
            idempotencyKey: "json-deep-1",
            steps: [
                DeviceToolStep(
                    tool: .jsonProcess,
                    arguments: ["op": .string("validate"), "json": .string(deepJSON)]
                ),
            ]
        ))

        XCTAssertEqual(outcome.status, .failed)
        XCTAssertEqual(outcome.errorCode, .invalidArgument)
    }

    func testFileGenerationPipelineAndSessionRepositoryIntegration() async throws {
        let (executor, _) = makeExecutor()
        let jsonInput = #"[{"item":"A","count":3},{"item":"B","count":7}]"#

        let outcome = try await executor.executeAndWait(DeviceTaskSubmission(
            idempotencyKey: "pipeline-file-1",
            title: "JSON to CSV + PDF",
            steps: [
                DeviceToolStep(
                    stepID: "to-csv",
                    tool: .jsonProcess,
                    arguments: [
                        "op": .string("to_csv"),
                        "json": .string(jsonInput),
                        "columns": .array([.string("item"), .string("count")]),
                    ]
                ),
                DeviceToolStep(
                    stepID: "write-csv",
                    tool: .fileGenerate,
                    arguments: [
                        "filename": .string("report.csv"),
                        "content": .string("{{prev.text}}"),
                    ]
                ),
                DeviceToolStep(
                    stepID: "write-pdf",
                    tool: .fileGenerate,
                    arguments: [
                        "filename": .string("report.pdf"),
                        "title": .string("Device Report"),
                        "content": .string("{{steps.to-csv.text}}"),
                    ]
                ),
            ]
        ))

        XCTAssertEqual(outcome.status, .completed)
        XCTAssertEqual(outcome.artifacts.count, 2)

        let csvArtifact = try XCTUnwrap(outcome.artifacts.first(where: { $0.filename == "report.csv" }))
        let pdfArtifact = try XCTUnwrap(outcome.artifacts.first(where: { $0.filename == "report.pdf" }))

        let (_, csvBytes) = try await executor.artifactData(taskID: outcome.taskID, artifactID: csvArtifact.artifactID)
        let (_, pdfBytes) = try await executor.artifactData(taskID: outcome.taskID, artifactID: pdfArtifact.artifactID)
        XCTAssertEqual(String(data: csvBytes, encoding: .utf8), "item,count\nA,3\nB,7")
        XCTAssertTrue(String(decoding: pdfBytes.prefix(5), as: UTF8.self) == "%PDF-")
        XCTAssertEqual(DeviceSandboxCrypto.sha256Hex(csvBytes), csvArtifact.sha256)
        XCTAssertEqual(DeviceSandboxCrypto.sha256Hex(pdfBytes), pdfArtifact.sha256)

        // Verify SessionTaskRepositoryProtocol & SessionTaskStore interoperability
        let repo = DeviceSessionTaskRepository(executor: executor)
        let store = await MainActor.run { SessionTaskStore(repository: repo) }
        await store.loadDetail(taskID: outcome.taskID)

        let loadedTask = await MainActor.run { store.tasksByID[outcome.taskID] }
        let loadedEvents = await MainActor.run { store.eventsByTaskID[outcome.taskID] ?? [] }
        let loadedResult = await MainActor.run { store.resultsByTaskID[outcome.taskID] }
        let loadedArtifacts = await MainActor.run { store.artifactsByTaskID[outcome.taskID] ?? [] }

        XCTAssertEqual(loadedTask?.status, .completed)
        XCTAssertEqual(loadedResult?.result?.simulated, false)
        XCTAssertEqual(loadedResult?.result?.modelLabel, "iphone-native-executor-v1")
        XCTAssertEqual(loadedArtifacts.count, 2)
        XCTAssertEqual(loadedEvents.map(\.phase), [.accepted, .leased, .started, .progress, .progress, .progress, .completed])
    }

    func testSandboxRejectsPathTraversalAndBlockedMediaTypes() async throws {
        let (executor, _) = makeExecutor()

        let traversalOutcome = try await executor.executeAndWait(DeviceTaskSubmission(
            idempotencyKey: "sec-traversal-1",
            steps: [
                DeviceToolStep(
                    tool: .fileGenerate,
                    arguments: [
                        "filename": .string("../escape.txt"),
                        "content": .string("blocked"),
                    ]
                ),
            ]
        ))
        XCTAssertEqual(traversalOutcome.status, .failed)
        XCTAssertEqual(traversalOutcome.errorCode, .policyDenied)

        let blockedHTMLOutcome = try await executor.executeAndWait(DeviceTaskSubmission(
            idempotencyKey: "sec-html-1",
            steps: [
                DeviceToolStep(
                    tool: .fileGenerate,
                    arguments: [
                        "filename": .string("evil.html"),
                        "media_type": .string("text/html"),
                        "content": .string("<script>alert(1)</script>"),
                    ]
                ),
            ]
        ))
        XCTAssertEqual(blockedHTMLOutcome.status, .failed)
        XCTAssertEqual(blockedHTMLOutcome.errorCode, .policyDenied)
    }

    func testIdempotencyReplayAndConflict() async throws {
        let (executor, _) = makeExecutor()
        let submission = DeviceTaskSubmission(
            idempotencyKey: "idem-key-1",
            steps: [
                DeviceToolStep(tool: .textProcess, arguments: ["op": .string("stats"), "text": .string("hello")]),
            ]
        )

        let first = try await executor.submitTask(submission)
        XCTAssertFalse(first.replayed)

        let replay = try await executor.submitTask(submission)
        XCTAssertTrue(replay.replayed)
        XCTAssertEqual(replay.taskID, first.taskID)

        let conflicting = DeviceTaskSubmission(
            idempotencyKey: "idem-key-1",
            steps: [
                DeviceToolStep(tool: .textProcess, arguments: ["op": .string("stats"), "text": .string("different")]),
            ]
        )
        do {
            _ = try await executor.submitTask(conflicting)
            XCTFail("Expected idempotencyConflict")
        } catch let error as DeviceExecutorError {
            XCTAssertEqual(error, .idempotencyConflict)
        }
    }

    func testCancellationOfQueuedAndRunningTasksCleansStaging() async throws {
        let slowTool = SlowCancellableTool(stepDelayMs: 2_500)
        let (executor, root) = makeExecutor(tools: [slowTool] + NativeToolRegistry.defaultTools())

        // 1. Queued cancellation (not started)
        let queuedReceipt = try await executor.submitTask(
            DeviceTaskSubmission(
                idempotencyKey: "cancel-queued-1",
                steps: [DeviceToolStep(tool: .textProcess, arguments: ["op": .string("stats"), "text": .string("queued")])]
            ),
            startImmediately: false
        )
        let queuedCancel = try await executor.cancelTask(id: queuedReceipt.taskID)
        XCTAssertEqual(queuedCancel.status, .cancelled)
        XCTAssertTrue(queuedCancel.terminal)

        // 2. Active running cancellation
        let runningReceipt = try await executor.submitTask(
            DeviceTaskSubmission(
                idempotencyKey: "cancel-running-1",
                steps: [DeviceToolStep(tool: SlowCancellableTool.toolName)]
            ),
            startImmediately: true
        )

        try await slowTool.waitUntilStarted()
        let cancelResp = try await executor.cancelTask(id: runningReceipt.taskID)
        XCTAssertTrue(cancelResp.cancelRequested)

        let outcome = try await executor.waitForCompletion(taskID: runningReceipt.taskID)
        XCTAssertEqual(outcome.status, .cancelled)
        XCTAssertEqual(outcome.errorCode, .cancelled)

        let stagingDir = root.appendingPathComponent("staging/\(runningReceipt.taskID.uuidString.lowercased())")
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagingDir.path))
    }

    func testBackgroundSuspensionInterruptsAndResumesFromCheckpoint() async throws {
        let root = makeSandboxRoot()
        let bgManager = FakeBackgroundTaskManager()
        let slowTool = SlowCancellableTool(stepDelayMs: 2_000)
        let (executor, _) = makeExecutor(
            root: root,
            tools: [slowTool] + NativeToolRegistry.defaultTools(),
            backgroundTaskManager: bgManager
        )

        let submission = DeviceTaskSubmission(
            idempotencyKey: "bg-resume-1",
            steps: [
                DeviceToolStep(
                    stepID: "s1",
                    tool: .textProcess,
                    arguments: ["op": .string("stats"), "text": .string("checkpointed step one")]
                ),
                DeviceToolStep(
                    stepID: "s2",
                    tool: SlowCancellableTool.toolName
                ),
            ],
            maxAttempts: 3
        )

        let receipt = try await executor.submitTask(submission, startImmediately: true)
        try await slowTool.waitUntilStarted()

        await executor.handleScenePhase(.background)
        XCTAssertEqual(bgManager.beginCount, 1)

        // Trigger OS background expiration while step 2 is running.
        await slowTool.setDelayMs(20)
        bgManager.fireLatestExpiration()
        try await Task.sleep(for: .milliseconds(80))

        let interruptedRecord = try await executor.record(for: receipt.taskID)
        XCTAssertEqual(interruptedRecord?.task.status, .queued)
        XCTAssertEqual(interruptedRecord?.completedStepOutputs.count, 1)
        XCTAssertEqual(interruptedRecord?.leaseEpoch, 2)

        // Foreground resume should complete without re-running step 1!
        await executor.handleScenePhase(.active)
        let finalOutcome = try await executor.waitForCompletion(taskID: receipt.taskID)
        XCTAssertEqual(finalOutcome.status, .completed)
        XCTAssertEqual(finalOutcome.attemptCount, 2)
        XCTAssertGreaterThanOrEqual(finalOutcome.leaseEpoch, 3)
    }

    func testColdStartRecoveryAcrossExecutorRestart() async throws {
        let root = makeSandboxRoot()
        let journal = DeviceExecutionJournal(directory: root)
        let workspace = DeviceSandboxWorkspace(rootDirectory: root)

        let oldBootID = UUID()
        let now = Date()
        let nowISO = DeviceWireDate.format(now)
        let futureISO = DeviceWireDate.format(now.addingTimeInterval(60))
        let pastISO = DeviceWireDate.format(now.addingTimeInterval(-10))

        // 1. Crashed running task with step 1 already checkpointed
        let runningID = UUID()
        let runningSubmission = DeviceTaskSubmission(
            idempotencyKey: "crash-running-1",
            steps: [
                DeviceToolStep(stepID: "s1", tool: .textProcess, arguments: ["op": .string("stats"), "text": .string("step 1")]),
                DeviceToolStep(stepID: "s2", tool: .fileGenerate, arguments: ["filename": .string("recovered.txt"), "content": .string("{{prev.text}}")]),
            ],
            maxAttempts: 2
        )
        let step1Checkpoint = NativeToolOutput(summaryText: "step 1 done", outputText: "recovered payload")
        try await journal.insertQueuedTask(PersistedDeviceTaskRecord(
            task: SessionTaskDTO(
                taskID: runningID,
                agentID: DeviceTaskSubmission.defaultAgentID,
                kind: DeviceTaskSubmission.deviceTaskKind,
                title: "Interrupted Task",
                status: .running,
                currentRunID: UUID(),
                attemptCount: 1,
                cancelRequested: false,
                createdAt: nowISO,
                updatedAt: nowISO,
                deadlineAt: futureISO,
                resultState: .pending
            ),
            submission: runningSubmission,
            requestDigest: try runningSubmission.canonicalDigest(),
            leaseEpoch: 1,
            ownerBootSessionID: oldBootID,
            completedStepOutputs: [0: step1Checkpoint],
            events: [
                SessionTaskEventDTO(
                    taskID: runningID,
                    sequence: 1,
                    phase: .accepted,
                    occurredAt: nowISO,
                    traceID: runningID,
                    payload: SessionTaskEventPayloadDTO(taskKind: DeviceTaskSubmission.deviceTaskKind, toStatus: .queued, simulated: false)
                ),
            ]
        ))

        // 2. Queued task with cancelRequested = true
        let cancelledID = UUID()
        let cancelSubmission = DeviceTaskSubmission(
            idempotencyKey: "crash-cancel-1",
            steps: [DeviceToolStep(tool: .textProcess, arguments: ["op": .string("stats"), "text": .string("x")])]
        )
        try await journal.insertQueuedTask(PersistedDeviceTaskRecord(
            task: SessionTaskDTO(
                taskID: cancelledID,
                agentID: DeviceTaskSubmission.defaultAgentID,
                kind: DeviceTaskSubmission.deviceTaskKind,
                title: "Pending Cancel",
                status: .queued,
                attemptCount: 0,
                cancelRequested: true,
                createdAt: nowISO,
                updatedAt: nowISO,
                deadlineAt: futureISO,
                resultState: .pending
            ),
            submission: cancelSubmission,
            requestDigest: try cancelSubmission.canonicalDigest()
        ))

        // 3. Expired deadline task
        let expiredID = UUID()
        let expiredSubmission = DeviceTaskSubmission(
            idempotencyKey: "crash-expired-1",
            steps: [DeviceToolStep(tool: .textProcess, arguments: ["op": .string("stats"), "text": .string("x")])]
        )
        try await journal.insertQueuedTask(PersistedDeviceTaskRecord(
            task: SessionTaskDTO(
                taskID: expiredID,
                agentID: DeviceTaskSubmission.defaultAgentID,
                kind: DeviceTaskSubmission.deviceTaskKind,
                title: "Expired Task",
                status: .queued,
                attemptCount: 0,
                cancelRequested: false,
                createdAt: nowISO,
                updatedAt: nowISO,
                deadlineAt: pastISO,
                resultState: .pending
            ),
            submission: expiredSubmission,
            requestDigest: try expiredSubmission.canonicalDigest()
        ))

        // Launch fresh executor (new process bootSessionID)
        let newExecutor = DeviceTaskExecutor(
            journal: DeviceExecutionJournal(directory: root),
            workspace: workspace,
            bootSessionID: UUID()
        )
        let report = try await newExecutor.recoverAndResumeIfNeeded(autoStart: true)
        XCTAssertEqual(report.recoveredInterruptedCount, 1)
        XCTAssertEqual(report.convergedCancelledCount, 1)
        XCTAssertEqual(report.expiredCount, 1)

        let resumedOutcome = try await newExecutor.waitForCompletion(taskID: runningID)
        XCTAssertEqual(resumedOutcome.status, .completed)
        XCTAssertEqual(resumedOutcome.attemptCount, 2)
        XCTAssertEqual(resumedOutcome.artifacts.count, 1)

        let artifactData = try await newExecutor.artifactData(
            taskID: runningID,
            artifactID: resumedOutcome.artifacts[0].artifactID
        ).data
        // Confirms step 2 consumed step 1's persisted checkpoint output!
        XCTAssertEqual(String(data: artifactData, encoding: .utf8), "recovered payload")

        let cancelledOutcome = try await newExecutor.outcome(for: cancelledID)
        XCTAssertEqual(cancelledOutcome.status, .cancelled)

        let expiredOutcome = try await newExecutor.outcome(for: expiredID)
        XCTAssertEqual(expiredOutcome.status, .failed)
        XCTAssertEqual(expiredOutcome.errorCode, .deadlineExceeded)
    }

    func testOnDevicePerformanceBenchmarkSuite() async throws {
        let report = try await DeviceExecutorBenchmark.runSuite(iterations: 5)
        let markdown = report.markdownSummary()
        print("\n=== DEVICE BENCHMARK REPORT ===\n\(markdown)\n===============================\n")

        XCTAssertEqual(report.cases.count, 4)
        for item in report.cases {
            XCTAssertGreaterThan(item.p50Ms, 0)
            XCTAssertLessThan(item.p95Ms, 5_000, "Benchmark case \(item.name) exceeded 5s P95")
        }
    }
}

private final class FakeBackgroundTaskManager: BackgroundTaskManaging, @unchecked Sendable {
    private let lock = NSLock()
    private var nextID: Int = 1
    private var handlers: [Int: @Sendable () -> Void] = [:]
    private var _beginCount = 0

    var beginCount: Int {
        lock.withLock { _beginCount }
    }

    func beginBackgroundTask(
        name: String,
        expirationHandler: @escaping @Sendable () -> Void
    ) async -> Int {
        lock.withLock {
            _beginCount += 1
            let id = nextID
            nextID += 1
            handlers[id] = expirationHandler
            return id
        }
    }

    func endBackgroundTask(_ identifier: Int) async {
        _ = lock.withLock {
            handlers.removeValue(forKey: identifier)
        }
    }

    func fireLatestExpiration() {
        let handler: (@Sendable () -> Void)? = lock.withLock {
            guard let maxKey = handlers.keys.max() else { return nil }
            return handlers[maxKey]
        }
        handler?()
    }
}

private actor SlowCancellableTool: NativeTool {
    static let toolName = DeviceToolName(rawValue: "device.test.slow")!
    let name: DeviceToolName = SlowCancellableTool.toolName

    private var delayMs: Int
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []

    init(stepDelayMs: Int) {
        self.delayMs = stepDelayMs
    }

    func setDelayMs(_ newDelay: Int) {
        self.delayMs = newDelay
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { continuation in
            startWaiters.append(continuation)
        }
    }

    func execute(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) async throws -> NativeToolOutput {
        started = true
        let waiters = startWaiters
        startWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }

        let currentDelay = delayMs
        let sliceMs = 20
        var elapsed = 0
        while elapsed < currentDelay {
            try context.checkCancellation()
            try await Task.sleep(for: .milliseconds(sliceMs))
            elapsed += sliceMs
        }
        try context.checkCancellation()
        return NativeToolOutput(summaryText: "Slow tool finished.", outputText: "ok")
    }
}
