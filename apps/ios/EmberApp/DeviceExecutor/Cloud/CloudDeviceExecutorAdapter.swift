import Foundation
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
    case registering
    case ready(readyUntilMs: Int64)
    case executing(taskId: UUID, runId: UUID, leaseEpoch: Int)
    case backingOff(message: String)
    case halted(CloudDeviceError)

    public var label: String {
        switch self {
        case .stopped:
            return "Stopped"
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
    public let credential: CloudDeviceCredential

    private let configuration: CloudDeviceEndpointConfiguration
    private let transport: CloudDeviceAPITransporting
    private let journal: CloudDeviceExecutionJournal
    private let workspace: DeviceSandboxWorkspace
    private let textTool: NativeTextTool
    private let clock: CloudDeviceClock
    private let statusHandler: (@Sendable (CloudDeviceAdapterSnapshot) -> Void)?

    private var status: CloudDeviceAdapterStatus = .stopped
    private var lastEventDescription: String?
    private var lastRegisteredClockMs: Int64?
    private var loopTask: Task<Void, Never>?

    public init(
        configuration: CloudDeviceEndpointConfiguration,
        authProvider: AuthSessionProvider,
        credentialStore: CloudDeviceCredentialStoring = KeychainCloudDeviceCredentialStore(),
        transport: CloudDeviceAPITransporting? = nil,
        journal: CloudDeviceExecutionJournal? = nil,
        workspace: DeviceSandboxWorkspace? = nil,
        textTool: NativeTextTool = NativeTextTool(),
        clock: CloudDeviceClock = SystemCloudDeviceClock(),
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
        guard loopTask == nil else { return }
        loopTask = Task { [weak self] in
            guard let self else { return }
            await self.runForegroundLoop()
        }
    }

    public func stop() async {
        loopTask?.cancel()
        loopTask = nil
        lastRegisteredClockMs = nil
        await emitStatus(.stopped, detail: "Stopped cloud adapter loop")
    }

    /// Executes one deterministic cycle:
    /// 1. Ensure device readiness is registered with Cloud AgentHead.
    /// 2. Flush any staged `.pendingCommit` results from prior runs/restarts using the exact original fence.
    /// 3. Recover any incomplete `.claimed` / `.checkpointed` records by renewing their original Cloud lease.
    /// 4. Otherwise poll `/claim`; if offered a task, execute `device.text.process` / `stats` locally,
    ///    checkpoint the M2-C1 tool output, stage `/result`, and commit back to Cloud.
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

    private func runForegroundLoop() async {
        await emitStatus(.registering, detail: "Starting Cloud Device Adapter")
        while !Task.isCancelled {
            do {
                let outcome = try await runSingleCycle()
                if outcome == .idle {
                    try await clock.sleep(for: configuration.idlePollInterval)
                }
            } catch is CancellationError {
                return
            } catch let error as CloudDeviceError {
                guard !Task.isCancelled else { return }
                if !error.canRetry {
                    await emitStatus(.halted(error), detail: error.statusDescription)
                    return
                }
                lastRegisteredClockMs = nil
                await emitStatus(.backingOff(message: error.statusDescription), detail: error.statusDescription)
                try? await clock.sleep(for: configuration.idlePollInterval)
            } catch let error as URLError {
                guard !Task.isCancelled else { return }
                lastRegisteredClockMs = nil
                let message = "Network error (\(error.code.rawValue))"
                await emitStatus(.backingOff(message: message), detail: message)
                try? await clock.sleep(for: configuration.idlePollInterval)
            } catch {
                guard !Task.isCancelled else { return }
                await emitStatus(.halted(.unavailableStorage), detail: error.localizedDescription)
                return
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

        let bgToken = await beginUIKitBackgroundTask(named: "ember-cloud-device-\(taskID.uuidString.lowercased())")
        defer {
            Task { @MainActor in
                UIApplicationEndIfValid(bgToken)
            }
        }

        guard isOfferValid(offer) else {
            let failureSubmission = CloudDeviceResultSubmission(failedWithFence: fence)
            _ = try await journal.stageResultSubmission(taskID: taskID, submission: failureSubmission, nowMs: clock.nowMs)
            let outcome = try await commitSubmission(taskID: taskID, submission: failureSubmission)
            return .executed(taskId: taskID, outcome: outcome)
        }

        var currentLeaseExpiresAtMs = offer.leaseExpiresAtMs
        if configuration.simulatedWorkDelay > .zero {
            let maintained = try await maintainLeaseDuringDelay(
                offer: offer,
                leaseExpiresAtMs: &currentLeaseExpiresAtMs
            )
            if !maintained {
                return .interruptedFenced(taskId: taskID)
            }
        }

        if clock.nowMs >= offer.deadlineAtMs {
            _ = try await journal.recordFailedLocally(
                taskID: taskID,
                fence: fence,
                reason: CloudDeviceError.deadlineExpired.statusDescription,
                nowMs: clock.nowMs
            )
            return .interruptedFenced(taskId: taskID)
        }

        // Execute M2-C1 Apple-native NativeTextTool inside per-task sandbox under Cloud IDs.
        let nativeOutput = try await runNativeTextStats(
            taskID: offer.taskId,
            runID: offer.runId,
            text: offer.input.text,
            deadlineAtMs: offer.deadlineAtMs
        )
        _ = try await journal.recordCheckpoint(
            taskID: taskID,
            fence: fence,
            nativeOutput: nativeOutput,
            nowMs: clock.nowMs
        )

        try Task.checkCancellation()
        if clock.nowMs >= offer.deadlineAtMs {
            _ = try await journal.recordFailedLocally(
                taskID: taskID,
                fence: fence,
                reason: CloudDeviceError.deadlineExpired.statusDescription,
                nowMs: clock.nowMs
            )
            return .interruptedFenced(taskId: taskID)
        }

        let wireStats = CloudDeviceTextStats(text: offer.input.text)
        let submission = CloudDeviceResultSubmission(fence: fence, output: wireStats)
        _ = try await journal.stageResultSubmission(taskID: taskID, submission: submission, nowMs: clock.nowMs)

        let outcome = try await commitSubmission(taskID: taskID, submission: submission)
        return .executed(taskId: taskID, outcome: outcome)
    }

    private func recoverUnfinishedRecord(
        _ record: CloudDeviceJournalRecord
    ) async throws -> CloudDeviceCycleOutcome {
        let fence = record.fence
        if clock.nowMs >= record.deadlineAtMs {
            _ = try await journal.recordFailedLocally(
                taskID: record.taskId,
                fence: fence,
                reason: "Cloud task deadline already elapsed before local recovery.",
                nowMs: clock.nowMs
            )
            return .recoveredFenced(taskId: record.taskId)
        }

        // Validate whether Cloud AgentHead still owns this exact `(taskId, runId, leaseEpoch)` lease.
        let renewOutcome = try await transport.renew(
            credential: credential,
            taskID: record.taskId,
            fence: fence,
            previousLeaseExpiresAtMs: record.leaseExpiresAtMs,
            deadlineAtMs: record.deadlineAtMs
        )

        switch renewOutcome {
        case .fenced:
            _ = try await journal.recordFenced(
                taskID: record.taskId,
                fence: fence,
                reason: "Unfinished local claim fenced by Cloud AgentHead on recovery renew.",
                nowMs: clock.nowMs
            )
            return .recoveredFenced(taskId: record.taskId)
        case .renewed(let leaseExpiresAtMs):
            _ = try await journal.recordRenewed(
                taskID: record.taskId,
                fence: fence,
                newLeaseExpiresAtMs: leaseExpiresAtMs,
                nowMs: clock.nowMs
            )
        }

        // If native execution had not yet checkpointed, run NativeTextTool now; otherwise reuse checkpoint.
        if record.phase == .claimed {
            guard isInputValid(capability: record.capability, version: record.version, input: record.input) else {
                let failureSubmission = CloudDeviceResultSubmission(failedWithFence: fence)
                _ = try await journal.stageResultSubmission(taskID: record.taskId, submission: failureSubmission, nowMs: clock.nowMs)
                let outcome = try await commitSubmission(taskID: record.taskId, submission: failureSubmission)
                return .recoveredUnfinished(taskId: record.taskId, outcome: outcome)
            }
            let nativeOutput = try await runNativeTextStats(
                taskID: record.taskId,
                runID: record.runId,
                text: record.input.text,
                deadlineAtMs: record.deadlineAtMs
            )
            _ = try await journal.recordCheckpoint(
                taskID: record.taskId,
                fence: fence,
                nativeOutput: nativeOutput,
                nowMs: clock.nowMs
            )
        }

        let wireStats = CloudDeviceTextStats(text: record.input.text)
        let submission = CloudDeviceResultSubmission(fence: fence, output: wireStats)
        _ = try await journal.stageResultSubmission(taskID: record.taskId, submission: submission, nowMs: clock.nowMs)

        let outcome = try await commitSubmission(taskID: record.taskId, submission: submission)
        return .recoveredUnfinished(taskId: record.taskId, outcome: outcome)
    }

    private func flushPendingRecord(
        _ record: CloudDeviceJournalRecord
    ) async throws -> CloudDeviceCommitOutcome {
        guard let submission = record.pendingSubmission else {
            return .fenced
        }
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
            let chunkMs = min(remainingMs, renewStepMs)
            try await clock.sleep(for: .milliseconds(chunkMs))
            remainingMs -= chunkMs

            if remainingMs > 0 {
                // Keep device readiness fresh and renew Cloud run lease while active.
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
                if clock.nowMs >= deadlineAtMs {
                    throw CloudDeviceError.deadlineExpired
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

    private func isOfferValid(_ offer: CloudDeviceClaimOffer) -> Bool {
        offer.leaseEpoch > 0
            && offer.leaseExpiresAtMs <= offer.deadlineAtMs
            && isInputValid(capability: offer.capability, version: offer.version, input: offer.input)
    }

    private func isInputValid(capability: String, version: Int, input: CloudDeviceTextInput) -> Bool {
        capability == configuration.capability
            && version == configuration.version
            && input.operation == CloudDeviceContract.statsOperation
            && input.text.utf16.count <= CloudDeviceContract.maxTextUTF16Units
    }

    private func emitStatus(_ newStatus: CloudDeviceAdapterStatus, detail: String?) async {
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

    @MainActor
    private func beginUIKitBackgroundTask(named name: String) -> UIBackgroundTaskIdentifier {
        UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: nil)
    }
}

@MainActor
private func UIApplicationEndIfValid(_ identifier: UIBackgroundTaskIdentifier) {
    if identifier != .invalid {
        UIApplication.shared.endBackgroundTask(identifier)
    }
}
