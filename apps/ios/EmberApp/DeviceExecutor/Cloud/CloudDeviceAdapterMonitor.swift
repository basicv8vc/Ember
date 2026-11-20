import Foundation
import Observation
import SwiftUI

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
    private var connectionGeneration: UInt64 = 0
    private var pendingStopTask: Task<Void, Never>?
    private var pendingStopID: UInt64 = 0

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
        transport: CloudDeviceAPITransporting? = nil,
        journal: CloudDeviceExecutionJournal? = nil,
        workspace: DeviceSandboxWorkspace? = nil,
        textTool: any NativeTool = NativeTextTool(),
        clock: CloudDeviceClock = SystemCloudDeviceClock(),
        backgroundTaskManager: any BackgroundTaskManaging = UIKitBackgroundTaskManager(),
        autoStart: Bool = false
    ) async throws {
        connectionGeneration &+= 1
        let myGeneration = connectionGeneration
        let previousAdapter = adapter
        adapter = nil
        isRunning = false

        if let previousAdapter {
            enqueueAdapterStop(previousAdapter)
        }
        while let stopTask = pendingStopTask {
            await stopTask.value
            guard connectionGeneration == myGeneration else { return }
        }
        guard connectionGeneration == myGeneration else { return }

        let created = try CloudDeviceExecutorAdapter(
            configuration: configuration,
            authProvider: authProvider,
            credentialStore: credentialStore,
            transport: transport,
            journal: journal,
            workspace: workspace,
            textTool: textTool,
            clock: clock,
            backgroundTaskManager: backgroundTaskManager,
            statusHandler: { [weak self] snapshot in
                Task { @MainActor [weak self] in
                    guard let self, self.connectionGeneration == myGeneration else { return }
                    self.applySnapshot(snapshot)
                }
            }
        )
        guard connectionGeneration == myGeneration else {
            await created.stop()
            return
        }
        self.adapter = created
        let snapshot = try await created.currentSnapshot()
        guard connectionGeneration == myGeneration else {
            await created.stop()
            return
        }
        applySnapshot(snapshot)
        if autoStart {
            await start()
        }
    }

    public func start() async {
        guard let adapter else { return }
        let myGeneration = connectionGeneration
        await adapter.start()
        guard connectionGeneration == myGeneration else { return }
        if let snapshot = try? await adapter.currentSnapshot(), connectionGeneration == myGeneration {
            applySnapshot(snapshot)
        }
    }

    public func stop() async {
        isRunning = false
        guard let adapter else {
            while let stopTask = pendingStopTask {
                await stopTask.value
            }
            return
        }
        let myGeneration = connectionGeneration
        await adapter.stop()
        guard connectionGeneration == myGeneration else { return }
        if let snapshot = try? await adapter.currentSnapshot(), connectionGeneration == myGeneration {
            applySnapshot(snapshot)
        }
    }

    private func enqueueAdapterStop(_ previousAdapter: CloudDeviceExecutorAdapter) {
        let priorStop = pendingStopTask
        pendingStopID &+= 1
        let stopID = pendingStopID
        pendingStopTask = Task { @MainActor [weak self] in
            if let priorStop {
                await priorStop.value
            }
            await previousAdapter.stop()
            if let self, self.pendingStopID == stopID {
                self.pendingStopTask = nil
            }
        }
    }

    public func handleScenePhase(_ phase: ScenePhase) async {
        guard let adapter else { return }
        let myGeneration = connectionGeneration
        await adapter.handleScenePhase(phase)
        guard connectionGeneration == myGeneration else { return }
        if let snapshot = try? await adapter.currentSnapshot(), connectionGeneration == myGeneration {
            applySnapshot(snapshot)
        }
    }

    private func applySnapshot(_ snapshot: CloudDeviceAdapterSnapshot) {
        self.deviceID = snapshot.deviceID
        self.statusLabel = snapshot.status.label
        self.summary = snapshot.journalSummary
        if let detail = snapshot.lastEventDescription {
            self.lastEvent = detail
        }
        switch snapshot.status {
        case .registering, .ready, .executing, .backingOff:
            self.isRunning = true
        case .stopped, .suspended, .halted:
            self.isRunning = false
        }
    }
}
