import Foundation
import SwiftUI
import UIKit

/// Abstraction over iOS background execution assertions so foreground/background lifecycle
/// handling can be verified deterministically in XCTest as well as on physical devices.
public protocol BackgroundTaskManaging: Sendable {
    func beginBackgroundTask(
        name: String,
        expirationHandler: @escaping @Sendable () -> Void
    ) async -> Int

    func endBackgroundTask(_ identifier: Int) async
}

public final class UIKitBackgroundTaskManager: BackgroundTaskManaging {
    public init() {}

    public func beginBackgroundTask(
        name: String,
        expirationHandler: @escaping @Sendable () -> Void
    ) async -> Int {
        await MainActor.run {
            let taskID = UIApplication.shared.beginBackgroundTask(withName: name) {
                expirationHandler()
            }
            return taskID.rawValue
        }
    }

    public func endBackgroundTask(_ identifier: Int) async {
        let invalidRaw = await MainActor.run { UIBackgroundTaskIdentifier.invalid.rawValue }
        guard identifier != invalidRaw else { return }
        await MainActor.run {
            UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: identifier))
        }
    }
}

/// Authoritative iPhone on-device execution node runtime.
/// Manages atomic admission, idempotency, bounded execution, cooperative cancellation,
/// foreground/background lifecycle suspension, and fenced durable recovery.
public actor DeviceTaskExecutor {
    private struct ActiveRunHandle {
        let runID: UUID
        let leaseEpoch: Int
        let task: Task<Void, Never>
        var cancelledByUser: Bool = false
        var interruptedByBackground: Bool = false
    }

    public let bootSessionID: UUID
    public let policy: DeviceSandboxPolicy
    public let workspace: DeviceSandboxWorkspace

    private let journal: DeviceExecutionJournal
    private let registry: NativeToolRegistry
    private let backgroundTaskManager: any BackgroundTaskManaging
    private let now: @Sendable () -> Date

    private var activeRuns: [UUID: ActiveRunHandle] = [:]
    private var queuedTaskIDs: [UUID] = []
    private var waiters: [UUID: [CheckedContinuation<DeviceTaskOutcome, Error>]] = [:]
    private var cachedOutcomes: [UUID: DeviceTaskOutcome] = [:]
    private var isDrainLoopRunning = false
    private var isBackgroundSuspended = false
    private var activeBackgroundTaskID: Int?
    public private(set) var lastRecoveryReport: DeviceRecoveryReport?

    public init(
        journal: DeviceExecutionJournal = DeviceExecutionJournal(),
        workspace: DeviceSandboxWorkspace = DeviceSandboxWorkspace(),
        registry: NativeToolRegistry = NativeToolRegistry(),
        policy: DeviceSandboxPolicy = .default,
        backgroundTaskManager: any BackgroundTaskManaging = UIKitBackgroundTaskManager(),
        bootSessionID: UUID = UUID(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.journal = journal
        self.workspace = workspace
        self.registry = registry
        self.policy = policy
        self.backgroundTaskManager = backgroundTaskManager
        self.bootSessionID = bootSessionID
        self.now = now
    }

    /// Reconciles persisted local tasks on launch or foreground recovery and resumes runnable work.
    @discardableResult
    public func recoverAndResumeIfNeeded(autoStart: Bool = true) async throws -> DeviceRecoveryReport {
        let (report, runnableTaskIDs, terminalRecords) = try await journal.recoverOnLaunch(
            currentBootSessionID: bootSessionID,
            now: now()
        )
        for terminal in terminalRecords {
            let termOutcome = outcome(from: terminal)
            cachedOutcomes[terminal.task.taskID] = termOutcome
            resumeWaiters(for: terminal.task.taskID, with: .success(termOutcome))
        }
        for taskID in runnableTaskIDs {
            workspace.cleanupStaging(for: taskID)
            if !queuedTaskIDs.contains(taskID), activeRuns[taskID] == nil {
                queuedTaskIDs.append(taskID)
            }
        }
        lastRecoveryReport = report
        if autoStart, !isBackgroundSuspended {
            scheduleDrainIfNeeded()
        }
        return report
    }

    public func submitTask(
        _ submission: DeviceTaskSubmission,
        startImmediately: Bool = true
    ) async throws -> TaskReceiptDTO {
        try validateSubmission(submission)

        if policy.rejectOnCriticalThermalState,
           DeviceResourceMonitor.currentThermalLevel() == .critical {
            throw DeviceExecutorError.thermalThrottled(.critical)
        }

        let digest = try submission.canonicalDigest()
        let result = try await journal.insertOrReplay(
            submission: submission,
            requestDigest: digest,
            title: submission.title ?? defaultTitle(for: submission),
            now: now()
        )

        let task = result.record.task
        if task.status.isTerminal {
            cachedOutcomes[task.taskID] = outcome(from: result.record)
        } else if !result.replayed {
            if !queuedTaskIDs.contains(task.taskID) {
                queuedTaskIDs.append(task.taskID)
            }
            if startImmediately, !isBackgroundSuspended {
                scheduleDrainIfNeeded()
            }
        }

        return TaskReceiptDTO(
            taskID: task.taskID,
            status: task.status,
            acceptedAt: task.createdAt,
            replayed: result.replayed
        )
    }

    public func executeAndWait(_ submission: DeviceTaskSubmission) async throws -> DeviceTaskOutcome {
        let receipt = try await submitTask(submission, startImmediately: true)
        return try await waitForCompletion(taskID: receipt.taskID)
    }

    public func waitForCompletion(taskID: UUID) async throws -> DeviceTaskOutcome {
        if let cached = cachedOutcomes[taskID] {
            return cached
        }
        guard let record = try await journal.record(for: taskID) else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        if record.task.status.isTerminal {
            let resolved = outcome(from: record)
            cachedOutcomes[taskID] = resolved
            return resolved
        }
        // Re-check actor-local terminal cache synchronously after the `await` so a completion
        // occurring during `journal.record` cannot be missed before registering the waiter.
        if let cached = cachedOutcomes[taskID] {
            return cached
        }

        return try await withCheckedThrowingContinuation { continuation in
            waiters[taskID, default: []].append(continuation)
        }
    }

    @discardableResult
    public func cancelTask(id taskID: UUID) async throws -> TaskCancelDTO {
        let cancelOutcome = try await journal.requestCancel(taskID: taskID, now: now())

        switch cancelOutcome {
        case .alreadyTerminal(let record):
            let resolved = outcome(from: record)
            cachedOutcomes[taskID] = resolved
            resumeWaiters(for: taskID, with: .success(resolved))
            return TaskCancelDTO(
                taskID: taskID,
                status: record.task.status,
                cancelRequested: record.task.cancelRequested,
                cancelRequestedAt: record.task.cancelRequested ? record.task.updatedAt : nil,
                terminal: true,
                updatedAt: record.task.updatedAt
            )

        case .cancelledQueued(let record):
            queuedTaskIDs.removeAll { $0 == taskID }
            workspace.cleanupStaging(for: taskID)
            let resolved = outcome(from: record)
            cachedOutcomes[taskID] = resolved
            resumeWaiters(for: taskID, with: .success(resolved))
            return TaskCancelDTO(
                taskID: taskID,
                status: .cancelled,
                cancelRequested: true,
                cancelRequestedAt: record.task.updatedAt,
                terminal: true,
                updatedAt: record.task.updatedAt
            )

        case .markedCancelRequested(let record):
            if var active = activeRuns[taskID] {
                active.cancelledByUser = true
                activeRuns[taskID] = active
                active.task.cancel()
            } else {
                // Non-running & non-queued (e.g. retryableFailed): converge immediately under fencing.
                let finalized = try await journal.commitCancelled(
                    taskID: taskID,
                    expectedLeaseEpoch: record.leaseEpoch,
                    reason: "Task cancelled while waiting for retry.",
                    now: now()
                )
                let resolved = outcome(from: finalized)
                cachedOutcomes[taskID] = resolved
                resumeWaiters(for: taskID, with: .success(resolved))
                return TaskCancelDTO(
                    taskID: taskID,
                    status: finalized.task.status,
                    cancelRequested: true,
                    cancelRequestedAt: finalized.task.updatedAt,
                    terminal: true,
                    updatedAt: finalized.task.updatedAt
                )
            }

            return TaskCancelDTO(
                taskID: taskID,
                status: record.task.status,
                cancelRequested: true,
                cancelRequestedAt: record.task.updatedAt,
                terminal: false,
                updatedAt: record.task.updatedAt
            )
        }
    }

    public func handleScenePhase(_ phase: ScenePhase) async {
        switch phase {
        case .background:
            await prepareForBackgroundSuspension()
        case .active:
            await resumeFromForeground()
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    public func prepareForBackgroundSuspension() async {
        isBackgroundSuspended = true
        guard !activeRuns.isEmpty, activeBackgroundTaskID == nil else { return }
        let bgID = await backgroundTaskManager.beginBackgroundTask(
            name: "ember.device-executor.run"
        ) { [weak self] in
            Task {
                await self?.handleBackgroundTaskExpiration()
            }
        }
        activeBackgroundTaskID = bgID
    }

    public func handleBackgroundTaskExpiration() async {
        var tasksToAwait: [Task<Void, Never>] = []
        for (taskID, var active) in activeRuns {
            active.interruptedByBackground = true
            activeRuns[taskID] = active
            active.task.cancel()
            tasksToAwait.append(active.task)
        }
        for runningTask in tasksToAwait {
            await runningTask.value
        }
        if let bgID = activeBackgroundTaskID {
            activeBackgroundTaskID = nil
            await backgroundTaskManager.endBackgroundTask(bgID)
        }
    }

    public func resumeFromForeground() async {
        isBackgroundSuspended = false
        if let bgID = activeBackgroundTaskID {
            activeBackgroundTaskID = nil
            await backgroundTaskManager.endBackgroundTask(bgID)
        }
        _ = try? await recoverAndResumeIfNeeded(autoStart: true)
    }

    public func allRecords() async throws -> [PersistedDeviceTaskRecord] {
        try await journal.allRecords()
    }

    public func record(for taskID: UUID) async throws -> PersistedDeviceTaskRecord? {
        try await journal.record(for: taskID)
    }

    public func outcome(for taskID: UUID) async throws -> DeviceTaskOutcome {
        if let cached = cachedOutcomes[taskID] {
            return cached
        }
        guard let record = try await journal.record(for: taskID) else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        let resolved = outcome(from: record)
        if record.task.status.isTerminal {
            cachedOutcomes[taskID] = resolved
        }
        return resolved
    }

    public func artifactFileURL(taskID: UUID, artifactID: UUID) async throws -> URL {
        guard let record = try await journal.record(for: taskID),
              let artifact = record.artifacts.first(where: { $0.artifactID == artifactID })
        else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        return try workspace.artifactFileURL(for: artifact)
    }

    public func artifactData(taskID: UUID, artifactID: UUID) async throws -> (artifact: DeviceGeneratedArtifact, data: Data) {
        guard let record = try await journal.record(for: taskID),
              let artifact = record.artifacts.first(where: { $0.artifactID == artifactID })
        else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        let data = try workspace.readArtifactData(for: artifact)
        return (artifact, data)
    }

    private func scheduleDrainIfNeeded() {
        guard !isDrainLoopRunning, !isBackgroundSuspended else { return }
        isDrainLoopRunning = true
        Task {
            await self.drainQueueLoop()
        }
    }

    private func drainQueueLoop() async {
        defer {
            isDrainLoopRunning = false
        }

        while !isBackgroundSuspended,
              activeRuns.count < policy.maxConcurrentTasks,
              !queuedTaskIDs.isEmpty {
            let nextTaskID = queuedTaskIDs.removeFirst()
            guard activeRuns[nextTaskID] == nil else { continue }
            await launchRun(for: nextTaskID)
        }

        if activeRuns.isEmpty, let bgID = activeBackgroundTaskID {
            activeBackgroundTaskID = nil
            await backgroundTaskManager.endBackgroundTask(bgID)
        }
    }

    private func launchRun(for taskID: UUID) async {
        let newRunID = UUID()
        let claimedRecord: PersistedDeviceTaskRecord
        do {
            claimedRecord = try await journal.claimRun(
                taskID: taskID,
                runID: newRunID,
                bootSessionID: bootSessionID,
                now: now()
            )
        } catch DeviceExecutorError.cancelled {
            await finalizeCancelledSafely(
                taskID: taskID,
                expectedLeaseEpoch: nil,
                reason: "Task cancelled before run claim."
            )
            return
        } catch DeviceExecutorError.executionTimeout(let message) {
            await finalizeFailedSafely(
                taskID: taskID,
                expectedLeaseEpoch: nil,
                errorCode: .deadlineExceeded,
                message: message
            )
            return
        } catch DeviceExecutorError.staleLease {
            if let existing = try? await journal.record(for: taskID), existing.task.status.isTerminal {
                let resolved = outcome(from: existing)
                cachedOutcomes[taskID] = resolved
                resumeWaiters(for: taskID, with: .success(resolved))
            }
            return
        } catch {
            resumeWaiters(for: taskID, with: .failure(error))
            return
        }

        let leaseEpoch = claimedRecord.leaseEpoch
        let executionTask = Task { [weak self] in
            guard let self else { return }
            await self.executeRun(
                taskID: taskID,
                runID: newRunID,
                leaseEpoch: leaseEpoch,
                initialRecord: claimedRecord
            )
        }
        activeRuns[taskID] = ActiveRunHandle(
            runID: newRunID,
            leaseEpoch: leaseEpoch,
            task: executionTask
        )
        await executionTask.value
    }

    private func executeRun(
        taskID: UUID,
        runID: UUID,
        leaseEpoch: Int,
        initialRecord: PersistedDeviceTaskRecord
    ) async {
        defer {
            activeRuns.removeValue(forKey: taskID)
        }

        let startResource = await DeviceResourceMonitor.capture(includeBattery: false)
        var stepOutputsByID: [String: NativeToolOutput] = [:]
        var lastOutput: NativeToolOutput?
        var completedStepsCount = initialRecord.completedStepOutputs.count
        var latestRecord = initialRecord

        for (idx, step) in initialRecord.submission.steps.enumerated() {
            if let existingOutput = initialRecord.completedStepOutputs[idx] {
                stepOutputsByID[step.stepID] = existingOutput
                lastOutput = existingOutput
            }
        }

        do {
            for (index, step) in initialRecord.submission.steps.enumerated() {
                if let cachedOutput = latestRecord.completedStepOutputs[index] {
                    stepOutputsByID[step.stepID] = cachedOutput
                    lastOutput = cachedOutput
                    continue
                }

                try checkRunControl(taskID: taskID, record: latestRecord)

                let stepStart = DispatchTime.now().uptimeNanoseconds
                let tool = try registry.tool(named: step.tool)
                let stepContext = NativeToolExecutionContext(
                    taskID: taskID,
                    runID: runID,
                    stepIndex: index,
                    stepID: step.stepID,
                    workspace: workspace,
                    policy: policy,
                    previousStepOutputs: stepOutputsByID,
                    lastStepOutput: lastOutput
                )

                let output = try await runStepWithTimeout(
                    tool: tool,
                    context: stepContext,
                    arguments: step.arguments,
                    timeoutMs: policy.stepTimeoutMs
                )

                try validateStructuredOutputSize(output.structuredData)
                try checkRunControl(taskID: taskID, record: latestRecord)

                let stepDurationMs = Int((DispatchTime.now().uptimeNanoseconds - stepStart) / 1_000_000)

                latestRecord = try await journal.checkpointStep(
                    taskID: taskID,
                    runID: runID,
                    expectedLeaseEpoch: leaseEpoch,
                    bootSessionID: bootSessionID,
                    stepIndex: index,
                    output: output,
                    durationMs: stepDurationMs,
                    now: now()
                )

                stepOutputsByID[step.stepID] = output
                lastOutput = output
                completedStepsCount += 1
            }

            let endResource = await DeviceResourceMonitor.capture(includeBattery: false)
            let metrics = DeviceResourceMonitor.metrics(
                from: startResource,
                to: endResource,
                stepsCompleted: completedStepsCount,
                artifactsGenerated: latestRecord.artifacts.count
            )

            let completedISO = DeviceWireDate.format(now())
            let summaryRaw = lastOutput?.summaryText ?? "Completed \(completedStepsCount) native step(s)."
            let detailRaw = lastOutput?.outputText ?? ""
            let clampedSummary = String(summaryRaw.prefix(2048))
            let clampedDetail = detailRaw.isEmpty ? nil : String(detailRaw.prefix(16384))

            let textResult = SessionTaskTextResult(
                summaryText: clampedSummary,
                detailText: clampedDetail,
                modelLabel: "iphone-native-executor-v1",
                simulated: false,
                producedAt: completedISO
            )

            // Re-check local run flags right before fenced commit.
            try checkRunControl(taskID: taskID, record: latestRecord)

            let committed = try await journal.commitCompleted(
                taskID: taskID,
                runID: runID,
                expectedLeaseEpoch: leaseEpoch,
                bootSessionID: bootSessionID,
                textResult: textResult,
                structuredOutput: lastOutput?.structuredData,
                metrics: metrics,
                now: now()
            )
            let resolved = outcome(from: committed)
            cachedOutcomes[taskID] = resolved
            resumeWaiters(for: taskID, with: .success(resolved))
        } catch is CancellationError {
            await handleInterruptedOrCancelledRun(
                taskID: taskID,
                runID: runID,
                leaseEpoch: leaseEpoch
            )
        } catch let error as DeviceExecutorError where error == .cancelled || error == .backgroundSuspended {
            await handleInterruptedOrCancelledRun(
                taskID: taskID,
                runID: runID,
                leaseEpoch: leaseEpoch
            )
        } catch let error as DeviceExecutorError {
            workspace.cleanupStaging(for: taskID)
            await finalizeFailedSafely(
                taskID: taskID,
                expectedLeaseEpoch: leaseEpoch,
                errorCode: error.taskErrorCode,
                message: error.localizedDescription
            )
        } catch {
            workspace.cleanupStaging(for: taskID)
            await finalizeFailedSafely(
                taskID: taskID,
                expectedLeaseEpoch: leaseEpoch,
                errorCode: .executionTimeout,
                message: error.localizedDescription
            )
        }
    }

    private func handleInterruptedOrCancelledRun(
        taskID: UUID,
        runID: UUID,
        leaseEpoch: Int
    ) async {
        workspace.cleanupStaging(for: taskID)
        let active = activeRuns[taskID]

        if active?.interruptedByBackground == true && active?.cancelledByUser != true {
            do {
                let interruptOutcome = try await journal.commitInterruptedForRetry(
                    taskID: taskID,
                    runID: runID,
                    expectedLeaseEpoch: leaseEpoch,
                    bootSessionID: bootSessionID,
                    now: now()
                )
                switch interruptOutcome {
                case .requeued:
                    if !queuedTaskIDs.contains(taskID) {
                        queuedTaskIDs.append(taskID)
                    }
                case .failedMaxAttempts(let record), .cancelled(let record), .alreadyTerminal(let record):
                    let resolved = outcome(from: record)
                    cachedOutcomes[taskID] = resolved
                    resumeWaiters(for: taskID, with: .success(resolved))
                }
                return
            } catch DeviceExecutorError.cancelled {
                await finalizeCancelledSafely(
                    taskID: taskID,
                    expectedLeaseEpoch: leaseEpoch,
                    reason: "Task cancelled during background interruption."
                )
                return
            } catch {
                resumeWaiters(for: taskID, with: .failure(error))
                return
            }
        }

        await finalizeCancelledSafely(
            taskID: taskID,
            expectedLeaseEpoch: leaseEpoch,
            reason: "Task cancelled during execution."
        )
    }

    private func finalizeCancelledSafely(
        taskID: UUID,
        expectedLeaseEpoch: Int?,
        reason: String
    ) async {
        workspace.cleanupStaging(for: taskID)
        do {
            let finalized = try await journal.commitCancelled(
                taskID: taskID,
                expectedLeaseEpoch: expectedLeaseEpoch,
                reason: reason,
                now: now()
            )
            let resolved = outcome(from: finalized)
            cachedOutcomes[taskID] = resolved
            resumeWaiters(for: taskID, with: .success(resolved))
        } catch {
            resumeWaiters(for: taskID, with: .failure(error))
        }
    }

    private func finalizeFailedSafely(
        taskID: UUID,
        expectedLeaseEpoch: Int?,
        errorCode: TaskErrorCode,
        message: String
    ) async {
        workspace.cleanupStaging(for: taskID)
        do {
            let finalized = try await journal.commitFailed(
                taskID: taskID,
                expectedLeaseEpoch: expectedLeaseEpoch,
                errorCode: errorCode,
                message: message,
                now: now()
            )
            let resolved = outcome(from: finalized)
            cachedOutcomes[taskID] = resolved
            resumeWaiters(for: taskID, with: .success(resolved))
        } catch {
            resumeWaiters(for: taskID, with: .failure(error))
        }
    }

    private func checkRunControl(taskID: UUID, record: PersistedDeviceTaskRecord) throws {
        if activeRuns[taskID]?.interruptedByBackground == true {
            throw DeviceExecutorError.backgroundSuspended
        }
        if activeRuns[taskID]?.cancelledByUser == true || Task.isCancelled {
            throw DeviceExecutorError.cancelled
        }
        if let deadlineISO = record.task.deadlineAt,
           let deadline = DeviceWireDate.parse(deadlineISO),
           deadline <= now() {
            throw DeviceExecutorError.executionTimeout("Task deadline exceeded during execution.")
        }
    }

    private func validateStructuredOutputSize(_ value: DeviceJSONValue?) throws {
        guard let value else { return }
        let jsonString = try value.canonicalJSONString(prettyPrinted: false)
        let byteCount = Data(jsonString.utf8).count
        guard byteCount <= policy.maxOutputTextBytes else {
            throw DeviceExecutorError.payloadTooLarge(
                "Structured output (\(byteCount) bytes) exceeds limit \(policy.maxOutputTextBytes)."
            )
        }
    }

    private func runStepWithTimeout(
        tool: any NativeTool,
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue],
        timeoutMs: Int
    ) async throws -> NativeToolOutput {
        try await withThrowingTaskGroup(of: NativeToolOutput.self) { group in
            group.addTask {
                try await tool.execute(context: context, arguments: arguments)
            }
            group.addTask {
                try await Task.sleep(for: .milliseconds(timeoutMs))
                throw DeviceExecutorError.executionTimeout(
                    "Tool '\(tool.name.rawValue)' exceeded step timeout (\(timeoutMs) ms)."
                )
            }
            guard let first = try await group.next() else {
                throw DeviceExecutorError.cancelled
            }
            group.cancelAll()
            return first
        }
    }

    private func resumeWaiters(for taskID: UUID, with result: Result<DeviceTaskOutcome, Error>) {
        guard let pending = waiters.removeValue(forKey: taskID) else { return }
        for continuation in pending {
            continuation.resume(with: result)
        }
    }

    private func outcome(from record: PersistedDeviceTaskRecord) -> DeviceTaskOutcome {
        DeviceTaskOutcome(
            taskID: record.task.taskID,
            runID: record.task.currentRunID ?? record.task.taskID,
            attemptCount: record.task.attemptCount,
            leaseEpoch: record.leaseEpoch,
            status: record.task.status,
            summaryText: record.result?.result?.summaryText ?? record.lastErrorMessage ?? "",
            detailText: record.result?.result?.detailText ?? "",
            structuredOutput: record.structuredOutput,
            artifacts: record.artifacts,
            metrics: record.metrics,
            errorCode: record.lastErrorCode,
            errorMessage: record.lastErrorMessage,
            producedAt: record.result?.result?.producedAt ?? record.task.updatedAt
        )
    }

    private func validateSubmission(_ submission: DeviceTaskSubmission) throws {
        guard !submission.idempotencyKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DeviceExecutorError.invalidArgument("Submission idempotencyKey cannot be empty.")
        }
        guard !submission.steps.isEmpty else {
            throw DeviceExecutorError.invalidArgument("Submission must contain at least one tool step.")
        }
        guard submission.steps.count <= policy.maxStepsPerTask else {
            throw DeviceExecutorError.payloadTooLarge(
                "Step count \(submission.steps.count) exceeds limit \(policy.maxStepsPerTask)."
            )
        }
        var seenStepIDs = Set<String>()
        for step in submission.steps {
            guard !step.stepID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw DeviceExecutorError.invalidArgument("Step ID cannot be empty.")
            }
            guard seenStepIDs.insert(step.stepID).inserted else {
                throw DeviceExecutorError.invalidArgument("Duplicate step ID '\(step.stepID)'.")
            }
            _ = try registry.tool(named: step.tool)
        }
    }

    private func defaultTitle(for submission: DeviceTaskSubmission) -> String {
        if submission.steps.count == 1, let first = submission.steps.first {
            return "On-device · \(first.tool.rawValue)"
        }
        return "On-device · \(submission.steps.count) steps"
    }
}
