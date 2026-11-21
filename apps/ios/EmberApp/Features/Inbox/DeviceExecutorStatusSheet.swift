import SwiftUI
import UIKit

struct DeviceExecutorStatusSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var monitor: CloudDeviceAdapterMonitor
    let isEnabled: Bool
    let errorMessage: String?
    let onSetEnabled: (Bool) -> Void

    @State private var copiedDeviceID = false
    #if DEBUG
    @State private var qaSampleText = "Hello Ember\nLine 2"
    #endif

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

                    #if DEBUG
                    if monitor.deviceID != nil {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Internal QA — Dispatch Device Text Task")
                                .font(.subheadline.weight(.semibold))

                            TextField("Sample text", text: $qaSampleText, axis: .vertical)
                                .textFieldStyle(.roundedBorder)
                                .lineLimit(2...5)
                                .accessibilityIdentifier("device-executor-qa-input")

                            HStack {
                                Button {
                                    Task { await monitor.dispatchTestTextTask(text: qaSampleText) }
                                } label: {
                                    if monitor.isDispatchingTestTask {
                                        ProgressView()
                                            .controlSize(.small)
                                    } else {
                                        Text("Dispatch Test Task")
                                    }
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(monitor.isDispatchingTestTask || qaSampleText.isEmpty)
                                .accessibilityIdentifier("device-executor-qa-dispatch")

                                if let task = monitor.lastDispatchedTask, !task.isTerminal {
                                    Button("Refresh") {
                                        Task { await monitor.refreshDispatchedTaskStatus() }
                                    }
                                    .buttonStyle(.bordered)
                                    .accessibilityIdentifier("device-executor-qa-refresh")
                                }
                            }

                            if let dispatchError = monitor.dispatchErrorMessage {
                                Text(dispatchError)
                                    .font(.caption)
                                    .foregroundStyle(.red)
                                    .accessibilityIdentifier("device-executor-qa-error")
                            }

                            if let task = monitor.lastDispatchedTask {
                                Divider()
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Task: \(task.taskId.uuidString.lowercased())")
                                        .font(.caption.monospaced())
                                    Text("Status: \(task.status) · Availability: \(task.availability)")
                                        .font(.caption.weight(.medium))
                                    if let reason = task.reason {
                                        Text("Reason: \(reason)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    if let stats = task.result {
                                        Text("Result: UTF-8 \(stats.utf8Bytes) B · Scalars \(stats.unicodeScalars) · Lines \(stats.lines)")
                                            .font(.caption.monospaced())
                                            .foregroundStyle(Color(uiColor: .systemGreen))
                                            .accessibilityIdentifier("device-executor-qa-result")
                                    }
                                }
                            }
                        }
                        .padding(EmberDesignTokens.standardSpacing)
                        .background(
                            EmberDesignTokens.cardBackground,
                            in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
                        )
                    }
                    #endif
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
