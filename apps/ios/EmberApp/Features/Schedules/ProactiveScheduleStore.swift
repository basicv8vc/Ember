import Foundation
import Observation

@MainActor @Observable
final class ProactiveScheduleStore {
    private let repository: (any ProactiveScheduleRepositoryProtocol)?
    private var generation: UInt64 = 0

    private(set) var schedules: [ProactiveScheduleDTO] = []
    private(set) var isLoading = false
    private(set) var isCreating = false
    private(set) var mutatingIDs: Set<UUID> = []
    private(set) var endpointAvailability: CloudEndpointAvailability = .unknown
    private(set) var errorMessage: String?

    init(repository: (any ProactiveScheduleRepositoryProtocol)? = nil) {
        self.repository = repository
    }

    var hasRepository: Bool { repository != nil }
    var isEndpointUnavailable: Bool { endpointAvailability == .unavailable }
    var isMockOnly: Bool { repository?.isMockOnly ?? false }

    var activeCount: Int {
        schedules.filter { $0.status == .active }.count
    }

    var hasInFlightRun: Bool {
        schedules.contains {
            let status = $0.latestRun?.status
            return status == "queued" || status == "running"
        }
    }

    var nextActiveFireDate: Date? {
        schedules
            .filter { $0.status == .active }
            .compactMap { $0.nextFireAt.flatMap(ConversationCardFormatting.date(from:)) }
            .min()
    }

    func refresh() async {
        guard let repository else { return }
        let startGeneration = generation
        isLoading = true
        errorMessage = nil
        if endpointAvailability == .unavailable {
            endpointAvailability = .unknown
        }
        defer {
            if generation == startGeneration {
                isLoading = false
            }
        }

        do {
            let list = try await repository.listSchedules()
            guard generation == startGeneration else { return }
            schedules = Self.sortSchedules(list.schedules)
            endpointAvailability = .available
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch ProactiveScheduleRepositoryError.endpointNotReady {
            guard generation == startGeneration else { return }
            endpointAvailability = .unavailable
            errorMessage = nil
        } catch {
            guard generation == startGeneration else { return }
            errorMessage = Self.localizedMessage(for: error)
        }
    }

    @discardableResult
    func create(_ request: CreateProactiveScheduleRequestDTO) async -> Bool {
        guard let repository, !isCreating else { return false }
        let startGeneration = generation
        isCreating = true
        errorMessage = nil
        defer {
            if generation == startGeneration {
                isCreating = false
            }
        }

        do {
            let created = try await repository.createSchedule(request)
            guard generation == startGeneration else { return false }
            upsertLocal(created)
            endpointAvailability = .available
            errorMessage = nil
            return true
        } catch is CancellationError {
            return false
        } catch ProactiveScheduleRepositoryError.endpointNotReady {
            guard generation == startGeneration else { return false }
            endpointAvailability = .unavailable
            errorMessage = nil
            return false
        } catch ProactiveScheduleRepositoryError.policyDenied {
            guard generation == startGeneration else { return false }
            errorMessage = Self.isRecurringModelBrief(request)
                ? String(localized: "schedules.error.policy_denied", table: "Conversation")
                : String(localized: "schedules.error.policy_denied_generic", table: "Conversation")
            return false
        } catch {
            guard generation == startGeneration else { return false }
            errorMessage = Self.localizedMessage(for: error)
            return false
        }
    }

    func pause(id: UUID) async {
        await runMutation(id: id) { try await $0.pauseSchedule(id: id) }
    }

    func resume(id: UUID) async {
        let target = schedules.first { $0.scheduleId == id }
        let isRecurringBrief = target.map { $0.scheduleKind != .once && $0.deliveryMode == .modelBrief } ?? false
        await runMutation(id: id, isRecurringBriefPolicyTarget: isRecurringBrief) {
            try await $0.resumeSchedule(id: id)
        }
    }

    func cancel(id: UUID) async {
        await runMutation(id: id) { try await $0.cancelSchedule(id: id) }
    }

    func clear() {
        generation &+= 1
        schedules.removeAll()
        isLoading = false
        isCreating = false
        mutatingIDs.removeAll()
        endpointAvailability = .unknown
        errorMessage = nil
    }

    private func runMutation(
        id: UUID,
        isRecurringBriefPolicyTarget: Bool = false,
        operation: (any ProactiveScheduleRepositoryProtocol) async throws -> ProactiveScheduleDTO
    ) async {
        guard let repository, !mutatingIDs.contains(id) else { return }
        let startGeneration = generation
        mutatingIDs.insert(id)
        errorMessage = nil
        defer {
            if generation == startGeneration {
                mutatingIDs.remove(id)
            }
        }

        do {
            let updated = try await operation(repository)
            guard generation == startGeneration else { return }
            upsertLocal(updated)
        } catch is CancellationError {
            return
        } catch ProactiveScheduleRepositoryError.policyDenied {
            guard generation == startGeneration else { return }
            errorMessage = isRecurringBriefPolicyTarget
                ? String(localized: "schedules.error.policy_denied", table: "Conversation")
                : String(localized: "schedules.error.policy_denied_generic", table: "Conversation")
        } catch {
            guard generation == startGeneration else { return }
            errorMessage = Self.localizedMessage(for: error)
        }
    }

    private func upsertLocal(_ schedule: ProactiveScheduleDTO) {
        if let index = schedules.firstIndex(where: { $0.scheduleId == schedule.scheduleId }) {
            schedules[index] = schedule
        } else {
            schedules.insert(schedule, at: 0)
        }
        schedules = Self.sortSchedules(schedules)
    }

    private static func sortSchedules(_ source: [ProactiveScheduleDTO]) -> [ProactiveScheduleDTO] {
        source.sorted { lhs, rhs in
            let lhsRank = sortRank(lhs.status)
            let rhsRank = sortRank(rhs.status)
            if lhsRank != rhsRank {
                return lhsRank < rhsRank
            }
            if lhs.updatedDate != rhs.updatedDate {
                return lhs.updatedDate > rhs.updatedDate
            }
            return lhs.scheduleId.uuidString < rhs.scheduleId.uuidString
        }
    }

    private static func sortRank(_ status: ProactiveScheduleStatus) -> Int {
        switch status {
        case .active: 0
        case .paused: 1
        case .completed: 2
        case .cancelled: 3
        }
    }

    private static func localizedMessage(for error: Error) -> String {
        switch error as? ProactiveScheduleRepositoryError {
        case .invalidInput:
            String(localized: "schedules.error.invalid_input", table: "Conversation")
        case .limitReached:
            String(localized: "schedules.error.limit_reached", table: "Conversation")
        case .conflict:
            String(localized: "schedules.error.conflict", table: "Conversation")
        case .unauthenticated:
            String(localized: "schedules.error.unauthenticated", table: "Conversation")
        case .recurringBriefDisabled:
            String(localized: "schedules.error.policy_denied", table: "Conversation")
        case .policyDenied:
            String(localized: "schedules.error.policy_denied_generic", table: "Conversation")
        default:
            String(localized: "schedules.error.unavailable", table: "Conversation")
        }
    }

    private static func isRecurringModelBrief(_ request: CreateProactiveScheduleRequestDTO) -> Bool {
        let resolvedMode = request.deliveryMode ?? (request.kind == .brief ? .modelBrief : .directReminder)
        guard resolvedMode == .modelBrief else { return false }
        if case .once = request.trigger {
            return false
        }
        return true
    }
}
