import Foundation

/// The only domain-facing task repository surface for Features and Stores.
public protocol TaskRepositoryProtocol: Sendable {
    func createTask(
        _ request: CreateTaskRequestDTO,
        idempotencyKey: String
    ) async throws -> TaskReceiptDTO

    func fetchTask(id: UUID) async throws -> TaskDTO

    func fetchEvents(taskID: UUID, after sequence: Int?) async throws -> TaskEventPageDTO

    func cancelTask(id: UUID) async throws -> TaskCancelDTO
}
