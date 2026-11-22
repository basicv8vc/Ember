import Foundation

enum TaskDetailSection: Equatable, Hashable, Sendable {
    case actionRequired
    case statusGuidance
    case outcome
    case artifacts
    case progress
    case cancelAction
    case technicalDetails
}

/// Pure, server-truth presentation rules for `TaskDetailView` (`SessionTaskDetailContent`).
/// Orders sections by the user's immediate goal for each `TaskStatus` and separates
/// low-frequency diagnostics (`taskID`, `attemptCount`, timestamps, model metadata) into
/// a collapsible Technical Details section.
enum TaskDetailPresentation {
    static func sectionOrder(
        for status: TaskStatus,
        hasArtifacts: Bool,
        hasAvailableResult: Bool = false,
        hasResultError: Bool = false
    ) -> [TaskDetailSection] {
        var sections: [TaskDetailSection] = []

        switch status {
        case .completed:
            sections.append(.outcome)
            if hasArtifacts { sections.append(.artifacts) }
            sections.append(.progress)
        case .waitingApproval:
            sections.append(.actionRequired)
            if hasArtifacts { sections.append(.artifacts) }
            sections.append(.progress)
            sections.append(.outcome)
        case .running, .queued:
            sections.append(.progress)
            if hasArtifacts { sections.append(.artifacts) }
            sections.append(.cancelAction)
            sections.append(.outcome)
        case .retryableFailed:
            sections.append(.statusGuidance)
            sections.append(.progress)
            if hasArtifacts { sections.append(.artifacts) }
            sections.append(.cancelAction)
            sections.append(.outcome)
        case .failed:
            sections.append(.statusGuidance)
            if hasAvailableResult || hasResultError {
                sections.append(.outcome)
                if hasArtifacts { sections.append(.artifacts) }
                sections.append(.progress)
            } else {
                if hasArtifacts { sections.append(.artifacts) }
                sections.append(.progress)
                sections.append(.outcome)
            }
        case .cancelled:
            sections.append(.statusGuidance)
            if hasArtifacts { sections.append(.artifacts) }
            sections.append(.progress)
            sections.append(.outcome)
        }

        sections.append(.technicalDetails)
        return sections
    }

    /// Prioritizes generated run deliverables (`.run`) ahead of user-uploaded inputs (`.user`)
    /// while preserving original server ordering within each group.
    static func orderedArtifacts(_ artifacts: [TaskArtifactItemDTO]) -> [TaskArtifactItemDTO] {
        let generated = artifacts.filter { $0.createdBy == .run }
        let userSupplied = artifacts.filter { $0.createdBy != .run }
        return generated + userSupplied
    }

    /// Extracts the latest authoritative `TaskErrorCode` reported by persisted events.
    static func latestServerErrorCode(in events: [SessionTaskEventDTO]) -> TaskErrorCode? {
        orderedEvents(events).reversed().compactMap { $0.payload.errorCode }.first
    }

    /// Returns the localized `ConversationCards` title key for the latest persisted server event.
    static func latestEventTitleKey(in events: [SessionTaskEventDTO]) -> String? {
        guard let latest = orderedEvents(events).last else { return nil }
        return ActivityEventRow.facts(for: latest.asTaskEventDTO()).titleKey
    }

    static func orderedEvents(_ events: [SessionTaskEventDTO]) -> [SessionTaskEventDTO] {
        events.enumerated()
            .sorted { left, right in
                if left.element.sequence == right.element.sequence {
                    return left.offset < right.offset
                }
                return left.element.sequence < right.element.sequence
            }
            .map(\.element)
    }
}
