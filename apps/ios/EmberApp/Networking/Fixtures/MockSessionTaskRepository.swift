import CryptoKit
import Foundation

/// Deterministic, swappable Mock repository simulating B1 Session Task & Conversation persistence.
/// Supports relaunch verification by persisting task/conversation snapshots in a dedicated file when a storage URL is supplied.
actor MockSessionTaskRepository: SessionTaskRepositoryProtocol {
    nonisolated let isMockOnly: Bool = true
    nonisolated let supportsPythonTaskSubmission: Bool = true

    static let agentID = UUID(uuidString: "00000000-0000-4000-8000-00000000b301")!
    static let notesTaskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b311")!
    static let runningTaskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b312")!
    static let approvalTaskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b313")!
    static let failedTaskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b314")!

    private struct PersistedState: Codable {
        var tasks: [SessionTaskDTO]
        var eventsByTaskID: [String: [SessionTaskEventDTO]]
        var resultsByTaskID: [String: SessionTaskResultDTO]
        var userMessages: [String]
    }

    private let storageURL: URL?
    private var state: PersistedState

    init(storageURL: URL? = nil, resetStorage: Bool = false) {
        self.storageURL = storageURL
        if resetStorage, let storageURL {
            try? FileManager.default.removeItem(at: storageURL)
        }
        if let storageURL,
           let data = try? Data(contentsOf: storageURL),
           let decoded = try? JSONDecoder().decode(PersistedState.self, from: data) {
            self.state = decoded
        } else {
            self.state = Self.defaultState()
            if let storageURL {
                Self.save(state, to: storageURL)
            }
        }
    }

    func listTasks(after cursor: String?, limit: Int) async throws -> SessionTaskListDTO {
        let ordered = state.tasks.sorted { lhs, rhs in
            if lhs.updatedDate != rhs.updatedDate {
                return lhs.updatedDate > rhs.updatedDate
            }
            if lhs.createdAt != rhs.createdAt {
                return lhs.createdAt > rhs.createdAt
            }
            return lhs.taskID.uuidString < rhs.taskID.uuidString
        }
        let pageLimit = min(max(limit, 1), 50)
        let startIndex: Int
        if let cursor, !cursor.isEmpty {
            guard let cursorIndex = ordered.firstIndex(where: {
                $0.taskID.uuidString.caseInsensitiveCompare(cursor) == .orderedSame
            }) else {
                return SessionTaskListDTO(tasks: [], nextAfter: nil, hasMore: false)
            }
            startIndex = cursorIndex + 1
        } else {
            startIndex = 0
        }

        guard startIndex < ordered.count else {
            return SessionTaskListDTO(tasks: [], nextAfter: nil, hasMore: false)
        }
        let endIndex = min(startIndex + pageLimit, ordered.count)
        let slice = Array(ordered[startIndex..<endIndex])
        let hasMore = endIndex < ordered.count
        let nextAfter = hasMore ? slice.last?.taskID.uuidString.lowercased() : nil
        return SessionTaskListDTO(tasks: slice, nextAfter: nextAfter, hasMore: hasMore)
    }

    func fetchTask(id: UUID) async throws -> SessionTaskDetailDTO {
        guard let task = state.tasks.first(where: { $0.taskID == id }) else {
            throw SessionTaskRepositoryError.notFound
        }
        let resultDTO = try await fetchResult(taskID: id)
        let summary = SessionTaskDTO(
            taskID: task.taskID,
            agentID: task.agentID,
            kind: task.kind,
            title: task.title,
            status: task.status,
            currentRunID: task.currentRunID,
            attemptCount: task.attemptCount,
            cancelRequested: task.cancelRequested,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            deadlineAt: task.deadlineAt,
            resultState: resultDTO.resultState
        )
        return SessionTaskDetailDTO(summary: summary, result: resultDTO.result)
    }

    func fetchEvents(taskID: UUID, after sequence: Int?) async throws -> SessionTaskEventPageDTO {
        guard state.tasks.contains(where: { $0.taskID == taskID }) else {
            throw SessionTaskRepositoryError.notFound
        }
        let all = state.eventsByTaskID[taskID.uuidString.lowercased()] ?? []
        let filtered: [SessionTaskEventDTO]
        if let sequence {
            filtered = all.filter { $0.sequence > sequence }
        } else {
            filtered = all
        }
        return SessionTaskEventPageDTO(taskID: taskID, events: filtered)
    }

    func fetchResult(taskID: UUID) async throws -> SessionTaskResultDTO {
        guard let task = state.tasks.first(where: { $0.taskID == taskID }) else {
            throw SessionTaskRepositoryError.notFound
        }
        if let existing = state.resultsByTaskID[taskID.uuidString.lowercased()] {
            return existing
        }
        if task.status.isTerminal {
            return SessionTaskResultDTO(
                taskID: taskID,
                taskStatus: task.status,
                resultState: .unavailable,
                result: nil
            )
        }
        return SessionTaskResultDTO(
            taskID: taskID,
            taskStatus: task.status,
            resultState: .pending,
            result: nil
        )
    }

    func fetchArtifacts(taskID: UUID) async throws -> TaskArtifactsListDTO {
        guard state.tasks.contains(where: { $0.taskID == taskID }) else {
            throw SessionTaskRepositoryError.notFound
        }
        if taskID == Self.notesTaskID {
            let sampleData = Data("item,owner,due\nConfirm App Store review checklist,Lin,2026-11-18\n".utf8)
            return TaskArtifactsListDTO(
                taskID: taskID,
                artifacts: [
                    TaskArtifactItemDTO(
                        artifactID: UUID(uuidString: "00000000-0000-4000-8000-00000000b371")!,
                        filename: "action_items.csv",
                        mediaType: "text/csv",
                        size: sampleData.count,
                        sha256: Self.sha256Hex(sampleData),
                        createdBy: .run,
                        createdAt: "2026-11-15T09:02:00Z"
                    )
                ]
            )
        }
        if let task = state.tasks.first(where: { $0.taskID == taskID }),
           task.kind == .pythonAgent,
           task.status == .completed {
            let report = Self.mockPythonArtifactData(for: task.taskID)
            return TaskArtifactsListDTO(
                taskID: taskID,
                artifacts: [
                    TaskArtifactItemDTO(
                        artifactID: task.taskID,
                        filename: "analysis_summary.csv",
                        mediaType: "text/csv",
                        size: report.count,
                        sha256: Self.sha256Hex(report),
                        createdBy: .run,
                        createdAt: task.updatedAt
                    )
                ]
            )
        }
        return TaskArtifactsListDTO(taskID: taskID, artifacts: [])
    }

    func downloadArtifact(
        artifactID: UUID,
        filename: String,
        mediaType: String
    ) async throws -> DownloadedTaskArtifact {
        if artifactID == UUID(uuidString: "00000000-0000-4000-8000-00000000b371")! {
            let sample = Data("item,owner,due\nConfirm App Store review checklist,Lin,2026-11-18\n".utf8)
            return DownloadedTaskArtifact(
                artifactID: artifactID,
                filename: B3AttachmentLimits.safeUploadFilename(filename, mediaType: mediaType),
                mediaType: mediaType,
                data: sample
            )
        }
        if let task = state.tasks.first(where: { $0.taskID == artifactID && $0.kind == .pythonAgent && $0.status == .completed }) {
            let report = Self.mockPythonArtifactData(for: task.taskID)
            return DownloadedTaskArtifact(
                artifactID: artifactID,
                filename: B3AttachmentLimits.safeUploadFilename(filename, mediaType: mediaType),
                mediaType: mediaType,
                data: report
            )
        }
        throw SessionTaskRepositoryError.notFound
    }

    func uploadAttachment(
        filename: String,
        mediaType: String,
        data: Data
    ) async throws -> StagedUploadReceiptDTO {
        let normalizedType = B3AttachmentLimits.normalizedMediaType(mediaType)
        let safeFilename = B3AttachmentLimits.safeUploadFilename(filename, mediaType: normalizedType)
        guard B3AttachmentLimits.isSafeMediaType(normalizedType),
              data.count <= SubmitPythonTaskRequestDTO.maxInlineArtifactBytes else {
            throw SessionTaskRepositoryError.invalidInput
        }
        let now = Date().ISO8601Format()
        return StagedUploadReceiptDTO(
            uploadID: UUID(),
            filename: safeFilename,
            mediaType: normalizedType,
            size: data.count,
            sha256: Self.sha256Hex(data),
            expiresAt: Date().addingTimeInterval(3600).ISO8601Format(),
            createdAt: now
        )
    }

    func submitPythonTask(_ request: SubmitPythonTaskRequestDTO) async throws -> PythonTaskSubmitResultDTO {
        let trimmedPrompt = request.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty,
              trimmedPrompt.count <= SubmitPythonTaskRequestDTO.promptMaxChars else {
            throw SessionTaskRepositoryError.invalidInput
        }
        let taskID = UUID()
        let now = Date().ISO8601Format()
        let task = SessionTaskDTO(
            taskID: taskID,
            agentID: Self.agentID,
            kind: .pythonAgent,
            title: request.title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                ? request.title?.trimmingCharacters(in: .whitespacesAndNewlines)
                : "Data analysis task",
            status: .completed,
            currentRunID: UUID(),
            attemptCount: 1,
            createdAt: now,
            updatedAt: now,
            resultState: .available
        )
        let result = SessionTaskTextResult(
            summaryText: "MOCK: Simulated Python analysis complete.",
            detailText: "MOCK ONLY: Simulated analysis for prompt: \(trimmedPrompt)",
            modelLabel: "mock-python-sandbox",
            simulated: true,
            producedAt: now
        )
        state.tasks.insert(task, at: 0)
        state.resultsByTaskID[taskID.uuidString.lowercased()] = SessionTaskResultDTO(
            taskID: taskID,
            taskStatus: .completed,
            resultState: .available,
            result: result
        )
        state.eventsByTaskID[taskID.uuidString.lowercased()] = [
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: 1,
                phase: .accepted,
                occurredAt: now,
                traceID: UUID(),
                payload: SessionTaskEventPayloadDTO(taskKind: .pythonAgent, route: .heavy, toStatus: .queued, simulated: true)
            ),
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: 2,
                phase: .completed,
                occurredAt: now,
                traceID: UUID(),
                payload: SessionTaskEventPayloadDTO(taskKind: .pythonAgent, attempt: 1, route: .heavy, fromStatus: .running, toStatus: .completed, runStatus: .succeeded, simulated: true)
            ),
        ]
        persist()
        return PythonTaskSubmitResultDTO(
            task: SessionTaskDetailDTO(summary: task, result: result),
            created: true
        )
    }

    private static func mockPythonArtifactData(for taskID: UUID) -> Data {
        Data("task_id,status,note\n\(taskID.uuidString.lowercased()),simulated,MOCK ONLY artifact\n".utf8)
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func cancelTask(id: UUID) async throws -> TaskCancelDTO {
        guard let index = state.tasks.firstIndex(where: { $0.taskID == id }) else {
            throw SessionTaskRepositoryError.notFound
        }
        let existing = state.tasks[index]
        let nowISO = "2026-11-15T12:15:00Z"

        if existing.status.isTerminal {
            return TaskCancelDTO(
                taskID: id,
                status: existing.status,
                cancelRequested: existing.cancelRequested,
                cancelRequestedAt: nil,
                terminal: true,
                updatedAt: existing.updatedAt
            )
        }

        let updated = SessionTaskDTO(
            taskID: existing.taskID,
            agentID: existing.agentID,
            kind: existing.kind,
            title: existing.title,
            status: .cancelled,
            currentRunID: existing.currentRunID,
            attemptCount: existing.attemptCount,
            cancelRequested: true,
            createdAt: existing.createdAt,
            updatedAt: nowISO,
            deadlineAt: existing.deadlineAt
        )
        state.tasks[index] = updated

        let key = id.uuidString.lowercased()
        var events = state.eventsByTaskID[key] ?? []
        let nextSequence = (events.last?.sequence ?? 0) + 1
        events.append(SessionTaskEventDTO(
            taskID: id,
            sequence: nextSequence,
            phase: .cancelled,
            occurredAt: nowISO,
            traceID: UUID(uuidString: "00000000-0000-4000-8000-00000000b399")!,
            payload: SessionTaskEventPayloadDTO(
                taskKind: existing.kind,
                fromStatus: existing.status,
                toStatus: .cancelled,
                cancelRequested: true,
                simulated: true
            )
        ))
        state.eventsByTaskID[key] = events
        state.resultsByTaskID[key] = SessionTaskResultDTO(
            taskID: id,
            taskStatus: .cancelled,
            resultState: .unavailable,
            result: nil
        )
        persist()

        return TaskCancelDTO(
            taskID: id,
            status: .cancelled,
            cancelRequested: true,
            cancelRequestedAt: nowISO,
            terminal: true,
            updatedAt: nowISO
        )
    }

    func appendedUserMessages() -> [String] {
        state.userMessages
    }

    func recordUserMessage(_ text: String) {
        state.userMessages.append(text)
        persist()
    }

    private func persist() {
        if let storageURL {
            Self.save(state, to: storageURL)
        }
    }

    private static func save(_ state: PersistedState, to url: URL) {
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if let data = try? JSONEncoder().encode(state) {
            try? data.write(to: url, options: .atomic)
        }
    }

    static func loadPersistedUserMessages(from storageURL: URL?) -> [String] {
        guard let storageURL,
              let data = try? Data(contentsOf: storageURL),
              let decoded = try? JSONDecoder().decode(PersistedState.self, from: data) else {
            return []
        }
        return decoded.userMessages
    }

    static func defaultStorageURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("ember-b3-mock-state.json")
    }

    private static func defaultState() -> PersistedState {
        let traceID = UUID(uuidString: "00000000-0000-4000-8000-00000000b390")!
        let runNotesID = UUID(uuidString: "00000000-0000-4000-8000-00000000b351")!
        let runActiveID = UUID(uuidString: "00000000-0000-4000-8000-00000000b352")!
        let runFailedID = UUID(uuidString: "00000000-0000-4000-8000-00000000b354")!

        let notesTask = SessionTaskDTO(
            taskID: notesTaskID,
            agentID: agentID,
            kind: .notesActionItems,
            title: "Extract Q4 launch action items from meeting notes",
            status: .completed,
            currentRunID: runNotesID,
            attemptCount: 1,
            createdAt: "2026-11-15T09:00:00Z",
            updatedAt: "2026-11-15T09:02:00Z"
        )

        let runningTask = SessionTaskDTO(
            taskID: runningTaskID,
            agentID: agentID,
            kind: .notesActionItems,
            title: "Summarize customer interview transcript",
            status: .running,
            currentRunID: runActiveID,
            attemptCount: 1,
            createdAt: "2026-11-15T10:15:00Z",
            updatedAt: "2026-11-15T10:16:00Z"
        )

        let approvalTask = SessionTaskDTO(
            taskID: approvalTaskID,
            agentID: agentID,
            kind: .pythonSandbox,
            title: "Verify CSV budget totals before export",
            status: .waitingApproval,
            currentRunID: nil,
            attemptCount: 1,
            createdAt: "2026-11-15T10:10:00Z",
            updatedAt: "2026-11-15T10:12:00Z"
        )

        let failedTask = SessionTaskDTO(
            taskID: failedTaskID,
            agentID: agentID,
            kind: .notesActionItems,
            title: "Cluster archive brainstorm notes",
            status: .failed,
            currentRunID: runFailedID,
            attemptCount: 2,
            createdAt: "2026-11-15T08:00:00Z",
            updatedAt: "2026-11-15T08:05:00Z"
        )

        let notesEvents = [
            SessionTaskEventDTO(
                taskID: notesTaskID,
                sequence: 1,
                phase: .accepted,
                occurredAt: "2026-11-15T09:00:00Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO(taskKind: .notesActionItems, toStatus: .queued, simulated: true)
            ),
            SessionTaskEventDTO(
                taskID: notesTaskID,
                sequence: 2,
                phase: .started,
                occurredAt: "2026-11-15T09:00:12Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO(
                    taskKind: .notesActionItems,
                    runID: runNotesID,
                    attempt: 1,
                    route: .standard,
                    fromStatus: .queued,
                    toStatus: .running,
                    runStatus: .running,
                    simulated: true
                )
            ),
            SessionTaskEventDTO(
                taskID: notesTaskID,
                sequence: 3,
                phase: .completed,
                occurredAt: "2026-11-15T09:02:00Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO(
                    taskKind: .notesActionItems,
                    runID: runNotesID,
                    attempt: 1,
                    fromStatus: .running,
                    toStatus: .completed,
                    runStatus: .succeeded,
                    durationMs: 4200,
                    simulated: true
                )
            ),
        ]

        let runningEvents = [
            SessionTaskEventDTO(
                taskID: runningTaskID,
                sequence: 1,
                phase: .accepted,
                occurredAt: "2026-11-15T10:15:00Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO(taskKind: .notesActionItems, toStatus: .queued, simulated: true)
            ),
            SessionTaskEventDTO(
                taskID: runningTaskID,
                sequence: 2,
                phase: .started,
                occurredAt: "2026-11-15T10:16:00Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO(
                    taskKind: .notesActionItems,
                    runID: runActiveID,
                    attempt: 1,
                    route: .standard,
                    fromStatus: .queued,
                    toStatus: .running,
                    runStatus: .running,
                    simulated: true
                )
            ),
        ]

        let approvalEvents = [
            SessionTaskEventDTO(
                taskID: approvalTaskID,
                sequence: 1,
                phase: .accepted,
                occurredAt: "2026-11-15T10:10:00Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO(taskKind: .pythonSandbox, toStatus: .queued, simulated: true)
            ),
            SessionTaskEventDTO(
                taskID: approvalTaskID,
                sequence: 2,
                phase: .waitingApproval,
                occurredAt: "2026-11-15T10:12:00Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO(
                    taskKind: .pythonSandbox,
                    fromStatus: .running,
                    toStatus: .waitingApproval,
                    simulated: true
                )
            ),
        ]

        let notesResult = SessionTaskResultDTO(
            taskID: notesTaskID,
            taskStatus: .completed,
            resultState: .available,
            result: SessionTaskTextResult(
                summaryText: "3 action items extracted from your Q4 launch notes.",
                detailText: """
                1. Confirm App Store review checklist (Owner: Lin, Due: Nov 18)
                2. Publish staging smoke runbook to team repo (Owner: Chen, Due: Nov 19)
                3. Finalize release rollout window with infra (Owner: Zhao, Due: Nov 20)
                """,
                modelLabel: "mock-notes-extractor",
                simulated: true,
                producedAt: "2026-11-15T09:02:00Z"
            )
        )

        let failedResult = SessionTaskResultDTO(
            taskID: failedTaskID,
            taskStatus: .failed,
            resultState: .unavailable,
            result: nil
        )

        return PersistedState(
            tasks: [notesTask, runningTask, approvalTask, failedTask],
            eventsByTaskID: [
                notesTaskID.uuidString.lowercased(): notesEvents,
                runningTaskID.uuidString.lowercased(): runningEvents,
                approvalTaskID.uuidString.lowercased(): approvalEvents,
            ],
            resultsByTaskID: [
                notesTaskID.uuidString.lowercased(): notesResult,
                failedTaskID.uuidString.lowercased(): failedResult,
            ],
            userMessages: []
        )
    }
}
