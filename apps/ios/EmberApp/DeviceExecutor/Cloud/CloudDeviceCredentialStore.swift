import CryptoKit
import Foundation
import Security

/// Device identity and 32-byte random secret (`64` lowercase hex chars) presented via `X-Device-Token`.
public struct CloudDeviceCredential: Codable, Equatable, Sendable {
    public let id: UUID
    public let token: String

    public init(id: UUID, token: String) {
        self.id = id
        self.token = token
    }

    public var normalizedDeviceID: String {
        id.uuidString.lowercased()
    }

    public var isValidTokenFormat: Bool {
        token.count == 64 && token.utf8.allSatisfy { byte in
            (0x30...0x39).contains(byte) || (0x61...0x66).contains(byte)
        }
    }

    public static func generate() throws -> CloudDeviceCredential {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer in
            guard let baseAddress = buffer.baseAddress else { return errSecAllocate }
            return SecRandomCopyBytes(kSecRandomDefault, buffer.count, baseAddress)
        }
        guard status == errSecSuccess else {
            throw CloudDeviceError.unavailableStorage
        }
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        return CloudDeviceCredential(id: UUID(), token: hex)
    }
}

public protocol CloudDeviceCredentialStoring: Sendable {
    func loadOrCreateCredential(for scopeIdentifier: String) throws -> CloudDeviceCredential
    func resetCredential(for scopeIdentifier: String) throws
}

/// Keychain-backed credential store scoped by SHA-256 of `(origin, accountID)`.
public struct KeychainCloudDeviceCredentialStore: CloudDeviceCredentialStoring {
    private let service: String

    public init(service: String = "com.basicv8vc.ember.cloud-device-adapter") {
        self.service = service
    }

    public func loadOrCreateCredential(for scopeIdentifier: String) throws -> CloudDeviceCredential {
        let accountKey = Self.scopeDigest(scopeIdentifier)
        if let existing = try loadCredential(accountKey: accountKey) {
            return existing
        }

        let created = try CloudDeviceCredential.generate()
        var item = queryDictionary(accountKey: accountKey)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        item[kSecValueData as String] = try JSONEncoder().encode(created)

        let added = SecItemAdd(item as CFDictionary, nil)
        if added == errSecDuplicateItem, let existing = try loadCredential(accountKey: accountKey) {
            return existing
        }
        guard added == errSecSuccess else {
            throw CloudDeviceError.unavailableStorage
        }
        return created
    }

    public func resetCredential(for scopeIdentifier: String) throws {
        let accountKey = Self.scopeDigest(scopeIdentifier)
        let status = SecItemDelete(queryDictionary(accountKey: accountKey) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CloudDeviceError.unavailableStorage
        }
    }

    private func loadCredential(accountKey: String) throws -> CloudDeviceCredential? {
        var query = queryDictionary(accountKey: accountKey)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = result as? Data else {
            throw CloudDeviceError.unavailableStorage
        }
        let decoded = try JSONDecoder().decode(CloudDeviceCredential.self, from: data)
        guard decoded.isValidTokenFormat else {
            throw CloudDeviceError.unavailableStorage
        }
        return decoded
    }

    private func queryDictionary(accountKey: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountKey,
        ]
    }

    public static func scopeDigest(_ scopeIdentifier: String) -> String {
        DeviceSandboxCrypto.sha256Hex(Data(scopeIdentifier.utf8))
    }
}

/// Deterministic file-backed or in-memory store for isolated unit tests without touching shared Keychain.
public actor InMemoryCloudDeviceCredentialStore: CloudDeviceCredentialStoring {
    private let lock = NSLock()
    private nonisolated(unsafe) var byScope: [String: CloudDeviceCredential] = [:]

    public init(preseeded: [String: CloudDeviceCredential] = [:]) {
        self.byScope = preseeded
    }

    public nonisolated func loadOrCreateCredential(for scopeIdentifier: String) throws -> CloudDeviceCredential {
        lock.lock()
        defer { lock.unlock() }
        if let existing = byScope[scopeIdentifier] {
            return existing
        }
        let created = try CloudDeviceCredential.generate()
        byScope[scopeIdentifier] = created
        return created
    }

    public nonisolated func resetCredential(for scopeIdentifier: String) throws {
        lock.lock()
        defer { lock.unlock() }
        byScope.removeValue(forKey: scopeIdentifier)
    }
}
