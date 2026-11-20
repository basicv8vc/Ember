import Foundation

enum LocalDeviceError: Error, Equatable {
    case invalidConfiguration
    case unavailableStorage
    case invalidResponse
    case http(Int)
    case resultConflict

    var status: String {
        switch self {
        case .invalidConfiguration: "Local QA configuration required"
        case .unavailableStorage: "Local device state unavailable"
        case .invalidResponse: "Invalid response from local runtime"
        case .http(let code): "Local runtime returned HTTP \(code)"
        case .resultConflict: "Pending result conflict. The local result is retained."
        }
    }

    var canRetry: Bool {
        switch self {
        case .http(let code): code == 408 || code == 429 || code >= 500
        default: false
        }
    }
}

struct LocalDeviceConfiguration: Decodable {
    static let fileName = "local-device-qa.json"

    let origin: URL
    let accountID: UUID
    let sessionToken: String
    let accessSecret: String
    let workDelay: Duration

    private enum CodingKeys: String, CodingKey {
        case origin = "EMBER_DEVICE_RELAY_URL"
        case accountID = "EMBER_DEVICE_ACCOUNT_ID"
        case sessionToken = "EMBER_DEVICE_SESSION_TOKEN"
        case accessSecret = "EMBER_DEVICE_LOCAL_ACCESS"
        case workDelay = "EMBER_DEVICE_WORK_DELAY_MS"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let origin = try values.decode(String.self, forKey: .origin)
        let accountID = try values.decode(UUID.self, forKey: .accountID)
        let sessionToken = try values.decode(String.self, forKey: .sessionToken)
        let accessSecret = try values.decode(String.self, forKey: .accessSecret)
        let delay = try values.decodeIfPresent(Int.self, forKey: .workDelay) ?? 0
        guard let components = URLComponents(string: origin),
              let host = components.host?.lowercased(),
              components.scheme == "http",
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              let port = components.port, (1...65535).contains(port),
              Self.isLocal(host), (0...60_000).contains(delay),
              Self.isHeaderValue(sessionToken), Self.isHeaderValue(accessSecret),
              let url = URL(string: "http://\(host):\(port)")
        else { throw LocalDeviceError.invalidConfiguration }
        self.origin = url
        self.accountID = accountID
        self.sessionToken = sessionToken
        self.accessSecret = accessSecret
        self.workDelay = .milliseconds(delay)
    }

    static func load() throws -> Self {
        let file = URL.documentsDirectory.appending(path: fileName)
        do {
            let data = try Data(contentsOf: file)
            let configuration = try JSONDecoder().decode(Self.self, from: data)
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path
            )
            var protectedFile = file
            var settings = URLResourceValues()
            settings.isExcludedFromBackup = true
            try protectedFile.setResourceValues(settings)
            return configuration
        } catch {
            throw LocalDeviceError.invalidConfiguration
        }
    }

    private static func isHeaderValue(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 1_024 && value.utf8.allSatisfy { (33...126).contains($0) }
    }

    private static func isLocal(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".local") { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        let octets = parts.compactMap { UInt8($0) }
        guard parts.count == 4, octets.count == 4,
              octets.map(String.init).joined(separator: ".") == host
        else { return false }
        return octets[0] == 10 || octets[0] == 127
            || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 169 && octets[1] == 254)
    }
}
