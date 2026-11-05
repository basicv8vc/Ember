import Foundation
import Security

/// The minimal local session record needed to restore a session and reason about its expiry.
///
/// Deliberately small: an opaque Ember token plus the server ids required to recognise the session
/// after a restart. No Apple assertion, no nonce, no email, no display name, no tenant or principal
/// identifier — the server owns those and re-derives them on every bootstrap.
///
/// The token is wrapped in `EmberAccessToken`, so every textual rendering of this type is redacted
/// by construction rather than by reviewer discipline.
public struct EmberSessionRecord: Equatable, Sendable, CustomStringConvertible,
    CustomDebugStringConvertible, CustomReflectable
{
    public let sessionID: UUID
    public let consumerID: UUID
    public let accessToken: EmberAccessToken
    /// Server-declared absolute expiry (annex §5.3: 30 days).
    public let expiresAt: Date
    /// When this device wrote the record. Used only for diagnostics-free local reasoning.
    public let storedAt: Date

    public init(
        sessionID: UUID,
        consumerID: UUID,
        accessToken: EmberAccessToken,
        expiresAt: Date,
        storedAt: Date
    ) {
        self.sessionID = sessionID
        self.consumerID = consumerID
        self.accessToken = accessToken
        self.expiresAt = expiresAt
        self.storedAt = storedAt
    }

    public func isExpired(at date: Date) -> Bool {
        date >= expiresAt
    }

    /// True when the token should be rotated before it is used. A leeway keeps a request from
    /// starting with a credential that expires in flight.
    public func needsRefresh(at date: Date, leeway: TimeInterval) -> Bool {
        date.addingTimeInterval(leeway) >= expiresAt
    }

    public var description: String {
        "EmberSessionRecord(session: \(sessionID.uuidString), consumer: \(consumerID.uuidString), "
            + "token: <redacted>, expiresAt: \(expiresAt))"
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        let children: [(label: String?, value: Any)] = [
            (label: "sessionID", value: sessionID),
            (label: "consumerID", value: consumerID),
            (label: "accessToken", value: "<redacted>"),
            (label: "expiresAt", value: expiresAt),
            (label: "storedAt", value: storedAt),
        ]
        return Mirror(self, children: children, displayStyle: .struct)
    }
}

/// Storage boundary for the local session record.
///
/// Implementations must distinguish "no record" from "cannot read the record": the first is a
/// signed-out consumer, the second is not (annex §10.3).
///
/// **The API is synchronous on purpose.** The Keychain is a local, fast, synchronous facility, and an
/// `async` store would put a suspension point inside every credential commit. That is precisely the
/// window in which a logout, a new sign-in or a stale refresh could interleave with a write that had
/// already been decided — the class of defect this slice must not have. Keeping these calls
/// synchronous lets `LiveAuthSessionCoordinator` perform "check generation → write → commit" as one
/// uninterrupted actor step.
public protocol EmberSessionStore: Sendable {
    /// Returns the stored record, or `nil` when none exists.
    /// - Throws: `AuthError.keychainUnavailable` when storage exists but cannot be read,
    ///   `AuthError.storedSessionCorrupt` when a record exists and cannot be decoded.
    func load() throws -> EmberSessionRecord?

    /// Writes the record, replacing any existing value.
    func save(_ record: EmberSessionRecord) throws

    /// Atomically replaces the record after a token rotation.
    ///
    /// A rotation must never leave the store empty: if it did, a crash between "revoke old" and
    /// "write new" would silently sign the consumer out of a session the server still considers
    /// live.
    func replace(_ record: EmberSessionRecord) throws

    /// Removes the record. Idempotent: deleting an absent record is success.
    func delete() throws
}

/// Keychain-backed store for the Ember session.
///
/// Accessibility is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (ADR-0004 annex §5.1 I-8):
/// readable by a background refresh after the first unlock, never migrated to another device by a
/// backup, and never synced to iCloud Keychain. Tokens are never written to `UserDefaults`, a file,
/// the Info.plist, build settings, a URL or a log.
public final class KeychainSessionStore: EmberSessionStore {
    public struct Configuration: Sendable, Equatable {
        /// App-specific namespace. Stable, so an update finds the previous record.
        public let service: String
        /// Single account per service: L1 holds at most one session at a time.
        public let account: String

        public init(service: String, account: String) {
            self.service = service
            self.account = account
        }

        public static let live = Configuration(
            service: "com.basicv8vc.ember.session",
            account: "ember.session.v1"
        )
    }

    private let configuration: Configuration

    public init(configuration: Configuration = .live) {
        self.configuration = configuration
    }

    // MARK: - EmberSessionStore

