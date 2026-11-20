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
/// Manages task admission, idempotency, bounded execution, cooperative cancellation,
/// foreground/background lifecycle suspension, and durable crash/relaunch recovery.
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
        let (report, runnableTaskIDs) = try await journal.recoverOnLaunch(
            currentBootSessionID: bootSessionID,
            now: now()
        )
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
        if let existing = try await journal.existingSubmission(idempotencyKey: submission.idempotencyKey) {
            guard existing.requestDigest == digest else {
                throw DeviceExecutorError.idempotencyConflict
            }
            if let existingRecord = try await journal.record(for: existing.taskID) {
                return TaskReceiptDTO(
                    taskID: existingRecord.task.taskID,
                    status: existingRecord.task.status,
                    acceptedAt: existingRecord.task.createdAt,
                    replayed: true
                )
            }
        }

        let createdDate = now()
        let createdISO = DeviceWireDate.format(createdDate)
        let deadlineISO = DeviceWireDate.format(createdDate.addingTimeInterval(submission.deadlineSeconds))
        let taskID = UUID()

        let taskDTO = SessionTaskDTO(
            taskID: taskID,
            agentID: submission.agentID,
            kind: DeviceTaskSubmission.deviceTaskKind,
            title: submission.title ?? defaultTitle(for: submission),
            status: .queued,
            currentRunID: nil,
            attemptCount: 0,
            cancelRequested: false,
            createdAt: createdISO,
            updatedAt: createdISO,
            deadlineAt: deadlineISO,
            resultState: .pending
        )

        let acceptedEvent = SessionTaskEventDTO(
            taskID: taskID,
            sequence: 1,
            phase: .accepted,
            occurredAt: createdISO,
            traceID: taskID,
            payload: SessionTaskEventPayloadDTO(
                taskKind: DeviceTaskSubmission.deviceTaskKind,
                route: .fast,
                toStatus: .queued,
                replayed: false,
                simulated: false
            )
        )

        let record = PersistedDeviceTaskRecord(
            task: taskDTO,
            submission: submission,
            requestDigest: digest,
            leaseEpoch: 0,
            ownerBootSessionID: nil,
            completedStepOutputs: [:],
            events: [acceptedEvent]
        )

        try await journal.insertQueuedTask(record)
        queuedTaskIDs.append(taskID)

        if startImmediately, !isBackgroundSuspended {
            scheduleDrainIfNeeded()
        }

        return TaskReceiptDTO(
            taskID: taskID,
            status: .queued,
            acceptedAt: createdISO,
            replayed: false
        )
    }

    public func executeAndWait(_ submission: DeviceTaskSubmission) async throws -> DeviceTaskOutcome {
        let receipt = try await submitTask(submission, startImmediately: true)
        return try await waitForCompletion(taskID: receipt.taskID)
    }

    public func waitForCompletion(taskID: UUID) async throws -> DeviceTaskOutcome {
        guard let record = try await journal.record(for: taskID) else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        if record.task.status.isTerminal {
            return outcome(from: record)
        }

        return try await withCheckedThrowingContinuation { continuation in
            waiters[taskID, default: []].append(continuation)
        }
    }

    @discardableResult
    public func cancelTask(id taskID: UUID) async throws -> TaskCancelDTO {
        guard var record = try await journal.record(for: taskID) else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }

        let currentDate = now()
        let nowISO = DeviceWireDate.format(currentDate)

        if record.task.status.isTerminal {
            return TaskCancelDTO(
                taskID: taskID,
                status: record.task.status,
                cancelRequested: record.task.cancelRequested,
                cancelRequestedAt: record.task.cancelRequested ? record.task.updatedAt : nil,
                terminal: true,
                updatedAt: record.task.updatedAt
            )
        }

        record.task = updatingTask(
            record.task,
            status: record.task.status,
            cancelRequested: true,
            updatedAt: nowISO,
            resultState: record.task.resultState
        )

        if var active = activeRuns[taskID] {
            active.cancelledByUser = true
            activeRuns[taskID] = active
            try await journal.saveRecord(record)
            active.task.cancel()
            return TaskCancelDTO(
                taskID: taskID,
                status: record.task.status,
                cancelRequested: true,
                cancelRequestedAt: nowISO,
                terminal: false,
                updatedAt: nowISO
            )
        }

        // Task is queued (not actively executing): converge directly to cancelled.
        queuedTaskIDs.removeAll { $0 == taskID }
        workspace.cleanupStaging(for: taskID)
        let previousStatus = record.task.status
        let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
        record.task = updatingTask(
            record.task,
            status: .cancelled,
            cancelRequested: true,
            updatedAt: nowISO,
            resultState: .unavailable
        )
        record.ownerBootSessionID = nil
        record.events.append(
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: nextSeq,
                phase: .cancelled,
                occurredAt: nowISO,
                traceID: record.task.currentRunID ?? taskID,
                payload: SessionTaskEventPayloadDTO(
                    taskKind: record.task.kind,
                    runID: record.task.currentRunID,
                    attempt: max(1, record.task.attemptCount),
                    route: .fast,
                    fromStatus: previousStatus,
                    toStatus: .cancelled,
                    runStatus: .cancelled,
                    errorCode: .cancelled,
                    cancelRequested: true,
                    simulated: false
                )
            )
        )
        record.result = SessionTaskResultDTO(
            taskID: taskID,
            taskStatus: .cancelled,
            resultState: .unavailable,
            result: nil
        )
        record.lastErrorCode = .cancelled
        record.lastErrorMessage = "Task cancelled before execution started."
        try await journal.saveRecord(record)
        resumeWaiters(for: taskID, with: .success(outcome(from: record)))

        return TaskCancelDTO(
            taskID: taskID,
            status: .cancelled,
            cancelRequested: true,
            cancelRequestedAt: nowISO,
            terminal: true,
            updatedAt: nowISO
        )
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

    /// Requests a bounded iOS background assertion for in-flight local runs and prepares
    /// clean cooperative interruption if the OS expiration handler triggers.
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
        guard let record = try await journal.record(for: taskID) else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        return outcome(from: record)
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
        guard var record = try? await journal.record(for: taskID) else { return }
        guard !record.task.status.isTerminal else {
            resumeWaiters(for: taskID, with: .success(outcome(from: record)))
            return
        }

        let startTime = now()
        let startISO = DeviceWireDate.format(startTime)

        if record.task.cancelRequested {
            await finalizeCancelled(&record, at: startISO, reason: "Task cancelled before run claim.")
            return
        }

        if let deadlineISO = record.task.deadlineAt,
           let deadlineDate = DeviceWireDate.parse(deadlineISO),
           deadlineDate <= startTime {
            await finalizeFailed(
                &record,
                at: startISO,
                errorCode: .deadlineExceeded,
                message: "Task deadline exceeded before execution."
            )
            return
        }

        let newRunID = UUID()
        let newAttempt = record.task.attemptCount + 1
        let newEpoch = record.leaseEpoch + 1
        let previousStatus = record.task.status

        record.leaseEpoch = newEpoch
        record.ownerBootSessionID = bootSessionID
        record.task = updatingTask(
            record.task,
            status: .running,
            currentRunID: newRunID,
            attemptCount: newAttempt,
            updatedAt: startISO,
            resultState: .pending
        )

        let baseSeq = (record.events.map(\.sequence).max() ?? 0) + 1
        record.events.append(
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: baseSeq,
                phase: .leased,
                occurredAt: startISO,
                traceID: newRunID,
                payload: SessionTaskEventPayloadDTO(
                    taskKind: record.task.kind,
                    runID: newRunID,
                    attempt: newAttempt,
                    route: .fast,
                    fromStatus: previousStatus,
                    toStatus: .running,
                    runStatus: .created,
                    simulated: false
                )
            )
        )
        record.events.append(
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: baseSeq + 1,
                phase: .started,
                occurredAt: startISO,
                traceID: newRunID,
                payload: SessionTaskEventPayloadDTO(
                    taskKind: record.task.kind,
                    runID: newRunID,
                    attempt: newAttempt,
                    route: .fast,
                    fromStatus: previousStatus,
                    toStatus: .running,
                    runStatus: .running,
                    simulated: false
                )
            )
        )

        do {
            try await journal.saveRecord(record)
        } catch {
            resumeWaiters(for: taskID, with: .failure(error))
            return
        }

        let executionTask = Task { [weak self] in
            guard let self else { return }
            await self.executeRun(taskID: taskID, runID: newRunID, leaseEpoch: newEpoch)
        }
        activeRuns[taskID] = ActiveRunHandle(
            runID: newRunID,
            leaseEpoch: newEpoch,
            task: executionTask
        )
        await executionTask.value
    }

    private func executeRun(taskID: UUID, runID: UUID, leaseEpoch: Int) async {
        defer {
            activeRuns.removeValue(forKey: taskID)
        }

        guard var record = try? await journal.record(for: taskID),
              record.leaseEpoch == leaseEpoch
        else {
            return
        }

        let startResource = await DeviceResourceMonitor.capture(includeBattery: false)
        var stepOutputsByID: [String: NativeToolOutput] = [:]
        var lastOutput: NativeToolOutput?
        var completedStepsCount = record.completedStepOutputs.count

        for (idx, step) in record.submission.steps.enumerated() {
            if let existingOutput = record.completedStepOutputs[idx] {
                stepOutputsByID[step.stepID] = existingOutput
                lastOutput = existingOutput
            }
        }

        do {
            for (index, step) in record.submission.steps.enumerated() {
                if let cachedOutput = record.completedStepOutputs[index] {
                    stepOutputsByID[step.stepID] = cachedOutput
                    lastOutput = cachedOutput
                    continue
                }

                try checkRunControl(taskID: taskID, record: record)

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

                try checkRunControl(taskID: taskID, record: record)

                let stepDurationMs = Int((DispatchTime.now().uptimeNanoseconds - stepStart) / 1_000_000)
                stepOutputsByID[step.stepID] = output
                lastOutput = output
                completedStepsCount += 1

                record.completedStepOutputs[index] = output
                for artifact in output.generatedArtifacts {
                    if !record.artifacts.contains(where: { $0.artifactID == artifact.artifactID }) {
                        record.artifacts.append(artifact)
                    }
                }

                let stepISO = DeviceWireDate.format(now())
                let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
                record.task = updatingTask(
                    record.task,
                    status: .running,
                    currentRunID: runID,
                    updatedAt: stepISO,
                    resultState: .pending
                )
                record.events.append(
                    SessionTaskEventDTO(
                        taskID: taskID,
                        sequence: nextSeq,
                        phase: .progress,
                        occurredAt: stepISO,
                        traceID: runID,
                        payload: SessionTaskEventPayloadDTO(
                            taskKind: record.task.kind,
                            runID: runID,
                            attempt: record.task.attemptCount,
                            route: .fast,
                            fromStatus: .running,
                            toStatus: .running,
                            runStatus: .running,
                            artifactID: output.generatedArtifacts.first?.artifactID,
                            durationMs: stepDurationMs,
                            simulated: false
                        )
                    )
                )
                try await journal.saveRecord(record)
            }

            let endResource = await DeviceResourceMonitor.capture(includeBattery: false)
            let metrics = DeviceResourceMonitor.metrics(
                from: startResource,
                to: endResource,
                stepsCompleted: completedStepsCount,
                artifactsGenerated: record.artifacts.count
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

            let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
            record.task = updatingTask(
                record.task,
                status: .completed,
                currentRunID: runID,
                updatedAt: completedISO,
                resultState: .available
            )
            record.ownerBootSessionID = nil
            record.metrics = metrics
            record.structuredOutput = lastOutput?.structuredData
            record.result = SessionTaskResultDTO(
                taskID: taskID,
                taskStatus: .completed,
                resultState: .available,
                result: textResult
            )
            record.events.append(
                SessionTaskEventDTO(
                    taskID: taskID,
                    sequence: nextSeq,
                    phase: .completed,
                    occurredAt: completedISO,
                    traceID: runID,
                    payload: SessionTaskEventPayloadDTO(
                        taskKind: record.task.kind,
                        runID: runID,
                        attempt: record.task.attemptCount,
                        route: .fast,
                        fromStatus: .running,
                        toStatus: .completed,
                        runStatus: .succeeded,
                        artifactID: record.artifacts.first?.artifactID,
                        durationMs: metrics.wallDurationMs,
                        simulated: false
                    )
                )
            )
            try await journal.saveRecord(record)
            resumeWaiters(for: taskID, with: .success(outcome(from: record)))
        } catch is CancellationError {
            await handleInterruptedRun(&record, taskID: taskID)
        } catch let error as DeviceExecutorError where error == .cancelled || error == .backgroundSuspended {
            await handleInterruptedRun(&record, taskID: taskID)
        } catch let error as DeviceExecutorError {
            workspace.cleanupStaging(for: taskID)
            let failedISO = DeviceWireDate.format(now())
            await finalizeFailed(
                &record,
                at: failedISO,
                errorCode: error.taskErrorCode,
                message: error.localizedDescription
            )
        } catch {
            workspace.cleanupStaging(for: taskID)
            let failedISO = DeviceWireDate.format(now())
            await finalizeFailed(
                &record,
                at: failedISO,
                errorCode: .executionTimeout,
                message: error.localizedDescription
            )
        }
    }

    private func handleInterruptedRun(_ record: inout PersistedDeviceTaskRecord, taskID: UUID) async {
        workspace.cleanupStaging(for: taskID)
        let nowISO = DeviceWireDate.format(now())
        let active = activeRuns[taskID]

        if active?.interruptedByBackground == true && active?.cancelledByUser != true && !record.task.cancelRequested {
            if record.task.attemptCount < record.submission.maxAttempts {
                let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
                record.leaseEpoch += 1
                record.ownerBootSessionID = nil
                record.task = updatingTask(
                    record.task,
                    status: .queued,
                    currentRunID: nil,
                    updatedAt: nowISO,
                    resultState: .pending
                )
                record.events.append(
                    SessionTaskEventDTO(
                        taskID: taskID,
                        sequence: nextSeq,
                        phase: .retryScheduled,
                        occurredAt: nowISO,
                        traceID: taskID,
                        payload: SessionTaskEventPayloadDTO(
                            taskKind: record.task.kind,
                            attempt: record.task.attemptCount,
                            route: .fast,
                            fromStatus: .running,
                            toStatus: .queued,
                            runStatus: .leaseExpired,
                            errorCode: .staleLease,
                            simulated: false
                        )
                    )
                )
                try? await journal.saveRecord(record)
                if !queuedTaskIDs.contains(taskID) {
                    queuedTaskIDs.append(taskID)
                }
                return
            }

            await finalizeFailed(
                &record,
                at: nowISO,
                errorCode: .staleLease,
                message: "Interrupted by background suspension after max attempts."
            )
            return
        }

        await finalizeCancelled(&record, at: nowISO, reason: "Task cancelled during execution.")
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

    private func finalizeCancelled(
        _ record: inout PersistedDeviceTaskRecord,
        at timestampISO: String,
        reason: String
    ) async {
        workspace.cleanupStaging(for: record.task.taskID)
        let previousStatus = record.task.status
        let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
        record.ownerBootSessionID = nil
        record.task = updatingTask(
            record.task,
            status: .cancelled,
            currentRunID: record.task.currentRunID,
            cancelRequested: true,
            updatedAt: timestampISO,
            resultState: .unavailable
        )
        record.events.append(
            SessionTaskEventDTO(
                taskID: record.task.taskID,
                sequence: nextSeq,
                phase: .cancelled,
                occurredAt: timestampISO,
                traceID: record.task.currentRunID ?? record.task.taskID,
                payload: SessionTaskEventPayloadDTO(
                    taskKind: record.task.kind,
                    runID: record.task.currentRunID,
                    attempt: max(1, record.task.attemptCount),
                    route: .fast,
                    fromStatus: previousStatus,
                    toStatus: .cancelled,
                    runStatus: .cancelled,
                    errorCode: .cancelled,
                    cancelRequested: true,
                    simulated: false
                )
            )
        )
        record.result = SessionTaskResultDTO(
            taskID: record.task.taskID,
            taskStatus: .cancelled,
            resultState: .unavailable,
            result: nil
        )
        record.lastErrorCode = .cancelled
        record.lastErrorMessage = reason
        try? await journal.saveRecord(record)
        resumeWaiters(for: record.task.taskID, with: .success(outcome(from: record)))
    }

    private func finalizeFailed(
        _ record: inout PersistedDeviceTaskRecord,
        at timestampISO: String,
        errorCode: TaskErrorCode,
        message: String
    ) async {
        workspace.cleanupStaging(for: record.task.taskID)
        let previousStatus = record.task.status
        let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
        record.ownerBootSessionID = nil
        record.task = updatingTask(
            record.task,
            status: .failed,
            currentRunID: record.task.currentRunID,
            updatedAt: timestampISO,
            resultState: .unavailable
        )
        record.events.append(
            SessionTaskEventDTO(
                taskID: record.task.taskID,
                sequence: nextSeq,
                phase: .failed,
                occurredAt: timestampISO,
                traceID: record.task.currentRunID ?? record.task.taskID,
                payload: SessionTaskEventPayloadDTO(
                    taskKind: record.task.kind,
                    runID: record.task.currentRunID,
                    attempt: max(1, record.task.attemptCount),
                    route: .fast,
                    fromStatus: previousStatus,
                    toStatus: .failed,
                    runStatus: .failedTerminal,
                    errorCode: errorCode,
                    simulated: false
                )
            )
        )
        record.result = SessionTaskResultDTO(
            taskID: record.task.taskID,
            taskStatus: .failed,
            resultState: .unavailable,
            result: nil
        )
        record.lastErrorCode = errorCode
        record.lastErrorMessage = message
        try? await journal.saveRecord(record)
        resumeWaiters(for: record.task.taskID, with: .success(outcome(from: record)))
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

    private func updatingTask(
        _ task: SessionTaskDTO,
        status: TaskStatus,
        currentRunID: UUID? = nil,
        attemptCount: Int? = nil,
        cancelRequested: Bool? = nil,
        updatedAt: String,
        resultState: SessionTaskResultState?
    ) -> SessionTaskDTO {
        SessionTaskDTO(
            taskID: task.taskID,
            agentID: task.agentID,
            kind: task.kind,
            title: task.title,
            status: status,
            currentRunID: currentRunID ?? task.currentRunID,
            attemptCount: attemptCount ?? task.attemptCount,
            cancelRequested: cancelRequested ?? task.cancelRequested,
            createdAt: task.createdAt,
            updatedAt: updatedAt,
            deadlineAt: task.deadlineAt,
            resultState: resultState
        )
    }
}
