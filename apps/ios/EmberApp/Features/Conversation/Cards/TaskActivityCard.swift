import SwiftUI

/// A compact, navigable summary of an existing Task snapshot.
public struct TaskActivityCard: View {
    private let title: String
    private let taskID: UUID
    private let taskStatus: TaskStatus
    private let updatedAt: String
    private let presentation: TaskPresentationState
    private let cancelResponse: TaskCancelDTO?
    private let progressDetail: String?
    private let artifactCount: Int
    private let onOpenDetail: () -> Void

    private var facts: TaskActivityFacts {
        Self.facts(
            taskID: taskID,
            status: taskStatus,
            updatedAt: updatedAt,
            presentation: presentation,
            cancelResponse: cancelResponse,
            progressDetail: progressDetail,
            artifactCount: artifactCount
        )
    }

    public init(
        title: String,
        task: TaskDTO,
        presentation: TaskPresentationState,
        cancelResponse: TaskCancelDTO? = nil,
        progressDetail: String? = nil,
        artifactCount: Int = 0,
        onOpenDetail: @escaping () -> Void
    ) {
        self.init(
            title: title,
            taskID: task.taskID,
            status: task.status,
            updatedAt: task.updatedAt,
            presentation: presentation,
            cancelResponse: cancelResponse,
            progressDetail: progressDetail,
            artifactCount: artifactCount,
            onOpenDetail: onOpenDetail
        )
    }

    public init(
        title: String,
        taskID: UUID,
        status: TaskStatus,
        updatedAt: String,
        presentation: TaskPresentationState,
        cancelResponse: TaskCancelDTO? = nil,
        progressDetail: String? = nil,
        artifactCount: Int = 0,
        onOpenDetail: @escaping () -> Void
    ) {
        self.title = title
        self.taskID = taskID
        self.taskStatus = status
        self.updatedAt = updatedAt
        self.presentation = presentation
        self.cancelResponse = cancelResponse
        self.progressDetail = progressDetail
        self.artifactCount = artifactCount
        self.onOpenDetail = onOpenDetail
    }

    public var body: some View {
        Button(action: onOpenDetail) {
            ConversationCardSurface {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "bolt.horizontal.circle.fill")
                            .font(.title3)
                            .foregroundStyle(Color(uiColor: .systemTeal))
                            .accessibilityHidden(true)

                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 7) {
                                Text("card.task", tableName: "ConversationCards")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                if facts.capability == .mockOnly {
                                    ConversationMockTag()
                                }
                            }
                            Text(title)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .padding(.top, 4)
                            .accessibilityHidden(true)
                    }

