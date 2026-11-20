import CryptoKit
import Foundation
import Security

struct LocalDeviceCredential: Codable {
    let id: UUID
    let token: String
}

struct LocalDevicePendingResult: Codable {
    let taskID: UUID
    let submission: LocalDeviceSubmission
}

struct LocalDeviceState {
    private let service = "com.basicv8vc.ember.local-device-adapter"
    private let key: String
    private let pendingFile: URL

    init(configuration: LocalDeviceConfiguration, root: URL = .applicationSupportDirectory) throws {
        let scope = "\(configuration.origin.absoluteString)|\(configuration.accountID.uuidString)"
        let key = Self.hex(SHA256.hash(data: Data(scope.utf8)))
        let directory = root.appending(path: "DeviceExecution", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        var excludedDirectory = directory
        var settings = URLResourceValues()
        settings.isExcludedFromBackup = true
        try excludedDirectory.setResourceValues(settings)
        self.key = key
        self.pendingFile = directory.appending(path: "\(key).json")
    }

    func loadOrCreateCredential() throws -> LocalDeviceCredential {
        if let credential = try loadCredential() { return credential }
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw LocalDeviceError.unavailableStorage }

        let credential = LocalDeviceCredential(id: UUID(), token: Self.hex(bytes))
        var item = keychainQuery
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        item[kSecValueData as String] = try JSONEncoder().encode(credential)
        let added = SecItemAdd(item as CFDictionary, nil)
        if added == errSecDuplicateItem, let existing = try loadCredential() { return existing }
        guard added == errSecSuccess else { throw LocalDeviceError.unavailableStorage }
        return credential
    }

    private func loadCredential() throws -> LocalDeviceCredential? {
        var query = keychainQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw LocalDeviceError.unavailableStorage
        }
        return try JSONDecoder().decode(LocalDeviceCredential.self, from: data)
    }

    private var keychainQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    func loadPending() throws -> LocalDevicePendingResult? {
        do {
            let data = try Data(contentsOf: pendingFile)
            return try JSONDecoder().decode(LocalDevicePendingResult.self, from: data)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return nil
        }
    }

    func savePending(_ pending: LocalDevicePendingResult) throws {
        try JSONEncoder().encode(pending).write(
            to: pendingFile, options: [.atomic, .completeFileProtection]
        )
    }

    func submitPending(
        _ pending: LocalDevicePendingResult,
        using submit: (LocalDevicePendingResult) async throws -> LocalDeviceClient.Result
    ) async throws -> LocalDeviceClient.Result {
        // Keep the original fence until a matching ACK or an explicit lost-fence response.
        let result = try await submit(pending)
        try Task.checkCancellation()
        try FileManager.default.removeItem(at: pendingFile)
        return result
    }

    private static func hex(_ bytes: some Sequence<UInt8>) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}
