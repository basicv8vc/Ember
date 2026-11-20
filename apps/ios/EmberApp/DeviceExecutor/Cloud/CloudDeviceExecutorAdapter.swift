import Foundation
import SwiftUI
import UIKit

public enum CloudDeviceCycleOutcome: Equatable, Sendable {
    case idle
    case flushedPending(taskId: UUID, outcome: CloudDeviceCommitOutcome)
    case recoveredUnfinished(taskId: UUID, outcome: CloudDeviceCommitOutcome)
    case recoveredFenced(taskId: UUID)
    case executed(taskId: UUID, outcome: CloudDeviceCommitOutcome)
    case interruptedFenced(taskId: UUID)
}

public enum CloudDeviceAdapterStatus: Equatable, Sendable {
    case stopped
    case suspended
    case registering
    case ready(readyUntilMs: Int64)
    case executing(taskId: UUID, runId: UUID, leaseEpoch: Int)
    case backingOff(message: String)
    case halted(CloudDeviceError)

    public var label: String {
        switch self {
        case .stopped:
            return "Stopped"
        case .suspended:
            return "Suspended (Background)"
        case .registering:
            return "Registering"
        case .ready(let readyUntilMs):
            return "Ready (until \(readyUntilMs))"
        case .executing(let taskId, _, let leaseEpoch):
            return "Running \(taskId.uuidString.lowercased()) (epoch \(leaseEpoch))"
        case .backingOff(let message):
            return "Retrying: \(message)"
        case .halted(let error):
            return "Halted: \(error.statusDescription)"
        }
    }
}

public struct CloudDeviceAdapterSnapshot: Equatable, Sendable {
    public let deviceID: UUID
    public let status: CloudDeviceAdapterStatus
    public let journalSummary: CloudDeviceJournalSummary
    public let lastEventDescription: String?

    public init(
        deviceID: UUID,
        status: CloudDeviceAdapterStatus,
        journalSummary: CloudDeviceJournalSummary,
        lastEventDescription: String?
    ) {
        self.deviceID = deviceID
        self.status = status
        self.journalSummary = journalSummary
        self.lastEventDescription = lastEventDescription
    }
}