                    HStack(alignment: .center, spacing: 10) {
                        HStack(spacing: 6) {
                            TaskStatusBadge(status: facts.status)
                            if facts.isActiveProgress && facts.connectionPhase != .disconnected {
                                ProgressView()
                                    .controlSize(.mini)
                                    .accessibilityHidden(true)
                            }
                        }
                        Spacer(minLength: 0)
                        if facts.artifactCount > 0 {
                            Label {
                                if facts.artifactCount == 1 {
                                    Text("card.artifact_single", tableName: "ConversationCards")
                                } else {
                                    Text("card.artifact_plural \(facts.artifactCount)", tableName: "ConversationCards")
                                }
                            } icon: {
                                Image(systemName: "paperclip")
                                    .accessibilityHidden(true)
                            }
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(EmberDesignTokens.groupedBackground, in: Capsule())
                        }
                        if let updatedAt = facts.updatedAt {
                            HStack(spacing: 4) {
                                Image(systemName: "clock")
                                    .accessibilityHidden(true)
                                Text("card.updated", tableName: "ConversationCards")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(updatedAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .fixedSize(horizontal: true, vertical: false)
                        }
                    }

                    if let progressDetail = facts.progressDetail {
                        Text(progressDetail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if facts.cancellationPending {
                        ConversationCardNotice(textKey: "card.cancel_pending", symbol: "hourglass")
                    } else if facts.commandInFlight == .cancellingTask {
                        ConversationCardNotice(textKey: "card.cancel_sending", symbol: "arrow.clockwise")
                    }

                    if facts.connectionPhase == .disconnected {
                        ConversationCardNotice(textKey: "card.connection_interrupted", symbol: "wifi.slash")
                    } else if facts.connectionPhase == .connecting {
                        ConversationCardNotice(textKey: "card.connection_reconnecting", symbol: "wifi")
                    }
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("card.task_open_hint", tableName: "ConversationCards"))
        .accessibilityIdentifier("task-activity-card-\(taskID.uuidString.lowercased())")
    }

    static func facts(
        for task: TaskDTO,
        presentation: TaskPresentationState,
        cancelResponse: TaskCancelDTO?,
        progressDetail: String? = nil,
        artifactCount: Int = 0
    ) -> TaskActivityFacts {
        facts(
            taskID: task.taskID,
            status: task.status,
            updatedAt: task.updatedAt,
            presentation: presentation,
            cancelResponse: cancelResponse,
            progressDetail: progressDetail,
            artifactCount: artifactCount
        )
    }

    static func facts(
        taskID: UUID,
        status: TaskStatus,
        updatedAt: String,
        presentation: TaskPresentationState,
        cancelResponse: TaskCancelDTO?,
        progressDetail: String? = nil,
        artifactCount: Int = 0
    ) -> TaskActivityFacts {
        let trimmedProgress = progressDetail?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedProgress = (trimmedProgress?.isEmpty == false) ? trimmedProgress : nil
        return TaskActivityFacts(
            status: status,
            updatedAt: ConversationCardFormatting.date(from: updatedAt),
            capability: presentation.capability,
            connectionPhase: presentation.connectionPhase,
            commandInFlight: presentation.commandInFlight,
            cancellationPending: isCancellationPending(taskID: taskID, status: status, response: cancelResponse),
            isActiveProgress: status == .queued || status == .running,
            progressDetail: normalizedProgress,
            artifactCount: max(0, artifactCount)
        )
    }

    private static func isCancellationPending(taskID: UUID, status: TaskStatus, response: TaskCancelDTO?) -> Bool {
        switch status {
        case .completed, .failed, .cancelled:
            return false
        case .queued, .running, .waitingApproval, .retryableFailed:
            break
        }

        guard let response, response.taskID == taskID else { return false }
        return response.cancelRequested && !response.terminal
    }
}

struct TaskActivityFacts: Equatable {
    let status: TaskStatus
    let updatedAt: Date?
    let capability: TaskExecutionCapability
    let connectionPhase: ConnectionPhase
    let commandInFlight: TaskCommandInFlight?
    let cancellationPending: Bool
    let isActiveProgress: Bool
    let progressDetail: String?
    let artifactCount: Int
}

#Preview("Task activity states · MOCK ONLY") {
    ScrollView {
        VStack(alignment: .leading, spacing: 12) {
            TaskActivityCard(
                title: "Prepare a short trip plan",
                task: previewTask(id: 101, status: .queued, updatedAt: "2026-11-02T01:00:00Z"),
                presentation: previewPresentation(.queued),
                onOpenDetail: {}
            )
            TaskActivityCard(
                title: "Compare two travel options",
                task: previewTask(id: 102, status: .running, updatedAt: "2026-11-02T01:05:00Z"),
                presentation: previewPresentation(.running),
                onOpenDetail: {}
            )
            TaskActivityCard(
                title: "Summarize the saved notes",
                task: previewTask(id: 103, status: .completed, updatedAt: "2026-11-02T01:10:00Z"),
                presentation: previewPresentation(.completed),
                onOpenDetail: {}
            )
            TaskActivityCard(
                title: "Cancel request still awaiting final state",
                task: previewTask(id: 104, status: .running, updatedAt: "2026-11-02T01:15:00Z"),
                presentation: TaskPresentationState(
                    taskStatus: .running,
                    connectionPhase: .connected,
                    commandInFlight: nil,
                    capability: .mockOnly
                ),
                cancelResponse: TaskCancelDTO(
                    taskID: previewID(104),
                    status: .running,
                    cancelRequested: true,
                    cancelRequestedAt: "2026-11-02T01:15:00Z",
                    terminal: false,
                    updatedAt: "2026-11-02T01:15:00Z"
                ),
                onOpenDetail: {}
            )
        }
        .padding()
    }
    .background(EmberDesignTokens.groupedBackground)
}

private func previewID(_ number: Int) -> UUID {
    UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", number))!
}

private func previewTask(id: Int, status: TaskStatus, updatedAt: String) -> TaskDTO {
    TaskDTO(
        taskID: previewID(id),
        agentID: previewID(201),
        kind: .mockChat,
        status: status,
        currentRunID: status == .running ? previewID(id + 100) : nil,
        attemptCount: status == .running ? 1 : 0,
        createdAt: "2026-11-02T00:55:00Z",
        updatedAt: updatedAt,
        deadlineAt: nil
    )
}

private func previewPresentation(_ status: TaskStatus) -> TaskPresentationState {
    TaskPresentationState(
        taskStatus: status,
        connectionPhase: .connected,
        commandInFlight: nil,
        capability: .mockOnly
    )
}
