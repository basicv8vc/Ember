import Foundation
import Observation

@MainActor @Observable
final class PersonalMemoryStore {
    private let repository: (any PersonalMemoryRepositoryProtocol)?
    private var generation: UInt64 = 0

    private(set) var items: [PersonalMemoryItemDTO] = []
    private(set) var limits: PersonalMemoryLimitsDTO = .default
    private(set) var isLoading = false
    private(set) var isSaving = false
    private(set) var deletingIDs: Set<UUID> = []
    private(set) var isEndpointUnavailable = false
    private(set) var errorMessage: String?

    init(repository: (any PersonalMemoryRepositoryProtocol)? = nil) {
        self.repository = repository
    }

    var hasRepository: Bool { repository != nil }
    var isMockOnly: Bool { repository?.isMockOnly ?? false }
    var isAtCapacity: Bool { items.count >= limits.maxItems }

    func refresh() async {
        guard let repository else { return }
        let startGeneration = generation
        isLoading = true
        errorMessage = nil
        isEndpointUnavailable = false
        defer {
            if generation == startGeneration {
                isLoading = false
            }
        }

        do {
            let list = try await repository.listMemories()
            guard generation == startGeneration else { return }
            items = Self.sortItems(list.items)
            limits = list.limits
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch PersonalMemoryRepositoryError.endpointNotReady {
            guard generation == startGeneration else { return }
            isEndpointUnavailable = true
            errorMessage = nil
        } catch {
            guard generation == startGeneration else { return }
            errorMessage = Self.localizedMessage(for: error)
        }
    }

    @discardableResult
    func save(kind: PersonalMemoryKind, content: String, key: String? = nil) async -> Bool {
        guard let repository, !isSaving else { return false }
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= limits.maxContentChars else {
            errorMessage = String(localized: "memory.error.invalid_input", table: "Conversation")
            return false
        }

        let startGeneration = generation
        isSaving = true
        errorMessage = nil
        defer {
            if generation == startGeneration {
                isSaving = false
            }
        }

        let normalizedKey = key?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let request = SavePersonalMemoryRequestDTO(
            kind: kind,
            content: trimmed,
            key: normalizedKey?.isEmpty == false ? normalizedKey : nil,
            provenance: PersonalMemoryProvenanceDTO(source: .userSettings)
        )

        do {
            let result = try await repository.saveMemory(request)
            guard generation == startGeneration else { return false }
            upsertLocalItem(result.item)
            isEndpointUnavailable = false
            errorMessage = nil
            return true
        } catch is CancellationError {
            return false
        } catch PersonalMemoryRepositoryError.endpointNotReady {
            guard generation == startGeneration else { return false }
            isEndpointUnavailable = true
            errorMessage = nil
            return false
        } catch {
            guard generation == startGeneration else { return false }
            errorMessage = Self.localizedMessage(for: error)
            return false
        }
    }

    func delete(id: UUID) async {
        guard let repository, !deletingIDs.contains(id) else { return }
        let startGeneration = generation
        deletingIDs.insert(id)
        errorMessage = nil
        defer {
            if generation == startGeneration {
                deletingIDs.remove(id)
            }
        }

        do {
            _ = try await repository.deleteMemory(id: id)
            guard generation == startGeneration else { return }
            items.removeAll { $0.memoryID == id }
        } catch is CancellationError {
            return
        } catch PersonalMemoryRepositoryError.notFound {
            guard generation == startGeneration else { return }
            items.removeAll { $0.memoryID == id }
        } catch {
            guard generation == startGeneration else { return }
            errorMessage = Self.localizedMessage(for: error)
        }
    }

    func clear() {
        generation &+= 1
        items.removeAll()
        limits = .default
        isLoading = false
        isSaving = false
        deletingIDs.removeAll()
        isEndpointUnavailable = false
        errorMessage = nil
    }

    private func upsertLocalItem(_ item: PersonalMemoryItemDTO) {
        if let index = items.firstIndex(where: { $0.memoryID == item.memoryID }) {
            items[index] = item
        } else {
            items.insert(item, at: 0)
        }
        items = Self.sortItems(items)
    }

    private static func sortItems(_ source: [PersonalMemoryItemDTO]) -> [PersonalMemoryItemDTO] {
        source.sorted { lhs, rhs in
            if lhs.updatedDate != rhs.updatedDate {
                return lhs.updatedDate > rhs.updatedDate
            }
            return lhs.memoryID.uuidString < rhs.memoryID.uuidString
        }
    }

    private static func localizedMessage(for error: Error) -> String {
        switch error as? PersonalMemoryRepositoryError {
        case .limitReached:
            String(localized: "memory.error.limit_reached", table: "Conversation")
        case .invalidInput:
            String(localized: "memory.error.invalid_input", table: "Conversation")
        case .unauthenticated:
            String(localized: "memory.error.unauthenticated", table: "Conversation")
        default:
            String(localized: "memory.error.unavailable", table: "Conversation")
        }
    }
}
