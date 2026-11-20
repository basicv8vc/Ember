import Foundation
import Observation

/// QA file schema compatible with Agent F's M2-F2 `local-device-qa.json` in the app's Documents folder.
public struct CloudDeviceQAFileConfiguration: Decodable, Sendable {
    public static let defaultFileName = "local-device-qa.json"

    public let origin: URL
    public let accountID: UUID
    public let sessionToken: String
    public let localAccessSecret: String
    public let workDelayMs: Int

    private enum CodingKeys: String, CodingKey {
        case origin = "EMBER_DEVICE_RELAY_URL"
        case accountID = "EMBER_DEVICE_ACCOUNT_ID"
        case sessionToken = "EMBER_DEVICE_SESSION_TOKEN"
        case localAccessSecret = "EMBER_DEVICE_LOCAL_ACCESS"
        case workDelayMs = "EMBER_DEVICE_WORK_DELAY_MS"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let originRaw = try values.decode(String.self, forKey: .origin)
        let accountID = try values.decode(UUID.self, forKey: .accountID)
        let sessionToken = try values.decode(String.self, forKey: .sessionToken)
        let localAccessSecret = try values.decode(String.self, forKey: .localAccessSecret)
        let delay = try values.decodeIfPresent(Int.self, forKey: .workDelayMs) ?? 0

        guard let originURL = URL(string: originRaw),
              CloudDeviceEndpointConfiguration.validatedOrigin(originURL) != nil,
              (0...60_000).contains(delay),
              CloudDeviceEndpointConfiguration.isValidHeaderValue(sessionToken),
              CloudDeviceEndpointConfiguration.isValidHeaderValue(localAccessSecret)
        else {
            throw CloudDeviceError.invalidConfiguration
        }
        self.origin = originURL
        self.accountID = accountID
        self.sessionToken = sessionToken
        self.localAccessSecret = localAccessSecret
        self.workDelayMs = delay
    }

    public func makeEndpointConfiguration() throws -> CloudDeviceEndpointConfiguration {
        try CloudDeviceEndpointConfiguration(
            origin: origin,
            accountID: accountID,
            localAccessSecret: localAccessSecret,
            simulatedWorkDelay: .milliseconds(workDelayMs)
        )
    }

    public static func loadFromDocuments(fileName: String = defaultFileName) throws -> Self {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let file = docs.appendingPathComponent(fileName, isDirectory: false)
        do {
            let data = try Data(contentsOf: file)
            let config = try JSONDecoder().decode(Self.self, from: data)
            try? FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUnlessOpen],
                ofItemAtPath: file.path
            )
            var protectedFile = file
            var resourceValues = URLResourceValues()
            resourceValues.isExcludedFromBackup = true
            try? protectedFile.setResourceValues(resourceValues)
            return config
        } catch let error as CloudDeviceError {
            throw error
        } catch {
            throw CloudDeviceError.invalidConfiguration
        }
    }
}

/// MainActor observable bridge exposing M2-C2 Cloud Device Adapter state to SwiftUI views.
@MainActor @Observable
public final class CloudDeviceAdapterMonitor {
    public private(set) var deviceID: UUID?
    public private(set) var statusLabel: String = "Disconnected"
    public private(set) var lastEvent: String?
    public private(set) var summary: CloudDeviceJournalSummary?
    public private(set) var isRunning = false

    private var adapter: CloudDeviceExecutorAdapter?

    public init() {}

    public func connectFromQAFileIfPresent() async {
        do {
            let qaConfig = try CloudDeviceQAFileConfiguration.loadFromDocuments()
            let endpoint = try qaConfig.makeEndpointConfiguration()
            let authProvider = try StaticCloudDeviceAuthProvider(bearerToken: qaConfig.sessionToken)
            try await connect(configuration: endpoint, authProvider: authProvider, autoStart: true)
        } catch CloudDeviceError.invalidConfiguration {
            statusLabel = "Local QA config not loaded (optional)"
        } catch {
            statusLabel = error.localizedDescription
        }
    }

    public func connect(
        configuration: CloudDeviceEndpointConfiguration,
        authProvider: AuthSessionProvider,
        credentialStore: CloudDeviceCredentialStoring = KeychainCloudDeviceCredentialStore(),
        autoStart: Bool = false
    ) async throws {
        await stop()
        let created = try CloudDeviceExecutorAdapter(
            configuration: configuration,
            authProvider: authProvider,
            credentialStore: credentialStore,
            statusHandler: { [weak self] snapshot in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.deviceID = snapshot.deviceID
                    self.statusLabel = snapshot.status.label
                    self.summary = snapshot.journalSummary
                    if let detail = snapshot.lastEventDescription {
                        self.lastEvent = detail
                    }
                }
            }
        )
        self.adapter = created
        let snapshot = try await created.currentSnapshot()
        self.deviceID = snapshot.deviceID
        self.statusLabel = snapshot.status.label
        self.summary = snapshot.journalSummary
        self.lastEvent = snapshot.lastEventDescription
        if autoStart {
            await start()
        }
    }

    public func start() async {
        guard let adapter else { return }
        isRunning = true
        await adapter.start()
    }

    public func stop() async {
        isRunning = false
        guard let adapter else { return }
        await adapter.stop()
    }
}
