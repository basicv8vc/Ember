import Foundation

/// Durable persisted representation of an on-device task, run lease, step checkpoints,
/// timeline events, result, artifacts, and metrics.
public struct PersistedDeviceTaskRecord: Codable, Equatable, Sendable {
    public var task: SessionTaskDTO
    public var submission: DeviceTaskSubmission
    public var requestDigest: String
    public var leaseEpoch: Int
    public var ownerBootSessionID: UUID?
    public var completedStepOutputs: [Int: NativeToolOutput]
    public var events: [SessionTaskEventDTO]
    public var result: SessionTaskResultDTO?
    public var structuredOutput: DeviceJSONValue?
    public var artifacts: [DeviceGeneratedArtifact]
    public var metrics: DeviceExecutionMetrics?
    public var lastErrorCode: TaskErrorCode?
    public var lastErrorMessage: String?

    public init(
        task: SessionTaskDTO,
        submission: DeviceTaskSubmission,
        requestDigest: String,
        leaseEpoch: Int = 0,
        ownerBootSessionID: UUID? = nil,
        completedStepOutputs: [Int: NativeToolOutput] = [:],
        events: [SessionTaskEventDTO] = [],
        result: SessionTaskResultDTO? = nil,
        structuredOutput: DeviceJSONValue? = nil,
        artifacts: [DeviceGeneratedArtifact] = [],
        metrics: DeviceExecutionMetrics? = nil,
        lastErrorCode: TaskErrorCode? = nil,
        lastErrorMessage: String? = nil
    ) {
        self.task = task
        self.submission = submission
        self.requestDigest = requestDigest
        self.leaseEpoch = leaseEpoch
        self.ownerBootSessionID = ownerBootSessionID
        self.completedStepOutputs = completedStepOutputs
        self.events = events
        self.result = result
        self.structuredOutput = structuredOutput
        self.artifacts = artifacts
        self.metrics = metrics
        self.lastErrorCode = lastErrorCode
        self.lastErrorMessage = lastErrorMessage
    }
}

