import Foundation

/// A validated opaque Ember session token.
///
/// The wire schema restricts the token to `ems_` followed by unreserved characters
/// (ADR-0004 annex §5.1 I-5). Validating at the decode boundary means a truncated or HTML error
/// page that happens to parse as JSON can never be installed as a credential later.
///
/// The wrapper exists so redaction is a property of the type rather than a habit at each call
/// site: `description`, `debugDescription` and `Mirror` never contain the token.
public struct EmberAccessToken: Equatable, Sendable, CustomStringConvertible,
    CustomDebugStringConvertible, CustomReflectable
{
    /// `ems_` plus at least one unreserved character, bounded so a hostile body cannot make a
    /// multi-megabyte "token".
    public static let maximumLength = 4_096
    private static let prefix = "ems_"

    public let rawValue: String

    public init?(_ candidate: String) {
        guard candidate.count > Self.prefix.count, candidate.count <= Self.maximumLength else {
            return nil
        }
        guard candidate.hasPrefix(Self.prefix) else { return nil }

        let remainder = candidate.dropFirst(Self.prefix.count)
        guard remainder.allSatisfy(Self.isUnreserved) else { return nil }
        self.rawValue = candidate
    }

    private static func isUnreserved(_ character: Character) -> Bool {
        guard character.isASCII else { return false }
        return character.isLetter || character.isNumber || character == "_" || character == "-"
    }

    public var description: String { "EmberAccessToken(<redacted>)" }
    public var debugDescription: String { description }

    public var customMirror: Mirror {
        Mirror(self, children: [(label: "rawValue", value: "<redacted>")], displayStyle: .struct)
    }
}

/// `POST /v1/auth/session` response (201). Frozen shape — exactly four fields, no tenant,
/// principal or policy identifiers (ADR-0004 annex §5.2).
public struct EmberSessionResponseDTO: Equatable, Sendable {
    public let sessionID: UUID
    public let consumerID: UUID
    public let accessToken: EmberAccessToken
    public let expiresAt: Date

    public init(sessionID: UUID, consumerID: UUID, accessToken: EmberAccessToken, expiresAt: Date) {
        self.sessionID = sessionID
        self.consumerID = consumerID
        self.accessToken = accessToken
        self.expiresAt = expiresAt
    }
}

/// `GET /v1/me` response (200). Every field is server-authoritative; nothing here is ever
/// synthesised locally (ADR-0004 annex §5.4, I-4).
public struct EmberMeDTO: Equatable, Sendable {
    public struct Agent: Equatable, Sendable {
        public let agentID: UUID
        public let displayName: String
    }

    public struct Conversation: Equatable, Sendable {
        public let conversationID: UUID
        /// Server-owned deletion generation. Echoed on every send and refreshed by this call.
        public let transcriptEpoch: Int
        public let createdAt: Date
        public let updatedAt: Date
    }

    public let consumerID: UUID
    public let agent: Agent
    public let conversation: Conversation
}

/// `POST /v1/auth/session` request body. The provider is fixed to `apple`: `dev` is a
/// non-production server-only path (§5.5) and is never emitted by this client.
struct EmberSessionCreateRequest: Encodable, Sendable {
    let provider: String
    let identityToken: String
    let nonce: String

    enum CodingKeys: String, CodingKey {
        case provider
        case identityToken = "identity_token"
        case nonce
    }

    static func apple(identityToken: String, nonce: String) -> Self {
        Self(provider: "apple", identityToken: identityToken, nonce: nonce)
    }
}

// MARK: - Strict decoding

/// A coding key for reject-unknown-field decoding. The frozen schemas are `strictObject`s, so a
/// response carrying an unexpected field is a contract violation rather than a superset to ignore.
struct EmberWireKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