    public func load() throws -> EmberSessionRecord? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        switch status {
        case errSecSuccess:
            guard let data = item as? Data else { throw AuthError.storedSessionCorrupt }
            return try StoredSessionPayload.decode(data)
        case errSecItemNotFound:
            return nil
        default:
            // Locked device, no passcode yet, or an unavailable keychain. Never a sign-out.
            throw AuthError.keychainUnavailable
        }
    }

    public func save(_ record: EmberSessionRecord) throws {
        let data = try StoredSessionPayload.encode(record)

        let updateStatus = SecItemUpdate(
            baseQuery as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )

        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            try add(data)
        default:
            throw AuthError.keychainUnavailable
        }
    }

    /// Rotation is one `SecItemUpdate` when a record exists. The Keychain replaces the value in
    /// place, so there is no interval in which the store holds neither the old nor the new token.
    public func replace(_ record: EmberSessionRecord) throws {
        try save(record)
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        switch status {
        case errSecSuccess, errSecItemNotFound:
            return
        default:
            throw AuthError.keychainUnavailable
        }
    }

    // MARK: - Item plumbing

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: configuration.service,
            kSecAttrAccount as String: configuration.account,
            // ThisDeviceOnly already excludes iCloud sync; the flag is explicit so a future
            // edit cannot reintroduce synchronizable storage by accident.
            kSecAttrSynchronizable as String: false,
        ]
    }

    private func add(_ data: Data) throws {
        var attributes = baseQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw AuthError.keychainUnavailable }
    }
}

/// The serialized form of a record. Internal, because nothing outside this file should be able to
/// construct a decodable shape that bypasses `EmberAccessToken` validation.
private enum StoredSessionPayload {
    private struct Payload: Codable {
        let version: Int
        let sessionID: String
        let consumerID: String
        let accessToken: String
        let expiresAt: Double
        let storedAt: Double

        enum CodingKeys: String, CodingKey {
            case version
            case sessionID = "sid"
            case consumerID = "cid"
            case accessToken = "tok"
            case expiresAt = "exp"
            case storedAt = "iat"
        }
    }

    static let version = 1

    static func encode(_ record: EmberSessionRecord) throws -> Data {
        let payload = Payload(
            version: version,
            sessionID: record.sessionID.uuidString,
            consumerID: record.consumerID.uuidString,
            accessToken: record.accessToken.rawValue,
            expiresAt: record.expiresAt.timeIntervalSince1970,
            storedAt: record.storedAt.timeIntervalSince1970
        )
        do {
            return try JSONEncoder().encode(payload)
        } catch {
            throw AuthError.keychainUnavailable
        }
    }

    static func decode(_ data: Data) throws -> EmberSessionRecord {
        let payload: Payload
        do {
            payload = try JSONDecoder().decode(Payload.self, from: data)
        } catch {
            throw AuthError.storedSessionCorrupt
        }

        guard payload.version == version,
            let sessionID = UUID(uuidString: payload.sessionID),
            let consumerID = UUID(uuidString: payload.consumerID),
            let accessToken = EmberAccessToken(payload.accessToken),
            payload.expiresAt.isFinite,
            payload.storedAt.isFinite
        else {
            throw AuthError.storedSessionCorrupt
        }

        return EmberSessionRecord(
            sessionID: sessionID,
            consumerID: consumerID,
            accessToken: accessToken,
            expiresAt: Date(timeIntervalSince1970: payload.expiresAt),
            storedAt: Date(timeIntervalSince1970: payload.storedAt)
        )
    }
}

/// Deterministic in-memory store for tests and previews. No Keychain, no disk.
///
/// The availability switch models the real failure the coordinator must survive: a locked device
/// where the credential exists but cannot be read. A lock, not an actor, so the store keeps the same
/// synchronous contract as the Keychain implementation and tests observe it without `await`.
public final class InMemoryEmberSessionStore: EmberSessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var record: EmberSessionRecord?
    private var isUnavailable = false
    private var deleteFailure: AuthError?

    private var loadCalls = 0
    private var saveCalls = 0
    private var replaceCalls = 0
    private var deleteCalls = 0

    public init(initialRecord: EmberSessionRecord? = nil) {
        self.record = initialRecord
    }

    public var loadCount: Int { lock.withLock { loadCalls } }
    public var saveCount: Int { lock.withLock { saveCalls } }
    public var replaceCount: Int { lock.withLock { replaceCalls } }
    public var deleteCount: Int { lock.withLock { deleteCalls } }

    public func setUnavailable(_ unavailable: Bool) {
        lock.withLock { isUnavailable = unavailable }
    }

    public func setDeleteFailure(_ error: AuthError?) {
        lock.withLock { deleteFailure = error }
    }

    public func seed(_ record: EmberSessionRecord?) {
        lock.withLock { self.record = record }
    }

    public func currentRecord() -> EmberSessionRecord? {
        lock.withLock { record }
    }

    public func load() throws -> EmberSessionRecord? {
        try lock.withLock {
            loadCalls += 1
            if isUnavailable { throw AuthError.keychainUnavailable }
            return record
        }
    }

    public func save(_ record: EmberSessionRecord) throws {
        try lock.withLock {
            saveCalls += 1
            if isUnavailable { throw AuthError.keychainUnavailable }
            self.record = record
        }
    }

    public func replace(_ record: EmberSessionRecord) throws {
        try lock.withLock {
            replaceCalls += 1
            if isUnavailable { throw AuthError.keychainUnavailable }
            self.record = record
        }
    }

    public func delete() throws {
        try lock.withLock {
            deleteCalls += 1
            if let deleteFailure { throw deleteFailure }
            if isUnavailable { throw AuthError.keychainUnavailable }
            record = nil
        }
    }
}
