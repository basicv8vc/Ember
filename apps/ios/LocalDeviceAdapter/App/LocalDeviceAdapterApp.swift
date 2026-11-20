import Foundation
import SwiftUI
import UIKit

@main
struct LocalDeviceAdapterApp: App {
    var body: some Scene {
        WindowGroup {
            LocalDeviceAdapterView()
        }
    }
}

private struct LocalDeviceAdapterView: View {
    @State private var adapter: NativeDeviceAdapter?
    @State private var status = "Starting"
    @State private var phase: UIApplication.State = .inactive

    var body: some View {
        NavigationStack {
            List {
                Text(phaseLabel)
                    .accessibilityIdentifier("native-device-adapter-scene")
                Text(status)
                    .accessibilityIdentifier("native-device-adapter-status")
                if let adapter {
                    LabeledContent("Device ID", value: adapter.deviceID.uuidString.lowercased())
                        .textSelection(.enabled)
                }
            }
            .navigationTitle("Local Device Adapter")
        }
        .onAppear {
            updatePhase(UIApplication.shared.applicationState)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            updatePhase(.active)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
            updatePhase(.inactive)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
            updatePhase(.background)
        }
        .task(id: phase) {
            guard phase == .active else { return }
            do {
                if adapter == nil {
                    adapter = try NativeDeviceAdapter(configuration: LocalDeviceConfiguration.load())
                }
                await adapter?.run { message in
                    status = message
                    log(message)
                }
            } catch {
                status = (error as? LocalDeviceError)?.status ?? LocalDeviceError.unavailableStorage.status
                log(status)
            }
        }
    }

    private var phaseLabel: String {
        switch phase {
        case .active: "Foreground"
        case .inactive: "Inactive"
        case .background: "Background"
        @unknown default: "Unavailable"
        }
    }

    private func updatePhase(_ current: UIApplication.State) {
        guard phase != current else { return }
        phase = current
        log("scene \(phaseLabel.lowercased())")
    }

    private func log(_ message: String) {
        FileHandle.standardOutput.write(Data("EmberDevice \(message)\n".utf8))
    }
}
