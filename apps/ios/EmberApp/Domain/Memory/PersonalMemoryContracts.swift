import Foundation

public enum PersonalMemoryKind: String, Codable, CaseIterable, Hashable, Sendable {
    case preference
    case fact
}

public enum PersonalMemorySource: String, Codable, Hashable, Sendable {
    case explicitUserRequest = "explicit_user_request"
    case userSettings = "user_settings"
}

public struct PersonalMemoryProvenanceDTO: Equatable, Codable, Sendable {
    public let source: PersonalMemorySource
    public let conversationID: UUID?
    public let messageID: UUID?

    private enum CodingKeys: String, CodingKey {
        case source
        case conversationID = "conversation_id"
        case messageID = "message_id"
    }

    public init(
        source: PersonalMemorySource,
        conversationID: UUID? = nil,
        messageID: UUID? = nil
    ) {
        self.source = source
        self.conversationID = conversationID
        self.messageID = messageID
    }
}

public struct PersonalMemoryItemDTO: Identifiable, Equatable, Codable, Sendable {
    public let memoryID: UUID
    public let kind: PersonalMemoryKind
    public let key: String?
    public let content: String
    public let provenance: PersonalMemoryProvenanceDTO
    public let createdAt: String
    public let updatedAt: String

    public var id: UUID { memoryID }

    private enum CodingKeys: String, CodingKey {
        case memoryID = "memory_id"
        case kind
        case key
        case content
        case provenance
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    public init(
        memoryID: UUID,
        kind: PersonalMemoryKind,
        key: String? = nil,
        content: String,
        provenance: PersonalMemoryProvenanceDTO,
        createdAt: String,
        updatedAt: String
    ) {
        self.memoryID = memoryID
        self.kind = kind
        self.key = key
        self.content = content
        self.provenance = provenance
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var updatedDate: Date {
        EmberWireDate.parse(updatedAt) ?? .distantPast
    }
}

public struct PersonalMemoryLimitsDTO: Equatable, Codable, Sendable {
    public static let `default` = PersonalMemoryLimitsDTO(maxItems: 50, maxContentChars: 500)

    public let maxItems: Int
    public let maxContentChars: Int

    private enum CodingKeys: String, CodingKey {
        case maxItems = "max_items"
        case maxContentChars = "max_content_chars"
    }

    public init(maxItems: Int, maxContentChars: Int) {
        self.maxItems = maxItems
        self.maxContentChars = maxContentChars
    }
}

public struct PersonalMemoryListDTO: Equatable, Codable, Sendable {
    public let items: [PersonalMemoryItemDTO]
    public let limits: PersonalMemoryLimitsDTO

    public init(items: [PersonalMemoryItemDTO], limits: PersonalMemoryLimitsDTO = .default) {
        self.items = items
        self.limits = limits
    }
}

public struct SavePersonalMemoryRequestDTO: Equatable, Encodable, Sendable {
    public let kind: PersonalMemoryKind
    public let content: String
    public let key: String?
    public let provenance: PersonalMemoryProvenanceDTO

    public init(
        kind: PersonalMemoryKind,
        content: String,
        key: String? = nil,
        provenance: PersonalMemoryProvenanceDTO
    ) {
        self.kind = kind
        self.content = content
        self.key = key
        self.provenance = provenance
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case content
        case key
        case provenance
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(content, forKey: .content)
        if let key {
            try container.encode(key, forKey: .key)
        }
        try container.encode(provenance, forKey: .provenance)
    }
}

public struct PersonalMemorySaveResultDTO: Equatable, Codable, Sendable {
    public let item: PersonalMemoryItemDTO
    public let created: Bool

    public init(item: PersonalMemoryItemDTO, created: Bool) {
        self.item = item
        self.created = created
    }
}

public struct PersonalMemoryDeleteResultDTO: Equatable, Codable, Sendable {
    public let deleted: Bool
    public let memoryID: UUID

    private enum CodingKeys: String, CodingKey {
        case deleted
        case memoryID = "memory_id"
    }

    public init(deleted: Bool, memoryID: UUID) {
        self.deleted = deleted
        self.memoryID = memoryID
    }
}

public enum PersonalMemoryRepositoryError: Error, Equatable, Sendable {
    case unauthenticated
    case notFound
    case endpointNotReady
    case limitReached
    case invalidInput
    case unavailable
    case invalidResponse
}

public protocol PersonalMemoryRepositoryProtocol: Sendable {
    var isMockOnly: Bool { get }
    func listMemories() async throws -> PersonalMemoryListDTO
    func saveMemory(_ request: SavePersonalMemoryRequestDTO) async throws -> PersonalMemorySaveResultDTO
    func deleteMemory(id: UUID) async throws -> PersonalMemoryDeleteResultDTO
}
