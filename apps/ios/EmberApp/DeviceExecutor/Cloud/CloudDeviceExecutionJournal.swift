import Foundation

public enum CloudDeviceExecutionPhase: Codable, Equatable, Sendable {
    /// Cloud AgentHead offer durably recorded prior to local native execution.
    case claimed
    /// Local NativeTextTool step finished and checkpointed, pending wire submission staging.
    case checkpointed
    /// Result submission staged with authoritative Cloud fence; must replay until committed or fenced.
    case pendingCommit
    /// Cloud AgentHead confirmed HTTP 200 `{ kind: "committed", replayed }`.
    case committed(replayed: Bool)
    /// Cloud AgentHead returned HTTP 409 `{ kind: "fenced" }` or superseded with a newer run/epoch.
    case fenced
    /// Execution failed locally (e.g. deadline expired or invalid input) after optional failure report.
    case failedLocally(reason: String)

    public var isTerminal: Bool {
        switch self {
        case .committed, .fenced, .failedLocally:
            return true
        case .claimed, .checkpointed, .pendingCommit:
            return false
        }
    }
}

public struct CloudDeviceJournalEvent: Codable, Equatable, Sendable {
    public let atMs: Int64
    public let kind: String
    public let detail: String?

    public init(atMs: Int64, kind: String, detail: String? = nil) {
        self.atMs = atMs
        self.kind = kind
        self.detail = detail
    }
}

/// Durable journal record anchored on Cloud AgentHead authoritative Task ID, Run ID,
/// Lease Epoch, and Deadline. Local storage tracks only execution, checkpoints, and pending ACK recovery.
public struct CloudDeviceJournalRecord: Codable, Equatable, Sendable {
    public let taskId: UUID
    public var operationId: UUID
    public var runId: UUID
    public var leaseEpoch: Int
    public var leaseExpiresAtMs: Int64
    public var deadlineAtMs: Int64
    public var capability: String
    public var version: Int
    public var input: CloudDeviceTextInput
    public var inputDigestSHA256: String
    public var phase: CloudDeviceExecutionPhase
    public var nativeStepOutput: NativeToolOutput?
    public var pendingSubmission: CloudDeviceResultSubmission?
    public var events: [CloudDeviceJournalEvent]
    public var updatedAtMs: Int64

    public var fence: CloudDeviceFence {
        CloudDeviceFence(operationId: operationId, runId: runId, leaseEpoch: leaseEpoch)
    }

    public init(
        offer: CloudDeviceClaimOffer,
        nowMs: Int64
    ) {
        self.taskId = offer.taskId
        self.operationId = offer.operationId
        self.runId = offer.runId
        self.leaseEpoch = offer.leaseEpoch
        self.leaseExpiresAtMs = offer.leaseExpiresAtMs
        self.deadlineAtMs = offer.deadlineAtMs
        self.capability = offer.capability
        self.version = offer.version
        self.input = offer.input
        self.inputDigestSHA256 = DeviceSandboxCrypto.sha256Hex(Data(offer.input.text.utf8))
        self.phase = .claimed
        self.nativeStepOutput = nil
        self.pendingSubmission = nil
        self.events = [
            CloudDeviceJournalEvent(
                atMs: nowMs,
                kind: "claimed",
                detail: "run=\(offer.runId.uuidString.lowercased()) epoch=\(offer.leaseEpoch)"
            )
        ]
        self.updatedAtMs = nowMs
    }
}

public struct CloudDeviceJournalSummary: Equatable, Sendable {
    public let totalRecords: Int
    public let activeClaimedCount: Int
    public let pendingCommitCount: Int
    public let committedCount: Int
    public let fencedCount: Int
    public let failedCount: Int

