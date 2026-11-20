import SwiftUI
import UIKit

struct DeviceExecutorStatusSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var monitor: CloudDeviceAdapterMonitor
    let isEnabled: Bool
    let errorMessage: String?
    let onSetEnabled: (Bool) -> Void

    @State private var copiedDeviceID = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: EmberDesignTokens.standardSpacing) {
                    Text("device.executor.subtitle", tableName: "Conversation")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if let errorMessage {
                        InlineNotice(
                            title: LocalizedStringKey(
                                String(localized: "device.executor.error.title", table: "Conversation")
                            ),
                            message: LocalizedStringKey(errorMessage),
                            tone: .warning
                        )
                        .accessibilityIdentifier("device-executor-error")
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Toggle(
                            isOn: Binding(
                                get: { isEnabled },
                                set: { onSetEnabled($0) }
                            )
                        ) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("device.executor.toggle.title", tableName: "Conversation")
                                    .font(.body.weight(.semibold))
                                Text("device.executor.toggle.subtitle", tableName: "Conversation")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .accessibilityIdentifier("device-executor-toggle")
                    }
                    .padding(EmberDesignTokens.standardSpacing)
                    .background(
                        EmberDesignTokens.cardBackground,
                        in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
                    )

                    VStack(alignment: .leading, spacing: 10) {
                        LabeledContent {
                            Text(monitor.statusLabel)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(monitor.isRunning ? Color(uiColor: .systemGreen) : .secondary)
                                .multilineTextAlignment(.trailing)
                        } label: {
                            Text("device.executor.status.label", tableName: "Conversation")
                        }
                        .accessibilityIdentifier("device-executor-status-label")

                        if let deviceID = monitor.deviceID {
                            Divider()
                            HStack(spacing: 8) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("device.executor.device_id.label", tableName: "Conversation")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Text(deviceID.uuidString.lowercased())
                                        .font(.caption.monospaced())
                                        .textSelection(.enabled)
                                }
                                Spacer()
                                Button {
                                    UIPasteboard.general.string = deviceID.uuidString.lowercased()
                                    copiedDeviceID = true
                                } label: {
                                    Image(systemName: copiedDeviceID ? "checkmark" : "doc.on.doc")
                                        .font(.caption.weight(.semibold))
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                .accessibilityIdentifier("device-executor-copy-id")
                            }
                        }

                        if let summary = monitor.summary {
                            Divider()
                            LabeledContent {
                                Text("\(summary.committedCount) / \(summary.pendingCommitCount) / \(summary.fencedCount)")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            } label: {
                                Text("device.executor.journal.label", tableName: "Conversation")
                            }
                        }

                        if let lastEvent = monitor.lastEvent {
                            Divider()
                            Text(lastEvent)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(EmberDesignTokens.standardSpacing)
                    .background(
                        EmberDesignTokens.cardBackground,
                        in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
                    )
                }
                .padding(EmberDesignTokens.standardSpacing)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .background(EmberDesignTokens.groupedBackground)
            .navigationTitle(Text("device.executor.nav_title", tableName: "Conversation"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Text("tasks.detail.close", tableName: "Conversation")
                    }
                    .accessibilityIdentifier("device-executor-close")
                }
            }
        }
    }
}