enum EmberWireValidation {
    static func rejectUnknownKeys(
        _ keys: [EmberWireKey],
        allowed: Set<String>,
        in type: String
    ) throws {
        for key in keys where !allowed.contains(key.stringValue) {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: [],
                    debugDescription: "unexpected field in \(type) response"
                )
            )
        }
    }

    static func object(
        _ container: KeyedDecodingContainer<EmberWireKey>,
        _ key: String
    ) throws -> KeyedDecodingContainer<EmberWireKey> {
        try container.nestedContainer(keyedBy: EmberWireKey.self, forKey: EmberWireKey(stringValue: key)!)
    }

    static func uuid(
        _ container: KeyedDecodingContainer<EmberWireKey>,
        _ key: String
    ) throws -> UUID {
        let raw = try container.decode(String.self, forKey: EmberWireKey(stringValue: key)!)
        guard let value = UUID(uuidString: raw) else { throw malformed(key) }
        return value
    }

    static func timestamp(
        _ container: KeyedDecodingContainer<EmberWireKey>,
        _ key: String
    ) throws -> Date {
        let raw = try container.decode(String.self, forKey: EmberWireKey(stringValue: key)!)
        guard let value = EmberWireDate.parse(raw) else { throw malformed(key) }
        return value
    }

    static func malformed(_ field: String) -> DecodingError {
        DecodingError.dataCorrupted(
            .init(codingPath: [], debugDescription: "malformed field \(field)")
        )
    }
}

/// RFC 3339 with a mandatory offset, matching `z.iso.datetime({ offset: true })`.
///
/// Formatters are created per call rather than cached in a static: auth responses are few, and a
/// shared mutable `ISO8601DateFormatter` would need unsafe global state to satisfy concurrency
/// checking.
enum EmberWireDate {
    static func parse(_ raw: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: raw) { return date }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }
}

extension EmberSessionResponseDTO: Decodable {
    private static let allowedKeys: Set<String> = [
        "session_id", "consumer_id", "access_token", "expires_at",
    ]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: EmberWireKey.self)
        try EmberWireValidation.rejectUnknownKeys(
            container.allKeys,
            allowed: Self.allowedKeys,
            in: "session"
        )

        let token = try container.decode(
            String.self,
            forKey: EmberWireKey(stringValue: "access_token")!
        )
        guard let accessToken = EmberAccessToken(token) else {
            throw EmberWireValidation.malformed("access_token")
        }

        self.init(
            sessionID: try EmberWireValidation.uuid(container, "session_id"),
            consumerID: try EmberWireValidation.uuid(container, "consumer_id"),
            accessToken: accessToken,
            expiresAt: try EmberWireValidation.timestamp(container, "expires_at")
        )
    }
}

extension EmberMeDTO: Decodable {
    private static let allowedKeys: Set<String> = ["consumer_id", "agent", "conversation"]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: EmberWireKey.self)
        try EmberWireValidation.rejectUnknownKeys(
            container.allKeys,
            allowed: Self.allowedKeys,
            in: "me"
        )

        let agentContainer = try EmberWireValidation.object(container, "agent")
        try EmberWireValidation.rejectUnknownKeys(
            agentContainer.allKeys,
            allowed: ["agent_id", "display_name"],
            in: "me.agent"
        )

        let displayName = try agentContainer.decode(
            String.self,
            forKey: EmberWireKey(stringValue: "display_name")!
        )
        guard (1...128).contains(displayName.count) else {
            throw EmberWireValidation.malformed("display_name")
        }

        let conversationContainer = try EmberWireValidation.object(container, "conversation")
        try EmberWireValidation.rejectUnknownKeys(
            conversationContainer.allKeys,
            allowed: ["conversation_id", "transcript_epoch", "created_at", "updated_at"],
            in: "me.conversation"
        )

        let epoch = try conversationContainer.decode(
            Int.self,
            forKey: EmberWireKey(stringValue: "transcript_epoch")!
        )
        guard epoch >= 0 else { throw EmberWireValidation.malformed("transcript_epoch") }

        self.init(
            consumerID: try EmberWireValidation.uuid(container, "consumer_id"),
            agent: Agent(
                agentID: try EmberWireValidation.uuid(agentContainer, "agent_id"),
                displayName: displayName
            ),
            conversation: Conversation(
                conversationID: try EmberWireValidation.uuid(conversationContainer, "conversation_id"),
                transcriptEpoch: epoch,
                createdAt: try EmberWireValidation.timestamp(conversationContainer, "created_at"),
                updatedAt: try EmberWireValidation.timestamp(conversationContainer, "updated_at")
            )
        )
    }
}
