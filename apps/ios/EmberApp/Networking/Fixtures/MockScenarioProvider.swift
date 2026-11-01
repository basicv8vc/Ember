import Foundation

public enum MockScenarioID: String, Codable, CaseIterable, Sendable {
    case receipt
    case queued
    case running
    case completed
    case missingResult = "missing_result"
    case disconnectedReconnected = "disconnected_reconnected"
    case cancelRace = "cancel_race"
    case approvalUnavailable = "approval_unavailable"
}

public enum MockApprovalAvailability: String, Codable, Sendable {
    case notApplicable = "not_applicable"
    case available
    case unavailable
}

/// A readable mock outcome may appear only inside this explicitly fixture-only container.
public struct MockOutcomeFixture: Codable, Equatable, Sendable {
    public let label: String
    public let content: String
}

public struct MockTaskScenarioFixture: Codable, Equatable, Sendable {
    public let scenarioID: MockScenarioID
    public let receipt: TaskReceiptDTO?
    public let task: TaskDTO?
    public let events: [TaskEventDTO]
    public let cancelResponse: TaskCancelDTO?
    public let snapshotAfterCancel: TaskDTO?
    public let eventAfterCancel: TaskEventDTO?
    public let approvalAvailability: MockApprovalAvailability
    public let presentationStates: [TaskPresentationState]
    public let outcomeFixture: MockOutcomeFixture?

    enum CodingKeys: String, CodingKey {
        case scenarioID = "scenario_id"
        case receipt
        case task
        case events
        case cancelResponse = "cancel_response"
        case snapshotAfterCancel = "snapshot_after_cancel"
        case eventAfterCancel = "event_after_cancel"
        case approvalAvailability = "approval_availability"
        case presentationStates = "presentation_states"
        case outcomeFixture = "outcome_fixture"
    }
}

public enum MockScenarioProviderError: Error, Equatable {
    case missingFixture(MockScenarioID)
    case invalidFixture(MockScenarioID)
}

public protocol MockScenarioProvider: Sendable {
    func load(_ scenarioID: MockScenarioID) throws -> MockTaskScenarioFixture
}

private final class MockScenarioBundleToken: NSObject {}

/// Loads deterministic JSON resources copied into the app bundle by the synchronized group.
public struct BundledMockScenarioProvider: MockScenarioProvider {
    public init() {}

    public func load(_ scenarioID: MockScenarioID) throws -> MockTaskScenarioFixture {
        let data = try fixtureData(named: scenarioID.rawValue)
        do {
            let scenario = try JSONDecoder().decode(MockTaskScenarioFixture.self, from: data)
            guard scenario.scenarioID == scenarioID else {
                throw MockScenarioProviderError.invalidFixture(scenarioID)
            }
            return scenario
        } catch {
            throw MockScenarioProviderError.invalidFixture(scenarioID)
        }
    }

    public func loadApprovalFixture() throws -> ApprovalDTO {
        do {
            return try JSONDecoder().decode(ApprovalDTO.self, from: fixtureData(named: "approval_pending"))
        } catch {
            throw MockScenarioProviderError.invalidFixture(.approvalUnavailable)
        }
    }

    private func fixtureData(named name: String) throws -> Data {
        let bundles = [Bundle(for: MockScenarioBundleToken.self), Bundle.main]
        let subdirectories: [String?] = [nil, "Networking/Fixtures", "Fixtures"]
        let url = bundles.lazy
            .flatMap { bundle in
                subdirectories.compactMap {
                    bundle.url(forResource: name, withExtension: "json", subdirectory: $0)
                }
            }
            .first
        guard let url else {
            throw MockScenarioProviderError.missingFixture(
                MockScenarioID(rawValue: name) ?? .approvalUnavailable
            )
        }
        return try Data(contentsOf: url)
    }
}