/// Cloud Device Adapter bridging Agent F's Cloud AgentHead V2 execution contract with M2-C1's
/// Apple-native `NativeTextTool` (`device.text.process` / `stats`) and App-Sandbox journal.
///
/// Authority split:
/// - Cloud AgentHead owns canonical `taskId`, `operationId`, `runId`, `leaseEpoch`, and `deadlineAtMs`.
/// - Local journal owns durable execution progress, step checkpoints, and unacknowledged `/result`
///   replay across unknown ACKs, background transitions, and app relaunches.
public actor CloudDeviceExecutorAdapter {
    private enum LeaseGuardResult {
        case valid
        case fenced
        case expired
    }

    public let credential: CloudDeviceCredential

    private let configuration: CloudDeviceEndpointConfiguration
    private let transport: CloudDeviceAPITransporting
    private let journal: CloudDeviceExecutionJournal
    private let workspace: DeviceSandboxWorkspace
    private let textTool: any NativeTool
    private let clock: CloudDeviceClock
    private let backgroundTaskManager: any BackgroundTaskManaging
    private let statusHandler: (@Sendable (CloudDeviceAdapterSnapshot) -> Void)?

    private var status: CloudDeviceAdapterStatus = .stopped
    private var lastEventDescription: String?
    private var lastRegisteredClockMs: Int64?

    // Lifecycle & concurrency state
    private var isBackgroundSuspended = false
    private var resumeOnForeground = false
    private var desiredRunning = false
    private var loopGeneration: UInt64 = 0
    private var activeLoopTask: Task<Void, Never>?
    private var activeLoopGeneration: UInt64?
    private var activeWorkCancellers: [UUID: @Sendable () -> Void] = [:]
    private var activeBackgroundTaskID: Int?

    public init(
        configuration: CloudDeviceEndpointConfiguration,
        authProvider: AuthSessionProvider,
        credentialStore: CloudDeviceCredentialStoring = KeychainCloudDeviceCredentialStore(),
        transport: CloudDeviceAPITransporting? = nil,
        journal: CloudDeviceExecutionJournal? = nil,
        workspace: DeviceSandboxWorkspace? = nil,
        textTool: any NativeTool = NativeTextTool(),
        clock: CloudDeviceClock = SystemCloudDeviceClock(),
        backgroundTaskManager: any BackgroundTaskManaging = UIKitBackgroundTaskManager(),
        statusHandler: (@Sendable (CloudDeviceAdapterSnapshot) -> Void)? = nil
    ) throws {
        self.configuration = configuration
        self.credential = try credentialStore.loadOrCreateCredential(
            for: configuration.scopeIdentifier
        )
        self.transport = transport ?? CloudDeviceAPIClient(
            configuration: configuration,
            authProvider: authProvider
        )
        let journalDir = CloudDeviceExecutionJournal.defaultDirectory(
            scopeIdentifier: configuration.scopeIdentifier
        )
        self.journal = journal ?? CloudDeviceExecutionJournal(directory: journalDir)
        self.workspace = workspace ?? DeviceSandboxWorkspace(rootDirectory: journalDir)
        self.textTool = textTool
        self.clock = clock
        self.backgroundTaskManager = backgroundTaskManager
        self.statusHandler = statusHandler
    }

    public func currentSnapshot() async throws -> CloudDeviceAdapterSnapshot {
        CloudDeviceAdapterSnapshot(
            deviceID: credential.id,
            status: status,
            journalSummary: try await journal.summary(),
            lastEventDescription: lastEventDescription
        )
    }

    public func journalRecords() async throws -> [CloudDeviceJournalRecord] {
        try await journal.allRecords()
    }

    public func start() async {
        desiredRunning = true
        if isBackgroundSuspended {
            resumeOnForeground = true
            await emitStatus(.suspended, detail: "Deferred start until foreground")
            return
        }
        if activeLoopTask != nil && activeLoopGeneration == loopGeneration {
            return
        }

        // Wait for any previous stopping loop to fully exit before starting a new one.
        while let running = activeLoopTask {
            if activeLoopGeneration == loopGeneration && desiredRunning {
                return
            }
            await running.value
            guard desiredRunning, !isBackgroundSuspended else {
                return
            }
        }

        loopGeneration &+= 1
        let generation = loopGeneration
        activeLoopGeneration = generation
        activeLoopTask = Task { [weak self] in
            guard let self else { return }
            await self.runForegroundLoop(generation: generation)
        }
    }

    public func stop() async {
        desiredRunning = false
        resumeOnForeground = false
        loopGeneration &+= 1

        cancelAllActiveWork()
        while let running = activeLoopTask {
            running.cancel()
            await running.value
            if desiredRunning {
                return
            }
        }

        lastRegisteredClockMs = nil
        await releaseBackgroundTaskIfNeeded()
        await emitStatus(.stopped, detail: "Stopped cloud adapter loop")
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
        if desiredRunning || activeLoopTask != nil {
            resumeOnForeground = true
        }

        if activeWorkCancellers.isEmpty {
            // Not executing a task: stop the polling loop immediately so no new tasks are claimed.
            loopGeneration &+= 1
            while let running = activeLoopTask {
                running.cancel()
                await running.value
                if !isBackgroundSuspended {
                    return
                }
            }
            await releaseBackgroundTaskIfNeeded()
            await emitStatus(.suspended, detail: "Suspended in background; stopped claiming new tasks")
        } else {
            // In-flight task is executing: protect its grace window with a real expiration handler.
            await acquireBackgroundTaskIfNeeded(named: "ember.cloud-device-adapter.run")
        }
    }

    public func handleBackgroundTaskExpiration() async {
        if desiredRunning || activeLoopTask != nil {
            resumeOnForeground = true
        }
        loopGeneration &+= 1
        cancelAllActiveWork()
        activeLoopTask?.cancel()
        await releaseBackgroundTaskIfNeeded()
        await emitStatus(
            .suspended,
            detail: "Background execution time expired; preserved durable journal state"
        )
    }

    public func resumeFromForeground() async {
        isBackgroundSuspended = false
        lastRegisteredClockMs = nil
        await releaseBackgroundTaskIfNeeded()
        if resumeOnForeground {
            resumeOnForeground = false
            await start()
        }
    }

    /// Executes one deterministic cycle:
    /// 1. Ensure device readiness is registered with Cloud AgentHead.
    /// 2. Flush any staged `.pendingCommit` results from prior runs/restarts using the exact original fence.
    /// 3. Recover any incomplete `.claimed` / `.checkpointed` records by renewing their original Cloud lease.
    /// 4. Otherwise (if foreground active) poll `/claim`; if offered a task, execute `device.text.process` / `stats`
    ///    locally, checkpoint the M2-C1 tool output, stage `/result`, and commit back to Cloud.
    public func runSingleCycle() async throws -> CloudDeviceCycleOutcome {
        try Task.checkCancellation()
        try await ensureRegisteredIfNeeded()

        if let pending = try await journal.pendingSubmissions().first {
            let outcome = try await flushPendingRecord(pending)
            return .flushedPending(taskId: pending.taskId, outcome: outcome)
        }

        if let unfinished = try await journal.unfinishedClaims().first {
            return try await recoverUnfinishedRecord(unfinished)
        }

        if isBackgroundSuspended {
            return .idle
        }

        switch try await transport.claim(credential: credential) {
        case .idle:
            return .idle
        case .claimed(let offer):
            try Task.checkCancellation()
            _ = try await journal.recordClaim(offer, nowMs: clock.nowMs)
            return try await executeAndCommitOffer(offer)
        }
    }

    /// Flushes all staged unacknowledged submissions in FIFO order without claiming new work.
    public func flushPendingResults() async throws -> [(UUID, CloudDeviceCommitOutcome)] {
        var results: [(UUID, CloudDeviceCommitOutcome)] = []
        for record in try await journal.pendingSubmissions() {
            try Task.checkCancellation()
            let outcome = try await flushPendingRecord(record)
            results.append((record.taskId, outcome))
        }
        return results
    }

    // MARK: - Foreground Loop

    private func runForegroundLoop(generation: UInt64) async {
        await emitStatus(.registering, detail: "Starting Cloud Device Adapter", generation: generation)
        while !Task.isCancelled && !isBackgroundSuspended && activeLoopGeneration == generation {
            do {
                let outcome = try await runSingleCycle()
                if isBackgroundSuspended || Task.isCancelled || activeLoopGeneration != generation {
                    break
                }
                if outcome == .idle {
                    try await clock.sleep(for: configuration.idlePollInterval)
                }
            } catch is CancellationError {
                break
            } catch let error as CloudDeviceError {
                guard !Task.isCancelled, activeLoopGeneration == generation else { break }
                if !error.canRetry {
                    desiredRunning = false
                    resumeOnForeground = false
                    await emitStatus(.halted(error), detail: error.statusDescription, generation: generation)
                    break
                }
                lastRegisteredClockMs = nil
                await emitStatus(.backingOff(message: error.statusDescription), detail: error.statusDescription, generation: generation)
                try? await clock.sleep(for: configuration.idlePollInterval)
            } catch let error as URLError {
                guard !Task.isCancelled, activeLoopGeneration == generation else { break }
                lastRegisteredClockMs = nil
                let message = "Network error (\(error.code.rawValue))"
                await emitStatus(.backingOff(message: message), detail: message, generation: generation)
                try? await clock.sleep(for: configuration.idlePollInterval)
            } catch {
                guard !Task.isCancelled, activeLoopGeneration == generation else { break }
                desiredRunning = false
                resumeOnForeground = false
                await emitStatus(.halted(.unavailableStorage), detail: error.localizedDescription, generation: generation)
                break
            }
        }

        if activeLoopGeneration == generation {
            activeLoopTask = nil
            activeLoopGeneration = nil
            if isBackgroundSuspended {
                await releaseBackgroundTaskIfNeeded()
                await emitStatus(.suspended, detail: "Suspended in background; stopped claiming new tasks")
            }
        }
    }

    // MARK: - Execution & Recovery Phases

    private func ensureRegisteredIfNeeded() async throws {
        let nowMs = clock.nowMs
        let heartbeatMs = durationMilliseconds(configuration.heartbeatInterval)
        if let lastRegisteredClockMs, nowMs - lastRegisteredClockMs < heartbeatMs {
            return
        }
        await emitStatus(.registering, detail: "Registering capability \(configuration.capability) v\(configuration.version)")
        let receipt = try await transport.register(credential: credential)
        lastRegisteredClockMs = clock.nowMs
        await emitStatus(
            .ready(readyUntilMs: receipt.readyUntilMs),
            detail: "Ready device=\(credential.normalizedDeviceID) until=\(receipt.readyUntilMs)"
        )
    }

    private func executeAndCommitOffer(_ offer: CloudDeviceClaimOffer) async throws -> CloudDeviceCycleOutcome {
        let taskID = offer.taskId
        let fence = offer.fence
        await emitStatus(
            .executing(taskId: taskID, runId: offer.runId, leaseEpoch: offer.leaseEpoch),
            detail: "Claimed task=\(taskID.uuidString.lowercased()) run=\(offer.runId.uuidString.lowercased()) epoch=\(offer.leaseEpoch)"
        )

        return try await withTrackedBackgroundExecution(
            named: "ember-cloud-device-\(taskID.uuidString.lowercased())"
        ) {
            var currentLeaseExpiresAtMs = offer.leaseExpiresAtMs

            // 1. Verify Cloud lease & deadline before starting execution.
            switch try await self.ensureLeaseValidForExecution(
                taskID: taskID,
                fence: fence,
                leaseExpiresAtMs: &currentLeaseExpiresAtMs,
                deadlineAtMs: offer.deadlineAtMs
            ) {
            case .valid:
                break
            case .fenced, .expired:
                return .interruptedFenced(taskId: taskID)
            }

            guard self.isOfferValid(offer) else {
                let failureSubmission = CloudDeviceResultSubmission(failedWithFence: fence)
                let staged = try await self.stageValidatedSubmission(
                    taskID: taskID,
                    submission: failureSubmission,
                    isRecovery: false
                )
                if let earlyOutcome = staged {
                    return earlyOutcome
                }
                let outcome = try await self.commitSubmission(taskID: taskID, submission: failureSubmission)
                return .executed(taskId: taskID, outcome: outcome)
            }

            if self.configuration.simulatedWorkDelay > .zero {
                let maintained = try await self.maintainLeaseDuringDelay(
                    offer: offer,
                    leaseExpiresAtMs: &currentLeaseExpiresAtMs
                )
                if !maintained {
                    return .interruptedFenced(taskId: taskID)
                }
            }

            // 2. Re-check lease & deadline right before NativeTool execution.
            switch try await self.ensureLeaseValidForExecution(
                taskID: taskID,
                fence: fence,
                leaseExpiresAtMs: &currentLeaseExpiresAtMs,
                deadlineAtMs: offer.deadlineAtMs
            ) {
            case .valid:
                break
            case .fenced, .expired:
                return .interruptedFenced(taskId: taskID)
            }

            // 3. Execute M2-C1 Apple-native NativeTextTool inside per-task sandbox under Cloud IDs.
            let nativeOutput: NativeToolOutput
            do {
                nativeOutput = try await self.runNativeTextStats(
                    taskID: offer.taskId,
                    runID: offer.runId,
                    text: offer.input.text,
                    leaseExpiresAtMs: currentLeaseExpiresAtMs,
                    deadlineAtMs: offer.deadlineAtMs
                )
            } catch CloudDeviceError.deadlineExpired {
                _ = try await self.journal.recordFailedLocally(
                    taskID: taskID,
                    fence: fence,
                    reason: CloudDeviceError.deadlineExpired.statusDescription,
                    nowMs: self.clock.nowMs
                )
                return .interruptedFenced(taskId: taskID)
            } catch CloudDeviceError.fenced {
                _ = try await self.journal.recordFenced(
                    taskID: taskID,
                    fence: fence,
                    reason: "Cloud run lease expired during native tool execution.",
                    nowMs: self.clock.nowMs
                )
                return .interruptedFenced(taskId: taskID)
            }

            // 4. Verify cancellation, lease & deadline before persisting checkpoint.
            switch try await self.ensureLeaseValidForExecution(
                taskID: taskID,
                fence: fence,
                leaseExpiresAtMs: &currentLeaseExpiresAtMs,
                deadlineAtMs: offer.deadlineAtMs
            ) {
            case .valid:
                break
            case .fenced, .expired:
                return .interruptedFenced(taskId: taskID)
            }

            if let earlyOutcome = try await self.recordValidatedCheckpoint(
                taskID: taskID,
                fence: fence,
                nativeOutput: nativeOutput,
                isRecovery: false
            ) {
                return earlyOutcome
            }

            // 5. Derive wire result directly from NativeToolOutput (single source of truth).
            let wireStats = try CloudDeviceTextStats(nativeToolOutput: nativeOutput)
            let submission = CloudDeviceResultSubmission(fence: fence, output: wireStats)

            // 6. Verify lease & deadline before staging new submission.
            switch try await self.ensureLeaseValidForExecution(
                taskID: taskID,
                fence: fence,
                leaseExpiresAtMs: &currentLeaseExpiresAtMs,
                deadlineAtMs: offer.deadlineAtMs
            ) {
            case .valid:
                break
            case .fenced, .expired:
                return .interruptedFenced(taskId: taskID)
            }

            if let earlyOutcome = try await self.stageValidatedSubmission(
                taskID: taskID,
                submission: submission,
                isRecovery: false
            ) {
                return earlyOutcome
            }

            let outcome = try await self.commitSubmission(taskID: taskID, submission: submission)
            return .executed(taskId: taskID, outcome: outcome)
        }
    }

    private func recoverUnfinishedRecord(
        _ record: CloudDeviceJournalRecord
    ) async throws -> CloudDeviceCycleOutcome {
        let fence = record.fence
        return try await withTrackedBackgroundExecution(
            named: "ember-cloud-device-recover-\(record.taskId.uuidString.lowercased())"
        ) {
            if self.clock.nowMs >= record.deadlineAtMs {
                _ = try await self.journal.recordFailedLocally(
                    taskID: record.taskId,
                    fence: fence,
                    reason: "Cloud task deadline already elapsed before local recovery.",
                    nowMs: self.clock.nowMs
                )
                return .recoveredFenced(taskId: record.taskId)
            }

            // Validate whether Cloud AgentHead still owns this exact `(taskId, runId, leaseEpoch)` lease.
            let renewOutcome = try await self.transport.renew(
                credential: self.credential,
                taskID: record.taskId,
                fence: fence,
                previousLeaseExpiresAtMs: record.leaseExpiresAtMs,
                deadlineAtMs: record.deadlineAtMs
            )

            var currentLeaseExpiresAtMs: Int64
            switch renewOutcome {
            case .fenced:
                _ = try await self.journal.recordFenced(
                    taskID: record.taskId,
                    fence: fence,
                    reason: "Unfinished local claim fenced by Cloud AgentHead on recovery renew.",
                    nowMs: self.clock.nowMs
                )
                return .recoveredFenced(taskId: record.taskId)
            case .renewed(let leaseExpiresAtMs):
                currentLeaseExpiresAtMs = leaseExpiresAtMs
                _ = try await self.journal.recordRenewed(
                    taskID: record.taskId,
                    fence: fence,
                    newLeaseExpiresAtMs: leaseExpiresAtMs,
                    nowMs: self.clock.nowMs
                )
            }

            // If native execution had not yet checkpointed, run NativeTextTool now; otherwise reuse checkpoint.
            let nativeOutput: NativeToolOutput
            if record.phase == .claimed {
                guard self.isInputValid(
                    capability: record.capability,
                    version: record.version,
                    input: record.input
                ) else {
                    let failureSubmission = CloudDeviceResultSubmission(failedWithFence: fence)
                    if let earlyOutcome = try await self.stageValidatedSubmission(
                        taskID: record.taskId,
                        submission: failureSubmission,
                        isRecovery: true
                    ) {
                        return earlyOutcome
                    }
                    let outcome = try await self.commitSubmission(taskID: record.taskId, submission: failureSubmission)
                    return .recoveredUnfinished(taskId: record.taskId, outcome: outcome)
                }

                switch try await self.ensureLeaseValidForExecution(
                    taskID: record.taskId,
                    fence: fence,
                    leaseExpiresAtMs: &currentLeaseExpiresAtMs,
                    deadlineAtMs: record.deadlineAtMs
                ) {
                case .valid:
                    break
                case .fenced, .expired:
                    return .recoveredFenced(taskId: record.taskId)
                }

                do {
                    nativeOutput = try await self.runNativeTextStats(
                        taskID: record.taskId,
                        runID: record.runId,
                        text: record.input.text,
                        leaseExpiresAtMs: currentLeaseExpiresAtMs,
                        deadlineAtMs: record.deadlineAtMs
                    )
                } catch CloudDeviceError.deadlineExpired {
                    _ = try await self.journal.recordFailedLocally(
                        taskID: record.taskId,
                        fence: fence,
                        reason: CloudDeviceError.deadlineExpired.statusDescription,
                        nowMs: self.clock.nowMs
                    )
                    return .recoveredFenced(taskId: record.taskId)
                } catch CloudDeviceError.fenced {
                    _ = try await self.journal.recordFenced(
                        taskID: record.taskId,
                        fence: fence,
                        reason: "Cloud run lease expired during recovery native tool execution.",
                        nowMs: self.clock.nowMs
                    )
                    return .recoveredFenced(taskId: record.taskId)
                }

                switch try await self.ensureLeaseValidForExecution(
                    taskID: record.taskId,
                    fence: fence,
                    leaseExpiresAtMs: &currentLeaseExpiresAtMs,
                    deadlineAtMs: record.deadlineAtMs
                ) {
                case .valid:
                    break
                case .fenced, .expired:
                    return .recoveredFenced(taskId: record.taskId)
                }

                if let earlyOutcome = try await self.recordValidatedCheckpoint(
                    taskID: record.taskId,
                    fence: fence,
                    nativeOutput: nativeOutput,
                    isRecovery: true
                ) {
                    return earlyOutcome
                }
            } else if let existingOutput = record.nativeStepOutput {
                nativeOutput = existingOutput
            } else {
                throw CloudDeviceError.unavailableStorage
            }

            // Derive wire stats directly from the NativeToolOutput checkpoint.
            let wireStats = try CloudDeviceTextStats(nativeToolOutput: nativeOutput)
            let submission = CloudDeviceResultSubmission(fence: fence, output: wireStats)

            switch try await self.ensureLeaseValidForExecution(
                taskID: record.taskId,
                fence: fence,
                leaseExpiresAtMs: &currentLeaseExpiresAtMs,
                deadlineAtMs: record.deadlineAtMs
            ) {
            case .valid:
                break
            case .fenced, .expired:
                return .recoveredFenced(taskId: record.taskId)
            }

            if let earlyOutcome = try await self.stageValidatedSubmission(
                taskID: record.taskId,
                submission: submission,
                isRecovery: true
            ) {
                return earlyOutcome
            }

            let outcome = try await self.commitSubmission(taskID: record.taskId, submission: submission)
            return .recoveredUnfinished(taskId: record.taskId, outcome: outcome)
        }
    }

    private func flushPendingRecord(
        _ record: CloudDeviceJournalRecord
    ) async throws -> CloudDeviceCommitOutcome {
        guard let submission = record.pendingSubmission else {
            return .fenced
        }
        // Already-staged pendingSubmission replays with original fence regardless of local lease expiry;
        // Cloud AgentHead decides committed(replayed: true) vs fenced.
        return try await commitSubmission(taskID: record.taskId, submission: submission)
    }

    private func commitSubmission(
        taskID: UUID,
        submission: CloudDeviceResultSubmission
    ) async throws -> CloudDeviceCommitOutcome {
        let fence = CloudDeviceFence(
            operationId: submission.operationId,
            runId: submission.runId,
            leaseEpoch: submission.leaseEpoch
        )
        let outcome = try await transport.submitResult(
            credential: credential,
            taskID: taskID,
            submission: submission
        )
        switch outcome {
        case .committed(let replayed):
            _ = try await journal.recordCommitted(
                taskID: taskID,
                fence: fence,
                replayed: replayed,
                nowMs: clock.nowMs
            )
            lastRegisteredClockMs = lastRegisteredClockMs ?? clock.nowMs
            await emitStatus(
                status,
                detail: "Committed task=\(taskID.uuidString.lowercased()) epoch=\(fence.leaseEpoch) replayed=\(replayed)"
            )
        case .fenced:
            _ = try await journal.recordFenced(
                taskID: taskID,
                fence: fence,
                reason: "Cloud AgentHead returned fenced on result submission.",
                nowMs: clock.nowMs
            )
            await emitStatus(
                status,
                detail: "Result fenced task=\(taskID.uuidString.lowercased()) epoch=\(fence.leaseEpoch)"
            )
        }
        return outcome
    }

    // MARK: - Lease & Journal Guards

    private func ensureLeaseValidForExecution(
        taskID: UUID,
        fence: CloudDeviceFence,
        leaseExpiresAtMs: inout Int64,
        deadlineAtMs: Int64
    ) async throws -> LeaseGuardResult {
        try Task.checkCancellation()
        let nowMs = clock.nowMs
        if nowMs >= deadlineAtMs {
            _ = try await journal.recordFailedLocally(
                taskID: taskID,
                fence: fence,
                reason: CloudDeviceError.deadlineExpired.statusDescription,
                nowMs: nowMs
            )
            return .expired
        }
        if nowMs >= leaseExpiresAtMs {
            _ = try await journal.recordFenced(
                taskID: taskID,
                fence: fence,
                reason: "Cloud run lease expired locally before completion.",
                nowMs: nowMs
            )
            return .fenced
        }

        let renewThresholdMs = max(100, durationMilliseconds(configuration.heartbeatInterval))
        if leaseExpiresAtMs - nowMs <= renewThresholdMs {
            let receipt = try await transport.register(credential: credential)
            lastRegisteredClockMs = clock.nowMs
            await emitStatus(.ready(readyUntilMs: receipt.readyUntilMs), detail: nil)

            let renewOutcome = try await transport.renew(
                credential: credential,
                taskID: taskID,
                fence: fence,
                previousLeaseExpiresAtMs: leaseExpiresAtMs,
                deadlineAtMs: deadlineAtMs
            )
            switch renewOutcome {
            case .renewed(let updatedExpiry):
                leaseExpiresAtMs = updatedExpiry
                _ = try await journal.recordRenewed(
                    taskID: taskID,
                    fence: fence,
                    newLeaseExpiresAtMs: updatedExpiry,
                    nowMs: clock.nowMs
                )
                let postRenewNow = clock.nowMs
                if postRenewNow >= deadlineAtMs {
                    _ = try await journal.recordFailedLocally(
                        taskID: taskID,
                        fence: fence,
                        reason: CloudDeviceError.deadlineExpired.statusDescription,
                        nowMs: postRenewNow
                    )
                    return .expired
                }
                if postRenewNow >= leaseExpiresAtMs {
                    _ = try await journal.recordFenced(
                        taskID: taskID,
                        fence: fence,
                        reason: "Cloud run lease elapsed immediately after renewal.",
                        nowMs: postRenewNow
                    )
                    return .fenced
                }
            case .fenced:
                _ = try await journal.recordFenced(
                    taskID: taskID,
                    fence: fence,
                    reason: "Cloud AgentHead fenced run during lease renewal.",
                    nowMs: clock.nowMs
                )
                return .fenced
            }
        }
        return .valid
    }

    private func recordValidatedCheckpoint(
        taskID: UUID,
        fence: CloudDeviceFence,
        nativeOutput: NativeToolOutput,
        isRecovery: Bool
    ) async throws -> CloudDeviceCycleOutcome? {
        guard let checkpointed = try await journal.recordCheckpoint(
            taskID: taskID,
            fence: fence,
            nativeOutput: nativeOutput,
            nowMs: clock.nowMs
        ) else {
            if let existing = try await journal.record(for: taskID),
               existing.fence == fence {
                if existing.phase == .fenced {
                    return isRecovery ? .recoveredFenced(taskId: taskID) : .interruptedFenced(taskId: taskID)
                }
                if case .committed(let replayed) = existing.phase {
                    return isRecovery
                        ? .recoveredUnfinished(taskId: taskID, outcome: .committed(replayed: replayed))
                        : .executed(taskId: taskID, outcome: .committed(replayed: replayed))
                }
            }
            throw CloudDeviceError.unavailableStorage
        }
        if checkpointed.phase == .fenced {
            return isRecovery ? .recoveredFenced(taskId: taskID) : .interruptedFenced(taskId: taskID)
        }
        if case .committed(let replayed) = checkpointed.phase {
            return isRecovery
                ? .recoveredUnfinished(taskId: taskID, outcome: .committed(replayed: replayed))
                : .executed(taskId: taskID, outcome: .committed(replayed: replayed))
        }
        guard checkpointed.fence == fence,
              checkpointed.phase == .checkpointed,
              checkpointed.nativeStepOutput != nil
        else {
            throw CloudDeviceError.unavailableStorage
        }
        return nil
    }

    private func stageValidatedSubmission(
        taskID: UUID,
        submission: CloudDeviceResultSubmission,
        isRecovery: Bool
    ) async throws -> CloudDeviceCycleOutcome? {
        guard let staged = try await journal.stageResultSubmission(
            taskID: taskID,
            submission: submission,
            nowMs: clock.nowMs
        ) else {
            throw CloudDeviceError.unavailableStorage
        }
        if staged.phase == .fenced {
            return isRecovery ? .recoveredFenced(taskId: taskID) : .interruptedFenced(taskId: taskID)
        }
        if case .committed(let replayed) = staged.phase {
            return isRecovery
                ? .recoveredUnfinished(taskId: taskID, outcome: .committed(replayed: replayed))
                : .executed(taskId: taskID, outcome: .committed(replayed: replayed))
        }
        guard staged.phase == .pendingCommit,
              staged.pendingSubmission == submission
        else {
            throw CloudDeviceError.unavailableStorage
        }
        return nil
    }

    private func maintainLeaseDuringDelay(
        offer: CloudDeviceClaimOffer,
        leaseExpiresAtMs: inout Int64
    ) async throws -> Bool {
        let totalDelayMs = durationMilliseconds(configuration.simulatedWorkDelay)
        let renewStepMs = max(100, durationMilliseconds(configuration.heartbeatInterval))
        var remainingMs = totalDelayMs

        while remainingMs > 0 {
            try Task.checkCancellation()
            if clock.nowMs >= offer.deadlineAtMs {
                _ = try await journal.recordFailedLocally(
                    taskID: offer.taskId,
                    fence: offer.fence,
                    reason: CloudDeviceError.deadlineExpired.statusDescription,
                    nowMs: clock.nowMs
                )
                return false
            }
            if clock.nowMs >= leaseExpiresAtMs {
                _ = try await journal.recordFenced(
                    taskID: offer.taskId,
                    fence: offer.fence,
                    reason: "Cloud run lease expired during work delay.",
                    nowMs: clock.nowMs
                )
                return false
            }
            let chunkMs = min(remainingMs, renewStepMs)
            try await clock.sleep(for: .milliseconds(chunkMs))
            remainingMs -= chunkMs

            if remainingMs > 0 {
                let receipt = try await transport.register(credential: credential)
                lastRegisteredClockMs = clock.nowMs
                await emitStatus(.ready(readyUntilMs: receipt.readyUntilMs), detail: nil)

                let renewOutcome = try await transport.renew(
                    credential: credential,
                    taskID: offer.taskId,
                    fence: offer.fence,
                    previousLeaseExpiresAtMs: leaseExpiresAtMs,
                    deadlineAtMs: offer.deadlineAtMs
                )
                switch renewOutcome {
                case .renewed(let updatedExpiry):
                    leaseExpiresAtMs = updatedExpiry
                    _ = try await journal.recordRenewed(
                        taskID: offer.taskId,
                        fence: offer.fence,
                        newLeaseExpiresAtMs: updatedExpiry,
                        nowMs: clock.nowMs
                    )
                case .fenced:
                    _ = try await journal.recordFenced(
                        taskID: offer.taskId,
                        fence: offer.fence,
                        reason: "Cloud AgentHead fenced run during lease renewal.",
                        nowMs: clock.nowMs
                    )
                    return false
                }
            }
        }
        return true
    }

    private func runNativeTextStats(
        taskID: UUID,
        runID: UUID,
        text: String,
        leaseExpiresAtMs: Int64,
        deadlineAtMs: Int64
    ) async throws -> NativeToolOutput {
        let context = NativeToolExecutionContext(
            taskID: taskID,
            runID: runID,
            stepIndex: 0,
            stepID: "cloud-text-stats",
            workspace: workspace,
            policy: .default,
            cancellationProbe: { [clock] in
                try Task.checkCancellation()
                let nowMs = clock.nowMs
                if nowMs >= deadlineAtMs {
                    throw CloudDeviceError.deadlineExpired
                }
                if nowMs >= leaseExpiresAtMs {
                    throw CloudDeviceError.fenced
                }
            }
        )
        return try await textTool.execute(
            context: context,
            arguments: [
                "op": .string(CloudDeviceContract.statsOperation),
                "text": .string(text),
            ]
        )
    }

    // MARK: - Background Task Management

    private func withTrackedBackgroundExecution<T: Sendable>(
        named name: String,
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        let handleID = UUID()
        let workTask = Task<T, Error> {
            try await operation()
        }
        activeWorkCancellers[handleID] = {
            workTask.cancel()
        }
        await acquireBackgroundTaskIfNeeded(named: name)

        do {
            let result = try await withTaskCancellationHandler {
                try await workTask.value
            } onCancel: {
                workTask.cancel()
            }
            activeWorkCancellers.removeValue(forKey: handleID)
            if activeWorkCancellers.isEmpty {
                await releaseBackgroundTaskIfNeeded()
            }
            return result
        } catch {
            activeWorkCancellers.removeValue(forKey: handleID)
            if activeWorkCancellers.isEmpty {
                await releaseBackgroundTaskIfNeeded()
            }
            throw error
        }
    }

    private func cancelAllActiveWork() {
        let cancellers = Array(activeWorkCancellers.values)
        for cancel in cancellers {
            cancel()
        }
    }

    private func acquireBackgroundTaskIfNeeded(named name: String) async {
        guard activeBackgroundTaskID == nil else { return }
        let bgID = await backgroundTaskManager.beginBackgroundTask(name: name) { [weak self] in
            Task {
                await self?.handleBackgroundTaskExpiration()
            }
        }
        if activeWorkCancellers.isEmpty && !isBackgroundSuspended {
            await backgroundTaskManager.endBackgroundTask(bgID)
        } else if activeBackgroundTaskID == nil {
            activeBackgroundTaskID = bgID
        } else {
            await backgroundTaskManager.endBackgroundTask(bgID)
        }
    }

    private func releaseBackgroundTaskIfNeeded() async {
        guard let bgID = activeBackgroundTaskID else { return }
        activeBackgroundTaskID = nil
        await backgroundTaskManager.endBackgroundTask(bgID)
    }

    // MARK: - Validation & Helpers

    private nonisolated func isOfferValid(_ offer: CloudDeviceClaimOffer) -> Bool {
        offer.leaseEpoch > 0
            && offer.leaseExpiresAtMs <= offer.deadlineAtMs
            && isInputValid(capability: offer.capability, version: offer.version, input: offer.input)
    }

    private nonisolated func isInputValid(capability: String, version: Int, input: CloudDeviceTextInput) -> Bool {
        capability == configuration.capability
            && version == configuration.version
            && input.operation == CloudDeviceContract.statsOperation
            && input.text.utf16.count <= CloudDeviceContract.maxTextUTF16Units
    }

    private func emitStatus(
        _ newStatus: CloudDeviceAdapterStatus,
        detail: String?,
        generation: UInt64? = nil
    ) async {
        if let generation, activeLoopGeneration != generation {
            return
        }
        status = newStatus
        if let detail {
            lastEventDescription = detail
        }
        if let handler = statusHandler {
            let summary = (try? await journal.summary()) ?? CloudDeviceJournalSummary(records: [])
            handler(
                CloudDeviceAdapterSnapshot(
                    deviceID: credential.id,
                    status: newStatus,
                    journalSummary: summary,
                    lastEventDescription: lastEventDescription
                )
            )
        }
    }

    private func durationMilliseconds(_ duration: Duration) -> Int64 {
        let (seconds, attoseconds) = duration.components
        return (seconds * 1_000) + (attoseconds / 1_000_000_000_000_000)
    }
}