/// Atomic, encrypted-at-rest local journal for on-device task execution & cold-start recovery.
public actor DeviceExecutionJournal {
    private struct IdempotencyEntry: Codable, Equatable {
        let taskID: UUID
        let requestDigest: String
    }

    private struct PersistedState: Codable {
        var schemaVersion: Int = 1
        var tasksByID: [String: PersistedDeviceTaskRecord] = [:]
        var idempotencyIndex: [String: IdempotencyEntry] = [:]
    }

    private let stateFileURL: URL
    private var cachedState: PersistedState?

    public init(directory: URL? = nil) {
        let base = directory ?? FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0].appendingPathComponent("EmberDeviceExecutor", isDirectory: true)
        self.stateFileURL = base.appendingPathComponent("executor-state.json")
    }

    public func allRecords() throws -> [PersistedDeviceTaskRecord] {
        let state = try readState()
        return state.tasksByID.values.sorted { lhs, rhs in
            if lhs.task.updatedDate != rhs.task.updatedDate {
                return lhs.task.updatedDate > rhs.task.updatedDate
            }
            return lhs.task.taskID.uuidString < rhs.task.taskID.uuidString
        }
    }

    public func record(for taskID: UUID) throws -> PersistedDeviceTaskRecord? {
        let state = try readState()
        return state.tasksByID[key(for: taskID)]
    }

    public func existingSubmission(idempotencyKey: String) throws -> (taskID: UUID, requestDigest: String)? {
        let state = try readState()
        guard let entry = state.idempotencyIndex[idempotencyKey] else { return nil }
        return (entry.taskID, entry.requestDigest)
    }

    public func insertQueuedTask(_ record: PersistedDeviceTaskRecord) throws {
        var state = try readState()
        state.tasksByID[key(for: record.task.taskID)] = record
        state.idempotencyIndex[record.submission.idempotencyKey] = IdempotencyEntry(
            taskID: record.task.taskID,
            requestDigest: record.requestDigest
        )
        try persistState(state)
    }

    public func saveRecord(_ record: PersistedDeviceTaskRecord) throws {
        var state = try readState()
        state.tasksByID[key(for: record.task.taskID)] = record
        try persistState(state)
    }

    /// Reconciles durable task state across process restarts, crashes, or background suspension.
    public func recoverOnLaunch(
        currentBootSessionID: UUID,
        now: Date = Date()
    ) throws -> (report: DeviceRecoveryReport, runnableTaskIDs: [UUID]) {
        var state = try readState()
        var didMutate = false
        var recoveredQueued = 0
        var recoveredInterrupted = 0
        var convergedCancelled = 0
        var expired = 0
        var restoredTerminal = 0
        var runnableTaskIDs: [UUID] = []

        let nowISO = DeviceWireDate.format(now)

        for (taskKey, var record) in state.tasksByID {
            if record.task.status.isTerminal {
                restoredTerminal += 1
                continue
            }

            if record.task.cancelRequested {
                let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
                let previousStatus = record.task.status
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
                        taskID: record.task.taskID,
                        sequence: nextSeq,
                        phase: .cancelled,
                        occurredAt: nowISO,
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
                record.lastErrorMessage = "Cancelled during recovery."
                state.tasksByID[taskKey] = record
                convergedCancelled += 1
                didMutate = true
                continue
            }

            if let deadlineString = record.task.deadlineAt,
               let deadline = DeviceWireDate.parse(deadlineString),
               deadline <= now {
                let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
                let previousStatus = record.task.status
                record.task = updatingTask(
                    record.task,
                    status: .failed,
                    updatedAt: nowISO,
                    resultState: .unavailable
                )
                record.ownerBootSessionID = nil
                record.events.append(
                    SessionTaskEventDTO(
                        taskID: record.task.taskID,
                        sequence: nextSeq,
                        phase: .failed,
                        occurredAt: nowISO,
                        traceID: record.task.currentRunID ?? record.task.taskID,
                        payload: SessionTaskEventPayloadDTO(
                            taskKind: record.task.kind,
                            runID: record.task.currentRunID,
                            attempt: max(1, record.task.attemptCount),
                            route: .fast,
                            fromStatus: previousStatus,
                            toStatus: .failed,
                            runStatus: .failedTerminal,
                            errorCode: .deadlineExceeded,
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
                record.lastErrorCode = .deadlineExceeded
                record.lastErrorMessage = "Task deadline expired before recovery."
                state.tasksByID[taskKey] = record
                expired += 1
                didMutate = true
                continue
            }

            switch record.task.status {
            case .running, .retryableFailed:
                // Only recover runs owned by a previous process/session (crash/termination), or already retryable.
                if record.ownerBootSessionID != currentBootSessionID || record.task.status == .retryableFailed {
                    if record.task.attemptCount < record.submission.maxAttempts {
                        let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
                        let previousStatus = record.task.status
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
                                taskID: record.task.taskID,
                                sequence: nextSeq,
                                phase: .retryScheduled,
                                occurredAt: nowISO,
                                traceID: record.task.taskID,
                                payload: SessionTaskEventPayloadDTO(
                                    taskKind: record.task.kind,
                                    attempt: record.task.attemptCount,
                                    route: .fast,
                                    fromStatus: previousStatus,
                                    toStatus: .queued,
                                    runStatus: .leaseExpired,
                                    errorCode: .staleLease,
                                    simulated: false
                                )
                            )
                        )
                        state.tasksByID[taskKey] = record
                        runnableTaskIDs.append(record.task.taskID)
                        recoveredInterrupted += 1
                        didMutate = true
                    } else {
                        let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
                        let previousStatus = record.task.status
                        record.ownerBootSessionID = nil
                        record.task = updatingTask(
                            record.task,
                            status: .failed,
                            updatedAt: nowISO,
                            resultState: .unavailable
                        )
                        record.events.append(
                            SessionTaskEventDTO(
                                taskID: record.task.taskID,
                                sequence: nextSeq,
                                phase: .failed,
                                occurredAt: nowISO,
                                traceID: record.task.currentRunID ?? record.task.taskID,
                                payload: SessionTaskEventPayloadDTO(
                                    taskKind: record.task.kind,
                                    runID: record.task.currentRunID,
                                    attempt: record.task.attemptCount,
                                    route: .fast,
                                    fromStatus: previousStatus,
                                    toStatus: .failed,
                                    runStatus: .failedTerminal,
                                    errorCode: .staleLease,
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
                        record.lastErrorCode = .staleLease
                        record.lastErrorMessage = "Max recovery attempts (\(record.submission.maxAttempts)) exhausted."
                        state.tasksByID[taskKey] = record
                        expired += 1
                        didMutate = true
                    }
                }
            case .queued:
                recoveredQueued += 1
                runnableTaskIDs.append(record.task.taskID)
            case .waitingApproval, .completed, .failed, .cancelled:
                break
            }
        }

        if didMutate {
            try persistState(state)
        }

        let orderedRunnable = runnableTaskIDs.sorted { lhs, rhs in
            let lDate = state.tasksByID[key(for: lhs)]?.task.createdAt ?? ""
            let rDate = state.tasksByID[key(for: rhs)]?.task.createdAt ?? ""
            if lDate != rDate {
                return lDate < rDate
            }
            return lhs.uuidString < rhs.uuidString
        }

        let report = DeviceRecoveryReport(
            recoveredQueuedCount: recoveredQueued,
            recoveredInterruptedCount: recoveredInterrupted,
            convergedCancelledCount: convergedCancelled,
            expiredCount: expired,
            restoredTerminalCount: restoredTerminal
        )
        return (report, orderedRunnable)
    }

    public func reset() throws {
        try persistState(PersistedState())
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

    private func key(for taskID: UUID) -> String {
        taskID.uuidString.lowercased()
    }

    private func readState() throws -> PersistedState {
        if let cachedState {
            return cachedState
        }
        guard FileManager.default.fileExists(atPath: stateFileURL.path) else {
            let empty = PersistedState()
            cachedState = empty
            return empty
        }
        do {
            let data = try Data(contentsOf: stateFileURL)
            let decoded = try JSONDecoder().decode(PersistedState.self, from: data)
            cachedState = decoded
            return decoded
        } catch {
            throw DeviceExecutorError.storageUnavailable("Corrupt device executor journal: \(error.localizedDescription)")
        }
    }

    private func persistState(_ state: PersistedState) throws {
        do {
            let directory = stateFileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutableDir = directory
            try mutableDir.setResourceValues(values)

            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(state)
            try data.write(to: stateFileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
            try fsyncURL(stateFileURL)
            try fsyncURL(directory)
            cachedState = state
        } catch {
            throw DeviceExecutorError.storageUnavailable("Failed to persist device executor journal: \(error.localizedDescription)")
        }
    }

    private func fsyncURL(_ url: URL) throws {
        let fd = open(url.path, O_RDONLY)
        guard fd >= 0 else {
            throw DeviceExecutorError.storageUnavailable("Unable to open descriptor for fsync.")
        }
        defer { close(fd) }
        guard fsync(fd) == 0 else {
            throw DeviceExecutorError.storageUnavailable("fsync failed with errno \(errno).")
        }
    }
}