    public init(records: [CloudDeviceJournalRecord]) {
        self.totalRecords = records.count
        var active = 0
        var pending = 0
        var committed = 0
        var fenced = 0
        var failed = 0
        for record in records {
            switch record.phase {
            case .claimed, .checkpointed:
                active += 1
            case .pendingCommit:
                pending += 1
            case .committed:
                committed += 1
            case .fenced:
                fenced += 1
            case .failedLocally:
                failed += 1
            }
        }
        self.activeClaimedCount = active
        self.pendingCommitCount = pending
        self.committedCount = committed
        self.fencedCount = fenced
        self.failedCount = failed
    }
}

/// App-Sandbox encrypted journal for Cloud-delegated execution checkpoints and crash recovery.
/// Cloud AgentHead remains the sole authority for Task ID, Run ID, Lease Epoch, and Deadline.
public actor CloudDeviceExecutionJournal {
    private struct PersistedState: Codable {
        var schemaVersion: Int = 1
        var recordsByTaskID: [String: CloudDeviceJournalRecord] = [:]
    }

    private let stateFileURL: URL
    private let maxRecords: Int
    private let maxBytes: Int
    private var cachedState: PersistedState?

    public init(
        directory: URL,
        maxRecords: Int = 200,
        maxBytes: Int = 4 * 1024 * 1024
    ) {
        self.stateFileURL = directory
            .appendingPathComponent("cloud-device-journal.json", isDirectory: false)
        self.maxRecords = max(1, maxRecords)
        self.maxBytes = max(16 * 1024, maxBytes)
    }

    public static func defaultDirectory(scopeIdentifier: String) -> URL {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0]
        let digest = KeychainCloudDeviceCredentialStore.scopeDigest(scopeIdentifier)
        return appSupport
            .appendingPathComponent("EmberDeviceExecutor", isDirectory: true)
            .appendingPathComponent("cloud", isDirectory: true)
            .appendingPathComponent(digest, isDirectory: true)
    }

    public func allRecords() throws -> [CloudDeviceJournalRecord] {
        let state = try readState()
        return state.recordsByTaskID.values.sorted { lhs, rhs in
            if lhs.updatedAtMs != rhs.updatedAtMs {
                return lhs.updatedAtMs > rhs.updatedAtMs
            }
            return lhs.taskId.uuidString < rhs.taskId.uuidString
        }
    }

    public func record(for taskID: UUID) throws -> CloudDeviceJournalRecord? {
        try readState().recordsByTaskID[key(taskID)]
    }

    public func summary() throws -> CloudDeviceJournalSummary {
        CloudDeviceJournalSummary(records: try allRecords())
    }

    /// Pending result submissions sorted oldest-first so replay preserves submission order.
    public func pendingSubmissions() throws -> [CloudDeviceJournalRecord] {
        try readState().recordsByTaskID.values
            .filter { $0.phase == .pendingCommit && $0.pendingSubmission != nil }
            .sorted { $0.updatedAtMs < $1.updatedAtMs }
    }

    /// Active incomplete claims (`.claimed` or `.checkpointed`) left behind by a crash/restart.
    public func unfinishedClaims() throws -> [CloudDeviceJournalRecord] {
        try readState().recordsByTaskID.values
            .filter { $0.phase == .claimed || $0.phase == .checkpointed }
            .sorted { $0.updatedAtMs < $1.updatedAtMs }
    }

    /// Records a newly claimed Cloud offer using Cloud AgentHead's exact IDs, epoch, lease, and deadline.
    @discardableResult
    public func recordClaim(
        _ offer: CloudDeviceClaimOffer,
        nowMs: Int64
    ) throws -> CloudDeviceJournalRecord {
        var state = try readState()
        let taskKey = key(offer.taskId)

        if let existing = state.recordsByTaskID[taskKey] {
            if existing.runId == offer.runId && existing.leaseEpoch == offer.leaseEpoch {
                return existing
            }
            // If Cloud issued a lower or equal epoch for the same run, keep the newer local record.
            if existing.runId == offer.runId && existing.leaseEpoch > offer.leaseEpoch {
                return existing
            }
        }

        let record = CloudDeviceJournalRecord(offer: offer, nowMs: nowMs)
        state.recordsByTaskID[taskKey] = record
        try persistState(state)
        return record
    }

    /// Updates the authoritative lease expiry returned by Cloud `/renew` while matching `(runId, leaseEpoch)`.
    @discardableResult
    public func recordRenewed(
        taskID: UUID,
        fence: CloudDeviceFence,
        newLeaseExpiresAtMs: Int64,
        nowMs: Int64
    ) throws -> CloudDeviceJournalRecord? {
        var state = try readState()
        let taskKey = key(taskID)
        guard var record = state.recordsByTaskID[taskKey],
              record.fence == fence,
              !record.phase.isTerminal
        else {
            return nil
        }
        record.leaseExpiresAtMs = newLeaseExpiresAtMs
        record.updatedAtMs = nowMs
        record.events.append(
            CloudDeviceJournalEvent(
                atMs: nowMs,
                kind: "renewed",
                detail: "epoch=\(fence.leaseEpoch) until=\(newLeaseExpiresAtMs)"
            )
        )
        state.recordsByTaskID[taskKey] = record
        try persistState(state)
        return record
    }

    /// Checkpoints M2-C1 native tool output before staging the final Cloud wire submission.
    @discardableResult
    public func recordCheckpoint(
        taskID: UUID,
        fence: CloudDeviceFence,
        nativeOutput: NativeToolOutput,
        nowMs: Int64
    ) throws -> CloudDeviceJournalRecord? {
        var state = try readState()
        let taskKey = key(taskID)
        guard var record = state.recordsByTaskID[taskKey],
              record.fence == fence,
              !record.phase.isTerminal
        else {
            return nil
        }
        record.nativeStepOutput = nativeOutput
        record.phase = .checkpointed
        record.updatedAtMs = nowMs
        record.events.append(
            CloudDeviceJournalEvent(atMs: nowMs, kind: "checkpointed", detail: nativeOutput.summaryText)
        )
        state.recordsByTaskID[taskKey] = record
        try persistState(state)
        return record
    }

    /// Durably stages the exact Cloud result submission (`completed` or `failed`) with its authoritative
    /// `(operationId, runId, leaseEpoch)` before posting over HTTP so unknown ACK / relaunch can replay safely.
    @discardableResult
    public func stageResultSubmission(
        taskID: UUID,
        submission: CloudDeviceResultSubmission,
        nowMs: Int64
    ) throws -> CloudDeviceJournalRecord? {
        var state = try readState()
        let taskKey = key(taskID)
        guard var record = state.recordsByTaskID[taskKey],
              record.operationId == submission.operationId,
              record.runId == submission.runId,
              record.leaseEpoch == submission.leaseEpoch
        else {
            return nil
        }
        if case .committed = record.phase {
            return record
        }
        if record.phase == .fenced {
            return record
        }
        record.pendingSubmission = submission
        record.phase = .pendingCommit
        record.updatedAtMs = nowMs
        record.events.append(
            CloudDeviceJournalEvent(
                atMs: nowMs,
                kind: "staged_\(submission.status.rawValue)",
                detail: "epoch=\(submission.leaseEpoch)"
            )
        )
        state.recordsByTaskID[taskKey] = record
        try persistState(state)
        return record
    }

    @discardableResult
    public func recordCommitted(
        taskID: UUID,
        fence: CloudDeviceFence,
        replayed: Bool,
        nowMs: Int64
    ) throws -> CloudDeviceJournalRecord? {
        var state = try readState()
        let taskKey = key(taskID)
        guard var record = state.recordsByTaskID[taskKey],
              record.fence == fence
        else {
            return nil
        }
        record.pendingSubmission = nil
        record.phase = .committed(replayed: replayed)
        record.updatedAtMs = nowMs
        record.events.append(
            CloudDeviceJournalEvent(atMs: nowMs, kind: "committed", detail: "replayed=\(replayed)")
        )
        state.recordsByTaskID[taskKey] = record
        try persistState(state)
        return record
    }

    @discardableResult
    public func recordFenced(
        taskID: UUID,
        fence: CloudDeviceFence,
        reason: String,
        nowMs: Int64
    ) throws -> CloudDeviceJournalRecord? {
        var state = try readState()
        let taskKey = key(taskID)
        guard var record = state.recordsByTaskID[taskKey],
              record.fence == fence
        else {
            return nil
        }
        record.pendingSubmission = nil
        record.phase = .fenced
        record.updatedAtMs = nowMs
        record.events.append(
            CloudDeviceJournalEvent(atMs: nowMs, kind: "fenced", detail: reason)
        )
        state.recordsByTaskID[taskKey] = record
        try persistState(state)
        return record
    }

    @discardableResult
    public func recordFailedLocally(
        taskID: UUID,
        fence: CloudDeviceFence,
        reason: String,
        nowMs: Int64
    ) throws -> CloudDeviceJournalRecord? {
        var state = try readState()
        let taskKey = key(taskID)
        guard var record = state.recordsByTaskID[taskKey],
              record.fence == fence
        else {
            return nil
        }
        if case .committed = record.phase {
            return record
        }
        record.pendingSubmission = nil
        record.phase = .failedLocally(reason: reason)
        record.updatedAtMs = nowMs
        record.events.append(
            CloudDeviceJournalEvent(atMs: nowMs, kind: "failed_locally", detail: reason)
        )
        state.recordsByTaskID[taskKey] = record
        try persistState(state)
        return record
    }

    // MARK: - Persistence & Pruning

    private func key(_ taskID: UUID) -> String {
        taskID.uuidString.lowercased()
    }

    private func ensureProtectedDirectory() throws {
        let dir = stateFileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUnlessOpen]
        )
        var excluded = dir
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
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
        let data = try Data(contentsOf: stateFileURL)
        let decoded = try JSONDecoder().decode(PersistedState.self, from: data)
        cachedState = decoded
        return decoded
    }

    private func persistState(_ rawState: PersistedState) throws {
        try ensureProtectedDirectory()
        var state = pruneRecordsIfNeeded(rawState)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        var data = try encoder.encode(state)
        while data.count > maxBytes, pruneOldestTerminalRecord(&state) {
            data = try encoder.encode(state)
        }

        let dir = stateFileURL.deletingLastPathComponent()
        let tmpURL = dir.appendingPathComponent(".cloud-journal-\(UUID().uuidString.lowercased()).tmp")
        try data.write(to: tmpURL, options: [.atomic, .completeFileProtectionUnlessOpen])
        if let handle = try? FileHandle(forWritingTo: tmpURL) {
            try? handle.synchronize()
            try? handle.close()
        }
        if FileManager.default.fileExists(atPath: stateFileURL.path) {
            _ = try FileManager.default.replaceItemAt(stateFileURL, withItemAt: tmpURL)
        } else {
            try FileManager.default.moveItem(at: tmpURL, to: stateFileURL)
        }
        cachedState = state
    }

    private func pruneRecordsIfNeeded(_ rawState: PersistedState) -> PersistedState {
        var state = rawState
        while state.recordsByTaskID.count > maxRecords {
            if !pruneOldestTerminalRecord(&state) {
                break
            }
        }
        return state
    }

    private func pruneOldestTerminalRecord(_ state: inout PersistedState) -> Bool {
        let oldestTerminal = state.recordsByTaskID.values
            .filter { record in
                switch record.phase {
                case .committed, .fenced, .failedLocally:
                    return true
                case .claimed, .checkpointed, .pendingCommit:
                    return false
                }
            }
            .min { lhs, rhs in
                if lhs.updatedAtMs != rhs.updatedAtMs {
                    return lhs.updatedAtMs < rhs.updatedAtMs
                }
                return lhs.taskId.uuidString < rhs.taskId.uuidString
            }
        guard let target = oldestTerminal else {
            return false
        }
        state.recordsByTaskID.removeValue(forKey: key(target.taskId))
        return true
    }
}
