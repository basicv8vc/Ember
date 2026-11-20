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

public enum JournalCancelOutcome: Sendable {
    case alreadyTerminal(PersistedDeviceTaskRecord)
    case cancelledQueued(PersistedDeviceTaskRecord)
    case markedCancelRequested(PersistedDeviceTaskRecord)
}

public enum JournalInterruptOutcome: Sendable {
    case requeued(PersistedDeviceTaskRecord)
    case failedMaxAttempts(PersistedDeviceTaskRecord)
    case alreadyTerminal(PersistedDeviceTaskRecord)
}

/// Atomic, encrypted-at-rest local journal for on-device task execution & cold-start recovery.
/// Serves as the single fenced state-transition authority for local device tasks.
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
    private let maxTasks: Int
    private let maxJournalBytes: Int
    private var cachedState: PersistedState?

    public init(
        directory: URL? = nil,
        maxTasks: Int = DeviceSandboxPolicy.default.maxJournalTasks,
        maxJournalBytes: Int = DeviceSandboxPolicy.default.maxJournalBytes
    ) {
        let base = directory ?? FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0].appendingPathComponent("EmberDeviceExecutor", isDirectory: true)
        self.stateFileURL = base.appendingPathComponent("executor-state.json")
        self.maxTasks = max(1, maxTasks)
        self.maxJournalBytes = max(16 * 1024, maxJournalBytes)
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

    /// Atomically checks idempotency and inserts a new queued task if not previously seen.
    public func insertOrReplay(
        submission: DeviceTaskSubmission,
        requestDigest: String,
        title: String,
        now: Date
    ) throws -> (record: PersistedDeviceTaskRecord, replayed: Bool) {
        var state = try readState()

        if let existing = state.idempotencyIndex[submission.idempotencyKey] {
            guard existing.requestDigest == requestDigest else {
                throw DeviceExecutorError.idempotencyConflict
            }
            if let existingRecord = state.tasksByID[key(for: existing.taskID)] {
                return (existingRecord, true)
            }
        }

        let createdISO = DeviceWireDate.format(now)
        let deadlineISO = DeviceWireDate.format(now.addingTimeInterval(submission.deadlineSeconds))
        let taskID = UUID()

        let taskDTO = SessionTaskDTO(
            taskID: taskID,
            agentID: submission.agentID,
            kind: DeviceTaskSubmission.deviceTaskKind,
            title: title,
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
            requestDigest: requestDigest,
            leaseEpoch: 0,
            ownerBootSessionID: nil,
            completedStepOutputs: [:],
            events: [acceptedEvent]
        )

        state.tasksByID[key(for: taskID)] = record
        state.idempotencyIndex[submission.idempotencyKey] = IdempotencyEntry(
            taskID: taskID,
            requestDigest: requestDigest
        )
        try persistState(&state)
        return (record, false)
    }

    /// Inserts a pre-constructed record (used by recovery tests).
    public func insertQueuedTask(_ record: PersistedDeviceTaskRecord) throws {
        var state = try readState()
        state.tasksByID[key(for: record.task.taskID)] = record
        state.idempotencyIndex[record.submission.idempotencyKey] = IdempotencyEntry(
            taskID: record.task.taskID,
            requestDigest: record.requestDigest
        )
        try persistState(&state)
    }

    /// Atomically claims a queued task for execution under a new runID and incremented leaseEpoch.
    public func claimRun(
        taskID: UUID,
        runID: UUID,
        bootSessionID: UUID,
        now: Date
    ) throws -> PersistedDeviceTaskRecord {
        var state = try readState()
        let taskKey = key(for: taskID)
        guard var record = state.tasksByID[taskKey] else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        guard !record.task.status.isTerminal else {
            throw DeviceExecutorError.staleLease("Task is already terminal (\(record.task.status.rawValue)).")
        }
        if record.task.cancelRequested {
            throw DeviceExecutorError.cancelled
        }
        if let deadlineISO = record.task.deadlineAt,
           let deadline = DeviceWireDate.parse(deadlineISO),
           deadline <= now {
            throw DeviceExecutorError.executionTimeout("Task deadline exceeded before run claim.")
        }
        guard record.task.status == .queued else {
            throw DeviceExecutorError.staleLease("Task status '\(record.task.status.rawValue)' is not claimable.")
        }

        let nowISO = DeviceWireDate.format(now)
        let newAttempt = record.task.attemptCount + 1
        let newEpoch = record.leaseEpoch + 1
        let previousStatus = record.task.status

        record.leaseEpoch = newEpoch
        record.ownerBootSessionID = bootSessionID
        record.task = updatingTask(
            record.task,
            status: .running,
            currentRunID: .some(runID),
            attemptCount: newAttempt,
            updatedAt: nowISO,
            resultState: .pending
        )

        let baseSeq = (record.events.map(\.sequence).max() ?? 0) + 1
        record.events.append(
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: baseSeq,
                phase: .leased,
                occurredAt: nowISO,
                traceID: runID,
                payload: SessionTaskEventPayloadDTO(
                    taskKind: record.task.kind,
                    runID: runID,
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
                occurredAt: nowISO,
                traceID: runID,
                payload: SessionTaskEventPayloadDTO(
                    taskKind: record.task.kind,
                    runID: runID,
                    attempt: newAttempt,
                    route: .fast,
                    fromStatus: previousStatus,
                    toStatus: .running,
                    runStatus: .running,
                    simulated: false
                )
            )
        )

        state.tasksByID[taskKey] = record
        try persistState(&state)
        return record
    }

    /// Atomically persists a fenced step checkpoint.
    public func checkpointStep(
        taskID: UUID,
        runID: UUID,
        expectedLeaseEpoch: Int,
        bootSessionID: UUID,
        stepIndex: Int,
        output: NativeToolOutput,
        durationMs: Int,
        now: Date
    ) throws -> PersistedDeviceTaskRecord {
        var state = try readState()
        let taskKey = key(for: taskID)
        guard var record = state.tasksByID[taskKey] else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        try validateActiveFence(
            record: record,
            expectedRunID: runID,
            expectedLeaseEpoch: expectedLeaseEpoch,
            expectedBootSessionID: bootSessionID,
            now: now
        )

        let nowISO = DeviceWireDate.format(now)
        let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1

        record.completedStepOutputs[stepIndex] = output
        for artifact in output.generatedArtifacts {
            if !record.artifacts.contains(where: { $0.artifactID == artifact.artifactID }) {
                record.artifacts.append(artifact)
            }
        }
        record.task = updatingTask(
            record.task,
            status: .running,
            currentRunID: .some(runID),
            updatedAt: nowISO,
            resultState: .pending
        )
        record.events.append(
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: nextSeq,
                phase: .progress,
                occurredAt: nowISO,
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
                    durationMs: durationMs,
                    simulated: false
                )
            )
        )

        state.tasksByID[taskKey] = record
        try persistState(&state)
        return record
    }

    /// Atomically commits a completed task after verifying lease/epoch/cancel/deadline fencing.
    public func commitCompleted(
        taskID: UUID,
        runID: UUID,
        expectedLeaseEpoch: Int,
        bootSessionID: UUID,
        textResult: SessionTaskTextResult,
        structuredOutput: DeviceJSONValue?,
        metrics: DeviceExecutionMetrics,
        now: Date
    ) throws -> PersistedDeviceTaskRecord {
        var state = try readState()
        let taskKey = key(for: taskID)
        guard var record = state.tasksByID[taskKey] else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        try validateActiveFence(
            record: record,
            expectedRunID: runID,
            expectedLeaseEpoch: expectedLeaseEpoch,
            expectedBootSessionID: bootSessionID,
            now: now
        )

        let completedISO = textResult.producedAt
        let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1

        record.task = updatingTask(
            record.task,
            status: .completed,
            currentRunID: .some(runID),
            updatedAt: completedISO,
            resultState: .available
        )
        record.ownerBootSessionID = nil
        record.metrics = metrics
        record.structuredOutput = structuredOutput
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

        state.tasksByID[taskKey] = record
        try persistState(&state)
        return record
    }

    /// Atomically records a cancellation request or immediately cancels a queued task.
    public func requestCancel(taskID: UUID, now: Date) throws -> JournalCancelOutcome {
        var state = try readState()
        let taskKey = key(for: taskID)
        guard var record = state.tasksByID[taskKey] else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }

        if record.task.status.isTerminal {
            return .alreadyTerminal(record)
        }

        let nowISO = DeviceWireDate.format(now)
        if record.task.status == .queued {
            let previousStatus = record.task.status
            let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
            record.ownerBootSessionID = nil
            record.task = updatingTask(
                record.task,
                status: .cancelled,
                currentRunID: .some(nil),
                cancelRequested: true,
                updatedAt: nowISO,
                resultState: .unavailable
            )
            record.events.append(
                SessionTaskEventDTO(
                    taskID: taskID,
                    sequence: nextSeq,
                    phase: .cancelled,
                    occurredAt: nowISO,
                    traceID: taskID,
                    payload: SessionTaskEventPayloadDTO(
                        taskKind: record.task.kind,
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
            state.tasksByID[taskKey] = record
            try persistState(&state)
            return .cancelledQueued(record)
        }

        record.task = updatingTask(
            record.task,
            status: record.task.status,
            cancelRequested: true,
            updatedAt: nowISO,
            resultState: record.task.resultState
        )
        state.tasksByID[taskKey] = record
        try persistState(&state)
        return .markedCancelRequested(record)
    }

    /// Atomically commits cancellation under lease fencing.
    public func commitCancelled(
        taskID: UUID,
        expectedLeaseEpoch: Int?,
        reason: String,
        now: Date
    ) throws -> PersistedDeviceTaskRecord {
        var state = try readState()
        let taskKey = key(for: taskID)
        guard var record = state.tasksByID[taskKey] else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        if record.task.status.isTerminal {
            return record
        }
        if let expectedLeaseEpoch, record.leaseEpoch != expectedLeaseEpoch {
            throw DeviceExecutorError.staleLease("Lease epoch mismatch on cancel commit.")
        }

        let nowISO = DeviceWireDate.format(now)
        let previousStatus = record.task.status
        let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
        record.ownerBootSessionID = nil
        record.task = updatingTask(
            record.task,
            status: .cancelled,
            cancelRequested: true,
            updatedAt: nowISO,
            resultState: .unavailable
        )
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
        record.lastErrorMessage = reason
        state.tasksByID[taskKey] = record
        try persistState(&state)
        return record
    }

    /// Atomically commits terminal failure under lease fencing.
    public func commitFailed(
        taskID: UUID,
        expectedLeaseEpoch: Int?,
        errorCode: TaskErrorCode,
        message: String,
        now: Date
    ) throws -> PersistedDeviceTaskRecord {
        var state = try readState()
        let taskKey = key(for: taskID)
        guard var record = state.tasksByID[taskKey] else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        if record.task.status.isTerminal {
            return record
        }
        if let expectedLeaseEpoch, record.leaseEpoch != expectedLeaseEpoch {
            throw DeviceExecutorError.staleLease("Lease epoch mismatch on failure commit.")
        }

        let nowISO = DeviceWireDate.format(now)
        let previousStatus = record.task.status
        let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
        record.ownerBootSessionID = nil
        record.task = updatingTask(
            record.task,
            status: .failed,
            updatedAt: nowISO,
            resultState: .unavailable
        )
        record.events.append(
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: nextSeq,
                phase: .failed,
                occurredAt: nowISO,
                traceID: record.task.currentRunID ?? taskID,
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
            taskID: taskID,
            taskStatus: .failed,
            resultState: .unavailable,
            result: nil
        )
        record.lastErrorCode = errorCode
        record.lastErrorMessage = message
        state.tasksByID[taskKey] = record
        try persistState(&state)
        return record
    }

    /// Atomically handles background suspension interruption, re-queuing with cleared `currentRunID`
    /// and incremented `leaseEpoch` or failing if `maxAttempts` is exhausted.
    public func commitInterruptedForRetry(
        taskID: UUID,
        runID: UUID,
        expectedLeaseEpoch: Int,
        bootSessionID: UUID,
        now: Date
    ) throws -> JournalInterruptOutcome {
        var state = try readState()
        let taskKey = key(for: taskID)
        guard var record = state.tasksByID[taskKey] else {
            throw DeviceExecutorError.taskNotFound(taskID)
        }
        if record.task.status.isTerminal {
            return .alreadyTerminal(record)
        }
        guard record.leaseEpoch == expectedLeaseEpoch,
              record.task.currentRunID == runID,
              record.ownerBootSessionID == bootSessionID
        else {
            throw DeviceExecutorError.staleLease("Lease mismatch on background interruption.")
        }

        let nowISO = DeviceWireDate.format(now)
        let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1

        if record.task.attemptCount < record.submission.maxAttempts {
            record.leaseEpoch += 1
            record.ownerBootSessionID = nil
            record.task = updatingTask(
                record.task,
                status: .queued,
                currentRunID: .some(nil),
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
            state.tasksByID[taskKey] = record
            try persistState(&state)
            return .requeued(record)
        }

        let failed = try commitFailed(
            taskID: taskID,
            expectedLeaseEpoch: expectedLeaseEpoch,
            errorCode: .staleLease,
            message: "Interrupted by background suspension after max attempts.",
            now: now
        )
        return .failedMaxAttempts(failed)
    }

    /// Reconciles durable task state across process restarts, crashes, or background suspension.
    public func recoverOnLaunch(
        currentBootSessionID: UUID,
        now: Date = Date()
    ) throws -> (report: DeviceRecoveryReport, runnableTaskIDs: [UUID], terminalRecords: [PersistedDeviceTaskRecord]) {
        var state = try readState()
        var didMutate = false
        var recoveredQueued = 0
        var recoveredInterrupted = 0
        var convergedCancelled = 0
        var expired = 0
        var restoredTerminal = 0
        var runnableTaskIDs: [UUID] = []
        var terminalRecords: [PersistedDeviceTaskRecord] = []

        let nowISO = DeviceWireDate.format(now)

        for (taskKey, var record) in state.tasksByID {
            if record.task.status.isTerminal {
                restoredTerminal += 1
                terminalRecords.append(record)
                continue
            }

            if record.task.cancelRequested {
                let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
                let previousStatus = record.task.status
                record.task = updatingTask(
                    record.task,
                    status: .cancelled,
                    currentRunID: .some(nil),
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
                        traceID: record.task.taskID,
                        payload: SessionTaskEventPayloadDTO(
                            taskKind: record.task.kind,
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
                record.lastErrorMessage = "Cancelled during recovery."
                state.tasksByID[taskKey] = record
                terminalRecords.append(record)
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
                    currentRunID: .some(nil),
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
                        traceID: record.task.taskID,
                        payload: SessionTaskEventPayloadDTO(
                            taskKind: record.task.kind,
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
                terminalRecords.append(record)
                expired += 1
                didMutate = true
                continue
            }

            switch record.task.status {
            case .running, .retryableFailed:
                if record.ownerBootSessionID != currentBootSessionID || record.task.status == .retryableFailed {
                    if record.task.attemptCount < record.submission.maxAttempts {
                        let nextSeq = (record.events.map(\.sequence).max() ?? 0) + 1
                        let previousStatus = record.task.status
                        record.leaseEpoch += 1
                        record.ownerBootSessionID = nil
                        record.task = updatingTask(
                            record.task,
                            status: .queued,
                            currentRunID: .some(nil),
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
                            currentRunID: .some(nil),
                            updatedAt: nowISO,
                            resultState: .unavailable
                        )
                        record.events.append(
                            SessionTaskEventDTO(
                                taskID: record.task.taskID,
                                sequence: nextSeq,
                                phase: .failed,
                                occurredAt: nowISO,
                                traceID: record.task.taskID,
                                payload: SessionTaskEventPayloadDTO(
                                    taskKind: record.task.kind,
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
                        terminalRecords.append(record)
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
            try persistState(&state)
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
        return (report, orderedRunnable, terminalRecords)
    }

    public func reset() throws {
        var empty = PersistedState()
        try persistState(&empty)
    }

    private func validateActiveFence(
        record: PersistedDeviceTaskRecord,
        expectedRunID: UUID,
        expectedLeaseEpoch: Int,
        expectedBootSessionID: UUID,
        now: Date
    ) throws {
        if record.task.status == .cancelled || record.task.cancelRequested {
            throw DeviceExecutorError.cancelled
        }
        guard !record.task.status.isTerminal else {
            throw DeviceExecutorError.staleLease("Task is already terminal (\(record.task.status.rawValue)).")
        }
        guard record.task.status == .running,
              record.leaseEpoch == expectedLeaseEpoch,
              record.task.currentRunID == expectedRunID,
              record.ownerBootSessionID == expectedBootSessionID
        else {
            throw DeviceExecutorError.staleLease("Stale lease or owner mismatch.")
        }
        if let deadlineISO = record.task.deadlineAt,
           let deadline = DeviceWireDate.parse(deadlineISO),
           deadline <= now {
            throw DeviceExecutorError.executionTimeout("Task deadline exceeded.")
        }
    }

    private func updatingTask(
        _ task: SessionTaskDTO,
        status: TaskStatus,
        currentRunID: UUID?? = nil,
        attemptCount: Int? = nil,
        cancelRequested: Bool? = nil,
        updatedAt: String,
        resultState: SessionTaskResultState?
    ) -> SessionTaskDTO {
        let resolvedRunID: UUID? = switch currentRunID {
        case .none: task.currentRunID
        case .some(let value): value
        }
        return SessionTaskDTO(
            taskID: task.taskID,
            agentID: task.agentID,
            kind: task.kind,
            title: task.title,
            status: status,
            currentRunID: resolvedRunID,
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

    private func persistState(_ state: inout PersistedState) throws {
        pruneTerminalRecordsIfNeeded(&state)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        var data: Data
        do {
            data = try encoder.encode(state)
        } catch {
            throw DeviceExecutorError.storageUnavailable("Failed to encode journal: \(error.localizedDescription)")
        }

        while data.count > maxJournalBytes {
            guard pruneOneOldestTerminalRecord(&state) else {
                throw DeviceExecutorError.payloadTooLarge(
                    "Device executor journal (\(data.count) bytes) exceeds limit \(maxJournalBytes)."
                )
            }
            data = try encoder.encode(state)
        }

        do {
            let directory = stateFileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutableDir = directory
            try mutableDir.setResourceValues(values)

            try data.write(to: stateFileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
            try fsyncURL(stateFileURL)
            try fsyncURL(directory)
            cachedState = state
        } catch {
            throw DeviceExecutorError.storageUnavailable("Failed to persist device executor journal: \(error.localizedDescription)")
        }
    }

    private func pruneTerminalRecordsIfNeeded(_ state: inout PersistedState) {
        while state.tasksByID.count > maxTasks {
            guard pruneOneOldestTerminalRecord(&state) else {
                break
            }
        }
    }

    private func pruneOneOldestTerminalRecord(_ state: inout PersistedState) -> Bool {
        let terminalEntries = state.tasksByID.filter { $0.value.task.status.isTerminal }
        guard let oldest = terminalEntries.min(by: { lhs, rhs in
            if lhs.value.task.updatedDate != rhs.value.task.updatedDate {
                return lhs.value.task.updatedDate < rhs.value.task.updatedDate
            }
            return lhs.key < rhs.key
        }) else {
            return false
        }
        state.tasksByID.removeValue(forKey: oldest.key)
        state.idempotencyIndex.removeValue(forKey: oldest.value.submission.idempotencyKey)
        return true
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
